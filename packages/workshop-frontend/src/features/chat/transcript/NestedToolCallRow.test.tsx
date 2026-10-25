// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import { NestedToolCallRow } from "./NestedToolCallRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const codeCall = (
  overrides: { output?: string; error?: string } = {},
): AiToolCall => ({
  toolCallId: "call-1",
  toolName: "executeCode",
  input: { code: "console.log(1)" },
  ...overrides,
});

describe("NestedToolCallRow running indicator", () => {
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

  const renderRow = (tc: AiToolCall) =>
    act(() =>
      root.render(
        <NestedToolCallRow toolCall={tc} open={false} onToggle={() => {}} />,
      ),
    );

  const spinner = () => container.querySelector(".animate-spin");
  const errorPill = () => container.querySelector(".bg-kumo-danger-tint");

  it("shows the spinner once the call has run past the delay", () => {
    renderRow(codeCall());
    expect(spinner()).toBeNull();
    expect(errorPill()).toBeNull();

    act(() => vi.advanceTimersByTime(150));
    expect(spinner()).not.toBeNull();
  });

  it("keeps the spinner long enough not to flash once output arrives", () => {
    renderRow(codeCall());
    act(() => vi.advanceTimersByTime(150));
    expect(spinner()).not.toBeNull();

    renderRow(codeCall({ output: "done" }));
    act(() => vi.advanceTimersByTime(399));
    expect(spinner()).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(spinner()).toBeNull();
  });

  it("never shows a spinner for a call that finishes within the delay", () => {
    renderRow(codeCall());
    act(() => vi.advanceTimersByTime(100));
    renderRow(codeCall({ output: "done" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(spinner()).toBeNull();
  });

  it("shows the Error pill instead of a spinner for a failed call", () => {
    renderRow(codeCall({ error: "boom" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(errorPill()).not.toBeNull();
    expect(spinner()).toBeNull();
  });
});
