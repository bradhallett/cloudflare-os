// Workspace vocabulary shared by chats, workpieces and the Overseer: gadget metadata and
// summaries of outputs, the UI bundle shape, the git-commit reading types (CommitInfo,
// TreeNode, FileAtCommit), the action log grammar, bound hooks, and the agent-spawner
// configuration. Re-exported from api.ts, the single import surface of the API.


import type { NotificationMute, WorkpieceId } from "./api.js";
import type { AiChatAuthorInfo } from "./chat.js";
import type { ActionDescription, HookDescription, ObservationDescription } from "./gatekeeper.js";
import type { CollaboratorRole } from "./sharing.js";
/**
 * Metadata about a workspace (one Overseer DO and everything in it). Includes everything needed
 * to render the workspace list on the front page.
 *
 * TODO(multi-gadget): Rename `WorkspaceMetadata`.
 */
export type GadgetMetadata = {
  /**
   * Unique ID for this workspace, used with `openGadget()`. This is a url-safe base64 value
   * chosen randomly when the workspace is created.
   */
  id: string;

  /**
   * Human-readable workspace title. Can be modified. (Per-gadget titles live on the gadget
   * workpieces themselves; see WorkpieceSummary.)
   */
  title: string;

  /** Total cost of AI inference in dollars, if known. */
  totalCost?: number;

  /** Whether the user has pinned this gadget to the top of their list. */
  pinned?: boolean;

  /** Set while the user has muted this workspace's notifications. */
  notificationMute?: NotificationMute;

  /**
   * Set when the gadget is not owned by the current user. Presence of this field indicates the
   * user is a collaborator, not the owner.
   */
  owner?: AiChatAuthorInfo;

  /**
   * The viewing user's effective role for this gadget. The owner is always "build". Used by the
   * frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
   * Absent implies "build" for backwards compatibility.
   */
  role?: CollaboratorRole;

  /**
   * True when the gadget has observed data marked `containsRestrictedData` (see
   * `ObservationDescription`). It can still be shared, with collaborators verified per
   * gatekeeper (if `ownerInvitesOnly` is also set, only the owner can add them), but can no longer
   * fetch from the public web, and every action requires manual approval.
   */
  containsRestrictedData?: boolean;

  /**
   * True when the gadget has observed data marked `ownerInvitesOnly` (see
   * `ObservationDescription`). Only collaborators the owner added directly have access: share
   * links can no longer be created, copied, or redeemed, and only the owner can add collaborators.
   */
  ownerInvitesOnly?: boolean;

  /**
   * Various objects in the API specify a gadgetId, but make the property optional. When omitted,
   * the default gadget ID should be assumed. This is largely for backwards compatibility with
   * records that were stored before workspaces could have multiple gadgets.
   *
   * TODO(multi-gadget): Do a migration to backfill all gadget IDs, then eliminate the concept of
   * a default gadget from the API.
   */
  defaultGadgetId?: WorkpieceId;

  // TODO:
  // - created / modified / activity times
  // - icon? thumbnail?
}

/**
 * GadgetMetadata extended with timestamps. These are available when listing gadgets from the
 * user's collection, but not from the Overseer (which doesn't track them).
 */
export type GadgetMetadataWithTimestamps = GadgetMetadata & {
  created: Date;
  lastActive: Date;
}

/**
 * The icons an output format may be drawn with. A closed set because we want them to look consistent.
 * The glyphs themselves live in the frontend, so only these keys ever cross the wire.
 */
export const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"] as const;

/** One of `OUTPUT_ICONS`, naming a glyph the frontend knows how to draw. */
export type OutputIcon = typeof OUTPUT_ICONS[number];

/**
 * Whether an unknown value names one of the icons this deployment can draw. Used wherever an icon
 * arrives from outside the kernel: a published blueprint, an admin override, or the browser.
 */
export function isOutputIcon(value: unknown): value is OutputIcon {
  return typeof value === "string" && (OUTPUT_ICONS as readonly string[]).includes(value);
}

/**
 * What instantiating a blueprint produces: a Document, a Spreadsheet, a Workflow, etc. Declared
 * by the blueprint's author (see `BlueprintMetadata.output`), inherited by every gadget instantiated
 * from it, and used wherever that gadget is shown in place of generic gadget.
 *
 * Declaring this is presentation only. Any user can publish a blueprint calling itself a
 * Document; that must be harmless. Being offered as one of the deployment's standard formats (in
 * the New menu, or the agent's preferred list) is a separate, admin-curated decision.
 */
