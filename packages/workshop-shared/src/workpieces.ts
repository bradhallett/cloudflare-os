// The workpiece vocabulary: workpiece/gadget/worktree summaries, gadget upstreams,
// blueprint merge proposals and apply results, workpiece subscriptions, gadget bindings,
// pre-approvable actions, gatekeeper creation specs, and blueprint-binding annotations.
// Re-exported from api.ts, the single import surface of the API.


import type { WorkpieceId } from "./api.js";
import type { ActionKind } from "./gatekeeper.js";
import type { ModelKind } from "./models.js";
import type { AgentSpawnerConfig, BlueprintOutput } from "./workspace.js";
/**
 * Summary of one workpiece, delivered via Overseer.subscribeToWorkpieces(), discriminated by
 * `type`. Gadgets and worktrees are published (gatekeeper workpieces -- chat capsules, ambient
 * singletons, connections -- are not listed). Worktrees are published only to subscriptions that
 * include pending workpieces (build role): like a pending gadget, a worktree belongs to one chat
 * (its `chatId` is always set) and the UI shows it only while that chat is selected.
 */
export type WorkpieceSummary = GadgetSummary | WorktreeSummary;

/** The WorkpieceSummary of a gadget: an app built from code, with a committed mainline head. */
export type GadgetSummary = {
  id: WorkpieceId;
  type: "gadget";

  /** Display title: the gadget's user-renamable title. */
  title: string;

  /**
   * The format this workpiece was built as, inherited from the blueprint it was instantiated
   * from. Absent means a generic app. The UI names and draws the workpiece from this.
   */
  output?: BlueprintOutput;

  /**
   * The gadget's head commit (40-hex hash) in the workspace's git object store -- i.e. its
   * committed mainline code, readable via Overseer.listTree() / readFilesAtCommit(). Advances
   * when a chat's changes are accepted; subscribeToWorkpieces() delivers a fresh entry()
   * whenever it does. Absent only while the gadget is still pending in a chat (see `chatId`):
   * every permanent gadget has a head, even before it has any code (an empty initial commit),
   * so a chat's first edit always has a commit to pin (see ChatGadgetPin).
   */
  commitId?: string;

  /**
   * Where this gadget's code came from: the blueprint it follows, or that it was built from
   * scratch (see GadgetUpstream). Absent if that is not known, as for a gadget made before it
   * was recorded. Delivered only to subscribers with the "build" role: a blueprint id is a share
   * link to the blueprint's code, which a "use" collaborator cannot otherwise read.
   */
  upstream?: GadgetUpstream;

  /**
   * If present, this workpiece exists only in the context of the given chat. The UI should display
   * it only while the given chat is open.
   *
   * For gadgets, this means the gadget is still provisional: it becomes permanent when the user
   * accepts the chat's changes through its creation message, and is deleted if those changes are
   * reverted (or the chat is deleted).
   */
  chatId?: number;
};

/**
 * The blueprint a gadget follows: the one it takes updates from, and how much of it the gadget
 * already has. An update is available when the blueprint names a current release
 * (`BlueprintMetadata.commitId`, from `PublicApi.getBlueprint()`) other than a known `commitId`.
 *
 * A gadget built from scratch in its workspace follows no blueprint, and its upstream says so
 * by naming none. That differs from a gadget with no upstream at all, whose origin is unknown.
 */
export type GadgetUpstream = {
  /**
   * The blueprint's id. Absent if the gadget was built from scratch: there is then no blueprint
   * to offer it updates from, and no `commitId` either. GadgetClient.applyBlueprint() treats
   * such a gadget like one of unknown origin, and gives it a blueprint to follow if its
   * proposal is accepted.
   */
  blueprintId?: string;

  /**
   * The release of that blueprint the gadget most recently merged: a release commit, and an
   * ancestor of the gadget's head. For a blueprint stored before releases were commits, it is
   * the commit that everyone who reads that content derives from its files.
   *
   * Absent if the gadget was created from the blueprint before gadgets recorded the release
   * they took. Which release that was is then unknown: whether an update is available cannot
   * be told, and applying the blueprint merges over a guessed base (see
   * BlueprintMerge.unverifiedBase), as for a gadget that follows no blueprint. Accepting that
   * proposal records the release.
   */
  commitId?: string;
};

/**
 * A proposal to merge a release of a blueprint into a gadget (see
 * AiChatMessageBody.blueprintMerges). It records everything about the proposal as it was made,
 * so describing it needs no second look at a blueprint that may have been republished since.
 */
