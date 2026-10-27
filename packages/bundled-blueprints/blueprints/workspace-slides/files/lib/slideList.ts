/** The left panel: slide thumbnails, drag-to-reorder, search, jump menu, counter, present/edit toggles, and the render/print entry points. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { currentSlide, filteredSlideIndices, renderSlide, slideLabel } from "./canvas.ts";
import { duplicateSlideById, moveSlideTo, removeSlideById } from "./commands.ts";
import { hexA, svg, svgFromString } from "./dom.ts";
import type { VendorStyle } from "./dom.ts";
import { updateUndoButtons } from "./history.ts";
import { renderInspector } from "./inspector.ts";
import type { Slide } from "./protocol.ts";
import { currentIndex, deck, editMode, presenting, selectedBlockId, setCurrentIndex, setEditMode, setPresenting, setSelectedBlockId, setSlideSearch, shellRef, slideSearch, stageRef } from "./state.ts";
import { C, FONT, ICONS } from "./tokens.ts";

/* Render a slide at a small fixed width by scaling its full-fidelity DOM.
 * We render with `editMode` forced off so the thumbnail never shows
 * selection outlines or contentEditable affordances. */
function renderSlideThumbnail(slide: Slide, width = 156): HTMLDivElement {
  const prevEdit = editMode, prevSel = selectedBlockId;
  setEditMode(false); setSelectedBlockId(null);
  let frame: HTMLDivElement;
  try { frame = renderSlide(slide); }
  finally { setEditMode(prevEdit); setSelectedBlockId(prevSel); }
  const scale = width / 1200;
  const height = 675 * scale;
  const container = el("div", {
    style: {
      width: width + "px", height: height + "px",
      borderRadius: "6px", overflow: "hidden",
      background: (slide.background && slide.background.color) || C.page,
      position: "relative", pointerEvents: "none",
      boxShadow: "0 1px 0 rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,245,232,0.04)",
    },
  });
  frame.style.transform = `scale(${scale})`;
  frame.style.transformOrigin = "0 0";
  frame.style.flex = "none";
  container.appendChild(frame);
  return container;
}

/* Tiny per-row action button (duplicate / delete) revealed on row hover. */
function thumbActionBtn(iconHtml: string, title: string, onClick: EventListener, danger = false): HTMLButtonElement {
  const b = el("button", {
    title, "aria-label": title,
    "data-icon-btn": "1",
    onclick: onClick,
    style: {
      width: "22px", height: "22px", padding: "0",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "rgba(20,12,8,0.78)",
      color: danger ? "#ffb8a0" : "#f5e7d6",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "6px",
      cursor: "pointer",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
    } as VendorStyle,
  });
  b.innerHTML = iconHtml;
  b.addEventListener("mouseenter", () => {
    b.style.background = danger
      ? "rgba(255,95,46,0.22)"
      : "rgba(255,245,232,0.16)";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "rgba(20,12,8,0.78)";
  });
  return b;
}

export function updateCounter(): void {
  if (shellRef.counter) {
    shellRef.counter.textContent =
      `${currentIndex + 1} / ${deck.slides.length}`;
  }
}

export function toggleJumpMenu(): void {
  const menu = shellRef.jumpMenu;
  if (!menu) return;
  if (menu.style.display === "grid") { menu.style.display = "none"; return; }
  menu.innerHTML = "";
  for (let i = 0; i < deck.slides.length; i++) {
    const active = i === currentIndex;
    const b = el("button", {
      text: String(i + 1),
      onclick: () => { go(i); menu.style.display = "none"; },
      style: {
        width: "38px", height: "38px",
        borderRadius: "10px", border: "none",
        background: active ? C.orange : "rgba(255,245,232,0.06)",
        color: active ? "#fff" : "#f5e7d6",
        fontWeight: "800", fontSize: "13px",
        fontFamily: FONT, cursor: "pointer",
        fontVariantNumeric: "tabular-nums",
        transition: "background 0.12s ease",
      },
    });
    b.dataset.iconBtn = "1";
    b.style.transition =
      "background 160ms var(--ease), transform 120ms var(--ease)";
    if (!active) {
      b.addEventListener("mouseenter", () =>
        b.style.background = "rgba(255,245,232,0.14)");
      b.addEventListener("mouseleave", () =>
        b.style.background = "rgba(255,245,232,0.06)");
    }
    menu.appendChild(b);
  }
  menu.style.display = "grid";
}

