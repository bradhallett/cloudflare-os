// Ported from HextaUI (https://hextaui.com/docs/use-invalid-shake),
// https://github.com/preetsuthar17/hextaui — MIT License, Copyright (c) HextaUI.
// Copied verbatim apart from the inlined prefersReducedMotion helper (from
// HextaUI's lib/motion.ts), a support probe around :user-invalid, JSDoc, and
// export conventions.

import * as React from "react";

/** A form control {@link useInvalidShake} can watch. */
type ShakeControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const submitSelector =
  'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]';

function prefersReducedMotion() {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function supportsUserInvalid() {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("selector(:user-invalid)")
  );
}

function isInvalid(control: ShakeControl) {
  return (
    control.getAttribute("aria-invalid") === "true" ||
    control.hasAttribute("data-invalid") ||
    // Diverges from HextaUI: some environments (jsdom) throw on the
    // :user-invalid pseudo-class instead of returning false, so probe support
    // before matching.
    (supportsUserInvalid() && control.matches(":user-invalid"))
  );
}

/**
 * Shakes a form control when a submit attempt finds it invalid, and never while
 * someone is still typing.
 *
 * The hook only sets a `data-shake` attribute for 400ms, at most once per submit
 * attempt, and only within ~600ms of one (a click/Enter on a submit control, or
 * the form's submit event) when the control reports invalid via
 * `:user-invalid`, `aria-invalid="true"` or `data-invalid`. Under
 * `prefers-reduced-motion: reduce` nothing is set. The control must belong to a
 * `<form>`; without one the hook does nothing.
 *
 * The motion itself comes from CSS: import `@gadgets/ui/button-shake.css` (or
 * copy its `button-shake` keyframes) and style the control with
 * `data-shake:motion-safe:animate-button-shake` or an equivalent
 * `[data-shake]` animation rule.
 *
 * @param ref The form control to watch.
 * @param enabled Whether to shake. Defaults to true.
 */
function useInvalidShake(
  ref: React.RefObject<ShakeControl | null>,
  enabled = true,
) {
  React.useEffect(() => {
    const control = ref.current;
    const form = control?.form;
    if (!enabled || !control || !form) {
      return;
    }

    let attempt = 0;
    let shaken = 0;
    let attemptedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;

    const shake = () => {
      if (shaken === attempt || prefersReducedMotion()) {
        return;
      }
      shaken = attempt;
      const target =
        control.closest<HTMLElement>("[data-slot=input-group]") ?? control;
      target.removeAttribute("data-shake");
      void target.offsetWidth;
      target.setAttribute("data-shake", "");
      clearTimeout(timer);
      timer = setTimeout(() => target.removeAttribute("data-shake"), 400);
    };

    const recent = () => performance.now() - attemptedAt < 600;

    const check = () => {
      if (recent() && isInvalid(control)) {
        shake();
      }
    };

    const onAttempt = () => {
      attempt += 1;
      attemptedAt = performance.now();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(submitSelector)) {
        onAttempt();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.key === "Enter" && target instanceof HTMLInputElement) {
        onAttempt();
      }
    };

    const onInvalid = () => {
      if (recent()) {
        shake();
      }
    };

    const attributes = new MutationObserver(check);
    attributes.observe(control, {
      attributes: true,
      attributeFilter: ["aria-invalid", "data-invalid"],
    });

    form.addEventListener("click", onClick, true);
    form.addEventListener("keydown", onKeyDown, true);
    form.addEventListener("submit", onAttempt, true);
    control.addEventListener("invalid", onInvalid);

    return () => {
      attributes.disconnect();
      form.removeEventListener("click", onClick, true);
      form.removeEventListener("keydown", onKeyDown, true);
      form.removeEventListener("submit", onAttempt, true);
      control.removeEventListener("invalid", onInvalid);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [ref, enabled]);
}

export { useInvalidShake };
export type { ShakeControl };
