// The cursor behind every Notion listing is the kit's `TokenCursor` shaped by `notionCursor()`:
// one provider page per `next()`, each authorized before it leaves. These tests pin the adapter's
// own contract — above all that a provider which echoes its continuation token is refused instead
// of paging forever (the private cursor this replaced looped on one). Notion is not faked here;
// these run in Node, so the Workers hosting surface is mocked (as in reconnect.test.ts).

import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Target { [Symbol.dispose]() {} }
  class Stub { dup() { return this; } }
  return { RpcTarget: Target, RpcStub: Stub };
});

// Loaded dynamically so the vi.mock above is in effect first; a static import of the adapter
// (which pulls in the mocked Workers surface) would race the mock registry.
const { notionCursor } = await import("../src/notion-cursor");

/** One scripted provider page: rows, the next continuation token, and an authorization ledger. */
type Scripted = { items: string[]; nextCursor: string | undefined };

describe("notionCursor", () => {
  it("serves whole provider pages, passes firstPage only on the first, and ends at null", async () => {
    const script: Record<string, Scripted> = {
      undefined: { items: ["a", "b"], nextCursor: "p2" },
      p2: { items: [], nextCursor: "p3" }, // empty mid-walk page: still emitted, walk continues
      p3: { items: ["c"], nextCursor: undefined },
    };
    const authorized: string[][] = [];
    const firstPages: boolean[] = [];
    const cursor = notionCursor<string>(async (cursor, firstPage) => {
      firstPages.push(firstPage);
      const page = script[String(cursor)];
      if (page === undefined) throw new Error(`unexpected cursor ${String(cursor)}`);
      return { ...page, authorize: async () => { authorized.push(page.items); } };
    });
    expect(await cursor.next()).toEqual(["a", "b"]);
    expect(await cursor.next()).toEqual([]); // a spent window, not the walk's end
    expect(await cursor.next()).toEqual(["c"]);
    expect(await cursor.next()).toBeNull();
    expect(await cursor.next()).toBeNull();
    expect(firstPages).toEqual([true, false, false]);
    expect(authorized).toEqual([["a", "b"], [], ["c"]]); // each page authorized once, before it returned
  });

  it("authorizes a walk that finds nothing, as its final answer", async () => {
    const authorized: string[][] = [];
    const cursor = notionCursor<string>(async () => ({
      items: [], nextCursor: undefined,
      authorize: async () => { authorized.push([]); },
    }));
    expect(await cursor.next()).toBeNull(); // the empty final page folds into the walk's end
    expect(authorized).toEqual([[]]);
  });

  it("refuses a provider that echoes the token it was asked to continue from", async () => {
    const fetches: (string | undefined)[] = [];
    const cursor = notionCursor<string>(async cursor => {
      fetches.push(cursor);
      return { items: ["row"], nextCursor: "stuck", authorize: async () => {} };
    });
    expect(await cursor.next()).toEqual(["row"]);
    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    expect(fetches).toEqual([undefined, "stuck"]); // refused on the second fetch; no loop
  });

  it("refuses a provider that loops back to a token the walk already followed", async () => {
    const tokens = ["b", "c", "b"]; // the third page points back at the second fetch's result
    let call = 0;
    const cursor = notionCursor<string>(async () => ({
      items: [String(call)], nextCursor: tokens[call++], authorize: async () => {},
    }));
    expect(await cursor.next()).toEqual(["0"]);
    expect(await cursor.next()).toEqual(["1"]);
    await expect(cursor.next()).rejects.toThrow(/already followed/);
  });

  it("holds a refused page and re-authorizes it without refetching", async () => {
    let fetches = 0;
    let refusals = 0;
    const cursor = notionCursor<string>(async () => {
      fetches++;
      return {
        items: ["secret"], nextCursor: undefined,
        authorize: async () => {
          if (refusals++ === 0) throw new Error("refused");
        },
      };
    });
    await expect(cursor.next()).rejects.toThrow("refused");
    expect(await cursor.next()).toEqual(["secret"]); // the retry re-offers the same page
    expect(fetches).toBe(1);
  });
});
