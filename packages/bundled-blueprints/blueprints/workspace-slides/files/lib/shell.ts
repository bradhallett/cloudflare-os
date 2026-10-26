/** mountShell(): builds the whole editor chrome — stage, panels, toolbar, keyboard map — once at boot. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import { currentSlide, selectBlock } from "./canvas.ts";
import { addSlide } from "./commands.ts";
import { hexA, svg } from "./dom.ts";
import type { VendorStyle } from "./dom.ts";
import { copySelectedBlock, cutSelectedBlock, doRedo, doUndo, duplicateSelectedBlock, pasteClipboardBlock, updateUndoButtons } from "./history.ts";
import { renderInspector } from "./inspector.ts";
import type { GadgetStub, Slide } from "./protocol.ts";
import { buildSlideSearchHeader, go, render, toggleEdit, toggleJumpMenu, togglePresent } from "./slideList.ts";
import { clipboardBlock, currentIndex, deck, editMode, presenting, selectedBlockId, setSelectedBlockId, setStageScale, shellRef, stageRef, stageScale } from "./state.ts";
import { makeContentSlide, makeFourColumnSlide, makeTitleSlide, makeTwoColumnSlide } from "./templates.ts";
import type { SlideTemplate } from "./templates.ts";
import { C, EASE, EASE_IN_OUT, FONT, ICONS } from "./tokens.ts";


// The RPC stub binding the Workshop's iframe bootstrap defines before this module
// runs. client.ts declares it too; ambient declarations are file-scoped.
declare const gadget: GadgetStub;

export function mountShell(): void {
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.background = "#faf9f7";
  document.body.style.height = "100vh";
  document.body.style.overflow = "hidden";
  document.body.style.fontFamily = FONT;
  document.body.style.color = "#fff5e8";

  // Global stylesheet: easing tokens, scrollbar polish, focus ring reset,
  // shared field control styles.
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --ease: ${EASE};
      --ease-in-out: ${EASE_IN_OUT};
    }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, input:focus-visible, select:focus-visible,
    textarea:focus-visible {
      outline: 2px solid ${hexA(C.orange, 0.55)};
      outline-offset: 1px;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,245,232,0.08);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,245,232,0.18); }
    /* Slide list rows: subtle press feedback and hover lift. */
    [data-slide-row] {
      transition:
        background 180ms var(--ease),
        border-color 180ms var(--ease),
        transform 120ms var(--ease);
    }
    [data-slide-row]:active { transform: scale(0.985); }
    [data-icon-btn] {
      transition:
        background 160ms var(--ease),
        color 160ms var(--ease),
        transform 100ms var(--ease);
    }
    [data-icon-btn]:active { transform: scale(0.92); }
    [data-press] { transition: transform 120ms var(--ease); }
    [data-press]:active { transform: scale(0.97); }

    /* --- Inspector form controls ------------------------------------ */
    .field-input {
      width: 100%;
      min-width: 0;
      background: rgba(255,245,232,0.04);
      color: #fff5e8;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: ${FONT};
      line-height: 1.4;
      outline: none;
      transition:
        background 140ms var(--ease),
        border-color 140ms var(--ease),
        box-shadow 140ms var(--ease);
    }
    .field-input::placeholder { color: #6e5747; }
    .field-input:hover { background: rgba(255,245,232,0.07); }
    .field-input:focus, .field-input:focus-visible {
      background: rgba(20,12,8,0.6);
      border-color: ${hexA(C.orange, 0.45)};
      box-shadow: 0 0 0 3px ${hexA(C.orange, 0.10)};
      outline: none;
    }
    .field-textarea {
      min-height: 64px;
      resize: vertical;
      padding: 7px 8px;
    }
    .field-select {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 24px;
      cursor: pointer;
      background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239a8273' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    .field-select option {
      background: #1a1108;
      color: #fff5e8;
    }
    .field-check {
      width: 16px; height: 16px;
      flex: 0 0 16px;
      appearance: none; -webkit-appearance: none;
      margin: 0;
      border: 1px solid rgba(255,245,232,0.22);
      border-radius: 4px;
      background: rgba(255,245,232,0.04);
      cursor: pointer;
      position: relative;
      transition:
        background 140ms var(--ease),
        border-color 140ms var(--ease);
    }
    .field-check:hover {
      background: rgba(255,245,232,0.10);
      border-color: rgba(255,245,232,0.34);
    }
    .field-check:checked {
      background: ${C.orange};
      border-color: ${C.orange};
    }
    .field-check:checked::after {
      content: "";
      position: absolute;
      left: 4.5px; top: 1.5px;
      width: 4px; height: 8px;
      border: solid #fff;
      border-width: 0 1.8px 1.8px 0;
      transform: rotate(45deg);
    }
    /* Hide number input spinners — they look noisy in dark UI. */
    .field-input[type="number"]::-webkit-outer-spin-button,
    .field-input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .field-input[type="number"] { -moz-appearance: textfield; }

    /* Light editor chrome: the slides are the focus, so edit mode uses
       quiet neutral surfaces instead of heavy black sidebars. */
    #leftPanel, #rightPanel {
      background: rgba(255,255,255,0.97) !important;
      border-color: #e7e5e4 !important;
      color: #292524 !important;
      box-shadow: 0 0 28px rgba(28,25,23,0.05);
    }
    #leftPanel *, #rightPanel * { scrollbar-color: #d6d3d1 transparent; }
    #leftPanel ::-webkit-scrollbar-thumb,
    #rightPanel ::-webkit-scrollbar-thumb { background: #d6d3d1; }
    #leftPanel :is(div, span, label):not(.slide-frame *),
    #rightPanel :is(div, span, label) {
      color: #57534e !important;
    }
    #leftPanel input, #rightPanel input, #rightPanel textarea,
    #rightPanel select {
      color: #292524 !important;
    }
    #leftPanel input::placeholder, #rightPanel input::placeholder,
    #rightPanel textarea::placeholder { color: #a8a29e !important; }
    #leftPanel button, #rightPanel button {
      color: #57534e !important;
    }
    #leftPanel [data-slide-row] { border-color: transparent; }
    #leftPanel [data-slide-row]:hover { background: #f7f5f3 !important; }
    #leftPanel [data-slide-row][data-active="1"] {
      background: #fff7ed !important;
      border-color: #fdba74 !important;
    }
    #leftPanel [data-icon-btn] {
      background: rgba(255,255,255,0.94) !important;
      border-color: #e7e5e4 !important;
      box-shadow: 0 2px 8px rgba(28,25,23,0.10);
    }
    #rightPanel > div > div { border-color: #e7e5e4 !important; }
    #rightPanel button {
      background: #f7f7f6 !important;
      border-color: #efeeec !important;
    }
    #rightPanel button:hover { background: #efeeec !important; }
    #rightPanel .field-input {
      background: #f7f7f6 !important;
      border-color: #e7e5e4 !important;
    }
    #rightPanel .field-input:hover { background: #f1f0ef !important; }
    #rightPanel .field-input:focus {
      background: #fff !important;
      border-color: #fb923c !important;
      box-shadow: 0 0 0 3px rgba(251,146,60,0.14) !important;
    }
    #rightPanel .field-select option { background: #fff; color: #292524; }
    #rightPanel .field-check {
      background: #fff !important;
      border-color: #d6d3d1 !important;
    }
    #rightPanel .field-check:checked {
      background: ${C.orange} !important;
      border-color: ${C.orange} !important;
    }
    #leftPanel button:hover, #rightPanel button:hover {
      background: #f1f0ef !important;
    }
    #leftPanel [aria-label*="Delete"], #rightPanel [aria-label*="Delete"] {
      color: #dc2626 !important;
    }
    .add-slide-menu {
      animation: addMenuIn 150ms var(--ease);
      transform-origin: bottom right;
    }
    @keyframes addMenuIn {
      from { opacity: 0; transform: translateY(5px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media screen {
      html.slides-export, html.slides-export body {
        height: auto !important;
        min-height: 100%;
        overflow: visible !important;
        background: #f5f1eb !important;
      }
      html.slides-export body { padding: 24px; }
      html.slides-export #root { display: none !important; }
      html.slides-export #printDeck { display: block; }
      html.slides-export .print-slide {
        width: 1200px;
        height: 675px;
        margin: 0 auto 24px;
        overflow: hidden;
        box-shadow: 0 12px 36px rgba(43, 28, 20, 0.16);
      }
      html.slides-export .print-slide:last-child { margin-bottom: 0; }
      html.slides-export .print-slide > .slide-frame { border-radius: 0 !important; }
    }
    #printDeck { display: none; }
    @page { size: 12.5in 7.03125in; margin: 0; }
    @media print {
      html, body {
        width: 1200px;
        height: auto !important;
        margin: 0;
        overflow: visible !important;
        background: #fff !important;
      }
      #root { display: none !important; }
      #printDeck { display: block; }
      .print-slide {
        width: 1200px;
        height: 675px;
        overflow: hidden;
        break-after: page;
      }
      .print-slide:last-child { break-after: auto; }
      .print-slide > .slide-frame { border-radius: 0 !important; }
    }
  `;
  document.head.appendChild(style);

  const root = el("div", {
    id: "root",
    style: { position: "fixed", inset: "0", display: "flex" },
  });

  // ---- Left panel (slides) -----------------------------------------
  // Same dark surface + 0.94 alpha as the right panel for cohesion.
  const leftPanel = el("div", {
    id: "leftPanel",
    style: {
      width: "208px", flex: "0 0 208px",
      background: "rgba(20,12,8,0.94)",
      borderRight: "1px solid rgba(255,245,232,0.06)",
      display: "none",
      flexDirection: "column",
    },
  });

  // Search header — same shape as the right-panel library search
  // (icon prefix, fading clear button), but freestanding rather than
  // wrapped in a card since the slides list is the whole left panel.
  leftPanel.appendChild(buildSlideSearchHeader());

  const slideList = el("div", {
    id: "slideList",
    style: { flex: "1", overflowY: "auto",
             padding: "4px 10px 8px", scrollBehavior: "smooth" },
  });
  leftPanel.appendChild(slideList);

  // Footer: one calm default action plus a caret menu for alternate layouts.
  // The primary action creates the standard narrative slide.
  const leftFooter = el("div", {
    style: {
      position: "relative",
      padding: "12px",
      borderTop: "1px solid #e7e5e4",
    },
  });
  const addMenu = el("div", {
    class: "add-slide-menu",
    style: {
      position: "absolute", left: "12px", right: "12px", bottom: "58px",
      display: "none", flexDirection: "column", gap: "2px",
      padding: "6px",
      background: "#ffffff", border: "1px solid #e7e5e4",
      borderRadius: "12px", boxShadow: "0 14px 34px rgba(28,25,23,0.14)",
      zIndex: "20",
    },
  });
  const closeAddMenu = () => { addMenu.style.display = "none"; };
  const addOption = (label: string, detail: string, factory: () => SlideTemplate) => {
    const option = el("button", {
      "data-press": "1",
      onclick: (e: Event) => {
        e.stopPropagation(); closeAddMenu(); addSlide(factory());
      },
      style: {
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        width: "100%", padding: "9px 10px", border: "none",
        borderRadius: "8px", background: "transparent", cursor: "pointer",
        textAlign: "left", fontFamily: FONT,
      },
    }, [
      el("span", { text: label, style: { fontSize: "12px", fontWeight: "650", color: "#292524" } }),
      el("span", { text: detail, style: { marginTop: "2px", fontSize: "10.5px", color: "#78716c" } }),
    ]);
    addMenu.appendChild(option);
  };
  addOption("Title slide", "Orange cover", makeTitleSlide);
  addOption("Narrative", "Standard content slide", makeContentSlide);
  addOption("Two columns", "Side-by-side comparison", makeTwoColumnSlide);
  addOption("Four columns", "Compact structured overview", makeFourColumnSlide);
  leftFooter.appendChild(addMenu);

  const addControl = el("div", {
    style: {
      display: "grid", gridTemplateColumns: "1fr 38px",
      border: "1px solid #d6d3d1", borderRadius: "10px",
      overflow: "hidden", background: "#ffffff",
      boxShadow: "0 1px 2px rgba(28,25,23,0.05)",
    },
  });
  const addDefault = el("button", {
    "data-press": "1", title: "Add standard slide",
    onclick: () => addSlide(makeContentSlide()),
    style: {
      height: "38px", border: "none", background: "transparent",
      color: "#292524", cursor: "pointer", fontFamily: FONT,
      fontSize: "12px", fontWeight: "650",
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "7px",
    },
    html: `${ICONS.plus}<span>Add slide</span>`,
  });
  const caret = el("button", {
    title: "Choose slide layout", "aria-label": "Choose slide layout",
    onclick: (e: Event) => {
      e.stopPropagation();
      addMenu.style.display = addMenu.style.display === "flex" ? "none" : "flex";
    },
    style: {
      height: "38px", border: "none", borderLeft: "1px solid #e7e5e4",
      background: "transparent", color: "#57534e", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    },
    html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  });
  addControl.appendChild(addDefault);
  addControl.appendChild(caret);
  leftFooter.appendChild(addControl);
  leftPanel.appendChild(leftFooter);
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Node && leftFooter.contains(e.target))) closeAddMenu();
  });
  root.appendChild(leftPanel);

  // ---- Center stage -------------------------------------------------
  const stageWrap = el("div", {
    style: {
      flex: "1", position: "relative", overflow: "hidden",
      background: "radial-gradient(circle at 50% 40%, #ffffff 0%, #f7f5f2 80%)",
    },
  });
  const stage = el("div", {
    id: "stage",
    style: {
      position: "absolute", top: "50%", left: "50%",
      width: "1200px", height: "675px",
      boxShadow: "0 10px 28px rgba(43, 28, 20, 0.14)",
      borderRadius: "18px", overflow: "hidden",
      transformOrigin: "center center",
    },
  });
  stageRef.el = stage; stageRef.wrap = stageWrap;
  stageWrap.appendChild(stage);
  root.appendChild(stageWrap);

  // ---- Right panel (component library + slide + inspector) ---------
  // The inspectorBody owns its own top padding (library card has 14px
  // margin-top), so we don't need a separate header strip.
  const rightPanel = el("div", {
    id: "rightPanel",
    style: {
      width: "284px", flex: "0 0 284px",
      background: "rgba(20,12,8,0.94)",
      borderLeft: "1px solid rgba(255,245,232,0.06)",
      display: "none",
      flexDirection: "column",
    },
  });
  const inspectorBody = el("div", {
    id: "inspectorBody",
    style: { flex: "1", overflowY: "auto", paddingBottom: "32px" },
  });
  rightPanel.appendChild(inspectorBody);
  root.appendChild(rightPanel);

  // ---- Bottom floating control bar ---------------------------------
  const bar = el("div", {
    id: "controls",
    style: {
      position: "absolute",
      left: "50%", bottom: "22px",
      transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "4px",
      padding: "6px",
      background: "rgba(20, 12, 8, 0.72)",
      border: "1px solid rgba(255, 245, 232, 0.08)",
      borderRadius: "999px",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: "0 12px 36px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)",
      zIndex: "10", fontFamily: FONT,
    } as VendorStyle,
  });

  const iconBtn = ({ icon, title, onClick, variant = "ghost", size = 38 }:
    { icon: string; title: string; onClick: EventListener; variant?: string; size?: number }) => {
    const b = el("button", {
      title, "aria-label": title, onclick: onClick,
      "data-icon-btn": "1",
      style: {
        width: size + "px", height: size + "px",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: variant === "accent" ? C.orange : "transparent",
        color: variant === "accent" ? "#fff" : "#f5e7d6",
        border: "none", borderRadius: "999px", cursor: "pointer", padding: "0",
      },
    });
    b.innerHTML = icon;
    b.dataset.variant = variant;
    b.addEventListener("mouseenter", () => {
      b.style.background = b.dataset.variant === "accent"
        ? C.orangeDark : "rgba(255,245,232,0.08)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = b.dataset.variant === "accent" ? C.orange : "transparent";
    });
    return b;
  };

  const prev = iconBtn({ icon: ICONS.chevronLeft, title: "Previous slide (←)",
    onClick: () => go(currentIndex - 1) });
  const next = iconBtn({ icon: ICONS.chevronRight, title: "Next slide (→)",
    onClick: () => go(currentIndex + 1) });

  const counter = el("button", {
    title: "Jump to slide",
    "data-press": "1",
    style: {
      minWidth: "78px", height: "38px", padding: "0 14px",
      background: "transparent", color: "#fff5e8",
      border: "none", borderRadius: "999px",
      fontSize: "13px", fontWeight: "700",
      fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
      cursor: "pointer", fontFamily: FONT,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      transition: "background 160ms var(--ease)",
    },
    onclick: (e: Event) => { e.stopPropagation(); toggleJumpMenu(); },
  });
  counter.addEventListener("mouseenter", () =>
    counter.style.background = "rgba(255,245,232,0.08)");
  counter.addEventListener("mouseleave", () =>
    counter.style.background = "transparent");

  const divider = () => el("div", {
    style: { width: "1px", height: "22px", margin: "0 6px",
             background: "rgba(255,245,232,0.12)" },
  });

  const undoBtn = iconBtn({ icon: ICONS.undo, title: "Undo (⌘Z)",
    onClick: doUndo });
  const redoBtn = iconBtn({ icon: ICONS.redo, title: "Redo (⇧⌘Z)",
    onClick: doRedo });
  const editBtn = iconBtn({ icon: ICONS.pencil, title: "Edit (E)",
    onClick: toggleEdit });
  const fsBtn = iconBtn({ icon: ICONS.expand, title: "Present (F)",
    onClick: togglePresent });

  // The divider on the trailing side of the undo/redo pair is captured
  // so we can hide it alongside the buttons when not in edit mode.
  const undoDivider = divider();
  bar.appendChild(prev);
  bar.appendChild(counter);
  bar.appendChild(next);
  bar.appendChild(divider());
  bar.appendChild(undoBtn);
  bar.appendChild(redoBtn);
  bar.appendChild(undoDivider);
  bar.appendChild(editBtn);
  bar.appendChild(fsBtn);
  stageWrap.appendChild(bar);

  // Floating exit-present button.
  const exitBtn = el("button", {
    title: "Exit presentation (Esc / F)",
    "aria-label": "Exit presentation",
    "data-icon-btn": "1",
    onclick: togglePresent,
    style: {
      position: "absolute", top: "16px", right: "16px",
      width: "38px", height: "38px",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(20,12,8,0.55)", color: "#f5e7d6",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "999px", cursor: "pointer", padding: "0",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      opacity: "0",
      transition: "opacity 180ms var(--ease), background 160ms var(--ease)",
      zIndex: "12",
    } as VendorStyle,
  });
  exitBtn.innerHTML = ICONS.collapse;
  exitBtn.addEventListener("mouseenter", () => exitBtn.style.opacity = "1");
  exitBtn.addEventListener("mouseleave", () => exitBtn.style.opacity = "0");
  stageWrap.appendChild(exitBtn);

  // Jump menu (number grid)
  const jumpMenu = el("div", {
    id: "jumpMenu",
    style: {
      position: "absolute", left: "50%", bottom: "78px",
      transform: "translateX(-50%)",
      display: "none",
      gridTemplateColumns: "repeat(6, 38px)",
      gap: "6px", padding: "10px",
      background: "rgba(20,12,8,0.92)",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "14px",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
      zIndex: "11",
    } as VendorStyle,
  });
  stageWrap.appendChild(jumpMenu);
  document.addEventListener("click", (e) => {
    if (jumpMenu.style.display !== "none" &&
        !(e.target instanceof Node && jumpMenu.contains(e.target)) && e.target !== counter) {
      jumpMenu.style.display = "none";
    }
  });

  shellRef.root = root;
  shellRef.leftPanel = leftPanel;
  shellRef.rightPanel = rightPanel;
  shellRef.inspectorBody = inspectorBody;
  shellRef.slideList = slideList;
  shellRef.counter = counter;
  shellRef.bar = bar;
  shellRef.exitBtn = exitBtn;
  shellRef.jumpMenu = jumpMenu;
  shellRef.editBtn = editBtn;
  shellRef.fsBtn = fsBtn;
  shellRef.undoBtn = undoBtn;
  shellRef.redoBtn = redoBtn;
  shellRef.undoDivider = undoDivider;
  updateUndoButtons();

  const printDeck = el("div", { id: "printDeck", "data-print-root": "slides" });
  shellRef.printDeck = printDeck;
  document.body.appendChild(root);
  document.body.appendChild(printDeck);

  const fit = () => {
    const w = stageWrap.clientWidth;
    const h = stageWrap.clientHeight;
    if (!w || !h) return;
    if (presenting) {
      setStageScale(Math.min(w / 1200, h / 675));
      stage.style.transform = `translate(-50%, -50%) scale(${stageScale})`;
      stage.style.borderRadius = "0";
      stage.style.boxShadow = "none";
    } else {
      setStageScale(Math.min((w - 48) / 1200, (h - 120) / 675));
      stage.style.transform = `translate(-50%, -50%) scale(${stageScale})`;
      stage.style.borderRadius = "18px";
      stage.style.boxShadow = "0 10px 28px rgba(43, 28, 20, 0.14)";
    }
  };
  shellRef.fit = fit;
  window.addEventListener("resize", fit);
  setTimeout(fit, 0);

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLElement && (e.target.isContentEditable ||
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT")) return;
    const mod = e.metaKey || e.ctrlKey;
    // Undo / redo work outside edit mode too (you might still want to
    // roll back a stray change), so check these before the edit-only
    // clipboard handlers below.
    if (mod && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "y") {
      // Windows-style redo.
      e.preventDefault(); doRedo(); return;
    }
    // Clipboard shortcuts (edit mode only). Handled before the bare-key
    // branches so Ctrl+C / Cmd+C never get swallowed by the "f"/"e"
    // toggles below.
    if (editMode && mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        if (selectedBlockId) { e.preventDefault(); copySelectedBlock(); }
        return;
      }
      if (k === "x") {
        if (selectedBlockId) { e.preventDefault(); cutSelectedBlock(); }
        return;
      }
      if (k === "v") {
        if (clipboardBlock) { e.preventDefault(); pasteClipboardBlock(); }
        return;
      }
      if (k === "d") {
        if (selectedBlockId) { e.preventDefault(); duplicateSelectedBlock(); }
        return;
      }
    }
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ")
      { e.preventDefault(); go(currentIndex + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp")
      { e.preventDefault(); go(currentIndex - 1); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End")  go(deck.slides.length - 1);
    else if (e.key === "e" || e.key === "E") toggleEdit();
    else if (e.key === "f" || e.key === "F") togglePresent();
    else if ((e.key === "Delete" || e.key === "Backspace") &&
             editMode && selectedBlockId) {
      e.preventDefault();
      const slide = currentSlide();
      const block = slide && slide.blocks.find(b => b.id === selectedBlockId);
      if (block) {
        slide!.blocks = slide!.blocks.filter(b => b.id !== block.id);
        setSelectedBlockId(null);
        gadget.removeBlock(slide!.id, block.id);
        render(); renderInspector();
      }
    } else if (e.key === "Escape") {
      if (jumpMenu.style.display === "grid") jumpMenu.style.display = "none";
      else if (selectedBlockId) selectBlock(null);
      else if (presenting) togglePresent();
    }
  });
}