export type BlueprintOutput = {
  /**
   * Stable grouping slug, e.g. "document". Outputs sharing an id are grouped together on the
   * outputs page.
   */
  id: string;

  noun: string;
  plural: string;

  icon: OutputIcon;
};

/**
 * One entry of the "New ..." menu, as returned by `listOutputFormats()`. This names a blueprint the
 * deployment has promoted, instantiated with `newGadgetFromBlueprint(blueprintId, ...)` like any other.
 */
export type OutputFormatOffer = {
  blueprintId: string;

  /**
   * How to name and draw it: the blueprint's own declaration with any deployment override
   * applied. Also what the created gadget inherits.
   */
  output: BlueprintOutput;

  /** The blueprint's description. */
  description: string;

  /** The blueprint needs bindings wired up before it can run. */
  requiresSetup: boolean;
};

/** The result of `AuthenticatedApi.listOutputs()`. */
export type ListOutputsResult = {
  /** Every output indexed so far. */
  outputs: OutputSummary[];

  /**
   * Set while workspaces predating the index are still being swept into it, which happens once per
   * user after a deployment upgrades. Each call sweeps a bounded number of them, so a caller that
   * wants the rest calls again until this is false.
   *
   * False means stop asking, not that the index is complete. A workspace that couldn't be reached
   * is passed over rather than retried forever, and a sweep that reached none of them gives up for
   * now instead of spinning. Either way the gap closes when the workspace is next opened, and the
   * next call to this method resumes any sweep that was left unfinished.
   */
  catchingUp: boolean;
};

/**
 * One entry in the user's output index: something a workspace produced that the user can open
 * directly.
 */
export type OutputSummary = {
  /** The workspace that contains this output (an `openGadget()` id). */
  workspaceId: string;

  /**
   * The workpiece within that workspace. `(workspaceId, workpieceId)` uniquely identifies an
   * output.
   */
  workpieceId: WorkpieceId;

  /**
   * The format this output was built as, if it came from a blueprint declaring one. Absent for a
   * gadget built from scratch, which displays as a generic app.
   */
  output?: BlueprintOutput;

  title: string;
  workspaceTitle: string;
  created: Date;

  /**
   * When the containing workspace was last active. Outputs have no activity timestamp of their
   * own yet, so all outputs of a workspace share this value.
   */
  lastActive: Date;

  /**
   * Set when the containing workspace is owned by someone else (i.e. it was shared with the
   * caller).
   */
  owner?: AiChatAuthorInfo;

  /**
   * The caller's role, cached on their last open and refreshed when a revocation downgrades them,
   * so a listing can offer only the actions it permits; the workspace still authorizes each one
   * when attempted. Absent for the caller's own workspaces, and for a shared one whose last open
   * predates this field.
   */
  role?: CollaboratorRole;
}

/**
 * Describes the client-side UI code for a Gadget. Such code is intended to run inside an iframe
 * sandbox with no access to the outside world except through an RPC interface to the Workshop
 * and to the Gadget's server.
 */
export type UiBundle = {
  // URL from which the main bundle of UI code can be downloaded. This download contains all the
  // Gadget's client-side assets. The URL is content-addressed to make it highly cacheable, even
  // across multiple Gadgets sharing the same implementation (blueprint).
  //
  // TODO: Specify the format of what this URL returns. A raw HTML page doesn't quite work because
  //   the client needs to initialize the sandbox with some platform libraries before loading the
  //   Gadget itself.
//  url: string;

  /**
   * Returns the raw JS code to execute in the Gadget iframe.
   * TODO: For now we just return the code but we should switch to serving over HTTP as described
   *   above, for caching. Or... maybe we should actually serve over RPC, but also employ the
   *   Cache API in the browser? Or some other local storage?
   */
  jsCode: string;

  // Other metadata could be placed here in the future, e.g. to specify what version of support
  // libraries should be loaded.
};

/**
 * A git author/committer identity, as recorded in commits in a workspace's git object store.
 * Derived from the committing user's profile: the display name becomes `name` and the profile ID
 * the `email` (profile IDs that aren't email addresses get an `@localhost` placeholder appended).
 */
export type CommitIdentity = {
  /** Human-readable name, e.g. "Kenton Varda". */
  name: string;

  /** Email address, e.g. "kenton@cloudflare.com" or "kenton@localhost". */
  email: string;
};

