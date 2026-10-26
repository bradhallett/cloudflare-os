/**
 * Canonical input class chains for Workshop form controls (match the profile settings
 * page and the command palette). Two sizes cover the app: `INPUT_LG` for full-size pages
 * and `INPUT_SM` for dense surfaces like dialogs and panels. Compose, don't fork: keep
 * size overrides as local suffixes/prefixes rather than new full chains.
 */

/** Full-size form input: mobile-first `h-10`/`16px`, intended to step down on wider viewports. */
export const INPUT_LG =
  'h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[16px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'

/** Compact form input for dense surfaces: dialogs, panels, and settings rows. */
export const INPUT_SM =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'
