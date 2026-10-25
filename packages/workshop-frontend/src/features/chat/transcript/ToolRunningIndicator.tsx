import { useDelayedLoading } from "@gadgets/ui";

/**
 * The mini spinner a tool row shows while its call is still running. Always rendered, in a
 * fixed-size slot, so the row never reflows when the spinner appears or disappears: the delay
 * hides it for calls that finish quickly, and once shown it stays up for the minimum duration
 * after the call completes so it never flashes.
 */
export const ToolRunningIndicator = ({ running }: { running: boolean }) => {
  const show = useDelayedLoading(running);
  return (
    <span aria-hidden className="flex h-3 w-3 flex-shrink-0">
      {show && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      )}
    </span>
  );
};