/**
 * Metadata of one commit in a workspace's git object store, as produced by the backend's
 * GitStore. Commits are immutable, so results may be cached by oid.
 */
export type CommitInfo = {
  /** The commit's oid (40-hex SHA-1), as found in e.g. WorkpieceSummary.commitId. */
  oid: string;

  /** Parent commit oids; empty for a root commit. */
  parents: string[];

  /** The commit message, as stored (git normalization gives it a trailing newline). */
  message: string;

  /** The commit author. */
  author: CommitIdentity;

  /** The author timestamp. */
  timestamp: Date;
};

/**
 * One entry of a commit's tree, as returned by Overseer.listTree(): a directory carrying its own
 * entries, or a leaf of one of git's four non-directory modes. `name` is a single path segment
 * (never containing `/`); a file's path is the `/`-join of the names down to it. A `symlink` and
 * a `submodule` (gitlink) are listed with their kind and have no readable text (see
 * FileAtCommit). Nested rather than a flat path list so the tree needs one call per commit and
 * no parsing, and each name travels once. Carries no oids or sizes.
 */
export type TreeNode =
  | { name: string; kind: "file" | "executable" | "symlink" | "submodule" }
  | { name: string; kind: "dir"; children: TreeNode[] };

/**
 * One file's content at a commit, as returned by Overseer.readFilesAtCommit(). `text` carries
 * the file's UTF-8 content; `absent` means the path names no entry at that commit (or names a
 * directory); `unreadable` means the entry exists but cannot be presented as text -- a symlink,
 * a submodule, binary content, or a blob over the git store's per-object size cap -- and carries
 * a descriptive, path-flavored message suitable for display in place of the file.
 */
export type FileAtCommit =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; message: string };

/**
 * Maximum number of paths one Overseer.readFilesAtCommit() call may name. Callers with more
 * paths chunk them across calls.
 */
export const MAX_READ_FILES_PER_CALL = 64;

/**
 * Text bytes after which Overseer.readFilesAtCommit() stops decoding and omits the remaining
 * requested paths from its response (the client re-requests them). Keeps one response well
 * under the RPC message ceiling even with the UTF-16 inflation of serialized text. The first
 * file is always returned whole, however large, so every call makes progress; its size is
 * bounded only by what the git store could hold.
 */
export const READ_FILES_RESPONSE_BUDGET = 8 * 1024 * 1024;

/**
 * Specifies the state of an action in the action log:
 * * pending: Action has not been applied yet. It is waiting for approval.
 * * approved: Action was approved and applied.
 * * rejected: Action was rejected by the user.
 */
export type ActionState = "pending" | "approved" | "rejected";

export type ActionLogEntry = {
  /** Sequential ID number for the action. Counts up from when the workspace was created. */
  id: number;

  /**
   * Which gatekeeper produced this action? Omitted if the log entry came from a non-gatekeeper
   * source (e.g. webFetch tool).
   */
  gatekeeperId?: WorkpieceId;

  resourceTitle: string;
  resourceUrl?: string;

  createdAt: Date;
  appliedAt?: Date;

  state: ActionState;
} & ({
  type: "action";
  description: ActionDescription;
  /**
   * Who resolved the action (approved or rejected it). Set when the action leaves "pending"; absent
   * while still pending (or for legacy actions resolved before this was tracked). For an
   * auto-approved action this is the user who enabled the rule -- auto-approvals run under their
   * authority (see `autoApproved`).
   */
  resolvedBy?: AiChatAuthorInfo;

  /**
   * True when the action was applied automatically by an auto-approval rule rather than by a human
   * clicking Approve. Only ever set alongside state "approved" (there is no automatic rejection).
   */
  autoApproved?: boolean;

  /**
   * True for the creation queued by createExternalResource. Approving it requires one of the
   * approver's accounts for the gatekeeper's vendor (see GatekeeperClient.getCreationSpec()), in
   * which the resource is created.
   */
  creation?: true;
} | {
  type: "observation";
  description: ObservationDescription;
} | {
  type: "bindHook";

  description: HookDescription;

  /** Hook that was created by this action. `undefined` if it was later deleted. */
  hookId?: number;

  /** Is the hook currently enabled? */
  enabled: boolean;

  // Note that `state` is not meaningful for hooks. Instead of being "approved" or "rejected", they
  // are enabled/disabled, which the user can freely toggle as often as they want.
});

