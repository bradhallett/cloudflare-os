import { RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { Overseer, GadgetMetadata, WorkpieceId, WorkpiecesSubscriber, GadgetClient, GatekeeperClient, ActionsSubscriber, ActionHistoryFilter, ActionHistoryPage, CodeChangeSubmission, CommitInfo, FileAtCommit, TreeNode, MergeChangesResult, AiChatMetadata, AiChatMessage, AiChatHistoryPage, AiChatSubscriber, AiChatAuthorInfo, AgentSpawnerConfig, ConsoleLogSubscriber, CapsuleSpecifier, CollaboratorInfo, CollaboratorRole, AffectedCollaborator, ShareLinkInfo, ObserverBindingNeed, MessageFormatRef, BotSelection, BlueprintGadgetSummary, BlueprintScreenshotUpload, ChatAttachmentHandle, BoundHookInfo, PreApprovableAction, PresenceSubscriber, SlashCommandChoice, SlashCommandRequest } from "@gadgets/workshop-shared/api";
import { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { UserDurableObject } from "./user";
import { retryOnDoReset } from "./do-retry";
import { OverseerImpl } from "./overseer-impl";
import { joinSessionPresence } from "./overseer-client";
import { UseGadgetClientInterface } from "./overseer-gadget-client";

// Restricted capability handed to "use"-role collaborators. It implements the full `Overseer`
// interface but permits only the handful of methods needed to render and interact with the
// gadgets' deployed UIs: getMetadata() (restricted to id/title/owner), a restricted
// subscribeToMetadata(), subscribeToPresence(), subscribeToWorkpieces(), and getGadget()
// (returning a restricted, mainline-only UseGadgetClientInterface). Presence includes active
// viewers' names, profile IDs, and roles. Every other
// method throws "Unauthorized", with a few exceptions: subscribeToConsoleLogs() and
// subscribeToActions() return inert subscriptions (they never deliver data), and
// listActions() returns an empty terminal page, rather than denying.
// The editor calls all of these speculatively from its top-level hooks, before it has switched to
// the use-only view; an inert result lets those calls resolve quietly instead of surfacing
// as spurious client-side errors, while still revealing nothing to the "use" collaborator.
//
// Default-deny is enforced at compile time: because this class `implements Overseer`, adding any
// new method to the interface will fail to compile here until a developer consciously decides
// whether "use" callers may invoke it.
@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class UseOverseerInterface extends RpcTarget implements Overseer {
  constructor(private impl: OverseerImpl,
              private clientProfileId: string,
              private clientUserId: string,
              private notifyClosed: NativeRpcStub<() => void>) {
    super();
    this.#leaveSession = this.impl.joinSession("use");
    this.#leavePresence = joinSessionPresence(
        this.impl, this.clientProfileId, "use",
        () => retryOnDoReset(() => this.#clientUser.whoami(), this.impl.logger));
    this.#leaveOutputsFanout = this.impl.joinOutputsFanout(this.clientUserId);
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
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

  // Throws "Unauthorized" for any method not available to "use" collaborators.
  #deny(): never {
    throw new Error("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  }

  // Count a subscription handle toward #hasCollaboratorSession for its own lifetime, exactly as
  // OverseerClientInterface.#subscriptionLease does for "build" sessions -- a client can dispose
  // this interface while retaining the subscription. Applied uniformly, including to the inert
  // subscriptions: every export minted into a collaborator session counts, rather than
  // per-subscription reasoning about which could carry data.
  #subscriptionLease(subscription: RpcStub<{}>): RpcStub<{}> {
    let leave = this.impl.joinSession("use");
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        leave();
        subscription[Symbol.dispose]();
      }
    });
  }

  // --- Allowed methods ---

  async getMetadata(): Promise<GadgetMetadata> {
    return {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      owner: await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger),
      role: "use",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
  }

  async subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>> {
    callback = callback.dup();  // keep stub after return

    // Fetch owner info first so the title read and subscription below have no await in between.
    let owner = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);

    let metadata: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      owner,
      role: "use",
      defaultGadgetId: this.impl.defaultGadgetId,
    };

    let titleSubscriber = {
      update(value: string) {
        metadata.title = value;
        callback(metadata).catch(unsubscribe);
      }
    };

    let unsubscribe = () => {
      this.impl.storage.title.unsubscribe(titleSubscriber);
      callback[Symbol.dispose]();
    };

    this.impl.storage.title.subscribe(titleSubscriber);

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

  /**
   * The gadget list is visible to "use" collaborators (v1 shares the whole workspace), and each
   * gadget is exposed through a restricted UseGadgetClientInterface that only permits rendering
   * its deployed UI. Gadgets still provisional to a chat are withheld: they are proposals within
   * the owner's chats, and their mainline code is empty anyway. Worktrees are withheld likewise,
   * being chat-private (and readable only through the build-only commit reads).
   */
  async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.subscribeToWorkpieces(subscriber, false));
  }

  async getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    if (this.impl.getGadgetRecord(id).pending) {  // also validates it exists
      throw new Error(`No such gadget: ${id}`);
    }
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new UseGadgetClientInterface(this.impl, id, this.clientUserId);
  }

  // --- Denied methods (build-only) ---

  async setTitle(_title: string): Promise<void> { this.#deny(); }
  async deleteSelf(): Promise<void> { this.#deny(); }
  async createGadget(_title: string): Promise<RpcStub<GadgetClient>> { this.#deny(); }
  async submitCodeChange(_chatId: number, _submission: CodeChangeSubmission)
      : Promise<{generation: number, revision: number}> {
    this.#deny();
  }
  async listTree(_commitId: string): Promise<TreeNode[]> { this.#deny(); }
  async readFilesAtCommit(_commitId: string, _paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    this.#deny();
  }
  async listChangedPaths(_fromCommit: string, _toCommit: string): Promise<string[]> {
    this.#deny();
  }
  async getCommitLog(_fromCommit: string, _depth?: number): Promise<CommitInfo[]> {
    this.#deny();
  }

  async updateChatFromMainline(_chatId: number): Promise<{conflictPaths: string[]}> {
    this.#deny();
  }
  async listPreApprovableActions(): Promise<PreApprovableAction[]> { this.#deny(); }
  async getGatekeeperById(_id: number): Promise<GatekeeperClient<any>> { this.#deny(); }
  async newGatekeeper(_accountId: number, _resourceUrl: string)
      : Promise<GatekeeperClient<any> | null> { this.#deny(); }
  async newAiModelGatekeeper(_modelId: string): Promise<GatekeeperClient<any>> { this.#deny(); }
  async newAgentSpawnerGatekeeper(_config: AgentSpawnerConfig): Promise<GatekeeperClient<any>> {
    this.#deny();
  }
  /**
   * Pending actions are queried eagerly for the badge; resolved history is demand-loaded. Return
   * an empty terminal page so this speculative read does not fail for "use" collaborators.
   */
  async listActions(_options?: {beforeId?: number, filter?: ActionHistoryFilter})
      : Promise<ActionHistoryPage> {
    return {entries: []};
  }
  async approveAction(_id: number): Promise<void> { this.#deny(); }
  async rejectAction(_id: number): Promise<void> { this.#deny(); }
  async listHooks(): Promise<BoundHookInfo[]> { this.#deny(); }
  async enableHook(_id: number): Promise<void> { this.#deny(); }
  async disableHook(_id: number): Promise<void> { this.#deny(); }
  async deleteHook(_id: number): Promise<void> { this.#deny(); }
  async setAutoApprovedActionKind(_gatekeeperId: WorkpieceId, _actionKind: ActionKind)
      : Promise<void> { this.#deny(); }
  async removeAutoApprovedActionKind(_gatekeeperId: WorkpieceId, _tag: string): Promise<void> { this.#deny(); }
  async listAutoApprovedActionKinds()
      : Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>> {
    this.#deny();
  }
  async acceptConnectionRequest(_requestId: string, _result: {gatekeeperId: number}): Promise<void> { this.#deny(); }
  async denyConnectionRequest(_requestId: string): Promise<void>  { this.#deny(); }
  async subscribeToActions(
      subscriber: RpcStub<ActionsSubscriber>, _startAfter?: Date): Promise<RpcStub<{}>> {
    // Inert: "use" sessions have no visibility into the action log. Signal a settled, empty log
    // (so the client doesn't sit in a perpetual "loading" state) and never deliver entries.
    let sub = subscriber.dup();
    sub.ready().catch(() => {});
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        sub[Symbol.dispose]();
      }
    }));
  }
  async listChats(): Promise<AiChatMetadata[]> { this.#deny(); }
  async listModels(): Promise<AiChatAuthorInfo[]> { this.#deny(); }
  async getChatHistory(_chatId: number, _beforeSequence?: number): Promise<AiChatHistoryPage> {
    this.#deny();
  }
  async getChatMessage(_chatId: number, _sequence: number): Promise<AiChatMessage | undefined> { this.#deny(); }
  async listSlashCommands(): Promise<SlashCommandChoice[]> { this.#deny(); }
  async subscribeToChat(
      _subscriber: RpcStub<AiChatSubscriber>, _startAfter?: Date): Promise<RpcStub<{}>> {
    this.#deny();
  }
  async viewChat(_chatId: number): Promise<RpcStub<{}>> { this.#deny(); }
  async newChat(_initialMessage: string | SlashCommandRequest, _modelId: string | null,
                 _capsules?: CapsuleSpecifier[], _attachments?: ChatAttachmentHandle[],
                 _formats?: MessageFormatRef[], _bot?: BotSelection): Promise<number> {
    this.#deny();
  }
  async sendChatMessage(_chatId: number, _message: string | SlashCommandRequest,
                        _modelId: string | null,
                        _capsules?: CapsuleSpecifier[], _attachments?: ChatAttachmentHandle[],
                        _formats?: MessageFormatRef[],
                        _bot?: BotSelection | "none"): Promise<void> {
    this.#deny();
  }
  async uploadBlob(_content: Uint8Array): Promise<string> { this.#deny(); }
  async getChatAttachmentContent(_chatId: number, _id: string): Promise<Uint8Array> { this.#deny(); }
  async setChatTitle(_chatId: number, _title: string): Promise<void> { this.#deny(); }
  async mergeChanges(_chatId: number): Promise<MergeChangesResult> {
    this.#deny();
  }
  async revertChanges(_chatId: number, _revertFrom: number): Promise<void> { this.#deny(); }
  async finalizeChatDraft(_chatId: number): Promise<void> { this.#deny(); }
  async discardChatDraftChanges(_chatId: number): Promise<void> { this.#deny(); }
  async deleteChat(_chatId: number): Promise<void> { this.#deny(); }
  async stopAgent(_chatId: number): Promise<void> { this.#deny(); }
  async retryAgent(_chatId: number, _modelId: string): Promise<void> { this.#deny(); }
  async subscribeToConsoleLogs(_subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>> {
    // Inert: "use" sessions never receive console logs. The inbound subscriber stub is left
    // undup'd, so the RPC system disposes it when this call returns.
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {}
    }));
  }
  async listBlueprints(): Promise<BlueprintGadgetSummary[]> { this.#deny(); }
  async updateBlueprint(_blueprintId: string, _options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void> { this.#deny(); }
  async deleteBlueprint(_blueprintId: string): Promise<void> { this.#deny(); }
  async retryBlueprintPublish(_blueprintId: string): Promise<void> { this.#deny(); }
  async listObserverRequirements(
      _role: CollaboratorRole): Promise<ObserverBindingNeed[]> { this.#deny(); }
  async listCollaborators(): Promise<CollaboratorInfo[]> { this.#deny(); }
  async addCollaborator(_username: string, _role: CollaboratorRole, _note?: string)
      : Promise<CollaboratorInfo | null> { this.#deny(); }
  async removeCollaborator(_profileId: string, _keepUsers: string[])
      : Promise<AffectedCollaborator[]> { this.#deny(); }
  async previewRemoveCollaborator(_profileId: string): Promise<AffectedCollaborator[]> {
    this.#deny();
  }
  async createShareLink(_role: CollaboratorRole, _note?: string)
      : Promise<{ key: string; linkId: string }> {
    this.#deny();
  }
  async newShareLinkKey(_linkId: string): Promise<{ key: string }> { this.#deny(); }
  async listShareLinks(): Promise<ShareLinkInfo[]> { this.#deny(); }
  async updateShareLink(_linkId: string, _note?: string): Promise<void> { this.#deny(); }
  async revokeShareLink(_linkId: string, _keepUsers: string[]): Promise<AffectedCollaborator[]> {
    this.#deny();
  }
  async previewRevokeShareLink(_linkId: string): Promise<AffectedCollaborator[]> { this.#deny(); }
  async transferToOrg(_orgId: string): Promise<void> { this.#deny(); }
}
