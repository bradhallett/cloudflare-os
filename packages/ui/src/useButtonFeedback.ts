// Ported from HextaUI (https://hextaui.com/docs/use-button-feedback),
// https://github.com/preetsuthar17/hextaui — MIT License, Copyright (c) HextaUI.
// Copied verbatim apart from JSDoc and export conventions.

import * as React from "react";

/** Lifecycle of a tracked action: idle → loading → success | error → idle. */
type ButtonStatus = "idle" | "loading" | "success" | "error";

/**
 * Milliseconds an outcome stays visible before resetting, either one number for
 * both outcomes or per-outcome.
 */
type ButtonResetAfter = number | { success?: number; error?: number };

/** Options for {@link useButtonFeedback}. */
type ButtonFeedbackOptions = {
  /** How long each outcome stays visible before resetting to idle. Defaults to `{ success: 2000, error: 4000 }`. */
  resetAfter?: ButtonResetAfter;
  /** Called on every status transition. */
  onStatusChange?: (status: ButtonStatus) => void;
  /** Called with the rejection reason when the tracked action fails. */
  onError?: (error: unknown) => void;
};

const spinnerDelay = 150;
const minimumSpinnerTime = 400;
const resumeResetDelay = 600;
const defaultResetAfter = { success: 2000, error: 4000 };

function resolveResetAfter(
  resetAfter: ButtonResetAfter | undefined,
  outcome: "success" | "error",
) {
  if (typeof resetAfter === "number") {
    return resetAfter;
  }
  return resetAfter?.[outcome] ?? defaultResetAfter[outcome];
}

/**
 * Runs an async action through idle → loading → success/error for a button or
 * other control.
 *
 * Skips the spinner for calls that settle within 150ms, holds a shown spinner
 * for at least 400ms, and holds the error state while the control is hovered or
 * focus-visible (resetting 600ms after the pointer or focus leaves). Spread
 * `buttonProps` onto the control to get the error hold; `track` the action from
 * wherever it starts.
 */
function useButtonFeedback(options: ButtonFeedbackOptions = {}) {
  const [status, setStatus] = React.useState<ButtonStatus>("idle");
  const [error, setError] = React.useState<unknown>(undefined);
  const optionsRef = React.useRef(options);
  const runRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
  // Whether the current run's action has settled. A settled run only has its outcome display
  // pending (the spinner hold or reset), which a new attempt supersedes: letting the stale
  // outcome land over the new attempt would desync the control from what is actually running.
  const settledRef = React.useRef(true);
  const timersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const holdRef = React.useRef({ hovered: false, focused: false });
  const resetPendingRef = React.useRef(false);
  const statusRef = React.useRef<ButtonStatus>("idle");

  React.useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const clearTimers = React.useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  React.useEffect(
    () => () => {
      runRef.current += 1;
      clearTimers();
    },
    [clearTimers],
  );

  const update = React.useCallback((next: ButtonStatus) => {
    statusRef.current = next;
    setStatus(next);
    optionsRef.current.onStatusChange?.(next);
  }, []);

  const later = React.useCallback((callback: () => void, delay: number) => {
    const run = runRef.current;
    timersRef.current.push(
      setTimeout(() => {
        if (run === runRef.current) {
          callback();
        }
      }, delay),
    );
  }, []);

  const isHeld = React.useCallback(
    () =>
      statusRef.current === "error" &&
      (holdRef.current.hovered || holdRef.current.focused),
    [],
  );

  const resume = React.useCallback(() => {
    if (resetPendingRef.current && !isHeld()) {
      resetPendingRef.current = false;
      later(() => update("idle"), resumeResetDelay);
    }
  }, [isHeld, later, update]);

  /**
   * Starts tracking an action given as a promise or a function returning one.
   * Ignored while another action is still pending; once it has settled, the new action
   * supersedes its outcome display, which never lands.
   */
  const track = React.useCallback(
    (action: PromiseLike<unknown> | (() => PromiseLike<unknown>)) => {
      if (inFlightRef.current && !settledRef.current) {
        return;
      }
      const run = ++runRef.current;
      let spinnerShownAt: number | null = null;

      inFlightRef.current = true;
      settledRef.current = false;
      resetPendingRef.current = false;
      clearTimers();

      later(() => {
        spinnerShownAt = Date.now();
        update("loading");
      }, spinnerDelay);

      const settle = (outcome: "success" | "error", reason?: unknown) => {
        if (run !== runRef.current) {
          return;
        }
        settledRef.current = true;
        clearTimers();
        const remaining =
          spinnerShownAt === null
            ? 0
            : Math.max(0, minimumSpinnerTime - (Date.now() - spinnerShownAt));

        later(() => {
          inFlightRef.current = false;
          if (outcome === "error") {
            setError(reason);
            optionsRef.current.onError?.(reason);
          }
          update(outcome);
          later(
            () => {
              if (isHeld()) {
                resetPendingRef.current = true;
              } else {
                update("idle");
              }
            },
            resolveResetAfter(optionsRef.current.resetAfter, outcome),
          );
        }, remaining);
      };

      try {
        const promise = typeof action === "function" ? action() : action;
        Promise.resolve(promise).then(
          () => settle("success"),
          (reason: unknown) => settle("error", reason),
        );
      } catch (reason) {
        settle("error", reason);
      }
    },
    [clearTimers, isHeld, later, update],
  );

  /**
   * Tracks an action whose resolved `false` means failure: the control shows its error
   * state with reason `undefined`, on the contract that the failure has already been
   * reported where the action ran (a toast, an inline notice). A sync `false` maps the
   * same way; any other sync result starts nothing async, so nothing is tracked.
   */
  const trackBoolean = React.useCallback(
    (action: boolean | PromiseLike<boolean | void> | void) => {
      if (typeof action === "boolean") {
        if (action === false) {
          track(Promise.reject(undefined));
        } else {
          track(Promise.resolve());
        }
        return;
      }
      if (action != null) {
        track(
          Promise.resolve(action).then((value) => {
            if (value === false) {
              throw undefined;
            }
          }),
        );
      }
    },
    [track],
  );


  /** Cancels timers, clears a reported error, and returns to idle immediately. */
  const reset = React.useCallback(() => {
    runRef.current += 1;
    clearTimers();
    inFlightRef.current = false;
    settledRef.current = true;
    resetPendingRef.current = false;
    setError(undefined);
    update("idle");
  }, [clearTimers, update]);

  const handlers = React.useMemo(
    () => ({
      onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse") {
          holdRef.current.hovered = true;
        }
      },
      onPointerLeave: () => {
        holdRef.current.hovered = false;
        resume();
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        holdRef.current.focused = event.currentTarget.matches(":focus-visible");
      },
      onBlur: () => {
        holdRef.current.focused = false;
        resume();
      },
    }),
    [resume],
  );

  return {
    status,
    error,
    track,
    trackBoolean,
    reset,
    isPending: () => inFlightRef.current,
    buttonProps: { status, ...handlers },
  };
}

export { useButtonFeedback };
export type { ButtonFeedbackOptions, ButtonResetAfter, ButtonStatus };
