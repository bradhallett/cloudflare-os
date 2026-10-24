import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { SharingManager, SharingStorage } from "../src/sharing.js";
import type {
  AiChatAuthorInfo, CollaboratorRole, OrgRole, PermissionEdge,
} from "@gadgets/workshop-shared/api";
import type { CollaboratorRecord, ShareKeyRecord } from "../src/storage-schema/overseer-storage.js";
import { makeMockStorage } from "./mock-storage.js";

// Removal semantics on org-owned workspaces: the org-membership refusal must fire only for a
// target whose access actually rests on their org baseline, never for a non-member whose parallel
// user edges merely look redundant.

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

// A manager for a workspace owned by the org with the given members (userId → org role), mirroring
// sharing.test.ts's makeOrgManager: the map models a live membership snapshot.
function makeOrgManager(members: Record<string, OrgRole>) {
  let snapshot = new Map(Object.entries(members));
  let storage = makeStorage();
  return {
    storage,
    snapshot,
    mgr: new SharingManager(storage, "owner@example.com", () => false, async () => snapshot),
  };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

function userEdge(sharer: string, role: CollaboratorRole): PermissionEdge {
  return { type: "user", sharer, created: new Date(), role };
}

function seedCollaborator(storage: SharingStorage, id: string, addedBy: PermissionEdge[]) {
  storage.collaborators.put({ profile: profile(id), addedBy });
}

describe("removeCollaborator on org-owned workspaces", () => {
  it("lets a non-owner sever their own redundant edge to a non-member", async () => {
    let { storage, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    // A non-member target holding two parallel user edges: one from the admin (owner authority,
    // build) and one from a member (use). Severing the member's edge changes nothing about the
    // target's access, but the target holds no org baseline, so the refusal must not fire -- the
    // sharer can always retract their own grant.
    seedCollaborator(storage, "pal", [
      userEdge("admin", "build"),
      userEdge("member", "use"),
    ]);
    let affected = await mgr.removeCollaborator(
        { profileId: "member", isOwner: false }, "pal", []);
    expect(affected).toEqual([]);
    expect(await mgr.getEffectiveRole("pal")).toBe("build");

    // The admin's edge still stands: an owner-style removal now removes the non-member outright.
    let gone = await mgr.removeCollaborator(
        { profileId: "admin", isOwner: true }, "pal", []);
    expect(gone.map((x) => x.profile.id)).toEqual(["pal"]);
    expect(await mgr.getEffectiveRole("pal")).toBeUndefined();
  });

  it("still refuses for a member whose access is their baseline alone", async () => {
    let { storage, mgr } = makeOrgManager({ admin: "admin", member: "member" });
    seedCollaborator(storage, "member", [userEdge("admin", "use")]);
    await expect(mgr.removeCollaborator(
        { profileId: "admin", isOwner: true }, "member", []))
        .rejects.toThrow(/organization's membership/);
  });
});
