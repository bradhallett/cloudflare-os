// The blueprint half of the user Durable Object (user.ts): the blueprints the user published
// from their workspaces, their blueprint library (with the live org-membership gate), the pinned
// set, and the KV/R2 cleanup of deleted owned blueprints. The DO keeps its RPC surface as thin
// delegators (the user-bots.ts pattern).

import {BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX} from '@gadgets/workshop-shared/api';
import { type BlueprintUserRecord, type UserStorage} from "./storage-schema/user-storage.js";
import { blueprintKvKey, isReservedBlueprintKey, readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import type { AdminSettings } from "./admin-settings.js";
import { deleteBlueprintContent } from "./blueprint-archive.js";
import { resolveBlueprintForUser } from "./blueprint-access.js";
import { isActiveMember } from "./org-access.js";
import { retryOnDoReset } from "./do-retry.js";

/** The blueprint storage keys this store owns (a slice of the user DO's UserStorage). */
export type UserBlueprintStorage = Pick<UserStorage,
    "blueprints" | "libraryBlueprints" | "pinnedBlueprints" | "orgMemberships" | "gadgets">;

/**
 * The user's blueprint state: published blueprints (the workspaces they came from), the library
 * (entries the user added, org-owned ones gated live by the org that justified the add), the
 * pinned set, and the deletion path that also clears the blueprint's KV record and R2 content.
 */
export class UserBlueprintStore {
  constructor(
      private ctx: DurableObjectState,
      private env: Cloudflare.Env,
      private storage: UserBlueprintStorage,
      private adminSettings: DurableObjectNamespace<AdminSettings>,
  ) {}

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    // The blueprint may belong to one of the user's orgs, so this is the member-gated read.
    let kvRecord = await resolveBlueprintForUser(
        this.env, this.ctx.exports.OrgDurableObject,
        [...this.storage.orgMemberships.list()].map(entry => entry.orgId), this.ctx.id.name!, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    let orgOwner = kvRecord.owner?.type === "org" ? kvRecord.owner.id : undefined;
    if (existing) {
      existing.metadata = kvRecord.metadata;
      existing.orgOwner = orgOwner;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
      // The org whose member this blueprint belongs to, if any: the listing's live gate.
      orgOwner,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.owner?.type !== "user" || kvRecord.owner.id !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      await deleteBlueprintContent(this.env, kvRecord.owner, id);
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    // An org-owned entry is gated live, like every org read (the lazy-revocation contract,
    // docs/tenancy.md): the record names the org whose member added it, and the listing asks
    // that org again, so a removed member's entry is withheld. The record is kept -- a re-add
    // restores the listing, and opening re-resolves regardless -- and records written before
    // the gate name no org, so they list as they always did.
    let me = this.ctx.id.name!;
    // Every distinct org's gate is asked at once (the mirror image of server.ts's concurrent
    // describeForMember fanout), rather than org N+1's gate starting only after org N's
    // resolves. Each is a pure read, retried across an org-DO reset, memoized per org; an
    // unreadable org answers as if removed, so the listing fails closed.
    let memberOf = new Map<string, Promise<boolean>>();
    let askOrg = (orgId: string) => {
      let gate = memberOf.get(orgId);
      if (gate === undefined) {
        gate = retryOnDoReset(() =>
            this.ctx.exports.OrgDurableObject.getByName(orgId).getMember(me))
            .then(isActiveMember, () => false);
        memberOf.set(orgId, gate);
      }
      return gate;
    };
    // Snapshot the records first (the #sweepExpiredInvitations pattern): a storage list()
    // iterator is invalidated by writes, and the gates below must be kicked before any await.
    let records = Array.from(this.storage.libraryBlueprints.list());
    for (let orgId of new Set(records.map(r => r.orgOwner).filter(o => o !== undefined))) {
      askOrg(orgId!);
    }
    let dead: string[] = [];
    for (let record of records) {
      if (record.orgOwner !== undefined && !(await askOrg(record.orgOwner))) continue;
      // The blueprint's authoritative home is KV under the entry's scope -- the same key
      // resolveBlueprintForUser found it at (user-owned and bundled blueprints live at the
      // root; an org's under its org/ prefix). An entry whose blueprint is gone there is a
      // ghost (a workspace deleted without removing the entry, say) and is dropped below.
      let kvKey = record.orgOwner !== undefined
          ? blueprintKvKey({type: "org", id: record.orgOwner}, record.id)
          : record.id;
      if (await this.env.BLUEPRINTS.get(kvKey) === null) {
        dead.push(record.id);
        continue;
      }
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    // Reconcile on read (the deleted-blueprint contract): the ghost entries collected above
    // are removed from the store and unpinned -- the same cleanup removeBlueprintFromLibrary
    // does -- so they disappear from every listing instead of failing the open on click.
    for (let id of dead) {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }
}
