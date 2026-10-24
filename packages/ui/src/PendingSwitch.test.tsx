// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingSwitch } from "./PendingSwitch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no PointerEvent, which Kumo's Switch forwards its clicks with.
if (typeof window.PointerEvent !== "function") {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    pointerId = 1;
  } as unknown as typeof window.PointerEvent;
}

type MountProps = {
  checked?: boolean;
  onChange: (next: boolean) => Promise<void>;
  onError?: (error: unknown) => void;
};

describe("PendingSwitch", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    // A failed assertion skips the mount's own unmount, so nothing of one test
    // is left for the next to find.
    document.body.innerHTML = "";
  });

  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  const mount = ({ checked = false, onChange, onError }: MountProps) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (props: MountProps) =>
      act(() =>
        root.render(
          <PendingSwitch
            aria-label="test"
            checked={props.checked ?? false}
            onChange={props.onChange}
            onError={props.onError}
          />,
        ),
      );
    render({ checked, onChange, onError });
    const control = () => {
      const element = Array.from(document.body.querySelectorAll('[role="switch"]'))
        .find((el) => el.getAttribute("aria-label") === "test")!;
      if (!(element instanceof HTMLButtonElement)) throw new Error("No switch rendered");
      return element;
    };
    return {
      control,
      rerender: render,
      unmount() {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  const toggle = async (element: HTMLButtonElement) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  // The package's TypeScript lib predates Promise.withResolvers, so the
  // executor form it replaces is what is left.
  const deferred = <T = void,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("applies the new value optimistically and marks itself busy", async () => {
    const write = deferred();
    const onChange = vi.fn(() => write.promise);
    const switchEl = mount({ onChange });
    const control = switchEl.control();

    expect(control.getAttribute("aria-checked")).toBe("false");
    await toggle(control);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.hasAttribute("data-pending")).toBe(true);
    // Within the spinner delay nothing spins.
    await advance(100);
    expect(control.hasAttribute("data-spinner")).toBe(false);

    // Success: the caller commits the server value, and the pending marks clear.
    await act(async () => write.resolve());
    switchEl.rerender({ checked: true, onChange });
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("aria-busy")).toBeNull();
    expect(control.hasAttribute("data-pending")).toBe(false);
    switchEl.unmount();
  });

  it("spins in the thumb only after the slow delay", async () => {
    const write = deferred();
    const switchEl = mount({ onChange: () => write.promise });
    const control = switchEl.control();
    await toggle(control);

    await advance(149);
    expect(control.hasAttribute("data-spinner")).toBe(false);
    await advance(1);
    expect(control.hasAttribute("data-spinner")).toBe(true);

    await act(async () => write.resolve());
    expect(control.hasAttribute("data-spinner")).toBe(true); // held the minimum duration
    await advance(500);
    expect(control.hasAttribute("data-spinner")).toBe(false);
    switchEl.unmount();
  });

  it("falls back to the server value once idle, and keeps it once the server follows", async () => {
    const write = deferred();
    const onChange = () => write.promise;
    const switchEl = mount({ onChange });
    const control = switchEl.control();
    await toggle(control);
    await act(async () => write.resolve());
    // The caller hasn't committed yet, so the last server value is what shows.
    expect(control.getAttribute("aria-checked")).toBe("false");
    switchEl.rerender({ checked: true, onChange });
    expect(control.getAttribute("aria-checked")).toBe("true");
    switchEl.unmount();
  });

  it("reverts and reports the failure when the write fails", async () => {
    const write = deferred();
    const onError = vi.fn();
    const failure = new Error("write rejected");
    const switchEl = mount({ checked: true, onChange: () => write.promise, onError });
    const control = switchEl.control();

    await toggle(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    await act(async () => write.reject(failure));
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onError).toHaveBeenCalledWith(failure);
    switchEl.unmount();
  });

  it("ignores a second toggle while a write is in flight", async () => {
    const write = deferred();
    const onChange = vi.fn(() => write.promise);
    const switchEl = mount({ onChange });
    const control = switchEl.control();
    await toggle(control);
    await toggle(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(control.getAttribute("aria-checked")).toBe("true");
    await act(async () => write.resolve());
    switchEl.unmount();
  });
});
