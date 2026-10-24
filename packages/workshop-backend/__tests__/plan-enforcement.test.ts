// Plan enforcement (issue #16): the model-catalog, connector, and workspace-creation chokepoints
// consult the optional SAAS_ENTITLEMENTS port. Each gate is proven open and closed per plan
// here, against a real UserDurableObject hand-constructed with the port bound (the pattern the
// admin-settings suites use, since the test pool binds no entitlements worker). Unbound — every
// OSS deployment — and a failing port both behave exactly as pre-port code: the catalog lists
// everything, connectors mint, and workspaces are unlimited. The fourth chokepoint, spend caps
// and overage, is covered in entitlements-policy.test.ts against checkUsageAndBalance directly.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Entitlements } from "@gadgets/workshop-shared/entitlements";
import { serializeAdminConfig } from "../src/admin-config.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
import type { GadgetRecord } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// What a test reaches into the user DO for: the typed collection behind newGadget's cap count
// (its `storage` is private; this widens just the piece seeded here).
type UserInternals = UserDurableObject & {
  storage: { gadgets: { put(record: GadgetRecord): void } };
};

let counter = 0;

// The plan answer every test starts from, with the one field it switches on overridden.
function plan(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    plan: "free",
    seats: 1,
    monthlySpendCapUsd: 5,
    overageAllowed: false,
    allowedModelTiers: ["standard", "premium"],
    allowedGatekeepers: ["fakekee"],
    ...overrides,
  };
}

// A fake entitlements port recording the users it was asked about, answering `answer` (or
// throwing it, which the adapters read as "no entitlements" — gate open).
function entitlementsPort(answer: Entitlements | Error) {
  const userIds: string[] = [];
  return {
    userIds,
    port: {
      getEntitlements: async (query: { userId: string }) => {
        userIds.push(query.userId);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
  };
}

// The one resource the fake vendor below offers, marked creatable as the resource-creation
// mint requires.
const FAKE_RESOURCE = { urlPattern: "fakekee:widgets", title: "Fake widgets", creatable: true };

// A gatekeeper vendor that mints one resource class, enough for createResourceGatekeeper.
function fakeVendor() {
  return {
    describe: async () => ({ vendorId: "fakekee", title: "Fakekee" }),
    createResource: async () => ({ class: class FakeResource {}, resource: FAKE_RESOURCE }),
  } as unknown as Cloudflare.Env["GATEKEEPER_CONTEXT"];
}

/**
 * A real UserDurableObject over fresh storage, hand-constructed so its environment carries the
 * given entitlements answer (null: no binding, as OSS deployments run) and admin config. All of
 * a test's calls run inside one Durable Object invocation.
 */
function planUser(entitlements: Entitlements | Error | null, admin: Partial<AdminConfig> = {}) {
  const stub = env.TEST_USER.getByName(`plan-enforcement-${++counter}`);
  const port = entitlementsPort(entitlements ?? plan());
  const inDo = <T>(f: (user: UserDurableObject) => T | Promise<T>): Promise<T> =>
      runInDurableObject(stub, (_host: UserDurableObject, state: DurableObjectState) => f(
          new UserDurableObject(state, {
            CF_AI_GATEWAY: "platform-gateway",
            CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
            CF_AI_GATEWAY_API_TOKEN: "gateway-token",
            CF_AI_GATEWAY_PROVIDERS: "anthropic",
            BLUEPRINTS: {
              get: async () =>
                  serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...admin }),
            } as unknown as KVNamespace,
            GATEKEEPER_FAKEKEE: fakeVendor(),
            // The binding's absence is what makes a deployment OSS; a null answer above only
            // fakes the port's presence, so drop it entirely when unbound.
            ...(entitlements === null ? {} : { SAAS_ENTITLEMENTS: port.port }),
          } as unknown as Cloudflare.Env)));
  return { inDo, userIds: port.userIds };
}

// A call's outcome, with a rejection carried as its message so the pool never sees it as an
// unhandled rejection inside the Durable Object.
async function attempt<T>(f: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// A workspace the user owns (`owner` unset), or one shared with them (set).
function seedGadget(user: UserDurableObject, id: string, owner?: string) {
  (user as UserInternals).storage.gadgets.put({
    id, title: id, created: new Date(), ...(owner ? { owner } : {}),
  } as GadgetRecord);
}

// The anthropic language models the tests below see, split by catalog tier.
const STANDARD = "claude-haiku-4-5";
const PREMIUM = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];

const languageModelIds = async (user: UserDurableObject) =>
    (await user.listModels()).map(model => model.id);

