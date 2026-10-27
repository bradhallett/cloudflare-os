import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useKumoToastManager } from "@cloudflare/kumo";

import { RpcStub } from "capnweb";
import {
  getStoredSelectedBot,
  getStoredSelectedModel,
  sameBotSelection,
} from "../../modelSelection";
import {
  Overseer,
  AiChatAuthorInfo,
  AiChatMetadata,
  AiToolCall,
  isPlanRefusalCode,
  type PlanRefusalCode,
  BotInfo,
  BotSelection,
  ChatAttachmentRef,
  WorkpieceId,
  BlueprintOutput,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";
import { ChatListPanel, type ChatListScope } from "./ChatListPanel";
import { ChatTranscript } from "./ChatTranscript";
import { ChatDialogs } from "./ChatDialogs";
import { ChatHeaderBar } from "./ChatHeaderBar";
import { ChatComposerBar } from "./ChatComposerBar";
import { useChatActions } from "./useChatActions";
import { useChatListActions } from "./useChatListActions";
import { useChatChanges } from "./useChatChanges";
import { useConnectionRequests } from "./useConnectionRequests";
import type { ChatContentReader } from "../code/otClient";
import { triggerBlobDownload } from "../../fileTransfers";
import { useAlwaysApproveTag } from "../../useAlwaysApproveTag";
import { useResolveAction } from "../../useResolveAction";
import { useAuthenticatedApi } from "../../AuthContext";
import {
  useChatCompactions,
  useChatIsLoadingHistory,
  useChatList,
  useChatListReady,
  useChatMessages,
  useChatMetadata,
  useChatModels,
  useChatProvisionalState,
  useChatRowBuffer,
  useChatStoreConnection,
  useSelectedChatModel,
} from "./store/useChatStore";
import {
  getStoredShowThinkingTraces,
  persistShowThinkingTraces,
} from "./thinkingTracesPreference";
import { resolveToolCallOutput } from "./transcript/toolCalls";
import {
  buildChatDisplayEntries,
  computeMessageStates,
  EARLIER_PAGE_PREFETCH_PX,
  inferChatAgentFromMessages,
  rhythmTopClass,
} from "./transcript/chatDisplayEntries";
import { usePendingTurnChanges } from "./transcript/usePendingTurnChanges";
import { useExpansionSet } from "./transcript/useExpansionSet";
import { useMessageScroller } from "./transcript/useMessageScroller";
import { JumpToLatestPill } from "./transcript/JumpToLatestPill";
import { MissedMessagesStatus } from "./transcript/MissedMessagesStatus";
import { type AutoApproveTarget } from "./transcript/ActionCard";

function fallbackToStoredModelSelection(
  modelId: string | null,
  availableModels: readonly AiChatAuthorInfo[],
): string | null {
  if (modelId !== null || availableModels.length > 0) {
    return modelId;
  }

  return getStoredSelectedModel(availableModels);
}

/**
 * The display name of a chat's declared bot when that bot no longer resolves in the merged bot
 * list (deleted, or a deployment bot that was removed): the picker shows it as a disabled
 * "no longer available" row while the chat keeps running as a bare-model chat.
 */
function staleChatBotName(meta: AiChatMetadata, bots: BotInfo[]): string | undefined {
  const bot = meta.bot;
  if (!bot) return undefined;
  return bots.some((candidate) => sameBotSelection(candidate.selection, bot))
    ? undefined
    : meta.botName;
}

interface ChatInterfaceProps {
  workspaceId: string;
  overseer: RpcStub<Overseer>;
  // True once the workspace has read restricted data (GadgetMetadata.containsRestrictedData).
  // Latched actions are never auto-approved, so the always-approve affordance is hidden.
  restricted?: boolean;
  selectedChatId: number | null;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  // The selected chat's uncommitted content, which accepting its changes first checks for merge
  // conflicts nobody resolved. Without it the changes are accepted unchecked.
  chatContent?: ChatContentReader;
  pendingConsoleLogCount: number;
  consoleLogPreview: string;
  consoleLogSeverity: "error" | "warn" | "info";
  onConsumeConsoleLogs: () => string;
  onDiscardConsoleLogs: () => void;
  // Called after an auto-approval rule is enabled from the chat thread, so the Activity pane's
  // Auto-approval list reflects it without a reload.
  onAutoApproveChange?: () => void;
  sidebarMode?: boolean;
  sidebarWidth?: number;
  onSidebarResize?: (width: number) => void;
  renderExtraTab?: () => React.ReactNode;
  constrainChatWidth?: boolean;
  // Opens a workpiece the transcript offers (a created gadget's app, a created worktree's code).
  onOpenGadget: (workpieceId: WorkpieceId) => void;

  // The output format a workpiece was built as, so a created-app card can name and draw it as the
  // Document (or whatever) it is rather than a generic app.
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined;
}


function ChatInterface({
  workspaceId,
  overseer,
  restricted,
  selectedChatId,
  onNavigateToChat,
  chatContent,
  pendingConsoleLogCount,
  consoleLogPreview,
  consoleLogSeverity,
  onConsumeConsoleLogs,
  onDiscardConsoleLogs,
  onAutoApproveChange,
  sidebarMode,
  sidebarWidth = 280,
  onSidebarResize,
  renderExtraTab,
  constrainChatWidth,
  onOpenGadget,
  outputOfWorkpiece,
}: ChatInterfaceProps) {
  const toasts = useKumoToastManager();
  const { currentUser, authenticatedApi } = useAuthenticatedApi();
  const getOverseer = useCallback(() => overseer, [overseer]);
  // This component owns the workspace's chat store: it opens the subscription (reopening on
  // reconnects) and feeds the selector hooks below, which every other reader in the tree goes
  // through. The store lives in a session registry, so navigating away and back is instant.
  const store = useChatStoreConnection({
    workspaceId,
    overseer,
    selectedChatId,
    toasts,
    onNavigateToChat,
  });
  // The current selection as a ref, for awaits that must not act on a chat the user has left.
  const selectedChatIdRef = useRef(selectedChatId);
  selectedChatIdRef.current = selectedChatId;

  // Chat state, each slice a stable identity until it changes: components re-render only for
  // what they read (see store/useChatStore.ts).
  const chatList = useChatList(workspaceId);
  const chatListReady = useChatListReady(workspaceId);
  const currentMessages = useChatMessages(workspaceId, selectedChatId);
  const currentCompactions = useChatCompactions(workspaceId, selectedChatId);
  const currentChatMetadata = useChatMetadata(workspaceId, selectedChatId);
  const currentProvisionalState = useChatProvisionalState(workspaceId, selectedChatId);
  const currentRowBuffer = useChatRowBuffer(workspaceId, selectedChatId);
  const isLoading = useChatIsLoadingHistory(workspaceId, selectedChatId);
  const availableModels = useChatModels(workspaceId);
  const selectedModel = useSelectedChatModel(workspaceId);
  const setSelectedModel = useCallback(
    (model: string | null) => store.setSelectedModel(model),
    [store],
  );
  // UI state
  // Out-of-credits modal (free-tier limit reached). `usageModalShownFor` tracks the error sequence
  // we've already auto-opened for, so dismissing it doesn't immediately reopen.
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  // Why the modal is open — the usage_limit surface or a plan-refusal code — picked up from the
  // error that opened it, so the SaaS upgrade prompt can say what to upgrade for.
  const [usageModalReason, setUsageModalReason] = useState<"usage_limit" | PlanRefusalCode>("usage_limit");
  const usageModalShownForRef = useRef<number | null>(null);
  const [chatListScope, setChatListScope] = useState<ChatListScope>("all");
  // Fetching the page before the selected chat's compaction boundary.
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  // List, changes, and connection-request flow state lives in its hooks below
  // (useChatListActions, useChatChanges, useConnectionRequests).
  const toolCallExpansion = useExpansionSet<string>();
  const [showThinkingTraces, setShowThinkingTraces] = useState(
    () => getStoredShowThinkingTraces(),
  );
  const actionExpansion = useExpansionSet<number>();
  const errorExpansion = useExpansionSet<string>();
  const compactionExpansion = useExpansionSet<number>();
  const [sidebarActiveTab, setSidebarActiveTab] = useState<
    "chat" | "connections"
  >("chat");
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);

  // Sidebar resize handling.
  //
  // We use Pointer Events with setPointerCapture rather than global mousemove/
  // mouseup listeners. The gadget runs in an iframe; if the user drags the
  // resize handle and the cursor crosses into the iframe, the iframe captures
  // mouse events and the parent window never receives mouseup. The drag would
  // then "stick" to the cursor even after release. Pointer capture routes all
  // pointermove/pointerup events to the handle until release, regardless of
  // what's under the cursor — including iframes.
  const handleSidebarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsSidebarResizing(true);
    },
    [],
  );
  const handleSidebarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const newWidth = Math.max(200, Math.min(500, e.clientX));
      onSidebarResize?.(newWidth);
    },
    [onSidebarResize],
  );
  const handleSidebarPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsSidebarResizing(false);
    },
    [],
  );

  // Apply page-level cursor + user-select only while a resize is in progress.
  useEffect(() => {
    if (!isSidebarResizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isSidebarResizing]);

  // The transcript's scroll container. Reader affordances (follow-the-live-edge with
  // back-off, missed-row pill, turn anchoring) live in useMessageScroller.
  const messagesContainerRef = useRef<HTMLDivElement>(null);


  // In sidebar mode, auto-select the most recent chat when none is selected.
  useEffect(() => {
    if (
      sidebarMode &&
      selectedChatId === null &&
      chatListReady &&
      chatList.length > 0
    ) {
      onNavigateToChat(chatList[0].id, { replace: true });
    }
  }, [sidebarMode, selectedChatId, chatListReady, chatList, onNavigateToChat]);

  const messageStates = useMemo(() => computeMessageStates(currentMessages), [currentMessages]);
  // Declared bots for the composer's agent picker, plus its pick (a chat's own bot wins while
  // that chat is open; Home's stored pick covers the no-chat case).
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [selectedBot, setSelectedBot] = useState<BotSelection | null>(null);


  // ─── action hooks ──────────────────────────────────────────────────────────
  // Each flow owns its own state; ChatInterface orchestrates the results.
  const {
    handleSend,
    handleNewChatSend,
    handleModelChange,
    handleBotChange,
    retryModelId,
    handleStop,
    handleToggleHook,
    processingActions,
    setProcessingActions,
    handleRetry,
    handleCopyMessage,
    currentFailedSends,
    retryFailedSend,
    dismissFailedSend,
  } = useChatActions({
    overseer,
    selectedChatId,
    selectedModel,
    setSelectedModel,
    bots,
    selectedBot,
    setSelectedBot,
    onNavigateToChat,
    store,
    toasts,
    currentChatMetadata,
  });

  const {
    titleInput,
    setTitleInput,
    isEditingTitle,
    setIsEditingTitle,
    renamingChatId,
    renamingInput,
    setRenamingInput,
    deleteTarget,
    setDeleteTarget,
    isDeleting,
    handleSaveChatTitle,
    handleCancelTitleEdit,
    handleDeleteChat,
    handleDeleteConfirm,
    cancelListRename,
    startListRename,
    handleSaveListRename,
  } = useChatListActions({
    overseer,
    selectedChatId,
    currentChatMetadata,
    store,
    toasts,
  });

  const {
    staleAcceptChatId,
    setStaleAcceptChatId,
    isUpdatingFromMainline,
    unresolvedConflicts,
    setUnresolvedConflicts,
    discardChangesTarget,
    setDiscardChangesTarget,
    discardingChangesChatIds,
    handleMergeChanges,
    handleAcceptChanges,
    handleUpdateFromMainline,
    handleFinalizeDraftChanges,
    handleDiscardDraftChanges,
    handleDiscardPendingChanges,
    handleRevertChanges,
  } = useChatChanges({
    overseer,
    selectedChatId,
    selectedChatIdRef,
    currentChatMetadata,
    currentMessages,
    messageStates,
    chatContent,
    toasts,
  });

  const {
    connectionAccept,
    setConnectionAccept,
    processingConnections,
    handleAcceptConnection,
    handleConnectionCreated,
    handleDenyConnection,
  } = useConnectionRequests({ overseer, toasts });
  // A pending agent connection request blocks the composer: the user must accept ("Set up") or deny
  // it before continuing the conversation.
  const hasPendingConnectionRequest = useMemo(
    () => currentMessages.some(
      (msg) => msg.type === "connectionRequest" && msg.state === "pending",
    ),
    [currentMessages],
  );
  // A pending awaitDecision action also blocks the composer: the agent turn is suspended until the
  // user approves or rejects it, so (like a connection request) further input must wait.
  const hasPendingAwaitedAction = useMemo(
    () => currentMessages.some(
      (msg) => msg.type === "action" &&
        msg.actionLog?.type === "action" &&
        msg.actionLog.state === "pending" &&
        msg.actionLog.description.awaitDecision === true,
    ),
    [currentMessages],
  );
  // A gadget's stamped format, looked up by the id a finished createGadget call reports, so the
  // transcript can say "Created Doc" with the Doc icon.
  const resolveToolOutput = useCallback(
    (tc: AiToolCall) => resolveToolCallOutput(tc, outputOfWorkpiece),
    [outputOfWorkpiece],
  );


  const displayEntries = useMemo(
    () =>
      // Hide agent checkpoints; surface them as turn-level discard actions. User-saved
      // checkpoints get their own compact row so the discard action is attached to the
      // edit that actually created it.
      buildChatDisplayEntries(
        currentMessages, messageStates.changeStatus, currentCompactions, resolveToolOutput, currentFailedSends),
    [currentMessages, messageStates, currentCompactions, resolveToolOutput, currentFailedSends],
  );

  const entryTopClasses = useMemo(() => {
    const out: string[] = Array.from({ length: displayEntries.length });
    for (let i = 0; i < displayEntries.length; i++) {
      out[i] = rhythmTopClass(i > 0 ? displayEntries[i - 1] : null, displayEntries[i]);
    }
    return out;
  }, [displayEntries]);

  const queuedSteers = currentChatMetadata?.queuedSteers;

  // Hide the user name on user message rows when the only human in the chat is the
  // currently-logged-in user (it would just say "you" on every message). If anyone else has ever
  // posted in this chat, or has a steer queued, names stay so it's clear who said what.
  const hideOwnUserName = useMemo(() => {
    if (!currentUser) return false;
    if (queuedSteers?.some((steer) => steer.author.id !== currentUser.id)) return false;
    let sawSelf = !!queuedSteers?.length;
    for (const msg of currentMessages) {
      if (msg.type !== "message" || msg.author.type !== "user") continue;
      if (msg.author.id !== currentUser.id) return false;
      sawSelf = true;
    }
    return sawSelf;
  }, [currentMessages, currentUser, queuedSteers]);

  const lastMessageSequence = currentMessages[currentMessages.length - 1]?.sequence;

  // Auto-open the out-of-credits modal once when the latest message is a usage-limit error.
  const lastMessage = currentMessages[currentMessages.length - 1];
  useEffect(() => {
    if (
      lastMessage &&
      lastMessage.type === "error" &&
      (lastMessage.code === "usage_limit" || isPlanRefusalCode(lastMessage.code)) &&
      usageModalShownForRef.current !== lastMessage.sequence
    ) {
      usageModalShownForRef.current = lastMessage.sequence;
      if (lastMessage.code === "usage_limit") setUsageModalReason("usage_limit");
      else if (isPlanRefusalCode(lastMessage.code)) setUsageModalReason(lastMessage.code);
      setUsageModalOpen(true);
    }
  }, [lastMessage]);

  // Download a committed chat attachment. Image bytes are already inlined on the message; other
  // attachments are fetched on demand over the authenticated RPC connection.
  const downloadChatAttachment = useCallback(async (chatId: number, attachment: ChatAttachmentRef) => {
    try {
      let bytes = attachment.content;
      if (!bytes) {
        bytes = await overseer.getChatAttachmentContent(chatId, attachment.id);
      }
      triggerBlobDownload(
        new Blob([bytes as BlobPart], {type: attachment.mimeType || "application/octet-stream"}),
        attachment.name ?? "attachment",
      );
    } catch (err: any) {
      console.error("Failed to download chat attachment:", err);
      toasts.add({ title: err?.message || "Failed to download attachment", variant: "error" });
    }
  }, [overseer, toasts]);


  // Whether the live window holds *human* draft edits -- the rows the draft banner describes.
  // Server-authored rows (agent edits, mainline merges) share the same stream but must not
  // raise the banner: the agent's activity has its own streaming UI. Derived from the rows
  // (rather than tracked) so pruning -- materialization watermarks, generation bumps -- can
  // never leave it stale.
  const currentHasUserDraftRows =
    currentRowBuffer !== null && currentRowBuffer.rows.some(row => row.submission !== undefined);

  const provisionalToolCalls = currentProvisionalState?.toolCalls ?? [];
  const useConstrainedChatWidth = sidebarMode || constrainChatWidth;

  const isCompacting = currentProvisionalState?.compacting === true;

  const hasVisibleProvisionalContent =
    !!currentProvisionalState &&
    (currentProvisionalState.text !== "" ||
      currentProvisionalState.reasoning !== "" ||
      currentProvisionalState.compacting ||
      provisionalToolCalls.length > 0);

  const isAgentActive = !!currentChatMetadata?.activeAgent;
  const activeAgent = currentChatMetadata?.activeAgent;
  // Names the chat's own model in the composer even when the picker no longer offers it.
  const chatAgent = activeAgent ?? inferChatAgentFromMessages(currentMessages);

  // Reader affordances for the transcript. Declared before the follow/anchor effects below so
  // its entries effect runs first in each commit: it updates follow state (and may anchor a
  // prompt sent mid-turn) before the follow effect decides whether to scroll.
  const scroller = useMessageScroller({
    containerRef: messagesContainerRef,
    chatId: selectedChatId,
    entries: displayEntries,
    isTurnActive: isAgentActive,
  });


  // Loads the page before the oldest message on screen. Held in a ref because the scroll handler is
  // built once, while the loader closes over state that changes each render.
  const loadEarlierRef = useRef<() => void>(() => {});

  // Height of the message area just before an earlier page is prepended. Restoring against it keeps
  // the user on what they were reading instead of jumping them backwards.
  const prependAnchorRef = useRef<number | undefined>(undefined);

  // Scroll events update the scroller's follow state, and approaching the top pulls in the
  // previous page, so a compacted thread reads as one continuous scroll rather than making the
  // user ask for their own history.
  const handleMessagesScroll = useCallback(() => {
    scroller.handleScroll();
    const el = messagesContainerRef.current;
    if (el && el.scrollTop <= EARLIER_PAGE_PREFETCH_PX) loadEarlierRef.current();
  }, [scroller.handleScroll]);

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (prependAnchorRef.current !== undefined) {
      el.scrollTop += el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = undefined;
    } else if (el.scrollHeight <= el.clientHeight) {
      // A short page leaves nothing to scroll, so no scroll event would ever ask for the rest.
      loadEarlierRef.current();
    }
  });

  // Auto-scroll to the live edge when messages change, but only while the reader still follows it.
  // The provisional state's identity rides along so growing stream text keeps following too: the
  // durable deps (currentMessages, hasVisibleProvisionalContent) hold steady while a turn streams.
  useLayoutEffect(() => {
    scroller.followContent();
  }, [
    currentMessages,
    hasVisibleProvisionalContent,
    isAgentActive,
    currentProvisionalState,
    queuedSteers?.length,
    scroller.followContent,
  ]);

  // Always scroll to bottom and close transient chat UI when switching chats.
  useLayoutEffect(() => {
    scroller.resetToBottom();
  }, [selectedChatId, scroller.resetToBottom]);
  useEffect(() => {
    setDiscardChangesTarget(null);
    setStaleAcceptChatId(null);
    setUnresolvedConflicts(null);
  }, [selectedChatId]);

  // Initialize title input when selecting a chat
  useEffect(() => {
    if (currentChatMetadata) {
      setTitleInput(currentChatMetadata.title);
    }
  }, [currentChatMetadata?.title]);

  // Update selected model when switching chats
  useEffect(() => {
    if (selectedChatId === null) {
      setSelectedModel(getStoredSelectedModel(availableModels));
      setSelectedBot(getStoredSelectedBot(bots));
    } else {
      // An existing thread takes its active agent's model, else the one that last spoke.
      setSelectedModel(fallbackToStoredModelSelection(chatAgent?.id ?? null, availableModels));
      // The chat's declared bot initializes the picker — but only while it still resolves and is
      // usable; a stale or unavailable bot shows as a disabled row instead (staleChatBotName).
      const metaBot = currentChatMetadata?.bot ?? null;
      setSelectedBot(
        metaBot === null || !bots.some((bot) => sameBotSelection(bot.selection, metaBot) && bot.available)
          ? null
          : metaBot);
    }
  }, [selectedChatId, availableModels, chatAgent?.id, bots, currentChatMetadata?.bot]);

  // Load the declared bots for the agent picker (user's own + deployment-wide). Retried on
  // reconnect like the models fetch; a failure leaves the picker model-only.
  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listBots()
      .then((list) => {
        if (!cancelled) setBots(list);
      })
      .catch((err) => {
        logRpcFailure("Failed to fetch bots:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  // Reset per-chat UI state when selectedChatId changes. Compaction summaries keep their
  // expansion: their keys are boundary sequences, which are stable across views. The reset
  // functions are stable (see useExpansionSet), so this runs on chat switches only — not on
  // every expansion toggle.
  useEffect(() => {
    toolCallExpansion.reset();
    actionExpansion.reset();
    errorExpansion.reset();
    setIsLoadingEarlier(false);
    setIsEditingTitle(false);
    setSidebarActiveTab("chat");
  }, [
    selectedChatId,
    toolCallExpansion.reset,
    actionExpansion.reset,
    errorExpansion.reset,
  ]);

  // While the chat is shown, the workspace keeps the model provider's cache of it warm. Disposing
  // the call's promise disposes the lease it resolves to, even if it hasn't resolved yet.
  useEffect(() => {
    if (selectedChatId === null) return;
    const lease = overseer.viewChat(selectedChatId);
    return () => lease[Symbol.dispose]();
  }, [overseer, selectedChatId]);

  // Sequence of the oldest message loaded, or undefined once the thread's start is loaded. Paging
  // asks for what precedes it, so the control disappears exactly when there is nothing earlier.
  const oldestLoadedSequence = currentMessages[0]?.sequence;
  const hasEarlierMessages = oldestLoadedSequence !== undefined && oldestLoadedSequence > 0;

  // Load the page before the oldest message on screen. Those messages are all older than anything
  // the subscription delivers, so lastMessageTimestamp is left alone.
  const handleShowEarlierMessages = async () => {
    if (selectedChatId === null || !hasEarlierMessages || isLoadingEarlier) return;

    setIsLoadingEarlier(true);
    try {
      // Capture the anchor before the load: the store ingests the page (and re-renders the
      // transcript) the moment it resolves, before this await returns control here.
      prependAnchorRef.current = messagesContainerRef.current?.scrollHeight;
      await store.loadHistoryPage(selectedChatId, oldestLoadedSequence);
    } finally {
      setIsLoadingEarlier(false);
    }
  };

  loadEarlierRef.current = () => { void handleShowEarlierMessages(); };


  // Pending "always approve this type" confirmation, opened from a pending action card.
  const [autoApproveConfirm, setAutoApproveConfirm] = useState<AutoApproveTarget | null>(null);

  // Enable auto-approval of an action tag on its connection (gated by the confirm dialog). The
  // server applies the now-eligible pending action(s) via its drain, and the action state flips to
  // "approved" through the actions subscription -- so we don't optimistically mutate it here.
  const { alwaysApproveTag, isTagAutoApproved } =
    useAlwaysApproveTag(overseer, setProcessingActions, onAutoApproveChange);

  const { resolveAction, creationAccountModal } =
    useResolveAction(overseer, setProcessingActions, (actionId, state) => {
      store.applyOptimisticActionState(actionId, state);
    });


  const toggleShowThinkingTraces = useCallback(() => {
    setShowThinkingTraces((prev) => {
      const next = !prev;
      persistShowThinkingTraces(next);
      return next;
    });
  }, []);


  // The current epoch's opening sequence (see ChatCodeBase.epoch), zero when the epoch spans the
  // whole chat. A *pending* changes message before it exists only in chats converted from
  // pre-git storage -- its content rides the conversion boundary's collapsed change, and the
  // server refuses to revert it individually -- so no per-message discard affordance is offered
  // below the epoch. (In merge-opened epochs every pre-epoch change is already merged, so the
  // cutoff changes nothing there.)
  const chatEpoch = currentChatMetadata?.codeBase?.epoch ?? 0;

  const {
    lastDurablePendingChange,
    hasPendingBlueprintProposal,
    completedAgentTurnMessageSeqs,
    latestCompletedAgentTurnMessageSeq,
    pendingChangeByTurnItemSeq,
    createdWorkpiecesByTurnItemSeq,
  } = usePendingTurnChanges({
    currentMessages,
    messageStates,
    isAgentActive,
    chatEpoch,
    outputOfWorkpiece,
  });

  // ─── sidebar list content (reused in both modes) ──────────────────────────
  const chatListPanel = (
    <ChatListPanel
      chatList={chatList}
      chatListScope={chatListScope}
      setChatListScope={setChatListScope}
      chatListReady={chatListReady}
      sidebarMode={sidebarMode}
      selectedChatId={selectedChatId}
      onNavigateToChat={onNavigateToChat}
      renamingChatId={renamingChatId}
      renamingInput={renamingInput}
      setRenamingInput={setRenamingInput}
      startListRename={startListRename}
      cancelListRename={cancelListRename}
      handleSaveListRename={handleSaveListRename}
      handleDeleteChat={handleDeleteChat}
      useConstrainedChatWidth={useConstrainedChatWidth}
      workspaceId={workspaceId}
      overseer={overseer}
      getOverseer={getOverseer}
      currentUser={currentUser}
      availableModels={availableModels}
      selectedModel={selectedModel}
      handleModelChange={handleModelChange}
      bots={bots}
      selectedBot={selectedBot}
      handleBotChange={handleBotChange}
      showThinkingTraces={showThinkingTraces}
      toggleShowThinkingTraces={toggleShowThinkingTraces}
      handleNewChatSend={handleNewChatSend}
    />
  );

  // ─── main render ─────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex h-full bg-kumo-base ${sidebarMode ? "flex-row" : "flex-col"}`}
    >
      {/* ── Sidebar mode: conversations list on the left ───────────────────── */}
      {sidebarMode && (
        <>
          <div
            className="flex flex-col border-r border-kumo-line flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            {chatListPanel}
          </div>
          {/* Resize handle */}
          <div
            className="w-1 flex-shrink-0 bg-kumo-line hover:bg-kumo-brand cursor-col-resize transition-colors relative touch-none"
            onPointerDown={handleSidebarPointerDown}
            onPointerMove={handleSidebarPointerMove}
            onPointerUp={handleSidebarPointerUp}
            onPointerCancel={handleSidebarPointerUp}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        </>
      )}

      {/* ── Non-sidebar mode: show list OR chat ────────────────────────────── */}
      {!sidebarMode && selectedChatId === null ? (
        chatListPanel
      ) : selectedChatId !== null ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Tab bar — in sidebar mode, show Chat / Connections tabs */}
          {sidebarMode && (
            <div className="flex h-12 flex-shrink-0 items-center gap-5 border-b border-kumo-line px-4">
              <button
                type="button"
                onClick={() => setSidebarActiveTab("chat")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "chat"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setSidebarActiveTab("connections")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "connections"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Connections
              </button>
            </div>
          )}

          {/* Connections tab content */}
          {sidebarMode &&
            sidebarActiveTab === "connections" &&
            renderExtraTab && (
              <div className="flex-1 overflow-auto">{renderExtraTab()}</div>
            )}

          {/* Chat content — hidden when connections tab is active in sidebar mode */}
          {(!sidebarMode || sidebarActiveTab === "chat") && (
            <>
              {/* Chat sub-header — hidden in sidebar mode (list is always visible) */}
              <ChatHeaderBar
                sidebarMode={sidebarMode}
                onNavigateToChat={onNavigateToChat}
                isEditingTitle={isEditingTitle}
                titleInput={titleInput}
                setTitleInput={setTitleInput}
                handleSaveChatTitle={handleSaveChatTitle}
                handleCancelTitleEdit={handleCancelTitleEdit}
                chatTitle={currentChatMetadata?.title}
                botName={currentChatMetadata?.botName}
                setIsEditingTitle={setIsEditingTitle}
                handleDeleteChat={() => handleDeleteChat()}
              />
              {/* Messages */}
              <div className="relative flex min-h-0 flex-1">
                <div
                  ref={messagesContainerRef}
                  onScroll={handleMessagesScroll}
                  {...scroller.intentEvents}
                  tabIndex={0}
                  role="region"
                  aria-label="Conversation transcript"
                  className="chat-panel scroll-fade-y h-full min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-inset"
                >
                  <ChatTranscript
                    isLoading={isLoading}
                    isLoadingEarlier={isLoadingEarlier}
                    pendingConsoleLogCount={pendingConsoleLogCount}
                    useConstrainedChatWidth={useConstrainedChatWidth}
                    displayEntries={displayEntries}
                    entryTopClasses={entryTopClasses}
                    currentUser={currentUser}
                    chatEpoch={chatEpoch}
                    onRetryFailedSend={retryFailedSend}
                    onDismissFailedSend={dismissFailedSend}
                    isAgentActive={isAgentActive}
                    activeAgent={activeAgent}
                    hideOwnUserName={hideOwnUserName}
                    showThinkingTraces={showThinkingTraces}
                    restricted={restricted}
                    lastMessageSequence={lastMessageSequence}
                    currentMessages={currentMessages}
                    queuedSteers={queuedSteers}
                    turnChanges={{
                      lastDurablePendingChange,
                      pendingChangeByTurnItemSeq,
                      createdWorkpiecesByTurnItemSeq,
                      completedAgentTurnMessageSeqs,
                      latestCompletedAgentTurnMessageSeq,
                      handleRevertChanges,
                    }}
                    expansion={{
                      toolCalls: toolCallExpansion,
                      actions: actionExpansion,
                      errors: errorExpansion,
                      compactions: compactionExpansion,
                    }}
                    tools={{
                      resolveToolOutput,
                      onOpenGadget,
                      getOverseer,
                    }}
                    actionCards={{
                      processingActions,
                      resolveAction,
                      setAutoApproveConfirm,
                      isTagAutoApproved,
                      handleToggleHook,
                    }}
                    connections={{
                      processingConnections,
                      handleAcceptConnection,
                      handleDenyConnection,
                    }}
                    errorHandling={{
                      setUsageModalOpen,
                      handleRetry,
                      retryModelId,
                    }}
                    messages={{
                      messageStates,
                      handleCopyMessage,
                      downloadChatAttachment,
                    }}
                    currentRowBuffer={currentRowBuffer}
                    currentHasUserDraftRows={currentHasUserDraftRows}
                    handleDiscardDraftChanges={handleDiscardDraftChanges}
                    handleFinalizeDraftChanges={handleFinalizeDraftChanges}
                    currentProvisionalState={currentProvisionalState}
                    provisionalToolCalls={provisionalToolCalls}
                    isCompacting={isCompacting}
                  />
                </div>
                <MissedMessagesStatus
                  missedCount={scroller.missedCount}
                  isTurnActive={isAgentActive}
                />
                {!scroller.atBottom && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                    <JumpToLatestPill
                      missedCount={scroller.missedCount}
                      onJump={scroller.jumpToLatest}
                    />
                  </div>
                )}
              </div>

              <ChatComposerBar
                sidebarMode={sidebarMode}
                useConstrainedChatWidth={useConstrainedChatWidth}
                workspaceId={workspaceId}
                selectedChatId={selectedChatId}
                overseer={overseer}
                getOverseer={getOverseer}
                handleSend={handleSend}
                isAgentActive={isAgentActive}
                availableModels={availableModels}
                selectedModel={selectedModel}
                chatAgent={chatAgent}
                handleModelChange={handleModelChange}
                bots={bots}
                selectedBot={selectedBot}
                handleBotChange={handleBotChange}
                staleBotName={currentChatMetadata
                  ? staleChatBotName(currentChatMetadata, bots)
                  : undefined}
                pendingConsoleLogCount={pendingConsoleLogCount}
                consoleLogPreview={consoleLogPreview}
                consoleLogSeverity={consoleLogSeverity}
                onConsumeConsoleLogs={onConsumeConsoleLogs}
                onDiscardConsoleLogs={onDiscardConsoleLogs}
                handleStop={handleStop}
                queuedSteers={queuedSteers}
                showThinkingTraces={showThinkingTraces}
                toggleShowThinkingTraces={toggleShowThinkingTraces}
                currentUser={currentUser}
                hasPendingConnectionRequest={hasPendingConnectionRequest}
                hasPendingAwaitedAction={hasPendingAwaitedAction}
                currentChatMetadata={currentChatMetadata}
                hasPendingBlueprintProposal={hasPendingBlueprintProposal}
                discardingChangesChatIds={discardingChangesChatIds}
                discardChangesTarget={discardChangesTarget}
                setDiscardChangesTarget={setDiscardChangesTarget}
                handleDiscardPendingChanges={handleDiscardPendingChanges}
                handleAcceptChanges={handleAcceptChanges}
              />
            </>
          )}
        </div>
      ) : null}

      <ChatDialogs
        staleAcceptChatId={staleAcceptChatId}
        setStaleAcceptChatId={setStaleAcceptChatId}
        isUpdatingFromMainline={isUpdatingFromMainline}
        handleUpdateFromMainline={handleUpdateFromMainline}
        unresolvedConflicts={unresolvedConflicts}
        setUnresolvedConflicts={setUnresolvedConflicts}
        handleMergeChanges={handleMergeChanges}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        isDeleting={isDeleting}
        handleDeleteConfirm={handleDeleteConfirm}
        restricted={restricted}
        autoApproveConfirm={autoApproveConfirm}
        processingActions={processingActions}
        setAutoApproveConfirm={setAutoApproveConfirm}
        alwaysApproveTag={alwaysApproveTag}
        creationAccountModal={creationAccountModal}
        connectionAccept={connectionAccept}
        setConnectionAccept={setConnectionAccept}
        getOverseer={getOverseer}
        handleConnectionCreated={handleConnectionCreated}
        usageModalOpen={usageModalOpen}
        setUsageModalOpen={setUsageModalOpen}
        usageModalReason={usageModalReason}
      />
    </div>
  );
}

export default ChatInterface;
