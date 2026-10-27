/** The deck editor's shared mutable state: the deck document, selection, modes, panel filters, and the in-tab block clipboard, plus the long-lived shell/stage element refs. The lets are exported as live bindings (reads stay `deck.slides`-style); writes go through the setters so every module sees the same values. */

import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { BlockInput, Deck } from "./protocol.ts";

/* ----------------------- App state --------------------------------------- */
export let deck: Deck      = { slides: [] };
export let currentIndex    = 0;
export let editMode        = false;
export let presenting      = false;
export let selectedBlockId: string | null = null;
export let stageScale      = 1;
export let advancedOpen    = false;   // remembered across inspector re-renders
export let librarySearch   = "";      // filter text for component library
export let slideSearch     = "";      // filter text for slide list
// In-memory clipboard for copy/cut/paste of a single block (edit mode only).
// We store a deep clone WITHOUT the id so paste always produces a fresh block.
// Lives only in this tab — not persisted, not shared between clients, since
// "copy a block from one deck and paste it into another" isn't a real flow.
export let clipboardBlock: BlockInput | null = null;
// Server-side undo/redo availability, refreshed whenever the deck changes
// (or via getUndoState() at boot). The undo stack lives on the server and
// is shared across all connected clients — a global history for the deck.
export let canUndo         = false;
export let canRedo         = false;

export const stageRef: { el: HTMLDivElement | null; wrap: HTMLDivElement | null } = { el: null, wrap: null };

/* The shell's long-lived elements, filled in by mountShell(). */
interface ShellRefs {
  root?: HTMLDivElement;
  leftPanel?: HTMLDivElement;
  rightPanel?: HTMLDivElement;
  inspectorBody?: HTMLDivElement;
  slideList?: HTMLDivElement;
  counter?: HTMLButtonElement;
  bar?: HTMLDivElement;
  exitBtn?: HTMLButtonElement;
  jumpMenu?: HTMLDivElement;
  editBtn?: HTMLButtonElement;
  fsBtn?: HTMLButtonElement;
  undoBtn?: HTMLButtonElement;
  redoBtn?: HTMLButtonElement;
  undoDivider?: HTMLDivElement;
  printDeck?: HTMLDivElement;
  fit?: () => void;
}
export const shellRef: ShellRefs = {};

// Setters: writes from other modules go through these so the exported live bindings
// stay coherent.
/** Assigns {@link deck}. */
export function setDeck(next: Deck): void { deck = next; }

/** Assigns {@link currentIndex}. */
export function setCurrentIndex(next: number): void { currentIndex = next; }

/** Assigns {@link editMode}. */
export function setEditMode(next: boolean): void { editMode = next; }

/** Assigns {@link presenting}. */
export function setPresenting(next: boolean): void { presenting = next; }

/** Assigns {@link selectedBlockId}. */
export function setSelectedBlockId(next: string | null): void { selectedBlockId = next; }

/** Assigns {@link stageScale}. */
export function setStageScale(next: number): void { stageScale = next; }

/** Assigns {@link advancedOpen}. */
export function setAdvancedOpen(next: boolean): void { advancedOpen = next; }

/** Assigns {@link librarySearch}. */
export function setLibrarySearch(next: string): void { librarySearch = next; }

/** Assigns {@link slideSearch}. */
export function setSlideSearch(next: string): void { slideSearch = next; }

/** Assigns {@link clipboardBlock}. */
export function setClipboardBlock(next: BlockInput | null): void { clipboardBlock = next; }

/** Assigns {@link canUndo}. */
export function setCanUndo(next: boolean): void { canUndo = next; }

/** Assigns {@link canRedo}. */
export function setCanRedo(next: boolean): void { canRedo = next; }

