// The organization Durable Object: the tenant primitive (see docs/tenancy.md). One instance per
// org, named by the org's random id. It owns the org's record, settings, members, and
// invitations; the `members` collection is the sole authority on membership, interpreted only by
// org-access.ts. Every membership change is mirrored into the affected member's user DO
// (UserDurableObject.syncOrgMembership) so a user can list their orgs in one read of their own
// object — that index is discovery only, and every org read re-checks membership live, which is
// also the lazy-revocation contract for the org-scoped surfaces built on this in later issues:
// they hold org-derived access without eagerly cascading a removal, and re-check `getMember()`
// (or the actor-checked reads below) when access matters.

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createWorkshopLogger, type WorkshopLogger } from "./observability";
import {
  MAX_ORG_NAME_LENGTH, type OrgCommerceMember, type OrgMember, type OrgMemberStatus,
  type OrgRole, type OrgSummary, createPlanRefusalError,
} from "@gadgets/workshop-shared/api";
import {
  canManageOrgAssets, canManageRoles, canRemoveMember, canUpdateSettings, canViewMembers,
  gadgetBaselineRole, isActiveMember, invitableView, wouldLoseLastOwner, type OrgAccess,
} from "./org-access";
import { makeOrgStorage, type OrgRecord, type OrgSettings } from "./storage-schema/org-storage";
import { refuseUnverifiableWorkspaceCap, resolveEntitlements, workspaceCapFrom } from "./entitlements.js";
import { notifyOrgMembersChanged } from "./commerce.js";

const logger = createWorkshopLogger("workshop.org");

/** How long an invitation stays acceptable after it is issued or refreshed. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Org Durable Object. Reached by the authenticated API (server.ts) and, once org-scoped
 * resources exist, by the surfaces that lazily re-check membership. All permission checks happen
 * here against the org's own records, never in a caller.
 */
