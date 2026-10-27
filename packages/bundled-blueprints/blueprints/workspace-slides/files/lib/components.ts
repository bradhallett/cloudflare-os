/** The COMPONENTS registry: one entry per block type, each with its defaults, inspector field schema, and renderer, plus the library-facing palette order, categories, descriptions, and icons. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { escapeHtml, escapeRegex, hexA, svg, svgFromString } from "./dom.ts";
import type { Block, BlockProps } from "./protocol.ts";
import { render } from "./slideList.ts";
import { C, FONT, TONES, WORDMARK, toneColor, toneFill } from "./tokens.ts";

/* ====================== Component primitives ============================= */

/* Each component is responsible for rendering its content into a wrapper
 * the shell creates. The wrapper handles position, selection, and dragging,
 * so render() should produce content with width/height 100% of its wrapper.
 *
 * `ctx` has helpers:
 *   - inlineText(elem, propKey)  — bind contentEditable in edit mode
 *
 * Schema fields drive the inspector panel:
 *   { key, label, type: "text"|"multiline"|"number"|"select"|"checkbox", ... }
 */

/* One inspector field. The union is discriminated on `type`, so a "select"
 * always carries its options and a "number" its range. */
export type FieldSchema =
  | { key: string; label: string; type: "text" | "multiline" | "checkbox" | "color" | "image" | "svg"; advanced?: boolean }
  | { key: string; label: string; type: "number"; min?: number; max?: number; step?: number; advanced?: boolean }
  | { key: string; label: string; type: "select"; options: string[]; advanced?: boolean };

/* What the shell hands a component's render(): the block, and the binder
 * for inline-editable text. */
export interface RenderCtx {
  block: Block;
  inlineText(elem: HTMLElement, propKey: string, transform?: (raw: string) => string): HTMLElement;
}

/* A freshly added block before the server mints its id: everything but
 * `id` and `type`. */
export type BlockDefaults = Omit<Block, "id" | "type">;

export interface ComponentDef {
  name: string;
  defaultBlock?: () => BlockDefaults;
  fields?: FieldSchema[];
  resizableW?: boolean;
  resizableH?: boolean;
  fullBleed?: boolean;
  render(props: BlockProps, ctx: RenderCtx): HTMLElement | SVGElement;
}

