// Ported from HextaUI's Attachment title (https://hextaui.com/docs/attachment),
// https://github.com/preetsuthar17/hextaui — MIT License, Copyright (c) HextaUI.
// Copied verbatim apart from JSDoc and export conventions.

/** A filename split for display: {@link base} may be truncated, {@link extension} may not. */
type SplitFileName = {
  base: string;
  extension: string;
};

/**
 * Splits a filename into a truncatable base and an extension worth keeping visible, so a long
 * name can render as `very-long-na….pdf`.
 *
 * Returns `null` when there is no extension worth preserving: no dot, a leading dot (dotfiles
 * like `.bashrc`), a trailing dot, or an extension longer than 8 characters including the dot
 * (which would crowd out the base in a small tile).
 */
function splitFileName(name: string): SplitFileName | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 8) {
    return null;
  }
  return {base: name.slice(0, dot), extension: name.slice(dot)};
}

export {splitFileName};
export type {SplitFileName};
