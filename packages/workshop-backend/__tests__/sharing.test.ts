import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { SharingManager, SharingStorage } from "../src/sharing.js";
import type { OrgRole } from "@gadgets/workshop-shared/api";
import {
  AiChatAuthorInfo,
  PermissionEdge,
  CollaboratorRole,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import type { CollaboratorRecord, ShareKeyRecord } from "../src/storage-schema/overseer-storage.js";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): SharingStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      collaborators: collection<CollaboratorRecord>()({
        primaryKey: (record: CollaboratorRecord) => record.profile.id,
      }),
      shareKeys: collection<ShareKeyRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: {
          byAlias(record: ShareKeyRecord) {
            return record.alias ?? null;
          },
        },
      }),
    },
  });
}

const OWNER = "owner@example.com";

function makeManager(
    ownerInvitesOnly: () => boolean = () => false,
    owningOrgRoles: () => Promise<ReadonlyMap<string, OrgRole> | null> = async () => null,
): {
  storage: SharingStorage;
  mgr: SharingManager;
} {
  let storage = makeStorage();
  return { storage, mgr: new SharingManager(storage, OWNER, ownerInvitesOnly, owningOrgRoles) };
}

// A manager whose `ownerInvitesOnly` flag the test can flip at any point.
function makeManagerWithFlag() {
  let flags = { ownerInvitesOnly: false };
  return { flags, ...makeManager(() => flags.ownerInvitesOnly) };
}

// A manager for a workspace owned by the org with the given members (userId → org role). Tests
// mutate the map to model membership changes between reads, as a live snapshot would.
function makeOrgManager(members: Record<string, OrgRole>, ownerInvitesOnly = false) {
  let snapshot = new Map(Object.entries(members));
  let flags = { ownerInvitesOnly };
  return {
    snapshot,
    flags,
    ...makeManager(() => flags.ownerInvitesOnly, async () => snapshot),
  };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

function userEdge(sharer: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "user", sharer, created: new Date(), role };
}

function keyEdge(keyId: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "shareKey", keyId, created: new Date(), role };
}

function seedCollaborator(storage: SharingStorage, id: string, addedBy: PermissionEdge[]) {
  storage.collaborators.put({ profile: profile(id), addedBy });
}

// Seed a share link. A link is stored as its first key, so `linkId` is that key's hash -- which is
// what `shareKey` edges reference.
function seedLink(
  storage: SharingStorage,
  linkId: string,
  createdBy: string,
  role: CollaboratorRole = "build",
) {
  storage.shareKeys.put({ id: linkId, created: new Date(), createdBy, role });
}

// Read back a link record, asserting that the id names a link rather than one of its aliases.
function link(storage: SharingStorage, linkId: string) {
  let record = storage.shareKeys.get(linkId)!;
  if (record.alias !== undefined) throw new Error(`${linkId} is an alias, not a link`);
  return record;
}

function ids(list: { profile: AiChatAuthorInfo }[]): string[] {
  return list.map((x) => x.profile.id).toSorted();
}

const owner = { profileId: OWNER, isOwner: true };
function collab(id: string) {
  return { profileId: id, isOwner: false };
}

describe("authorization", () => {
  it("isCollaborator reflects the collaborators table", async () => {
    let { storage, mgr } = makeManager();
    expect(mgr.isCollaborator("a")).toBe(false);
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    expect(mgr.isCollaborator("a")).toBe(true);
  });

  it("getEffectiveRole returns build for the owner", async () => {
    let { mgr } = makeManager();
    expect(await mgr.getEffectiveRole(OWNER)).toBe("build");
  });

  it("getEffectiveRole returns undefined for non-collaborators", async () => {
    let { mgr } = makeManager();
    expect(await mgr.getEffectiveRole("nobody")).toBeUndefined();
  });

  it("getEffectiveRole reflects the granted role", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "build")]);
    expect(await mgr.getEffectiveRole("a")).toBe("use");
    expect(await mgr.getEffectiveRole("b")).toBe("build");
  });
});

