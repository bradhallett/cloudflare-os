// The one organization membership policy. An org's Durable Object answers `OrgAccess` from its
// own `members` collection; every reader of membership — the AuthenticatedApi org methods, and
// the org-scoped surfaces later issues build on them — interprets it here. Mirrors
// gatekeeper-context's collection-access.ts, including its owner protection: an operation that
// would leave the org with no owner is refused (the org goes on ownerless only if the last owner's
// account is ever deleted out from under it, which no API here does).

import type { OrgInvitePolicy, OrgMemberStatus, OrgRole } from "@gadgets/workshop-shared/api";

/** Roles ranked low to high; a member may never act above, or grant a role above, their own. */
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/** One user's standing on one org, as recorded by the org itself. */
export type OrgAccess = {
  /** False for an id no org was ever created under. */
  exists: boolean;
  /** The user's role, or null when they are not a member (invited or otherwise). */
  role: OrgRole | null;
  /** The user's membership status, or null when they are not a member. */
  status: OrgMemberStatus | null;
  /** How many members currently hold the owner role. */
  ownerCount: number;
  invitePolicy: OrgInvitePolicy;
};

/** Whether the user's membership is a standing one: they belong to the org. */
export function isActingMember(access: OrgAccess): boolean {
  return access.exists && access.role !== null && access.status === "active";
}

/** Whether the user may read the org's member list. */
export function canViewMembers(access: OrgAccess): boolean {
  return isActingMember(access);
}

/**
 * The roles the user may grant in an invitation, or null when they may not invite: owners invite
 * at any role, admins at admin or below, and a plain member only under the `member` invite policy
 * — and then only as a member. Nobody ever grants a role above their own.
 */
export function invitableView(access: OrgAccess): OrgRole[] | null {
  if (!isActingMember(access)) return null;
  if (access.role === "owner") return ["owner", "admin", "member"];
  if (access.role === "admin") return ["admin", "member"];
  return access.invitePolicy === "member" ? ["member"] : null;
}

/** Whether the user may change members' roles (which is also how ownership is handed over). */
export function canManageRoles(access: OrgAccess): boolean {
  return isActingMember(access) && access.role === "owner";
}

/**
 * Whether the user may update the org's settings. Owners only.
 */
export function canUpdateSettings(access: OrgAccess): boolean {
  return isActingMember(access) && access.role === "owner";
}

/**
 * Whether the user may remove the member holding `targetRole` (never the target's own last-owner
 * protection — see wouldLoseLastOwner). Owners remove anyone, admins remove members, and an
 * ordinary member removes only themself, which is what leaveOrg() does.
 */
export function canRemoveMember(access: OrgAccess, targetRole: OrgRole): boolean {
  if (!isActingMember(access) || access.role === null) return false;
  return ROLE_RANK[access.role] > ROLE_RANK[targetRole];
}

/**
 * Whether removing or demoting the member holding `targetRole` would leave the org with no owner.
 * The sole owner cannot be demoted, removed, or leave; anyone else can.
 */
export function wouldLoseLastOwner(access: OrgAccess, targetRole: OrgRole): boolean {
  return targetRole === "owner" && access.ownerCount <= 1;
}
