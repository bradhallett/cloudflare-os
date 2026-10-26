/** Design tokens: the palette, tones, fonts, wordmark, easing curves, and shared UI icons. */

import { svg } from "./dom.ts";

/* ----------------------- Design tokens ----------------------------------- */
export const C = {
  page:        "#f5f1eb",
  surface:     "#fff9ef",
  surfaceSoft: "#fff4e6",
  text:        "#2b0b05",
  muted:       "#7b6254",
  subtle:      "#a89082",
  border:      "#ead6c4",
  borderLight: "#f2e3d5",
  orange:      "#ff5f2e",
  orangeDark:  "#c84724",
  blue:        "#0a95ff",
  purple:      "#9b3ff6",
  green:       "#26a641",
  yellow:      "#f5a623",
};
// Corporate slide-facing palette. Editor chrome may use additional neutral
// values, but authored slide components are deliberately restricted to the
// branded white-slide colors.
export const TONES = ["neutral", "tangerine", "ruby"];
export const toneFill: Record<string, string> = {
  neutral:    "#FFFFFF",
  tangerine: "#FFFFFF",
  ruby:      "#FFFFFF",
};
export const toneColor: Record<string, string> = {
  neutral:    "#747474",
  tangerine: "#F6821F",
  ruby:      "#FF6633",
};

export const FONT     = 'Inter, Arial, sans-serif';
export const MONO     = '"Apercu Mono Pro", ui-monospace, SFMono-Regular, Menlo, monospace';
export const WORDMARK = '"FT Kunst Grotesk", Inter, Arial, sans-serif';

/* Custom easing curves — built-in CSS easings lack the punch that makes
 * UI motion feel intentional. Used everywhere via `var(--ease)`. */
export const EASE        = "cubic-bezier(0.23, 1, 0.32, 1)";        // strong ease-out
export const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";       // strong ease-in-out
export const ICONS = {
  chevronLeft: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>`,
  chevronRight: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  pencil: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`,
  expand: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/><polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>`,
  collapse: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 4 9 9 4 9"/><polyline points="15 4 15 9 20 9"/><polyline points="9 20 9 15 4 15"/><polyline points="15 20 15 15 20 15"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  // Hooked-arrow undo / redo (Lucide `undo-2` / `redo-2`): a horizontal
  // shaft that loops back under itself with the arrowhead pointing the
  // direction of travel. Much more universally legible as undo/redo
  // than the circular "rotate ccw / cw" arrows commonly bundled with
  // icon sets.
  undo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>`,
  redo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
};
