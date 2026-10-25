// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRunningIndicator } from "./ToolRunningIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToolRunningIndicator", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderIndicator = (running: boolean) =>
    act(() => root.render(<ToolRunningIndicator running={running} />));

  // The slot the spinner lives in, present from mount so siblings never shift.
  const slot = () => container.querySelector("span");
  // The spinner itself, inside the reserved slot.
  const spinner = () => container.querySelector("span > span");

  it("reserves its slot from mount, before the spinner appears", () => {
    renderIndicator(true);
    expect(slot()).not.toBeNull();
    expect(slot()!.getAttribute("aria-hidden")).toBe("true");
    expect(slot()!.className).toContain("h-3");
    expect(spinner()).toBeNull();

    act(() => vi.advanceTimersByTime(149));
    expect(spinner()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(spinner()).not.toBeNull();
    expect(spinner()!.className).toContain("animate-spin");
  });

  it("keeps the slot but never spins for a call that is not running", () => {
    renderIndicator(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(slot()).not.toBeNull();
    expect(spinner()).toBeNull();
  });

  it("shows nothing for a call that finishes within the delay", () => {
    renderIndicator(true);
    act(() => vi.advanceTimersByTime(149));
    renderIndicator(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(spinner()).toBeNull();
  });

  it("keeps a shown spinner up for the minimum duration after the call finishes", () => {
    renderIndicator(true);
    act(() => vi.advanceTimersByTime(150));
    expect(spinner()).not.toBeNull();

    // The result lands the instant the spinner appears; it must not flash away.
    renderIndicator(false);
    act(() => vi.advanceTimersByTime(399));
    expect(spinner()).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(spinner()).toBeNull();
    expect(slot()).not.toBeNull();
  });
});
