/**
 * End-to-end tests for `OAuthAccountDO`, the kit's account-DO base: the connect lifecycle and the
 * two races it exists to close — a first connect double-redeemed (RC-1), and a reconnect whose
 * commit loses to a newer connection (RC-2) — plus expiry latching and disposal. Sequential by
 * construction: the fences are tested at their branches, and `credentials.test.ts` covers the
 * coordinator's interleavings underneath.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BaseHooks, FakeAccount } from "./account-base";
import { baseControls, baseProvider, BaseTestCallback, liveCalls, resetBase } from "./account-base";

let seq = 0;

/** A fresh account (and the hooks that install its callback), per test. */
function bind() {
  seq += 1;
  const account = env.FAKE_ACCOUNT.getByName(`account-${seq}`);
  const hooks = env.BASE_HOOKS.getByName(`hooks-${seq}`);
  return { name: `account-${seq}`, account, hooks };
}

/** Runs a first connect to its handoff, as a user clicking through the connect page does. */
async function connect(name: string, account: DurableObjectStub<FakeAccount>,
                      hooks: DurableObjectStub<BaseHooks>): Promise<string> {
  const initiation = crypto.randomUUID();
  await hooks.installCallback(name, initiation);
  const flow = await account.beginOAuthFlow(initiation);
  expect(flow).not.toBeNull();
  const result = await account.acceptAuthCode("code", flow!.oauthNonce);
  expect(result).toHaveProperty("handoff");
  return (result as { handoff: { ticket: string } }).handoff.ticket;
}

/** Runs a reconnect up to its stage, whose id the Workshop ticket carries back. */
async function restage(account: DurableObjectStub<FakeAccount>): Promise<string> {
  const initiation = crypto.randomUUID();
  await account.prepareReconnect(initiation);
  const flow = await account.beginOAuthFlow(initiation);
  expect(flow).not.toBeNull();
  const result = await account.acceptAuthCode("code", flow!.oauthNonce);
  expect(result).toHaveProperty("handoff");
  return (result as { handoff: { ticket: string } }).handoff.ticket;
}

