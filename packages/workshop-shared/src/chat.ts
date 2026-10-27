// The chat wire grammar: chat authors, messages and their bodies (the durable record of a
// conversation), tool calls, attachments, capsule and output-format references, slash-command
// invocations, and the provisional stream events an in-progress agent turn emits. These are the
// wire types the chat surface of `AuthenticatedApi`/`Overseer`, the backend's chat engine, and the
// frontend transcript all share.
//
// The grammar reads a handful of workspace vocabulary types (workpiece ids, blueprint outputs,
// action log entries, chat pins) from api.ts via type-only imports, which are erased at runtime —
// so this module carries no runtime dependency on the API graph. `api.ts` re-exports every name
// here, so importers of `@gadgets/workshop-shared/api` are unaffected by this module's existence;
// the `@gadgets/workshop-shared/chat` subpath serves code that wants the chat grammar alone.

import type {
  ActionLogEntry,
  BlueprintMerge,
  BlueprintOutput,
  ChatGadgetPinRecord,
  MainlineMergeGadget,
  OutputIcon,
  WorkpieceId,
} from "./api.js";
import type {AgentCatalog, GitOid, ResourceDescription} from "./gatekeeper.js";
import type {CodeChange} from "./code-change.js";

export type AiChatAuthorInfo = {
  /**
   * Is the author a human, AI, or Gadget?
   *
   * "gadget" means an automated actor sent this on a chat's behalf: a prompt sent to an agent
   * spawner (a gadget spawned an agent programmatically -- `id` is then the gadget owner's ID,
   * for accounting purposes, and `name` the gadget title), or a message a bot sent to another
   * chat (a subagent task or an inter-bot DM -- `id` is then the sending bot's key,
   * "u:<id>" or "d:<slug>", and `name` the bot's name).
   */
  type: "user" | "agent" | "gadget";

  /** Unique user identifier, e.g. "kenton@cloudflare.com" or "gpt-5.1-pro". */
  id: string;

  /** Display name for author, e.g. "Kenton Varda" or "GPT" */
  name: string;

  /**
   * The user's preferred email address for git commits they author, set via
   * `AuthenticatedApi.setOwnCommitEmail()`. When absent, commits derive an address from `id`.
   * Self-asserted and unverified: it is attribution only and must never be read as identity.
   */
  commitEmail?: string;

  // Note: the avatar is intentionally not included here to keep this type lightweight (it's
  // embedded in every chat message). Fetch user avatars separately via
  // `AuthenticatedApi.getAvatar(userId)`.
};

export type AiChatMessage = {
  chatId: number;
  sequence: number;
  timestamp: Date;
  author: AiChatAuthorInfo;
} & AiChatMessageBody;

