// The chat-session vocabulary: chat metadata and code bases, gadget pins, code-change
// submissions and merge results, chat history and its filter helpers, and the chat,
// actions, and console-log subscriber interfaces. Re-exported from api.ts, the single
// import surface of the API.


import type { WorkpieceId } from "./api.js";
import type { BotSelection } from "./bots.js";
import type { AiChatAuthorInfo, AiChatMessage, AiChatStreamEvent } from "./chat.js";
import type { CodeChange } from "./code-change.js";
import type { ActionLogEntry, ActionState } from "./workspace.js";
export type AiChatMetadata = {
  id: number,
  title: string,
  started: Date,
  lastActive: Date,

  /**
   * If present, an LLM (described by the author info) is currently actively responding to the
   * chat.
   */
  activeAgent?: AiChatAuthorInfo,

  /**
   * The workpieces to which this chat has proposed changes that have not been accepted yet
   * (including changes not yet materialized into a durable `changes` message): gadgets and
   * worktrees whose code the chat modified (pinned in the current epoch -- for a worktree, an
   * explicit commit() counts as a modification), gadgets it provisionally created, and gadgets
   * it added a binding to. A worktree's creation alone is not listed: the worktree is private to
   * the chat either way, so a checkout made only to be read proposes nothing (see
   * AiChatMessageBody.createdWorktrees). Absent (or empty) when the chat proposes nothing --
   * the pending-changes accept/discard affordances and per-workpiece draft previews key off this
   * list. Derived server-side and delivered on metadata updates; never submitted by clients.
   * (This replaces the earlier `hasProposedChanges` boolean; values of that retired field may
   * linger in stored metadata but are never delivered as truth.)
   */
  proposedChangeWorkpieces?: WorkpieceId[];

  /**
   * Messages sent while the agent works that it has not read yet, oldest first (see
   * `Overseer.sendChatMessage`). Each then appears in the chat as a message marked `steered`,
   * unless a turn ends without reading it and without failing or waiting on the user's decision:
   * it then prompts the next turn as an ordinary message. Stopping the agent drops them all (see
   * `Overseer.stopAgent`). Absent when none.
   */
  queuedSteers?: {text: string, author: AiChatAuthorInfo}[];

  /** If this was started from an agent spawner, the spawner's display name. */
  spawnerName?: string;

  /** If this chat runs as a declared bot (see AuthenticatedApi.listBots()), the bot's name. */
  botName?: string;

  /**
   * The bot this chat last ran as, if any: the identity the in-chat picker initializes from.
   * Clearing the chat's bot (sendChatMessage with "none") removes this and `botName`. The bot
   * itself may since have been deleted or become unavailable; the picker then shows it as no
   * longer available rather than silently switching.
   */
  bot?: BotSelection;

  /**
   * Tokens the model reported for this conversation's last step, if known. Cleared when compaction
   * changes what the next prompt will contain, until a step measures it again.
   */
  totalTokens?: number;

  /** Total cost of this conversation so far, in dollars, if known. */
  totalCost?: number;

  /**
   * Prompt tokens this conversation has sent to the model so far, including the ones the
   * provider read from or wrote to its prompt cache, if known. A running total, like
   * `totalCost`: compaction does not reset it.
   */
  promptTokens?: number;

  /** How many of `promptTokens` the provider read from its prompt cache. */
  cacheReadTokens?: number;

  /** How many of `promptTokens` the provider wrote to its prompt cache. */
  cacheWriteTokens?: number;

  /**
   * First sequence this chat still replays. Everything before it is covered by a compaction
   * checkpoint; those messages remain in canonical history but no longer drive current-state reads.
   */
  compactedTo?: number;

  /**
   * The chat's code-branch state for its *current epoch*: which gadgets are pinned (and where),
   * plus the stream position and generation that submitCodeChange() validates against. Delivered
   * via AiChatSubscriber.metadata(), and re-delivered when its shape changes -- a pin
   * established or advanced, a generation bump -- but not on every accepted change: clients track
   * `revision` live via AiChatSubscriber.changeApplied().
   *
   * Absent until something first needs it; an absent record means
   * `{pins: [], generation: 0, revision: 0}`, and both sides use that reading -- a new chat's
   * first submitCodeChange() simply passes `generation: 0, revision: 0`.
   */
  codeBase?: ChatCodeBase;
};

