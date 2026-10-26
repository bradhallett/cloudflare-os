import { AiChatMessage, AiChatAuthorInfo, AiToolCall, AiChatMessageBody, AiChatStreamEvent, BlueprintOutput, BlueprintMerge, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { FileContent, CodeChange, FileChange } from "@gadgets/workshop-shared/code-change";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { Usage } from "@earendil-works/pi-ai";
import type { AiGatewayLogRoute } from "./ai-gateway";
import type { WebFetchEnv } from "./web-fetch";
import type { GrepScan } from "./grep";
import type { ChatBindingEntry } from "./storage-schema/overseer-storage";
import type { AiChatAgentContext, CompactionCheckpoint, StoredAssistantMessage, StoredChatMessage } from "./storage-schema/overseer-storage";

/**
 * One buffered agent tool edit: an entry of the step buffer, which the step's persistence
 * barrier appends as one chat change row (see AgentHooks.commitAgentStep). One row per tool
 * call, in call order, never pre-composed: the client resolves streaming edit previews by
 * matching each broadcast row to the oldest pending preview of the same file, so the barrier's
 * burst must preserve the per-call row correspondence.
 */
export interface AgentStepChange {
  /** The tool call's edit, exactly as it will be recorded (and broadcast) as a row. */
  change: CodeChange;

  /**
   * Present on the step's first write to an unpinned gadget with committed code: the head the
   * edit is anchored to. The barrier validates it against the gadget's *current* head and
   * mirrors it into the chat's code base in the same transaction that records the row.
   */
  pin?: {gadgetId: WorkpieceId, baseCommit: string};
}

/**
 * The agent turn's worktree state, as the programmatic Worktree binding needs it. The binding is
 * served overseer-side (see worktree-session.ts; executeCode's env loopback resolves to it), but
 * everything a worktree operation touches lives in the turn: the session-content overlay of
 * touched/read files, the removal tombstones, the step's change buffer, and commit()'s in-memory
 * head advancements. runAgent implements this interface over its turn state and passes it to
 * executeCodeMode, which registers it for exactly the duration of the execution (see
 * OverseerImpl.executeCodeMode) -- so a stored worktree stub cannot operate outside its turn.
 * (The env.GIT binding's in-memory worktrees implement it too, with no turn behind them; see
 * InMemoryWorktree in git-binding.ts.)
 */
export interface WorktreeTurnAccess {
  /**
   * The base commit the worktree's overlay composes on: the chat pin's base while the worktree
   * is pinned in this session, else its accepted commit (WorktreeRecord.pinBase) -- the same
   * commit the first write will pin at. Undefined when the id is not a live worktree.
   */
  getBaseCommit(worktreeId: WorkpieceId): string | undefined;

  /**
   * The head advanced by a commit() buffered earlier in this turn, or undefined if none: the
   * in-memory half of "reported HEAD is the last explicit commit" (the durable half is the
   * record's headCommit, advanced at each step's barrier).
   */
  getBufferedHead(worktreeId: WorkpieceId): string | undefined;

  /**
   * The worktree's session content entry: the touched and lazily-read files (always a subset of
   * the tree -- worktree content is never materialized whole). Also exactly the overlay an
   * explicit commit()'s tree build applies over the pin base, together with getRemovedPaths().
   */
  getOverlayFiles(worktreeId: WorkpieceId): ReadonlyMap<string, FileContent>;

  /** Paths whose latest change is a removal: absent from the overlay, but not from the base. */
  getRemovedPaths(worktreeId: WorkpieceId): ReadonlySet<string>;

  /**
   * Read a file exactly as the file tools do: session content first, else the pinned base
   * (faulting the text into the session content, so later edits apply against it). Returns
   * undefined for an absent (or removed) path; throws the descriptive symlink/submodule errors
   * and UnreadableContentError for oversized/binary content.
   */
  readFile(worktreeId: WorkpieceId, path: string): Promise<string | undefined>;

  /**
   * Buffer one validated file change into the step: applied to the session content immediately,
   * durable (as an ordinary chat change row) at the step's barrier, which also pins the
   * worktree in the chat if nothing in the epoch has yet. The caller has already enforced the
   * base-entry write rules; this applies the same step budget the file tools do.
   */
  appendChange(worktreeId: WorkpieceId, path: string, change: FileChange): void;

  /**
   * Buffer a commit() head advancement for the step barrier, which validates the previousHead
   * chain, advances the record's headCommit, records the advancement as `worktreeCommits` on
   * the step's "changes" message, and pins the worktree in the chat if nothing in the epoch has
   * yet (so the advancement is revertable). In-memory until then: a step that dies before its
   * barrier drops the advancement, leaving only harmless dangling commit objects.
   */
  appendCommit(worktreeId: WorkpieceId, commit: string, previousHead: string): void;
}

/**
 * One entry of the chat's seed binding layer, as returned by AgentHooks.prepareChatBindings():
 * a name in the chat's env, its target workpiece, and display info for the system prompt.
 */
export type SeedBindingInfo = {
  name: string;
  target: WorkpieceId;

  /** Human title of the target (a gadget's title, or a gatekeeper's resource title). */
  title: string;

  /** Whether the target is a gadget (vs. an external resource gatekeeper). */
  isGadget: boolean;

  /**
   * Present when this entry is an always-available (ambient) resource, e.g. the read session of a
   * connected account that provides a singleton; carries its progressive-discovery catalog (null
   * when the gatekeeper provides none). Such entries get their own system-prompt section.
   */
  catalog?: AgentCatalog | null;
};

/**
 * The history one agent pass replays: the active compaction checkpoint, if any, the chat log from
 * it on, and the token total the provider reported for the chat's last model step (zero when none
 * is recorded). See AgentHooks.loadChatHistory.
 */
export type ChatHistory = {
  checkpoint?: CompactionCheckpoint;
  chatMessages: StoredChatMessage[];
  measuredTokens: number;
};

/**
 * Summary of one of the workspace's gadgets, as needed by the agent: identity and its named
 * bindings. See AgentHooks.listGadgetInfo().
 */
export type AgentGadgetInfo = {
  id: WorkpieceId;
  title: string;
  /**
   * Whether this is the workspace's default gadget: the gadget that tools operate on when their
   * gadget-name parameter is omitted. Only workspaces migrated from single-gadget days
   * (or created from a blueprint) have one.
   */
  isDefault: boolean;
  bindings: {name: string, title: string, target: WorkpieceId}[];
  /** What instantiating this gadget's blueprint produces, when it came from one that declares it. */
  output?: BlueprintOutput;
};

/**
 * A chat message body as the agent loop hands it to AgentHooks.commitAgentStep: the
 * client-visible body, plus (for agent steps) the model-facing snapshot to persist alongside it.
 * The overseer strips `modelData` into separate storage; it must never reach clients.
 */
export type AiChatMessageBodyWithModelData = AiChatMessageBody & {
  modelData?: StoredAssistantMessage;
};

/**
 * The chat-log side of the Overseer's agent hooks (see AgentHooks): the transcript, its
 * context, steers, the step persistence barrier, compaction checkpoints, and the model-facing
 * snapshots and attachments the replay of a log reads.
 */

export interface ChatLogHooks {

  getChatAgentContext(chatId: number): AiChatAgentContext;

  /** Records the chat's AiChatAgentContext.workspacePrompt. */

  /** Records the chat's AiChatAgentContext.workspacePrompt. */
  setChatWorkspacePrompt(chatId: number, workspacePrompt: string): void;

  /** The sequence the chat's next message will get. */

  /** The sequence the chat's next message will get. */
  nextChatSequencePeek(chatId: number): number;

  /** Appends messages to the chat log, unless the chat has been deleted. */

  /** Appends messages to the chat log, unless the chat has been deleted. */
  addChatMessages(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[]): void;

  /**
   * Takes the messages sent to the chat since the agent last asked, recording each in the chat
   * log as a steered message. The agent reads them before its next model request.
   */

  /**
   * Takes the messages sent to the chat since the agent last asked, recording each in the chat
   * log as a steered message. The agent reads them before its next model request.
   */
  takeSteers(chatId: number): string[];

  /**
   * The step's persistence barrier: in one storage transaction, persist the step's chat
   * messages (`msgs`, the tool-call record among them), validate and append each buffered
   * change as a chat change row -- one row per tool call, in call order, with the same
   * pin/codeBase bookkeeping the appends always had -- materialize the rows into the step's
   * single "changes" message carrying the step's gadget creations (with the blueprint release
   * each was created from, if any), binding additions, and worktree head advancements (stamping
   * pending gadget and binding records, making created worktrees permanent, and advancing
   * worktree heads), and retire the rows. The step's effects
   * are thus durable iff its transcript record is; a crash mid-step loses both, and the resumed
   * model re-runs the step against unmodified content. Returns whether a "changes" message was
   * written (change-ID numbering counts messages).
   *
   * Rows and messages broadcast from inside the transaction, as every append always has: the
   * transaction protects server-side storage, not what subscribers saw before a rollback (a
   * mid-barrier exception is itself a bug; see the design note on materializeChatChanges'
   * caller in overseer.ts). The rows' `changeApplied` broadcasts supersede the tool calls'
   * streamed edit previews.
   *
   * The accounting parameters match the overseer's addChatMessages. `usage` is pi's report for
   * the step: it sets the chat's token counts, and its catalog-priced `cost.total` is the cost
   * fallback. When both `aiGatewayLogId` and `aiGatewayLogRoute` are present, the authoritative
   * cost is fetched asynchronously from the AI Gateway log; otherwise the estimate is applied.
   */

  /**
   * The step's persistence barrier: in one storage transaction, persist the step's chat
   * messages (`msgs`, the tool-call record among them), validate and append each buffered
   * change as a chat change row -- one row per tool call, in call order, with the same
   * pin/codeBase bookkeeping the appends always had -- materialize the rows into the step's
   * single "changes" message carrying the step's gadget creations (with the blueprint release
   * each was created from, if any), binding additions, and worktree head advancements (stamping
   * pending gadget and binding records, making created worktrees permanent, and advancing
   * worktree heads), and retire the rows. The step's effects
   * are thus durable iff its transcript record is; a crash mid-step loses both, and the resumed
   * model re-runs the step against unmodified content. Returns whether a "changes" message was
   * written (change-ID numbering counts messages).
   *
   * Rows and messages broadcast from inside the transaction, as every append always has: the
   * transaction protects server-side storage, not what subscribers saw before a rollback (a
   * mid-barrier exception is itself a bug; see the design note on materializeChatChanges'
   * caller in overseer.ts). The rows' `changeApplied` broadcasts supersede the tool calls'
   * streamed edit previews.
   *
   * The accounting parameters match the overseer's addChatMessages. `usage` is pi's report for
   * the step: it sets the chat's token counts, and its catalog-priced `cost.total` is the cost
   * fallback. When both `aiGatewayLogId` and `aiGatewayLogRoute` are present, the authoritative
   * cost is fetched asynchronously from the AI Gateway log; otherwise the estimate is applied.
   */
  commitAgentStep(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      step: {
        changes: AgentStepChange[],
        createdGadgets: {gadgetId: WorkpieceId, title: string, bindingName: string}[],
        createdWorktrees: {worktreeId: WorkpieceId, title: string, bindingName: string}[],
        addedBindings: {gadgetId: WorkpieceId, name: string, target: WorkpieceId}[],
        worktreeCommits: {worktreeId: WorkpieceId, commit: string, previousHead: string}[],
        blueprintMerges: BlueprintMerge[],
      },
      usage?: Usage, aiGatewayLogId?: string,
      aiGatewayLogRoute?: AiGatewayLogRoute): Promise<boolean>;

  /**
   * The history one agent pass replays (see ChatHistory). Read fresh before each pass, since a
   * pass can compact or persist steps.
   */

  /**
   * The history one agent pass replays (see ChatHistory). Read fresh before each pass, since a
   * pass can compact or persist steps.
   */
  loadChatHistory(chatId: number): ChatHistory;

  /** Publish a compaction checkpoint: later history loads start from it. */

  /** Publish a compaction checkpoint: later history loads start from it. */
  commitChatCompaction(chatId: number, checkpoint: CompactionCheckpoint): void;

  /**
   * The gadget's current head commit (WorkpieceSummary.commitId), or undefined if it has none:
   * still pending in a chat, created outside chats and never accepted, or deleted. An unpinned
   * gadget with a head is read at that head; one without a head lives only in the session doc.
   * Undefined for worktrees, whose counterpart is getWorktreePinBase.
   */

  /**
   * Fetch the model-facing snapshot persisted for an agent step's "message" record, if any (see
   * StoredAssistantMessage). Absent for messages persisted before snapshots existed; replay then
   * falls back to reconstructing the message from the client-visible record.
   */
  getChatModelData(chatId: number, sequence: number): StoredAssistantMessage | undefined;

  /**
   * Record an observation in the Overseer audit log on behalf of a built-in agent tool
   * (i.e. one that isn't backed by a gatekeeper, like `webFetch`). Used to track which
   * external influencers may have tainted the agent's session.
   */

  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void;

  /**
   * Fetch the model-facing snapshot persisted for an agent step's "message" record, if any (see
   * StoredAssistantMessage). Absent for messages persisted before snapshots existed; replay then
   * falls back to reconstructing the message from the client-visible record.
   */

  consumeCapturedActions(chatId: number)
      : {actions: number[], accessedGadget: boolean, awaitDecision: boolean} | undefined;

  /**
   * Drain connection requests captured during the current step so they can be appended to the chat
   * (analogous to consumeCapturedActions).
   */
  consumeCapturedConnectionRequests(chatId: number): AiChatMessageBody[];

  /**
   * Mint a gatekeeper simulating a new resource of a creatable type, and queue the creation for
   * the user's approval. Unlike requestConnection, nothing waits on the user: the gatekeeper
   * simulates the resource until the creation applies. Throws an agent-readable message when the
   * request can't be met.
   */

  /** Returns the bytes of a committed attachment owned by this chat for inclusion in model input. */
  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array>;

  /**
   * Returns the resources needed by `webFetch` to delegate document-to-Markdown conversion
   * to Workers AI. Exposed as a narrow interface (rather than handing over the whole `env`)
   * so the dependency surface stays explicit.
   */

  /**
   * Prepare (seeding/naming lazily as needed) and return the chat's seed binding layer, including
   * the always-available (ambient) resources with their discovery catalogs. Called at turn start,
   * before history replay; this is also the chokepoint that stamps binding names onto any
   * persisted messages that introduced resources but don't carry a name yet (pasted resources,
   * plus connection requests from before agents named their own). `chatMessages` is the caller's
   * in-memory copy of the chat log, which is both scanned and stamped in place -- storage reads
   * return fresh deserialized objects, so stamping a separately-listed copy would leave the
   * caller's replay blind to the new names until the next turn.
   */
  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<SeedBindingInfo[]>;

  /**
   * Run one executeCode tool call. `worktreeTurn` is the turn's worktree state (see
   * WorktreeTurnAccess): the overseer registers it for the duration of the execution so the
   * chat's worktree env bindings can resolve against the running turn.
   */

}

/**
 * The workspace's read-only views as the agent needs them (see AgentHooks): git and workpiece
 * reads, registry info and resolution, grep, binding descriptions, and the deployment's
 * standing prompt inputs.
 */

export interface WorkspaceReadHooks {

  /**
   * The gadget's current head commit (WorkpieceSummary.commitId), or undefined if it has none:
   * still pending in a chat, created outside chats and never accepted, or deleted. An unpinned
   * gadget with a head is read at that head; one without a head lives only in the session doc.
   * Undefined for worktrees, whose counterpart is getWorktreePinBase.
   */
  getGadgetHead(gadgetId: WorkpieceId): string | undefined;

  /**
   * A worktree's accepted commit (WorktreeRecord.pinBase in overseer-storage.ts): what an unpinned
   * worktree reads at, lazily by path, and what its first modification pins it at -- the
   * worktree analog of getGadgetHead. Only an accept moves it, and none can run mid-turn.
   * Undefined for anything that is not a live worktree.
   */

  /**
   * A worktree's accepted commit (WorktreeRecord.pinBase in overseer-storage.ts): what an unpinned
   * worktree reads at, lazily by path, and what its first modification pins it at -- the
   * worktree analog of getGadgetHead. Only an accept moves it, and none can run mid-turn.
   * Undefined for anything that is not a live worktree.
   */
  getWorktreePinBase(id: WorkpieceId): string | undefined;

  /**
   * Read a commit's full file map from the workspace's git object store. Commits are immutable,
   * so results are cacheable by oid (and the store's parse cache makes repeats cheap).
   */

  /**
   * Read a commit's full file map from the workspace's git object store. Commits are immutable,
   * so results are cacheable by oid (and the store's parse cache makes repeats cheap).
   */
  readCommitFiles(oid: string): Promise<Map<string, string>>;

  /**
   * The paths of the files whose entry differs between two commits' trees, added and removed
   * ones included, in sorted order. Compares tree objects by id, so no file is read, and a
   * subtree that is the same on both sides is not read either.
   */

  /**
   * The paths of the files whose entry differs between two commits' trees, added and removed
   * ones included, in sorted order. Compares tree objects by id, so no file is read, and a
   * subtree that is the same on both sides is not read either.
   */
  listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]>;

  /**
   * Summarize the workspace's gadgets for the system prompt and for describeBinding's `gadget`
   * lookups (see AgentGadgetInfo). Gadgets still provisional to a chat other than `forChatId` are
   * omitted.
   */

  /**
   * Summarize the workspace's gadgets for the system prompt and for describeBinding's `gadget`
   * lookups (see AgentGadgetInfo). Gadgets still provisional to a chat other than `forChatId` are
   * omitted.
   */
  listGadgetInfo(forChatId: number): AgentGadgetInfo[];

  /**
   * Resolve an agent tool's optional workpiece reference. Absent means the workspace's default
   * gadget; throws an agent-readable error if there is none. When `mustExist` is set,
   * additionally throws if the gadget isn't currently registered -- or is provisional to a chat
   * other than `forChatId` -- (used by live file tools; history replay omits it so old edits to
   * since-deleted gadgets still resolve).
   */

  /**
   * Resolve an agent tool's optional workpiece reference. Absent means the workspace's default
   * gadget; throws an agent-readable error if there is none. When `mustExist` is set,
   * additionally throws if the gadget isn't currently registered -- or is provisional to a chat
   * other than `forChatId` -- (used by live file tools; history replay omits it so old edits to
   * since-deleted gadgets still resolve).
   */
  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, forChatId?: number)
      : {workpieceId: WorkpieceId};

  /**
   * Create a new, empty gadget workpiece with the given title and binding name, provisional to
   * the given chat: it becomes permanent only when the user accepts the chat's changes through
   * the "changes" message that records the creation (GadgetRecord.pending in overseer-storage.ts).
   * Throws if the binding name is invalid or already claimed by another gadget (including one
   * still pending in another chat). Returns the id and the (trimmed) title as created.
   * `blueprint` is the blueprint being instantiated, if any, and `output` the format it declares
   * (see fetchBlueprint). A gadget created from none is recorded as made from scratch.
   */

  /**
   * Whether the workpiece is a worktree: chat-private, git-rooted, read lazily by path. False
   * for gadgets and for ids that no longer resolve.
   */
  isWorktree(id: WorkpieceId): boolean;

  /**
   * Read one file of a commit's tree by path, walking (and fault-pulling) only the objects along
   * the path -- never a whole tree -- the lazy base resolver behind worktree session content and
   * the way every unpinned read is served, gadget or worktree. Returns undefined for an absent
   * path; throws descriptive, agent-visible errors for a symlink or submodule path (naming the
   * target), oversized or binary content, and pull failures.
   */

  /**
   * Read one file of a commit's tree by path, walking (and fault-pulling) only the objects along
   * the path -- never a whole tree -- the lazy base resolver behind worktree session content and
   * the way every unpinned read is served, gadget or worktree. Returns undefined for an absent
   * path; throws descriptive, agent-visible errors for a symlink or submodule path (naming the
   * target), oversized or binary content, and pull failures.
   */
  readFileAtCommit(commit: string, path: string): Promise<string | undefined>;

  /**
   * readFileAtCommit that also reports the blob's oid: the file's content address, which an
   * unpinned read stamps (AiToolCall.observedOid, and the agent's filesRead) so a later edit can
   * ask whether the committed file is still byte-identical (fileOidAtCommit).
   */

  /**
   * readFileAtCommit that also reports the blob's oid: the file's content address, which an
   * unpinned read stamps (AiToolCall.observedOid, and the agent's filesRead) so a later edit can
   * ask whether the committed file is still byte-identical (fileOidAtCommit).
   */
  readFileAtCommitWithOid(commit: string, path: string)
      : Promise<{text: string, oid: string} | undefined>;

  /**
   * The blob oid of the regular file at `path` in a commit's tree, or undefined for an absent
   * path or one naming anything else. A tree walk along the path; never reads the blob.
   */

  /**
   * The blob oid of the regular file at `path` in a commit's tree, or undefined for an absent
   * path or one naming anything else. A tree walk along the path; never reads the blob.
   */
  fileOidAtCommit(commit: string, path: string): Promise<string | undefined>;

  /**
   * Read a blob by oid as text, under readFileAtCommit's content rules (`path` names the file in
   * errors). How replay reproduces exactly the text a stamped read returned, whatever the
   * commit holds now.
   */

  /**
   * Read a blob by oid as text, under readFileAtCommit's content rules (`path` names the file in
   * errors). How replay reproduces exactly the text a stamped read returned, whatever the
   * commit holds now.
   */
  readBlobText(oid: string, path: string): Promise<string>;

  /**
   * Throws the same descriptive errors readFileAtCommit does when `path` names a symlink or
   * submodule in the commit's tree -- the write side of the tree-entry modes rules. Absent
   * paths (new files) and regular files pass, including ones whose content is unreadable
   * (a whole-file write is coherent against any base).
   */

  /**
   * Throws the same descriptive errors readFileAtCommit does when `path` names a symlink or
   * submodule in the commit's tree -- the write side of the tree-entry modes rules. Absent
   * paths (new files) and regular files pass, including ones whose content is unreadable
   * (a whole-file write is coherent against any base).
   */
  assertWorktreePathWritable(commit: string, path: string): Promise<void>;

  /**
   * The grep tool's scan: the searchable files under `path` in a workpiece's overlay-over-base
   * view, with missing base blobs pulled in one batch (see scanWorkpieceForGrep). `base` is the
   * commit the workpiece's untouched files are read from, or undefined for a gadget with no
   * committed code.
   */

  /**
   * The grep tool's scan: the searchable files under `path` in a workpiece's overlay-over-base
   * view, with missing base blobs pulled in one batch (see scanWorkpieceForGrep). `base` is the
   * commit the workpiece's untouched files are read from, or undefined for a gadget with no
   * committed code.
   */
  grepWorkpiece(turn: WorktreeTurnAccess, workpieceId: WorkpieceId, base: string | undefined,
                path?: string): Promise<GrepScan>;

  /**
   * Describe a workpiece (a gadget or a gatekeeper) reachable as `envName` in chat `chatId`'s
   * env, for the agent's describeBinding tool. (`envName` is provided here only so that it can
   * be incorporated into the returned description.)
   */

  /**
   * Describe a workpiece (a gadget or a gatekeeper) reachable as `envName` in chat `chatId`'s
   * env, for the agent's describeBinding tool. (`envName` is provided here only so that it can
   * be incorporated into the returned description.)
   */
  describeBinding(envName: string, id: WorkpieceId, chatId: number): Promise<string>;

  /** Describe the env.GIT binding (see GIT_BINDING_NAME), for the describeBinding tool. */

  /** Describe the env.GIT binding (see GIT_BINDING_NAME), for the describeBinding tool. */
  describeGitBinding(envName: string): string;

  /**
   * Add a binding to the given gadget or agent spawner, pointing at the given workpiece. The
   * binding is provisional to the chat. The caller is responsible for getting the addition
   * recorded in the chat log (see `addedBindings` on the "changes" message) so the pending edge
   * gets sequence-stamped.
   */

  /**
   * Deployment-wide, admin-authored instructions to append to the agent's system prompt. Returns
   * "" when none are set. Read on each turn so admin edits take effect promptly.
   */
  getInstanceInstructions(): Promise<string>;

  /** A random string that belongs to this workspace and never changes. */

  /** A random string that belongs to this workspace and never changes. */
  getPromptCacheSalt(): string;

  /**
   * Connection-request hooks for the agent.
   *
   * List the gatekeeper vendors the user could connect (id + display name). Used to populate the
   * system prompt so the agent knows what it can request; resource patterns are fetched on demand
   * via listConnectableResources().
   */

  /**
   * Connection-request hooks for the agent.
   *
   * List the gatekeeper vendors the user could connect (id + display name). Used to populate the
   * system prompt so the agent knows what it can request; resource patterns are fetched on demand
   * via listConnectableResources().
   */
  listConnectableVendors(): Promise<{id: string, displayName: string}[]>;

  /**
   * Describe the resource types a given vendor offers (urlPattern + title + description), so the
   * agent can construct a resourceUrl for requestConnection. Returns formatted text.
   */

  /**
   * Describe the resource types a given vendor offers (urlPattern + title + description), so the
   * agent can construct a resourceUrl for requestConnection. Returns formatted text.
   */
  listConnectableResources(vendorId: string): Promise<string>;

  /**
   * Record a pending connection request for the given chat. `message` is the tool output text; when
   * `requested` is true a request was created (captured and spliced into the chat as a
   * "connectionRequest" message by the agent loop, see consumeCapturedConnectionRequests) and the
   * turn should end so the agent waits for the user. When `requested` is false the request was
   * rejected (e.g. it wouldn't resolve to a connectable resource); `message` explains what to fix
   * and the agent should be allowed to retry within the same turn.
   */

  /**
   * Blueprint hooks for the agent.
   *
   * List the blueprints available to the turn's initiator (their own published blueprints, their
   * library, and the deployment's featured set) as formatted text. The initiator -- not the
   * workspace owner -- because blueprint libraries are per-user: a collaborator driving the agent
   * should see their own. There is no search index; the corpora are small enough for the model to
   * scan directly.
   */
  listAvailableBlueprints(initiator: AiChatAuthorInfo): Promise<string>;

  /**
   * A short standing note naming the deployment's standard output formats, or "" if it has none.
   * Carried in the system prompt rather than left to `listBlueprints`, because a request phrased as
   * "make me a doc" may not prompt an agent to go looking for blueprints at all.
   */

  /**
   * A short standing note naming the deployment's standard output formats, or "" if it has none.
   * Carried in the system prompt rather than left to `listBlueprints`, because a request phrased as
   * "make me a doc" may not prompt an agent to go looking for blueprints at all.
   */
  describeStandardFormats(): Promise<string>;

  /**
   * Fetch a blueprint's decoded files, plus formatted notes describing the copied files and the
   * bindings the blueprint's code expects the agent to wire up. Used by the createGadget tool to
   * instantiate the blueprint as a new gadget, along with the output format the blueprint declares
   * (if any), which the created gadget inherits. `merge` is the record of the release the files
   * are, for the creation's "changes" message once the gadget has an id (see
   * AiChatMessageBody.blueprintMerges). `initiator` is the user the turn runs for, who must be a
   * member of the org owning an org-owned blueprint to read it. Throws an agent-readable error if
   * the blueprint doesn't exist.
   */

  /**
   * Fetch a blueprint's decoded files, plus formatted notes describing the copied files and the
   * bindings the blueprint's code expects the agent to wire up. Used by the createGadget tool to
   * instantiate the blueprint as a new gadget, along with the output format the blueprint declares
   * (if any), which the created gadget inherits. `merge` is the record of the release the files
   * are, for the creation's "changes" message once the gadget has an id (see
   * AiChatMessageBody.blueprintMerges). `initiator` is the user the turn runs for, who must be a
   * member of the org owning an org-owned blueprint to read it. Throws an agent-readable error if
   * the blueprint doesn't exist.
   */
  fetchBlueprint(initiator: AiChatAuthorInfo, blueprintId: string): Promise<{
    files: Record<string, string>, notes: string, output?: BlueprintOutput,
    merge: Omit<BlueprintMerge, "gadgetId">,
  }>;

  /**
   * Activate one of this chat's bot skills (agentContext.botSkills) by commandId or unique
   * title, invoking it against the workspace and returning its agent-visible result text.
   * Throws an agent-readable error when the skill is unknown, ambiguous, or no longer usable.
   */

  /**
   * The bots the turn's initiator may delegate to or message (merged user + deployment bots,
   * only the available ones), as the bot tools' descriptions list them. Empty -- and the
   * delegateToBot/messageBot tools are omitted -- when there are none (or no initiator).
   */
  listDelegatableBots(chatId: number): Promise<{key: string, name: string, description?: string}[]>;

  /**
   * Run (or continue) a bot's thread as this chat's subagent and await its reply: idempotent by
   * `toolCallId` (a re-executed tool call returns the existing child, never a duplicate), and
   * returning the child's last reply or an honest status string when it ended without one.
   * Refuses cycles, self-delegation, and over-deep chains with agent-readable errors.
   */

}

