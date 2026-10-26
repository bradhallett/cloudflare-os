// Triggers and webhooks end to end: the createTrigger approval gate, the enable/disable
// lifecycle against the upstream, webhook ingest (signature, dedupe, quota, expiry routing),
// authorizeObservation-gated delivery with retry, reconciliation drift repair, key-mode
// migration of trigger instances, and the worker's public webhook route. Delete the
// no-row-on-upstream-failure branch in account.ts's enableTrigger, the dedupe put, or the
// reconcile walk, and this file fails.

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposioAccount } from "../../src/account.js";
import { signWebhook } from "../../src/webhooks.js";
import { githubSpec } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");

const testEnv = env as unknown as {
  COMPOSIO_ACCOUNT: DurableObjectNamespace<ComposioAccount>;
};

const account = (name: string) => testEnv.COMPOSIO_ACCOUNT.getByName(name);

/** A trigger-event envelope for `upstreamId`, routed to the account by its metadata. */
function triggerEnvelope(
  id: string,
  upstreamId: string,
  accountName: string,
  data: unknown = { number: 7 },
) {
  return {
    id,
    type: "composio.trigger.message",
    timestamp: new Date().toISOString(),
    metadata: {
      trigger_id: upstreamId,
      trigger_slug: "github_issue_opened",
      user_id: `workshop-${accountName}`,
    },
    data,
  };
}

/** A connected-account-expiry envelope, optionally carrying the routing user_id. */
function expiredEnvelope(id: string, accountName: string | null) {
  return {
    id,
    type: "composio.connected_account.expired",
    timestamp: new Date().toISOString(),
    data: {
      id: `cac_${id}`,
      toolkit: { slug: "github" },
      status_reason: "token expired",
      ...(accountName === null ? {} : { user_id: `workshop-${accountName}` }),
    },
  };
}


/** Accounts whose Durable Objects this file has touched, so their alarms die with the test. */
const touchedAccounts = new Set<string>();

afterEach(async () => {
  hooks.installFake(null);
  // A trailing alarm (delivery backoff, reconcile pull-in) firing inside a later test would
  // hit that test's fake upstream and mutate its recordings: cancel every touched alarm.
  for (const name of touchedAccounts) {
    await runInDurableObject(account(name), (_instance, state) => {
      state.storage.deleteAlarm();
    });
  }
  touchedAccounts.clear();
});

beforeEach(async () => {
  // Earlier files' accounts can leave trailing alarms that would fire inside this file and
  // corrupt the fake upstream's recordings: cancel every registered account's alarm first.
  for (const name of await hooks.drainAccountAlarmRegistry()) {
    await runInDurableObject(account(name), (_instance, state) => {
      state.storage.deleteAlarm();
    });
  }
  await hooks.resetInitiator();
});

afterAll(async () => {
  // The pool tears down soon after; a trailing alarm firing then reports as a hung worker
  // (cloudflare/workers-sdk#14180), so the last accounts' alarms die here too.
  for (const name of [...touchedAccounts, ...await hooks.drainAccountAlarmRegistry()]) {
    await runInDurableObject(account(name), (_instance, state) => {
      state.storage.deleteAlarm();
    });
  }
});

/** Runs the account's alarm at `ms` from now, on a faked clock the runtime never wakes for. */
async function alarmAfter(ms: number, accountName: string): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  try {
    await runDurableObjectAlarm(account(accountName));
  } finally {
    vi.useRealTimers();
  }
}

/** Provisions a key, opens the singleton session, and enables one armed trigger. */
async function armedTrigger(accountName: string): Promise<string> {
  // Facet names are unique per account: a reused facet DO would keep its first account.
  const facet = `${accountName}-f`;
  touchedAccounts.add(accountName);
  hooks.installFake(githubSpec([]));
  await hooks.provisionOwnKey(accountName, "own-key-1");
  await hooks.singletonSession(accountName, facet);
  const created = await hooks.createTrigger(facet, {
    triggerSlug: "github_issue_opened",
    filters: { repo: "acme/api" },
  });
  if (!created.ok) throw new Error(created.message);
  await hooks.enableCapturedHook(facet, 0, { workspaceId: "ws-a" });
  await hooks.resetInitiator();
  return created.value;
}

