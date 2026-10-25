// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JumpToLatestPill } from "./JumpToLatestPill";

// Kumo's Button is a real component; the test only needs a clickable, labelled button.
vi.mock("@cloudflare/kumo", () => ({
  Button: ({ children, onClick }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

function renderPill(props: { missedCount: number; onJump: () => void }) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<JumpToLatestPill {...props} />);
  });
  return {
    button: () => container.querySelector("button"),
    async advance(ms: number) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JumpToLatestPill", () => {
  it("waits out the entrance delay before appearing", async () => {
    vi.useFakeTimers();
    const pill = renderPill({ missedCount: 0, onJump: () => {} });
    expect(pill.button()).toBeNull();
    await pill.advance(249);
    expect(pill.button()).toBeNull();
    await pill.advance(1);
    expect(pill.button()).not.toBeNull();
    pill.unmount();
  });

  it("labels singular and plural missed messages, or no count at all", async () => {
    vi.useFakeTimers();
    for (const [missedCount, label] of [
      [1, "1 new"],
      [3, "3 new"],
      [0, "Jump to latest"],
    ] as const) {
      const pill = renderPill({ missedCount, onJump: () => {} });
      await pill.advance(250);
      // The label span is asserted exactly, so reverting to the old "N new messages" wording fails.
      expect(pill.button()!.querySelector("span")!.textContent).toBe(label);
      pill.unmount();
    }
  });

  it("jumps on click", async () => {
    vi.useFakeTimers();
    const onJump = vi.fn<() => void>();
    const pill = renderPill({ missedCount: 2, onJump });
    await pill.advance(250);
    await act(async () => {
      pill.button()!.click();
    });
    expect(onJump).toHaveBeenCalledTimes(1);
    pill.unmount();
  });
});
