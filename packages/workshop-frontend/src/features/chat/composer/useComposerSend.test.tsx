// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "./attachments/useComposerAttachments";
import type { ComposerDocument } from "./composerDocument";
import type { StoredComposerDraft } from "./draft/composerDraft";
import { useComposerSend, type UseComposerSendArgs } from "./useComposerSend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyDocument = (text: string): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

// A flagged `retryable` rejection, as workerd's enhanced error serialization delivers it.
const transientError = () => Object.assign(new Error("retryable"), {retryable: true});

const readyAttachment = (): ComposerAttachment => ({
  id: "a1",
  blob: new Blob(["x"]),
  mimeType: "text/plain",
  uploadState: "ready",
  ref: {kind: "attachment", id: "ref-1"} as ComposerAttachment["ref"],
});

const runCommand = (start: number, length: number) => ({
  choice: {
    selection: {builtin: true, commandId: "compact"},
    name: "run",
    description: "runs",
    providerLabel: "Workshop",
  } as SlashCommandChoice,
  start,
  length,
});

type Harness = {
  latest: () => ReturnType<typeof useComposerSend>;
  rerender: (args: Partial<UseComposerSendArgs>) => void;
  unmount: () => void;
};

// Renders a probe that records the hook's latest output and lets each test override args.
const renderHook = (args: UseComposerSendArgs): Harness => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let current = args;
  let output: ReturnType<typeof useComposerSend>;
  const Probe = () => {
    output = useComposerSend(current);
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

const baseArgs = (): UseComposerSendArgs => ({
  chatKey: 7,
  selectedModelId: null,
  onSend: async () => {},
  newChat: false,
  isAgentActive: false,
  isBlocked: false,
  document: emptyDocument("hello"),
  attachments: [],
  clearSentAttachments: vi.fn(),
  isCreatingResource: false,
  beginSend: () => ({key: undefined, editRevision: 0, draft: {} as StoredComposerDraft}),
  completeSend: () => true,
  replaceDocument: vi.fn(),
  recordDraftEdit: vi.fn(),
  setInputValue: vi.fn(),
  toasts: {add: vi.fn(() => "t")},
});

const mounted: Harness[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("useComposerSend", () => {
  it("canSend requires idle, unblocked, and non-empty input", () => {
    const harness = renderHook(baseArgs());
    mounted.push(harness);
    expect(harness.latest().canSend).toBe(true);

    harness.rerender({document: emptyDocument("  ")});
    expect(harness.latest().canSend).toBe(false);

    harness.rerender({document: emptyDocument("hello"), isBlocked: true});
    expect(harness.latest().canSend).toBe(false);

    harness.rerender({isBlocked: false, isAgentActive: true});
    expect(harness.latest().canSend).toBe(false);
  });

  it("canSend counts a ready attachment and rejects an unready one", () => {
    const harness = renderHook({...baseArgs(), document: emptyDocument("")});
    mounted.push(harness);
    harness.rerender({attachments: [readyAttachment()]});
    expect(harness.latest().canSend).toBe(true);

    const uploading = {...readyAttachment(), uploadState: "uploading" as const, ref: undefined};
    harness.rerender({attachments: [uploading]});
    expect(harness.latest().canSend).toBe(false);
  });

  it("canSteer requires agent activity and a plain-text draft", () => {
    const harness = renderHook({...baseArgs(), isAgentActive: true});
    mounted.push(harness);
    expect(harness.latest().canSteer).toBe(true);

    harness.rerender({document: {...emptyDocument("/run hi"), command: runCommand(0, 4)}});
    expect(harness.latest().canSteer).toBe(false);

    harness.rerender({document: emptyDocument("hi"), attachments: [readyAttachment()]});
    expect(harness.latest().canSteer).toBe(false);
  });

  it("a successful send clears the document", async () => {
    const args = baseArgs();
    const harness = renderHook(args);
    mounted.push(harness);
    await act(async () => {
      harness.latest().submitMessage();
    });
    expect(args.replaceDocument).toHaveBeenCalledWith({text: "", capsules: [], formats: [], command: null});
    expect(args.clearSentAttachments).toHaveBeenCalled();
  });

  it("a transient failure keeps the draft and raises the hiccup hint", async () => {
    const args = {...baseArgs(), onSend: vi.fn(async () => { throw transientError(); })};
    const harness = renderHook(args);
    mounted.push(harness);
    await act(async () => {
      harness.latest().submitMessage();
    });
    expect(args.replaceDocument).not.toHaveBeenCalled();
    expect(harness.latest().sendHiccup).toEqual({chatKey: 7});
  });

  it("a definitive failure in a chat clears the draft for the failed-send bubble", async () => {
    const args = {...baseArgs(), onSend: vi.fn(async () => { throw new Error("definitive"); })};
    const harness = renderHook(args);
    mounted.push(harness);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        harness.latest().submitMessage();
      });
      expect(args.replaceDocument).toHaveBeenCalledWith({text: "", capsules: [], formats: [], command: null});
      expect(harness.latest().sendHiccup).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it("a definitive failure without a chat keeps the draft (no transcript to hold it)", async () => {
    const args = {...baseArgs(), chatKey: null, onSend: vi.fn(async () => { throw new Error("definitive"); })};
    const harness = renderHook(args);
    mounted.push(harness);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        harness.latest().submitMessage();
      });
      expect(args.replaceDocument).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("Stop folds queued steers back into the draft text", async () => {
    const onStop = vi.fn(async () => {});
    const args = {...baseArgs(), isAgentActive: true, queuedSteers: ["first", "second"], onStop};
    const harness = renderHook(args);
    mounted.push(harness);
    act(() => {
      harness.latest().handleStop();
    });
    expect(args.setInputValue).toHaveBeenCalledWith("hello\n\nfirst\n\nsecond");
    expect(harness.latest().isStopping).toBe(true);
  });
});