describe("redeemShareKey", () => {
  it("creates a new collaborator (fetching profile) when the key is valid", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "newbie",
      fetchProfile: async () => {
        fetched++;
        return profile("newbie");
      },
    });

    expect(fetched).toBe(1);
    let rec = storage.collaborators.get("newbie")!;
    expect(rec.addedBy).toEqual([expect.objectContaining({ type: "shareKey", role: "build" })]);
  });

  it("stamps the redeemed edge with the key's role", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "use" });

    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "shareKey", role: "use" }),
    ]);
    expect(await mgr.getEffectiveRole("a")).toBe("use");
  });

  it("adds a key edge to an existing collaborator without fetching the profile", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER)]);

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => {
        fetched++;
        return profile("a");
      },
    });

    expect(fetched).toBe(0);
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("does not duplicate an edge for the same key", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
  });

  it("is a no-op for an unknown key", async () => {
    let { storage, mgr } = makeManager();
    // A syntactically-valid raw key (hex) that was never created.
    await mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff",
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });
});

describe("addCollaborator", () => {
  it("adds a new collaborator with a user edge from the caller", async () => {
    let { storage, mgr } = makeManager();
    let info = await mgr.addCollaborator({
      caller: owner,
      profile: profile("a"),
      role: "build",
      note: "hi",
    });
    expect(info.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "build", note: "hi" }),
    ]);
    expect(info.role).toBe("build");
    expect(storage.collaborators.get("a")).toBeDefined();
  });

  it("records the granted role", async () => {
    let { mgr } = makeManager();
    let info = await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(info.role).toBe("use");
  });

  it("refuses to add the owner", async () => {
    let { mgr } = makeManager();
    await expect(
      mgr.addCollaborator({ caller: owner, profile: profile(OWNER), role: "build" }),
    ).rejects.toThrow(/owner/);
  });

  it("forbids granting a role higher than the caller's own", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    await expect(
      mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "build" }),
    ).rejects.toThrow(/higher than your own/);
    // Granting an equal-or-lower role is fine.
    await expect(
      mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "use" }),
    ).resolves.toBeDefined();
  });

  it("adds a second edge from a different sharer but dedups same sharer", async () => {
    let { storage, mgr } = makeManager();
    await mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "build" });
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    await mgr.addCollaborator({ caller: collab("b"), profile: profile("a"), role: "build" });
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" }); // dup sharer
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("upgrades (never downgrades) the role of an existing same-sharer edge", async () => {
    let { storage, mgr } = makeManager();
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(await mgr.getEffectiveRole("a")).toBe("build");

    // A subsequent lower grant does not downgrade the existing edge.
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(await mgr.getEffectiveRole("a")).toBe("build");
  });
});

describe("computeEffectiveRoles", () => {
  it("propagates roles along a chain", async () => {
    let { storage, mgr } = makeManager();
    // owner -> a -> b
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    let roles = mgr.computeEffectiveRoles();
    expect(roles.get("a")).toBe("build");
    expect(roles.get("b")).toBe("build");
  });

  it("bounds a granted role by the sharer's effective role", async () => {
    let { storage, mgr } = makeManager();
    // owner -grants use-> a; a -grants build-> b. b is bounded by a's "use".
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    expect(await mgr.getEffectiveRole("b")).toBe("use");
  });

  it("takes the maximum across multiple paths", async () => {
    let { storage, mgr } = makeManager();
    // b is reachable via owner directly (use) and via a (build).
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    expect(await mgr.getEffectiveRole("b")).toBe("build");
  });

  it("severs a target's own edges and drops their sole dependents", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ severedTarget: "a" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });

  it("cascades share-link revocation through dependent users", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ revokedLinkId: "k1" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });
});

