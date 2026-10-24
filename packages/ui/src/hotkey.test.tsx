// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatHotkey,
  isApplePlatform,
  keyLabel,
  matchesHotkey,
  parseHotkey,
  spokenKey,
  useIsApple,
} from "./hotkey";

function fakePlatform(platform: string) {
  vi.stubGlobal("navigator", Object.assign(new Object(), navigator, { platform }));
}

function keyEvent(init: KeyboardEventInit & { code?: string }) {
  const event = new KeyboardEvent("keydown", init);
  if (init.code !== undefined) {
    Object.defineProperty(event, "code", { value: init.code });
  }
  return event;
}

describe("parseHotkey", () => {
  it("normalizes aliases and orders modifiers with the trigger key last", () => {
    expect(parseHotkey("shift+cmd+k")).toEqual([["shift", "meta", "k"]]);
    expect(parseHotkey("Control+Option+Return")).toEqual([["ctrl", "alt", "enter"]]);
  });

  it("splits chords on whitespace and drops empty parts", () => {
    expect(parseHotkey("mod+k  n")).toEqual([["mod", "k"], ["n"]]);
    expect(parseHotkey("  ")).toEqual([]);
  });

  it("maps space and arrow aliases", () => {
    expect(parseHotkey("mod+up")).toEqual([["mod", "arrowup"]]);
    expect(parseHotkey("space")).toEqual([["space"]]);
  });
});

describe("matchesHotkey", () => {
  it("matches mod+k as ⌘K on Apple platforms", () => {
    fakePlatform("MacIntel");
    expect(matchesHotkey(keyEvent({ key: "k", metaKey: true, code: "KeyK" }), "mod+k")).toBe(true);
    expect(matchesHotkey(keyEvent({ key: "k", ctrlKey: true, code: "KeyK" }), "mod+k")).toBe(false);
  });

  it("matches mod+k as Ctrl+K on non-Apple platforms", () => {
    fakePlatform("Win32");
    expect(matchesHotkey(keyEvent({ key: "k", ctrlKey: true, code: "KeyK" }), "mod+k")).toBe(true);
    expect(matchesHotkey(keyEvent({ key: "k", metaKey: true, code: "KeyK" }), "mod+k")).toBe(false);
  });

  it("requires exact modifier state", () => {
    fakePlatform("MacIntel");
    expect(matchesHotkey(keyEvent({ key: "k", metaKey: true, shiftKey: true, code: "KeyK" }), "mod+k")).toBe(false);
    expect(matchesHotkey(keyEvent({ key: "k", metaKey: true, shiftKey: true, code: "KeyK" }), "mod+shift+k")).toBe(true);
    expect(matchesHotkey(keyEvent({ key: "escape" }), "escape")).toBe(true);
  });

  it("matches the physical key regardless of the produced case", () => {
    fakePlatform("MacIntel");
    expect(matchesHotkey(keyEvent({ key: "K", metaKey: true, shiftKey: true, code: "KeyK" }), "mod+shift+k")).toBe(true);
  });

  it("still reports the key of an IME-composition event, so handlers must gate with their own composition check", () => {
    fakePlatform("MacIntel");
    const composing = keyEvent({ key: "k", metaKey: true, code: "KeyK" });
    Object.defineProperty(composing, "isComposing", { value: true });
    Object.defineProperty(composing, "keyCode", { value: 229 });
    // The utilities are key-based (passthrough): the ChatComposer-style guard
    // `!isImeComposing(event) && matchesHotkey(event, hotkey)` is what keeps
    // composition keystrokes from triggering a shortcut.
    expect(matchesHotkey(composing, "mod+k")).toBe(true);
  });
});

describe("formatHotkey", () => {
  it("glues Apple symbols and joins others with +", () => {
    expect(formatHotkey("mod+shift+k", true)).toBe("⇧⌘K");
    expect(formatHotkey("mod+shift+k", false)).toBe("Shift+Ctrl+K");
    expect(formatHotkey("mod+k", true)).toBe("⌘K");
    expect(formatHotkey("mod+k", false)).toBe("Ctrl+K");
  });

  it("uses spoken names for special keys via keyLabel and spokenKey", () => {
    expect(keyLabel("enter", true)).toBe("↵");
    expect(spokenKey("mod", true)).toBe("Command");
    expect(spokenKey("mod", false)).toBe("Control");
    expect(spokenKey("backspace", false)).toBe("Backspace");
  });
});

describe("useIsApple", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("reflects the current platform", () => {
    fakePlatform("MacIntel");
    expect(isApplePlatform()).toBe(true);
    fakePlatform("Linux x86_64");
    expect(isApplePlatform()).toBe(false);

    let isApple: boolean | undefined;
    const Probe = () => {
      isApple = useIsApple();
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(<Probe />));
    expect(isApple).toBe(false);
  });
});
