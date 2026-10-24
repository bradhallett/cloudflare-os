// checkUsageAndBalance consults the optional SAAS_ENTITLEMENTS port for the policy it
// enforces (daily limit / minimum balance). With no binding — every OSS deployment — the
// env-configured policy applies with no RPC, identical to pre-port behavior. With a bound
// port, the port's policy decides; a failing port falls back to env config rather than
// blocking or crashing model calls (see src/entitlements.ts).

import { describe, expect, it } from "vitest";
import type { UsagePolicy } from "@gadgets/workshop-shared/entitlements";
import { resolveUsagePolicy } from "../src/entitlements.js";
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

// A fake port recording the users it was asked about, answering the given policy (or throwing it).
function fakePort(answer: UsagePolicy | Error) {
  const queried: string[] = [];
  const port = {
    resolveUsagePolicy: async (query: { userId: string }) => {
      queried.push(query.userId);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { queried, port: port as unknown as NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]> };
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
