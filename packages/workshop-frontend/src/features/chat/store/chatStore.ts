/**
 * The workspace chat store: one instance per workspace, owning the chat subscription's entire
 * client-side state — the durable cache (chats, messages, compaction boundaries, action-message
 * index), provisional streaming state, live change-row and edit-preview streams, and the
 * derived code-branch snapshot. Formerly the guts of `useChatSubscription` (FE-3): the store is
 * a plain class with no React dependency, so any component can read any slice through
 * `useSyncExternalStore` selectors (see useChatStore.ts) instead of one hook threading a bag of
 * refs and version counters through its children.
 *
 * Snapshot discipline: every `get*` selector returns a value whose identity is stable until
 * that slice actually changes (copy-on-write), which is what lets `useSyncExternalStore`
 * consumers skip re-renders and lets callers dedupe by `===` instead of re-deriving content
 * signatures (FE-8). High-frequency stream deltas mutate provisional state in place and commit
 * shallow copies once per animation frame — the committed identity is the re-render signal, so
 * no tick counter exists.
 */

import { RpcTarget, type RpcStub } from "capnweb";
import type {
  ActionLogEntry,
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMetadata,
  AiChatStreamEvent,
  AiChatSubscriber,
  Overseer,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import type { useKumoToastManager } from "@cloudflare/kumo";
import { reportIssue } from "../../../errorReporting";
import { logRpcFailure } from "../../../rpcErrors";
import { getStoredSelectedModel } from "../../../modelSelection";
import { actionLogResumed } from "../../../useActions";
import type { ChatChangeRow } from "../../code/otClient";
import {
  pruneChatChangeRows,
  type ActiveFileTarget,
  type ChatChangeRowBuffer,
  type ChatCodeChanges,
  type ChatLiveChangeRows,
  type ChatLiveEditPreviews,
  type EditPreviewEvent,
  type StreamingEditPreview,
} from "../liveCodeStreams";
import {
  clearProvisionalCodeState,
  clearProvisionalTextState,
  createProvisionalChatState,
  getOrCreateProvisionalToolCall,
  isProvisionalChatStateEmpty,
  type ProvisionalChatState,
} from "../provisionalChatState";
import {
  computeChatEpochChanges,
  type CompactionBoundary,
} from "../transcript/chatDisplayEntries";

/** The host app's toast manager, registered when the subscription opens. */
export type Toasts = ReturnType<typeof useKumoToastManager>;

/** Navigates the app's chat route; used by store-driven redirects (deleted chat, failed load). */
export type NavigateToChat = (
  chatId: number | null,
  options?: { replace?: boolean },
) => void;

/** One indexed location of an action card in the message cache. */
interface ActionMessageLocation {
  chatId: number;
  sequence: number;
}

/**
 * Identity-preserving metadata ingest (FE-8): the server redelivers chat metadata wholesale on
 * every activity bump (lastActive, title, ...), but most deliveries change nothing the UI reads.
 * Reusing the previous object — and within it the previous `codeBase` and
 * `proposedChangeWorkpieces`, whose identities key derived effects — keeps those consumers from
 * churning on no-op redeliveries.
 */
function reconcileMetadata(prev: AiChatMetadata | undefined, next: AiChatMetadata): AiChatMetadata {
  if (prev === undefined) return next;
  const merged = { ...next };
  if (prev.codeBase !== undefined && merged.codeBase !== undefined &&
      JSON.stringify(prev.codeBase) === JSON.stringify(merged.codeBase)) {
    merged.codeBase = prev.codeBase;
  }
  if (prev.proposedChangeWorkpieces !== undefined && merged.proposedChangeWorkpieces !== undefined &&
      prev.proposedChangeWorkpieces.join(",") === merged.proposedChangeWorkpieces.join(",")) {
    merged.proposedChangeWorkpieces = prev.proposedChangeWorkpieces;
  }
  return merged;
}

/** Whether two metadata deliveries are observationally equivalent (same content, any identity). */
function metadataEquals(a: AiChatMetadata, b: AiChatMetadata): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export class ChatStore {
  readonly workspaceId: string;

  /** Registered `useSyncExternalStore` listeners; notified after every committed slice change. */
  readonly #listeners = new Set<() => void>();

  // ── durable cache (survives reconnects) ─────────────────────────────────────
  /** Live metadata by chat id; the chat-list snapshot is derived from it. */
  readonly #chats = new Map<number, AiChatMetadata>();
  /** Message arrays by chat id, sparse-indexed by sequence (idempotent under redelivery). */
  readonly #messages = new Map<number, AiChatMessage[]>();
  /** Compaction boundaries by chat id, oldest first. */
  readonly #compacted = new Map<number, CompactionBoundary[]>();
  /** Action-id → message locations, for patching cached action cards. */
  readonly #actionMessages = new Map<number, Map<string, ActionMessageLocation>>();
  /** Resume watermark for resubscribes (see Overseer.subscribeToChat's `startAfter`). */
  #lastMessageTimestamp: Date | null = null;

  // ── streaming state ────────────────────────────────────────────────────────
  /** Live (mutated in place) provisional state by chat id; committed copies feed selectors. */
  readonly #provisional = new Map<number, ProvisionalChatState>();
  /** Committed provisional identities by chat id — replaced on rAF commits and discards. */
  readonly #provisionalCommitted = new Map<number, ProvisionalChatState>();
  /** Chats whose provisional state mutated since the last rAF commit. */
  readonly #provisionalDirty = new Set<number>();
  #provisionalFlushScheduled = false;

  /** Per-chat live change-row buffers (see ChatChangeRowBuffer). */
  readonly #rows = new Map<number, ChatChangeRowBuffer>();
  /** Committed row-buffer identities — new object per mutation, for the draft banner. */
  readonly #rowsCommitted = new Map<number, ChatChangeRowBuffer>();
  /** Live-row listeners by chat, notified synchronously from ingestChangeApplied. */
  readonly #rowListeners = new Map<number, Set<(row: ChatChangeRow) => void>>();

  /** Per-chat streaming edit previews (retained for subscribe-time replay). */
  readonly #editPreviews = new Map<number, StreamingEditPreview>();
  /** Edit-preview event listeners by chat, notified synchronously from stream events. */
  readonly #editPreviewListeners = new Map<number, Set<(event: EditPreviewEvent) => void>>();

  /** Last server-instance generation seen; detects full DO restarts (streamGeneration). */
  #lastStreamGeneration: number | undefined;

  // ── derived snapshots ──────────────────────────────────────────────────────
  #chatListSnapshot: readonly AiChatMetadata[] = [];
  #chatListDirty = false;
  #anyProposedSnapshot: readonly number[] = [];
  #anyProposedDirty = false;
  #messagesSnapshots = new Map<number, readonly AiChatMessage[]>();
  #compactionsSnapshots = new Map<number, readonly CompactionBoundary[]>();
  #liveRows = new Map<number, ChatLiveChangeRows>();
  #liveEditPreviews = new Map<number, ChatLiveEditPreviews>();

  // ── code-branch snapshot (computeChatEpochChanges fold) ─────────────────────
  #codeChanges = new Map<number, ChatCodeChanges>();
  #codeChangesInputs = new Map<number, string>();

  // ── list/load state ────────────────────────────────────────────────────────
  #chatListReady = false;
  #modelsSnapshot: readonly AiChatAuthorInfo[] = [];
  #selectedModel: string | null = null;
  readonly #historyLoaded = new Set<number>();
  readonly #historyLoading = new Set<number>();
  /** Chats whose oldest loaded boundary a revert reached past (see refreshStaleBoundary). */
  readonly #staleBoundaryChats = new Set<number>();

  // ── subscription plumbing ──────────────────────────────────────────────────
  #connection: {
    overseer: RpcStub<Overseer>;
    toasts: Toasts;
    onNavigateToChat: NavigateToChat;
    subscription: { [Symbol.dispose](): void } | null;
    selectedChatId: number | null;
  } | null = null;
  /** Stubs whose onRpcBroken handler is already registered (capnweb has no unregister). */
  readonly #rpcBrokenRegistered = new Set<RpcStub<Overseer>>();
  /**
   * Synchronous notification for the selected chat's streaming file target: the per-frame
   * selector re-renders too late for the editor tab to follow the very first file of a turn.
   */
  #onStreamingActiveFile:
    | ((chatId: number, file: ActiveFileTarget | null | undefined) => void)
    | undefined;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  // ── subscription lifecycle ─────────────────────────────────────────────────

  /**
   * Opens (or re-opens) the chat subscription on `overseer`. Called from the owning component's
   * effect, so it may run again with a fresh stub after a reconnect: the durable cache survives,
   * the old subscription is disposed, and the new one resumes from the last message timestamp.
   * `toasts` and `onNavigateToChat` are refreshed on every call — they arrive as fresh objects
   * each render.
   */
  open(
    overseer: RpcStub<Overseer>,
    toasts: Toasts,
    onNavigateToChat: NavigateToChat,
    selectedChatId: number | null,
  ): void {
    const previous = this.#connection;
    if (previous?.overseer === overseer) {
      previous.toasts = toasts;
      previous.onNavigateToChat = onNavigateToChat;
      previous.selectedChatId = selectedChatId;
      return;
    }
    if (previous) previous.subscription?.[Symbol.dispose]();

    const connection = {
      overseer,
      toasts,
      onNavigateToChat,
      subscription: null as { [Symbol.dispose](): void } | null,
      selectedChatId,
    };
    this.#connection = connection;

    try {
      // Subscribe using the last message timestamp so the replay covers the gap (at-least-once:
      // every fold below is idempotent). The promise is stored, not awaited — capnweb RpcPromises
      // resolve only on disconnect, and the disposable promise itself is the pipelined stub.
      connection.subscription = overseer.subscribeToChat(
        new ChatSubscriber(this),
        this.#lastMessageTimestamp ?? undefined,
      );

      // After subscribing, load the chat list and models: the subscription covers any change
      // from here on, so the list can never miss activity between fetch and subscribe.
      void (async () => {
        try {
          // A revert may have marked boundaries stale while disconnected; their refetch can
          // start now that the subscription is re-established.
          for (const chatId of this.#staleBoundaryChats) void this.refreshStaleBoundary(chatId);
          const [chats, models] = await Promise.all([
            overseer.listChats(),
            overseer.listModels(),
          ]);
          if (this.#connection !== connection) return;
          for (const chat of chats) this.ingestMetadata(chat);
          this.#chatListReady = true;
          this.#modelsSnapshot = models;
          this.#selectedModel = getStoredSelectedModel(models);
          this.#notify();
        } catch (err) {
          if (!logRpcFailure("Failed to subscribe to chats:", err)) {
            reportIssue("chat.subscription-load", err);
            toasts.add({ title: "Unable to load conversations", variant: "error" });
          }
        }
      })();
    } catch (err) {
      if (!logRpcFailure("Failed to subscribe to chats:", err)) {
        reportIssue("chat.subscription-load", err);
        toasts.add({ title: "Unable to load conversations", variant: "error" });
      }
    }

    // capnweb's onRpcBroken has no unregister: each call attaches another rejection handler to
    // the stub's session promise, so guard to at most one registration per stub.
    if (!this.#rpcBrokenRegistered.has(overseer)) {
      this.#rpcBrokenRegistered.add(overseer);
      overseer.onRpcBroken?.(() => {
        // The cache persists; the owner re-opens on the fresh stub.
        this.#connection = null;
      });
    }
  }

  /** Disposes the live subscription (the cache stays for the next open). */
  close(): void {
    this.#connection?.subscription?.[Symbol.dispose]();
    this.#connection = null;
  }

  /** The chat the owner currently has selected; drives store-driven redirects. */
  setSelectedChatId(chatId: number | null): void {
    if (this.#connection) this.#connection.selectedChatId = chatId;
  }

  /** Sets the streaming-file notification (a fresh closure each render is fine). */
  setOnStreamingActiveFile(
    handler: ((chatId: number, file: ActiveFileTarget | null | undefined) => void) | undefined,
  ): void {
    this.#onStreamingActiveFile = handler;
  }

  /**
   * Loads `chatId`'s history once (the subscription only delivers new messages). On failure —
   * e.g. a stale URL — navigates back to the chat list.
   */
  ensureHistory(chatId: number): void {
    if (this.#historyLoaded.has(chatId) || this.#historyLoading.has(chatId)) return;
    const connection = this.#connection;
    if (!connection) return;
    this.#historyLoading.add(chatId);
    this.#notify();
    void (async () => {
      try {
        const page = await connection.overseer.getChatHistory(chatId);
        this.#historyLoading.delete(chatId);
        this.#ingestHistoryPage(chatId, page);
      } catch (err) {
        console.error("Failed to load chat history:", err);
        this.#historyLoading.delete(chatId);
        this.#notify();
        connection.onNavigateToChat(null, { replace: true });
      }
    })();
  }

  /**
   * On a resumed reconnect the actions subscription replays the log's gap, covering cached
   * action cards. Otherwise (cold open) re-fetch cached action cards whose log can still change:
   * blank or pending cards, and bindHook cards, which stay mutable after resolution. A few at a
   * time — a large cache refreshing all at once would flood the workspace DO. Returns a
   * cancellation handle for the owning effect's cleanup.
   */
  refreshMutableActionCards(): (() => void) | undefined {
    const connection = this.#connection;
    if (!connection || actionLogResumed(connection.overseer)) return undefined;
    let cancelled = false;
    const targets = [...this.#actionMessages.values()].flatMap((locations) => {
      const location = locations.values().next().value;
      const msg = location && this.#cachedActionMessage(location)?.msg;
      return msg && (!msg.actionLog || msg.actionLog.state === "pending" ||
          msg.actionLog.type === "bindHook") ? [location] : [];
    });
    const refresh = async (location: ActionMessageLocation) => {
      try {
        const fetched = await connection.overseer.getChatMessage(location.chatId, location.sequence);
        if (cancelled || fetched?.type !== "action" || !fetched.actionLog) return;
        // Resolution is monotonic: never regress a card another channel already resolved.
        const current = this.#cachedActionMessage(location)?.msg;
        if (fetched.actionLog.state === "pending" &&
            current?.actionLog && current.actionLog.state !== "pending") return;
        this.#rewriteActionMessages(fetched.actionLog.id, () =>
          ({ ...this.#cachedActionMessage(location)!.msg, actionLog: fetched.actionLog! }));
      } catch (err) {
        console.error("Failed to refresh action card:", err);
      }
    };
    let next = 0;
    for (let i = Math.min(4, targets.length); i > 0; i--) {
      void (async () => {
        while (next < targets.length) {
          if (cancelled) return;
          await refresh(targets[next++]);
        }
      })();
    }
    return () => { cancelled = true; };
  }

  // ── ingest (wire → cache) ──────────────────────────────────────────────────

  /** The subscriber's `metadata` fold. */
  ingestMetadata(chat: AiChatMetadata): void {
    const prev = this.#chats.get(chat.id);
    const next = reconcileMetadata(prev, chat);
    if (prev !== undefined && metadataEquals(prev, next)) {
      // No-op redelivery: keep the previous identity so derived consumers hold steady. No
      // transition can hide in it — any field change (activeAgent, compactedTo, codeBase)
      // breaks the equality.
      return;
    }

    // When the agent stops running (activeAgent becomes unset), do a final full clear of this
    // chat's provisional streaming state — a mop-up in case the final message/clear events that
    // ordinarily retire it were missed.
    if (prev?.activeAgent && !chat.activeAgent) {
      this.#provisional.delete(chat.id);
      this.#commitProvisional(chat.id);
      this.#resetEditPreviews(chat.id);
    }

    // A compaction that lands while the chat is open publishes a boundary the client only gets
    // with a page, so refetch. Asking whether that boundary is already loaded makes it
    // idempotent: paging back adds boundaries rather than replacing them.
    if (this.#messages.has(chat.id) && chat.compactedTo !== undefined &&
        !this.#compacted.get(chat.id)?.some(({ to }) => to === chat.compactedTo)) {
      void this.#refreshBoundary(chat.id);
    }

    // A generation bump obsoletes buffered rows: a *destructive* bump (revert / draft discard —
    // no `prior`) erased every row, so drop them all; a content-preserving bump (a merge's epoch
    // reset) retires the closed generation's rows but the code view may still be draining its
    // tail, so keep exactly the prior generation and the new one. (The buffers are advisory
    // replay caches — the OT client dedupes on its own stream position.)
    const codeBase = chat.codeBase;
    if (prev !== undefined && codeBase !== undefined &&
        (prev.codeBase?.generation ?? 0) !== codeBase.generation) {
      const keepFrom = codeBase.prior?.generation ?? codeBase.generation;
      if (pruneChatChangeRows(this.#rows, chat.id, (row) => row.generation >= keepFrom)) {
        this.#rowsCommitted.delete(chat.id);
      }
    }

    this.#chats.set(chat.id, next);
    this.#chatListDirty = true;
    this.#anyProposedDirty = true;

    this.#notify();
  }

  /** The subscriber's `deleted` fold: forget the chat everywhere and leave it if selected. */
  ingestDeleted(chatId: number): void {
    this.#chats.delete(chatId);
    this.#messages.delete(chatId);
    this.#messagesSnapshots.delete(chatId);
    this.#compacted.delete(chatId);
    this.#compactionsSnapshots.delete(chatId);
    this.#removeChatFromActionMessageIndex(chatId);
    this.#provisional.delete(chatId);
    this.#provisionalCommitted.delete(chatId);
    this.#provisionalDirty.delete(chatId);
    this.#editPreviews.delete(chatId);
    this.#rows.delete(chatId);
    this.#rowsCommitted.delete(chatId);
    this.#historyLoaded.delete(chatId);
    this.#historyLoading.delete(chatId);
    this.#codeChanges.delete(chatId);
    this.#codeChangesInputs.delete(chatId);
    this.#chatListDirty = true;
    this.#anyProposedDirty = true;

    // If currently viewing this chat, go back to the list; replace so browser-back cannot
    // return to the deleted chat.
    if (this.#connection?.selectedChatId === chatId) {
      this.#connection.onNavigateToChat(null, { replace: true });
    }
    this.#notify();
  }

  /** The subscriber's `changeApplied` fold: idempotent by generation:revision. */
  ingestChangeApplied(
    chatId: number,
    generation: number,
    revision: number,
    author: AiChatAuthorInfo,
    change: CodeChange,
    submission?: { clientId: string; seq: number },
  ): void {
    let buffer = this.#rows.get(chatId);
    if (!buffer) {
      buffer = { rows: [], seen: new Set(), lastUserEditAt: null };
      this.#rows.set(chatId, buffer);
    }
    // Dedupe: subscribe-replay redelivers every retained row.
    const key = `${generation}:${revision}`;
    if (buffer.seen.has(key)) return;
    buffer.seen.add(key);
    const row: ChatChangeRow = {
      generation, revision, author, change,
      ...(submission !== undefined ? { submission } : {}),
    };
    buffer.rows.push(row);
    if (submission !== undefined) {
      // Only human submissions drive the draft banner (see ChatChangeRowBuffer).
      buffer.lastUserEditAt = new Date();
    }
    this.#rowsCommitted.delete(chatId);
    // Deliver to subscribers synchronously: the message that materializes this row may prune it
    // from the buffer before any effect runs.
    this.#rowListeners.get(chatId)?.forEach((listener) => listener(row));
    this.#notify();
  }

  /** The subscriber's `message` fold: durable-cache append, idempotent by sequence. */
  ingestMessage(msg: AiChatMessage): void {
    let messages = this.#messages.get(msg.chatId);
    if (!messages) {
      messages = [];
      this.#messages.set(msg.chatId, messages);
    }

    // Set at sequence index — idempotent under redelivery.
    messages[msg.sequence] = msg;
    this.#messagesSnapshots.delete(msg.chatId);
    this.#indexActionMessage(msg);

    if (!this.#lastMessageTimestamp || msg.timestamp > this.#lastMessageTimestamp) {
      this.#lastMessageTimestamp = msg.timestamp;
    }

    // A revert reaching past the oldest loaded boundary changed it on the server: hold the chat
    // until the boundary's page is refetched (the code view would rebuild on the old blob, and
    // the OT client rebuilds only on a generation change).
    if (msg.type === "revert") {
      const oldest = this.#compacted.get(msg.chatId)?.[0];
      if (oldest !== undefined && msg.revertFrom < oldest.to) {
        this.#staleBoundaryChats.add(msg.chatId);
        void this.refreshStaleBoundary(msg.chatId);
      }
    }

    // A "changes" message's watermark absorbs the rows it materialized; drop our copies. Rows
    // of other generations are untouched — revisions restart per generation, so an unqualified
    // prune could clear the wrong stream's rows.
    if (msg.type === "changes" && msg.watermark !== undefined) {
      const { changesGeneration, throughRevision } = msg.watermark;
      if (pruneChatChangeRows(this.#rows, msg.chatId, (row) =>
          row.generation !== changesGeneration || row.revision > throughRevision)) {
        this.#rowsCommitted.delete(msg.chatId);
      }
    }

    // The turn-flush "changes" message covers every row a successful edit appended, and an
    // error message ends the step — either way this step's previews are over (ordinarily each
    // previewed edit's own row already resolved them).
    if (msg.type === "changes" || msg.type === "error") {
      this.#resetEditPreviews(msg.chatId);
    }

    const provisional = this.#provisional.get(msg.chatId);
    if (provisional) {
      if (msg.type === "message") {
        clearProvisionalTextState(provisional);
      } else if (msg.type === "changes") {
        clearProvisionalCodeState(provisional);
      } else if (msg.type === "error") {
        clearProvisionalTextState(provisional);
        clearProvisionalCodeState(provisional);
      }
      if (isProvisionalChatStateEmpty(provisional)) {
        this.#provisional.delete(msg.chatId);
      }
      this.#commitProvisional(msg.chatId);
    }

    if (msg.type === "changes" || msg.type === "revert") {
      // Change-affecting message: force the code-branch snapshot's recompute (see
      // getCodeChanges). "merge" is excluded — the epoch reset it performs reaches the doc
      // through the metadata's codeBase, redelivered with the merge; recomputing here as well
      // would race the metadata and transiently pair the old epoch's updates with the new
      // epoch's (empty) pin set.
      this.#codeChanges.delete(msg.chatId);
      this.#codeChangesInputs.delete(msg.chatId);
    }
    this.#notify();
  }

  /** The subscriber's `streamGeneration` fold: a DO restart discards in-flight streams. */
  ingestStreamGeneration(generation: number): void {
    if (this.#lastStreamGeneration !== undefined &&
        this.#lastStreamGeneration !== generation) {
      // The DO fully restarted since our last subscription; any in-flight provisional streams
      // were lost and will be re-streamed from scratch, so discard stale provisional state
      // rather than append to it. Clearing all chats is safe: provisional state is ephemeral.
      this.#provisional.clear();
      this.#provisionalCommitted.clear();
      this.#provisionalDirty.clear();
      // Reset every subscribed chat's previews, not just those with a streaming entry:
      // consumers also hold finished previews awaiting rows that were lost with the DO.
      for (const chatId of this.#editPreviewListeners.keys()) this.#resetEditPreviews(chatId);
      this.#notify();
    }
    this.#lastStreamGeneration = generation;
  }

  /** The subscriber's `stream` fold: provisional streaming state, committed per frame. */
  ingestStream(chatId: number, event: AiChatStreamEvent): void {
    let provisional = this.#provisional.get(chatId);
    if (!provisional) {
      provisional = createProvisionalChatState();
      this.#provisional.set(chatId, provisional);
    }

    switch (event.type) {
      case "streamReset":
        // A failed model request is being retried: drop everything it streamed, as an error
        // message would, so the retry's output doesn't append to the failed attempt's.
        clearProvisionalTextState(provisional);
        clearProvisionalCodeState(provisional);
        this.#resetEditPreviews(chatId);
        break;
      case "compacting":
        provisional.compacting = true;
        break;
      case "compacted":
        provisional.compacting = false;
        if (event.nothingToCompact) {
          this.#connection?.toasts.add({
            title: "Nothing to compact — there are no earlier messages to summarize.",
          });
        }
        break;
      case "textDelta":
        provisional.text += event.delta;
        break;
      case "reasoningDelta":
        provisional.reasoning += event.delta;
        break;
      case "toolCallStarted":
        getOrCreateProvisionalToolCall(provisional, event.toolCallId, event.toolName);
        break;
      case "toolCodeDelta": {
        const toolCall = getOrCreateProvisionalToolCall(provisional, event.toolCallId, null);
        toolCall.code += event.delta;
        break;
      }
      case "toolOutputDelta": {
        const toolCall = getOrCreateProvisionalToolCall(provisional, event.toolCallId, null);
        toolCall.output += event.delta;
        break;
      }
      case "toolCallFinished": {
        const toolCall = getOrCreateProvisionalToolCall(provisional, event.toolCallId, null);
        toolCall.finished = true;
        break;
      }
      case "setActiveFile":
        provisional.activeEditingFile = event.file ?? null;
        // The per-frame commit re-renders first; telling the editor straight away lets the tab
        // follow the very first file of a turn.
        if (chatId === this.#connection?.selectedChatId) {
          this.#onStreamingActiveFile?.(chatId, event.file ?? null);
        }
        break;
      case "toolCallOutputFormat": {
        const toolCall = getOrCreateProvisionalToolCall(provisional, event.toolCallId, null);
        toolCall.outputFormat = event.output;
        break;
      }
      case "toolCallTarget": {
        // Surfaces the file name during streaming for writes and edits so the frontend updates.
        const toolCall = getOrCreateProvisionalToolCall(provisional, event.toolCallId, null);
        toolCall.target = event.file.filename;
        break;
      }
      case "editPreviewStart":
        this.#editPreviews.set(chatId, {
          toolCallId: event.toolCallId,
          workpieceId: event.file.workpieceId,
          filename: event.file.filename,
          ...(event.textToReplace !== undefined ? { textToReplace: event.textToReplace } : {}),
          text: "",
        });
        this.#emitEditPreviewEvent(chatId, {
          kind: "start",
          toolCallId: event.toolCallId,
          workpieceId: event.file.workpieceId,
          filename: event.file.filename,
          ...(event.textToReplace !== undefined ? { textToReplace: event.textToReplace } : {}),
        });
        break;
      case "editPreviewDelta": {
        const preview = this.#editPreviews.get(chatId);
        if (preview !== undefined && preview.toolCallId === event.toolCallId) {
          preview.text += event.delta;
        }
        this.#emitEditPreviewEvent(chatId,
          { kind: "delta", toolCallId: event.toolCallId, delta: event.delta });
        break;
      }
      case "editPreviewClear": {
        const preview = this.#editPreviews.get(chatId);
        if (preview !== undefined && preview.toolCallId === event.toolCallId) {
          this.#editPreviews.delete(chatId);
        }
        // Forwarded regardless of which call it names: a failed call's clear arrives at
        // execution time, when a later call's preview may already be the streaming one, and
        // the consumer still holds the named call's finished preview.
        this.#emitEditPreviewEvent(chatId, { kind: "clear", toolCallId: event.toolCallId });
        break;
      }
    }

    if (isProvisionalChatStateEmpty(provisional)) {
      this.#provisional.delete(chatId);
    }
    this.#provisionalDirty.add(chatId);
    this.#scheduleProvisionalFlush();
  }

  // ── history pages ──────────────────────────────────────────────────────────

  /**
   * Folds one history page into the cache. Messages land at their sequence index, so filling in
   * an older page and re-receiving a message the subscription already delivered are both
   * harmless. The page's boundary joins the ones already known, keyed by its cut so the same
   * page fetched twice contributes one marker.
   */
  #ingestHistoryPage(chatId: number, page: AiChatHistoryPage): void {
    let messages = this.#messages.get(chatId);
    if (!messages) {
      messages = [];
      this.#messages.set(chatId, messages);
    }
    for (const msg of page.messages) {
      messages[msg.sequence] = msg;
      this.#indexActionMessage(msg);
    }
    this.#messagesSnapshots.delete(chatId);

    const last = page.messages[page.messages.length - 1];
    if (last && (!this.#lastMessageTimestamp || last.timestamp > this.#lastMessageTimestamp)) {
      this.#lastMessageTimestamp = last.timestamp;
    }

    if (page.compacted) {
      const boundaries = this.#compacted.get(chatId) ?? [];
      this.#compacted.set(chatId, [
        ...boundaries.filter(({ to }) => to !== page.compacted!.to),
        page.compacted,
      ].toSorted((a, b) => a.to - b.to));
      this.#compactionsSnapshots.delete(chatId);
    }

    this.#historyLoaded.add(chatId);
    // The page may backfill change-affecting messages behind an unchanged epoch key.
    this.#codeChanges.delete(chatId);
    this.#codeChangesInputs.delete(chatId);
    this.#notify();
  }

  /**
   * Loads one page into the cache (the transcript's earlier-page prefetch). Returns whether the
   * page loaded, so the caller can keep its scroll anchoring honest.
   */
  async loadHistoryPage(chatId: number, beforeSequence?: number): Promise<boolean> {
    const connection = this.#connection;
    if (!connection) return false;
    try {
      const page = await connection.overseer.getChatHistory(chatId, beforeSequence);
      this.#ingestHistoryPage(chatId, page);
      return true;
    } catch (err) {
      console.error("Failed to load earlier messages:", err);
      connection.toasts.add({ title: "Failed to load earlier messages", variant: "error" });
      return false;
    }
  }

  /** Refetches the newest page (or the one before `beforeSequence`), e.g. for a new boundary. */
  async #refreshBoundary(chatId: number, beforeSequence?: number): Promise<boolean> {
    const connection = this.#connection;
    if (!connection) return false;
    try {
      const page = await connection.overseer.getChatHistory(chatId, beforeSequence);
      this.#ingestHistoryPage(chatId, page);
      return true;
    } catch (err) {
      reportIssue("chat.compaction-boundary-refresh", err, { handled: true });
      return false;
    }
  }

  /**
   * Refetches a stale chat's oldest boundary, then releases its code view. The page before
   * `to + 1` is the one message at that boundary, so the server returns exactly that checkpoint.
   * A failed refetch keeps the hold until the next subscription.
   */
  async refreshStaleBoundary(chatId: number): Promise<void> {
    const oldest = this.#compacted.get(chatId)?.[0];
    if (oldest === undefined || await this.#refreshBoundary(chatId, oldest.to + 1)) {
      this.#staleBoundaryChats.delete(chatId);
      this.#codeChanges.delete(chatId);
      this.#codeChangesInputs.delete(chatId);
      this.#notify();
    }
  }

  // ── action-message patching ────────────────────────────────────────────────

  #indexActionMessage(msg: AiChatMessage): void {
    if (msg.type !== "action") return;
    let locations = this.#actionMessages.get(msg.actionId);
    if (!locations) {
      locations = new Map();
      this.#actionMessages.set(msg.actionId, locations);
    }
    locations.set(`${msg.chatId}:${msg.sequence}`, { chatId: msg.chatId, sequence: msg.sequence });
  }

  #removeChatFromActionMessageIndex(chatId: number): void {
    for (const [actionId, locations] of this.#actionMessages) {
      for (const [key, location] of locations) {
        if (location.chatId === chatId) locations.delete(key);
      }
      if (locations.size === 0) this.#actionMessages.delete(actionId);
    }
  }

  /** Resolves an indexed location to its cached action message, if still an action card. */
  #cachedActionMessage(location: ActionMessageLocation) {
    const messages = this.#messages.get(location.chatId);
    const msg = messages?.[location.sequence];
    return msg?.type === "action" ? { messages: messages!, msg } : undefined;
  }

  /**
   * Rewrites every cached card of one action through `rewrite`, dropping index entries whose
   * message is gone or no longer an action card. One mechanism for every patch path — the
   * action-log upsert, optimistic approve/reject, and the optimistic hook toggle — formerly
   * three near-identical patchers.
   */
  #rewriteActionMessages(
    actionId: number,
    rewrite: (msg: AiChatMessage & { type: "action" }) => AiChatMessage,
  ): void {
    const locations = this.#actionMessages.get(actionId);
    if (!locations) return;

    let changed = false;
    for (const [key, location] of locations) {
      const cached = this.#cachedActionMessage(location);
      if (!cached || cached.msg.actionId !== actionId) {
        locations.delete(key);
        continue;
      }
      const nextMessages = [...cached.messages];
      nextMessages[location.sequence] = rewrite(cached.msg);
      this.#messages.set(location.chatId, nextMessages);
      this.#messagesSnapshots.delete(location.chatId);
      changed = true;
    }

    if (locations.size === 0) this.#actionMessages.delete(actionId);
    if (changed) this.#notify();
  }

  /** Applies an action-log upsert (from the actions subscription) to every cached card. */
  patchActionMessagesFromLog(record: ActionLogEntry): void {
    this.#rewriteActionMessages(record.id, (msg) => ({ ...msg, actionLog: record }));
  }

  /** Optimistically flips a pending card to approved/rejected (see useResolveAction). */
  applyOptimisticActionState(actionId: number, state: "approved" | "rejected"): void {
    this.#rewriteActionMessages(actionId, (msg) => msg.actionLog
      ? { ...msg, actionLog: { ...msg.actionLog, state, appliedAt: new Date() } }
      : msg);
  }

  /** Optimistically toggles a bindHook card's enabled flag (see handleToggleHook). */
  applyOptimisticHookEnabled(actionId: number, enabled: boolean): void {
    this.#rewriteActionMessages(actionId, (msg) => msg.actionLog?.type === "bindHook"
      ? { ...msg, actionLog: { ...msg.actionLog, enabled } }
      : msg);
  }

  // ── local (optimistic) metadata edits ──────────────────────────────────────

  /** Renames a chat locally, before/without the server round-trip (see useChatListActions). */
  renameChatLocally(chatId: number, title: string): void {
    const chat = this.#chats.get(chatId);
    if (!chat) return;
    this.#chats.set(chatId, { ...chat, title });
    this.#chatListDirty = true;
    this.#notify();
  }

  // ── edit-preview plumbing ──────────────────────────────────────────────────

  #emitEditPreviewEvent(chatId: number, event: EditPreviewEvent): void {
    this.#editPreviewListeners.get(chatId)?.forEach((listener) => listener(event));
  }

  /** The turn-boundary mop-up: drop all of a chat's preview state (see EditPreviewEvent.reset). */
  #resetEditPreviews(chatId: number): void {
    this.#editPreviews.delete(chatId);
    this.#emitEditPreviewEvent(chatId, { kind: "reset" });
  }

  // ── provisional commit machinery ───────────────────────────────────────────

  #scheduleProvisionalFlush(): void {
    if (this.#provisionalFlushScheduled) return;
    this.#provisionalFlushScheduled = true;
    requestAnimationFrame(() => {
      this.#provisionalFlushScheduled = false;
      for (const chatId of this.#provisionalDirty) this.#commitProvisional(chatId);
      this.#provisionalDirty.clear();
      this.#notify();
    });
  }

  /** Publishes a fresh committed identity for one chat's provisional state (see getProvisional). */
  #commitProvisional(chatId: number): void {
    const state = this.#provisional.get(chatId);
    if (state === undefined) {
      this.#provisionalCommitted.delete(chatId);
      return;
    }
    this.#provisionalCommitted.set(chatId, { ...state });
  }

  // ── selectors (stable identity per slice) ──────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** All chats, most recently active first. New identity only when a chat actually changed. */
  getChatList(): readonly AiChatMetadata[] {
    if (this.#chatListDirty) {
      this.#chatListSnapshot = Array.from(this.#chats.values()).toSorted(
        (a, b) => b.lastActive.getTime() - a.lastActive.getTime(),
      );
      this.#chatListDirty = false;
    }
    return this.#chatListSnapshot;
  }

  getChatListReady(): boolean {
    return this.#chatListReady;
  }

  getChat(chatId: number | null): AiChatMetadata | undefined {
    return chatId === null ? undefined : this.#chats.get(chatId);
  }

  /** The chat's messages, dense, ascending — identity changes only when they do. */
  getMessages(chatId: number | null): readonly AiChatMessage[] {
    if (chatId === null) return EMPTY_MESSAGES;
    let snapshot = this.#messagesSnapshots.get(chatId);
    if (snapshot === undefined) {
      snapshot = (this.#messages.get(chatId) ?? []).filter(
        (msg): msg is AiChatMessage => msg !== undefined,
      );
      this.#messagesSnapshots.set(chatId, snapshot);
    }
    return snapshot;
  }

  getCompactions(chatId: number | null): readonly CompactionBoundary[] {
    if (chatId === null) return EMPTY_COMPACTIONS;
    let snapshot = this.#compactionsSnapshots.get(chatId);
    if (snapshot === undefined) {
      snapshot = this.#compacted.get(chatId) ?? [];
      this.#compactionsSnapshots.set(chatId, snapshot);
    }
    return snapshot;
  }

  /** Whether the chat's first history page has loaded (gates the code-branch snapshot). */
  isHistoryLoaded(chatId: number | null): boolean {
    return chatId !== null && this.#historyLoaded.has(chatId);
  }

  getIsLoadingHistory(chatId: number | null): boolean {
    return chatId !== null && this.#historyLoading.has(chatId);
  }

  /**
   * The chat's committed provisional streaming state. Stream deltas mutate the live object in
   * place; the committed identity is replaced once per frame (or synchronously on discards), so
   * consumers re-render exactly when there is something new to show.
   */
  getProvisional(chatId: number | null): ProvisionalChatState | null {
    if (chatId === null) return null;
    return this.#provisionalCommitted.get(chatId) ?? null;
  }

  /** The chat's live change-row buffer (draft banner input); identity per mutation. */
  getRowBuffer(chatId: number | null): ChatChangeRowBuffer | null {
    if (chatId === null) return null;
    let snapshot = this.#rowsCommitted.get(chatId);
    if (snapshot === undefined) {
      const buffer = this.#rows.get(chatId);
      if (buffer === undefined) return null;
      snapshot = { rows: [...buffer.rows], seen: buffer.seen, lastUserEditAt: buffer.lastUserEditAt };
      this.#rowsCommitted.set(chatId, snapshot);
    }
    return snapshot;
  }

  /**
   * The chat's derived code-branch snapshot (see ChatCodeChanges): its code base plus the
   * current epoch's recorded changes, computed together so the code view never pairs one's
   * stale value with the other's fresh one. Undefined until the chat's metadata and messages
   * have arrived and no loaded boundary is stale. Keyed on the inputs' content, so
   * appends that cannot move the fold and metadata redeliveries that change nothing
   * recompute nothing (FE-8).
   */
  getCodeChanges(chatId: number | null): ChatCodeChanges | undefined {
    if (chatId === null || !this.#chats.has(chatId) || !this.#messages.has(chatId) ||
        this.#staleBoundaryChats.has(chatId)) {
      return undefined;
    }
    const boundary = this.getCompactions(chatId)[0];
    const codeBase = this.#chats.get(chatId)!.codeBase;
    const inputs = `${boundary?.to ?? -1}:${JSON.stringify(codeBase ?? null)}` +
      `:${this.#codeChangesEpochKey(chatId)}`;
    if (inputs !== this.#codeChangesInputs.get(chatId)) {
      this.#codeChangesInputs.set(chatId, inputs);
      const dense = (this.#messages.get(chatId) ?? []).filter(
        (msg): msg is AiChatMessage => msg !== undefined,
      );
      const { epochChange, rowsThrough } = computeChatEpochChanges(dense, boundary, codeBase);
      this.#codeChanges.set(chatId, { chatId, codeBase, epochChange, rowsThrough });
    }
    return this.#codeChanges.get(chatId);
  }

  /**
   * The last "changes"/"revert" message's sequence, so epoch folds rerun on every such
   * arrival. "merge" is excluded: the epoch reset it performs arrives through the metadata's
   * codeBase (see ingestMessage).
   */
  #codeChangesEpochKey(chatId: number): string {
    const messages = this.#messages.get(chatId);
    if (messages === undefined) return "";
    let last = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg !== undefined && (msg.type === "changes" || msg.type === "revert")) {
        last = msg.sequence;
        break;
      }
    }
    return `${last}`;
  }

  /**
   * The chat's live-row stream in the subscription shape the code view consumes (see
   * ChatLiveChangeRows). Identity is stable per chat, so consumers subscribe once per chat.
   */
  getLiveRows(chatId: number | null): ChatLiveChangeRows | undefined {
    if (chatId === null) return undefined;
    let stream = this.#liveRows.get(chatId);
    if (stream === undefined) {
      const store = this;
      stream = {
        chatId,
        subscribe: (listener: (row: ChatChangeRow) => void) => {
          let listeners = store.#rowListeners.get(chatId);
          if (!listeners) {
            listeners = new Set();
            store.#rowListeners.set(chatId, listeners);
          }
          listeners.add(listener);
          // Replay what the buffer retains; the consumer dedupes, so redundancy is harmless.
          const buffer = store.#rows.get(chatId);
          if (buffer) for (const row of buffer.rows) listener(row);
          return () => {
            listeners!.delete(listener);
            if (listeners!.size === 0) store.#rowListeners.delete(chatId);
          };
        },
      };
      this.#liveRows.set(chatId, stream);
    }
    return stream;
  }

  /** The chat's edit-preview stream (see ChatLiveEditPreviews), stable per chat. */
  getLiveEditPreviews(chatId: number | null): ChatLiveEditPreviews | undefined {
    if (chatId === null) return undefined;
    let stream = this.#liveEditPreviews.get(chatId);
    if (stream === undefined) {
      const store = this;
      stream = {
        chatId,
        subscribe: (listener: (event: EditPreviewEvent) => void) => {
          let listeners = store.#editPreviewListeners.get(chatId);
          if (!listeners) {
            listeners = new Set();
            store.#editPreviewListeners.set(chatId, listeners);
          }
          listeners.add(listener);
          // Replay the streaming preview so a consumer subscribing mid-stream (a chat switch,
          // an OT client rebuild) still shows the text streamed so far.
          const streaming = store.#editPreviews.get(chatId);
          if (streaming !== undefined) {
            listener({
              kind: "start",
              toolCallId: streaming.toolCallId,
              workpieceId: streaming.workpieceId,
              filename: streaming.filename,
              ...(streaming.textToReplace !== undefined
                ? { textToReplace: streaming.textToReplace } : {}),
            });
            if (streaming.text !== "") {
              listener({ kind: "delta", toolCallId: streaming.toolCallId, delta: streaming.text });
            }
          }
          return () => {
            listeners!.delete(listener);
            if (listeners!.size === 0) store.#editPreviewListeners.delete(chatId);
          };
        },
      };
      this.#liveEditPreviews.set(chatId, stream);
    }
    return stream;
  }

  getModels(): readonly AiChatAuthorInfo[] {
    return this.#modelsSnapshot;
  }

  getSelectedModel(): string | null {
    return this.#selectedModel;
  }

  setSelectedModel(model: string | null): void {
    this.#selectedModel = model;
    this.#notify();
  }

  /**
   * The union of every chat's proposed-change workpieces, ascending — drives per-gadget draft
   * previews. Derived from the chat map, with a cached identity so metadata redeliveries that
   * change nothing do not churn its consumers.
   */
  getAnyChatProposedWorkpieces(): readonly number[] {
    if (this.#anyProposedDirty) {
      this.#anyProposedSnapshot = [...new Set(
        [...this.#chats.values()].flatMap((meta) => meta.proposedChangeWorkpieces ?? []),
      )].toSorted((a, b) => a - b);
      this.#anyProposedDirty = false;
    }
    return this.#anyProposedSnapshot;
  }

  /**
   * The streaming file target for the selected chat, from committed provisional state — fed to
   * the editor by the synchronous callback on change and re-read by selectors per frame.
   */
  getStreamingActiveFile(chatId: number | null): ActiveFileTarget | null | undefined {
    return chatId === null ? undefined : this.#provisionalCommitted.get(chatId)?.activeEditingFile;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

const EMPTY_MESSAGES: readonly AiChatMessage[] = [];
const EMPTY_COMPACTIONS: readonly CompactionBoundary[] = [];

/**
 * The store's RPC subscriber target. A class so the server receives a single stub for the
 * object, not one per method; it holds nothing but the store, so however late the server
 * delivers an event, it lands on current state.
 */
class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  readonly #store: ChatStore;

  constructor(store: ChatStore) {
    super();
    this.#store = store;
  }

  streamGeneration(generation: number): void {
    this.#store.ingestStreamGeneration(generation);
  }

  metadata(chat: AiChatMetadata): void {
    this.#store.ingestMetadata(chat);
  }

  deleted(chatId: number): void {
    this.#store.ingestDeleted(chatId);
  }

  changeApplied(
    chatId: number,
    generation: number,
    revision: number,
    author: AiChatAuthorInfo,
    change: CodeChange,
    submission?: { clientId: string; seq: number },
  ): void {
    this.#store.ingestChangeApplied(chatId, generation, revision, author, change, submission);
  }

  message(msg: AiChatMessage): void {
    this.#store.ingestMessage(msg);
  }

  stream(chatId: number, event: AiChatStreamEvent): void {
    this.#store.ingestStream(chatId, event);
  }
}
