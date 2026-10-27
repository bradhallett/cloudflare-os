// The cursor that lazily pages through a Linear GraphQL connection, authorizing each page's
// observation (and, on workspace bindings, its teams) before it is handed out.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue, Cursor, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { RawConnection } from "./linear-api";
import type { LinearGatekeeperImpl } from "./linear-gatekeeper";

export function disposeStub(stub: RpcStub<ApprovalQueue>): void {
  (stub as unknown as Disposable)[Symbol.dispose]();
}

// ---------------------------------------------------------------------------
// Cursor: lazily pages through a Linear connection, authorizing each page.

export class StreamingCursor<TRaw, TOut> extends RpcTarget implements Cursor<TOut> {
  #gk: LinearGatekeeperImpl;
  #fetchPage: (after: string | undefined) => Promise<RawConnection<TRaw>>;
  #normalize: (raw: TRaw) => TOut;
  #queue: RpcStub<ApprovalQueue>;
  #describe: (items: TOut[]) => ObservationDescription;
  // The team(s) whose data a given raw page reveals, for workspace-binding observer tracking (see
  // LinearGatekeeperImpl.authorizeTeamObservation). Empty for workspace-level pages any member sees.
  #teamIdsOf: (rawItems: TRaw[]) => string[];
  #after: string | undefined = undefined;
  #done = false;

  constructor(
    gk: LinearGatekeeperImpl,
    queue: RpcStub<ApprovalQueue>,
    fetchPage: (after: string | undefined) => Promise<RawConnection<TRaw>>,
    normalize: (raw: TRaw) => TOut,
    describe: (items: TOut[]) => ObservationDescription,
    teamIdsOf: (rawItems: TRaw[]) => string[],
  ) {
    super();
    this.#gk = gk;
    this.#queue = queue;
    this.#fetchPage = fetchPage;
    this.#normalize = normalize;
    this.#describe = describe;
    this.#teamIdsOf = teamIdsOf;
  }

  async next(): Promise<TOut[] | null> {
    if (this.#done) return null;
    const conn = await this.#fetchPage(this.#after);
    const items = conn.nodes.map(this.#normalize);
    // Authorize before advancing pagination state, so a denied page can be retried.
    await this.#gk.authorizeTeamObservation(this.#queue, this.#teamIdsOf(conn.nodes), this.#describe(items));
    this.#after = conn.pageInfo.endCursor ?? undefined;
    if (!conn.pageInfo.hasNextPage) this.#done = true;
    return items;
  }

  [Symbol.dispose](): void {
    disposeStub(this.#queue);
  }
}