export type BlueprintMerge = {
  /** The gadget the release is merged into. */
  gadgetId: WorkpieceId;

  /** The blueprint, which the gadget follows once the proposal is accepted. */
  blueprintId: string;

  /** The blueprint's title at this release. */
  title: string;

  /** The blueprint's version counter at this release (`BlueprintMetadata.version`). */
  version: number;

  /** The release: the commit that the gadget's history gains as a parent, if it lacks it. */
  commitId: string;

  /**
   * What the proposal does to the gadget's files, as the result of the merge decides it:
   * - "follow": nothing. Either the release is already in the gadget's history, or the gadget
   *   already has every change the release made since the base.
   * - "fastForward": they become the release's exactly. The gadget had no changes of its own
   *   since the base, or was created from the release.
   * - "merge": the gadget and the blueprint both changed files since the base, and the two
   *   sets of changes were merged, three ways. A merge that conflicted is one even if no file
   *   changes: a file the gadget changed and the release deleted is kept, but whether it
   *   should stay is still to be decided.
   */
  kind: "follow" | "fastForward" | "merge";

  /**
   * The commit the merge took as the version the gadget and the release have in common. Absent
   * if there was nothing to merge: the release was already in the gadget's history, or the
   * gadget was created from it.
   */
  baseCommit?: string;

  /**
   * The files whose merge was not clean, as paths within the gadget, in sorted order. Each
   * holds inline conflict markers, or for a file one side deleted and the other changed, the
   * changed content with no markers (as for `mainlineMerge`). Empty unless `kind` is "merge".
   */
  conflictPaths: string[];

  /**
   * Present if the gadget and the release share no history, so that `baseCommit` is a guess at
   * what the gadget was built from. A change the gadget's owner made that the guess happens to
   * include looks like something the blueprint removed, and is undone with no conflict
   * reported.
   */
  unverifiedBase?: true;

  /**
   * The bindings the release declares that the gadget had none named for, by binding name.
   * Absent if there were none. A binding that exists only to feed an agent spawner
   * (`spawnerOnly`) has no name in the gadget to look for, so it is listed only when a missing
   * agent-spawner binding's agents get it.
   */
  missingBindings?: Record<string, BlueprintBinding>;
};

/**
 * One gadget's part of an update from mainline (see AiChatMessageBody.mainlineMerge): the three
 * sides of its merge, as commits, and what did not merge cleanly. The other two sides are on
 * the message's pin declaration for the gadget: its `mergedCommit` is the head that was
 * merged, and its `baseCommit` the merge commit, whose parents are that head and
 * `chatCommit`. Where the chat had nothing of its own to merge, no merge commit was written,
 * and the declaration's `baseCommit` is the head itself.
 */
export type MainlineMergeGadget = {
  /** The pinned gadget that was brought up to date. */
  gadgetId: WorkpieceId;

  /**
   * The base of the merge: the mainline commit the chat had last merged for this gadget, which
   * is the pin's ChatGadgetPinState.mergedCommit as it was before the update. A revert of the
   * update puts the pin's `mergedCommit` back to this.
   */
  baseCommit: string;

  /**
   * A commit of the chat's files for the gadget as they were before the update. Its parent is
   * the pin's `baseCommit` as it was then, the commit the chat's changes were made on; where the
   * files were that commit's own, it is that commit.
   */
  chatCommit: string;

  /**
   * The files whose merge was not clean, as paths within the gadget, in sorted order (see
   * BlueprintMerge.conflictPaths).
   */
  conflictPaths: string[];
};

/** Result of GadgetClient.applyBlueprint(). */
export type ApplyBlueprintResult = {
  /** A new chat holds the proposal, to preview and then accept or discard. */
  outcome: "proposed";

  /** The new chat. */
  chatId: number;
} | {
  /** The gadget already follows this blueprint at its current release. Nothing was proposed. */
  outcome: "upToDate";
} | {
  /**
   * The gadget and the blueprint share no history, and the caller did not allow for that.
   * Nothing was proposed. Calling again with `allowUnrelated` proposes a merge over a guessed
   * base (see BlueprintMerge.unverifiedBase), which the user should be warned of first.
   */
  outcome: "unrelated";
} | {
  /**
   * The gadget and the blueprint share a version, but its files are not available to merge
   * against. Nothing was proposed.
   */
  outcome: "baseUnavailable";
};

/**
 * The WorkpieceSummary of a worktree: a checkout of an external git repository that an agent
 * works in (see AiChatMessageBody.createdWorktrees). It has no app and no bindings; the UI shows
 * only its code. Its three commits are the worktree's state as the chat sees it; the OT rows of
 * the chat's current epoch compose on `pinBase`.
 */
