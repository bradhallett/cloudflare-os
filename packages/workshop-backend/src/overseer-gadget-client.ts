import { RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { UiBundle, WorkpieceId, GadgetClient, GadgetBindingInfo, GatekeeperClient, BlueprintBindingAnnotation, BlueprintMetadata, ApplyBlueprintResult, BlueprintGadgetSummary, BlueprintScreenshotUpload, blueprintScreenshotUrl } from "@gadgets/workshop-shared/api";
import type { BindingRecord, BlueprintGadgetRecord, GadgetRecord } from "./storage-schema/overseer-storage";
import { UserDurableObject } from "./user";
import { retryOnDoReset } from "./do-retry";
import type { GadgetExportFormat } from "@gadgets/workshop-shared/api";
import { OverseerImpl } from "./overseer-impl";
import type { SessionKind } from "./overseer-support";
import { GatekeeperClientImpl } from "./overseer-gatekeeper-client";
import { defaultBlueprintBindingTitle, validateBlueprintScreenshotUpload } from "./overseer-binding-info";

// Capability representing one gadget workpiece, handed to "build"-role sessions via
// Overseer.createGadget()/getGadget().
//
// `joinedAs` counts this capability toward #hasCollaboratorSession for its lifetime (passed for
// collaborator mints, omitted for the owner's and for internal construction): a client can dispose
// the parent interface while retaining this one, and a retained capability that escaped the count
// would let a scope widening find no session to sever.
@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class GadgetClientImpl extends RpcTarget implements GadgetClient {
  #leaveSession?: () => void;

  constructor(private impl: OverseerImpl, private id: WorkpieceId,
      private clientUserId: string, private joinedAs?: SessionKind) {
    super();
    if (joinedAs) this.#leaveSession = impl.joinSession(joinedAs);
  }

  [Symbol.dispose]() {
    this.#leaveSession?.();
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)));
  }

  async getId(): Promise<WorkpieceId> {
    return this.id;
  }

  async getTitle(): Promise<string> {
    return this.impl.getGadgetRecord(this.id).title;
  }

  async setTitle(title: string): Promise<void> {
    let record = this.impl.getGadgetRecord(this.id);
    record.title = title;
    this.impl.storage.gadgets.put(record);
  }

  async remove(): Promise<void> {
    return this.impl.removeWorkpiece(this.id);
  }

  async getUiBundle(chatId?: number): Promise<UiBundle | null> {
    return this.impl.getGadgetUiBundle(this.id, chatId);
  }

  async connectToGadget(chatId?: number): Promise<RpcStub<any>> {
    this.impl.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: this.#clientUser.id.toString(),
      chat_id: chatId,
      interaction_type: "gadget_ui_connected",
    });
    // The facet stub counts exactly as this capability does (joinedAs): it can outlive this
    // object, and it is the very stub a hook-enable widening's data flows through.
    return this.impl.getGadgetFacet(this.id, chatId, this.joinedAs);
  }

  async getExportFormats(chatId?: number): Promise<GadgetExportFormat[]> {
    return this.impl.getGadgetExportFormats(this.id, chatId);
  }

  async export(formatId: string, chatId?: number): Promise<ReadableStream<Uint8Array>> {
    return this.impl.exportGadget(this.id, formatId, chatId);
  }

  async listBindings(chatId?: number): Promise<GadgetBindingInfo[]> {
    let record = this.impl.getGadgetRecord(this.id);
    // Edges pending in other chats are those chats' unaccepted proposals, so they aren't listed.
    return this.impl.visibleBindings(record, chatId).map(([name, edge]) => {
      let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
      return {
        name,
        target: edge.target,
        resourceTitle: gatekeeper?.resourceTitle || "(title unavailable)",
        vendorId: gatekeeper?.creationSpec?.type === "gatekeeper"
            ? gatekeeper.creationSpec.vendorId
            : undefined,
        ...(edge.pending ? {chatId: edge.pending.chatId} : {}),
      };
    });
  }

  async getBinding(name: string): Promise<GatekeeperClient<any> | null> {
    let record = this.impl.getGadgetRecord(this.id);
    let edge = record.bindings[name];
    if (!edge || edge.pending || !this.impl.storage.gatekeepers.get(edge.target)) return null;
    // The child capability counts exactly as this one does: it can outlive this object.
    return new GatekeeperClientImpl(
        this.impl, edge.target, await this.impl.getGatekeeperFacet(edge.target),
        this.clientUserId, this.joinedAs);
  }

  async bind(name: string, target: WorkpieceId, chatId?: number): Promise<void> {
    if (chatId === undefined) {
      this.impl.bindWorkpiece(this.id, name, target);
      return;
    }

    // Binding with a chat open is provisional to that chat, like code edits: write the pending
    // edge and the "changes" message that records (and sequence-stamps) it in one synchronous
    // step, so this path has no crash window (mirroring user-initiated gadget creation).
    if (!this.impl.storage.chatMeta.get(chatId)) {
      throw new Error(`No such chat: ${chatId}`);
    }
    let author = await retryOnDoReset(() => this.#clientUser.whoami(), this.impl.logger);
    this.impl.bindWorkpiece(this.id, name, target, chatId);
    this.impl.addChatMessages(chatId, author, [{
      type: "changes",
      addedBindings: [{gadgetId: this.id, name, target}],
    }]);
  }

  async bindWithSuggestedName(target: WorkpieceId, chatId?: number): Promise<string> {
    let record = this.impl.getGadgetRecord(this.id);
    let existing = this.impl.visibleBindings(record, chatId)
        .find(([, edge]) => edge.target === target);
    if (existing) {
      return existing[0];
    }

    // The target is client-supplied, so refuse one blocked pending a scope-widening restart
    // before describing it (metadata-only, but every client-reachable route is gated).
    let facet = await this.impl.getGatekeeperFacet(target);
    this.impl.assertGatekeeperUsable(target);
    let description = await facet.describe();
    let suggestedName = description.suggestedBindingName;
    let i = 1;
    // Re-read the record after the describe() await, in case bindings changed meanwhile. Dedupe
    // against ALL edges, including other chats' pending ones (which occupy their names).
    record = this.impl.getGadgetRecord(this.id);
    while (record.bindings[suggestedName] !== undefined) {
      suggestedName = `${description.suggestedBindingName}_${++i}`;
    }
    await this.bind(suggestedName, target, chatId);
    return suggestedName;
  }

  async unbind(name: string): Promise<void> {
    this.impl.unbindWorkpiece(this.id, name);
  }

  async renameBinding(oldName: string, newName: string): Promise<void> {
    this.impl.renameBinding(this.id, oldName, newName);
  }

  #getBindingEdge(name: string): {record: GadgetRecord, edge: BindingRecord} {
    let record = this.impl.getGadgetRecord(this.id);
    let edge = record.bindings[name];
    if (!edge) throw new Error(`No such binding: ${name}`);
    return {record, edge};
  }

  async getBlueprintAnnotation(name: string): Promise<BlueprintBindingAnnotation | null> {
    let {edge} = this.#getBindingEdge(name);
    let annotation = edge.blueprintAnnotation;
    if (!annotation) return null;
    let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
    return {
      title: annotation.title ||
          (gatekeeper ? defaultBlueprintBindingTitle(gatekeeper, name) : name),
      description: annotation.description ?? "",
      suggestValue: annotation.suggestValue,
    };
  }

  async setBlueprintAnnotation(name: string, annotation: BlueprintBindingAnnotation)
      : Promise<void> {
    let {record, edge} = this.#getBindingEdge(name);
    let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
    edge.blueprintAnnotation = {
      title: annotation.title.trim() ||
          (gatekeeper ? defaultBlueprintBindingTitle(gatekeeper, name) : name),
      description: annotation.description,
      suggestValue: annotation.suggestValue,
    };
    this.impl.storage.gadgets.put(record);
  }

  async createBlueprint(title?: string, description?: string,
                        screenshotUpload?: BlueprintScreenshotUpload)
      : Promise<BlueprintGadgetSummary> {
    if (!this.impl.ownerId) throw new Error("Workspace not initialized.");

    // NOTE: It is INTENTIONAL that collaborators can publish blueprints on behalf of the owner.
    //   We may in the future create different collaborator permission levels, in which case we'd
    //   need an auth check here and the following methods.

    let gadget = this.impl.getGadgetRecord(this.id);
    if (gadget.pending) {
      // A provisional gadget's files live only in its chat's proposed changes; snapshotting its
      // (empty) mainline code would produce a useless blueprint.
      throw new Error("This gadget is a provisional creation in a chat. Accept the chat's " +
          "changes before creating a blueprint from it.");
    }

    // Generate 128-bit random ID as hex.
    let idBytes = new Uint8Array(16);
    crypto.getRandomValues(idBytes);
    let id = idBytes.toHex();

    // Collect binding metadata (validates all annotations are configured).
    let bindings = this.impl.collectBindingMetadata(this.id);

    // Get gadget owner's profile for the author field.
    let owner = this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId));
    let ownerProfile = await owner.whoami();

    // The blueprint exports the gadget's committed code, keyed by its head commit. (Re-read the
    // record after the awaits above so the head is current.) A blueprint of a code-less gadget
    // would be useless, so refuse rather than publish an empty archive.
    let commitId = await this.impl.assertPublishableCommit(
        this.impl.getGadgetRecord(this.id).commitId);
    let now = new Date();

    let metadata: BlueprintMetadata = {
      title: title || gadget.title,
      description: description || "",
      author: ownerProfile,
      created: now,
      version: 0,  // counts releases; the first is minted below
      lastUpdated: now,
      bindings,
    };

    // Republishing preserves the format: a blueprint made from a Document still produces
    // Documents.
    if (gadget.output) {
      metadata.output = gadget.output;
    }

    let record: BlueprintGadgetRecord = {
      id,
      metadata,
      gadgetId: this.id,
    };

    let screenshot = screenshotUpload ? validateBlueprintScreenshotUpload(screenshotUpload) : undefined;

    // Mint the first release of the committed code and propagate to User DO, KV, R2.
    let pack = await this.impl.mintBlueprintRelease(record, commitId);
    await this.impl.propagateBlueprint(record, pack, screenshot);

    this.impl.recordGadgetAnalytics({
      event_name: "blueprint_created",
      user_id: this.#clientUser.id.toString(),
      blueprint_id: id,
    });

    // Derive codeVersionDate from the exported commit.
    let codeVersionDate =
        (await this.impl.gitStore.readCommitLog(commitId, {depth: 1}))[0].timestamp;

    return {
      id,
      title: metadata.title,
      description: metadata.description,
      version: metadata.version,
      codeVersionDate,
      screenshotUrl: blueprintScreenshotUrl(id, metadata),
      dirty: record.dirty,
    };
  }

  async applyBlueprint(blueprintId: string,
                       options: {modelId: string | null, allowUnrelated?: boolean})
      : Promise<ApplyBlueprintResult> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(options.modelId), this.impl.logger);
    return await this.impl.applyBlueprint(
        this.id, blueprintId, options, userMeta, this.clientUserId);
  }
}