/**
 * The effectful operations behind the agent's tools (see AgentHooks): creating workpieces and
 * bindings, executing code, requesting connections, blueprints, observations, and bot
 * delegation.
 */

export interface ToolEffectHooks {

  /**
   * Create a new, empty gadget workpiece with the given title and binding name, provisional to
   * the given chat: it becomes permanent only when the user accepts the chat's changes through
   * the "changes" message that records the creation (GadgetRecord.pending in overseer-storage.ts).
   * Throws if the binding name is invalid or already claimed by another gadget (including one
   * still pending in another chat). Returns the id and the (trimmed) title as created.
   * `blueprint` is the blueprint being instantiated, if any, and `output` the format it declares
   * (see fetchBlueprint). A gadget created from none is recorded as made from scratch.
   */
  createGadget(title: string, bindingName: string, chatId: number,
               blueprint?: {output?: BlueprintOutput}): {id: WorkpieceId, title: string};

  /**
   * Create a new worktree workpiece rooted at the given commit id (a full oid, resolved against
   * the workspace's local git knowledge -- never a remote lookup), provisional to and permanently
   * private to the given chat. Performs the initial pull when the commit is known only from a
   * gatekeeper. Like createGadget, the creation becomes durable via the step's "changes" message
   * (`createdWorktrees`); a step that dies before its barrier leaves an unstamped record that
   * reconciliation reaps. The new worktree is unpinned: it reads as its base commit until the
   * first modification pins it. Returns the base commit alongside the id.
   */

