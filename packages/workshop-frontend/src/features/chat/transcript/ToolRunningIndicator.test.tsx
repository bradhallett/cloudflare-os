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

  it("renders nothing until the loading delay has passed", () => {
    act(() => root.render(<ToolRunningIndicator />));
    expect(container.querySelector("span")).toBeNull();

    act(() => vi.advanceTimersByTime(149));
    expect(container.querySelector("span")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const spinner = container.querySelector("span");
    expect(spinner).not.toBeNull();
    expect(spinner!.className).toContain("animate-spin");
    expect(spinner!.getAttribute("aria-hidden")).toBe("true");
  });
});
