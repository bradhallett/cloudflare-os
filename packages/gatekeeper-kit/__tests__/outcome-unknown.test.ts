import { describe, expect, it } from "vitest";
import { fakeKv } from "./fake-kv";
import { AttemptJournal, desiredStateReached } from "../src/outcome-unknown";

describe("AttemptJournal", () => {
  it("carries a marker from before the dispatch until it is settled", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<{ at: number }>(kv, { namespace: "x" });

    expect(attempts.attempt(7, "0")).toBeUndefined();
    attempts.begin(7, "0", { at: 12_000 });
    expect(attempts.attempt(7, "0")).toEqual({ at: 12_000 });
    attempts.settle(7, "0");
    expect(attempts.attempt(7, "0")).toBeUndefined();
  });

  it("keeps steps of one action apart", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<number>(kv, { namespace: "x" });

    attempts.begin(7, "0", 1);
    attempts.begin(7, "1", 2);
    attempts.begin(8, "0", 3);

    expect(attempts.attempt(7, "0")).toBe(1);
    expect(attempts.attempt(7, "1")).toBe(2);
    expect(attempts.attempt(8, "0")).toBe(3);
    expect(attempts.possiblyApplied(9)).toBe(false);
  });

  it("survives the crash between marking a dispatch and reconciling it", () => {
    const kv = fakeKv();
    new AttemptJournal<{ at: number; mediaIds: string[] }>(kv, { namespace: "x" })
      .begin(7, "0", { at: 12_000, mediaIds: ["m1"] });

    // A new activation over the same storage: the re-delivered apply finds the marker.
    const revived = new AttemptJournal<{ at: number; mediaIds: string[] }>(kv, { namespace: "x" });
    expect(revived.attempt(7, "0")).toEqual({ at: 12_000, mediaIds: ["m1"] });
    expect(revived.possiblyApplied(7)).toBe(true);
  });

  it("replaces a marker whose dispatch was reconciled to nothing, so the new attempt is judged by its own send", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<{ at: number }>(kv, { namespace: "x" });

    attempts.begin(7, "0", { at: 12_000 });
    attempts.begin(7, "0", { at: 45_000 });
    expect(attempts.attempt(7, "0")).toEqual({ at: 45_000 });
  });

  it("answers whether an action may already have applied, for the refusal to reject", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<unknown>(kv, { namespace: "x" });

    expect(attempts.possiblyApplied(7)).toBe(false);
    attempts.begin(7, "2", null);
    expect(attempts.possiblyApplied(7)).toBe(true);
    expect(attempts.possiblyApplied(8)).toBe(false);
    attempts.settle(7, "2");
    expect(attempts.possiblyApplied(7)).toBe(false);
  });

  it("drops an action's markers once it resolves", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<unknown>(kv, { namespace: "x" });

    attempts.begin(7, "0", null);
    attempts.begin(7, "1", null);
    attempts.begin(8, "0", null);
    attempts.clear(7);

    expect(attempts.attempt(7, "0")).toBeUndefined();
    expect(attempts.attempt(7, "1")).toBeUndefined();
    expect(attempts.attempt(8, "0")).not.toBeUndefined();
  });

  it("housekeeps the markers of actions no longer waiting", () => {
    const kv = fakeKv();
    const attempts = new AttemptJournal<unknown>(kv, { namespace: "x" });

    attempts.begin(7, "0", null);
    attempts.begin(8, "0", null);
    attempts.begin(8, "1", null);
    kv.put("x:attempt:not-an-action", null);

    attempts.clearExcept(new Set([8]));

    expect(attempts.attempt(7, "0")).toBeUndefined();
    expect(attempts.attempt(8, "0")).not.toBeUndefined();
    expect(attempts.attempt(8, "1")).not.toBeUndefined();
    expect(kv.keys()).not.toContain("x:attempt:not-an-action");
  });

  it("adopts an existing marker prefix without moving keys", () => {
    const kv = fakeKv();
    kv.put("attempt:12:0", { at: 12_000 });

    const attempts = new AttemptJournal<{ at: number }>(kv, { markerPrefix: "attempt:" });
    expect(attempts.attempt(12, "0")).toEqual({ at: 12_000 });
    attempts.begin(12, "1", { at: 13_000 });
    expect(kv.keys()).toEqual(["attempt:12:0", "attempt:12:1"]);
  });

  it("rejects an unusable namespace or prefix", () => {
    const kv = fakeKv();
    expect(() => new AttemptJournal(kv, { namespace: "two words" })).toThrow(/namespace/);
    expect(() => new AttemptJournal(kv, { markerPrefix: "" })).toThrow(/markerPrefix/);
  });
});

describe("desiredStateReached", () => {
  it("settles the apply when the provider already holds the approved state", async () => {
    const current = await desiredStateReached(async () => "abc123", "abc123");
    expect(current).toBeUndefined();
  });

  it("names the provider's current state for the refusal otherwise", async () => {
    const current = await desiredStateReached(async () => "def456" as string | null, "abc123");
    expect(current).toBe("def456");
  });

  it("treats a missing branch as a state, not a settled apply", async () => {
    const current = await desiredStateReached(async () => null, "abc123");
    expect(current).toBeNull();
  });

  it("propagates a failed read rather than settling", async () => {
    const failure = new Error("provider unreachable");
    await expect(desiredStateReached<string>(async () => { throw failure; }, "abc123"))
      .rejects.toBe(failure);
  });
});
