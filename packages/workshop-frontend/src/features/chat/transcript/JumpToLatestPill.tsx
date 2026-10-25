import { ArrowDownIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { useDelayedLoading } from "@gadgets/ui";

/** Props for {@link JumpToLatestPill}. */
export interface JumpToLatestPillProps {
  /** Rows appended since the reader last saw the live edge; 0 when nothing was missed. */
  missedCount: number;
  /** Scrolls to the live edge and re-enables following. */
  onJump: () => void;
}

/**
 * Label for missed rows, shared by the pill and the polite status: the count is of rendered
 * rows — collapsed runs and merged rows mean it is not a message count — so it claims no noun.
 */
export const missedCountLabel = (count: number) => `${count} new`;

/**
 * The transcript's floating jump pill (HextaUI's Message Scroller button): "N new ↓" while
 * rows landed below the fold, "Jump to latest" the rest of the time the reader is scrolled
 * away. Mounting it is the caller's signal that it should show; the delayed entrance keeps a
 * brief scroll adjustment from flashing it.
 */
export const JumpToLatestPill = ({ missedCount, onJump }: JumpToLatestPillProps) => {
  const visible = useDelayedLoading(true, { delay: 250, minDuration: 0 });
  if (!visible) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onJump}
      className="themed-floating-shadow pointer-events-auto gap-1.5 rounded-full"
    >
      <span>
        {missedCount > 0 ? missedCountLabel(missedCount) : "Jump to latest"}
      </span>
      <ArrowDownIcon size={13} aria-hidden="true" />
    </Button>
  );
};
