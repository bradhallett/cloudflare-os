// The organization grammar — roles, memberships, settings — and the org-management face of
// `AuthenticatedApi` (the org Durable Object in workshop-backend owns the authority behind
// those methods; these are the wire types both sides share). `api.ts` re-exports every name
// here, so importers of `@gadgets/workshop-shared/api` are unaffected by this module's
// existence; the `@gadgets/workshop-shared/orgs` subpath serves code that wants the org
// grammar without the API graph (e.g. typed log fields).

/**
 * A member's role in an organization. Owners manage roles and settings; admins manage members;
 * members belong to the org. An organization always keeps at least one owner.
 */
export type OrgRole = "owner" | "admin" | "member";

/** Whether a membership is standing (`active`) or still awaiting the invitee's acceptance. */
export type OrgMemberStatus = "active" | "invited";

/**
 * Who may invite new members: `admin` (the default) restricts invitations to owners and admins;
 * `member` additionally lets every active member invite, at the `member` role only.
 */
export type OrgInvitePolicy = "admin" | "member";

/** The longest organization name createOrg() accepts, after trimming. */
export const MAX_ORG_NAME_LENGTH = 100;

/**
 * One membership of an organization, as stored by the org itself and returned by
 * `AuthenticatedApi.getOrgMembers()`.
 */
export type OrgMember = {
  /**
   * Canonical user identifier of the member (email for Access / sign-in accounts, username for
   * password accounts). The invitee need not have signed in yet.
   */
  userId: string;
  role: OrgRole;
  status: OrgMemberStatus;
  /** The inviting member's user id, or null for the org's creating owner. */
  invitedBy: string | null;
  invitedAt: Date;
  /** When the member accepted their invitation; null while it is pending. */
  joinedAt: Date | null;
};

/**
 * An organization as one member sees it: its record and settings together with the caller's own
 * membership. Returned by every org method that acts for a particular member.
 */
export type OrgSummary = {
  /** The org's random id, also identifying it in API calls. */
  id: string;
  name: string;
  invitePolicy: OrgInvitePolicy;
  /** The caller's role in this org. */
  role: OrgRole;
  /** The caller's membership status in this org. */
  status: OrgMemberStatus;
};

/**
 * One of the signed-in user's organization memberships, as `whoami()` reports it. Read from the
 * user's mirrored membership index, so it is a snapshot for display: the org re-checks membership
 * live wherever it carries authority (search scoping, picker tickets, org methods). The role and
 * status are picked from `OrgMember` so the mirror cannot drift from the org's own grammar.
 */
export type OrgMembership = Pick<OrgMember, "role" | "status"> & {
  /** The org's random id, as in `OrgSummary.id`. */
  orgId: string;
};

/**
 * The org-management methods of `AuthenticatedApi`: creating organizations, managing
 * memberships and invitations, and org settings. Membership is re-checked against the live org
 * record on every call; the caller's mirrored index is display state, never authority.
 */
export interface OrgApiMethods {
  /**
   * Create an organization with the caller as its first owner and only member. The name is
   * trimmed, and must be non-empty and at most MAX_ORG_NAME_LENGTH characters.
   */
  createOrg(name: string): Promise<OrgSummary>;

  /**
   * The caller's organizations, one entry per membership (one person may be in many). Read from
   * the user's membership index and re-checked against each org, so an entry disappears once its
   * membership ends even if the index is briefly stale.
   */
  listMyOrgs(): Promise<OrgSummary[]>;

  /**
   * Every membership of one organization — pending invitations included — sorted by user id.
   * Only an active member of the org may call this.
   */
  getOrgMembers(orgId: string): Promise<OrgMember[]>;

  /**
   * Invite `userId` (a canonical user id; the person need not have signed in yet) to the org at
   * `role`, defaulting to "member". Creates — or, for a pending invitation to the same person,
   * refreshes — an invitation that stays acceptable for seven days. The caller must be an active
   * member allowed to invite by the org's invite policy, and may not grant a role above their
   * own. An already-active member cannot be invited.
   */
  inviteOrgMember(orgId: string, userId: string, role?: OrgRole): Promise<OrgMember>;

  /**
   * Accept the caller's pending invitation, making the membership active. Throws when there is
   * no pending invitation for the caller, or it has expired.
   */
  acceptOrgInvitation(orgId: string): Promise<OrgSummary>;

  /**
   * Change a member's role. Owners only, and the caller may not grant a role above their own.
   * Refused when it would leave the organization with no owner (the last owner cannot be
   * demoted).
   */
  changeOrgMemberRole(orgId: string, userId: string, role: OrgRole): Promise<OrgMember>;

  /**
   * Remove a membership, or revoke its pending invitation. Owners may remove anyone; admins may
   * remove members; a member may remove no one but themself (prefer leaveOrg). Refused when it
   * would leave the organization with no owner. Removing the caller themself is exactly
   * leaveOrg().
   */
  removeOrgMember(orgId: string, userId: string): Promise<void>;

  /**
   * The caller leaves the organization: their membership (or pending invitation) is removed.
   * Refused for a sole owner, who must first hand ownership to someone else.
   */
  leaveOrg(orgId: string): Promise<void>;

  /**
   * Update the org's settings (see OrgInvitePolicy). Owners only.
   */
  updateOrgSettings(
      orgId: string, settings: { invitePolicy: OrgInvitePolicy }): Promise<OrgSummary>;
}
