import { memo } from "react";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import { CaretRight } from "@phosphor-icons/react";
import { getToolCallSummary, getToolIcon, type ToolOutputResolver } from "./toolCalls";
import { ToolCallDetails } from "./ToolCallDetails";
import { WorkIcon } from "./WorkIcon";

/** One tool call inside an expanded work-run group. */
export const NestedToolCallRow = memo(function NestedToolCallRow({
  toolCall: tc,
  open,
  onToggle,
  outputOf,
}: {
  toolCall: AiToolCall;
  open: boolean;
  onToggle: (key: string) => void;
  outputOf?: ToolOutputResolver;
}) {
  const key = `call-${tc.toolCallId}`;
  const summary = getToolCallSummary(tc, outputOf);
  const label = `${summary.verb}${summary.target ? ` ${summary.target}` : ""}`;
  const Icon = getToolIcon(tc.toolName, outputOf?.(tc));

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={Icon} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          {tc.error && (
            <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
              Error
            </span>
          )}
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ToolCallDetails toolCall={tc} />
        </div>
      )}
    </div>
  );
});
