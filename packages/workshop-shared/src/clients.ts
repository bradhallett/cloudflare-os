// The per-workpiece client capabilities handed out by the Overseer: WorkpieceClient,
// GadgetClient (the gadget's own RPC surface), and GatekeeperClient. Re-exported from
// api.ts, the single import surface of the API.


import type { WorkpieceId } from "./api.js";
import type { BlueprintGadgetSummary, BlueprintScreenshotUpload } from "./blueprints.js";
import type { ResourceDescription } from "./gatekeeper.js";
import type { ApplyBlueprintResult, BlueprintBindingAnnotation, GadgetBindingInfo, GatekeeperCreationSpec } from "./workpieces.js";
import type { UiBundle } from "./workspace.js";
import type { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
/**
 * Common base interface for per-workpiece capabilities. Each workpiece type has its own
 * subinterface (GadgetClient, GatekeeperClient<T>) for type-specific operations; this base holds
 * the shared identity/lifecycle surface.
 */
export interface WorkpieceClient extends RpcTarget {
  /** Get the workpiece's ID, unique among all workpieces in the workspace (of any type). */
  getId(): Promise<WorkpieceId>;

  /**
   * Human-readable title, for display. For a gadget this is its user-renamable title; for a
   * gatekeeper it is the connected resource's title.
   */
  getTitle(): Promise<string>;

  /**
   * Change the workpiece's title.
   *
   * (Note gatekeeper titles are initially based on the title of the underlying resource, but this
   * method does not change the remote resource, only the display name used locally within this
   * workspace.)
   */
  setTitle(title: string): Promise<void>;

  /**
   * Permanently remove this workpiece from the workspace.
   *
   * For a gadget, this deletes its registry entry (including its binding map) and hooks and
   * clears its files; gatekeepers it bound survive, possibly no longer bound by any gadget. For
   * a gatekeeper, this destroys the connection itself -- distinct from merely unbinding it from
   * one gadget (GadgetClient.unbind()).
   */
  remove(): Promise<void>;
}

/** Describes a file export format supported by a Gadget. */
export type GadgetExportFormat = {
  /** Unique, non-empty identifier for this format. */
  id: string;

  /** User-facing label for the format. */
  label: string;

  /** Whether the Workshop captures a browser or invokes a server-side handler. */
  mode: "browser" | "server";

  /** Media type of the exported file. */
  contentType: string;

  /** File extension, including the leading dot. */
  fileExtension: string;

  /** Suggested download filename, including its extension. Defaults to the Gadget title plus fileExtension when unset. */
  fileName?: string;
};

/**
 * Capability representing one gadget workpiece within a workspace. Obtained from
 * Overseer.createGadget() or Overseer.getGadget(). Workspace-level concerns (code sync, chats,
 * sharing, actions, blueprint listing) stay on Overseer; this covers the per-gadget surface.
 */
export interface GadgetClient extends WorkpieceClient {
  /**
   * Get the gadget's deployed UI code, to be run inside an iframe sandbox.
   *
   * Returns null if the gadget has no deployed UI code (e.g. if it's new, or if it's just an AI
   * agent with no code).
   */
  getUiBundle(chatId?: number): Promise<UiBundle | null>;

  /**
   * Open an RPC interface to the gadget's server-side Durable Object facet. The frontend may pass
   * this stub into the gadget's iframe sandbox, so that the gadget UI can communicate with its
   * server side. It can also permit the coding agent to make direct calls.
   *
   * If `chatId` is specified, then the gadget will include changes currently proposed in the given
   * chat.
   *
   * The facet's shape is the gadget author's to declare, so the stub is deliberately `any`-typed
   * here: callers (and tests) pin it to their facet interface with an assertion at the call site.
   * A type parameter is the intended shape but is currently unimplementable: capnweb's `Stub<T>`
   * is a deferred conditional, so a `<T extends RpcCompatible<T>>(chatId?: number):
   * Promise<RpcStub<T>>` declaration fails TS2416 at every implementer (the implementation's
   * return collapses to `StubBase<unknown>` during signature comparison) — this was tried and
   * reverted, not assumed.
   */
  connectToGadget(chatId?: number): Promise<RpcStub<any>>;

  /**
   * Lists the Gadget's supported file export formats. If `chatId` is specified,
   * the formats are read from the code currently proposed in that chat.
   */
  getExportFormats(chatId?: number): Promise<GadgetExportFormat[]>;

  /**
   * Exports the format with the given ID. If `chatId` is specified, the export
   * uses changes currently proposed in that chat.
   */
  export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>;

  // --- Binding management ---
  //
  // A gadget's bindings are edges mapping a name (as it appears in the gadget worker's `env`) to
  // a target workpiece -- today always a gatekeeper. The same gatekeeper may be bound multiple
  // times in one gadget or by several gadgets, under independent names.

  /**
   * List this gadget's bindings.
   *
   * If `chatId` is specified, bindings which have been proposed but not yet accepted in the given
   * chat thread will be included.
   */
  listBindings(chatId?: number): Promise<GadgetBindingInfo[]>;

  /** Get the gatekeeper bound under the given name, or null if there is no such binding. */
  getBinding(name: string): Promise<GatekeeperClient<any> | null>;

  /**
   * Bind the given workpiece (a gatekeeper) into this gadget's `env` under `name`. Throws if the
   * name is invalid (see validateBindingName()), reserved, or already bound in this gadget
   * (including bound provisionally by another chat).
   *
   * If `chatId` is provided, the binding is treated like an edit made in the given chat -- it is
   * proposed, but someone needs to click "accept changes" (call `mergeChanges()`) to make it
   * final. Until then it exists only in the given chat.
   */
  bind(name: string, target: WorkpieceId, chatId?: number): Promise<void>;

  /**
   * Like bind(), but if the target isn't already bound in this gadget, choose a name based on the
   * resource's own suggestion (deduplicated against this gadget's existing binding names). If the
   * target is already bound, does nothing. Either way, returns the target's binding name.
   */
  bindWithSuggestedName(target: WorkpieceId, chatId?: number): Promise<string>;

  /**
   * Remove the binding with the given name. This only removes the edge from this gadget -- the
   * target gatekeeper itself survives (possibly no longer bound by any gadget); use
   * GatekeeperClient.remove() to destroy the connection itself.
   */
  unbind(name: string): Promise<void>;

  /**
   * Rename a binding while preserving its target and blueprint annotation. Throws if `oldName`
   * does not exist or `newName` is reserved or already bound in this gadget.
   */
  renameBinding(oldName: string, newName: string): Promise<void>;

  /**
   * Get the blueprint annotation for the named binding, if one has been set. Annotations live on
   * the binding edge, not on the target gatekeeper (see BlueprintBindingAnnotation).
   */
  getBlueprintAnnotation(name: string): Promise<BlueprintBindingAnnotation | null>;

  /** Set the blueprint annotation for the named binding. */
  setBlueprintAnnotation(name: string, annotation: BlueprintBindingAnnotation): Promise<void>;

  /**
   * Create a new blueprint from this gadget's current committed code.
   * `title` defaults to the gadget's title if omitted.
   *
   * The blueprint is always owned by the workspace owner, regardless of who calls this method.
   *
   * Steps: generate ID, snapshot code, collect binding metadata, store locally, propagate
   * to User DO + KV + R2. Maintenance of existing blueprints stays on Overseer (see
   * Overseer.updateBlueprint() etc.).
   */
  createBlueprint(title?: string, description?: string, screenshot?: BlueprintScreenshotUpload): Promise<BlueprintGadgetSummary>;

  /**
   * Propose merging the current release of a blueprint into this gadget: to take an update from
   * the blueprint the gadget follows, or to switch it to another. The proposal is recorded in a
   * new chat (see AiChatMessageBody.blueprintMerges), where it is previewed and then accepted
   * or discarded like any other proposed change. Nothing about the gadget changes until it is
   * accepted, including which blueprint it follows.
   *
   * The merge is three-way, against the newest version the gadget and the release have in
   * common. If they share no history that version has to be guessed, which is only done if
   * `allowUnrelated` is set (see ApplyBlueprintResult). Unless the release is already in the
   * gadget's history, the merge is written as a commit, which the new chat is pinned at.
   *
   * A proposal of kind "merge" starts an agent turn in the new chat, to resolve what conflicted
   * and to check that the two sets of changes work together. `modelId` is the model that runs
   * it: as for Overseer.newChat(), one of the IDs in the result of `listModels()`, or null for
   * no agent. No other proposal starts a turn.
   *
   * Throws if the blueprint does not exist, or if the gadget is still pending in a chat and so
   * has no committed code to merge into. Throws too, creating no chat, if the gadget and the
   * blueprint both changed a file and a version of it, or the merged text, is too large for a
   * file to hold; the error names the file. Making it smaller, or undoing the gadget's own
   * changes to it, lets the blueprint be applied.
   */
  applyBlueprint(blueprintId: string, options: {modelId: string | null, allowUnrelated?: boolean})
      : Promise<ApplyBlueprintResult>;
}

/**
 * Capability representing one gatekeeper (connection) workpiece. Note that binding-edge
 * operations -- binding names and blueprint annotations -- live on GadgetClient, since a
 * gatekeeper may be bound by several gadgets under different names.
 */
export interface GatekeeperClient<Session extends RpcCompatible<Session>> extends WorkpieceClient {
  /** Get the resource description, including the schema of its RPC interface. */
  describe(): Promise<ResourceDescription>;

  /**
   * Open a direct session to this gatekeeper. Particularly useful when using the AI agent to talk
   * to the resource directly.
   */
  openSession(): Promise<RpcStub<Session>>;

  /** Get the creation spec describing how this gatekeeper was originally created. */
  getCreationSpec(): Promise<GatekeeperCreationSpec>;

  // TODO: Get/set permissions.
}
