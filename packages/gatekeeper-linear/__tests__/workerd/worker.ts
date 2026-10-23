// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which drives the account Durable Object the way the
// Workshop's callback does, returning plain data (an expected rejection crossing RPC otherwise
// reports as unhandled).

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperUserImpl } from "../../src/linear";

export { default } from "../../src/linear";
export * from "../../src/linear";

type UserProps = { userObjectId: string };

type TestExports = {
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
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
}
