import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type {
  BotSelection,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";

import { isTransientRpcError } from "../../../rpcErrors";
import type { ComposerAttachment } from "./attachments/useComposerAttachments";
import type { StoredComposerDraft } from "./draft/composerDraft";
import { buildComposerSubmission } from "./composerSubmission";
import type { ComposerDocument } from "./composerDocument";

/** The slice of the toast manager the send flow reports blocking states through. */
export interface ComposerToastSink {
  add(toast: { title: string; variant: "error" }): string;
}

/** What {@link useComposerSend} orchestrates; see the hook. */
export interface UseComposerSendArgs {
  /** Identity of the chat the composer is bound to; a change dismisses the hiccup hint. */
  chatKey?: number | null;
  onSend: (
    message: string | SlashCommandRequest,
    modelId: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
    bot?: BotSelection | "none",
  ) => Promise<void> | void;
  /** Chooses a bot in the agent picker; null returns to a bare model. */
  onBotChange?: (bot: BotSelection | null) => void;
  /** Whether this composer starts a new chat (intake) rather than steering an existing one. */
  newChat: boolean;
  isAgentActive: boolean;
  isBlocked: boolean;
  onStop?: () => Promise<void>;
  /** Texts of the steers queued for the agent, which Stop moves into the draft. */
  queuedSteers?: readonly string[];
  /** The model a send rides on (the picker's current pick). */
  selectedModelId: string | null | undefined;
  /** The bot the picker selects, or null when a model or "No agent" answers the chat. */
  selectedBot?: BotSelection | null;
  /** The document's current render value — its text/command gate the send buttons. */
  document: ComposerDocument;
  attachments: readonly ComposerAttachment[];
  clearSentAttachments: (sent: readonly ComposerAttachment[]) => void;
  isCreatingResource: boolean;
  /** Draft-storage send bookkeeping; both come from {@link useComposerDraft}. */
  beginSend: () => { key: string | undefined; editRevision: number; draft: StoredComposerDraft };
  completeSend: (send: { key: string | undefined; editRevision: number; draft: StoredComposerDraft }) => boolean;
  replaceDocument: (document: ComposerDocument) => void;
  recordDraftEdit: () => void;
  setInputValue: Dispatch<SetStateAction<string>>;
  toasts: ComposerToastSink;
}

/**
 * The composer's send orchestration: gating (canSend/canSteer), the send itself (draft
 * bookkeeping, attachment readiness, bot selection, failure handling), the transient
 * "may not have been sent" hiccup hint, and Stop-while-steers-are-queued.
 */
export function useComposerSend({
  chatKey,
  onSend,
  onBotChange,
  newChat,
  isAgentActive,
  isBlocked,
  onStop,
  queuedSteers,
  selectedModelId,
  selectedBot,
  document,
  attachments,
  clearSentAttachments,
  isCreatingResource,
  beginSend,
  completeSend,
  replaceDocument,
  recordDraftEdit,
  setInputValue,
  toasts,
}: UseComposerSendArgs) {
  const { text, capsules, formats, command } = document;
  const [isSending, setIsSending] = useState(false);
  // Set by Stop until the agent goes idle: a steer sent meanwhile would be refused.
  const [isStopping, setIsStopping] = useState(false);
  if (isStopping && !isAgentActive) setIsStopping(false);
  // The chat the "may not have been sent" hint belongs to; the render condition scopes it,
  // and leaving the chat dismisses it.
  const [sendHiccup, setSendHiccup] = useState<{ chatKey?: number | null } | null>(null);
  useEffect(() => setSendHiccup(null), [chatKey]);
  const sendInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSend = async () => {
    if (sendInFlightRef.current || isSending || isBlocked) return;
    setSendHiccup(null);
    const attachmentsSnapshot = attachments;
    const readyAttachments = attachmentsSnapshot
      .filter((attachment) => attachment.uploadState === "ready" && attachment.ref)
      .map((attachment) => attachment.ref!);
    const hasUploadingAttachment = attachmentsSnapshot.some((attachment) => attachment.uploadState === "uploading");
    const hasFailedAttachment = attachmentsSnapshot.some((attachment) => attachment.uploadState === "error");

    if (!text.trim() && !command && readyAttachments.length === 0) return;
    if (hasUploadingAttachment) {
      toasts.add({ title: "Please wait for attachment uploads to finish", variant: "error" });
      return;
    }
    if (hasFailedAttachment) {
      toasts.add({ title: "Remove failed attachment uploads before sending", variant: "error" });
      return;
    }
    if (isCreatingResource) {
      toasts.add({ title: "Please wait for the resource connection to finish", variant: "error" });
      return;
    }

    sendInFlightRef.current = true;
    setIsSending(true);
    const draftSend = beginSend();
    try {
      const submissionResult = buildComposerSubmission({
        document,
        hasAttachments: readyAttachments.length > 0,
      });
      if (!submissionResult.ok) {
        toasts.add({ title: "Slash commands cannot include resources or attachments", variant: "error" });
        return;
      }
      const { message, capsules: capsuleSpecifiers, formats: formatRefs } =
        submissionResult.submission;

      // The picker's single choice of who answers. Intake names the bot for the chat being
      // created; in-chat, an idle chat gets the explicit pick ("none" clears the bot) while a
      // running turn keeps its agent — steers pass no bot.
      const sendBot = onBotChange == null
        ? undefined
        : newChat
          ? selectedBot ?? undefined
          : isAgentActive
            ? undefined
            : selectedBot ?? "none";

      try {
        await onSend(message, selectedModelId ?? null,
            capsuleSpecifiers,
            readyAttachments.length ? readyAttachments : undefined,
            formatRefs,
            sendBot);
      } catch (err) {
        // A definitive failure in a chat with a transcript hands the message to the transcript's
        // failed-send bubble, so the draft clears exactly as a success would; a transient failure
        // (outcome unknown) and the new-chat composer (no transcript to hold it) keep the draft.
        if (!isTransientRpcError(err) && chatKey != null) {
          clearSentAttachments(attachmentsSnapshot);
          if (completeSend(draftSend)) {
            replaceDocument({ text: "", capsules: [], formats: [], command: null });
          }
        }
        throw err;
      }
      clearSentAttachments(attachmentsSnapshot);
      if (!completeSend(draftSend)) return;
      replaceDocument({ text: "", capsules: [], formats: [], command: null });
    } finally {
      sendInFlightRef.current = false;
      if (mountedRef.current) setIsSending(false);
    }
  };

  const submitMessage = () => {
    const submittedChatKey = chatKey;
    void handleSend().catch((err) => {
      if (isTransientRpcError(err)) {
        setSendHiccup({ chatKey: submittedChatKey });
      } else {
        // The onSend handlers log the RPC failures they see; this is the only report for
        // anything handleSend itself throws before reaching them.
        console.error("Failed to send chat message:", err);
      }
    });
  };

  const handleStop = () => {
    if (!onStop) return;
    setIsStopping(true);
    if (queuedSteers?.length) {
      recordDraftEdit();
      setInputValue([text.trimEnd(), ...queuedSteers].filter(Boolean).join("\n\n"));
    }
    // A failed Stop may still have dropped the steers on the server, so the draft keeps them, and
    // Stop can be pressed again.
    onStop().catch(() => {
      if (mountedRef.current) setIsStopping(false);
    });
  };

  const hasReadyAttachment = attachments.some(
    (attachment) => attachment.uploadState === "ready" && attachment.ref,
  );
  const hasUnreadyAttachment = attachments.some(
    (attachment) => attachment.uploadState !== "ready",
  );
  const canSend = !isSending && !isAgentActive && !isBlocked &&
    (text.trim().length > 0 || command !== null || hasReadyAttachment) &&
    !hasUnreadyAttachment && !isCreatingResource;
  // While the agent works, a plain message steers it (see ChatInterface's handleSend).
  const canSteer = isAgentActive && !isSending && !isStopping && !isBlocked &&
    text.trim().length > 0 && command === null && capsules.length === 0 &&
    formats.length === 0 && attachments.length === 0 && !isCreatingResource;

  return {
    /** Whether a send is in flight; disables the attachment tray while it runs. */
    isSending,
    canSend,
    /** Whether a plain message would steer the running agent. */
    canSteer,
    /** Sends (or steers) the draft; reports transient failures through the hiccup hint. */
    submitMessage,
    /** Stops the agent, folding queued steers back into the draft. */
    handleStop,
    /** Whether Stop is in flight; clears itself once the agent goes idle. */
    isStopping,
    /** The chat the "may not have been sent" hint belongs to, set by a transient failure. */
    sendHiccup,
  };
}
