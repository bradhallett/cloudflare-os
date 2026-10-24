import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { GatekeeperUserSelection } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import { GATEKEEPER_USER_SELECTION_LIFETIME_MS } from "../src/user.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import type { OrgDurableObject } from "../src/org.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
  }
}

// The typed collection behind the public methods, as a test reaches into the selector's DO.
type UserInternals = UserDurableObject & {
  env: Cloudflare.Env;
  storage: {
    connectedAccounts: {
      get(id: number): { id: number; autoProvisioned?: boolean } | undefined;
      put(record: unknown): void;
    };
    pendingUserSelections: {
      list(): Iterable<{ ticketHash: string; expiresAt: Date }>;
      put(record: unknown): void;
    };
  };
};

// Keep admin policy local to these users; a shared KV binding also changes agent tracing I/O.
const adminConfigKv = new Map<string, string>();
const BLUEPRINTS = {
  get: async (key: string) => adminConfigKv.get(key) ?? null,
} as unknown as KVNamespace;

async function installAdminConfig(userId: string): Promise<void> {
  await inUser(userId, user => {
    user.env = { ...user.env, BLUEPRINTS };
  });
}

async function createUser(userId: string, displayName: string): Promise<void> {
  await installAdminConfig(userId);
  await hooks().createUser(userId, displayName);
}

function hooks(): DurableObjectStub<GatekeeperUserPickerTestHooks> {
  return env.TEST_GATEKEEPER_USER_PICKER.getByName("");
}

function uniqueUser(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

// A fresh org holding `owner` (as its owner) and everyone in `people` as active members: the
// directory scope a picker pick is justified by. Mirrors reach each member's index along the way.
async function shareAnOrg(owner: string, ...people: string[]): Promise<string> {
  const orgId = `org-${crypto.randomUUID()}`;
  const org = env.TEST_ORG.getByName(orgId);
  await org.initializeOrg("Test Org", owner);
  for (const person of people) {
    await org.inviteMember(owner, person);
    await org.acceptInvitation(person);
  }
  return orgId;
}

function inUser<T>(userId: string, f: (user: UserInternals) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_USER.getByName(userId),
    (instance: UserDurableObject) => f(instance as UserInternals));
}

// A minted selection, or the test fails naming what came back instead.
function minted(result: GatekeeperUserSelection | null | { error: string }): GatekeeperUserSelection {
  if (!result || "error" in result) throw new Error(`expected a selection, got ${JSON.stringify(result)}`);
  return result;
}

// A viewer with a UI-providing "context" account, and a pickable person with a plain one. The two
// share an org, as a pickable pair must: a pick is justified only by org co-membership or an
// existing share relationship.
async function viewerAndPicked(pickedName = "Picked") {
  const viewer = uniqueUser("view");
  const picked = uniqueUser("picked");
  const testHooks = hooks();
  await Promise.all([
    createUser(viewer, "Viewer"),
    createUser(picked, pickedName),
  ]);
  const orgId = await shareAnOrg(viewer, picked);
  const [appAccount, pickedAccount] = await Promise.all([
    testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true }),
    testHooks.addAccount(picked, "context", `${picked}-context`),
  ]);
  return { viewer, picked, appAccount, pickedAccount, testHooks, orgId };
}

