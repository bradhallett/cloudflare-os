import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportIssue } from "@gadgets/observability/error-reporting";
import { ScheduleDriver } from "../src/schedule-driver.js";
import { enableSchedule, gadgetId, makeActiveScheduleDue } from "./driver-harness.js";
import type { TestHooks } from "./driver-harness.js";

vi.mock("@gadgets/observability/error-reporting", () => ({ reportIssue: vi.fn() }));
// Shrink the recovery lease so a lease-deadline timeout lands within a couple of seconds of real
// time. Real timers, not fake ones: the deadline timer belongs to the alarm handler's workerd
// execution context, and a faked global clock fires it from the wrong context, where workerd
// refuses the storage and span I/O the timeout path performs. The mock lives in this file only;
// the main driver suite keeps the production lease for its alarm-arming expectations.
vi.mock("../src/driver-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/driver-state.js")>()),
  RECOVERY_DELAY_MS: 2_000,
}));

const testEnv = env as unknown as {
  SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

describe("ScheduleDriver lease deadlines", () => {
  beforeEach(() => {
    vi.mocked(reportIssue).mockClear();
    return testEnv.TEST_HOOKS.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    return reset();
  });

  it("fails a hung callback at its lease deadline and keeps delivering sibling schedules", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("delivery-lease-timeout");
    const activationTime = Date.now();
    for (const scheduleId of ["healthy", "hung"]) {
      await enableSchedule(
        driver,
        {
          workspaceId: "workspace-a",
          scheduleId,
          spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
          title: scheduleId,
          description: "Test lease-deadline delivery fencing.",
          gadgetId,
        },
        activationTime,
      );
    }
    await makeActiveScheduleDue(driver, "workspace-a", "healthy");
    await makeActiveScheduleDue(driver, "workspace-a", "hung");
    await testEnv.TEST_HOOKS.hang("callback", "hung");

    // The alarm still completes on its own: the lease deadline fails the parked delivery exactly
    // like a callback failure would, and the healthy sibling was delivered inside the same alarm.
    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "healthy"))?.state).toMatchObject({
      status: "active",
    });
    expect((await testEnv.TEST_HOOKS.read()).callbackScheduleIds).toEqual(["healthy", "hung"]);
    expect((await driver.getSchedule("workspace-a", "hung"))?.state).toMatchObject({
      status: "retrying",
      attempts: 1,
    });
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.delivery.timeout",
      expect.any(Error),
      expect.objectContaining({
        handled: true,
        attributes: expect.objectContaining({ scheduleId: "hung" }),
      }),
    );

    // The abandoned delivery settling late cannot double-settle the fenced run. Real delay by
    // necessity: fake timers cannot fire the workerd I/O the settlement rides on.
    await testEnv.TEST_HOOKS.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await driver.getSchedule("workspace-a", "hung"))?.state).toMatchObject({
      status: "retrying",
      attempts: 1,
    });

    // Later work keeps flowing while the account still holds the abandoned callback call.
    await makeActiveScheduleDue(driver, "workspace-a", "healthy");
    await runDurableObjectAlarm(driver);
    expect((await testEnv.TEST_HOOKS.read()).callbackScheduleIds).toEqual([
      "healthy",
      "hung",
      "healthy",
    ]);
  });

  it("skips a hung admission at its lease deadline without consuming an attempt", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("admission-lease-timeout");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Hung admission",
        description: "Test lease-deadline admission fencing.",
        gadgetId,
      },
      activationTime,
    );
    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    await testEnv.TEST_HOOKS.hang("start");

    await runDurableObjectAlarm(driver);

    // An admission that never resolves is skipped exactly like an admission rejection: the
    // occurrence is gone without consuming an attempt, and the schedule waits for its next fire.
    const skipped = await driver.getSchedule("workspace-a", "schedule-a");
    expect(skipped?.state).toMatchObject({ status: "active" });
    expect(
      skipped?.state.status === "active" ? skipped.state.nextFire : undefined,
    ).toBeGreaterThan(activationTime);
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual(["start"]);
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.delivery.timeout",
      expect.any(Error),
      expect.objectContaining({ handled: true }),
    );

    // The admission settling late cannot deliver a callback for the skipped occurrence. Real
    // delay by necessity: fake timers cannot fire the workerd I/O the settlement rides on.
    await testEnv.TEST_HOOKS.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual(["start"]);
    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "active",
    });
  });
});
