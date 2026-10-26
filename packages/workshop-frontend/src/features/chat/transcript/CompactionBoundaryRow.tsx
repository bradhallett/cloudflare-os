import { Brain, CaretRight } from "@phosphor-icons/react";
import type { CompactionBoundary, ChatDisplayEntry } from "./chatDisplayEntries";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import styles from "../../../ChatInterface.module.css";

/** The boundary's summary, shown while the marker is expanded. */
function CompactionSummary({
  boundary,
  keptRows,
}: {
  boundary: CompactionBoundary;
  keptRows: number | undefined;
}) {
  return (
    <div className="themed-surface-inset mt-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3.5">
      {keptRows !== undefined && (
        // Says what the agent traded away and what it still has, since the marker sits at
        // the request rather than at the cut it describes.
        <p className="mb-3 text-[12px] leading-[17px] text-kumo-subtle">
          The agent reads this in place of everything earlier in the chat.{" "}
          {keptRows === 0
            ? "Nothing after it was kept."
            : `The ${keptRows === 1 ? "message" : `${keptRows} messages`} after the cut ${keptRows === 1 ? "was" : "were"} kept in full.`}
        </p>
      )}
      <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
        <MarkdownMessage message={boundary.summary} />
      </div>
    </div>
  );
}

/**
 * A compaction checkpoint: the divider that announces the context was compacted, expanding
 * to the summary the agent reads in place of everything before the cut. Announced at the
 * request that produced it when there is one (an event where the user asked, not a rule
 * across the thread), otherwise at the cut itself.
 */
export function CompactionBoundaryRow({
  entry,
  expanded,
  onToggle,
  className,
}: {
  entry: Extract<ChatDisplayEntry, { type: "compactionBoundary" }>;
  expanded: boolean;
  onToggle: (to: number) => void;
  className: string;
}) {
  const summary = <CompactionSummary boundary={entry.boundary} keptRows={entry.keptRows} />;

  if (entry.requestedBy) {
    return (
      <div className={`${className} max-w-[860px] py-1`}>
        <button
          type="button"
          onClick={() => onToggle(entry.boundary.to)}
          aria-expanded={expanded}
          className="inline-flex cursor-pointer items-center gap-3 rounded-md px-1.5 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
            <Brain size={16} />
          </span>
          <span className="font-medium">
            {entry.requestedBy.name} compacted the context
          </span>
          <CaretRight
            size={11}
            weight="bold"
            className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        {expanded && summary}
      </div>
    );
  }

  return (
    <div className={`${className} mb-4 max-w-[860px]`}>
      <div className="flex items-center gap-3" role="separator" aria-label="Context compacted">
        <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
        <button
          type="button"
          onClick={() => onToggle(entry.boundary.to)}
          aria-expanded={expanded}
          className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
        >
          <Brain size={13} aria-hidden="true" />
          Context compacted
          <CaretRight
            size={11}
            weight="bold"
            className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
      </div>
      {expanded && summary}
    </div>
  );
}