  /**
   * Create a new worktree workpiece rooted at the given commit id (a full oid, resolved against
   * the workspace's local git knowledge -- never a remote lookup), provisional to and permanently
   * private to the given chat. Performs the initial pull when the commit is known only from a
   * gatekeeper. Like createGadget, the creation becomes durable via the step's "changes" message
   * (`createdWorktrees`); a step that dies before its barrier leaves an unstamped record that
   * reconciliation reaps. The new worktree is unpinned: it reads as its base commit until the
   * first modification pins it. Returns the base commit alongside the id.
   */
  createWorktree(title: string, chatId: number, commitId: string)
      : Promise<{id: WorkpieceId, title: string, baseCommit: string}>;

  /**
   * Whether the workpiece is a worktree: chat-private, git-rooted, read lazily by path. False
   * for gadgets and for ids that no longer resolve.
   */

  /**
   * Add a binding to the given gadget or agent spawner, pointing at the given workpiece. The
   * binding is provisional to the chat. The caller is responsible for getting the addition
   * recorded in the chat log (see `addedBindings` on the "changes" message) so the pending edge
   * gets sequence-stamped.
   */
  addGadgetBinding(gadgetId: WorkpieceId, name: string, target: WorkpieceId, chatId: number): void;

  /**
   * Prepare (seeding/naming lazily as needed) and return the chat's seed binding layer, including
   * the always-available (ambient) resources with their discovery catalogs. Called at turn start,
   * before history replay; this is also the chokepoint that stamps binding names onto any
   * persisted messages that introduced resources but don't carry a name yet (pasted resources,
   * plus connection requests from before agents named their own). `chatMessages` is the caller's
   * in-memory copy of the chat log, which is both scanned and stamped in place -- storage reads
   * return fresh deserialized objects, so stamping a separately-listed copy would leave the
   * caller's replay blind to the new names until the next turn.
   */