/** How the approver of a creation (see ActionLogEntry.creation) chose to make it. */
export type CreationApproval = {
  /** The approver's connected account, for the gatekeeper's vendor, to create the resource in. */
  accountId: number;

  /**
   * What the approver chose in that account's creation configurator (see
   * AuthenticatedApi.startCreationConfigurator()): a vendor-defined URL only the gatekeeper reads.
   * Omitted when they made no choice, as for a type without one.
   */
  configuration?: string;
};

export type BoundHookInfo = {
  id: number;

  /** The gatekeeper that delivers this hook. */
  gatekeeperId: WorkpieceId;

  /** The gadget whose code this hook wakes. */
  gadgetId: WorkpieceId;

  resourceTitle?: string;
  resourceUrl?: string;
  description: HookDescription;
  enabled: boolean;
};

/**
 * Configuration for an AI spawner binding. This binding allows the gadget to programmatically
 * create new agents, that is, start new agent chat threads, which appear in the gadget's agent
 * chat UI as new conversations. Agents created this way don't typically edit the gadget code, but
 * rather use the `executeCode` tool to directly invoke the gadget's bindings to perform tasks.
 * Beyond the bindings configured here, a gadget hands an agent per-task capabilities -- RPC stubs
 * representing specific resources or callbacks relevant to that agent session -- as the arguments
 * of calls made on the stub that the binding's `spawnCallable()` returns.
 *
 * For example, a gadget that responds to emails might invoke an agent for each email message that
 * arrives, with an RPC stub that allows it to reply to that email -- but prohibits the agent from
 * seeing or replying to any other email, to guard against prompt injection or information leakage
 * between email threads.
 */
export type AgentSpawnerConfig = {
  /** Display name for the binding, shown in the binding list. */
  displayName: string,

  /**
   * Model ID to run, of the gadget owner's available models. Can be `null` to just create a chat
   * that doesn't actually run an agent -- the prompt, or the calls made on a callable agent, are
   * appended to the chat for a human to pick up.
   */
  modelId: string | null,

  /**
   * The bindings available to agents spawned by this spawner: binding name (as it appears as
   * `env.NAME` in the spawned agent's executeCode environment) -> target workpiece. This is the
   * spawner's initial set: afterwards the chat agent may add more with `setGadgetBinding`, each
   * a proposal that takes effect once the user accepts the chat's changes. When an agent is
   * spawned, the spawner's bindings are snapshotted into the spawned chat's seed binding layer
   * (entries whose targets no longer exist are dropped); the spawned agent sees only these
   * bindings, never the workspace's default binding list.
   *
   * The entries are deliberately not limited to bindings held by the gadget that owns the
   * spawner: a spawner may define bindings of its own, with its own names and targets.
   *
   * Once a gadget binds the spawner, every binding target joins each "use" collaborator's
   * verification scope transitively: spawning is reachable from the gadget UI, and the spawned
   * agent reads these bindings with the spawner creator's authority.
   */
  env: Record<string, WorkpieceId>,
};

/**
 * The `vendorId` with which the agent's requestConnection asks the user to add an agent spawner
 * (see AgentSpawnerConfig) rather than connect a gatekeeper vendor's resource. No vendor can have
 * it: vendor ids come from binding names, which have no hyphen.
 */
export const AGENT_SPAWNER_CONNECTION_ID = "agent-spawner";

/**
 * The gadget-output listing methods of AuthenticatedApi. Split out of the session core so
 * the output vocabulary and its methods live in one module.
 */
export interface WorkspaceOutputMethods {
  /**
   * List the outputs of all the user's workspaces. Used to display the Outputs page, which lets
   * the user find things they made without remembering which workspace they made them in.
   *
   * Served from an index in the user's own account which each workspace pushes to; a workspace
   * shared with the user contributes its outputs from the first time the user opens it (matching
   * when it appears in listGadgets()), and stops updating them if their access is revoked.
   * Provisional gadgets (still awaiting acceptance of a chat's changes) are never included.
   *
   * TODO: Pagination, sort options.
   */
  listOutputs(): Promise<ListOutputsResult>;

  /**
   * The deployment's standard output formats, in the order they should be offered -- what fills a
   * "New Document / New Slides / ..." menu. Empty when the deployment promotes none.
   *
   * These are ordinary blueprints an admin has promoted.
   */
  listOutputFormats(): Promise<OutputFormatOffer[]>;
}
