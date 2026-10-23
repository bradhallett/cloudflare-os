import type { RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import type { ScheduledTaskHook } from "../src/types.js";
import type { ScheduleActivation, ScheduleDriver, StoredSchedule } from "../src/schedule-driver.js";

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;

/** Exports the test worker attaches for minting in-Worker initiator fetchers. */
type WorkerTestExports = { TestHooks(options: object): Fetcher<TestHooks> };

/** RPC surface of the persistent initiator defined in `__tests__/worker.ts`. */
export type TestHooks = HookInitiator<ScheduleHookTarget> & {
  configure(
    mode: "success" | "start-reject" | "authorization-reject" | "callback-reject",
  ): Promise<void>;
  blockAt(point: "start" | "authorization" | "callback"): Promise<void>;
  holdCallbacksUntilConcurrent(count: number): Promise<void>;
  hang(point: "start" | "authorization" | "callback", scheduleId?: string): Promise<void>;
  read(): Promise<{
    events: string[];
    callbackScheduleIds: string[];
    maxActiveCallbacks: number;
    disposedApprovalQueues: number;
    disposedCallbacks: number;
  }>;
  release(): Promise<void>;
  reset(): Promise<void>;
  waitForDisposals(
    target: { approvalQueues: number; callbacks: number },
    budgetMs: number,
  ): Promise<void>;
  waitUntilBlocked(): Promise<void>;
};

/** Gadget owning the schedules under test; matches the initiator's admission check. */
export const gadgetId = 3;

export function testInitiator(driver: ScheduleDriver): Fetcher<TestHooks> {
  // The pool wraps env capabilities, so mint the persistable entrypoint inside the Worker. Tests
  // run inside the object's isolate already; the cast only reaches the protected `ctx` handle.
  const holder = driver as unknown as { ctx: { exports: WorkerTestExports } };
  const exports = holder.ctx.exports;
  return exports.TestHooks({});
}

export function enableSchedule(
  driver: DurableObjectStub<ScheduleDriver>,
  activation: ScheduleActivation,
  now = Date.now(),
): Promise<void> {
  return runInDurableObject(driver, (instance) =>
    instance.enable(activation, testInitiator(instance), now),
  );
}

export async function updateSchedule(
  driver: DurableObjectStub<ScheduleDriver>,
  workspaceId: string,
  scheduleId: string,
  update: (stored: StoredSchedule) => StoredSchedule,
): Promise<void> {
  await runInDurableObject(driver, (_instance, state) => {
    const key = `schedule:${workspaceId}:${scheduleId}`;
    const stored = state.storage.kv.get<StoredSchedule>(key);
    if (!stored) throw new Error(`Missing test schedule: ${key}`);
    state.storage.kv.put(key, update(stored));
  });
}

export async function makeActiveScheduleDue(
  driver: DurableObjectStub<ScheduleDriver>,
  workspaceId: string,
  scheduleId: string,
): Promise<void> {
  await updateSchedule(driver, workspaceId, scheduleId, (stored) => {
    if (stored.state.status !== "active") throw new Error("Expected active schedule");
    return { ...stored, state: { ...stored.state, nextFire: 1 } };
  });
}
