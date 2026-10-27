// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds `TestHooks`, which reaches the account Durable Object as tests
// need. `TestHooks` has to be a Durable Object so it can create the `TestCallback` entrypoint with
// per-user props, as the Workshop does.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ConnectHandoff, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../../src/supabase";
export * from "../../src/supabase";
import {
  GatekeeperUserImpl, SupabaseGatekeeperImpl, type SupabaseGatekeeperImplProps,
} from "../../src/supabase";
import type { ExecuteAction } from "../../src/supabase-actions";

type UserProps = { userObjectId: string };

type TestExports = {
  TestUser(options: { props: UserProps }): Record<string, (...args: unknown[]) => Promise<unknown>>;
  TestCallback(options: { props: UserProps }): Fetcher<GatekeeperConnectCallback>;
  SeededSupabaseGatekeeper(options: { props: SupabaseGatekeeperImplProps }): DurableObjectClass;
}

/** The account entrypoint, reachable for tests. */
export class TestUser extends GatekeeperUserImpl {}

/**
 * The production gatekeeper plus the staging hooks a claim-lifecycle test needs: parking an
 * action at `claimed` (a dispatch that died mid-run) cannot be produced through the validated
 * entry points on demand.
 */
export class SeededSupabaseGatekeeper extends SupabaseGatekeeperImpl {
  /** Queues a mutating statement as submitted, returning its action id. */
  stageAction(action: ExecuteAction): number {
    const { journal } = this.sqlActions();
    const id = journal.allocate({ kind: "execute", payload: action });
    journal.markSubmitted(id);
    return id;
  }

  /** Leaves the claim a dispatch that died after taking it would have. */
  claimAction(actionId: number): void {
    this.sqlActions().journal.markClaimed(actionId);
  }

  /** The journal record for an id, for asserting the settled state. */
  actionRecord(actionId: number): unknown {
    return this.sqlActions().journal.get(actionId);
  }
}

/** A stand-in for the Workshop's connect callback, persistent as the Workshop's own is. */
export class TestCallback extends WorkerEntrypoint<Cloudflare.Env, UserProps> {
  async credentialsExpired(): Promise<void> {}

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async complete(): Promise<ConnectHandoff> {
    throw new Error("Workshop unreachable");
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

export async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
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
    return await outcome(() => (account as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method](...args));
  }

  /** Calls `method` on the account entrypoint for `userObjectId`. */
  async user(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>> {
    return await outcome(() => this.#exports.TestUser({ props: { userObjectId } })[method](...args));
  }

  /** The gatekeeper facet the Overseer would bind for these props, persistent per facet name. */
  #gatekeeper(facetName: string, props: SupabaseGatekeeperImplProps): SeededSupabaseGatekeeper {
    return this.ctx.facets.get<SeededSupabaseGatekeeper>(facetName, () => ({
      class: this.#exports.SeededSupabaseGatekeeper({ props }),
    })) as unknown as SeededSupabaseGatekeeper;
  }

  /** Stages a mutating statement on the gatekeeper, returning its action id. */
  async stageGatekeeperAction(
    facetName: string, props: SupabaseGatekeeperImplProps, action: ExecuteAction,
  ): Promise<number> {
    return await this.#gatekeeper(facetName, props).stageAction(action);
  }

  /** Parks a staged action at `claimed`, as a dispatch that died mid-run would leave it. */
  async claimGatekeeperAction(
    facetName: string, props: SupabaseGatekeeperImplProps, actionId: number,
  ): Promise<void> {
    await this.#gatekeeper(facetName, props).claimAction(actionId);
  }

  /** Applies an action on the gatekeeper, failures carried back as data. */
  async applyGatekeeperAction(
    facetName: string, props: SupabaseGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void>> {
    // The validator expects the git cache the interface declares; Supabase never consults it.
    class NullGitCache extends RpcTarget {}
    return await outcome(() =>
      (this.#gatekeeper(facetName, props) as unknown as {
        applyAction(actionId: number, cache: RpcTarget): Promise<void>;
      }).applyAction(actionId, new NullGitCache()));
  }

  /** Rejects an action on the gatekeeper, failures carried back as data. */
  async rejectGatekeeperAction(
    facetName: string, props: SupabaseGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void>> {
    return await outcome(() => this.#gatekeeper(facetName, props).rejectAction(actionId));
  }

  /** The journal record for an action on the gatekeeper. */
  async gatekeeperActionRecord(
    facetName: string, props: SupabaseGatekeeperImplProps, actionId: number,
  ): Promise<unknown> {
    return await this.#gatekeeper(facetName, props).actionRecord(actionId);
  }
}
