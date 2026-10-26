// Plan enforcement (issue #16): the model-catalog, connector, and workspace-creation chokepoints
// consult the optional SAAS_ENTITLEMENTS port. Each gate is proven open and closed per plan
// here, against a real UserDurableObject hand-constructed with the port bound (the pattern the
// admin-settings suites use, since the test pool binds no entitlements worker). Unbound — every
// OSS deployment — behaves exactly as pre-port code: the catalog lists everything, connectors
// mint, and workspaces are unlimited. A bound port that fails behaves the opposite way, closed:
// no tiered model runs, nothing mints, nothing provisions, and creation is refused, so an
// entitlements outage cannot open a plan gate. Spend caps and overage are covered in
// entitlements-policy.test.ts against checkUsageAndBalance directly.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Entitlements } from "@gadgets/workshop-shared/entitlements";
import { DecisionModelGatekeeper, LanguageModelGatekeeper } from "../src/ai-models.js";
import { getPlanRefusalCode, type AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { serializeAdminConfig } from "../src/admin-config.js";
import { OrgDurableObject } from "../src/org.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { makeOrgStorage } from "../src/storage-schema/org-storage.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
import type { GadgetRecord } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// What a test reaches into the user DO for: the typed collections behind newGadget's cap count
// and the ambient-account assertions (its `storage` is private; this widens just the pieces
// seeded or read here).
type UserInternals = UserDurableObject & {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    connectedAccounts: { list(): Array<{ id: number; vendorId: string }> };
  };
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
 * given entitlements answer (null: no binding, as OSS deployments run), admin config, and any
 * extra bindings (more fake gatekeeper vendors). All of a test's calls run inside one Durable
 * Object invocation.
 */
function planUser(
    entitlements: Entitlements | Error | null, admin: Partial<AdminConfig> = {},
    extraEnv: (state: DurableObjectState) => Record<string, unknown> = () => ({})) {
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
            ...extraEnv(state),
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
// A plan answer the ambient downgrade test swaps between calls on the same Durable Object, each
// swap served by a fresh port object: resolveEntitlements remembers a resolved answer per port
// for a few seconds (see src/entitlements.ts), so swapping one port's answer mid-test would
// serve the remembered pre-downgrade answer — the memo's bounded staleness, covered in
// entitlements-policy.test.ts — instead of the dorm rule under test.
function swappablePlan(initial: Entitlements) {
  const state = { answer: initial as Entitlements };
  return {
    state,
    port: () => ({
      getEntitlements: async () => state.answer,
    }) as unknown as NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
  };
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
    const { inDo } = planUser(plan({ allowedModelTiers: ["standard"] }));
    const listed = await inDo(languageModelIds);
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

  it("a failing port fails closed: no tiered model is offered or runs", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    expect(await inDo(languageModelIds)).toEqual([]);
    expect(await inDo(user =>
        attempt(() => user.getChatContext(STANDARD))))
        .toEqual({ error: 'The "Claude Haiku 4.5" model isn\'t available on your plan.' });
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

  it("a failing port fails closed: creation is refused, not uncapped", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    expect(await inDo(user => newGadget(user, "any")))
        .toEqual({
          error: "Your plan couldn't be verified, so the workspace wasn't created. Please try again.",
        });
  });

  it("a retried creation is idempotent: its own row never re-refuses it", async () => {
    const { inDo } = planUser(plan({ maxWorkspaces: 1 }));
    await inDo(user => seedGadget(user, "crashed-midway"));
    expect(await inDo(user => newGadget(user, "crashed-midway"))).toBe("created");
  });

  it("registering a workspace that already exists is exempt from the cap", async () => {
    // No registry row at all — the workspace (an Overseer DO holding state) exists without one,
    // the state an at-cap refusal or a crash between claim and registration leaves behind.
    // Completing its registration must succeed: refusing could not undo the workspace.
    const { inDo } = planUser(plan({ maxWorkspaces: 0 }));
    const outcome = await inDo(user =>
        attempt(async () => {
          await user.ensureGadgetRegistered("existing-workspace", "Existing workspace");
          return "registered";
        }));
    expect(outcome).toBe("registered");
    expect(await inDo(user => user.getGadget("existing-workspace")))
        .toMatchObject({ id: "existing-workspace" });
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

  it("a failing port fails closed: the connector doesn't mint", async () => {
    const { inDo } = planUser(new Error("entitlements down"));
    expect(await inDo(mint)).toEqual({
      error: 'The "fakekee" connector isn\'t available on your plan.',
    });
  });

  it("a plan-excluded vendor is neither listed nor connectable", async () => {
    const hidden = planUser(plan({ allowedGatekeepers: ["other"] }));
    expect(await hidden.inDo(user => user.listGatekeeperVendors())).toEqual([]);
    expect(await hidden.inDo(user =>
        attempt(() => user.connectAccount("fakekee"))))
        .toEqual({ error: 'The "fakekee" connector isn\'t available on your plan.' });

    const offered = planUser(plan({ allowedGatekeepers: ["fakekee"] }));
    const vendors = await offered.inDo(user => user.listGatekeeperVendors());
    expect(vendors.map(vendor => vendor.id)).toEqual(["fakekee"]);
  });

  it("a failing port hides the vendor listing and refuses a connect", async () => {
    const down = planUser(new Error("entitlements down"));
    expect(await down.inDo(user => user.listGatekeeperVendors())).toEqual([]);
    expect(await down.inDo(user =>
        attempt(() => user.connectAccount("fakekee"))))
        .toEqual({ error: 'The "fakekee" connector isn\'t available on your plan.' });
  });
});

describe("plan-enforced ambient gatekeepers", () => {
  // A second, ambient vendor — the shape scheduler/context have: it auto-provisions an account
  // (no OAuth) whose description declares an agent singleton. The account is a real
  // FakeGatekeeperAccount facet: the only account shape the user DO can persist, since a plain
  // object with methods cannot cross Durable Object storage.
  const ambientVendor = (state: DurableObjectState) => ({
    describe: async () => ({ vendorId: "ambientkee", autoProvisionsAccount: true }),
    createAccount: () =>
        (state.exports as unknown as {
          FakeGatekeeperAccount(props: { props: unknown }): unknown;
        }).FakeGatekeeperAccount({
          props: { name: "Ambient", singleton: { tsType: "FakeSession" } },
        }),
  } as unknown as Cloudflare.Env["GATEKEEPER_CONTEXT"]);

  it("unbound: the ambient vendor provisions, lists, and mints its singleton", async () => {
    const { inDo } = planUser(null, {}, state => ({ GATEKEEPER_AMBIENTKEE: ambientVendor(state) }));
    await inDo(user => user.provisionAmbientAccount("ambientkee"));
    expect((await inDo(user => user.listAddableGatekeepers())).map(rec => rec.id))
        .toEqual([]);  // already added
    const provided = await inDo(user => user.listProvidedAccounts());
    expect(provided.map(rec => rec.vendorId)).toEqual(["ambientkee"]);
    // The singleton mints while the deployment offers the vendor.
    expect(await inDo(user => attempt(async () =>
      (await user.getSingletonGatekeeperClass(provided[0].accountId)) === null
          ? "null" : "minted"))).toBe("minted");
  });

  it("a plan excluding the vendor provisions nothing and lists nothing", async () => {
    const { inDo } = planUser(
        plan({ allowedGatekeepers: ["fakekee"] }),
        // "enabled" (forced) mode, so the ensure path would auto-provision absent the plan gate.
        { ambientGatekeeperModes: { ambientkee: "enabled" } },
        state => ({ GATEKEEPER_AMBIENTKEE: ambientVendor(state) }));
    expect(await inDo(user =>
        attempt(() => user.provisionAmbientAccount("ambientkee"))))
        .toEqual({ error: 'The "ambientkee" connector isn\'t available on your plan.' });
    expect(await inDo(user => user.listAddableGatekeepers())).toEqual([]);
    expect(await inDo(user => user.listProvidedAccounts())).toEqual([]);
  });

  it("a downgrade dorms the existing account, and the record survives it", async () => {
    const { state, port } = swappablePlan(plan({ allowedGatekeepers: ["ambientkee"] }));
    const { inDo } = planUser(null, {}, state => ({
      GATEKEEPER_AMBIENTKEE: ambientVendor(state),
      // Fresh port each invocation (see swappablePlan), so every call below consults the plan
      // as it stands; the harness's own binding stays overridden.
      SAAS_ENTITLEMENTS: port(),
    }));
    await inDo(user => user.provisionAmbientAccount("ambientkee"));

    state.answer = plan({ allowedGatekeepers: ["fakekee"] });  // the downgrade
    expect(await inDo(user => user.listProvidedAccounts())).toEqual([]);
    const records = await inDo(user =>
        [...(user as UserInternals).storage.connectedAccounts.list()]);
    expect(records.map(rec => rec.vendorId)).toEqual(["ambientkee"]);  // not stranded
    expect(await inDo(user => user.getSingletonGatekeeperClass(records[0].id))).toBeNull();

    state.answer = plan({ allowedGatekeepers: ["ambientkee"] });  // re-upgraded
    expect((await inDo(user => user.listProvidedAccounts())).map(rec => rec.vendorId))
        .toEqual(["ambientkee"]);
  });
});

describe("plan-enforced model bindings", () => {
  const OWNER_ID = "owner-789";
  const INITIATOR: AiChatAuthorInfo = { type: "gadget", id: OWNER_ID, name: "Report Gadget" };
  // A premium model, the tier the binding below was minted while the owner's plan allowed.
  const PREMIUM_CONFIG = { provider: "anthropic" as const, model: "claude-opus-5-5", apiToken: "" };
  const DECISION_CONFIG = {
    provider: "cloudflare" as const, model: "@cf/cloudflare/clef", apiToken: "",
  };

  // The usage gate consults the owner's user DO lazily, and a session start that refuses on plan
  // never reaches it.
  const users = {
    idFromString: (id: string) => id,
    get: () => ({}),
  } as unknown as DurableObjectNamespace<UserDurableObject>;

  // The deployment env a binding runs in, its entitlements port answering `answer`.
  function bindingEnv(answer: Entitlements | Error): Cloudflare.Env {
    const { port } = swappablePlan(plan());
    const source = port as { getEntitlements: (q: { userId: string }) => Promise<Entitlements> };
    source.getEntitlements = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
      BLUEPRINTS: {
        get: async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
      } as unknown as KVNamespace,
      SAAS_ENTITLEMENTS: source as unknown as NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
    } as unknown as Cloudflare.Env;
  }

  // A binding's session under `answer`, the plan its owner answers at call time.
  function session(
      answer: Entitlements | Error,
      config: { provider: "anthropic" | "cloudflare"; model: string; apiToken: string } =
          PREMIUM_CONFIG,
      decision = false) {
    const gatekeeper = Object.create(
        decision ? DecisionModelGatekeeper.prototype : LanguageModelGatekeeper.prototype);
    Object.assign(gatekeeper, {
      env: bindingEnv(answer),
      ctx: {
        props: { displayName: "Model", config, initiator: INITIATOR, ownerUserId: OWNER_ID },
        exports: { UserDurableObject: users },
      },
    });
    return (gatekeeper as unknown as LanguageModelGatekeeper).startSession(undefined as never);
  }

  it("a binding keeps running while the owner's plan allows its tier", async () => {
    await expect(
        session(plan({ allowedModelTiers: ["standard", "premium"] })))
        .resolves.toHaveProperty("run");
  });

  it("a plan downgrade refuses the binding's next session, both gatekeepers", async () => {
    // The refusal carries its code, as a chat naming the model does, so the UI can offer the
    // plan upgrade and the agent layer classifies it (PLAN_REFUSAL_CODES).
    const refusal = await session(plan({ allowedModelTiers: ["standard"] })).then(
        () => undefined, (error: unknown) => error);
    expect(getPlanRefusalCode(refusal)).toBe("MODEL_NOT_ON_PLAN");
    expect((refusal as Error).message)
        .toBe('The "Claude Opus 5.5" model isn\'t available on your plan.');  // premium-tier model
    await expect(session(plan({ allowedModelTiers: ["premium"] }), DECISION_CONFIG, true))
        .rejects.toThrow(
            'The "Clef (Workers AI)" model isn\'t available on your plan.');  // standard-tier
  });

  it("unbound: a binding runs any tier; a failed port refuses them all", async () => {
    const unbound = {
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
      BLUEPRINTS: {
        get: async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
      } as unknown as KVNamespace,
    } as unknown as Cloudflare.Env;
    for (const [gatekeeperClass, method] of [
      [LanguageModelGatekeeper, "run"],
      [DecisionModelGatekeeper, "decide"],
    ] as const) {
      const gatekeeper = Object.create(gatekeeperClass.prototype);
      Object.assign(gatekeeper, {
        env: unbound,
        ctx: {
          props: {
            displayName: "Model", config: PREMIUM_CONFIG, initiator: INITIATOR,
            ownerUserId: OWNER_ID,
          },
          exports: { UserDurableObject: users },
        },
      });
      const started = await (gatekeeper as unknown as {
        startSession(queue: unknown): Promise<Record<string, unknown>>,
      }).startSession(undefined as never);
      expect(typeof started[method]).toBe("function");
    }
    await expect(session(new Error("entitlements down"))).rejects.toThrow(
        'The "Claude Opus 5.5" model isn\'t available on your plan.');
  });
});

describe("plan-enforced external messages", () => {
  const message = {
    callerEmail: "carol@example.com", externalChatKey: "k", idempotencyKey: "i",
    prompt: "hello", chatGatewayRpcTarget: {} as never, title: "T",
  };

  // receiveExternalMessage against a real OverseerDurableObject — everything inside one DO
  // invocation, since its storage cannot be touched from outside — with the caller's user DO
  // faked. Its newGadget — the plan-capped write registration must lead with — refuses every
  // fresh key at cap, and its ensureGadgetRegistered records the cap-exempt completions.
  function externalMessageOutcome(seed?: (impl: any) => void) {
    const stub = env.TEST_OVERSEER.getByName(`plan-enforcement-overseer-${++counter}`);
    const doId = stub.id.toString();
    return runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      // Reaching the DO's private impl, the pattern observer-scope-restart.test.ts uses.
      const impl = (instance as unknown as { impl: any }).impl;
      const CALLER_ID = "caller-user-id";
      const registered: string[] = [];
      const ensured: string[] = [];
      const caller = {
        id: { toString: () => CALLER_ID },
        whoamiIfExists: async () => ({ type: "user", id: CALLER_ID, name: "Carol" }),
        newGadget: async (id: string, _title: string) => {
          if (registered.includes(id)) return;  // idempotent, like the real one
          registered.push(id);
          throw new Error("You've reached your plan's limit of 2 workspaces.");
        },
        getExternalMessageChatContext: () =>
            Promise.reject(new Error("model lookup failed")),
        ensureGadgetRegistered: async (id: string) => { ensured.push(id); },
      };
      impl.users = {
        getByName: () => caller,
        idFromString: (id: string) => id,
        get: () => caller,
      };
      const titleBefore = impl.storage.title.get();
      seed?.(impl);
      const outcome = await attempt(() =>
          instance.receiveExternalMessage({ ...message } as never));
      return {
        outcome,
        registered,
        ensured,
        ownerId: impl.storage.ownerId.get(),
        titleChanged: impl.storage.title.get() !== titleBefore,
        pending: impl.storage.ownerRegistrationPending.get(),
        doId,
      };
    });
  }

  it("an at-cap plan is refused before any workspace state exists", async () => {
    const h = await externalMessageOutcome();
    expect(h.outcome).toEqual({
      accepted: false,
      message: "You've reached your plan's limit of 2 workspaces.",
    });
    expect(h.registered).toHaveLength(1);  // the capped newGadget, exactly once
    // Nothing was claimed: no owner, no retitled workspace, nothing to be locked out of.
    expect(h.ownerId).toBeUndefined();
    expect(h.titleChanged).toBe(false);
    expect(h.pending).toBeFalsy();
  });

  it("an already-claimed workspace completes its registration despite the cap", async () => {
    const CALLER_ID = "caller-user-id";
    const h = await externalMessageOutcome(impl => {
      // A claim that predates register-first: the workspace DO exists holding state, and its
      // registration is pending. The at-cap newGadget above refuses fresh keys, so completing
      // this one is the cap-exempt ensureGadgetRegistered.
      const internals = impl as { ownerId: string, ownerProfileId: string, storage: any };
      internals.ownerId = CALLER_ID;
      internals.ownerProfileId = CALLER_ID;
      internals.storage.ownerId.put(CALLER_ID);
      internals.storage.title.put("T");
      internals.storage.ownerRegistrationPending.put(true);
    });
    expect(h.outcome).toEqual({ error: "model lookup failed" });  // past registration
    expect(h.registered).toEqual([]);  // never re-registered through the capped path
    expect(h.ensured).toEqual([h.doId]);
    expect(h.pending).toBe(false);
  });
});

