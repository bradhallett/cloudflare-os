import { WorkpieceId, AiChatMetadata, AiChatAuthorInfo, AiToolCall, CapsuleSpecifier, CollaboratorRole, ObserverBindingNeed, MessageFormatRef, ChatAttachmentHandle, SlashCommandRequest, validateBindingName } from "@gadgets/workshop-shared/api";
import { Gatekeeper, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import { WorkspaceGitCache } from "./git-cache";
import { migrateToActionIndexes, migrateToBlueprintUpstreams, migrateToGitStorage, migrateToMultiGadget, migrateToWorkpieceTypes, migrateToSpawnerBindings, migrateToDeclaredBots } from "./storage-schema/overseer-migrations";
import { AgentHooks, summarizeArgs } from "./agent";
import { ChatCacheWarmer } from "./chat-cache-warming";
import { UserDurableObject } from "./user";
import type { UserChatContext } from "./user";
import { AutoApprovalDrainer } from "./auto-approval";
import { OverseerGatekeepers } from "./overseer-gatekeepers";
import { OverseerBots } from "./overseer-bots";
import { AGENT_KEEPALIVE_ALARM_MS, ALARM_MAX_RETRIES, stringifyError } from "./overseer-support";
import { GIT_BINDING_NAME } from "./agent";
import { assertBindingNameFree, type ExternalMessageResponseTargetRegistration } from "./overseer-support";
import { observerBindingNeed } from "./overseer-binding-info";

/**
 * OverseerImpl: the overseer durable object implementation: alarms, chat control, and the constructor.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export class OverseerImpl extends OverseerBots implements AgentHooks {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.gitCache = new WorkspaceGitCache(this.storage, {
      pull: (gatekeeperId, oids, hints) => this.#pullGitObjects(gatekeeperId, oids, hints),
    });

    // Run any pending storage migration (see storage-schema/overseer-migrations.ts) before
    // anything else can touch storage. This must happen in the constructor (not just open())
    // because the DO also wakes via constructor-driven agent-turn restoration below, hook
    // deliveries, and [restore]()-based persistent callbacks. This migration is fully
    // synchronous, so nothing can observe pre-migration state; the git-storage migration below
    // is the asynchronous one, shielded by blockConcurrencyWhile.
    migrateToMultiGadget(this);
    this.defaultGadgetId = this.storage.defaultGadgetId.get();

    this.autoApprovalDrainer = new AutoApprovalDrainer(
        this.storage,
        (record, resolvedBy, autoApproved) =>
            this.applyPendingAction(record, resolvedBy, autoApproved));

    // Mirror every gadget-registry change into the owner's outputs index. Subscribing here makes
    // the registry the single chokepoint, so creation, acceptance, renaming, reverting and
    // deletion all propagate without each call site remembering to. (Workspace deletion is handled
    // by UserDurableObject.deleteGadget(), which drops the whole workspace's entries.)
    this.storage.gadgets.subscribe({
      add: () => this.markOutputsDirty(),
      update: () => this.markOutputsDirty(),
      remove: () => this.markOutputsDirty(),
    });

    // Keeps a viewed chat's last model request warm between turns (see chat-cache-warming.ts):
    // the DO id names the warmer's timers, and resent requests bill the chat's cost record
    // like any turn request (via addChatMessages's addRequestCost tail, mirroring #runAgentTurn).
    this.cacheWarmer = new ChatCacheWarmer(ctx.id.toString(), (chatId, resent) =>
        this.addRequestCost(chatId, resent.usage, resent.aiGatewayLogId,
            resent.aiGatewayLogRoute, false));

    this.ctx.blockConcurrencyWhile(async () => {
      if (this.storage.version.get() === 1) await migrateToGitStorage(this);
      migrateToActionIndexes(this);
      migrateToWorkpieceTypes(this);
      migrateToBlueprintUpstreams(this);
      migrateToSpawnerBindings(this);
      migrateToDeclaredBots(this);
      // Do not replace an existing alarm during constructor recovery: setAlarm would reset the
      // platform's retry budget. Cache its time before registering any recovered executions.
      this.scheduledAlarm = await this.ctx.storage.getAlarm();
      if ([...this.storage.activeAgents.list()].some(r => this.storage.chatMeta.get(r.chatId)?.activeAgent)) {
        this.agentKeepAliveTime = this.scheduledAlarm ?? undefined;
      }
    // Resume outside the critical section, before blocked events are delivered. On failure,
    // blockConcurrencyWhile already aborted the object; consume its rejection (logging it: a
    // swallowed boot failure silently skips every agent resume this restart) and retry on wake.
    }).then(() => this.resumeInterruptedAgents(), error => {
      this.logger.error("boot or resume sweep failed; some agents may not have been resumed", {
        event: "agent.resume.boot.failed", error,
      });
    });
  }
  /**
   * The body of the alarm handler: perform every concern the alarm exists for, together, and hold
   * the DO open until all of them are done. They run concurrently so none waits on another -- in
   * particular a response retry never waits behind an unrelated chat's long turn -- and since work
   * begets work (a drain starts a turn, a turn's end drains more calls), passes repeat until one
   * ends with no turn running and no drain in flight. Both checks are needed: between a turn's end
   * and the next turn's start, the only sign of work in progress is the drain (which the next pass
   * joins, being single-flight). A drain that fails leaves its calls recorded rather than looping
   * here; the recompute at the end re-arms the alarm for them, starting a fresh keep-alive period
   * from now rather than re-firing on the time that has just passed. A delivery failure is
   * rethrown once everything else has settled, so the platform retries the alarm. After its last
   * retry, schedule a fresh wake-up: a long response-target outage must not strand durable work.
   */
  async runAlarmTasks(retryCount = 0): Promise<void> {
    this.inAlarmHandler = true;
    this.scheduledAlarm = undefined; // A success recomputes the next alarm from settled state.
    let failed = false;
    try {
      do {
        this.resumeInterruptedAgents();
        let results = await Promise.allSettled([
          this.waitForAllAgentsToComplete(),
          this.drainAllPendingAgentCalls(),
          this.deliverReadyExternalMessageResponses(),
        ]);
        for (let result of results) {
          if (result.status === "rejected") throw result.reason;
        }
        if (this.resumeErrors.size > 0) throw this.resumeErrors.values().next().value;
      } while (this.runningAgents.size > 0 || this.pendingCallDrains.size > 0);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.inAlarmHandler = false;
      this.agentKeepAliveTime = undefined;
      if (!failed || retryCount >= ALARM_MAX_RETRIES) {
        this.updateAlarm(failed ? Date.now() + AGENT_KEEPALIVE_ALARM_MS : 0);
      }
    }
  }

  /**
   * Resume any agent turns that were left running by a previous instance of this DO (i.e. were
   * interrupted by a server restart). Called as soon as constructor initialization completes,
   * before any blocked event is delivered, so at the start of the alarm handler
   * it'll recognize that agents are running and wait for them.
   */
  protected resumeInterruptedAgents(): void {
    let interrupted = Array.from(this.storage.activeAgents.list());
    this.logger.debug("agent resume sweep", {
      event: "agent.resume.sweep", resumeRecords: interrupted.length,
    });
    for (let record of interrupted) {
      // Per-record resilience: a synchronous throw here (alarm re-registration, a storage read,
      // decision-resume) escapes both boot handlers and would strand every LATER record's chat
      // mid-sweep with no error anywhere. Log it and keep sweeping; the record stays for the
      // next sweep (alarm wake or next construction) to retry.
      try {
        if (this.runningAgents.has(record.chatId)) continue;
        if (!this.storage.chatMeta.get(record.chatId)?.activeAgent) {
          this.resumeAgentAfterDecision(record.chatId);
          continue;
        }
        // Register the running agent immediately (see above), and create the LiveChatContext
        // synchronously, so that cancellations are immediately respected.
        this.registerRunningAgent(record.chatId);
        let liveChat = this.getLiveChat(record.chatId);

        this.resumeErrors.delete(record.chatId);
        this.resumeAgent(record, liveChat).catch(error => {
          // The async resume rejected before any of its own handling surfaced the failure:
          // log it and leave the record for the next sweep (alarm wake or next construction).
          this.logger.error("agent resume failed to start", {
            event: "agent.resume.start.failed", chatId: record.chatId, error,
          });
        });
      } catch (error) {
        this.logger.error("agent resume sweep failed for one chat", {
          event: "agent.resume.sweep.failed", chatId: record.chatId, error,
        });
      }
    }

    // Backwards compatibility: Prior to the introduction of the `activeAgents` table, we could
    // only detect abandoned agents by the presence of `activeAgent` in the `AiChatMetadata` for
    // the chat thread. On the first app update after `activeAgents` is introduced, we could still
    // have such threads with no record in `activeAgents`. We can't resume these threads, but at
    // the very least, we should properly cancel them.
    //
    // After this change has been deployed, we could plausibly remove this block, though it might
    // be nice to keep for consistency purposes.
    for (let thread of Array.from(this.storage.chatMeta.list())) {
      if (thread.activeAgent && !this.runningAgents.has(thread.id)) {
        this.postAgentErrorMessage(thread.id, thread.activeAgent,
            "Agent interrupted due to server restart.");
        delete thread.activeAgent;
        this.storage.chatMeta.put(thread);
        this.deliverWaitingExternalMessageResponse(thread.id);
      }
    }

    // Deliver any calls to callable agents that were recorded but not yet appended to their chat
    // when the previous instance went away. (A chat whose turn was just resumed drains at the end
    // of that turn instead.)
    this.drainAllPendingAgentCalls();
  }

  // =======================================================================================
  // Multi-gadget workspace helpers: the gadget registry and defaultGadgetId resolution.

  // The git cache's pull delegate (see GitPullDelegate): reaches the gatekeeper through its
  // instantiated facet -- the same path every other invocation of an existing gatekeeper uses --
  // and ingests its pack with that source's provenance and the DO cache's existing limits.
  async #pullGitObjects(gatekeeperId: WorkpieceId, oids: string[], hints: GitPullHints)
      : Promise<void> {
    if (this.storage.gatekeepers.get(gatekeeperId) === undefined) {
      throw new Error(
          `The connection that provided this git object has been deleted from the workspace. ` +
          `Reconnect it to pull the object again.`);
    }
    // gitPull is optional on Gatekeeper; view the facet through the same Required<Pick<...>>
    // pattern as CatalogGatekeeperFacet. A gatekeeper that doesn't implement it rejects the
    // call, which the pull driver treats as this source failing.
    let facet = await this.getGatekeeperFacet(gatekeeperId) as unknown as
        Fetcher<Gatekeeper<any> & Required<Pick<Gatekeeper<any>, "gitPull">>>;
    using transfer = await facet.gitPull(oids, hints);
    const pack = await transfer.stream();
    let stored: Set<string>;
    try {
      stored = new Set(await this.gitCache.consumePackFromGatekeeper(gatekeeperId, pack));
    } catch (error) {
      // A stream exception crossing Workers RPC can turn into "Network connection lost".
      // The producer records its real protocol error before rejecting the stream.
      const status = await transfer.status().catch(() => undefined);
      if (status?.state === "failed") throw new Error(status.message, {cause: error});
      throw error;
    }
    const status = await transfer.status();
    if (status.state === "failed") throw new Error(status.message);
    if (status.state !== "complete") {
      throw new Error(`git fetch ended without a completed transfer (${status.state})`);
    }
    const missing = oids.filter(oid => !stored.has(oid));
    if (missing.length > 0 && !(hints.type === "blob" && hints.filterBlobSize !== undefined)) {
      throw new Error(`git fetch did not provide the requested objects: ${missing.join(", ")}`);
    }
  }

  async newChat(
    clientUser: DurableObjectStub<UserDurableObject>,
    userMeta: UserChatContext,
    initialMessage: string | SlashCommandRequest,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    responseTargetRegistration?: ExternalMessageResponseTargetRegistration,
    externalChatKey?: string,
    formats?: MessageFormatRef[],
  ): Promise<number> {
    if (responseTargetRegistration) {
      let decision = this.prepareExternalMessageResponseTargetRegistration(responseTargetRegistration);
      if (decision.reuseExisting) return decision.record.chatId;
    }
    if (typeof initialMessage !== "string" && (capsules?.length || attachments?.length)) {
      throw new Error("Slash commands cannot include resources or attachments.");
    }
    let canonicalAttachments = this.canonicalizeChatAttachmentRefs(attachments);
    let prepared = await this.prepareChatMessage(
        initialMessage, (canonicalAttachments?.length ?? 0) > 0);

    // A bot chat snapshots its bot at start (see snapshotBotForChat): the frozen declaration
    // plus the workspace's skill resolution, stored on the chat's context and never re-resolved
    // per turn. userMeta.bot is set only when the client passed one; getChatContext has already
    // validated the bot and put its model in userMeta.aiModel.
    let botSnapshot = userMeta.bot ? await this.snapshotBotForChat(userMeta.bot) : undefined;

    // No code base is established at creation: gadgets pin lazily, when their code is first
    // modified in the chat (see ChatCodeBase). Until then the chat reads committed code live at
    // each gadget's current head.
    let chatId = this.nextChatId();
    let attachmentFiles = await this.prepareWorkspaceAttachmentFiles(chatId, canonicalAttachments);
    let scratchWorktree = await this.prepareScratchWorktree(
        chatId, attachmentFiles, userMeta.profile);
    let timestamp = this.getChatTimestamp();
    this.ctx.storage.transactionSync(() => {
      let meta: AiChatMetadata = {
        id: chatId,
        title: "New Chat",   // filled in later by AI
        started: timestamp,
        lastActive: timestamp,
      };
      if (botSnapshot) {
        meta.botName = botSnapshot.botConfig.name;
        meta.bot = botSnapshot.botConfig.selection;
      }
      if (prepared.message !== undefined && userMeta.aiModel) {
        meta.activeAgent = userMeta.aiModel.profile;
      }
      this.storage.chatMeta.put(meta);
      this.storage.chatContext.put({
        ...this.getChatAgentContext(chatId),
        attachmentsMigrated: true,
        ...botSnapshot,
      });

      let promptSequence = this.commitPreparedChatMessage(
          chatId, timestamp, userMeta.profile, prepared, capsules, canonicalAttachments, formats,
          scratchWorktree, scratchWorktree?.commitId);
      if (responseTargetRegistration) {
        if (promptSequence === undefined) {
          throw new Error("External messages require a prompt.");
        }
        this.registerExternalMessageResponseTarget(
          responseTargetRegistration.idempotencyKey,
          chatId,
          promptSequence,
          responseTargetRegistration.chatGatewayRpcTarget,
        );
      }
      if (externalChatKey) {
        this.storage.externalChats.put({ externalChatKey, chatId });
      }
    });

    if (prepared.message !== undefined && userMeta.aiModel) {
      let needsAgentTurnKeepAlive = responseTargetRegistration !== undefined;
      this.startAgent(chatId, userMeta.aiModel, userMeta.profile,
                      clientUser.id.toString(), false, needsAgentTurnKeepAlive);
    }

    if (userMeta.quickModel) {
      let titleMessage = prepared.message?.trim() || prepared.slashCommand?.args.trim() ||
        prepared.skillName || (prepared.slashCommand ? "Slash command" : "") ||
        `[user attached ${canonicalAttachments?.length ?? 0} attachment(s)]`;
      this.generateThreadTitle(chatId, titleMessage, userMeta.quickModel, userMeta.profile);
    }

    this.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: clientUser.id.toString(),
      chat_id: chatId,
      interaction_type: "chat_started",
    });

    return chatId;
  }


  /**
   * Add a binding edge to a gadget on behalf of the agent's setGadgetBinding tool. The edge is
   * provisional to the chat (see BindingRecord.pending); the agent loop records the addition in
   * the chat log via `addedBindings`, which sequence-stamps it (see addChatMessages()).
   */
  addGadgetBinding(gadgetId: WorkpieceId, name: string, target: WorkpieceId,
                   chatId: number): void {
    let spawner = this.storage.gatekeepers.get(gadgetId);
    if (spawner?.bindings) {
      this.validateSpawnerBinding(name, target, chatId);
      assertBindingNameFree(spawner.bindings, name, chatId);
      // Pending, so it widens no one's verification scope until mergeChanges promotes it.
      spawner.bindings[name] = {target, pending: {chatId}};
      this.storage.gatekeepers.put(spawner);
      return;
    }
    if (!this.storage.gatekeepers.get(target)) {
      throw new Error("This resource is no longer available.");
    }
    // Validate the gadget exists and is visible to this chat.
    let gadget = this.getGadgetRecord(
        this.resolveWorkpieceRoot(gadgetId, true, chatId).workpieceId);
    this.bindWorkpiece(gadget.id, name, target, chatId);
  }

  // Throws unless `target` may be bound into an agent spawner as `name`, by chat `chatId` if
  // given: each agent the spawner starts gets it as `env.<name>` (see GatekeeperRecord.bindings).
  validateSpawnerBinding(name: string, target: WorkpieceId, chatId?: number): void {
    validateBindingName(name);
    if (name === GIT_BINDING_NAME) {
      // The spawned chat's env already has the automatic env.GIT, which this would shadow.
      throw new Error(`The binding name \`${name}\` is reserved.`);
    }
    let gadget = this.storage.gadgets.get(target);
    if (gadget?.type === "worktree") {
      throw new Error(`Binding "${name}" references workpiece ${target}, which is a worktree; ` +
          `worktrees are chat-private and cannot be given to an agent spawner.`);
    }
    // A gadget provisional to another chat belongs to that chat's unaccepted proposal, not (yet)
    // to the workspace. The chat's own is accepted along with the binding.
    if (gadget?.pending && gadget.pending.chatId !== chatId) {
      throw new Error(`Binding "${name}" references gadget ${target}, which is still pending ` +
          `in a chat.`);
    }
    if (!gadget && !this.storage.gatekeepers.get(target)) {
      throw new Error(`Binding "${name}" references workpiece ${target}, which does not exist.`);
    }
  }

  /**
   * Called by AgentSelfLoopback when any method is called on the `self` object or on a
   * spawnCallable() stub. Resolves once the call is durably recorded; the agent handles it
   * asynchronously and nothing is returned to the caller.
   */
  async deliverAgentCallback(
      chatId: number, methodName: string, args: unknown[],
      initiatorUserId: string, initiatorModelId: string | null): Promise<void> {
    if (!this.ownerId) throw new Error("Workspace has been deleted.");

    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) throw new Error("No such chatId: " + chatId);

    let callId = this.storage.nextAgentCallId.get();
    try {
      // The put serializes synchronously, so this is also where unstorable arguments are
      // rejected -- in particular an RPC stub that isn't a persistent stub.
      this.storage.pendingAgentCalls.put({
        chatId,
        callId,
        methodName,
        args,
        argsSummary: summarizeArgs(args),
        initiatorUserId,
        initiatorModelId,
      });
    } catch (err) {
      if ((err as {name?: unknown} | null)?.name === "DataCloneError") {
        throw new Error(
            "Arguments to a callable agent must be storable. RPC stubs must be persistent stubs " +
            "created with ctx.restore(); see the agent spawner binding documentation. " +
            `(${stringifyError(err)})`, {cause: err});
      }
      throw err;
    }
    this.storage.nextAgentCallId.put(callId + 1);
    // In the same synchronous step, so the call is never recorded without a wake-up scheduled to
    // deliver it should the DO die first (see #agentKeepAliveTime).
    this.updateAlarm();

    // If the agent is running, we can't append to its chat now (that would confuse the turn in
    // progress); its turn delivers the call when it ends. Likewise a message being prepared:
    // the reservation's release delivers it. Otherwise deliver it now.
    if (!meta.activeAgent && !this.isPreparingChatMessage(chatId)) {
      this.drainPendingAgentCalls(chatId);
    }
  }

  /**
   * Drain every chat that has pending calls and no running turn (a running turn drains its own
   * at its end). Called from the constructor (fire-and-forget, for wakes of any kind) and from the
   * alarm handler (awaited, so the alarm's retry covers a failure).
   */
  drainAllPendingAgentCalls(): Promise<void> {
    let chatIds = new Set<number>();
    for (let record of this.storage.pendingAgentCalls.list()) {
      chatIds.add(record.chatId);
    }
    return Promise.all(Array.from(chatIds)
        .filter(chatId => !this.runningAgents.has(chatId))
        .map(chatId => this.drainPendingAgentCalls(chatId))).then(() => {});
  }

  /**
   * Ensure every singleton account the gadget owner has (e.g. the Context Library) is provisioned
   * for this gadget as an ambient gatekeeper record, folded into each chat's env (named by the
   * gatekeeper's suggested binding name; see prepareChatBindings) so the agent can read it in
   * executeCode — search/list/read recorded as observations — and optionally wire into a gadget
   * via setGadgetBinding if the gadget's persistent code needs it. (Most gadgets never call the
   * library programmatically, so a gadget binding would just be noise.) Idempotent:
   * provisioned once per gadget and re-added if missing. Called on open(), before any agent turn.
   *
   * The session is reached through the owner's stored connected account, not by asserting the owner's
   * identity to the vendor — so the capability is the account the user actually holds.
   */
  async ensureAmbientCapsules(): Promise<void> {
    let ownerId = this.ownerId;
    if (!ownerId) return;
    let ownerDo = this.ownerUserDo();
    // listProvidedAccounts ensures the owner's auto-provisioned singleton accounts exist first, so this
    // single round trip both provisions them and reads them back before we wire up capsules.
    let accounts = (await ownerDo.listProvidedAccounts())
        .filter(account => account.description.singleton?.tsType);

    // Reconcile existing ambient capsule records against the owner's current singleton accounts. Each
    // record is keyed to a specific accountId; if that account is gone (disconnected) or was replaced
    // (an optional account removed and re-added with a new accountId), the record is stale and would
    // point the capsule at a deleted account — so remove it. Snapshot the list since we mutate it.
    let currentAccountId = new Map(accounts.map(account => [account.vendorId, account.accountId]));
    let bound = new Set<string>();
    // Snapshot before iterating, since removeGatekeeper() mutates the collection.
    let existingGatekeepers = Array.from(this.storage.gatekeepers.list());
    for (let gk of existingGatekeepers) {
      if (gk.creationSpec?.type !== "ambient") continue;
      if (currentAccountId.get(gk.creationSpec.vendorId) === gk.creationSpec.accountId) {
        bound.add(gk.creationSpec.vendorId);
      } else {
        this.removeGatekeeper(gk.id);
      }
    }
    let toAdd = accounts.filter(account => !bound.has(account.vendorId));
    if (toAdd.length === 0) return;

    // Each singleton account provides a normal Gatekeeper class (imbued via ctx.props with whatever
    // it needs — e.g. account id and sharing domain). We install it as a Facet exactly like any other
    // gatekeeper, so its session and catalog run gadget-side in the gatekeeper's own worker with no
    // further round-trips through the owner's user DO. The account capability stays encapsulated in
    // that DO — only the class reference crosses out.
    //
    // Provision concurrently so Cap'n Web can batch the owner-DO class lookups; addGatekeeper assigns
    // ids before awaiting, so concurrent adds don't collide.
    await Promise.all(toAdd.map(async account => {
      // Best-effort and isolated per account: a single failing account (e.g. its
      // getSingletonGatekeeperClass throws) must not block the others or the rest of open().
      try {
        let cls = await ownerDo.getSingletonGatekeeperClass(account.accountId);
        if (!cls) return;
        // Provision as an unnamed record: it reaches the agent through each chat's env (named from
        // the gatekeeper's suggested binding name when the chat takes it in; see
        // prepareChatBindings), not as any gadget's binding.
        await this.addGatekeeper(
            cls,
            {type: "ambient", vendorId: account.vendorId, accountId: account.accountId},
            ownerId);
      } catch (err) {
        this.logger.error("failed to provision ambient capsule", {
          event: "ambient.capsule.provision.failed",
          vendorId: account.vendorId, accountId: account.accountId, error: err,
        });
      }
    }));
  }

  /**
   * Old paused chats have no execution row. Before applying a decision, adopt the existing
   * client's authority once, without model/profile I/O. New pauses always retain their row.
   */
  rememberDecisionInitiator(chatId: number, userId: string, profile: AiChatAuthorInfo): void {
    if (this.storage.activeAgents.get(chatId) || this.storage.chatMeta.get(chatId)?.activeAgent) return;
    let wait = this.decisionWait(chatId);
    if (!wait) return;
    this.storage.activeAgents.put({chatId, modelId: wait.agent.id, initiatorUserId: userId,
      initiator: profile, callbackInitiated: false});
  }

  /**
   * Mint a gatekeeper simulating a new resource, tied to no account, and queue its creation.
   * Unlike addGatekeeper(), this publishes without restarting collaborator sessions: a restart now
   * would abort this turn before its tool call is recorded, and until the creation applies there
   * is no real resource to verify anyone against -- the simulated one holds only what was written
   * through this workspace, which no current collaborator is excluded from
   * (#enforceExcludeObservers). applyPendingAction restarts once the resource is real.
   */
  async createExternalResource(
      chatId: number, input: Extract<AiToolCall, {toolName: "createExternalResource"}>["input"])
      : Promise<{gatekeeperId: WorkpieceId}> {
    let minted = await this.ownerUserStub().createResourceGatekeeper(
        input.vendorId, input.resourceUrlPattern, input.title);
    let id = this.allocateWorkpieceId();
    this.storage.gatekeepers.put({
      id,
      class: minted.class,
      resourceTitle: input.title,
      creationSpec: {type: "gatekeeper", vendorId: input.vendorId,
                     typeUrlPattern: minted.typeUrlPattern},
    });
    await this.submitAction(id, "create", minted.action, {from: "agent", chatId})
        .catch(error => { this.removeGatekeeper(id); throw error; });
    return {gatekeeperId: id};
  }

  listObserverRequirements(role: CollaboratorRole): ObserverBindingNeed[] {
    return this.inScopeGatekeepers(role).map(observerBindingNeed);
  }
  protected self(): OverseerImpl {
    return this;
  }
}
