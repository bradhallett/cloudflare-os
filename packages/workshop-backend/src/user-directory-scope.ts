import type { GatekeeperOrgMembership } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability.js";
import type { UserStorage } from "./storage-schema/user-storage.js";

const logger = createWorkshopLogger("workshop.user");

/**
 * The caller's user-directory scope: who they may find with `searchUsers()` and pick with a
 * gatekeeper user-selection ticket. One entry per org that still holds the caller as an active
 * member (re-checked live through the org's own member listing, so a stale index entry or a
 * removed membership yields no entry), naming that org's active member ids; `partnerIds` adds the
 * owners of workspaces shared with the caller, the explicit share relationships that outlive org
 * boundaries. Together these are the whole searchable set — nobody outside them is discoverable.
 */
export type UserDirectoryScope = {
  orgs: { orgId: string; memberIds: string[] }[];
  partnerIds: string[];
};

/**
 * The user's standing in the deployment's people directory: the profile mirror (sync), the
 * mirrored org-membership index read live against the org authority (scope, fresh
 * memberships), the explicit share partnerships, and the picker-justification re-check.
 * Extracted from UserDurableObject so the directory product area owns its storage slices;
 * the DO keeps the picker-ticket orchestration (pendingUserSelections) that consumes the
 * justification verdicts.
 */
export class UserDirectoryScopeStore {
  #ctx: DurableObjectState;
  #storage: Pick<UserStorage, "orgMemberships" | "gadgets" | "profile" | "profileRev" | "directoryRev">;

  constructor(ctx: DurableObjectState,
      storage: Pick<UserStorage, "orgMemberships" | "gadgets" | "profile" | "profileRev" | "directoryRev">) {
    this.#ctx = ctx;
    this.#storage = storage;
  }

  /**
   * Mirror the profile into the deployment-wide user directory. Best-effort and does not block
   * the caller. The `syncUser` call opens this DO's input gate, so a rename can start a second
   * sync while one is in flight, and the two can reach the directory in either order. Each sync
   * carries its `profileRev` and the directory keeps the highest, so no ordering is needed
   * here. The revision counter only increases, and a failed sync leaves it behind so the next
   * authentication retries.
   */
  sync(): void {
    const rev = this.#storage.profileRev.get();
    if (rev === this.#storage.directoryRev.get()) return;
    const profile = this.#storage.profile.get();
    this.#ctx.exports.UserDirectoryDurableObject.getByName("")
        .syncUser({ id: profile.id, name: profile.name }, rev)
        .then(() => {
          if (rev > this.#storage.directoryRev.get()) this.#storage.directoryRev.put(rev);
        }, (error: unknown) => {
          logger.warn("failed to sync user directory record", {
            event: "user.directory.sync.failed",
            error,
          });
        });
  }

  /**
   * The caller's directory scope (see `UserDirectoryScope`), as `searchUsers` and the gatekeeper
   * user picker compute it. The user's mirrored membership index names the orgs; each org's own
   * member listing — an actor-checked read, so it re-checks this membership live — names the
   * people. An org that cannot be read (the index is stale, the membership ended, or the read
   * failed) contributes nothing: the scope fails closed, so an unreachable org can only shrink
   * discovery, never widen it.
   */
  async scope(): Promise<UserDirectoryScope> {
    const me = this.#storage.profile.get().id;
    const orgs = await Promise.allSettled([...this.#storage.orgMemberships.list()].map(
        async (entry): Promise<UserDirectoryScope["orgs"][number]> => ({
          orgId: entry.orgId,
          memberIds: (await this.#ctx.exports.OrgDurableObject.getByName(entry.orgId)
              .listMembersFor(me))
              .filter(member => member.status === "active")
              .map(member => member.userId),
        })));
    return {
      orgs: orgs.flatMap(result => result.status === "fulfilled" ? [result.value] : []),
      partnerIds: [...this.#sharePartnerIds()],
    };
  }

  /**
   * The user's organization memberships read afresh from each org, as the Workshop reports them
   * to gatekeepers (GatekeeperOrgMembership): the mirrored index names the orgs and each org
   * answers for the user live — describeForMember returns null once a membership has ended, so
   * a stale index entry or an unreadable org contributes nothing (fail-closed, like scope).
   * Only active memberships are reported: a pending invitation grants nothing yet, and neither
   * may an org-keyed grant it would justify.
   */
  async freshOrgMemberships(): Promise<GatekeeperOrgMembership[]> {
    const me = this.#storage.profile.get().id;
    const orgs = await Promise.allSettled([...this.#storage.orgMemberships.list()].map(
        async entry => await this.#ctx.exports.OrgDurableObject.getByName(entry.orgId)
            .describeForMember(me)));
    return orgs.flatMap(result => {
      const org = result.status === "fulfilled" ? result.value : null;
      return org !== null && org.status === "active" ? [{ orgId: org.id, role: org.role }] : [];
    });
  }

  /**
   * Whether a pending selection's recorded justification still holds. Org-justified tickets name
   * their orgs (`orgIds`); each is asked, as the authority on its own membership, whether the
   * selector and the selected are still active members — one surviving org suffices. A ticket
   * without orgs was justified by a workspace share, which must still be recorded here. Tickets
   * minted before org scoping recorded no orgIds and read as share-justified.
   */
  async stillJustified(
      record: { orgIds?: string[]; selectedUserId: string },
  ): Promise<boolean> {
    let orgIds = record.orgIds ?? [];
    if (orgIds.length === 0) return this.#sharePartnerIds().has(record.selectedUserId);
    let me = this.#storage.profile.get().id;
    for (let orgId of orgIds) {
      let org = this.#ctx.exports.OrgDurableObject.getByName(orgId);
      let [mine, theirs] = await Promise.all([
        org.getMember(me), org.getMember(record.selectedUserId)]);
      if (mine?.status === "active" && theirs?.status === "active") return true;
    }
    return false;
  }

  /**
   * The ids of people this user already holds an explicit share relationship with: the owners of
   * workspaces shared with them, as their own object records from opening each share. (The
   * converse — collaborators on workspaces this user owns — lives in those workspaces' Overseers,
   * not here, and org scoping of sharing graphs tracks it in later issues.) A dismissed share
   * drops its record, and with it the partnership.
   */
  #sharePartnerIds(): Set<string> {
    const partners = new Set<string>();
    for (const gadget of this.#storage.gadgets.list()) {
      if (gadget.owner) partners.add(gadget.owner.id);
    }
    return partners;
  }
}
