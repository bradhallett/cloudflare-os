/** Inspector field widgets — one builder per field schema type — plus the image-reading pipeline and small button helpers. */

import { el, loadImage, readFileAsDataURL } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { FieldSchema } from "./components.ts";
import { hexA, svg, svgFromString } from "./dom.ts";
import { renderInspector } from "./inspector.ts";
import type { PropValue } from "./protocol.ts";
import { C, MONO } from "./tokens.ts";

/* ----------- Inspector field widgets -----------
 *
 * All fields share a horizontal layout: small uppercase label on the
 * left, control on the right (multiline + color stack vertically since
 * their controls need full width). Inputs use shared CSS classes
 * defined in mountShell so hover/focus states are consistent without
 * per-element listeners. */

function fieldRow(label: string, control: HTMLElement, opts: { stacked?: boolean } = {}): HTMLDivElement {
  if (opts.stacked) {
    return el("div", { style: { padding: "4px 0" }}, [
      el("div", {
        text: label,
        style: {
          fontSize: "10px", fontWeight: "650",
          color: "#9a8273", marginBottom: "6px",
          letterSpacing: "0.04em", textTransform: "uppercase",
        },
      }),
      control,
    ]);
  }
  return el("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "78px 1fr",
      alignItems: "center",
      gap: "10px",
      minHeight: "28px",
      padding: "1px 0",
    },
  }, [
    el("label", {
      text: label,
      style: {
        fontSize: "11px", fontWeight: "500",
        color: "#9a8273", lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    control,
  ]);
}
/* The inspector's values are whatever the block's props hold; each widget
 * below is told the scalar type its field type implies. */
export function renderField(f: FieldSchema, v: PropValue | undefined, cb: (v: PropValue) => void): HTMLDivElement {
  switch (f.type) {
    case "multiline":  return multilineField(f.label, (v ?? "") as string, cb);
    case "number":     return numberField(f.label, (v ?? 0) as number, cb, f);
    case "select":     return selectField(f.label, v, cb, f.options);
    case "checkbox":   return checkField(f.label, !!v, cb);
    case "color":      return colorField(f.label, (v ?? "#000000") as string, cb);
    case "image":      return imageField(f.label, (v ?? "") as string, cb);
    case "svg":        return svgField(f.label, (v ?? "") as string, cb);
    case "text":
    default:           return textField(f.label, (v ?? "") as string, cb);
  }
}
function textField(label: string, value: string, cb: (v: string) => void): HTMLDivElement {
  const input = el("input", {
    type: "text", value,
    class: "field-input",
    onblur: (e: Event) => { if (e.target instanceof HTMLInputElement && e.target.value !== value) cb(e.target.value); },
    onkeydown: (e: Event) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    },
  });
  return fieldRow(label, input);
}
function multilineField(label: string, value: string, cb: (v: string) => void): HTMLDivElement {
  const ta = el("textarea", {
    class: "field-input field-textarea",
    onblur: (e: Event) => { if (e.target instanceof HTMLTextAreaElement && e.target.value !== value) cb(e.target.value); },
    onkeydown: (e: Event) => e.stopPropagation(),
  });
  ta.value = value;
  return fieldRow(label, ta, { stacked: true });
}
export function numberField(
  label: string,
  value: number,
  cb: (v: number) => void,
  opts: { min?: number; max?: number; step?: number } = {},
  attrs: { dataKey?: string } = {},
): HTMLDivElement {
  const input = el("input", {
    type: "number", value, step: opts.step ?? 1,
    min: opts.min, max: opts.max,
    "data-key": attrs.dataKey || "",
    class: "field-input",
    onchange: (e: Event) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const n = Number(e.target.value);
      if (!Number.isNaN(n) && n !== value) cb(n);
    },
    onkeydown: (e: Event) => e.stopPropagation(),
  });
  return fieldRow(label, input);
}
function selectField(label: string, value: PropValue | undefined, cb: (v: string) => void, options: string[]): HTMLDivElement {
  const sel = el("select", {
    class: "field-input field-select",
    onchange: (e: Event) => { if (e.target instanceof HTMLSelectElement) cb(e.target.value); },
    onkeydown: (e: Event) => e.stopPropagation(),
  });
  for (const o of options) {
    const opt = el("option", { value: o, text: o });
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return fieldRow(label, sel);
}
export function checkField(label: string, value: boolean, cb: (v: boolean) => void): HTMLDivElement {
  const cbox = el("input", {
    type: "checkbox",
    class: "field-check",
    onchange: (e: Event) => { if (e.target instanceof HTMLInputElement) cb(e.target.checked); },
  });
  cbox.checked = !!value;
  return fieldRow(label, el("div", {
    style: { display: "inline-flex", alignItems: "center" },
  }, [cbox]));
}
export function colorField(label: string, value: string, cb: (v: string) => void): HTMLDivElement {
  const wrap = el("div", {
    style: { display: "flex", gap: "6px", alignItems: "stretch" },
  });
  const swatchWrap = el("div", {
    style: {
      width: "26px", height: "26px",
      borderRadius: "6px",
      position: "relative", flex: "0 0 26px",
      background: value,
      border: "1px solid rgba(255,245,232,0.10)",
      cursor: "pointer",
    },
  });
  // The native <input type="color"> control is hard to style; we use it
  // strictly for its picker UX and lay our swatch on top via opacity: 0.
  const sw = el("input", {
    type: "color", value,
    style: {
      position: "absolute", inset: "0",
      width: "100%", height: "100%",
      padding: "0", border: "none", background: "transparent",
      cursor: "pointer", opacity: "0",
    },
    onchange: (e: Event) => { if (!(e.target instanceof HTMLInputElement)) return; swatchWrap.style.background = e.target.value; cb(e.target.value); },
    oninput:  (e: Event) => { if (e.target instanceof HTMLInputElement) swatchWrap.style.background = e.target.value; },
  });
  swatchWrap.appendChild(sw);
  const tx = el("input", {
    type: "text", value,
    class: "field-input",
    style: { flex: "1", fontVariantNumeric: "tabular-nums" },
    onblur: (e: Event) => { if (e.target instanceof HTMLInputElement && e.target.value !== value) cb(e.target.value); },
    onkeydown: (e: Event) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    },
  });
  wrap.appendChild(swatchWrap); wrap.appendChild(tx);
  return fieldRow(label, wrap);
}
/* ---- Image field ------------------------------------------------------
 *
 * Custom widget for the `image` component's `src` prop. Stacks:
 *
 *   [   thumbnail preview / placeholder   ]
 *   [ Upload ]  [ Clear ]
 *   [ url text input ......................]
 *
 * Uploaded files are read as data URLs and, if they're raster images
 * larger than `MAX_IMAGE_DIM`, automatically downscaled via canvas so we
 * don't bloat the deck JSON document. SVG files are passed through as-is.
 * External URLs are accepted via the text input — the browser will load
 * them through the normal <img> path (which is allowed in the sandbox).
 */
