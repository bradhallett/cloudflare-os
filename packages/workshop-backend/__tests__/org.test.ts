// The organization Durable Object's membership rules, exercised like production reaches them:
// through the namespace (so @validateRpc's generated validators compile and run), with the
// user-DO membership index checked after each change. The pure policy (org-access.ts) is covered
// by these outcomes; storage round-trips have their own suite (org-storage.test.ts).

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OrgMember, OrgSummary } from "@gadgets/workshop-shared/api";
import type { OrgDurableObject } from "../src/org";
import { makeOrgStorage } from "../src/storage-schema/org-storage";
import type { UserDurableObject } from "../src/user";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

let counter = 0;

// A fresh org id, unique per test like randomOrgId() is in production.
function newOrgId(): string {
  return `org-${++counter}-${crypto.randomUUID().slice(0, 8)}`;
}

// Fresh people per test: the user DO is shared across the suite, and each test must see only
// its own mirrored memberships in the index.
function people(): { alice: string, bob: string, carol: string } {
  const n = ++counter;
  return {
    alice: `alice-${n}@example.com`,
    bob: `bob-${n}@example.com`,
    carol: `carol-${n}@example.com`,
  };
}

function org(id: string): DurableObjectStub<OrgDurableObject> {
  return env.TEST_ORG.getByName(id);
}

// Creates an org owned by `owner`, returning its id and the summary the creator saw.
async function createOrg(name: string, owner: string): Promise<{ id: string, summary: OrgSummary }> {
  const id = newOrgId();
  const summary = await org(id).initializeOrg(name, owner);
  return { id, summary };
}

