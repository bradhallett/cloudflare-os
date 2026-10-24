// Per-domain registry of public collections. It serializes writes to the KV snapshot read by user
// sessions when building their enabled collection set, and indexes the collections each org holds
// a grant on, which member listings consult before re-checking each collection live.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { ContextCollectionSummary } from "./context-types.js";
import { publicCollectionsKvKey } from "./collection-kv.js";

// One collection held by one org. `key` is orgId and collection id joined by a NUL, which never
// appears in either id, so a collection can be indexed under several orgs independently.
type OrgCollectionRecord = {
  key: string;
  orgId: string;
  id: string;
};

function makeRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      publicCollections: collection<ContextCollectionSummary>()({
        primaryKey: "id",
      }),
      orgCollections: collection<OrgCollectionRecord>()({
        primaryKey: "key",
        nonUniqueIndexes: {
          byOrg(record: OrgCollectionRecord) { return record.orgId; },
        },
      }),
    },
    singletons: {},
  });
}

export class LibraryRegistryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeRegistryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeRegistryStorage(ctx.storage);
  }

  async #writeSnapshot(domain: string): Promise<void> {
    let collections = [...this.storage.publicCollections.list()];
    await this.env.CONTEXT_COLLECTIONS.put(
      publicCollectionsKvKey(domain), JSON.stringify(collections));
  }

  isPublic(collectionId: string): boolean {
    return !!this.storage.publicCollections.get(collectionId);
  }

  async addPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    this.storage.publicCollections.put(summary);
    await this.#writeSnapshot(domain);
  }

  async removePublic(domain: string, collectionId: string): Promise<void> {
    if (this.storage.publicCollections.get(collectionId)) {
      this.storage.publicCollections.delete(collectionId);
      await this.#writeSnapshot(domain);
    }
  }

  /** Refresh a public collection summary; no-op if it is no longer public. */
  async syncPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    let existing = this.storage.publicCollections.get(summary.id);
    if (!existing) return;
    if (existing.lastUpdated.valueOf() !== summary.lastUpdated.valueOf()) {
      this.storage.publicCollections.put(summary);
      await this.#writeSnapshot(domain);
    }
  }

  /** Index a collection under an org, so member listings can find it. Idempotent. */
  addOrgCollection(_domain: string, orgId: string, collectionId: string): void {
    this.storage.orgCollections.put({
      key: `${orgId}\u0000${collectionId}`,
      orgId,
      id: collectionId,
    });
  }

  /**
   * Drop an org's index entry for a collection. Idempotent, and never read for authority: listings
   * re-check the collection's own grants, so a stale entry costs a wasted live check, not access.
   */
  removeOrgCollection(_domain: string, orgId: string, collectionId: string): void {
    this.storage.orgCollections.delete(`${orgId}\u0000${collectionId}`);
  }

  /** Every collection id indexed under one org. Discovery only; grants are re-checked live. */
  listOrgCollections(_domain: string, orgId: string): string[] {
    return [...this.storage.orgCollections.byOrg.get(orgId)].map(record => record.id);
  }
}