export type WorktreeSummary = {
  id: WorkpieceId;
  type: "worktree";

  /** Display title: the name the worktree was created under. */
  title: string;

  /**
   * The chat this worktree belongs to, for its whole life (a worktree is never shared across
   * chats). Always set: the UI displays the worktree only while this chat is selected, as it
   * does a pending gadget, and the worktree is deleted with the chat.
   */
  chatId: number;

  /**
   * The accepted commit (40-hex hash): the worktree's content as of the chat's last accept, and
   * the worktree analog of a gadget's `commitId`. While the worktree is unpinned in its chat, its
   * content reads as this commit's tree (via Overseer.listTree()/readFilesAtCommit()), and a
   * client's pin declaration (CodeChangeSubmission.pins) is accepted iff its `baseCommit` equals
   * this. Advances when the chat's changes are accepted (to the accept's auto-commit of the
   * changed content); subscribeToWorkpieces() delivers a fresh entry() whenever it does.
   */
  pinBase: string;

  /**
   * The last explicit commit the agent made (initially `baseCommit`): what the worktree's own
   * API reports as HEAD. Header display only -- it plays no role in what the UI shows as changed,
   * which is always relative to `pinBase`. Re-delivered whenever it advances, and rolled back
   * with the changes that advanced it when they are reverted.
   */
  headCommit: string;

  /** The commit the worktree was created at. Immutable; informational. */
  baseCommit: string;
};

/** Callback interface used to receive workpiece-list updates. See Overseer.subscribeToWorkpieces(). */
export interface WorkpiecesSubscriber {
  /**
   * Upsert: called once per existing workpiece when the subscription starts, then again whenever
   * a workpiece is created or its summary changes (e.g. it is renamed).
   */
  entry(summary: WorkpieceSummary): void;

  /** The workpiece was deleted. */
  removed(id: WorkpieceId): void;

  /** Called after entry() has been called for all workpieces known so far. */
  ready(): void;
}

/**
 * Information about one of a gadget's bindings, for display in the Connections tab. Returned by
 * GadgetClient.listBindings().
 */
export type GadgetBindingInfo = {
  /** The binding name, as it appears in the gadget worker's `env`. */
  name: string;

  /** The workpiece that the binding points at. */
  target: WorkpieceId;

  /** Denormalized display info about the target. */
  resourceTitle: string;
  vendorId?: string;

  /**
   * If present, this binding is still provisional to the given chat (which is necessarily the
   * `chatId` passed to listBindings(); edges pending in other chats are never listed). It becomes
   * permanent when the user accepts that chat's changes through the message that recorded it, and
   * is deleted if those changes are reverted.
   */
  chatId?: number;
};

/**
 * An auto-approvable action kind offered by a specific connection. Aggregated from each bound
 * gatekeeper's getAutoApprovableActions(); `alreadyEnabled` reports whether a matching rule exists.
 */
export type PreApprovableAction = {
  gatekeeperId: WorkpieceId;
  resourceTitle: string;
  actionKind: ActionKind;
  alreadyEnabled: boolean;

  /** Vendor of the gatekeeper holding this connection. Absent for vendorless gatekeepers. */
  vendorId?: string;
};

// =======================================================================================
// Blueprint types
// =======================================================================================

/**
 * Describes how a gatekeeper was originally created. Stored on each GatekeeperRecord so that
 * bindings can be recreated and blueprint metadata can be derived.
 */
export type GatekeeperCreationSpec = {
  type: "gatekeeper";
  vendorId: string;        // identifies the gatekeeper adapter (e.g. "google")
  resourceUrl?: string;    // absent until a resource created by createExternalResource exists
  typeUrlPattern: string;  // URL pattern from the vendor's SupportedResource (not the specific URL)
} | {
  type: "aiModel";
  modelId: string;         // the user's configured model ID
  provider: string;        // provider name (e.g. "anthropic")
  modelName: string;       // model name on the provider's API (e.g. "claude-sonnet-4-6")
} | {
  type: "agentSpawner";
  /**
   * The spawner's config, less `env`: its bindings change after creation, so they are binding
   * edges of the spawner instead, added with the agent's setGadgetBinding tool.
   */
  config: Omit<AgentSpawnerConfig, "env">;

  /**
   * Denormalized from the creating user's model config at binding creation time.
   * Absent when config.modelId is null. Used to populate blueprint suggestedModel
   * without requiring a live lookup.
   */
  modelProvider?: string;
  modelName?: string;
} | {
  /**
   * A singleton gatekeeper account (e.g. the Context Library) auto-provided to every gadget as an
   * unnamed capsule so the agent can read/search it in code. Not user-configured, so excluded from
   * blueprints; re-added automatically if missing.
   */
  type: "ambient";
  vendorId: string;        // the singleton gatekeeper's id (GATEKEEPER_<ID> suffix, lowercased)
  accountId: number;       // the owner's connected-account id for this singleton (in their user DO)
};

