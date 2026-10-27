/** The right panel: component library, slide settings, the selected-block inspector, and the patch helpers edits funnel through. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { ElChild } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { currentSlide } from "./canvas.ts";
import { addBlockOfType } from "./commands.ts";
import { COMPONENTS, COMPONENT_CATEGORIES, COMP_DESC, COMP_ICON, PALETTE_ORDER } from "./components.ts";
import type { ComponentDef, FieldSchema } from "./components.ts";
import { hexA, svg, svgFromString } from "./dom.ts";
import { checkField, colorField, compactIconBtn, numberField, renderField } from "./fields.ts";
import type { Block, BlockInput, BlockPatch, GadgetStub, PropValue, Slide } from "./protocol.ts";
import { render } from "./slideList.ts";
import { advancedOpen, librarySearch, selectedBlockId, setAdvancedOpen, setLibrarySearch, setSelectedBlockId, shellRef } from "./state.ts";
import { C, FONT } from "./tokens.ts";


// The RPC stub binding the Workshop's iframe bootstrap defines before this module
// runs. client.ts declares it too; ambient declarations are file-scoped.
declare const gadget: GadgetStub;

/* ====================== Inspector ========================================
 *
 * Right-sidebar layout (top to bottom):
 *
 *   1. Component library — a contained, filterable card. Searches by name,
 *      groups by category. Always visible since adding is the primary
 *      action; constrained to a max-height so it never dominates.
 *   2. Slide section — compact background settings for the current slide.
 *   3. Selected block inspector — header (icon + name), schema fields,
 *      icon-row actions, advanced disclosure. Or, when nothing is
 *      selected, a quiet empty hint.
 *
 * Inputs use shared `.field-*` CSS classes defined in mountShell, so
 * hover/focus states feel consistent without per-element listeners.
 * ----------------------------------------------------------------------- */

export function renderInspector() {
  const panel = shellRef.inspectorBody;
  if (!panel) return;
  panel.innerHTML = "";

  panel.appendChild(renderComponentLibrary());

  const slide = currentSlide();
  if (slide) panel.appendChild(renderSlideSection(slide));

  const block = slide && slide.blocks.find(b => b.id === selectedBlockId);
  if (block) {
    const def = COMPONENTS[block.type];
    panel.appendChild(renderSelectedBlock(slide!, block, def));
  } else {
    panel.appendChild(renderEmptyHint());
  }
}

/* ---- Section helpers --------------------------------------------------- */

export function sectionLabel(text: string, extra?: HTMLElement): HTMLDivElement {
  const row = el("div", {
    style: {
      display: "flex", alignItems: "center",
      padding: "0 4px 8px",
      fontSize: "10px", fontWeight: "750",
      letterSpacing: "0.1em", textTransform: "uppercase",
      color: "#7b6254",
    },
  });
  row.appendChild(el("span", { text }));
  if (extra) {
    extra.style.marginLeft = "auto";
    row.appendChild(extra);
  }
  return row;
}

function sectionBlock(children: ElChild[], opts: { padding?: string; border?: boolean } = {}): HTMLDivElement {
  return el("div", {
    style: {
      padding: opts.padding || "18px 16px 0",
      borderTop: opts.border ? "1px solid rgba(255,245,232,0.05)" : "none",
      marginTop: opts.border ? "18px" : "0",
    },
  }, children);
}

/* ---- Component library ------------------------------------------------- */

