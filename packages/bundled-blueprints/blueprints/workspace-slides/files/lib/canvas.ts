/** The slide stage: rendering slides and blocks, inline text editing, drag/resize with snap guides, and selection. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { COMPONENTS } from "./components.ts";
import type { ComponentDef, RenderCtx } from "./components.ts";
import { hexA, svg } from "./dom.ts";
import { renderInspector, updateInspectorPositionFields } from "./inspector.ts";
import type { Block, BlockPatch, GadgetStub, Slide } from "./protocol.ts";
import { render } from "./slideList.ts";
import { currentIndex, deck, editMode, selectedBlockId, setSelectedBlockId, slideSearch, stageRef, stageScale } from "./state.ts";
import { COVER_ORANGE_URL, DotGrid } from "./templates.ts";
import { C, FONT } from "./tokens.ts";


// The RPC stub binding the Workshop's iframe bootstrap defines before this module
// runs. client.ts declares it too; ambient declarations are file-scoped.
declare const gadget: GadgetStub;

/* ====================== Slide rendering ================================== */

export function currentSlide(): Slide | null {
  return deck.slides[currentIndex] || null;
}

/* ----- Slide text extraction (for filter + row labels) -----------------
 *
 * We walk every block's props and grab any string values. Used by the
 * left-sidebar slide search (so typing matches any text in any block),
 * and by `slideLabel()` to surface the most representative line under
 * each thumbnail row. */
function slideText(slide: Slide): string {
  const parts: string[] = [];
  for (const b of (slide.blocks || [])) {
    const p = b.props || {};
    for (const k in p) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) parts.push(v);
    }
  }
  return parts.join(" ").toLowerCase();
}

/* Best-effort one-line label for a slide row. Priority: first non-empty
 * title → subtitle → text → sectionLabel → "Untitled". */
export function slideLabel(slide: Slide): string {
  const priority = ["title", "subtitle", "text", "sectionLabel"];
  for (const type of priority) {
    for (const b of (slide.blocks || [])) {
      if (b.type !== type) continue;
      const t = (b.props?.text || "").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
  }
  // Fall back to any text we can find.
  for (const b of (slide.blocks || [])) {
    const t = (b.props?.text || b.props?.title || "").trim();
    if (t) return t.replace(/\s+/g, " ");
  }
  return "Untitled";
}

export function filteredSlideIndices(): number[] {
  const q = slideSearch.trim().toLowerCase();
  if (!q) return deck.slides.map((_, i) => i);
  return deck.slides
    .map((s, i) => (slideText(s).includes(q) ? i : -1))
    .filter(i => i >= 0);
}

export function renderSlide(slide: Slide): HTMLDivElement {
  const frame = el("div", {
    class: "slide-frame",
    style: {
      position: "relative", overflow: "hidden",
      width: "1200px", height: "675px",
      background: (slide.background && slide.background.color) || C.page,
      fontFamily: FONT, color: C.text,
    },
  });
  if (slide.background && slide.background.coverOrange) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute", inset: "0",
        backgroundImage: `url("${COVER_ORANGE_URL}")`,
        backgroundSize: "cover", backgroundPosition: "center",
        pointerEvents: "none",
      },
    }));
  }
  if (!slide.background || slide.background.inset !== false) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute", inset: "16px",
        borderRadius: "16px",
        background: C.surface,
        border: `1px solid ${C.borderLight}`,
        pointerEvents: "none",
      },
    }));
  }
  if (slide.background && slide.background.dotGrid) {
    frame.appendChild(DotGrid(slide.background.dotGrid));
  }
  for (const block of slide.blocks) {
    const wrap = renderBlock(slide, block);
    if (wrap) frame.appendChild(wrap);
  }
  // Click on bare slide area deselects.
  if (editMode) {
    frame.addEventListener("pointerdown", (e) => {
      if (e.target === frame ||
          (e.target instanceof Element && e.target.classList.contains("slide-bg-hit"))) {
        selectBlock(null);
      }
    });
    // The inset surface acts as background; mark it as hit target.
    const insetChild = frame.children[0];
    if (insetChild) insetChild.classList.add("slide-bg-hit");
  }
  return frame;
}