describe("previewRemoveCollaborator", () => {
  it("reports a transitively-removed dependent", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let affected = await mgr.previewRemoveCollaborator(owner, "a");
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(affected.find((x) => x.profile.id === "b")!.newRole).toBe(null);
  });

  it("reports a downgrade rather than a removal", async () => {
    let { storage, mgr } = makeManager();
    // b has build via a, but also use directly from the owner. Removing a downgrades b to use.
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    let affected = await mgr.previewRemoveCollaborator(owner, "a");
    let b = affected.find((x) => x.profile.id === "b")!;
    expect(b.oldRole).toBe("build");
    expect(b.newRole).toBe("use");
  });
});

describe("removeCollaborator", () => {
  it("severs the target's access and lets dependents go dark, but retains records", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = await mgr.removeCollaborator(owner, "a", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // Records are NOT deleted under the lazy model.
    expect(storage.collaborators.get("a")).toBeDefined();
    expect(storage.collaborators.get("b")).toBeDefined();
    // But neither has access anymore.
    expect(await mgr.getEffectiveRole("a")).toBeUndefined();
    expect(await mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("owner severs ALL incoming edges to the target", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // t is reachable via both the owner and a.
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    await mgr.removeCollaborator(owner, "t", []);
    expect(storage.collaborators.get("t")!.addedBy).toEqual([]);
    expect(await mgr.getEffectiveRole("t")).toBeUndefined();
  });

  it("re-adding a removed intermediary restores their downstream shares (undo)", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // a has shared with five users.
    for (let i = 0; i < 5; i++) seedCollaborator(storage, `d${i}`, [userEdge("a")]);

    await mgr.removeCollaborator(owner, "a", []);
    expect(await mgr.getEffectiveRole("a")).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(await mgr.getEffectiveRole(`d${i}`)).toBeUndefined();

    // Undo by re-adding a; the five downstream grants were never deleted.
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(await mgr.getEffectiveRole("a")).toBe("build");
    for (let i = 0; i < 5; i++) expect(await mgr.getEffectiveRole(`d${i}`)).toBe("build");
  });

  it("re-roots a kept dependent under the caller", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = await mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]); // b is kept, so not reported
    expect(await mgr.getEffectiveRole("b")).toBe("build");
    // b gained a fresh edge from the caller.
    expect(storage.collaborators.get("b")!.addedBy).toContainEqual(
      expect.objectContaining({ type: "user", sharer: OWNER, role: "build" }),
    );
  });

  it("keeps a downgraded user at their prior role when kept", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = await mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);
    expect(await mgr.getEffectiveRole("b")).toBe("build");
  });

  it("downgrades a non-kept user instead of removing them", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = await mgr.removeCollaborator(owner, "a", []);
    expect(affected.map((x) => x.profile.id).toSorted()).toEqual(["a", "b"]);
    expect(affected.find((x) => x.profile.id === "b")!.newRole).toBe("use");
    // b retains access at the lower role; its (now-inert) edge from a is left untouched (lazy).
    expect(await mgr.getEffectiveRole("b")).toBe("use");
    expect(storage.collaborators.get("b")!.addedBy).toHaveLength(2);
  });

  it("does not prune now-inert edges from surviving collaborators (lazy)", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // c is supported by the owner directly, but also carries an edge from a.
    seedCollaborator(storage, "c", [userEdge(OWNER), userEdge("a")]);

    await mgr.removeCollaborator(owner, "a", []);
    // c keeps full access; the inert edge from a remains in storage.
    expect(await mgr.getEffectiveRole("c")).toBe("build");
    expect(storage.collaborators.get("c")!.addedBy).toHaveLength(2);
  });

  it("lets a non-owner remove only their own edge, sparing the target if others remain", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    let affected = await mgr.removeCollaborator(collab("a"), "t", []);
    expect(affected).toEqual([]);
    expect(storage.collaborators.get("t")!.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER }),
    ]);
  });

  it("forbids a non-owner from removing a user they didn't add", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "t", [userEdge(OWNER)]);
    await expect(mgr.removeCollaborator(collab("a"), "t", [])).rejects.toThrow(/only remove users/);
  });

  it("throws when the target is not a collaborator", async () => {
    let { mgr } = makeManager();
    await expect(mgr.removeCollaborator(owner, "ghost", [])).rejects.toThrow(/not a collaborator/);
  });
});

