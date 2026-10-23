import type { ChatCodeBase, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import type { ChatChangeRow } from "../code/otClient";

/**
 * The selected chat's live (accepted but not yet materialized) change row stream, delivered via
 * AiChatSubscriber.changeApplied() and buffered per chat. `subscribe` replays the currently
 * retained rows and then delivers each new row as it arrives -- synchronously from the
 * subscription callback, *before* the materialization watermark that absorbs it can prune the
 * buffer. That ordering is load-bearing: the server broadcasts a row and the "changes" message
 * that materializes it in the same step (e.g. at the live-window size cap), so a consumer fed
 * asynchronously would routinely miss the final row of each materialized batch. Rows a
 * consumer subscribes too late to see are covered by the durable snapshot's watermark instead
 * (see ChatCodeChanges.rowsThrough). Replay can redeliver rows a consumer has already seen;
 * consumers dedupe by stream position (the OT client does).
 */
export interface ChatLiveChangeRows {
  /** Which chat this stream belongs to (see ChatCodeChanges.chatId). */
  chatId: number;
  /** Subscribe to the row stream; returns the unsubscribe function. */
  subscribe(listener: (row: ChatChangeRow) => void): () => void;
}

/**
 * One event of the selected chat's edit-preview stream: the writeFile/editFile content the agent
 * is still generating (see AiChatStreamEvent's editPreviewStart for the model). `start` opens a
 * preview of the named call -- ending the previous call's delta stream, though *that* preview
 * stays displayed until its durable row or `clear` resolves it (tool calls execute only after
 * the whole model response streams, so several previews can finish before any row exists).
 * `delta` appends streamed text to the named call's preview; `clear` withdraws a preview whose
 * call will produce no row (it may name any call of the response, not just the streaming one);
 * `reset` is the mop-up that drops all preview state (turn ended, stream lost). The consumer
 * additionally resolves each preview when its durable change row arrives (see
 * WorkpieceCodeInterface), which is the ordinary end of a successful one.
 */
export type EditPreviewEvent = {
  kind: "start";
  toolCallId: string;
  workpieceId: WorkpieceId;
  filename: string;
  /** editFile's replaced text; absent for writeFile (the streamed text replaces the whole file). */
  textToReplace?: string;
} | {
  kind: "delta";
  toolCallId: string;
  delta: string;
} | {
  kind: "clear";
  toolCallId: string;
} | {
  kind: "reset";
};

/**
 * The selected chat's live edit-preview stream (see EditPreviewEvent), fed synchronously from
 * the chat subscription's stream events. `subscribe` replays the currently *streaming* preview
 * (as a start plus one delta) so a consumer attaching mid-stream still shows it; previews that
 * already finished streaming are not replayable -- a late joiner picks their content up from the
 * durable rows instead.
 */
export interface ChatLiveEditPreviews {
  /** Which chat this stream belongs to (see ChatCodeChanges.chatId). */
  chatId: number;
  /** Subscribe to the preview event stream; returns the unsubscribe function. */
  subscribe(listener: (event: EditPreviewEvent) => void): () => void;
}

/**
 * The currently-streaming preview retained per chat, for subscribe-time replay only (see
 * ChatLiveEditPreviews.subscribe).
 */
export type StreamingEditPreview = {
  toolCallId: string;
  workpieceId: WorkpieceId;
  filename: string;
  textToReplace?: string;
  text: string;
};

/**
 * The selected chat's durable code-branch state, as one consistent snapshot: the chat's current
 * ChatCodeBase (pins, generation, epoch -- `codeBase` absent when the chat has none yet, which
 * reads as `{pins: [], generation: 0, revision: 0}`) together with the current epoch's
 * non-reverted "changes" messages composed into one change. The two are always derived together
 * -- the code view builds the chat's content as pin base trees + `epochChange` + live rows, and
 * pairing a stale epoch's changes with a fresh epoch's pins (or vice versa) would transiently
 * build nonsense. `rowsThrough` is the current generation's revision the composed changes'
 * watermarks reach: rows at or below it are already inside `epochChange`, and only later rows
 * still apply on top (see AiChatMessageBody.watermark). `undefined` while no chat is selected or
 * its metadata/history hasn't loaded; `epochChange` absent when the chat has recorded no code
 * changes this epoch.
 */
export interface ChatCodeChanges {
  /**
   * Which chat this snapshot describes: parent-owned state updates lag a chat switch by a
   * render, so consumers must ignore a snapshot whose chatId doesn't match their selection.
   */
  chatId: number;
  codeBase?: ChatCodeBase;
  epochChange?: CodeChange;
  rowsThrough: number;
}

/**
 * The file an agent is currently streaming edits into. Files are identified by (workpiece,
 * filename) pairs since a chat can edit multiple gadgets.
 */
export type ActiveFileTarget = {
  workpieceId: WorkpieceId;
  filename: string;
};

/**
 * One chat's buffered live change rows (see ChatLiveChangeRows): append-only `rows` with `seen`
 * keys for dedupe (subscribe-replay redelivers retained rows). Pruning -- dropping rows a
 * materialization watermark covered or a destructive generation bump erased -- replaces `rows`
 * wholesale so consumers' cursors know to restart.
 */
export type ChatChangeRowBuffer = {
  rows: ChatChangeRow[];
  seen: Set<string>;
  /**
   * For the draft banner, which describes *human* draft edits only (rows carrying a
   * `submission`, i.e. produced by submitCodeChange -- agent edits flow through the same stream
   * but have their own streaming UI): when the newest such row arrived (rows don't carry
   * timestamps on the wire; arrival time is close enough for display).
   */
  lastUserEditAt: Date | null;
};

/**
 * Prune a chat's row buffer to the rows `keep` selects, replacing the array (a new identity
 * tells consumers to re-read from the start). Returns whether anything was dropped.
 */
export function pruneChatChangeRows(
  buffers: Map<number, ChatChangeRowBuffer>,
  chatId: number,
  keep: (row: ChatChangeRow) => boolean,
): boolean {
  const buffer = buffers.get(chatId);
  if (!buffer) return false;
  const kept = buffer.rows.filter(keep);
  if (kept.length === buffer.rows.length) return false;
  if (kept.length === 0) {
    buffers.delete(chatId);
    return true;
  }
  buffer.rows = kept;
  buffer.seen = new Set(kept.map(row => `${row.generation}:${row.revision}`));
  return true;
}
