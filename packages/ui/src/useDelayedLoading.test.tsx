// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountHook } from "./hookHarness";
import { useDelayedLoading } from "./useDelayedLoading";

const use = (props: {
  loading: boolean;
  delay?: number;
  minDuration?: number;
}) =>
  useDelayedLoading(props.loading, {
    delay: props.delay,
    minDuration: props.minDuration,
  });

describe("useDelayedLoading", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("is false on first render and stays false for work that finishes within the delay", () => {
    const hook = mountHook(use, { loading: false });
    expect(hook.value).toBe(false);

    hook.rerender({ loading: true });
    advance(80);
    expect(hook.value).toBe(false);

    hook.rerender({ loading: false });
    advance(1000);
    expect(hook.value).toBe(false);
    hook.unmount();
  });

  it("shows after the delay and holds the minimum duration once the work ends", () => {
    const hook = mountHook(use, { loading: true });

    advance(149);
    expect(hook.value).toBe(false);
    advance(1);
    expect(hook.value).toBe(true);

    // The work ends while the indicator is visible, so the 400ms minimum runs
    // from when it was shown (t=150): it hides at 550ms.
    hook.rerender({ loading: false });
    advance(249); // t=399
     expect(hook.value).toBe(true);
    advance(151); // t=550
     expect(hook.value).toBe(false);
    hook.unmount();
  });

  it("stays visible when loading turns back on during the minimum-duration hold", () => {
    const hook = mountHook(use, { loading: true });
    advance(200);
    expect(hook.value).toBe(true);

    hook.rerender({ loading: false });
    advance(100);
    expect(hook.value).toBe(true);

    hook.rerender({ loading: true });
    advance(1000);
    expect(hook.value).toBe(true);
    hook.unmount();
  });

  it("never updates state after unmount", () => {
    const hook = mountHook(use, { loading: true });
    advance(100);
    hook.unmount();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });
});
