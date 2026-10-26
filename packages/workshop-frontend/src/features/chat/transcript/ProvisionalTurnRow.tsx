import { memo } from "react";
import styles from "../ChatInterface.module.css";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import type { ProvisionalChatState, ProvisionalToolCallState } from "../provisionalChatState";
import { isUserMessageEntry, type ChatDisplayEntry } from "./chatDisplayEntries";
import { ProvisionalToolGroupRow } from "./ProvisionalToolGroupRow";
import { ThinkingTraceRow } from "./ThinkingTraceRow";

/**
 * The live turn's placeholder: what the agent is streaming right now — compacting and
 * thinking notices, reasoning, partial text, in-flight tool calls — shown only while the
 * agent is active; once real output appears, that speaks for itself.
 */
export const ProvisionalTurnRow = memo(function ProvisionalTurnRow({
  provisionalState,
  toolCalls,
  isCompacting,
  showThinkingTraces,
  currentMessages,
  previousEntry,
  expandedToolCalls,
  toggleToolCallExpansion,
}: {
  provisionalState: ProvisionalChatState | null;
  toolCalls: ProvisionalToolCallState[];
  isCompacting: boolean;
  /**
   * The rAF-coalesced stream tick. The provisional state and tool calls are mutated in place
   * with stable identity, so this counter is the only prop that changes while a response
   * streams -- exactly what the memo wrapper needs to repaint the row per tick while the
   * durable transcript around it holds still.
   */
  provisionalTick: number;
  showThinkingTraces: boolean;
  /** The chat's messages, read for whether the agent has answered anything yet. */
  currentMessages: AiChatMessage[];
  /** The transcript row above the placeholder, which sets its spacing rhythm. */
  previousEntry: ChatDisplayEntry | null;
  expandedToolCalls: ReadonlySet<string>;
  toggleToolCallExpansion: (expansionKey: string) => void;
}) {
  const hasShownReasoning = showThinkingTraces && !!provisionalState?.reasoning;
  // Only while awaiting the agent's first output this turn; otherwise it flashes again in
  // the gap after the last message finalizes but before isAgentActive clears.
  const lastMessage =
    currentMessages.length > 0 ? currentMessages[currentMessages.length - 1] : null;
  const awaitingFirstResponse =
    !lastMessage ||
    lastMessage.author.type === "user" ||
    lastMessage.author.type === "gadget";
  const showThinking =
    !isCompacting &&
    awaitingFirstResponse &&
    !provisionalState?.text &&
    !hasShownReasoning &&
    toolCalls.length === 0;

  // Match the spacing this response gets once finalized (see rhythmTopClass) so it doesn't
  // shift when streaming completes.
  const provisionalTopClass = !previousEntry
    ? ""
    : previousEntry.type === "modelChange"
      ? "mt-2"
      : isUserMessageEntry(previousEntry)
        ? "mt-5"
        : "mt-4";

  return (
    <div className={`group/agent min-w-0 w-full max-w-[860px] space-y-2 ${provisionalTopClass}`}>
      {isCompacting && (
        <div className="inline-flex shimmer px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-inactive shimmer-duration-1800">
          Compacting…
        </div>
      )}

      {showThinking && (
        <div className="inline-flex shimmer px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-inactive shimmer-duration-1800">
          Thinking
        </div>
      )}

      {showThinkingTraces && provisionalState?.reasoning && (
        <ThinkingTraceRow reasoning={provisionalState.reasoning} />
      )}

      {provisionalState?.text && (
        <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
          <MarkdownMessage message={provisionalState.text} />
        </div>
      )}

      {toolCalls.length > 0 && (
        <ProvisionalToolGroupRow
          toolCalls={toolCalls}
          isExpanded={expandedToolCalls.has(`group-${toolCalls[0].toolCallId}`)}
          onToggle={toggleToolCallExpansion}
        />
      )}
    </div>
  );
});
