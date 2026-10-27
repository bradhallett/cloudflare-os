// The streaming RPC cursor the GitHub gatekeeper's listings share (issues, pulls, discussions,
// files, branches, tags, commits): it lazily fetches remote pages, overlays simulation onto each
// row, and merges provisional rows in at their sort positions. The same shape as
// gatekeeper-gitlab's `StreamingCursor`; in-memory listings use the kit's `ArrayCursor`.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";

/** Upstream page size for StreamingCursor walks: GitHub's maximum `per_page`. */
const REMOTE_PAGE_SIZE = 100;

/**
 * Bound on upstream fetches per `StreamingCursor.next()` (the kit's provider-cursor bound): a
 * selective overlay may drop page after page, and one call must not walk a whole history.
 */
const MAX_REMOTE_PAGES_PER_NEXT = 10;

/**
 * A cursor that lazily fetches pages from a remote API, overlays (and possibly drops) each row,
 * and merges in pre-computed provisional items at their correct sort positions.
 *
 * This avoids the need to fetch ALL pages upfront before returning any results, which is
 * critical for repos with large issue/PR histories.
 */
@validateRpc()
export class StreamingCursor<T, R = T> extends RpcTarget implements Cursor<T> {
  /**
   * Fetches one page from the remote API (or cache), one row per upstream row: a short page is
   * what ends the walk, so rows are dropped in #overlay, never here.
   */
  #fetchPage: (page: number, perPage: number) => Promise<R[]>;
  /** Applies the simulation overlay to a fetched row: the item to serve, or null to drop it. */
  #overlay: (row: R) => T | null;
  /**
   * Comparator consistent with the remote API's sort order.
   * Returns negative if a should come before b.
   */
  #comparator: (a: T, b: T) => number;
  /** Pre-computed injected items, already overlaid and filtered, sorted by #comparator. */
  #injectedItems: T[];
  #injectedIndex = 0;
  /**
   * Re-validates an injected item at the moment `next()` serves it (a page may be drained long
   * after the cursor -- and its injected snapshot -- was built): returns the item to serve,
   * possibly refreshed, or null to drop it. Must not change the item's sort position. Defaults
   * to serving the snapshot as-is.
   */
  #revalidateInjected: (item: T) => T | null;

  /** Rows buffered ahead of what next() has returned; injected ones re-validate when served. */
  #buffer: {item: T, injected: boolean}[] = [];
  #remotePage = 1;
  #remoteExhausted = false;
  #pageSize: number;

  constructor(options: {
    fetchPage: (page: number, perPage: number) => Promise<R[]>;
    overlay: (row: R) => T | null;
    comparator: (a: T, b: T) => number;
    injectedItems: T[];
    revalidateInjected?: (item: T) => T | null;
    pageSize: number;
  }) {
    super();
    this.#fetchPage = options.fetchPage;
    this.#overlay = options.overlay;
    this.#comparator = options.comparator;
    this.#injectedItems = options.injectedItems;
    this.#revalidateInjected = options.revalidateInjected ?? (item => item);
    this.#pageSize = options.pageSize;
  }

  /** @returns The next page, `[]` when the fetch window ran out before a match, or `null` at the end. */
  async next(): Promise<T[] | null> {
    // Fill the page from the buffer, loading more when it runs dry. Injected rows re-validate
    // at the moment they are *served*, not when they were buffered: #loadMore buffers a whole
    // remote page at once, so with a small page size a row can sit in the buffer across many
    // next() calls -- plenty of time for the state that justified it to change underneath.
    // Consumed rows leave the buffer only once the page is returned, so a fetch that throws
    // leaves them for the retry.
    const page: T[] = [];
    let consumed = 0;
    let fetches = 0;
    while (page.length < this.#pageSize) {
      const entry = this.#buffer[consumed];
      if (entry === undefined) {
        if (this.#fullyExhausted()) break;
        if (!this.#remoteExhausted && fetches++ === MAX_REMOTE_PAGES_PER_NEXT) break;
        await this.#loadMore();
        continue;
      }
      consumed++;
      const item = entry.injected ? this.#revalidateInjected(entry.item) : entry.item;
      if (item !== null) page.push(item);
    }
    this.#buffer.splice(0, consumed);
    return page.length === 0 && this.#fullyExhausted() ? null : page;
  }

  #fullyExhausted(): boolean {
    return this.#remoteExhausted && this.#injectedIndex >= this.#injectedItems.length;
  }

  async #loadMore(): Promise<void> {
    if (this.#remoteExhausted) {
      // Remote is done; flush remaining injected items into the buffer.
      this.#flushInjectedBefore(undefined);
      return;
    }

    const rows = await this.#fetchPage(this.#remotePage, REMOTE_PAGE_SIZE);
    this.#remotePage++;
    if (rows.length < REMOTE_PAGE_SIZE) {
      this.#remoteExhausted = true;
    }

    for (const row of rows) {
      const item = this.#overlay(row);
      if (item === null) continue;

      // Before appending this remote item, merge in any injected items that sort before it.
      this.#flushInjectedBefore(item);
      this.#buffer.push({item, injected: false});
    }

    // If remote just became exhausted, flush remaining injected items.
    if (this.#remoteExhausted) {
      this.#flushInjectedBefore(undefined);
    }
  }

  /**
   * Buffer the injected items that sort at or before `limit` (all remaining, when `limit` is
   * undefined). Re-validation happens later, when next() serves them from the buffer.
   */
  #flushInjectedBefore(limit: T | undefined): void {
    while (this.#injectedIndex < this.#injectedItems.length) {
      if (limit !== undefined &&
          this.#comparator(this.#injectedItems[this.#injectedIndex], limit) > 0) {
        return;
      }
      this.#buffer.push({item: this.#injectedItems[this.#injectedIndex++], injected: true});
    }
  }
}

