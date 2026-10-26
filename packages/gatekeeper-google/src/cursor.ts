// The paging engine behind every `Cursor` this gatekeeper hands out is the kit's `TokenCursor`
// (see `@gadgets/gatekeeper-kit/cursors`); this module only shapes Google's page contract — raw
// provider items, entry building, page authorization, entry cleanup — onto it.
//
// One behavior this adapter pins down: a `next()` serves the entries of one provider page, so a
// short page is returned short rather than topped up from a second provider call (`fillPage:
// false` in the kit's terms). Empty pages are walked onward within the fetch bound, and an
// authorization refusal holds the page — the retry re-offers exactly the entries the refusal
// covered, and they are released (via `disposeEntries`) only when the cursor itself is dropped.
//
// This module deliberately imports nothing from `cloudflare:workers` beyond what the kit does, so
// it stays testable outside workerd. google.ts and the sessions wrap the pager for the wire.

import { TokenCursor } from "@gadgets/gatekeeper-kit/cursors";

/** One page as the provider returned it, before any scope filtering. */
export type CursorPage<Item> = {
  items: Item[];
  /** Absent once the provider has no more pages. */
  nextPageToken?: string;
};

export type CursorPagerOptions<Item, Entry> = {
  /** Fetch one raw page. `pageToken` is undefined for the first. */
  fetchPage(pageToken: string | undefined): Promise<CursorPage<Item>>;

  /**
   * Turn a raw page into the entries the caller sees. Runs inside the cursor's fetch, so a
   * refusal-held page keeps the entries it built and a retry re-offers them rather than
   * rebuilding (and re-charging) the provider read.
   */
  buildEntries(items: Item[]): Promise<Entry[]>;

  /**
   * Authorize a page before it is disclosed. Throws to deny; the kit holds the page, and the
   * retry offers the same entries again.
   * @param entries The entries of the outgoing page; empty on an exhausted walk's last call.
   * @param exhausted Whether the provider has no more pages.
   */
  authorize(entries: readonly Entry[], exhausted: boolean): Promise<void>;

  /** Best-effort cleanup for built entries the cursor is dropped holding (a refused page). */
  disposeEntries?(entries: readonly Entry[]): void | Promise<void>;

  /**
   * Provider pages one `next()` may fetch before returning what it has. The default
   * (`DEFAULT_MAX_PROVIDER_PAGES_PER_CALL`) keeps a couple of reads per call; raise it only for
   * call sites that measurably need a deeper window, never to paper over a runaway filter.
   */
  maxProviderPagesPerCall?: number;
};

/**
 * No provider page approaches this many entries; passing it as the kit's page size with
 * `fillPage: false` makes "the whole fetched provider page" the unit a `next()` serves.
 */
const WHOLE_PROVIDER_PAGE = Number.MAX_SAFE_INTEGER;

/** The one method a `Cursor` exposes. `CursorPager` implements it; google.ts wraps it for RPC. */
export interface Pager<Entry> {
  next(): Promise<Entry[] | null>;
}

/**
 * A `TokenCursor` over Google's page contract: fetch a raw page, build its entries, authorize
 * them, and clean them up if the cursor is dropped mid-walk.
 */
export class CursorPager<Item, Entry> extends TokenCursor<Entry> implements Pager<Entry> {
  constructor(options: CursorPagerOptions<Item, Entry>) {
    super({
      fetchPage: async (pageToken) => {
        const page = await options.fetchPage(pageToken);
        return { items: await options.buildEntries(page.items), nextToken: page.nextPageToken };
      },
      pageSize: WHOLE_PROVIDER_PAGE,
      fillPage: false,
      maxProviderPagesPerCall: options.maxProviderPagesPerCall,
      authorizePage: (entries, { terminal }) => options.authorize(entries, terminal),
      dispose: (held) => {
        void options.disposeEntries?.(held ?? []);
      },
    });
  }
}
