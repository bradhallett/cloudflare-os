/**
 * The OAuth-account-base fixture: one concrete `OAuthAccountDO` subclass over the conformance
 * `FakeProvider`, plus the Workshop-callback stand-in and the hooks that install it. Deliberately
 * written out, the way the conformance consumer is — this is also the reference for what a wave-2
 * connector's adoption subclass looks like.
 */

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ConnectHandoff,
  GatekeeperConnectCallback,
  GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";
import { OAuthAccountDO, type OAuthAttempt } from "../../src/oauth-account";
import { CredentialsExpiredError, type CredentialCoordinatorOptions } from "../../src/credentials";
import { FakeProvider, type Grant } from "./conformance/provider";

/** One provider per test run, distinct from the conformance suite's instance. */
export const baseProvider = new FakeProvider();

/** What `onCredentialsLive` saw, in order. */
export const liveCalls: Array<{ subjectId?: string; accessToken: string }> = [];

/** Fixture controls a test sets to force provider-side conditions. */
export const baseControls = { /** Makes every grant read as already expired, forcing refresh. */
  expireNow: false };

/** Resets shared state between tests, since these module instances outlive one. */
export function resetBase(): void {
  baseProvider.controls.rejectCredentials = false;
  baseProvider.controls.grantDead = false;
  baseProvider.principal = "user-a";
  baseProvider.revoked.clear();
  baseProvider.activeAccessTokens.clear();
  baseControls.expireNow = false;
  liveCalls.length = 0;
  BaseTestCallback.failComplete = false;
  BaseTestCallback.notifications = 0;
}

/** The subjects `subjectOf` derives: the principal is the access token's prefix. */
export type FakeSubject = { id: string };

/** A stand-in for the user facet `complete` names. Its methods are never called here. */
class FakeUser extends RpcTarget {}

/**
 * A concrete account over `FakeProvider`: the smallest real adoption of the base, exercising every
 * hook the way a connector would.
 */
