// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useExpansionSet, type ExpansionSet } from "./useExpansionSet";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let current: ExpansionSet<string> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  current = null;
});

function Probe() {
  current = useExpansionSet<string>();
  return null;
}

function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
}

describe("useExpansionSet", () => {
  it("toggles keys in and out", () => {
    mount();
    act(() => current!.toggle("a"));
    expect(current!.keys.has("a")).toBe(true);
    act(() => current!.toggle("a"));
    expect(current!.keys.has("a")).toBe(false);
  });

  it("resets every key", () => {
    mount();
    act(() => current!.toggle("a"));
    act(() => current!.toggle("b"));
    act(() => current!.reset());
    expect(current!.keys.size).toBe(0);
  });

  it("keeps the controller identity steady while keys hold", () => {
    mount();
    const before = current!;
    act(() => current!.toggle("a"));
    const afterToggle = current!;
    act(() => root!.render(<Probe />));
    // Re-rendering with unchanged keys keeps the controller object identical, so
    // memoized rows and effect dep arrays are not disturbed.
    expect(current).toBe(afterToggle);
    expect(current).not.toBe(before);
  });
});
