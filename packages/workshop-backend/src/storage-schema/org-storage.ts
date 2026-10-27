// The Org Durable Object's storage schema: `makeOrgStorage()` and the record types it stores.
//
// Everything an organization persists is declared in this one file, so that a change to the stored
// shape of an org shows up as a change here. See overseer-storage.ts for the conventions. The
// `members` collection is the sole authority on membership (org-access.ts interprets it); each
// member's user DO keeps a mirrored index entry for discovery (UserDurableObject
// .syncOrgMembership), which every org read re-checks live.

import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { OrgInvitePolicy, OrgMember } from "@gadgets/workshop-shared/api";

/**
 * The organization itself: set once by `OrgDurableObject.initializeOrg()` and immutable after.
 * `id` is the random id the org was created under, which is also the DO's name.
 */
export type OrgRecord = {
  id: string;
  name: string;
  createdAt: Date;
};

/** Settings the org's owners may change. See `OrgInvitePolicy` in the shared API. */
export type OrgSettings = {
  invitePolicy: OrgInvitePolicy;
};

/**
 * A pending invitation, keyed by invitee. Deleted on acceptance or revocation; an invitation past
 * `expiresAt` is unacceptable and swept lazily (with the `invited` member record it shadows).
 */
export type OrgInvitationRecord = {
  inviteeId: string;
  role: OrgMember["role"];
  invitedBy: string;
  invitedAt: Date;
  expiresAt: Date;
};

/**
 * A workspace the org owns, keyed by the Overseer DO's id. The org's only record of it:
 * membership changes fan out to these workspaces so a removed or demoted member's live session
 * is severed, while each workspace's own sharing graph stays the authority on access (it
 * re-checks membership live at every open). Entries survive only from the removed org-transfer
 * flow; removed when a workspace is deleted.
 */
export type OrgOwnedGadgetRecord = {
  gadgetId: string;
};
/** Builds the org storage schema over one org Durable Object's storage. */
export function makeOrgStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // The org's memberships, keyed by the member's canonical user id. A record with
      // status "invited" shadows its pending invitation in `invitations`.
      members: collection<OrgMember>()({
        primaryKey: "userId",
        nonUniqueIndexes: {
          byRole(member: OrgMember) { return member.role; },
        },
      }),
      invitations: collection<OrgInvitationRecord>()({
        primaryKey: "inviteeId",
      }),
      // The org's owned workspaces, keyed by their Overseer DO id. Only historic entries remain
      // (the transfer flow is gone); removed when a workspace is deleted.
      ownedGadgets: collection<OrgOwnedGadgetRecord>()({
        primaryKey: "gadgetId",
      }),
    },
    singletons: {
      // The org record: null until initializeOrg() runs, and never null after.
      org: <OrgRecord | null>null,
      settings: <OrgSettings>{
        invitePolicy: "admin",
      },
    },
  });
}