/**
 * A chat's code-branch state (see AiChatMetadata.codeBase). A chat behaves like a branch: its
 * uncommitted changes are one revisioned stream of code changes (see
 * `@gadgets/workshop-shared/code-change`) applied on top of pinned commits, and accepting the
 * changes fast-forwards each touched gadget's head (see Overseer.mergeChanges()). A gadget
 * joins the stream only when its code is first *modified* in the chat -- at that moment it is
 * pinned at a commit, whose tree its changes apply on top of. Unpinned gadgets always track
 * mainline head, live, and are read via Overseer.listTree()/readFilesAtCommit(). One exception:
 * a gadget created within this chat and still pending has no head commit to pin, so it stays
 * unpinned while its changes build its content up from nothing (every file starts with a
 * `set`); the merge that makes it permanent ends the epoch anyway, and in later epochs it pins
 * like any other gadget. A worktree (see createdWorktrees) follows the same rule with its
 * accepted commit in the role of the head: unpinned it reads as that commit's tree, its first
 * modification pins it there, and an accept advances the accepted commit rather than creating a
 * mainline commit.
 *
 * Clients derive the chat's content themselves: for each pin, start from `baseCommit`'s tree
 * (Overseer.listTree(baseCommit), with each file's text read by path via readFilesAtCommit()
 * only when something needs it -- an `edit` to apply, or a file the user opens; a whole
 * repository tree is never fetched); apply the current epoch's non-reverted `changes` messages'
 * changes in log order, from the pin's last declaration on (see ChatGadgetPinRecord, and
 * `composeEpochChanges` in `@gadgets/workshop-shared/code-change`); then apply the changes not
 * yet materialized into a message, delivered
 * in revision order via AiChatSubscriber.changeApplied(). Accepting changes ends the epoch: the
 * pin set resets to empty and the change stream restarts.
 */
export type ChatCodeBase = {
  /**
   * Per-workpiece pins: every permanent gadget, and every worktree, whose code has been modified
   * in the current epoch.
   */
  pins: ChatGadgetPinState[];

  /**
   * Identifies the chat's current change stream. submitCodeChange() validates against this; it is
   * bumped by every operation that invalidates the stream clients are rooted in. Bumps come in
   * two classes. **Content-preserving** (a merge's epoch reset): the stream identity changes
   * but the content carries over -- `prior` describes the closed stream, and in-flight
   * submissions are transformed onto the new generation (see submitCodeChange()). **Destructive**
   * (a revert, draft discard, or agent turn abort erased already-applied changes, or
   * updateChatFromMainline() re-rooted pins): content other clients may have transformed against
   * is gone, so they must discard local state and rebuild. Pin additions do *not* bump -- they
   * only append changes.
   */
  generation: number;

  /**
   * Sequence number of the message that opened the current epoch: an `epochBoundary` merge
   * message, or a migrated chat's `conversionBoundary` changes message. Absent when the epoch
   * runs from the start of the chat. Only `changes` messages after this point contribute to the
   * chat's current content.
   */
  epoch?: number;

  /**
   * Revision of the most recently accepted change of the current generation's stream (changes are
   * numbered sequentially from 1; 0 means none yet). Restarts with each generation, so
   * `(generation, revision)` identifies a point in the chat's uncommitted-change stream. This
   * field is a snapshot as of this metadata delivery; clients track the live position via
   * AiChatSubscriber.changeApplied().
   */
  revision: number;

  /**
   * Present after a content-preserving generation bump (a merge's epoch reset): describes the
   * closed generation so clients can hand off to the new one without losing anything. A client
   * still processing generation `prior.generation` first applies its remaining changeApplied()
   * deliveries -- that stream is complete once seen through `finalRevision` -- and then
   * switches. Content is identical across the boundary for every gadget except those listed in
   * `discontinuousGadgets`, which must be rebuilt from head (dropping pending local changes that
   * touch them; the server would reject those anyway). Absent after a destructive bump, whose
   * closed stream is unusable anyway.
   */
  prior?: {
    /** The closed generation. */
    generation: number;

    /** The closed generation's terminal revision: its stream is complete through here. */
    finalRevision: number;

    /**
     * Gadgets whose chat content did not carry across the epoch reset: the pin was dropped
     * while the chat's content for the gadget differed from the new head (it was pinned but had
     * no net change to commit, and mainline had moved past its pin). Usually empty.
     */
    discontinuousGadgets: WorkpieceId[];
  };
};