function renderBlock(slide: Slide, block: Block): HTMLElement | SVGElement {
  const def = COMPONENTS[block.type];
  if (!def) {
    return el("div", {
      style: {
        position: "absolute", left: (block.x || 0) + "px",
        top: (block.y || 0) + "px",
        padding: "6px 10px", color: "#fff", background: "#b00",
        borderRadius: "4px", fontSize: "12px",
      },
      text: `?: ${block.type}`,
    });
  }

  const ctx: RenderCtx = {
    block,
    inlineText: (elem, propKey, transform) =>
      bindInlineText(elem, slide, block, propKey, transform),
  };

  // Full-bleed blocks (arrow) render their own absolutely-positioned content.
  if (def.fullBleed) {
    const content = def.render(block.props || {}, ctx);
    if (editMode) {
      // CRITICAL: a full-bleed SVG covers the entire 1200×675 stage. We
      // must NOT make the SVG itself pointer-clickable, or it will eat
      // clicks meant for blocks rendered earlier in the DOM (titles,
      // text, etc). Instead, keep the SVG transparent to clicks and add
      // an invisible wide hit-line on top of the visible graphics.
      content.style.pointerEvents = "none";
      const onSelect = (e: PointerEvent) => {
        e.stopPropagation();
        selectBlock(block.id);
      };
      if (block.type === "arrow") {
        const p = block.props || {};
        const hit = svg("line", {
          x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2,
          stroke: "transparent",
          "stroke-width": "18",
          "stroke-linecap": "round",
          style: "cursor:pointer;pointer-events:stroke;",
        });
        hit.addEventListener("pointerdown", onSelect);
        content.appendChild(hit);
      }
      // Any visible <line>/<text> inside the bleed should also be hit
      // targets, for components other than arrow that might use bleed.
      for (const node of content.querySelectorAll("text")) {
        node.style.pointerEvents = "auto";
        node.style.cursor = "pointer";
        node.addEventListener("pointerdown", onSelect);
      }
      if (block.id === selectedBlockId) {
        // Show endpoint handles
        const handles = renderArrowHandles(slide, block);
        const layer = el("div", { style: {
          position: "absolute", left: "0", top: "0",
          width: "1200px", height: "675px", pointerEvents: "none",
        }});
        layer.appendChild(content);
        for (const h of handles) layer.appendChild(h);
        return layer;
      }
    }
    return content;
  }

  // Regular positioned wrapper.
  const wrap = el("div", {
    style: {
      position: "absolute",
      left: (block.x ?? 0) + "px",
      top: (block.y ?? 0) + "px",
      ...(block.w != null ? { width: block.w + "px" } : {}),
      ...(block.h != null ? { height: block.h + "px" } : {}),
      boxSizing: "border-box",
    },
  });
  wrap.dataset.blockId = block.id;
  const content = def.render(block.props || {}, ctx);
  wrap.appendChild(content);

  if (editMode) {
    wrap.style.cursor = "move";
    attachBlockInteractions(wrap, slide, block, def);
    if (block.id === selectedBlockId) {
      wrap.style.outline = `2px solid ${C.orange}`;
      wrap.style.outlineOffset = "2px";
      wrap.style.zIndex = "5";
      if (def.resizableW || def.resizableH) addResizeHandle(wrap, slide, block, def);
    } else {
      wrap.addEventListener("mouseenter", () => {
        if (block.id !== selectedBlockId)
          wrap.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      });
      wrap.addEventListener("mouseleave", () => {
        if (block.id !== selectedBlockId) wrap.style.outline = "none";
      });
    }
  }
  return wrap;
}