const MAX_IMAGE_DIM       = 1600;
const IMAGE_DOWNSCALE_MIN = 400_000;  // bytes — below this we keep the original

/* Convert a File to a data URL, downscaling raster images larger than
 * MAX_IMAGE_DIM on the longest side. SVG goes through verbatim.
 *
 * `readFileAsDataURL` and `loadImage` are the ui library's; the encoding rule
 * is the deck's own, because a slide keeps a PNG a PNG (a chart's transparency
 * matters more here than the last few kilobytes) and falls back to the file as
 * uploaded whenever the canvas cannot re-encode it. */
async function fileToImageDataURL(file: File): Promise<string> {
  if (file.type === "image/svg+xml") return await readFileAsDataURL(file);
  const original = await readFileAsDataURL(file);
  let img: HTMLImageElement;
  try { img = await loadImage(original); }
  catch { return original; }
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_IMAGE_DIM && file.size < IMAGE_DOWNSCALE_MIN) return original;
  const scale = Math.min(1, MAX_IMAGE_DIM / longest);
  const canvas = document.createElement("canvas");
  canvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // PNGs preserve transparency; everything else goes to JPEG at 0.85.
  const isPng = file.type === "image/png";
  try {
    return canvas.toDataURL(isPng ? "image/png" : "image/jpeg",
      isPng ? undefined : 0.85);
  } catch { return original; }
}

