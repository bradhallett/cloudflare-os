// The one collection access policy. A collection's Durable Object answers `CollectionAccess` for an
// account from its own grants; every reader of access — management API, agent reads, catalogs, and
// observer verification — interprets it here.

import type {
  ContextCollectionPermissions, ContextCollectionRole, ContextCollectionVisibility,
} from "./context-types.js";
import type { GatekeeperOrgMembership, GatekeeperOrgRole } from "@gadgets/workshop-shared/gatekeeper";

/** One account's standing on one collection, as recorded by the collection itself. */
export type CollectionAccess = {
  /** False for an ID no collection was ever initialized under, or one since deleted. */
  exists: boolean;
  visibility: ContextCollectionVisibility;
  /**
   * The account's effective role on a private collection: its own grant's role, or the strongest
   * role an org grant confers on one of its orgs (see `orgGrantRole`). Always null on a public one.
   */
  role: ContextCollectionRole | null;
  /**
   * Whether the account may govern this collection through an org: it holds `owner`/`admin` in an
   * org that owns the collection. Governance grants `canManageOwners`/`canDelete` (and sharing)
   * beyond the account's own role, mirroring how the Workshop maps org roles to management.
   */
  manager: boolean;
  everyoneCanView: boolean;
  /** Whether any grant — account or org — is `owner`. Only meaningful for private collections. */
  hasOwner: boolean;
  /** Whether anyone besides this account can read it: another grant, or everyone-viewable. */
  shared: boolean;
};

/** Whether the account may read every document in the collection. */
export function canReadCollection(access: CollectionAccess): boolean {
  if (!access.exists) return false;
  if (access.visibility === "public") return true;
  return access.role !== null || access.everyoneCanView;
}

/**
 * What the account may do. Public collections keep their rule: editable and deletable by admins.
 * Private collection roles retain their permissions even after the last owner disconnects. An org
 * manager (`access.manager`) may share, manage owners, and delete like an owner.
 */
export function collectionPermissions(
    access: CollectionAccess, isAdmin: boolean): ContextCollectionPermissions {
  if (!access.exists) {
    return { canEdit: false, canShare: false, canManageOwners: false, canDelete: false };
  }
  if (access.visibility === "public") {
    return { canEdit: isAdmin, canShare: false, canManageOwners: false, canDelete: isAdmin };
  }
  let isOwner = access.role === "owner";
  let canEdit = isOwner || access.role === "editor";
  return {
    canEdit,
    canShare: canEdit || access.manager,
    canManageOwners: isOwner || access.manager,
    canDelete: isOwner || access.manager,
  };
}

/**
 * The collection role an org grant confers on a plain member of the org: the grant's own role for
 * `viewer` and `editor`; an `owner` grant makes the *org* the owner, whose members use the
 * collection as editors — management of an org-owned collection belongs to the org's own admins
 * (see `governsOrgGrants`), not to every member.
 */
export function orgGrantRole(grantRole: ContextCollectionRole): ContextCollectionRole {
  return grantRole === "owner" ? "editor" : grantRole;
}

/** Whether an org role may govern collections its org owns, mirroring the Workshop's org model. */
export function governsOrgGrant(orgRole: GatekeeperOrgRole): boolean {
  return orgRole === "owner" || orgRole === "admin";
}

/**
 * The role an org grant gives one account, from that account's live memberships: the grant's
 * member role if the account belongs to the org, else null. The caller folds several orgs'
 * answers together with the account's own grant.
 */
export function orgGrantFor(
    grant: { orgId: string; role: ContextCollectionRole },
    memberships: readonly GatekeeperOrgMembership[]): ContextCollectionRole | null {
  return memberships.some(membership => membership.orgId === grant.orgId)
    ? orgGrantRole(grant.role)
    : null;
}