export type AiChatMessageBody = {
  /** A regular chat message. */
  type: "message";
  message: string;

  /**
   * The message may contain "capsules", which are embedded capabilities that reference external
   * resources. See `CapsuleSpecifier` for more.
   */
  capsules?: CapsuleSpecifier[];

  /**
   * Standard output formats the message names, e.g. "create a Doc for homework and Slides for the
   * presentation". See `MessageFormatRef`.
   */
  formats?: MessageFormatRef[];

  /**
   * If the AI produces any thinking/reasoning text, this is it. This should be hidden by default
   * but the user should have the option to expand it.
   */
  reasoning?: string;

  /** Messages from an AI agent can invoke tools. */
  toolCalls?: AiToolCall[];

  /** Attachments that were sent with this message. Actual bytes stored separately. */
  attachments?: ChatAttachmentRef[];

  /**
   * Sequence of the visible slash-command event that generated this agent-visible message.
   * Clients use this to group the two records for display.
   */
  generatedBySlashCommandSequence?: number;

  /**
   * Sent while the agent was working, so it steers that turn rather than prompting one. The agent
   * reads it before its next model request, or, if the turn ended before it could and started no
   * other (it failed, or stopped to wait on the user's decision), when the agent next runs.
   */
  steered?: true;
} | {
  /**
   * A slash command exactly as requested by the client, retained for display and never included in
   * model context. A gatekeeper command does not itself start an agent turn -- the prompt it expands
   * to arrives as a separate `message`. A built-in command is handled by the Workshop, and this
   * record is what drives the turn it runs.
   */
  type: "slashCommand";
  request: SlashCommandRequest;

  /** Provider-supplied skill name for the display badge. Commands without one show no badge. */
  skillName?: string;
} | {
  /**
   * Represents changes made to the code by an agent tool call or by a collaborating user as part
   * of a chat. These changes are provisional until they are accepted.
   */
  type: "changes";

  /**
   * The code changes themselves, composed from the changes this batch materialized (see
   * `watermark`). Applies to the chat content produced by the current epoch's earlier messages,
   * with this message's own `pins` established first (see ChatGadgetPin). Absent when the
   * batch records only gadget creations and/or binding additions with no accompanying code
   * edits, and on pre-conversion messages (see `conversionBoundary`).
   */
  change?: CodeChange;

  /**
   * Obsolete. Before the git-storage migration this recorded the code version the message's
   * changes were built against. It survives only as stored data on old messages and drives
   * nothing.
   */
  observedCodeVersion?: number;

  /**
   * Pins this batch declares. For each gadget listed, the chat's content restarts at the pinned
   * commit's tree, dropping whatever earlier messages of the epoch changed in it (see
   * ChatGadgetPinRecord), and this message's `change` applies on top. Usually the declaration
   * accompanies the epoch's first modification of the gadget's code.
   */
  pins?: ChatGadgetPinRecord[];

  /**
   * The span of the change stream this batch materialized: this message's `change` is the
   * composition of generation `changesGeneration`'s changes from just past the previous
   * materialization's watermark through `throughRevision`. On receiving the message, clients drop
   * their local copies of the covered changes -- and a client that already applied them must not
   * apply `change` on top: the message re-records content those changes already delivered, it does
   * not add to it. The generation is included because revisions restart per generation; a delayed
   * message must never clear another generation's changes. Absent when the batch materialized no
   * changes (e.g. it records only creations/bindings), and on pre-conversion messages.
   */
  watermark?: {changesGeneration: number, throughRevision: number};

  /**
   * Present when this batch was produced by Overseer.updateChatFromMainline(). `conflictPaths`
   * lists the files whose 3-way merge was not clean, in sorted order, each qualified by its
   * gadget's binding name (`GADGET_NAME/path/to/file`); their merged contents carry inline
   * conflict markers (or, for delete-vs-modify, the surviving side's content) for the user or
   * their agent to resolve.
   *
   * `gadgets` records each gadget's part of the merge, whose result is a commit: the batch has
   * no `change`, and its `pins` re-root each gadget merged at that commit, with the head merged
   * as the declaration's `mergedCommit` (see ChatGadgetPinRecord). Each entry also records what
   * the pin's `mergedCommit` was before the update, which a revert covering this message puts
   * back (see Overseer.revertChanges()).
   *
   * A batch without `gadgets` was recorded before merges were commits. Its `change` merged
   * mainline commits into the chat, or is absent when the chat's content already matched them,
   * and it advanced the chat's pins with no record of their earlier values, so it cannot be
   * reverted while still proposed (Overseer.revertChanges() refuses). Erasing its content while
   * keeping the advanced pins would let a later accept silently overwrite the mainline changes
   * it delivered.
   */
  mainlineMerge?: {conflictPaths: string[], gadgets?: MainlineMergeGadget[]};

  /**
   * Present on the synthetic message that converted this chat from the pre-git-storage
   * representation: its `change` collapses every uncommitted edit the chat had at migration time
   * into one diff against the chat's pinned commits. It acts as an epoch boundary: messages
   * before it are text-only history whose code payloads are no longer available. Present even
   * when the chat had nothing to convert (then with no `change` and no `pins`), because
   * ChatCodeBase.epoch needs a message to point at. The conversion change is all-or-nothing:
   * Overseer.revertChanges() refuses a range that erases this message while keeping any earlier
   * still-proposed batch (those batches' content was collapsed into this one and cannot survive
   * it), so the boundary and the pre-migration batches it collapsed are only ever discarded
   * together. Clients never display this message: the user took no action, and the migration it
   * records is not theirs to action.
   */
  conversionBoundary?: true;

  /**
   * Gadgets created as part of this batch of changes (by the agent's `createGadget` tool, or by
   * the user via Overseer.createGadget() with a chat open -- in the latter case `change` is
   * omitted). Like the code changes themselves, the creations are provisional: a merge
   * through this message makes them permanent, and a revert covering it deletes them. Titles are
   * denormalized for display, since a reverted creation's registry record is gone. `bindingName`
   * is the name under which the gadget appears in the creating chat's env (and, once merged, the
   * workspace default binding list); recording it here lets the creating chat pick the name back
   * up on replay.
   */
  createdGadgets?: {gadgetId: WorkpieceId, title: string, bindingName: string}[];

  /**
   * Worktrees created as part of this batch of changes (by the agent's `createWorktree` tool).
   * Deliberately separate from `createdGadgets` so a client can never mistake a worktree for a
   * gadget creation. Unlike a gadget creation, a worktree creation is not a proposed change (see
   * AiChatMetadata.proposedChangeWorkpieces), so it is not provisional either: recording this
   * message makes each worktree permanent (though private to this chat for life), nothing needs
   * accepting until the worktree is first modified, and a revert covering this message rolls
   * back the worktree's content and head but never deletes it. A creation pins nothing: like a
   * gadget, a worktree joins `pins` when it is first modified (see ChatGadgetPin). Batches
   * written before that was so carry the worktree's birth pin `{gadgetId: worktreeId,
   * baseCommit}` alongside the creation, which readers honor as an ordinary pin. `bindingName`
   * is the name in the creating chat's env, recorded so replay can pick it back up. The worktree
   * itself reaches the client as a WorktreeSummary on the workpiece subscription, and its
   * content rides `change` and `pins` like a gadget's.
   */
  createdWorktrees?: {worktreeId: WorkpieceId, title: string, bindingName: string}[];

  /**
   * Explicit worktree commits made as part of this batch: the agent's `commit()` calls on the
   * Worktree binding, each advancing the worktree's head from `previousHead` to `commit` (the
   * new head; also the call's return value). This is the durable, sequence-bearing record of the
   * advancement: the worktree registry record's head is updated in the same synchronous step
   * this message is written, and a revert covering this message rolls each affected worktree's
   * head back to its earliest reverted entry's `previousHead` (entries are ordered within the
   * message and messages by sequence, so multiple commits per step or per reverted range
   * compose). The commit objects themselves always remain -- content-addressed, and merely
   * dangling after a rollback -- so a queued push naming a rolled-back commit stays valid.
   */
  worktreeCommits?: {worktreeId: WorkpieceId, commit: string, previousHead: string}[];

  /**
   * Binding edges added to gadgets as part of this batch of changes (by the agent's
   * setGadgetBinding tool, or by the user binding a connection with a chat open -- in the latter
   * case `change` is omitted). Like `createdGadgets`, the additions are
   * provisional: the edge is visible only from this chat until a merge through this message
   * makes it permanent, and a revert covering it deletes the edge. `name` is the binding's name
   * within the gadget (or agent spawner) identified by `gadgetId`; `target` is the bound
   * workpiece.
   */
  addedBindings?: {gadgetId: WorkpieceId, name: string, target: WorkpieceId}[];

  /**
   * Blueprint releases this batch proposes to merge into gadgets: recorded by
   * GadgetClient.applyBlueprint(), and by the agent's `createGadget` tool when it builds the new
   * gadget from a blueprint.
   *
   * A proposal that GadgetClient.applyBlueprint() records is one message with no `change`. Its
   * merge was written as a commit, whose parents are the gadget's head and the release, and
   * which marks the release as merged. The batch's `pins` re-root the gadget at that commit,
   * with the head as the declaration's `mergedCommit` (see ChatGadgetPinRecord). The agent's
   * `createGadget` instead delivers the release's files as the batch's `change`, since a gadget
   * still pending in the chat has no head to commit on.
   *
   * Like the rest of the batch this is provisional. A merge through this message makes each
   * gadget follow the blueprint named (see GadgetUpstream) and records the release in the
   * gadget's history; a revert covering it withdraws the proposal, and until one or the other
   * the gadget is as it was.
   *
   * A proposal whose release is already in the gadget's history writes no commit and pins
   * nothing, so it does not put its gadget in AiChatMetadata.proposedChangeWorkpieces: this
   * record is then the only sign that the chat has something to accept.
   */
  blueprintMerges?: BlueprintMerge[];
} | {
  /**
   * Indicates that at this point in the chat, the user chose to merge all (non-reverted) changes
   * in this chat up to and including the given sequence number. `mergeThrough` is
   * server-computed: always the last sequence recorded before this message, since merges accept
   * everything (see Overseer.mergeChanges()).
   */
  type: "merge";
  mergeThrough: number;

  /**
   * Obsolete: the workspace-wide code version at which a pre-git-storage merge was applied.
   * Merges now record `commits` instead.
   */
  version?: number;

  /**
   * The commits this merge created: each touched gadget's new head (see
   * WorkpieceSummary.commitId). Empty when the merge created no commits (e.g. it covered only
   * gadget creations / binding additions, with no code changes). Present on every merge
   * message, including pre-migration ones: the git-storage migration synthesized a commit for
   * each historical merge and backfilled this field.
   */
  commits: {gadgetId: WorkpieceId, commitId: string}[];

  /**
   * This merge closed the chat's epoch: the chat's code base reset to empty and its change stream
   * restarted under a new generation, so content reconstruction starts fresh here (see
   * ChatCodeBase). Present on every merge message except pre-migration ones, which predate
   * epochs.
   */
  epochBoundary?: true;

  /**
   * No longer written; honored when read. Merges from when worktrees were pinned from birth
   * recorded here the re-pin of each live worktree in the new generation, at `baseCommit`: a
   * fresh local auto-commit capturing its uncommitted overlay when the closed epoch left it
   * dirty, else its unchanged base. Content reconstruction and compaction checkpoints still
   * re-root worktree content at these pins so the epochs they open fold as they were written.
   * Today a worktree pins on first modification like a gadget, and an accept merely advances
   * the worktree's accepted commit (to the same auto-commit) with no pin in the new generation,
   * so a merge written now carries no entry here. Auto-commits are internal bookkeeping,
   * squashed out of explicit history -- the worktree's reported head is untouched, and a later
   * explicit commit parents on that head, never on an auto-commit. Clients do not need to read
   * this field: a re-pin that is still in effect is mirrored in ChatCodeBase.pins, which is the
   * only pin source a client uses.
   */
  worktreePins?: {worktreeId: WorkpieceId, baseCommit: string}[];
} | {
  /**
   * Indicates that at this point in the chat, the user chose to revert all changes starting at the
   * given sequence number through the end of the chat as of that time. These changes are
   * completely erased from the chat's uncommitted state. Subsequent changes will be based only on
   * what existed before this point, and any later merge will not include the reverted changes.
   */
  type: "revert";
  revertFrom: number;
} | {
  /** Indicates that the agent in this chat performed an action. */
  type: "action",
  actionId: number;

  /**
   * Denormalized description of the action.
   *
   * This is inlined into the message at the time of query, so it is always present and always
   * current in messages delivered to the client. It is marked optional only because it is not
   * present in messages stored in the chat table on the server side.
   */
  actionLog?: ActionLogEntry;
} | {
  /**
   * Indicates that the AI agent accessed the gadget one or more times. This is logged in order
   * to track whether information known to the gadget may have tainted the agent session.
   */
  type: "useGadget";
} | {
  /**
   * The always-available resources changed after the agent's system prompt listed them: a
   * catalog changed, e.g. a skill was added to the Context Library, or the chat gained a resource,
   * e.g. the owner turned on Web Search. The agent writes this before the model request that first
   * sees the change, and tells the model what changed, so the system prompt can stay the same for
   * the whole chat. Clients show nothing for it.
   */
  type: "catalogChange";

  /** Each changed or new resource, as it is now. */
  resources: AlwaysAvailableResource[];
} | {
  /**
   * Indicates that the agent run ended with an error (e.g. LLM API failure, abort, server
   * restart). This is displayed to the user with a "retry" button, but is NOT included in the
   * chat log sent to the LLM so the agent does not react to it.
   */
  type: "error";
  message: string;
  /**
   * Optional machine-readable code so the client can react specially (e.g. "usage_limit" opens
   * the "connect Cloudflare / add credits" modal instead of a generic error + retry).
   */
  code?: string;
} | {
  /**
   * Indicates that a call was delivered to the agent: a method was called on its `self` object
   * (which code run by the agent's `executeCode` tool receives, and may pass along or store) or on
   * the stub an agent spawner's `spawnCallable()` returned. The call activates the agent to
   * respond; nothing is returned to the caller.
   */
  type: "agentCallback";

  /** The method name that was called. */
  methodName: string;

  /** A depth-limited summary string of the arguments for the agent's context window. */
  argsSummary: string;

  /**
   * Name under which the arguments appear in the agent's `env`. Absent on messages from before
   * callable agents became durable, whose arguments are no longer available.
   */
  bindingName?: string;
} | {
  /**
   * A model-visible control note for an approved-decision handoff, explicit Retry, or Stop.
   * It also ends the preceding decision segment for recovery. Not rendered in the chat UI:
   * the decision cards and turn controls already show these transitions to the user.
   * Older logs used this variant to nudge an agent whose callbacks were still unresolved.
   */
  type: "agentNudge";
  text: string;
} | {
  /**
   * The agent requested that the user connect a gatekeeper (e.g. "I need ClickHouse cluster X").
   * Rendered inline in the chat as an accept/deny card. State is mutated in-place when the user
   * accepts or denies; the message is re-delivered to subscribers so the card updates. On accept the
   * agent is resumed with the outcome (see the history builder in agent-replay.ts); on deny the agent is
   * not resumed (the user drives what happens next).
   */
  type: "connectionRequest";

  /** Unique id used by acceptConnectionRequest()/denyConnectionRequest(). */
  requestId: string;

  /**
   * The gatekeeper vendor the agent is requesting (id + denormalized display name), or
   * AGENT_SPAWNER_CONNECTION_ID for an agent spawner.
   */
  vendorId: string;
  vendorName: string;

  /** Denormalized vendor logo URL, for the connection card icon. */
  vendorLogoUrl?: string;

  /**
   * Denormalized human-readable resource type/scope being requested (e.g. "Home Assistant
   * Instance", "Gmail Mailbox"), resolved from the vendor's supported resources at request time.
   */
  resourceTitle?: string;

  /**
   * A fully- or partially-specified resource URL, if the agent could infer one. When absent (or
   * incomplete) the accept flow opens the vendor's resource configurator to fill in the gaps.
   */
  resourceUrl?: string;

  /**
   * The urlPattern of the supported resource this request resolved to at request time (one of the
   * vendor's SupportedResource.urlPattern values, e.g. "https://github.com/:owner/:repo" or the
   * whole-instance "https://*"). The backend guarantees every connection request for a vendor
   * resolves to a concrete resource (see resolveRequestedResource), and the accept modal
   * pre-selects exactly this resource — so accepting never opens a blank "create new connection"
   * picker. Absent for an agent spawner, which has no resources: accepting opens its form.
   */
  resourceUrlPattern?: string;

  /** Why the agent wants this connection. Shown to the user to inform their decision. */
  reason: string;

  /** Lifecycle state. Starts "pending"; set by the user's accept/deny. */
  state: "pending" | "accepted" | "denied";

  /**
   * Once accepted, the id of the created gatekeeper. The resource is surfaced to the agent as a
   * named binding in the chat's env; the agent can additionally bind it into a gadget via
   * setGadgetBinding if its gadget code needs it.
   */
  gatekeeperId?: WorkpieceId;

  /**
   * The name under which the resource will appear in the chat's env (`env.NAME` in executeCode)
   * once the request is accepted. Supplied by the agent as a required parameter of the
   * requestConnection tool -- the agent knows why it is requesting the resource, so it picks the
   * name itself -- and recorded here at request time. The name is claimed in the chat's scope
   * from that moment until the request is denied. Optional only because messages persisted
   * before named chat bindings existed lack it; those are named and stamped lazily at the
   * turn-start naming chokepoint.
   */
  bindingName?: string;
};

