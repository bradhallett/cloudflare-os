import { describe, expect, it, vi } from "vitest";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import { HomeAssistantActionStore, type ActionStoreDeps } from "../src/action-store";
import { HomeAssistantError } from "../src/homeassistant-api";
import type { HomeAssistantAction } from "../src/homeassistant";
import { fakeKv, type FakeKv } from "./fake-kv";

// A minimal valid submit body; every test dispatches the same shape.
const body = {
  type: "callService",
  domain: "light",
  service: "turn_on",
  origin: { kind: "session" },
} as const;

// A promise nothing ever resolves, standing in for a dispatch whose isolate died mid-call.
function neverSettles(): Promise<void> {
  return Promise.withResolvers<void>().promise;
}

function store(
  kv: FakeKv,
  dispatch: ActionStoreDeps["dispatch"],
  extras: Partial<ActionStoreDeps> = {},
): HomeAssistantActionStore {
  return new HomeAssistantActionStore({
    kv,
    dispatch,
    snapshotForRevert: async () => ({ type: "noRevert" }),
    onAuthError: async () => {},
    ...extras,
  });
}

// Stages an action the way submitWrite does: allocated, described, and accepted by the queue.
function stage(actions: HomeAssistantActionStore): HomeAssistantAction {
  const action = actions.allocate(body);
  actions.markSubmitted(action.id);
  return action;
}

