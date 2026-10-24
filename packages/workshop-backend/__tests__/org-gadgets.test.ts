// Org-owned workspaces (#8): transferToOrg writes the owner subject and registers the workspace
// with the org; from then on open() authorizes every caller -- the transferring owner included --
// through the sharing graph's org baselines, re-checked live. Membership removal reaches the
// workspace through the org's owned-gadget index and severs live sessions; the next open denies.
// Exercised end-to-end against the real Overseer and Org Durable Objects in workerd, reached the
// way production reaches them (ctx.exports), like org.test.ts and user-deprovision.test.ts.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OrgRole, OrgSummary, Overseer } from "@gadgets/workshop-shared/api";
import type { OrgDurableObject } from "../src/org";
import { makeOrgStorage } from "../src/storage-schema/org-storage";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { UseOverseerInterface } from "../src/overseer-client-use.js";
import type { ProductAnalyticsGadgetInput } from "../src/analytics.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
  }
}

const ALICE = "alice@example.com";  // org owner; transfers her workspace in.
const BOB = "bob@example.com";      // org admin.
const CAROL = "carol@example.com";  // org member.

// The slices of OverseerImpl the fixture drives; reaching `impl` at all needs the same
// unchecked cast every overseer suite uses (workerd hands back only the DO facade).
type TestImpl = {
  ownerId: string;
  ownerProfileId: string;
  ensureAmbientCapsules: () => Promise<void>;
  markOutputsDirty: () => void;
  scheduleAccessRestart: (reason: string) => Promise<void>;
  storage: { ownerSubject: { get(): { type: "org"; id: string } | undefined } };
  ctx: { id: { toString(): string } };
};

let counter = 0;

// A fresh org with ALICE as its creating owner plus the given extra members, seeded straight
// into the members collection (the invite/accept flow is org.test.ts's subject).
async function createOrg(members: Record<string, OrgRole>): Promise<string> {
  const id = `org-gadgets-${++counter}-${crypto.randomUUID().slice(0, 8)}`;
  const summary: OrgSummary = await env.TEST_ORG.getByName(id).initializeOrg("Acme", ALICE);
  expect(summary.role).toBe("owner");
  if (Object.keys(members).length > 0) {
    await runInDurableObject(env.TEST_ORG.getByName(id), (_instance: OrgDurableObject, state) => {
      const storage = makeOrgStorage(state.storage);
      for (const [userId, role] of Object.entries(members)) {
        storage.members.put({
          userId, role, status: "active",
          invitedBy: ALICE, invitedAt: new Date(0), joinedAt: new Date(0),
        });
      }
    });
  }
  return id;
}

// The org's owned-gadget index, as ids.
async function ownedGadgets(orgId: string): Promise<string[]> {
  return runInDurableObject(env.TEST_ORG.getByName(orgId), (_instance: OrgDurableObject, state) =>
    [...makeOrgStorage(state.storage).ownedGadgets.list()].map(g => g.gadgetId));
}

type Workspace = {
  impl: TestImpl & {
    // Reaching `users` (and `impl` itself, in withWorkspace) needs the same unchecked cast
    // every overseer suite uses: the harness reaches over the DO's real surface.
    users: DurableObjectNamespace<UserDurableObject>;
  };
  restarts: string[];
  // Valid user-DO ids to open as: the real users namespace requires them (idFromString).
  userIds: Record<"alice" | "bob" | "carol" | "outsider", string>;
  open: (userId: string, profileId: string) => Promise<Overseer>;
  gadgetId: () => string;
};

