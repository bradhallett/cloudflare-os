import { describe, expect, it } from "vitest";
import { fakeKv } from "./fake-kv";
import {
  ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE,
} from "../src/actions";
import {
  applyClaimedAction, AttemptJournal, desiredStateReached, markOutcomeUnknown,
  type ClaimedActionRecord,
} from "../src/outcome-unknown";

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

describe("applyClaimedAction", () => {
  type TestRecord = ClaimedActionRecord & { payload: string };

  /** A record store keyed by id, which is all `applyClaimedAction` needs. */
  function storeOf(...seeded: Array<TestRecord>): {
    store: { getAction(id: number): TestRecord | undefined; putAction(record: TestRecord): void };
    records: Map<number, TestRecord>;
  } {
    const records = new Map(seeded.map(each => [Number(each.payload.slice(1)), each]));
    return {
      store: {
        getAction: id => records.get(id),
        putAction: record => void records.set(Number(record.payload.slice(1)), record),
      },
      records,
    };
  }

  function record(id: number, state: ClaimedActionRecord["state"] = "pending"): TestRecord {
    return { state, payload: `a${id}` };
  }

  const mustNotDispatch = async (): Promise<void> => {
    throw new Error("dispatch must not run");
  };

  it("refuses an id no record answers to", async () => {
    const { store } = storeOf();
    await expect(applyClaimedAction(store, 9, mustNotDispatch, () => false))
      .rejects.toThrow("Unknown action: 9");
  });

  it("settles a replayed apply over an applied or reverted record without dispatching", async () => {
    for (const settled of ["applied", "reverted"] as const) {
      const { store } = storeOf(record(1, settled));
      await applyClaimedAction(store, 1, mustNotDispatch, () => false);
    }
  });

  it("answers a failed record with its own failure, no dispatch", async () => {
    const { store } = storeOf({ ...record(1, "failed"), failure: "quota exhausted" });
    await expect(applyClaimedAction(store, 1, mustNotDispatch, () => false))
      .rejects.toThrow("quota exhausted");
  });

  it("claims before the dispatch, and the dispatch's own applied state is what persists", async () => {
    const { store, records } = storeOf(record(1));
    let handed: TestRecord | undefined;
    await applyClaimedAction(store, 1, async claimed => {
      handed = { ...claimed };
      claimed.state = "applied";
      store.putAction(claimed);
    }, () => false);

    // The dispatch saw the claimed record, and what it persisted is the state it set itself.
    expect(handed?.state).toBe("claimed");
    expect(records.get(1)).toEqual({ state: "applied", payload: "a1" });
  });

  it("records an outcome-unknown dispatch failure terminally and surfaces it", async () => {
    const { store, records } = storeOf(record(1));
    const failure = await applyClaimedAction(
      store, 1,
      async () => { throw new Error("connection dropped after send"); },
      () => true)
      .catch(error => error);

    expect(failure).toBeInstanceOf(ActionOutcomeUnknownError);
    expect((failure as Error).message).toBe(
      `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (connection dropped after send)`);
    expect(records.get(1)).toEqual({
      state: "failed", payload: "a1",
      failure: `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (connection dropped after send)`,
    });
  });

  it("returns a refused dispatch to pending, keeping the failure retryable", async () => {
    const { store, records } = storeOf(record(1));
    const refusal = new Error("HTTP 422");
    await expect(
      applyClaimedAction(store, 1, async () => { throw refusal; }, () => false))
      .rejects.toBe(refusal);
    expect(records.get(1)).toEqual({ state: "pending", payload: "a1" });
  });

  it("answers a leftover claim with a terminal outcome-unknown failure", async () => {
    const { store, records } = storeOf(record(1, "claimed"));
    await expect(applyClaimedAction(store, 1, mustNotDispatch, () => false))
      .rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(records.get(1)).toEqual({
      state: "failed", payload: "a1", failure: APPLY_OUTCOME_UNKNOWN_MESSAGE,
    });
  });

  it("markOutcomeUnknown records the claim terminally and returns the surfaced error", () => {
    const { store, records } = storeOf(record(1, "claimed"));
    const failure = markOutcomeUnknown(store, record(1, "claimed"));
    expect(failure).toBeInstanceOf(ActionOutcomeUnknownError);
    expect(failure.message).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(records.get(1)).toEqual({
      state: "failed", payload: "a1", failure: APPLY_OUTCOME_UNKNOWN_MESSAGE,
    });
  });
});
