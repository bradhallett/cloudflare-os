import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { GatekeeperUserSelectionExchange } from "@gadgets/workshop-shared/gatekeeper";
import { ContextApiImpl } from "../src/context-api.js";
import { canReadCollection, collectionPermissions } from "../src/collection-access.js";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import { ContextVerifier } from "../src/library-gatekeeper.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { domainName } from "../src/domain.js";

// Org grants: an org holds a collection role, every recorded member resolves it live at each
// check, and orgs may own collections their admins govern. Storage persists across the file's
// tests, so each gets its own sharing domain — and the isolation test leans on that too.
let domain = "";
let domains = 0;
beforeEach(() => {
  domain = `workshop-${domains++}.example`;
});

// A rejected Durable Object RPC promise is a proxy that assertions would probe into further,
// unhandled, calls; settle it into a plain promise first.
function settled(rpc: PromiseLike<unknown>): Promise<unknown> {
  let { promise, resolve, reject } = Promise.withResolvers<unknown>();
  rpc.then(resolve, reject);
  return promise;
}

type TestEnv = {
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  USER_LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
  REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
};
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

const collection = (id: string) =>
  testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(domain, id)));
const library = (accountId: string) =>
  testEnv.USER_LIBRARIES.get(testEnv.USER_LIBRARIES.idFromName(domainName(domain, accountId)));

let nextId = 0;

