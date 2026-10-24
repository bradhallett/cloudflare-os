// Hotkey parse/match/format utilities ported from HextaUI (MIT):
// https://hextaui.com/docs/hotkey.md — `lib/hotkey.ts`.
// Dependency-free; `mod` maps to ⌘ on Apple platforms and Ctrl elsewhere.
import * as React from "react";

function subscribePlatform() {
  return () => {};
}

/** Whether the current platform is an Apple one (⌘-bearing keyboard layout). */
export function isApplePlatform() {
  if (typeof navigator === "undefined") {
    return true;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * Whether shortcuts should be presented in Apple terms (⌘, ⌥, ⇧). Server
 * render assumes Apple so hydration matches the client's first paint only when
 * the client is Apple; the store re-reads after hydration corrects the rest.
 */
export function useIsApple() {
  return React.useSyncExternalStore(
    subscribePlatform,
    isApplePlatform,
    () => true,
  );
}

const modifierOrder = ["ctrl", "alt", "shift", "mod", "meta"];

const appleKeys: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↵",
  backspace: "⌫",
  escape: "esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const otherKeys: Record<string, string> = {
  mod: "Ctrl",
  meta: "Win",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  backspace: "Backspace",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const sharedKeys: Record<string, string> = {
  space: "Space",
  tab: "Tab",
  delete: "Del",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

const spokenKeys: Record<string, string> = {
  mod: "Command",
  meta: "Command",
  ctrl: "Control",
  alt: "Option",
  shift: "Shift",
  enter: "Enter",
  backspace: "Delete",
  escape: "Escape",
  arrowup: "Up arrow",
  arrowdown: "Down arrow",
  arrowleft: "Left arrow",
  arrowright: "Right arrow",
};

const otherSpokenKeys: Record<string, string> = {
  mod: "Control",
  meta: "Windows",
  alt: "Alt",
  backspace: "Backspace",
};

function normalizeKey(token: string) {
  const key = token.trim().toLowerCase();
  const aliases: Record<string, string> = {
    cmd: "meta",
    command: "meta",
    control: "ctrl",
    option: "alt",
    opt: "alt",
    return: "enter",
    esc: "escape",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    " ": "space",
  };
  return aliases[key] ?? key;
}

function sortModifiers(parts: string[]) {
  const key = parts.at(-1) ?? "";
  const modifiers = parts
    .slice(0, -1)
    .toSorted((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b));
  return [...modifiers, key];
}

/**
 * Parses a hotkey string into chords (whitespace-separated sequences), each a
 * list of normalized keys with the trigger key last and modifiers sorted.
 */
export function parseHotkey(hotkey: string) {
  return hotkey
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) =>
      sortModifiers(
        chord
          .split(/\+(?!$)/)
          .map(normalizeKey)
          .filter(Boolean),
      ),
    );
}

/** Display label for one normalized key part. */
export function keyLabel(key: string, apple: boolean) {
  const names = apple ? appleKeys : otherKeys;
  return (
    names[key] ??
    sharedKeys[key] ??
    (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1))
  );
}

/** Screen-reader label for one normalized key part. */
export function spokenKey(key: string, apple: boolean) {
  return (
    (!apple ? otherSpokenKeys[key] : undefined) ??
    spokenKeys[key] ??
    sharedKeys[key] ??
    keyLabel(key, apple)
  );
}

function parseChord(hotkey: string) {
  return parseHotkey(hotkey.replace(/\s+/g, ""))[0] ?? [];
}

/**
 * Formats a single-chord hotkey for display: symbols glued together on Apple
 * platforms (⌘⇧K), `+`-joined elsewhere (Ctrl+Shift+K).
 */
export function formatHotkey(hotkey: string, apple: boolean) {
  const labels = parseChord(hotkey).map((part) => keyLabel(part, apple));
  return apple ? labels.join("") : labels.join("+");
}

function eventKeys(event: KeyboardEvent) {
  const keys = new Set([normalizeKey(event.key === " " ? "space" : event.key)]);
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? "");
  if (physical) {
    keys.add((physical[1] ?? physical[2]).toLowerCase());
  }
  return keys;
}

/**
 * Whether a native keyboard event matches a single-chord hotkey. `mod` means
 * ⌘ on Apple platforms and Ctrl everywhere else; every modifier state must
 * match exactly, so `mod+k` does not match ⌘⇧K.
 */
export function matchesHotkey(event: KeyboardEvent, hotkey: string) {
  const parts = parseChord(hotkey);
  const key = parts.pop();
  const wants = new Set(parts);
  const apple = isApplePlatform();
  const meta = wants.has("meta") || (wants.has("mod") && apple);
  const ctrl = wants.has("ctrl") || (wants.has("mod") && !apple);

  return (
    key !== undefined &&
    eventKeys(event).has(key) &&
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.altKey === wants.has("alt") &&
    event.shiftKey === wants.has("shift")
  );
}
