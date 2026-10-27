/**
 * Turns the office text engine's model into Slides REST shapes: text content Slides reports,
 * restyle requests that pin the styles Google leaves unspecified, and the field masks a request
 * that replaces a whole style needs. The addressing and rewriting itself lives in
 * `office-text.ts`.
 */

import type { RestText, RestTextElement, RestTextStyle } from "./slides-api";
import { restyled, type StyleChange } from "./slides-format";
import {
  atNewlines, ChangeConflict, cut, paragraphAt, paragraphRange, projectedText, providerRange,
  styleAt, withStyle, type RichText, type TextSegment,
} from "./office-text";

/** Where text requests apply: a shape, or one cell of a table. */
export type TextLocation = {
  objectId: string;
  cellLocation?: { rowIndex: number; columnIndex: number };
};

/**
 * Restyle the projected range `[start, end)` as an `updateTextStyle` of `change` does. Google sets
 * no link on a newline or bullet, and a link set over part of an existing link retargets all of it.
 * A range covering a whole paragraph also styles its bullet.
 */
export function styledText(
  rich: RichText, start: number, end: number, change: StyleChange<RestTextStyle>,
): RichText {
  let [before, rest] = cut(rich.segments, start);
  let [inside, after] = cut(rest, end - start);
  let pieces = inside.flatMap(atNewlines);
  let styled = pieces.map(segment => withStyle(
    segment, restyled(segment.style, change, segment.text === "\n" ? "link" : undefined)));
  let link = change.style.link;
  if (link) {
    let retarget = (segments: TextSegment[], old: RestTextStyle["link"]) => {
      if (!old) return;
      let key = JSON.stringify(old);
      for (let at = 0; at < segments.length && JSON.stringify(segments[at].style?.link) === key; at++) {
        segments[at] = withStyle(segments[at], { ...segments[at].style, link });
      }
    };
    let left = before.toReversed();
    retarget(left, pieces[0]?.style?.link);
    before = left.toReversed();
    retarget(after, pieces.at(-1)?.style?.link);
  }
  let text = projectedText(rich.segments);
  let from = 0;
  let paragraphs = rich.paragraphs.map(paragraph => {
    let newline = text.indexOf("\n", from);
    let to = newline === -1 ? text.length : newline;
    // Styling through the text's end reaches its newline too. An empty paragraph requires its
    // newline in the range rather than an empty range at its start.
    let covered = start <= from && end >= to && end > from;
    from = to + 1;
    if (!paragraph.bullet || !covered) return paragraph;
    let { bulletStyle: _, ...bullet } = paragraph.bullet;
    let bulletStyle = restyled(paragraph.bullet.bulletStyle, change, "link");
    return { ...paragraph, bullet: { ...bullet, ...(bulletStyle ? { bulletStyle } : {}) } };
  });
  let result = { ...rich, paragraphs, segments: [...before, ...styled, ...after] };
  // A range ending in a newline holds its paragraph's newline already, and reaches no further.
  return pieces.at(-1)?.text === "\n" ? result : styledParagraphEnd(result, end, change);
}

/**
 * Restyles the newline at projected `offset`, or the last one if `offset` ends the text, as a
 * `change` set on text ending there reaches it, link aside.
 */
function styledParagraphEnd(
  rich: RichText, offset: number, change: StyleChange<RestTextStyle>,
): RichText {
  let restyle = (style: RestTextStyle | undefined) => restyled(style, change, "link");
  let [head, [next, ...tail]] = cut(rich.segments, offset);
  if (!next) {
    let { endStyle, ...rest } = rich;
    let style = restyle(endStyle);
    return style ? { ...rest, endStyle: style } : rest;
  }
  let [newline, ...line] = atNewlines(next);
  if (newline?.text !== "\n") return rich;
  return { ...rich, segments: [...head, withStyle(newline, restyle(newline.style)), ...line, ...tail] };
}

/** `TextContent` holding `rich`, with the indices, runs and paragraph markers Slides reports. */
export function restTextOf(rich: RichText): RestText {
  // Google ends a run at every newline, the last included.
  let pieces = rich.segments.flatMap(segment => segment.autoText ? [segment] :
    segment.text.split(/(?<=\n)/).filter(Boolean)
      .map(text => ({ ...segment, text, width: text.length })));
  pieces.push({ text: "\n", width: 1, ...(rich.endStyle ? { style: rich.endStyle } : {}) });
  let textElements: RestTextElement[] = [];
  let index = 0;
  let paragraph = 0;
  let runs: RestTextElement[] = [];
  for (let piece of pieces) {
    let at = { startIndex: index, endIndex: index += piece.width };
    let style = piece.style ? { style: piece.style } : {};
    runs.push(piece.autoText
      ? { ...at, autoText: { type: piece.autoText, content: piece.text, ...style } }
      : { ...at, textRun: { content: piece.text, ...style } });
    if (piece.autoText || !piece.text.endsWith("\n")) continue;
    // Each paragraph opens with a marker spanning it.
    let { style: paragraphStyle, bullet } = rich.paragraphs[paragraph++] ?? {};
    textElements.push({
      startIndex: runs[0].startIndex, endIndex: index,
      paragraphMarker: {
        ...(paragraphStyle ? { style: paragraphStyle } : {}), ...(bullet ? { bullet } : {}),
      },
    }, ...runs);
    runs = [];
  }
  return { textElements, ...(rich.lists ? { lists: rich.lists } : {}) };
}