/* Bind an element as inline-editable text.
 *
 * Two states inside edit mode:
 *   - Block NOT selected: text renders as static. Clicks bubble up so the
 *     wrap can select the block (one click to select).
 *   - Block selected: text becomes contentEditable. Clicks stop propagation
 *     so they don't restart a drag, and focus opens the caret.
 *
 * (This two-click pattern matches Figma/Keynote and avoids re-rendering
 * the editable mid-focus.)
 */
function bindInlineText(elem: HTMLElement, slide: Slide, block: Block, propKey: string, transform?: (raw: string) => string): HTMLElement {
  const raw = ((block.props || {})[propKey] ?? "") as string;
  const isSelected = block.id === selectedBlockId;
  if (editMode && isSelected) {
    elem.contentEditable = "plaintext-only";
    elem.spellcheck = false;
    elem.textContent = raw;
    elem.style.outline = "none";
    elem.style.cursor = "text";
    elem.addEventListener("pointerdown", (e) => e.stopPropagation());
    elem.addEventListener("focus", () => {
      elem.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      elem.style.outlineOffset = "2px";
    });
    elem.addEventListener("blur", async () => {
      elem.style.outline = "none";
      const v = elem.innerText.replace(/\u00A0/g, " ");
      if (v === raw) return;
      block.props = { ...(block.props || {}), [propKey]: v };
      await gadget.updateBlock(slide.id, block.id, { props: { [propKey]: v } });
      render();
    });
    elem.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); elem.blur(); }
    });
  } else {
    if (transform) elem.innerHTML = transform(raw);
    else elem.textContent = raw;
  }
  return elem;
}

/* ====================== Block interactions =============================== */

/* Snap distance in slide coords. The viewport is scaled, so this is the
 * threshold *before* scaling — at typical zoom it lands around 5-8px on
 * screen, which feels like a gentle assist rather than a hard grid. */
const SNAP_THRESHOLD = 6;

/* Click-to-select + drag-to-move.
 *
 * We deliberately do NOT call selectBlock on pointerdown — that would
 * re-render the wrap and orphan the live drag. Instead: tracking starts
 * on pointerdown, position is mutated visually during pointermove without
 * any re-render, and on pointerup we (a) save the new position if the
 * user actually dragged, and (b) select the block if they only clicked.
 *
 * Dragging also computes alignment snaps against every other block's
 * edges and centers (plus the slide bounds + center). When within
 * SNAP_THRESHOLD of a target, the position locks to it and a subtle
 * orange guide line is drawn. Hold Alt/Option to disable snapping.
 */