describe("trigger lifecycle", () => {
  it("parks createTrigger at the approval gate with the event, filters, and destination named", async () => {
    hooks.installFake(githubSpec([]));
    await hooks.provisionOwnKey("trig-gate", "own-key-1");
    await hooks.singletonSession("trig-gate", "trig-gate-f");
    const created = await hooks.createTrigger("trig-gate-f", {
      triggerSlug: "github_issue_opened",
      filters: { repo: "acme/route" },
    });
    expect(created.ok).toBe(true);
    // Before approval, nothing upstream and no row: the gate is the only side effect.
    expect(await hooks.accountTriggers("trig-gate")).toEqual([]);
    expect((await hooks.triggerUpstreamState()).upserts).toEqual([]);

    const descriptions = await hooks.capturedHooks("trig-gate-f");
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].title).toContain("github_issue_opened");
    expect(descriptions[0].description).toContain("github_issue_opened");
    expect(descriptions[0].description).toContain("acme/route");
    // Destination is enable-time metadata (HookTargetMetadata), asserted via the row in later tests.
  });

  it("enables on approval: subscription, upstream upsert, and a trigger row", async () => {
    hooks.installFake(githubSpec([]));
    await hooks.provisionOwnKey("trig-enable", "own-key-1");
    await hooks.singletonSession("trig-enable", "trig-enable-f");
    await hooks.createTrigger("trig-enable-f", { triggerSlug: "github_issue_opened" });
    await hooks.enableCapturedHook("trig-enable-f", 0, { workspaceId: "ws-a" });

    const state = await hooks.triggerUpstreamState();
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].url).toBe("https://composio.test/webhook");
    expect(state.upserts).toMatchObject([
      { slug: "github_issue_opened", userId: "workshop-trig-enable" },
    ]);
    const rows = await hooks.accountTriggers("trig-enable");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "ws-a", triggerSlug: "github_issue_opened" });
  });

  it("leaves no row when the upstream upsert fails, then succeeds on retry", async () => {
    hooks.installFake(githubSpec([]));
    await hooks.provisionOwnKey("trig-fail", "own-key-1");
    await hooks.singletonSession("trig-fail", "trig-fail-f");
    await hooks.createTrigger("trig-fail-f", { triggerSlug: "github_issue_opened" });
    await hooks.mutateTriggers({ failUpserts: 1 });

    const failed = await hooks.enableCapturedHook("trig-fail-f", 0, { workspaceId: "ws-a" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).toContain("upstream unavailable");
    expect(await hooks.accountTriggers("trig-fail")).toEqual([]);
    expect((await hooks.triggerUpstreamState()).instances).toEqual([]);

    const retried = await hooks.enableCapturedHook("trig-fail-f", 0, { workspaceId: "ws-a" });
    expect(retried.ok).toBe(true);
    expect(await hooks.accountTriggers("trig-fail")).toHaveLength(1);
  });

  it("disable deletes the upstream instance, drops the row, and disposes the initiator", async () => {
    await armedTrigger("trig-disable");
    const before = await hooks.triggerUpstreamState();
    expect(before.instances).toHaveLength(1);
    const upstreamId = before.instances[0].id;

    await hooks.disableCapturedHook("trig-disable-f", 0);

    const after = await hooks.triggerUpstreamState();
    expect(after.instances).toEqual([]);
    expect(after.instanceDeletes).toEqual([upstreamId]);
    expect(await hooks.accountTriggers("trig-disable")).toEqual([]);
    // The initiator capability record is dropped with the row (the account code disposes the
    // stored stub; workerd does not propagate stub disposal through a storage roundtrip).
    const capsKeys = await runInDurableObject(account("trig-disable"), (_instance, state) =>
      [...state.storage.kv.list()].filter(([key]) => key.startsWith("triggerCaps:")).length);
    expect(capsKeys).toBe(0);
  });

  it("deleteTrigger on the session observes, then disarms through the account", async () => {
    await armedTrigger("trig-delete");
    const created = (await hooks.accountTriggers("trig-delete"))[0];

    const deleted = await hooks.deleteTriggerOnSession("trig-delete-f", created.triggerId);
    expect(deleted.ok).toBe(true);
    expect(await hooks.accountTriggers("trig-delete")).toEqual([]);
    expect((await hooks.triggerUpstreamState()).instances).toEqual([]);
  });
});