function renderComponentLibrary(): HTMLDivElement {
  const wrap = el("div", { style: { padding: "14px 12px 6px" }});
  const card = el("div", {
    style: {
      background: "rgba(255,245,232,0.025)",
      border: "1px solid rgba(255,245,232,0.06)",
      borderRadius: "12px",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
    },
  });

  // --- Search row (also the section's visual title) ---
  const search = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "9px 12px",
      borderBottom: "1px solid rgba(255,245,232,0.05)",
    },
  });
  search.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a7164" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/></svg>`));
  const input = el("input", {
    type: "text",
    placeholder: "Add component",
    value: librarySearch,
    style: {
      flex: "1",
      background: "transparent",
      border: "none", outline: "none",
      color: "#fff5e8",
      fontSize: "12px", fontFamily: FONT,
      padding: "0", letterSpacing: "0",
    },
    oninput: (e: Event) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      setLibrarySearch(e.target.value);
      refreshLibraryList();
    },
    onkeydown: (e: Event) => {
      e.stopPropagation();
      if (!(e instanceof KeyboardEvent && e.target instanceof HTMLInputElement)) return;
      if (e.key === "Escape") {
        if (librarySearch) {
          setLibrarySearch("");
          e.target.value = "";
          refreshLibraryList();
        } else {
          e.target.blur();
        }
      } else if (e.key === "Enter") {
        // Add first match
        const matches = filteredComponents();
        if (matches.length > 0) {
          setLibrarySearch("");
          addBlockOfType(matches[0]);
        }
      }
    },
  });
  search.appendChild(input);
  // Clear button is always present; we toggle opacity/pointer-events so we
  // never need to re-render the search row mid-typing (which would steal
  // focus from the input).
  const clear = el("button", {
    title: "Clear",
    "aria-label": "Clear search",
    "data-press": "1",
    "data-library-clear": "1",
    onclick: () => {
      setLibrarySearch("");
      input.value = "";
      input.focus();
      refreshLibraryList();
    },
    style: {
      background: "transparent", border: "none",
      padding: "2px", margin: "0",
      color: "#8a7164", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "4px",
      opacity: librarySearch ? "1" : "0",
      pointerEvents: librarySearch ? "auto" : "none",
      transition:
        "color 140ms var(--ease), background 140ms var(--ease), opacity 140ms var(--ease)",
    },
  });
  clear.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M6 18 18 6"/></svg>`;
  clear.addEventListener("mouseenter", () => {
    clear.style.color = "#fff5e8";
    clear.style.background = "rgba(255,245,232,0.08)";
  });
  clear.addEventListener("mouseleave", () => {
    clear.style.color = "#8a7164";
    clear.style.background = "transparent";
  });
  search.appendChild(clear);
  card.appendChild(search);

  // --- Scrollable list ---
  const list = el("div", {
    style: {
      maxHeight: "280px",
      overflowY: "auto",
      padding: "4px 0 6px",
    },
  });
  list.dataset.libraryList = "1";
  populateLibraryList(list);
  card.appendChild(list);

  wrap.appendChild(card);
  return wrap;
}

function filteredComponents(): string[] {
  const q = librarySearch.trim().toLowerCase();
  if (!q) return PALETTE_ORDER.slice();
  return PALETTE_ORDER.filter(t => {
    const def = COMPONENTS[t];
    const name = (def?.name || "").toLowerCase();
    const desc = (COMP_DESC[t] || "").toLowerCase();
    return name.includes(q) || desc.includes(q) || t.toLowerCase().includes(q);
  });
}

function populateLibraryList(list: HTMLElement): void {
  list.innerHTML = "";
  const matches = filteredComponents();
  if (matches.length === 0) {
    list.appendChild(el("div", {
      text: "No matches",
      style: {
        padding: "18px", textAlign: "center",
        color: "#7b6254", fontSize: "11.5px",
      },
    }));
    return;
  }

  if (librarySearch) {
    // Flat list when searching — keeps results dense.
    for (const t of matches) list.appendChild(libraryItem(t));
  } else {
    for (const cat of COMPONENT_CATEGORIES) {
      const types = cat.types.filter(t => matches.includes(t));
      if (types.length === 0) continue;
      list.appendChild(el("div", {
        text: cat.name,
        style: {
          padding: "10px 14px 4px",
          fontSize: "9.5px", fontWeight: "800",
          letterSpacing: "0.12em", textTransform: "uppercase",
          color: "#6e5747",
        },
      }));
      for (const t of types) list.appendChild(libraryItem(t));
    }
  }
}

/* Surgically replace just the list children when typing — avoids
 * re-rendering the whole inspector and stealing focus from the input. */
function refreshLibraryList(): void {
  const list = shellRef.inspectorBody?.querySelector<HTMLDivElement>('[data-library-list="1"]');
  if (!list) return;
  populateLibraryList(list);
  const clear = shellRef.inspectorBody?.querySelector<HTMLButtonElement>('[data-library-clear="1"]');
  if (clear) {
    clear.style.opacity = librarySearch ? "1" : "0";
    clear.style.pointerEvents = librarySearch ? "auto" : "none";
  }
}

