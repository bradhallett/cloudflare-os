/* =========================================================================
 *  Gadgets Slide Builder
 *  -----------------------------------------------------------------------
 *  The deck is data. Each slide is `{ id, background, blocks: [...] }`.
 *  Each block is `{ id, type, x, y, w?, h?, props }`. Components live in
 *  the COMPONENTS registry below; adding a new block type means adding a
 *  new entry there.
 *
 *  Edit mode (E) reveals:
 *    - left panel: search box + slide thumbnails (drag to reorder,
 *      hover for actions) with a one-line title under each
 *    - right panel:
 *        · filterable component library (search + grouped list)
 *        · slide background settings
 *        · inspector for the selected block (or empty hint)
 *    - draggable + resizable blocks with inline editable text
 *
 *  Present mode (F) hides all chrome and fills the viewport.
 *
 *  The element builder, the two image-reading steps and the subscriber
 *  `RpcTarget` come from the shared `ui` and `sync` libraries, imported by
 *  this package's name and inlined into the bundle by the build. Everything
 *  else — the design tokens, the COMPONENTS registry, the slide renderer and
 *  the builder shell — is this deck's own, in the sibling `lib/` modules this
 *  entry mounts.
 * ========================================================================= */
import { createSubscriber } from "@gadgets/bundled-blueprints/libraries/sync/client";
import type { SyncHost } from "@gadgets/bundled-blueprints/libraries/sync/client";
import { currentSlide } from "./lib/canvas.ts";
import { updateUndoButtons } from "./lib/history.ts";
import { renderInspector } from "./lib/inspector.ts";
import type { DeckCallbacks, GadgetStub } from "./lib/protocol.ts";
import { mountShell } from "./lib/shell.ts";
import { render, renderPrintDeck, renderSlideList, updateCounter } from "./lib/slideList.ts";
import { currentIndex, deck, selectedBlockId, setCanRedo, setCanUndo, setCurrentIndex, setDeck, setSelectedBlockId, shellRef } from "./lib/state.ts";


const isSlidesExport = ["html", "pdf"].includes((globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId ?? "");
if (isSlidesExport) document.documentElement.classList.add("slides-export");
declare const gadget: GadgetStub;
declare const RpcTarget: SyncHost["RpcTarget"];
/* ====================== Realtime ========================================= */

/* The object the Durable Object calls back. The sync library builds it over
 * the bootstrap's RpcTarget, so the callback lands on the prototype, which is
 * the only place the RPC layer looks. */
const subscriber = () => createSubscriber<DeckCallbacks>(RpcTarget, {
  deckChanged(newDeck, meta) {
    // The server passes `{canUndo, canRedo}` as a second arg; refresh
    // the button state alongside the rest of the UI. (Old/missing meta
    // is tolerated for forward-compat.)
    if (meta) {
      setCanUndo(!!meta.canUndo);
      setCanRedo(!!meta.canRedo);
      updateUndoButtons();
    }
    // Preserve selection & index when possible.
    const prevSlideId = currentSlide()?.id;
    setDeck(newDeck);
    if (prevSlideId) {
      const i = deck.slides.findIndex(s => s.id === prevSlideId);
      if (i >= 0) setCurrentIndex(i);
      else setCurrentIndex(Math.min(currentIndex, deck.slides.length - 1));
    } else {
      setCurrentIndex(Math.min(currentIndex, deck.slides.length - 1));
    }
    // If selected block is gone, drop it.
    if (selectedBlockId) {
      const s = currentSlide();
      if (!s || !s.blocks.find(b => b.id === selectedBlockId))
        setSelectedBlockId(null);
    }
    render(); renderSlideList(); renderInspector(); updateCounter();
  },
});

/* ====================== Boot ============================================= */


  try {
    setDeck((await gadget.getDeck()) || { slides: [] });
  } catch (e) { setDeck({ slides: [] }); }
  try { await gadget.subscribe(subscriber()); } catch (e) {}
  mountShell();
  updateCounter();
  render();
  renderSlideList();
  if (isSlidesExport) {
    renderPrintDeck();
    shellRef.root!.remove();
  }
  // Initial undo-button state. Subsequent updates piggy-back on
  // deckChanged broadcasts.
  try {
    const s = await gadget.getUndoState();
    setCanUndo(!!s?.canUndo); setCanRedo(!!s?.canRedo);
    updateUndoButtons();
  } catch {}