describe("HomeAssistantActionStore", () => {
  it("dispatches once and settles a replayed apply", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn(async () => {});
    const actions = store(kv, dispatch);
    const action = stage(actions);

    await actions.apply(action.id);
    await expect(actions.apply(action.id)).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ ...body, id: action.id });
    expect(actions.pendingActions()).toEqual([]);
    const applied = actions.getApplied(action.id);
    expect(applied?.action).toEqual({ ...body, id: action.id });
    expect(applied?.revertInfo).toEqual({ type: "noRevert" });
  });

  it("settles a replayed apply on a fresh activation over the same storage", async () => {
    const kv = fakeKv();
    const first = stage(store(kv, async () => {}));
    await store(kv, async () => {}).apply(first.id);

    // A restart between the settle and the Workshop recording its approval replays the apply.
    const dispatch = vi.fn(async () => {});
    await expect(store(kv, dispatch).apply(first.id)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses to re-dispatch a claim left by an attempt that died mid-dispatch", async () => {
    const kv = fakeKv();
    const action = stage(store(kv, async () => {}));
    // The dying attempt claims, enters dispatch, and never settles: an isolate restart mid-call.
    // Entering dispatch proves the claim row was written -- dispatch runs strictly after it.
    const enteredDispatch = Promise.withResolvers<void>();
    void store(kv, () => {
      enteredDispatch.resolve();
      return neverSettles();
    }).apply(action.id);
    await enteredDispatch.promise;

    const dispatch = vi.fn(async () => {});
    const revived = store(kv, dispatch);
    await expect(revived.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    // The device was driven exactly once, by the attempt that died; the replay never dispatches.
    expect(dispatch).not.toHaveBeenCalled();
    // The refusal is terminal: every later apply answers with the recorded reason, no dispatch.
    await expect(revived.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(dispatch).not.toHaveBeenCalled();
    expect(revived.pendingActions()).toEqual([]);
  });

  it("serializes concurrent applies of one id into a single dispatch", async () => {
    const kv = fakeKv();
    const enteredDispatch = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const dispatch = vi.fn(async () => {
      enteredDispatch.resolve();
      await gate.promise;
    });
    const actions = store(kv, dispatch);
    const action = stage(actions);

    const first = actions.apply(action.id);
    const second = actions.apply(action.id);
    // While the first dispatch is in flight, the second has not dispatched anything.
    await enteredDispatch.promise;
    expect(dispatch).toHaveBeenCalledTimes(1);
    gate.resolve();

    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(actions.getApplied(action.id)).toBeDefined();
  });

  it("records a dispatch with no response as a terminal, surfaced unknown outcome", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn(() => Promise.reject(new HomeAssistantError(
      "Home Assistant did not respond within 15000ms (http://ha.local).",
      { outcomeUnknown: true },
    )));
    const actions = store(kv, dispatch);
    const action = stage(actions);

    await expect(actions.apply(action.id))
      .rejects.toThrow(`${APPLY_OUTCOME_UNKNOWN_MESSAGE} (Home Assistant did not respond`);
    // The record answers later attempts with the same message instead of re-dispatching.
    await expect(actions.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(actions.pendingActions()).toEqual([]);
  });

  it("keeps an answered failure pending and retryable", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new HomeAssistantError(
        "Home Assistant returned HTTP 400: service not found",
        { status: 400 },
      ))
      .mockResolvedValueOnce(undefined);
    const actions = store(kv, dispatch);
    const action = stage(actions);

    await expect(actions.apply(action.id)).rejects.toThrow("HTTP 400");
    expect(actions.pendingActions()).toEqual([{ ...body, id: action.id }]);

    await actions.apply(action.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(actions.getApplied(action.id)?.action).toEqual({ ...body, id: action.id });
  });

  it("notes expired credentials when the instance rejects the token, and stays retryable", async () => {
    const kv = fakeKv();
    const onAuthError = vi.fn(async () => {});
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new HomeAssistantError(
        "Home Assistant rejected the access token. The token may have been revoked.",
        { status: 401, isAuthError: true },
      ))
      .mockResolvedValueOnce(undefined);
    const actions = store(kv, dispatch, { onAuthError });
    const action = stage(actions);

    await expect(actions.apply(action.id)).rejects.toThrow("rejected the access token");
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(actions.pendingActions()).toEqual([{ ...body, id: action.id }]);

    await actions.apply(action.id);
    expect(actions.getApplied(action.id)).toBeDefined();
  });

  it("refuses to reject an action whose dispatch may still be in flight", async () => {
    const kv = fakeKv();
    const action = stage(store(kv, async () => {}));
    const enteredDispatch = Promise.withResolvers<void>();
    void store(kv, () => {
      enteredDispatch.resolve();
      return neverSettles();
    }).apply(action.id);
    await enteredDispatch.promise;

    const actions = store(kv, async () => {});
    await expect(actions.reject(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(actions.getApplied(action.id)).toBeUndefined();

    // Once the user has checked the device, a rejection clears the recorded failure.
    await expect(actions.reject(action.id)).resolves.toBeUndefined();
    expect(actions.pendingActions()).toEqual([]);
    expect(actions.getApplied(action.id)).toBeUndefined();
  });

  it("upgrades pre-journal rows and never reissues an id", async () => {
    const kv = fakeKv();
    // The hand-rolled store's counter held the last issued id; its rows were bare pending rows.
    kv.put("counter:nextActionId", 7);
    kv.put("pending:5", {
      id: 5,
      action: { ...body, id: 5 },
      submittedAt: 1234,
    });

    const dispatch = vi.fn(async () => {});
    const actions = store(kv, dispatch);
    expect(actions.pendingActions()).toEqual([{ ...body, id: 5 }]);

    const next = stage(actions);
    expect(next.id).toBe(8);

    await actions.apply(5);
    expect(dispatch).toHaveBeenCalledWith({ ...body, id: 5 });
    expect(actions.getApplied(5)?.action).toEqual({ ...body, id: 5 });
    expect(kv.keys()).not.toContain("counter:nextActionId");
  });

  it("rolls back a staged submission the approval queue refused", () => {
    const kv = fakeKv();
    const actions = store(kv, async () => {});

    const action = actions.allocate(body);
    // Staged: the approval queue has not accepted it yet, so it does not simulate.
    expect(actions.pendingActions()).toEqual([]);

    actions.rollbackSubmission(action.id);
    expect(actions.pendingActions()).toEqual([]);
    expect(kv.keys()).toEqual(["counter:nextFreeActionId"]);

    // The failed submission's id is not reused, so the overseer never sees two actions share one.
    const next = stage(actions);
    expect(next.id).toBe(action.id + 1);
    expect(actions.pendingActions()).toEqual([{ ...body, id: next.id }]);
  });
});
