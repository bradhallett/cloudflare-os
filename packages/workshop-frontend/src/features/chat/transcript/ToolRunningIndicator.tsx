import { useDelayedLoading } from "@gadgets/ui";

/**
 * The mini spinner a tool row shows while its call is still running. Rendered only for the
 * running stretch -- mounted when the call starts, unmounted when its result lands -- so the
 * delay hides it for calls that finish quickly and it disappears the moment one completes.
 */
export function ToolRunningIndicator() {
  const show = useDelayedLoading(true);
  if (!show) return null;
  return (
    <span
      aria-hidden
      className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent"
    />
  );
}
