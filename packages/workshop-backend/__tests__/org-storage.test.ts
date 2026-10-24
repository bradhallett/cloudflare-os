// The Org Durable Object's storage schema over mock storage: record round-trips, defaults, the
// byRole index, and deletion — the same pattern the action-log suites use for overseer storage.

import { describe, expect, it } from "vitest";
import type { OrgMember } from "@gadgets/workshop-shared/api";
import {
  makeOrgStorage, type OrgInvitationRecord, type OrgRecord,
} from "../src/storage-schema/org-storage";
import { makeMockStorage } from "./mock-storage";

// A member record as the DO writes one, with every field the wire type carries.
function member(overrides: Partial<OrgMember> = {}): OrgMember {
  return {
    userId: "alice@example.com",
    role: "owner",
    status: "active",
    invitedBy: null,
    invitedAt: new Date(1_700_000_000_000),
    joinedAt: new Date(1_700_000_000_000),
    ...overrides,
  };
}

// An invitation as inviteMember writes one.
function invitation(inviteeId: string, overrides: Partial<OrgInvitationRecord> = {})
    : OrgInvitationRecord {
  return {
    inviteeId,
    role: "member",
    invitedBy: "alice@example.com",
    invitedAt: new Date(1_700_000_000_000),
    expiresAt: new Date(1_700_060_400_000),
    ...overrides,
  };
}

describe("org storage", () => {
  it("starts with no org and the default admin invite policy", () => {
    const storage = makeOrgStorage(makeMockStorage());
    expect(storage.org.get()).toBeNull();
    expect(storage.settings.get()).toEqual({ invitePolicy: "admin" });
    expect([...storage.members.list()]).toEqual([]);
    expect([...storage.invitations.list()]).toEqual([]);
  });

  it("round-trips the org record and a settings change through the storage boundary", () => {
    const mock = makeMockStorage();
    const storage = makeOrgStorage(mock);
    const org: OrgRecord = {
      id: "0123456789abcdef0123456789abcdef",
      name: "Acme",
      createdAt: new Date(1_700_000_000_000),
    };
    storage.org.put(org);
    storage.settings.put({ invitePolicy: "member" });

    // A fresh view over the same bytes reads what was written, dates included.
    const reread = makeOrgStorage(mock);
    expect(reread.org.get()).toEqual(org);
    expect(reread.settings.get()).toEqual({ invitePolicy: "member" });
    // A different storage sees none of it.
    expect(makeOrgStorage(makeMockStorage()).org.get()).toBeNull();
  });

  it("stores members keyed by user id, listed in key order", () => {
    const storage = makeOrgStorage(makeMockStorage());
    storage.members.put(member({ userId: "carol@example.com", role: "member", status: "invited" }));
    storage.members.put(member());
    storage.members.put(member({ userId: "bob@example.com", role: "admin" }));

    expect([...storage.members.list()].map(m => m.userId)).toEqual([
      "alice@example.com", "bob@example.com", "carol@example.com",
    ]);
    expect(storage.members.get("bob@example.com")!.role).toBe("admin");
  });

  it("holds isolated membership records per org: the same user, two storages, two roles", () => {
    const org1 = makeOrgStorage(makeMockStorage());
    const org2 = makeOrgStorage(makeMockStorage());
    org1.members.put(member({ userId: "alice@example.com" }));
    org2.members.put(member({ userId: "alice@example.com", role: "member" }));

    expect(org1.members.get("alice@example.com")!.role).toBe("owner");
    expect(org2.members.get("alice@example.com")!.role).toBe("member");
  });

  it("indexes members by role", () => {
    const storage = makeOrgStorage(makeMockStorage());
    storage.members.put(member());
    storage.members.put(member({ userId: "bob@example.com", role: "admin" }));
    storage.members.put(member({ userId: "carol@example.com", role: "admin" }));

    expect([...storage.members.byRole.get("owner")].map(m => m.userId))
        .toEqual(["alice@example.com"]);
    expect([...storage.members.byRole.get("admin")].map(m => m.userId))
        .toEqual(["bob@example.com", "carol@example.com"]);
    expect([...storage.members.byRole.get("member")]).toEqual([]);

    storage.members.delete("bob@example.com");
    expect([...storage.members.byRole.get("admin")].map(m => m.userId))
        .toEqual(["carol@example.com"]);
  });

  it("round-trips and deletes invitations keyed by invitee", () => {
    const storage = makeOrgStorage(makeMockStorage());
    storage.invitations.put(invitation("bob@example.com"));

    expect(storage.invitations.get("bob@example.com")).toEqual(invitation("bob@example.com"));
    expect(storage.invitations.get("carol@example.com")).toBeUndefined();

    storage.invitations.delete("bob@example.com");
    expect(storage.invitations.get("bob@example.com")).toBeUndefined();
    expect([...storage.invitations.list()]).toEqual([]);
  });

  it("re-putting a member replaces the record in one entry", () => {
    const storage = makeOrgStorage(makeMockStorage());
    storage.members.put(member({ userId: "bob@example.com", role: "member", status: "invited" }));
    storage.members.put(member({ userId: "bob@example.com", role: "admin", status: "invited" }));

    const listed = [...storage.members.list()];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ userId: "bob@example.com", role: "admin" });
  });
});
