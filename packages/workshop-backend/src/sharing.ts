// Collaborator authorization, sharing, and permission-graph logic for a Gadget's Overseer.
//
// This module owns all manipulation of the `collaborators` and `shareKeys` storage collections
// and the permission graph that links them. It deliberately performs no RPC: anything that
// requires talking to a User DO (resolving a profile from a username, fetching the owner's
// profile, notifying a user that a gadget was opened, etc.) stays in the Overseer, which passes
// resolved values (or, where laziness matters, a callback) into this module.
//
// LAZY REVOCATION MODEL: Access is determined by reachability from the owner in the permission
// graph, recomputed live at every open() (see `getEffectiveRole`). Revocation is therefore lazy:
// removing a collaborator only severs the edges granting *them* access, and revoking a share link
// only flags the link revoked. Nothing cascades, no records are deleted, and downstream edges are
// never touched -- users who lose their only path to the owner simply become unreachable and are
// denied at open() time. Because the graph is never destructively pruned, revocation is reversible:
// re-adding a removed collaborator restores them and, transitively, everyone they had shared with
// (unless `ownerInvitesOnly` is set, when only the owner's direct grants count).
// (Records and revoked keys accumulate in storage; a future GC could reclaim long-dead entries.)
//
// ORG-OWNED WORKSPACES: a workspace transferred to an org (historic: the transfer flow is
// removed, but such workspaces keep rooting the same graph at the org) roots the same
// graph at the org instead of the user owner. Each active member starts at the role their org
// role grants (owners/admins "build", members "use" -- org-access.ts baselines), and stored edges
// still extend access transitively but only on top of those baselines, so removing someone from
// the org (or demoting them to member) simply drops their baseline and their access ends at the
// next open(), exactly like any other lazy revocation. The `ownerInvitesOnly` flag follows the
// same root: on an org-owned workspace the "owner" whose direct grants still count is any member
// at the build baseline (org owners/admins -- see #mayAuthorOwnerGrant), so a sensitive
// org-owned workspace stays sharable by its admins and closed to everyone else's grants.
//
// NOTE: The sensitive-data (`containsRestrictedData`) policy intentionally does NOT live here; the
// Overseer enforces it. This module only answers questions about the sharing graph. The one
// exception is the `ownerInvitesOnly` flag, which the Overseer supplies as a hook: once it is set,
// only direct grants from the workspace's owner authority count, so it narrows which edges
// `computeEffectiveRoles` follows and must be checked synchronously with each grant's storage write.

import { AiChatAuthorInfo, CollaboratorInfo, PermissionEdge, CollaboratorRole, AffectedCollaborator,
    createOpenGadgetError, OPEN_GADGET_ERROR_CODES, OrgRole } from "@gadgets/workshop-shared/api";
import { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import { gadgetBaselineRole } from "./org-access";
import type { CollaboratorRecord, ShareKeyRecord, ShareLinkRecord }
    from "./storage-schema/overseer-storage";

/**
 * Roles are totally ordered: build > use. Higher rank means strictly more access. Exported so
 * role comparisons elsewhere (e.g. the Overseer's `requireRole` floor) rank rather than
 * string-compare, which stays correct if a role is ever added between the two.
 */
export function roleRank(role: CollaboratorRole): number {
  return role === "build" ? 2 : 1;
}

// Edges and share keys created before roles were introduced lack a `role` field; treat them as
// "build" for backwards compatibility.
function edgeGrantedRole(edge: PermissionEdge): CollaboratorRole {
  return edge.role ?? "build";
}

function maxRole(a: CollaboratorRole, b: CollaboratorRole): CollaboratorRole {
  return roleRank(a) >= roleRank(b) ? a : b;
}

function minRole(a: CollaboratorRole, b: CollaboratorRole): CollaboratorRole {
  return roleRank(a) <= roleRank(b) ? a : b;
}

// Fixed 256-bit key used to domain-separate share key hashes from other hashes in the system.
// Not secret -- it only provides personalization.
const SHARE_KEY_HMAC_KEY = new Uint8Array([
  0x09, 0x2a, 0x64, 0x37, 0xae, 0x8a, 0xce, 0x43,
  0x03, 0x81, 0x17, 0xed, 0x5b, 0x0c, 0x4a, 0xca,
  0x82, 0x23, 0x41, 0x11, 0x0b, 0x28, 0x48, 0x8f,
  0x57, 0x53, 0x25, 0x2a, 0xda, 0xa0, 0xbf, 0xd7,
]);

// Compute the storage ID (HMAC-SHA-256 hex) for a raw share key. The raw key is never stored
// server-side; only this hash is.
async function hashShareKey(rawKey: string): Promise<string> {
  let hmacKey = await crypto.subtle.importKey(
      "raw", SHARE_KEY_HMAC_KEY, { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]);
  let sig = new Uint8Array(await crypto.subtle.sign(
      "HMAC", hmacKey, Uint8Array.fromHex(rawKey)));
  return sig.toHex();
}

/**
 * The slice of Overseer storage this module operates on. Satisfied by the real OverseerStorage
 * and easily constructed over a Map-backed mock DurableObjectStorage in tests.
 */
export interface SharingStorage {
  collaborators: Collection<CollaboratorRecord>;
  shareKeys: Collection<ShareKeyRecord> & {
    /** A link's copies, keyed by the link they alias. */
    byAlias: NonUniqueIndex<ShareKeyRecord, string>;
  };
}

// Narrow a key record to a link, or undefined if it's an alias.
function asLink(record: ShareKeyRecord | undefined): ShareLinkRecord | undefined {
  return record !== undefined && record.alias === undefined ? record : undefined;
}

/**
 * Per-session caller identity. Mirrors the fields the OverseerClientInterface holds for the
 * connected client.
 */
export interface SharingCaller {
  /** The caller's profile.id (username/email). */
  profileId: string;
  /**
   * True if the caller is the gadget owner. The owner can manage anyone's collaborator edges
   * and share keys; non-owners are restricted to edges/keys they created themselves.
   */
  isOwner: boolean;
}

export class SharingManager {
  /**
   * `ownerProfileId` is stable for the lifetime of a gadget, so it's supplied once at
   * construction rather than per call.
   *
   * `ownerInvitesOnly` reports the Overseer's `ownerInvitesOnly` flag (see
   * `ObservationDescription.ownerInvitesOnly`). `computeEffectiveRoles` reads it to count only
   * direct owner grants once it is set. Grants call it after their last await, right before the
   * storage write, so an observation that sets the flag mid-call cannot slip a grant through.
   *
   * `owningOrgRoles` returns the live membership snapshot of the org that owns this workspace
   * (member canonical user id → org role), or null while a user owns it. Supplied as a callback
   * so this module stays RPC-free (the Overseer talks to the org DO). Methods that authorize read
   * it first and thread the snapshot through the synchronous graph computation, so one open()
   * sees one consistent membership. A snapshot that is a map (even empty) means org-owned: the
   * graph roots at the org, not at `ownerProfileId`.
   */
  constructor(
      private storage: SharingStorage,
      private ownerProfileId: string,
      private ownerInvitesOnly: () => boolean,
      private owningOrgRoles: () => Promise<ReadonlyMap<string, OrgRole> | null>) {}

  // Throw if share links are disabled by `ownerInvitesOnly`. Redemption refusals surface
  // from open(), so they carry the `shareLinksDisabled` open-gadget code; link management throws
  // the same message uncoded.
  #requireShareLinksAllowed(opts?: { redeeming: boolean }): void {
    if (this.ownerInvitesOnly()) {
      let error = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.shareLinksDisabled);
      throw opts?.redeeming ? error : new Error(error.message);
    }
  }

  // Every share link, revoked or not. Aliases are skipped.
  *#listLinks(): Generator<ShareLinkRecord> {
    for (let record of this.storage.shareKeys.list()) {
      let link = asLink(record);
      if (link) yield link;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Authorization (used by Overseer.open())

  /**
   * True if `profileId` currently has a collaborator record. This only checks membership; use
   * `getEffectiveRole()` to determine the actual access level (and whether the record is still
   * reachable from the owner in the permission graph).
   */
  isCollaborator(profileId: string): boolean {
    return this.storage.collaborators.get(profileId) !== undefined;
  }

  /**
   * The effective role of `profileId` -- the maximum role reachable from the workspace's owner
   * through valid permission edges -- or undefined if the user has no access. The user owner
   * always has "build"; on an org-owned workspace they are instead subject to their org
   * membership like anyone else.
   *
   * Awaited membership: an org-owned workspace consults its owning org live (the constructor's
   * `owningOrgRoles` callback). Pass `orgRoles` to reuse a snapshot already fetched for the same
   * operation -- a Map for org-owned, null for user-owned -- so one authorization reads one
   * consistent membership.
   */
  async getEffectiveRole(
      profileId: string,
      orgRoles?: ReadonlyMap<string, OrgRole> | null): Promise<CollaboratorRole | undefined> {
    if (orgRoles === undefined) orgRoles = await this.owningOrgRoles();
    if (!orgRoles && profileId === this.ownerProfileId) return "build";
    return this.computeEffectiveRoles({ orgRoles }).get(profileId);
  }

  /**
   * Redeem a raw share key on behalf of a user opening the gadget. If the key exists, ensures the
   * user is a collaborator with a `shareKey` edge for its link (adding the edge if missing, or
   * creating the collaborator record if they're new). Does nothing if the key is unknown.
   *
   * The raw key is hashed internally; the plaintext is never stored. `fetchProfile` is invoked
   * (an RPC, in production) only when a brand-new collaborator must be created, so existing
   * collaborators are redeemed without any RPC.
   *
   * A key whose link is revoked behaves like an unknown key (it cannot be redeemed).
   *
   * If the workspace has `ownerInvitesOnly` set, a valid key adds nothing: a collaborator the
   * owner added directly is left as they are (so reopening an old link doesn't fail), and anyone
   * else -- including someone who joined through a link before the flag was set -- is refused with
   * a `shareLinksDisabled` exception.
   *
   * TODO: The edge is written before the redeeming open()'s observer verification runs, so a
   * recipient whose verification fails lingers in listCollaborators until removed or the link is
   * revoked.
   */
  async redeemShareKey(opts: {
    rawKey: string;
    profileId: string;
    fetchProfile: () => Promise<AiChatAuthorInfo>;
  }): Promise<void> {
    let hash = await hashShareKey(opts.rawKey);
    let keyRecord = this.storage.shareKeys.get(hash);
    if (!keyRecord) return;

    // Edges point at the link, not the individual key, so a link's keys collapse to one grant.
    // A copy of a link is an alias; follow it to the link that owns the metadata.
    let link = keyRecord.alias === undefined
        ? keyRecord : asLink(this.storage.shareKeys.get(keyRecord.alias));
    if (!link || link.revoked) return;
    let linkId = link.id;
    let role = link.role ?? "build";

    if (this.ownerInvitesOnly()) {
      // Only direct owner grants count (see computeEffectiveRoles), so the link can grant nothing.
      // Let someone who already has access through the owner re-open with it; refuse anyone else.
      if (!await this.getEffectiveRole(opts.profileId)) {
        this.#requireShareLinksAllowed({ redeeming: true });
      }
      return;
    }

    let existing = this.storage.collaborators.get(opts.profileId);
    if (existing) {
      // User is already a collaborator. Only add an edge if they don't already have one for this
      // link (redeeming a second key of the same link is a no-op).
      let alreadyHasEdge = existing.addedBy.some(
          e => e.type === "shareKey" && e.keyId === linkId);
      if (!alreadyHasEdge) {
        existing.addedBy.push({
          type: "shareKey",
          keyId: linkId,
          created: new Date(),
          role,
        });
        this.storage.collaborators.put(existing);
      }
    } else {
      // New collaborator -- need full profile from their user DO. The RPC may race an observation
      // setting ownerInvitesOnly, so check again right before the write.
      let profile = await opts.fetchProfile();
      this.#requireShareLinksAllowed({ redeeming: true });
      this.storage.collaborators.put({
        profile,
        addedBy: [{
          type: "shareKey",
          keyId: linkId,
          created: new Date(),
          role,
        }],
      });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Collaborator management

  /**
   * List currently-active collaborators -- those with a live path from the owner. Under the lazy
   * revocation model, removed collaborators linger in storage with no reachable role; they are
   * omitted here (they reappear if re-added).
   */
  async listCollaborators(): Promise<CollaboratorInfo[]> {
    let roles = this.computeEffectiveRoles({ orgRoles: await this.owningOrgRoles() });
    let result: CollaboratorInfo[] = [];
    for (let record of this.storage.collaborators.list()) {
      let role = roles.get(record.profile.id);
      if (!role) continue;  // not currently reachable from the owner
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        role,
      });
    }
    return result;
  }

  /**
   * Add a collaborator with a `user` edge from the caller, granting `role`. The caller is
   * responsible for resolving `profile` (via RPC) and for any policy checks. The caller may not
   * grant a role higher than their own effective role. Once `ownerInvitesOnly` is set, only a
   * holder of the workspace's owner authority may call this -- the user owner, or on an
   * org-owned workspace an org owner/admin whose baseline is still build (#mayAuthorOwnerGrant,
   * the same authors whose edges the graph then counts), so a stored grant always takes effect.
   */
  async addCollaborator(opts: {
    caller: SharingCaller;
    profile: AiChatAuthorInfo;
    role: CollaboratorRole;
    note?: string;
  }): Promise<CollaboratorInfo> {
    let orgRoles = await this.owningOrgRoles();
    // Don't add the owner as a collaborator (an org-owned workspace has no such user: the former
    // owner is an ordinary principal under the org).
    if (!orgRoles && opts.profile.id === this.ownerProfileId) {
      throw new Error("Cannot add the workspace owner as a collaborator.");
    }

    if (this.ownerInvitesOnly() &&
        !this.#mayAuthorOwnerGrant(opts.caller.profileId, orgRoles)) {
      throw new Error(
          "Only the workspace owner can add people to a workspace that contains sensitive data.");
    }

    let callerRole = this.#requireCallerRole(opts.caller, orgRoles);
    if (roleRank(opts.role) > roleRank(callerRole)) {
      throw new Error("You cannot grant a role higher than your own.");
    }

    let existing = this.storage.collaborators.get(opts.profile.id);
    let edge: PermissionEdge = {
      type: "user",
      sharer: opts.caller.profileId,
      created: new Date(),
      role: opts.role,
      note: opts.note,
    };

    if (existing) {
      // Already a collaborator -- add an edge if they don't have one from this sharer, otherwise
      // upgrade the existing edge's role (never silently downgrade).
      let existingEdge = existing.addedBy.find(
          e => e.type === "user" && e.sharer === opts.caller.profileId);
      if (existingEdge && existingEdge.type === "user") {
        existingEdge.role = maxRole(edgeGrantedRole(existingEdge), opts.role);
        if (opts.note !== undefined) existingEdge.note = opts.note;
      } else {
        existing.addedBy.push(edge);
      }
      this.storage.collaborators.put(existing);
      return {
        profile: existing.profile,
        addedBy: existing.addedBy,
        role: this.computeEffectiveRoles({ orgRoles }).get(existing.profile.id) ?? opts.role,
      };
    }

    let record: CollaboratorRecord = {
      profile: opts.profile,
      addedBy: [edge],
    };
    this.storage.collaborators.put(record);
    return {
      profile: record.profile,
      addedBy: record.addedBy,
      role: this.computeEffectiveRoles({ orgRoles }).get(record.profile.id) ?? opts.role,
    };
  }

  async previewRemoveCollaborator(
      caller: SharingCaller, profileId: string): Promise<AffectedCollaborator[]> {
    let target = this.storage.collaborators.get(profileId);
    if (!target) return [];

    let orgRoles = await this.owningOrgRoles();
    let baseline = this.computeEffectiveRoles({ orgRoles });
    let modified = caller.isOwner
        ? this.computeEffectiveRoles({ orgRoles, severedTarget: profileId })
        : this.computeEffectiveRoles({
            orgRoles, removedEdge: { target: profileId, sharer: caller.profileId } });

    return this.#computeAffected(baseline, modified);
  }

  /**
   * Remove a collaborator by severing the edges that grant them access. This is a *lazy* removal:
   * nothing cascades and no records are deleted. The target's record (and crucially, any edges
   * where the target is the *sharer* of access to others) is left intact, and dependents who lose
   * their only path to the owner simply become unreachable -- they are denied at open() time, not
   * pruned here. This makes the removal trivially reversible: re-adding the target (see
   * addCollaborator) restores the target and, transitively, everyone they had shared with.
   *
   *   - The owner severs *all* incoming edges to the target (owner-removal means "gone now").
   *   - A non-owner severs only their own `user` edge to the target; if the target retains other
   *     edges, they keep access (possibly at a lower role).
   *
   * `keepUsers` is optional re-root sugar: any listed dependent who would otherwise lose access or
   * be downgraded is granted a fresh edge from the caller at their prior role (see
   * `#reRootKeptUsers`). Returns the collaborators whose access actually changed (removed or
   * downgraded), excluding kept users.
   *
   * On an org-owned workspace this refuses, with a pointer at the org, when the target is an org
   * member whose access would not change: their baseline survives any edge severance, so a plain
   * collaborator whose only role is their org role must be removed from the org, not from this
   * list. A non-member's parallel user edges are still severable normally, even when redundant.
   */
  async removeCollaborator(
      caller: SharingCaller, profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let orgRoles = await this.owningOrgRoles();
    let target = this.storage.collaborators.get(profileId);
    if (!target) {
      throw new Error("User is not a collaborator.");
    }

    // Permission check: owner can remove anyone; collaborators can only remove users
    // they themselves added.
    if (!caller.isOwner) {
      let hasEdgeFromCaller = target.addedBy.some(
          e => e.type === "user" && e.sharer === caller.profileId);
      if (!hasEdgeFromCaller) {
        throw new Error("You can only remove users that you added.");
      }
    }

    let baseline = this.computeEffectiveRoles({ orgRoles });

    // The role the target keeps once the chosen edges are severed (both hypotheticals match the
    // severance below exactly).
    let kept = this.computeEffectiveRoles(caller.isOwner
        ? { orgRoles, severedTarget: profileId }
        : { orgRoles, removedEdge: { target: profileId, sharer: caller.profileId } })
        .get(profileId);
    let had = baseline.get(profileId);
    if (orgRoles?.has(profileId) && kept !== undefined && had !== undefined
        && roleRank(kept) >= roleRank(had)) {
      throw new Error(
          "That person's access comes from their organization's membership; remove them from the organization instead.");
    }

    // Sever the edges that grant the target access. The record is retained even if it becomes
    // empty, so the target's own outgoing grants survive and the removal can be undone.
    if (caller.isOwner) {
      target.addedBy = [];
    } else {
      target.addedBy = target.addedBy.filter(
          e => !(e.type === "user" && e.sharer === caller.profileId));
    }
    this.storage.collaborators.put(target);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers), orgRoles);

    return this.#computeAffected(baseline, this.computeEffectiveRoles({ orgRoles }));
  }

  // ---------------------------------------------------------------------------------------
  // Share link management

  // Enforce that `caller` may manage `link`: the owner can manage any link; a collaborator only
  // the links they created. `action` is the user-facing verb (e.g. "revoke", "edit", "copy").
  #requireLinkManager(caller: SharingCaller, link: ShareLinkRecord, action: string): void {
    if (!caller.isOwner && link.createdBy !== caller.profileId) {
      throw new Error(`You can only ${action} share links that you created.`);
    }
  }

  // Look up a link by id, throwing the caller-facing error if the id is unknown or names an alias..
  #requireLink(linkId: string): ShareLinkRecord {
    let link = asLink(this.storage.shareKeys.get(linkId));
    if (!link) {
      throw new Error("Share link not found.");
    }
    return link;
  }

  async createShareLink(
      opts: { caller: SharingCaller; role: CollaboratorRole; note?: string })
      : Promise<{ key: string; linkId: string }> {
    let callerRole = this.#requireCallerRole(opts.caller, await this.owningOrgRoles());
    if (roleRank(opts.role) > roleRank(callerRole)) {
      throw new Error("You cannot grant a role higher than your own.");
    }

    // The link is stored as its first key: the record is keyed by that key's hash.
    let { key, hash } = await this.#mintKey();
    this.#requireShareLinksAllowed();
    this.storage.shareKeys.put({
      id: hash,
      note: opts.note,
      created: new Date(),
      createdBy: opts.caller.profileId,
      role: opts.role,
    });
    return { key, linkId: hash };
  }

  /** Mints another key for an existing link. */
  async newShareLinkKey(opts: { caller: SharingCaller; linkId: string }): Promise<{ key: string }> {
    let link = this.#requireLink(opts.linkId);
    if (link.revoked) {
      throw new Error("Share link not found.");
    }
    this.#requireLinkManager(opts.caller, link, "copy");

    // Re-check the ceiling: the caller's role may have dropped below the link's since it was
    // created, and a fresh key must never grant more than the caller currently has.
    let callerRole = this.#requireCallerRole(opts.caller, await this.owningOrgRoles());
    if (roleRank(link.role ?? "build") > roleRank(callerRole)) {
      throw new Error("You cannot grant a role higher than your own.");
    }

    let { key, hash } = await this.#mintKey();
    this.#requireShareLinksAllowed();
    this.storage.shareKeys.put({ id: hash, alias: link.id });
    return { key };
  }

  // Generate a random 128-bit key, returning it along with the hash it is stored under. The caller
  // decides whether that hash keys a link or an alias.
  async #mintKey(): Promise<{ key: string; hash: string }> {
    let rawBytes = new Uint8Array(16);
    crypto.getRandomValues(rawBytes);
    let key = rawBytes.toHex();
    return { key, hash: await hashShareKey(key) };
  }

  /**
   * Active (non-revoked) share links. The Overseer maps each `createdBy` profile.id to a display
   * profile (which may require RPC) to produce `ShareLinkInfo`s; see `getCreatorProfile`.
   */
  listShareLinkRecords(): ShareLinkRecord[] {
    return [...this.#listLinks()].filter(link => !link.revoked);
  }

  /**
   * Resolve the display profile for a share link's creator using only locally-available data
   * (the collaborator table). Returns undefined if the creator is neither a current collaborator
   * nor matched here (e.g. the owner), in which case the Overseer resolves it via RPC. The final
   * fallback (a bare profile from the id) is also the Overseer's responsibility.
   */
  getCreatorProfile(createdBy: string): AiChatAuthorInfo | undefined {
    return this.storage.collaborators.get(createdBy)?.profile;
  }

  updateShareLink(caller: SharingCaller, linkId: string, note?: string): void {
    let link = this.#requireLink(linkId);
    this.#requireLinkManager(caller, link, "edit");

    link.note = note === undefined ? undefined : note.slice(0, 500);
    this.storage.shareKeys.put(link);
  }

  async previewRevokeShareLink(
      caller: SharingCaller, linkId: string): Promise<AffectedCollaborator[]> {
    let link = asLink(this.storage.shareKeys.get(linkId));
    if (!link) return [];
    this.#requireLinkManager(caller, link, "revoke");
    if (link.revoked) return [];

    let orgRoles = await this.owningOrgRoles();
    let baseline = this.computeEffectiveRoles({ orgRoles });
    let modified = this.computeEffectiveRoles({ orgRoles, revokedLinkId: linkId });
    return this.#computeAffected(baseline, modified);
  }

  /**
   * Revoke a share link by soft-revoking it (setting the `revoked` flag) rather than deleting it.
   * This is the lazy counterpart to removeCollaborator: the link record and every `shareKey` edge
   * referencing it stay intact (no dangling references), but the link contributes nothing to the
   * permission graph and its keys can no longer be redeemed. Its copies are deleted outright,
   * since no edge ever names an alias. Users who relied solely on it become unreachable and
   * are denied at open() time.
   *
   * `keepUsers` is optional re-root sugar, identical to removeCollaborator. Returns the
   * collaborators whose access actually changed (removed or downgraded), excluding kept users.
   */
  async revokeShareLink(
      caller: SharingCaller, linkId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let link = this.#requireLink(linkId);
    this.#requireLinkManager(caller, link, "revoke");

    let orgRoles = await this.owningOrgRoles();
    let baseline = this.computeEffectiveRoles({ orgRoles });

    link.revoked = true;
    this.storage.shareKeys.put(link);

    // Revoking makes the copies useless, and nothing references them, so delete them.
    this.storage.shareKeys.byAlias.delete(link.id);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers), orgRoles);

    return this.#computeAffected(baseline, this.computeEffectiveRoles({ orgRoles }));
  }

  // ---------------------------------------------------------------------------------------
  // Permission-graph engine

  /**
   * Compute the effective role of every principal -- the maximum role reachable from the
   * workspace's owner through valid permission edges. A principal absent from the returned map
   * has no access.
   *
   * The owner is the implicit root at "build". Each edge grants min(edge role, sharer's effective
   * role):
   *   - A "user" edge's sharer is the owner (effective "build") or another collaborator.
   *   - A "shareKey" edge's "sharer" is the key's creator; the edge grants the key's role bounded
   *     by the creator's effective role.
   *
   * Optional modifications model a hypothetical change, used by the preview methods:
   *   - `severedTarget`: a profileId whose own incoming edges are all treated as severed (an
   *     owner-style removal). The record stays, so on an org-owned workspace the member keeps
   *     their baseline and their dependents stay bounded by it.
   *   - `removedEdge`: a single user edge (target ← sharer) treated as removed.
   *   - `revokedLinkId`: a link treated as revoked (its edges contribute nothing).
   *   - `orgRoles`: the owning org's live membership (see the constructor's `owningOrgRoles`). A
   *     Map means the workspace is org-owned: each active member is seeded at the role their org
   *     role grants (org-access.ts), the user owner stops being the root, and stored edges only
   *     extend access on top of the baselines -- so a member's removal from the org (or demotion
   *     to member) ends or narrows their access here, lazily, like any other revocation. null
   *     means user-owned (the default when omitted).
   *
   * Once `ownerInvitesOnly` is set, only direct grants from the workspace's owner authority
   * count: every `shareKey` edge (even for a link that authority created) and every `user`
   * edge from anyone else is skipped (see `#mayAuthorOwnerGrant`). People who reached the
   * workspace any other way lose access, and a collaborator whose owner edge grants less than
   * they reached transitively is downgraded to it. On an org-owned workspace the owner
   * authority is the build baseline: org owners'/admins' user edges count, an ordinary
   * member's do not, and an admin's demotion ends the grants they authored at the next read.
   */
  computeEffectiveRoles(opts: {
    severedTarget?: string | null;
    removedEdge?: { target: string; sharer: string } | null;
    revokedLinkId?: string | null;
    orgRoles?: ReadonlyMap<string, OrgRole> | null;
  } = {}): Map<string, CollaboratorRole> {
    let severedTarget = opts.severedTarget ?? null;
    let removedEdge = opts.removedEdge ?? null;
    let revokedLinkId = opts.revokedLinkId ?? null;
    let orgRoles = opts.orgRoles ?? null;
    let ownerGrantsOnly = this.ownerInvitesOnly();

    // Map linkId → {creator, role}, excluding revoked links (the persisted `revoked` flag, and the
    // hypothetical `revokedLinkId` used by preview).
    let linkInfo = new Map<string, { creator: string; role: CollaboratorRole }>();
    for (let link of this.#listLinks()) {
      if (link.id === revokedLinkId || link.revoked) continue;
      linkInfo.set(link.id, {
        creator: link.createdBy,
        role: link.role ?? "build",
      });
    }

    // All collaborator records -- including a severed target's, which must stay reachable as a
    // sharer for its own dependents (at whatever role it retains).
    let allCollabs = new Map<string, CollaboratorRecord>();
    for (let record of this.storage.collaborators.list()) {
      allCollabs.set(record.profile.id, record);
    }

    // Roles known so far.
    let eff = new Map<string, CollaboratorRole>();

    // An org-owned workspace roots its graph at the org: every active member starts at the role
    // their org role grants, and edges only build on those baselines. (Pending invitees are
    // absent from the snapshot, so their access never starts.)
    if (orgRoles) {
      for (let [userId, orgRole] of orgRoles) {
        eff.set(userId, gadgetBaselineRole(orgRole));
      }
    }

    // Effective role of a potential sharer. The user owner is the root at "build" on a
    // user-owned workspace; on an org-owned one they are an ordinary principal, granted only
    // what their own membership (or an edge) gives.
    let sharerRole = (id: string): CollaboratorRole | undefined =>
        !orgRoles && id === this.ownerProfileId ? "build" : eff.get(id);

    // Fixed-point iteration. Roles only increase, so this converges.
    let changed = true;
    while (changed) {
      changed = false;
      for (let [id, record] of allCollabs) {
        let best: CollaboratorRole | undefined = eff.get(id);
        // An owner-style severance clears this target's own incoming edges entirely.
        if (id === severedTarget) continue;
        for (let edge of record.addedBy) {
          let granted: CollaboratorRole | undefined;
          if (edge.type === "shareKey") {
            if (ownerGrantsOnly) continue;
            let info = linkInfo.get(edge.keyId);
            if (!info) continue;  // link revoked or no longer exists
            let creatorRole = sharerRole(info.creator);
            if (!creatorRole) continue;
            granted = minRole(info.role, creatorRole);
          } else {
            // Skip the specifically-removed edge.
            if (removedEdge && id === removedEdge.target &&
                edge.sharer === removedEdge.sharer) {
              continue;
            }
            // (A severed target keeps whatever role remains, so its own dependents stay
            // bounded by that -- no sharer exclusion here.)
            if (ownerGrantsOnly && !this.#mayAuthorOwnerGrant(edge.sharer, orgRoles)) continue;
            let upstream = sharerRole(edge.sharer);
            if (!upstream) continue;
            granted = minRole(edgeGrantedRole(edge), upstream);
          }
          if (granted && (!best || roleRank(granted) > roleRank(best))) {
            best = granted;
          }
        }
        if (best && best !== eff.get(id)) {
          eff.set(id, best);
          changed = true;
        }
      }
    }

    return eff;
  }

  // Whether `sharer`'s direct user edges count as owner grants once `ownerInvitesOnly` is set:
  // the user owner on a user-owned workspace, or -- on an org-owned one, which has no user
  // owner -- an active member at the build baseline (org owners/admins: the roles org-access.ts
  // baselines at build, and the only ones that may move workspaces into the org). An admin's
  // later demotion therefore also lazily revokes the grants they authored: the edges stop
  // counting at the next graph read, exactly like any other baseline drop.
  #mayAuthorOwnerGrant(sharer: string, orgRoles: ReadonlyMap<string, OrgRole> | null): boolean {
    if (!orgRoles) return sharer === this.ownerProfileId;
    let orgRole = orgRoles.get(sharer);
    return orgRole !== undefined && gadgetBaselineRole(orgRole) === "build";
  }

  // The caller's effective role, throwing if the caller has no access at all (which should not
  // happen for an authorized session). On an org-owned workspace the caller's own membership is
  // the ceiling even when they hold owner authority in the session (`isOwner` covers org admins,
  // whose baseline is "build" anyway) -- the former user owner who is not a member shares
  // nothing.
  #requireCallerRole(
      caller: SharingCaller, orgRoles: ReadonlyMap<string, OrgRole> | null): CollaboratorRole {
    if (!orgRoles && caller.isOwner) return "build";
    let role = this.computeEffectiveRoles({ orgRoles }).get(caller.profileId);
    if (!role) {
      throw new Error("You do not have permission to share this workspace.");
    }
    return role;
  }

  /**
   * The collaborators who lost access or were downgraded when `ownerInvitesOnly` was set, given
   * `baseline`, the effective roles computed just before the flag was set.
   */
  computeAffectedByOwnerInvitesOnly(
      baseline: Map<string, CollaboratorRole>,
      orgRoles: ReadonlyMap<string, OrgRole> | null = null): AffectedCollaborator[] {
    return this.#computeAffected(baseline, this.computeEffectiveRoles({ orgRoles }));
  }

  // Diff two effective-role maps, returning the collaborators whose access changed. A user is
  // affected if they had access in `baseline` and either lost it (newRole null) or were downgraded
  // (newRole lower than oldRole) in `modified`. Profiles/edges are read from current storage.
  #computeAffected(
      baseline: Map<string, CollaboratorRole>,
      modified: Map<string, CollaboratorRole>): AffectedCollaborator[] {
    let result: AffectedCollaborator[] = [];
    for (let [id, oldRole] of baseline) {
      let newRole = modified.get(id) ?? null;
      if (newRole !== null && roleRank(newRole) >= roleRank(oldRole)) {
        continue;  // unchanged or (shouldn't happen) upgraded
      }
      let record = this.storage.collaborators.get(id);
      if (!record) continue;
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        oldRole,
        newRole,
      });
    }
    return result;
  }

  // Optional re-root sugar for removeCollaborator/revokeShareLink. Must be called *after* the
  // edge/key has already been severed in storage. `baseline` is the effective-role map from before
  // the severance. For each kept user who would otherwise lose access or be downgraded, append a
  // fresh `user` edge from the caller at their prior role (bounded by what the caller can grant),
  // so they retain their access independently of the severed path.
  #reRootKeptUsers(
      caller: SharingCaller, baseline: Map<string, CollaboratorRole>, keepSet: Set<string>,
      orgRoles: ReadonlyMap<string, OrgRole> | null): void {
    if (keepSet.size === 0) return;

    let callerRole = this.#requireCallerRole(caller, orgRoles);
    let afterSever = this.computeEffectiveRoles({ orgRoles });

    for (let id of keepSet) {
      let prior = baseline.get(id);
      if (!prior) continue;  // had no access to begin with -- nothing to keep

      let now = afterSever.get(id);
      if (now && roleRank(now) >= roleRank(prior)) continue;  // not dropped -- no edge needed

      let record = this.storage.collaborators.get(id);
      if (!record) continue;

      record.addedBy.push({
        type: "user",
        sharer: caller.profileId,
        created: new Date(),
        role: minRole(prior, callerRole),
      });
      this.storage.collaborators.put(record);
    }
  }
}
