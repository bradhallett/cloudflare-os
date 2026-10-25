import { useEffect, useRef, useState } from "react";

import { missedCountLabel } from "./JumpToLatestPill";

/** Props for {@link MissedMessagesStatus}. */
export interface MissedMessagesStatusProps {
  /** Rows appended since the reader last saw the live edge; 0 when nothing was missed. */
  missedCount: number;
  /** Whether an agent turn is running; its end settles the announced count. */
  isTurnActive: boolean;
}

/**
 * Visually-hidden polite status for missed rows. The transcript's `role="log"` is held
 * `aria-busy` while a turn runs, so rows landing below the fold are otherwise silent for
 * assistive tech; this announces them when they are first missed, and once more with the
 * settled count when the turn ends — not on every streaming commit, and not on every
 * increment that lands while no turn is running.
 */
export const MissedMessagesStatus = ({
  missedCount,
  isTurnActive,
}: MissedMessagesStatusProps) => {
  const [announcement, setAnnouncement] = useState("");
  // The count already announced; null while nothing is missed, so each batch of missed rows
  // still gets its first announcement.
  const announcedRef = useRef<number | null>(null);
  // Rows arrived during a turn whose end has not yet been announced.
  const pendingSettleRef = useRef(false);

  useEffect(() => {
    if (missedCount === 0) {
      // Back on the live edge: nothing is pending, and the next batch announces afresh.
      announcedRef.current = null;
      pendingSettleRef.current = false;
      setAnnouncement("");
      return;
    }
    if (announcedRef.current === null) {
      announcedRef.current = missedCount;
      setAnnouncement(missedCountLabel(missedCount));
      return;
    }
    if (isTurnActive) {
      if (missedCount !== announcedRef.current) pendingSettleRef.current = true;
      return;
    }
    // Outside a turn, only a count grown during one re-announces — at its settled boundary —
    // so increments landing with no turn running stay silent after the first announcement.
    if (pendingSettleRef.current) {
      pendingSettleRef.current = false;
      announcedRef.current = missedCount;
      setAnnouncement(missedCountLabel(missedCount));
    }
  }, [missedCount, isTurnActive]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
};
