/** Deck-editing commands: add block, add/move/duplicate/remove slide. Each re-reads the deck from the server and re-renders. */

import { currentSlide } from "./canvas.ts";
import { COMPONENTS } from "./components.ts";
import type { BlockDefaults } from "./components.ts";
import { renderInspector } from "./inspector.ts";
import type { Block, BlockInput, GadgetStub, SlideInput } from "./protocol.ts";
import { render, renderSlideList, updateCounter } from "./slideList.ts";
import { currentIndex, deck, setCurrentIndex, setDeck, setSelectedBlockId } from "./state.ts";
import type { SlideTemplate } from "./templates.ts";


// The RPC stub binding the Workshop's iframe bootstrap defines before this module
// runs. client.ts declares it too; ambient declarations are file-scoped.
declare const gadget: GadgetStub;

/* ====================== Add block ======================================== */

export async function addBlockOfType(type: string): Promise<void> {
  const slide = currentSlide();
  if (!slide) return;
  const def = COMPONENTS[type];
  const base: BlockDefaults = def.defaultBlock ? def.defaultBlock() : { x: 100, y: 200, props: {} };
  // Offset successive added blocks so they don't stack.
  const sameType = slide.blocks.filter(b => b.type === type).length;
  base.x = (base.x ?? 100) + sameType * 16;
  base.y = (base.y ?? 200) + sameType * 16;
  const block: BlockInput = { type, ...base };
  const id = await gadget.addBlock(slide.id, block);
  // null: the slide is gone -- deleted by another client, whose deck update has already replaced
  // ours -- so there is nothing to add locally.
  if (id === null) return;
  block.id = id;
  slide.blocks.push(block as Block);
  setSelectedBlockId(id);
  render(); renderInspector();
}

/* ====================== Slide ops UI ===================================== */

/* Add a slide after the current one. Pass a template object (e.g.
 * makeTitleSlide() / makeContentSlide()) to seed its layout; omit it for a
 * blank content slide (server's newBlankSlide, which is a cover). */
export async function addSlide(template?: SlideTemplate): Promise<void> {
  const seed: SlideInput | undefined = template ? JSON.parse(JSON.stringify(template)) : undefined;
  const id = await gadget.addSlide(currentIndex + 1, seed);
  const newDeck = await gadget.getDeck();
  setDeck(newDeck);
  const i = deck.slides.findIndex(s => s.id === id);
  if (i >= 0) setCurrentIndex(i);
  setSelectedBlockId(null);
  render(); renderSlideList(); renderInspector(); updateCounter();
}
export async function moveSlideTo(fromIndex: number, toIndex: number): Promise<void> {
  if (fromIndex === toIndex) return;
  const slide = deck.slides[fromIndex];
  if (!slide) return;
  // Optimistic local update so the list doesn't flicker.
  const [s] = deck.slides.splice(fromIndex, 1);
  deck.slides.splice(toIndex, 0, s);
  if (currentIndex === fromIndex) setCurrentIndex(toIndex);
  else if (fromIndex < currentIndex && toIndex >= currentIndex) setCurrentIndex(currentIndex - 1);
  else if (fromIndex > currentIndex && toIndex <= currentIndex) setCurrentIndex(currentIndex + 1);
  await gadget.moveSlide(slide.id, toIndex);
  renderSlideList(); updateCounter();
}

export async function duplicateSlideById(slideId: string): Promise<void> {
  const newId = await gadget.duplicateSlide(slideId);
  setDeck(await gadget.getDeck());
  const i = deck.slides.findIndex(s => s.id === newId);
  if (i >= 0) setCurrentIndex(i);
  setSelectedBlockId(null);
  render(); renderSlideList(); renderInspector(); updateCounter();
}

export async function removeSlideById(slideId: string): Promise<void> {
  const wasCurrent = currentSlide()?.id === slideId;
  await gadget.removeSlide(slideId);
  setDeck(await gadget.getDeck());
  if (wasCurrent) setCurrentIndex(Math.min(currentIndex, deck.slides.length - 1));
  setSelectedBlockId(null);
  render(); renderSlideList(); renderInspector(); updateCounter();
}