/** Every `TextStyle` field, so a style sent with them replaces the text's whole style. */
export const TEXT_STYLE_FIELDS = "backgroundColor,baselineOffset,bold,fontFamily,fontSize," +
  "foregroundColor,italic,link,smallCaps,strikethrough,underline,weightedFontFamily";

/** Every writable `ParagraphStyle` field, likewise. */
export const PARAGRAPH_STYLE_FIELDS = "alignment,direction,indentEnd,indentFirstLine,indentStart," +
  "lineSpacing,spaceAbove,spaceBelow,spacingMode";

/** A `Range` of provider indices. */
export function fixedRange(startIndex: number, endIndex: number) {
  return { type: "FIXED_RANGE", startIndex, endIndex };
}

/**
 * Whether styling `text`, inserted at projected `start` of `projected`, styles the whole of a
 * paragraph it starts. That reaches the paragraph's newline, as styling text ending a paragraph
 * does, and Google then gives the paragraph's bullet the style too.
 */
function fillsParagraph(projected: string, start: number, text: string): boolean {
  let joined = projected.slice(0, start) + text + projected.slice(start);
  let end = start + text.length;
  let starts = [...text.matchAll(/\n/g)].map(match => start + match.index + 1);
  if (start === 0 || projected[start - 1] === "\n") starts.unshift(start);
  return starts.some(from => {
    let newline = joined.indexOf("\n", from);
    let to = newline === -1 ? joined.length : newline;
    // An empty paragraph right after the text keeps its newline's style: the text ends one before.
    return to <= end && !(from === to && to === end);
  });
}

// A text style as JSON with its keys sorted, so styles Google lists in different orders compare
// equal. A bullet takes no link.
function styleKey(style: RestTextStyle): string {
  let { link: _, ...rest } = style;
  return JSON.stringify(rest, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : 1))
      : value);
}

/**
 * Requests turning `before` into `after`, which `spliceText` made by replacing `[start, end)` with
 * `text`. Google only "generally" keeps neighbouring styles and documents no rule for a merge, so
 * the new text is given its style explicitly, and so is the paragraph a merge leaves. A list item
 * that style fills would have its bullet restyled too, which is refused unless the bullet already
 * has that style, since no request sets a bullet's style back.
 */
export function replaceRequests(
  location: TextLocation, before: RichText, after: RichText, start: number, end: number,
  text: string,
): unknown[] {
  let range = providerRange(before.segments, start, end);
  let requests: unknown[] = [];
  if (text) {
    let style = styleAt(before, start) ?? {};
    let projected = projectedText(before.segments);
    let touched = before.paragraphs.slice(paragraphAt(projected, start), paragraphAt(projected, end) + 1);
    let styledApart = touched.some(({ bullet }) =>
      bullet && styleKey(bullet.bulletStyle ?? {}) !== styleKey(style));
    if (styledApart && fillsParagraph(projected, start, text)) {
      throw new ChangeConflict(
        "the new text fills a list item, and Google would give its bullet, which is styled apart " +
        "from its text, the text's style instead");
    }
    requests.push(
      { insertText: { ...location, text, insertionIndex: range.startIndex } },
      { updateTextStyle: {
        ...location, style, fields: TEXT_STYLE_FIELDS,
        textRange: fixedRange(range.startIndex, range.startIndex + text.length),
      } },
    );
  }
  if (range.endIndex > range.startIndex) {
    requests.push({
      deleteText: {
        ...location, textRange: fixedRange(range.startIndex + text.length, range.endIndex + text.length),
      },
    });
  }
  if (projectedText(before.segments).slice(start, end).includes("\n")) {
    let edited = projectedText(after.segments);
    let paragraph = paragraphAt(edited, start + text.length);
    let { startIndex, endIndex } = providerRange(after.segments, ...paragraphRange(edited, paragraph));
    requests.push({
      updateParagraphStyle: {
        ...location, style: after.paragraphs[paragraph].style ?? {}, fields: PARAGRAPH_STYLE_FIELDS,
        // Through its newline, so an empty paragraph has a range too.
        textRange: fixedRange(startIndex, endIndex + 1),
      },
    });
  }
  return requests;
}
