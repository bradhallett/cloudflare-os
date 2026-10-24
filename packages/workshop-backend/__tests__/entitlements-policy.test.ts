// checkUsageAndBalance consults the optional SAAS_ENTITLEMENTS port for the policy it
// enforces (daily limit / minimum balance) and, only once that policy would block a call, for
// the plan's overage allowance. With no binding — every OSS deployment — the env-configured
// policy applies with no RPC and a block behaves exactly as pre-port code, identical bytes. With
// a bound port, the port's policy decides, an overage-allowing plan proceeds past the exhausted
// allowance (the SaaS meters the spend), and a failing port falls back to env config / no gate
// rather than blocking or crashing model calls (see src/entitlements.ts).

import { describe, expect, it } from "vitest";
import type { Entitlements, UsagePolicy } from "@gadgets/workshop-shared/entitlements";
import { resolveEntitlements, resolveUsagePolicy } from "../src/entitlements.js";
import { checkUsageAndBalance } from "../src/ai-gateway-billing/limits/usage-checker.js";
import type { UserDurableObject } from "../src/user.js";

const USER_ID = "0123456789abcdef0123456789abcdef";

// A user stub connected to no Cloudflare account, recording the daily limit each
// consumeDailyLlmCall() was issued with. resolveConnection() no-ops on the missing account, so
// the checker takes the free-tier path with no network.
function fakeUserStub(withinLimits: boolean) {
  const limits: number[] = [];
  const stub = {
    getCloudflareGatekeeperAccount: async () => null,
    consumeDailyLlmCall: async (limit: number) => {
      limits.push(limit);
      return {
        withinLimits, limit,
        used: withinLimits ? limit - 1 : limit,
        remaining: withinLimits ? 1 : 0,
        resetAt: "...",
      };
    },
  };
  return { limits, stub: stub as unknown as DurableObjectStub<UserDurableObject> };
}

// A fake port recording the users it was asked about, answering the given policy and
// entitlements (or throwing the error given in its place).
function fakePort(answer: UsagePolicy | Error, entitlements?: Entitlements | Error) {
  const queried: string[] = [];
  const queriedEntitlements: string[] = [];
  const port = {
    resolveUsagePolicy: async (query: { userId: string }) => {
      queried.push(query.userId);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    getEntitlements: async (query: { userId: string }) => {
      queriedEntitlements.push(query.userId);
      if (entitlements === undefined || entitlements instanceof Error) {
        throw entitlements ?? new Error("entitlements down");
      }
      return entitlements;
    },
  };
  return {
    queried, queriedEntitlements,
    port: port as unknown as NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
  };
}

// The plan answer the overage tests switch on: hard-capped vs overage-allowing.
function planEntitlements(overageAllowed: boolean): Entitlements {
  return {
    plan: overageAllowed ? "pro" : "free",
    seats: 1,
    monthlySpendCapUsd: overageAllowed ? 500 : 5,
    overageAllowed,
    allowedModelTiers: ["standard"],
    allowedGatekeepers: [],
  };
}

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    ENABLE_CLOUDFLARE_LIMITS: "true",
    DAILY_LLM_CALL_LIMIT: "7",
    MINIMUM_CLOUDFLARE_BALANCE: "5",
    ...overrides,
  } as Cloudflare.Env;
}

describe("resolveUsagePolicy (SaaS entitlements adapter)", () => {
  it("returns the env-configured policy when no port is bound", async () => {
    expect(await resolveUsagePolicy(env(), USER_ID))
      .toEqual({ dailyLlmCallLimit: 7, minimumBalance: 5 });
  });

  it("asks the bound port for the user's policy", async () => {
    const { queried, port } = fakePort({ dailyLlmCallLimit: 3, minimumBalance: 9 });
    expect(await resolveUsagePolicy(env({ SAAS_ENTITLEMENTS: port }), USER_ID))
      .toEqual({ dailyLlmCallLimit: 3, minimumBalance: 9 });
    expect(queried).toEqual([USER_ID]);
  });

  it("falls back to env config when the port fails", async () => {
    const { port } = fakePort(new Error("entitlements down"));
    expect(await resolveUsagePolicy(env({ SAAS_ENTITLEMENTS: port }), USER_ID))
      .toEqual({ dailyLlmCallLimit: 7, minimumBalance: 5 });
  });
});