// Restricted GadgetClient handed to "use"-role collaborators: it permits only what is needed to
// render and interact with the gadget's deployed UI, mainline-only. Like UseOverseerInterface,
// `implements GadgetClient` enforces default-deny at compile time: any new GadgetClient method
// fails to compile here until a developer decides whether "use" callers may invoke it.
@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class UseGadgetClientInterface extends RpcTarget implements GadgetClient {
  // Only ever minted for "use" collaborators, so it always counts toward #hasCollaboratorSession:
  // a client can dispose their UseOverseerInterface while retaining this, and a retained
  // capability that escaped the count would let a scope widening find no session to sever.
  #leaveSession: () => void;

  constructor(private impl: OverseerImpl, private id: WorkpieceId,
      private clientUserId: string) {
    super();
    this.#leaveSession = impl.joinSession("use");
  }

  [Symbol.dispose]() {
    this.#leaveSession();
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)));
  }

  #deny(): never {
    throw new Error("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  }

  // --- Allowed methods ---

  async getId(): Promise<WorkpieceId> {
    return this.id;
  }

  async getTitle(): Promise<string> {
    return this.impl.getGadgetRecord(this.id).title;
  }

  async getUiBundle(chatId?: number): Promise<UiBundle | null> {
    if (chatId !== undefined) {
      this.#deny();
    }
    return this.impl.getGadgetUiBundle(this.id);
  }

  async connectToGadget(chatId?: number): Promise<RpcStub<any>> {
    if (chatId !== undefined) {
      this.#deny();
    }

    this.impl.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: this.#clientUser.id.toString(),
      interaction_type: "gadget_ui_connected",
    });
    // The facet stub counts as a "use" session for its own lifetime, like this interface: it can
    // outlive this object, and it is the very stub a hook-enable widening's data flows through.
    return this.impl.getGadgetFacet(this.id, undefined, "use");
  }

  async getExportFormats(chatId?: number): Promise<GadgetExportFormat[]> {
    if (chatId !== undefined) this.#deny();
    return this.impl.getGadgetExportFormats(this.id);
  }

  async export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>> {
    if (chatId !== undefined) this.#deny();
    return this.impl.exportGadget(this.id, id);
  }

  // --- Denied methods (build-only) ---

  async setTitle(_title: string): Promise<void> { this.#deny(); }
  async remove(): Promise<void> { this.#deny(); }
  async listBindings(): Promise<GadgetBindingInfo[]> { this.#deny(); }
  async getBinding(_name: string): Promise<GatekeeperClient<any> | null> { this.#deny(); }
  async bind(_name: string, _target: WorkpieceId): Promise<void> { this.#deny(); }
  async bindWithSuggestedName(_target: WorkpieceId): Promise<string> { this.#deny(); }
  async unbind(_name: string): Promise<void> { this.#deny(); }
  async renameBinding(_oldName: string, _newName: string): Promise<void> { this.#deny(); }
  async getBlueprintAnnotation(_name: string): Promise<BlueprintBindingAnnotation | null> {
    this.#deny();
  }
  async setBlueprintAnnotation(_name: string, _annotation: BlueprintBindingAnnotation)
      : Promise<void> { this.#deny(); }
  async createBlueprint(_title?: string, _description?: string,
                        _screenshot?: BlueprintScreenshotUpload): Promise<BlueprintGadgetSummary> {
    this.#deny();
  }
  async applyBlueprint(_blueprintId: string,
                       _options: {modelId: string | null, allowUnrelated?: boolean})
      : Promise<ApplyBlueprintResult> {
    this.#deny();
  }
}