function attachBlockInteractions(wrap: HTMLDivElement, slide: Slide, block: Block, def: ComponentDef): void {
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Clicks inside contentEditable text are handled by the text element.
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
    e.stopPropagation();

    const startX = e.clientX, startY = e.clientY;
    const origX = block.x ?? 0, origY = block.y ?? 0;
    // Measure block size once at drag start. For blocks without explicit
    // w/h (titles, pills, etc.) we fall back to the rendered offset, which
    // gives us accurate edges & centers for snap math.
    const bw = block.w ?? wrap.offsetWidth;
    const bh = block.h ?? wrap.offsetHeight;
    // Snap targets are static for the duration of the drag — gather once.
    const targets = computeSnapTargets(slide, block);
    const wasSelected = block.id === selectedBlockId;
    let dragged = false;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / stageScale;
      const dy = (ev.clientY - startY) / stageScale;
      if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragged = true;
      if (!dragged) return;
      let nx = Math.round(origX + dx);
      let ny = Math.round(origY + dy);

      // Alt/Option temporarily disables snap so the user can always nudge
      // a block one pixel off a guide.
      let guidesV: number[] = [], guidesH: number[] = [];
      if (!ev.altKey) {
        const snap = applySnap(nx, ny, bw, bh, targets);
        nx = snap.x; ny = snap.y;
        guidesV = snap.guidesV; guidesH = snap.guidesH;
      }
      drawSnapGuides(wrap.parentElement, guidesV, guidesH);

      wrap.style.left = nx + "px";
      wrap.style.top  = ny + "px";
      block.x = nx; block.y = ny;
      updateInspectorPositionFields(block);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      clearSnapGuides();
      if (dragged) {
        await gadget.updateBlock(slide.id, block.id,
          { x: block.x, y: block.y });
        if (!wasSelected) selectBlock(block.id);
        // If already selected, no re-render needed — position is already
        // applied. The broadcast will arrive and idempotently re-render.
      } else if (!wasSelected) {
        selectBlock(block.id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* Collect snap candidates from every other block on the slide, plus the
 * slide bounds + center. Returns lists of vertical lines (x values) and
 * horizontal lines (y values). We skip the block being dragged, and skip
 * full-bleed blocks (arrows) which don't have a meaningful bounding box. */
interface SnapTargets { verts: number[]; horiz: number[] }

function computeSnapTargets(slide: Slide, draggingBlock: Block): SnapTargets {
  const verts: number[] = [], horiz: number[] = [];
  // Slide bounds and center — useful for centering things on the canvas.
  verts.push(0, 600, 1200);
  horiz.push(0, 337.5, 675);

  for (const b of slide.blocks) {
    if (b.id === draggingBlock.id) continue;
    const bdef = COMPONENTS[b.type];
    if (!bdef || bdef.fullBleed) continue;
    const node = stageRef.el?.querySelector<HTMLElement>(`[data-block-id="${b.id}"]`);
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    const w = b.w ?? (node ? node.offsetWidth : 0);
    const h = b.h ?? (node ? node.offsetHeight : 0);
    if (w > 0) {
      verts.push(x);
      verts.push(x + w);
      verts.push(x + w / 2);
    }
    if (h > 0) {
      horiz.push(y);
      horiz.push(y + h);
      horiz.push(y + h / 2);
    }
  }
  return { verts, horiz };
}

/* Given a proposed (nx, ny) and the dragged block size, find the nearest
 * snap on each axis within SNAP_THRESHOLD. Returns the adjusted position
 * plus the guide lines (in slide coords) that should be drawn to visualize
 * the snap. We snap each axis independently so the user can pick up a
 * horizontal alignment without losing free movement vertically. */
function applySnap(nx: number, ny: number, bw: number, bh: number, targets: SnapTargets) {
  // Candidates on the dragged block, paired with the offset needed to
  // express the result as a top-left coordinate.
  const xCands = [
    { pos: nx,           offset: 0 },
    { pos: nx + bw / 2,  offset: -bw / 2 },
    { pos: nx + bw,      offset: -bw },
  ];
  const yCands = [
    { pos: ny,           offset: 0 },
    { pos: ny + bh / 2,  offset: -bh / 2 },
    { pos: ny + bh,      offset: -bh },
  ];

  let bestX: { d: number; x: number; guide: number } | null = null;
  for (const c of xCands) {
    for (const t of targets.verts) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!bestX || d < bestX.d)) {
        bestX = { d, x: t + c.offset, guide: t };
      }
    }
  }
  let bestY: { d: number; y: number; guide: number } | null = null;
  for (const c of yCands) {
    for (const t of targets.horiz) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!bestY || d < bestY.d)) {
        bestY = { d, y: t + c.offset, guide: t };
      }
    }
  }

  return {
    x: bestX ? Math.round(bestX.x) : nx,
    y: bestY ? Math.round(bestY.y) : ny,
    guidesV: bestX ? [bestX.guide] : [],
    guidesH: bestY ? [bestY.guide] : [],
  };
}

/* Draw alignment guide lines on the slide frame. We render into a tagged
 * layer so we can clear it cheaply without disturbing the rest of the
 * slide. The layer is positioned inside the 1200×675 frame (NOT the
 * scaled stage), so guide coordinates are in slide units. */