/**
 * A resource the agent can always use without requesting it (e.g. the Context Library's read
 * session), as its system prompt lists it.
 */
export type AlwaysAvailableResource = {
  /** The resource's binding name in the agent's `env`. */
  name: string;

  /** The resource's title. */
  title: string;

  /** The resource's discovery catalog, or null if it has none or it failed to load. */
  catalog: AgentCatalog | null;
};

/**
 * A previously uploaded blob to attach to a chat message, with display/model-input metadata.
 * The blob must be present in this workspace's Git store. Attachment limits and MIME signatures
 * are checked when sending. The ID-only variant accepts legacy staged uploads.
 */
export type ChatAttachmentHandle = {
  /** Immutable Git blob returned by `uploadBlob()`. */
  oid: GitOid;
  /** MIME type of this use of the blob; it does not change the stored bytes. */
  mimeType: string;
  /** Original display filename, sanitized when sending. */
  name?: string;
} | {
  /** Legacy staged-upload ID; new clients use a blob OID instead. */
  id: string;
};

/**
 * Attachment metadata returned to clients.
 *
 * For supported inline image formats, `content` carries the image bytes so the client can render
 * them without an extra round trip. For other attachments, fetch the bytes on demand via
 * `Overseer.getChatAttachmentContent()`.
 */
