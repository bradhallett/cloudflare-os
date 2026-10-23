// Spotify, faked at the `fetch` boundary for the workerd suite. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the whole suite — test file, TestHooks, and the Durable
// Objects — runs in one isolate. The fake keeps state: access tokens name users, authorization
// codes name the user that granted them, and library writes are recorded as Spotify would hold
// them. A test can hold every library write (and later answer it) to order an apply against a
// rejection. Anything unrouted, or sent anywhere but Spotify, fails the test.
import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { GatekeeperProps } from "./worker";

export const ACCOUNTS = "https://accounts.spotify.com";
export const API = "https://api.spotify.com";

export type FakeUser = { id: string; displayName: string | null };

export const ALICE: FakeUser = { id: "alice-user", displayName: "Alice" };
export const BOB: FakeUser = { id: "bob-user", displayName: "Bob" };

export type FakeRequest = { method: string; url: URL; headers: Headers; body?: string };

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

export class FakeSpotify {
  readonly requests: FakeRequest[] = [];
  /** Which user each access token belongs to. */
  readonly tokens = new Map<string, FakeUser>();
  /** Which user each authorization code authorizes. */
  readonly codes = new Map<string, FakeUser>();
  /** Library saves, one entry per write with the URIs it carried. */
  readonly saves: string[][] = [];
  #nextGrant = 0;
  #writeHold: { promise: Promise<number>; resolve: (status: number) => void } | null = null;
  #writeArrived: { promise: Promise<void>; resolve: () => void } | null = null;

  install(): this {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
    return this;
  }

  /** Holds every library write until `releaseWrites` answers it with `status`. */
  holdWrites(): void {
    this.#writeHold = Promise.withResolvers<number>();
  }

  releaseWrites(status: number): void {
    this.#writeHold?.resolve(status);
    this.#writeHold = null;
  }

  /** Resolves once a library write has arrived while one was being waited for. */
  writeArrived(): Promise<void> {
    this.#writeArrived ??= Promise.withResolvers<void>();
    return this.#writeArrived.promise;
  }

  async #handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.requests.push({ method, url, headers, body });

    if (url.origin === ACCOUNTS && url.pathname === "/api/token" && method === "POST") {
      const form = new URLSearchParams(body ?? "");
      const user = form.get("grant_type") === "authorization_code"
        ? this.codes.get(form.get("code") ?? "")
        : undefined;
      if (!user) return json({ error: "invalid_grant", error_description: "Unknown authorization code." }, { status: 400 });
      const n = this.#nextGrant++;
      const accessToken = `access-${user.id}-${n}`;
      this.tokens.set(accessToken, user);
      return json({
        access_token: accessToken,
        refresh_token: `refresh-${user.id}-${n}`,
        expires_in: 3600,
        scope: "user-read-private user-library-modify",
      });
    }

    if (url.origin === API) {
      const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const user = this.tokens.get(token);
      if (!user) return json({ error: { message: "Invalid access token" } }, { status: 401 });

      if (method === "GET" && url.pathname === "/v1/me") {
        return json({ id: user.id, display_name: user.displayName, uri: `spotify:user:${user.id}`, type: "user" });
      }
      if (method === "PUT" && url.pathname === "/v1/me/library") {
        this.saves.push((url.searchParams.get("uris") ?? "").split(",").filter(Boolean));
        this.#writeArrived?.resolve();
        this.#writeArrived = null;
        const hold = this.#writeHold;
        if (hold) {
          const status = await hold.promise;
          if (status >= 400) return new Response(null, { status });
        }
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`FakeSpotify has no route for ${method} ${url}`);
  }
}

// Shared harness plumbing, in the style of the X suite: the TestHooks stub, account stubs, and
// the seeding/reconnect helpers the tests build scenarios from.

export type Outcome<T> = { ok: T } | { error: string };

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure, for when the test is the failure being asserted. */
export function failure(outcome: Outcome<unknown>): string {
  if ("ok" in outcome) throw new Error("expected the call to fail");
  return outcome.error;
}

/**
 * The TestHooks surface the tests use, spelled out by hand: the stub's generated RPC types map
 * union returns onto their error branch, which collapses `Outcome<T>` and loses `ok`'s type.
 */
export type HooksApi = {
  installCallback(userObjectId: string, initiationNonce: string): Promise<void>;
  account(userObjectId: string, method: string, ...args: unknown[]): Promise<Outcome<unknown>>;
  queueSaveTracks(facetName: string, props: GatekeeperProps, trackIds: string[]): Promise<Outcome<number>>;
  applyAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<void>>;
  rejectAction(facetName: string, props: GatekeeperProps, actionId: number): Promise<Outcome<unknown>>;
  queueLog(facetName: string): Array<{ actionId: number }>;
  submitRacingDecision(
    facetName: string, props: GatekeeperProps, trackIds: string[], decision: "apply" | "reject",
  ): Promise<Outcome<{
    actionId: number;
    decided: Outcome<unknown>;
    submitted: Outcome<unknown>;
    afterwards: Outcome<unknown>;
  }>>;
};

export function hooks(): HooksApi {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks")) as unknown as HooksApi;
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/**
 * Seeds a connected account for `user` whose token the fake accepts and that needs no refresh,
 * the way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(
  x: FakeSpotify, user: FakeUser = ALICE, options: { subject?: boolean } = {},
): Promise<string> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const accessToken = `seed-access-${user.id}`;
  x.tokens.set(accessToken, user);
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), (_instance, state) => {
    state.storage.kv.put("refreshToken", `seed-refresh-${user.id}`);
    state.storage.kv.put("accessToken", accessToken);
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    state.storage.kv.put("scopes", ["user-read-private"]);
    if (options.subject !== false) {
      state.storage.kv.put("subject", { userId: user.id, displayName: user.displayName });
    }
  });
  return accountId.toString();
}

/**
 * Runs a reconnect inside the account, Spotify authorizing `user`, up to the callback: a handoff
 * naming the stage to commit, or a refusal. The account needs a Workshop callback
 * (`installCallback`).
 */
export async function reconnectAs(x: FakeSpotify, userObjectId: string, user: FakeUser): Promise<unknown> {
  const initiation = generateNonce();
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation);
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    const code = `code-${user.id}`;
    x.codes.set(code, user);
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}