function imageField(label: string, value: string, cb: (v: string) => void): HTMLDivElement {
  // Wrap cb so that any change also refreshes the inspector. The image
  // field has visible state in its own UI (preview + size label +
  // upload/clear visibility) so a slide-only re-render isn't enough.
  const apply = async (v: string) => {
    await cb(v);
    renderInspector();
  };
  const wrap = el("div", {
    style: { display: "flex", flexDirection: "column", gap: "6px" },
  });

  // --- Preview tile -----------------------------------------------------
  const preview = el("div", {
    style: {
      width: "100%", aspectRatio: "16 / 9",
      borderRadius: "7px",
      background: hexA(C.muted, 0.06),
      border: `1px solid rgba(255,245,232,0.08)`,
      backgroundImage:
        "linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.025) 75%)," +
        "linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.025) 75%)",
      backgroundSize: "16px 16px",
      backgroundPosition: "0 0, 8px 8px",
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden",
    },
  });
  if (value) {
    preview.appendChild(el("img", {
      src: value, alt: "", draggable: "false",
      style: { width: "100%", height: "100%",
               objectFit: "contain", display: "block" },
    }));
  } else {
    preview.appendChild(el("div", {
      text: "No image",
      style: { color: "#7b6254", fontSize: "10.5px", fontWeight: "700",
               letterSpacing: "0.08em", textTransform: "uppercase" },
    }));
  }

  // --- Buttons ---------------------------------------------------------
  const btnRow = el("div", { style: {
    display: "grid", gridTemplateColumns: value ? "1fr 1fr" : "1fr",
    gap: "4px",
  }});
  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    style: { display: "none" },
    onchange: async (e: Event) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const url = await fileToImageDataURL(f);
        await apply(url);
      } catch (err) {
        statusEl.textContent = "Couldn't read that file.";
        statusEl.style.color = "#ffb18d";
      }
      e.target.value = "";  // allow re-uploading the same file
    },
  });
  const upload = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    value ? "Replace image" : "Upload image",
    () => fileInput.click());
  // The compactIconBtn renders as icon-only; force a label inside it so the
  // image field reads better at the inspector's narrow width.
  upload.innerHTML = "";
  upload.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`));
  upload.appendChild(el("span", {
    text: value ? "Replace" : "Upload",
    style: { marginLeft: "8px", fontSize: "11.5px", fontWeight: "600",
             letterSpacing: "0.02em" },
  }));
  btnRow.appendChild(upload);
  btnRow.appendChild(fileInput);
  if (value) {
    const clear = compactIconBtn("", "Clear image", () => apply(""), { danger: true });
    clear.innerHTML = "";
    clear.appendChild(svgFromString(
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M6 18 18 6"/></svg>`));
    clear.appendChild(el("span", {
      text: "Clear",
      style: { marginLeft: "8px", fontSize: "11.5px", fontWeight: "600" },
    }));
    btnRow.appendChild(clear);
  }

  // --- URL input -------------------------------------------------------
  const urlInput = el("input", {
    type: "text",
    placeholder: "or paste image URL / data:URI",
    value: value && value.startsWith("data:") ? "" : value,
    class: "field-input",
    onblur: (e: Event) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const v = e.target.value.trim();
      if (v !== value) apply(v);
    },
    onkeydown: (e: Event) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    },
  });

  const statusEl = el("div", {
    style: { fontSize: "10.5px", color: "#7b6254",
             lineHeight: "1.4", minHeight: "0" },
  });
  if (value && value.startsWith("data:")) {
    // Approx byte count of base64 payload, sans header.
    const i = value.indexOf(",");
    const bytes = i >= 0 ? Math.round(((value.length - i - 1) * 3) / 4) : 0;
    if (bytes > 0) {
      statusEl.textContent = `Inlined • ${formatBytes(bytes)}`;
    }
  }

  wrap.appendChild(preview);
  wrap.appendChild(btnRow);
  wrap.appendChild(urlInput);
  if (statusEl.textContent) wrap.appendChild(statusEl);
  return fieldRow(label, wrap, { stacked: true });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* ---- SVG field --------------------------------------------------------
 *
 * Big monospace textarea for pasting raw SVG markup. We don't try to
 * validate here — `svg` component's render() does the parsing and shows
 * an "Invalid SVG" placeholder on the slide if it can't parse. */
function svgField(label: string, value: string, cb: (v: string) => void): HTMLDivElement {
  const ta = el("textarea", {
    class: "field-input field-textarea",
    placeholder: '<svg width="..." height="..." viewBox="...">...</svg>',
    spellcheck: "false",
    style: {
      minHeight: "120px",
      fontFamily: MONO,
      fontSize: "11px",
      lineHeight: "1.45",
      whiteSpace: "pre",
      overflowWrap: "normal",
      overflowX: "auto",
    },
    onblur: (e: Event) => { if (e.target instanceof HTMLTextAreaElement && e.target.value !== value) cb(e.target.value); },
    onkeydown: (e: Event) => e.stopPropagation(),
  });
  ta.value = value;
  return fieldRow(label, ta, { stacked: true });
}

export function compactIconBtn(iconHtml: string, title: string, onClick: EventListener, opts: { danger?: boolean } = {}): HTMLButtonElement {
  const danger = opts.danger;
  const b = el("button", {
    title, "aria-label": title, onclick: onClick,
    "data-press": "1",
    style: {
      width: "100%", height: "30px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "rgba(255,245,232,0.04)",
      color: danger ? "#ffb8a0" : "#d8c4ad",
      border: "1px solid transparent",
      borderRadius: "7px",
      cursor: "pointer", padding: "0",
      transition:
        "background 140ms var(--ease), color 140ms var(--ease), border-color 140ms var(--ease)",
    },
  });
  b.innerHTML = iconHtml;
  b.addEventListener("mouseenter", () => {
    b.style.background = danger
      ? "rgba(255,95,46,0.16)"
      : "rgba(255,245,232,0.10)";
    b.style.borderColor = danger
      ? "rgba(255,95,46,0.32)"
      : "rgba(255,245,232,0.10)";
    b.style.color = danger ? "#ffd0bd" : "#fff5e8";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "rgba(255,245,232,0.04)";
    b.style.borderColor = "transparent";
    b.style.color = danger ? "#ffb8a0" : "#d8c4ad";
  });
  return b;
}