export type ChatAttachmentRef = {
  /** Chat-owned attachment identity used for downloads and message rendering. */
  id: string;
  /** Original immutable upload blob. Absent on legacy attachments. */
  oid?: GitOid;
  mimeType: string;
  name?: string;
  size: number;

  /**
   * Path in the chat's scratch worktree, preserving uploaded bytes for every file format.
   * Absent only on legacy attachments committed before workspace ingress was introduced.
   */
  workspacePath?: string;

  /** Inlined bytes for small image attachments. Present only for images. */
  content?: Uint8Array;
};

/** Whether attachment bytes can be decoded and inlined into the agent's prompt as text. */
export function isTextLikeAttachmentMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return false;
  return mimeType.startsWith("text/") ||
      /\b(json|javascript|typescript|xml|yaml|csv|markdown)\b/.test(mimeType);
}

/**
 * Describes a tool call performed by an AI agent as part of a message.
 *
 * The agent addresses workpieces by their chat binding name (the `gadget`/`workpiece` parameters
 * on several variants), never by workpiece ID. Logs persisted before multi-gadget workspaces lack
 * these names; when a name is absent, the workspace's `defaultGadgetId` (from `GadgetMetadata`)
 * is assumed, and it is an error for it to be omitted when there is no default.
 */
export type AiToolCall = {
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;

  /**
   * Obsolete. Before the git-storage migration this recorded the code version the tool call
   * observed. Its *presence* still marks the call as pre-migration -- history replay elides
   * such calls' observed content, which is no longer available -- but the value itself drives
   * nothing.
   */
  observedCodeVersion?: number;

  /** If the tool failed, the error. */
  error?: string;
} & ({
  /**
   * Any workpiece can potentially export files. Gadgets, in particular, export their source code
   * as files, but other workpieces may export other filesystems. Hence, a file is identified by
   * the pair of a workpiece reference (the `workpiece` chat binding name) and `filename`.
   */
  toolName: "readFile";
  input: {
    workpiece?: string;
    filename: string;

    /**
     * Optional line window: `startLine` is 1-based and `lineCount` is the number of lines to return
     * from there, each defaulting to the file's edge. A windowed read ends with a line stating the
     * range shown and where to continue. Absent on reads recorded before ranges existed.
     */
    startLine?: number;
    lineCount?: number;
  };

  /**
   * Present when the read was served from committed code rather than the chat's uncommitted
   * content: the workpiece was not pinned in the chat (see ChatGadgetPin), so the agent read the
   * file at its head -- a gadget's mainline head, a worktree's accepted commit -- and this is
   * the blob oid of the content it saw. History replay reproduces the read's exact text from
   * it, whatever the head holds now, and the agent's read-before-edit gate compares it against
   * the file's oid at the head an edit is about to pin at, refusing an edit anchored to content
   * another chat has since changed. Reads of pinned workpieces come from the chat's content,
   * which cannot go stale within an epoch, and carry no stamp.
   */
  observedOid?: string;

  /**
   * No longer written; honored when read. Before reads were stamped with the blob's oid
   * (`observedOid`), an unpinned read recorded the commit it read at; replay resolves the file's
   * blob from it by path.
   */
  observedCommit?: string;
} | {
  /**
   * Search a workpiece's files for lines matching a regular expression, in `grep -n` form. The
   * output, bounded as the model saw it, is recorded so replay doesn't re-run the search.
   */
  toolName: "grep";
  input: {
    workpiece: string;

    /** JavaScript regular expression, matched against each line. */
    pattern: string;

    /** A file to search, or a directory to search recursively. Absent means the whole workpiece. */
    path?: string;
  };
  output?: string;
} | {
  toolName: "writeFile";
  input: {
    workpiece?: string;
    filename: string;
    content: string;
  };
} | {
  toolName: "editFile";
  input: {
    workpiece?: string;
    filename: string;
    textToReplace: string;
    replacement: string;
  };
} | {
  /**
   * Describe a binding by name: one of the chat's bindings or, when `gadget` is given, one of
   * that gadget's own bindings. Numeric names appear only in logs persisted before named chat
   * bindings (they were capsule indices).
   */
  toolName: "describeBinding";
  input: {
    name: string | number;
    /** Chat binding name of a gadget; when present, `name` is a binding in that gadget's env. */
    gadget?: string;
  };

  /**
   * The description, exactly as the model saw it (already bounded), which history replay returns
   * verbatim rather than describing the binding again. Absent when the call failed, and in logs
   * persisted before descriptions were recorded, whose replay elides the result.
   */
  output?: string;
} | {
  toolName: "setBindingHook";
  input: {
    bindingName: string;
    entrypoint: string | null;
  };
} | {
  /**
   * Wire one of the chat's bindings into a gadget's own binding list, or an agent spawner's. The
   * addition is provisional to the chat, recorded by a "changes" message (see `addedBindings`).
   */
  toolName: "setGadgetBinding";
  input: {
    /** Chat binding name of the target gadget or agent spawner. */
    gadget: string;
    /** Chat binding name of the resource to wire into the gadget. */
    source: string;
    /** Name to bind the resource under within the gadget; defaults to `source`. */
    name?: string;
  };

  /**
   * The added binding edge as resolved when the tool ran -- the durable record of what the call
   * did, which history replay reproduces instead of re-running the tool, mirroring createGadget's
   * recorded output. `changeId` is the change number of the batch that records the addition (see
   * `addedBindings`). Absent only when the call failed (`error` is set).
   */
  output?: {gadgetId: WorkpieceId, name: string, target: WorkpieceId, changeId: number};
} | {
  /**
   * Obsolete predecessor of `setGadgetBinding`, from before named chat bindings; appears only in
   * old chat logs. Its additions were immediate and permanent (nothing provisional to recover),
   * so replay is a recorded no-op.
   */
  toolName: "saveCapsuleAsBinding";
  input: {
    capsuleId: number;
    bindingName: string;
  };
} | {
  /** Create a new gadget workpiece in the workspace, either empty or instantiated from a blueprint. */
  toolName: "createGadget";
  input: {
    /** Human-readable title for the new gadget. Required: the agent always names its creations. */
    title: string;

    /**
     * Name under which the gadget appears in the chat's env and, once merged, the workspace
     * default binding list (see validateBindingName()).
     */
    bindingName: string;

    /**
     * If present, the new gadget starts with the named blueprint's files (copied into the chat's
     * proposed changes) instead of empty.
     */
    blueprintId?: string;
  };

  /**
   * The created gadget's workpiece ID, recorded when the gadget was actually created. History
   * replay reconstructs tool outputs by re-running persisted calls, but a creation tool can't be
   * re-run; replay returns this recorded result without creating anything.
   *
   * `changeId` is the change number of the "changes" batch that records the creation (see
   * `createdGadgets` on the "changes" message body), reported like writeFile/editFile report
   * theirs so reverts can be referred to precisely.
   *
   * `blueprintNotes` is present for blueprint instantiations: formatted text describing the files
   * copied in and the bindings the blueprint expects the agent to wire up. Recorded so replay
   * doesn't have to re-fetch the blueprint (whose content may have changed since).
   */
  output?: {gadgetId: WorkpieceId, changeId?: number, blueprintNotes?: string};
} | {
  /**
   * Create a new worktree workpiece: a file tree rooted at a git commit, private to the creating
   * chat, whose files the agent then reads and edits with the regular file tools. Unlike a
   * gadget, a worktree has no output, no bindings, and cannot execute; its name lives only in
   * the chat's binding map, never in the workspace default binding list.
   */
  toolName: "createWorktree";
  input: {
    /** Human-readable title for the new worktree. Required, like a gadget's. */
    title: string;

    /**
     * Name under which the worktree appears in the chat's env (see validateBindingName()). The
     * chat's binding map is the only namespace a worktree name occupies.
     */
    bindingName: string;

    /**
     * The git commit to root the worktree at: a full 40-hex oid, resolved against the
     * workspace's local git store and its gatekeeper-provided metadata (never a remote lookup --
     * remote refs resolve through gatekeeper APIs first). Abbreviated ids are refused, since
     * knowing a commit's id is the capability to read it; logs written before that may carry an
     * unambiguous prefix.
     */
    commitId: string;
  };

  /**
   * The created worktree's workpiece ID, recorded when the worktree was actually created; like
   * createGadget's output, replay returns this recorded result instead of re-creating.
   *
   * `changeId` is the change number of the "changes" batch that records the creation (see
   * `createdWorktrees` on the "changes" message body), like createGadget's.
   *
   * `baseCommit` is the full oid `input.commitId` resolved to -- the commit the worktree is
   * rooted at, and its accepted commit until the chat's first accept of changes to it. Recorded
   * because the input of an older log may be a prefix and the model is told the resolved oid. The creation pins
   * nothing: the worktree reads as its accepted commit until its first modification pins it
   * (see ChatGadgetPin), so replay serves untouched files from the pin when there is one and
   * from the accepted commit otherwise, never from this field.
   */
  output?: {worktreeId: WorkpieceId, changeId?: number, baseCommit: string};
} | {
  toolName: "executeCode";
  input: {
    code: string;
  };

  /** Output, if the code actually ran. (Otherwise, `error` should be present.) */
  output?: string;
} | {
  /**
   * **Obsolete.** Rejected all of the agent's outstanding callbacks with an error. No longer
   * emitted since callable agents stopped returning values; retained so older chat logs remain
   * readable.
   */
  toolName: "giveUp";
  input: {
    error: string;
  };
} | {
  toolName: "webFetch";
  input: {
    url: string;
    /** If true, return the raw response body without Markdown conversion. */
    raw?: boolean;
  };

  /**
   * Output, if the fetch actually completed. (Otherwise, `error` should be present.) This is
   * stored so that the agent's chat history can be replayed without re-issuing the fetch.
   * Formatted as a YAML-frontmatter header followed by the body (see formatWebFetchResult).
   */
  output?: string;
} | {
  /** This actually shouldn't ever appear in logs unless the agent misunderstands the tool. */
  toolName: "observeUserChanges";
  input: {};
} | {
  /**
   * List the blueprints the workspace owner could instantiate (their own blueprints, their
   * library, and the deployment's featured blueprints), so the agent can pass a blueprintId to
   * createGadget. The formatted text output is recorded so replay doesn't re-list.
   */
  toolName: "listBlueprints";
  input: {};
  output?: string;
} | {
  /**
   * List the resource types a gatekeeper vendor offers, so the agent can construct a resourceUrl
   * for requestConnection. Resource patterns are only surfaced on demand (not in the system prompt).
   */
  toolName: "listConnectableResources";
  input: {
    vendorId: string;
  };
  output?: string;
} | {
  /**
   * Ask the user to connect a gatekeeper, pre-configured as much as the agent can manage. Renders
   * an accept/deny card in the chat; non-blocking (the turn ends, and the agent is resumed if the
   * user accepts; on deny the agent is not resumed).
   */
  toolName: "requestConnection";
  input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;

    /**
     * Name under which the resource will appear in the chat's env once accepted (see
     * `connectionRequest.bindingName`). Optional only because logs persisted before named chat
     * bindings lack it.
     */
    bindingName?: string;
  };
  output?: string;
} | {
  /**
   * Activate one of the chat bot's declared skills (a slash command from a gatekeeper): the
   * skill's commandId, or its unique title. Bot chats only.
   */
  toolName: "activateSkill";
  input: {
    skill: string;
  };
  output?: string;
} | {
  /**
   * Run another bot as a blocking subagent: the bot key ("u:<id>" for a user bot, "d:<slug>" for
   * a deployment bot), the task message, and optionally a prior child thread to continue. Returns
   * the child's threadId and its reply.
   */
  toolName: "delegateToBot";
  input: {
    bot: string;
    message: string;
    threadId?: number;
  };
  output?: string;
} | {
  /**
   * Send an async direct message to another bot (by key or name) or to "orchestrator" (the
   * delegating parent thread). Delivered as an inbound message; the recipient's next turn sees it.
   */
  toolName: "messageBot";
  input: {
    to: string;
    text: string;
  };
  output?: string;
} | {
  /**
   * Create a new external resource of a creatable type (see `SupportedResource.creatable`). Its
   * binding is usable at once: the gatekeeper simulates the resource until a user approves the
   * creation action, choosing the account to create it in.
   */
  toolName: "createExternalResource";
  input: {
    vendorId: string;

    /** `urlPattern` of the creatable resource type. */
    resourceUrlPattern: string;

    /** Title of the new resource, e.g. a document's title. */
    title: string;

    /** Name under which the resource appears in the chat's env (see validateBindingName()). */
    bindingName: string;
  };

  /** The new gatekeeper workpiece; replay re-binds it rather than creating again. */
  output?: {gatekeeperId: WorkpieceId};
});

