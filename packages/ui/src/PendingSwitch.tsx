// Pending-state switch after HextaUI's Switch spec
// (https://hextaui.com/docs/switch), on Kumo's Switch: the new value shows
// optimistically while `onChange`'s write is in flight, the control carries
// `aria-busy` and `data-pending`, and a thumb spinner appears only once the
// write is slow. A rejection reverts to the last server value and reaches
// `onError`. Style it with `@gadgets/ui/pending-switch.css`.

import { Switch } from "@cloudflare/kumo";
import * as React from "react";
import { useDelayedLoading } from "./useDelayedLoading";

type KumoSwitchProps = React.ComponentProps<typeof Switch>;

type PendingSwitchProps = Omit<
  KumoSwitchProps,
  // `onChange` here is the async write, not the DOM event of the same name.
  "checked" | "onChange" | "onCheckedChange" | "transitioning"
> & {
  /** The value the server last reported. */
  checked: boolean;
  /**
   * Applies a new value. The switch shows it optimistically until the promise
   * settles; a rejection reverts the switch and reaches `onError`.
   */
  onChange: (next: boolean) => Promise<void>;
  /** Called with the rejection when `onChange` fails. */
  onError?: (error: unknown) => void;
};

/**
 * A Kumo `Switch` that owns its own pending state for an async write.
 *
 * One write at a time: further toggles while one is in flight are ignored.
 * The caller keeps server-truth state in `checked` and commits to it when its
 * own write succeeds; this switch only bridges the in-flight window and the
 * failure revert.
 */
const PendingSwitch = ({ checked, onChange, onError, ...switchProps }: PendingSwitchProps) => {
  // The value being written, or null when idle. While set, it is what the switch shows.
  const [pendingValue, setPendingValue] = React.useState<boolean | null>(null);
  const pending = pendingValue !== null;
  const slow = useDelayedLoading(pending);

  const change = (next: boolean) => {
    if (pendingValue !== null) return;
    setPendingValue(next);
    onChange(next)
      .catch((error: unknown) => {
        onError?.(error);
      })
      .finally(() => setPendingValue(null));
  };

  // Kumo's Switch derives `aria-busy` from `transitioning` and would override
  // one passed through `switchProps`. The data attributes carry the pending
  // cursor and the delayed thumb spinner, and reach the button because Kumo
  // spreads unknown props onto it.
  const pendingAttributes = {
    "data-pending": pending || undefined,
    "data-spinner": slow || undefined,
  } as unknown as KumoSwitchProps;

  return (
    <Switch
      {...switchProps}
      checked={pendingValue ?? checked}
      onCheckedChange={change}
      transitioning={pending}
      {...pendingAttributes}
    />
  );
};

export { PendingSwitch };
export type { PendingSwitchProps };