/**
 * One workpiece's pin within a chat (see ChatCodeBase): the record that the gadget's (or
 * worktree's) code was modified for the first time in the chat's current epoch, fixing the
 * commit its uncommitted changes apply on top of. A pin is established by that first
 * modification -- a submitCodeChange() pin declaration, or the agent's first write (for a
 * worktree, also its first commit()), which pins at the then-current head (a worktree's
 * accepted commit) -- and lasts until the epoch ends or the declaring message is reverted.
 *
 * This shape is the declaration a client submits with a first modification
 * (CodeChangeSubmission.pins). Its permanent record in the chat log and in compaction
 * checkpoints is a ChatGadgetPinRecord, which only the server writes.
 */
export type ChatGadgetPin = {
  /** The pinned gadget. */
  gadgetId: WorkpieceId;

  /**
   * The commit whose tree the chat's uncommitted changes for this gadget apply on top of. Fixed
   * until a later declaration re-roots the gadget (see ChatGadgetPinRecord): every change
   * recorded for this gadget since is expressed against content rooted here, so nothing else
   * moves it.
   */
  baseCommit: string;
};

/**
 * A pin declaration as the chat log records it: the `pins` of a "changes" message, and of a
 * compaction checkpoint. A declaration **re-roots** its gadget: the gadget's chat content
 * becomes `baseCommit`'s tree, and any changes that earlier messages of the epoch recorded for
 * the gadget no longer count. Every fold of the log applies that one rule, so a closed epoch's
 * content is reconstructed by starting each gadget from its last surviving declaration's tree
 * and applying the changes recorded from that message on. A reverted message declares nothing,
 * so reverting a re-root brings back the declaration before it and the changes recorded since.
 */
export type ChatGadgetPinRecord = ChatGadgetPin & {
  /**
   * ChatGadgetPinState.mergedCommit as of the declaration, for whoever describes it. Absent
   * when it equals `baseCommit`. A record of the past only: the pin's live `mergedCommit` is
   * never set from it.
   */
  mergedCommit?: string;
};

/**
 * A pin's current state within a chat (see ChatCodeBase.pins): its current declaration, plus how
 * far mainline has been merged into the chat since. That addition is live state rather than
 * history, which is why it is absent from the declaration a client submits.
 */
export type ChatGadgetPinState = ChatGadgetPin & {
  /**
   * The most recent mainline commit whose content the chat's content for this gadget includes.
   * Accepting the chat's changes requires this to equal the gadget's current head
   * (WorkpieceSummary.commitId); a difference means the chat is stale and the UI should offer
   * updating from mainline.
   *
   * It starts equal to `baseCommit`. An update from mainline recorded before re-roots existed
   * advanced it to a descendant of `baseCommit`. A re-root that merges mainline into the chat
   * declares a merge commit as `baseCommit` and sets this to the merge's first parent, the head
   * that was merged; accepting then fast-forwards the head from here through the merge commit
   * (see Overseer.mergeChanges()). A revert puts back what the earliest update it covers
   * records the pin had before (see AiChatMessageBody.mainlineMerge).
   */
  mergedCommit: string;
};

/**
 * One client code-change submission (see Overseer.submitCodeChange() for the full validation and
 * retry contract).
 */
export type CodeChangeSubmission = {
  /**
   * The generation of the chat's change stream the submission is rooted in (see
   * ChatCodeBase.generation).
   */
  generation: number;

  /**
   * The revision within `generation` the change is expressed against: the submitter has applied
   * every accepted change up to and including this revision (0 = none). The server transforms the
   * change over any changes accepted since.
   */
  revision: number;

  /**
   * Identifies the client's editing session: a client-generated random token (e.g. a UUID),
   * minted fresh each time the client builds or rebuilds its local editing state and never
   * shared between concurrent sessions (two tabs are two clients). Together with `seq` this
   * makes submissions idempotent: the server remembers each session's last accepted submission
   * and recognizes retries. Sessions are scoped to the authenticated user, so the token only
   * needs to be unique among that user's own sessions. See Overseer.submitCodeChange() for the full
   * contract.
   */
  clientId: string;

  /**
   * This submission's sequence number within the client session, starting at 1 and incrementing
   * by 1 per change. Retry a transport failure with the same seq and an identical payload -- never
   * renumber or re-compose a submitted change; the server rejects a reused seq whose content
   * differs. Because the server remembers only the last accepted seq per session, at most one
   * submission may be in flight at a time (see Overseer.submitCodeChange()).
   */
  seq: number;

  /**
   * Pin declarations, one per permanent gadget this change touches that is not yet pinned in the
   * chat (a gadget still pending in the chat is never pinned or declared), and one per worktree
   * it touches that is not yet pinned -- pending or not, since a worktree's content is its
   * accepted commit's tree, never built up from nothing. The same shape is what the chat log
   * keeps permanently; see Overseer.submitCodeChange() for the validation rules.
   */
  pins?: ChatGadgetPin[];

  /** The change itself. */
  change: CodeChange;
};

