// ZoomInfo, faked at the `fetch` boundary for the workerd suites. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the whole suite runs in one isolate. Authorization codes
// name the OIDC subject they authorize; the token endpoint mints an id token carrying that
// subject; data endpoints answer JSON:API documents to any token the fake issued. A test
// scripts an enrichment failure with `failEnrich` and counts dispatches with `enrichRequests`.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

export type FakeZoomInfoUser = { sub: string; email: string; name: string };

export const ALICE: FakeZoomInfoUser = { sub: "sub-alice", email: "alice@example.com", name: "Alice" };
export const BOB: FakeZoomInfoUser = { sub: "sub-bob", email: "bob@example.com", name: "Bob" };

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned JWT whose payload carries the user's identity claims, as ZoomInfo's id token does. */
function idTokenFor(user: FakeZoomInfoUser): string {
  const payload = JSON.stringify({ sub: user.sub, email: user.email, name: user.name });
  return `${base64Url('{"alg":"none"}')}.${base64Url(payload)}.sig`;
}

export class FakeZoomInfo {
  /** Authorization codes pending redemption, naming the user each authorizes. */
  readonly codes = new Map<string, FakeZoomInfoUser>();
  /** Access tokens this fake has issued; data endpoints accept only these. */
  readonly tokens = new Set<string>();
  /** How many enrichment dispatches reached the fake. */
  enrichRequests = 0;
  /** Scripts the next enrichment dispatch: a status to answer with, or "abort" to drop the call. */
  failEnrich: number | "abort" | undefined;

  /** Issues the grant a completed authorization would yield, registering its access token. */
  grant(user: FakeZoomInfoUser): { accessToken: string; refreshToken: string; idToken: string } {
    const accessToken = `zi-access-${user.sub}`;
    this.tokens.add(accessToken);
    return { accessToken, refreshToken: `zi-refresh-${user.sub}`, idToken: idTokenFor(user) };
  }

  install(): this {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.host !== "api.zoominfo.com") throw new Error(`unexpected fetch: ${request.url}`);

      if (request.method === "POST" && url.pathname === "/gtm/oauth/v1/token") {
        const form = new URLSearchParams(await request.text());
        const user = this.codes.get(form.get("code") ?? "");
        if (user === undefined || form.get("grant_type") !== "authorization_code") {
          return json({ error: "invalid_grant" }, { status: 400 });
        }
        this.codes.delete(form.get("code")!);
        const grant = this.grant(user);
        return json({
          access_token: grant.accessToken,
          refresh_token: grant.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          id_token: grant.idToken,
        });
      }

      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!this.tokens.has(token)) {
        return json({ errors: [{ code: 401, detail: "unauthorized" }] }, { status: 401 });
      }

      if (request.method === "POST" && url.pathname.endsWith("/enrich")) {
        this.enrichRequests += 1;
        if (this.failEnrich === "abort") throw new TypeError("fetch failed");
        if (this.failEnrich !== undefined) {
          return json({ errors: [{ code: this.failEnrich, detail: "enrichment failed" }] }, { status: this.failEnrich });
        }
        return json({ data: [] });
      }
      if (request.method === "POST" && url.pathname === "/gtm/data/v1/companies/search") {
        return json({
          data: [{ type: "Company", id: "1001", attributes: { name: "Example Corp", website: "example.com" } }],
          meta: { page: { number: 1 }, totalResults: 1 },
        });
      }
      return json({ data: [] });
    });
    return this;
  }
}

/**
 * Seeds a connected account for `user` whose token the fake accepts and that needs no refresh,
 * the way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(zi: FakeZoomInfo, user: FakeZoomInfoUser = ALICE): Promise<string> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const { accessToken, refreshToken } = zi.grant(user);
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", accessToken);
    state.storage.kv.put("refreshToken", refreshToken);
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    state.storage.kv.put("scopes", ["read"]);
    state.storage.kv.put("connectionSubject", {
      id: user.sub,
      displayName: user.name,
      uniqueName: user.email,
    });
  });
  return accountId.toString();
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/**
 * Runs a reconnect inside the account, ZoomInfo authorizing `user`, up to the callback: a handoff
 * naming the stage to commit, or a refusal. The account needs a Workshop callback
 * (`installCallback`).
 */
export async function reconnectAs(zi: FakeZoomInfo, userObjectId: string, user: FakeZoomInfoUser) {
  const initiation = crypto.randomUUID().replace(/-/g, "");
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation);
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    const code = `code-${crypto.randomUUID()}`;
    zi.codes.set(code, user);
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T>(outcome: { ok: T } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: { ok: unknown } | { error: string }): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}