function libraryItem(type: string): HTMLButtonElement {
  const def = COMPONENTS[type];
  const item = el("button", {
    "data-press": "1",
    title: `Add ${def.name}`,
    onclick: () => {
      if (librarySearch) setLibrarySearch("");
      addBlockOfType(type);
    },
    style: {
      display: "flex", alignItems: "center", gap: "10px",
      width: "100%",
      padding: "7px 12px",
      background: "transparent",
      color: "#e8d6c2",
      border: "none",
      cursor: "pointer",
      fontFamily: FONT, textAlign: "left",
      transition: "background 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  const iconWrap = el("div", {
    style: {
      width: "22px", height: "22px", flex: "0 0 22px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "5px",
      background: "rgba(255,245,232,0.05)",
      color: "#b89e87",
      transition: "background 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  iconWrap.innerHTML = COMP_ICON[type] || "";
  item.appendChild(iconWrap);
  item.appendChild(el("div", {
    style: { flex: "1", minWidth: "0",
             display: "flex", flexDirection: "column", gap: "1px" },
  }, [
    el("div", {
      text: def.name,
      style: {
        fontSize: "12px", fontWeight: "600",
        lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    el("div", {
      text: COMP_DESC[type] || "",
      style: {
        fontSize: "10.5px", color: "#7b6254",
        lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
  ]));
  const plus = el("span", {
    html: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    style: {
      color: "#8a7164",
      display: "inline-flex",
      opacity: "0",
      transform: "translateX(-2px)",
      transition: "opacity 140ms var(--ease), transform 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  item.appendChild(plus);
  item.addEventListener("mouseenter", () => {
    item.style.background = "rgba(255,245,232,0.06)";
    iconWrap.style.background = hexA(C.orange, 0.18);
    iconWrap.style.color = "#ffb18d";
    plus.style.opacity = "1";
    plus.style.transform = "translateX(0)";
    plus.style.color = "#ffb18d";
  });
  item.addEventListener("mouseleave", () => {
    item.style.background = "transparent";
    iconWrap.style.background = "rgba(255,245,232,0.05)";
    iconWrap.style.color = "#b89e87";
    plus.style.opacity = "0";
    plus.style.transform = "translateX(-2px)";
    plus.style.color = "#8a7164";
  });
  return item;
}

/* ---- Slide section ----------------------------------------------------- */

function renderSlideSection(slide: Slide): HTMLDivElement {
  const wrap = sectionBlock([
    sectionLabel("Slide"),
    el("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }}, [
      colorField("Page color", slide.background?.color || C.page, async (v) => {
        slide.background = { ...slide.background, color: v };
        await gadget.updateSlide(slide.id, { background: { color: v } });
        render();
      }),
      numberField("Dot grid", slide.background?.dotGrid ?? 0, async (v) => {
        slide.background = { ...slide.background, dotGrid: v };
        await gadget.updateSlide(slide.id, { background: { dotGrid: v } });
        render();
      }, { min: 0, max: 1, step: 0.05 }),
      checkField("Inset surface", slide.background?.inset !== false, async (v) => {
        slide.background = { ...slide.background, inset: v };
        await gadget.updateSlide(slide.id, { background: { inset: v } });
        render();
      }),
    ]),
  ], { padding: "18px 16px 6px" });
  return wrap;
}

/* ---- Selected block inspector ----------------------------------------- */

function renderSelectedBlock(slide: Slide, block: Block, def: ComponentDef | undefined): HTMLDivElement {
  const wrap = sectionBlock([], { border: true, padding: "16px 16px 18px" });

  // --- Header: icon + name + small "selected" caption ---
  const header = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "10px",
      marginBottom: "14px",
    },
  });
  const ico = el("div", {
    style: {
      width: "26px", height: "26px",
      borderRadius: "6px",
      background: hexA(C.orange, 0.16),
      color: "#ffb18d",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flex: "0 0 26px",
    },
  });
  ico.innerHTML = COMP_ICON[block.type] || COMP_ICON.shape;
  header.appendChild(ico);
  header.appendChild(el("div", {
    style: { display: "flex", flexDirection: "column", minWidth: "0" },
  }, [
    el("div", {
      text: def?.name || block.type,
      style: {
        fontSize: "12.5px", fontWeight: "650", color: "#fff5e8",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    el("div", {
      text: "Selected",
      style: {
        fontSize: "10px", fontWeight: "700",
        color: "#7b6254", marginTop: "1px",
        letterSpacing: "0.06em", textTransform: "uppercase",
      },
    }),
  ]));
  wrap.appendChild(header);

  // --- Basic schema fields ---
  const basicFields  = (def?.fields || []).filter(f => !f.advanced);
  const advancedFields = (def?.fields || []).filter(f => f.advanced);

  // Effective-prop defaults for this component. Blocks may omit props
  // entirely (e.g. seed-deck subtitles only carry `text`); the render
  // functions fall back via `props.fontSize || 19`, so the inspector
  // should mirror that and surface the same effective value rather than
  // showing 0 / "" for a missing prop. Without this, editing one of
  // those seed blocks looks like "Font size is 0".
  const propDefaults = (def?.defaultBlock ? (def.defaultBlock().props || {}) : {});

  if (basicFields.length > 0) {
    const fieldsWrap = el("div", { style: { display: "flex",
      flexDirection: "column", gap: "4px" }});
    for (const f of basicFields) {
      const v = (block.props || {})[f.key] ?? propDefaults[f.key];
      const cb = (nv: PropValue) => patchBlockProp(slide, block, f.key, nv);
      fieldsWrap.appendChild(renderField(f, v, cb));
    }
    wrap.appendChild(fieldsWrap);
  }

  // --- Compact icon-row actions ---
  wrap.appendChild(renderBlockActions(slide, block));

  // --- Advanced disclosure ---
  const hasAdvanced = !def?.fullBleed || advancedFields.length > 0;
  if (hasAdvanced) {
    wrap.appendChild(renderAdvancedDisclosure(slide, block, def, advancedFields));
  }
  return wrap;
}

function renderBlockActions(slide: Slide, block: Block): HTMLDivElement {
  const actions = el("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "4px",
      marginTop: "12px",
    },
  });
  const dup = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    "Duplicate", async () => {
      const copy: BlockInput = JSON.parse(JSON.stringify(block));
      delete copy.id;
      copy.x = (copy.x ?? 0) + 24;
      copy.y = (copy.y ?? 0) + 24;
      const newId = await gadget.addBlock(slide.id, copy);
      // null: the slide is gone -- deleted by another client, whose deck update has already
      // replaced ours -- so there is nothing to add locally.
      if (newId === null) return;
      slide.blocks.push({ ...copy, id: newId });
      setSelectedBlockId(newId);
      render(); renderInspector();
    });
  const fwd = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`,
    "Bring forward", async () => {
      const i = slide.blocks.findIndex(b => b.id === block.id);
      if (i < slide.blocks.length - 1) {
        const [b] = slide.blocks.splice(i, 1);
        slide.blocks.splice(i + 1, 0, b);
        await gadget.reorderBlock(slide.id, block.id, i + 1);
        render();
      }
    });
  const bwd = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m5 12 7 7 7-7"/></svg>`,
    "Send backward", async () => {
      const i = slide.blocks.findIndex(b => b.id === block.id);
      if (i > 0) {
        const [b] = slide.blocks.splice(i, 1);
        slide.blocks.splice(i - 1, 0, b);
        await gadget.reorderBlock(slide.id, block.id, i - 1);
        render();
      }
    });
  const del = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    "Delete", async () => {
      slide.blocks = slide.blocks.filter(b => b.id !== block.id);
      setSelectedBlockId(null);
      await gadget.removeBlock(slide.id, block.id);
      render(); renderInspector();
    }, { danger: true });

  actions.appendChild(dup);
  actions.appendChild(fwd);
  actions.appendChild(bwd);
  actions.appendChild(del);
  return actions;
}

function renderAdvancedDisclosure(slide: Slide, block: Block, def: ComponentDef | undefined, advancedFields: FieldSchema[]): HTMLDivElement {
  const wrap = el("div", { style: { marginTop: "14px" }});
  const toggle = el("button", {
    "data-press": "1",
    onclick: () => { setAdvancedOpen(!advancedOpen); renderInspector(); },
    style: {
      width: "100%",
      display: "inline-flex", alignItems: "center", gap: "6px",
      padding: "8px 0",
      background: "transparent",
      color: "#8a7164",
      border: "none",
      borderTop: "1px solid rgba(255,245,232,0.05)",
      borderRadius: "0",
      cursor: "pointer",
      fontSize: "10px", fontWeight: "750",
      letterSpacing: "0.1em", textTransform: "uppercase",
      fontFamily: FONT,
      transition: "color 160ms var(--ease)",
    },
  });
  const chev = el("span", {
    html: `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
    style: {
      display: "inline-flex",
      transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 200ms var(--ease)",
    },
  });
  toggle.appendChild(chev);
  toggle.appendChild(el("span", { text: "Advanced" }));
  toggle.addEventListener("mouseenter", () => toggle.style.color = "#c8b39c");
  toggle.addEventListener("mouseleave", () => toggle.style.color = "#8a7164");
  wrap.appendChild(toggle);

  if (!advancedOpen) return wrap;

  const body = el("div", {
    style: {
      display: "flex", flexDirection: "column", gap: "4px",
      paddingTop: "8px",
    },
  });

  if (!def?.fullBleed) {
    const grid = el("div", {
      style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" },
    });
    grid.appendChild(numberField("X", block.x ?? 0,
      v => patchBlock(slide, block, {x: v}),
      { min: -100, max: 1300 }, { dataKey: "pos-x" }));
    grid.appendChild(numberField("Y", block.y ?? 0,
      v => patchBlock(slide, block, {y: v}),
      { min: -100, max: 800 }, { dataKey: "pos-y" }));
    if (def?.resizableW || block.w != null)
      grid.appendChild(numberField("W", block.w ?? 0,
        v => patchBlock(slide, block, {w: v}),
        { min: 10, max: 1300 }, { dataKey: "pos-w" }));
    if (def?.resizableH || block.h != null)
      grid.appendChild(numberField("H", block.h ?? 0,
        v => patchBlock(slide, block, {h: v}),
        { min: 10, max: 800 }, { dataKey: "pos-h" }));
    body.appendChild(grid);
  }

  const propDefaults = (def?.defaultBlock ? (def.defaultBlock().props || {}) : {});
  for (const f of advancedFields) {
    const v = (block.props || {})[f.key] ?? propDefaults[f.key];
    const cb = (nv: PropValue) => patchBlockProp(slide, block, f.key, nv);
    body.appendChild(renderField(f, v, cb));
  }

  wrap.appendChild(body);
  return wrap;
}

function renderEmptyHint(): HTMLDivElement {
  const wrap = sectionBlock([], { border: true, padding: "28px 20px 36px" });
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";
  wrap.style.gap = "10px";
  wrap.style.textAlign = "center";
  const ico = el("div", {
    style: {
      width: "30px", height: "30px",
      borderRadius: "7px",
      background: "rgba(255,245,232,0.04)",
      color: "#7b6254",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    },
    html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  });
  wrap.appendChild(ico);
  wrap.appendChild(el("div", {
    text: "Nothing selected",
    style: { fontSize: "12px", fontWeight: "600", color: "#c8b39c" },
  }));
  wrap.appendChild(el("div", {
    text: "Click any block on the slide to inspect its properties.",
    style: {
      fontSize: "11px", color: "#7b6254",
      lineHeight: "1.5", maxWidth: "200px",
    },
  }));
  return wrap;
}

async function patchBlock(slide: Slide, block: Block, patch: BlockPatch): Promise<void> {
  Object.assign(block, patch);
  await gadget.updateBlock(slide.id, block.id, patch);
  render();
}
async function patchBlockProp(slide: Slide, block: Block, key: string, value: PropValue): Promise<void> {
  block.props = { ...(block.props || {}), [key]: value };
  await gadget.updateBlock(slide.id, block.id, { props: { [key]: value } });
  render();
}

/* Update inspector x/y/w/h while dragging without a full re-render. */
export function updateInspectorPositionFields(block: Block): void {
  if (!shellRef.inspectorBody) return;
  for (const [k, dk] of [["x", "pos-x"], ["y", "pos-y"],
                          ["w", "pos-w"], ["h", "pos-h"]] as const) {
    const input = shellRef.inspectorBody.querySelector<HTMLInputElement>(`input[data-key="${dk}"]`);
    if (input) input.value = String(block[k] ?? 0);
  }
}