// TODO: Extend AiToolCall for code-mode tool calls.
// - Includes inline audit logs from the action.
// - Actions can be approved or rejected inline.

/**
 * A standard output format named inline in a chat message, recorded so the message can be redrawn
 * the way it was composed. Display only: the agent reads the noun as ordinary text and resolves it
 * against the deployment's live catalog, so no blueprint id is carried here.
 *
 * Shaped like `CapsuleSpecifier`, but carries no authority: naming a format grants nothing, so
 * there is no workpiece behind it.
 */
export type MessageFormatRef = {
  /**
   * Position and length of the format's name within the message text. Exists so we can render as
   * format with icon in chat UI.
   */
  position: number;
  length: number;

  /** Denormalized so an old message still displays after the format is renamed or un-promoted. */
  noun: string;
  icon: OutputIcon;
};

/**
 * Capsules are resource references that are embedded inline in a chat message. The name comes
 * from the fact that they are represented as a pill-shaped inline element, and that they represent
 * a capability (in the capability-based security sense).
 *
 * When the user is typing a chat message and inserts a link into the message, they will be
 * prompted to turn the link into a capsule. Doing so implicitly creates a gatekeeper and grants
 * the agent permission to use it.
 */
export type CapsuleSpecifier = {
  /**
   * Position and length of the text within the chat message which should be replaced by the
   * capsule. The chat message contains some placeholder text which the capsule replaces. This
   * placeholder text exists mostly for ease of debugging -- it is never actually displayed to
   * the user nor the agent. Typically, the placeholder text should be an integer in square
   * brackets, where the integer is the position of the capsule within the message's capsule
   * list, e.g. `[0]`, `[1]`, etc. However, nothing should actually depend on the placeholder
   * text's content; the CapsuleSpecifier itself is all that matters.
   */
  position: number;
  length: number;

  /**
   * ID of the workpiece, which should have been created using newGatekeeper() or similar.
   *
   * This can reference any workpiece, including gadgets. It should be called `workpieceId`, but
   * when it was introduced it could only point to gatekeepers, and a name change would break
   * existing storage.
   */
  gatekeeperId: WorkpieceId;

  /**
   * Denormalized resource description from calling GatekeeperClient.describe() at the time of
   * insertion. We store this in the chat message to avoid the need to start up the gatekeeper
   * to ask for it again every time the message is displayed.
   */
  description: ResourceDescription;

  /**
   * Vendor whose gatekeeper the resource came from, denormalized at insertion like `description`
   * and trusted no more than it is, so the message can show the vendor's logo without starting the
   * gatekeeper. Display metadata only, never authority.
   */
  vendorId?: string;

  /**
   * The name under which the pasted resource appears in the chat's env (`env.NAME` in
   * executeCode). Stamped onto the persisted message at the turn-start naming chokepoint; absent
   * until then. Messages from before named chat bindings existed are stamped lazily the same
   * way. If the same workpiece already has a name in the chat's scope, that name is reused
   * rather than minting a new one.
   */
  bindingName?: string;
};

