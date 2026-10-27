import { describe, expect, it, vi } from "vitest";
import type {
  GatekeeperUserVerifier,
  GitCache,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import {
  ArrayCursor,
  PageCursor,
  PageHookCursor,
  requestedPageSize,
  TokenCursor,
  type ProviderPage,
  type TokenPage,
} from "../../src/cursors";
import { ObservationGate, trackedCollectionObservers } from "../../src/observers";
import { fakeKv } from "../fake-kv";

type Issue = { id: number; open: boolean };

/** A real authorizer, so a gate built from its stub is type-checked rather than cast into place. */
class TestAuthorizer extends RpcTarget implements ObservationAuthorizer {
  readonly #seen: string[];

  constructor(seen: string[]) {
    super();
    this.#seen = seen;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (description.excludeObservers?.length) {
      throw new Error(`cannot hide from ${description.excludeObservers.join(", ")}`);
    }
    this.#seen.push(description.description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Git cache is not used in this test.");
  }
}

/**
 * A stub over a fresh `TestAuthorizer` and the descriptions it accepted. Annotated, never cast: a
 * gate demanding the whole approval queue would fail to compile against it.
 */
function makeAuthorizer(): { authorizer: RpcStub<ObservationAuthorizer>; seen: string[] } {
  const seen: string[] = [];
  return { authorizer: new RpcStub(new TestAuthorizer(seen)), seen };
}

/** Serves a scripted sequence of token pages; past the end the provider reports exhaustion. */
function tokenApi(pages: TokenPage<Issue>[]) {
  let index = 0;
  return vi.fn(async (_token: string | undefined, _perPage: number) =>
    pages[index++] ?? { items: [] });
}

/** Five four-row token pages ending without a token, so a full page takes several fetches. */
function fourRowTokenApi() {
  const page = (ids: number[], nextToken?: string): TokenPage<Issue> =>
    ({ items: ids.map(id => ({ id, open: true })), nextToken });
  return tokenApi([
    page([1, 2, 3, 4], "a"), page([5, 6, 7, 8], "b"), page([9, 10, 11, 12], "c"),
    page([13, 14, 15, 16], "d"), page([17, 18, 19, 20]),
  ]);
}

// Cursors must authorize the exact page they return; tests that assert on it pass their own.
const authorizePage = async () => {};

const ids = (page: Issue[] | null) => page?.map(issue => issue.id);

