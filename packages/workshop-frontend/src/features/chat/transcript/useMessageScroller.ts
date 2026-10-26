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
 * How the scroller relates to the live edge: "following" rides it, "readerOwns" is the reader's
 * explicit opt-out until they return to the edge, and "jumping" is a programmatic smooth jump in
 * flight, whose intermediate positions must not read as the reader leaving the edge.
 */
type FollowMode = "following" | "readerOwns" | "jumping";

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
  /** The chat whose rows `entries` are. Message sequences restart per chat, so the per-sequence bookkeeping resets when this changes. */
  chatId: number | null;
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
  /** Spread on the container: explicit reader input — wheel, touch drag, scroll keys, scrollbar drag — opts out of following. */
  intentEvents: {
    onWheel: () => void;
    onTouchMove: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
  /** Scrolls to the live edge if (and only if) still following — gliding, not snapping, while a jump is in flight. Call whenever content may grow. */
  followContent: () => void;

  /** Jump-pill action: scrolls to the live edge and re-enables following. */
  jumpToLatest: () => void;
  /** Chat switch: re-enable following, forget what was missed, scroll to the live edge. */
  resetToBottom: () => void;
}

/**
 * Reader affordances for the transcript's scroll container, ported from HextaUI's Message
 * Scroller (https://hextaui.com/docs/message-scroller): follow-the-live-edge with back-off on
 * any explicit reader input (wheel, touch drag, keyboard, scrollbar drag), a missed-row count taken
 * while scrolled away, and turn anchoring that settles a prompt sent mid-turn near the top of
 * the viewport so its answer streams in below it.
 *
 * The hook only observes and scrolls; the caller drives `followContent()` from its own
 * content-change effect (streamed text grows the container without changing `entries`).
 */
