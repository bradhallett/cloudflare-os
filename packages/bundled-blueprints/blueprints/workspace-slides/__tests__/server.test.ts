// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";

// The Slides Durable Object over in-memory storage: the contract its client relies on for adding
// blocks. A real instance, since the class keeps private methods, over a state that is only the
// storage the gadget reads and writes -- the `cloudflare:workers` stub vitest.config.ts aliases in
// accepts it, where the runtime's base would refuse a state that is not a real DurableObjectState.
// Real DO storage structured-clones on every get, so a mutator never aliases the stored object
// (two unfenced mutators would then edit one shared deck and the queue tests would pass vacuously).
// The fake clones too, for the same semantics.
function inMemoryState(deck: unknown) {
  const stored = new Map<string, unknown>([["deck", deck]]);
  const state = {
    storage: {
      get: async (key: string) => {
        const value = stored.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      put: async (key: string, value: unknown) => { stored.set(key, value); },
    },
  } as unknown as DurableObjectState;
  return { state, stored };
}

function inMemoryGadget(deck: unknown) {
  return new Gadget(inMemoryState(deck).state, {});
}

// The stored shape getDeck() accepts as current; older shapes convert in place (below).
const deck = () => ({ themeVersion: "workspace.1", slides: [{ id: "s1", background: {}, blocks: [] }] });

describe("Workspace Slides blocks", () => {

  it("seeds bottom brand bars as editable shapes", async () => {
    const seeded = await inMemoryGadget(undefined).getDeck();
    const bars = seeded.slides.flatMap(slide => slide.blocks).filter(block =>
      block.x === 0 && block.y === 663 && block.w === 1200 && block.h === 12);

    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar).toMatchObject({
        type: "shape",
        props: {
          kind: "rect",
          fill: "#F6821F",
          stroke: "",
          strokeWidth: 0,
          radius: 0,
          opacity: 1,
        },
      });
    }
  });

  it("adds a block to a slide and returns its id", async () => {
    const gadget = inMemoryGadget(deck());
    const id = await gadget.addBlock("s1", { type: "text", x: 10, y: 20, props: { text: "hi" } });
    expect(id).toMatch(/^[0-9a-f-]{8}$/);
    const saved = await gadget.getDeck();
    expect(saved.slides[0]!.blocks).toEqual([{ id, type: "text", x: 10, y: 20, props: { text: "hi" } }]);
  });

  // setDeck is reached over the GADGET binding with a deck built from the public type, on which
  // the marker is optional; without the stamp the next getDeck would reseed and the deck be lost.
  it("keeps a deck set without the schema marker", async () => {
    const gadget = inMemoryGadget(undefined);
    await gadget.setDeck({ slides: [{ id: "s9", background: {}, blocks: [] }] });
    expect((await gadget.getDeck()).slides.map(slide => slide.id)).toEqual(["s9"]);
  });

  it("returns null, and stores nothing, for a slide that no longer exists", async () => {
    const gadget = inMemoryGadget(deck());
    expect(await gadget.addBlock("gone", { type: "text", x: 0, y: 0, props: {} })).toBeNull();
    expect((await gadget.getDeck()).slides[0]!.blocks).toEqual([]);
  });
});

describe("Workspace Slides mutation queue", () => {
  // Two mutators whose RPCs interleave at the first await: without the sync library's queue
  // both would read the same stored deck and the second store would silently drop the first
  // mutation's block (BP-1).
  it("keeps both of two concurrent block adds", async () => {
    const gadget = inMemoryGadget(deck());
    await Promise.all([
      gadget.addBlock("s1", { type: "text", x: 0, y: 0, props: { text: "first" } }),
      gadget.addBlock("s1", { type: "text", x: 0, y: 1, props: { text: "second" } }),
    ]);
    const saved = await gadget.getDeck();
    expect(saved.slides[0]!.blocks.map(b => b.props)).toEqual([{ text: "first" }, { text: "second" }]);
  });

  it("keeps a mutation that races a whole-deck replace", async () => {
    const gadget = inMemoryGadget(deck());
    await Promise.all([
      gadget.setDeck(deck()),
      gadget.addBlock("s1", { type: "text", x: 0, y: 0, props: { text: "kept" } }),
    ]);
    const saved = await gadget.getDeck();
    // Queue order is call order: the add landed on the deck the replace wrote, not on the
    // pre-replace snapshot an unfenced pair of RPCs would both have read.
    expect(saved.slides[0]!.blocks.map(b => b.props)).toEqual([{ text: "kept" }]);
  });
});

describe("Workspace Slides deck migration", () => {
  it("converts an older deck in place instead of wiping it (BP-2)", async () => {
    // A `slides` deck that predates the version marker: same shape, no stamp.
    const older = { slides: [{ id: "kept", background: {}, blocks: [] }] };
    const { state, stored } = inMemoryState(older);
    const gadget = new Gadget(state, {});

    const loaded = await gadget.getDeck();

    expect(loaded.slides.map(slide => slide.id)).toEqual(["kept"]);  // content kept, not seeded
    expect(loaded.themeVersion).toBe("workspace.1");                 // stamped current
    const persisted = stored.get("deck") as { slides: { id: string }[] };
    expect(persisted.slides.map(slide => slide.id)).toEqual(["kept"]);
  });

  it("preserves an uninterpretable legacy deck under a side key while seeding a fresh one", async () => {
    // The pre-`slides` schema (field overrides under numeric keys) predates this source tree;
    // it cannot be converted, but it must not be destroyed either.
    const legacy = { "1": { title: "old" }, "2": { title: "older" } };
    const { state, stored } = inMemoryState(legacy);
    const gadget = new Gadget(state, {});

    const loaded = await gadget.getDeck();

    expect(loaded.slides.length).toBeGreaterThan(0);        // a usable current deck
    expect(loaded.themeVersion).toBe("workspace.1");
    expect(stored.get("deck:legacy-v0")).toEqual(legacy);   // the old bytes survive
  });
});
