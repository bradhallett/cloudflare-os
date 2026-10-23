import { RpcStub, RpcTarget } from "capnweb";
import { Overseer, WorkpieceId, AiChatMetadata, AgentSpawnerConfig, ConsoleLogEvent, CollaboratorRole, ObserverConfigCallback, BlueprintMetadata, BlueprintOutput, createOpenGadgetError, OPEN_GADGET_ERROR_CODES, resolveSiteName } from "@gadgets/workshop-shared/api";
import { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, RpcStub as NativeRpcStub, restore } from "cloudflare:workers";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { AiChatAgentContext, ExternalChatRecord, GatekeeperCaller } from "./storage-schema/overseer-storage";
import type { WorkspaceOutputEntry } from "./storage-schema/user-storage";
import { commitIdentityForAuthor } from "./git-store";
import { OVERSEER_STORAGE_VERSION } from "./storage-schema/overseer-migrations";
import { readAdminConfig } from "./admin-config";
import { ambientGatekeeperMode } from "./provisioning-policy";
import { releaseMergeHeader } from "./blueprint-release";
import type { CallableAgent, SpawnCallableOptions } from "./agent-spawner-binding";
import { retryOnDoReset } from "./do-retry";
import type { SubmitExternalMessageResult } from "@gadgets/workshop-shared/external-message-gateway";
import { OverseerImpl } from "./overseer-impl";
import { UseOverseerInterface } from "./overseer-client-use";
import { OverseerClientInterface } from "./overseer-client";
import type { ExternalMessageResponseTargetRegistration, ExternalMessageSubmitInput, OverseerRestoreParams } from "./overseer-support";
import { stringifyError } from "./overseer-support";
import type { BindingLoopbackTarget } from "./overseer-loopbacks";
import { ApprovalQueueImpl, makeHookFiringCallback, requireLiveHook } from "./overseer-gatekeeper-client";
import { gatekeeperVendorId } from "./overseer-binding-info";

