// A reconnect pins the ZoomInfo account it was made as: the OIDC subject of the new grant must
// match the pinned one, a mismatch is refused (and the old connection left alone), and a match
// hands off a stage to commit. ZoomInfo is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import worker from "../../src/zoominfo";
import type { ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { ALICE, BOB, FakeZoomInfo, accountStub, hooks, reconnectAs, seedAccount, unwrap } from "./fake-zoominfo";

type StoredIdentity = { displayName?: string; uniqueName?: string; subject?: string };

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

async function storedIdentity(userObjectId: string): Promise<StoredIdentity | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<StoredIdentity>("identity"));
}

async function storedToken(userObjectId: string): Promise<string | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<string>("accessToken"));
}

describe("reconnect pinning", () => {
  it("refuses a reconnect that authorized a different ZoomInfo account", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi);
    await hooks().installCallback(id, generateNonce());
    const result = await reconnectAs(zi, id, BOB) as { refused: { title: string } };
    expect(result.refused.title).toContain("different ZoomInfo account");
    // The pinned connection is untouched: no new grant, no new identity.
    expect(await storedToken(id)).toBe(`zi-access-${ALICE.sub}`);
    expect((await storedIdentity(id))?.subject).toBe(ALICE.sub);
  });

  it("hands off a stage to commit when the same ZoomInfo account authorized", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi);
    await hooks().installCallback(id, generateNonce());
    const result = await reconnectAs(zi, id, ALICE) as { handoff: ConnectHandoff };
    expect(typeof result.handoff.ticket).toBe("string");
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    expect(await storedToken(id)).toBe(`zi-access-${ALICE.sub}`);
    expect((await storedIdentity(id))?.subject).toBe(ALICE.sub);
  });

  it("shows the refusal page when ZoomInfo authorized a different account", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi);
    const initiation = generateNonce();
    await hooks().installCallback(id, initiation);
    unwrap(await hooks().account(id, "prepareReconnect", initiation));
    const start = await worker.fetch(new Request(`http://localhost:8787/gatekeeper/zoominfo/${id}/${initiation}`),
      env as never, ctx());
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    zi.codes.set("code-bob", BOB);
    const callback = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/zoominfo/oauth?code=code-bob&state=${state}`), env as never, ctx());
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("different ZoomInfo account");
    expect(await storedToken(id)).toBe(`zi-access-${ALICE.sub}`);
  });
});
