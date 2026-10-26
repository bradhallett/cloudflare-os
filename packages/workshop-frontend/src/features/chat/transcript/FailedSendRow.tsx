import { Tooltip } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import styles from "../ChatInterface.module.css";
import type { OverseerSource } from "../../../components/chat/slash-command-catalog";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import type { FailedChatSend } from "./failedSends";
import { SlashCommandMention } from "./SlashCommandMention";

/**
 * A user send the server rejected, rendered where the message would have landed: the user's own
 * bubble in a destructive variant (error-tinted surface with the failure icon tinted to match),
 * with the retry that re-sends it. The failed message lives only here — the composer gave up its
 * draft when the failure was reported — so dismiss is explicit, never incidental.
 */
export const FailedSendRow = ({
  send,
  getOverseer,
  onRetry,
  onDismiss,
}: {
  send: FailedChatSend;
  getOverseer: OverseerSource;
  /** Re-sends the exact payload that failed. */
  onRetry: (send: FailedChatSend) => void;
  /** Drops the failed message for good. */
  onDismiss: (send: FailedChatSend) => void;
}) => {
  const { payload } = send;
  const attachmentNames = (payload.attachments ?? [])
    // Legacy staged uploads carry only an id; there is nothing displayable to name.
    .map((attachment) => ("name" in attachment ? attachment.name : undefined))
    .filter((name): name is string => name !== undefined);
  return (
    <div className="flex flex-col items-end">
      <div className={`w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-kumo-danger/30 bg-kumo-danger-tint px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
        {/* A div, not a p: `.markdownContent p` would out-rank the utility classes. */}
        <div className="mb-1 flex items-center gap-1 text-[12px] leading-4 font-medium text-kumo-danger">
          <WarningCircleIcon size={13} weight="fill" aria-hidden="true" />
          Not sent
        </div>
        {typeof payload.message === "string"
          ? payload.message.trim() && (
              <MarkdownMessage
                message={payload.message}
                capsules={payload.capsules}
                formats={payload.formats}
                preserveLineBreaks
              />
            )
          : (
            <span className="whitespace-pre-wrap">
              <SlashCommandMention
                args={payload.message.args}
                id={payload.message.id}
                commandPosition={payload.message.commandPosition}
                formats={payload.formats}
                getOverseer={getOverseer}
              />
            </span>
          )}
        {attachmentNames.length > 0 && (
          <div className="mt-1 text-[12px] leading-4 text-kumo-subtle">
            Attached: {attachmentNames.join(", ")}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive">
        <Tooltip content={formatFullTimestamp(send.timestamp)} asChild>
          <span className="font-mono">
            {send.timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </Tooltip>
        <Tooltip content="Send this message again." asChild>
          <button
            type="button"
            onClick={() => onRetry(send)}
            className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98]"
          >
            <ArrowsClockwiseIcon size={12} weight="bold" />
            Retry
          </button>
        </Tooltip>
        <Tooltip content="Remove this failed message." asChild>
          <button
            type="button"
            onClick={() => onDismiss(send)}
            aria-label="Remove failed message"
            className="flex flex-shrink-0 cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,transform] duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none active:scale-[0.96]"
          >
            <XIcon size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