function drawSnapGuides(frame: HTMLElement | null, xs: number[], ys: number[]): void {
  if (!frame) return;
  let layer = frame.querySelector<HTMLDivElement>('[data-snap-layer]');
  if (!layer) {
    layer = el("div", {
      "data-snap-layer": "1",
      style: {
        position: "absolute", inset: "0",
        pointerEvents: "none",
        zIndex: "100",
      },
    });
    frame.appendChild(layer);
  }
  layer.innerHTML = "";
  for (const x of xs) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: x + "px", top: "0",
        width: "1px", height: "675px",
        marginLeft: "-0.5px",
        background: C.orange,
        opacity: "0.9",
      },
    }));
  }
  for (const y of ys) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: "0", top: y + "px",
        width: "1200px", height: "1px",
        marginTop: "-0.5px",
        background: C.orange,
        opacity: "0.9",
      },
    }));
  }
}

function clearSnapGuides() {
  const layer = stageRef.el?.querySelector('[data-snap-layer]');
  if (layer) layer.remove();
}

/* Bottom-right corner resize handle. */
function addResizeHandle(wrap: HTMLDivElement, slide: Slide, block: Block, def: ComponentDef): void {
  const handle = el("div", {
    style: {
      position: "absolute", right: "-6px", bottom: "-6px",
      width: "12px", height: "12px",
      background: "#fff", border: `2px solid ${C.orange}`,
      borderRadius: "3px", cursor: "nwse-resize",
      zIndex: "10",
    },
  });
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const origW = block.w ?? wrap.offsetWidth;
    const origH = block.h ?? wrap.offsetHeight;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / stageScale;
      const dy = (ev.clientY - startY) / stageScale;
      if (def.resizableW) {
        const nw = Math.max(40, Math.round(origW + dx));
        wrap.style.width = nw + "px";
        block.w = nw;
      }
      if (def.resizableH) {
        const nh = Math.max(24, Math.round(origH + dy));
        wrap.style.height = nh + "px";
        block.h = nh;
      }
      updateInspectorPositionFields(block);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const patch: BlockPatch = {};
      if (def.resizableW) patch.w = block.w;
      if (def.resizableH) patch.h = block.h;
      await gadget.updateBlock(slide.id, block.id, patch);
      render();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  wrap.appendChild(handle);
}

/* Endpoint handles for an arrow block. */
function renderArrowHandles(slide: Slide, block: Block): HTMLDivElement[] {
  const handles: HTMLDivElement[] = [];
  for (const which of ["1", "2"]) {
    const x = block.props["x" + which] as number, y = block.props["y" + which] as number;
    const h = el("div", {
      style: {
        position: "absolute",
        left: (x - 7) + "px", top: (y - 7) + "px",
        width: "14px", height: "14px",
        background: "#fff", border: `2px solid ${C.orange}`,
        borderRadius: "50%", cursor: "grab",
        pointerEvents: "auto", zIndex: "8",
      },
    });
    h.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      h.style.cursor = "grabbing";
      const startX = e.clientX, startY = e.clientY;
      const ox = x, oy = y;
      const onMove = (ev: PointerEvent) => {
        const nx = Math.round(ox + (ev.clientX - startX) / stageScale);
        const ny = Math.round(oy + (ev.clientY - startY) / stageScale);
        block.props["x" + which] = nx;
        block.props["y" + which] = ny;
        render();
      };
      const onUp = async () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        await gadget.updateBlock(slide.id, block.id, {
          props: {
            ["x" + which]: block.props["x" + which],
            ["y" + which]: block.props["y" + which],
          },
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    handles.push(h);
  }
  return handles;
}

/* ====================== Selection ======================================== */

export function selectBlock(id: string | null): void {
  if (selectedBlockId === id) return;
  setSelectedBlockId(id);
  render();
  renderInspector();
}
