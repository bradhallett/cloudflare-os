/** Ready-made slide layouts (cover, content, two-column, four-column) and the cover art / dot-grid helpers they use. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { svg } from "./dom.ts";
import type { BlockInput, SlideInput } from "./protocol.ts";

const COVER_ORANGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#ff5115"/><stop offset=".56" stop-color="#ff861f"/><stop offset="1" stop-color="#ffc02c"/></linearGradient><linearGradient id="a" x2="1" y2=".8"><stop stop-color="#ff5a16"/><stop offset="1" stop-color="#ffad25"/></linearGradient></defs><rect width="1200" height="675" fill="url(#b)"/><path d="M-42-50C374-81 699-4 886 185c171 172 157 399-13 490H0V0z" fill="#ff5a17" opacity=".64"/><path d="M7 675C126 389 380 208 694 198c256-8 427 90 506 169v308z" fill="url(#a)" opacity=".66"/><path d="M1199 98c-29 282-237 494-518 558-192 44-413 37-675 19" fill="none" stroke="#ffbe20" stroke-width="2.2" opacity=".92"/></svg>`;
export const COVER_ORANGE_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(COVER_ORANGE_SVG)}`;


/* =====================================================================
 *  Slide templates
 *  -------------------------------------------------------------------
 *  Two ready-made slide layouts, both on the 1200×675 canvas:
 *
 *   - makeTitleSlide()   → the orange full-bleed COVER (title + subtitle
 *                          + white horizontal logo). Used for the deck's
 *                          opening slide.
 *   - makeContentSlide() → a white BASIC content slide following the
 *                          branded corporate shell: accent eyebrow,
 *                          black headline, dark horizontal logo upper-right,
 *                          a one-column body, and the bottom brand bar.
 *
 *  Both are plain `{ background, blocks }` objects with no ids — the
 *  server mints ids for every block on insert. `addSlide(template)` deep-
 *  clones and inserts one; the two footer buttons call these. Everything
 *  they produce is a normal editable block, so users can tweak freely.
 * ===================================================================== */
export type SlideTemplate = Omit<SlideInput, "blocks"> & { blocks: BlockInput[] };

export function makeTitleSlide(): SlideTemplate {
  return {
    background: { color: "#F6821F", inset: false, coverOrange: true },
    blocks: [
      { type: "logo", x: 36, y: 56, w: 267, props: {} },
      { type: "title", x: 33, y: 197, w: 687,
        props: { text: "[TITLE]", fontSize: 58, weight: 700,
          color: "#FFFFFF", letterSpacing: "-0.03em",
          lineHeight: 1.1, highlight: "" } },
      { type: "subtitle", x: 36, y: 533, w: 553,
        props: { text: "[SUBTITLE]", fontSize: 17, weight: 600,
          color: "#FFFFFF", lineHeight: 1.5 } },
    ],
  };
}

export function makeContentSlide(): SlideTemplate {
  return {
    background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
    blocks: [
      { type: "sectionLabel", x: 36, y: 35, props: { text: "SECTION" } },
      { type: "title", x: 35, y: 76, w: 984,
        props: { text: "Write the headline as a specific assertion",
          fontSize: 28, weight: 600, color: "#000000",
          letterSpacing: "-0.03em", lineHeight: 1.2, highlight: "" } },
      { type: "logo", x: 1013, y: 40,
        props: { variant: "dark", scale: 0.62 } },
      { type: "text", x: 36, y: 204, w: 760,
        props: { text: "Replace this with one or two short paragraphs of supporting evidence. Keep body copy to roughly 40–60 words and leave generous white space on the right.",
          fontSize: 19, weight: "400", color: "#000000",
          family: "sans", align: "left", lineHeight: 1.6 } },
      { type: "shape", x: 0, y: 663, w: 1200, h: 12,
        props: { kind: "rect", fill: "#F6821F", stroke: "", strokeWidth: 0,
          radius: 0, opacity: 1 } },
    ],
  };
}

// Compliance-first content structures. These use exact reference-canvas
// geometry so authors start from the corporate grid instead of freehand
// cards. Every element remains an ordinary editable block.
export function makeTwoColumnSlide(): SlideTemplate {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter(b => b.type !== "text");
  for (const x of [36, 609]) {
    slide.blocks.splice(-1, 0,
      { type: "text", x, y: 204, w: 553,
        props: { text: "Column heading", fontSize: 18, weight: 600,
          color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
      { type: "text", x, y: 252, w: 553,
        props: { text: "Add concise supporting copy. Keep both columns parallel in structure and similar in length.",
          fontSize: 19, weight: 400, color: "#000000", family: "sans",
          align: "left", lineHeight: 1.6 } });
  }
  return slide;
}

export function makeFourColumnSlide(): SlideTemplate {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter(b => b.type !== "text");
  [34, 328, 622, 916].forEach((x, i) => {
    slide.blocks.splice(-1, 0,
      { type: "text", x, y: 194, w: 40,
        props: { text: String(i + 1).padStart(2, "0"), fontSize: 14,
          weight: 600, color: "#FF6633", family: "sans", align: "left", lineHeight: 1.2 } },
      { type: "text", x, y: 228, w: 260,
        props: { text: "Column heading", fontSize: 16, weight: 600,
          color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
      { type: "text", x, y: 272, w: 260,
        props: { text: "Use compact supporting copy with one clear idea per column.",
          fontSize: 15, weight: 400, color: "#747474", family: "sans",
          align: "left", lineHeight: 1.5 } });
  });
  return slide;
}

/* Dot grid background. */
export function DotGrid(opacity = 0.42) {
  return el("div", {
    style: {
      position: "absolute", inset: "0",
      opacity: String(opacity),
      backgroundImage: "radial-gradient(circle, #fff7ef 1.5px, transparent 1.5px)",
      backgroundSize: "38px 36px",
      backgroundPosition: "30px 18px",
      pointerEvents: "none",
    },
  });
}
