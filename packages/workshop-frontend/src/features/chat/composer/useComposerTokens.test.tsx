// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDocument } from "./composerDocument";
import { useComposerTokens, type UseComposerTokensArgs } from "./useComposerTokens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capsule = (start: number, length: number) => ({
  gatekeeperId: 1,
  description: {
    url: "https://example.com/a",
    title: "A",
    snippet: "",
    suggestedBindingName: "a",
    tsType: "A",
  },
  start,
  length,
});

const documentWithTokens = (text: string): ComposerDocument => ({
  text,
  capsules: [capsule(0, 3)],
  formats: [],
  command: null,
});

type Harness = {
  latest: () => ReturnType<typeof useComposerTokens>;
  rerender: (args: Partial<UseComposerTokensArgs>) => void;
  unmount: () => void;
};

const renderHook = (args: UseComposerTokensArgs): Harness => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  if ("textarea" in args) container.appendChild((args as {textarea: HTMLTextAreaElement}).textarea);
  let current = args;
  let output: ReturnType<typeof useComposerTokens>;
  const Probe = () => {
    output = useComposerTokens(current);
    return null;
  };
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return {
    latest: () => output,
    rerender: (overrides) => {
      current = {...current, ...overrides};
      act(() => root.render(<Probe />));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const baseArgs = (doc: ComposerDocument): UseComposerTokensArgs & {textarea: HTMLTextAreaElement} => {
  const textarea = document.createElement("textarea");
  return {
    document: doc,
    recordDraftEdit: vi.fn<() => void>(),
    replaceDocument: vi.fn<(document: ComposerDocument) => void>(),
    textareaRef: {current: textarea},
    // Only the no-token early return is exercised; hit tests with real spans stay in the
    // browser layout suite.
    mirrorRef: {current: {
      tokenAtPoint: vi.fn<() => null>(),
      syncLayout: vi.fn<() => void>(),
      syncWidth: vi.fn<() => void>(),
      syncScroll: vi.fn<() => void>(),
      textOffsetTop: () => 0,
      setHoveredToken: vi.fn<() => void>(),
    }},
    textarea,
  };
};

const mounted: Harness[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("useComposerTokens", () => {
  it("merges capsule, command, and format ranges", () => {
    const harness = renderHook(baseArgs({
      text: "/run x [fmt] tail",
      capsules: [],
      formats: [{start: 8, length: 5, noun: "fmt", icon: "table"}],
      command: {choice: {
        selection: {builtin: true, commandId: "compact"},
        name: "run",
        description: "runs",
        providerLabel: "Workshop",
      }, start: 0, length: 4},
    }));
    mounted.push(harness);
    expect(harness.latest().currentTokenRanges()).toEqual([
      {start: 0, length: 4},
      {start: 8, length: 5},
    ]);
  });

  it("snapCaretOutOfTokens bounces a caret inside a token to its edge", () => {
    const harness = renderHook(baseArgs(documentWithTokens("abc tail")));
    mounted.push(harness);
    expect(harness.latest().snapCaretOutOfTokens(1, "left")).toBe(0);
    expect(harness.latest().snapCaretOutOfTokens(1, "right")).toBe(3);
    expect(harness.latest().snapCaretOutOfTokens(1, "nearest")).toBe(0);
    expect(harness.latest().snapCaretOutOfTokens(2, "nearest")).toBe(3);
    expect(harness.latest().snapCaretOutOfTokens(9, "nearest")).toBe(9);
  });

  it("moveCaret moves the textarea selection and refreshes the picker caret", () => {
    const args = baseArgs(documentWithTokens("abc tail"));
    args.textarea.value = "abc tail";
    const harness = renderHook(args);
    act(() => {
      harness.latest().moveCaret(5);
    });
    expect(args.textarea.selectionStart).toBe(5);
    expect(args.textarea.selectionEnd).toBe(5);
    expect(harness.latest().cursorPosition).toBe(5);
  });

  it("removeTokenAt replaces the document and parks the caret after the edit", async () => {
    const args = baseArgs(documentWithTokens("abc tail"));
    const harness = renderHook(args);
    mounted.push(harness);
    act(() => {
      harness.latest().removeTokenAt({start: 0, length: 3});
    });
    expect(args.recordDraftEdit).toHaveBeenCalled();
    const replaced = (args.replaceDocument as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(replaced.text).toBe("tail");
    await act(async () => {});
    expect(args.textarea.selectionStart).toBe(0);
  });

  it("tokenAtPoint skips hit-testing when the document has no tokens", () => {
    const args = baseArgs({text: "plain", capsules: [], formats: [], command: null});
    const harness = renderHook(args);
    mounted.push(harness);
    expect(harness.latest().tokenAtPoint(10, 10)).toBeNull();
    expect((args.mirrorRef.current!.tokenAtPoint as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