describe("revokeShareLink", () => {
  it("soft-revokes the link and cuts off users supported only by it", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = await mgr.revokeShareLink(owner, "k1", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // The link record is retained but marked revoked.
    expect(link(storage, "k1").revoked).toBe(true);
    expect(await mgr.getEffectiveRole("a")).toBeUndefined();
    expect(await mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("does not cascade-revoke links created by cut-off users (lazy)", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedLink(storage, "k2", "a"); // link created by a
    seedCollaborator(storage, "b", [keyEdge("k2")]);

    await mgr.revokeShareLink(owner, "k1", []);
    // k2 is left untouched, but b is unreachable because a (k2's creator) is unreachable.
    expect(link(storage, "k2").revoked).toBeFalsy();
    expect(await mgr.getEffectiveRole("b")).toBeUndefined();

    // Undo: re-add a, and b regains access through k2.
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(await mgr.getEffectiveRole("b")).toBe("build");
  });

  it("a revoked link's keys can no longer be redeemed", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;

    await mgr.revokeShareLink(owner, linkId, []);

    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from revoking a link they didn't create", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    await expect(mgr.revokeShareLink(collab("a"), "k1", [])).rejects.toThrow(/only revoke/);
  });
});

describe("createShareLink", () => {
  it("persists the granted role", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "use" });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    let records = mgr.listShareLinkRecords();
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("use");
    // The caller is told which link it created, so it never has to infer it from the list.
    expect(linkId).toBe(records[0].id);
  });

  it("forbids creating a link with a higher role than the caller's own", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    await expect(mgr.createShareLink({ caller: collab("a"), role: "build" })).rejects.toThrow(
      /higher than your own/,
    );
  });
});

describe("newShareLinkKey", () => {
  it("mints a new key for the same link that redeems to one grant", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1 } = await mgr.createShareLink({ caller: owner, role: "use", note: "team" });
    let linkId = mgr.listShareLinkRecords()[0].id;

    let { key: key2 } = await mgr.newShareLinkKey({ caller: owner, linkId });
    expect(key2).not.toBe(key1);

    // Two secret records, one logical link: listing still shows a single entry, and the new
    // secret inherits the link's note/role.
    expect([...storage.shareKeys.list()]).toHaveLength(2);
    let listed = mgr.listShareLinkRecords();
    expect(listed).toHaveLength(1);
    expect(listed[0].role).toBe("use");
    expect(listed[0].note).toBe("team");

    // Both secrets redeem, and a user redeeming both gets a single (deduplicated) edge.
    await mgr.redeemShareKey({
      rawKey: key1,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await mgr.redeemShareKey({
      rawKey: key2,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(await mgr.getEffectiveRole("a")).toBe("use");
  });

  it("revoking a link revokes every key minted for it", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1 } = await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;
    let { key: key2 } = await mgr.newShareLinkKey({ caller: owner, linkId });

    await mgr.revokeShareLink(owner, linkId, []);
    expect(link(storage, linkId).revoked).toBe(true);
    // The copies are reclaimed; the link row stays, since edges point at it.
    expect([...storage.shareKeys.list()].map((r) => r.id)).toEqual([linkId]);

    // Neither the original nor the copied secret can be redeemed anymore.
    for (let rawKey of [key1, key2]) {
      await mgr.redeemShareKey({ rawKey, profileId: "a", fetchProfile: async () => profile("a") });
    }
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from copying a link they didn't create", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" })).rejects.toThrow(
      /only copy/,
    );
  });

  it("forbids copying a link that now grants a higher role than the caller's own", async () => {
    let { storage, mgr } = makeManager();
    // "a" created a build link, then was downgraded to use.
    seedLink(storage, "k1", "a", "build");
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" })).rejects.toThrow(
      /higher than your own/,
    );
  });

  it("cannot manage a link through the id of one of its copies", async () => {
    let { storage, mgr } = makeManager();
    await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;
    await mgr.newShareLinkKey({ caller: owner, linkId });

    // A copy has its own hash in the same table. Mistaking one for a link would make revocation a
    // silent no-op: redemption resolves the copy through to the link, which would go untouched.
    let aliasId = [...storage.shareKeys.list()].find((r) => r.alias !== undefined)!.id;
    expect(mgr.listShareLinkRecords().map((r) => r.id)).toEqual([linkId]);
    await expect(mgr.newShareLinkKey({ caller: owner, linkId: aliasId })).rejects.toThrow(
      /not found/,
    );
    expect(() => mgr.updateShareLink(owner, aliasId, "x")).toThrow(/not found/);
    await expect(mgr.revokeShareLink(owner, aliasId, [])).rejects.toThrow(/not found/);
  });
});

