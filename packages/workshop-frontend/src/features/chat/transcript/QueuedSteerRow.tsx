import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import { UserMetaRow } from "./UserMetaRow";
import { userBubbleClassName } from "./UserMessageRow";

/**
 * A steer waiting to be read: dimmed like a sent-but-unacknowledged message, grouped under
 * the previous steer from the same author, named once the group ends.
 */
export function QueuedSteerRow({
  text,
  author,
  showName,
  groupedWithPrevious,
  endsGroup,
  notReadYet,
}: {
  text: string;
  author: AiChatAuthorInfo;
  showName: boolean;
  /** Whether the previous steer came from the same author (tighter spacing when it did). */
  groupedWithPrevious: boolean;
  /** Whether the next steer, if any, comes from another author (the group's last row). */
  endsGroup: boolean;
  /** Whether no steer follows — the whole queue is still unread. */
  notReadYet: boolean;
}) {
  return (
    <div className={`flex flex-col items-end ${groupedWithPrevious ? "mt-2" : "mt-5"}`}>
      <div className={`${userBubbleClassName} opacity-60`}>
        <MarkdownMessage message={text} preserveLineBreaks />
      </div>
      {endsGroup && (
        <UserMetaRow
          author={author}
          showName={showName}
          note={notReadYet ? "Not read yet" : undefined}
          revealOnHover={false}
          className="mt-1"
        />
      )}
    </div>
  );
}