  /**
   * Run one executeCode tool call. `worktreeTurn` is the turn's worktree state (see
   * WorktreeTurnAccess): the overseer registers it for the duration of the execution so the
   * chat's worktree env bindings can resolve against the running turn.
   */
  executeCodeMode(chatId: number, code: string,
                   initiator: AiChatAuthorInfo, initiatorModelId: string,
                   bindings: Record<string, ChatBindingEntry>,
                   onOutputText?: (delta: string) => void,
                   worktreeTurn?: WorktreeTurnAccess): Promise<string>;

  /**
   * Record an observation in the Overseer audit log on behalf of a built-in agent tool
   * (i.e. one that isn't backed by a gatekeeper, like `webFetch`). Used to track which
   * external influencers may have tainted the agent's session.
   */
  recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void>;

  /** Returns the bytes of a committed attachment owned by this chat for inclusion in model input. */

  /**
   * Returns the resources needed by `webFetch` to delegate document-to-Markdown conversion
   * to Workers AI. Exposed as a narrow interface (rather than handing over the whole `env`)
   * so the dependency surface stays explicit.
   */
  getWebFetchEnv(): WebFetchEnv;

  /**
   * Deployment-wide, admin-authored instructions to append to the agent's system prompt. Returns
   * "" when none are set. Read on each turn so admin edits take effect promptly.
   */

