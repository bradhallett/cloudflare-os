import { memo } from "react";
import { ArrowUUpLeft, CaretRight } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import type { CreatedWorkpieceName } from "./messageTypes";
import { NestedObservationRow } from "./NestedObservationRow";
import { NestedToolCallRow } from "./NestedToolCallRow";
import { ObservationDetails } from "./ObservationDetails";
import { getDiscardLabel, type PendingTurnChanges } from "./pendingTurnChanges";
import { ToolCallDetails } from "./ToolCallDetails";
import { ToolRunningIndicator } from "./ToolRunningIndicator";
import type { ToolCallGroup, ToolOutputResolver } from "./toolCalls";
import { WorkIcon } from "./WorkIcon";

/**
 * The revert footer a work group carries when its turn left pending changes: everything
 * about it travels together, so it is one object rather than five coincident props.
 */
export interface ToolGroupFooter {
  /** The sequence reverting from undoes the turn's pending changes. */
  changeSequence: number;
  timestamp: Date;
  /** Whether the turn's changes are the chat's last durable pending ones (label wording). */
  isTrailing: boolean;
  createdWorkpieces?: CreatedWorkpieceName[];
  disabled?: boolean;
  onRevert: (sequence: number) => void;
}

/**
 * Builds the footer a turn's work group carries when the turn left pending changes, from the
 * pending batch itself. Both row kinds that render groups (work runs and agent messages)
 * share this, so their footers cannot drift apart.
 */
export function turnFooterProps(
  pendingChange: PendingTurnChanges | null,
  isTrailing: boolean,
  timestamp: Date,
  disabled: boolean,
  onRevert: (sequence: number) => void,
): ToolGroupFooter | undefined {
  return pendingChange
    ? {
        changeSequence: pendingChange.revertFrom,
        timestamp,
        isTrailing,
        createdWorkpieces: pendingChange.createdWorkpieces,
        disabled,
        onRevert,
      }
    : undefined;
}

/** A transcript work-run group row: the summary button, its expanded calls, and its revert footer. */
export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  open,
  expandedKeys,
  onToggle,
  footer,
  outputOf,
}: {
  group: ToolCallGroup;
  open: boolean;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  footer?: ToolGroupFooter;
  outputOf?: ToolOutputResolver;
}) {
  const footerLabel = footer ? getDiscardLabel(footer.isTrailing, footer.createdWorkpieces) : null;
  return (
    <div className="group -ml-0.5">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={group.Icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
            <span className="min-w-0 truncate">{group.label}</span>
            <ToolRunningIndicator running={group.running} />
            {group.hasError && (
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
          {group.detailLines.length > 1 && (
            <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
              {group.detailLines.join(" · ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        group.calls.length === 1 && group.observations.length === 0 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ToolCallDetails toolCall={group.calls[0]} />
          </div>
        ) : group.calls.length === 0 && group.observations.length === 1 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ObservationDetails observation={group.observations[0]} />
          </div>
        ) : (
          <div className="ml-8 mt-1 space-y-1">
            {group.calls.map((toolCall) => {
              const key = `call-${toolCall.toolCallId}`;
              return (
                <NestedToolCallRow
                  key={toolCall.toolCallId}
                  toolCall={toolCall}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                  outputOf={outputOf}
                />
              );
            })}
            {group.observations.map((observation) => {
              const key = `observation-${observation.chatId}-${observation.sequence}`;
              return (
                <NestedObservationRow
                  key={key}
                  observation={observation}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                />
              );
            })}
          </div>
        )
      )}
      {footer && footerLabel && (
        <div className="ml-0 mt-0.5 flex items-center gap-1 opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Tooltip content={footerLabel} asChild>
            <button
              type="button"
              disabled={footer.disabled}
              onClick={() => footer.onRevert(footer.changeSequence)}
              className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={footerLabel}
            >
              <ArrowUUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content={formatFullTimestamp(footer.timestamp)} asChild>
            <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
              {footer.timestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
});