describe("plan-enforced model tiers", () => {
  it("unbound: the catalog is unfiltered and every model runs", async () => {
    const { inDo } = planUser(null);
    const listed = await inDo(languageModelIds);
    expect(listed).toEqual(expect.arrayContaining([STANDARD, ...PREMIUM]));
    const chat = await inDo(user =>
        attempt(() => user.getChatContext("claude-fable-5-1")));
    expect("error" in chat).toBe(false);
  });

  it("a standard-only plan hides premium models from the catalog", async () => {
    const { inDo, userIds } = planUser(plan({ allowedModelTiers: ["standard"] }));
    const listed = await inDo(languageModelIds);
    console.log("TIERDEBUG", JSON.stringify({ listed, userIds }));
    expect(listed).toContain(STANDARD);
    expect(listed).not.toEqual(expect.arrayContaining(PREMIUM));
  });

  it("a standard-only plan refuses a premium model a chat names", async () => {
    const { inDo } = planUser(plan({ allowedModelTiers: ["standard"] }));
    expect(await inDo(user =>
        attempt(() => user.getChatContext("claude-fable-5-1"))))
        .toEqual({ error: 'The "Claude Fable 5.1" model isn\'t available on your plan.' });
  });

  it("a plan with the tier runs the model", async () => {
    const { inDo } = planUser(plan({ allowedModelTiers: ["standard", "premium"] }));
    const chat = await inDo(user =>
        attempt(() => user.getChatContext("claude-fable-5-1")));
    expect("error" in chat).toBe(false);
  });

  it("a plan allowing no tiers offers and runs no tiered model", async () => {
    const { inDo } = planUser(plan({ allowedModelTiers: [] }));
    expect(await inDo(languageModelIds)).toEqual([]);
    expect(await inDo(user =>
        attempt(() => user.getChatContext(STANDARD))))
        .toEqual({ error: 'The "Claude Haiku 4.5" model isn\'t available on your plan.' });
  });

  it("a failing port behaves as unbound", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    const listed = await inDo(languageModelIds);
    expect(listed).toEqual(expect.arrayContaining([STANDARD, ...PREMIUM]));
    const chat = await inDo(user =>
        attempt(() => user.getChatContext("claude-fable-5-1")));
    expect("error" in chat).toBe(false);
  });
});

describe("plan-enforced workspace caps", () => {
  const newGadget = (user: UserDurableObject, id: string) =>
      attempt(async () => {
        await user.newGadget(id, id);
        return "created";
      });

  it("caps at exactly the plan's workspaces: the next own one is refused", async () => {
    const { inDo } = planUser(plan({ maxWorkspaces: 2 }));
    await inDo(user => newGadget(user, "first"));
    await inDo(user => newGadget(user, "second"));
    expect(await inDo(user => newGadget(user, "third")))
        .toEqual({ error: "You've reached your plan's limit of 2 workspaces." });
  });

  it("counts only owned workspaces: shared ones never reach the cap", async () => {
    const { inDo } = planUser(plan({ maxWorkspaces: 1 }));
    await inDo(user => {
      seedGadget(user, "own");
      seedGadget(user, "shared-1", "someone-else");
      seedGadget(user, "shared-2", "someone-else");
    });
    expect(await inDo(user => newGadget(user, "second-own")))
        .toEqual({ error: "You've reached your plan's limit of 1 workspaces." });
  });

  it("a plan setting no cap leaves workspaces unlimited", async () => {
    const { inDo } = planUser(plan());
    await inDo(user => {
      for (let i = 0; i < 3; i++) seedGadget(user, `seed-${i}`);
    });
    expect(await inDo(user => newGadget(user, "fourth"))).toBe("created");
  });

  it("unbound: workspaces are unlimited", async () => {
    const { inDo } = planUser(null);
    await inDo(user => {
      for (let i = 0; i < 5; i++) seedGadget(user, `seed-${i}`);
    });
    expect(await inDo(user => newGadget(user, "sixth"))).toBe("created");
  });

  it("a failing port behaves as unbound", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    await inDo(user => {
      for (let i = 0; i < 5; i++) seedGadget(user, `seed-${i}`);
    });
    expect(await inDo(user => newGadget(user, "sixth"))).toBe("created");
  });

  it("registering an existing workspace is never capped", async () => {
    const { inDo } = planUser(plan({ maxWorkspaces: 0 }));
    await inDo(user => seedGadget(user, "already-here"));
    const outcome = await inDo(user =>
        attempt(async () => {
          await user.ensureGadgetRegistered("already-here", "Already here");
          return "registered";
        }));
    expect(outcome).toBe("registered");
  });
});

describe("plan-enforced connectors", () => {
  const mint = (user: UserDurableObject) =>
      attempt(() => user.createResourceGatekeeper("fakekee", FAKE_RESOURCE.urlPattern, "Widgets"));

  it("unbound: the connector mints", async () => {
    const { inDo } = planUser(null);
    expect("error" in (await inDo(mint))).toBe(false);
  });

  it("a plan listing the vendor mints; one omitting it refuses", async () => {
    const allowed = planUser(plan({ allowedGatekeepers: ["fakekee"] }));
    expect("error" in (await allowed.inDo(mint))).toBe(false);
    const refused = planUser(plan({ allowedGatekeepers: ["other"] }));
    expect(await refused.inDo(mint))
        .toEqual({ error: 'The "fakekee" connector isn\'t available on your plan.' });
  });

  it("an administrator's disabled gatekeeper keeps its message when the plan also omits it", async () => {
    const { inDo } = planUser(
        plan({ allowedGatekeepers: [] }), { disabledGatekeepers: ["fakekee"] });
    expect(await inDo(mint)).toEqual({
      error: 'The "fakekee" gatekeeper is disabled on this deployment by an administrator.',
    });
  });

  it("an administrator's disabled resource keeps its message when the plan also omits the vendor", async () => {
    const { inDo } = planUser(
        plan({ allowedGatekeepers: [] }),
        { disabledResources: { fakekee: [FAKE_RESOURCE.urlPattern] } });
    expect(await inDo(mint)).toEqual({
      error: 'The "Fake widgets" resource is disabled on this deployment by an administrator.',
    });
  });

  it("a failing port behaves as unbound", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    expect("error" in (await inDo(mint))).toBe(false);
  });
});