  /**
   * Record a pending connection request for the given chat. `message` is the tool output text; when
   * `requested` is true a request was created (captured and spliced into the chat as a
   * "connectionRequest" message by the agent loop, see consumeCapturedConnectionRequests) and the
   * turn should end so the agent waits for the user. When `requested` is false the request was
   * rejected (e.g. it wouldn't resolve to a connectable resource); `message` explains what to fix
   * and the agent should be allowed to retry within the same turn.
   */
  requestConnection(chatId: number, input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;
    bindingName: string;
  }): Promise<{ requested: boolean; message: string }>;

  /**
   * Drain connection requests captured during the current step so they can be appended to the chat
   * (analogous to consumeCapturedActions).
   */

  /**
   * Mint a gatekeeper simulating a new resource of a creatable type, and queue the creation for
   * the user's approval. Unlike requestConnection, nothing waits on the user: the gatekeeper
   * simulates the resource until the creation applies. Throws an agent-readable message when the
   * request can't be met.
   */
  createExternalResource(
      chatId: number, input: Extract<AiToolCall, {toolName: "createExternalResource"}>["input"])
      : Promise<{gatekeeperId: WorkpieceId}>;

  /**
   * Blueprint hooks for the agent.
   *
   * List the blueprints available to the turn's initiator (their own published blueprints, their
   * library, and the deployment's featured set) as formatted text. The initiator -- not the
   * workspace owner -- because blueprint libraries are per-user: a collaborator driving the agent
   * should see their own. There is no search index; the corpora are small enough for the model to
   * scan directly.
   */

  /**
   * Activate one of this chat's bot skills (agentContext.botSkills) by commandId or unique
   * title, invoking it against the workspace and returning its agent-visible result text.
   * Throws an agent-readable error when the skill is unknown, ambiguous, or no longer usable.
   */
  invokeBotSkill(chatId: number, skill: string): Promise<string>;

  /**
   * The bots the turn's initiator may delegate to or message (merged user + deployment bots,
   * only the available ones), as the bot tools' descriptions list them. Empty -- and the
   * delegateToBot/messageBot tools are omitted -- when there are none (or no initiator).
   */

  /**
   * Run (or continue) a bot's thread as this chat's subagent and await its reply: idempotent by
   * `toolCallId` (a re-executed tool call returns the existing child, never a duplicate), and
   * returning the child's last reply or an honest status string when it ended without one.
   * Refuses cycles, self-delegation, and over-deep chains with agent-readable errors.
   */
  runBotSubagent(chatId: number, bot: string, message: string, threadId: number | undefined,
      toolCallId: string, signal: AbortSignal): Promise<{threadId: number, response: string}>;

  /**
   * Deliver a direct message to another bot's thread in this chat's delegation tree (waking an
   * idle one, auto-spawning a missing one, steering a mid-turn one) or to "orchestrator" (the
   * chat's parent). Returns confirmation text for the sender; throws an agent-readable error
   * when the target can't be resolved or the tree's DM budget is exhausted.
   */

  /**
   * Deliver a direct message to another bot's thread in this chat's delegation tree (waking an
   * idle one, auto-spawning a missing one, steering a mid-turn one) or to "orchestrator" (the
   * chat's parent). Returns confirmation text for the sender; throws an agent-readable error
   * when the target can't be resolved or the tree's DM budget is exhausted.
   */
  deliverBotMessage(chatId: number, to: string, text: string): Promise<string>;

}

/**
 * Methods of OverseerImpl that runAgent() needs to call, extracted as an interface to avoid cyclic
 * dependencies. Split by concern: ChatLogHooks (the transcript and its lifecycle),
 * WorkspaceReadHooks (read-only workspace views), and ToolEffectHooks (tool-driven effects).
 */
export interface AgentHooks extends ChatLogHooks, WorkspaceReadHooks, ToolEffectHooks {}
