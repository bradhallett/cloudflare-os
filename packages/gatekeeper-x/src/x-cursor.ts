// X's listings ride the kit's `TokenCursor`, shaped to X's billing: a provider page is the unit
// the caller asked for, so the cursor makes exactly one X request per `next()` (`fillPage: false`
// with a fetch bound of 1) and serves that page whole — short pages included, never topped up
// from a second request. On X every row fetched is billed, so a cursor must never read rows the
// caller did not ask for.

import { TokenCursor } from "@gadgets/gatekeeper-kit/cursors";
import type { ObservationInput, ObservationScope } from "@gadgets/gatekeeper-kit/observers";
import type { Cursor } from "./types";

/** One page as fetched: its rows, where to resume, and how to authorize disclosing it. */
export type XPage<T> = {
  items: T[];
  /** Absent once the walk is over. */
  nextToken?: string;
  observation: ObservationInput;
  scope: ObservationScope;
};

/** What a cursor needs from the listing that made it. */
export type XCursorOptions<T> = {
  /** Fetches one page, continuing from `token` (absent for the first page). */
  fetchPage(token: string | undefined): Promise<XPage<T>>;
  /** Authorizes a page before `next()` returns it. A throw holds the page for the retry. */
  authorize(page: XPage<T>): Promise<void>;
  /** Releases what the cursor owns, when the caller disposes it. */
  dispose?(): void;
};

/**
 * Makes the cursor for an X listing, on the kit's `TokenCursor`.
 * @param options The listing's fetch, authorization, and release hooks.
 * @returns The cursor to return to the caller.
 */
export function xCursor<T>(options: XCursorOptions<T>): Cursor<T> {
  // The local page is the provider page, overlays included, so a `next()` never splits one: the
  // kit's page size is unbounded and the fetch bound holds the walk to a single X request.
  let fetched: XPage<T> | undefined;
  return new TokenCursor<T>({
    pageSize: Number.MAX_SAFE_INTEGER,
    fillPage: false,
    maxProviderPagesPerCall: 1,
    fetchPage: async token => {
      fetched = await options.fetchPage(token);
      return { items: fetched.items, nextToken: fetched.nextToken };
    },
    authorizePage: async () => {
      if (fetched === undefined) {
        throw new Error("The X cursor authorized a page before it fetched one.");
      }
      // A non-terminal call authorizes the page X just served. The terminal one reaches here
      // only after an empty walk — the kit skips terminal authorization once a page was
      // answered — and authorizes that final empty page, the "no such thing" answer, as X
      // served it.
      await options.authorize(fetched);
    },
    dispose: () => options.dispose?.(),
  });
}

/** A cursor over rows already in hand, such as posts that exist only while pending. */
export function staticPage<T>(items: T[], observation: ObservationInput, scope: ObservationScope): XPage<T> {
  return { items, observation, scope };
}