// Accepts however a failing call surfaces — validators may throw synchronously or reject — and
// returns its message, or fails the test when nothing was thrown.
async function failure(call: () => unknown): Promise<string> {
  try {
    await Promise.resolve().then(call);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

// The user's mirrored membership index, as listMyOrgs reads it.
async function myMemberships(userId: string) {
  return env.TEST_USER.getByName(userId).listOrgMemberships();
}

// Rewrites `userId`'s invitation to have expired, the way time passing would.
async function expireInvitation(id: string, userId: string): Promise<void> {
  await runInDurableObject(org(id), (_instance, state) => {
    const storage = makeOrgStorage(state.storage);
    const invitation = storage.invitations.get(userId);
    if (invitation === undefined) throw new Error("no invitation to expire");
    storage.invitations.put({ ...invitation, expiresAt: new Date(Date.now() - 1) });
  });
}

describe("org membership", () => {
  it("runs the lifecycle: create → invite → accept → role change → remove", async () => {
    const { alice: ALICE, bob: BOB, carol: CAROL } = people();
    const { id, summary } = await createOrg("Acme", ALICE);
    expect(summary).toMatchObject(
        { name: "Acme", role: "owner", status: "active", invitePolicy: "admin" });
    expect(await myMemberships(ALICE)).toEqual(
        [{ orgId: id, role: "owner", status: "active" }]);

    // Invite Bob: his record is invited, and his own index learns of it.
    const invited = await org(id).inviteMember(ALICE, BOB);
    expect(invited).toMatchObject(
        { userId: BOB, role: "member", status: "invited", invitedBy: ALICE, joinedAt: null });
    expect(await myMemberships(BOB)).toEqual([{ orgId: id, role: "member", status: "invited" }]);

    // He cannot act as a member yet.
    expect(await failure(() => org(id).listMembersFor(BOB)))
        .toBe("Only a member of this organization may list its members.");

    // He accepts.
    const joined = await org(id).acceptInvitation(BOB);
    expect(joined).toMatchObject({ role: "member", status: "active" });
    expect((await org(id).getMember(BOB))!.joinedAt).toBeInstanceOf(Date);
    expect(await myMemberships(BOB)).toEqual([{ orgId: id, role: "member", status: "active" }]);

    // The owner promotes him; the change is authoritative and mirrored.
    const promoted = await org(id).changeMemberRole(ALICE, BOB, "admin");
    expect(promoted).toMatchObject({ userId: BOB, role: "admin", status: "active" });
    expect(await myMemberships(BOB)).toEqual([{ orgId: id, role: "admin", status: "active" }]);

    // The member list reads in user-id order, invitations included.
    const members: OrgMember[] = await org(id).listMembersFor(ALICE);
    expect(members.map(m => [m.userId, m.role])).toEqual([[ALICE, "owner"], [BOB, "admin"]]);

    // The owner removes him: record and index entry both go.
    await org(id).removeMember(ALICE, BOB);
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await myMemberships(BOB)).toEqual([]);
    expect((await org(id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE]);

    // Carol was never involved; her index never heard of this org.
    expect(await myMemberships(CAROL)).toEqual([]);
  });

  it("refuses every way of leaving an org without an owner", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);

    // Demotion, removal, and leaving are all refused while Alice is the only owner.
    expect(await failure(() => org(id).changeMemberRole(ALICE, ALICE, "member")))
        .toBe("An organization must keep at least one owner; hand ownership over first.");
    expect(await failure(() => org(id).removeMember(ALICE, ALICE)))
        .toBe("An organization must keep at least one owner; hand ownership over first.");
    expect(await failure(() => org(id).memberLeave(ALICE)))
        .toBe("An organization must keep at least one owner; hand ownership over first.");

    // Hand ownership over, and the former owner may leave.
    await org(id).inviteMember(ALICE, BOB, "owner");
    await org(id).acceptInvitation(BOB);
    await org(id).memberLeave(ALICE);
    expect(await org(id).getMember(ALICE)).toBeNull();
    expect(await myMemberships(ALICE)).toEqual([]);
    expect((await org(id).listMembersFor(BOB)).map(m => m.userId)).toEqual([BOB]);

    // Bob is now the sole owner, and equally protected.
    expect(await failure(() => org(id).changeMemberRole(BOB, BOB, "member")))
        .toBe("An organization must keep at least one owner; hand ownership over first.");
  });

  it("keeps one person's memberships in two orgs isolated", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const first = await createOrg("First", ALICE);
    const second = await createOrg("Second", ALICE);

    await org(first.id).inviteMember(ALICE, BOB, "admin");
    await org(second.id).inviteMember(ALICE, BOB, "member");
    await org(first.id).acceptInvitation(BOB);
    await org(second.id).acceptInvitation(BOB);

    // Two memberships, independently roled.
    const memberships = await myMemberships(BOB);
    expect(new Set(memberships.map(m => m.orgId))).toEqual(new Set([first.id, second.id]));
    expect(memberships.filter(m => m.orgId === first.id)).toEqual(
        [{ orgId: first.id, role: "admin", status: "active" }]);
    expect(memberships.filter(m => m.orgId === second.id)).toEqual(
        [{ orgId: second.id, role: "member", status: "active" }]);
    expect((await org(first.id).getMember(BOB))!.role).toBe("admin");
    expect((await org(second.id).getMember(BOB))!.role).toBe("member");

    // Leaving the first leaves the second untouched.
    await org(first.id).memberLeave(BOB);
    expect(await org(first.id).getMember(BOB)).toBeNull();
    expect(await myMemberships(BOB)).toEqual([{ orgId: second.id, role: "member", status: "active" }]);
    // Each org still sees only its own members.
    expect((await org(first.id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE]);
    expect((await org(second.id).listMembersFor(ALICE)).map(m => m.userId))
        .toEqual([ALICE, BOB]);
  });

  it("enforces the invite policy and the rank rules", async () => {
    const { alice: ALICE, bob: BOB, carol: CAROL } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "member");
    await org(id).acceptInvitation(BOB);

    // Default policy: a plain member may not invite.
    expect(await failure(() => org(id).inviteMember(BOB, CAROL)))
        .toBe("You may not invite members to this organization.");

    // An admin may invite, but never above their own rank.
    await org(id).changeMemberRole(ALICE, BOB, "admin");
    expect(await failure(() => org(id).inviteMember(BOB, CAROL, "owner")))
        .toBe("You may not grant a role above your own.");
    const invited = await org(id).inviteMember(BOB, CAROL, "admin");
    expect(invited).toMatchObject({ userId: CAROL, role: "admin", status: "invited" });

    // An admin may not change roles, update settings, or remove an admin.
    expect(await failure(() => org(id).changeMemberRole(BOB, CAROL, "member")))
        .toBe("Only an owner may change roles in this organization.");
    expect(await failure(() => org(id).updateOrgSettings(BOB, { invitePolicy: "member" })))
        .toBe("Only an owner may change this organization's settings.");
    expect(await failure(() => org(id).removeMember(BOB, CAROL)))
        .toBe("You may not remove that member.");
    // But an admin does remove a member.
    await org(id).changeMemberRole(ALICE, CAROL, "member");
    await org(id).removeMember(BOB, CAROL);
    expect(await org(id).getMember(CAROL)).toBeNull();

    // Under the member policy a member may invite — at the member role only.
    expect(await org(id).updateOrgSettings(ALICE, { invitePolicy: "member" }))
        .toMatchObject({ invitePolicy: "member" });
    await org(id).changeMemberRole(ALICE, BOB, "member");
    expect((await org(id).inviteMember(BOB, CAROL)).role).toBe("member");
    expect(await failure(() => org(id).inviteMember(BOB, CAROL, "admin")))
        .toBe("You may not grant a role above your own.");

    // Nonsense invitations are refused.
    expect(await failure(() => org(id).inviteMember(ALICE, ALICE)))
        .toBe("You are already in this organization.");
    await org(id).acceptInvitation(CAROL);
    expect(await failure(() => org(id).inviteMember(ALICE, CAROL)))
        .toBe("That person is already a member of this organization.");
    expect(await failure(() => org(id).inviteMember(ALICE, "   ")))
        .toBe("The invited user id must not be empty.");
  });

  it("restricts the member list to active members", async () => {
    const { alice: ALICE, bob: BOB, carol: CAROL } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB);

    // Invited is not in: only standing members may read.
    expect(await failure(() => org(id).listMembersFor(BOB)))
        .toBe("Only a member of this organization may list its members.");
    expect(await failure(() => org(id).listMembersFor(CAROL)))
        .toBe("Only a member of this organization may list its members.");
    expect((await org(id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE, BOB]);
  });

  it("refuses an expired invitation and sweeps it with its member record", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB);
    await expireInvitation(id, BOB);

    // Acceptance is refused, and the swept records are gone — org-side and in Bob's index.
    expect(await failure(() => org(id).acceptInvitation(BOB)))
        .toBe("That invitation has expired.");
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await org(id).describeForMember(BOB)).toBeNull();
    expect(await myMemberships(BOB)).toEqual([]);

    // A later invitation to the same person works from a clean slate.
    expect((await org(id).inviteMember(ALICE, BOB, "admin")).role).toBe("admin");
    expect((await org(id).getMember(BOB))!.invitedBy).toBe(ALICE);
  });

  it("refreshes a pending invitation on re-invite, keeping one record", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "member");
    const refreshed = await org(id).inviteMember(ALICE, BOB, "admin");

    expect(refreshed).toMatchObject({ userId: BOB, role: "admin", status: "invited" });
    expect((await org(id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE, BOB]);
    // The refreshed role is what acceptance grants.
    expect((await org(id).acceptInvitation(BOB)).role).toBe("admin");
  });

  it("a pending invited owner does not dilute the sole active owner's protection", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "owner");

    // Bob's invitation is at the owner role, but he is not an owner yet: Alice remains the sole
    // active owner, so she can neither leave nor demote herself against a phantom second owner.
    expect(await failure(() => org(id).memberLeave(ALICE)))
        .toBe("An organization must keep at least one owner; hand ownership over first.");
    expect(await failure(() => org(id).changeMemberRole(ALICE, ALICE, "member")))
        .toBe("An organization must keep at least one owner; hand ownership over first.");

    // The pending owner invitation can be revoked by removal, without stranding the org.
    await org(id).removeMember(ALICE, BOB);
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await org(id).getMember(ALICE)).toMatchObject({ role: "owner", status: "active" });
    expect(await myMemberships(BOB)).toEqual([]);
  });

  it("a pending invited owner can decline while a sole active owner remains", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "owner");

    // Bob leaving is declining the invitation: his pending record was never an active owner,
    // so Alice's sole ownership does not refuse him.
    await org(id).memberLeave(BOB);
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await myMemberships(BOB)).toEqual([]);
    expect(await org(id).getMember(ALICE)).toMatchObject({ role: "owner", status: "active" });
  });

  it("an expired invited owner is swept without touching the last active member record", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "owner");
    await expireInvitation(id, BOB);

    // The sweep removes only the invited record; the active owner stays put.
    expect(await org(id).describeForMember(BOB)).toBeNull();
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await org(id).getMember(ALICE)).toMatchObject({ role: "owner", status: "active" });
    expect((await org(id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE]);
  });

  it("an owner may remove a co-owner; the sole active owner still cannot be removed", async () => {
    const { alice: ALICE, bob: BOB, carol: CAROL } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB, "owner");
    await org(id).acceptInvitation(BOB);
    await org(id).inviteMember(ALICE, CAROL, "owner");
    await org(id).acceptInvitation(CAROL);

    // Equal rank: either owner removes a co-owner.
    await org(id).removeMember(BOB, CAROL);
    expect(await org(id).getMember(CAROL)).toBeNull();
    expect(await myMemberships(CAROL)).toEqual([]);

    // Two active owners remain, so Alice may remove Bob too — leaving herself sole owner,
    // where the last-owner protection takes over again.
    await org(id).removeMember(ALICE, BOB);
    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await failure(() => org(id).removeMember(ALICE, ALICE)))
        .toBe("An organization must keep at least one owner; hand ownership over first.");
    expect(await org(id).getMember(ALICE)).toMatchObject({ role: "owner", status: "active" });
  });

  it("revoking an invitation by removal frees the invitee to be re-invited", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);
    await org(id).inviteMember(ALICE, BOB);
    await org(id).removeMember(ALICE, BOB);

    expect(await org(id).getMember(BOB)).toBeNull();
    expect(await myMemberships(BOB)).toEqual([]);
    expect(await failure(() => org(id).acceptInvitation(BOB)))
        .toBe("You have no pending invitation to this organization.");
  });

  it("answers reads for an unknown org id, and refuses to reuse one", async () => {
    const { alice: ALICE } = people();
    expect(await org(newOrgId()).describeForMember(ALICE)).toBeNull();
    expect(await org(newOrgId()).getMember(ALICE)).toBeNull();
    expect(await failure(() => org(newOrgId()).listMembersFor(ALICE)))
        .toBe("No such organization.");
    expect(await failure(() => org(newOrgId()).acceptInvitation(ALICE)))
        .toBe("No such organization.");

    const { id } = await createOrg("Acme", ALICE);
    expect(await failure(() => org(id).initializeOrg("Again", ALICE)))
        .toBe("This organization id is already in use.");
  });

  it("validates the org name", async () => {
    const { alice: ALICE } = people();
    expect(await failure(() => org(newOrgId()).initializeOrg("   ", ALICE)))
        .toBe("An organization name must be 1 to 100 characters.");
    expect(await failure(() => org(newOrgId()).initializeOrg("x".repeat(101), ALICE)))
        .toBe("An organization name must be 1 to 100 characters.");
    // Whitespace is trimmed, and 100 characters is accepted.
    expect((await org(newOrgId()).initializeOrg("  Acme  ", ALICE)).name).toBe("Acme");
    expect((await org(newOrgId()).initializeOrg("x".repeat(100), ALICE)).name).toHaveLength(100);
  });
});

describe("org RPC validation", () => {
  // The class is @validateRpc()-decorated, so these run the generated validators (the
  // loopback-validation.test.ts pattern): malformed arguments reject before the org is touched.

  it("rejects malformed arguments without writing anything", async () => {
    const { alice: ALICE, bob: BOB } = people();
    const { id } = await createOrg("Acme", ALICE);

    expect(await failure(() => org(id).inviteMember(ALICE, BOB, "wizard" as never)))
        .toBeTruthy();
    expect(await failure(() => org(id).inviteMember(42 as never, BOB))).toBeTruthy();
    expect(await failure(() => org(id).changeMemberRole(ALICE, BOB, undefined as never)))
        .toBeTruthy();
    expect(await failure(() => org(id).initializeOrg(null as never, ALICE))).toBeTruthy();
    expect(await failure(() => org(id).updateOrgSettings(ALICE, { invitePolicy: "anyone" as never })))
        .toBeTruthy();

    // Nothing above wrote: the org still has exactly its creator.
    expect((await org(id).listMembersFor(ALICE)).map(m => m.userId)).toEqual([ALICE]);
    expect(await org(id).getMember(BOB)).toBeNull();
  });
});