describe("webhook ingest", () => {
  it("dedupes a redelivered envelope id: one firing, one counted delivery", async () => {
    await armedTrigger("trig-dedupe");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    const envelope = triggerEnvelope("evt_dedupe", upstreamId, "trig-dedupe");

    await expect(hooks.ingestSignedWebhook("trig-dedupe", envelope)).resolves.toBe(200);
    await expect(hooks.ingestSignedWebhook("trig-dedupe", envelope)).resolves.toBe(200);
    await runDurableObjectAlarm(account("trig-dedupe"));

    expect((await hooks.readInitiator()).firings).toHaveLength(1);
    expect(await hooks.usage("trig-dedupe")).toMatchObject({
      events: { delivered: 1, dropped: 0, limit: 500 },
    });
  });

  it("drops the 501st event of a workspace day and counts it visibly", async () => {
    await armedTrigger("trig-quota");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    for (let i = 0; i < 501; i++) {
      const status = await hooks.ingestSignedWebhook(
        "trig-quota", triggerEnvelope(`evt_quota_${i}`, upstreamId, "trig-quota"));
      expect(status).toBe(200);
    }
    // The queue caps deliveries per alarm run: drain to quiescence on an advancing clock.
    for (let drained = 0; drained < 40; drained++) {
      await alarmAfter(1_000, "trig-quota");
      if ((await hooks.readInitiator()).firings.length >= 500) break;
    }

    expect(await hooks.usage("trig-quota")).toMatchObject({
      events: { delivered: 500, dropped: 1, limit: 500 },
    });
    expect((await hooks.readInitiator()).firings).toHaveLength(500);
  }, 120_000);

  it("refuses a wrong signature, a stale timestamp, and heals after upstream rotation", async () => {
    await armedTrigger("trig-sig");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;

    await expect(hooks.ingestSignedWebhook(
      "trig-sig", triggerEnvelope("evt_wrong", upstreamId, "trig-sig"),
      { secret: "whsec_not-the-one" },
    )).resolves.toBe(401);
    await expect(hooks.ingestSignedWebhook(
      "trig-sig", triggerEnvelope("evt_stale", upstreamId, "trig-sig"),
      { ageSeconds: 400 },
    )).resolves.toBe(401);

    // Upstream rotated without telling us: the first delivery heals from the listing.
    await hooks.mutateTriggers({ rotateUpstreamSecret: true });
    const healed = triggerEnvelope("evt_healed", upstreamId, "trig-sig");
    await expect(hooks.ingestSignedWebhook("trig-sig", healed)).resolves.toBe(200);
  });

  it("rotates the stored secret on demand: the old secret stops verifying", async () => {
    await armedTrigger("trig-rotate");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    const oldSecret = await hooks.fakeWebhookSecret();

    const rotated = await hooks.rotateWebhookSecretOnAccount("trig-rotate");
    expect(rotated.ok).toBe(true);
    expect((await hooks.triggerUpstreamState()).rotations).toHaveLength(1);

    await expect(hooks.ingestSignedWebhook(
      "trig-rotate", triggerEnvelope("evt_old", upstreamId, "trig-rotate"),
      { secret: oldSecret },
    )).resolves.toBe(401);
    await expect(hooks.ingestSignedWebhook(
      "trig-rotate", triggerEnvelope("evt_new", upstreamId, "trig-rotate"),
    )).resolves.toBe(200);
  });

  it("records expiry notices for routed connected-account expiries", async () => {
    await armedTrigger("trig-expired");

    await expect(hooks.ingestSignedWebhook(
      "trig-expired", expiredEnvelope("evt_exp_1", "trig-expired"),
    )).resolves.toBe(200);
    const notices = await hooks.accountExpiryNotices("trig-expired");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ toolkitSlug: "github" });
  });
});

describe("delivery", () => {
  it("gates every event on authorizeObservation, retrying after a refusal", async () => {
    await armedTrigger("trig-gating");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    await hooks.configureInitiator("authorization-reject");
    await hooks.ingestSignedWebhook(
      "trig-gating", triggerEnvelope("evt_gate", upstreamId, "trig-gating"));
    await runDurableObjectAlarm(account("trig-gating"));

    const refused = await hooks.readInitiator();
    expect(refused.firings).toEqual([]);
    expect(refused.observations).toEqual([]);
    expect(refused.startHookCalls).toBe(1);

    await hooks.configureInitiator("success");
    await alarmAfter(60_000, "trig-gating"); // the queue's first backoff step is one minute

    const delivered = await hooks.readInitiator();
    expect(delivered.firings).toHaveLength(1);
    expect(delivered.firings[0]).toMatchObject({ triggerSlug: "github_issue_opened" });
    expect(delivered.observations).toHaveLength(1);
    expect(delivered.observations[0].title).toContain("github_issue_opened");
  });

  it("reconciles a missing upstream instance by re-upserting it", async () => {
    await armedTrigger("trig-recon");
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    await hooks.mutateTriggers({ killInstance: upstreamId });
    expect((await hooks.triggerUpstreamState()).instances).toEqual([]);

    await runDurableObjectAlarm(account("trig-recon"));

    const state = await hooks.triggerUpstreamState();
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0].userId).toBe("workshop-trig-recon");
    expect(state.upserts).toHaveLength(2);
    expect(await hooks.accountTriggers("trig-recon")).toHaveLength(1);
  });

  it("deletes an orphaned upstream instance, sparing other users'", async () => {
    await armedTrigger("trig-orphan");
    await hooks.mutateTriggers({ injectInstance: {
      id: "ti_orphan", triggerName: "github_pr_merged",
      userId: "workshop-trig-orphan",
    } });
    await hooks.mutateTriggers({ injectInstance: {
      id: "ti_foreign", triggerName: "github_pr_merged", userId: "someone-else",
    } });

    await runDurableObjectAlarm(account("trig-orphan"));

    const state = await hooks.triggerUpstreamState();
    expect(state.instanceDeletes).toContain("ti_orphan");
    const ids = state.instances.map(row => row.id);
    expect(ids).not.toContain("ti_orphan");
    expect(ids).toContain("ti_foreign");
    expect(ids.filter(id => id !== "ti_foreign")).toHaveLength(1); // the account's own trigger
  });
});

