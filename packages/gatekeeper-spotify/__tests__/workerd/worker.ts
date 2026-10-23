// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the gatekeeper as the overseer does.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from `ctx.exports.X({props})` is
// only reachable through `ctx.facets`, which is how the overseer instantiates a gatekeeper, and a
// stub minted for a facet or a session it returns cannot be handed to the test. So TestHooks
// drives each scenario itself and returns plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ConnectHandoff,
  GatekeeperConnectCallback,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperUserImpl } from "../../src/spotify";

export { default } from "../../src/spotify";
export * from "../../src/spotify";

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` with a Vitest-aware stub rather than the real decorator, the decorated
 * entrypoints cannot be instantiated from a Durable Object's ctx.exports; this undecorated twin
 * can. `acceptAuthCode` looks the name `GatekeeperUserImpl` up in its own exports, so a
 * first-connect test swaps the two (as the X suite does).
 */
export class TestUser extends GatekeeperUserImpl {}

type UserProps = { userObjectId: string };

export type GatekeeperProps = { userObjectId: string; resourceKind: "account" | "playlist"; playlistId?: string };

type TestExports = {
  SpotifyGatekeeperImpl(options: { props: GatekeeperProps }): DurableObjectClass;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
};

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  /** Set by a test that wants the Workshop to refuse the connection `complete` reports. */
  static failComplete = false;

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async complete(): Promise<ConnectHandoff> {
    if (TestCallback.failComplete) throw new Error("Workshop unreachable");
    return { targetOrigin: "http://localhost:8787", ticket: "first-connect" };
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The `Gatekeeper` contract takes a GitCache stub on applyAction; Spotify ignores it. */
class NullCache extends RpcTarget {}
/**
 * An approval queue whose next `submitAction` reply can be held and later released, so a test can
 * apply or reject an action while its own submission is still in flight — the interleaving the
 * resurrection bug lived in.
 */
export class RacingQueue extends RpcTarget {
  readonly submissions: Array<{ actionId: number; description: ActionDescription }> = [];
  #held: Promise<void> | null = null;
  #next: { promise: Promise<number>; resolve: (actionId: number) => void } | null = null;

  /** Makes the next submitAction's reply wait on `hold`. */
  holdNext(hold: Promise<void>): void {
    this.#held = hold;
  }

  /** The action id of the next submitAction, whenever it arrives. */
  nextSubmission(): Promise<number> {
    this.#next ??= Promise.withResolvers<number>();
    return this.#next.promise;
  }

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submissions.push({ actionId, description });
    this.#next?.resolve(actionId);
    this.#next = null;
    const held = this.#held;
    this.#held = null;
    if (held) await held;
  }

  async authorizeObservation(_description: ObservationDescription): Promise<void> {}
}

type Session = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = {
  startSession(queue: RacingQueue): Promise<Session>;
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<unknown>;
};

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RacingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * The gatekeeper facet named `facetName`, made with `props` on first use. A facet is cached per
   * name, storage and all, so each scenario takes a fresh name.
   */
  #gatekeeper(facetName: string, props: GatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get(facetName, () => ({
      class: this.#exports.SpotifyGatekeeperImpl({ props }),
    })) as unknown as GatekeeperFacet;
  }

  #queue(facetName: string): RacingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, queue = new RacingQueue());
    return queue;
  }

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(userObjectId: string, initiationNonce: string): Promise<void> {
    const callback = this.#exports.TestCallback({ props: { userObjectId } });
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    await account.setCallback(callback, initiationNonce);
  }

  /** Calls `method` on the account Durable Object, failures carried back as data. */
  async account(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    const account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
    return await outcome(() =>
      (account as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method](...args));
  }

  /** Queues a save-tracks action through a session, as an agent turn would, and reports its id. */
  async queueSaveTracks(facetName: string, props: GatekeeperProps, trackIds: string[]): Promise<Outcome<number>> {
    return await outcome(async () => {
      const queue = this.#queue(facetName);
      const session = await this.#gatekeeper(facetName, props).startSession(queue);
      try {
        await session.saveTracks(trackIds);
      } finally {
        session[Symbol.dispose]?.();
      }
      return queue.submissions.at(-1)!.actionId;
    });
  }

  async applyAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, new NullCache()));
  }

  async rejectAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<unknown>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  /** The action ids the facet's approval queue has been asked to approve. */
  queueLog(facetName: string): Array<{ actionId: number }> {
    return this.#queue(facetName).submissions.map(({ actionId }) => ({ actionId }));
  }

  /**
   * Reproduces the resurrection interleaving: a save-tracks action is submitted, the queue holds
   * the submission's reply, the action is applied or rejected through the queue while the submit
   * is still in flight, and only then is the reply released. Returns the action's id and each
   * step's outcome as plain data, ending with a second apply attempt that must be refused.
   */
  async submitRacingDecision(
    facetName: string,
    props: GatekeeperProps,
    trackIds: string[],
    decision: "apply" | "reject",
  ): Promise<Outcome<{
    actionId: number;
    decided: Outcome<unknown>;
    submitted: Outcome<unknown>;
    afterwards: Outcome<unknown>;
  }>> {
    return await outcome(async () => {
      const gatekeeper = this.#gatekeeper(facetName, props);
      const queue = this.#queue(facetName);
      const session = await gatekeeper.startSession(queue);
      const gate = Promise.withResolvers<void>();
      queue.holdNext(gate.promise);
      const nextId = queue.nextSubmission();
      const saving = session.saveTracks(trackIds);
      const actionId = await nextId;
      const decided = decision === "apply"
        ? await outcome(() => gatekeeper.applyAction(actionId, new NullCache()))
        : await outcome(() => gatekeeper.rejectAction(actionId));
      gate.resolve();
      const submitted = await outcome(() => saving);
      session[Symbol.dispose]?.();
      const afterwards = await outcome(() => gatekeeper.applyAction(actionId, new NullCache()));
      return { actionId, decided, submitted, afterwards };
    });
  }
}
