// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import { ToolGroupRow } from "./ToolGroupRow";
import { buildToolCallGroups } from "./toolCalls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const codeCall = (
  overrides: { output?: string; error?: string } = {},
): AiToolCall => ({
  toolCallId: "call-1",
  toolName: "executeCode",
  input: { code: "console.log(1)" },
  ...overrides,
});

describe("ToolGroupRow running indicator", () => {
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

  const renderRow = (calls: AiToolCall[]) =>
    act(() =>
      root.render(
        <ToolGroupRow
          group={buildToolCallGroups(calls)[0]}
          open={false}
          expandedKeys={new Set()}
          onToggle={() => {}}
        />,
      ),
    );

  const spinner = () => container.querySelector(".animate-spin");
  const errorPill = () => container.querySelector(".bg-kumo-danger-tint");

  it("shows the spinner in the summary line once the run passes the delay", () => {
    renderRow([codeCall()]);
    expect(spinner()).toBeNull();

    act(() => vi.advanceTimersByTime(150));
    expect(spinner()).not.toBeNull();
  });

  it("shows no spinner for a group whose calls all finished", () => {
    renderRow([codeCall({ output: "done" })]);
    act(() => vi.advanceTimersByTime(1000));
    expect(spinner()).toBeNull();
  });

  it("shows the Error pill instead of a spinner for a failed group", () => {
    renderRow([codeCall({ error: "boom" })]);
    act(() => vi.advanceTimersByTime(1000));
    expect(errorPill()).not.toBeNull();
    expect(spinner()).toBeNull();
  });
});
