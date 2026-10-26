import { ArrowUUpLeft, Copy } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import type { AiChatMessage, WorkpieceId } from "@gadgets/workshop-shared/api";
import styles from "../../../ChatInterface.module.css";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import { CreatedWorkpieceChatCard, type CreatedWorkpieceCardInfo } from "./CreatedWorkpieceChatCard";
import { ThinkingTraceRow } from "./ThinkingTraceRow";
import { type ChangeChatMessage } from "./messageTypes";
import { getDiscardLabel, type PendingTurnChanges } from "./pendingTurnChanges";
import { ToolGroupRow, turnFooterProps } from "./ToolGroupRow";
import type { ToolCallGroup, ToolOutputResolver } from "./toolCalls";

/**
 * An agent's reply: its thinking trace and text, the per-message actions (copy, per-turn
 * discard) that follow it, the workpieces it created, and the run of tool calls it made —
 * whose group carries the turn's discard footer when the reply itself has no text to hang
 * actions on.
 */
export function AgentMessageRow({
  msg,
  workGroup,
  lastMessageSequence,
  showThinkingTraces,
  isAgentActive,
  lastDurablePendingChange,
  pendingChangeByTurnItemSeq,
  createdWorkpiecesByTurnItemSeq,
  completedAgentTurnMessageSeqs,
  latestCompletedAgentTurnMessageSeq,
  expandedToolCalls,
  toggleToolCallExpansion,
  resolveToolOutput,
  onOpenGadget,
  onCopyMessage,
  onRevertChanges,
}: {
  msg: Extract<AiChatMessage, { type: "message" }>;
  workGroup: ToolCallGroup | null | undefined;
  lastMessageSequence: number | undefined;
  showThinkingTraces: boolean;
  isAgentActive: boolean;
  lastDurablePendingChange: ChangeChatMessage | null;
  pendingChangeByTurnItemSeq: Map<number, PendingTurnChanges>;
  createdWorkpiecesByTurnItemSeq: Map<number, CreatedWorkpieceCardInfo[]>;
  completedAgentTurnMessageSeqs: Set<number>;
  latestCompletedAgentTurnMessageSeq: number | null;
  expandedToolCalls: ReadonlySet<string>;
  toggleToolCallExpansion: (expansionKey: string) => void;
  resolveToolOutput: ToolOutputResolver;
  onOpenGadget: (workpieceId: WorkpieceId) => void;
  onCopyMessage: (message: string) => Promise<void>;
  onRevertChanges: (revertFrom: number) => Promise<void>;
}) {
  const hasMessageText = msg.message.trim().length > 0;
  const showReasoning = showThinkingTraces && !!msg.reasoning;
  const actionMessageSeq = lastMessageSequence ?? msg.sequence;
  const pendingChange = pendingChangeByTurnItemSeq.get(actionMessageSeq) ?? null;
  const createdWorkpieces = createdWorkpiecesByTurnItemSeq.get(actionMessageSeq) ?? [];
  // With no text of its own, the reply's actions (and the turn's discard) attach to its
  // tool-group footer instead of an actions row of their own.
  const attachActionsToToolGroups = !hasMessageText && !!pendingChange && !!workGroup;
  const showActions =
    completedAgentTurnMessageSeqs.has(actionMessageSeq) &&
    (hasMessageText || (!!pendingChange && !attachActionsToToolGroups));
  const keepActionsVisible = actionMessageSeq === latestCompletedAgentTurnMessageSeq;
  const isTrailing = pendingChange?.through === lastDurablePendingChange?.sequence;
  return (
    <div className="min-w-0 w-full max-w-[860px] space-y-2">
      <div className="group/agentMessage relative space-y-1.5">
        {showReasoning && <ThinkingTraceRow reasoning={msg.reasoning!} />}

        {hasMessageText && (
          <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
            <MarkdownMessage
              message={msg.message}
              capsules={msg.capsules}
              formats={msg.formats}
            />
          </div>
        )}

        {showActions && (
          <div className={`mt-0.5 -ml-1 flex items-center gap-1 transition-opacity duration-150 ease-out ${
            keepActionsVisible
              ? "opacity-100"
              : "opacity-100 sm:opacity-0 sm:group-hover/agentMessage:opacity-100 sm:group-focus-within/agentMessage:opacity-100"
          }`}>
            {hasMessageText && (
              <Tooltip content="Copy message" asChild>
                <button
                  type="button"
                  onClick={() => onCopyMessage(msg.message)}
                  className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96]"
                  aria-label="Copy message"
                >
                  <Copy size={15} />
                </button>
              </Tooltip>
            )}
            {pendingChange && (() => {
              const label = getDiscardLabel(
                pendingChange.through === lastDurablePendingChange?.sequence,
                pendingChange.createdWorkpieces,
              );
              return (
              <Tooltip content={label} asChild>
                <button
                  type="button"
                  disabled={isAgentActive}
                  onClick={() => onRevertChanges(pendingChange.revertFrom)}
                  className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={label}
                >
                  <ArrowUUpLeft size={15} />
                </button>
              </Tooltip>
              );
            })()}
            <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
              <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                {msg.timestamp.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </Tooltip>
          </div>
        )}
      </div>

      {createdWorkpieces.map((created) => (
        <CreatedWorkpieceChatCard
          key={created.workpieceId}
          created={created}
          onOpen={() => onOpenGadget(created.workpieceId)}
        />
      ))}

      {workGroup && (
        <div className="space-y-1">
          <ToolGroupRow
            outputOf={resolveToolOutput}
            key={workGroup.key}
            group={workGroup}
            open={expandedToolCalls.has(workGroup.key)}
            expandedKeys={expandedToolCalls}
            onToggle={toggleToolCallExpansion}
            footer={
              attachActionsToToolGroups && pendingChange
                ? turnFooterProps(
                    pendingChange,
                    isTrailing,
                    msg.timestamp,
                    isAgentActive,
                    onRevertChanges,
                  )
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
