import { describe, expect, it, vi } from "vitest";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import {
  HOME_ASSISTANT_ACTIONS, appliedAction, homeAssistantJournal, withActionId,
  type HomeAssistantActionHost,
} from "../src/action-store";
import { HomeAssistantError, type RegistrySnapshot } from "../src/homeassistant-api";
import type { HomeAssistantAction } from "../src/homeassistant";
import { fakeKv, type FakeKv } from "./fake-kv";

// A minimal valid submit body; every test dispatches the same shape.
const body = {
  type: "callService",
  domain: "light",
  service: "turn_on",
  origin: { kind: "session" },
} as const;

// Registry names only enrich descriptions; tests never need them.
const registry: RegistrySnapshot = {
  areas: [], floors: [], labels: [], devices: [], entities: [], states: new Map(),
};

/** The host a test wants; dispatch is the only field any test varies meaningfully. */
function host(
  dispatch: HomeAssistantActionHost["dispatch"],
  extras: Partial<HomeAssistantActionHost> = {},
): HomeAssistantActionHost {
  return {
    fetchRegistrySnapshot: async () => registry,
    snapshotForRevert: async () => ({ type: "noRevert" }),
    onAuthError: async () => {},
    dispatch,
    ...extras,
  };
}

/** Binds the declared set over the given storage the way the gatekeeper object does. */
function bind(kv: FakeKv, overrides: Partial<HomeAssistantActionHost> = {}) {
  const journal = homeAssistantJournal(kv);
  const actions = HOME_ASSISTANT_ACTIONS.bind(journal, host(async () => {}, overrides));
  return { journal, actions };
}

// Stages an action the way submitWrite does: described, accepted by the queue, submitted.
async function stage(
  actions: ReturnType<typeof bind>["actions"],
): Promise<HomeAssistantAction> {
  const queue = { submitAction: vi.fn(async () => {}) };
  const id = await actions.submit(queue, "callService", body);
  return withActionId(body, id);
}

// A promise nothing ever resolves, standing in for a dispatch whose isolate died mid-call.
function neverSettles(): Promise<void> {
  return Promise.withResolvers<void>().promise;
}

