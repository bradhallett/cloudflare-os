// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TURN_ANCHOR_PEEK_PX,
  turnAnchorScrollTop,
  useMessageScroller,
  type MessageScroller,
} from "./useMessageScroller";
import type { ChatDisplayEntry } from "./chatDisplayEntries";

// jsdom lays nothing out, so each test pins the container's scroll geometry directly and makes
// scrollTo() drive the pinned scrollTop, exactly as layout-driven scrolling would.
let scrollToCalls: Array<{ top?: number; behavior?: string }> = [];

// The latest scroller the harness rendered, for assertions between renders.
let currentScroller: MessageScroller | null = null;

beforeEach(() => {
  scrollToCalls = [];
  // jsdom has no scrollTo; route it into the pinned scrollTop as real scrolling would, clamped
  // to the element's scroll range the way browsers do.
  Element.prototype.scrollTo = function (
    this: HTMLElement,
    arg?: ScrollToOptions | number,
  ) {
    const top = typeof arg === "object" && arg !== null ? arg.top : arg;
    scrollToCalls.push({ top, behavior: typeof arg === "object" ? arg.behavior : undefined });
    if (top !== undefined) {
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    }
  } as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pinGeometry(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop = 0 }: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop?: number;
  },
): (top: number) => void {
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  return (next: number) => {
    top = next;
  };
}

const agentMessage = (sequence: number): ChatDisplayEntry =>
  ({
    type: "message",
    key: `agent-${sequence}`,
    message: {
      type: "message",
      sequence,
      author: { type: "agent", id: "model", name: "Model" },
    },
  }) as unknown as ChatDisplayEntry;

const userMessage = (sequence: number): ChatDisplayEntry =>
  ({
    type: "message",
    key: `user-${sequence}`,
    message: {
      type: "message",
      sequence,
      author: { type: "user", id: "me", name: "Me" },
    },
  }) as unknown as ChatDisplayEntry;