export const COMPONENTS: Record<string, ComponentDef> = {
  sectionLabel: {
    name: "Section label",
    defaultBlock: () => ({
      x: 48, y: 38,
      props: { text: "NEW SECTION" },
    }),
    fields: [
      { key: "text", label: "Text", type: "text" },
    ],
    render(props, ctx) {
      // Eyebrow: always accent orange, uppercase, SemiBold, +5% tracking.
      return ctx.inlineText(el("div", {
        style: {
          color: "#FF6633",
          fontSize: "10px", fontWeight: "600", lineHeight: "1",
          letterSpacing: "0.05em", textTransform: "uppercase",
          whiteSpace: "nowrap",
        },
      }), "text");
    },
  },

  logo: {
    name: "Logo",
    defaultBlock: () => ({
      x: 36, y: 56, props: { variant: "light", scale: 1, text: "Workspace",
        accentDot: true },
    }),
    fields: [
      { key: "text", label: "Wordmark", type: "text" },
      { key: "variant", label: "Variant", type: "select",
        options: ["light", "dark"] },
      { key: "scale", label: "Scale", type: "number",
        min: 0.4, max: 2, step: 0.05 },
      { key: "accentDot", label: "Accent dot", type: "checkbox" },
    ],
    render(props) {
      // Clean editable wordmark. Used on both cover (light) and content
      // (dark) slides. Optionally ends with a small accent dot — a quiet,
      // intentional brand flourish rather than an arbitrary icon.
      const scale = props.scale || 1;
      const dark = props.variant === "dark";
      const textColor  = dark ? "#000000" : "#FFFFFF";
      const wrap = el("div", {
        style: {
          display: "flex", flexDirection: "row", alignItems: "baseline",
          gap: (3 * scale) + "px", whiteSpace: "nowrap",
        },
      });
      wrap.appendChild(el("div", {
        text: props.text != null ? props.text : "Workspace",
        style: {
          color: textColor,
          fontFamily: FONT,
          fontSize: (24 * scale) + "px",
          fontWeight: "700",
          lineHeight: "1",
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
        },
      }));
      if (props.accentDot !== false) {
        wrap.appendChild(el("div", {
          style: {
            width: (6 * scale) + "px", height: (6 * scale) + "px",
            borderRadius: "50%", background: "#F6821F",
            flex: `0 0 ${6 * scale}px`,
            transform: `translateY(${-1 * scale}px)`,
          },
        }));
      }
      return wrap;
    },
  },

  gadgetsMark: {
    name: "Gadgets mark",
    defaultBlock: () => ({
      x: 48, y: 280, props: { size: "large" },
    }),
    fields: [
      { key: "size", label: "Size", type: "select",
        options: ["large", "small"] },
    ],
    render(props) {
      const conf = props.size === "small"
        ? { svg: 48, gap: 18, fs: 40 }
        : { svg: 59, gap: 26, fs: 49 };
      const wrap = el("div", {
        style: {
          display: "flex", alignItems: "center", gap: conf.gap + "px",
        },
      });
      wrap.appendChild(svgFromString(`
        <svg width="${conf.svg}" height="${conf.svg}" viewBox="0 0 86 86" xmlns="http://www.w3.org/2000/svg">
          <polygon points="43 6 77 25 77 61 43 80 9 61 9 25"
            fill="none" stroke="#ff4801" stroke-width="10" stroke-linejoin="round"/>
        </svg>`));
      wrap.appendChild(el("div", {
        text: "gadgets",
        style: {
          fontFamily: WORDMARK,
          fontSize: conf.fs + "px",
          fontWeight: "500",
          letterSpacing: "-0.055em",
          color: "#140400",
          lineHeight: "1",
        },
      }));
      return wrap;
    },
  },

  title: {
    name: "Title",
    defaultBlock: () => ({
      x: 33, y: 197, w: 687,
      props: { text: "[TITLE]", fontSize: 58, weight: 700,
               color: "#FFFFFF", letterSpacing: "-0.03em",
               highlight: "", lineHeight: 1.1 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 14, max: 120, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "highlight", label: "Highlight (comma list)", type: "text", advanced: true },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "letterSpacing", label: "Letter spacing", type: "text", advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.8, max: 2, step: 0.02, advanced: true },
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          fontSize: (props.fontSize || 42) + "px",
          fontWeight: String(props.weight || 900),
          letterSpacing: props.letterSpacing || "-0.04em",
          lineHeight: String(props.lineHeight || 1.08),
          color: props.color || C.text,
          whiteSpace: "pre-wrap",
        },
      });
      ctx.inlineText(e, "text", (txt) => {
        let html = escapeHtml(txt);
        const words = (props.highlight || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        for (const w of words) {
          const re = new RegExp(escapeRegex(w), "g");
          html = html.replace(re, `<span style="color:${C.orange}">${escapeHtml(w)}</span>`);
        }
        return html.replace(/\n/g, "<br/>");
      });
      return e;
    },
  },

  subtitle: {
    name: "Subtitle",
    defaultBlock: () => ({
      x: 36, y: 533, w: 553,
      props: { text: "[SUBTITLE]", fontSize: 17,
               color: "#FFFFFF", lineHeight: 1.5, weight: 600 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 10, max: 48, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.9, max: 2, step: 0.05, advanced: true },
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          color: props.color || C.muted,
          fontSize: (props.fontSize || 19) + "px",
          lineHeight: String(props.lineHeight || 1.5),
          fontWeight: String(props.weight || 500),
          whiteSpace: "pre-wrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  text: {
    name: "Text block",
    defaultBlock: () => ({
      x: 100, y: 200, w: 400,
      props: { text: "Text", fontSize: 19, color: "#000000", weight: 400,
               family: "sans", align: "left", lineHeight: 1.6 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 8, max: 96, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "align", label: "Align", type: "select",
        options: ["left", "center", "right"] },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.9, max: 2, step: 0.05, advanced: true },
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          fontFamily: FONT,
          fontSize: (props.fontSize || 19) + "px",
          fontWeight: String(props.weight || 400),
          color: props.color || "#000000",
          textAlign: props.align || "left",
          lineHeight: String(props.lineHeight || 1.6),
          whiteSpace: "pre-wrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  bulletList: {
    name: "Bullet list",
    defaultBlock: () => ({
      x: 36, y: 204, w: 850,
      props: {
        text: "First complete sentence.\nSecond complete sentence.\nThird complete sentence.",
        treatment: "primary",
      },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "One item per line", type: "multiline" },
      { key: "treatment", label: "Treatment", type: "select",
        options: ["primary", "compact"] },
    ],
    render(props) {
      const compact = props.treatment === "compact";
      const size = compact ? 17 : 19;
      const itemGap = compact ? 8 : 10;
      const list = el("div", {
        style: {
          width: "100%",
          display: "flex", flexDirection: "column",
          gap: itemGap + "px",
          fontFamily: FONT,
        },
      });
      const items = String(props.text || "")
        .split("\n").map(s => s.trim()).filter(Boolean).slice(0, 6);
      for (const item of items) {
        const row = el("div", {
          style: {
            display: "flex", alignItems: "flex-start", gap: "12px",
            width: "100%",
          },
        });
        row.appendChild(el("span", {
          style: {
            width: "6px", height: "6px", flex: "0 0 6px",
            marginTop: compact ? "7px" : "8px",
            borderRadius: "50%", background: "#F6821F",
          },
        }));
        row.appendChild(el("div", {
          text: item,
          style: {
            flex: "1", minWidth: "0",
            fontSize: size + "px", fontWeight: "400",
            lineHeight: compact ? "1.45" : "1.5",
            color: "#000000", textAlign: "left",
          },
        }));
        list.appendChild(row);
      }
      return list;
    },
  },

  card: {
    name: "Card",
    defaultBlock: () => ({
      x: 100, y: 240, w: 280, h: 260,
      props: { tone: "neutral", topStripe: false,
               eyebrow: "EYEBROW", title: "Card title",
               body: "Body copy goes here." },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "topStripe", label: "Top stripe", type: "checkbox" },
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" },
    ],
    render(props, ctx) {
      const tone = props.tone || "neutral";
      const color = toneColor[tone], fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          position: "relative",
          width: "100%", height: "100%",
          boxSizing: "border-box",
          padding: "20px",
          borderRadius: "2px",
          background: fill,
          border: "1px solid #E5E5E5",
          boxShadow: "none",
          display: "flex", flexDirection: "column", gap: "12px",
          overflow: "hidden",
        },
      });
      if (props.eyebrow) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            color: "#FF6633", fontSize: "10px", fontWeight: "600",
            letterSpacing: "0.05em", textTransform: "uppercase",
            lineHeight: "1.2",
          },
        }), "eyebrow"));
      }
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "18px", fontWeight: "600",
          letterSpacing: "-0.02em", lineHeight: "1.3",
          color: "#000000",
        },
      }), "title"));
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "15px", lineHeight: "1.5",
          color: "#747474", fontWeight: "400",
          whiteSpace: "pre-wrap",
        },
      }), "body"));
      return wrap;
    },
  },

  box: {
    name: "Diagram box",
    defaultBlock: () => ({
      x: 200, y: 320, w: 220, h: 110,
      props: { tone: "neutral", title: "Box", body: "", dashed: false },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "dashed", label: "Dashed border", type: "checkbox" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" },
    ],
    render(props, ctx) {
      const tone = props.tone || "neutral";
      const color = toneColor[tone], fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          boxSizing: "border-box",
          padding: "14px",
          borderRadius: "2px",
          background: fill,
          border: `${props.dashed ? "1px dashed" : "1px solid"} #E5E5E5`,
          display: "flex", flexDirection: "column",
          justifyContent: "center",
        },
      });
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "16px", fontWeight: "600",
          letterSpacing: "-0.02em", color: "#000000",
          lineHeight: "1.3",
        },
      }), "title"));
      if (props.body) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            marginTop: "6px",
            fontSize: "14px", color: "#747474",
            fontWeight: "400", lineHeight: "1.45",
          },
        }), "body"));
      }
      return wrap;
    },
  },

  tonePill: {
    name: "Tone pill",
    defaultBlock: () => ({
      x: 100, y: 200, props: { tone: "tangerine", text: "LABEL" },
    }),
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "text", label: "Text", type: "text" },
    ],
    render(props, ctx) {
      const tone = props.tone || "tangerine";
      const e = el("div", {
        style: {
          display: "inline-block",
          padding: "5px 12px",
          borderRadius: "999px",
          background: hexA(toneColor[tone], 0.12),
          color: toneColor[tone],
          fontSize: "11px",
          fontWeight: "850",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  divider: {
    name: "Divider",
    defaultBlock: () => ({
      x: 100, y: 360, w: 400, h: 2,
      props: { color: C.border, opacity: 1 },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "color", label: "Color", type: "color" },
      { key: "opacity", label: "Opacity", type: "number",
        min: 0, max: 1, step: 0.05 },
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.color || C.border,
          opacity: String(props.opacity ?? 1),
          borderRadius: "1px",
        },
      });
    },
  },

  shape: {
    name: "Shape",
    defaultBlock: () => ({
      x: 200, y: 200, w: 200, h: 200,
      props: { kind: "rect", fill: "#FFFFFF", stroke: "#E5E5E5",
               strokeWidth: 1, radius: 2, opacity: 1 },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "kind", label: "Kind", type: "select",
        options: ["rect", "ellipse"] },
      { key: "fill", label: "Fill", type: "color" },
      { key: "stroke", label: "Stroke", type: "color" },
      { key: "opacity", label: "Opacity", type: "number",
        min: 0, max: 1, step: 0.05 },
      { key: "strokeWidth", label: "Stroke width", type: "number",
        min: 0, max: 12, step: 1, advanced: true },
      { key: "radius", label: "Corner radius", type: "number",
        min: 0, max: 200, step: 1, advanced: true },
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.fill || "transparent",
          border: `${props.strokeWidth || 0}px solid ${props.stroke || "transparent"}`,
          borderRadius: (props.kind === "ellipse" ? "999px" : (props.radius || 0) + "px"),
          opacity: String(props.opacity ?? 1),
          boxSizing: "border-box",
        },
      });
    },
  },

  image: {
    name: "Image",
    defaultBlock: () => ({
      x: 600, y: 0, w: 600, h: 675,
      props: { src: "", fit: "cover", radius: 0, alt: "" },
    }),
    resizableW: true, resizableH: true,
    fields: [
      // Custom field type — implemented in renderField(). Renders a
      // preview + upload button + URL input + clear, and writes the
      // resulting data: URL (or external URL) into `src`.
      { key: "src", label: "Source", type: "image" },
      { key: "fit", label: "Fit", type: "select",
        options: ["contain", "cover", "fill"] },
      { key: "radius", label: "Radius", type: "number",
        min: 0, max: 200, step: 1, advanced: true },
      { key: "alt", label: "Alt text", type: "text", advanced: true },
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          overflow: "hidden",
          borderRadius: (props.radius || 0) + "px",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: props.src ? "transparent" : hexA(C.muted, 0.06),
          border: props.src ? "none" : `1px dashed ${hexA(C.muted, 0.35)}`,
          boxSizing: "border-box",
        },
      });
      if (props.src) {
        wrap.appendChild(el("img", {
          src: props.src,
          alt: props.alt || "",
          draggable: "false",
          style: {
            width: "100%", height: "100%",
            objectFit: props.fit || "contain",
            display: "block",
            pointerEvents: "none",
            userSelect: "none",
          },
        }));
      } else {
        wrap.appendChild(el("div", {
          text: "No image",
          style: {
            color: C.subtle, fontSize: "11px", fontWeight: "700",
            letterSpacing: "0.08em", textTransform: "uppercase",
          },
        }));
      }
      return wrap;
    },
  },

  svg: {
    name: "SVG",
    defaultBlock: () => ({
      x: 100, y: 180, w: 600, h: 337.5,
      props: { markup: "", fit: "contain", background: "" },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "markup", label: "SVG markup", type: "svg" },
      { key: "fit", label: "Fit", type: "select",
        options: ["contain", "stretch"] },
      { key: "background", label: "Background", type: "color", advanced: true },
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.background || "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden",
          boxSizing: "border-box",
          borderRadius: "2px",
        },
      });
      const raw = (props.markup || "").trim();
      // Brand-bar SVGs sit exactly on the bottom edge of the canvas. Give
      // them an equivalent CSS background as a rendering fallback so the
      // strip remains visible at every stage scale and outside edit mode
      // (where there is no selection/interaction layer to repaint it).
      const isBrandBar = /viewBox=["']0 0 1200 12["']/.test(raw) &&
        raw.includes("#FF6633") && raw.includes("#F6821F") &&
        raw.includes("#FBAD41");
      if (isBrandBar) {
        wrap.style.background =
          "linear-gradient(90deg, #FF6633 0%, #F6821F 50%, #FBAD41 100%)";
      }
      if (!raw) {
        wrap.style.border = `1px dashed ${hexA(C.muted, 0.35)}`;
        wrap.style.background = hexA(C.muted, 0.06);
        wrap.appendChild(el("div", {
          text: "Paste SVG markup",
          style: {
            color: C.subtle, fontSize: "11px", fontWeight: "700",
            letterSpacing: "0.08em", textTransform: "uppercase",
          },
        }));
        return wrap;
      }
      // Parse & sanitize: drop <script> tags, strip on* attributes, then
      // size the root <svg> to fill the block. The Gadget is a single-user
      // app, but it's cheap to keep pasted markup from running JS.
      let node: SVGSVGElement | null = null;
      try {
        const tmp = document.createElement("div");
        tmp.innerHTML = raw;
        node = tmp.querySelector("svg");
      } catch (e) {}
      if (!node) {
        wrap.appendChild(el("div", {
          text: "Invalid SVG",
          style: { color: C.orange, fontSize: "12px", fontWeight: "700" },
        }));
        return wrap;
      }
      node.querySelectorAll("script").forEach(s => s.remove());
      const walk = (n: Element) => {
        for (const a of Array.from(n.attributes || [])) {
          if (a.name.toLowerCase().startsWith("on")) n.removeAttribute(a.name);
        }
        for (const c of n.children) walk(c);
      };
      walk(node);
      // Make the SVG fill its box. Preserve aspect ratio by default; the
      // `fit` prop picks between preserveAspectRatio modes.
      node.setAttribute("width", "100%");
      node.setAttribute("height", "100%");
      node.setAttribute(
        "preserveAspectRatio",
        props.fit === "stretch" ? "none" : "xMidYMid meet"
      );
      node.style.display = "block";
      node.style.pointerEvents = "none";
      wrap.appendChild(node);
      return wrap;
    },
  },

  arrow: {
    name: "Arrow",
    // Arrows live in a full-bleed SVG; x/y are ignored but the endpoints
    // are in props.
    fullBleed: true,
    defaultBlock: () => ({
      x: 0, y: 0,
      props: { x1: 200, y1: 400, x2: 600, y2: 400,
               color: "muted", label: "", dashed: false, width: 2 },
    }),
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "color", label: "Color", type: "select",
        options: ["muted", "tangerine", "ruby"] },
      { key: "dashed", label: "Dashed", type: "checkbox" },
      { key: "width", label: "Width", type: "number",
        min: 1, max: 8, step: 0.5, advanced: true },
      { key: "x1", label: "From X", type: "number",
        min: 0, max: 1200, advanced: true },
      { key: "y1", label: "From Y", type: "number",
        min: 0, max: 675, advanced: true },
      { key: "x2", label: "To X",   type: "number",
        min: 0, max: 1200, advanced: true },
      { key: "y2", label: "To Y",   type: "number",
        min: 0, max: 675, advanced: true },
    ],
    render(props) {
      const color = ({
        muted: "#747474", tangerine: "#F6821F", ruby: "#FF6633",
      } as Record<string, string>)[props.color || "muted"];
      const svgEl = svg("svg", {
        width: 1200, height: 675, viewBox: "0 0 1200 675",
        style: "position:absolute;left:0;top:0;pointer-events:none;width:1200px;height:675px;",
      });
      const defs = svg("defs");
      const marker = svg("marker", {
        id: "ah-" + Math.random().toString(36).slice(2, 8),
        markerWidth: "10", markerHeight: "10",
        refX: "8", refY: "3", orient: "auto", markerUnits: "strokeWidth",
      }, [svg("path", { d: "M0,0 L0,6 L9,3 z", fill: color })]);
      defs.appendChild(marker);
      svgEl.appendChild(defs);
      const line = svg("line", {
        x1: props.x1, y1: props.y1, x2: props.x2, y2: props.y2,
        stroke: color,
        "stroke-width": String(props.width || 2),
        opacity: "0.85",
        "marker-end": `url(#${marker.getAttribute("id")})`,
        "stroke-linecap": "round",
      });
      if (props.dashed) line.setAttribute("stroke-dasharray", "6 6");
      svgEl.appendChild(line);
      if (props.label) {
        const mx = (props.x1! + props.x2!) / 2;
        const my = (props.y1! + props.y2!) / 2 - 8;
        const t = svg("text", {
          x: mx, y: my, "text-anchor": "middle",
          fill: color, "font-size": "12", "font-weight": "800",
          "font-family": FONT, "letter-spacing": "0.02em",
        });
        t.textContent = props.label;
        svgEl.appendChild(t);
      }
      return svgEl;
    },
  },
};