/**
 * Result of Overseer.mergeChanges(). A stale chat is an expected outcome of the accept flow --
 * someone else's accept can land at any time -- so it is reported as a value for ordinary
 * control flow, not thrown as an error.
 */
export type MergeChangesResult = {
  /**
   * "merged": the changes were accepted; every touched gadget's head fast-forwarded (also the
   * outcome when there was nothing to merge). "stale": nothing was merged -- mainline advanced
   * past one of the chat's pins, so the accept could not fast-forward; call
   * updateChatFromMainline(), resolve any conflicts, and retry.
   */
  outcome: "merged" | "stale";
};

/**
 * One page of a chat's history, bounded below by a compaction checkpoint. Compaction doesn't delete
 * messages, so a long thread is read one checkpoint-delimited page at a time.
 */
export type AiChatHistoryPage = {
  /** The page's messages, ascending by sequence. */
  messages: AiChatMessage[];

  /** The checkpoint bounding this page below, absent once the page reaches the thread's start. */
  compacted?: {
    /** First sequence in this page. Pass as `getChatHistory`'s `beforeSequence` for the page before. */
    to: number;

    /**
     * Summary that replaces the messages before `to` in subsequent model prompts, exposed so the
     * user can inspect the context kept across the boundary.
     */
    summary: string;

    /**
     * Changes still proposed before `to`, composed into one code change, so the client can show
     * pending changes without loading the messages that recorded them. Composes over the base
     * trees of the pins the compacted messages established (which remain in ChatCodeBase.pins),
     * before any later messages' changes.
     */
    proposedChange?: CodeChange;
  };
};

/**
 * Filter for listActions(): "all" for every record, one specific record type, or "pending" for
 * only the currently-pending records (of any type). Pending records appear in the type views and
 * "all" too, so history shows everything the agent has attempted.
 */
export type ActionHistoryFilter = "all" | "pending" | ActionLogEntry["type"];

/**
 * Whether a record passes an ActionHistoryFilter. Used by the client's live-merge; the server's
 * listActions() answers the same question from its byHistoryFilter index, whose key derivation
 * must stay in lockstep with this function so the two ends of the wire can't drift.
 */
export function matchesActionHistoryFilter(
    record: {type: ActionLogEntry["type"], state: ActionState},
    filter: ActionHistoryFilter): boolean {
  return filter === "pending"
      ? record.state === "pending"
      : filter === "all" || record.type === filter;
}

/**
 * A record's last state-change time: appliedAt once a mutation has stamped it, else createdAt.
 * The server's byLastChanged resume index keys on this (actionLastChangedKey in overseer.ts) and
 * the client's resume watermark must reproduce it exactly — derive it only through this helper.
 */
export function actionChangeTime(record: Pick<ActionLogEntry, "appliedAt" | "createdAt">): Date {
  return record.appliedAt ?? record.createdAt;
}

/** One page of action history from listActions(). */
export type ActionHistoryPage = {
  /** Matching records, descending id (creation order, newest first). */
  entries: ActionLogEntry[];

  /**
   * Id of the last returned entry; pass as `beforeId` for the next-older page. Absent when the
   * page reached the start of the history.
   */
  nextBeforeId?: number;
};

// --- Chat wire ---
// The chat grammar (authors, messages and their bodies, tool calls, attachments, slash-command
// requests, and provisional stream events) lives in ./chat.ts; re-exported here so this file
// stays the one import surface.

export type {
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMessageBody,
  AiToolCall,
  AlwaysAvailableResource,
  ChatAttachmentHandle,
  ChatAttachmentRef,
  MessageFormatRef,
  CapsuleSpecifier,
  SlashCommandId,
  SlashCommandRequest,
  SlashCommandChoice,
  AiChatStreamEvent,
} from "./chat.js";
export { isTextLikeAttachmentMimeType } from "./chat.js";