/** Identifies a Gatekeeper slash command or the built-in `/compact` command. */
export type SlashCommandId = {
  gatekeeperId: WorkpieceId;
  commandId: string;
  builtin?: never;
} | {
  builtin: true;
  commandId: "compact";
};

/** A slash command invocation parsed by the client. */
export type SlashCommandRequest = {
  id: SlashCommandId;

  /**
   * Unparsed natural-language arguments surrounding the command, with the command itself removed.
   * The provider may consume or transform these into an agent-visible message.
   */
  args: string;

  /**
   * Index in `args` where the user typed the command, so a transcript can show it where they put it
   * rather than implying it led the line. Display only.
   */
  commandPosition?: number;
};

/** One slash command as shown in the Workshop picker. */
export type SlashCommandChoice = {
  /** Selection to pass back when invoking this command. */
  selection: SlashCommandId;

  /** Name shown after `/`. */
  name: string;

  /** Short description shown in the picker. */
  description: string;

  /**
   * Name of the command's provider: the offering Gatekeeper's title, or the Workshop itself for a
   * built-in command.
   */
  providerLabel: string;

  /** Optional resource label used when multiple commands share a name. */
  resourceLabel?: string;

};

/**
 * One provisional streaming event emitted while an agent step is still in progress.
 *
 * At most one provisional stream is active per chat at a time. The client should not persist
 * these events. Instead, it should display them temporarily and discard them as soon as the
 * corresponding durable `message()` and/or `changes` message arrives, when the agent stops
 * running (`activeAgent` becomes unset in the chat metadata), or when a `streamReset` event
 * arrives.
 */