/* Component types shown in the library (in order). The brand marks
 * (gadgetsMark, logo) are kept in COMPONENTS so the seed deck still
 * renders, but they're intentionally not exposed as reusable building
 * blocks. */
export const PALETTE_ORDER = [
  "title", "subtitle", "text", "bulletList", "sectionLabel",
  "card", "box",
  "image", "svg",
  "divider", "shape", "arrow",
];

/* Library grouping & descriptions — drive the right-sidebar component
 * library. Adding a new component requires (a) an entry in COMPONENTS,
 * (b) a slot in PALETTE_ORDER, (c) a category here, (d) a description
 * and an icon. */
export const COMPONENT_CATEGORIES = [
  { name: "Text",       types: ["title", "subtitle", "text", "bulletList", "sectionLabel"] },
  { name: "Containers", types: ["card", "box"] },
  { name: "Media",      types: ["image", "svg"] },
  { name: "Decoration", types: ["tonePill", "divider", "shape"] },
  { name: "Diagram",    types: ["arrow"] },
];

export const COMP_DESC: Record<string, string> = {
  title:        "Display headline",
  subtitle:     "Supporting copy",
  text:         "Free-form text",
  bulletList:   "Corporate bullet list",
  sectionLabel: "Section eyebrow",
  card:         "Tonal card",
  box:          "Diagram block",
  image:        "Uploaded picture",
  svg:          "Pasted SVG markup",
  tonePill:     "Inline pill",
  divider:      "Horizontal rule",
  shape:        "Rect or ellipse",
  arrow:        "Connector",
};

/* Tiny monochrome icons used in the library + selected-block header.
 * 14×14, currentColor-stroked so they pick up hover state. */
export const COMP_ICON: Record<string, string> = {
  title:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M8 4v9"/></svg>`,
  subtitle:     `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6.5h8M8 6.5v5.5"/></svg>`,
  text:         `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>`,
  bulletList:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="4.5" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="11.5" r=".8" fill="currentColor" stroke="none"/><path d="M6 4.5h7M6 8h7M6 11.5h7"/></svg>`,
  sectionLabel: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none"/><path d="M6.5 8h7"/></svg>`,
  card:         `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/><path d="M2.5 6h11"/></svg>`,
  box:          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>`,
  tonePill:     `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="5.5" width="13" height="5" rx="2.5"/></svg>`,
  divider:      `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8h12"/></svg>`,
  shape:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5"/></svg>`,
  arrow:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h10"/><path d="M9 4.5 12.5 8 9 11.5"/></svg>`,
  image:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="m2.5 12 3.5-3 3 2.5 2-1.5 2.5 2"/></svg>`,
  svg:          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5 2.5 8 6 11.5"/><path d="M10 4.5 13.5 8 10 11.5"/></svg>`,
};