// A fresh user-owned workspace owned by `owner` (default ALICE), with ambient-capsule and restart
// side effects pinned down the way chat-changes.test.ts does. Everything runs inside the DO, over
// real storage.
async function withWorkspace(
    fn: (ws: Workspace) => Promise<void>,
    owner: "alice" | "carol" = "alice"): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`org-gadgets-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as { impl: TestImpl & {
      users: DurableObjectNamespace<UserDurableObject>;
    } }).impl;
    const userIds = {
      alice: impl.users.newUniqueId().toString(),
      bob: impl.users.newUniqueId().toString(),
      carol: impl.users.newUniqueId().toString(),
      outsider: impl.users.newUniqueId().toString(),
    };
    impl.ownerId = userIds[owner];
    impl.ownerProfileId = owner === "carol" ? CAROL : ALICE;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    const restarts: string[] = [];
    // A real restart aborts the DO (which would kill this very test callback).
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    await fn({
      impl,
      restarts,
      userIds,
      open: (userId: string, profileId: string) =>
          instance.open(userId, profileId, new NativeRpcStub<() => void>(() => {})),
      gadgetId: () => impl.ctx.id.toString(),
    });
  });
}

// Seeds a workspace like withWorkspace, but opens it from the test side: runInDurableObject's
// callback stays suspended while a client it created calls back into it (deleteSelf's
// notifyClosed), which this harness cannot resolve -- from outside, the round trip is ordinary.
async function seedWorkspace(): Promise<{ name: string; userIds: Workspace["userIds"] }> {
  const name = `org-gadgets-${++counter}`;
  const userIds = await runInDurableObject(
      env.TEST_OVERSEER.getByName(name),
      (instance: OverseerDurableObject) => {
        const impl = (instance as unknown as { impl: TestImpl & {
          users: DurableObjectNamespace;
        } }).impl;
        const ids = {
          alice: impl.users.newUniqueId().toString(),
          bob: impl.users.newUniqueId().toString(),
          carol: impl.users.newUniqueId().toString(),
          outsider: impl.users.newUniqueId().toString(),
        };
        impl.ownerId = ids.alice;
        impl.ownerProfileId = ALICE;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        // A real restart aborts the DO mid-deletion; deletion needs no restart here.
        impl.scheduleAccessRestart = async () => {};
        return ids;
      });
  return { name, userIds };
}

describe("org-owned workspaces", () => {
  it("transfer registers with the org, and every member opens at their baseline", async () => {
    const orgId = await createOrg({ [BOB]: "admin", [CAROL]: "member" });
    let workspaceId = "";
    await withWorkspace(async ws => {
      workspaceId = ws.gadgetId();
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);

      // The subject is written and the org knows the workspace; everyone was severed.
      expect(ws.impl.storage.ownerSubject.get()).toEqual({ type: "org", id: orgId });
      expect(ws.restarts).toEqual([
        "Gadget restarted because its ownership moved to an organization.",
      ]);

      // The transferring owner is now an ordinary principal: build, from her org owner baseline.
      using reopened = await ws.open(ws.userIds.alice, ALICE);
      expect(reopened).not.toBeInstanceOf(UseOverseerInterface);
      // An admin baselines at build too; a member at use; a non-member is denied.
      using asBob = await ws.open(ws.userIds.bob, BOB);
      expect(asBob).not.toBeInstanceOf(UseOverseerInterface);
      using asCarol = await ws.open(ws.userIds.carol, CAROL);
      expect(asCarol).toBeInstanceOf(UseOverseerInterface);
      await expect(ws.open(ws.userIds.outsider, "dana@example.com")).rejects.toThrow();
    });
    expect(await ownedGadgets(orgId)).toEqual([workspaceId]);
  });

  it("removing a member severs their live session and denies their next open", async () => {
    const orgId = await createOrg({ [CAROL]: "member" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);
      ws.restarts.length = 0;

      // A live "use" session for Carol: held open, so it counts as a session to sever.
      using asCarol = await ws.open(ws.userIds.carol, CAROL);
      expect(asCarol).toBeInstanceOf(UseOverseerInterface);
      expect(ws.restarts).toEqual([]);

      // Removing her from the org reaches the workspace through the owned-gadget index.
      await env.TEST_ORG.getByName(orgId).removeMember(ALICE, CAROL);
      expect(ws.restarts).toHaveLength(1);
      await expect(ws.open(ws.userIds.carol, CAROL)).rejects.toThrow();
      // The org owner's own access is untouched.
      using asAlice = await ws.open(ws.userIds.alice, ALICE);
      expect(asAlice).not.toBeInstanceOf(UseOverseerInterface);
    });
  });

  it("a member leaving severs their live session like a removal", async () => {
    const orgId = await createOrg({ [CAROL]: "member" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);
      ws.restarts.length = 0;

      using asCarol = await ws.open(ws.userIds.carol, CAROL);
      expect(asCarol).toBeInstanceOf(UseOverseerInterface);
      expect(ws.restarts).toEqual([]);

      await env.TEST_ORG.getByName(orgId).memberLeave(CAROL);
      expect(ws.restarts).toHaveLength(1);
      await expect(ws.open(ws.userIds.carol, CAROL)).rejects.toThrow();
    });
  });

  it("a refused sole-owner removal or leave severs nothing, a co-owner's still does", async () => {
    const orgId = await createOrg({ [BOB]: "admin", [CAROL]: "member" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);
      ws.restarts.length = 0;

      // Carol's live session must survive both refused operations untouched.
      using asCarol = await ws.open(ws.userIds.carol, CAROL);
      expect(asCarol).toBeInstanceOf(UseOverseerInterface);
      await expect(env.TEST_ORG.getByName(orgId).removeMember(ALICE, ALICE)).rejects.toThrow(
          "at least one owner");
      await expect(env.TEST_ORG.getByName(orgId).memberLeave(ALICE)).rejects.toThrow(
          "at least one owner");
      expect(ws.restarts).toEqual([]);
      expect(asCarol).toBeInstanceOf(UseOverseerInterface);

      // With a second owner standing, removing him severs his own session, as a removal must.
      await env.TEST_ORG.getByName(orgId).changeMemberRole(ALICE, BOB, "owner");
      using asBob = await ws.open(ws.userIds.bob, BOB);
      expect(asBob).not.toBeInstanceOf(UseOverseerInterface);
      await env.TEST_ORG.getByName(orgId).removeMember(ALICE, BOB);
      expect(ws.restarts).toHaveLength(1);
      await expect(ws.open(ws.userIds.bob, BOB)).rejects.toThrow();
    });
  });

  it("a refused or repeated transfer leaves the workspace exactly as it was", async () => {
    const orgId = await createOrg({ [BOB]: "admin" });
    const { name, userIds } = await seedWorkspace();
    const overseer = env.TEST_OVERSEER.getByName(name);
    using ownerClient = await overseer.open(
        userIds.alice, ALICE, new NativeRpcStub<() => void>(() => {}));
    await ownerClient.transferToOrg(orgId);

    // The org refuses to index a workspace for a non-admin actor (the same gate a transfer
    // hits; transferToOrg registers with the org before touching its own state, so a refusal
    // changes nothing). Caught promise-style, the way org.test.ts asserts refusals: a bare
    // expected rejection leaves the harness an unhandled-rejection log that fails the run.
    let orgRefusal = "";
    try {
      await Promise.resolve().then(
          () => env.TEST_ORG.getByName(orgId).addOwnedGadget("dana@example.com", "g1"));
    } catch (error) {
      orgRefusal = error instanceof Error ? error.message : String(error);
    }
    expect(orgRefusal).toMatch(/Only an owner or admin/);

    // Transfer is one-way: a workspace that already belongs to an org refuses locally, before
    // any org call, and nothing changes.
    let transferRefusal = "";
    try {
      await Promise.resolve().then(() => ownerClient.transferToOrg(orgId));
    } catch (error) {
      transferRefusal = error instanceof Error ? error.message : String(error);
    }
    expect(transferRefusal).toMatch(/already belongs to an organization/);
    const after = await runInDurableObject(overseer, (instance: OverseerDurableObject) => ({
      subject: (instance as unknown as { impl: TestImpl }).impl.storage.ownerSubject.get(),
    }));
    expect(after.subject).toEqual({ type: "org", id: orgId });
  });

  it("an org admin may delete the workspace, which leaves the org's index", async () => {
    const orgId = await createOrg({ [BOB]: "admin" });
    const { name, userIds } = await seedWorkspace();
    const workspaceId = env.TEST_OVERSEER.idFromName(name).toString();

    const overseer = env.TEST_OVERSEER.getByName(name);
    using ownerClient = await overseer.open(
        userIds.alice, ALICE, new NativeRpcStub<() => void>(() => {}));
    await ownerClient.transferToOrg(orgId);
    expect(await ownedGadgets(orgId)).toEqual([workspaceId]);

    // Bob holds no session authority of his own -- his right to delete comes from the org.
    using asBob = await overseer.open(
        userIds.bob, BOB, new NativeRpcStub<() => void>(() => {}));
    await asBob.deleteSelf();
    expect(await ownedGadgets(orgId)).toEqual([]);
  });

  it("a transfer the org refuses leaves the workspace exactly as it was", async () => {
    const orgId = await createOrg({ [CAROL]: "member" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.carol, CAROL);

      // Carol owns the workspace but is only a member of the org, so the org refuses to index
      // it and the transfer fails -- before any workspace state changed. Caught promise-style,
      // as above: a bare expected rejection leaves the harness an unhandled-rejection log.
      const refused = async () => {
        try {
          await Promise.resolve().then(() => ownerClient.transferToOrg(orgId));
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      expect(await refused()).toMatch(/Only an owner or admin/);
      // A repeat refusal is the same refusal, and still changes nothing.
      expect(await refused()).toMatch(/Only an owner or admin/);

      // Nothing was written and nobody was severed: the workspace is user-owned as before,
      // Carol's own owner session still works, and no restart was scheduled.
      expect(ws.impl.storage.ownerSubject.get()).toBeUndefined();
      expect(ws.restarts).toEqual([]);
      using reopened = await ws.open(ws.userIds.carol, CAROL);
      expect(reopened).not.toBeInstanceOf(UseOverseerInterface);
    }, "carol");
    expect(await ownedGadgets(orgId)).toEqual([]);
  });

  it("demoting an admin to member severs and downgrades their live session", async () => {
    const orgId = await createOrg({ [BOB]: "admin" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);
      ws.restarts.length = 0;

      // A live build session for Bob, held open so it counts as a session to sever.
      using asBob = await ws.open(ws.userIds.bob, BOB);
      expect(asBob).not.toBeInstanceOf(UseOverseerInterface);
      expect(ws.restarts).toEqual([]);

      // A promotion (admin -> owner) never narrows a baseline: nothing is severed.
      await env.TEST_ORG.getByName(orgId).changeMemberRole(ALICE, BOB, "owner");
      expect(ws.restarts).toEqual([]);

      // Demoting him to member narrows his baseline to use: the live session is severed and
      // his next open lands at the use interface.
      await env.TEST_ORG.getByName(orgId).changeMemberRole(ALICE, BOB, "member");
      expect(ws.restarts).toEqual([
        "Gadget restarted because your organization membership changed.",
      ]);
      using reopened = await ws.open(ws.userIds.bob, BOB);
      expect(reopened).toBeInstanceOf(UseOverseerInterface);
    });
  });

  it("a member's session resolves models from their own account, not the workspace's", async () => {
    const orgId = await createOrg({ [BOB]: "admin" });
    await withWorkspace(async ws => {
      using ownerClient = await ws.open(ws.userIds.alice, ALICE);
      await ownerClient.transferToOrg(orgId);

      // Each of Alice's and Bob's user DOs gets its own hand-added model (the test deployment
      // has no AI Gateway, so these are the only models listModels can return).
      const users = ws.impl.users;
      await users.get(users.idFromString(ws.userIds.alice)).addModel(
          { type: "agent", id: "alices-model", name: "Alices Model" },
          { provider: "openai", model: "alices-model", apiToken: "sk-alice" });
      await users.get(users.idFromString(ws.userIds.bob)).addModel(
          { type: "agent", id: "bobs-model", name: "Bobs Model" },
          { provider: "openai", model: "bobs-model", apiToken: "sk-bob" });

      // Bob's session on the org-owned workspace -- he is not the workspace's user owner --
      // resolves models through his own user DO.
      using asBob = await ws.open(ws.userIds.bob, BOB);
      const models = (await asBob.listModels()).map(m => m.id);
      expect(models).toContain("bobs-model");
      expect(models).not.toContain("alices-model");
    });
  });

  // The org observability dimension (#20), probed from inside the workspace's DO: the logger's
  // fields, and the org column (blob10) of the activity points one event wrote. A user-owned
  // workspace names no org anywhere; from the transfer on, both surfaces carry it.
  it("an org-owned workspace's events carry its org; a user-owned one's do not", async () => {
    const orgId = await createOrg({});
    const { name, userIds } = await seedWorkspace();
    const overseer = env.TEST_OVERSEER.getByName(name);

    const before = await probeOrgDimension(name);
    expect(before.logFields.orgId).toBeUndefined();
    expect(before.metricOrgColumn).toEqual([""]);

    using ownerClient = await overseer.open(
        userIds.alice, ALICE, new NativeRpcStub<() => void>(() => {}));
    await ownerClient.transferToOrg(orgId);

    const after = await probeOrgDimension(name);
    expect(after.logFields.orgId).toBe(orgId);
    expect(after.metricOrgColumn).toEqual([`org_${orgId}`]);
  });
});

type OrgDimensionProbe = { logFields: Record<string, unknown>; metricOrgColumn: unknown[] };

// Runs inside the workspace's DO: captures one logger entry, and the points one activity event
// writes to a stubbed METRICS binding, without either escaping the probe.
async function probeOrgDimension(name: string): Promise<OrgDimensionProbe> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), (instance: OverseerDurableObject) => {
    // The same unchecked cast every overseer suite uses: workerd hands back only the DO facade.
    const impl = (instance as unknown as {
      impl: TestImpl & {
        logger: { info(message: string, details: { event: string }): void };
        recordGadgetAnalytics(event: ProductAnalyticsGadgetInput): void;
      };
    }).impl;
    let logFields: Record<string, unknown> = {};
    const info = console.info;
    console.info = (entry: Record<string, unknown>) => { logFields = entry; };
    const points: AnalyticsEngineDataPoint[] = [];
    // The Workers env the metrics writer reads, as a mutable binding table for the probe.
    const ambient = env as unknown as {
      METRICS?: { writeDataPoint(point: AnalyticsEngineDataPoint): void };
    };
    ambient.METRICS = { writeDataPoint: point => points.push(point) };
    try {
      impl.logger.info("probing the org dimension", { event: "org.dimension.probe" });
      impl.recordGadgetAnalytics({
        event_name: "gadget_interaction", user_id: "probe", interaction_type: "chat_message_sent",
      });
    } finally {
      console.info = info;
      delete ambient.METRICS;
    }
    // blob10 is the org column; every point of one event carries the same value (or blank).
    return {
      logFields,
      metricOrgColumn: [...new Set(points.map(point => point.blobs?.[9] ?? null))],
    };
  });
}