describe("checkUsageAndBalance consults the entitlements port", () => {
  it("unbound: enforces the env-configured limit, as before the port existed", async () => {
    const user = fakeUserStub(true);
    const result = await checkUsageAndBalance(env(), user.stub, USER_ID);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(7);
    expect(result.shouldUseByok).toBe(false);
    expect(user.limits).toEqual([7]);
  });

  it("bound: enforces the port's limit", async () => {
    const user = fakeUserStub(true);
    const { queried, port } = fakePort({ dailyLlmCallLimit: 3, minimumBalance: 9 });
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(3);
    expect(queried).toEqual([USER_ID]);
    expect(user.limits).toEqual([3]);
  });

  it("bound: blocks with the usage-limit surface once the port's limit is spent", async () => {
    const user = fakeUserStub(false);
    const { port } = fakePort({ dailyLlmCallLimit: 3, minimumBalance: 9 });
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Free usage limit reached");
    expect(user.limits).toEqual([3]);
  });

  it("bound but failing port: falls back to the env-configured policy", async () => {
    const user = fakeUserStub(true);
    const { port } = fakePort(new Error("entitlements down"));
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(7);
    expect(user.limits).toEqual([7]);
  });

  it("limits disabled: unlimited and the port is never consulted", async () => {
    const user = fakeUserStub(true);
    const { queried, port } = fakePort({ dailyLlmCallLimit: 3, minimumBalance: 9 });
    const result = await checkUsageAndBalance(
      env({ ENABLE_CLOUDFLARE_LIMITS: undefined, SAAS_ENTITLEMENTS: port }),
      user.stub, USER_ID);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(Infinity);
    expect(queried).toEqual([]);
    expect(user.limits).toEqual([]);
  });
});

describe("checkUsageAndBalance applies the plan's overage policy at the exhausted allowance", () => {
  // The snapshot of a hard block, shared by every path that must behave like no port at all.
  const hardBlock = {
    allowed: false,
    reason: "Free usage limit reached. Connect your Cloudflare account to continue.",
    shouldUseByok: true,
    withinLimits: false,
    remaining: 0,
    limit: 3,
    windowKind: "daily",
    resetAt: "...",
    balance: null,
    hasUserToken: false,
  };

  it("unbound: blocks exactly as pre-port code did", async () => {
    const user = fakeUserStub(false);
    // Same policy the port hands the bound tests below, but via env config and no binding: the
    // two blocks must match byte-for-byte.
    const result = await checkUsageAndBalance(
        env({ DAILY_LLM_CALL_LIMIT: "3", MINIMUM_CLOUDFLARE_BALANCE: "9" }), user.stub, USER_ID);
    expect(result).toEqual(hardBlock);
  });

  it("hard-capped plan: the block is byte-identical to the unbound one", async () => {
    const user = fakeUserStub(false);
    const { port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, planEntitlements(false));
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result).toEqual(hardBlock);
  });

  it("overage-allowing plan: proceeds on the platform, unmetered by the checker", async () => {
    const user = fakeUserStub(false);
    const { queriedEntitlements, port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, planEntitlements(true));
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result).toEqual({
      ...hardBlock,
      allowed: true,
      reason: undefined,
      shouldUseByok: false,
    });
    expect(queriedEntitlements).toEqual([USER_ID]);
  });

  it("failing entitlements consult: falls back to the block, never to a crash", async () => {
    const user = fakeUserStub(false);
    const { port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, new Error("entitlements down"));
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result).toEqual(hardBlock);
  });

  it("never consults entitlements while the allowance covers the call", async () => {
    const user = fakeUserStub(true);
    const { queriedEntitlements, port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, planEntitlements(true));
    const result = await checkUsageAndBalance(env({ SAAS_ENTITLEMENTS: port }), user.stub, USER_ID);
    expect(result.allowed).toBe(true);
    expect(result.shouldUseByok).toBe(false);
    expect(queriedEntitlements).toEqual([]);
  });
});

describe("resolveEntitlements (SaaS entitlements adapter)", () => {
  it("returns null when no port is bound, without consulting anything", async () => {
    expect(await resolveEntitlements(env(), USER_ID)).toBeNull();
  });

  it("asks the bound port for the user's entitlements", async () => {
    const { queriedEntitlements, port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, planEntitlements(true));
    expect(await resolveEntitlements(env({ SAAS_ENTITLEMENTS: port }), USER_ID))
        .toEqual(planEntitlements(true));
    expect(queriedEntitlements).toEqual([USER_ID]);
  });

  it("returns null when the port fails, so no plan gate applies", async () => {
    const { port } = fakePort(
        { dailyLlmCallLimit: 3, minimumBalance: 9 }, new Error("entitlements down"));
    expect(await resolveEntitlements(env({ SAAS_ENTITLEMENTS: port }), USER_ID)).toBeNull();
  });
});
