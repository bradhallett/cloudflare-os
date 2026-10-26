/** Block clipboard (copy/cut/paste/duplicate) and server-side undo/redo. The clipboard lives only in this tab; the undo stack lives on the server and is shared across clients. */

import { currentSlide } from "./canvas.ts";
import { renderInspector } from "./inspector.ts";
import type { BlockInput, GadgetStub } from "./protocol.ts";
import { render } from "./slideList.ts";
import { canRedo, canUndo, clipboardBlock, editMode, selectedBlockId, setClipboardBlock, setSelectedBlockId, shellRef } from "./state.ts";


// The RPC stub binding the Workshop's iframe bootstrap defines before this module
// runs. client.ts declares it too; ambient declarations are file-scoped.
declare const gadget: GadgetStub;

/* ====================== Clipboard ========================================
 *
 * Copy/cut/paste of a single selected block. The clipboard is in-memory
 * (per-tab) — no cross-deck or cross-tab paste, which keeps the model
 * dead simple. Paste inserts onto the *current* slide (not the one the
 * block was copied from) and offsets the position so the new block is
 * visibly distinct from its source. The pasted block is selected.
 * ----------------------------------------------------------------------- */

export function copySelectedBlock(): boolean {
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return false;
  const block = slide.blocks.find(b => b.id === selectedBlockId);
  if (!block) return false;
  // Deep clone & strip id — paste mints a new one.
  const clone: BlockInput = JSON.parse(JSON.stringify(block));
  delete clone.id;
  setClipboardBlock(clone);
  return true;
}

export async function cutSelectedBlock(): Promise<void> {
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return;
  if (!copySelectedBlock()) return;
  const blockId = selectedBlockId;
  slide.blocks = slide.blocks.filter(b => b.id !== blockId);
  setSelectedBlockId(null);
  await gadget.removeBlock(slide.id, blockId);
  render(); renderInspector();
}

export async function pasteClipboardBlock(): Promise<void> {
  if (!clipboardBlock) return;
  const slide = currentSlide();
  if (!slide) return;
  const copy: BlockInput = JSON.parse(JSON.stringify(clipboardBlock));
  delete copy.id;
  // Nudge so the pasted block doesn't sit perfectly on top of its source.
  // Arrows have x/y=0 (full-bleed); for them, shift the endpoints instead.
  if (copy.type === "arrow" && copy.props) {
    copy.props = { ...copy.props,
      x1: (copy.props.x1 ?? 0) + 24, y1: (copy.props.y1 ?? 0) + 24,
      x2: (copy.props.x2 ?? 0) + 24, y2: (copy.props.y2 ?? 0) + 24,
    };
  } else {
    copy.x = (copy.x ?? 0) + 24;
    copy.y = (copy.y ?? 0) + 24;
  }
  const newId = await gadget.addBlock(slide.id, copy);
  // null: the slide is gone -- deleted by another client, whose deck update has already
  // replaced ours -- so there is nothing to add locally.
  if (newId === null) return;
  slide.blocks.push({ ...copy, id: newId });
  setSelectedBlockId(newId);
  render(); renderInspector();
}

export async function duplicateSelectedBlock(): Promise<void> {
  // Equivalent to copy + paste-to-same-slide, but doesn't disturb the
  // clipboard. Mirrors the inspector's duplicate icon button.
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return;
  const block = slide.blocks.find(b => b.id === selectedBlockId);
  if (!block) return;
  const copy: BlockInput = JSON.parse(JSON.stringify(block));
  delete copy.id;
  if (copy.type === "arrow" && copy.props) {
    copy.props = { ...copy.props,
      x1: (copy.props.x1 ?? 0) + 24, y1: (copy.props.y1 ?? 0) + 24,
      x2: (copy.props.x2 ?? 0) + 24, y2: (copy.props.y2 ?? 0) + 24,
    };
  } else {
    copy.x = (copy.x ?? 0) + 24;
    copy.y = (copy.y ?? 0) + 24;
  }
  const newId = await gadget.addBlock(slide.id, copy);
  // null: the slide is gone -- deleted by another client, whose deck update has already
  // replaced ours -- so there is nothing to add locally.
  if (newId === null) return;
  slide.blocks.push({ ...copy, id: newId });
  setSelectedBlockId(newId);
  render(); renderInspector();
}

/* ====================== Undo / redo ======================================
 *
 * The undo stack lives on the server (see #save in server.js). It's a
 * global history for the deck shared across every connected client —
 * pressing undo here rolls back the most recent mutation made by ANY
 * client. This matches how a shared document feels: one timeline that
 * everyone agrees on. Buttons reflect server-reported availability and
 * are updated on every broadcast.
 * ----------------------------------------------------------------------- */

export async function doUndo(): Promise<void> {
  if (!canUndo) return;
  try { await gadget.undo(); } catch {}
  // The server will broadcast the new deck state (and updated meta) via
  // the subscriber; no local state changes are needed here.
}

export async function doRedo(): Promise<void> {
  if (!canRedo) return;
  try { await gadget.redo(); } catch {}
}

export function updateUndoButtons(): void {
  // Undo/redo are an editing concern, so the buttons (and their flanking
  // divider) are hidden entirely outside edit mode. The keyboard
  // shortcuts still work everywhere — they're cheap and harmless.
  const show = editMode;
  if (shellRef.undoDivider) {
    shellRef.undoDivider.style.display = show ? "block" : "none";
  }
  for (const [b, enabled] of [[shellRef.undoBtn, canUndo],
                              [shellRef.redoBtn, canRedo]] as const) {
    if (!b) continue;
    b.style.display = show ? "inline-flex" : "none";
    b.style.opacity = enabled ? "1" : "0.32";
    b.style.pointerEvents = enabled ? "auto" : "none";
    b.style.cursor = enabled ? "pointer" : "default";
  }
}