export function togglePresent(): void {
  setPresenting(!presenting);
  if (presenting && editMode) setEditMode(false);
  if (shellRef.bar) shellRef.bar.style.display = presenting ? "none" : "flex";
  if (shellRef.exitBtn)
    shellRef.exitBtn.style.display = presenting ? "inline-flex" : "none";
  if (shellRef.jumpMenu) shellRef.jumpMenu.style.display = "none";
  shellRef.leftPanel!.style.display = (editMode && !presenting) ? "flex" : "none";
  shellRef.rightPanel!.style.display = (editMode && !presenting) ? "flex" : "none";
  const b = shellRef.fsBtn;
  if (b) {
    b.innerHTML = presenting ? ICONS.collapse : ICONS.expand;
    b.title = presenting ? "Exit presentation (F)" : "Present (F)";
  }
  // Entering present mode implicitly leaves edit mode, so refresh the
  // undo button visibility too.
  updateUndoButtons();
  shellRef.fit?.();
  render();
}

export function toggleEdit(): void {
  setEditMode(!editMode);
  if (editMode && presenting) setPresenting(false);
  setSelectedBlockId(null);
  const b = shellRef.editBtn;
  if (b) {
    b.style.background = editMode ? C.orange : "transparent";
    b.style.color = editMode ? "#fff" : "#f5e7d6";
    b.dataset.variant = editMode ? "accent" : "ghost";
    b.title = editMode ? "Done editing (E)" : "Edit (E)";
  }
  shellRef.leftPanel!.style.display = editMode ? "flex" : "none";
  shellRef.rightPanel!.style.display = editMode ? "flex" : "none";
  updateUndoButtons();
  shellRef.fit?.();
  render(); renderSlideList(); renderInspector();
}

export function go(i: number): void {
  const n = deck.slides.length;
  if (n === 0) return;
  setCurrentIndex(((i % n) + n) % n);
  setSelectedBlockId(null);
  updateCounter();
  render(); renderSlideList(); renderInspector();
}

export function render(): void {
  if (!stageRef.el) return;
  stageRef.el.innerHTML = "";
  const slide = currentSlide();
  if (!slide) return;
  stageRef.el.appendChild(renderSlide(slide));
}

export function renderPrintDeck(): void {
  const printDeck = shellRef.printDeck;
  if (!printDeck) return;
  const prevEdit = editMode, prevSelection = selectedBlockId;
  setEditMode(false);
  setSelectedBlockId(null);
  try {
    printDeck.replaceChildren(...deck.slides.map((slide) => {
      const page = el("section", { class: "print-slide" });
      page.appendChild(renderSlide(slide));
      return page;
    }));
  } finally {
    setEditMode(prevEdit);
    setSelectedBlockId(prevSelection);
  }
}

window.addEventListener("beforeprint", renderPrintDeck);
window.matchMedia("print").addEventListener("change", (event) => {
  if (event.matches) renderPrintDeck();
});

/* ====================== Slide list & search ============================= */

/* The search field that lives in the left panel header. Renders once at
 * shell mount time; typing into it filters the slide list in place
 * without ever stealing focus.
 *
 * The visual treatment mirrors the right panel's component-library
 * search exactly: a flat row (no pill background, no focus glow on the
 * wrapper) with the icon, input, and clear button laid out in a row,
 * with the surrounding `header` div providing the bottom-border
 * separator that the library card's border-bottom plays the role of. */
