// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountHook } from "./hookHarness";
import { useButtonFeedback } from "./useButtonFeedback";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const use = (props: {
  onStatusChange?: (s: string) => void;
  onError?: (e: unknown) => void;
}) =>
  useButtonFeedback({
    onStatusChange: props.onStatusChange,
    onError: props.onError,
  });

describe("useButtonFeedback", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("skips the spinner for a fast success and resets after the success window", async () => {
    const statuses: string[] = [];
    const hook = mountHook(use, {
      onStatusChange: (s) => statuses.push(s),
    });

    hook.value.track(wait(80));
    expect(hook.value.isPending()).toBe(true);
    await advance(100);
    // Settled within the 150ms spinner delay: never loading.
    expect(statuses).toEqual(["success"]);
    expect(hook.value.status).toBe("success");

    await advance(2000);
    expect(hook.value.status).toBe("idle");
    expect(hook.value.isPending()).toBe(false);
    hook.unmount();
  });

  it("shows the spinner for slow work and holds it the minimum time", async () => {
    const hook = mountHook(use, {});

    hook.value.track(wait(500));
    await advance(150);
    expect(hook.value.status).toBe("loading");

    await advance(350); // work ends at 500ms total
    expect(hook.value.status).toBe("loading"); // 50ms of the minimum remain
    await advance(50);
    expect(hook.value.status).toBe("success");

    await advance(2000);
    expect(hook.value.status).toBe("idle");
    hook.unmount();
  });

  it("ignores a second track while one action is in flight", async () => {
    const statuses: string[] = [];
    const hook = mountHook(use, {
      onStatusChange: (s) => statuses.push(s),
    });
    hook.value.track(wait(300));
    hook.value.track(wait(10));
    await advance(3000);
    // Only the first run's outcome lands.
    expect(statuses).toEqual(["loading", "success", "idle"]);
    hook.unmount();
  });

  it("replaces a settled attempt's pending outcome when a new action starts", async () => {
    const statuses: string[] = [];
    const hook = mountHook(use, {
      onStatusChange: (s) => statuses.push(s),
    });
    const failure = wait(160).then(() => {
      throw new Error("boom");
    });

    hook.value.track(failure);
    await advance(160);
    // The failure settled inside the spinner hold, so its error display is still pending.
    expect(hook.value.status).toBe("loading");
    expect(hook.value.isPending()).toBe(true);

    // A retry within that window takes over instead of being ignored.
    hook.value.track(wait(300));
    await advance(3000);
    // The retry's spinner re-reports loading; the failure's error never lands.
    expect(statuses).toEqual(["loading", "loading", "success", "idle"]);
    hook.unmount();
  });

  it("reports the error and holds the error state while hovered, then resets after the pointer leaves", async () => {
    const seen: unknown[] = [];
    const hook = mountHook(use, { onError: (e) => seen.push(e) });
    const reason = new Error("nope");
    const failure = wait(10).then(() => {
      throw reason;
    });

    hook.value.track(failure);
    await advance(100);
    expect(hook.value.status).toBe("error");
    expect(hook.value.error).toBe(reason);
    expect(seen).toEqual([reason]);

    // Only pointerType is read by the handler.
    const mouseEnter = { pointerType: "mouse" } as React.PointerEvent<HTMLElement>;
    hook.value.buttonProps.onPointerEnter(mouseEnter);
    await advance(4000);
    expect(hook.value.status).toBe("error");

    hook.value.buttonProps.onPointerLeave();
    await advance(599);
    expect(hook.value.status).toBe("error");
    await advance(1);
    expect(hook.value.status).toBe("idle");
    hook.unmount();
  });

  it("reset returns to idle immediately and cancels pending timers", async () => {
    const hook = mountHook(use, {});
    hook.value.track(wait(300));
    await advance(200);
    expect(hook.value.status).toBe("loading");

    act(() => hook.value.reset());
    expect(hook.value.status).toBe("idle");
    await advance(5000);
    expect(hook.value.status).toBe("idle");
    hook.unmount();
  });

  it("reset clears a reported error along with the status", async () => {
    const reason = new Error("nope");
    const hook = mountHook(use, {});
    hook.value.track(Promise.reject(reason));
    await advance(100);
    expect(hook.value.status).toBe("error");
    expect(hook.value.error).toBe(reason);

    act(() => hook.value.reset());
    expect(hook.value.status).toBe("idle");
    expect(hook.value.error).toBeUndefined();
    hook.unmount();
  });
});