describe("pre-copy share keys", () => {
  it("reads a key written before link copies existed as a link", async () => {
    let { storage, mgr } = makeManager();
    // A key written before copies existed already has the shape of a link, and its edges already
    // point at the hash, so it reads back as a link with no migration.
    storage.shareKeys.put({
      id: "hash1",
      note: "team",
      created: new Date("2025-01-01"),
      createdBy: OWNER,
      role: "use",
    });
    seedCollaborator(storage, "a", [keyEdge("hash1", "use")]);

    expect(mgr.listShareLinkRecords()).toMatchObject([
      { id: "hash1", note: "team", createdBy: OWNER, role: "use" },
    ]);
    expect(await mgr.getEffectiveRole("a")).toBe("use");

    // Such a link can also be copied, and the copy grants the same access.
    let { key } = await mgr.newShareLinkKey({ caller: owner, linkId: "hash1" });
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "b",
      fetchProfile: async () => profile("b"),
    });
    expect(await mgr.getEffectiveRole("b")).toBe("use");
  });
});

describe("listCollaborators", () => {
  it("includes each collaborator's effective role", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use")]);
    let list = await mgr.listCollaborators();
    expect(list.find((x) => x.profile.id === "a")!.role).toBe("build");
    expect(list.find((x) => x.profile.id === "b")!.role).toBe("use");
  });

  it("omits collaborators who linger in storage but are unreachable", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "dead", []); // record with no incoming edges
    let list = await mgr.listCollaborators();
    expect(ids(list)).toEqual(["a"]);
  });
});

describe("listShareLinkRecords", () => {
  it("omits revoked links", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    storage.shareKeys.put({ id: "k2", created: new Date(), createdBy: OWNER, revoked: true });
    expect(mgr.listShareLinkRecords().map((r) => r.id)).toEqual(["k1"]);
  });
});

describe("updateShareLink", () => {
  it("owner can edit any link's note", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", "a");
    mgr.updateShareLink(owner, "k1", "renamed");
    expect(link(storage, "k1").note).toBe("renamed");
  });

  it("non-owner cannot edit a link they didn't create", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    expect(() => mgr.updateShareLink(collab("a"), "k1", "x")).toThrow(/only edit/);
  });
});

