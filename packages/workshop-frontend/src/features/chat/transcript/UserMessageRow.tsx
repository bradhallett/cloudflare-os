import type { AiChatMessage, ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import styles from "../../../ChatInterface.module.css";
import { ChatAttachmentGrid } from "../attachments/ChatAttachmentGrid";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import { SlashCommandMention } from "./SlashCommandMention";
import { UserMetaRow } from "./UserMetaRow";
import type { OverseerSource } from "../../../components/chat/slash-command-catalog";

// The user's message bubble: rounded with the tail on the bottom right. Markdown-aware for
// typed messages; the queued-steer bubbles reuse it dimmed (see QueuedSteerRow).
const userBubbleBase =
  "themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default";
export const userBubbleClassName = `${userBubbleBase} ${styles.markdownContent}`;

/**
 * One of the user's own bubbles: a typed message (with its attachments, and the slash
 * command it expanded from when there was one) or the bare slash command itself. Consecutive
 * bubbles from one user read as a group, so the name/time meta row shows only under the
 * last of them.
 */
export function UserMessageRow({
  msg,
  slashCommand,
  endsUserGroup,
  showName,
  getOverseer,
  onDownloadAttachment,
}: {
  msg: Extract<AiChatMessage, { type: "slashCommand" | "message" }>;
  /** The slash command this message expanded from, when the transcript kept the pairing. */
  slashCommand?: Extract<AiChatMessage, { type: "slashCommand" }>;
  /** Whether this bubble is the last of its author's consecutive group. */
  endsUserGroup: boolean;
  /** Whether the meta row names the author (hidden for the reader's own when asked). */
  showName: boolean;
  getOverseer: OverseerSource;
  onDownloadAttachment: (chatId: number, attachment: ChatAttachmentRef) => void;
}) {
  if (msg.type === "slashCommand") {
    return (
      <div className="group/message relative flex flex-col items-end">
        <div className={userBubbleBase}>
          <span className="whitespace-pre-wrap">
            <SlashCommandMention
              name={msg.skillName}
              args={msg.request.args}
              id={msg.request.id}
              commandPosition={msg.request.commandPosition}
              getOverseer={getOverseer}
            />
          </span>
        </div>
        {endsUserGroup && (
          <UserMetaRow
            author={msg.author}
            showName={showName}
            timestamp={msg.timestamp}
            className="mt-0.5"
          />
        )}
      </div>
    );
  }

  return (
    <div className="group/message relative flex flex-col items-end">
      <div className={userBubbleClassName}>
        {msg.attachments && msg.attachments.length > 0 && (
          <ChatAttachmentGrid
            attachments={msg.attachments}
            onDownload={(attachment) => onDownloadAttachment(msg.chatId, attachment)}
          />
        )}
        {slashCommand ? (
          // What the command expanded into is the agent's context, not something to re-read
          // here.
          <div className="whitespace-pre-wrap">
            <SlashCommandMention
              name={slashCommand.skillName}
              args={slashCommand.request.args}
              id={slashCommand.request.id}
              commandPosition={slashCommand.request.commandPosition}
              formats={msg.formats}
              getOverseer={getOverseer}
            />
          </div>
        ) : msg.message.trim() && (
          <MarkdownMessage
            message={msg.message}
            capsules={msg.capsules}
            formats={msg.formats}
            preserveLineBreaks
          />
        )}
      </div>
      {endsUserGroup && (
        <UserMetaRow
          author={msg.author}
          showName={showName}
          timestamp={msg.timestamp}
          className="mt-0.5"
        />
      )}
    </div>
  );
}