@validateRpc()
export class OrgDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeOrgStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeOrgStorage(ctx.storage);
  }

  /** The org record, or a thrown error for an id no org was created under. */
  #org(): OrgRecord {
    const org = this.storage.org.get();
    if (org === null) throw new Error("No such organization.");
    return org;
  }

  /**
   * This org's logger: the `workshop.org` component with the org's id folded in
   * (`logger.with({orgId})`, the org observability convention), so every event names its org
   * without each call site saying so. Before `initializeOrg` creates the record there is no id
   * yet, and events carry none.
   */
  get #log(): WorkshopLogger {
    const org = this.storage.org.get();
    return org === null ? logger : logger.with({ orgId: org.id });
  }

  /**
   * This org's access answer for `userId` (see org-access.ts). The owner count is computed here,
   * once, so every owner-protection check sees the same rule: only *active* owners count, since a
   * pending (or expired-but-unswept) invited owner can still decline or be swept, and counting
   * them would let the sole active owner leave or demote themself against a phantom second owner.
   */
  #accessFor(userId: string): OrgAccess {
    const member = this.storage.members.get(userId);
    return {
      exists: true,
      role: member?.role ?? null,
      status: member?.status ?? null,
      ownerCount: [...this.storage.members.byRole.get("owner")]
          .filter((m) => m.status === "active").length,
      invitePolicy: this.storage.settings.get().invitePolicy,
    };
  }

  #summaryFor(org: OrgRecord, settings: OrgSettings, member: OrgMember): OrgSummary {
    return {
      id: org.id,
      name: org.name,
      invitePolicy: settings.invitePolicy,
      role: member.role,
      status: member.status,
    };
  }

  /**
   * Deletes every expired invitation together with the `invited` member record shadowing it, and
   * mirrors the removal to each swept member. Invitations are swept lazily — here, at the start of
   * the reads and mutations that care — rather than from an alarm, because an expired invitation
   * is already unacceptable (acceptInvitation re-checks `expiresAt`).
   *
   * A swept invitation releases the seat it had claimed (membership, so seat count, is pushed to
   * commerce only from here — the port has no pull API), so anything swept also re-syncs.
   */
  async #sweepExpiredInvitations(): Promise<void> {
    const now = Date.now();
    // The snapshot is materialized because the loop awaits (the mirror) mid-iteration, and a
    // second kv.list() (however triggered) would invalidate a still-live iterator.
    const expired = [...this.storage.invitations.list()];
    let sweptAny = false;
    for (const invitation of expired) {
      if (invitation.expiresAt.getTime() > now) continue;
      this.storage.invitations.delete(invitation.inviteeId);
      this.storage.members.delete(invitation.inviteeId);
      this.#log.debug("swept an expired org invitation", {
        event: "org.invitation.expired",
      });
      await this.#mirror(invitation.inviteeId, null);
      sweptAny = true;
    }
    if (sweptAny) this.#syncCommerceMembers();
  }

  /**
   * Report `userId`'s membership into their user DO's index. Best-effort: the index only drives
   * listMyOrgs, which re-checks each org live, so a lost or late mirror costs staleness, not
   * authority. Awaited inline so a mutation does not return before its own mirror is sent, but
   * the input gate opens while the cross-DO call is in flight, so a concurrent mutation's mirror
   * can still arrive first — reordering is narrowed, not guaranteed.
   */
  async #mirror(
      userId: string,
      membership: { role: OrgRole; status: OrgMemberStatus } | null,
  ): Promise<void> {
    try {
      await this.ctx.exports.UserDurableObject.getByName(userId)
          .syncOrgMembership(this.#org().id, membership);
    } catch (error) {
      this.#log.warn("failed to mirror org membership into user object", {
        event: "org.membership.mirror.failed",
        error,
      });
    }
  }

  /**
   * Create the org under this DO's already-chosen id, with `creatorUserId` as its first owner and
   * only member. The name is trimmed, and must be non-empty and at most MAX_ORG_NAME_LENGTH
   * characters. Throws if this id was already initialized (a fresh random id makes that a
   * shall-never-happen, but it is refused rather than silently re-created).
   */
  async initializeOrg(name: string, creatorUserId: string): Promise<OrgSummary> {
    if (this.storage.org.get() !== null) {
      throw new Error("This organization id is already in use.");
    }
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > MAX_ORG_NAME_LENGTH) {
      throw new Error(
          `An organization name must be 1 to ${MAX_ORG_NAME_LENGTH} characters.`);
    }
    const now = new Date();
    const org: OrgRecord = { id: this.ctx.id.name!, name: trimmed, createdAt: now };
    this.storage.org.put(org);
    const member: OrgMember = {
      userId: creatorUserId,
      role: "owner",
      status: "active",
      invitedBy: null,
      invitedAt: now,
      joinedAt: now,
    };
    this.storage.members.put(member);
    this.#log.info("created an organization", { event: "org.created" });
    await this.#mirror(creatorUserId, { role: member.role, status: member.status });
    this.#syncCommerceMembers();
    return this.#summaryFor(org, this.storage.settings.get(), member);
  }

  /**
   * The org as `userId` sees it, or null when they are not a member (or no org exists under this
   * id, which is how listMyOrgs drops stale index entries). An expired pending invitation reads
   * as null: it is swept on the way in.
   */
  async describeForMember(userId: string): Promise<OrgSummary | null> {
    await this.#sweepExpiredInvitations();
    const org = this.storage.org.get();
    const member = this.storage.members.get(userId);
    if (org === null || member === undefined) return null;
    return this.#summaryFor(org, this.storage.settings.get(), member);
  }

  /**
   * One user's membership of this org, or null — the authority read behind every org-derived
   * access. The lazy-revocation hook for org-scoped surfaces (later issues): they never cascade a
   * removal; they call this when access matters, so a removed member's access ends at the next
   * check.
   */
  async getMember(userId: string): Promise<OrgMember | null> {
    return this.storage.members.get(userId) ?? null;
  }

  /**
   * The org's active members — the live membership snapshot behind an org-owned workspace's
   * sharing graph (see sharing.ts), which baselines each member's access at their org role and
   * re-reads this at every open. An authority read like getMember(), so it takes no actor: only
   * this worker's own code can reach it. Pending invitees are excluded; their access never
   * starts.
   */
  async activeMembers(): Promise<OrgMember[]> {
    this.#org();
    return [...this.storage.members.list()].filter(m => m.status === "active");
  }

  /**
   * Every membership of the org — pending invitations included — sorted by user id. Only an
   * active member may read the list.
   */
  async listMembersFor(actorId: string): Promise<OrgMember[]> {
    this.#org();
    if (!canViewMembers(this.#accessFor(actorId))) {
      throw new Error("Only a member of this organization may list its members.");
    }
    await this.#sweepExpiredInvitations();
    return [...this.storage.members.list()];
  }

  /**
   * Invite `inviteeId` at `role` (default "member"). Creates an invitation, or refreshes a
   * pending one to the new role and a new expiry. The invitee need not have signed in yet; an
   * already-active member cannot be invited. Permission and the grantable roles come from
   * org-access.ts: the actor must be allowed to invite under the org's policy and can never
   * grant a role above their own.
   */
  async inviteMember(
      actorId: string, inviteeId: string, role: OrgRole = "member",
  ): Promise<OrgMember> {
    this.#org();
    await this.#sweepExpiredInvitations();
    const invitee = inviteeId.trim();
    if (invitee === "") throw new Error("The invited user id must not be empty.");
    if (invitee === actorId) throw new Error("You are already in this organization.");
    const view = invitableView(this.#accessFor(actorId));
    if (view === null) {
      throw new Error("You may not invite members to this organization.");
    }
    if (!view.includes(role)) {
      throw new Error("You may not grant a role above your own.");
    }
    const existing = this.storage.members.get(invitee);
    if (existing !== undefined && existing.status === "active") {
      throw new Error("That person is already a member of this organization.");
    }
    const now = new Date();
    const member: OrgMember = {
      userId: invitee,
      role,
      status: "invited",
      invitedBy: actorId,
      invitedAt: now,
      joinedAt: null,
    };
    this.storage.members.put(member);
    this.storage.invitations.put({
      inviteeId: invitee,
      role,
      invitedBy: actorId,
      invitedAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    });
    this.#log.info("invited an org member", { event: "org.member.invited", orgRole: role });
    await this.#mirror(invitee, { role: member.role, status: member.status });
    this.#syncCommerceMembers();
    return member;
  }

  /**
   * `userId` accepts their pending invitation: the membership becomes active. Throws when there
   * is no pending invitation for them, or it has expired (an expired one is swept, so it cannot
   * be accepted by racing the sweep).
   */
  async acceptInvitation(userId: string): Promise<OrgSummary> {
    const org = this.#org();
    const invitation = this.storage.invitations.get(userId);
    const member = this.storage.members.get(userId);
    if (invitation === undefined || member === undefined || member.status !== "invited") {
      throw new Error("You have no pending invitation to this organization.");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      this.storage.invitations.delete(userId);
      this.storage.members.delete(userId);
      await this.#mirror(userId, null);
      // The invitee's seat was claimed at invite time; releasing the member record must release
      // it at commerce too (see #sweepExpiredInvitations).
      this.#syncCommerceMembers();
      throw new Error("That invitation has expired.");
    }
    const joined: OrgMember = { ...member, status: "active", joinedAt: new Date() };
    this.storage.members.put(joined);
    this.storage.invitations.delete(userId);
    this.#log.info("an org member joined", {
      event: "org.member.joined", orgRole: joined.role,
    });
    await this.#mirror(userId, { role: joined.role, status: joined.status });
    this.#syncCommerceMembers();
    return this.#summaryFor(org, this.storage.settings.get(), joined);
  }

  /**
   * Change the member `userId`'s role (also how ownership is handed over). Owners only; refused
   * when it would leave the org with no owner. A pending invitation's granted role changes the
   * same way.
   */
  async changeMemberRole(actorId: string, userId: string, role: OrgRole): Promise<OrgMember> {
    this.#org();
    if (!canManageRoles(this.#accessFor(actorId))) {
      throw new Error("Only an owner may change roles in this organization.");
    }
    const member = this.storage.members.get(userId);
    if (member === undefined) throw new Error("No such member.");
    // Only a standing owner can be the last owner: demoting a *pending* owner invitation's
    // granted role never trips the protection, because the invitee was never an active owner.
    if (isActiveMember(member) && wouldLoseLastOwner(this.#accessFor(actorId), member.role) && role !== "owner") {
      throw new Error(
          "An organization must keep at least one owner; hand ownership over first.");
    }
    const changed: OrgMember = { ...member, role };
    this.storage.members.put(changed);
    const invitation = this.storage.invitations.get(userId);
    if (invitation !== undefined) this.storage.invitations.put({ ...invitation, role });
    this.#log.info("changed an org member's role", {
      event: "org.member.role_changed", orgRole: role,
    });
    await this.#mirror(userId, { role: changed.role, status: changed.status });
    // A demotion to member narrows the member's baseline on every org-owned workspace; sever
    // their live sessions there so the next open re-checks at the lower role. Promotions and
    // owner/admin swaps never narrow (both baseline at build), so they disturb nothing.
    if (gadgetBaselineRole(role) === "use" && gadgetBaselineRole(member.role) === "build") {
      await this.#severOwnedGadgetSessions();
    }
    this.#syncCommerceMembers();
    return changed;
  }

  /**
   * Remove the membership of `userId`, revoking a pending invitation if that is what it is.
   * Owners remove anyone, admins remove members, and a member removes only themself — removing
   * yourself is exactly memberLeave(). Refused when it would leave the org with no owner.
   */
  async removeMember(actorId: string, userId: string): Promise<void> {
    this.#org();
    if (actorId === userId) return this.memberLeave(userId);
    const member = this.storage.members.get(userId);
    if (member === undefined) throw new Error("No such member.");
    if (!canRemoveMember(this.#accessFor(actorId), member.role)) {
      throw new Error("You may not remove that member.");
    }
    if (isActiveMember(member) && wouldLoseLastOwner(this.#accessFor(actorId), member.role)) {
      throw new Error(
          "An organization must keep at least one owner; hand ownership over first.");
    }
    this.#deleteMember(member);
    this.#log.info("removed an org member", { event: "org.member.removed" });
    await this.#mirror(userId, null);
    await this.#severOwnedGadgetSessions();
    this.#syncCommerceMembers();
  }

  /**
   * `userId` leaves the org, dropping a pending invitation with them. Refused for a sole owner,
   * who must first hand ownership over.
   */
  async memberLeave(userId: string): Promise<void> {
    this.#org();
    const member = this.storage.members.get(userId);
    if (member === undefined) throw new Error("You are not a member of this organization.");
    // A pending invitation is never the last owner being protected above: an invited owner can
    // always decline, even while the org has exactly one active owner.
    if (isActiveMember(member) && wouldLoseLastOwner(this.#accessFor(userId), member.role)) {
      throw new Error(
          "An organization must keep at least one owner; hand ownership over first.");
    }
    this.#deleteMember(member);
    this.#log.info("an org member left", { event: "org.member.left" });
    await this.#mirror(userId, null);
    await this.#severOwnedGadgetSessions();
    this.#syncCommerceMembers();
  }

  /**
   * Pushes the org's whole membership snapshot (pending invitations included) to the bound
   * commerce service, fire-and-forget, after every membership change: the service claims and
   * releases the org's subscription seats from it — an invited member claims their seat
   * immediately — and keeps its org records in step. A no-op with no service bound; a dropped
   * push is healed by the service's own reconciliation, the same contract as the usage-events
   * seam. Called with storage already final, so the snapshot is exactly what changed.
   */
  #syncCommerceMembers(): void {
    const org = this.storage.org.get();
    if (org === null) return;
    const members: OrgCommerceMember[] = [...this.storage.members.list()].map(member => ({
      userId: member.userId, role: member.role, status: member.status,
    }));
    notifyOrgMembersChanged(this.env, org.id, org.name, members);
  }

  #deleteMember(member: OrgMember): void {
    this.storage.members.delete(member.userId);
    this.storage.invitations.delete(member.userId);
  }

  /**
   * Record that the org owns the workspace `gadgetId` (an Overseer DO id): `Overseer.transferToOrg`
   * calls this before writing its own owner subject (register-first, so no window exists where
   * the org records a workspace the UserDO does not). The actor must be an active owner/admin of
   * org (org-access.ts), checked here rather than in the caller. Idempotent per workspace: a
   * retried transfer refreshes the record rather than duplicating it.
   *
   * `transferringUserId` (the workspace's user owner, passed by transferToOrg) applies the plan's
   * workspace cap to the org's own count: this transfer is the moment a workspace *becomes*
   * org-owned, so it is where an org-wide cap is enforced (a user's own creations are capped in
   * their UserDurableObject instead). The cap is read from the transferring user's plan — the
   * entitlements port answers per user, and a SaaS that models orgs as tenants gives every member
   * the same number. Refused, like any other failure here, before any write: the workspace stays
   * exactly as it was.
   */
  async addOwnedGadget(
      actorId: string, gadgetId: string, transferringUserId?: string): Promise<void> {
    this.#org();
    if (!canManageOrgAssets(this.#accessFor(actorId))) {
      throw new Error("Only an owner or admin of this organization may transfer workspaces into it.");
    }
    if (transferringUserId !== undefined) {
      // The cap is folded from the answer once (see workspaceCapFrom): "unavailable" — a bound
      // plan service that failed — refuses the transfer, as the personal-creation cap does (see
      // UserDurableObject.newGadget); "unbound" is unlimited.
      let gate = workspaceCapFrom(await resolveEntitlements(this.env, transferringUserId));
      refuseUnverifiableWorkspaceCap(gate, "transferred");
      if (gate.status === "capped") {
        // Count the org's owned workspaces, excluding this one: a retried transfer must not be
        // refused by the index entry its own crashed attempt left behind.
        let owned = [...this.storage.ownedGadgets.list()]
            .filter(gadget => gadget.gadgetId !== gadgetId).length;
        if (owned >= gate.cap) {
          throw createPlanRefusalError("WORKSPACE_CAP_REACHED",
              `This organization has reached its plan's limit of ${gate.cap} workspaces.`);
        }
      }
    }
    this.storage.ownedGadgets.put({ gadgetId });
    this.#log.info("a workspace was transferred into the org", {
      event: "org.gadget.transferred",
    });
  }

  /**
   * Drop a workspace from the org's index: its own Overseer calls this while deleting itself, so
   * it takes no actor (the workspace already authorized the deletion). Best-effort symmetry with
   * addOwnedGadget; a lost entry only means a future membership change notifies a dead DO.
   */
  async removeOwnedGadget(gadgetId: string): Promise<void> {
    this.#org();
    this.storage.ownedGadgets.delete(gadgetId);
    this.#log.info("a workspace left the org's index", {
      event: "org.gadget.unindexed",
    });
  }

  // Tell every org-owned workspace that a membership ended or narrowed, so each can sever live
  // sessions (the workspace's own sharing graph stays the authority and re-checks at every
  // open; the sever is role-counted, so it names no member). Best-effort and awaited inline,
  // like #mirror: an unreachable workspace costs a logged warning, and the membership change
  // itself never fails because of it.
  async #severOwnedGadgetSessions(): Promise<void> {
    for (const gadget of this.storage.ownedGadgets.list()) {
      try {
        await this.ctx.exports.OverseerDurableObject
            .get(this.ctx.exports.OverseerDurableObject.idFromString(gadget.gadgetId))
            .severOrgMemberSessions();
      } catch (error) {
        this.#log.warn("failed to notify an org-owned workspace of a membership change", {
          event: "org.gadget.membership.notify.failed",
          error,
        });
      }
    }
  }

  /**
   * Update the org's settings (see OrgInvitePolicy). Owners only. Returns the org as the actor
   * sees it.
   */
  async updateOrgSettings(
      actorId: string, settings: { invitePolicy: OrgSettings["invitePolicy"] },
  ): Promise<OrgSummary> {
    const org = this.#org();
    if (!canUpdateSettings(this.#accessFor(actorId))) {
      throw new Error("Only an owner may change this organization's settings.");
    }
    const updated: OrgSettings = { invitePolicy: settings.invitePolicy };
    this.storage.settings.put(updated);
    this.#log.info("updated org settings", { event: "org.settings.updated" });
    const member = this.storage.members.get(actorId)!;
    return this.#summaryFor(org, updated, member);
  }
}