describe("ownerInvitesOnly", () => {
  it("refuses to create or copy share links", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    flags.ownerInvitesOnly = true;

    await expect(mgr.createShareLink({ caller: owner, role: "use" })).rejects.toThrow(
      /Share links are disabled/,
    );
    await expect(mgr.newShareLinkKey({ caller: owner, linkId: "k1" })).rejects.toThrow(
      /Share links are disabled/,
    );
    expect([...storage.shareKeys.list()].map((r) => r.id)).toEqual(["k1"]);

    // Link management isn't an open() failure, so it carries no open-gadget code.
    let error = await mgr.createShareLink({ caller: owner, role: "use" }).catch((e) => e);
    expect(getOpenGadgetErrorCode(error)).toBeUndefined();
  });

  it("persists nothing when the flag flips while a key is being minted", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);

    // Both calls park in #mintKey's await, and check the flag only once it resolves.
    let created = mgr.createShareLink({ caller: owner, role: "use" });
    let copied = mgr.newShareLinkKey({ caller: owner, linkId: "k1" });
    flags.ownerInvitesOnly = true;

    await expect(created).rejects.toThrow(/Share links are disabled/);
    await expect(copied).rejects.toThrow(/Share links are disabled/);
    expect([...storage.shareKeys.list()].map((r) => r.id)).toEqual(["k1"]);
  });

  it("refuses a new user redeeming a link created before ownerInvitesOnly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    flags.ownerInvitesOnly = true;

    let fetched = 0;
    await expect(
      mgr.redeemShareKey({
        rawKey: key,
        profileId: "newbie",
        fetchProfile: async () => {
          fetched++;
          return profile("newbie");
        },
      }),
    ).rejects.toMatchObject({
      code: OPEN_GADGET_ERROR_CODES.shareLinksDisabled,
      message: expect.stringMatching(/Share links are disabled/),
    });

    // Refused before the profile RPC.
    expect(fetched).toBe(0);
    expect(storage.collaborators.get("newbie")).toBeUndefined();
  });

  it("persists nothing when the flag flips during the profile fetch", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    await expect(
      mgr.redeemShareKey({
        rawKey: key,
        profileId: "newbie",
        fetchProfile: async () => {
          flags.ownerInvitesOnly = true;
          return profile("newbie");
        },
      }),
    ).rejects.toMatchObject({ code: OPEN_GADGET_ERROR_CODES.shareLinksDisabled });
    expect(storage.collaborators.get("newbie")).toBeUndefined();
  });

  it("lets a direct collaborator reopen a link without adding an edge", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    flags.ownerInvitesOnly = true;

    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    // No new grant: still just the owner's edge, at its original role.
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER }),
    ]);
    expect(await mgr.getEffectiveRole("a")).toBe("use");
  });

  it("refuses an existing collaborator the owner did not add directly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [keyEdge(linkId)]);
    flags.ownerInvitesOnly = true;

    await expect(
      mgr.redeemShareKey({
        rawKey: key,
        profileId: "a",
        fetchProfile: async () => profile("a"),
      }),
    ).rejects.toMatchObject({ code: OPEN_GADGET_ERROR_CODES.shareLinksDisabled });
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId }),
    ]);
  });

  it("still ignores an unknown key", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    flags.ownerInvitesOnly = true;
    await mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff",
      profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("lets only the owner add collaborators", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    flags.ownerInvitesOnly = true;

    await expect(
      mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "use" }),
    ).rejects.toThrow(/Only the workspace owner/);
    expect(storage.collaborators.get("b")).toBeUndefined();

    await mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "use" });
    expect(await mgr.getEffectiveRole("b")).toBe("use");
  });

  it("keeps link management available to the owner", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1"), userEdge(OWNER, "use")]);
    flags.ownerInvitesOnly = true;

    expect(mgr.listShareLinkRecords().map((r) => r.id)).toEqual(["k1"]);
    mgr.updateShareLink(owner, "k1", "renamed");
    // The link already grants nothing, so revoking it changes nobody's access.
    expect(await mgr.revokeShareLink(owner, "k1", [])).toEqual([]);
    expect(await mgr.getEffectiveRole("a")).toBe("use");
    expect(ids(await mgr.removeCollaborator(owner, "a", []))).toEqual(["a"]);
  });

  it("counts only direct owner grants", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "direct", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "linked", [keyEdge("k1")]);
    seedCollaborator(storage, "transitive", [userEdge("direct", "build")]);
    let baseline = mgr.computeEffectiveRoles();
    expect(ids(await mgr.listCollaborators())).toEqual(["direct", "linked", "transitive"]);

    flags.ownerInvitesOnly = true;

    expect(await mgr.getEffectiveRole("direct")).toBe("build");
    expect(await mgr.getEffectiveRole("linked")).toBeUndefined();
    expect(await mgr.getEffectiveRole("transitive")).toBeUndefined();
    expect(ids(await mgr.listCollaborators())).toEqual(["direct"]);
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("linked"), oldRole: "build", newRole: null }),
      expect.objectContaining({ profile: profile("transitive"), oldRole: "build", newRole: null }),
    ]);
  });

  it("counts a user the owner kept during a removal as direct", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);

    // Removing a while keeping b re-roots b on an edge from the owner.
    await mgr.removeCollaborator(owner, "a", ["b"]);
    flags.ownerInvitesOnly = true;

    expect(await mgr.getEffectiveRole("b")).toBe("use");
  });

  it("downgrades a collaborator to their owner edge's role", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    let baseline = mgr.computeEffectiveRoles();
    expect(baseline.get("b")).toBe("build");

    flags.ownerInvitesOnly = true;

    expect(await mgr.getEffectiveRole("b")).toBe("use");
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("b"), oldRole: "build", newRole: "use" }),
    ]);
  });

  it("re-adding an intermediary restores nobody else", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);

    await mgr.removeCollaborator(owner, "a", []);
    expect(await mgr.getEffectiveRole("b")).toBeUndefined();
    flags.ownerInvitesOnly = true;

    // Without the flag, re-adding a would bring b back through a's untouched edge. Once it is set,
    // only the owner's direct grants count, so b stays out until the owner adds them directly.
    await mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(await mgr.getEffectiveRole("a")).toBe("build");
    expect(await mgr.getEffectiveRole("b")).toBeUndefined();

    await mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "use" });
    expect(await mgr.getEffectiveRole("b")).toBe("use");
  });
});

