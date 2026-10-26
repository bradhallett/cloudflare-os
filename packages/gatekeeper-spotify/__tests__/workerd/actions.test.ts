// The gatekeeper's approval flow, over the kit's action engine: an applied action stays applied, a
// rejected one stays rejected, and a submission whose approval is still in flight cannot revive
// either. Everything is asserted behaviorally — a resurrected record would show up as a second
// library save or a successful re-decision. Spotify is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSpotify, failure, hooks, unwrap } from "./fake-spotify";

type GatekeeperProps = { userObjectId: string; resourceKind: "account" | "playlist"; playlistId?: string };


/** A connected, pinned account the gatekeeper's session can draw a live token from. */
async function connectedProps(x: FakeSpotify): Promise<GatekeeperProps> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  const accessToken = "seed-access-alice";
  x.tokens.set(accessToken, { id: "alice-user", displayName: "Alice" });
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), (_instance, state) => {
    state.storage.kv.put("refreshToken", "seed-refresh-alice");
    state.storage.kv.put("accessToken", accessToken);
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + 60 * 60 * 1000);
    state.storage.kv.put("scopes", ["user-library-modify"]);
    state.storage.kv.put("connectionSubject", { id: "alice-user", displayName: "Alice" });
  });
  return { userObjectId: accountId.toString(), resourceKind: "account" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an approval in flight", () => {
  it("stays applied when its submission's reply races it", async () => {
    const x = new FakeSpotify().install();
    const props = await connectedProps(x);
    const result = unwrap(await hooks().submitRacingDecision("race-apply", props, ["spotify:track:1"], "apply"));
    // The decision ran while the submit was held; the submit returned after, and could not
    // resurrect the record — so the action saved exactly once.
    expect(result.decided).toEqual({ ok: undefined });
    expect(result.submitted).toEqual({ ok: undefined });
    // The engine is idempotent on an applied id: re-applying answers success without re-saving.
    expect(result.afterwards).toEqual({ ok: undefined });
    expect(await hooks().applyAction("race-apply", props, result.actionId)).toEqual({ ok: undefined });
    // Clearing a decided entry from the queue is refused: an applied action has nothing to reject.
    expect(failure(await hooks().rejectAction("race-apply", props, result.actionId))).toMatch(/no longer pending/);
    expect(await hooks().applyAction("race-apply", props, result.actionId)).toEqual({ ok: undefined });
    expect(x.saves).toEqual([["spotify:track:1"]]);
    expect(await hooks().queueLog("race-apply")).toEqual([{ actionId: result.actionId }]);
  });

  it("stays rejected when a submission's reply races it", async () => {
    const x = new FakeSpotify().install();
    const props = await connectedProps(x);
    const result = unwrap(await hooks().submitRacingDecision("race-reject", props, ["spotify:track:2"], "reject"));
    expect(result.decided).toEqual({ ok: undefined });
    expect(result.submitted).toEqual({ ok: undefined });
    // No library write ever ran, and the rejected record is gone, so a later apply is refused.
    expect(failure(result.afterwards)).toMatch(/Unknown pending action/);
    expect(failure(await hooks().applyAction("race-reject", props, result.actionId))).toMatch(/Unknown pending action/);
    expect(x.saves).toEqual([]);
  });

  it("ends rejected when its apply fails and the rejection follows it", async () => {
    const x = new FakeSpotify().install();
    const props = await connectedProps(x);
    const actionId = unwrap(await hooks().queueSaveTracks("fail-after-reject", props, ["spotify:track:3"]));
    // Answer the apply's library write with a 502: the failure restores the record pending (a
    // plain provider error is retryable, never terminal), so the queued rejection can still take
    // it — the write ran once and the action ends rejected.
    x.holdWrites();
    const applying = hooks().applyAction("fail-after-reject", props, actionId);
    await x.writeArrived();
    x.releaseWrites(502);
    expect(failure(await applying)).toBeDefined();
    expect(await hooks().rejectAction("fail-after-reject", props, actionId)).toEqual({ ok: undefined });
    expect(failure(await hooks().applyAction("fail-after-reject", props, actionId))).toMatch(/Unknown pending action/);
    expect(x.saves).toEqual([["spotify:track:3"]]);
  });
});