describe("ArrayCursor", () => {
  it("pages a held list, then reports the end", async () => {
    const cursor = new ArrayCursor([1, 2, 3], 2);

    expect(await cursor.next()).toEqual([1, 2]);
    expect(await cursor.next()).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("reports the end immediately for an empty list", async () => {
    expect(await new ArrayCursor([], 2).next()).toBeNull();
  });

  it("rejects a page size that would never terminate", () => {
    expect(() => new ArrayCursor([1], 0)).toThrow(/positive safe integer/);
    expect(() => new ArrayCursor([1], 1.5)).toThrow(/positive safe integer/);
  });
});

describe("requestedPageSize", () => {
  it("answers the fallback when the caller requested none, and clamps the rest to one remote page", () => {
    expect(requestedPageSize(undefined)).toBe(50);
    expect(requestedPageSize(undefined, 20)).toBe(20);
    expect(requestedPageSize({ resultsPerPage: 7 })).toBe(7);
    expect(requestedPageSize({ resultsPerPage: 500 })).toBe(100);
  });

  it("refuses a request a cursor could never terminate on", () => {
    expect(() => requestedPageSize({ resultsPerPage: 0 })).toThrow(/resultsPerPage must be a positive integer/);
    expect(() => requestedPageSize({ resultsPerPage: 2.5 })).toThrow(/resultsPerPage must be a positive integer/);
  });
});

describe("TokenCursor", () => {
  it("walks until the token is absent, not until a page is empty", async () => {
    // Marketo's shape: an empty window mid-walk, and `""` as a real continuation token. Ending on
    // either -- as page-number paging must -- silently truncates the walk.
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [], nextToken: "b" },
      { items: [{ id: 3, open: true }], nextToken: "" },
      { items: [{ id: 4, open: true }] },
    ]);
    // The whole walk is four provider pages, so the window must be deep enough to read them all.
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 10, remotePageSize: 25, maxProviderPagesPerCall: 4 });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage.mock.calls).toEqual([
      [undefined, 25], ["a", 25], ["b", 25], ["", 25],
    ]);
  });

  it("ends the call rather than failing on a provider with nothing for this window", async () => {
    // An activity stream answers empty windows for a quiet period, so this is pacing, not a fault.
    const fetchPage = tokenApi([
      ...Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` })),
      { items: [{ id: 1, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, maxProviderPagesPerCall: 10 });

    // `[]` is a legal non-terminal page: only `null` ends a cursor, so the walk survives the cap.
    expect(await cursor.next()).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(10);
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
  });

  it("re-sends the same token after a provider rejection", async () => {
    // The position lives in the cursor, so latching a transient failure would cost the whole walk.
    const asked: (string | undefined)[] = [];
    let attempt = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: async token => {
        asked.push(token);
        if (++attempt === 2) throw new Error("provider 503");
        return { items: [{ id: attempt, open: true }], nextToken: attempt < 3 ? "t2" : undefined };
      },
      authorizePage,
      pageSize: 1,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    await expect(cursor.next()).rejects.toThrow("provider 503");
    expect(ids(await cursor.next())).toEqual([3]);
    expect(asked).toEqual([undefined, "t2", "t2"]);
  });

  it("refuses a provider that echoes the token it was asked to continue from", async () => {
    const fetchPage = vi.fn(async (token: string | undefined): Promise<TokenPage<Issue>> =>
      token === undefined
        ? { items: [{ id: 1, open: true }], nextToken: "same" }
        : { items: [{ id: 2, open: true }], nextToken: token });
    const cursor = new TokenCursor<Issue>({ fetchPage, authorizePage, pageSize: 10 });

    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "same", "same"]);
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [{ id: 3, open: true }, { id: 4, open: true }], nextToken: "b" },
      { items: [{ id: 5, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 2 });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => ids(page))).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "a", "b"]);
  });

  it("releases what the fetch callback owns, once, however often it is disposed", async () => {
    // A callback that duplicates a stub for the walk has nowhere else to release it: the cursor
    // stub's disposal is the only signal that the walk is over.
    const dispose = vi.fn();
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      authorizePage,
      pageSize: 1,
      dispose,
    });
    expect(ids(await cursor.next())).toEqual([1]);

    cursor[Symbol.dispose]();
    cursor[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("authorizes the exact page it returns, including one served from the buffer", async () => {
    const fetchPage = tokenApi([
      { items: [1, 2, 3, 4, 5].map(id => ({ id, open: true })) },
    ]);
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage: authorized, pageSize: 2, remotePageSize: 5 });

    expect(ids(await cursor.next())).toEqual([1, 2]);
    expect(ids(await cursor.next())).toEqual([3, 4]);

    // The second page came out of the buffer with no provider call, and was still authorized.
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(authorized.mock.calls).toEqual([
      [[{ id: 1, open: true }, { id: 2, open: true }], { terminal: false }],
      [[{ id: 3, open: true }, { id: 4, open: true }], { terminal: false }],
    ]);
  });

  it("re-offers a refused page rather than dropping it or re-fetching", async () => {
    const fetchPage = tokenApi([
      { items: [1, 2, 3, 4, 5].map(id => ({ id, open: true })) },
    ]);
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage: async () => {
        if (++call === 2) throw new Error("authorization unavailable");
      },
      pageSize: 2,
      remotePageSize: 5,
    });

    expect(ids(await cursor.next())).toEqual([1, 2]);
    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // The same items, and the provider position never rewound, so it must not be asked again.
    expect(ids(await cursor.next())).toEqual([3, 4]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("re-offers a capped page unchanged, rather than growing what was refused", async () => {
    // A heavily filtered provider caps the window before the page is full. Refilling on retry
    // would hand the approver a larger page than the one they just refused.
    let page = 0;
    const fetchPage = vi.fn(async () => {
      page += 1;
      // The provider caps its window at one row; the connector filters what the caller may see.
      return {
        items: [{ id: page, open: page % 3 === 0 }].filter(issue => issue.open),
        nextToken: page < 10 ? `t${page}` : undefined,
      };
    });
    const offered: number[][] = [];
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      pageSize: 100,
      maxProviderPagesPerCall: 10,
      authorizePage: async items => {
        offered.push(items.map(issue => issue.id));
        if (++call === 1) throw new Error("authorization unavailable");
      },
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    expect(ids(await cursor.next())).toEqual([3, 6, 9]);

    expect(offered).toEqual([[3, 6, 9], [3, 6, 9]]);
    // The held page is served without asking the provider again.
    expect(fetchPage).toHaveBeenCalledTimes(10);
  });

  it("authorizes a spent fetch window, which discloses that the window held nothing", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi(
        Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` }))),
      authorizePage: authorized,
      pageSize: 2,
    });

    // Not terminal: the walk continues, so the caller is told to ask again.
    expect(await cursor.next()).toEqual([]);
    expect(authorized.mock.calls).toEqual([[[], { terminal: false }]]);
  });

  it("still authorizes the terminal answer after empty windows disclosed no rows", async () => {
    // The empty windows were authorized, but none of them answered the query. Treating "authorized
    // something" as "disclosed something" would let the zero-result answer out unaudited.
    const seen: string[] = [];
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        ...Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` })),
        { items: [] },
      ]),
      pageSize: 2,
      maxProviderPagesPerCall: 10,
      authorizePage: async (items, { terminal }) =>
        void seen.push(`${terminal ? "terminal" : "window"}:${items.length}`),
    });

    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toBeNull();

    expect(seen).toEqual(["window:0", "terminal:0"]);
    // Still at most once: exhaustion asked again emits no duplicate.
    expect(await cursor.next()).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("authorizes the zero-result answer a walk that disclosed nothing still gives", async () => {
    // `searchUsers(email) -> no matches` is an existence oracle: it answers a question about
    // provider data, so it cannot reach the gadget unaudited just because no row came back.
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    expect(await cursor.next()).toBeNull();
    expect(authorized.mock.calls).toEqual([[[], { terminal: true }]]);

    // Exhaustion is idempotent: asking again repeats no observation.
    expect(await cursor.next()).toBeNull();
    expect(authorized).toHaveBeenCalledOnce();
  });

  it("does not re-authorize exhaustion for a walk that already returned a page", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
    // The page was authorized; the `null` that follows discloses nothing new.
    expect(authorized.mock.calls).toEqual([[[{ id: 1, open: true }], { terminal: false }]]);
  });

  it("re-authorizes a refused zero-result answer on the next call", async () => {
    let call = 0;
    const authorized = vi.fn(async () => {
      if (++call === 1) throw new Error("authorization unavailable");
    });
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // The refusal left nothing recorded, so the retry must ask again rather than answer silently.
    expect(await cursor.next()).toBeNull();
    expect(authorized).toHaveBeenCalledTimes(2);
  });

  it("drives a real gate through every empty case the documented pattern must survive", async () => {
    // The other tests stub `authorizePage`, so they cannot catch a scope the gate itself refuses.
    // A spent window and an exhausted walk both arrive with no items, and `{ ids: [] }` is refused.
    const { authorizer, seen } = makeAuthorizer();
    using gate = new ObservationGate(
      authorizer,
      // A `sets` scope needs the strategy that actually checks them.
      trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [], nextToken: "w0" },
        { items: [{ id: 1, open: true }] },
      ]),
      pageSize: 2,
      remotePageSize: 1,
      authorizePage: (issues, { terminal }) => issues.length === 0
        ? gate.authorize(
          { title: "Issues", description: terminal ? "None left." : "None visible yet." },
          { kind: "baseline" })
        : gate.authorize(
          { title: "Issues", description: `Read ${issues.length} issues.` },
          { kind: "collections", ids: issues.map(issue => issue.id.toString()) }),
    });

    // A page, then exhaustion. Neither may throw out of the gate.
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
    expect(seen).toEqual(["Read 1 issues."]);
  });

  it("refuses a gated page through a real read-only authorizer stub", async () => {
    // The gate needs only `ObservationAuthorizer` -- exactly what a slash-command handler is given.
    const { authorizer, seen } = makeAuthorizer();
    const strategy = trackedCollectionObservers<string[]>({
      kv: fakeKv(),
      hasCollectionAccess: async (allowed, collectionIds) =>
        collectionIds.map(id => allowed.includes(id)),
    });
    using gate = new ObservationGate(authorizer, strategy);
    await strategy.addObserver("limited", ["s1"] as unknown as Fetcher<GatekeeperUserVerifier>);

    using cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      pageSize: 1,
      authorizePage: issues => gate.authorize(
        { title: "Issues", description: `Read ${issues.length} issues.` },
        { kind: "collections", ids: ["s2"] }),
    });

    // The collaborator cannot see s2, so the derived exclusion refuses the page before its rows
    // reach the caller.
    await expect(cursor.next()).rejects.toThrow("cannot hide from limited");
    expect(seen).toEqual([]);
  });

  it("keeps authorizing after the session that made it is gone", async () => {
    // A cursor is returned to the gadget and walked later, so it outlives the call that made it.
    // Real stubs, so the lease's refcount is workerd's rather than the test's: releasing the
    // session must not close the handle the walk still holds.
    const { authorizer, seen } = makeAuthorizer();
    const session = new ObservationGate(
      authorizer, trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));
    const walk = session.lease();
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [{ id: 1, open: true }], nextToken: "n" },
        { items: [{ id: 2, open: true }] },
      ]),
      pageSize: 1,
      remotePageSize: 1,
      // The cursor takes its own lease and releases it when the walk is dropped.
      authorizePage: items => walk.authorize(
        { title: "Issues", description: `Read ${items.length} issues.` },
        { kind: "collections", ids: items.map(issue => issue.id.toString()) }),
      dispose: () => walk[Symbol.dispose](),
    });

    expect(ids(await cursor.next())).toEqual([1]);
    session[Symbol.dispose]();

    // The walk must neither continue unaudited nor become unusable.
    expect(ids(await cursor.next())).toEqual([2]);
    expect(seen).toEqual(["Read 1 issues.", "Read 1 issues."]);
    cursor[Symbol.dispose]();
  });

  it("releases a lease without disturbing the session that opened it", async () => {
    const { authorizer, seen } = makeAuthorizer();
    using session = new ObservationGate(
      authorizer, trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));

    session.lease()[Symbol.dispose]();

    // The session still holds its own handle, so the walk ending does not end the session.
    await session.authorize({ title: "After", description: "Still open." }, { kind: "baseline" });
    expect(seen).toEqual(["Still open."]);
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = tokenApi([]);
    expect(() => new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 0 })).toThrow(/positive safe integer/);
    expect(() => new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 1.5 }))
      .toThrow(/positive safe integer/);
    expect(() => new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, maxProviderPagesPerCall: 0 }))
      .toThrow(/positive safe integer/);
  });

  it("fetches one provider page per call when bounded to one, returning [] for an empty window", async () => {
    // A provider billing every row fetched must never be read ahead of what the caller asked for.
    const fetchPage = tokenApi([
      { items: [], nextToken: "a" },
      { items: [{ id: 1, open: true }], nextToken: "b" },
      { items: [{ id: 2, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 10, maxProviderPagesPerCall: 1 });

    expect(await cursor.next()).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(ids(await cursor.next())).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(await cursor.next())).toEqual([2]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("authorizes each page before reading past the default two-page refill", async () => {
    // Rows fetched beyond the page a `next()` returns are provider data nothing has approved
    // yet, so the default window stays small: the cursor answers for eight rows before it
    // fetches a third page that a refusal would have made too late to stop.
    const fetchPage = fourRowTokenApi();
    const fetchesWhenAuthorized: number[] = [];
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      // Filling this page takes three four-row provider pages, more than the default window.
      pageSize: 10,
      remotePageSize: 4,
      authorizePage: async () => void fetchesWhenAuthorized.push(fetchPage.mock.calls.length),
    });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // No fetch happened beyond the bound before the page it paid for was authorized.
    expect(fetchesWhenAuthorized).toEqual([2]);

    expect(ids(await cursor.next())).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(fetchesWhenAuthorized).toEqual([2, 4]);

    expect(ids(await cursor.next())).toEqual([17, 18, 19, 20]);
    expect(fetchesWhenAuthorized).toEqual([2, 4, 5]);
    expect(await cursor.next()).toBeNull();
  });

  it("refills a page fully only when the caller opts into a deeper window", async () => {
    const fetchPage = fourRowTokenApi();
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 10, remotePageSize: 4, maxProviderPagesPerCall: 10 });

    // The explicit budget fills the page: three four-row pages reach ten rows in one call.
    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(ids(await cursor.next())).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(await cursor.next()).toBeNull();
  });

  it("serves one provider page per next() without topping up a short page", async () => {
    // fillPage: false is the one-billed-read-per-page contract: a caller draining Slack-sized
    // pages must not pay for a second provider page just to fill out a short local one.
    const fetchPage = fourRowTokenApi();
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage,
      pageSize: 10,
      remotePageSize: 4,
      fillPage: false,
    });

    // Each next() returns exactly the four rows one provider page carried, despite pageSize 10.
    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4]);
    expect(ids(await cursor.next())).toEqual([5, 6, 7, 8]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(await cursor.next())).toEqual([9, 10, 11, 12]);
    expect(ids(await cursor.next())).toEqual([13, 14, 15, 16]);
    expect(ids(await cursor.next())).toEqual([17, 18, 19, 20]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("walks empty provider pages within one call when not filling pages", async () => {
    // The no-top-up break only fires once something is buffered, so a provider answering empty
    // pages mid-walk is still walked to the fetch bound, not stalled one page per next().
    const fetchPage = tokenApi([
      { items: [], nextToken: "a" },
      { items: [], nextToken: "b" },
      { items: [{ id: 1, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage,
      pageSize: 10,
      remotePageSize: 4,
      fillPage: false,
      // Deep enough that the walk of three pages happens in one call.
      maxProviderPagesPerCall: 5,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(await cursor.next()).toBeNull();
  });

  it("re-offers a refused page unchanged when not filling pages", async () => {
    const fetchPage = fourRowTokenApi();
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage: async () => {
        if (++call === 2) throw new Error("authorization unavailable");
      },
      pageSize: 10,
      remotePageSize: 4,
      fillPage: false,
    });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4]);
    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // The retry re-offers the second page's four rows without a third provider page.
    expect(ids(await cursor.next())).toEqual([5, 6, 7, 8]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("refuses a provider that loops back to a token the walk already followed", async () => {
    // An echo is caught on the spot; a longer cycle -- the provider handing back a token two
    // pages old -- would page full pages forever, and the fetch bound is no backstop.
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }], nextToken: "a" },
      { items: [{ id: 2, open: true }], nextToken: "b" },
      { items: [{ id: 3, open: true }], nextToken: "a" },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 1, remotePageSize: 1 });

    expect(ids(await cursor.next())).toEqual([1]);
    expect(ids(await cursor.next())).toEqual([2]);
    await expect(cursor.next()).rejects.toThrow(
      "Provider returned a continuation token this walk already followed.");
  });

  it("hands a still-held page to dispose, and nothing when no page is held", async () => {
    // A refused page's rows were fetched but never served: releasing them is the gatekeeper's
    // job once the caller drops the cursor instead of retrying.
    const fetchPage = tokenApi([{ items: [{ id: 1, open: true }], nextToken: "a" }]);
    let disposed: readonly Issue[] | null | undefined;
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage: async () => {
        throw new Error("authorization unavailable");
      },
      pageSize: 10,
      remotePageSize: 1,
      dispose: held => void (disposed = held ?? null),
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    cursor[Symbol.dispose]();
    expect(disposed?.map(issue => issue.id)).toEqual([1]);

    // A cursor that never held a refused page releases the callback's own resources the same way.
    const quiet = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 2, open: true }] }]),
      authorizePage,
      pageSize: 10,
      dispose: held => void (disposed = held ?? null),
    });
    expect(ids(await quiet.next())).toEqual([2]);
    quiet[Symbol.dispose]();
    expect(disposed).toBeNull();
  });
});

describe("PageCursor", () => {
  const issue = (id: number, open = true): Issue => ({ id, open });
  const byId = (a: Issue, b: Issue) => a.id - b.id;

  /** Serves a scripted sequence of numbered pages; past the end the provider reports exhaustion. */
  function pageApi(pages: ProviderPage<Issue>[]) {
    let index = 0;
    return vi.fn(async (_page: number, _perPage: number) => pages[index++] ?? { items: [] });
  }

  it("walks numbered pages until nextPage is null, not until a page is short", async () => {
    // GitLab's shape: pages can come back short mid-listing, so only the absent continuation
    // ends the walk.
    const fetchPage = pageApi([
      { items: [issue(1), issue(2)], nextPage: 2 },
      { items: [issue(3)], nextPage: 3 },
      { items: [issue(4), issue(5)], nextPage: null },
    ]);
    const cursor = new PageCursor<Issue>(
      { fetchPage, pageSize: 10, remotePageSize: 2, maxProviderPagesPerCall: 3 });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4, 5]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage.mock.calls).toEqual([[1, 2], [2, 2], [3, 2]]);
  });

  it("serves pages unchanged when no retain or authorization is given", async () => {
    // A listing whose observation was authorized once, up front, names neither hook.
    const cursor = new PageCursor<Issue>({
      fetchPage: pageApi([
        { items: [issue(1), issue(2)], nextPage: 2 },
        { items: [issue(3)], nextPage: null },
      ]),
      pageSize: 2,
      remotePageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([1, 2]);
    expect(ids(await cursor.next())).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("keeps a page's continuation when retain drops placeholder rows from it", async () => {
    // GitHub's shape: pull rows arrive as null placeholders so the raw page keeps its upstream
    // length -- what ends the walk -- and retain drops them afterwards.
    const rawPages: ProviderPage<Issue | null>[] = [
      { items: [null, issue(1), null], nextPage: 2 },
      { items: [issue(2)], nextPage: null },
    ];
    const fetchPage = vi.fn(async (page: number): Promise<ProviderPage<Issue | null>> =>
      rawPages[page - 1]);
    const cursor = new PageCursor<Issue, Issue | null>({
      fetchPage,
      retain: rows => rows.flatMap(row => (row === null ? [] : [row])),
      pageSize: 1,
      remotePageSize: 3,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    expect(ids(await cursor.next())).toEqual([2]);
    expect(await cursor.next()).toBeNull();
  });

  it("keeps walking when an overlay drops every row of a page", async () => {
    // A selective overlay can drop page after page: the window bounds the reads, the spent
    // window returns [] ("ask again"), and exhaustion still comes only from nextPage.
    let calls = 0;
    const cursor = new PageCursor<Issue>({
      fetchPage: async page => {
        calls++;
        if (page <= 2) return { items: [issue(page * 100)], nextPage: page + 1 };
        return { items: [issue(3)], nextPage: null };
      },
      retain: rows => (calls <= 2 ? [] : [...rows]),
      pageSize: 1,
      maxProviderPagesPerCall: 2,
    });

    expect(await cursor.next()).toEqual([]);
    expect(calls).toBe(2);
    expect(ids(await cursor.next())).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("merges injected rows at their sort positions around the retained rows", async () => {
    const cursor = new PageCursor<Issue>({
      fetchPage: pageApi([
        { items: [issue(2), issue(4)], nextPage: 2 },
        { items: [issue(6)], nextPage: null },
      ]),
      retain: rows => rows.filter(row => row.open),
      inject: { items: [issue(1, false), issue(4, false), issue(5, false), issue(7, false)], compare: byId },
      pageSize: 10,
      remotePageSize: 2,
    });

    expect(await cursor.next()).toEqual([
      issue(1, false), issue(2), issue(4, false), issue(4), issue(5, false), issue(6), issue(7, false),
    ]);
    expect(await cursor.next()).toBeNull();
  });

  it("refuses a provider that continues with the page it was asked to continue from", async () => {
    const fetchPage = vi.fn(async (page: number): Promise<ProviderPage<Issue>> =>
      page === 1
        ? { items: [issue(1)], nextPage: 1 }
        : { items: [issue(2)], nextPage: null });
    const cursor = new PageCursor<Issue>({ fetchPage, pageSize: 10 });

    await expect(cursor.next()).rejects.toThrow(/returned page 1 to continue a listing that asked for page 1/);
    await expect(cursor.next()).rejects.toThrow(/returned page 1 to continue a listing that asked for page 1/);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 1]);
  });

  it("refuses a provider that restarts a listing at page 1", async () => {
    const fetchPage = vi.fn(async (page: number): Promise<ProviderPage<Issue>> =>
      page === 1
        ? { items: [issue(1)], nextPage: 2 }
        : { items: [issue(2)], nextPage: 1 });
    const cursor = new PageCursor<Issue>({ fetchPage, pageSize: 10 });

    await expect(cursor.next()).rejects.toThrow(/returned page 1 to continue a listing that asked for page 2/);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const fetchPage = pageApi([
      { items: [issue(1), issue(2)], nextPage: 2 },
      { items: [issue(3), issue(4)], nextPage: 3 },
      { items: [issue(5)], nextPage: null },
    ]);
    const cursor = new PageCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => ids(page))).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });
});

describe("injected rows", () => {
  const issue = (id: number, open = true): Issue => ({ id, open });
  const byId = (a: Issue, b: Issue) => a.id - b.id;

  it("merges by the provider's order, ahead of an equal provider row, outside authorization", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [issue(2), issue(4)], nextToken: "a" },
        { items: [issue(6)] },
      ]),
      inject: { items: [issue(1, false), issue(4, false), issue(5, false), issue(7, false)], compare: byId },
      authorizePage: authorized,
      pageSize: 10,
      remotePageSize: 2,
    });

    expect(await cursor.next()).toEqual([
      issue(1, false), issue(2), issue(4, false), issue(4), issue(5, false), issue(6), issue(7, false),
    ]);
    expect(await cursor.next()).toBeNull();
    // Injected rows are the agent's own simulation, not something the provider disclosed.
    expect(authorized.mock.calls).toEqual([[[issue(2), issue(4), issue(6)], { terminal: false }]]);
  });

  it("does not authorize a page made only of injected rows", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [issue(2)] }]),
      inject: { items: [issue(1, false)], compare: byId },
      authorizePage: authorized,
      pageSize: 1,
    });

    expect(await cursor.next()).toEqual([issue(1, false)]);
    expect(authorized).not.toHaveBeenCalled();
    expect(await cursor.next()).toEqual([issue(2)]);
    expect(authorized).toHaveBeenCalledOnce();
  });

  it("still owes the zero-result answer after serving only injected rows", async () => {
    const seen: string[] = [];
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [] }]),
      inject: { items: [issue(1, false)], compare: byId },
      pageSize: 1,
      authorizePage: async (items, { terminal }) =>
        void seen.push(`${terminal ? "terminal" : "page"}:${items.length}`),
    });

    expect(await cursor.next()).toEqual([issue(1, false)]);
    expect(await cursor.next()).toBeNull();
    // Only the terminal answer is owed: the injected page disclosed nothing from the provider.
    expect(seen).toEqual(["terminal:0"]);
  });

  it("drops a row revalidation rejects without returning an empty page", async () => {
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [issue(2)] }]),
      inject: {
        items: [issue(1, false), issue(3, false)],
        compare: byId,
        revalidate: row => row.id === 1 ? null : { ...row, open: true },
      },
      authorizePage,
      pageSize: 1,
    });

    expect(await cursor.next()).toEqual([issue(2)]);
    // Re-read as served, not as built.
    expect(await cursor.next()).toEqual([issue(3, true)]);
    expect(await cursor.next()).toBeNull();
  });

  it("drops a row whose identity was served by either source, re-keying served injected rows", async () => {
    // Issue 1 is a queued create's stand-in; once it lands, the provider lists it as issue 10.
    const landed = new Map<number, number>();
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [issue(3), issue(9)], nextToken: "a" },
        { items: [issue(10)] },
      ]),
      inject: {
        items: [issue(1, false), issue(9, false)],
        compare: byId,
        identity: row => String(landed.get(row.id) ?? row.id),
      },
      authorizePage,
      pageSize: 2,
      remotePageSize: 2,
    });

    expect(await cursor.next()).toEqual([issue(1, false), issue(3)]);
    landed.set(1, 10);
    // Provider 9 duplicates the injected 9 on the same page; provider 10 is the landed create.
    expect(await cursor.next()).toEqual([issue(9, false)]);
    expect(await cursor.next()).toBeNull();
  });

  it("counts identities served only once their page is returned", async () => {
    // A fetch failing, or an authorization refused, after an injected row was taken must not
    // cost that row on the retry.
    let attempt = 0;
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: async token => {
        if (token === undefined) return { items: [issue(2)], nextToken: "a" };
        if (++attempt === 1) throw new Error("provider 503");
        return { items: [issue(3)] };
      },
      inject: { items: [issue(1, false)], compare: byId, identity: row => String(row.id) },
      authorizePage: async () => {
        if (++call === 1) throw new Error("authorization unavailable");
      },
      pageSize: 3,
      remotePageSize: 1,
    });

    await expect(cursor.next()).rejects.toThrow("provider 503");
    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    expect(await cursor.next()).toEqual([issue(1, false), issue(2), issue(3)]);
  });

  it("re-reads a refused page's injected rows, deferring a provider row one no longer hides", async () => {
    // The stand-in hides provider 1 as the same row. Its create is discarded between refusal and
    // retry: provider 1 must not join the refused page, nor be lost, nor overtake provider 2.
    const queued = new Set([1]);
    const authorized = vi.fn(async () => {
      if (authorized.mock.calls.length === 1) throw new Error("authorization unavailable");
    });
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [issue(1), issue(2)] }]),
      inject: {
        items: [issue(1, false)],
        compare: byId,
        revalidate: row => (queued.has(row.id) ? row : null),
        identity: row => String(row.id),
      },
      authorizePage: authorized,
      pageSize: 2,
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    queued.delete(1);
    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toEqual([issue(1), issue(2)]);
    expect(await cursor.next()).toBeNull();
    expect(authorized.mock.calls).toEqual([
      [[issue(2)], { terminal: false }],
      [[], { terminal: false }],
      [[issue(1), issue(2)], { terminal: false }],
    ]);
  });

  it("serves one row per identity on a refused page's retry", async () => {
    // The stand-in's create lands as issue 5 between refusal and retry, so the page holds it twice.
    const landed = new Map<number, number>();
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [issue(5)] }]),
      inject: {
        items: [issue(1, false)],
        compare: byId,
        identity: row => String(landed.get(row.id) ?? row.id),
      },
      authorizePage: async () => {
        if (++call === 1) throw new Error("authorization unavailable");
      },
      pageSize: 2,
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    landed.set(1, 5);
    expect(await cursor.next()).toEqual([issue(1, false)]);
  });

  it("keeps walking when a retry drops every row of a refused page", async () => {
    // Provider 5 is the landed copy of a stand-in an earlier page served; the refused page holds it.
    const landed = new Map<number, number>();
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [issue(5), issue(6)] }]),
      inject: {
        items: [issue(1, false)],
        compare: byId,
        identity: row => String(landed.get(row.id) ?? row.id),
      },
      authorizePage: async () => {
        if (++call === 1) throw new Error("authorization unavailable");
      },
      pageSize: 1,
    });

    expect(await cursor.next()).toEqual([issue(1, false)]);
    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    landed.set(1, 5);
    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toEqual([issue(6)]);
    expect(await cursor.next()).toBeNull();
  });
});

describe("PageHookCursor", () => {
  const issues: Issue[] = [{ id: 1, open: true }, { id: 2, open: false }, { id: 3, open: true }];

  it("runs the hook on each page before returning it, and not at exhaustion", async () => {
    const hooked: number[][] = [];
    const cursor = new PageHookCursor(new ArrayCursor(issues, 2), {
      beforePage: async items => { hooked.push(items.map(issue => issue.id)); },
    });

    expect(await cursor.next()).toEqual(issues.slice(0, 2));
    // The second page has not been fetched, so the hook has seen only the first.
    expect(hooked).toEqual([[1, 2]]);
    expect(await cursor.next()).toEqual(issues.slice(2));
    expect(await cursor.next()).toBeNull();
    expect(hooked).toEqual([[1, 2], [3]]);
  });

  it("holds a page whose hook threw, so the retry re-offers it rather than skipping it", async () => {
    let failures = 1;
    const hooked: number[][] = [];
    const cursor = new PageHookCursor(new ArrayCursor(issues, 2), {
      beforePage: async items => {
        if (failures-- > 0) throw new Error("hook failed");
        hooked.push(items.map(issue => issue.id));
      },
    });

    await expect(cursor.next()).rejects.toThrow(/hook failed/);
    expect(await cursor.next()).toEqual(issues.slice(0, 2));
    expect(await cursor.next()).toEqual(issues.slice(2));
    expect(hooked).toEqual([[1, 2], [3]]);
  });

  it("serializes concurrent calls, so each page is hooked and returned once", async () => {
    const hooked: number[][] = [];
    const cursor = new PageHookCursor(new ArrayCursor(issues, 1), {
      beforePage: async items => {
        await Promise.resolve();
        hooked.push(items.map(issue => issue.id));
      },
    });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);
    expect(pages).toEqual([[issues[0]], [issues[1]], [issues[2]]]);
    expect(hooked).toEqual([[1], [2], [3]]);
  });

  it("runs the release hook once, however often it is disposed", () => {
    const dispose = vi.fn();
    const cursor = new PageHookCursor(new ArrayCursor(issues, 2), { beforePage: async () => {}, dispose });

    cursor[Symbol.dispose]();
    cursor[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
