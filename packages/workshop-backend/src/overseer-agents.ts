import { RpcStub } from "capnweb";
import { WorkpieceId, AiChatAuthorInfo, CapsuleSpecifier, CollaboratorRole, ObserverConfigCallback, ObserverBindingNeed, ObserverBindingFailure, MessageFormatRef, ChatAttachmentHandle, SlashCommandRequest, BotSelection } from "@gadgets/workshop-shared/api";
import type { FileContent } from "@gadgets/workshop-shared/code-change";
import type { CachedRequest } from "./ai-models";
import { Gatekeeper, GatekeeperUserVerifier, createObservationRefusedError } from "@gadgets/workshop-shared/gatekeeper";
import { chatKey, chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ActionRecord, ActiveAgentRecord, GatekeeperClass, GatekeeperRecord, ObserverRecord, WorkpieceRecord } from "./storage-schema/overseer-storage";
import type { UserAiModelRecord } from "./storage-schema/user-storage";
import { commitIdentityForAuthor } from "./git-store";
import { GitCacheImpl } from "./git-cache";
import { getModel, UserGatewayRouting } from "./ai-models";
import { AgentTurnError } from "./ai-invoke";
import { runAgent } from "./agent";
import { chatChangeStatuses } from "./agent-compaction";
import { UserDurableObject } from "./user";
import type { UserChatContext } from "./user";
import { reportIssue } from "@gadgets/observability/error-reporting";
import { checkUsageAndBalance } from "./ai-gateway-billing/limits/usage-checker";
import { refreshCachedBalance } from "./ai-gateway-billing/cloudflare/connection-service";
import { roleRank } from "./sharing";
import { obsContext } from "./observability";
import { traceAgentTurn } from "./agent-tracing";
import { retryOnDoReset, shouldRetryAfterReset } from "./do-retry";
import { OverseerMainline } from "./overseer-mainline";
import type { ExternalMessageResponseTargetRegistration, LiveChatContext, PreparedScratchWorktree } from "./overseer-support";
import { AGENT_RESUME_MAX_ATTEMPTS, computeSessionAffinity, stringifyError } from "./overseer-support";
import { stampBindHookAction } from "./overseer-action-log";
import { callArgsBindingName, fallbackBindingName, gatekeeperVendorId, observerBindingNeed, observerBindingTitle, observerVendorId, oneLineReason } from "./overseer-binding-info";

