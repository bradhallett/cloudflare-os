// The account Durable Object: a connection pinned to the Spotify user it was made as. A reconnect
// as anyone else is refused and drops the new grant, a same-user reconnect stages until the
// Workshop commits it, an account connected before pinning existed adopts its first reconnect's
// user, and a first connect records the user it was made as. Spotify is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { TestCallback } from "./worker";
import worker from "../../src/spotify";
import { ALICE, BOB, FakeSpotify, accountStub, failure, hooks, reconnectAs, seedAccount, seedLegacyAccount, unwrap } from "./fake-spotify";

type Subject = { id: string; displayName: string | null };

afterEach(() => {
  vi.unstubAllGlobals();
  TestCallback.failComplete = false;
});

async function storedCredentials(
  userObjectId: string,
): Promise<{ refreshToken: string; accessToken: string; accessTokenExpiresAt: number; scopes: string[] } | undefined> {
  return await runInDurableObject(accountStub(userObjectId), (_instance, state) =>
    state.storage.kv.get("credentials"));
}

async function storedRefreshToken(userObjectId: string): Promise<string | undefined> {
  return (await storedCredentials(userObjectId))?.refreshToken;
}

async function storedSubject(userObjectId: string): Promise<Subject | undefined> {
  return await runInDurableObject(accountStub(userObjectId), (_instance, state) =>
    state.storage.kv.get<Subject>("connectionSubject"));
}

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

/**
 * Runs a first connect inside a fresh account, Spotify authorizing `user`: the handoff on success,
 * the thrown error when the Workshop never takes the connection. The decorated account entrypoint
 * cannot be minted from a Durable Object under the vite validation plugin, so its undecorated
 * twin's exports factory (`TestUser`) is swapped in for the call.
 */
async function firstConnectAs(x: FakeSpotify, id: string, user: typeof ALICE): Promise<unknown> {
  const initiation = generateNonce();
  await hooks().installCallback(id, initiation);
  return await runInDurableObject(accountStub(id), async (instance, state) => {
    Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the connect did not start");
    const code = `code-${user.id}`;
    x.codes.set(code, user);
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}

describe("reconnecting", () => {
  it("refuses a reconnect as another Spotify user, dropping the new grant", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce());
    const before = await storedRefreshToken(id);
    const result = await reconnectAs(x, id, BOB);
    expect(result).toEqual({
      refused: {
        title: "That's a different Spotify account",
        detail: expect.stringContaining("This connection is for Alice"),
      },
    });
    expect(await storedRefreshToken(id)).toBe(before);
    expect(await storedSubject(id)).toMatchObject({ id: ALICE.id });
    // Nothing was staged: no commit is awaiting confirmation.
    expect(failure(await hooks().account(id, "commitReconnect", "not-a-stage")))
      .toMatch(/No reconnect is awaiting/);
  });

  it("stages a same-user reconnect until the Workshop commits it", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await hooks().installCallback(id, generateNonce());
    const before = await storedRefreshToken(id);
    const result = await reconnectAs(x, id, ALICE) as { handoff: { ticket: string } };
    expect(await storedRefreshToken(id)).toBe(before);
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    expect(await storedRefreshToken(id)).toMatch(/^refresh-alice-user-\d+$/);
    expect(await storedSubject(id)).toMatchObject({ id: ALICE.id });
    // The stage is spent: a second commit of the same stage is refused.
    expect(failure(await hooks().account(id, "commitReconnect", result.handoff.ticket)))
      .toMatch(/No reconnect is awaiting/);
  });

  it("adopts the pin on the first reconnect of an account connected before pinning", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x, ALICE, { subject: false });
    await hooks().installCallback(id, generateNonce());
    // No stored subject means nothing to compare against, so the reconnect lands — and pins.
    const landed = await reconnectAs(x, id, BOB) as { handoff: { ticket: string } };
    unwrap(await hooks().account(id, "commitReconnect", landed.handoff.ticket));
    expect(await storedSubject(id)).toMatchObject({ id: BOB.id });
    // From then on the connection refuses anyone else, its original user included.
    const result = await reconnectAs(x, id, ALICE);
    expect(result).toEqual({
      refused: {
        title: "That's a different Spotify account",
        detail: expect.stringContaining("This connection is for Bob"),
      },
    });
  });
});

describe("connecting", () => {
  it("records the user a first connect is made as", async () => {
    const x = new FakeSpotify().install();
    const id = env.USER_ACCOUNT.newUniqueId().toString();
    const result = await firstConnectAs(x, id, ALICE) as { handoff: unknown };
    expect(result.handoff).toBeDefined();
    expect(await storedSubject(id)).toMatchObject({ id: ALICE.id });
  });

  it("drops the recorded user when the Workshop never takes the connection", async () => {
    const x = new FakeSpotify().install();
    TestCallback.failComplete = true;
    const id = env.USER_ACCOUNT.newUniqueId().toString();
    await expect(firstConnectAs(x, id, ALICE)).rejects.toThrow(/Workshop unreachable/);
    expect(await storedRefreshToken(id)).toBeUndefined();
    expect(await storedSubject(id)).toBeUndefined();
  });
});