function ScrollerHarness({
  entries,
  isTurnActive,
}: {
  entries: readonly ChatDisplayEntry[];
  isTurnActive: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scroller = useMessageScroller({ containerRef, entries, isTurnActive });
  // Captured for assertions between renders; the harness renders nothing from it.
  currentScroller = scroller;
  return (
    <div
      ref={containerRef}
      data-testid="transcript"
      onScroll={scroller.handleScroll}
      {...scroller.intentEvents}
    >
      {entries.map((entry) => (
        <div key={entry.key} data-entry-key={entry.key} />
      ))}
    </div>
  );
}

async function renderHarness(
  entries: readonly ChatDisplayEntry[],
  isTurnActive: boolean,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop?: number },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ScrollerHarness entries={entries} isTurnActive={isTurnActive} />);
  });
  const transcript = container.querySelector<HTMLElement>('[data-testid="transcript"]')!;
  const setScrollTop = pinGeometry(transcript, geometry);
  return {
    transcript,
    setScrollTop,
    async rerender(nextEntries: readonly ChatDisplayEntry[], nextTurnActive: boolean) {
      await act(async () => {
        root.render(
          <ScrollerHarness entries={nextEntries} isTurnActive={nextTurnActive} />,
        );
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const fireScroll = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new Event("scroll"));
  });

const scroller = () => currentScroller!;

describe("turnAnchorScrollTop", () => {
  it("places the row peek below the top edge", () => {
    expect(turnAnchorScrollTop(500, TURN_ANCHOR_PEEK_PX, 1000)).toBe(500 - TURN_ANCHOR_PEEK_PX);
  });

  it("clamps to the scroll range", () => {
    expect(turnAnchorScrollTop(50, TURN_ANCHOR_PEEK_PX, 1000)).toBe(0);
    expect(turnAnchorScrollTop(5000, TURN_ANCHOR_PEEK_PX, 600)).toBe(600);
  });
});

describe("useMessageScroller", () => {
  it("counts rows appended while the reader is scrolled away, and clears on return", async () => {
    // 600 is the bottom of a 1000px thread in a 400px viewport.
    const harness = await renderHarness([agentMessage(1)], false, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    expect(scroller().atBottom).toBe(true);

    // Follows the live edge: nothing is ever missed.
    await harness.rerender([agentMessage(1), agentMessage(2)], false);
    expect(scroller().missedCount).toBe(0);

    // Wheel while away from the bottom opts the reader out of following.
    harness.setScrollTop(300);
    await act(async () => {
      harness.transcript.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    expect(scroller().atBottom).toBe(false);

    await harness.rerender([agentMessage(1), agentMessage(2), agentMessage(3), agentMessage(4)], false);
    expect(scroller().missedCount).toBe(2);
    expect(scroller().atBottom).toBe(false);

    // Scrolling back to the bottom by hand re-enables following and clears the count.
    harness.setScrollTop(600);
    await fireScroll(harness.transcript);
    expect(scroller().missedCount).toBe(0);
    expect(scroller().atBottom).toBe(true);

    harness.unmount();
  });

  it("treats keyboard and scrollbar-drag input as reader intent too", async () => {
    const harness = await renderHarness([agentMessage(1)], false, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });

    // A scroll key on the focused container takes control even while still at the bottom:
    // still on the live edge, but no longer following what arrives.
    await act(async () => {
      harness.transcript.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(scroller().atBottom).toBe(true);
    await harness.rerender([agentMessage(1), agentMessage(2), agentMessage(3)], false);
    expect(scroller().missedCount).toBe(2);

    // Reaching the bottom again clears the opt-out...
    harness.setScrollTop(600);
    await fireScroll(harness.transcript);
    expect(scroller().atBottom).toBe(true);
    expect(scroller().missedCount).toBe(0);

    // ...and a press on the container itself (the scrollbar rail) opts back out.
    harness.setScrollTop(100);
    await act(async () => {
      harness.transcript.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(scroller().atBottom).toBe(false);
    // A press on a row inside the container is content, not the rail: it changes nothing.
    harness.setScrollTop(600);
    await fireScroll(harness.transcript);
    const row = harness.transcript.querySelector<HTMLElement>("[data-entry-key]")!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(scroller().atBottom).toBe(true);

    harness.unmount();
  });

  it("jumpToLatest scrolls to the live edge and re-enables following", async () => {
    const harness = await renderHarness([agentMessage(1)], false, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 200,
    });
    await fireScroll(harness.transcript);
    expect(scroller().atBottom).toBe(false);

    scrollToCalls.length = 0;
    await act(async () => {
      scroller().jumpToLatest();
    });
    expect(scrollToCalls.at(-1)?.top).toBe(1000);
    expect(scroller().missedCount).toBe(0);
    expect(scroller().atBottom).toBe(true);

    harness.unmount();
  });

  it("anchors a prompt sent mid-turn near the top, not the bottom", async () => {
    const harness = await renderHarness([agentMessage(1)], true, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    // All rects read as one column: the user row sits scrollTop into the content. Stubbed on the
    // prototype because the row does not exist until the rerender below commits it.
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 0 } as DOMRect);

    scrollToCalls.length = 0;
    await harness.rerender([agentMessage(1), userMessage(2)], true);
    // Row top (600) minus the peek: 504, within the 600px scroll range.
    expect(scrollToCalls.at(-1)?.top).toBe(504);
    expect(scrollToCalls.at(-1)?.top).not.toBe(1000);
    expect(scroller().atBottom).toBe(false);

    // The anchored prompt itself is not missed; only rows after it count.
    await harness.rerender([agentMessage(1), userMessage(2), agentMessage(3)], true);
    expect(scroller().missedCount).toBe(1);

    rectSpy.mockRestore();
    harness.unmount();
  });

  it("does not anchor when no turn is active: the send follows the bottom", async () => {
    const harness = await renderHarness([agentMessage(1)], false, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    scrollToCalls.length = 0;
    await harness.rerender([agentMessage(1), userMessage(2)], false);
    // No top-anchoring call: the hook left scrolling to the caller's follow effect.
    expect(scrollToCalls.filter((call) => call.top !== 1000 && call.top !== undefined)).toHaveLength(0);
    expect(scroller().missedCount).toBe(0);

    harness.unmount();
  });

  it("resetToBottom re-arms following for a fresh chat", async () => {
    const harness = await renderHarness([agentMessage(1)], false, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 100,
    });
    await act(async () => {
      harness.transcript.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    expect(scroller().atBottom).toBe(false);

    scrollToCalls.length = 0;
    await act(async () => {
      scroller().resetToBottom();
    });
    expect(scrollToCalls.at(-1)?.top).toBe(1000);
    expect(scroller().atBottom).toBe(true);
    expect(scroller().missedCount).toBe(0);

    harness.unmount();
  });
});