/**
 * OverseerAgents: agent lifecycle: turns, callbacks, reconciliation, pending actions, chat attachments prep, observers and collaborators.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerAgents extends OverseerMainline {
  /**
   * Resume a single interrupted agent turn. Re-resolves the model config from the initiator's user
   * DO (we don't persist the secret API token), then runs the agent loop, which rebuilds its state
   * by replaying the persisted chat log.
   */
  protected async resumeAgent(record: ActiveAgentRecord, liveChat: LiveChatContext) {
    let owns = () => this.liveChats.get(record.chatId) === liveChat &&
        this.storage.chatMeta.get(record.chatId)?.activeAgent !== undefined;
    let finish = () => {
      if (!owns()) return;
      let meta = this.storage.chatMeta.get(record.chatId)!;
      delete meta.activeAgent;
      this.storage.chatMeta.put(meta);
      this.unregisterRunningAgent(record.chatId);
      this.finishAgentTurn(record.chatId);
    };
    // A reset can land after a request or final response committed but before teardown. Honor
    // that logged pause/completion instead of issuing another model request -- unless steers were
    // queued after the final response: as in #finishAgentTurn, they prompt the next turn.
    let wait = this.decisionWait(record.chatId);
    let meta = this.storage.chatMeta.get(record.chatId);
    if (wait === null && meta?.queuedSteers) {
      this.logQueuedSteers(meta, false);
    } else if (wait !== undefined) {
      if (meta) {
        delete meta.activeAgent;
        this.storage.chatMeta.put(meta);
      }
      this.unregisterRunningAgent(record.chatId, !!wait);
      this.#publishAgentTurnNotification(record.chatId, record.initiator, record.initiatorUserId);
      this.finishAgentTurn(record.chatId);
      return;
    }
    if ((record.resumeAttempts ?? 0) >= AGENT_RESUME_MAX_ATTEMPTS) {
      this.postAgentErrorMessage(record.chatId, this.storage.chatMeta.get(record.chatId)!.activeAgent!,
          "The agent could not be resumed because its model lookup was interrupted too many times.");
      finish();
      return;
    }
    // Count before I/O, so an eviction during lookup cannot reset the budget. Successful
    // preparation clears it: this budget never retries inference or external effects.
    let resumeAttempts = (record.resumeAttempts ?? 0) + 1;
    record = {...record, resumeAttempts};
    this.storage.activeAgents.put(record);
    let aiModel: UserAiModelRecord | undefined;
    let failure: unknown;
    let leaveSession = () => {};
    using _resumeSession = {[Symbol.dispose]: () => leaveSession()};
    try {
      let userMeta = await retryOnDoReset(() => this.users.get(
          this.users.idFromString(record.initiatorUserId)).getChatContext(record.modelId), this.logger);
      aiModel = userMeta.aiModel;
      if (this.ownerId && record.initiator.type === "user" && record.initiatorUserId !== this.ownerId) {
        let user = this.users.get(this.users.idFromString(record.initiatorUserId));
        if (!await this.authorizeCollaborator(record.initiator.id, user, {requireRole: "build"})) {
          throw new Error("The original initiator no longer has build access to this workspace.");
        }
        // Keep verification live through inference, including after the approving client leaves.
        leaveSession = this.joinSession("build");
      }
    } catch (err) {
      failure = err;
      aiModel = undefined;
      this.logger.error("error preparing agent resumption", {
        event: "agent.resume.prepare.failed",
        chatId: record.chatId, modelId: record.modelId, error: err,
      });
    }

    // Message preparation can start during the lookup. Let it commit first; a newer prompt or
    // Stop must win over this resume, including when the lookup itself failed.
    for (let preparation; (preparation = this.waitForChatMessagePreparation(record.chatId));) {
      await preparation;
    }
    if (!owns()) return;
    if (liveChat.cancelController.signal.aborted) { finish(); return; }
    if (failure && shouldRetryAfterReset(failure) && resumeAttempts < AGENT_RESUME_MAX_ATTEMPTS) {
      this.resumeErrors.set(record.chatId, failure);
      this.unregisterRunningAgent(record.chatId, true);
      // A transient prepare failure parks the record silently -- no chat-visible error -- to be
      // retried by the next sweep. A park from the constructor-initiated sweep is the exact state
      // a mid-alarm eviction leaves: the alarm that fired was consumed and its success-path
      // re-arm never ran, so nothing else calls updateAlarm and the retry would never happen;
      // the chat strands until an unrelated wake. updateAlarm still sees the parked record
      // (activeAgents row + chatMeta.activeAgent = agent work), so it arms the keep-alive alarm
      // and the alarm loop's resumeErrors rethrow takes over. Inside the alarm handler this is
      // the usual no-op: the end-of-run recompute re-arms.
      this.updateAlarm();
      return;
    }
    this.resumeErrors.delete(record.chatId);

    if (!aiModel) {
      // The model is no longer available; we can't resume. Post an error and clear state. Clear
      // `activeAgent` and tear down the registry/record atomically (matching `#runAgentTurn`'s
      // finally).
      this.postAgentErrorMessage(record.chatId, this.storage.chatMeta.get(record.chatId)!.activeAgent!,
          failure ? `The agent could not be resumed: ${stringifyError(failure)}` :
          "The agent could not be resumed because its AI model is no longer available.");
      finish();
      return;
    }

    delete record.resumeAttempts;
    this.storage.activeAgents.put(record);
    await this.#runAgentTurn(
        record.chatId, aiModel, record.initiator, record.initiatorUserId, record.callbackInitiated,
        liveChat);
  }

  /**
   * The hand-off once a chat's turn is over and its running-agent state has been torn down: drop
   * the turn's live context, then deliver whatever was waiting for the chat to go idle -- steers
   * the turn never read, calls to the agent recorded during the turn (which start another turn),
   * or failing that the response an external message is waiting on. Every path that ends a turn
   * goes through here, so nothing sent mid-turn is stranded by the way the turn ended. `turn` is
   * the turn that ended, absent if none ran.
   */
  protected finishAgentTurn(chatId: number, turn?: {
    aiModel: UserAiModelRecord, initiator: AiChatAuthorInfo, initiatorUserId: string,
  }): void {
    // Release any delegateToBot await on this chat's turn first: whatever follows (a drained
    // steer's new turn, an approval park) must not leave the parent's tool call hanging.
    this.settleSubagentWaiters(chatId);

    // A turn started by the drain gets a fresh context, and with it a fresh cancel controller --
    // this one may have been aborted.
    this.liveChats.delete(chatId);

    // Steers the turn never read go to the log as if sent the moment it ended. They prompt the
    // next turn, on the same agent, unless it can't take one (none ran, or it ended waiting on the
    // user's decision): they then stay steers, read when the agent next runs.
    let meta = this.storage.chatMeta.get(chatId);
    if (meta?.queuedSteers) {
      let next = turn && !this.decisionWait(chatId) ? turn : undefined;
      if (next) meta.activeAgent = next.aiModel.profile;
      this.logQueuedSteers(meta, !next);
      if (next) {
        this.startAgent(chatId, next.aiModel, next.initiator, next.initiatorUserId);
        return;
      }
    }

    if (this.hasPendingAgentCalls(chatId)) {
      this.drainPendingAgentCalls(chatId);
    } else {
      this.resumeAgentAfterDecision(chatId);
      if (!this.storage.chatMeta.get(chatId)?.activeAgent) {
        this.deliverWaitingExternalMessageResponse(chatId);
      }
    }
  }

  /**
   * Reap crash-orphaned provisional gadgets and binding edges for the given chat. A pending
   * record/edge is sequence-stamped in the same transaction that persists the "changes" message
   * recording it (the step's barrier; see addChatMessages), so with no turn running:
   *   - An *unstamped* record/edge is a mid-step crash orphan: its step's message is by
   *     construction lost, so nothing in the log backs it. Reap it; the resumed turn simply
   *     re-creates it if the model still wants it (for a gadget, wasting only an ID, which is
   *     fine -- workpiece IDs are never reused anyway).
   *   - A *stamped* record is reaped when the log marks its creation reverted: reverts record
   *     their message before the awaited record deletions (see #revertChanges), so this is both
   *     the tail of every revert and the recovery from one that crashed partway.
   *   - A *stamped worktree* was written before recording a worktree creation promoted it (see
   *     WorktreeRecord.pending). It is promoted here instead, reverted or not.
   * Called at agent turn start (before history replay) and turn end, plus from merge and revert
   * (which assert the chat has no active turn) -- never mid-step, when an unstamped record
   * awaiting its barrier legitimately exists.
   * Best-effort per gadget: a failure (e.g. a hook controller that can't be reached) leaves the
   * record for the next reconciliation attempt.
   */
  async reconcilePendingGadgets(chatId: number): Promise<void> {
    let pending = this.listPendingGadgets(chatId);
    let unstamped = pending.filter(gadget => gadget.pending!.sequence === undefined);
    let stamped: WorkpieceRecord[] = [];
    for (let record of pending) {
      if (record.pending!.sequence === undefined) continue;
      if (record.type === "worktree") {
        delete record.pending;
        this.storage.gadgets.put(record);
      } else {
        stamped.push(record);
      }
    }

    // A marking message only affects messages recorded before it, so statuses for the stamped
    // creations need only the log tail from the earliest one on.
    let reverted: WorkpieceRecord[] = [];
    if (stamped.length > 0) {
      let statuses = chatChangeStatuses(this.storage.chats.list({
        prefix: chatKeyPrefix(chatId),
        start: chatKey(chatId, Math.min(...stamped.map(g => g.pending!.sequence!))),
      }));
      reverted = stamped.filter(g => statuses.get(g.pending!.sequence!) === "reverted");
    }
    let reaped = false;
    for (let gadget of [...reverted, ...unstamped]) {
      try {
        await this.removeWorkpiece(gadget.id);
        reaped = true;
      } catch (err) {
        this.logger.warn("failed to reap pending gadget", {
          event: "gadget.pending.reconcile.failed", chatId, error: err,
        });
      }
    }

    // (After the reaps above, which may have removed a gadget along with its edges.)
    if (this.deleteBindingEdges(edge => edge.pending?.chatId === chatId &&
                                         edge.pending.sequence === undefined).size > 0) {
      reaped = true;
    }

    // A reap changes the chat's derived proposedChangeWorkpieces (see
    // proposedChangeWorkpieceIds) without any chatMeta write of its own, so re-put the metadata
    // to re-broadcast it -- notably for the revert tail, whose own meta write precedes the
    // awaited record deletions here (see #revertChanges on why that order is fixed). A put
    // always notifies subscribers (typed-storage doesn't compare values), and the chat may be
    // gone by now (reconciliation runs after awaits), in which case there is nobody to update.
    if (reaped) {
      let meta = this.storage.chatMeta.get(chatId);
      if (meta) this.storage.chatMeta.put(meta);
    }
  }

  /**
   * Permanently delete a workpiece: its hooks, its registry entry (which for a gadget carries
   * its binding map and head commit -- the gadget's only "ref"), and its running facet (a
   * worktree has no hooks or facet, so those steps are no-ops for one). Gatekeepers a gadget
   * bound survive, possibly orphaned. The workpiece's commits become dangling objects in the git
   * store, which is fine: content-addressed objects are cheap, unreachable, and shared with any
   * related histories. (Chat docs may still hold content in the gadget's files root, and chats
   * may still pin the gadget; the pins stay because the chat's rows still fold on them. Both are
   * inert because the registry entry -- the enumeration source of truth -- is gone.)
   */
  async removeWorkpiece(id: WorkpieceId): Promise<void> {
    let record = this.storage.gadgets.get(id);
    if (!record) {
      throw new Error(`No such workpiece: ${id}`);
    }

    // Disable and delete hooks that wake this gadget.
    let def = this.defaultGadgetId;
    for (let hook of Array.from(this.storage.boundHooks.list())) {
      if ((hook.gadgetId ?? def) === id) {
        await this.deleteHook(hook.id);
      }
    }

    // (After the reaps above, which may have removed a gadget along with its edges.)
    let affectedChats = this.chatsProposing(id);
    let facetName = this.gadgetFacetName(id);
    this.storage.gadgets.delete(id);  // notifies workpiece subscribers
    this.runningChatIds.delete(id);
    this.ctx.facets.delete(facetName);
    // An agent spawner may bind the gadget (see GatekeeperRecord.bindings).
    for (let chatId of this.deleteBindingEdges(edge => edge.target === id)) {
      affectedChats.add(chatId);
    }
    this.rebroadcastChatMeta(affectedChats);
  }

  /** Disable (if needed) and delete a bound hook, updating its action-log record to match. */
  async deleteHook(id: number): Promise<void> {
    let record = this.storage.boundHooks.get(id);
    if (!record) return;
    if (record.enabled) {
      await record.controller.disable();
    }
    this.storage.boundHooks.delete(record.id);

    stampBindHookAction(this.storage, record.actionId, false, {clearHookId: true});
  }

  /**
   * Apply a single pending action: invoke the gatekeeper, mark it approved, and persist (the put
   * auto-notifies subscribeToActions). Shared by manual approval (`approveAction`) and the
   * auto-approval drain (`drainAutoApprovals`). The caller is responsible for validating that the
   * record is still pending before calling.
   *
   * `resolvedBy`/`autoApproved` are required (not defaulted) so that no apply path can omit how the
   * gate was cleared: this is the single chokepoint where an action transitions to "approved", so
   * requiring them here guarantees the audit log always records the resolving user and whether it
   * was applied automatically. For an auto-approval, `resolvedBy` is the user who enabled the rule.
   * A creation also needs `creation`: the verifier of the account the approver chose to create it
   * in, and what they chose in that account's creation configurator.
   */
  async applyPendingAction(record: ActionRecord & {type: "action"},
                           resolvedBy: AiChatAuthorInfo, autoApproved: boolean,
                           creation?: {creator: Fetcher<GatekeeperUserVerifier>,
                                       configuration: string | null}): Promise<void> {
    let id = record.gatekeeperId;
    // A created resource exists only once its creation applies, and that stays pending until then.
    if (record.action !== "create" && this.#creationPending(id)) {
      throw new Error("This resource doesn't exist yet. Approve its creation first.");
    }
    let gatekeeper = await this.getGatekeeperFacet(record.gatekeeperId);
    let created: {class: GatekeeperClass, resourceUrl: string} | undefined;
    if (record.action === "create") {
      if (!creation) throw new Error("Choose one of your accounts to create this resource in.");
      // applyCreation is optional on Gatekeeper; GatekeeperVendor.createResource()'s gatekeepers
      // implement it.
      created = await (gatekeeper as unknown as Fetcher<Gatekeeper<any> &
          Required<Pick<Gatekeeper<any>, "applyCreation">>>)
          .applyCreation(creation.creator, creation.configuration);
    } else {
      // The apply-time cache stub is scoped to the gatekeeper AND to this action (approval can
      // happen long after the session that queued it, so the queue-time stub is gone) -- the
      // binding that makes buildPack() serve exactly this action's pending-push closure.
      await gatekeeper.applyAction(record.action,
          new GitCacheImpl(this.gitCache, record.gatekeeperId, record.id));
    }
    record.state = "approved";
    record.appliedAt = new Date();
    record.resolvedBy = resolvedBy;
    record.autoApproved = autoApproved;
    // A creation switches the gatekeeper to the real resource's class in the same durable step
    // that records the approval. (Re-read: the connection may have been removed meanwhile, which
    // leaves the card's URL as the only pointer to the created resource.)
    if (created) record.resourceUrl = created.resourceUrl;
    let gatekeeperRecord = created && this.storage.gatekeepers.get(id);
    if (created && gatekeeperRecord) {
      gatekeeperRecord.class = created.class;
      gatekeeperRecord.resourceUrl = created.resourceUrl;
      if (gatekeeperRecord.creationSpec?.type === "gatekeeper") {
        gatekeeperRecord.creationSpec.resourceUrl = created.resourceUrl;
      }
    }
    // One durable step for the completion record and the mark conversion (pushed objects are
    // now proven on the remote), so a crash between the push and here strands nothing locally
    // -- the remote side of that window is the gatekeeper's applyAction idempotency
    // responsibility.
    this.storage.transaction(() => {
      this.gitCache.convertPushMarksToOnRemote(record.id);
      this.storage.actions.put(record);
      if (gatekeeperRecord) this.storage.gatekeepers.put(gatekeeperRecord);
    });
    // No await between the decision write and the durable execution claim. This also covers
    // auto-approval, rather than relying on a client's continuation after this promise resolves.
    if (record.caller.from === "agent" && record.description.awaitDecision) {
      this.resumeAgentAfterDecision(record.caller.chatId, record.id);
    }
    if (gatekeeperRecord) {
      // Restart the facet on the new class before anything else reaches it.
      this.ctx.facets.abort(`gatekeeper${id}`,
          new Error("Connection restarted because its resource was created."));
      // Minting skipped addGatekeeper's restart: collaborators had no real resource to be
      // verified against until now (see createExternalResource).
      if (this.restartIfSessionsAffected("Gadget restarted because a resource was created.")) {
        this.gatekeepersPendingRestart.add(id);
      }
    }
    // Also when a rule applies it: a user's "always approve" answers a pending request that way.
    this.traceAgentActionApproval(record, "approved");
  }

  /** Blocks other messages and agent turns for this chat until the returned object is disposed. */
  reserveChatMessagePreparation(chatId: number): Disposable {
    if (this.preparingChatMessages.has(chatId)) {
      throw new Error("A chat message is already being prepared for this chat.");
    }
    let resolve!: () => void;
    let done = new Promise<void>(resolver => {
      resolve = resolver;
    });
    this.preparingChatMessages.set(chatId, done);
    return {
      [Symbol.dispose]: () => {
        if (this.preparingChatMessages.get(chatId) !== done) return;
        this.preparingChatMessages.delete(chatId);
        resolve();
        // Calls to the agent that arrived during the preparation were recorded but not kicked
        // (see deliverAgentCallback); if the preparation didn't end up starting a turn, deliver
        // them now.
        if (!this.storage.chatMeta.get(chatId)?.activeAgent && this.hasPendingAgentCalls(chatId)) {
          this.drainPendingAgentCalls(chatId);
        } else {
          this.resumeAgentAfterDecision(chatId);
        }
      },
    };
  }

  /**
   * Migrate only the chat being used, one payload at a time. Each file's projection and
   * original-download reference publish together, so a reset retries without duplicating it.
   */
  protected async migrateChatAttachments(chatId: number): Promise<void> {
    if (this.getChatAgentContext(chatId).attachmentsMigrated) return;
    let complete = true;
    const messages = [...this.storage.chats.list({prefix: chatKeyPrefix(chatId)})];
    for (const message of messages) {
      if (message.type !== "message") continue;
      for (const attachment of message.attachments ?? []) {
        // The publication checks can race collaborator edits. Recompute from durable state on
        // retry; successful earlier files are idempotently skipped, including after a DO reset.
        for (let attempt = 0; attempt < 3; ++attempt) {
          try {
            await this.#migrateChatAttachment(chatId, message.sequence, attachment.id);
            break;
          } catch (error) {
            if (attempt < 2) continue;
            complete = false;
            this.logger.warn("legacy attachment migration deferred", {
              event: "chat.attachment.migration.deferred", chatId, sequence: message.sequence, error,
            });
          }
        }
      }
    }
    if (complete && this.storage.chatMeta.get(chatId)) {
      this.storage.chatContext.put({...this.getChatAgentContext(chatId), attachmentsMigrated: true});
    }
  }

  async #migrateChatAttachment(chatId: number, sequence: number, id: string): Promise<void> {
    const message = this.storage.chats.get(chatKey(chatId, sequence));
    if (message?.type !== "message") return;
    const attachment = message.attachments?.find(ref => ref.id === id);
    if (!attachment) return;
    const source = this.storage.chatAttachmentContent.get(id);
    if (source?.state.type !== "committed" || source.state.chatId !== chatId) return;
    if (source.state.oid !== undefined && attachment.workspacePath !== undefined) return;
    const oid = source.state.oid ??
      (await this.gitStore.writeBlob(await this.getChatAttachmentData(chatId, id))).oid;
    const projected = {...attachment, oid};
    const files = attachment.workspacePath === undefined
      ? await this.prepareWorkspaceAttachmentFiles(chatId, [projected]) : new Map<string, FileContent>();
    const worktree = this.scratchWorktree(chatId);
    const prepared = await this.prepareScratchWorktree(chatId, files, message.author);
    const changes = worktree && files.size
      ? this.prepareWorkspaceAttachmentChanges(chatId, worktree, files) : [];
    this.storage.transaction(() => {
      if (!this.storage.chatMeta.get(chatId)) return;
      const current = this.storage.chats.get(chatKey(chatId, sequence));
      if (current?.type !== "message") return;
      const ref = current.attachments?.find(ref => ref.id === id);
      if (!ref) return;
      const stored = this.storage.chatAttachmentContent.get(id);
      if (stored?.state.type !== "committed" || stored.state.chatId !== chatId) return;
      if (stored.state.oid !== undefined && ref.workspacePath !== undefined) return;
      if (this.scratchWorktree(chatId)?.id !== worktree?.id) {
        throw new Error("Scratch worktree changed during attachment migration; retry.");
      }
      if (prepared) this.installScratchWorktree(chatId, prepared);
      if (worktree) this.appendWorkspaceAttachments(chatId, worktree, changes, message.author);
      Object.assign(ref, projected);
      this.storage.chats.put(current);
      this.storage.chatAttachmentContent.put({fileId: id, state: {
        type: "committed", chatId, oid, workspacePath: ref.workspacePath,
      }});
    });
    await this.ctx.storage.sync();
  }

  async #writeWorkspaceAttachmentCommit(
      files: ReadonlyMap<string, FileContent>, author: AiChatAuthorInfo): Promise<string | undefined> {
    if (files.size === 0) return undefined;
    return await this.gitStore.writeFilesAsCommit(files, {
      parents: [],
      author: commitIdentityForAuthor(author),
      message: "Store uploaded chat attachments",
      timestamp: new Date(),
    });
  }

  protected async prepareScratchWorktree(
      chatId: number, files: ReadonlyMap<string, FileContent>, author: AiChatAuthorInfo)
      : Promise<PreparedScratchWorktree | undefined> {
    if (files.size === 0 || this.scratchWorktree(chatId) !== undefined) return undefined;
    let bindingName = fallbackBindingName(
        "SCRATCH", name => this.chatScopeNames(chatId).has(name));
    let commitId = (await this.#writeWorkspaceAttachmentCommit(files, author))!;
    return {commitId, bindingName};
  }

  /**
   * Enforce an observation's `excludeObservers`, named by the gatekeeper `gatekeeperId` produced
   * it. For each named opaque observerId:
   *   - Map it back to a profileId via the byObserverId index. An unknown id is not an active
   *     observer (e.g. already torn down), so it is ignored.
   *   - If that profileId is still authorized in the sharing graph *and* this gatekeeper is still
   *     in their role's verification scope, we cannot guarantee they won't see the observation (v1
   *     has no per-thread hiding), so we throw to block it.
   *   - If this gatekeeper has left their scope, they cannot reach the observation and must not
   *     block it. They stay a collaborator with an intact record, so only their registration on
   *     *this* gatekeeper is dropped -- which is what left them named here after the connection
   *     was unbound, since a "use" collaborator's open never re-verifies (and so never re-registers
   *     or removes) a gatekeeper outside their scope. A rebind puts it back in scope and their next
   *     open registers them again.
   *   - If that profileId is no longer authorized, we allow the observation for them and delete
   *     their observer record (best-effort removeObserver on all gatekeepers). They are no longer
   *     set up to observe; if they regain access they reconfigure from scratch (Step 3).
   * If no named observer can reach the observation, it is allowed. Every id is classified before
   * anything is torn down, so a blocked observation leaves no teardown behind it; the removals are
   * then all issued together and awaited at once.
   */
  protected async enforceExcludeObservers(gatekeeperId: number, observerIds: string[]): Promise<void> {
    let sharing = await this.getSharingManager();

    let unauthorized: ObserverRecord[] = [];
    let outOfScope: string[] = [];
    for (let observerId of observerIds) {
      let observer = this.storage.observers.byObserverId.get(observerId);
      // TODO(observer-races): a first-time ensureObserver registers its observerId with the
      // gatekeepers before the record is persisted, so an id named here in that window reads as
      // unknown and the observation is admitted. Fix: an in-memory pending-id map consulted
      // here, failing closed.
      if (!observer) continue;  // not an active observer -> ignore
      let role = sharing.getEffectiveRole(observer.profileId);
      if (!role) {
        unauthorized.push(observer);
      } else if (this.#inRoleVerificationScope(gatekeeperId, role)) {
        // The mark lets gatekeepers reclaim prepared observer state: the refusal proves nothing
        // was recorded (see OBSERVATION_REFUSED_CODE).
        throw createObservationRefusedError();
      } else {
        outOfScope.push(observerId);
      }
    }

    // Nobody named can reach the observation. Tear down those who have lost access entirely, since
    // they are no longer set up to observe at all, and de-register the rest from this gatekeeper
    // only. A fresh open racing one of these removals is ordered behind it by
    // #withObserverGatekeeperLock, so its registration is never silently undone.
    let allGatekeeperIds = [...this.storage.gatekeepers.list()].map(gk => gk.id);
    let removals = unauthorized.map(observer => {
      this.storage.observers.delete(observer.profileId);
      return this.removeObserverFromGatekeepers(observer.observerId, allGatekeeperIds);
    });
    for (let observerId of outOfScope) {
      removals.push(this.removeObserverFromGatekeepers(observerId, [gatekeeperId]));
    }
    await Promise.all(removals);
  }

  // Whether `gatekeeperId` is in the verification scope of a collaborator holding `role`, i.e.
  // whether an observer of that role could have been verified against it -- and so whether their
  // being named in its `excludeObservers` means anything.
  //
  // Fail-closed and deliberately narrow: the only way out is "role is `use`, the connection
  // requires an account, and neither a gadget binding, an enabled hook, nor a reachable agent
  // spawner's env makes it reachable" (see #useScopeGatekeeperIds). A "build" collaborator's
  // scope is every account-requiring connection, and a connection requiring no account never
  // verifies anyone, so both stay in scope and block exactly as before.
  //
  // Uses #accountRequiringUseScope() rather than #inScopeGatekeepers("use"), whose
  // observerVendorId() throws on a legacy record with no creationSpec: an unrelated legacy
  // connection must not turn the observation path into an error.
  #inRoleVerificationScope(gatekeeperId: number, role: CollaboratorRole): boolean {
    if (role !== "use") return true;
    if (!gatekeeperVendorId(this.storage.gatekeepers.get(gatekeeperId))) return true;
    return this.accountRequiringUseScope().has(gatekeeperId);
  }

  /**
   * Diff the account-requiring "use" scope against a snapshot taken just before a mutation, and
   * when it widened onto a live "use" session, restart -- additionally blocking each widened
   * connection until the reset lands (see #gatekeepersPendingRestart): the severed sessions stay
   * live for the reset's ~100ms delay, and a gadget facet reload in that window would otherwise
   * mint fresh binding loopbacks onto a connection nobody verified the holder against. Marking
   * the gatekeeper ids suffices as quarantine because every such loopback funnels through
   * openGatekeeperSession (assertGatekeeperUsable). Shared by every "use"-scope widening site:
   * bindWorkpiece, mergeChatChanges, enableHookRecord.
   */
  protected restartIfUseScopeWidened(useScopeBefore: Set<WorkpieceId>, reason: string): void {
    let widened = [...this.accountRequiringUseScope()].filter(id => !useScopeBefore.has(id));
    if (widened.length === 0) return;
    if (this.restartIfSessionsAffected(reason, "use")) {
      for (let id of widened) this.gatekeepersPendingRestart.add(id);
    }
  }

  async sendChatMessage(
    clientUser: DurableObjectStub<UserDurableObject>,
    userMeta: UserChatContext,
    chatId: number,
    message: string | SlashCommandRequest,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    responseTargetRegistration?: ExternalMessageResponseTargetRegistration,
    formats?: MessageFormatRef[],
    bot?: BotSelection | "none",
  ): Promise<void> {
    if (responseTargetRegistration) {
      let decision = this.prepareExternalMessageResponseTargetRegistration(responseTargetRegistration);
      if (decision.reuseExisting) return;
    }
    if (typeof message !== "string" && (capsules?.length || attachments?.length)) {
      throw new Error("Slash commands cannot include resources or attachments.");
    }
    let canonicalAttachments = this.canonicalizeChatAttachmentRefs(attachments);
    this.assertChatNotActive(chatId);
    using _chatMessageReservation = this.reserveChatMessagePreparation(chatId);
    await this.migrateChatAttachments(chatId);
    let prepared = await this.prepareChatMessage(
        message, (canonicalAttachments?.length ?? 0) > 0);

    // A bot param switches the chat's bot (re-snapshotting, as at start) or, as "none", clears
    // it. Both ride the next send: this code runs past assertChatNotActive and the message
    // reservation, so a switch only ever lands on an idle chat. Absent means no change -- the
    // retries and steers below must not disturb the chat's bot.
    let botSnapshot = userMeta.bot ? await this.snapshotBotForChat(userMeta.bot) : undefined;

    let attachmentFiles = await this.prepareWorkspaceAttachmentFiles(chatId, canonicalAttachments);
    let scratchWorktree = this.scratchWorktree(chatId);
    let preparedScratchWorktree: PreparedScratchWorktree | undefined;
    let attachmentSourceCommit: string | undefined;
    if (scratchWorktree !== undefined) {
      attachmentSourceCommit = await this.#writeWorkspaceAttachmentCommit(
          attachmentFiles, userMeta.profile);
      // Prefetch only. Workspace rows and attachment references land with the validated message.
      if (attachmentFiles.size) {
        await this.getCurrentChatContent(chatId, this.getChatMetaOrThrow(chatId));
        for (const path of attachmentFiles.keys()) {
          await this.gitCache.assertWorktreePathWritable(scratchWorktree.pinBase, path);
        }
      }
    } else {
      preparedScratchWorktree = await this.prepareScratchWorktree(
          chatId, attachmentFiles, userMeta.profile);
      attachmentSourceCommit = preparedScratchWorktree?.commitId;
    }

    let meta = this.assertChatNotActive(chatId, true);
    let result = this.materializeChatChanges(chatId, meta);
    if (result) meta = result.meta;
    const attachmentChanges = scratchWorktree && attachmentFiles.size
      ? this.prepareWorkspaceAttachmentChanges(chatId, scratchWorktree, attachmentFiles) : [];
    meta.lastActive = this.getChatTimestamp();
    // A built-in command runs a turn without a prompt: `/compact` compacts and ends.
    let runsAgentTurn = prepared.message !== undefined ||
        prepared.slashCommand?.id.builtin === true;
    if (runsAgentTurn && userMeta.aiModel) {
      meta.activeAgent = userMeta.aiModel.profile;
    }
    try {
      this.ctx.storage.transactionSync(() => {
        let context = this.getChatAgentContext(chatId);
        if (botSnapshot) {
          meta.botName = botSnapshot.botConfig.name;
          meta.bot = botSnapshot.botConfig.selection;
          context = {...context, ...botSnapshot};
        } else if (bot === "none") {
          delete meta.botName;
          delete meta.bot;
          delete context.botConfig;
          delete context.botSkills;
          delete context.unavailableBotSkills;
          delete context.botSection;
        }
        this.storage.chatContext.put(context);
        this.storage.chatMeta.put(meta);
        let promptSequence = this.commitPreparedChatMessage(
            chatId, meta.lastActive, userMeta.profile, prepared, capsules, canonicalAttachments,
            formats, preparedScratchWorktree, attachmentSourceCommit);
        if (scratchWorktree && attachmentFiles.size) {
          this.appendWorkspaceAttachments(chatId, scratchWorktree, attachmentChanges, userMeta.profile);
        }
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
      });
    } catch (error) {
      // The row appender updates disposable caches too; discard them after storage rollback.
      this.invalidateChatContent(chatId);
      this.liveWindowCache.delete(chatId);
      throw error;
    }

    if (runsAgentTurn && userMeta.aiModel) {
      let needsAgentTurnKeepAlive = responseTargetRegistration !== undefined;
      this.startAgent(chatId, userMeta.aiModel, userMeta.profile,
                      clientUser.id.toString(), false, needsAgentTurnKeepAlive);
    }
    this.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: clientUser.id.toString(),
      chat_id: chatId,
      interaction_type: "chat_message_sent",
    });
  }

  /**
   * Start an agent turn for the given chat (fire-and-forget). Persists an `ActiveAgentRecord` so
   * the turn can be resumed after a server restart, and tracks the turn so the keep-alive alarm is
   * held while it runs. `initiatorUserId` is the hex DO ID of the user whose model/account is used,
   * needed to re-resolve the model config on resume.
   */
  startAgent(chatId: number, aiModel: UserAiModelRecord,
             initiator: AiChatAuthorInfo, initiatorUserId: string,
             callbackInitiated: boolean = false,
             keepAlive: boolean = false): void {
    // Register before starting the turn so registration always precedes the turn's teardown
    // (`#unregisterRunningAgent`, in `#runAgentTurn`'s finally).
    this.registerRunningAgent(chatId);
    this.resumeErrors.delete(chatId);
    this.storage.activeAgents.put({
      chatId,
      initiatorUserId,
      modelId: aiModel.profile.id,
      initiator,
      callbackInitiated,
    });

    let liveChat = this.getLiveChat(chatId);
    let turn = this.#runAgentTurn(
        chatId, aiModel, initiator, initiatorUserId, callbackInitiated, liveChat);
    if (keepAlive) this.ctx.waitUntil(turn);
  }

  #runAgentTurn(chatId: number, aiModel: UserAiModelRecord,
                initiator: AiChatAuthorInfo,
                initiatorUserId: string,
                callbackInitiated: boolean,
                liveChat: LiveChatContext): Promise<void> {
    return obsContext.with({
      operation: "agent.run",
      gadgetId: this.ctx.id.toString(),
      chatId,
      modelId: aiModel.profile.id,
    }, () => this.#runAgentTurnWithContext(
        chatId, aiModel, initiator, initiatorUserId, callbackInitiated, liveChat));
  }

  async #runAgentTurnWithContext(chatId: number, aiModel: UserAiModelRecord,
                                 initiator: AiChatAuthorInfo,
                                 initiatorUserId: string,
                                 callbackInitiated: boolean,
                                 liveChat: LiveChatContext): Promise<void> {
    let owns = () => this.liveChats.get(chatId) === liveChat;
    // When this turn is billed to the user's own Cloudflare account, we refresh their cached credit
    // balance once the turn completes (see the `finally` below) so the next billing decision
    // reflects the spend this turn just incurred, rather than waiting for the cache TTL to lapse.
    let byokOwnerStub: DurableObjectStub<UserDurableObject> | undefined;
    let finished = false;
    // Why the turn ended early, posted in the `finally`.
    let failure: {message: string, code?: string} | undefined;
    // The turn's last model request, kept warm while the chat is viewed (see ChatCacheWarmer).
    let lastRequest: CachedRequest | undefined;
    let startedAt = Date.now();
    const turnLogger = this.logger.with({
      operation: "agent.run",
      chatId,
      modelId: aiModel.profile.id,
    });
    turnLogger.debug("agent run started", {
      event: "agent.run.started", callbackInitiated,
    });

    try {
      // The trace span covers the turn's setup and run, not the teardown below, which can start the
      // chat's next turn.
      await traceAgentTurn(this.getChatAgentContext(chatId), liveChat.cancelController.signal,
          async turn => {
        // Reap any provisional gadgets orphaned by a crashed prior turn before snapshotting
        // history: replay must not see registry records the chat log doesn't back (an unstamped
        // record's creating step never reached its barrier, so the log holds no trace of it; see
        // reconcilePendingGadgets). The model then simply re-creates a reaped gadget if it still
        // wants it.
        await this.reconcilePendingGadgets(chatId);
        if (!owns()) return;
        liveChat.cancelController.signal.throwIfAborted();

        // Turn-start materialization: live rows recorded before this turn (user edits, for turns
        // not started via sendChatMessage -- callbacks, resumes) become a durable "changes"
        // message attributed to their own authors, so the turn's appends never share a batch with
        // them. (`allowDuringTurn` because the callers set activeAgent before starting us.)
        this.materializeChatChanges(chatId, undefined, {allowDuringTurn: true});

        // Enforce the optional free-tier usage limit before starting the turn, and resolve whether
        // it bills the owner's own gateway.
        // When the Cloudflare limits flow is disabled, checkUsageAndBalance() always allows.
        // (This runs inside the try so the `finally` below still clears the active-agent state and
        // emits a stream "clear" — otherwise the UI would spin forever on a block.)
        let byokRouting: UserGatewayRouting | undefined;
        if (this.ownerId) {
          let ownerStub = this.users.get(this.users.idFromString(this.ownerId));
          let usage = await checkUsageAndBalance(this.env, ownerStub);
          if (!usage.allowed) {
            turn.setErrorType("usage_limit");
            failure = {message: usage.reason ?? "Usage limit reached.", code: "usage_limit"};
            turnLogger.debug("agent run finished", {
              event: "agent.run.finished", outcome: "usage_limit",
              durationMs: Date.now() - startedAt,
            });
            return;
          }
          // Free tier exhausted but the user can continue via their own Cloudflare gateway: route
          // inference through it so the usage bills their account. checkUsageAndBalance already
          // resolved the routing (reusing its connection lookup), so we don't decrypt the token
          // again.
          if (usage.shouldUseByok) {
            byokRouting = usage.byokRouting;
            if (byokRouting) byokOwnerStub = ownerStub;
          }
        }

        let sessionAffinity = await computeSessionAffinity(this.ctx.id.toString(), chatId);
        let chosenModel = getModel(
            this.env, aiModel.config, initiator, {
              sessionAffinity,
              userGateway: byokRouting,
              metadata: { source: "chat", gadgetId: this.ctx.id.toString(), chatId },
            });
        turn.setModel(chosenModel.model);

        let controller = liveChat.cancelController;
        controller.signal.throwIfAborted();

        await this.migrateChatAttachments(chatId);
        lastRequest = await runAgent(
            this.self(), chosenModel, chatId, aiModel.profile, controller.signal, initiator, aiModel.config);
        finished = true;
        turnLogger.debug("agent run finished", {
          event: "agent.run.finished", outcome: "ok",
          durationMs: Date.now() - startedAt,
        });
      });
    } catch (err: unknown) {
      if (!owns()) return;
      // A failed model request surfaces as AgentTurnError (pi reports provider failures as data;
      // runAgent converts them back to a throw), carrying the failing request's HTTP status when
      // one was observed.
      let apiError = err instanceof AgentTurnError ? err : null;

      // Report unexpected failures for triage. Skip expected provider 4xx (auth,
      // rate limit, quota/billing), which are ordinary control flow, not incidents.
      const apiStatus = apiError?.statusCode;
      if (apiStatus === undefined || apiStatus >= 500) {
        reportIssue("overseer.run-agent", err, {
          attributes: obsContext.get(),
          http: apiStatus === undefined
            ? undefined
            : { kind: "client", responseStatusCode: apiStatus },
        });
      }

      let errorMessage = stringifyError(err);
      if (apiError) {
        turnLogger.error("runAgent failed", {
          event: "agent.run.failed", statusCode: apiError.statusCode, error: err,
        });
      } else {
        turnLogger.error("runAgent failed", {
          event: "agent.run.failed", error: err,
        });
      }
      turnLogger.debug("agent run finished", {
        event: "agent.run.finished", outcome: "error",
        durationMs: Date.now() - startedAt,
      });

      failure = {message: errorMessage};
    } finally {
      if (owns()) {
        // If this turn billed the user's own Cloudflare account, refresh their cached balance now (in
        // the background) so the next turn's billing decision reflects the spend just incurred. Runs
        // on both the success and error paths — an "insufficient funds" failure is exactly when an
        // up-to-date balance matters most.
        if (byokOwnerStub) {
          this.ctx.waitUntil(refreshCachedBalance(this.env, byokOwnerStub));
        }

        // Reap any provisional gadget this turn created whose creating step never reached its
        // barrier (the turn erred or was aborted mid-step): the record is unstamped and the
        // step's message is by construction lost, so nothing in the log backs it. Never throws,
        // so it can't mask an error propagating out of the turn.
        await this.reconcilePendingGadgets(chatId);
        if (owns()) {
          // Posted past the turn's last await, so a steer sent as the turn winds down still lands
          // before the error, which must stay last for Retry to show.
          if (failure) {
            this.postAgentErrorMessage(chatId, aiModel.profile, failure.message, failure.code);
          }

          // Note: We no longer emit a stream "clear" event here. The client performs a full clear of
          // provisional streaming state when it observes that the agent is no longer running (i.e. when
          // chat metadata's activeAgent becomes unset, which happens just below).

          let meta = this.storage.chatMeta.get(chatId);
          if (meta) {
            delete meta.activeAgent;
            meta.lastActive = this.getChatTimestamp();
            this.storage.chatMeta.put(meta);
          }

          // Keep only an unfinished decision's original caller/model. An approval during teardown
          // may already be ready; #finishAgentTurn claims it in this same synchronous span.
          if (meta && liveChat.cancelController.signal.aborted && this.decisionWait(chatId)) {
            // A tool that was already in flight may have committed its card after Stop's boundary.
            this.addChatMessages(chatId, initiator,
                [{type: "agentNudge", text: "The user stopped this turn. Wait for a new request."}]);
          }
          let wait = this.decisionWait(chatId);
          this.unregisterRunningAgent(chatId,
              finished && !liveChat.cancelController.signal.aborted && !!meta && !!wait && !wait.denied);

          // Without `meta`, the chat was deleted while the turn was ending.
          if (lastRequest && meta) this.cacheWarmer.start(chatId, lastRequest, aiModel.profile.id);

          if (finished && meta) {
            // Classified here, past the turn's last await, so a decision made as it ended counts.
            this.#publishAgentTurnNotification(chatId, initiator, initiatorUserId);
          }

          // A failed turn logged its unread steers before its error (see postAgentErrorMessage),
          // so it starts no follow-up, which would likely fail the same way.
          this.finishAgentTurn(chatId, {aiModel, initiator, initiatorUserId});
        }
      }
    }
  }

  /**
   * Append the chat's pending agent calls to its chat log as agentCallback messages and, if the
   * initiator has a model, start the agent. Called whenever the chat may have become idle with
   * calls pending; a no-op if it hasn't. The callers were answered when their calls were recorded,
   * so any failure here is surfaced in the chat and the log, never to them.
   *
   * Most callers fire and forget, and this may die mid-way (a crash resets the DO). That is safe:
   * a call stays recorded until the synchronous block below moves it into the log, so nothing is
   * lost, and a recorded call counts as outstanding agent work for the alarm (see
   * #agentKeepAliveTime), so the DO is woken to retry rather than waiting on the next event.
   *
   * Single-flight per chat: a kick while a drain is already in flight joins it rather than
   * starting another (the in-flight one re-lists the records after its awaits, so it picks up
   * anything recorded meanwhile). This is what lets runAlarmTasks see a drain as work in progress,
   * and it keeps the constructor and the alarm handler, which may both kick the same chat, from
   * resolving the model twice or reporting a failure twice.
   */
  drainPendingAgentCalls(chatId: number): Promise<void> {
    let drain = this.pendingCallDrains.get(chatId);
    if (!drain) {
      drain = this.#drainPendingAgentCalls(chatId)
          .finally(() => {
            this.pendingCallDrains.delete(chatId);
            // A drain can also settle without starting a turn (its chat was deleted, or its
            // initiator has no model), which unregistering a running agent never observes.
            this.wakeIdleWaiters();
          });
      this.pendingCallDrains.set(chatId, drain);
    }
    return drain;
  }

  async #drainPendingAgentCalls(chatId: number): Promise<void> {
    let author: AiChatAuthorInfo | undefined;
    try {
      let [first] = Array.from(this.storage.pendingAgentCalls.list(
          {prefix: chatKeyPrefix(chatId), limit: 1}));
      if (!first) return;

      // Resolve the model and profile from the initiator of the first call, so if several calls
      // are delivered in one turn it is charged to that one. A model that can't be resolved
      // (deleted since) is final: the calls are still appended, with an error in place of a turn,
      // so a human sees them and the alarm isn't retrying forever. For that we need the profile
      // alone; if even that fails, the user DO itself is the problem, which is transient -- the
      // calls stay recorded and the alarm retries.
      let user = this.wrapUserDo(this.users.get(this.users.idFromString(first.initiatorUserId)));
      let userMeta: UserChatContext;
      let modelError: unknown;
      try {
        userMeta = await user.getChatContext(first.initiatorModelId);
      } catch (err) {
        if (first.initiatorModelId === null) throw err;  // nothing model-related to fall back from
        modelError = err;
        userMeta = await user.getChatContext(null);
      }
      author = this.gadgetAuthorFor(userMeta.profile);

      // getChatContext() waits on the user's Durable Object. A user message may start an agent
      // while that call is pending, so wait for message preparation to finish and then re-read
      // chat state. If a turn is running now, its end drains the calls instead.
      let preparation = this.waitForChatMessagePreparation(chatId);
      while (preparation) {
        await preparation;
        preparation = this.waitForChatMessagePreparation(chatId);
      }
      let meta = this.storage.chatMeta.get(chatId);
      if (!meta) return;  // deleted meanwhile; deleteChat removed the calls too
      if (meta.activeAgent) return;

      // Move every recorded call into the chat log. No awaits from here to the turn start, so a
      // crash cannot leave a call half-delivered, and a call recorded after this point waits for
      // the turn to end. Each call's arguments get an env name, unique in the chat's scope as of
      // this point in the log, stamped on the message like capsule binding names are.
      let initiatorUserId = first.initiatorUserId;
      let taken = this.chatScopeNames(chatId);
      for (let call of Array.from(this.storage.pendingAgentCalls.list(
          {prefix: chatKeyPrefix(chatId)}))) {
        let sequence = this.nextChatSequence(chatId);
        let bindingName = callArgsBindingName(call.methodName, name => taken.has(name));
        taken.add(bindingName);
        // The args go in a separate table (not sent to clients); they were already proven
        // storable when they were recorded.
        this.storage.agentCallbackArgs.put({ chatId, sequence, args: call.args });
        this.storage.chats.put({
          chatId,
          sequence,
          timestamp: this.getChatTimestamp(),
          author,

          type: "agentCallback",
          methodName: call.methodName,
          argsSummary: call.argsSummary,
          bindingName,
        });
        this.storage.pendingAgentCalls.deleteRecord(call);
      }

      if (modelError !== undefined) {
        this.logger.error("model unavailable for pending agent calls", {
          event: "agent.callback.start.failed", error: modelError, chatId,
        });
        this.postAgentErrorMessage(chatId, author,
            `Could not start the agent to handle its call(s): ${stringifyError(modelError)}`);
        this.deliverWaitingExternalMessageResponse(chatId);
        return;
      }
      if (!userMeta.aiModel) {
        // The spawner has no model: the calls sit in the chat for a human to pick up.
        this.deliverWaitingExternalMessageResponse(chatId);
        return;
      }

      meta.activeAgent = userMeta.aiModel.profile;
      meta.lastActive = this.getChatTimestamp();
      this.storage.chatMeta.put(meta);
      this.startAgent(chatId, userMeta.aiModel, author, initiatorUserId,
                      /* callbackInitiated */ true);
    } catch (err) {
      this.logger.error("failed to deliver pending agent calls", {
        event: "agent.callback.start.failed", error: err, chatId,
      });
      if (author) {
        this.postAgentErrorMessage(chatId, author,
            `Failed to start the agent to handle its pending call(s): ${stringifyError(err)}`);
        this.deliverWaitingExternalMessageResponse(chatId);
      }
    } finally {
      // The set of pending calls changed (or a turn started): recompute the alarm.
      this.updateAlarm();
    }
  }

  // Normal teardown and recovery of a logged outcome notify the same original caller. Only a
  // person waits on completion; callbacks and spawned agents notify only when permission is needed.
  #publishAgentTurnNotification(chatId: number, initiator: AiChatAuthorInfo, initiatorUserId: string): void {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) return;
    let awaitingDecision = this.decisionWait(chatId)?.pending ?? false;
    if (!awaitingDecision && initiator.type !== "user") return;
    this.ctx.waitUntil(this.users.get(this.users.idFromString(initiatorUserId))
        .publishNotification({
          id: crypto.randomUUID(),
          kind: awaitingDecision ? "permissionRequested" : "taskCompleted",
          workspaceId: this.ctx.id.toString(),
          chatId,
          chatTitle: meta.title,
        }).catch(error => {
          this.logger.warn("notification publish failed", {
            event: "notification.publish.failed", chatId, error,
          });
        }));
  }

  /**
   * No await: the decision, its model-visible note, busy state, execution row and alarm all
   * precede model lookup. Live resumption and restart recovery then use the same #resumeAgent.
   */
  resumeAgentAfterDecision(chatId: number, decisionId?: number | string): void {
    let meta = this.storage.chatMeta.get(chatId);
    if (meta?.activeAgent) return; // Teardown rechecks after releasing this execution.
    let record = this.storage.activeAgents.get(chatId);
    if (!record) return;
    let wait = this.decisionWait(chatId);
    if (wait && decisionId !== undefined && !(typeof decisionId === "number"
        ? wait.actionIds.includes(decisionId) : wait.requestIds.includes(decisionId))) return;
    if (!meta || !wait || wait.denied) {
      this.storage.activeAgents.delete(chatId);
      // Dropping the record ends any delegation awaiting this chat's turn: settle its waiter
      // and mark the delegation done, so a parent re-awaiting after a reset answers from the
      // log instead of hanging on a turn that will never run.
      this.settleSubagentWaiters(chatId);
      return;
    }
    if (wait.pending || this.isPreparingChatMessage(chatId)) return;
    let text = wait.titles.length
        ? `The changes you submitted have been approved and applied: ${wait.titles.map(t => `"${t}"`).join(", ")}. Reads now reflect them.`
        : "The requested connections have been accepted. Continue using the connected resources.";
    this.addChatMessages(chatId, record.initiator, [{type: "agentNudge", text}]);
    meta.activeAgent = wait.agent;
    meta.lastActive = this.getChatTimestamp();
    this.storage.chatMeta.put(meta);
    this.registerRunningAgent(chatId);
    this.resumeAgent(record, this.getLiveChat(chatId)).catch(error => {
      // The async resume rejected before any of its own handling surfaced the failure: log it
      // and leave the record for the next sweep (alarm wake or next construction).
      this.logger.error("agent resume failed to start", {
        event: "agent.resume.start.failed", chatId, error,
      });
    });
  }

  // --- Connection-request hooks ---

  // Whether the gatekeeper's resource is still simulated: its creation is pending.
  #creationPending(id: WorkpieceId): boolean {
    return [...this.storage.actions.pendingByGatekeeper.get(id)]
        .some(queued => queued.type === "action" && queued.action === "create");
  }

  // --- Blueprint hooks for the agent ---

  /**
   * Gatekeeper ids reachable from a "use" collaborator's session, and therefore all of their
   * verification scope: everything bound by some non-provisional gadget (the gadget UI they drive
   * can invoke it), plus every connection with an *enabled* hook -- a hook is a live write channel
   * into the gadget it wakes, delivering the connection's data into state that collaborator can
   * open, regardless of binding edges -- plus, transitively, every binding target of a reachable
   * agent spawner: connectToGadget mints the bound spawner's loopback with no role filter
   * (getEnvForLoader), and spawn/spawnCallable seeds the spawned agent's bindings from the
   * spawner's (AgentSpawnerQueueImpl), handing the collaborator an agent that reads those
   * connections with the creator's authority and returns their data.
   */
  protected useScopeGatekeeperIds(): Set<WorkpieceId> {
    let ids = new Set<WorkpieceId>();
    for (let gadget of this.storage.gadgets.list()) {
      // Provisional gadgets and binding edges aren't visible to "use" collaborators, so they
      // don't bring gatekeepers into scope. (Worktrees have no binding edges at all.)
      if (gadget.type !== "gadget" || gadget.pending) continue;
      for (let [, edge] of this.visibleBindings(gadget)) {
        ids.add(edge.target);
      }
    }
    for (let hook of this.storage.boundHooks.list()) {
      if (!hook.enabled) continue;
      // A hook wakes one gadget; while that gadget is still provisional to a chat, "use"
      // collaborators can't open it (getGadget refuses pending gadgets), so the hook doesn't
      // bring its connection into their scope. Promotion deletes `pending` inside
      // mergeChanges' scope diff, which reports the widening then. An unresolvable target
      // (no gadgetId and no default gadget, or a deleted record) stays in scope, fail-closed.
      let gadgetId = hook.gadgetId ?? this.defaultGadgetId;
      if (gadgetId !== undefined && this.storage.gadgets.get(gadgetId)?.pending) continue;
      ids.add(hook.gatekeeperId);
    }

    // Close over agent spawners' bindings. The closure roots at the reachable set above because
    // an *unbound* spawner is unreachable (loopbacks are minted only through gadget binding edges
    // and chat bindings, and chats are owner/build-only), and a spawner's permanent bindings grow
    // only by promotion -- so every widening lands on the diffs around the sites that grow the
    // roots or promote (bindWorkpiece, mergeChanges, enableHookRecord), with no dedicated
    // trigger. Spawner-to-spawner bindings are legal, hence the worklist; a binding target that
    // is a gadget is skipped -- such gadgets are non-pending, so their bindings are covered by
    // the first loop.
    //
    // The bindings are also the ceiling, not just the seed: a spawned chat's agent has neither
    // the requestConnection tool nor setGadgetBinding (agent.ts restricts spawned agents to
    // describeBinding/executeCode), and connection requests are created only by the former, so
    // no accepted request can ever add a connection to a spawned chat beyond the spawner's
    // bindings. If spawned agents ever gain either tool, this closure must learn about it too.
    let pending = [...ids];
    while (pending.length > 0) {
      let spawner = this.storage.gatekeepers.get(pending.pop()!);
      for (let [, {target}] of this.visibleBindings({bindings: spawner?.bindings ?? {}})) {
        if (ids.has(target) || !this.storage.gatekeepers.get(target)) continue;
        ids.add(target);
        pending.push(target);
      }
    }
    return ids;
  }

  /**
   * The account-requiring subset of #useScopeGatekeeperIds(): exactly what a "use" collaborator
   * is verified against, as an id set two states can be compared by (see mergeChatChanges).
   *
   * Uses the non-throwing gatekeeperVendorId() rather than #inScopeGatekeepers("use"), whose
   * observerVendorId() throws on a legacy record with no creationSpec: an unrelated legacy
   * connection must not turn a caller's ordinary bookkeeping into an error.
   *
   * A reachable legacy record (no creationSpec) joins the set even though it has no vendor to
   * verify against: nobody CAN be verified against it, so it becoming reachable must restart
   * and quarantine -- fresh use opens then fail closed via observerVendorId() -- rather than
   * vanish from both sides of the widening diff and leave live sessions invoking it.
   */
  protected accountRequiringUseScope(): Set<WorkpieceId> {
    let ids = new Set<WorkpieceId>();
    for (let id of this.useScopeGatekeeperIds()) {
      let gk = this.storage.gatekeepers.get(id);
      if (gk && (!gk.creationSpec || gatekeeperVendorId(gk))) ids.add(id);
    }
    return ids;
  }

  /**
   * Selects the gatekeepers a non-owner observer with the given `role` must be verified against:
   *   - "build" collaborators (full access): every account-requiring gatekeeper.
   *   - "use" collaborators (UI only): only account-requiring gatekeepers some gadget binds or an
   *     enabled hook feeds, since that is all their sessions can reach.
   *
   * The scope filter runs before observerVendorId(), which throws on a legacy record with no
   * creationSpec: an unrelated legacy connection outside the caller's scope must not block their
   * open, since nothing they can reach needs verification against it. An in-scope one still
   * throws, fail-closed (and "build" scope is everything, so it always throws there).
   *
   * TODO(known-risk): a "use" collaborator is never verified against a producer outside their
   *   scope, yet restricted data read from it can reach gadget state they see, because provenance
   *   is not tracked past the observation. Accepted for v1; see "Known security risk -- never-bound
   *   producers" in plans/restricted-data-sharing.md.
   */
  protected inScopeGatekeepers(role: CollaboratorRole): GatekeeperRecord[] {
    let boundIds = role === "use" ? this.useScopeGatekeeperIds() : undefined;

    let result: GatekeeperRecord[] = [];
    for (let gk of this.storage.gatekeepers.list()) {
      if (boundIds && !boundIds.has(gk.id)) continue;
      if (!observerVendorId(gk)) continue;
      result.push(gk);
    }
    // A simulated resource has no account behind it to verify anyone against. Approving its
    // creation restarts every session (see applyPendingAction), so verification happens then.
    // (Filtered after the listing: reading another index mid-listing would end it.)
    return result.filter(gk => !this.#creationPending(gk.id));
  }

  /**
   * The authorization gate every non-owner entry point (open(), receiveExternalMessage()) must
   * pass through: resolve the caller's effective role, then verify them as an observer of
   * everything this workspace has read. Returns null for no access; verification failures throw.
   * A caller that requires at least `requireRole` (e.g. receiveExternalMessage needs "build")
   * passes it so an insufficient role is denied *before* verification runs -- otherwise the caller
   * would be verified (real addObserver calls, a persisted observer record) only to be turned
   * away, or worse, told to fix a verification failure that can never grant them access.
   * `configureCb` is forwarded to ensureObserver to prompt for unconfigured account choices;
   * without it, verification is non-interactive and an unconfigured binding denies access.
   */
  async authorizeCollaborator(
      profileId: string,
      clientUser: DurableObjectStub<UserDurableObject>,
      opts: {
        configureCb?: RpcStub<ObserverConfigCallback>;
        requireRole?: CollaboratorRole;
      } = {}): Promise<CollaboratorRole | null> {
    let sharing = await this.getSharingManager();
    let role = sharing.getEffectiveRole(profileId);
    if (!role || (opts.requireRole && roleRank(role) < roleRank(opts.requireRole))) return null;

    // A session-to-be counts as a session for its role from the moment its role is resolved:
    // verification can park indefinitely on collaborator-controlled awaits (the account-
    // configuration prompt, verifier RPCs), and a scope widening in that window must schedule the
    // restart -- which resets the DO, taking this parked call with it, so the client retries
    // against the new scope. Between this release and open() constructing the counted client
    // interface there are only microtask continuations (open() awaits nothing else after this
    // call), and no incoming event can be delivered inside a microtask drain, so nothing can
    // observe the count dip to zero across the handoff.
    let leaveSession = this.joinSession(role);
    try {
      await this.ensureObserver(profileId, clientUser, role, opts.configureCb);
    } finally {
      leaveSession();
    }
    return role;
  }

  /**
   * Bring a non-owner `profileId` into compliance as an observer for their `role`, so that they may
   * open the Gadget. May invoke `configureCb` to ask the user to choose connected accounts for
   * gatekeeper bindings they haven't configured yet. Re-runs `addObserver` (re-verification) for
   * already-configured bindings on every open, catching revocation of the user's underlying
   * resource access promptly. Returns when fully verified; throws to deny access.
   *
   * See observers-implementation-plan.md §5 Step 3.
   *
   * TODO: Concurrent opens by the same profile race this method -- two calls mint two observerIds
   *   and the last-written record forgets the other's gatekeeper registrations -- so verification
   *   needs to be serialized per profile.
   */
  async ensureObserver(
      profileId: string,
      clientUser: DurableObjectStub<UserDurableObject>,
      role: CollaboratorRole,
      configureCb?: RpcStub<ObserverConfigCallback>): Promise<void> {
    // 1. Select in-scope gatekeepers. If none require an account, there is nothing to verify and
    //    no observer record is needed (built-in gatekeepers never name observers in
    //    excludeObservers).
    let inScope = this.inScopeGatekeepers(role);
    if (inScope.length === 0) return;

    // 2. Load any existing observer record, and build a working copy of its account choices.
    let record = this.storage.observers.get(profileId);
    let accountChoices: {[gatekeeperId: number]: number} = {...record?.accountChoices};

    let observerId = record?.observerId ?? crypto.randomUUID();
    // Whether this collaborator was already an admitted observer when the call began. A returning
    // observer's `observerId` is already persisted, so it stays resolvable no matter how this call
    // ends -- which is what makes keeping their registrations on a failure safe (see the catch).
    let returningObserver = record !== undefined;
    // Gatekeepers this call touched, for a *first-time* observer's rollback only (see the catch):
    // those we successfully registered the observer with, and those that refused (or whose account
    // was gone) and have not verified since.
    let newlyAdded = new Set<number>();
    let invalidated = new Set<number>();

    // Failures from the previous pass, keyed by gatekeeper id: an already-configured binding whose
    // chosen account was disconnected, or which the gatekeeper refused.
    let passFailures = new Map<number, ObserverBindingFailure>();

    // We may need to re-prompt the configuration modal when an already-configured binding fails, so
    // the user can fix it in place. Bound the number of such re-prompts to avoid looping against a
    // misbehaving client (or an account that simply keeps failing).
    let reprompts = 0;
    const MAX_CONFIG_REPROMPTS = 1;

    try {
      while (true) {
        // 3. Determine uncovered bindings: in-scope gatekeepers with no account choice yet. Ambient
        //    bindings use the collaborator's matching provided account automatically; unlike an
        //    ordinary connection, there is no meaningful account choice when one already exists.
        //    On a re-prompt, leave a failed ambient binding uncovered so the client can explain the
        //    failure rather than silently retrying the same account.
        let uncovered = inScope.filter(gk => !(gk.id in accountChoices));
        let ambientNeeds = uncovered.flatMap(gk => {
          let spec = gk.creationSpec;
          return spec?.type === "ambient" && !passFailures.has(gk.id)
              ? [{gatekeeperId: gk.id, vendorId: spec.vendorId}]
              : [];
        });
        if (ambientNeeds.length > 0) {
          let accountsByVendor = new Map<string, number>();
          for (let account of await clientUser.listProvidedAccounts()) {
            if (account.description.singleton && !accountsByVendor.has(account.vendorId)) {
              accountsByVendor.set(account.vendorId, account.accountId);
            }
          }
          for (let need of ambientNeeds) {
            let accountId = accountsByVendor.get(need.vendorId);
            if (accountId !== undefined) accountChoices[need.gatekeeperId] = accountId;
          }
          uncovered = inScope.filter(gk => !(gk.id in accountChoices));
        }

        // 4. If there are uncovered bindings, ask the client to choose accounts for them.
        if (uncovered.length > 0) {
          if (!configureCb) {
            // Non-interactive open (e.g. no UI). We can't configure, so deny.
            throw new Error(
                "To open this workspace, you must choose connected accounts for the services it " +
                "uses, but no configuration channel was provided.");
          }

          let needs: ObserverBindingNeed[] = uncovered.map(gk => ({
            ...observerBindingNeed(gk),
            // Present only for bindings we're re-prompting because they just failed, so the client
            // can explain what went wrong and aim its re-authenticate affordance at that account.
            failure: passFailures.get(gk.id),
          }));

          let choices = await configureCb.configure(needs);
          let uncoveredIds = new Set(uncovered.map(gk => gk.id));
          for (let choice of choices) {
            // Validate the choice.
            if (!uncoveredIds.has(choice.gatekeeperId) || !Number.isSafeInteger(choice.accountId)) {
              throw new Error(
                  "The account choices returned by the client were invalid. Please try again.");
            }

            accountChoices[choice.gatekeeperId] = choice.accountId;
          }

          // The client must have supplied a choice for every uncovered binding.
          let stillUncovered = uncovered.filter(gk => !(gk.id in accountChoices));
          if (stillUncovered.length > 0) {
            throw new Error(
                "You must connect an account for every service this workspace uses in order to open " +
                "it.");
          }
        }

        // 5. Verify all in-scope bindings (covered + newly chosen). For each, resolve the chosen
        //    account's verifier and hand it to the gatekeeper's addObserver(). Collect *every*
        //    failure rather than just the first, so a re-prompt can present them all at once.
        let failures = new Map<number, ObserverBindingFailure>();

        await Promise.all(inScope.map(async gk => {
          let accountId = accountChoices[gk.id];
          let vendorId = observerVendorId(gk);
          if (!vendorId) {
            throw new Error("An observer account was requested for a non-gatekeeper binding.");
          }

          let fail = (reason: string, err?: unknown) => {
            failures.set(gk.id, {accountId, reason});
            invalidated.add(gk.id);
            this.logger.warn("observer verification failed", {
              event: "gatekeeper.observer.verify.failed",
              gatekeeperId: gk.id, vendorId, accountId, observerId, error: err,
            });
          };

          try {
            let verifier = await clientUser.getVerifier(accountId, vendorId);
            if (!verifier) {
              // Account gone -> the overseer authors the reason. (Wrong vendor throws above.)
              fail("This account is no longer connected.");
              return;
            }
            // Serialized per (observer, gatekeeper) so this registration can't land while an
            // exclusion teardown's removeObserver for the same pair is still in flight (which
            // would delete it moments later); see #withObserverGatekeeperLock.
            await this.withObserverGatekeeperLock(observerId, gk.id,
                async () => (await this.getGatekeeperFacet(gk.id)).addObserver(observerId, verifier));
            newlyAdded.add(gk.id);
            // Keep `invalidated` meaning "failed and has not verified since": this binding just
            // verified on a repaired pass, so the catch below must not roll its registration back.
            invalidated.delete(gk.id);
          } catch (err) {
            // Either a settled denial or an operational failure (expired credentials, upstream
            // outage). Treat every failure as repairable and let the user try again.
            fail(stringifyError(err), err);
          }
        }));

        if (failures.size > 0) {
          // Drop the failed choices so the re-prompt asks about exactly these bindings. A failed
          // binding's unpersisted account choice self-corrects on the next open (re-verification
          // fails the stale persisted choice and re-prompts).
          for (let id of failures.keys()) {
            delete accountChoices[id];
          }

          // Offer the user a chance to repair (typically re-authenticate the expired account),
          // unless we have no way to prompt or have already spent the budget.
          if (configureCb && reprompts < MAX_CONFIG_REPROMPTS) {
            reprompts++;
            passFailures = failures;
            continue;
          }

          // Terminal. Name each failed connection and account so the user knows what to fix, rather
          // than reporting an anonymous refusal.
          throw new Error(
              "This workspace could not confirm that you are permitted to observe all of the data it " +
              "has accessed:\n" +
              await this.#describeObserverFailures(clientUser, inScope, failures));
        }

        // All in-scope bindings verified successfully.
        break;
      }
    } catch (err) {
      // Best-effort remove everything a *first-ever* verification registered: nothing referenced
      // those registrations before this call, and the freshly-minted observerId is discarded with
      // the unpersisted record, so anything left behind would linger unresolvable.
      //
      // A *returning* observer's registrations are all kept -- including the ones this call added.
      // Their persisted observerId is shared with concurrent opens, so a rollback here could
      // delete a registration that a concurrent successful open just made and persisted.
      // De-registering is the fail-open direction: the gatekeeper stops naming that observer in
      // `excludeObservers`, so an observation it should have excluded them from is admitted with
      // nothing left to block it. A spurious registration merely blocks fail-closed until it is
      // lazily cleaned up (see #enforceExcludeObservers) or a later open re-verifies it.
      if (!returningObserver) {
        await this.removeObserverFromGatekeepers(observerId, [...newlyAdded, ...invalidated]);
      }

      // Only this open is denied. Sessions the collaborator already holds are left alone: they
      // keep whatever access their own open verified until they next re-open, which is the
      // lazy-revocation residual documented in docs/observers.md.
      throw err;
    }

    // 6. Persist the observer record only after all addObserver calls succeed. Creating/updating
    //    the record is the canonical moment the user becomes a configured observer.
    this.storage.observers.put({profileId, observerId, accountChoices});
  }

  // Render the observer verification failures as one line per binding, naming the connection and the
  // account that was refused: `<resourceTitle> (<account label>) — <reason>`. Cold path only (we're
  // about to deny the open), so the extra User DO round trip per failure is fine. Discloses nothing
  // new: the reason was either already thrown to this same user or authored by us, and the account is
  // their own.
  async #describeObserverFailures(
      clientUser: DurableObjectStub<UserDurableObject>,
      inScope: GatekeeperRecord[],
      failures: Map<number, ObserverBindingFailure>): Promise<string> {
    // Iterate inScope rather than `failures`: the map is filled from concurrent verification
    // callbacks, so its insertion order varies run to run and the message would reorder on retry.
    let failed = inScope.flatMap(gk => {
      let failure = failures.get(gk.id);
      return failure ? [{gk, failure}] : [];
    });

    let lines = await Promise.all(failed.map(async ({gk, failure}) => {
      // A disconnected account has no description left, so name it by what became of it.
      let label = "an account you have since disconnected";
      try {
        let description = await clientUser.describeConnectedAccount(failure.accountId);
        if (description) {
          label = description.uniqueName || description.displayName || `account ${failure.accountId}`;
        }
      } catch (err) {
        label = `account ${failure.accountId}`;
        this.logger.warn("failed to describe account for observer failure", {
          event: "gatekeeper.observer.verify.describe.failed",
          gatekeeperId: gk.id, accountId: failure.accountId, error: err,
        });
      }

      return `${observerBindingTitle(gk)} (${label}) — ${oneLineReason(failure.reason)}`;
    }));

    return lines.join("\n");
  }
}
