import type {
  BotSelection,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { isTransientRpcError } from "../../../rpcErrors";

/** What {@link FailedChatSend} holds of the send that failed: exactly the arguments a retry
 * re-sends, so a retry is the same send, not a reconstruction of it. */
export type FailedSendPayload = {
  message: string | SlashCommandRequest;
  modelId: string | null;
  capsules?: CapsuleSpecifier[];
  attachments?: ChatAttachmentHandle[];
  formats?: MessageFormatRef[];
  bot?: BotSelection | "none";
};

/**
 * A user send that the server definitively rejected, held client-side so the transcript can show
 * the message that never arrived in a destructive bubble with a retry (the durable history never
 * records it). Transient failures — where the send may still have gone through — are deliberately
 * not failed sends; the composer's hiccup banner owns that case.
 */
export type FailedChatSend = {
  /** Stable id for React keys and retry/dismiss bookkeeping. */
  id: string;
  /** The chat the send targeted; records for other chats never render. */
  chatId: number;
  /** When the send was attempted; the bubble's timestamp. */
  timestamp: Date;
  payload: FailedSendPayload;
};

let nextFailedSendId = 0;

/**
 * Records a rejected send as a {@link FailedChatSend}, or null when no record is wanted: transient
 * errors (the outcome is unknown — showing the message as failed would be a lie) and sends that
 * had no chat yet (there is no transcript to render the bubble in; the composer keeps the draft).
 */
export function failedSendFromRejection(
  chatId: number | null,
  payload: FailedSendPayload,
  err: unknown,
  now: () => Date = () => new Date(),
): FailedChatSend | null {
  if (chatId === null || isTransientRpcError(err)) return null;
  return {
    id: `failed-send-${nextFailedSendId++}`,
    chatId,
    timestamp: now(),
    payload,
  };
}
