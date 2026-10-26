// The paging engine behind every `Cursor` this gatekeeper hands out is the kit's `TokenCursor`
// (see `@gadgets/gatekeeper-kit/cursors`); this module only shapes Confluence's page contract —
// one provider page per `next()`, each authorized before it leaves — onto it. Confluence pages
// by an opaque `cursor` link parameter, so the kit's refusal of an echoed or repeated
// continuation token (a provider bug the cursor this replaces paged forever on) comes free.

import { TokenCursor } from "@gadgets/gatekeeper-kit/cursors";
import type { Cursor } from "./types";

/** One page as fetched: its rows, where to resume, and how to authorize disclosing it. */
export type ConfluencePage<T> = {
  items: T[];
  /** Absent once the walk is over. */
  nextCursor: string | undefined;
  /**
   * Records the observation that authorizes disclosing this page. Runs before `next()` returns
   * the page; a throw refuses it, and the retry re-authorizes the same page without refetching.
   */
  authorize(): Promise<void>;
};

/**
 * Makes the cursor for a Confluence listing, on the kit's `TokenCursor`.
 * @param fetchPage Fetches one page, continuing from `cursor` (`undefined` for the first page).
 * @returns The cursor to return to the caller.
 */
export function confluenceCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<ConfluencePage<T>>,
): Cursor<T> {
  // The local page is the provider page, overlays included, so a `next()` never splits one: the
  // kit's page size is unbounded and the fetch bound holds the walk to a single Confluence
  // request.
  let fetched: ConfluencePage<T> | undefined;
  return new TokenCursor<T>({
    pageSize: Number.MAX_SAFE_INTEGER,
    fillPage: false,
    maxProviderPagesPerCall: 1,
    fetchPage: async cursor => {
      fetched = await fetchPage(cursor);
      return { items: fetched.items, nextToken: fetched.nextCursor };
    },
    authorizePage: async (_items, { terminal }) => {
      if (fetched === undefined) {
        throw new Error("The Confluence cursor authorized a page before it fetched one.");
      }
      // A walk that disclosed rows ends without a Confluence page of its own to authorize: the
      // last page's authorization already happened when it was served. An empty walk authorized
      // nothing yet, so its final page — the "no such thing" answer — is authorized here, as
      // Confluence served it.
      if (terminal && fetched.items.length > 0) return;
      await fetched.authorize();
    },
  });
}
