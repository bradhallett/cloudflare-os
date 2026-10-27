/**
 * Canonical action class chains for Workshop controls (the button sibling of inputStyles):
 * one primary-button chain instead of per-file copies. Compose, don't fork: keep size or
 * layout overrides as local suffixes rather than new full chains.
 */

/** Primary action button: brand fill, press feedback, and disabled affordances. */
export const PRIMARY_BTN =
  'press inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