/**
 * User-provided metadata controlling how a gatekeeper binding should appear in blueprints.
 * Stored on the binding edge (a gadget's binding-name -> gatekeeper mapping), not on the
 * gatekeeper itself: two gadgets binding the same gatekeeper can annotate it differently for
 * their respective blueprints. Optional: when absent, the binding is included in the blueprint
 * with a generated title, empty description, and no resource suggestion.
 *
 * Legacy field `included` may still be present on records written by older versions of
 * the workshop. The backend still honors `included: false`, but new writes omit it.
 */
export type BlueprintBindingAnnotation = {
  title: string;           // friendly name shown to people using the blueprint
  description: string;     // explains what resource to connect (may be empty)
  suggestValue?: boolean;  // include the specific URL/model as a suggestion
};

/**
 * Symbolic target of one agent-spawner env entry in a blueprint. Workpiece IDs are
 * workspace-local, so a spawner's `env` (see AgentSpawnerConfig.env) can't transfer into a
 * blueprint as-is; instead each entry references either one of the blueprint's own bindings by
 * name -- the user fills it at instantiation time like any other binding, and the spawner env
 * entry resolves to the gatekeeper created for it -- or the blueprint's gadget itself, resolving
 * to the newly instantiated gadget.
 */
export type SpawnerEnvTarget = {
  type: "binding";

  /**
   * Key into BlueprintMetadata.bindings. May reference a binding that is also bound into the
   * gadget, or one synthesized purely to feed this spawner (see BlueprintBinding.spawnerOnly).
   */
  name: string;
} | {
  /**
   * This spawner binding refers back to the gadget itself (the one instantiated from the
   * blueprint).
   */
  type: "gadget";
};

/**
 * Describes one binding required by a blueprint. Stored in BlueprintMetadata.bindings as a
 * Record keyed by binding name. Consumers identify bindings by their key (the binding name)
 * while `title` and `description` provide user-facing text.
 */
export type BlueprintBinding = {
  title: string;        // friendly name shown to people using the blueprint
  description: string;  // explains what resource to connect here (may be empty)

  /**
   * If true, this binding exists only to satisfy an agent spawner's env (it is referenced by
   * some spawner's `env` entry as a SpawnerEnvTarget). The user fills it at instantiation time
   * like any other binding, but the created gatekeeper is fed only to the spawner(s) referencing
   * it -- it is not bound into the gadget itself.
   */
  spawnerOnly?: true;
} & ({
  /** A regular external-resource gatekeeper binding. */
  type: "gatekeeper";

  /**
   * Identifies the gatekeeper adapter (currently mapped to the workshop's
   * GATEKEEPER_<name> service binding).
   */
  gatekeeperName: string;

  /** URL pattern describing the type of resource this binding accepts. */
  typeUrlPattern: string;

  /** The specific resource URL from the source gadget (suggestion only). */
  resourceUrl?: string;
} | {
  /**
   * An AI model binding. The user instantiating the blueprint picks one of their own
   * configured models.
   */
  type: "aiModel";

  /**
   * The blueprint creator may suggest a particular model to use, or omit this to leave
   * it up to the recipient.
   */
  suggestedModel?: {provider: string, modelName: string};

  /** The source binding's model kind, so installers pick one of that kind; absent: `"language"`. */
  modelKind?: ModelKind;
} | {
  /** An agent spawner binding. */
  type: "agentSpawner";

  /**
   * The blueprint creator may suggest a particular model to use, or omit this. (The
   * value is `null` if the suggestion is that AgentSpawnerConfig.modelId should be
   * configured as `null`. This is different from `undefined`, which means no suggestion.)
   */
  suggestedModel?: {provider: string, modelName: string} | null;

  /**
   * Symbolic form of AgentSpawnerConfig.env: env name -> target, resolved to concrete workpiece
   * IDs at instantiation time (see SpawnerEnvTarget).
   */
  env: Record<string, SpawnerEnvTarget>;
});
