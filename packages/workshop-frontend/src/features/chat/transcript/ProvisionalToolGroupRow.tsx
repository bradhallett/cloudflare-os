import { CaretRight } from "@phosphor-icons/react";
import type { ProvisionalToolCallState } from "../provisionalChatState";
import { buildProvisionalToolSummary, getToolIcon } from "./toolCalls";
import { ToolRunningIndicator } from "./ToolRunningIndicator";
import { WorkIcon } from "./WorkIcon";

/**
 * The still-streaming run of tool calls: one summary line (label, spinner, targets so far)
 * expanding to each call's streamed code and output as they arrive.
 */
export function ProvisionalToolGroupRow({
  toolCalls,
  isExpanded,
  onToggle,
}: {
  toolCalls: ProvisionalToolCallState[];
  isExpanded: boolean;
  onToggle: (expansionKey: string) => void;
}) {
  const first = toolCalls[0];
  const { label, detailLines, running } = buildProvisionalToolSummary(toolCalls);
  const expansionKey = `group-${first.toolCallId}`;
  const detailCalls = toolCalls.filter((t) => t.code || t.output);
  return (
    <div className="space-y-1">
      <div className="group/work -ml-0.5">
        <button
          type="button"
          onClick={() => onToggle(expansionKey)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
          aria-expanded={isExpanded}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <WorkIcon Icon={getToolIcon(first.toolName, first.outputFormat)} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
              <span className="min-w-0 truncate">{label}</span>
              <ToolRunningIndicator running={running} />
              <CaretRight
                size={13}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`}
              />
            </span>
            {detailLines.length > 1 && (
              <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
                {detailLines.join(" · ")}
              </span>
            )}
          </span>
        </button>
        {isExpanded && detailCalls.length > 0 && (
          <div className="ml-8 mt-1 space-y-1">
            {detailCalls.map((toolCall) => (
              <div
                key={`stream-tool-${toolCall.toolCallId}`}
                className="themed-surface-inset space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3"
              >
                {toolCall.code && (
                  <>
                    <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Code</span>
                    <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                      {toolCall.code}
                    </pre>
                  </>
                )}
                {toolCall.output && (
                  <>
                    <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Output</span>
                    <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                      {toolCall.output}
                    </pre>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