export function useMessageScroller({
  containerRef,
  chatId,
  entries,
  isTurnActive,
}: UseMessageScrollerOptions): MessageScroller {
  const [atBottom, setAtBottom] = useState(true);
  const [missedCount, setMissedCount] = useState(0);
  const atBottomRef = useRef(true);
  // Following = at the live edge and no reader back-off. The refs are the truth effects read;
  // the state is what rendering shows.
  const setAtBottomState = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);
  const modeRef = useRef<FollowMode>("following");
  const lastSeenSequenceRef = useRef<number>(-Infinity);
  const latestSequenceRef = useRef<number>(-Infinity);
  const lastUserSequenceRef = useRef<number>(-Infinity);
  // The chat the per-sequence refs above describe. Message sequences restart per chat, so a
  // stale chat's numbers must never be compared against the current chat's rows.
  const chatIdRef = useRef(chatId);
  // Armed for a chat's opening rows — from mount when rows are already on screen or a turn is
  // already running (a page-load or warm-cache remount mid-turn: those rows, and any that
  // arrive over its still-running turn while the cache refills, are history the reader is
  // landing on, not a prompt to anchor), and on chat change until the switched-to chat's first
  // non-empty rows pass. A first send into an empty chat mounts with neither, so it anchors.
  const adoptingChatRef = useRef(entries.length > 0 || isTurnActive);
  const lastScrollHeightRef = useRef(0);

  // Resume following the live edge: whatever put the reader back on it means nothing below
  // counts as missed, and any in-flight jump is over.
  const markFollowing = useCallback(() => {
    modeRef.current = "following";
    lastSeenSequenceRef.current = latestSequenceRef.current;
    setMissedCount(0);
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    // Chat switch: sequence numbers restart per chat, so the previous chat's watermark would
    // misread this chat's rows (a prompt below it would never anchor; rows above it would count
    // as missed). Reset before anything below compares against them.
    if (chatIdRef.current !== chatId) {
      chatIdRef.current = chatId;
      lastSeenSequenceRef.current = -Infinity;
      latestSequenceRef.current = -Infinity;
      lastUserSequenceRef.current = -Infinity;
      adoptingChatRef.current = true;
    }

    latestSequenceRef.current = entries.reduce(
      (max, entry) => Math.max(max, entrySequenceId(entry)),
      -Infinity,
    );

    // A prompt that lands while a turn runs anchors near the top of the viewport, with a peek of
    // the prior exchange above it, so the answer streams in below it (HextaUI's scrollAnchor).
    const anchor = latestUserMessageEntry(entries);
    // The armed chat's opening rows are history the reader is landing on, not a fresh
    // prompt: adopt the newest one as already anchored instead of scrolling to it.
    if (adoptingChatRef.current && entries.length > 0) {
      adoptingChatRef.current = false;
      if (anchor) lastUserSequenceRef.current = anchor.sequence;
    }
    if (anchor && anchor.sequence > lastUserSequenceRef.current) {
      lastUserSequenceRef.current = anchor.sequence;
      // Keys are internal row ids; escape the quote so an exotic key cannot break out of the
      // attribute selector (jsdom has no CSS.escape).
      const selector = `[data-entry-key="${anchor.key.replace(/"/g, '\\"')}"]`;
      const row = el?.querySelector<HTMLElement>(selector) ?? null;
      if (
        isTurnActive &&
        el &&
        row &&
        // A transcript that fits on screen has no live edge to leave: anchor only when there
        // is somewhere to scroll away from, so a steer in a short thread keeps following
        // instead of freezing fully-visible rows into missed ones.
        el.scrollHeight - el.clientHeight > BOTTOM_TOLERANCE_PX
      ) {
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
    if (atBottomRef.current && modeRef.current !== "readerOwns") {
      // Still riding the live edge — following it, or mid-glide back to it (a jump): content
      // growth must retarget the follow, not strand it. The caller's follow effect scrolls.
      markFollowing();
      return;
    }
    // Not following. Content growth moves the live edge past an opted-out reader even though
    // their scroll position never changed; a shrink may bring it back under them.
    const next = !grew && isAtBottom(el);
    if (next !== atBottomRef.current) setAtBottomState(next);
    if (next) {
      markFollowing();
    } else {
      setMissedCount(
        entries.filter((entry) => entrySequenceId(entry) > lastSeenSequenceRef.current)
          .length,
      );
    }
  }, [chatId, entries, isTurnActive, containerRef, setAtBottomState, markFollowing]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const edge = isAtBottom(el);
    if (modeRef.current === "jumping" && !edge) {
      // In flight: only arriving at the edge ends the jump; a reader input cancels it instead.
      return;
    }
    if (edge !== atBottomRef.current) setAtBottomState(edge);
    // Reaching the live edge by any means re-enables following and clears what was missed.
    if (edge) markFollowing();
  }, [containerRef, setAtBottomState, markFollowing]);

  const interrupt = useCallback(() => {
    // Any explicit reader input opts out of following until they are back on the live edge
    // (HextaUI counts wheel, touch, keyboard and scrollbar drags alike).
    modeRef.current = "readerOwns";
    const el = containerRef.current;
    if (el && !isAtBottom(el)) setAtBottomState(false);
  }, [containerRef, setAtBottomState]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Only keys pressed with the container itself focused scroll it; the same key on a
      // focused row control (a button's Space) is content interaction, not reader intent.
      if (
        event.target === event.currentTarget &&
        Object.hasOwn(READER_SCROLL_KEYS, event.key)
      ) {
        interrupt();
      }
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
    if (!el || !atBottomRef.current || modeRef.current === "readerOwns") return;
    // While the pill's smooth jump glides, follow in kind: an instant scroll here would snap
    // the reader to the new edge mid-flight. Retargeting keeps the glide smooth to it.
    el.scrollTo({ top: el.scrollHeight, behavior: modeRef.current === "jumping" ? "smooth" : "auto" });
    lastSeenSequenceRef.current = latestSequenceRef.current;
  }, [containerRef]);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    markFollowing();
    setAtBottomState(true);
    const reduced = prefersReducedMotion();
    // The smooth glide reads as "jumping" until it settles on the edge (see handleScroll);
    // reduced motion degrades to an instant jump, which is already following.
    modeRef.current = reduced ? "following" : "jumping";
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [containerRef, setAtBottomState, markFollowing]);

  const resetToBottom = useCallback(() => {
    markFollowing();
    const el = containerRef.current;
    // Snap straight to the edge and skip this pass's growth re-check, which would still see
    // the pre-scroll position.
    lastScrollHeightRef.current = el?.scrollHeight ?? 0;
    setAtBottomState(true);
    el?.scrollTo({ top: el?.scrollHeight ?? 0, behavior: "auto" });
  }, [containerRef, setAtBottomState, markFollowing]);

  return {
    atBottom,
    missedCount,
    handleScroll,
    intentEvents: {
      onWheel: interrupt,
      onTouchMove: interrupt,
      onKeyDown: handleKeyDown,
      onPointerDown: handlePointerDown,
    },
    followContent,
    jumpToLatest,
    resetToBottom,
  };
}
