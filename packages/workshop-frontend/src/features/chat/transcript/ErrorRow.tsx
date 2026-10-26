import { ArrowsClockwise, CaretRight, Lightning, WarningCircle } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/**
 * An agent error: the message in a row of its own, expandable to the full text, with the
 * way out — Add credits for a usage-limit stop, Retry for anything else. Only the chat's
 * last message (once no turn is running) is actionable; older errors are history.
 */
export function ErrorRow({
  msg,
  isLast,
  isExpanded,
  onToggle,
  onOpenUsageModal,
  onRetry,
  retryModelId,
}: {
  msg: Extract<AiChatMessage, { type: "error" }>;
  /** Whether this is the chat's last message with no turn running (the actionable one). */
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenUsageModal: () => void;
  onRetry: () => void;
  /** The model a retry runs on; null disables the retry button. */
  retryModelId: string | null;
}) {
  return (
    <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <div className="flex w-full items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
          aria-expanded={isExpanded}
        >
          <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-danger" aria-hidden="true">
                <WarningCircle size={16} weight="fill" />
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-kumo-danger">Error: </span>
                  <span className="text-kumo-subtle">{msg.message}</span>
                </span>
                <CaretRight
                  size={13}
                  weight="bold"
                  className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`}
                />
              </span>
            </span>
          </Tooltip>
        </button>
        {isLast && msg.code === "usage_limit" && (
          <Tooltip content="Add credits to continue." asChild>
            <button
              type="button"
              onClick={onOpenUsageModal}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98]"
            >
              <Lightning size={12} weight="bold" />
              Continue
            </button>
          </Tooltip>
        )}
        {isLast && msg.code !== "usage_limit" && (
          <Tooltip content="Retry the last action." asChild>
            <button
              type="button"
              onClick={onRetry}
              disabled={retryModelId === null}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowsClockwise size={12} weight="bold" />
              Retry
            </button>
          </Tooltip>
        )}
      </div>
      {isExpanded && (
        <div className="ml-8 mt-1">
          <pre className="max-h-48 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {msg.message}
          </pre>
        </div>
      )}
    </div>
  );
}
