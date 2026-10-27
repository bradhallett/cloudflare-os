/**
 * Addresses and rewrites the text an office shape holds, as both the sheets and slides families
 * model it.
 *
 * Agents read text as the model projects it, where an AutoText shows what it renders (a slide
 * number "11"), while the provider indexes an AutoText as one code unit whatever it shows. Every
 * other character occupies one index per UTF-16 code unit, so a range of projected text maps onto
 * provider indices exactly, unless a boundary falls inside an AutoText.
 *
 * Rewriting keeps styles: inserted text takes the style of the run at its insertion index, as
 * Google's `insertText` "generally" does, and a newline it inserts starts a paragraph copying the
 * one it was inserted into, bullet included, as `insertText` documents. Deleting a newline merges
 * its paragraph into the next, which keeps its own style. Google documents neither the first rule
 * exactly nor the last at all, so requests set both styles explicitly. A style set on text
 * that ends a paragraph also reaches its newline, as a live read shows, though a link never does.
 */

import type {
  RestBullet, RestParagraphStyle, RestText, RestTextStyle,
} from "./slides-api";
import { restyled, type StyleChange } from "./slides-format";

/** A text run, or an AutoText occupying `width` provider indices whatever `text` it shows. */
export type TextSegment = { text: string; width: number; autoText?: string; style?: RestTextStyle };

/** What a paragraph marker carries. */
export type Paragraph = { style?: RestParagraphStyle; bullet?: RestBullet };

/**
 * A shape's or cell's text: its segments, without the newline the provider keeps at its end, one
 * paragraph per newline including that last one, and the last newline's own style.
 */
export type RichText = {
  segments: TextSegment[];
  paragraphs: Paragraph[];
  endStyle?: RestTextStyle;
  lists?: Record<string, unknown>;
};

/** A provider index range, end exclusive. */
export type IndexRange = { startIndex: number; endIndex: number };

/**
 * Why a queued change cannot apply to the document as it now is. Its message is a lowercase
 * clause, which callers prefix with the change it is about.
 */
export class ChangeConflict extends Error {}

/** Characters Google strips from inserted text, which would leave a result unlike the preview. */
// oxlint-disable-next-line no-control-regex -- Google's documented set of stripped characters
export const STRIPPED_CHARACTERS = /[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text and paragraphs of a shape or cell, as `RichText` describes them. */
export function richTextOf(body: RestText | undefined): RichText {
  let segments: TextSegment[] = [];
  let markers: Paragraph[] = [];
  for (let element of body?.textElements ?? []) {
    if (element.paragraphMarker) {
      let { style, bullet } = element.paragraphMarker;
      markers.push({ ...(style ? { style } : {}), ...(bullet ? { bullet } : {}) });
    } else if (element.textRun) {
      let { content = "", style } = element.textRun;
      segments.push({ text: content, width: content.length, ...(style ? { style } : {}) });
    } else if (element.autoText) {
      let width = (element.endIndex ?? 0) - (element.startIndex ?? 0);
      if (!Number.isInteger(width) || width <= 0) {
        throw new Error("Google Slides returned an invalid AutoText");
      }
      let { type = "UNSPECIFIED", content = "", style } = element.autoText;
      segments.push({ text: content, width, autoText: type, ...(style ? { style } : {}) });
    }
  }
  let endStyle: RestTextStyle | undefined;
  let last = segments.at(-1);
  if (last && !last.autoText && last.text.endsWith("\n")) {
    endStyle = last.style;
    let text = last.text.slice(0, -1);
    segments.pop();
    if (text) segments.push({ ...last, text, width: text.length });
  }
  // A summary read's field mask leaves out paragraph markers.
  let count = projectedText(segments).split("\n").length;
  return {
    segments,
    paragraphs: Array.from({ length: count }, (_, i) => markers[i] ?? {}),
    ...(endStyle ? { endStyle } : {}),
    ...(body?.lists ? { lists: body.lists } : {}),
  };
}

/** The text agents read, as the model projects it. */
export function projectedText(segments: readonly TextSegment[]): string {
  return segments.map(segment => segment.text).join("");
}

/** The paragraph of projected `text` holding `offset`. */
export function paragraphAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1;
}

/** Paragraph `i` of projected `text`, as a range without its newline. */
export function paragraphRange(text: string, i: number): [start: number, end: number] {
  let lines = text.split("\n");
  let start = lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
  return [start, start + lines[i].length];
}

/** Splits at a projected offset, which must not fall inside an AutoText. */
export function cut(
  segments: readonly TextSegment[], offset: number,
): [TextSegment[], TextSegment[]] {
  let projected = 0;
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i];
    if (offset < projected + segment.text.length) {
      if (offset === projected) return [segments.slice(0, i), segments.slice(i)];
      if (segment.autoText) {
        throw new ChangeConflict("a slide number or other AutoText can only be edited whole");
      }
      let k = offset - projected;
      return [
        [...segments.slice(0, i), { ...segment, text: segment.text.slice(0, k), width: k }],
        [{ ...segment, text: segment.text.slice(k), width: segment.text.length - k },
          ...segments.slice(i + 1)],
      ];
    }
    projected += segment.text.length;
  }
  return [[...segments], []];
}

