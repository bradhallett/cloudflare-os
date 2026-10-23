// The gatekeeper's approval flow: an action's approval is a one-way transition. Once applied or
// rejected, the record is retired — a submission whose approval is still in flight cannot revive
// it, an apply that loses the race to a rejection does not run its effect, and an apply whose
// write fails after a rejection raced it stays rejected. Everything is asserted behaviorally: a
// resurrected record would show up as a second library save or a successful re-decision. Spotify
// is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canTransition } from "../../src/action-state";
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
    state.storage.kv.put("subject", { userId: "alice-user", displayName: "Alice" });
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
    // resurrect the record — so the action saved once and every re-decision is refused.
    expect(result.decided).toEqual({ ok: undefined });
    expect(result.submitted).toEqual({ ok: undefined });
    expect(failure(result.afterwards)).toMatch(/no longer pending/);
    expect(failure(await hooks().applyAction("race-apply", props, result.actionId))).toMatch(/no longer pending/);
    // Lenient by design: the queue may always clear an entry, but clearing it changes nothing.
    expect(await hooks().rejectAction("race-apply", props, result.actionId)).toEqual({ ok: undefined });
    expect(failure(await hooks().applyAction("race-apply", props, result.actionId))).toMatch(/no longer pending/);
    expect(x.saves).toEqual([["spotify:track:1"]]);
    expect(await hooks().queueLog("race-apply")).toEqual([{ actionId: result.actionId }]);
  });

  it("stays rejected when a submission's reply races it", async () => {
    const x = new FakeSpotify().install();
    const props = await connectedProps(x);
    const result = unwrap(await hooks().submitRacingDecision("race-reject", props, ["spotify:track:2"], "reject"));
    expect(result.decided).toEqual({ ok: undefined });
    expect(result.submitted).toEqual({ ok: undefined });
    // No library write ever ran, and the record cannot be applied afterwards.
    expect(failure(result.afterwards)).toMatch(/no longer pending/);
    expect(failure(await hooks().applyAction("race-reject", props, result.actionId))).toMatch(/no longer pending/);
    expect(x.saves).toEqual([]);
  });

  it("stays rejected when an apply's write fails after a rejection raced it", async () => {
    const x = new FakeSpotify().install();
    const props = await connectedProps(x);
    const actionId = unwrap(await hooks().queueSaveTracks("fail-after-reject", props, ["spotify:track:3"]));
    // Hold the apply's library write so the rejection can land while the apply is in flight, then
    // answer the write with a 502: the apply's own failure handling must not un-reject the record.
    x.holdWrites();
    const applying = hooks().applyAction("fail-after-reject", props, actionId);
    await x.writeArrived();
    expect(await hooks().rejectAction("fail-after-reject", props, actionId)).toEqual({ ok: undefined });
    x.releaseWrites(502);
    expect(failure(await applying)).toBeDefined();
    expect(failure(await hooks().applyAction("fail-after-reject", props, actionId))).toMatch(/no longer pending/);
    expect(x.saves).toEqual([["spotify:track:3"]]);
  });
});

describe("action-state transitions", () => {
  it("treats applied and rejected as terminal", () => {
    expect(canTransition("staged", "pending")).toBe(true);
    expect(canTransition("staged", "approved")).toBe(true);
    expect(canTransition("staged", "rejected")).toBe(true);
    expect(canTransition("pending", "approved")).toBe(true);
    expect(canTransition("pending", "rejected")).toBe(true);
    expect(canTransition("pending", "failed")).toBe(true);
    // `failed` is retryable, and may be re-marked failed by another throwing retry.
    expect(canTransition("failed", "approved")).toBe(true);
    expect(canTransition("failed", "rejected")).toBe(true);
    expect(canTransition("failed", "failed")).toBe(true);
    expect(canTransition("failed", "pending")).toBe(false);
    // Nothing leaves the terminal states — not even a repeat of the same one.
    for (const terminal of ["approved", "rejected"] as const) {
      expect(canTransition(terminal, "pending")).toBe(false);
      expect(canTransition(terminal, "approved")).toBe(false);
      expect(canTransition(terminal, "rejected")).toBe(false);
      expect(canTransition(terminal, "failed")).toBe(false);
    }
  });
});
