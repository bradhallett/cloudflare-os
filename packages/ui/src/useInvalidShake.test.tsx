// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInvalidShake } from "./useInvalidShake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fixture = {
  form: HTMLFormElement;
  control: HTMLSelectElement;
  group: HTMLDivElement | null;
  submit: HTMLButtonElement;
  unmount: () => void;
};

function mountFixture(reducedMotion = false, inputGroup = false): Fixture {
  const matchMedia = vi.fn().mockReturnValue({
    matches: reducedMotion,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  vi.stubGlobal("matchMedia", matchMedia);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ref = React.createRef<HTMLSelectElement | null>();
  const Host = () => {
    useInvalidShake(ref);
    return (
      <form onSubmit={(event) => event.preventDefault()}>
        {inputGroup ? (
          <div data-slot="input-group">
            <select ref={ref} required defaultValue="">
              <option value="" disabled />
            </select>
          </div>
        ) : (
          <select ref={ref} required defaultValue="">
            <option value="" disabled />
          </select>
        )}
        <button type="submit">Continue</button>
      </form>
    );
  };
  act(() => root.render(<Host />));
  const form = container.querySelector("form")!;
  return {
    form,
    control: ref.current!,
    group: container.querySelector("[data-slot=input-group]"),
    submit: form.querySelector("button")!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

describe("useInvalidShake", () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    }),
  );

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("does not shake when invalid appears without a submit attempt", () => {
    const { control, unmount } = mountFixture();
    act(() => {
      control.setAttribute("aria-invalid", "true");
    });
    advance(1000);
    expect(control.hasAttribute("data-shake")).toBe(false);
    unmount();
  });

  it("shakes after a submit attempt finds the control invalid, then clears the attribute", () => {
    const { control, submit, unmount } = mountFixture();
    act(() => {
      control.setAttribute("aria-invalid", "true");
      submit.click();
    });
    advance(50); // run the requestAnimationFrame check
    expect(control.hasAttribute("data-shake")).toBe(true);

    // The attribute stays 400ms from the shake, then is removed.
    advance(300); // t=350
    expect(control.hasAttribute("data-shake")).toBe(true);
    advance(100); // past the 400ms window
    expect(control.hasAttribute("data-shake")).toBe(false);
    unmount();
  });

  it("shakes the [data-slot=input-group] wrapper instead of the control", () => {
    const { control, group, submit, unmount } = mountFixture(false, true);
    act(() => {
      control.setAttribute("aria-invalid", "true");
      submit.click();
    });
    advance(50); // run the requestAnimationFrame check
    expect(group?.hasAttribute("data-shake")).toBe(true);
    expect(control.hasAttribute("data-shake")).toBe(false);
    unmount();
  });

  it("shakes on the native invalid event within the submit window, and shakes again on a second attempt", () => {
    const { control, submit, unmount } = mountFixture();
    act(() => {
      submit.click();
      control.dispatchEvent(new Event("invalid"));
    });
    expect(control.hasAttribute("data-shake")).toBe(true);

    advance(500); // attribute cleared
    expect(control.hasAttribute("data-shake")).toBe(false);

    act(() => {
      submit.click();
      control.dispatchEvent(new Event("invalid"));
    });
    expect(control.hasAttribute("data-shake")).toBe(true);
    unmount();
  });

  it("shakes only once per submit attempt however many invalid signals arrive", () => {
    const { control, submit, unmount } = mountFixture();
    act(() => {
      control.setAttribute("aria-invalid", "true");
      submit.click();
      control.dispatchEvent(new Event("invalid"));
      control.setAttribute("data-invalid", "");
    });
    advance(16);
    expect(control.hasAttribute("data-shake")).toBe(true);
    unmount();
  });

  it("ignores invalid signals outside the submit window", async () => {
    const { control, submit, unmount } = mountFixture();
    act(() => {
      submit.click();
    });
    advance(601);
    await act(async () => {
      control.setAttribute("aria-invalid", "true");
      control.dispatchEvent(new Event("invalid"));
    });
    advance(100);
    expect(control.hasAttribute("data-shake")).toBe(false);
    unmount();
  });

  it("never shakes under prefers-reduced-motion", () => {
    const { control, submit, unmount } = mountFixture(true);
    act(() => {
      control.setAttribute("aria-invalid", "true");
      submit.click();
      control.dispatchEvent(new Event("invalid"));
    });
    advance(100);
    expect(control.hasAttribute("data-shake")).toBe(false);
    unmount();
  });
});
