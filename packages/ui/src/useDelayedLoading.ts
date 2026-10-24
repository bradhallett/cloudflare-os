// Ported from HextaUI (https://hextaui.com/docs/use-delayed-loading),
// https://github.com/preetsuthar17/hextaui — MIT License, Copyright (c) HextaUI.
// Copied verbatim apart from JSDoc and export conventions.

import * as React from "react";

/** Options for {@link useDelayedLoading}. */
type DelayedLoadingOptions = {
  /** Milliseconds to wait before showing the loading state. Defaults to 150. */
  delay?: number;
  /**
   * Minimum milliseconds the loading state stays visible once shown, so it never
   * flickers. Defaults to 400.
   */
  minDuration?: number;
};

/**
 * Shows a loading state only when work is actually slow, then keeps it up long
 * enough that it never flickers.
 *
 * Waits `delay` before showing anything, so work that finishes sooner never
 * shows a loading state; once visible, the indicator stays at least
 * `minDuration`. If `loading` turns back on while still visible, it stays
 * visible. Always `false` on the first render.
 *
 * @param loading Whether the work is in progress right now.
 * @returns Whether to show the loading state.
 */
function useDelayedLoading(
  loading: boolean,
  { delay = 150, minDuration = 400 }: DelayedLoadingOptions = {},
) {
  const [visible, setVisible] = React.useState(false);
  const shownAt = React.useRef(0);

  React.useEffect(() => {
    if (loading === visible) {
      return;
    }
    if (loading) {
      const timer = setTimeout(
        () => {
          shownAt.current = Date.now();
          setVisible(true);
        },
        Math.max(0, delay),
      );
      return () => clearTimeout(timer);
    }
    const remaining = Math.max(0, minDuration - (Date.now() - shownAt.current));
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [loading, visible, delay, minDuration]);

  return visible;
}

export { useDelayedLoading };
export type { DelayedLoadingOptions };