export function buildSlideSearchHeader(): HTMLDivElement {
  const header = el("div", {
    style: {
      padding: "9px 12px",
      borderBottom: "1px solid rgba(255,245,232,0.05)",
    },
  });

  const box = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "8px",
    },
  });
  box.dataset.slideSearchBox = "1";
  box.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a7164" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/></svg>`));

  const input = el("input", {
    type: "text",
    placeholder: "Search slides",
    value: slideSearch,
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
      setSlideSearch(e.target.value);
      renderSlideList();
      updateSlideSearchClear();
    },
    onkeydown: (e: Event) => {
      e.stopPropagation();
      if (!(e instanceof KeyboardEvent && e.target instanceof HTMLInputElement)) return;
      if (e.key === "Escape") {
        if (slideSearch) {
          setSlideSearch("");
          e.target.value = "";
          renderSlideList();
          updateSlideSearchClear();
        } else {
          e.target.blur();
        }
      } else if (e.key === "Enter") {
        // Jump to the first match.
        const idxs = filteredSlideIndices();
        if (idxs.length > 0) go(idxs[0]);
      }
    },
  });
  box.appendChild(input);

  const clear = el("button", {
    title: "Clear",
    "aria-label": "Clear slide search",
    "data-press": "1",
    "data-slide-search-clear": "1",
    onclick: () => {
      setSlideSearch("");
      input.value = "";
      input.focus();
      renderSlideList();
      updateSlideSearchClear();
    },
    style: {
      background: "transparent", border: "none",
      padding: "2px", margin: "0",
      color: "#8a7164", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "4px",
      opacity: slideSearch ? "1" : "0",
      pointerEvents: slideSearch ? "auto" : "none",
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
  box.appendChild(clear);

  header.appendChild(box);
  return header;
}

function updateSlideSearchClear(): void {
  const c = document.querySelector<HTMLButtonElement>('[data-slide-search-clear="1"]');
  if (c) {
    c.style.opacity = slideSearch ? "1" : "0";
    c.style.pointerEvents = slideSearch ? "auto" : "none";
  }
}

/* Index of the slide currently being dragged in the side list. */
let dragSrcIndex: number | null = null;

function clearDropIndicators(list: HTMLElement): void {
  list.querySelectorAll("[data-drop-line]").forEach(e => e.remove());
}

export function renderSlideList(): void {
  const list = shellRef.slideList;
  if (!list) return;
  list.innerHTML = "";

  const indices = filteredSlideIndices();
  const filtering = !!slideSearch.trim();

  if (indices.length === 0) {
    list.appendChild(el("div", {
      style: {
        padding: "24px 12px", textAlign: "center",
        color: "#7b6254", fontSize: "11.5px", lineHeight: "1.4",
      },
    }, [
      el("div", { text: "No slides match", style: { fontWeight: "600" }}),
      el("div", {
        text: `"${slideSearch}"`,
        style: { marginTop: "4px", color: "#5b483b",
                 fontStyle: "italic", fontSize: "10.5px",
                 whiteSpace: "nowrap", overflow: "hidden",
                 textOverflow: "ellipsis" },
      }),
    ]));
    return;
  }

  // While filtering we can't drag-to-reorder (the visual positions don't
  // map cleanly onto absolute indices). Disable draggable + grab cursor.
  const canReorder = !filtering;

  for (const i of indices) {
    const s = deck.slides[i];
    const active = i === currentIndex;

    const row = el("div", {
      "data-slide-row": "1",
      "data-index": String(i),
      "data-active": active ? "1" : "0",
      draggable: canReorder ? "true" : "false",
      onclick: () => go(i),
      style: {
        position: "relative",
        padding: "8px",
        marginBottom: "5px",
        borderRadius: "10px",
        background: active
          ? hexA(C.orange, 0.12)
          : "transparent",
        border: `1px solid ${active
          ? hexA(C.orange, 0.40)
          : "transparent"}`,
        cursor: canReorder ? "grab" : "pointer",
        transition:
          "background 140ms var(--ease), border-color 140ms var(--ease)",
      },
    });

    // Header: slide number on the left, hover-revealed actions on the right.
    const header = el("div", {
      style: {
        display: "flex", alignItems: "center",
        marginBottom: "6px", padding: "0 2px",
        height: "16px",
      },
    });
    header.appendChild(el("div", {
      text: String(i + 1).padStart(2, "0"),
      style: {
        fontSize: "10px", fontWeight: "750",
        color: active ? "#ffb18d" : "#6e5747",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.08em",
      },
    }));
    const actions = el("div", {
      style: {
        marginLeft: "auto",
        display: "flex", gap: "4px",
        opacity: "0",
        transition: "opacity 140ms var(--ease)",
        pointerEvents: "none",
      },
    });
    const dupBtn = thumbActionBtn(ICONS.copy, "Duplicate slide", (e) => {
      e.stopPropagation(); duplicateSlideById(s.id);
    });
    const delBtn = thumbActionBtn(ICONS.trash, "Delete slide", (e) => {
      e.stopPropagation(); removeSlideById(s.id);
    }, true);
    actions.appendChild(dupBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
    row.appendChild(header);

    // Thumbnail
    row.appendChild(renderSlideThumbnail(s, 156));

    // One-line title under the thumb, so the list is scannable without
    // having to read tiny thumbnail text.
    const label = slideLabel(s);
    row.appendChild(el("div", {
      style: {
        marginTop: "6px",
        padding: "0 2px",
        fontSize: "11px",
        fontWeight: active ? "600" : "500",
        color: active ? "#fff5e8" : "#a89082",
        lineHeight: "1.3",
        whiteSpace: "nowrap", overflow: "hidden",
        textOverflow: "ellipsis",
      },
      text: label,
    }));

    // Reveal hover actions only on hover (not on press / drag).
    row.addEventListener("mouseenter", () => {
      actions.style.opacity = "1";
      actions.style.pointerEvents = "auto";
      if (!active) row.style.background = "rgba(255,245,232,0.035)";
    });
    row.addEventListener("mouseleave", () => {
      actions.style.opacity = "0";
      actions.style.pointerEvents = "none";
      if (!active) row.style.background = "transparent";
    });

    if (canReorder) attachSlideDragHandlers(row, list, i);

    list.appendChild(row);
  }
}

function attachSlideDragHandlers(row: HTMLDivElement, list: HTMLElement, i: number): void {
  // Native HTML5 drag-and-drop for reordering. Works inside the sandbox
  // and gets a free drag-image from the browser.
  row.addEventListener("dragstart", (e) => {
    dragSrcIndex = i;
    row.style.opacity = "0.4";
    row.style.cursor = "grabbing";
    try {
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", String(i));
    } catch {}
  });
  row.addEventListener("dragend", () => {
    row.style.opacity = "1";
    row.style.cursor = "grab";
    clearDropIndicators(list);
    dragSrcIndex = null;
  });
  row.addEventListener("dragover", (e) => {
    if (dragSrcIndex == null) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    clearDropIndicators(list);
    // Don't show an indicator that would be a no-op.
    if ((before && (dragSrcIndex === i || dragSrcIndex === i - 1)) ||
        (!before && (dragSrcIndex === i || dragSrcIndex === i + 1))) return;
    const line = el("div", {
      "data-drop-line": "1",
      style: {
        height: "2px", margin: "0 2px",
        background: C.orange,
        borderRadius: "2px",
        boxShadow: `0 0 8px ${hexA(C.orange, 0.6)}`,
      },
    });
    if (before) list.insertBefore(line, row);
    else if (row.nextSibling) list.insertBefore(line, row.nextSibling);
    else list.appendChild(line);
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = dragSrcIndex;
    clearDropIndicators(list);
    if (from == null || from === i) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    let to = before ? i : i + 1;
    if (from < to) to -= 1;
    if (from === to) return;
    moveSlideTo(from, to);
  });
}
