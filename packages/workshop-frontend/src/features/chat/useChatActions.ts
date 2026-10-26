import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  AiChatMetadata,
  BotInfo,
  BotSelection,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  Overseer,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { RpcStub } from "capnweb";
import { hookToggleFailureToast } from "../../components/HookToggle";
import { isTransientRpcError, logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { persistSelectedBot, persistSelectedModel, sameBotSelection } from "../../modelSelection";
import { copyToClipboard } from "../../clipboard";
import type { Toasts } from "./useChatSubscription";
import type { FailedChatSend } from "./transcript/failedSends";
import { failedSendFromRejection } from "./transcript/failedSends";

/** Props {@link useChatActions} reads from its host component. */
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
  /** Latest onNavigateToChat, for callbacks built once that must call the current one. */
  onNavigateToChatRef: {
    current: (chatId: number | null, options?: { replace?: boolean }) => void;
  };
  forceUpdate: () => void;
  applyOptimisticHookEnabled: (actionId: number, enabled: boolean) => boolean;
  toasts: Toasts;
  /** The selected chat's metadata, undefined while it has not loaded. */
  currentChatMetadata: AiChatMetadata | null | undefined;
}

/**
 * The chat's send-side RPC handlers -- sending (including failed-send bookkeeping and retry),
 * model and bot selection, stopping the agent, hook toggles, and copy-message. Owns the state
 * those flows exist around (the failed-send bubbles, the in-flight hook toggles); the list,
 * changes, and connection-request flows live in their own hooks (see useChatListActions,
 * useChatChanges, useConnectionRequests).
 */
export function useChatActions({
  overseer,
  selectedChatId,
  selectedModel,
  setSelectedModel,
  bots,
  selectedBot,
  setSelectedBot,
  onNavigateToChatRef,
  forceUpdate,
  applyOptimisticHookEnabled,
  toasts,
  currentChatMetadata,
}: UseChatActionsArgs) {
  // Hook toggles in flight, to disable their rows while the RPC lands.
  const [processingActions, setProcessingActions] = useState<Set<number>>(
    () => new Set());
  // Sends the server definitively rejected, held for the transcript's retry bubbles.
  const [failedSends, setFailedSends] = useState<FailedChatSend[]>([]);

  // Creates a chat from a send's payload and navigates to it — the shared core of the
  // composer's send (no chat open yet) and the sidebar's new-chat send. Throws the RPC error
  // for the caller's own reporting.
  const createChat = async (
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
    const newChatId = await overseer.newChat(
        message, model, capsules, attachments, formats,
        bot === "none" ? undefined : bot);
    onNavigateToChatRef.current(newChatId);
  };

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
        await createChat(message, model, capsules, attachments, formats, bot);
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
    try {
      await createChat(messageText, modelId, capsules, attachments, formats, bot);
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

  // Retry drops the bubble first so a success leaves no duplicate; a definitive failure re-records
  // a fresh bubble via handleSend itself, while a transient failure would leave the retry
  // outcome-unknown — so the original bubble is restored to keep the message reachable.
  const retryFailedSend = useCallback(
    async (send: FailedChatSend) => {
      setFailedSends((prev) => prev.filter((s) => s.id !== send.id));
      try {
        await handleSend(
          send.payload.message,
          send.payload.modelId,
          send.payload.capsules,
          send.payload.attachments,
          send.payload.formats,
          send.payload.bot,
        );
      } catch (err) {
        if (isTransientRpcError(err)) setFailedSends((prev) => [...prev, send]);
      }
    },
    [handleSend],
  );

  const dismissFailedSend = useCallback((send: FailedChatSend) => {
    setFailedSends((prev) => prev.filter((s) => s.id !== send.id));
  }, []);

  // Failed sends are session-local, so filter to the open chat before feeding the transcript.
  const currentFailedSends = useMemo(
    () => (selectedChatId === null ? [] : failedSends.filter((s) => s.chatId === selectedChatId)),
    [failedSends, selectedChatId],
  );

  return {
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
  };
}
