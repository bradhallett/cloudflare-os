import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  entrySequenceId,
  latestUserMessageEntry,
  type ChatDisplayEntry,
} from "./chatDisplayEntries";

/**
 * A reader this far from the bottom edge still counts as following the live edge. Allows for
 * fractional scroll positions and layout rounding.
 */
const BOTTOM_TOLERANCE_PX = 8;

/**
 * How much of the previous exchange stays visible above a turn anchor, so a new question reads
 * as connected to what came before while its answer streams in below it.
 */
export const TURN_ANCHOR_PEEK_PX = 96;

/** Keys that scroll a focused scroll container; any of them is the reader taking control. */
const READER_SCROLL_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  PageUp: true,
  PageDown: true,
  Home: true,
  End: true,
  " ": true,
};

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_TOLERANCE_PX;
}

/**
 * The scroll offset that puts a row `peek`px below the viewport's top edge, clamped to the
 * container's scroll range. Pure so the anchoring math can be asserted against a mocked viewport.
 */
export function turnAnchorScrollTop(
  elementTop: number,
  peek: number,
  maxScrollTop: number,
): number {
  return Math.max(0, Math.min(elementTop - peek, maxScrollTop));
}

/** The row's top edge within the container's content, independent of CSS positioning up the tree. */
function rowTopInContainer(container: HTMLElement, row: HTMLElement): number {
  return (
    row.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

/** Options for {@link useMessageScroller}. */
export interface UseMessageScrollerOptions {
  /** The transcript's scroll container. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The chat's rendered rows, in order. Rows appended past the last one seen while scrolled away are the missed ones. */
  entries: readonly ChatDisplayEntry[];
  /** Whether an agent turn is running: a prompt that lands now anchors near the top instead of following the bottom. */
  isTurnActive: boolean;
}

/** What {@link useMessageScroller} returns. */
export interface MessageScroller {
  /** Whether the reader is on the live edge; false once they scroll or signal intent away. */
  atBottom: boolean;
  /** Rows appended since the reader last saw the live edge. */
  missedCount: number;
  /** Scroll-event handler for the container. */
  handleScroll: () => void;
  /** Spread on the container: every explicit reader input opts out of following. */
  intentEvents: {
    onWheel: () => void;
    onTouchStart: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
  /** Scrolls to the live edge if (and only if) still following. Call whenever content may grow. */
  followContent: () => void;
  /** Jump-pill action: scrolls to the live edge and re-enables following. */
  jumpToLatest: () => void;
  /** Chat switch: re-enable following, forget what was missed, scroll to the live edge. */
  resetToBottom: () => void;
}

/**
 * Reader affordances for the transcript's scroll container, ported from HextaUI's Message
 * Scroller (https://hextaui.com/docs/message-scroller): follow-the-live-edge with back-off on
 * any explicit reader input (wheel, touch, keyboard, scrollbar drag), a missed-row count taken
 * while scrolled away, and turn anchoring that settles a prompt sent mid-turn near the top of
 * the viewport so its answer streams in below it.
 *
 * The hook only observes and scrolls; the caller drives `followContent()` from its own
 * content-change effect (streamed text grows the container without changing `entries`).
 */
export function useMessageScroller({
  containerRef,
  entries,
  isTurnActive,
}: UseMessageScrollerOptions): MessageScroller {
  const [atBottom, setAtBottom] = useState(true);
  const [missedCount, setMissedCount] = useState(0);
  // Following = at the live edge and no reader back-off. The refs are the truth effects read;
  // the state is what rendering shows.
  const atBottomRef = useRef(true);
  const readerIntentRef = useRef(false);
  // True while a programmatic smooth jump to the bottom is in flight: intermediate positions it
  // scrolls through must not read as the reader leaving the edge.
  const jumpingRef = useRef(false);
  const lastSeenSequenceRef = useRef<number>(-Infinity);
  const latestSequenceRef = useRef<number>(-Infinity);
  const lastUserSequenceRef = useRef<number>(-Infinity);
  const lastScrollHeightRef = useRef(0);

  const setAtBottomState = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    latestSequenceRef.current = entries.reduce(
      (max, entry) => Math.max(max, entrySequenceId(entry)),
      -Infinity,
    );

    // A prompt that lands while a turn runs anchors near the top of the viewport, with a peek of
    // the prior exchange above it, so the answer streams in below it (HextaUI's scrollAnchor).
    const anchor = latestUserMessageEntry(entries);
    if (anchor && anchor.sequence > lastUserSequenceRef.current) {
      lastUserSequenceRef.current = anchor.sequence;
      // Keys are internal row ids; escape the quote so an exotic key cannot break out of the
      // attribute selector (jsdom has no CSS.escape).
      const selector = `[data-entry-key="${anchor.key.replace(/"/g, '\\"')}"]`;
      const row = el?.querySelector<HTMLElement>(selector) ?? null;
      if (isTurnActive && el && row) {
        el.scrollTo({
          top: turnAnchorScrollTop(
            rowTopInContainer(el, row),
            TURN_ANCHOR_PEEK_PX,
            el.scrollHeight - el.clientHeight,
          ),
          // Reduced motion degrades the settle to an instant jump.
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        // The anchored prompt is on screen; only what streams in after it is new below.
        lastSeenSequenceRef.current = Math.max(
          lastSeenSequenceRef.current,
          anchor.sequence,
        );
        setAtBottomState(false);
        // The anchor deliberately moved the viewport: skip this pass's growth re-check, which
        // still sees the pre-scroll position and would undo the anchor. The anchor's own scroll
        // events settle the follow state from here.
        lastScrollHeightRef.current = el.scrollHeight;
        return;
      }
    }

    if (!el) return;
    const grew = el.scrollHeight > lastScrollHeightRef.current + 0.5;
    lastScrollHeightRef.current = el.scrollHeight;
    if (atBottomRef.current && !readerIntentRef.current) {
      // Still following: the caller's follow effect scrolls to the new edge, so nothing is missed.
      lastSeenSequenceRef.current = latestSequenceRef.current;
      setMissedCount(0);
      return;
    }
    // Not following. Content growth moves the live edge past an opted-out reader even though
    // their scroll position never changed; a shrink may bring it back under them.
    const next = !grew && isAtBottom(el);
    if (next !== atBottomRef.current) setAtBottomState(next);
    if (next) {
      readerIntentRef.current = false;
      lastSeenSequenceRef.current = latestSequenceRef.current;
      setMissedCount(0);
    } else {
      setMissedCount(
        entries.filter((entry) => entrySequenceId(entry) > lastSeenSequenceRef.current)
          .length,
      );
    }
  }, [entries, isTurnActive, containerRef, setAtBottomState]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const edge = isAtBottom(el);
    if (jumpingRef.current) {
      // In flight: only arriving at the edge ends the jump; a reader input cancels it instead.
      if (edge) jumpingRef.current = false;
      else return;
    }
    if (edge !== atBottomRef.current) setAtBottomState(edge);
    if (edge) {
      // Reaching the live edge by any means re-enables following and clears what was missed.
      readerIntentRef.current = false;
      lastSeenSequenceRef.current = latestSequenceRef.current;
      setMissedCount(0);
    }
  }, [containerRef, setAtBottomState]);

  const interrupt = useCallback(() => {
    // Any explicit reader input opts out of following until they are back on the live edge
    // (HextaUI counts wheel, touch, keyboard and scrollbar drags alike).
    jumpingRef.current = false;
    readerIntentRef.current = true;
    const el = containerRef.current;
    if (el && !isAtBottom(el)) setAtBottomState(false);
  }, [containerRef, setAtBottomState]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (Object.hasOwn(READER_SCROLL_KEYS, event.key)) interrupt();
    },
    [interrupt],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // A press on the container itself is the scrollbar rail (or empty margin), not content.
      if (event.target === event.currentTarget) interrupt();
    },
    [interrupt],
  );

  const followContent = useCallback(() => {
    const el = containerRef.current;
    if (!el || !atBottomRef.current || readerIntentRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    lastSeenSequenceRef.current = latestSequenceRef.current;
  }, [containerRef]);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    readerIntentRef.current = false;
    lastSeenSequenceRef.current = latestSequenceRef.current;
    setMissedCount(0);
    setAtBottomState(true);
    const reduced = prefersReducedMotion();
    jumpingRef.current = !reduced;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [containerRef, setAtBottomState]);

  const resetToBottom = useCallback(() => {
    const el = containerRef.current;
    readerIntentRef.current = false;
    jumpingRef.current = false;
    lastSeenSequenceRef.current = latestSequenceRef.current;
    lastScrollHeightRef.current = el?.scrollHeight ?? 0;
    setMissedCount(0);
    setAtBottomState(true);
    el?.scrollTo({ top: el?.scrollHeight ?? 0, behavior: "auto" });
  }, [containerRef, setAtBottomState]);

  return {
    atBottom,
    missedCount,
    handleScroll,
    intentEvents: {
      onWheel: interrupt,
      onTouchStart: interrupt,
      onKeyDown: handleKeyDown,
      onPointerDown: handlePointerDown,
    },
    followContent,
    jumpToLatest,
    resetToBottom,
  };
}
