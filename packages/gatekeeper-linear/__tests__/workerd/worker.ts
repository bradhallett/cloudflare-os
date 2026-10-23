// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which drives the account Durable Object the way the
// Workshop's callback does, returning plain data (an expected rejection crossing RPC otherwise
// reports as unhandled).

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperUserImpl, LinearGatekeeperImpl, type LinearGatekeeperImplProps } from "../../src/linear";

export { default } from "../../src/linear";
export * from "../../src/linear";

type UserProps = { userObjectId: string };

type TestExports = {
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
  LinearGatekeeperImpl(options: { props: LinearGatekeeperImplProps }): DurableObjectClass;
  SeededLinearGatekeeper(options: { props: LinearGatekeeperImplProps }): DurableObjectClass;
};

/**
 * The account entrypoint, reachable for tests. Under the capnweb-validate *vite* plugin, which
 * applies `@validateRpc()` with a Vitest-aware stub rather than the real decorator, the decorated
 * entrypoints cannot be instantiated from a Durable Object's ctx.exports; this undecorated twin
 * can. `acceptAuthCode` looks the name `GatekeeperUserImpl` up in its own exports, so a
 * first-connect test swaps the two (as the X suite does).
 */
export class TestUser extends GatekeeperUserImpl {}

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

/**
 * The production gatekeeper plus direct storage access, for records a mid-dispatch interruption
 * leaves (`claimed`) that no validated entry point can produce on demand.
 */
export class SeededLinearGatekeeper extends LinearGatekeeperImpl {
  /** Writes raw storage entries, as an interrupted apply would have. */
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.ctx.storage.kv.put(key, value);
  }

  /** Reads one raw storage entry back, for asserting the settled record. */
  entry(key: string): unknown {
    return this.ctx.storage.kv.get(key);
  }
}

/** The git cache `applyAction` is validated to receive; Linear never consults it. */
class NullGitCache extends RpcTarget {}

/**
 * The facet surface TestHooks drives, spelled structurally (as the ZoomInfo suite does): the
 * validator expects `applyAction` to receive the git cache the interface declares.
 */
type GatekeeperFacet = {
  applyAction(actionId: number, cache: RpcTarget): Promise<void>;
  rejectAction(actionId: number): Promise<void | { restart?: boolean }>;
  seed(entries: Record<string, unknown>): void;
  entry(key: string): unknown;
};

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
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

  /** The gatekeeper DO the Overseer would bind for these props, persistent per facet name. */
  #gatekeeper(facetName: string, props: LinearGatekeeperImplProps): GatekeeperFacet {
    return this.ctx.facets.get<SeededLinearGatekeeper>(facetName, () => ({
      class: this.#exports.SeededLinearGatekeeper({ props }),
    })) as unknown as GatekeeperFacet;
  }

  /** Applies an action on the gatekeeper, failures carried back as data. */
  async applyGatekeeperAction(
    facetName: string, props: LinearGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).applyAction(actionId, new NullGitCache()));
  }

  /** Rejects an action on the gatekeeper, failures carried back as data. */
  async rejectGatekeeperAction(
    facetName: string, props: LinearGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void | { restart?: boolean }>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  /** Seeds raw storage on the gatekeeper, as an interrupted dispatch would leave it. */
  async seedGatekeeper(
    facetName: string, props: LinearGatekeeperImplProps, entries: Record<string, unknown>,
  ): Promise<void> {
    await this.#gatekeeper(facetName, props).seed(entries);
  }

  /** Reads one raw storage entry from the gatekeeper. */
  async gatekeeperEntry(
    facetName: string, props: LinearGatekeeperImplProps, key: string,
  ): Promise<unknown> {
    return await this.#gatekeeper(facetName, props).entry(key);
  }
}