export class FakeAccount extends OAuthAccountDO<unknown, Grant, FakeSubject> {
  #exchangeBarrier?: {
    entered: Promise<void>;
    markEntered(): void;
    release: Promise<void>;
    resume(): void;
  };
  /** Set while an exchange is parked, so `releaseExchange` reaches it after it consumed the barrier. */
  #exchangeRelease?: () => void;
  #exchangeWanted = false;

  protected override credentialOptions(): CredentialCoordinatorOptions<Grant> {
    return {
      ...super.credentialOptions(),
      // The FakeProvider issues grants that do not carry a generation anywhere, so nothing to
      // upgrade: the point of the override is proving the seam exists and composes.
      refreshSkewMs: 5_000,
    };
  }

  protected override vendorId(): string {
    return "fake";
  }

  protected override requestedScopes(): string[] {
    return ["projects:read"];
  }

  protected override userFacet(): Fetcher<GatekeeperUser> {
    // The callback never calls into it; a stub over an ad-hoc target crosses RPC fine.
    return new RpcStub(new FakeUser()) as unknown as Fetcher<GatekeeperUser>;
  }

  protected override async exchange(_code: string, attempt: OAuthAttempt): Promise<Grant> {
    // A paused exchange holds the window between the nonce claim and the credential write —
    // exactly where a second connect can land, and what the generation fence covers.
    const barrier = this.#exchangeBarrier;
    if (barrier !== undefined) {
      // One-shot: consuming the barrier takes ownership of its release, and a second exchange
      // landing while this one is parked must not park too.
      this.#exchangeBarrier = undefined;
      this.#exchangeRelease = barrier.resume;
      barrier.markEntered();
      await barrier.release;
      this.#exchangeRelease = undefined;
    }
    // The scopes an exchange reports are the attempt's, like a provider echoing the ask.
    return { ...baseProvider.mint(), scopes: attempt.scopes };
  }

  /** Pauses the next exchange after the attempt's nonce was claimed, as a slow provider would. */
  pauseExchange(): void {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    this.#exchangeBarrier = {
      entered: entered.promise,
      markEntered: () => entered.resolve(),
      release: release.promise,
      resume: () => release.resolve(),
    };
    this.#exchangeWanted = true;
  }

  /**
   * Waits until the paused exchange reaches its boundary. The exchange consumes the barrier on
   * arrival, so the boundary is reached both when the barrier is armed (wait for `entered`) and
   * when it has already been consumed (the exchange is parked at `release`).
   */
  async waitForExchange(): Promise<void> {
    if (!this.#exchangeWanted) throw new Error("No exchange is paused.");
    const barrier = this.#exchangeBarrier;
    if (barrier !== undefined) await barrier.entered;
  }

  /** Releases the paused exchange, whether it has reached its barrier yet or not. */
  releaseExchange(): void {
    if (!this.#exchangeWanted) throw new Error("No exchange is paused.");
    this.#exchangeBarrier?.resume();
    this.#exchangeRelease?.();
    this.#exchangeBarrier = undefined;
    this.#exchangeRelease = undefined;
    this.#exchangeWanted = false;
  }

  protected override subjectOf(creds: Grant): Promise<FakeSubject | undefined> {
    return Promise.resolve({ id: creds.accessToken.split("-access-")[0]! });
  }

  protected override refreshCredentials(current: Grant): Promise<Grant> {
    try {
      return Promise.resolve({ ...current, ...baseProvider.refresh(current) });
    } catch (error) {
      // Grant death as the provider signals it, classified the way a connector maps its own
      // errors — `oauthRefresh` does this for `OAuthClient`-based connectors.
      throw new CredentialsExpiredError("invalid_grant", { cause: error });
    }
  }

  protected override reconnectRefusal(pinned: FakeSubject, granted: FakeSubject):
      { title: string; detail: string } {
    return {
      title: "That's a different fake account",
      detail: `This connection is ${pinned.id}, but the provider authorized ${granted.id}.`,
    };
  }

  protected override expiresAt(creds: Grant): number | undefined {
    return baseControls.expireNow ? Date.now() - 1_000 : creds.expiresAt;
  }

  protected override disposeGrant(creds: Grant): void {
    baseProvider.revoked.add(creds.refreshToken);
  }

  protected override onCredentialsLive(creds: Grant, subject: FakeSubject | undefined): void {
    liveCalls.push({ subjectId: subject?.id, accessToken: creds.accessToken });
  }

  protected override credentialsExpiredMessage(): string {
    return "Fake credentials died.";
  }

  /** Storage size, for assertions that `alarm`/`revoke` really emptied the account. */
  async keyCount(): Promise<number> {
    return [...this.ctx.storage.kv.list()].length;
  }

  /** Runs the lifecycle alarm in place, for tests: `alarm` itself is reserved over RPC. */
  async runAlarm(): Promise<void> {
    await this.alarm();
  }
}

/**
 * A stand-in for the Workshop's connect callback. State is static because the plugin runs tests in
 * the main worker's isolate, the same one this callback runs in.
 */
export class BaseTestCallback extends WorkerEntrypoint<unknown> {
  /** Set by a test that wants the Workshop to refuse the connection `complete` reports. */
  static failComplete = false;

  /** How many times `credentialsExpired` ran — the latch must hold it at one. */
  static notifications = 0;

  async complete(): Promise<ConnectHandoff> {
    if (BaseTestCallback.failComplete) throw new Error("Workshop unreachable");
    return { targetOrigin: "http://localhost:8787", ticket: "first-connect" };
  }

  /** A reconnect's handoff carries its stage id as the ticket, so a test can commit that stage. */
  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    return { targetOrigin: "http://localhost:8787", ticket: stageId };
  }

  async credentialsExpired(): Promise<void> {
    BaseTestCallback.notifications += 1;
  }
}

type HooksEnv = { FAKE_ACCOUNT: DurableObjectNamespace<FakeAccount> };

type TestExports = {
  BaseTestCallback(options: { props: Record<string, never> }): Fetcher<GatekeeperConnectCallback>;
};

/**
 * Drives the account the way the vendor's `connectAccount` does: minting the callback inside this
 * worker, since a stub minted from the test runner's context cannot be stored in DO storage.
 */
export class BaseHooks extends DurableObject<HooksEnv> {
  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /** Gives the account a Workshop callback and an initiation nonce, as `connectAccount` does. */
  async installCallback(accountName: string, initiationNonce: string): Promise<void> {
    const callback = this.#exports.BaseTestCallback({ props: {} });
    await this.env.FAKE_ACCOUNT.getByName(accountName).setCallback(callback, initiationNonce);
  }
}
