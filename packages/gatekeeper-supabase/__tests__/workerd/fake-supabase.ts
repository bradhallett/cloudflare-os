// Supabase, faked at the `fetch` boundary for the workerd suites. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the whole suite runs in one isolate. Authorization codes
// name the gotrue user they authorize; the token endpoint mints a grant; `/v1/profile` reports the
// user each access token belongs to; revocations are counted so a test can assert a usable grant
// was retired.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";

/** One Supabase user the fake can authorize: the gotrue id the connection pins to. */
export type FakeSupabaseUser = { gotrueId: string; email: string; username: string };

export const ALICE: FakeSupabaseUser = { gotrueId: "gt-alice", email: "alice@example.com", username: "alice" };
export const BOB: FakeSupabaseUser = { gotrueId: "gt-bob", email: "bob@example.com", username: "bob" };

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

export class FakeSupabase {
  /** Authorization codes pending redemption, naming the user each authorizes. */
  readonly codes = new Map<string, FakeSupabaseUser>();
  /** Refresh tokens this fake has been asked to revoke. */
  readonly revokes: string[] = [];
  /** Scripts `/v1/profile` to fail, the way an outage would. */
  failProfile = false;
  readonly #usersByToken = new Map<string, FakeSupabaseUser>();

  /** Issues the grant a completed authorization would yield, registering its access token. */
  grant(user: FakeSupabaseUser): { accessToken: string; refreshToken: string } {
    const accessToken = `sb-access-${user.gotrueId}-${Math.random().toString(36).slice(2, 8)}`;
    this.#usersByToken.set(accessToken, user);
    return { accessToken, refreshToken: `sb-refresh-${user.gotrueId}` };
  }

  install(): this {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.host !== "api.supabase.com") throw new Error(`unexpected fetch: ${request.url}`);

      if (request.method === "POST" && url.pathname === "/v1/oauth/token") {
        const form = new URLSearchParams(await request.text());
        const user = this.codes.get(form.get("code") ?? "");
        if (user === undefined || form.get("grant_type") !== "authorization_code") {
          return json({ error: "invalid_grant", error_description: "Unknown code." }, { status: 400 });
        }
        this.codes.delete(form.get("code")!);
        const grant = this.grant(user);
        return json({
          access_token: grant.accessToken,
          refresh_token: grant.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (url.pathname === "/v1/profile") {
        const user = this.#usersByToken.get(token);
        if (user === undefined) return json({ message: "unauthorized" }, { status: 401 });
        if (this.failProfile) return json({ message: "profile unavailable" }, { status: 503 });
        return json({ gotrue_id: user.gotrueId, primary_email: user.email, username: user.username });
      }
      if (request.method === "POST" && url.pathname === "/v1/oauth/revoke") {
        const body = await request.json() as { refresh_token?: string };
        this.revokes.push(body.refresh_token ?? "");
        return json({});
      }
      if (token !== "" && this.#usersByToken.has(token)) return json([]);
      return json({ message: "unauthorized" }, { status: 401 });
    });
    return this;
  }
}

/**
 * Seeds a connected account for `user` whose token the fake accepts and that needs no refresh,
 * the way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(sb: FakeSupabase, user: FakeSupabaseUser = ALICE): Promise<string> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const { accessToken, refreshToken } = sb.grant(user);
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", accessToken);
    state.storage.kv.put("refreshToken", refreshToken);
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    state.storage.kv.put("identity", { id: user.gotrueId, email: user.email, username: user.username });
  });
  return accountId.toString();
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/**
 * Runs a reconnect inside the account, Supabase authorizing `user`, up to the callback: a handoff
 * naming the stage to commit, a refusal, or the error a broken profile read raises. The account
 * needs a Workshop callback (`installCallback`).
 */
export async function reconnectAs(sb: FakeSupabase, userObjectId: string, user: FakeSupabaseUser) {
  const initiation = crypto.randomUUID().replace(/-/g, "");
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation);
    const oauthNonce = await instance.beginOAuthFlow(initiation);
    if (!oauthNonce) throw new Error("the reconnect did not start");
    const code = `code-${crypto.randomUUID()}`;
    sb.codes.set(code, user);
    return await instance.acceptAuthCode(code, oauthNonce);
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
