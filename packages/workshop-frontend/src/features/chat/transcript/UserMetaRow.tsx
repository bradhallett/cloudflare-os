import { Tooltip } from "@cloudflare/kumo";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";

/**
 * The name and time shown under a user's message bubble: once per group of consecutive
 * messages, revealed on hover or focus within the bubble's group. Queued steers reuse it
 * with a note ("Not read yet") in place of the timestamp, always visible.
 */
export function UserMetaRow({
  author,
  showName,
  timestamp,
  note,
  revealOnHover = true,
  className = "",
}: {
  author: AiChatAuthorInfo;
  /** Whether the author's name shows at all (hidden for the reader's own messages when asked). */
  showName: boolean;
  /** When the message was sent; shown in full on hover. */
  timestamp?: Date;
  /** Plain trailing note, as a queued steer's "Not read yet". */
  note?: string;
  /** Whether the row stays hidden until the message's group is hovered or focused. */
  revealOnHover?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive ${
        revealOnHover
          ? "opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100"
          : ""
      } ${className}`}
    >
      {showName && <span className="font-medium">{author.name}</span>}
      {timestamp && (
        <Tooltip content={formatFullTimestamp(timestamp)} asChild>
          <span className="font-mono">
            {timestamp.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </Tooltip>
      )}
      {note && <span>{note}</span>}
    </div>
  );
}