describe("plan-enforced org workspace caps", () => {
  const OWNER = "org-owner@example.com";

  // A real OrgDurableObject whose environment carries the entitlements port, seeded with an
  // active owner and the given workspaces already in the org's index.
  async function orgWithPlan(entitlements: Entitlements | Error | null, owned: string[]) {
    const stub = env.TEST_ORG.getByName(`plan-enforcement-org-${++counter}`);
    await runInDurableObject(stub, (_host: OrgDurableObject, state: DurableObjectState) => {
      const storage = makeOrgStorage(state.storage);
      storage.org.put({ id: "org", name: "Acme", createdAt: new Date(0) });
      storage.members.put({
        userId: OWNER, role: "owner", status: "active", invitedBy: null,
        invitedAt: new Date(0), joinedAt: new Date(0),
      });
      for (const gadgetId of owned) storage.ownedGadgets.put({ gadgetId });
    });
    const port = entitlementsPort(entitlements ?? plan());
    // As in planUser: no binding at all while unbound, which is what makes a deployment OSS.
    const withPort = (env: Record<string, unknown>) =>
        (entitlements === null ? env : { ...env, SAAS_ENTITLEMENTS: port.port });
    const inDo = <T>(f: (org: OrgDurableObject) => T | Promise<T>): Promise<T> =>
        runInDurableObject(stub, (_host: OrgDurableObject, state: DurableObjectState) => f(
            new OrgDurableObject(state, withPort({}) as unknown as Cloudflare.Env)));
    return { inDo };
  }

  const transfer = (org: OrgDurableObject, gadgetId: string, transferring = "member-1") =>
      attempt(() => org.addOwnedGadget(OWNER, gadgetId, transferring));

  it("a transfer is refused at the org's plan cap; below it, recorded", async () => {
    const capped = await orgWithPlan(plan({ maxWorkspaces: 2 }), ["g1", "g2"]);
    expect(await capped.inDo(org => transfer(org, "g3")))
        .toEqual({ error: "This organization has reached its plan's limit of 2 workspaces." });
    const room = await orgWithPlan(plan({ maxWorkspaces: 3 }), ["g1", "g2"]);
    expect(await room.inDo(org => transfer(org, "g3"))).toBeUndefined();
  });

  it("a transfer its own crashed attempt left behind is not re-refused", async () => {
    // Counted, g3's own row reaches the cap of 3 — but that row is the crashed attempt's own,
    // so the retry refreshes it rather than being refused by it.
    const retried = await orgWithPlan(plan({ maxWorkspaces: 3 }), ["g1", "g2", "g3"]);
    expect(await retried.inDo(org => transfer(org, "g3"))).toBeUndefined();
  });

  it("unbound: transfers are unlimited; a failing port refuses them", async () => {
    const unbound = await orgWithPlan(null, ["g1", "g2", "g3"]);
    expect(await unbound.inDo(org => transfer(org, "g4"))).toBeUndefined();
    const down = await orgWithPlan(new Error("entitlements down"), []);
    expect(await down.inDo(org => transfer(org, "g1"))).toEqual({
      error: "Your plan couldn't be verified, so the workspace wasn't transferred. Please try again.",
    });
  });
});