/** The rejection message of an RPC expected to fail. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail");
}

beforeEach(() => {
  resetBase();
});

describe("OAuthAccountDO", () => {
  it("completes a first connect and serves credentials", async () => {
    const { name, account, hooks } = bind();
    const ticket = await connect(name, account, hooks);
    expect(ticket).toBe("first-connect");

    const read = await account.getCredentials();
    expect(read.creds.accessToken).toMatch(/^user-a-access/);
    expect(read.creds.scopes).toEqual(["projects:read"]);
    // The identity fence is an opaque nonce; the verified subject rode the live hook instead.
    expect(read.identity).not.toBe("");
    expect(read.generation).not.toBe("");
    // The first connect's live hook saw the verified subject.
    expect(liveCalls).toEqual([{ subjectId: "user-a", accessToken: read.creds.accessToken }]);
  });

  it("keeps a reconnect inert until its ticket commits", async () => {
    const { name, account, hooks } = bind();
    await connect(name, account, hooks);
    const before = (await account.getCredentials()).creds.accessToken;

    const stageId = await restage(account);
    expect((await account.getCredentials()).creds.accessToken).toBe(before);

    await account.commitReconnect(stageId);
    const after = (await account.getCredentials()).creds.accessToken;
    expect(after).not.toBe(before);
    expect(liveCalls).toHaveLength(2);
    expect(liveCalls[1]).toEqual({ subjectId: "user-a", accessToken: after });
  });

  it("refuses a reconnect that comes back as someone else, disposing its grant", async () => {
    const { name, account, hooks } = bind();
    await connect(name, account, hooks);
    const before = (await account.getCredentials()).creds.accessToken;

    baseProvider.principal = "user-b";
    const result = await (async () => {
      const initiation = crypto.randomUUID();
      await account.prepareReconnect(initiation);
      const flow = await account.beginOAuthFlow(initiation);
      return await account.acceptAuthCode("code", flow!.oauthNonce);
    })();

    expect(result).toMatchObject({ refused: { title: "That's a different fake account" } });
    // The refused grant was minted for user-b; the connector's disposal revoked it.
    expect(baseProvider.revoked.size).toBe(1);
    expect([...baseProvider.revoked][0]).toContain("user-b-refresh");
    expect((await account.getCredentials()).creds.accessToken).toBe(before);
  });

  it("refuses a reconnect commit overtaken by a newer connection, disposing the staged grant",
    async () => {
      const { name, account, hooks } = bind();
      await connect(name, account, hooks);

      // Stage a reconnect, then let a second first connect win the connection before it commits.
      const stageId = await restage(account);
      const stagedAccessToken = (await account.getCredentials()).creds.accessToken;
      await connect(name, account, hooks);
      const winner = (await account.getCredentials()).creds.accessToken;
      expect(winner).not.toBe(stagedAccessToken);

      const message = await failure(account.commitReconnect(stageId));
      expect(message).toContain("reconnected again while this reconnect was finishing");
      // The overtaken grant was disposed, and the newer connection still stands.
      expect(baseProvider.revoked.size).toBe(1);
      expect([...baseProvider.revoked][0]).toContain("user-a-refresh");
      expect((await account.getCredentials()).creds.accessToken).toBe(winner);
    });

  it("disposes a first connect whose fence a second connect overtook mid-exchange", { timeout: 15_000 }, async () => {
    const { name, account, hooks } = bind();
    // Flow 1 claims its nonce, then hangs at the exchange — the window the fence exists for.
    const initiation1 = crypto.randomUUID();
    await hooks.installCallback(name, initiation1);
    const flow1 = await account.beginOAuthFlow(initiation1);
    await account.pauseExchange();
    const pending1 = account.acceptAuthCode("code", flow1!.oauthNonce);
    await account.waitForExchange();

    // A second flow completes entirely while the first is still at its provider.
    await connect(name, account, hooks);
    const live = (await account.getCredentials()).creds.accessToken;

    account.releaseExchange();
    const message = await failure(pending1);
    expect(message).toContain("disconnected while it was being authorized");
    expect((await account.getCredentials()).creds.accessToken).toBe(live);
    // The overtaken first flow's mint is the one disposal: nothing else was refused.
    expect(baseProvider.revoked.size).toBe(1);
  });

  it("reports grant death in the connector's words and notifies the Workshop once", async () => {
    const { name, account, hooks } = bind();
    await connect(name, account, hooks);
    baseProvider.controls.grantDead = true;
    // A grant inside its own expiry window is served as is; death is discovered at refresh.
    baseControls.expireNow = true;

    const message = await failure(account.getCredentials());
    expect(message).toBe("Fake credentials died.");

    await account.notifyCredentialsExpired();
    expect(BaseTestCallback.notifications).toBe(1);
    // The latch holds: the same death does not notify again.
    await account.notifyCredentialsExpired();
    expect(BaseTestCallback.notifications).toBe(1);
  });

  it("drops a never-connected account at alarm and disposes live and staged grants at revoke",
    async () => {
      const fresh = env.FAKE_ACCOUNT.getByName(`account-fresh-${seq}`);
      await fresh.runAlarm();
      expect(await fresh.keyCount()).toBe(0);

      const { name, account, hooks } = bind();
      await connect(name, account, hooks);
      const stageId = await restage(account);
      const live = (await account.getCredentials()).creds;

      await account.revoke();
      expect(await account.keyCount()).toBe(0);
      // Both the live and the staged grant went to the connector's disposal.
      expect(baseProvider.revoked.size).toBe(2);
      expect(baseProvider.revoked.has(live.refreshToken)).toBe(true);
      expect(stageId).not.toBe("");
    });
});
