// A reconnect pins the Supabase account it was made as: the gotrue id the new grant's profile
// reports must match the pinned one. A mismatch is refused and the unusable new grant revoked at
// Supabase; a match hands off a stage to commit. A profile that cannot be read fails the flow the
// same way — with the exchanged grant revoked, since it cannot be pinned to anyone. Supabase is
// faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import worker from "../../src/supabase";
import type { ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { ALICE, BOB, FakeSupabase, accountStub, hooks, reconnectAs, seedAccount, unwrap } from "./fake-supabase";

type StoredIdentity = { id: string; email?: string; username?: string };

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

async function storedIdentity(userObjectId: string): Promise<StoredIdentity | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<StoredIdentity>("connectionSubject"));
}

async function storedToken(userObjectId: string): Promise<string | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<string>("accessToken"));
}

describe("reconnect pinning", () => {
  it("refuses a reconnect that authorized a different Supabase account, revoking the new grant", async () => {
    const sb = new FakeSupabase().install();
    const id = await seedAccount(sb, ALICE);
    await hooks().installCallback(id, generateNonce());
    const result = await reconnectAs(sb, id, BOB) as { refused: { title: string } };
    expect(result.refused.title).toContain("different Supabase account");
    // The new grant was retired at Supabase and the pinned connection is untouched.
    expect(sb.revokes).toEqual([`sb-refresh-${BOB.gotrueId}`]);
    expect((await storedToken(id))?.startsWith(`sb-access-${ALICE.gotrueId}`)).toBe(true);
    expect((await storedIdentity(id))?.id).toBe(ALICE.gotrueId);
  });

  it("hands off a stage to commit when the same Supabase account authorized", async () => {
    const sb = new FakeSupabase().install();
    const id = await seedAccount(sb, ALICE);
    await hooks().installCallback(id, generateNonce());
    const result = await reconnectAs(sb, id, ALICE) as { handoff: ConnectHandoff };
    expect(typeof result.handoff.ticket).toBe("string");
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    // The staged grant is live, for the same account.
    expect((await storedToken(id))?.startsWith(`sb-access-${ALICE.gotrueId}`)).toBe(true);
    expect((await storedIdentity(id))?.id).toBe(ALICE.gotrueId);
  });

  it("fails a reconnect whose profile cannot be read, revoking the exchanged grant", async () => {
    const sb = new FakeSupabase().install();
    sb.failProfile = true;
    const id = await seedAccount(sb, ALICE);
    await hooks().installCallback(id, generateNonce());
    await expect(reconnectAs(sb, id, ALICE)).rejects.toThrow(/Could not read which Supabase account/);
    expect(sb.revokes).toHaveLength(1);
    expect((await storedToken(id))?.startsWith(`sb-access-${ALICE.gotrueId}`)).toBe(true);
  });

  it("shows the refusal page when Supabase authorized a different account", async () => {
    const sb = new FakeSupabase().install();
    const id = await seedAccount(sb, ALICE);
    const initiation = generateNonce();
    await hooks().installCallback(id, initiation);
    unwrap(await hooks().account(id, "prepareReconnect", initiation));
    const start = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/supabase/${id}/${initiation}`),
      env as never, ctx());
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    sb.codes.set("code-bob", BOB);
    const callback = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/supabase/oauth?code=code-bob&state=${state}`), env as never, ctx());
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("different Supabase account");
  });
});