describe("gatekeeper user picker selection tickets", () => {
  afterEach(() => adminConfigKv.clear());

  it("mints a ticket with a snapshot of the current name, without involving the app's gatekeeper", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked("Before Rename");
    await testHooks.renameUser(picked, "After Rename");

    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    expect(selection.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(selection.profile).toEqual({ displayName: "After Rename" });
    // Only the ticket's hash is at rest, and the record names the app account, not the gatekeeper.
    await inUser(viewer, user => {
      const [record] = Array.from(user.storage.pendingUserSelections.list());
      expect(record).toMatchObject({ appAccountId: appAccount, vendorId: "context", selectedUserId: picked });
      expect(record.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(GATEKEEPER_USER_SELECTION_LIFETIME_MS);
      for (const [, value] of user.ctx.storage.kv.list()) {
        expect(JSON.stringify(value)).not.toContain(selection.ticket);
      }
    });
    // Neither account heard about it: the gatekeeper learns of a selection only by redeeming it.
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toEqual(["describe"]);
    await expect(testHooks.accountCalls(`${picked}-context`)).resolves.toEqual(["describe"]);
  });

  it("mints for existing people regardless of their accounts, but not self or missing people", async () => {
    const viewer = uniqueUser("view");
    const wrongVendor = uniqueUser("wrongvendor");
    const expired = uniqueUser("expired");
    const noAccounts = uniqueUser("noaccounts");
    const ambiguous = uniqueUser("ambiguous");
    const missing = uniqueUser("missing");
    const testHooks = hooks();

    await Promise.all([
      createUser(viewer, "Viewer"),
      createUser(wrongVendor, "Wrong Vendor"),
      createUser(expired, "Expired Account"),
      createUser(noAccounts, "No Accounts"),
      createUser(ambiguous, "Multiple Accounts"),
    ]);
    await shareAnOrg(viewer, wrongVendor, expired, noAccounts, ambiguous);
    const [appAccount] = await Promise.all([
      testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true }),
      testHooks.addAccount(wrongVendor, "github", `${wrongVendor}-github`),
      testHooks.addAccount(expired, "context", `${expired}-context`, { expired: true }),
      testHooks.addAccount(ambiguous, "context", `${ambiguous}-one`),
    ]);
    await testHooks.addAccount(ambiguous, "context", `${ambiguous}-two`);

    for (const [person, displayName] of [
      [wrongVendor, "Wrong Vendor"], [expired, "Expired Account"],
      [noAccounts, "No Accounts"], [ambiguous, "Multiple Accounts"],
    ]) {
      const selection = minted(await testHooks.pick(viewer, appAccount, person));
      expect(selection.profile).toEqual({ displayName });
      await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual(
        person === ambiguous ? [
          { identity: `${ambiguous}-one`, displayName },
          { identity: `${ambiguous}-two`, displayName },
        ] : []);
      await expect(testHooks.redeem(viewer, appAccount, selection.ticket))
        .resolves.toEqual({ error: expect.any(String) });
    }
    await expect(testHooks.pick(viewer, appAccount, viewer)).resolves.toBeNull();
    await expect(testHooks.pick(viewer, appAccount, missing)).resolves.toBeNull();
    await expect(env.TEST_USER.getByName(missing).whoamiIfExists()).resolves.toBeNull();
  });

  it("mints nothing for an existing user outside the caller's scope, hiding that they exist", async () => {
    const viewer = uniqueUser("view");
    const outsider = uniqueUser("outsider");
    const testHooks = hooks();
    await Promise.all([createUser(viewer, "Viewer"), createUser(outsider, "Outsider")]);
    const appAccount = await testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });

    // The outsider exists, yet a pick reveals nothing — the same null as for a missing user.
    await expect(env.TEST_USER.getByName(outsider).whoamiIfExists()).resolves.toMatchObject({
      id: outsider,
    });
    await expect(testHooks.pick(viewer, appAccount, outsider)).resolves.toBeNull();
    await inUser(viewer, user => {
      expect(Array.from(user.storage.pendingUserSelections.list())).toEqual([]);
    });

    // Co-membership alone reopens the pick; no share relationship exists here.
    await shareAnOrg(viewer, outsider);
    await testHooks.addAccount(outsider, "context", `${outsider}-context`);
    const selection = minted(await testHooks.pick(viewer, appAccount, outsider));
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
      identity: `${outsider}-context`, displayName: "Outsider",
    }]);
  });

  it("records the orgs justifying a ticket and refuses it once the membership ends", async () => {
    const viewer = uniqueUser("view");
    const picked = uniqueUser("picked");
    const testHooks = hooks();
    await Promise.all([createUser(viewer, "Viewer"), createUser(picked, "Picked")]);
    const orgId = await shareAnOrg(viewer, picked);
    const appAccount = await testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });
    await testHooks.addAccount(picked, "context", `${picked}-context`);
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await inUser(viewer, user => {
      const [record] = Array.from(user.storage.pendingUserSelections.list());
      expect(record).toMatchObject({ selectedUserId: picked, orgIds: [orgId] });
    });
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
      identity: `${picked}-context`, displayName: "Picked",
    }]);

    // A fresh ticket dies with the membership that justified it, and stays spent.
    const stranded = minted(await testHooks.pick(viewer, appAccount, picked));
    await env.TEST_ORG.getByName(orgId).removeMember(viewer, picked);
    await expect(testHooks.redeem(viewer, appAccount, stranded.ticket))
      .resolves.toEqual({ error: "This selection is no longer available. Please select the user again." });
    await expect(testHooks.redeem(viewer, appAccount, stranded.ticket))
      .resolves.toEqual({ error: expect.any(String) });
  });

  it("lets a member of two orgs pick a co-member of either", async () => {
    const viewer = uniqueUser("view");
    const memberA = uniqueUser("membera");
    const memberB = uniqueUser("memberb");
    const testHooks = hooks();
    await Promise.all([
      createUser(viewer, "Viewer"),
      createUser(memberA, "Member A"),
      createUser(memberB, "Member B"),
    ]);
    const orgA = await shareAnOrg(viewer, memberA);
    const orgB = await shareAnOrg(viewer, memberB);
    const appAccount = await testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });
    await testHooks.addAccount(memberA, "context", `${memberA}-context`);
    await testHooks.addAccount(memberB, "context", `${memberB}-context`);

    // The scope unions both orgs: each member is pickable, justified by only their own org.
    for (const [person, orgId] of [[memberA, orgA], [memberB, orgB]] as const) {
      const selection = minted(await testHooks.pick(viewer, appAccount, person));
      await inUser(viewer, user => {
        const record = Array.from(user.storage.pendingUserSelections.list())
          .find(({ selectedUserId }) => selectedUserId === person);
        expect(record).toMatchObject({ selectedUserId: person, orgIds: [orgId] });
      });
      await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
        identity: `${person}-context`,
        displayName: person === memberA ? "Member A" : "Member B",
      }]);
    }
  });

  it("justifies a pick by an existing share relationship, live-checked at redemption", async () => {
    const viewer = uniqueUser("view");
    const owner = uniqueUser("owner");
    const testHooks = hooks();
    await Promise.all([createUser(viewer, "Viewer"), createUser(owner, "Owner")]);
    const appAccount = await testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });
    await testHooks.addAccount(owner, "context", `${owner}-context`);

    // No org holds these two; only the recorded share relationship makes the owner pickable.
    await env.TEST_USER.getByName(viewer).recordSharedGadgetOpen(
      "shared-gadget", "Shared Gadget", { type: "user", id: owner, name: "Owner" }, "build");
    const selection = minted(await testHooks.pick(viewer, appAccount, owner));
    await inUser(viewer, user => {
      const [record] = Array.from(user.storage.pendingUserSelections.list());
      expect(record).toMatchObject({ selectedUserId: owner, orgIds: [] });
    });
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
      identity: `${owner}-context`, displayName: "Owner",
    }]);

    // Forgetting the share strands a ticket that depended on it.
    const stranded = minted(await testHooks.pick(viewer, appAccount, owner));
    await env.TEST_USER.getByName(viewer).forgetSharedGadget("shared-gadget");
    await expect(testHooks.redeem(viewer, appAccount, stranded.ticket))
      .resolves.toEqual({ error: "This selection is no longer available. Please select the user again." });
  });

  it("refuses self-selection after the selector cold-starts through its serialized ID", async () => {
    const viewer = uniqueUser("view");
    const viewerId = env.TEST_USER.idFromName(viewer);
    const user = env.TEST_USER.get(env.TEST_USER.idFromString(viewerId.toString()));
    // Start through idFromString before any named access so this instance has no ctx.id.name.
    await user.authenticateFromCfAccess(viewer, true);
    await installAdminConfig(viewer);
    const testHooks = hooks();
    const appAccount = await testHooks.addAccount(viewer, "context", `${viewer}-context`, { providesUi: true });
    await inUser(viewer, instance => {
      expect(instance.ctx.id.name).toBeUndefined();
    });

    // The subsequent named mint must still recognize the caller and leave no redeemable ticket.
    await expect(testHooks.pick(viewer, appAccount, viewer)).resolves.toBeNull();
    await inUser(viewer, instance => {
      expect(Array.from(instance.storage.pendingUserSelections.list())).toEqual([]);
    });
  });

  it("refuses disabled, missing and non-UI selector apps", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();
    const plainAccount = await testHooks.addAccount(viewer, "github", `${viewer}-github`);

    await expect(testHooks.pick(viewer, plainAccount, picked)).resolves.toEqual({ error: "No such app." });
    await expect(testHooks.pick(viewer, appAccount + 1000, picked)).resolves.toEqual({ error: "No such app." });

    adminConfigKv.set(ADMIN_CONFIG_KEY, JSON.stringify({ disabledGatekeepers: ["context"] }));
    await expect(testHooks.pick(viewer, appAccount, picked)).resolves.toEqual({ error: "No such app." });
    adminConfigKv.delete(ADMIN_CONFIG_KEY);
    expect(minted(await testHooks.pick(viewer, appAccount, picked)).profile.displayName).toBe("Picked");
  });

  it("redeems to the picked person's own verifier and a fresh snapshot, once", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked("Before Rename");
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await testHooks.renameUser(picked, "After Rename");

    // The iframe keeps the name as of the pick; redemption reads it again.
    expect(selection.profile.displayName).toBe("Before Rename");
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
      identity: `${picked}-context`, displayName: "After Rename",
    }]);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
    await inUser(viewer, user => {
      expect(Array.from(user.storage.pendingUserSelections.list())).toEqual([]);
    });
  });

  it("refuses a ticket through another app account's exchange without spending it", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();
    const otherApp = await testHooks.addAccount(viewer, "github", `${viewer}-github`, { providesUi: true });
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));

    await expect(testHooks.redeem(viewer, otherApp, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([{
      identity: `${picked}-context`, displayName: "Picked",
    }]);
  });

  it("hands the app's account an exchange scoped to it when its UI opens", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();
    const otherApp = await testHooks.addAccount(viewer, "github", `${viewer}-github`, { providesUi: true });
    const forContext = minted(await testHooks.pick(viewer, appAccount, picked));
    const forOther = minted(await testHooks.pick(viewer, appAccount, picked));

    // The github app's exchange cannot redeem a ticket minted for the context app; the context app's can.
    await expect(testHooks.openAppUi(viewer, otherApp, `${viewer}-github`, forOther.ticket))
      .resolves.toBeUndefined();
    await expect(testHooks.accountCalls(`${viewer}-github`)).resolves.toContainEqual(
      expect.stringMatching(/^startAppUi\(false, error: /));
    await expect(testHooks.openAppUi(viewer, appAccount, `${viewer}-context`, forContext.ticket))
      .resolves.toBeUndefined();
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toContain(
      `startAppUi(false, ${picked}-context, Picked)`);
  });

  it("returns all current valid same-vendor accounts for only the picked person with fresh profiles", async () => {
    const { viewer, picked, appAccount, pickedAccount, testHooks } = await viewerAndPicked("Before Rename");
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await env.TEST_USER.getByName(picked).disconnectAccount(pickedAccount);
    await testHooks.addAccount(picked, "context", `${picked}-replacement`);
    await testHooks.addAccount(picked, "context", `${picked}-second`);
    await testHooks.addAccount(picked, "context", `${picked}-expired`, { expired: true });
    await testHooks.addAccount(picked, "github", `${picked}-github`);
    const otherPerson = uniqueUser("otherperson");
    await createUser(otherPerson, "Other Person");
    await testHooks.addAccount(otherPerson, "context", `${otherPerson}-context`);
    await testHooks.renameUser(picked, "After Rename");

    expect(selection.profile).toEqual({ displayName: "Before Rename" });
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([
      { identity: `${picked}-replacement`, displayName: "After Rename" },
      { identity: `${picked}-second`, displayName: "After Rename" },
    ]);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
  });

  it("delivers zero and multiple verifier results through the native app UI exchange", async () => {
    const { viewer, picked, appAccount, pickedAccount, testHooks } = await viewerAndPicked();
    const multiple = minted(await testHooks.pick(viewer, appAccount, picked));
    const secondAccount = await testHooks.addAccount(picked, "context", `${picked}-second`);
    await expect(testHooks.openAppUi(viewer, appAccount, `${viewer}-context`, multiple.ticket))
      .resolves.toBeUndefined();
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toContain(
      `startAppUi(false, ${picked}-context, Picked; ${picked}-second, Picked)`);
    await expect(testHooks.redeem(viewer, appAccount, multiple.ticket)).resolves.toEqual({ error: expect.any(String) });

    const empty = minted(await testHooks.pick(viewer, appAccount, picked));
    await env.TEST_USER.getByName(picked).disconnectAccount(pickedAccount);
    await env.TEST_USER.getByName(picked).disconnectAccount(secondAccount);
    await expect(testHooks.openAppUi(viewer, appAccount, `${viewer}-context`, empty.ticket))
      .resolves.toBeUndefined();
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toContain("startAppUi(false, [])");
    await expect(testHooks.redeem(viewer, appAccount, empty.ticket)).resolves.toEqual({ error: expect.any(String) });
  });

  it("returns an empty array after disconnect, without pinning a later ticket to that account", async () => {
    const { viewer, picked, appAccount, pickedAccount, testHooks } = await viewerAndPicked();
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await env.TEST_USER.getByName(picked).disconnectAccount(pickedAccount);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([]);
    await testHooks.addAccount(picked, "context", `${picked}-replacement`);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
    const next = minted(await testHooks.pick(viewer, appAccount, picked));
    await expect(testHooks.redeem(viewer, appAccount, next.ticket)).resolves.toEqual([
      { identity: `${picked}-replacement`, displayName: "Picked" },
    ]);
  });

  it("refuses another viewer's exchange without spending the selected person's ticket", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();
    const otherViewer = uniqueUser("otherviewer");
    await createUser(otherViewer, "Other Viewer");
    const otherApp = await testHooks.addAccount(otherViewer, "context", `${otherViewer}-context`, { providesUi: true });
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await expect(testHooks.redeem(otherViewer, otherApp, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([
      { identity: `${picked}-context`, displayName: "Picked" },
    ]);
  });

  it("filters policy-disabled ambient accounts and returns an empty array when none remain", async () => {
    const { viewer, picked, appAccount, pickedAccount, testHooks } = await viewerAndPicked();
    await inUser(picked, user => {
      const account = user.storage.connectedAccounts.get(pickedAccount);
      expect(account).toBeDefined();
      user.storage.connectedAccounts.put({ ...account, autoProvisioned: true });
    });
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    adminConfigKv.set(ADMIN_CONFIG_KEY, JSON.stringify({
      ambientGatekeeperModes: { context: "disabled" },
    }));
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([]);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: expect.any(String) });

    await testHooks.addAccount(picked, "context", `${picked}-manual`);
    const withManual = minted(await testHooks.pick(viewer, appAccount, picked));
    await expect(testHooks.redeem(viewer, appAccount, withManual.ticket)).resolves.toEqual([
      { identity: `${picked}-manual`, displayName: "Picked" },
    ]);
  });

  it("returns an empty array when credentials expire, and still spends the ticket", async () => {
    const { viewer, picked, appAccount, pickedAccount, testHooks } = await viewerAndPicked();
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    await env.TEST_USER.getByName(picked).markCredentialsExpired(pickedAccount);

    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual([]);
    // Empty redemption spent the ticket; restoring the account does not revive it.
    await env.TEST_USER.getByName(picked).markCredentialsRestored(pickedAccount);
    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: expect.any(String) });
  });

  it("refuses redemption when the selector app's vendor was disabled since the pick", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();
    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    adminConfigKv.set(ADMIN_CONFIG_KEY, JSON.stringify({ disabledGatekeepers: ["context"] }));

    await expect(testHooks.redeem(viewer, appAccount, selection.ticket)).resolves.toEqual({ error: "No such app." });
  });

  it("reveals nothing for malformed, unknown or expired tickets, and sweeps expired ones", async () => {
    const { viewer, picked, appAccount, testHooks } = await viewerAndPicked();

    const rejected = await testHooks.redeem(viewer, appAccount, "not-a-ticket");
    expect(rejected).toEqual({ error: expect.any(String) });
    await expect(testHooks.redeem(viewer, appAccount, "0".repeat(64))).resolves.toEqual(rejected);

    const presented = minted(await testHooks.pick(viewer, appAccount, picked));
    const swept = minted(await testHooks.pick(viewer, appAccount, picked));
    await inUser(viewer, async user => {
      expect(await user.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      // Snapshot first: a put during kv.list() invalidates the iterator.
      for (const record of Array.from(user.storage.pendingUserSelections.list())) {
        user.storage.pendingUserSelections.put({ ...record, expiresAt: new Date(Date.now() - 1) });
      }
    });

    // An expired ticket is refused and removed when presented; the alarm removes the other.
    await expect(testHooks.redeem(viewer, appAccount, presented.ticket)).resolves.toEqual(rejected);
    await inUser(viewer, async user => {
      expect(Array.from(user.storage.pendingUserSelections.list())).toHaveLength(1);
      await user.alarm();
      expect(Array.from(user.storage.pendingUserSelections.list())).toEqual([]);
      expect(await user.ctx.storage.getAlarm()).toBeNull();
    });
    await expect(testHooks.redeem(viewer, appAccount, swept.ticket)).resolves.toEqual(rejected);
  });

  it("reports the picked person's live org memberships with every redeemed account", async () => {
    const { viewer, picked, appAccount, testHooks, orgId } = await viewerAndPicked();
    // A second org the picked person joined, and one that only ever invited them: only active
    // memberships may reach a gatekeeper, since org-keyed grants resolve against them.
    const otherOwner = uniqueUser("owner");
    await createUser(otherOwner, "Other Owner");
    const secondOrg = await shareAnOrg(otherOwner, picked);
    const pendingOrg = `org-${crypto.randomUUID()}`;
    await env.TEST_ORG.getByName(pendingOrg).initializeOrg("Pending Org", otherOwner);
    await env.TEST_ORG.getByName(pendingOrg).inviteMember(otherOwner, picked);
    await testHooks.addAccount(picked, "context", `${picked}-second`);

    const selection = minted(await testHooks.pick(viewer, appAccount, picked));
    // Duplicated across the picked person's account results, and only active orgs: the pending
    // invitation is absent, and each array is the live org-authority answer, not a stale index.
    const memberships = [`${orgId}:member`, `${secondOrg}:member`].toSorted();
    await expect(testHooks.redeemMemberships(viewer, appAccount, selection.ticket)).resolves.toEqual([
      memberships, memberships,
    ]);

    // The opening user's own memberships reach the app in the AppUiContext, likewise live.
    const forContext = minted(await testHooks.pick(viewer, appAccount, picked));
    await expect(testHooks.openAppUi(viewer, appAccount, `${viewer}-context`, forContext.ticket))
      .resolves.toBeUndefined();
    await expect(testHooks.accountCalls(`${viewer}-context`)).resolves.toContain(
      `contextOrgs(false, ${orgId}:owner)`);
  });
});