/** Expires the seeded account's access token, so the next read must refresh. */
async function expireToken(userObjectId: string): Promise<void> {
  await runInDurableObject(accountStub(userObjectId), (_instance, state) => {
    const creds = state.storage.kv.get<{ refreshToken: string; accessToken: string; accessTokenExpiresAt: number; scopes: string[] }>("credentials")!;
    state.storage.kv.put("credentials", { ...creds, accessTokenExpiresAt: Date.now() - 1000 });
  });
}

function refreshRequests(x: FakeSpotify): number {
  return x.requests.filter(r => r.url.pathname === "/api/token" && r.body?.includes("grant_type=refresh_token")).length;
}

describe("migrating the legacy layout", () => {
  it("upgrades an account stored one key per field on first read, then reaps the old keys", async () => {
    const x = new FakeSpotify().install();
    const id = await seedLegacyAccount(x);
    expect(await accountStub(id).getAccessToken()).toBe("seed-access-alice-user");
    expect(await storedCredentials(id)).toMatchObject({
      refreshToken: "seed-refresh-alice-user",
      accessToken: "seed-access-alice-user",
    });
    // The canonical record replaced every legacy key in one step.
    const legacy = await runInDurableObject(accountStub(id), (_instance, state) => ({
      refreshToken: state.storage.kv.get<string>("refreshToken"),
      accessToken: state.storage.kv.get<string>("accessToken"),
      accessTokenExpiresAt: state.storage.kv.get<number>("accessTokenExpiresAt"),
      scopes: state.storage.kv.get<string[]>("scopes"),
    }));
    expect(legacy).toEqual({ refreshToken: undefined, accessToken: undefined, accessTokenExpiresAt: undefined, scopes: undefined });
  });
});

describe("refreshing", () => {
  it("rotates an expired token and persists the rotated refresh token", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await expireToken(id);
    x.holdRefreshes();
    const pending = accountStub(id).getAccessToken();
    await vi.waitFor(() => expect(refreshRequests(x)).toBe(1));
    x.releaseRefreshes();
    expect(await pending).toMatch(/^access-alice-user-\d+$/);
    expect(await storedCredentials(id)).toMatchObject({
      accessToken: expect.stringMatching(/^access-alice-user-\d+$/),
      refreshToken: expect.stringMatching(/^refresh-alice-user-\d+$/),
    });
  });

  it("serves two concurrent readers of an expired token with one refresh round-trip", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await expireToken(id);
    x.holdRefreshes();
    const first = accountStub(id).getAccessToken();
    const second = accountStub(id).getAccessToken();
    await vi.waitFor(() => expect(refreshRequests(x)).toBe(1));
    // Let the second reader enter the Durable Object while the first is still held at the
    // provider: if refreshes were not single-flight it would issue its own round-trip here.
    await new Promise(resolve => setTimeout(resolve, 20));
    x.releaseRefreshes();
    expect(await second).toBe(await first);
    expect(await first).toMatch(/^access-alice-user-\d+$/);
    expect(refreshRequests(x)).toBe(1);
  });

  it("expires the connection on a proven-dead grant and stops calling the provider", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await expireToken(id);
    // A refresh token the provider does not know answers 400 invalid_grant: a proven death.
    await runInDurableObject(accountStub(id), (_instance, state) => {
      const creds = state.storage.kv.get<{ refreshToken: string }>("credentials")!;
      state.storage.kv.put("credentials", { ...creds, refreshToken: "revoked-refresh-token" });
    });
    const message = "Spotify credentials have expired or been revoked. Please reconnect the account.";
    await expect(accountStub(id).getAccessToken()).rejects.toThrow(message);
    // The expiry latch is set, so a retry must neither hit the provider nor change its answer.
    const refreshes = refreshRequests(x);
    await expect(accountStub(id).getAccessToken()).rejects.toThrow(message);
    expect(refreshRequests(x)).toBe(refreshes);
    const latched = await runInDurableObject(accountStub(id), (_instance, state) =>
      state.storage.kv.get("credentials:expired"));
    expect(latched).toBeTruthy();
  });

  it("rides out a transient token-endpoint failure without expiring the connection", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    await expireToken(id);
    x.failNextRefresh(503);
    const failure = await accountStub(id).getAccessToken().then(() => null, (error: Error) => error.message);
    // The provider's own failure surfaces raw — not the connection-expired wording.
    expect(failure).toBeTruthy();
    expect(failure).not.toContain("expired or been revoked");
    // Nothing latched: the same call heals on retry and rotates.
    const latched = await runInDurableObject(accountStub(id), (_instance, state) =>
      state.storage.kv.get("credentials:expired"));
    expect(latched).toBeFalsy();
    expect(await accountStub(id).getAccessToken()).toMatch(/^access-alice-user-\d+$/);
    expect(await storedCredentials(id)).toMatchObject({
      refreshToken: expect.stringMatching(/^refresh-alice-user-\d+$/),
    });
  });
});

describe("the connect link", () => {
  it("shows the refusal page when Spotify authorized a different account", async () => {
    const x = new FakeSpotify().install();
    const id = await seedAccount(x);
    const initiation = generateNonce();
    await hooks().installCallback(id, initiation);
    unwrap(await hooks().account(id, "prepareReconnect", initiation));
    const start = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/spotify/${id}/${initiation}`), env, ctx());
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const code = `code-${BOB.id}`;
    x.codes.set(code, BOB);
    const callback = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/spotify/oauth?code=${code}&state=${state}`), env, ctx());
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("That&#39;s a different Spotify account");
  });
});