describe("key-mode migration", () => {
  it("re-upserts trigger instances under the new own key, deleting the old", async () => {
    await armedTrigger("trig-switch");
    const firstId = (await hooks.triggerUpstreamState()).instances[0].id;

    await expect(hooks.provisionOwnKey("trig-switch", "own-key-2")).resolves.toMatchObject({
      ok: true,
    });

    const state = await hooks.triggerUpstreamState();
    expect(state.upserts).toHaveLength(2);
    expect(state.instanceDeletes).toContain(firstId);
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0].userId).toBe("workshop-trig-switch");
    expect(await hooks.accountTriggers("trig-switch")).toHaveLength(1);
  });
});

describe("worker webhook route", () => {
  // Each test gets its own uuid-shaped account: the worker route routes by that shape.
  const uuidE2E = "1eea4d10-7c70-4d3e-9d8e-2b2a5f1b0d01";
  const uuidSig = "2ffb51c2-9f50-4b57-91e2-6db5198a3f02";
  const uuidQuiet = "3ad0e3b4-5b6c-4d7e-8f90-a1b2c3d4e5f3";

  /** POSTs one envelope to the public webhook route, signed with the fake's current secret. */
  async function signedPost(
    envelope: Record<string, unknown>,
    options?: { secret?: string; omitHeaders?: boolean },
  ): Promise<Response> {
    const rawBody = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signWebhook({
      webhookId: String(envelope.id), timestamp, rawBody,
      secret: options?.secret ?? ((await hooks.fakeWebhookSecret()) || "whsec_unsigned"),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options?.omitHeaders !== true) {
      headers["webhook-id"] = String(envelope.id);
      headers["webhook-timestamp"] = timestamp;
      headers["webhook-signature"] = signature;
    }
    return await SELF.fetch("https://composio.test/webhook", {
      method: "POST", headers, body: rawBody,
    });
  }

  it("accepts a signed trigger delivery end to end, and delivers after the alarm", async () => {
    await armedTrigger(uuidE2E);
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    const response = await signedPost(triggerEnvelope("evt_route", upstreamId, uuidE2E));
    expect(response.status).toBe(200);
    await runDurableObjectAlarm(account(uuidE2E));
    expect((await hooks.readInitiator()).firings).toHaveLength(1);
  });

  it("refuses a bad signature with 401, and demands all three headers", async () => {
    await armedTrigger(uuidSig);
    const upstreamId = (await hooks.triggerUpstreamState()).instances[0].id;
    const refused = await signedPost(
      triggerEnvelope("evt_bad", upstreamId, uuidSig), { secret: "whsec_wrong" });
    expect(refused.status).toBe(401);

    const headerless = await signedPost(
      triggerEnvelope("evt_bad2", upstreamId, uuidSig), { omitHeaders: true });
    expect(headerless.status).toBe(400);
  });

  it("acknowledges events for accounts this deployment never minted, without routing", async () => {
    const response = await signedPost(triggerEnvelope("evt_notours", "ti_x", "not-a-uuid"));
    expect(response.status).toBe(200);
    // The account gate rejected the id before any account was reached: no side effects exist.
    expect(await hooks.accountTriggers("not-a-uuid")).toEqual([]);
  });

  it("acknowledges an unroutable expiry and an unsubscribed event type", async () => {
    await armedTrigger(uuidQuiet);
    const unknown = {
      ...triggerEnvelope("evt_unknown", "ti_y", uuidQuiet),
      type: "composio.random",
    };
    for (const envelope of [expiredEnvelope("evt_nouser", null), unknown]) {
      const response = await signedPost(envelope);
      expect(response.status).toBe(200);
    }
    expect(await hooks.accountExpiryNotices(uuidQuiet)).toEqual([]);
    expect((await hooks.readInitiator()).firings).toEqual([]);
  });

  it("serves the Connect Link callback page", async () => {
    const response = await SELF.fetch("https://composio.test/connect-callback");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
