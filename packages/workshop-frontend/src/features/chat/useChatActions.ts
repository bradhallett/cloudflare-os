import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  AiChatMessage,
  AiChatMetadata,
  BotInfo,
  BotSelection,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  GatekeeperClient,
  MessageFormatRef,
  Overseer,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { RpcStub } from "capnweb";
import type { ChatContentReader } from "../code/otClient";
import { commitFileStore, type CommitFileReader } from "../code/commitFileStore";
import { hookToggleFailureToast } from "../../components/HookToggle";
import { logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { persistSelectedBot, persistSelectedModel, sameBotSelection } from "../../modelSelection";
import { copyToClipboard } from "../../clipboard";
import {
  findUnresolvedConflicts,
  listConflictedFiles,
  type UnresolvedConflict,
} from "./mergeConflicts";
import type { ChatCache, Toasts } from "./useChatSubscription";
import type { MessageState } from "./transcript/chatDisplayEntries";
import type { FailedChatSend } from "./transcript/failedSends";
import { failedSendFromRejection } from "./transcript/failedSends";

/** The accept-flow GatekeeperModal's pre-seeded connection request (see AiChatMetadata). */
interface ConnectionAccept {
  requestId: string;
  vendorId: string;
  resourceUrl?: string;
  resourceUrlPattern?: string;
}

/**
 * State and helpers the chat's RPC handlers read or write. All state stays owned by
 * ChatInterface; the handlers arrive assembled around it.
 */
export interface UseChatActionsArgs {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  selectedModel: string | null;
  setSelectedModel: Dispatch<SetStateAction<string | null>>;
  /** Declared bots offered in the composer's agent picker (see AuthenticatedApi.listBots). */
  bots: BotInfo[];
  /** The picker's bot selection, or null when a model or "No agent" answers the chat. */
  selectedBot: BotSelection | null;
  setSelectedBot: Dispatch<SetStateAction<BotSelection | null>>;
  /** Mirrors selectedChatId for callbacks that must not capture a stale id. */
  selectedChatIdRef: { current: number | null };
  /** Latest onNavigateToChat, for callbacks built once that must call the current one. */
  onNavigateToChatRef: {
    current: (chatId: number | null, options?: { replace?: boolean }) => void;
  };
  cacheRef: { current: ChatCache };
  forceUpdate: () => void;
  bumpChatListVersion: () => void;
  applyOptimisticHookEnabled: (actionId: number, enabled: boolean) => boolean;
  toasts: Toasts;
  /** The selected chat's metadata, undefined while it has not loaded. */
  currentChatMetadata: AiChatMetadata | null | undefined;
  currentMessages: AiChatMessage[];
  messageStates: MessageState;
  /** The selected chat's uncommitted content, checked for unresolved conflicts on accept. */
  chatContent: ChatContentReader | undefined;
  titleInput: string;
  setTitleInput: Dispatch<SetStateAction<string>>;
  setIsEditingTitle: Dispatch<SetStateAction<boolean>>;
  deleteTarget: { id: number; title: string } | null;
  setDeleteTarget: Dispatch<SetStateAction<{ id: number; title: string } | null>>;
  setIsDeleting: Dispatch<SetStateAction<boolean>>;
  renamingInput: string;
  setRenamingInput: Dispatch<SetStateAction<string>>;
  /** Which chat the list is renaming, kept in a ref so blur/commit races stay consistent. */
  renamingChatIdRef: { current: number | null };
  setRenamingChatId: Dispatch<SetStateAction<number | null>>;
  staleAcceptChatId: number | null;
  setStaleAcceptChatId: Dispatch<SetStateAction<number | null>>;
  setIsUpdatingFromMainline: Dispatch<SetStateAction<boolean>>;
  setUnresolvedConflicts: Dispatch<SetStateAction<UnresolvedConflict[] | null>>;
  discardChangesTarget: { chatId: number } | null;
  setDiscardChangesTarget: Dispatch<SetStateAction<{ chatId: number } | null>>;
  setDiscardingChangesChatIds: Dispatch<SetStateAction<Set<number>>>;
  setProcessingActions: Dispatch<SetStateAction<Set<number>>>;
  /** Latest connectionAccept, for the GatekeeperModal's onCreated callback. */
  connectionAcceptRef: { current: ConnectionAccept | null };
  setConnectionAccept: Dispatch<SetStateAction<ConnectionAccept | null>>;
  setProcessingConnections: Dispatch<SetStateAction<Set<string>>>;
  /** Records user sends the server definitively rejected, for the transcript's retry bubbles. */
  setFailedSends: Dispatch<SetStateAction<FailedChatSend[]>>;
}

/**
 * The chat's RPC handlers -- sending, model selection, title/rename/delete flows, the
 * accept/discard/revert changes flows (including conflict checks and update-from-mainline),
 * draft save/discard, hook toggles, connection-request accept/deny, retry, and copy-message.
 * Extracted verbatim from ChatInterface; every handler keeps its original name and closure
 * shape, with the shell's state threaded in through {@link UseChatActionsArgs}.
 */
export function useChatActions({
  overseer,
  selectedChatId,
  selectedModel,
  setSelectedModel,
  bots,
  selectedBot,
  setSelectedBot,
  selectedChatIdRef,
  onNavigateToChatRef,
  cacheRef,
  forceUpdate,
  bumpChatListVersion,
  applyOptimisticHookEnabled,
  toasts,
  currentChatMetadata,
  currentMessages,
  messageStates,
  chatContent,
  titleInput,
  setTitleInput,
  setIsEditingTitle,
  deleteTarget,
  setDeleteTarget,
  setIsDeleting,
  renamingInput,
  setRenamingInput,
  renamingChatIdRef,
  setRenamingChatId,
  staleAcceptChatId,
  setStaleAcceptChatId,
  setIsUpdatingFromMainline,
  setUnresolvedConflicts,
  discardChangesTarget,
  setDiscardChangesTarget,
  setDiscardingChangesChatIds,
  setProcessingActions,
  connectionAcceptRef,
  setConnectionAccept,
  setProcessingConnections,
  setFailedSends,
}: UseChatActionsArgs) {
  // Handle sending a message (always called from ChatComposer with explicit messageText)
  const handleSend = async (
    messageText?: string | SlashCommandRequest,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
    bot?: BotSelection | "none",
  ) => {
    const message = typeof messageText === "string" ? messageText.trim() : messageText ?? "";
    if (!message && (!attachments || attachments.length === 0)) return;

    // Use provided modelId or fall back to selectedModel
    const model = modelId !== undefined ? modelId : selectedModel;

    try {
      if (selectedChatId === null) {
        // Create a new chat (with optional capsules).
        const newChatId = await overseer.newChat(
            message, model, capsules, attachments, formats,
            bot === "none" ? undefined : bot);
        onNavigateToChatRef.current(newChatId);
      } else {
        // Send message to existing chat.
        await overseer.sendChatMessage(
          selectedChatId,
          message,
          model,
          capsules || undefined,
          attachments || undefined,
          formats,
          bot,
        );
      }
    } catch (err) {
      if (!logRpcFailure("Failed to send message:", err, { reportSite: "chat.send" })) {
        toasts.add({
          title: "Failed to send message",
          description: rpcFailureDescription(err),
          variant: "error",
        });
      }
      // A definitively rejected send leaves no server record, so the transcript holds it as a
      // failed-send bubble instead (transient failures stay with the composer's hiccup banner).
      const failedSend = failedSendFromRejection(
        selectedChatId,
        { message, modelId: model, capsules, attachments, formats, bot },
        err,
      );
      if (failedSend) setFailedSends((prev) => [...prev, failedSend]);
      throw err;
    }
  };

  // Handle creating a new chat from the sidebar (always creates, never sends to existing)
  const handleNewChatSend = async (
    messageText?: string | SlashCommandRequest,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
    bot?: BotSelection | "none",
  ) => {
    const message = typeof messageText === "string" ? messageText.trim() : messageText ?? "";
    if (!message && (!attachments || attachments.length === 0)) return;
    const model = modelId !== undefined ? modelId : selectedModel;
    try {
      const newChatId = await overseer.newChat(
          message, model, capsules, attachments, formats,
          bot === "none" ? undefined : bot);
      onNavigateToChatRef.current(newChatId);
    } catch (err) {
      if (!logRpcFailure("Failed to create new chat:", err, { reportSite: "chat.new" })) {
        toasts.add({
          title: "Failed to start conversation",
          description: rpcFailureDescription(err),
          variant: "error",
        });
      }
      throw err;
    }
  };

  // Handle model change. Picking a bare model answers "who runs this chat" with the model, so
  // the composer's bot pick (if any) yields; the change itself rides the next send.
  const handleModelChange = (modelId: string | null) => {
    setSelectedModel(modelId);
    persistSelectedModel(modelId);
    if (selectedBot !== null) {
      setSelectedBot(null);
      persistSelectedBot(null);
    }
  };

  // Handle bot change: a bot pick also selects the bot's model for the composer, and persists
  // the pick as the intake default (Home reuses it).
  const handleBotChange = (bot: BotSelection | null) => {
    setSelectedBot(bot);
    persistSelectedBot(bot);
    const botModel = bot === null ? null
      : bots.find((candidate) => sameBotSelection(candidate.selection, bot))?.modelId ?? null;
    setSelectedModel(botModel);
    persistSelectedModel(botModel);
  };

  // Handle stopping the agent
  const handleStop = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.stopAgent(selectedChatId);
    } catch (err) {
      console.error("Failed to stop agent:", err);
      toasts.add({ title: "Failed to stop agent", variant: "error" });
      throw err;
    }
  };

  // Handle saving chat title
  const handleSaveChatTitle = async () => {
    if (selectedChatId === null || !titleInput.trim()) {
      return;
    }

    try {
      await overseer.setChatTitle(selectedChatId, titleInput.trim());

      // Update the cache with the new title
      const chat = cacheRef.current.chats.get(selectedChatId);
      if (chat) {
        cacheRef.current.chats.set(selectedChatId, {
          ...chat,
          title: titleInput.trim(),
        });
        forceUpdate();
      }

      setIsEditingTitle(false);
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle canceling title edit
  const handleCancelTitleEdit = () => {
    setTitleInput(currentChatMetadata?.title || "");
    setIsEditingTitle(false);
  };

  // Handle deleting a chat. Can be called from the chat header (no args) or the
  // chat list (with explicit chatId/title).
  const handleDeleteChat = (chatId?: number, chatTitle?: string) => {
    const id = chatId ?? selectedChatId;
    const title = chatTitle ?? currentChatMetadata?.title ?? "this chat";
    if (id === null || id === undefined) return;
    setDeleteTarget({ id, title });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await overseer.deleteChat(deleteTarget.id);
      toasts.add({ title: "Chat deleted successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to delete chat:", err);
      toasts.add({ title: "Failed to delete chat", variant: "error" });
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  };

  const cancelListRename = () => {
    renamingChatIdRef.current = null;
    setRenamingChatId(null);
  };

  const startListRename = (chatId: number, title: string) => {
    renamingChatIdRef.current = chatId;
    setRenamingInput(title);
    setRenamingChatId(chatId);
  };

  // Handle saving a renamed chat from the list view
  const handleSaveListRename = async (chatId: number) => {
    if (renamingChatIdRef.current !== chatId) return;

    renamingChatIdRef.current = null;
    setRenamingChatId(null);

    const trimmed = renamingInput.trim();
    const existing = cacheRef.current.chats.get(chatId);
    // Cancel on empty or no-op so commit-on-blur doesn't fire pointless RPCs.
    if (!trimmed || trimmed === existing?.title) return;

    try {
      await overseer.setChatTitle(chatId, trimmed);
      if (existing) {
        cacheRef.current.chats.set(chatId, {
          ...existing,
          title: trimmed,
        });
        bumpChatListVersion();
        forceUpdate();
      }
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle accepting the chat's proposed changes. A merge always takes everything the chat
  // proposes -- live drafts are swept in and there is no partial accept (see
  // Overseer.mergeChanges()). Accepting is only ever a fast-forward; a "stale" outcome (mainline
  // advanced past the chat's pins) is expected control flow that opens the update-from-mainline
  // dialog rather than an error.
  const handleMergeChanges = async () => {
    if (selectedChatId === null) return;

    try {
      const result = await overseer.mergeChanges(selectedChatId);
      if (result.outcome === "stale") {
        setStaleAcceptChatId(selectedChatId);
        return;
      }
      toasts.add({ title: "Changes accepted", variant: "success" });
    } catch (err) {
      console.error("Failed to accept changes:", err);
      toasts.add({
        title: "Failed to accept changes",
        description: rpcFailureDescription(err),
        variant: "error",
      });
    }
  };

  // What "Accept changes" does. The server merges whatever the chat's files hold, so leftover
  // conflict markers are caught here: the files that the chat's merges listed as conflicted are
  // searched for one, and finding any puts the decision to the user. Content that has not
  // loaded cannot be searched, and holds nothing up. A file nobody has edited since its merge
  // is read from the commit the chat is pinned at, which the merge wrote.
  const overseerFileReader: CommitFileReader = {
    listTree: (commitId) => overseer.listTree(commitId),
    readFilesAtCommit: (commitId, paths) => overseer.readFilesAtCommit(commitId, paths),
    listChangedPaths: (fromCommit, toCommit) => overseer.listChangedPaths(fromCommit, toCommit),
  };
  const handleAcceptChanges = async () => {
    const chatId = selectedChatId;
    const reader = chatContent?.chatId === chatId ? chatContent : undefined;
    const content = reader?.read();
    if (reader !== undefined && content !== undefined) {
      const conflicted = listConflictedFiles(currentMessages, messageStates.changeStatus);
      // What is searched is the content on screen, and what the server merges is the content
      // it has been sent. While an edit is on its way the two differ, and the edit may be the
      // one that removed the last marker.
      if (conflicted.length > 0 && reader.hasLocalEdits()) {
        toasts.add({
          title: "Your latest edits are still being saved. Try accepting again in a moment.",
        });
        return;
      }
      const pins = currentChatMetadata?.codeBase?.pins ?? [];
      let unresolved: UnresolvedConflict[];
      try {
        unresolved = await findUnresolvedConflicts(
          conflicted, content,
          (gadgetId) => pins.find((pin) => pin.gadgetId === gadgetId)?.baseCommit,
          (commitId, paths) => commitFileStore.readFiles(overseerFileReader, commitId, paths));
      } catch (err) {
        console.error("Failed to check for merge conflicts:", err);
        toasts.add({ title: "Failed to check the changes for merge conflicts", variant: "error" });
        return;
      }
      if (selectedChatIdRef.current !== chatId) return;
      if (unresolved.length > 0) {
        setUnresolvedConflicts(unresolved);
        return;
      }
    }
    void handleMergeChanges();
  };

  // Merge mainline commits that landed after this chat's pins into the chat's uncommitted state
  // (see Overseer.updateChatFromMainline()). Offered when an accept comes back stale. Conflicts
  // are left inline as 3-way markers for the user (or their agent) to resolve; once the chat is
  // clean, accepting again is a plain fast-forward.
  const handleUpdateFromMainline = async () => {
    if (staleAcceptChatId === null) return;
    const chatId = staleAcceptChatId;
    setIsUpdatingFromMainline(true);
    try {
      const { conflictPaths } = await overseer.updateChatFromMainline(chatId);
      setStaleAcceptChatId(null);
      if (conflictPaths.length > 0) {
        toasts.add({
          title: `Updated this draft with the gadget's latest changes. ` +
            `${conflictPaths.length} ${conflictPaths.length === 1 ? "file has" : "files have"} ` +
            `conflicts marked in the code -- resolve them (or ask the agent to), then accept again.`,
          variant: "warning",
        });
      } else {
        toasts.add({
          title: "Updated this draft with the gadget's latest changes. Review and accept again.",
          variant: "success",
        });
      }
    } catch (err) {
      // The server refuses an update that needs a file too large to merge, in a message
      // naming the file and what to do about it (see Overseer.updateChatFromMainline()).
      console.error("Failed to update from mainline:", err);
      toasts.add({
        title: err instanceof Error && err.message
          ? err.message : "Failed to bring in the latest changes",
        variant: "error",
      });
    } finally {
      setIsUpdatingFromMainline(false);
    }
  };

  const handleFinalizeDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.finalizeChatDraft(selectedChatId);
      toasts.add({ title: "Changes saved", variant: "success" });
    } catch (err) {
      console.error("Failed to save changes:", err);
      toasts.add({ title: "Failed to save changes", variant: "error" });
    }
  };

  const handleDiscardDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      // The destructive generation bump this causes prunes the buffered rows when its
      // metadata arrives (see the metadata handler).
      await overseer.discardChatDraftChanges(selectedChatId);
      toasts.add({ title: "Changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard changes:", err);
      toasts.add({ title: "Failed to discard changes", variant: "error" });
    }
  };

  const handleDiscardPendingChanges = async () => {
    if (!discardChangesTarget) return;

    const target = discardChangesTarget;
    setDiscardingChangesChatIds((chatIds) => new Set(chatIds).add(target.chatId));
    try {
      // One call covers everything: live change rows are strictly newer than every materialized
      // message, so revertChanges(0) erases them along with the recorded batches (and a
      // rows-only revert degenerates to a draft discard server-side).
      await overseer.revertChanges(target.chatId, 0);
      setDiscardChangesTarget((current) =>
        current?.chatId === target.chatId ? null : current,
      );
      toasts.add({ title: "Pending changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard pending changes:", err);
      // See handleRevertChanges: the server's refusals are instructive, so surface them.
      toasts.add({
        title: err instanceof Error && err.message
          ? err.message : "Failed to discard pending changes",
        variant: "error",
      });
    } finally {
      setDiscardingChangesChatIds((chatIds) => {
        const next = new Set(chatIds);
        next.delete(target.chatId);
        return next;
      });
    }
  };

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = useCallback(async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Draft rewound", variant: "success" });
    } catch (err) {
      console.error("Failed to rewind draft:", err);
      // The server's refusals here are instructive (e.g. a still-proposed update-from-mainline
      // batch can't be reverted), so surface them rather than a generic failure.
      toasts.add({
        title: err instanceof Error && err.message ? err.message : "Failed to rewind draft",
        variant: "error",
      });
    }
  }, [overseer, selectedChatId, toasts]);
  // Handle enabling/disabling a bound hook from the chat thread.
  const handleToggleHook = async (actionId: number, hookId: number, enabled: boolean) => {
    setProcessingActions((prev) => new Set(prev).add(actionId));
    if (applyOptimisticHookEnabled(actionId, enabled)) forceUpdate();
    try {
      if (enabled) {
        await overseer.enableHook(hookId);
      } else {
        await overseer.disableHook(hookId);
      }
    } catch (err) {
      console.error("Failed to toggle hook:", err);
      toasts.add(hookToggleFailureToast(enabled, err));
      // Revert the optimistic update.
      if (applyOptimisticHookEnabled(actionId, !enabled)) forceUpdate();
    } finally {
      setProcessingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionId);
        return next;
      });
    }
  };

  // Open the gatekeeper modal pre-seeded with the agent's requested vendor/resource.
  const handleAcceptConnection = (msg: AiChatMessage & { type: "connectionRequest" }) => {
    setConnectionAccept({
      requestId: msg.requestId,
      vendorId: msg.vendorId,
      resourceUrl: msg.resourceUrl,
      resourceUrlPattern: msg.resourceUrlPattern,
    });
  };

  // Invoked by the accept-flow GatekeeperModal once the user has connected + configured a resource.
  // The gatekeeper is bound into no gadget; finalizing the request surfaces it to the agent as a
  // binding in the chat's env, under the name the agent chose when it made the request (the agent
  // wires it into a gadget itself if that gadget's code needs it).
  const handleConnectionCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    const accept = connectionAcceptRef.current;
    if (!accept) {
      gk[Symbol.dispose]();
      return;
    }
    setProcessingConnections((prev) => new Set(prev).add(accept.requestId));
    try {
      const id = await gk.getId();
      await overseer.acceptConnectionRequest(accept.requestId, {
        gatekeeperId: id,
      });
      setConnectionAccept(null);
    } catch (err) {
      console.error("Failed to finalize connection:", err);
      toasts.add({ title: "Failed to add connection", variant: "error" });
    } finally {
      gk[Symbol.dispose]();
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(accept.requestId);
        return next;
      });
    }
  };

  const handleDenyConnection = async (requestId: string) => {
    setProcessingConnections((prev) => new Set(prev).add(requestId));
    try {
      await overseer.denyConnectionRequest(requestId);
      // If the accept modal happens to be open for this same request, close it.
      if (connectionAcceptRef.current?.requestId === requestId) {
        setConnectionAccept(null);
      }
    } catch (err) {
      console.error("Failed to deny connection:", err);
      toasts.add({ title: "Failed to deny connection", variant: "error" });
    } finally {
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };
  // A bot chat retries on the bot's declared model — the pick must not swap it for the
  // composer's current model selection (the backend makes the same preference).
  const chatBotModelId = (() => {
    const metaBot = currentChatMetadata?.bot;
    if (!metaBot) return null;
    return bots.find((bot) => sameBotSelection(bot.selection, metaBot))?.modelId ?? null;
  })();
  const retryModelId = chatBotModelId ?? selectedModel;

  // Handle retrying the agent after an error
  const handleRetry = async () => {
    if (
      selectedChatId === null ||
      retryModelId === null
    ) {
      return;
    }

    try {
      await overseer.retryAgent(selectedChatId, retryModelId);
    } catch (err) {
      console.error("Failed to retry agent:", err);
      toasts.add({
        title: "Failed to retry agent",
        description: rpcFailureDescription(err),
        variant: "error",
      });
    }
  };

  const handleCopyMessage = useCallback(async (message: string) => {
    const ok = await copyToClipboard(message);
    toasts.add({
      title: ok ? "Copied message" : "Unable to copy message",
      variant: ok ? "success" : "error",
    });
  }, [toasts]);
  return {
    handleSend,
    handleNewChatSend,
    handleModelChange,
    handleBotChange,
    retryModelId,
    handleStop,
    handleSaveChatTitle,
    handleCancelTitleEdit,
    handleDeleteChat,
    handleDeleteConfirm,
    cancelListRename,
    startListRename,
    handleSaveListRename,
    handleMergeChanges,
    handleAcceptChanges,
    handleUpdateFromMainline,
    handleFinalizeDraftChanges,
    handleDiscardDraftChanges,
    handleDiscardPendingChanges,
    handleRevertChanges,
    handleToggleHook,
    handleAcceptConnection,
    handleConnectionCreated,
    handleDenyConnection,
    handleRetry,
    handleCopyMessage,
  };
}