describe("Home Assistant actions", () => {
  it("dispatches once and settles a replayed apply", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn(async () => {});
    const { journal, actions } = bind(kv, { dispatch });
    const action = await stage(actions);

    await actions.apply(action.id);
    await expect(actions.apply(action.id)).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ ...body, id: action.id });
    expect(journal.listPending()).toEqual([]);
    const applied = appliedAction(journal, kv, action.id);
    expect(applied?.action).toEqual({ ...body, id: action.id });
    expect(applied?.revertInfo).toEqual({ type: "noRevert" });
  });

  it("settles a replayed apply on a fresh activation over the same storage", async () => {
    const kv = fakeKv();
    const first = await stage(bind(kv).actions);
    await bind(kv).actions.apply(first.id);

    // A restart between the settle and the Workshop recording its approval replays the apply.
    const dispatch = vi.fn(async () => {});
    await expect(bind(kv, { dispatch }).actions.apply(first.id)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses to re-dispatch a claim left by an attempt that died mid-dispatch", async () => {
    const kv = fakeKv();
    const action = await stage(bind(kv).actions);
    // The dying attempt claims, enters dispatch, and never settles: an isolate restart mid-call.
    // Entering dispatch proves the claim row was written -- dispatch runs strictly after it.
    const enteredDispatch = Promise.withResolvers<void>();
    void bind(kv, {
      dispatch: () => {
        enteredDispatch.resolve();
        return neverSettles();
      },
    }).actions.apply(action.id);
    await enteredDispatch.promise;

    const dispatch = vi.fn(async () => {});
    const revived = bind(kv, { dispatch });
    await expect(revived.actions.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    // The device was driven exactly once, by the attempt that died; the replay never dispatches.
    expect(dispatch).not.toHaveBeenCalled();
    // The refusal is terminal: every later apply answers with the recorded reason, no dispatch.
    await expect(revived.actions.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(dispatch).not.toHaveBeenCalled();
    expect(revived.journal.listPending()).toEqual([]);
  });

  it("serializes concurrent applies of one id into a single dispatch", async () => {
    const kv = fakeKv();
    const enteredDispatch = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const dispatch = vi.fn(async () => {
      enteredDispatch.resolve();
      await gate.promise;
    });
    const { journal, actions } = bind(kv, { dispatch });
    const action = await stage(actions);

    const first = actions.apply(action.id);
    const second = actions.apply(action.id);
    // While the first dispatch is in flight, the second has not dispatched anything.
    await enteredDispatch.promise;
    expect(dispatch).toHaveBeenCalledTimes(1);
    gate.resolve();

    await Promise.all([first, second]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(appliedAction(journal, kv, action.id)).toBeDefined();
  });

  it("records a dispatch with no response as a terminal, surfaced unknown outcome", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn(() => Promise.reject(new HomeAssistantError(
      "Home Assistant did not respond within 15000ms (http://ha.local).",
      { outcomeUnknown: true },
    )));
    const { journal, actions } = bind(kv, { dispatch });
    const action = await stage(actions);

    await expect(actions.apply(action.id))
      .rejects.toThrow(`${APPLY_OUTCOME_UNKNOWN_MESSAGE} (Home Assistant did not respond`);
    // The record answers later attempts with the same message instead of re-dispatching.
    await expect(actions.apply(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(journal.listPending()).toEqual([]);
  });

  it("keeps an answered failure pending and retryable", async () => {
    const kv = fakeKv();
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new HomeAssistantError(
        "Home Assistant returned HTTP 400: service not found",
        { status: 400 },
      ))
      .mockResolvedValueOnce(undefined);
    const { journal, actions } = bind(kv, { dispatch });
    const action = await stage(actions);

    await expect(actions.apply(action.id)).rejects.toThrow("HTTP 400");
    expect(journal.listPending().map(({ id }) => id)).toEqual([action.id]);

    await actions.apply(action.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(appliedAction(journal, kv, action.id)?.action).toEqual({ ...body, id: action.id });
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
    const { journal, actions } = bind(kv, { dispatch, onAuthError });
    const action = await stage(actions);

    await expect(actions.apply(action.id)).rejects.toThrow("rejected the access token");
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(journal.listPending().map(({ id }) => id)).toEqual([action.id]);

    await actions.apply(action.id);
    expect(appliedAction(journal, kv, action.id)).toBeDefined();
  });

  it("refuses to reject an action whose dispatch may still be in flight", async () => {
    const kv = fakeKv();
    const action = await stage(bind(kv).actions);
    const enteredDispatch = Promise.withResolvers<void>();
    void bind(kv, {
      dispatch: () => {
        enteredDispatch.resolve();
        return neverSettles();
      },
    }).actions.apply(action.id);
    await enteredDispatch.promise;

    const { journal, actions } = bind(kv);
    await expect(actions.reject(action.id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(appliedAction(journal, kv, action.id)).toBeUndefined();

    // Once the user has checked the device, a rejection clears the recorded failure.
    await expect(actions.reject(action.id)).resolves.toBeUndefined();
    expect(journal.listPending()).toEqual([]);
    expect(appliedAction(journal, kv, action.id)).toBeUndefined();
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
    const { journal, actions } = bind(kv, { dispatch });
    expect(journal.listPending().map(({ id }) => withActionId(body, id))).toEqual([
      { ...body, id: 5 },
    ]);

    const next = await stage(actions);
    expect(next.id).toBe(8);

    await actions.apply(5);
    expect(dispatch).toHaveBeenCalledWith({ ...body, id: 5 });
    expect(appliedAction(journal, kv, 5)?.action).toEqual({ ...body, id: 5 });
    expect(kv.keys()).not.toContain("counter:nextActionId");
  });

  it("rolls back a staged submission the approval queue refused", async () => {
    const kv = fakeKv();
    const { journal, actions } = bind(kv);
    const refused = { submitAction: vi.fn(async () => { throw new Error("queue gone"); }) };

    // The queue refusing the submission rolls the staged record back; the id is not reused, so
    // the overseer never sees two actions share one.
    await expect(actions.submit(refused, "callService", body)).rejects.toThrow("queue gone");
    expect(journal.listPending()).toEqual([]);
    expect(kv.keys()).toEqual(["counter:nextFreeActionId"]);

    const next = await stage(actions);
    // The failed submission's id was consumed, never reused.
    expect(next.id).toBe(2);
    expect(journal.listPending().map(({ id }) => id)).toEqual([next.id]);
  });
});
