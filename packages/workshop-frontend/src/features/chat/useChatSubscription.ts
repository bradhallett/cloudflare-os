import { useEffect, useMemo, useRef, useState } from "react";
import { RpcStub, RpcTarget } from "capnweb";
import { reportIssue } from "../../errorReporting";
import { logRpcFailure } from "../../rpcErrors";
import { getStoredSelectedModel } from "../../modelSelection";
import { actionLogResumed, useActionEntries } from "../../useActions";
import type { useKumoToastManager } from "@cloudflare/kumo";
import {
  Overseer,
  AiChatHistoryPage,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  ActionLogEntry,
  AiChatAuthorInfo,
  AiChatStreamEvent,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import type { ChatChangeRow } from "../code/otClient";
import {
  pruneChatChangeRows,
  type ActiveFileTarget,
  type ChatChangeRowBuffer,
  type ChatCodeChanges,
  type ChatLiveChangeRows,
  type ChatLiveEditPreviews,
  type EditPreviewEvent,
  type StreamingEditPreview,
} from "./liveCodeStreams";
import {
  clearProvisionalCodeState,
  clearProvisionalTextState,
  createProvisionalChatState,
  getOrCreateProvisionalToolCall,
  isProvisionalChatStateEmpty,
  type ProvisionalChatState,
} from "./provisionalChatState";
import { computeChatEpochChanges, type CompactionBoundary } from "./transcript/chatDisplayEntries";

type Toasts = ReturnType<typeof useKumoToastManager>;

/**
 * Client-side cache for chats and messages (survives reconnects).
 */
export interface ChatCache {
  chats: Map<number, AiChatMetadata>;
  messages: Map<number, AiChatMessage[]>;
  // Compaction boundaries seen so far for each chat, oldest first. Every loaded page contributes
  // one, so a thread compacted several times shows a marker at each cut.
  compacted: Map<number, CompactionBoundary[]>;
  actionMessages: Map<number, Map<string, { chatId: number; sequence: number }>>;
  lastMessageTimestamp: Date | null;
}

/** Props {@link useChatSubscription} reads from its host component. */
export interface UseChatSubscriptionArgs {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  toasts: Toasts;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  onChatChangesChange?: (changes: ChatCodeChanges | undefined) => void;
  onLiveRowsChange?: (rows: ChatLiveChangeRows | undefined) => void;
  onLiveEditPreviewsChange?: (previews: ChatLiveEditPreviews | undefined) => void;
  onStreamingActiveFileChange?: (chatId: number, file: ActiveFileTarget | null | undefined) => void;
}

/**
 * Owns the chat subscription: the persistent message/metadata cache, provisional streaming
 * state, live change-row and edit-preview streams, and the cache-driven state that forces the
 * transcript to re-render. Everything here is behavior moved verbatim from ChatInterface.
 */
export function useChatSubscription({
  overseer,
  selectedChatId,
  toasts,
  onNavigateToChat,
  onChatChangesChange,
  onLiveRowsChange,
  onLiveEditPreviewsChange,
  onStreamingActiveFileChange,
}: UseChatSubscriptionArgs) {
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    compacted: new Map(),
    actionMessages: new Map(),
    lastMessageTimestamp: null,
  });
  const provisionalRef = useRef<Map<number, ProvisionalChatState>>(new Map());
  // Per-chat buffers of live (unmaterialized) change rows (see ChatLiveChangeRows), fed by
  // changeApplied, pruned by materialization watermarks and generation bumps.
  const chatChangeRowsRef = useRef<Map<number, ChatChangeRowBuffer>>(new Map());
  // Live-row subscribers by chat, notified synchronously from changeApplied (before any pruning;
  // see ChatLiveChangeRows.subscribe).
  const chatChangeRowListenersRef =
      useRef<Map<number, Set<(row: ChatChangeRow) => void>>>(new Map());
  // Per-chat streaming edit previews (retained for subscribe-time replay; see
  // StreamingEditPreview) and their event subscribers, fed synchronously from stream events.
  const editPreviewsRef = useRef<Map<number, StreamingEditPreview>>(new Map());
  const editPreviewListenersRef =
      useRef<Map<number, Set<(event: EditPreviewEvent) => void>>>(new Map());
  // Last server-instance generation seen (survives reconnects). Used to detect a full DO restart,
  // in which case in-flight provisional streams were lost and must be discarded. See
  // AiChatSubscriber.streamGeneration.
  const lastStreamGenerationRef = useRef<number | undefined>(undefined);

  const [_isSubscribed, setIsSubscribed] = useState(false);
  const [chatListReady, setChatListReady] = useState(false);
  const [chatListVersion, setChatListVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [updateCounter, setUpdateCounter] = useState(0); // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0); // Incremented only for change-affecting messages
  // Rows live in refs (chatChangeRowsRef); this state only forces re-renders of their readers (the
  // draft banner) as rows arrive or get pruned. Subscribed consumers are fed synchronously and
  // don't depend on it (see ChatLiveChangeRows).
  const [_liveRowsVersion, setLiveRowsVersion] = useState(0);
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>(
    [],
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Held in a ref for the same reason as `refreshBoundaryRef` below: the subscriber outlives the
  // render that created it, and the toast manager is a fresh object each render.
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  // Chats whose oldest loaded boundary a revert reached past. The server refolded that boundary's
  // proposed changes, so the code view waits for its page to be refetched: the revert's generation
  // bump would otherwise rebuild the chat's content on the old blob, and the OT client rebuilds
  // only on a generation change. A failed refetch keeps the hold until the next subscription.
  const staleBoundaryChatsRef = useRef(new Set<number>());

  const indexActionMessage = (msg: AiChatMessage) => {
    if (msg.type !== "action") return;
    let locations = cacheRef.current.actionMessages.get(msg.actionId);
    if (!locations) {
      locations = new Map();
      cacheRef.current.actionMessages.set(msg.actionId, locations);
    }
    locations.set(`${msg.chatId}:${msg.sequence}`, {
      chatId: msg.chatId,
      sequence: msg.sequence,
    });
  };

  const removeChatFromActionMessageIndex = (chatId: number) => {
    for (const [actionId, locations] of cacheRef.current.actionMessages) {
      for (const [key, location] of locations) {
        if (location.chatId === chatId) locations.delete(key);
      }
      if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    }
  };

  // Fold one history page into the cache. Messages are stored at their sequence index, so filling
  // in an older page and re-receiving a message the subscription already delivered are both
  // harmless. The page's boundary joins the ones already known, keyed by its cut so the same page
  // fetched twice contributes one marker.
  const cacheHistoryPage = (chatId: number, page: AiChatHistoryPage) => {
    let messages = cacheRef.current.messages.get(chatId);
    if (!messages) {
      messages = [];
      cacheRef.current.messages.set(chatId, messages);
    }

    for (const msg of page.messages) {
      messages[msg.sequence] = msg;
      indexActionMessage(msg);
    }

    if (page.compacted) {
      let boundaries = cacheRef.current.compacted.get(chatId) ?? [];
      cacheRef.current.compacted.set(chatId, [
        ...boundaries.filter(({to}) => to !== page.compacted!.to), page.compacted,
      ].toSorted((a, b) => a.to - b.to));
    }
  };

  // Refetches the page carrying one of a loaded chat's boundaries: the newest page, or the one
  // before `beforeSequence`, and resolves whether it loaded. Held in a ref because the chat
  // subscriber is constructed once, while `overseer` and `cacheHistoryPage` are recreated each
  // render.
  const refreshBoundaryRef =
    useRef<(chatId: number, beforeSequence?: number) => Promise<boolean>>(async () => false);
  refreshBoundaryRef.current = async (chatId: number, beforeSequence?: number) => {
    try {
      cacheHistoryPage(chatId, await overseer.getChatHistory(chatId, beforeSequence));
      forceUpdate();
      return true;
    } catch (err) {
      reportIssue("chat.compaction-boundary-refresh", err, {handled: true});
      return false;
    }
  };

  // Refetches a stale chat's oldest boundary, then releases its code view. The page before
  // `to + 1` is the one message at that boundary, so the server returns exactly that checkpoint.
  // Reads only refs and a state setter, so the subscriber's first-render copy stays current.
  const refreshStaleBoundary = async (chatId: number) => {
    let oldest = cacheRef.current.compacted.get(chatId)?.[0];
    if (oldest === undefined || await refreshBoundaryRef.current(chatId, oldest.to + 1)) {
      staleBoundaryChatsRef.current.delete(chatId);
      setProposedChangesVersion((prev) => prev + 1);
    }
  };

  // Refs for accessing current values in subscriber callbacks
  const selectedChatIdRef = useRef<number | null>(null);
  const onNavigateToChatRef = useRef(onNavigateToChat);
  onNavigateToChatRef.current = onNavigateToChat;

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null);

  // Force a re-render when cache is updated
  const forceUpdate = () => setUpdateCounter((prev) => prev + 1);
  const bumpChatListVersion = () => setChatListVersion((prev) => prev + 1);

  // Batched version of forceUpdate for high frequency stream events.
  // Coalesces multiple updates within a single animation frame.
  const pendingUpdateRef = useRef(false);
  const scheduleUpdate = () => {
    if (!pendingUpdateRef.current) {
      pendingUpdateRef.current = true;
      requestAnimationFrame(() => {
        pendingUpdateRef.current = false;
        forceUpdate();
      });
    }
  };

  // The selected chat's live-row stream in the subscription shape the code view consumes (see
  // ChatLiveChangeRows). Identity is stable per chat -- the subscription itself outlives row
  // arrivals and buffer pruning -- so consumers subscribe once per chat.
  const currentLiveRows = useMemo((): ChatLiveChangeRows | undefined => {
    if (selectedChatId === null) return undefined;
    const chatId = selectedChatId;
    return {
      chatId,
      subscribe: (listener) => {
        let listeners = chatChangeRowListenersRef.current.get(chatId);
        if (!listeners) {
          listeners = new Set();
          chatChangeRowListenersRef.current.set(chatId, listeners);
        }
        listeners.add(listener);
        // Replay what the buffer retains (rows arriving during the replay are impossible: this
        // is all synchronous). The consumer dedupes, so redundancy is harmless.
        const buffer = chatChangeRowsRef.current.get(chatId);
        if (buffer) for (const row of buffer.rows) listener(row);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) chatChangeRowListenersRef.current.delete(chatId);
        };
      },
    };
  }, [selectedChatId]);

  // The selected chat's edit-preview stream in subscription shape (see ChatLiveEditPreviews),
  // stable per chat like the row stream above.
  const currentLiveEditPreviews = useMemo((): ChatLiveEditPreviews | undefined => {
    if (selectedChatId === null) return undefined;
    const chatId = selectedChatId;
    return {
      chatId,
      subscribe: (listener) => {
        let listeners = editPreviewListenersRef.current.get(chatId);
        if (!listeners) {
          listeners = new Set();
          editPreviewListenersRef.current.set(chatId, listeners);
        }
        listeners.add(listener);
        // Replay the streaming preview, if any, so a consumer subscribing mid-stream (a chat
        // switch, an OT client rebuild) still shows the text streamed so far.
        const streaming = editPreviewsRef.current.get(chatId);
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
          listeners.delete(listener);
          if (listeners.size === 0) editPreviewListenersRef.current.delete(chatId);
        };
      },
    };
  }, [selectedChatId]);

  // Resolves an actionMessages location to the cached action message it points at (with its
  // containing message array, for copy-on-write patches). Undefined if the cache no longer holds
  // an action message there.
  const getCachedActionMessage = (location: { chatId: number; sequence: number }) => {
    const messages = cacheRef.current.messages.get(location.chatId);
    const msg = messages?.[location.sequence];
    return msg?.type === "action" ? { messages: messages!, msg } : undefined;
  };

  const applyActionLogUpdateToCachedMessages = (record: ActionLogEntry): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(record.id);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const cached = getCachedActionMessage(location);
      if (!cached || cached.msg.actionId !== record.id) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...cached.messages];
      nextMessages[location.sequence] = { ...cached.msg, actionLog: record };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(record.id);
    return changed;
  };

  const applyOptimisticActionState = (actionId: number, state: "approved" | "rejected"): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(actionId);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const cached = getCachedActionMessage(location);
      if (!cached || cached.msg.actionId !== actionId || !cached.msg.actionLog) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...cached.messages];
      nextMessages[location.sequence] = {
        ...cached.msg,
        actionLog: { ...cached.msg.actionLog, state, appliedAt: new Date() },
      };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    return changed;
  };

  const applyOptimisticHookEnabled = (actionId: number, enabled: boolean): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(actionId);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const cached = getCachedActionMessage(location);
      if (!cached || cached.msg.actionId !== actionId || cached.msg.actionLog?.type !== "bindHook") {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...cached.messages];
      nextMessages[location.sequence] = {
        ...cached.msg,
        actionLog: { ...cached.msg.actionLog, enabled },
      };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    return changed;
  };

  // Keep the ref in sync with selectedChatId state
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  // Notify parent when the selected chat's code-branch snapshot changes (see ChatCodeChanges):
  // its ChatCodeBase plus the current epoch's recorded changes, derived together so the code
  // view never pairs one's stale value with the other's fresh one. Recomputes when
  // proposedChangesVersion changes (i.e. a "changes" or "revert" message arrives, or a history
  // page loads) or when the codeBase's *content* changes -- metadata is redelivered on every
  // chat activity (title, lastActive, ...), so it is deduped by signature. "merge" messages bump
  // neither directly: the epoch reset they perform arrives through the metadata's codeBase
  // (advanced epoch, cleared pins, bumped generation), redelivered with the merge.
  const currentChatMetadata =
      selectedChatId !== null ? cacheRef.current.chats.get(selectedChatId) : null;
  const currentCodeBaseSignature = currentChatMetadata
    ? JSON.stringify(currentChatMetadata.codeBase ?? null) : undefined;
  useEffect(() => {
    if (selectedChatId === null || currentCodeBaseSignature === undefined ||
        !cacheRef.current.messages.has(selectedChatId) ||
        staleBoundaryChatsRef.current.has(selectedChatId)) {
      // No chat selected, its metadata or history hasn't loaded yet, or a revert left its oldest
      // boundary stale -- the code view can't build the chat's doc until all are current.
      onChatChangesChange?.(undefined);
      return;
    }

    // Read messages and metadata directly from the cache (always current) rather than using the
    // memoized currentMessages, so we don't need them as dependencies.
    const messages = (cacheRef.current.messages.get(selectedChatId) || []).filter(
      (msg) => msg !== undefined,
    );
    const codeBase = cacheRef.current.chats.get(selectedChatId)?.codeBase;
    const { epochChange, rowsThrough } = computeChatEpochChanges(
      messages,
      cacheRef.current.compacted.get(selectedChatId)?.[0],
      codeBase,
    );

    onChatChangesChange?.({ chatId: selectedChatId, codeBase, epochChange, rowsThrough });
  }, [
    proposedChangesVersion,
    selectedChatId,
    currentCodeBaseSignature,
    onChatChangesChange,
  ]);

  useEffect(() => {
    onLiveRowsChange?.(currentLiveRows);
  }, [currentLiveRows, onLiveRowsChange]);

  useEffect(() => {
    onLiveEditPreviewsChange?.(currentLiveEditPreviews);
  }, [currentLiveEditPreviews, onLiveEditPreviewsChange]);

  const onStreamingActiveFileChangeRef = useRef(onStreamingActiveFileChange);
  onStreamingActiveFileChangeRef.current = onStreamingActiveFileChange;
  const currentProvisionalState =
    selectedChatId !== null
      ? (provisionalRef.current.get(selectedChatId) ?? null)
      : null;
  const currentStreamingActiveFile = currentProvisionalState?.activeEditingFile;
  useEffect(() => {
    if (selectedChatId !== null) {
      onStreamingActiveFileChangeRef.current?.(selectedChatId, currentStreamingActiveFile);
    }
  }, [currentStreamingActiveFile, selectedChatId]);

  // Deliver one edit-preview event to a chat's subscribers. Touches only refs, so the
  // first-render closures the subscriber instance captures stay correct.
  const emitEditPreviewEvent = (chatId: number, event: EditPreviewEvent) => {
    editPreviewListenersRef.current.get(chatId)?.forEach((listener) => listener(event));
  };
  // The turn-boundary mop-up: drop all of a chat's preview state (see EditPreviewEvent's
  // `reset`). Emitted even when no preview is *streaming* -- finished previews awaiting their
  // rows live in the consumer, which this tells to let go of them.
  const resetEditPreviews = (chatId: number) => {
    editPreviewsRef.current.delete(chatId);
    emitEditPreviewEvent(chatId, { kind: "reset" });
  };

  // Proper class implementation of AiChatSubscriber
  // This is necessary so the server receives a single stub for the object,
  // not separate stubs for each method
  class ChatSubscriberImpl extends RpcTarget implements AiChatSubscriber {
    streamGeneration(generation: number) {
      if (
        lastStreamGenerationRef.current !== undefined &&
        lastStreamGenerationRef.current !== generation
      ) {
        // The DO fully restarted since our last subscription; any in-flight provisional streams
        // were lost and will be re-streamed from scratch. Discard stale provisional state so the
        // re-streamed content isn't appended to it. Clearing all chats is safe: provisional state
        // is purely ephemeral display state, and idle chats already have none.
        provisionalRef.current.clear();
        // Reset every subscribed chat's previews, not just those with a streaming entry:
        // consumers also hold finished previews awaiting rows that were lost with the DO.
        for (const chatId of editPreviewListenersRef.current.keys()) resetEditPreviews(chatId);
        forceUpdate();
      }
      lastStreamGenerationRef.current = generation;
    }

    metadata(chat: AiChatMetadata) {
      // When the agent stops running (activeAgent becomes unset), do a final full clear of this
      // chat's provisional streaming state. This generally shouldn't be necessary because chat
      // stream state is cleared when the final message arrives and code stream state is cleared
      // when the finalized changes arrive, but doing this final clear will "mop up" if there
      // were any inconsistencies in the streaming.
      const prevChat = cacheRef.current.chats.get(chat.id);
      if (prevChat?.activeAgent && !chat.activeAgent) {
        provisionalRef.current.delete(chat.id);
        resetEditPreviews(chat.id);
      }

      // A compaction that lands while the chat is open publishes a boundary the client only gets
      // with a page, so refetch instead of waiting for a reload. Asking whether that boundary is
      // already loaded makes this idempotent: paging back adds boundaries rather than replacing
      // them, so an extra fetch can neither miss a compaction nor undo an expansion.
      if (cacheRef.current.messages.has(chat.id) && chat.compactedTo !== undefined &&
          !cacheRef.current.compacted.get(chat.id)?.some(({to}) => to === chat.compactedTo)) {
        void refreshBoundaryRef.current(chat.id);
      }

      // A generation bump obsoletes buffered rows: a *destructive* bump (revert / draft
      // discard -- no `prior`) erased every row, so drop them all; a content-preserving bump
      // (a merge's epoch reset) retires the closed generation's rows but the code view may
      // still be draining its tail, so keep exactly the prior generation and the new one.
      // (The buffers are advisory replay caches -- the OT client dedupes and prunes on its own
      // stream position -- so pruning here is memory hygiene, not correctness.)
      const codeBase = chat.codeBase;
      if (prevChat !== undefined && codeBase !== undefined &&
          (prevChat.codeBase?.generation ?? 0) !== codeBase.generation) {
        const keepFrom = codeBase.prior?.generation ?? codeBase.generation;
        if (pruneChatChangeRows(chatChangeRowsRef.current, chat.id,
                                row => row.generation >= keepFrom)) {
          setLiveRowsVersion((prev) => prev + 1);
        }
      }

      cacheRef.current.chats.set(chat.id, chat);
      bumpChatListVersion();
      forceUpdate();
    }

    deleted(chatId: number) {
      // Remove from cache
      cacheRef.current.chats.delete(chatId);
      cacheRef.current.messages.delete(chatId);
      cacheRef.current.compacted.delete(chatId);
      removeChatFromActionMessageIndex(chatId);
      provisionalRef.current.delete(chatId);
      editPreviewsRef.current.delete(chatId);
      chatChangeRowsRef.current.delete(chatId);
      bumpChatListVersion();

      // If currently viewing this chat, go back to list
      // Use replace to prevent browser-back returning to the deleted chat
      if (selectedChatIdRef.current === chatId) {
        onNavigateToChatRef.current(null, { replace: true });
      }

      forceUpdate();
    }

    changeApplied(
      chatId: number,
      generation: number,
      revision: number,
      author: AiChatAuthorInfo,
      change: CodeChange,
      submission?: { clientId: string; seq: number },
    ) {
      let buffer = chatChangeRowsRef.current.get(chatId);
      if (!buffer) {
        buffer = { rows: [], seen: new Set(), lastUserEditAt: null };
        chatChangeRowsRef.current.set(chatId, buffer);
      }
      // Dedupe: subscribe-replay redelivers every retained row (see Overseer.subscribeToChat).
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
      // Deliver to subscribers synchronously: the message that materializes this row may prune
      // it from the buffer before any effect runs (see ChatLiveChangeRows).
      chatChangeRowListenersRef.current.get(chatId)?.forEach((listener) => listener(row));
      setLiveRowsVersion((prev) => prev + 1);
      scheduleUpdate();
    }

    message(msg: AiChatMessage) {
      // Use sequence number as index to make this idempotent
      // This handles both duplicate subscriptions (React strict mode) and race conditions

      // Get or initialize messages array for this chat
      let messages = cacheRef.current.messages.get(msg.chatId);
      if (!messages) {
        messages = [];
        cacheRef.current.messages.set(msg.chatId, messages);
      }

      // Set message at sequence index (idempotent)
      messages[msg.sequence] = msg;
      indexActionMessage(msg);

      // Update last message timestamp
      if (
        !cacheRef.current.lastMessageTimestamp ||
        msg.timestamp > cacheRef.current.lastMessageTimestamp
      ) {
        cacheRef.current.lastMessageTimestamp = msg.timestamp;
      }

      // Only trigger proposed-changes recomputation for message types that affect the code.
      // "merge" is excluded: the epoch reset it performs reaches the doc through the metadata's
      // codeBase.epoch (redelivered with the merge), which the chat-doc effect above depends on
      // -- recomputing here as well would race the metadata and transiently pair the old epoch's
      // updates with the new epoch's (empty) pin set.
      if (msg.type === "changes" || msg.type === "revert") {
        setProposedChangesVersion((prev) => prev + 1);
      }

      // A revert reaching past the oldest loaded boundary changed it on the server; see
      // staleBoundaryChatsRef.
      if (msg.type === "revert") {
        let oldest = cacheRef.current.compacted.get(msg.chatId)?.[0];
        if (oldest !== undefined && msg.revertFrom < oldest.to) {
          staleBoundaryChatsRef.current.add(msg.chatId);
          void refreshStaleBoundary(msg.chatId);
        }
      }

      // A "changes" message's watermark absorbs the rows it materialized; drop our copies (see
      // AiChatMessageBody.watermark). Rows of other generations are untouched -- revisions
      // restart per generation, so an unqualified prune could clear the wrong stream's rows.
      if (msg.type === "changes" && msg.watermark !== undefined) {
        const { changesGeneration, throughRevision } = msg.watermark;
        if (pruneChatChangeRows(chatChangeRowsRef.current, msg.chatId,
                                row => row.generation !== changesGeneration ||
                                       row.revision > throughRevision)) {
          setLiveRowsVersion((prev) => prev + 1);
        }
      }

      // The turn-flush "changes" message covers every row a successful edit appended, and an
      // error message ends the step -- either way this step's previews are over (ordinarily
      // each previewed edit's own row already resolved it; see WorkpieceCodeInterface).
      if (msg.type === "changes" || msg.type === "error") {
        resetEditPreviews(msg.chatId);
      }

      const provisional = provisionalRef.current.get(msg.chatId);
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
          provisionalRef.current.delete(msg.chatId);
        }
      }

      forceUpdate();
    }

    stream(chatId: number, event: AiChatStreamEvent) {
      let provisional = provisionalRef.current.get(chatId);

      if (!provisional) {
        provisional = createProvisionalChatState();
        provisionalRef.current.set(chatId, provisional);
      }

      switch (event.type) {
        case "streamReset":
          // A failed model request is being retried: drop everything it streamed, as an error
          // message would, so the retry's output doesn't append to the failed attempt's.
          clearProvisionalTextState(provisional);
          clearProvisionalCodeState(provisional);
          resetEditPreviews(chatId);
          break;
        case "compacting":
          provisional.compacting = true;
          break;
        case "compacted":
          provisional.compacting = false;
          if (event.nothingToCompact) {
            toastsRef.current.add({
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
        case "toolCallStarted": {
          getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            event.toolName,
          );
          break;
        }
        case "toolCodeDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.code += event.delta;
          break;
        }
        case "toolOutputDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.output += event.delta;
          break;
        }
        case "toolCallFinished": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.finished = true;
          break;
        }
        case "setActiveFile":
          provisional.activeEditingFile = event.file ?? null;
          // Also tell the editor straight away. The effect above only runs on re-render, which is
          // too late for the tab to follow the very first file of a turn.
          if (chatId === selectedChatIdRef.current) {
            onStreamingActiveFileChangeRef.current?.(chatId, event.file ?? null);
          }
          break;
        case "toolCallOutputFormat": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.outputFormat = event.output;
          break;
        }
        case "toolCallTarget": {
          // Surfaces the file name during streaming for writes and edits so the frontend can update.
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.target = event.file.filename;
          break;
        }
        case "editPreviewStart":
          editPreviewsRef.current.set(chatId, {
            toolCallId: event.toolCallId,
            workpieceId: event.file.workpieceId,
            filename: event.file.filename,
            ...(event.textToReplace !== undefined
              ? { textToReplace: event.textToReplace } : {}),
            text: "",
          });
          emitEditPreviewEvent(chatId, {
            kind: "start",
            toolCallId: event.toolCallId,
            workpieceId: event.file.workpieceId,
            filename: event.file.filename,
            ...(event.textToReplace !== undefined
              ? { textToReplace: event.textToReplace } : {}),
          });
          break;
        case "editPreviewDelta": {
          const preview = editPreviewsRef.current.get(chatId);
          if (preview !== undefined && preview.toolCallId === event.toolCallId) {
            preview.text += event.delta;
          }
          emitEditPreviewEvent(chatId,
            { kind: "delta", toolCallId: event.toolCallId, delta: event.delta });
          break;
        }
        case "editPreviewClear": {
          const preview = editPreviewsRef.current.get(chatId);
          if (preview !== undefined && preview.toolCallId === event.toolCallId) {
            editPreviewsRef.current.delete(chatId);
          }
          // Forwarded regardless of which call it names: a failed call's clear arrives at
          // execution time, when a later call's preview may already be the streaming one, and
          // the consumer still holds the named call's finished preview.
          emitEditPreviewEvent(chatId, { kind: "clear", toolCallId: event.toolCallId });
          break;
        }
      }

      if (isProvisionalChatStateEmpty(provisional)) {
        provisionalRef.current.delete(chatId);
      }

      scheduleUpdate();
    }
  }

  // Keep stable subscriber instance across re-renders
  const subscriberRef = useRef(new ChatSubscriberImpl());

  // Subscribe to chat updates
  useEffect(() => {
    let isMounted = true;

    const subscribe = async () => {
      try {
        // Subscribe using startAfter if we have a last message timestamp
        const startAfter = cacheRef.current.lastMessageTimestamp || undefined;

        // Don't await - subscribeToChat returns a promise that doesn't resolve until disconnect
        // Store the promise itself as the subscription
        // Pass the subscriber instance (which is now a proper class instance)
        const subscription = overseer.subscribeToChat(
          subscriberRef.current,
          startAfter,
        );

        subscriptionRef.current = subscription;

        if (isMounted) {
          setIsSubscribed(true);
          for (const chatId of staleBoundaryChatsRef.current) void refreshStaleBoundary(chatId);

          // After subscribing, load the list of chats and models
          // This is safe because subscription will catch any new activity
          const [chats, models] = await Promise.all([
            overseer.listChats(),
            overseer.listModels(),
          ]);

          chats.forEach((chat) => {
            cacheRef.current.chats.set(chat.id, chat);
          });
          bumpChatListVersion();
          setChatListReady(true);

          setAvailableModels(models);

          setSelectedModel(getStoredSelectedModel(models));

          forceUpdate();
        }
      } catch (err) {
        if (!logRpcFailure("Failed to subscribe to chats:", err)) {
          reportIssue('chat.subscription-load', err)
          toasts.add({ title: "Unable to load conversations", variant: "error" });
        }
      }
    };

    subscribe();

    // Set up reconnection handling
    overseer.onRpcBroken?.((error) => {
      console.warn("RPC connection broken:", error);
      setIsSubscribed(false);
      // Cache persists, component will get new overseer prop and resubscribe
    });

    return () => {
      isMounted = false;
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]();
      }
      // Note: subscriberRef.current stays alive for potential resubscription
    };
  }, [overseer]);

  // Patch cached chat messages on action upserts.
  useActionEntries(overseer, (record) => {
    if (applyActionLogUpdateToCachedMessages(record)) scheduleUpdate();
  });
  // On a resumed reconnect the subscription replays the gap, so the entries above cover cached
  // cards. Otherwise (cold open, or the prior session never settled) re-fetch cached action
  // cards whose log can still change: blank or pending cards (a resolution may have landed
  // while we were away), and bindHook cards, which stay mutable after resolution (`enabled`
  // toggles). Runs after useActionEntries, whose effect creates the store and its resumed flag.
  useEffect(() => {
    if (actionLogResumed(overseer)) return;
    let cancelled = false;
    const targets = [...cacheRef.current.actionMessages.values()].flatMap((locations) => {
      const location = locations.values().next().value;
      const msg = location && getCachedActionMessage(location)?.msg;
      return msg && (!msg.actionLog || msg.actionLog.state === "pending" ||
          msg.actionLog.type === "bindHook") ? [location] : [];
    });

    const refresh = async (location: { chatId: number; sequence: number }) => {
      try {
        const fetched = await overseer.getChatMessage(location.chatId, location.sequence);
        if (cancelled || fetched?.type !== "action" || !fetched.actionLog) return;
        // Resolution is monotonic: never regress a card another channel already resolved.
        const current = getCachedActionMessage(location)?.msg;
        if (fetched.actionLog.state === "pending" &&
            current?.actionLog && current.actionLog.state !== "pending") return;
        if (applyActionLogUpdateToCachedMessages(fetched.actionLog)) scheduleUpdate();
      } catch (err) {
        console.error("Failed to refresh action card:", err);
      }
    };

    // A few at a time: a large cache refreshing all at once would flood the workspace DO.
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
  }, [overseer]);

  // Load chat history when selectedChatId changes to a non-null value
  useEffect(() => {
    if (selectedChatId === null) return;

    // If we don't have messages for this chat yet, load them
    if (!cacheRef.current.messages.has(selectedChatId)) {
      let cancelled = false;
      setIsLoading(true);
      (async () => {
        try {
          const page = await overseer.getChatHistory(selectedChatId);
          if (cancelled) return;

          cacheHistoryPage(selectedChatId, page);

          // Update last message timestamp if needed
          if (page.messages.length > 0) {
            const lastMsg = page.messages[page.messages.length - 1];
            if (
              !cacheRef.current.lastMessageTimestamp ||
              lastMsg.timestamp > cacheRef.current.lastMessageTimestamp
            ) {
              cacheRef.current.lastMessageTimestamp = lastMsg.timestamp;
            }
          }

          // History may contain change-affecting messages that the subscriber
          // didn't deliver (they predated the subscription). Bump the version so
          // the proposed-changes effect re-evaluates with the loaded messages.
          setProposedChangesVersion((prev) => prev + 1);
          forceUpdate();
        } catch (err) {
          console.error("Failed to load chat history:", err);
          // If loading fails (e.g., invalid chat ID), navigate back to chat list
          if (!cancelled) {
            onNavigateToChatRef.current(null, { replace: true });
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }
    // LSP reports an error here, but tsc does not.
    // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [selectedChatId, overseer]);

  return {
    cacheRef,
    provisionalRef,
    chatChangeRowsRef,
    selectedChatIdRef,
    onNavigateToChatRef,
    chatListVersion,
    chatListReady,
    isLoading,
    updateCounter,
    availableModels,
    selectedModel,
    setSelectedModel,
    setProposedChangesVersion,
    forceUpdate,
    bumpChatListVersion,
    cacheHistoryPage,
    applyOptimisticActionState,
    applyOptimisticHookEnabled,
  };
}
