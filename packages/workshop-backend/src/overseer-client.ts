import { RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { Overseer, GadgetMetadata, WorkpieceId, WorkpiecesSubscriber, GadgetClient, GatekeeperClient, ActionsSubscriber, ActionHistoryFilter, ActionHistoryPage, CodeChangeSubmission, CommitInfo, FileAtCommit, MAX_READ_FILES_PER_CALL, TreeNode, MergeChangesResult, AiChatMetadata, AiChatMessage, AiChatHistoryPage, AiChatSubscriber, AiChatAuthorInfo, AgentSpawnerConfig, ConsoleLogSubscriber, CapsuleSpecifier, CollaboratorInfo, CollaboratorRole, AffectedCollaborator, ShareLinkInfo, GatekeeperCreationSpec, ObserverBindingNeed, MessageFormatRef, BlueprintGadgetSummary, BlueprintScreenshotUpload, blueprintScreenshotUrl, ChatAttachmentHandle, BoundHookInfo, PreApprovableAction, PresenceSubscriber, SlashCommandChoice, SlashCommandRequest, validateBindingName, modelKind } from "@gadgets/workshop-shared/api";
import { HookInitiator, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { keyString } from "@gadgets/typed-storage";
import type { ListOptions } from "@gadgets/typed-storage";
import { actionLastChangedKey, chatKey, chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ActionRecord, AgentSpawnerBindingProps, BlueprintGadgetRecord, StoredChatMessage } from "./storage-schema/overseer-storage";
import { commitIdentityForAuthor } from "./git-store";
import { AiModelGatekeeperProps } from "./ai-models";
import { GIT_BINDING_NAME } from "./agent";
import { UserDurableObject } from "./user";
import type { ProductAnalyticsConnectionType } from "./analytics";
import { SharingCaller } from "./sharing";
import { retryOnDoReset } from "./do-retry";
import type { CreationApproval } from "@gadgets/workshop-shared/api";
import { OverseerImpl } from "./overseer-impl";
import type { SessionKind } from "./overseer-support";
import { validateOid } from "./overseer-support";
import { fallbackBindingName, gatekeeperVendorId, validateBlueprintScreenshotUpload } from "./overseer-binding-info";
import { GadgetClientImpl } from "./overseer-gadget-client";
import { GatekeeperClientImpl } from "./overseer-gatekeeper-client";
import { ACTION_HISTORY_PAGE_DEFAULT_LIMIT, ACTION_REPLAY_PAGE_SIZE, actionRecordToLog, stampBindHookAction } from "./overseer-action-log";
import type { GatekeeperHookLoopbackProps } from "./overseer-loopbacks";

// Mark an overseer session as a present viewer for its lifetime. The caller invokes the returned
// function from the session's [Symbol.dispose] to leave.
/** Computes the presence payload broadcast when a session joins an overseer chat. */
export function joinSessionPresence(
    impl: OverseerImpl, profileId: string, role: CollaboratorRole,
    fetchProfile: () => Promise<AiChatAuthorInfo>): () => void {
  let leave: (() => void) | undefined;
  let cancelled = false;
  fetchProfile().then(user => {
    if (!cancelled) leave = impl.joinPresence(profileId, user, role);
  }).catch(() => {});
  return () => {
    cancelled = true;
    leave?.();
  };
}

@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class OverseerClientInterface extends RpcTarget implements Overseer {
  #clientProfilePromise: Promise<AiChatAuthorInfo> | undefined;

  constructor(private impl: OverseerImpl,
              private clientProfileId: string,
              private clientUserId: string,
              private isOwner: boolean,
              private notifyClosed: NativeRpcStub<() => void>,
              // Ambient capsule reconciliation started during open(); listSlashCommands() waits for
              // this so ambient providers are attached when possible.
               private slashCommandsReady: Promise<void>) {
    super();
    this.#leaveSession = this.impl.joinSession(this.isOwner ? "owner" : "build");
    this.#leavePresence = joinSessionPresence(
        this.impl, this.clientProfileId, "build", () => this.#getClientProfile());
    this.#leaveOutputsFanout = this.impl.joinOutputsFanout(this.clientUserId);
  }

  // We create a new stub for every call so that we don't have to worry about detecting when a
  // stub has become broken (see AuthenticatedApiImpl.#user in server.ts).
  get #owner(): DurableObjectStub<UserDurableObject> {
    if (!this.impl.ownerId) throw new Error("Workspace has been deleted.");
    return this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId)));
  }

  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)));
  }

  #leaveSession: () => void;
  #leavePresence: () => void;
  #leaveOutputsFanout: () => void;

  [Symbol.dispose]() {
    this.#leaveSession();
    this.#leavePresence();
    this.#leaveOutputsFanout();
    this.notifyClosed();
    this.notifyClosed[Symbol.dispose]();
  }

  // Per-session caller identity for the SharingManager.
  #sharingCaller(): SharingCaller {
    return { profileId: this.clientProfileId, isOwner: this.isOwner };
  }

  // What a capability minted into this session counts as toward #hasCollaboratorSession -- the
  // client can dispose this interface while retaining the capability, so each one counts for its
  // own lifetime. Undefined for the owner: the owner is never an observer, and counting them
  // would restart the owner's solo workspace for the owner's own change.
  #mintedCapabilityKind(): SessionKind | undefined {
    return this.isOwner ? undefined : "build";
  }

  // Count a subscription handle minted into a collaborator's session toward
  // #hasCollaboratorSession for its own lifetime, like every other retainable capability (see
  // #mintedCapabilityKind): a retained subscription keeps delivering workspace data after the
  // interface that minted it is disposed, so one that escaped the count would let a scope
  // widening find no session to sever while e.g. a chat or action subscription kept streaming
  // gatekeeper-derived data. Applied to every subscription-returning method uniformly -- one
  // invariant for every export, rather than per-subscription reasoning about which could carry
  // sensitive data. The owner's subscriptions pass through uncounted.
  #subscriptionLease(subscription: RpcStub<{}>): RpcStub<{}> {
    let kind = this.#mintedCapabilityKind();
    if (!kind) return subscription;
    let leave = this.impl.joinSession(kind);
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        leave();
        subscription[Symbol.dispose]();
      }
    });
  }

  async #getClientProfile(): Promise<AiChatAuthorInfo> {
    if (!this.#clientProfilePromise) {
      this.#clientProfilePromise = retryOnDoReset(
          () => this.#clientUser.whoami(), this.impl.logger)
          .catch((err: unknown) => {
            this.#clientProfilePromise = undefined;
            throw err;
          });
    }

    const profilePromise = this.#clientProfilePromise!;
    return profilePromise;
  }

  async getMetadata(): Promise<GadgetMetadata> {
    let result: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      totalCost: this.impl.storage.totalCost.get(),
      containsRestrictedData: this.impl.storage.containsRestrictedData.get(),
      ownerInvitesOnly: this.impl.storage.ownerInvitesOnly.get(),
      role: "build",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
    if (!this.isOwner) {
      result.owner = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);
    }
    return result;
  }

  async subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>> {
    callback = callback.dup();  // keep stub after return

    // For collaborators, fetch owner info first: storage is read and subscribed below with no
    // await in between, so an update can't land after the snapshot but before the subscription.
    let owner = this.isOwner
        ? undefined : await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);

    let metadata: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      totalCost: this.impl.storage.totalCost.get(),
      containsRestrictedData: this.impl.storage.containsRestrictedData.get(),
      ownerInvitesOnly: this.impl.storage.ownerInvitesOnly.get(),
      role: "build",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
    if (owner) metadata.owner = owner;

    let titleSubscriber = {
      update(value: string) {
        metadata.title = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let costSubscriber = {
      update(value: number | undefined) {
        metadata.totalCost = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let restrictedDataSubscriber = {
      update(value: boolean | undefined) {
        metadata.containsRestrictedData = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let ownerInvitesOnlySubscriber = {
      update(value: boolean | undefined) {
        metadata.ownerInvitesOnly = value;
        callback(metadata).catch(unsubscribe);
      }
    };

    let unsubscribe = () => {
      this.impl.storage.title.unsubscribe(titleSubscriber);
      this.impl.storage.totalCost.unsubscribe(costSubscriber);
      this.impl.storage.containsRestrictedData.unsubscribe(restrictedDataSubscriber);
      this.impl.storage.ownerInvitesOnly.unsubscribe(ownerInvitesOnlySubscriber);
      callback[Symbol.dispose]();
    };

    this.impl.storage.title.subscribe(titleSubscriber);
    this.impl.storage.totalCost.subscribe(costSubscriber);
    this.impl.storage.containsRestrictedData.subscribe(restrictedDataSubscriber);
    this.impl.storage.ownerInvitesOnly.subscribe(ownerInvitesOnlySubscriber);

    callback(metadata).catch(unsubscribe);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async subscribeToPresence(
      subscriber: RpcStub<PresenceSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.addPresenceSubscriber(subscriber));
  }

  async setTitle(title: string): Promise<void> {
    this.impl.storage.title.put(title);
    await this.#owner.updateTitle(this.impl.ctx.id.toString(), title);
  }

  async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.subscribeToWorkpieces(subscriber, true));
  }

  async createGadget(title: string, chatId?: number, bindingName?: string)
      : Promise<RpcStub<GadgetClient>> {
    // When creating within a chat, names already claimed in that chat's scope (its seed
    // plus log-derived bindings) are off-limits too: the chat's binding map is keyed by name,
    // so on replay the existing binding would win and the new gadget would never be addressable
    // under its promised name.
    let chatNames: Set<string> | undefined;
    if (chatId !== undefined) {
      if (!this.impl.storage.chatMeta.get(chatId)) {
        throw new Error(`No such chat: ${chatId}`);
      }
      chatNames = this.impl.chatScopeNames(chatId);
    }
    if (bindingName === undefined) {
      // The user didn't pick a name: derive one from the title via the quick model (the
      // title-to-identifier transform is exactly what it's for), falling back to a generic
      // GADGET/GADGET_2. Existing gadget names -- including pending ones -- are off-limits.
      let taken = new Set(
          [...this.impl.storage.gadgets.list()].flatMap(
              gadget => gadget.bindingName !== undefined ? [gadget.bindingName] : []));
      for (let name of chatNames ?? []) taken.add(name);
      let userMeta = await retryOnDoReset(
          () => this.#clientUser.getChatContext(null), this.impl.logger);
      if (userMeta.quickModel) {
        bindingName = await this.impl.generateBindingName(
            title, taken, {config: userMeta.quickModel, initiator: userMeta.profile});
      }
      bindingName ??= fallbackBindingName("GADGET", name => taken.has(name));
    } else if (chatNames?.has(bindingName)) {
      throw new Error(`The name "${bindingName}" is already in use in this chat. Choose a ` +
          `different name.`);
    }

    let record;
    if (chatId === undefined) {
      // A permanent gadget is born with its head: an empty-tree initial commit (see
      // GadgetRecord.commitId), giving a chat's first edit a commit to pin. Written before the
      // record -- it is content-addressed and referenced by nothing yet, so a validation
      // failure in createGadget below leaves no trace worth cleaning up.
      let initialCommitId = await this.impl.gitStore.writeFilesAsCommit(new Map(), {
        parents: [],
        author: commitIdentityForAuthor(await this.#getClientProfile()),
        message: `Create gadget: ${title}`,
        timestamp: new Date(),
      });
      // (createGadget validates the title and name.)
      record = this.impl.createGadget(title, bindingName, undefined, undefined, initialCommitId);
      this.impl.recordGadgetAnalytics({
        event_name: "workpiece_created",
        user_id: this.clientUserId,
        workpiece_id: record.id,
        source: "direct",
      });
    } else {
      // Creating a gadget with a chat open is provisional to that chat, like code edits: record
      // the creation in the chat log as a "changes" message (with no code update) and mark
      // the gadget pending. Both writes happen in one synchronous step, so (unlike the agent's
      // createGadget tool, whose "changes" message is persisted at step end) this path has no
      // crash window at all.
      let author = await this.#getClientProfile();
      if (!this.impl.storage.chatMeta.get(chatId)) {
        // Re-check adjacent to the synchronous creation: the chat may have been deleted during
        // the awaits above, and a pending record for a deleted chat would never be reaped.
        throw new Error(`No such chat: ${chatId}`);
      }
      record = this.impl.createGadget(title, bindingName, chatId, undefined, undefined,
                                     this.clientUserId);
      this.impl.addChatMessages(chatId, author, [{
        type: "changes",
        createdGadgets: [{gadgetId: record.id, title: record.title, bindingName}],
      }]);
    }
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new GadgetClientImpl(this.impl, record.id, this.clientUserId,
        this.#mintedCapabilityKind());
  }

  async getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.impl.getGadgetRecord(id);  // validate it exists
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new GadgetClientImpl(this.impl, id, this.clientUserId, this.#mintedCapabilityKind());
  }

  async deleteSelf(): Promise<void> {
    if (!this.isOwner) {
      throw new Error("Only the workspace owner can delete it.");
    }
    let startedAt = Date.now();

    this.impl.destroyAllLiveChats();
    // TODO: Revoke user sessions.

    // Disable all enabled hooks so that the gatekeepers stop delivering events to this gadget.
    // We do this before deleting storage so that we still have access to the hook controllers.
    // TODO: If any disablement fails, deletion will be blocked. We could ignore failures, but that
    //   would leave gatekeepers pointing at gadgets that don't exist anymore, which is also bad.
    //   What do we really want here?
    for (let record of Array.from(this.impl.storage.boundHooks.list())) {
      if (record.enabled) {
        await this.disableHook(record.id);
      }
    }

    await this.impl.ctx.blockConcurrencyWhile(async () => {
      await this.#owner.deleteGadget(this.impl.ctx.id.toString());
      await this.impl.ctx.storage.deleteAll();
      this.impl.recordGadgetAnalytics({
        event_name: "gadget_deleted",
        user_id: this.#clientUser.id.toString(),
      });
      // The restart severs every session still holding this workspace so its client reopens. The
      // deleter has nothing to reopen, so close it first. Best-effort: throwing here resets the DO.
      await this.notifyClosed().catch(() => {});
      this.impl.scheduleAccessRestart("Gadget restarted because the workspace was deleted.");
      this.impl.ownerId = undefined;
    });

    this.impl.logger.info("deleted workspace", {
      event: "workspace.delete.completed", durationMs: Date.now() - startedAt,
    });
  }

  async submitCodeChange(chatId: number, submission: CodeChangeSubmission)
      : Promise<{generation: number, revision: number}> {
    let author = await this.#getClientProfile();
    return await this.impl.submitCodeChange(chatId, submission, author, this.clientUserId);
  }

  // --- Commit-backed code reads ---

  // The reads go through the git cache and so may fault-pull through a gatekeeper on the
  // client's behalf -- reaching only commits the workspace's gatekeepers advertised or proved,
  // nothing an agent couldn't already trigger.
  async listTree(commitId: string): Promise<TreeNode[]> {
    return await this.impl.gitCache.readCommitTree(validateOid(commitId));
  }

  async readFilesAtCommit(commitId: string, paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    if (paths.length > MAX_READ_FILES_PER_CALL) {
      throw new Error(`Too many paths: at most ${MAX_READ_FILES_PER_CALL} per call.`);
    }
    return await this.impl.gitCache.readFilesAtCommit(validateOid(commitId), paths);
  }

  async listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]> {
    return await this.impl.listChangedPaths(validateOid(fromCommit), validateOid(toCommit));
  }

  async getCommitLog(fromCommit: string, depth?: number): Promise<CommitInfo[]> {
    if (depth !== undefined && (!Number.isInteger(depth) || depth <= 0)) {
      throw new Error("Invalid depth.");
    }
    return await this.impl.gitStore.readCommitLog(validateOid(fromCommit), {depth});
  }

  async updateChatFromMainline(chatId: number): Promise<{conflictPaths: string[]}> {
    let author = await this.#getClientProfile();
    return await this.impl.withChatLock(chatId,
        () => this.impl.updateChatFromMainline(chatId, author));
  }

  async getGatekeeperById(id: number): Promise<GatekeeperClient<any>> {
    let gatekeeper = this.impl.storage.gatekeepers.get(id)?.id;
    if (gatekeeper === undefined) {
      throw new Error(`No such gatekeeper id: ${id}`);
    }
    // A connection published moments before a scope-widening restart is not usable by the
    // sessions that restart is about to sever (see #gatekeepersPendingRestart).
    let facet = await this.impl.getGatekeeperFacet(id);
    this.impl.assertGatekeeperUsable(id);
    return new GatekeeperClientImpl(
        this.impl, id, facet, this.clientUserId, this.#mintedCapabilityKind());
  }

  private async recordConnectionCreated(
      result: GatekeeperClient<any>, connectionType: ProductAnalyticsConnectionType,
      vendorId?: string): Promise<void> {
    let gatekeeperId = await result.getId();
    this.impl.recordGadgetAnalytics({
      event_name: "connection_created",
      user_id: this.#clientUser.id.toString(),
      gatekeeper_id: gatekeeperId,
      connection_type: connectionType,
      vendor_id: vendorId,
    });
  }

  async newGatekeeper(accountId: number, resourceUrl: string)
      : Promise<GatekeeperClient<any> | null> {
    let {class: cls, vendorId, typeUrlPattern} =
        await this.#clientUser.getGatekeeperClassFor(accountId, resourceUrl);
    let creationSpec: GatekeeperCreationSpec = {
      type: "gatekeeper",
      vendorId,
      resourceUrl,
      typeUrlPattern,
    };
    let result = await this.impl.addGatekeeper(
        cls, creationSpec, this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "gatekeeper", vendorId);
    return result;
  }

  async newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>> {
    let chatMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(modelId), this.impl.logger);
    let props: AiModelGatekeeperProps = {
      displayName: chatMeta.aiModel!.profile.name,
      config: chatMeta.aiModel!.config,
      initiator: this.impl.gadgetAuthorFor(chatMeta.profile),
      metadata: { source: "model-binding", gadgetId: this.impl.ctx.id.toString() },
      // Spend gating: the binding's calls draw on the workspace owner's allowance (whoever
      // mints it); see bindingUsageGate in ai-models.ts.
      ownerUserId: this.impl.ownerId,
    }

    let creationSpec: GatekeeperCreationSpec = {
      type: "aiModel",
      modelId,
      provider: chatMeta.aiModel!.config.provider,
      modelName: chatMeta.aiModel!.config.model,
    };

    let result = await this.impl.addGatekeeper(
        modelKind(props.config.provider, props.config.model) === "decision"
            ? this.impl.ctx.exports.DecisionModelGatekeeper({props})
            : this.impl.ctx.exports.LanguageModelGatekeeper({props}),
        creationSpec, this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "ai_model");
    return result;
  }

  async newAgentSpawnerGatekeeper(config: AgentSpawnerConfig): Promise<GatekeeperClient<any>> {
    // Validate the configured env: names must be valid binding names and targets must exist --
    // and must not be gadgets still provisional to some chat, which belong to that chat's
    // unaccepted proposal, not (yet) to the workspace. (Spawn-time snapshotting tolerates targets
    // deleted later; this just catches bad input.)
    for (let [name, target] of Object.entries(config.env)) {
      validateBindingName(name);
      if (name === GIT_BINDING_NAME) {
        // The spawned chat's env already has the automatic env.GIT, which this would shadow.
        throw new Error(`Agent spawner env entry "${name}": the binding name \`${name}\` is ` +
            `reserved.`);
      }
      let gadget = this.impl.storage.gadgets.get(target);
      if (gadget) {
        if (gadget.type === "worktree") {
          throw new Error(`Agent spawner env entry "${name}" references workpiece ${target}, ` +
              `which is a worktree; worktrees are chat-private and cannot be configured.`);
        }
        if (gadget.pending) {
          throw new Error(`Agent spawner env entry "${name}" references gadget ${target}, ` +
              `which is still pending in a chat.`);
        }
      } else if (!this.impl.storage.gatekeepers.get(target)) {
        throw new Error(`Agent spawner env entry "${name}" references workpiece ${target}, ` +
            `which does not exist.`);
      }
    }

    let props: AgentSpawnerBindingProps = {
      overseerId: this.impl.ctx.id.toString(),
      config,
      creatorUserId: this.#clientUser.id.toString(),
    };

    // Resolve model provider/name for blueprint metadata.
    let creationSpec: GatekeeperCreationSpec = {
      type: "agentSpawner",
      config,
    };
    if (config.modelId) {
      let chatMeta = await retryOnDoReset(
          () => this.#clientUser.getChatContext(config.modelId), this.impl.logger);
      if (chatMeta.aiModel) {
        creationSpec.modelProvider = chatMeta.aiModel.config.provider;
        creationSpec.modelName = chatMeta.aiModel.config.model;
      }
    }

    let result = await this.impl.addGatekeeper(
        this.impl.ctx.exports.AgentSpawnerGatekeeper({props}), creationSpec,
        this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "agent_spawner");
    return result;
  }

  async listActions(options?: {beforeId?: number, filter?: ActionHistoryFilter})
      : Promise<ActionHistoryPage> {
    let {beforeId, filter = "all"} = options ?? {};
    if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 0)) {
      throw new TypeError(`Invalid beforeId: ${beforeId}`);
    }

    // One ranged read -- off the collection itself for "all" (already id-ordered), off
    // byHistoryFilter otherwise -- so the work is O(page) however sparse the matches. Pages are
    // full until the last; the +1 record probes whether an older page exists.
    let actions = this.impl.storage.actions;
    let range = {end: beforeId, reverse: true, limit: ACTION_HISTORY_PAGE_DEFAULT_LIMIT + 1};
    let page = [...(filter === "all"
        ? actions.list(range) : actions.byHistoryFilter.get(filter, range))];
    let more = page.length > ACTION_HISTORY_PAGE_DEFAULT_LIMIT;
    if (more) page.pop();
    return {
      entries: page.map(actionRecordToLog),
      nextBeforeId: more ? page.at(-1)!.id : undefined,
    };
  }

  async approveAction(id: number, creation?: CreationApproval): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.type === "bindHook") {
      throw new Error("Hooks should be enabled/disabled, not approved/rejected.");
    }
    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }
    if (action.type === "observation") {
      throw new Error("Observations can't have 'pending' state.");
    }

    // Resolve the approver's identity before applying, so a failed profile fetch can't leave the
    // action applied in the world but still "pending" in storage.
    let profile = await this.#getClientProfile();
    if (action.caller.from === "agent" && action.description.awaitDecision) {
      this.impl.rememberDecisionInitiator(action.caller.chatId, this.#clientUser.id.toString(), profile);
    }
    // A creation is made in the account the approver chose, whose verifier carries its authority.
    let vendorId = gatekeeperVendorId(this.impl.storage.gatekeepers.get(action.gatekeeperId));
    let creator = action.action === "create" && creation && vendorId
        ? await this.#clientUser.getVerifier(creation.accountId, vendorId) : null;
    await this.impl.applyPendingAction(action, profile, false,
        creator ? {creator, configuration: creation?.configuration ?? null} : undefined);

    // Clearing this manual gate may unblock later auto-eligible pending actions on the same
    // gatekeeper, so cascade a drain (in-order) once this one is applied.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(action.gatekeeperId));
  }

  // A drain can decide an agent turn's last awaited action, which must resume that turn just as a
  // manual approval does.
  async #drainAutoApprovalsAndResume(gatekeeperId: WorkpieceId): Promise<void> {
    // Snapshot every awaited action, even auto-eligible ones that didn't suspend their turn: a turn
    // suspended on a manual action can also be waiting on them. Accepted cost: one applied here
    // (e.g. a retried auto-apply failure) can resume a turn that never suspended.
    let awaited = new Map<number, number>();  // action id -> chat id
    let profile: AiChatAuthorInfo | undefined;
    // Legacy adoption scans chat history, so close the single KV cursor before adopting or awaiting.
    let pending = [...this.impl.storage.actions.pendingByGatekeeper.get(gatekeeperId)];
    for (let record of pending) {
      if (record.type === "action" && record.caller.from === "agent" &&
          record.description.awaitDecision) {
        awaited.set(record.id, record.caller.chatId);
        if (!this.impl.storage.activeAgents.get(record.caller.chatId)) {
          profile ??= await this.#getClientProfile();
          this.impl.rememberDecisionInitiator(record.caller.chatId, this.#clientUser.id.toString(), profile);
        }
      }
    }
    await this.impl.drainAutoApprovals(gatekeeperId);
    // The shared apply path claims new turns; this also covers legacy rows adopted above.
    for (let [id, chatId] of awaited) {
      if (this.impl.storage.actions.get(id)?.state !== "approved") continue;
      this.impl.resumeAgentAfterDecision(chatId, id);
    }
  }

  async listHooks(): Promise<BoundHookInfo[]> {
    let defaultGadgetId = this.impl.defaultGadgetId;
    let result: BoundHookInfo[] = [];
    for (let record of this.impl.storage.boundHooks.list()) {
      let gatekeeper = this.impl.storage.gatekeepers.get(record.gatekeeperId);
      result.push({
        id: record.id,
        gatekeeperId: record.gatekeeperId,
        // Hooks recorded before multi-gadget support carry no gadgetId; they belong to the
        // default gadget, which necessarily exists in any workspace old enough to have them.
        gadgetId: (record.gadgetId ?? defaultGadgetId)!,
        resourceTitle: gatekeeper?.resourceTitle,
        resourceUrl: gatekeeper?.resourceUrl,
        description: record.description,
        enabled: record.enabled,
      });
    }

    return result;
  }

  async enableHook(id: number): Promise<void> {
    let record = this.impl.storage.boundHooks.get(id);
    if (!record) throw new Error("Invalid hook ID.");

    if (!record.enabled) {
      let props: GatekeeperHookLoopbackProps = {
        overseerId: this.impl.ctx.id.toString(),
        hookId: id,
      }

      // TODO(hooks): enable()/disable() race. controller.enable() is awaited RPC to the gatekeeper;
      // a concurrent disableHook() can finish its controller.disable() first, then this enable()
      // still lands and recreates gatekeeper-side state (e.g. a scheduler driver row + alarm).
      // Live firings stay safe because startHook() re-checks record.enabled, but the resurrected
      // row can keep consuming quota/alarms until cleaned up.
      await record.controller.enable(
          this.impl.ctx.exports.GatekeeperHookLoopback({props}) as unknown as
              Fetcher<HookInitiator<RpcTarget>>,
          {
            workspaceId: this.impl.ctx.id.toString(),
            ...(record.gadgetId !== undefined ? {gadgetId: record.gadgetId} : {}),
          });

      // Flip the record and handle the "use"-scope widening an enabled hook can cause.
      this.impl.enableHookRecord(record);
    }
  }

  async disableHook(id: number): Promise<void> {
    let record = this.impl.storage.boundHooks.get(id);
    if (!record) throw new Error("Invalid hook ID.");

    if (record.enabled) {
      await record.controller.disable();

      // Re-read after the await: a deleteHook/removeGatekeeper landing while disable() was in
      // flight already reached the goal state (no hook), and putting the captured record back
      // would resurrect it as a zombie -- deleting the record must stay the authoritative kill.
      let current = this.impl.storage.boundHooks.get(id);
      if (!current) return;
      current.enabled = false;
      this.impl.storage.boundHooks.put(current);
      stampBindHookAction(this.impl.storage, current.actionId, false);
    }
  }

  async deleteHook(id: number): Promise<void> {
    return this.impl.deleteHook(id);
  }


  async rejectAction(id: number): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }

    if (action.type !== "action") {
      throw new Error(`Can't reject an observation: ${id}`);
    }

    if (action.action === "create") {
      // Rejecting a creation removes its connection, as disconnecting would (clearing queued
      // pushes' marks), and rejects every action queued against the simulated resource: none can
      // apply now. Their gatekeeper-side state goes with the facet's storage, so no rejectAction()
      // is called.
      let profile = await this.#getClientProfile();
      let queued = Array.from(
          this.impl.storage.actions.pendingByGatekeeper.get(action.gatekeeperId));
      this.impl.removeGatekeeper(action.gatekeeperId);
      for (let record of queued) {
        if (record.type !== "action") continue;
        record.state = "rejected";
        record.appliedAt = new Date();
        record.resolvedBy = profile;
        this.impl.storage.actions.put(record);
        this.impl.traceAgentActionApproval(record, "denied");
        if (record.caller.from === "agent") {
          this.impl.resumeAgentAfterDecision(record.caller.chatId, record.id);
        }
      }
      return;
    }

    let gatekeeper = await this.impl.getGatekeeperFacet(action.gatekeeperId);

    // Resolve the rejecter's identity before notifying the gatekeeper, so a failed profile fetch
    // can't leave the action rejected with the gatekeeper but still "pending" in storage.
    let profile = await this.#getClientProfile();

    await gatekeeper.rejectAction(action.action);

    action.state = "rejected";
    action.appliedAt = new Date();
    action.resolvedBy = profile;
    // A rejected push's pending-push marks are removed in the same durable step as the state
    // change (nothing was transmitted, so nothing became proven). No-op for pushless actions.
    this.impl.storage.transaction(() => {
      this.impl.gitCache.clearPushMarks(action.id);
      this.impl.storage.actions.put(action);
    });
    this.impl.traceAgentActionApproval(action, "denied");
    if (action.caller.from === "agent") {
      this.impl.resumeAgentAfterDecision(action.caller.chatId, action.id);
    }

    // Deny leaves the turn ended, like denyConnectionRequest. The rejected record also prevents a
    // sibling approval from resuming this turn. Like an approval, though, clearing this manual gate
    // may unblock later auto-eligible pending actions, whose turns do resume.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(action.gatekeeperId));
  }

  // Enable auto-approval of actions carrying `actionKind` on the given gatekeeper. Stores the
  // opt-in rule (one of the two gates required to auto-apply -- the action's own `autoApprovable`
  // verdict is the other) with the kind's display label, and immediately drains any pending
  // actions that this newly unblocks. Auto-approval rules are workspace-wide per gatekeeper.
  async setAutoApprovedActionKind(gatekeeperId: WorkpieceId, actionKind: ActionKind)
      : Promise<void> {
    let gatekeeper = this.impl.storage.gatekeepers.get(gatekeeperId);
    if (!gatekeeper) {
      throw new Error(`No such gatekeeper: ${gatekeeperId}`);
    }

    let profile = await this.#getClientProfile();
    this.impl.storage.autoApproveTags.put({
      gatekeeperId,
      actionKind,
      enabledBy: profile,
    });
    // Apply the currently-visible pending action(s) with this tag right away.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(gatekeeperId));
  }

  // Remove the auto-approval rule for `tag` on the given gatekeeper, so future matching actions
  // require manual approval again.
  async removeAutoApprovedActionKind(gatekeeperId: WorkpieceId, tag: string): Promise<void> {
    this.impl.storage.autoApproveTags.delete(`${gatekeeperId}:${tag}`);
  }

  // List the enabled auto-approval rules.
  async listAutoApprovedActionKinds()
      : Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>> {
    return [...this.impl.storage.autoApproveTags.list()].map(rule => ({
      gatekeeperId: rule.gatekeeperId,
      actionKind: rule.actionKind,
    }));
  }

  async listPreApprovableActions(): Promise<PreApprovableAction[]> {
    // Surface actions from every gatekeeper bound by some gadget (the connections the UI shows).
    let boundIds = new Set<WorkpieceId>();
    for (let gadget of this.impl.storage.gadgets.list()) {
      if (gadget.type !== "gadget") continue;  // worktrees have no binding edges
      for (let edge of Object.values(gadget.bindings)) {
        boundIds.add(edge.target);
      }
    }

    // TODO: a single gatekeeper failing (e.g. a rejected RPC) currently fails the whole catalog,
    // since we let getAutoApprovableActions() reject. Eventually we should isolate per-gatekeeper
    // failures and surface them to the UI (e.g. return the actions we could gather plus a list of
    // gatekeepers we couldn't reach) so one bad connection doesn't hide everyone else's actions.
    let perGatekeeper = [...boundIds]
        .map(id => this.impl.storage.gatekeepers.get(id))
        .filter(gk => gk !== undefined)
        .map(async (gk): Promise<PreApprovableAction[]> => {
      let facet = await this.impl.getGatekeeperFacet(gk.id);
      let kinds = await facet.getAutoApprovableActions();
      return kinds.map(actionKind => ({
        gatekeeperId: gk.id,
        // resourceTitle is a denormalized cache of the gatekeeper's describe().title, populated in a
        // second step after the record is first persisted (see addGatekeeper). It can be absent if
        // that describe() failed, or for records predating the field, so fall back to a placeholder.
        resourceTitle: gk.resourceTitle || "(title unavailable)",
        vendorId: gk.creationSpec?.type === "gatekeeper" ? gk.creationSpec.vendorId : undefined,
        actionKind,
        alreadyEnabled:
            this.impl.storage.autoApproveTags.get(`${gk.id}:${actionKind.tag}`) !== undefined,
      }));
    });

    return (await Promise.all(perGatekeeper)).flat();
  }

  // Find a pending connectionRequest message by id. The request id encodes the chat id as a prefix
  // (`${chatId}:...`) so we only scan that thread's messages.
  #findConnectionRequest(requestId: string): AiChatMessage & {type: "connectionRequest"} {
    let colonIdx = requestId.indexOf(":");
    if (colonIdx < 0) throw new Error(`Malformed connection request id: ${requestId}`);
    let chatId = Number(requestId.slice(0, colonIdx));
    if (!Number.isFinite(chatId)) throw new Error(`Malformed connection request id: ${requestId}`);

    for (let msg of this.impl.storage.chats.list({prefix: chatKeyPrefix(chatId)})) {
      if (msg.type === "connectionRequest" && msg.requestId === requestId) {
        return msg as AiChatMessage & {type: "connectionRequest"};
      }
    }
    throw new Error(`No such connection request: ${requestId}`);
  }


  async acceptConnectionRequest(
      requestId: string, result: {gatekeeperId: number}): Promise<void> {
    let msg = this.#findConnectionRequest(requestId);
    if (msg.state !== "pending") {
      throw new Error(`Connection request is not pending: ${requestId}`);
    }
    if (!this.impl.storage.activeAgents.get(msg.chatId)) {
      // Main discarded the original authority of paused turns. Adopt the explicit approver,
      // matching its old behavior; new pauses already retain their original execution row.
      let profile = await this.#getClientProfile();
      msg = this.#findConnectionRequest(requestId);
      if (msg.state !== "pending") {
        throw new Error(`Connection request is not pending: ${requestId}`);
      }
      this.impl.rememberDecisionInitiator(msg.chatId, this.#clientUser.id.toString(), profile);
    }

    msg.state = "accepted";
    // The gatekeeper is surfaced to the agent as a named binding in the chat's env, under the
    // name recorded on the request (see the connectionRequest history case in agent.ts).
    msg.gatekeeperId = result.gatekeeperId;
    // Bump the timestamp so clients that were offline during the decision still receive the
    // mutated card on reconnect (the catch-up scan is ordered by timestamp).
    msg.timestamp = this.impl.getChatTimestamp();
    this.impl.storage.chats.put(msg);  // fires the subscriber update() → re-delivers the card

    this.impl.resumeAgentAfterDecision(msg.chatId, requestId);
  }

  async denyConnectionRequest(requestId: string): Promise<void> {
    let msg = this.#findConnectionRequest(requestId);
    if (msg.state !== "pending") {
      throw new Error(`Connection request is not pending: ${requestId}`);
    }

    msg.state = "denied";
    msg.timestamp = this.impl.getChatTimestamp();
    this.impl.storage.chats.put(msg);  // fires the subscriber update() → re-delivers the card
    this.impl.resumeAgentAfterDecision(msg.chatId, requestId);

    // Intentionally do NOT resume the agent on deny. The agent's turn already ended when it made the
    // request; leaving it ended lets the user say what they want done instead, rather than forcing
    // the agent to guess from a bare "denied" signal. The denial is recorded in history and the
    // agent sees it the next time the user sends a message (see the connectionRequest history case).
  }

  async subscribeToActions(subscriber: RpcStub<ActionsSubscriber>, startAfter?: Date)
      : Promise<RpcStub<{}>> {
    let actions = this.impl.storage.actions;

    subscriber = subscriber.dup();  // keep stub after return
    let subscribed = false;
    let disposed = false;
    subscriber.onRpcBroken(_ => unsubscribe());

    let dbSubscriber = {
      add(record: ActionRecord) {
        subscriber.entry(actionRecordToLog(record)).catch(unsubscribe);
      },
      update(_oldRecord: ActionRecord, newRecord: ActionRecord): void {
        subscriber.entry(actionRecordToLog(newRecord)).catch(unsubscribe);
      },
      remove(_record: ActionRecord): void {
        // Required by typed-storage's Subscriber interface; actions are append-only today.
      }
    }

    function unsubscribe() {
      if (disposed) return;
      disposed = true;
      if (subscribed) actions.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    actions.subscribe(dbSubscriber);
    subscribed = true;

    // The subscription delivers live deltas only; clients query current pending state via
    // listActions({filter: "pending"}) after initiating the subscribe (see api.ts).
    if (startAfter !== undefined) {
      // Resubscribe after a disconnect: sweep byLastChanged for everything changed since the
      // client's last-seen time -- O(changed during the gap), not O(log). The bound is
      // inclusive: the frozen clock stamps whole batches with one instant, so an exclusive bound
      // would drop the last-seen record's siblings, while re-delivery is just a harmless upsert.
      // The end key is fixed up front; a record changing mid-replay re-sorts past it and arrives
      // via the live subscription instead. Each page's delivery is awaited, so a failure rejects
      // the subscribe call before ready() and a huge gap can't queue unbounded callbacks.
      try {
        let newest = [...actions.byLastChanged.list({reverse: true, limit: 1})].at(0);
        if (newest !== undefined) {
          let end = actionLastChangedKey({...newest, id: newest.id + 1});
          // keyString(t) is a prefix of every key with that timestamp, so `start` is inclusive
          // of the whole cutoff instant.
          let from: ListOptions<string> = {start: keyString(startAfter.valueOf())};
          for (;;) {
            if (disposed) throw new Error("Action subscriber failed during replay");
            let page = [...actions.byLastChanged.list(
                {...from, end, limit: ACTION_REPLAY_PAGE_SIZE})];
            await Promise.all(page.map(record => subscriber.entry(actionRecordToLog(record))));
            if (page.length < ACTION_REPLAY_PAGE_SIZE) break;
            from = {startAfter: actionLastChangedKey(page.at(-1)!)};
          }
        }
      } catch (err) {
        unsubscribe();
        throw err;  // rejecting the subscribe call is the client's error signal
      }
    }

    if (!disposed) subscriber.ready().catch(unsubscribe);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async listChats(): Promise<AiChatMetadata[]> {
    return [...this.impl.storage.chatMeta.list({reverse: true})]
        .map(meta => this.impl.chatMetaForClient(meta));
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    return retryOnDoReset(() => this.#clientUser.listModels(), this.impl.logger);
  }

  async listSlashCommands(): Promise<SlashCommandChoice[]> {
    await this.slashCommandsReady;
    return this.impl.listSlashCommands();
  }

  async uploadBlob(content: Uint8Array): Promise<string> {
    const {oid} = await this.impl.gitStore.writeBlob(content);
    await this.impl.ctx.storage.sync();
    return oid;
  }

  // Fetch the bytes of a committed chat attachment over the authenticated RPC connection. The
  // caller already has its canonical metadata from the ChatAttachmentRef in the message.
  async getChatAttachmentContent(chatId: number, id: string): Promise<Uint8Array> {
    return await this.impl.getChatAttachmentData(chatId, id);
  }

  // Compaction boundaries delimit the pages: the newest page is the tail replay still scans, and each
  // earlier page is the span one checkpoint summarized. A thread that was never compacted has a
  // single page.
  async getChatHistory(chatId: number, beforeSequence?: number): Promise<AiChatHistoryPage> {
    let checkpoint = beforeSequence === undefined
        ? this.impl.getActiveChatCompaction(chatId)
        : this.impl.getChatCompactionBelow(chatId, beforeSequence);
    let result = [...this.impl.storage.chats.list({
      prefix: chatKeyPrefix(chatId),
      start: checkpoint && chatKey(chatId, checkpoint.compactedTo),
      end: beforeSequence === undefined ? undefined : chatKey(chatId, beforeSequence),
    })];
    return {
      messages: result.map((msg) => this.#getChatMessageForClient(msg)),
      compacted: checkpoint && {
        to: checkpoint.compactedTo,
        summary: checkpoint.summary,
        proposedChange: checkpoint.proposedChange,
      },
    };
  }

  async getChatMessage(chatId: number, sequence: number): Promise<AiChatMessage | undefined> {
    let msg = this.impl.storage.chats.get(chatKey(chatId, sequence));
    return msg && this.#getChatMessageForClient(msg);
  }

  #getChatMessageForClient(msg: StoredChatMessage): AiChatMessage {
    if (msg.type === "action") {
      let record = this.impl.storage.actions.get(msg.actionId);
      if (record) {
        msg.actionLog = actionRecordToLog(record);
      }
    }
    return this.impl.hydrateChatMessageForClient(msg);
  }

  async subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date)
      : Promise<RpcStub<{}>> {
    let chats = this.impl.storage.chats;
    let chatMeta = this.impl.storage.chatMeta;
    let changedChatMetadata: AiChatMetadata[] = [];
    let replayCount = 0;

    subscriber = subscriber.dup();  // keep stub after return
    this.impl.addChatSubscriber(subscriber);
    subscriber.onRpcBroken(_ => unsubscribe());

    // Send the server-instance generation first, before any catch-up callbacks, so the client can
    // detect a full DO restart and discard stale provisional stream state.
    subscriber.streamGeneration(this.impl.streamGeneration).catch(unsubscribe);

    let impl = this.impl;
    let metaSubscriber = {
      add(record: AiChatMetadata) {
        subscriber.metadata(impl.chatMetaForClient(record)).catch(unsubscribe);
      },
      update(oldRecord: AiChatMetadata, newRecord: AiChatMetadata): void {
        subscriber.metadata(impl.chatMetaForClient(newRecord)).catch(unsubscribe);
      },
      remove(record: AiChatMetadata): void {
        subscriber.deleted(record.id);
      }
    }

    let self = this;
    function deliverMessage(record: AiChatMessage) {
      subscriber.message(self.#getChatMessageForClient(record)).catch(unsubscribe);
    }

    let msgSubscriber = {
      add(record: AiChatMessage) {
        deliverMessage(record);
      },
      update(oldRecord: AiChatMessage, newRecord: AiChatMessage): void {
        // Chat messages are normally immutable, but connectionRequest messages are mutated in
        // place when the user accepts/denies. Re-deliver so the client (which indexes by
        // sequence) replaces the cached message and re-renders the card.
        deliverMessage(newRecord);
      },
      remove(record: AiChatMessage): void {
        // Never happens.
      }
    }

    let disposed = false;
    function unsubscribe() {
      if (disposed) return;
      disposed = true;
      chats.unsubscribe(msgSubscriber);
      chatMeta.unsubscribe(metaSubscriber);
      self.impl.removeChatSubscriber(subscriber);
      subscriber[Symbol.dispose]();
    };

    if (startAfter !== undefined) {
      // Catch up on metadata changes.
      for (let meta of chatMeta.byLastActive.list({startAfter: startAfter.valueOf()})) {
        changedChatMetadata.push(meta);
        ++replayCount;
      }
    }

    if (startAfter !== undefined) {
      // Catch up on messages.
      for (let msg of chats.byTimestamp.list({startAfter: startAfter.valueOf()})) {
        deliverMessage(msg);
        ++replayCount;
      }
      // Messages establish the durable state that the corresponding metadata describes.
      for (let meta of changedChatMetadata) {
        subscriber.metadata(impl.chatMetaForClient(meta)).catch(unsubscribe);
      }
    }

    // Replay every currently retained (not-yet-materialized) change row so the subscriber can
    // reconstruct uncommitted chat content without a separate fetch. Rows a "changes" message
    // has absorbed are not replayed -- the message's watermark covers them -- and the rows are
    // delivered after the message catch-up above, matching their position in the stream (rows
    // are strictly newer than every materialized message of their generation). Delivered
    // unconditionally (no startAfter filtering): the client dedupes by (generation, revision).
    for (let row of this.impl.storage.chatChanges.list()) {
      if (row.retired) continue;
      subscriber.changeApplied(row.chatId, row.generation, row.revision, row.author, row.change,
                               row.submission).catch(unsubscribe);
      ++replayCount;
    }

    this.impl.logger.debug("chat subscription replay completed", {
      event: "chat.subscription.replay.completed",
      size: replayCount,
    });

    chatMeta.subscribe(metaSubscriber);
    chats.subscribe(msgSubscriber);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async newChat(initialMessage: string | SlashCommandRequest, chosenModelId: string | null,
                capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
                formats?: MessageFormatRef[]): Promise<number> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(chosenModelId), this.impl.logger);
    return this.impl.newChat(this.#clientUser, userMeta, initialMessage, capsules, attachments,
                             undefined, undefined, formats);
  }

  async sendChatMessage(
      chatId: number, message: string | SlashCommandRequest, chosenModelId: string | null,
      capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[]): Promise<void> {
    // A steer runs on the running turn's model, so it is queued before the sender's model is
    // looked up: a collaborator need not have that model.
    let author = await this.#getClientProfile();
    if (this.impl.steerRunningTurn(
        chatId, this.clientUserId, author, message, capsules, attachments, formats)) {
      return;
    }
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(chosenModelId), this.impl.logger);
    return this.impl.sendChatMessage(
        this.#clientUser, userMeta, chatId, message, capsules, attachments, undefined, formats);
  }

  async setChatTitle(chatId: number, title: string): Promise<void> {
    let meta = this.impl.storage.chatMeta.get(chatId);
    if (!meta) {
      throw new Error("No such chatId: " + chatId);
    }
    meta.lastActive = this.impl.getChatTimestamp();
    meta.title = title;
    this.impl.storage.chatMeta.put(meta);
  }

  async mergeChanges(chatId: number): Promise<MergeChangesResult> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(null), this.impl.logger);
    return await this.impl.withChatLock(chatId,
        () => this.impl.mergeChanges(chatId, userMeta, this.#clientUser.id.toString()));
  }

  async revertChanges(chatId: number, revertFrom: number): Promise<void> {
    if (!Number.isInteger(revertFrom) || revertFrom < 0) {
      throw new Error("Invalid revertFrom.");
    }

    let author = await this.#getClientProfile();
    await this.impl.withChatLock(chatId,
        () => this.impl.revertChanges(chatId, revertFrom, author));
  }

  async deleteChat(chatId: number): Promise<void> {
    let startedAt = Date.now();
    let response = this.impl.storage.gadgetResponseDeliveries.undeliveredByChatId.get(chatId);
    if (response?.status === "waiting") {
      this.impl.deliverExternalMessageResponse(response, "The chat was deleted before the agent responded.");
    }

    // Delete the chat's workpiece registry footprint: provisional gadgets, all of its worktrees,
    // and provisional binding edges.
    await this.impl.removeChatWorkpieces(chatId);
    this.impl.storage.chatMeta.delete(chatId);
    this.impl.storage.chatContext.delete(chatId);
    // Buffer the checkpoints first: deleting invalidates the list cursor.
    for (let checkpoint of Array.from(
        this.impl.storage.chatCompactions.list({prefix: chatKeyPrefix(chatId)}))) {
      this.impl.storage.chatCompactions.deleteRecord(checkpoint);
    }

    // The chat's change stream: rows (retired included), the straggler-bridge boundary, and the
    // per-client dedupe records (which live exactly as long as the chat -- see submitCodeChange).
    this.impl.deleteAllChatChanges(chatId);
    for (let record of Array.from(this.impl.storage.chatChangeClients.list(
        {prefix: chatKeyPrefix(chatId)}))) {
      this.impl.storage.chatChangeClients.deleteRecord(record);
    }

    // Any pre-conversion legacy drafts (see ChatDraftUpdateRecord).
    for (let draft of Array.from(this.impl.storage.chatDraftUpdates.list(
        {prefix: chatKeyPrefix(chatId)}))) {
      this.impl.storage.chatDraftUpdates.deleteRecord(draft);
    }

    // Delete the chat's messages and the attachment content referenced by them. Attachment metadata
    // is canonical in each message's ChatAttachmentRef, so no separate attachment index is needed.
    this.impl.ctx.storage.transactionSync(() => {
      for (let msg of this.impl.storage.chats.list({prefix: chatKeyPrefix(chatId)})) {
        if (msg.type === "message") {
          for (let attachment of msg.attachments ?? []) {
            let content = this.impl.storage.chatAttachmentContent.get(attachment.id);
            if (content?.state.type === "committed" && content.state.chatId === chatId) {
              this.impl.storage.chatAttachmentContent.delete(attachment.id);
            }
          }
        }
        this.impl.storage.chats.deleteRecord(msg);
      }
    });

    // Clean up agentCallbackArgs for this chat, and any calls to its agent not yet delivered.
    for (let entry of this.impl.storage.agentCallbackArgs.list(
        {prefix: chatKeyPrefix(chatId)})) {
      this.impl.storage.agentCallbackArgs.deleteRecord(entry);
    }
    for (let entry of Array.from(this.impl.storage.pendingAgentCalls.list(
        {prefix: chatKeyPrefix(chatId)}))) {
      this.impl.storage.pendingAgentCalls.deleteRecord(entry);
    }

    // Clean up the chat's model-facing snapshots.
    for (let entry of this.impl.storage.chatModelData.list(
        {prefix: chatKeyPrefix(chatId)})) {
      this.impl.storage.chatModelData.deleteRecord(entry);
    }

    // Defensively drop any resume record so a deleted chat is never resumed. (Aborting the agent
    // below also clears this via the tracked promise's finally, but the chat may have no live
    // agent in memory, e.g. after a restart before resumption ran.)
    this.impl.storage.activeAgents.delete(chatId);

    // Clean up all in-memory live state for this chat.
    this.impl.destroyLiveChat(chatId);

    this.impl.logger.info("deleted chat", {
      event: "chat.delete.completed", chatId, durationMs: Date.now() - startedAt,
    });
  }

  async stopAgent(chatId: number): Promise<void> {
    this.impl.cancelAgent(chatId);
  }

  async retryAgent(chatId: number, modelId: string): Promise<void> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(modelId), this.impl.logger);

    let meta = this.impl.assertChatNotActive(chatId);
    if (!userMeta.aiModel) {
      throw new Error("No AI model available.");
    }

    let result = this.impl.materializeChatChanges(chatId, meta);
    if (result) meta = result.meta;

    // An explicit retry starts a fresh segment, rather than inheriting an older decision wait
    // if this execution is interrupted before it can commit its first response.
    this.impl.addChatMessages(chatId, userMeta.profile,
        [{type: "agentNudge", text: "Retry the previous request."}]);
    meta.activeAgent = userMeta.aiModel.profile;
    meta.lastActive = this.impl.getChatTimestamp();
    this.impl.storage.chatMeta.put(meta);

    this.impl.startAgent(chatId, userMeta.aiModel, userMeta.profile,
                         this.#clientUser.id.toString());
  }

  async finalizeChatDraft(chatId: number): Promise<void> {
    let meta = this.impl.assertChatNotActive(chatId);
    this.impl.materializeChatChanges(chatId, meta);
  }

  async discardChatDraftChanges(chatId: number): Promise<void> {
    // Under the chat lock: the discard drops unlogged pins, and interleaving one of the
    // lock-holding operations' awaits could otherwise drop a pin whose seed a message they are
    // about to record (e.g. a mainline merge) is rooted in.
    await this.impl.withChatLock(chatId, async () => this.impl.discardChatDraftChanges(chatId));
  }

  async subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(await this.impl.subscribeToConsoleLogs(subscriber));
  }

  // --- Blueprint management ---

  async listBlueprints(): Promise<BlueprintGadgetSummary[]> {
    let result: BlueprintGadgetSummary[] = [];
    for (let record of Array.from(this.impl.storage.blueprints.list())) {
      result.push({
        id: record.id,
        title: record.metadata.title,
        description: record.metadata.description,
        version: record.metadata.version,
        codeVersionDate: await this.#blueprintCodeDate(record),
        screenshotUrl: blueprintScreenshotUrl(record.id, record.metadata),
        dirty: record.dirty,
        ...(await this.#hasUnpublishedChanges(record) ? {unpublishedChanges: true} : {}),
      });
    }
    return result;
  }

  // Whether the gadget a blueprint exports has committed files other than the ones the
  // blueprint last published, which are those of the record's `commitId`. A gadget that has
  // since been removed has nothing left to publish, and a record from before git-backed code
  // storage has no commit to compare with until it is migrated.
  //
  // The trees are what is compared, not the commits: publishing an unchanged tree mints nothing
  // and leaves `commitId` where it was (see mintBlueprintRelease), so a head that has moved on
  // to the same files would otherwise count as a change that no publish could clear.
  async #hasUnpublishedChanges(record: BlueprintGadgetRecord): Promise<boolean> {
    let gadgetId = record.gadgetId ?? this.impl.defaultGadgetId;
    let gadget = gadgetId === undefined ? undefined : this.impl.storage.gadgets.get(gadgetId);
    let head = gadget?.type === "gadget" ? gadget.commitId : undefined;
    let published = record.commitId;
    if (head === undefined || published === undefined || head === published) return false;
    let store = this.impl.gitStore;
    return await store.commitTree(head) !== await store.commitTree(published);
  }

  // The timestamp of the code exported into a blueprint: the exported commit's author date, or
  // for legacy (pre-git-storage) records the legacy log entry's, falling back to the metadata's
  // own last-updated time.
  async #blueprintCodeDate(record: BlueprintGadgetRecord): Promise<Date> {
    if (record.commitId !== undefined) {
      return (await this.impl.gitStore.readCommitLog(record.commitId, {depth: 1}))[0].timestamp;
    }
    if (record.codeVersion !== undefined) {
      let codeUpdate = this.impl.storage.code.get(record.codeVersion);
      if (codeUpdate) return codeUpdate.timestamp;
    }
    return record.metadata.lastUpdated;
  }

  async updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");

    if (options.title === undefined && options.description === undefined && !options.updateCode && !options.updateBindings && options.screenshot === undefined) {
      throw new Error("At least one update option must be provided.");
    }

    if (options.title !== undefined) {
      record.metadata.title = options.title;
    }
    if (options.description !== undefined) {
      record.metadata.description = options.description;
    }

    let pack: Uint8Array | undefined;
    if (options.updateCode || options.updateBindings) {
      // Re-collect binding metadata from the source gadget (validates annotations). Records
      // written before multi-gadget support carry no gadgetId; they export the default gadget.
      let gadgetId = this.impl.resolveGadgetId(record.gadgetId);
      record.metadata.bindings = this.impl.collectBindingMetadata(gadgetId);
      if (options.updateCode) {
        let commitId = await this.impl.assertPublishableCommit(
            this.impl.getGadgetRecord(gadgetId).commitId);
        pack = await this.impl.mintBlueprintRelease(record, commitId);
      }
    }

    let screenshot = options.screenshot === undefined
      ? undefined
      : options.screenshot === null ? null : validateBlueprintScreenshotUpload(options.screenshot);

    record.metadata.lastUpdated = new Date();

    await this.impl.propagateBlueprint(record, pack, screenshot);
  }

  async deleteBlueprint(blueprintId: string): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");

    try {
      await this.impl.deleteBlueprintPropagation(record);
    } catch (err) {
      // If deletion fails partway through, mark as dirty so the user can retry.
      record.dirty = true;
      this.impl.storage.blueprints.put(record);
      throw err;
    }
  }

  async retryBlueprintPublish(blueprintId: string): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");
    if (!record.dirty) return;  // nothing to retry

    if (record.releases === undefined) {
      // The record was last published before releases were commits, in a form that is no longer
      // written. Republishing its code gives it a release.
      throw new Error("This blueprint was last published in an older format. Republish its " +
          "code with updateBlueprint instead of retrying.");
    }

    // Propagating a dirty record re-sends the release that was being published, not the
    // current code.
    await this.impl.propagateBlueprint(record);
  }

  // --- Collaborator management ---
  //
  // The sharing/permission logic lives in SharingManager (./sharing). These methods handle only
  // the RPC-bound pieces (resolving profiles via User DOs) and delegate the rest.

  async listObserverRequirements(
      role: CollaboratorRole): Promise<ObserverBindingNeed[]> {
    return this.impl.listObserverRequirements(role);
  }

  async listCollaborators(): Promise<CollaboratorInfo[]> {
    return (await this.impl.getSharingManager()).listCollaborators();
  }

  async addCollaborator(username: string, role: CollaboratorRole, note?: string)
      : Promise<CollaboratorInfo | null> {
    // Look up the user DO to check if the account exists.
    let userDoId = this.impl.users.idFromName(username);
    let userDo = this.impl.users.get(userDoId);
    let profile = await userDo.whoamiIfExists();
    if (!profile) {
      return null;
    }

    return (await this.impl.getSharingManager()).addCollaborator({
      caller: this.#sharingCaller(),
      profile,
      role,
      note,
    });
  }

  async previewRemoveCollaborator(profileId: string): Promise<AffectedCollaborator[]> {
    return (await this.impl.getSharingManager())
        .previewRemoveCollaborator(this.#sharingCaller(), profileId);
  }

  async removeCollaborator(profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let affected = (await this.impl.getSharingManager())
        .removeCollaborator(this.#sharingCaller(), profileId, keepUsers);
    // Schedule the restart in the same synchronous step as the sharing mutation: the revoked
    // collaborator's live sessions must not outlive the cleanup below, which crosses gatekeeper
    // and User-DO round trips that can stall or hang. Only restart if someone actually lost
    // access or was downgraded (kept users are already excluded) -- a no-op removal, e.g.
    // severing a share-link edge nobody relied on, shouldn't disconnect everyone.
    if (affected.length > 0) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted to revoke access for a removed collaborator.");
    }
    // The reset's ~100ms delay gives the best-effort cleanup below a head start; whatever it cut
    // off self-heals (a leftover observer registration is lazily cleaned at exclusion time or by
    // a later open, a stale cached workspace listing just yields a denied open).
    // Tear down observer records for anyone who lost access (see tearDownLostObservers)...
    await this.impl.tearDownLostObservers(affected);
    // ...and likewise update or remove their cached workspace listing.
    await this.impl.refreshAffectedCollaboratorListings(affected);
    return affected;
  }

  async previewRevokeShareLink(linkId: string): Promise<AffectedCollaborator[]> {
    return (await this.impl.getSharingManager())
        .previewRevokeShareLink(this.#sharingCaller(), linkId);
  }

  async revokeShareLink(linkId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let affected = (await this.impl.getSharingManager())
        .revokeShareLink(this.#sharingCaller(), linkId, keepUsers);
    // Restart first, then best-effort cleanup, for the reasons given in removeCollaborator.
    if (affected.length > 0) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted to revoke access for a revoked share link.");
    }
    await this.impl.tearDownLostObservers(affected);
    await this.impl.refreshAffectedCollaboratorListings(affected);
    return affected;
  }

  // --- Share link management ---

  async createShareLink(role: CollaboratorRole, note?: string)
      : Promise<{ key: string; linkId: string }> {
    return (await this.impl.getSharingManager())
        .createShareLink({ caller: this.#sharingCaller(), role, note });
  }

  async newShareLinkKey(linkId: string): Promise<{ key: string }> {
    return (await this.impl.getSharingManager())
        .newShareLinkKey({ caller: this.#sharingCaller(), linkId });
  }

  async listShareLinks(): Promise<ShareLinkInfo[]> {
    let sharing = await this.impl.getSharingManager();

    // Collect all records synchronously to release the kv.list() iterator before any await
    // points below. Only one kv.list() iterator can be active at a time, and concurrent RPC
    // calls (e.g. listCollaborators) may start their own.
    let records = sharing.listShareLinkRecords();

    let result: ShareLinkInfo[] = [];
    // Cache profile lookups.
    let profileCache = new Map<string, AiChatAuthorInfo>();

    for (let record of records) {
      let createdBy = profileCache.get(record.createdBy);
      if (!createdBy) {
        // Check if the creator is the owner (requires an RPC to the owner's DO).
        let ownerProfileId = await this.impl.getOwnerProfileId();
        if (ownerProfileId === record.createdBy) {
          createdBy = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);
        }
        // Check if the creator is a collaborator (resolved locally).
        if (!createdBy) {
          createdBy = sharing.getCreatorProfile(record.createdBy);
        }
        // Fallback.
        if (!createdBy) {
          createdBy = { type: "user", id: record.createdBy, name: record.createdBy };
        }
        profileCache.set(record.createdBy, createdBy);
      }
      result.push({
        linkId: record.id,
        note: record.note,
        created: record.created,
        createdBy,
        role: record.role ?? "build",
      });
    }
    return result;
  }

  async updateShareLink(linkId: string, note?: string): Promise<void> {
    (await this.impl.getSharingManager())
        .updateShareLink(this.#sharingCaller(), linkId, note);
  }
}