// --- Bots ---
// The bot grammar and both bot method faces (user bots on AuthenticatedApi, deployment bots on
// AdminApi) live in ./bots.ts; re-exported here so this file stays the one import surface.

export type {
  BotSkillRef,
  BotDefinition,
  BotSelection,
  BotInfo,
  BotSkillChoice,
} from "./bots.js";
export {
  MAX_BOT_NAME_LENGTH,
  MAX_BOT_DESCRIPTION_LENGTH,
  MAX_BOT_INSTRUCTIONS_LENGTH,
  MAX_BOT_SKILLS,
} from "./bots.js";

/** Interface implemented by the client to receive action-log upserts. */
export interface ActionsSubscriber {
  entry(record: ActionLogEntry): void;

  /**
   * @deprecated Fires after the subscription has caught up to the current time. However, this is
   * only a useful signal when a subscription is being used to enumerate past actions using a
   * distant-past `startAfter`. This is not the correct way to use `subscribeToActions()`; use
   * `listActions()` instead.
   */
  ready(): void;
}

/**
 * Interface implemented by the client to receive callback notifications whenever there is new
 * chat activity. Use Overseer.subscribeToChat() to register a subscriber.
 */
export interface AiChatSubscriber {
  /**
   * Sent exactly once, at the start of a subscription, before any other callbacks. Carries an
   * opaque value identifying the current server (Overseer DO) instance. If a resubscribing client
   * sees a different value than on its previous subscription, the DO has fully restarted since
   * then, meaning any in-flight provisional stream content was lost and will be re-streamed from
   * scratch; the client should discard its provisional streaming state. An unchanged value (a
   * plain network reconnect to the same live instance) means provisional state should be kept.
   */
  streamGeneration(generation: number): void;

  /** Metadata for the given chat thread has changed, or a new chat thread was created. */
  metadata(chat: AiChatMetadata): void;

  /** Indicates the chat thread was deleted. */
  deleted(chatId: number): void;

  /** Adds a message to the chat. */
  message(msg: AiChatMessage): void;

  /**
   * Delivers one accepted change of a chat's change stream: a human submitCodeChange(), an agent
   * tool edit (broadcast when the tool call completes, superseding the provisional editPreview*
   * stream of its in-progress content -- see AiChatStreamEvent). Changes must be applied in
   * revision order within a generation; a gap means events were lost and the client should
   * rebuild from fresh metadata and history. On a generation switch, first finish the old
   * generation's remaining changes -- complete once seen through
   * ChatCodeBase.prior.finalRevision -- before re-basing onto the new stream (see
   * ChatCodeBase.prior), and ignore stray events only for generations fully left behind.
   * Subscriptions replay each chat's not-yet-materialized changes, so newly-joined clients can
   * reconstruct uncommitted state without a separate fetch; changes a `changes` message has since
   * absorbed are dropped via the message's `watermark` instead (there is no separate "cleared"
   * event).
   *
   * Changes produced by submitCodeChange() echo the submitter's identity as `submission` (the
   * CodeChangeSubmission's clientId and seq), so the submitting client recognizes its own change
   * -- in the live feed and in subscribe-replay alike, without depending on ack/broadcast
   * ordering -- and drops its in-flight buffer instead of re-applying. The echo is informational
   * only; server-authored changes (agent edits) omit it.
   */
  changeApplied(chatId: number, generation: number, revision: number, author: AiChatAuthorInfo,
                change: CodeChange, submission?: {clientId: string, seq: number}): void;

  /** Delivers one provisional streaming event. Clients may ignore event types they don't support. */
  stream(chatId: number, event: AiChatStreamEvent): void;
}

/**
 * Interface implemented by the client to receive callback notifications about console logs written
 * by the gadget.
 */
export interface ConsoleLogSubscriber {
  /**
   * Deliver a batch of logs. Often just one log is delivered at a time, but for efficiency they
   * may be batched.
   *
   * If `chatId` is non-null, then the logs were generated while running the version of the gadget
   * code including the changes in the given chat. This can be used to associate the logs with
   * an ongoing agent session and report them to that session.
   */
  event(chatId: number | null, logs: ConsoleLogEvent[]): Promise<void>;
}

export type ConsoleLogEvent = {
  timestamp: Date;

  level: "debug" | "info" | "log" | "warn" | "error";

  /**
   * The parameters that were passed to the log function, represented as an array of serializable
   * values.
   */
  message: any[];
}