export class OverseerDurableObject extends DurableObject<Cloudflare.Env> {
  private impl: OverseerImpl;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.impl = new OverseerImpl(ctx, env);
  }

  /**
   * The DO's one alarm (scheduled by #updateAlarm for the earliest time any concern below needs
   * it) does all of the following, so whichever concern set it, none is missed:
   * - Agent work outstanding for at least a minute -- a running turn, or a recorded call to a
   *   callable agent not yet appended to its chat. If the DO is still running when this is called,
   *   but the client has closed their browser and so isn't holding the DO alive anymore, the alarm
   *   handler takes over and holds the DO open until the work is done. If the DO died meanwhile,
   *   the alarm wakes it (and the constructor resumes the turns and drains the calls before
   *   alarm() itself runs). If the DO dies *while* the alarm is running, the system retries the
   *   alarm, picking the work up yet again.
   * - External-message responses ready to deliver, and delivered records due to be swept.
   *
   * See OverseerImpl.runAlarmTasks for how the concerns are run together.
   */
  async alarm(info?: AlarmInvocationInfo) {
    await this.impl.runAlarmTasks(info?.retryCount);
  }

  // Initialize a brand-new workspace's storage. (Before git-backed code storage this also wrote
  // an empty Yjs snapshot as legacy code version 1; workspaces born since have no legacy code
  // log at all -- committed code exists only once a first commit lands in the git store.)
  #initializeNewWorkspace(): void {
    this.impl.storage.codeVersion.put(1);

    // A workspace initialized by this version of the code is born at the current schema version;
    // there is nothing to migrate.
    this.impl.storage.version.put(OVERSEER_STORAGE_VERSION);
  }

  /**
   * This workspace's outputs, for the owner to fold into their index. Every registry change and
   * every owner open already pushes, so this exists only to catch up workspaces that predate the
   * index. Null unless the caller really is the owner, so nobody else can read the snapshot.
   */
  async getOutputsForOwnerBackfill(ownerId: string): Promise<WorkspaceOutputEntry[] | null> {
    if (this.impl.ownerId !== ownerId) return null;
    return this.impl.outputsSnapshot();
  }

  /**
   * `notifyClosed` should be invoked when the return `Overseer` stub is disposed, which is used
   * by AuthenticatedApiImpl.#openGadgetInternal() to detect Durable Object disconnects.
   */
  async open(userId: string, profileId: string,
             notifyClosed: NativeRpcStub<() => void>,
             shareKey?: string,
             configureObservers?: RpcStub<ObserverConfigCallback>): Promise<Overseer> {
    let firstOpen = !this.impl.ownerId;
    if (firstOpen) {
      // This Overseer hasn't been initialized yet.
      await this.ctx.blockConcurrencyWhile(async () => {
        // Verify that the owner believes it exists. The owner account must be initialized with
        // any new gadgets first before the gadget is actually opened.
        let owner = this.impl.users.get(this.impl.users.idFromString(userId));
        let meta = await owner.getGadget(this.ctx.id.toString());
        if (!meta) {
          throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
        }
        if (meta.owner) {
          // The user's DO contains a record indicating that this gadget was shared to them by
          // some other owner. This gadget may have existed in the past, and then was deleted,
          // which does not proactively clean up share recipient's references. We need to treat
          // this as missing otherwise we'll inadvertently create a new gadget with this ID
          // belonging to a different user than the original.
          throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
        }

        // Owner says we exist, so let's initialize ourselves.
        this.impl.ownerId = userId;

        this.impl.storage.ownerId.put(userId);

        this.#initializeNewWorkspace();
      });
    }

    let isOwner = (userId == this.impl.ownerId);

    // Cache the owner's profileId in memory when the owner opens.
    if (isOwner) {
      this.impl.ownerProfileId = profileId;
    }

    // Make singleton gatekeepers (e.g. the Context Library) available to the agent as unnamed
    // capsules. Idempotent and best-effort, so a library hiccup never blocks opening the gadget.
    // On the very first open we block so the agent's first turn sees the capsules; later opens let the
    // reconcile run in the background to keep cross-DO latency off the hot path.
    let ensureCapsules = this.impl.ensureAmbientCapsules().catch((err) => {
      this.impl.logger.error("failed to ensure singleton gatekeeper capsules", {
        event: "singleton.capsules.ensure.failed", error: err,
      });
    });
    if (firstOpen) {
      await ensureCapsules;
    }

    let owner = this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId!));
    let clientUser = isOwner
        ? owner
        : this.impl.users.get(this.impl.users.idFromString(userId));

    // Refresh the owner's outputs index. Pushes are best-effort, and workspaces predating the
    // index have never pushed at all, so re-syncing on open is what corrects both.
    if (isOwner) {
      this.impl.markOutputsDirty();
    }

    // The caller's effective role. The owner always has "build".
    let role: CollaboratorRole = "build";

    if (!isOwner) {
      let sharing = await this.impl.getSharingManager();

      // If a share key was provided, redeem it. The owner already has full access and should not
      // appear in the collaborators table.
      if (shareKey) {
        await sharing.redeemShareKey({
          rawKey: shareKey,
          profileId,
          fetchProfile: () => clientUser.whoami(),
        });
      }

      // Ambient reconciliation may attach Gatekeepers after open() starts. Finish it before taking
      // the observer snapshot so every capability exposed to this collaborator has an observer.
      await ensureCapsules;

      // Check authorization: compute the caller's effective role from the permission graph, then
      // verify they may observe everything this Gadget has read through its in-scope gatekeepers,
      // configuring their connected accounts if needed. Observer verification runs only after a
      // valid role is confirmed, so it never reveals gatekeeper or resource metadata to an
      // unauthorized user.
      //
      // An unauthorized caller (no effective role -- never had access, or was removed) gets a
      // distinct denial without workspace metadata. A removed collaborator who reconnects after
      // their session is force-restarted lands here and sees the terminal access-denied page.
      let effectiveRole = await this.impl.authorizeCollaborator(
          profileId, clientUser, {configureCb: configureObservers});
      if (!effectiveRole) {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      }
      role = effectiveRole;

      // Fire-and-forget a call to the collaborator's user DO so the gadget appears on
      // (or is refreshed on) their home page.
      let title = this.impl.storage.title.get();
      let gadgetId = this.impl.ctx.id.toString();
      void (async () => {
        try {
          const ownerProfile = await owner.whoami();
          await clientUser.recordSharedGadgetOpen(gadgetId, title, ownerProfile, role);
        } catch (err) {
          this.impl.logger.warn("failed to record shared gadget open", {
            event: "shared.gadget.open.record.failed", gadgetId, error: err,
          });
          return;
        }
        // Catch up whatever happened while they were away; changes from here on reach them
        // through the session fan-out (joinOutputsFanout).
        await this.impl.syncOutputsTo(clientUser);
      })();
    }

    this.impl.recordGadgetAnalytics({
      event_name: "gadget_opened",
      user_id: userId,
      source: shareKey ? "share_key" : "direct",
    });

    if (role === "use") {
      // "use" collaborators get a restricted capability exposing only the gadget UI.
      return new UseOverseerInterface(
          this.impl, profileId, userId, notifyClosed.dup());
    }

    return new OverseerClientInterface(
        this.impl, profileId, userId, isOwner, notifyClosed.dup(),
        ensureCapsules);
  }

  #getExternalChat(externalChatKey: string): ExternalChatRecord | undefined {
    let externalChat = this.impl.storage.externalChats.get(externalChatKey);
    if (externalChat && !this.impl.storage.chatMeta.get(externalChat.chatId)) {
      this.impl.storage.externalChats.delete(externalChat.externalChatKey);
      externalChat = undefined;
    }
    return externalChat;
  }

  async receiveExternalMessage(
    input: ExternalMessageSubmitInput,
  ): Promise<SubmitExternalMessageResult> {
    if (!input.prompt.trim()) {
      return { accepted: false, message: "Please include a prompt." };
    }

    // Resolve the caller.
    let caller = this.impl.users.getByName(input.callerEmail);
    let callerId = caller.id.toString();
    let callerProfile = await caller.whoamiIfExists();
    if (!callerProfile) {
      let siteName = resolveSiteName((await readAdminConfig(this.impl.env)).siteName);
      return {
        accepted: false,
        message: `Please create a ${siteName} account to continue.`,
      };
    }

    // Create the Gadget if it doesn't exist yet.
    let ownerId = this.impl.ownerId;
    if (!ownerId) {
      this.impl.ownerId = callerId;
      this.impl.ownerProfileId = callerProfile.id;
      this.impl.storage.ownerId.put(callerId);
      this.impl.storage.title.put(input.title);
      this.impl.storage.ownerRegistrationPending.put(true);
      this.#initializeNewWorkspace();
      ownerId = callerId;
      this.impl.recordGadgetAnalytics({
        event_name: "gadget_created",
        user_id: callerId,
        source: "external_message",
      });
    }

    // A non-owner caller counts as a live "build" session from the moment they are authorized
    // until this call completes: their reply is produced from whatever the workspace holds, and
    // this path never constructs one of the counted client interfaces, so without a lease a scope
    // widening mid-call would find no session to sever and the reply would be produced under
    // stale verification. With it, the widening resets the DO, this call dies with it, and the
    // caller retries. The lease deliberately starts only after authorizeCollaborator returns:
    // verification itself is covered by that call's own internal lease, and a caller it turns
    // away must never have counted at all -- a stranger racing an addGatekeeper would otherwise
    // cause a needless workspace reset. The handoff between the two leases is microtask-only,
    // the same argument as open()'s.
    //
    // KNOWN GAP, tolerable only while nothing calls this endpoint: this call's lease does not
    // cover the fire-and-forget turn's initial run. A scope widening after this call returns can
    // find no session to sever, and the reply can egress under stale verification. #resumeAgent
    // already re-authorizes the original non-owner person and holds a build lease through a
    // resumed run; its existing ActiveAgentRecord carries that identity. Before wiring this
    // endpoint to real callers, give the initial run its own per-turn build lease too.
    let leaveSession = () => {};
    using _sessionLease = {[Symbol.dispose]: () => leaveSession()};

    // Caller must be the owner or a build collaborator. The agent's reply can surface anything
    // the workspace has already read (chat history, gadget storage), so a collaborator passes the
    // same authorization gate as open() -- but non-interactively: with no way to configure
    // accounts here, an unverified caller is sent to open the workspace, which is where
    // verification happens. Requiring "build" up front means a "use" collaborator gets the plain
    // denial below rather than being verified (or told to fix a verification failure) for access
    // this path can never grant them.
    if (ownerId !== callerId) {
      let role: CollaboratorRole | null;
      try {
        role = await this.impl.authorizeCollaborator(
            callerProfile.id, caller, {requireRole: "build"});
      } catch (err) {
        return {
          accepted: false,
          message: "Your access to the data this workspace has read could not be verified. Open " +
              "the workspace in your browser to verify your access, then try again. " +
              `(${stringifyError(err)})`,
        };
      }
      if (role !== "build") {
        return {
          accepted: false,
          message: "You do not have access to interact with this workspace through its agent.",
        };
      }
      leaveSession = this.impl.joinSession("build");
    }

    // Complete pending registration in the owner's UserDO.
    if (this.impl.storage.ownerRegistrationPending.get()) {
      let owner = this.impl.users.get(this.impl.users.idFromString(ownerId));
      await owner.ensureGadgetRegistered(this.ctx.id.toString(), this.impl.storage.title.get());
      this.impl.storage.ownerRegistrationPending.put(false);
    }

    // Find the external conversation's chat if it exists.
    let externalChat = this.#getExternalChat(input.externalChatKey);
    let modelId = null;
    if (externalChat) {
      // Continue existing chats with the most recent agent model used in that chat.
      for (let msg of this.impl.storage.chats.list({ prefix: chatKeyPrefix(externalChat.chatId), reverse: true })) {
        if (msg.author.type === "agent") {
          modelId = msg.author.id;
          break;
        }
      }
    }

    // Resolve the caller's profile and model.
    let userContext = await caller.getExternalMessageChatContext(modelId);

    // The caller must have an available agent model.
    let aiModel = userContext.aiModel;
    if (!aiModel) {
      let siteName = resolveSiteName((await readAdminConfig(this.impl.env)).siteName);
      return {
        accepted: false,
        message: `Your ${siteName} account needs an AI model configured before it can respond.`,
      };
    }

    // Re-check because another request may have created the external chat while resolving the model.
    externalChat = this.#getExternalChat(input.externalChatKey);

    // Submit the prompt to the existing external chat, or start a new external chat.
    let responseTargetRegistration: ExternalMessageResponseTargetRegistration = {
      idempotencyKey: input.idempotencyKey,
      chatGatewayRpcTarget: input.chatGatewayRpcTarget,
    };
    let chatId: number;
    if (externalChat) {
      await this.impl.sendChatMessage(
        caller,
        userContext,
        externalChat.chatId,
        input.prompt,
        undefined,
        undefined,
        responseTargetRegistration,
      );
      chatId = externalChat.chatId;
    } else {
      chatId = await this.impl.newChat(
        caller,
        userContext,
        input.prompt,
        undefined,
        undefined,
        responseTargetRegistration,
        input.externalChatKey,
      );
    }

    return { accepted: true, chatPath: `/workspace/${this.ctx.id.toString()}?chat=${chatId}` };
  }

  /**
   * Initialize this workspace's default gadget from the release of a blueprint that `metadata`
   * describes. Called by AuthenticatedApi.newGadgetFromBlueprint() after creating (and opening)
   * the DO, with the metadata it goes on to set up the gadget's bindings from: the blueprint may
   * be republished meanwhile, and the code has to be the version those bindings belong to.
   */
  async initializeFromBlueprint(
      blueprintId: string, metadata: BlueprintMetadata, output?: BlueprintOutput): Promise<void> {
    // Set the title. The default gadget (created below) inherits it.
    let { title } = metadata;
    this.impl.storage.title.put(title);

    // Load the release and write the gadget's initial commits *before* creating the gadget
    // record: every permanent gadget is born with a head (see GadgetRecord.commitId), so a
    // failure here -- invalid content, an empty release, an unreachable owner -- must not leave
    // a headless record behind. The commits are content-addressed and referenced by nothing
    // until the record lands, so writing them first is safe. The release's tree becomes the
    // gadget's first committed tree. An empty release is refused rather than instantiated as a
    // code-less gadget: blueprints of such gadgets cannot be created (see createBlueprint), so
    // one can only arrive corrupted or hand-crafted.
    let release = await this.impl.loadBlueprint(blueprintId, metadata);
    if ((await this.impl.gitStore.readCommitFiles(release)).size === 0) {
      throw new Error("This blueprint's code archive is empty.");
    }
    let ownerId = this.impl.ownerId;
    if (!ownerId) {
      throw new Error("Workspace has no owner.");
    }
    // Fresh stub per call, so the pure whoami() read below is safe to retry once across a
    // user-DO reset (see retryOnDoReset: a captured stub would be permanently broken).
    let owner = () => this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(ownerId)));
    let ownerProfile = await retryOnDoReset(() => owner().whoami(), this.impl.logger);

    // The gadget's history starts at an empty root of its own, into which its head merges the
    // release: the head's tree is the release's, its first parent the root, its second the
    // release, which it marks as a release it merged (see releasesMergedSince). A commit's first
    // parent is always the gadget's own previous state, so the gadget's first-parent chain is its
    // own history, every commit of which has its tree here. The release's ancestors, most of
    // which arrived without theirs, are only ever reached through other parents -- where a later
    // update finds what the gadget and a blueprint have in common.
    let authorship = { author: commitIdentityForAuthor(ownerProfile), timestamp: new Date() };
    let root = await this.impl.gitStore.writeFilesAsCommit(new Map(), {
      ...authorship,
      parents: [],
      message: `Create gadget: ${title}`,
    });
    let commitId = await this.impl.gitStore.writeCommitForTree(
        await this.impl.gitStore.commitTree(release), {
      ...authorship,
      parents: [root, release],
      message: `Instantiate blueprint: ${title}`,
      headers: [releaseMergeHeader(release)],
    });

    // Blueprint instantiation still creates a fresh workspace containing one auto-created gadget,
    // recorded as the default gadget (see ensureDefaultGadget).
    let gadgetId = this.impl.ensureDefaultGadget(commitId);
    this.impl.recordGadgetAnalytics({
      event_name: "workpiece_created",
      user_id: ownerId,
      workpiece_id: gadgetId,
      source: "blueprint",
    });

    // The gadget follows the blueprint, from the release it was built from. It also inherits the
    // blueprint's declared format, so it is named and drawn as a Document (or whatever it
    // produces) rather than a generic app.
    let record = this.impl.getGadgetRecord(gadgetId);
    record.upstream = { blueprintId, commitId: release };
    if (output) {
      record.output = output;
    }
    this.impl.storage.gadgets.put(record);

    // Mark gadget as non-provisional (it has code, so it should appear in the gadget list).
    // (A write, so deliberately not retried -- a reset can't distinguish "never applied" from
    // "applied, response lost".)
    await owner().setGadgetLastActive(this.ctx.id.toString(), new Date(), undefined);
  }

  async startGatekeeperSession(
      target: BindingLoopbackTarget, caller: GatekeeperCaller): Promise<any> {
    return this.impl.startGatekeeperSession(target, caller);
  }

  startGatekeeperHook(id: number): NativeRpcStub<RpcTarget> {
    // TODO: There's a bug in workerd, if we return the RpcTarget directly here, because it is a
    //   Proxy, serializeJsValueWithPipeline() decides it is non-pipelineable, which is incorrect.
    //   Manually wrapping in a stub works around the problem for now.
    return new NativeRpcStub(this.impl.getGadgetHookEntrypoint(id));
  }

  async startHook(hookId: number): Promise<{
    callback: NativeRpcStub<RpcTarget>, approvalQueue: ApprovalQueue
  }> {
    let record = requireLiveHook(this.impl, hookId);

    let vendorId = record.vendorId ??
        gatekeeperVendorId(this.impl.storage.gatekeepers.get(record.gatekeeperId));
    if (!vendorId) throw new Error("Hook vendor is unavailable.");

    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(vendorId) ||
        ambientGatekeeperMode(config, vendorId) === "disabled") {
      throw new Error("Gatekeeper is disabled.");
    }

    // Re-read after the await: the KV read leaves the input gate open, so a disable/delete may
    // have landed while it was in flight, and issuing from the captured record would hand out a
    // firing on a dead hook (the enableHookRecord/disableHook idiom).
    record = requireLiveHook(this.impl, hookId);

    // Both returned capabilities revalidate the hook per call rather than trusting this moment:
    // they are held outside this DO (even across resets -- the stored callback is a persistent
    // stub), so this is what ties them to the firing, per the session contract documented on
    // Gatekeeper.bindHook (workshop-shared/gatekeeper.ts).
    return {
      callback: makeHookFiringCallback(this.impl, hookId),
      approvalQueue: new ApprovalQueueImpl(this.impl, record.gatekeeperId, {from: "hook"}, hookId),
    };
  }

  async deliverGadgetLogs(chatId: number | null, logs: ConsoleLogEvent[]) {
    return this.impl.deliverGadgetLogs(chatId, logs);
  }

  async deliverCodeModeTrace(executionId: string, trace: TraceItem) {
    return this.impl.deliverCodeModeTrace(executionId, trace);
  }

  deliverCodeModeText(executionId: string, delta: string) {
    return this.impl.deliverCodeModeText(executionId, delta);
  }

  /** Called by AgentSelfLoopback when any method is called on the `self` object. */
  deliverAgentCallback(
      chatId: number, methodName: string, args: unknown[],
      initiatorUserId: string, initiatorModelId: string | null): Promise<void> {
    return this.impl.deliverAgentCallback(
        chatId, methodName, args, initiatorUserId, initiatorModelId);
  }

  /** Implements AgentSpawnerBinding.spawn(): the agent starts at once on `prompt`. */
  async spawnAgent(
      title: string, prompt: string, config: AgentSpawnerConfig,
      creatorUserId?: string): Promise<void> {
    let {chatId, meta, userMeta, author, initiatorUserId} =
        await this.#createSpawnedChat(title, config, creatorUserId);

    if (userMeta.aiModel) {
      meta.activeAgent = userMeta.aiModel.profile;
      this.impl.storage.chatMeta.put(meta);
    }

    this.impl.storage.chats.put({
      chatId,
      sequence: this.impl.nextChatSequence(chatId),
      timestamp: meta.started,
      author,

      type: "message",
      message: prompt,
    });

    if (userMeta.aiModel) {
      // Fire off the agent (asynchronously).
      this.impl.startAgent(chatId, userMeta.aiModel, author, initiatorUserId);
    } else {
      // TODO: Flag as needing user attention.
    }
  }

  /**
   * Implements AgentSpawnerBinding.spawnCallable(): the chat is created with no messages, and
   * the agent starts when the first call is made on the returned stub. The declarations the agent
   * implements are frozen on the chat context, where the system-prompt builder reads them.
   */
  async spawnCallableAgent(
      title: string, options: SpawnCallableOptions, config: AgentSpawnerConfig,
      creatorUserId?: string): Promise<CallableAgent> {
    let {chatId, initiatorUserId} =
        await this.#createSpawnedChat(title, config, creatorUserId, options);

    // A stub that delivers calls to the new chat thread, like the `self` magic object. Each call
    // is recorded by deliverAgentCallback(), which starts the agent when it is idle; with no
    // model configured, calls are still appended to the chat, for a human to pick up.
    return this.impl.ctx.exports.AgentSelfLoopback({props: {
      overseerId: this.impl.ctx.id.toString(),
      chatId,
      initiatorUserId,
      initiatorModelId: config.modelId,
    }}) as unknown as CallableAgent;
  }

  // Creates the chat for a spawned agent: its metadata, and a context carrying the frozen spawner
  // config (plus, for a callable agent, the interface declarations) and the seed binding layer.
  // Writes no messages; the caller decides how the chat starts.
  async #createSpawnedChat(
      title: string, config: AgentSpawnerConfig, creatorUserId: string | undefined,
      spawnerTypes?: SpawnCallableOptions) {
    if (!this.impl.ownerId) throw new Error("Workspace has been deleted.");

    // Resolve the model from the creating user's account (falls back to owner for
    // bindings created before collaborator support).
    let resolveUserId = creatorUserId ?? this.impl.ownerId;
    let initiatorUserId = this.impl.users.idFromString(resolveUserId).toString();
    let user = this.impl.users.get(this.impl.users.idFromString(resolveUserId));
    let userMeta = await user.getChatContext(config.modelId);

    let chatId = this.impl.nextChatId();
    let timestamp = this.impl.getChatTimestamp();
    let meta: AiChatMetadata = {
      id: chatId,
      title,
      started: timestamp,
      lastActive: timestamp,
      spawnerName: config.displayName,
    };
    this.impl.storage.chatMeta.put(meta);

    // Snapshot the spawner's configured bindings as the chat's seed binding layer -- the spawned
    // agent sees only these, never the workspace default list. Entries whose targets no longer
    // exist are dropped.
    let bindings: Record<string, WorkpieceId> = Object.create(null);
    for (let [name, target] of Object.entries(config.env)) {
      if (this.impl.storage.gadgets.get(target)?.type === "gadget" ||
          this.impl.storage.gatekeepers.get(target)) {
        bindings[name] = target;
      }
    }

    let context: AiChatAgentContext = {chatId, spawnerConfig: config, bindings};
    if (spawnerTypes) context.spawnerTypes = spawnerTypes;
    this.impl.storage.chatContext.put(context);

    let author = this.impl.gadgetAuthorFor(userMeta.profile);
    return {chatId, meta, userMeta, author, initiatorUserId};
  }

  [restore](params: OverseerRestoreParams): any {
    return this.impl.restore(params);
  }
}
