// Linear, faked at the `fetch` boundary for the workerd suite. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the whole suite — test file, TestHooks, and the Durable
// Objects — runs in one isolate. The fake keeps state: access tokens name a user in a workspace,
// authorization codes name the user and workspace that granted them, and revocations are recorded
// as Linear would perform them. Anything unrouted, or sent anywhere but Linear, fails the test.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { ConnectionSubject } from "@gadgets/gatekeeper-kit/credential-stage";
import type { LinearGatekeeperImplProps } from "../../src/linear";

const API = "https://api.linear.app";

export type FakeWorkspace = { id: string; name: string; urlKey: string };
export type FakeUser = { id: string; name: string; displayName?: string };

export const ACME: FakeWorkspace = { id: "org-acme", name: "Acme", urlKey: "acme" };
export const GLOBEX: FakeWorkspace = { id: "org-globex", name: "Globex", urlKey: "globex" };

export const ALICE_ACME: FakeUser = { id: "user-alice", name: "Alice", displayName: "Alice Arnott" };
export const BOB_ACME: FakeUser = { id: "user-bob", name: "Bob", displayName: "Bob B" };
export const ALICE_GLOBEX: FakeUser = { id: "user-alice", name: "Alice", displayName: "Alice Arnott" };

export type FakeGrant = { user: FakeUser; workspace: FakeWorkspace };

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

export class FakeLinear {
  readonly requests: Array<{ method: string; url: URL; body?: string }> = [];
  /** Which user-in-workspace each access token belongs to. */
  readonly tokens = new Map<string, FakeGrant>();
  /** Which user-in-workspace each authorization code authorizes. */
  readonly codes = new Map<string, FakeGrant>();
  /** Tokens Linear has been asked to revoke, in order. */
  readonly revocations: string[] = [];
  #nextGrant = 0;

  install(): this {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
    return this;
  }

  async #handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    this.requests.push({ method, url, body });

    if (url.origin !== API) throw new Error(`FakeLinear has no route for ${method} ${url}`);

    if (method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body ?? "");
      const grant = form.get("grant_type") === "authorization_code"
        ? this.codes.get(form.get("code") ?? "")
        : this.tokens.get(form.get("refresh_token") ?? "");
      if (!grant) return json({ error: "invalid_grant", error_description: "Unknown code or token." }, { status: 400 });
      const n = this.#nextGrant++;
      const accessToken = `linoauth_${grant.user.id}_${grant.workspace.id}_${n}`;
      const refreshToken = `linrefresh_${grant.user.id}_${grant.workspace.id}_${n}`;
      this.tokens.set(accessToken, grant);
      this.tokens.set(refreshToken, grant);
      return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "read,write" });
    }

    if (method === "POST" && url.pathname === "/oauth/revoke") {
      const token = new URLSearchParams(body ?? "").get("token") ?? "";
      this.revocations.push(token);
      // 400 means "already revoked" and is treated as success by the caller; a live token is 200.
      return new Response(null, { status: this.tokens.has(token) ? 200 : 400 });
    }

    if (method === "POST" && url.pathname === "/graphql") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      const grant = this.tokens.get(token);
      if (!grant) return json({ errors: [{ message: "Unauthorized", extensions: { code: "AUTHENTICATION_ERROR" } }] }, { status: 401 });
      const query = JSON.parse(body ?? "{}").query as string;
      if (query.includes("viewer")) {
        return json({ data: { viewer: { id: grant.user.id, name: grant.user.name, displayName: grant.user.displayName ?? null }, organization: { id: grant.workspace.id, name: grant.workspace.name, urlKey: grant.workspace.urlKey } } });
      }
      throw new Error(`FakeLinear has no GraphQL response for: ${query}`);
    }

    throw new Error(`FakeLinear has no route for ${method} ${url}`);
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
  applyGatekeeperAction(
    facetName: string, props: LinearGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void>>;
  rejectGatekeeperAction(
    facetName: string, props: LinearGatekeeperImplProps, actionId: number,
  ): Promise<Outcome<void | { restart?: boolean }>>;
  seedGatekeeper(
    facetName: string, props: LinearGatekeeperImplProps, entries: Record<string, unknown>,
  ): Promise<void>;
  gatekeeperEntry(facetName: string, props: LinearGatekeeperImplProps, key: string): Promise<unknown>;
};

export function hooks(): HooksApi {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks")) as unknown as HooksApi;
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

type StoredGrant = { accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] };
type StoredSubject = ConnectionSubject & {
  userId: string; userName: string; orgId: string; orgName: string; orgUrlKey: string;
};

export async function storedGrant(userObjectId: string): Promise<StoredGrant | undefined> {
  return await runInDurableObject(accountStub(userObjectId), (_instance, state) =>
    state.storage.kv.get<StoredGrant>("grant"));
}

export async function storedSubject(userObjectId: string): Promise<StoredSubject | undefined> {
  return await runInDurableObject(accountStub(userObjectId), (_instance, state) =>
    state.storage.kv.get<StoredSubject>("connectionSubject"));
}

/**
 * Seeds a connected account for `user` in `workspace` whose token the fake accepts and that needs
 * no refresh, the way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(
  x: FakeLinear, user: FakeUser = ALICE_ACME, workspace: FakeWorkspace = ACME,
  options: { subject?: boolean } = {},
): Promise<string> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const accessToken = `seed-access-${user.id}-${workspace.id}`;
  x.tokens.set(accessToken, { user, workspace });
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), (_instance, state) => {
    state.storage.kv.put("grant", {
      accessToken,
      refreshToken: `seed-refresh-${user.id}-${workspace.id}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ["read", "write"],
    });
    if (options.subject !== false) {
      state.storage.kv.put("connectionSubject", {
        id: `${user.id}:${workspace.id}`,
        userId: user.id,
        userName: user.displayName ?? user.name,
        orgId: workspace.id,
        orgName: workspace.name,
        orgUrlKey: workspace.urlKey,
      } satisfies StoredSubject);
    }
  });
  return accountId.toString();
}

/**
 * Runs a reconnect inside the account, Linear authorizing `user` in `workspace`, up to the
 * callback: a handoff naming the stage to commit, or a refusal. The account needs a Workshop
 * callback (`installCallback`).
 */
export async function reconnectAs(
  x: FakeLinear, userObjectId: string, user: FakeUser, workspace: FakeWorkspace,
): Promise<unknown> {
  const initiation = generateNonce();
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation);
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    const code = `code-${user.id}-${workspace.id}-${crypto.randomUUID()}`;
    x.codes.set(code, { user, workspace });
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}