export type AiChatStreamEvent = {
  /** The turn is summarizing older context before it can continue, or before `/compact` ends. */
  type: "compacting";
} | {
  /**
   * The in-progress model request failed transiently and will be retried. Nothing it streamed
   * will become durable, so the client should discard the step's provisional state -- streamed
   * text and reasoning, tool-call cards, the active-file marker and all edit previews -- as it
   * would for an error message. The retry then streams afresh.
   */
  type: "streamReset";
} | {
  /**
   * The compaction attempt ended, whether it compacted, failed, was cancelled, or found nothing to
   * do.
   */
  type: "compacted";

  /**
   * Set when the attempt made no checkpoint because nothing precedes the newest message to
   * summarize. Only `/compact` reports this, since an explicit command is otherwise silent.
   */
  nothingToCompact?: boolean;
} | {
  type: "textDelta";
  delta: string;
} | {
  type: "reasoningDelta";
  delta: string;
} | {
  type: "toolCallStarted";
  toolCallId: string;
  toolName: AiToolCall["toolName"];
} | {
  /**
   * For the executeCode tool specifically, we stream the code as the AI writes it. (writeFile and
   * editFile stream their in-progress content through the editPreview* events below instead; other
   * tool calls' inputs are not streamed.)
   */
  type: "toolCodeDelta";
  toolCallId: string;
  delta: string;
} | {
  /**
   * This is a provisional UI lifecycle event. For most tools it means the full tool call input has
   * been received, so the tool is no longer visually "in progress". executeCode does not emit this
   * during streaming; its provisional card is cleared when the final durable message arrives.
   */
  type: "toolCallFinished";
  toolCallId: string;
} | {
  /**
   * Indicates which file the agent is currently editing, if any. This is emitted while a
   * writeFile/editFile call is streaming, and set to null when a non-edit tool becomes active.
   */
  type: "setActiveFile";
  file: { workpieceId: WorkpieceId, filename: string } | null;
} | {
  /** Streaming write/edit target file, used by the UI before the finalized tool call arrives. */
  type: "toolCallTarget";
  toolCallId: string;
  file: { workpieceId: WorkpieceId, filename: string };
} | {
  /**
   * Opens a live preview of a writeFile/editFile call whose content the model is still
   * generating: the streamed value (delivered by editPreviewDelta events) progressively replaces
   * a span of the target file, so the user watches the edit appear as it is written. Emitted
   * once the call's input has streamed far enough to identify the target (which happens when the
   * content/replacement field begins, since it is the input's final field).
   *
   * The event carries no base content: the client locates the span in its own copy of the file
   * -- the chat's content, or the committed head (a worktree's accepted commit) for a workpiece
   * the chat doesn't cover, read via readFilesAtCommit() if not yet loaded -- which mirrors the
   * content the agent computes its edit against (both are the same change stream).
   * The preview is display-only provisional state, never entering the client's own change
   * tracking.
   *
   * At most one preview is *streaming* at a time (a new editPreviewStart ends the previous
   * call's delta stream), but a preview outlives its streaming: tool calls execute only after
   * the whole model response has streamed, so several previews can finish before any of their
   * durable rows exists. The client must keep displaying each finished preview's final text --
   * a call's edits would otherwise vanish until its row lands -- until the preview resolves,
   * which happens in one of two ways: the completed call's change row arrives via
   * AiChatSubscriber.changeApplied() carrying the same final content (the ordinary end), or an
   * editPreviewClear withdraws it because no row will come. Since rows arrive in call order,
   * per-file previews resolve oldest-first. As with all provisional state, the client should
   * also discard whatever remains when the agent stops running.
   */
  type: "editPreviewStart";
  toolCallId: string;
  file: { workpieceId: WorkpieceId, filename: string };
  /**
   * For editFile: the exact text being replaced. The client finds its unique match in the file
   * (skipping the preview if there isn't exactly one -- the call itself will then fail). Absent
   * for writeFile, whose streamed content replaces the whole file.
   */
  textToReplace?: string;
} | {
  /** Appends newly decoded characters to the streaming edit preview's content. */
  type: "editPreviewDelta";
  toolCallId: string;
  delta: string;
} | {
  /**
   * Withdraws an edit preview whose tool call will produce no change row -- its input failed to
   * parse or validate, the call failed, or the edit turned out to be a no-op. May name any call
   * of the current response, not just the one currently streaming (failures surface at
   * execution, after later calls' previews may have started). The client restores the previewed
   * file to its real content. (Successful calls emit no clear: the durable changeApplied row
   * supersedes the preview instead.)
   */
  type: "editPreviewClear";
  toolCallId: string;
} | {
  /**
   * Streaming createGadget output format, used by the UI before the finalized tool call arrives.
   * Has the deployment's overrides applied, so it matches what the gadget is stamped with.
   */
  type: "toolCallOutputFormat";
  toolCallId: string;
  output: BlueprintOutput;
} | {
  type: "toolOutputDelta";
  toolCallId: string;
  delta: string;
};