describe("org-owned workspaces", () => {
  it("seeds each active member at the role their org role grants", async () => {
    let { mgr } = makeOrgManager({ orgOwner: "owner", admin: "admin", member: "member" });
    expect(await mgr.getEffectiveRole("orgOwner")).toBe("build");
    expect(await mgr.getEffectiveRole("admin")).toBe("build");
    expect(await mgr.getEffectiveRole("member")).toBe("use");
    expect(await mgr.getEffectiveRole("outsider")).toBeUndefined();
  });

  it("ends a removed member's access lazily, on the next read", async () => {
    let { snapshot, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    expect(await mgr.getEffectiveRole("member")).toBe("use");
    snapshot.delete("member");
    expect(await mgr.getEffectiveRole("member")).toBeUndefined();
  });

  it("narrows a demoted admin to use", async () => {
    let { snapshot, mgr } = makeOrgManager({ admin: "admin" });
    expect(await mgr.getEffectiveRole("admin")).toBe("build");
    snapshot.set("admin", "member");
    expect(await mgr.getEffectiveRole("admin")).toBe("use");
  });

  it("leaves a user-owned workspace unchanged when the resolver returns null", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    expect(await mgr.getEffectiveRole(OWNER)).toBe("build");
    expect(await mgr.getEffectiveRole("a")).toBe("build");
  });

  it("roots the graph at the org, not the former user owner", async () => {
    let { storage, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    // The former user owner is not a member: their stored edges grant nothing, and they hold
    // no access of their own.
    seedCollaborator(storage, "friend", [userEdge(OWNER, "build")]);
    expect(await mgr.getEffectiveRole(OWNER)).toBeUndefined();
    expect(await mgr.getEffectiveRole("friend")).toBeUndefined();
    // A member's edge still extends access on top of the baselines.
    seedCollaborator(storage, "pal", [userEdge("admin", "build")]);
    expect(await mgr.getEffectiveRole("pal")).toBe("build");
  });

  it("bounds a member's grant by their use baseline", async () => {
    let { mgr } = makeOrgManager({ member: "member" });
    await expect(mgr.addCollaborator(
        { caller: collab("member"), profile: profile("pal"), role: "build" }))
        .rejects.toThrow(/higher than your own/);
  });

  it("denies the former user owner sharing authority when they are not a member", async () => {
    let { mgr } = makeOrgManager({ member: "member" });
    await expect(mgr.addCollaborator({ caller: owner, profile: profile("pal"), role: "use" }))
        .rejects.toThrow(/do not have permission to share/);
  });

  it("lets an org admin remove a collaborator with owner authority", async () => {
    let { storage, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    seedCollaborator(storage, "hanger-on", [userEdge("member", "use")]);
    let affected =
        await mgr.removeCollaborator({ profileId: "admin", isOwner: true }, "hanger-on", []);
    expect(ids(affected)).toEqual(["hanger-on"]);
    expect(await mgr.getEffectiveRole("hanger-on")).toBeUndefined();
    expect(await mgr.getEffectiveRole("member")).toBe("use");
  });

  it("counts build-baseline members' edges as owner grants once ownerInvitesOnly is set", async () => {
    let { storage, snapshot, flags, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    seedCollaborator(storage, "pal", [userEdge("admin", "build")]);
    seedCollaborator(storage, "chum", [userEdge("member", "build")]);
    let baseline = mgr.computeEffectiveRoles({ orgRoles: snapshot });
    expect(baseline.get("pal")).toBe("build");
    expect(baseline.get("chum")).toBe("use");

    flags.ownerInvitesOnly = true;

    // The admin's direct grant counts as an owner grant; the member's does not.
    expect(await mgr.getEffectiveRole("admin")).toBe("build");
    expect(await mgr.getEffectiveRole("pal")).toBe("build");
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline, snapshot)).toEqual([
      expect.objectContaining({ profile: profile("chum"), oldRole: "use" }),
    ]);

    // An admin's demotion ends the grants they authored, lazily, like any baseline drop.
    snapshot.set("admin", "member");
    expect(await mgr.getEffectiveRole("admin")).toBe("use");
    expect(await mgr.getEffectiveRole("pal")).toBeUndefined();
  });

  it("under ownerInvitesOnly, only build-baseline members may add, and their adds count", async () => {
    let { snapshot, flags, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    flags.ownerInvitesOnly = true;

    // A plain member is refused even holding the session's owner flag: the gate reads the org's
    // live snapshot, the same authority the graph will count the grant against.
    await expect(mgr.addCollaborator(
        { caller: { profileId: "member", isOwner: true }, profile: profile("pal"), role: "use" }))
        .rejects.toThrow(/Only the workspace owner can add people/);

    // An admin's add takes effect, and the returned role is the effective one.
    let added = await mgr.addCollaborator(
        { caller: { profileId: "admin", isOwner: true }, profile: profile("pal"), role: "use" });
    expect(added.role).toBe("use");
    expect(await mgr.getEffectiveRole("pal")).toBe("use");

    // A since-demoted admin (stale session authority, fresh snapshot) is refused too.
    snapshot.set("admin", "member");
    await expect(mgr.addCollaborator(
        { caller: { profileId: "admin", isOwner: true }, profile: profile("mate"), role: "use" }))
        .rejects.toThrow(/Only the workspace owner can add people/);
  });

  it("refuses to remove a member whose access is their baseline alone", async () => {
    let { storage, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    // A use edge on top of a use baseline: severing it would change nothing, so refuse.
    seedCollaborator(storage, "member", [userEdge("admin", "use")]);
    await expect(mgr.removeCollaborator({ profileId: "admin", isOwner: true }, "member", []))
        .rejects.toThrow(/organization's membership/);

    // A build edge lifts the member above their baseline: severing downgrades them to it.
    seedCollaborator(storage, "member", [userEdge("admin", "build")]);
    let affected = await mgr.removeCollaborator(
        { profileId: "admin", isOwner: true }, "member", []);
    expect(affected).toEqual([
      expect.objectContaining(
          { profile: profile("member"), oldRole: "build", newRole: "use" }),
    ]);
    expect(await mgr.getEffectiveRole("member")).toBe("use");
  });

  it("lets a member redeem a share link on top of their baseline", async () => {
    let { mgr } = makeOrgManager({ admin: "admin", member: "member" });
    let { key } = await mgr.createShareLink(
        { caller: { profileId: "admin", isOwner: true }, role: "build" });
    expect(await mgr.getEffectiveRole("member")).toBe("use");

    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "member",
      fetchProfile: async () => profile("member"),
    });

    expect(await mgr.getEffectiveRole("member")).toBe("build");
  });
});