function width(segments: readonly TextSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.width, 0);
}

export function withStyle(segment: TextSegment, style: RestTextStyle | undefined): TextSegment {
  let { style: _, ...rest } = segment;
  return style ? { ...rest, style } : rest;
}

/** The provider indices of the projected range `[start, end)`. */
export function providerRange(
  segments: readonly TextSegment[], start: number, end: number,
): IndexRange {
  return { startIndex: width(cut(segments, start)[0]), endIndex: width(cut(segments, end)[0]) };
}

/** The style text inserted at a projected offset takes: the run's there, as `insertText` does. */
export function styleAt(rich: RichText, offset: number): RestTextStyle | undefined {
  let [, from] = cut(rich.segments, offset);
  return from.length > 0 ? from[0].style : rich.endStyle;
}

/** Replace the projected range `[start, end)` with `text`, keeping styles as the module says. */
export function spliceText(rich: RichText, start: number, end: number, text: string): RichText {
  let { segments, paragraphs } = rich;
  let [before] = cut(segments, start);
  let [, after] = cut(segments, end);
  let style = styleAt(rich, start);
  let projected = projectedText(segments);
  let paragraph = paragraphAt(projected, start);
  let merged = paragraphAt(projected, end);
  let inserted = text.split("\n").length - 1;
  // Google may give a merged paragraph either one's style; that is pinned when applied, but a list
  // item's bullet cannot be.
  let [first, last] = [paragraphs[paragraph], paragraphs[merged]]
    .map(({ bullet }) => JSON.stringify([bullet?.listId, bullet?.nestingLevel ?? 0]));
  if (merged > paragraph && first !== last) {
    throw new ChangeConflict(
      "the edit joins paragraphs that are not items of the same list at the same level; edit " +
      "each paragraph's text on its own");
  }
  let piece: TextSegment = { text, width: text.length, ...(style ? { style } : {}) };
  return {
    ...rich,
    segments: [
      ...before,
      // Google sets no link on a newline, so one the new text takes ends at each.
      ...atNewlines(piece).map(segment =>
        segment.text === "\n" ? withStyle(segment, restyled(segment.style, UNLINK)) : segment),
      ...after,
    ],
    paragraphs: [
      ...paragraphs.slice(0, paragraph),
      ...Array.from({ length: inserted }, () => structuredClone(paragraphs[paragraph])),
      ...paragraphs.slice(merged),
    ],
  };
}

const UNLINK: StyleChange<RestTextStyle> = { style: {}, fields: ["link"] };

/** A segment split so each newline is its own, as Google keeps a newline's style apart. */
export function atNewlines(segment: TextSegment): TextSegment[] {
  if (segment.autoText) return [segment];
  return segment.text.split(/(\n)/).filter(Boolean).map(text => ({ ...segment, text, width: text.length }));
}

// Whether an edit may start or end at a projected offset: not inside a character, nor an AutoText.
function isEditBoundary(segments: readonly TextSegment[], text: string, offset: number): boolean {
  if (!isGraphemeBoundary(text, offset)) return false;
  let projected = 0;
  for (let segment of segments) {
    if (offset <= projected) return true;
    projected += segment.text.length;
    if (offset < projected) return !segment.autoText;
  }
  return true;
}

/**
 * The least replacement with the same result as replacing `[start, end)` with `text`. Text left
 * unchanged at either end is not rewritten, so it keeps its own style.
 */
export function narrowChange(
  segments: readonly TextSegment[], start: number, end: number, text: string,
): { start: number; end: number; text: string } {
  let current = projectedText(segments);
  let old = current.slice(start, end);
  let shorter = Math.min(old.length, text.length);
  let prefix = 0;
  while (prefix < shorter && old[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shorter - prefix && old.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
  while (prefix > 0 && !isEditBoundary(segments, current, start + prefix)) prefix--;
  while (suffix > 0 && !isEditBoundary(segments, current, end - suffix)) suffix--;
  return { start: start + prefix, end: end - suffix, text: text.slice(prefix, text.length - suffix) };
}

/** Whether `offset` falls between characters of `text`, not inside one. */
export function isGraphemeBoundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length || graphemes.segment(text).containing(offset)?.index === offset;
}

/**
 * The projected range an edit replaces: the one occurrence of `find`, or, without it, all of the
 * text, which must still read `before` when that is given.
 */
export function changeRange(
  text: string, change: { find?: string; before?: string },
): { start: number; end: number } {
  let { find, before } = change;
  if (find === undefined) {
    if (before !== undefined && text !== before) {
      throw new ChangeConflict("the text has changed since this edit was made");
    }
    return { start: 0, end: text.length };
  }
  let start = text.indexOf(find);
  if (start === -1) throw new ChangeConflict("the text does not contain the text to find");
  if (text.indexOf(find, start + 1) !== -1) {
    throw new ChangeConflict(
      "the text to find occurs more than once; include more of the surrounding text");
  }
  let end = start + find.length;
  // Google moves an insertion out of a grapheme cluster, so the edit would land elsewhere.
  if (!isGraphemeBoundary(text, start) || !isGraphemeBoundary(text, end)) {
    throw new ChangeConflict("the text to find starts or ends inside a character; include all of it");
  }
  return { start, end };
}