/** A private web collection owned by `owner`, as the management API creates one. */
async function createCollection(owner: string): Promise<string> {
  let id = `collection-${nextId++}`;
  let now = new Date();
  await collection(id).initialize({
    id, title: "Runbooks", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, owner);
  await library(owner).createOwnedCollection(id);
  return id;
}

/** Record one account's org memberships in this sharing domain, as a Workshop sync would. */
async function recordMemberships(accountId: string, memberships: { orgId: string; role: string }[]) {
  await library(accountId).syncOrgMemberships(
    domain, accountId, memberships as { orgId: string; role: "owner" | "admin" | "member" }[]);
}

/** The account's org-aware standing on one collection, as every access decision reads it. */
async function resolved(id: string, accountId: string) {
  return collection(id).getResolvedAccess(accountId);
}

async function permissionsOf(id: string, accountId: string) {
  return collectionPermissions(await resolved(id, accountId), false);
}

/** A management API for `accountId`; the user-picker exchange is never spent by these tests. */
function api(accountId: string) {
  let exchange = {
    async redeem() { return []; },
  } as unknown as Fetcher<GatekeeperUserSelectionExchange>;
  return new ContextApiImpl(
    testEnv, domain, accountId, false,
    testEnv.COLLECTIONS, testEnv.USER_LIBRARIES, testEnv.REGISTRIES, exchange);
}

/** The observer-verification view of one account, as the Workshop receives it. */
function verifier(accountId: string) {
  return new ContextVerifier(Object.assign(createExecutionContext(), {
    props: { sharingDomain: domain, accountId },
  }), testEnv);
}

describe("org grants", () => {
  it("give every recorded member the grant's role, resolved live", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);

    let bob = await resolved(id, "bob");
    expect(bob.role).toBe("editor");
    expect(bob.manager).toBe(false);
    expect(canReadCollection(bob)).toBe(true);
    expect((await permissionsOf(id, "bob")).canEdit).toBe(true);

    // A non-member of the org gets nothing, and an account with no recorded memberships at all
    // is the same case: the grant confers only what a membership picks up.
    await recordMemberships("carol", []);
    expect((await resolved(id, "carol")).role).toBeNull();
    expect((await resolved(id, "dave")).role).toBeNull();
  });

  it("appear in member listings through the registry's org index, re-checked live", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "viewer");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);

    let listed = await library("bob").listLibrary(domain, "bob");
    expect(listed.map(entry => entry.id)).toContain(id);
    expect(listed.find(entry => entry.id === id)?.membership).toEqual({ role: "viewer", shared: true });

    // Access is the grant, not the index: drop the grant and the listing drops the collection,
    // though nothing else about the account changed.
    await collection(id).removeMember("alice", "org-1");
    expect((await library("bob").listLibrary(domain, "bob")).map(entry => entry.id)).not.toContain(id);
  });

  it("follow grant role changes and membership changes without any re-share", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    await recordMemberships("carol", [{ orgId: "org-1", role: "member" }]);

    // Demote the org: both members lose edit but keep read.
    await collection(id).setMemberRole("alice", "org-1", "viewer");
    expect((await permissionsOf(id, "bob")).canEdit).toBe(false);
    expect(canReadCollection(await resolved(id, "carol"))).toBe(true);

    // Bob leaves the org: his access drops even though the grant stands for everyone else.
    await recordMemberships("bob", []);
    expect((await resolved(id, "bob")).role).toBeNull();
    expect(canReadCollection(await resolved(id, "carol"))).toBe(true);

    // The sharing surface shows the org as one member row, so managers see what they govern.
    let sharing = await collection(id).getSharing("alice");
    let orgRow = sharing.members.find(member => member.memberId === "org-1");
    expect(orgRow?.subject).toBe("org");
    expect(orgRow?.role).toBe("viewer");
  });

  it("make org owners' admins the managers, plain members their editors", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "owner");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);

    // A plain member is an editor: they may edit and share like any editor, but neither manage
    // owners nor delete — governance of an org-owned collection belongs to its admins.
    let bob = await resolved(id, "bob");
    expect(bob.role).toBe("editor");
    expect(bob.manager).toBe(false);
    let bobPermissions = await permissionsOf(id, "bob");
    expect(bobPermissions.canEdit).toBe(true);
    expect(bobPermissions.canShare).toBe(true);
    expect(bobPermissions.canManageOwners).toBe(false);
    expect(bobPermissions.canDelete).toBe(false);

    // An admin governs: full management rights through the org, with no account grant at all.
    let dana = await resolved(id, "dana");
    expect(dana.role).toBe("editor");
    expect(dana.manager).toBe(true);
    let danaPermissions = await permissionsOf(id, "dana");
    expect(danaPermissions.canShare).toBe(true);
    expect(danaPermissions.canManageOwners).toBe(true);
    expect(danaPermissions.canDelete).toBe(true);
  });

  it("let an org admin create an org-owned collection, and gate everyone else out", async () => {
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);

    let meta = await api("dana").createContextCollection(
      "Team library", "", "private", undefined, "web", "org-1");
    expect(meta.id).toBeTruthy();

    // The org holds the owner grant; the creator is attributed but holds no account grant, so
    // their authority is governance, and governance is exactly the admin's.
    let dana = await resolved(meta.id, "dana");
    expect(dana.role).toBe("editor");
    expect(dana.manager).toBe(true);
    expect((await permissionsOf(meta.id, "dana")).canDelete).toBe(true);

    // Members read and edit, but neither manage nor delete.
    let bob = await resolved(meta.id, "bob");
    expect(bob.role).toBe("editor");
    expect(bob.manager).toBe(false);
    let bobPermissions = await permissionsOf(meta.id, "bob");
    expect(bobPermissions.canEdit).toBe(true);
    expect(bobPermissions.canDelete).toBe(false);

    // Members may not create for the org; neither may an admin of no recorded org.
    await expect(settled(api("bob").createContextCollection(
      "Nope", "", "private", undefined, "web", "org-1"))).rejects.toThrow("administer");
    await expect(settled(api("dana").createContextCollection(
      "Nope", "", "private", undefined, "web", "org-2"))).rejects.toThrow("administer");

    // The member's own API lists it like any private collection in their library.
    expect((await api("bob").listEnabledContextCollections())
      .map(entry => entry.id)).toContain(meta.id);
  });

  it("can be shared through the management API only by those who may share", async () => {
    let id = await createCollection("alice");
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);

    // An org admin with no standing on this collection cannot spend its name on it.
    await expect(settled(api("dana").shareContextCollectionWithOrg(id, "org-1", "viewer")))
      .rejects.toThrow("not found");

    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await api("alice").shareContextCollectionWithOrg(id, "org-1", "viewer");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    expect((await resolved(id, "bob")).role).toBe("viewer");

    // A member resolved through the org grant still cannot share.
    await expect(settled(api("bob").shareContextCollectionWithOrg(id, "org-1", "editor")))
      .rejects.toThrow("not found");
  });

  it("keep the last owner across both grant stores", async () => {
    // An org-owned collection: its org grant is the only owner, so demoting or removing it is
    // refused — nobody would be left to govern the collection.
    let orgOwned = `collection-${nextId++}`;
    let now = new Date();
    await collection(orgOwned).initialize({
      id: orgOwned, title: "Team library", description: "", visibility: "private",
      created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
    }, domain, "dana", "org-1");
    await testEnv.REGISTRIES.getByName(domain).addOrgCollection(domain, "org-1", orgOwned);
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);

    await expect(settled(collection(orgOwned).setMemberRole("dana", "org-1", "viewer")))
      .rejects.toThrow("needs an owner");
    await expect(settled(collection(orgOwned).removeMember("dana", "org-1")))
      .rejects.toThrow("needs an owner");

    // An account-owned collection: once the org also holds an owner grant, the account owner may
    // leave — the org keeps the collection owned.
    let owned = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-2", role: "member" }]);
    await collection(owned).shareOrg("alice", "org-2", "owner");
    await collection(owned).removeMember("alice", "alice");
    await recordMemberships("alice", []);
    let after = await resolved(owned, "alice");
    expect(after.role).toBeNull();
    expect(after.hasOwner).toBe(true);

    // The org's own admins are still its managers, and with no other owner recorded the org
    // grant cannot be removed by anyone: not by an admin of the owning org...
    await recordMemberships("erin", [{ orgId: "org-2", role: "admin" }]);
    await expect(settled(collection(owned).removeMember("erin", "org-2")))
      .rejects.toThrow("needs an owner");
    // ...and not by an outsider editor.
    await collection(owned).share("erin", [{ accountId: "frank", displayName: "Frank" }], "editor");
    await expect(settled(collection(owned).removeMember("frank", "org-2")))
      .rejects.toThrow("Only owners can change who owns this collection");
  });

  it("keep a collection alive across a member's disconnection", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);

    // The account that owned it disconnects: its own grant goes, the org grant survives.
    await collection(id).removeAccount("alice");
    expect((await resolved(id, "bob")).role).toBe("editor");
    expect((await collection(id).getMetadata()).id).toBe(id);

    // A member's disconnection drops their grant only through their own library wipe; the org
    // grant never lived per account, so the collection keeps serving the org's other members.
    await recordMemberships("carol", [{ orgId: "org-1", role: "member" }]);
    await collection(id).removeAccount("carol");
    expect((await resolved(id, "bob")).role).toBe("editor");
  });

  it("resolve only within the sharing domain the memberships were recorded in", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "viewer");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    expect((await resolved(id, "bob")).role).toBe("viewer");

    // Same collection id in another domain: bob's memberships are not recorded there, and the
    // collection there never granted the org anything either.
    let otherDomain = `workshop-${domains++}.example`;
    let other = testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(otherDomain, id)));
    let otherNow = new Date();
    await other.initialize({
      id, title: "Runbooks", description: "", visibility: "private",
      created: otherNow, lastUpdated: otherNow, documentCount: 0, content: { source: "web" },
    }, otherDomain, "zoe");
    let bobLibraryThere = testEnv.USER_LIBRARIES.get(
      testEnv.USER_LIBRARIES.idFromName(domainName(otherDomain, "bob")));
    expect((await bobLibraryThere.listOrgMemberships(otherDomain, "bob"))).toEqual([]);

    // Observer verification answers per domain too: true where the grant and membership line up,
    // false for a collection of another domain.
    let verify = verifier("bob");
    expect(await verify.hasCollectionsAccess(domain, [id])).toEqual([true]);
    expect(await verify.hasCollectionsAccess(otherDomain, [id])).toEqual([false]);
  });

  it("verify observers with org grants, following membership loss", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    expect(await verifier("bob").hasCollectionsAccess(domain, [id, "unknown"])).toEqual([true, false]);

    // Bob leaves the org: verification follows, because it resolves live like every read.
    await recordMemberships("bob", []);
    expect(await verifier("bob").hasCollectionsAccess(domain, [id])).toEqual([false]);
  });

  it("require the sharer to belong to an org before granting or raising its access", async () => {
    let id = await createCollection("alice");
    // An editor with no recorded membership in the target org: the org's name is not theirs to
    // spend, however they learned it — not directly, not through the management API, and not by
    // raising a grant someone else made.
    await collection(id).share("alice", [{ accountId: "mallory", displayName: "Mallory" }], "editor");
    await recordMemberships("mallory", [{ orgId: "org-2", role: "admin" }]);
    await expect(settled(collection(id).shareOrg("mallory", "org-1", "viewer")))
      .rejects.toThrow("belong to an organization");
    await expect(settled(api("mallory").shareContextCollectionWithOrg(id, "org-1", "viewer")))
      .rejects.toThrow("belong to an organization");

    // No grant was written: org-1 members still have no access.
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    expect((await resolved(id, "bob")).role).toBeNull();

    // A recorded member may grant the org; once they leave, raising the grant is refused but
    // dropping it stays open — a stale grant must never strand.
    await recordMemberships("mallory", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("mallory", "org-1", "viewer");
    expect((await resolved(id, "bob")).role).toBe("viewer");
    await recordMemberships("mallory", []);
    await expect(settled(collection(id).setMemberRole("mallory", "org-1", "editor")))
      .rejects.toThrow("belong to an organization");
    await collection(id).removeMember("mallory", "org-1");
    expect((await resolved(id, "bob")).role).toBeNull();
  });

  it("do not leak between orgs an account belongs to", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    // Bob belongs to org-2 only: a grant to one org is not a grant to any org.
    await recordMemberships("bob", [{ orgId: "org-2", role: "admin" }]);
    expect((await resolved(id, "bob")).role).toBeNull();
  });

  it("honor the strongest of the account's own grant and its orgs' grants", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "Bob" }], "viewer");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "editor");
    await recordMemberships("bob", [{ orgId: "org-1", role: "member" }]);
    expect((await resolved(id, "bob")).role).toBe("editor");
    // The account's own grant wins the other way, and governance follows the org grant alone:
    // dana administers an org whose grant is only editor, so dana edits but does not govern.
    await collection(id).setMemberRole("alice", "bob", "owner");
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);
    let dana = await resolved(id, "dana");
    expect(dana.role).toBe("editor");
    expect(dana.manager).toBe(false);
    let bobAfter = await resolved(id, "bob");
    expect(bobAfter.role).toBe("owner");
    expect(bobAfter.manager).toBe(false);
  });

  it("delete the collection when the last grant of either kind goes", async () => {
    let id = await createCollection("alice");
    await recordMemberships("alice", [{ orgId: "org-1", role: "member" }]);
    await collection(id).shareOrg("alice", "org-1", "owner");
    await recordMemberships("dana", [{ orgId: "org-1", role: "admin" }]);
    // Everyone may view while the owner is still there to say so.
    await collection(id).setEveryoneCanView("alice", true);

    // The account owner's own grant leaves first; the org's owner grant holds the collection.
    await collection(id).removeMember("alice", "alice");
    expect((await collection(id).getMetadata()).id).toBe(id);

    // The org grant is now the only owner, so removing it is refused like any last owner; the
    // governed way to end the collection is deleting it, which the org's admin may do.
    await expect(settled(collection(id).removeMember("dana", "org-1")))
      .rejects.toThrow("needs an owner");
    await collection(id).deleteSelf("dana", false);
    expect((await resolved(id, "alice")).exists).toBe(false);
  });
});
