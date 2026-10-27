// The enrichment outcome window. The submit/apply/reject lifecycle itself is the kit's
// `defineActions` engine over an `ActionJournal` (zoominfo-actions.ts); this module keeps only the
// decided-outcome log a Gadget reads back via getEnrichmentResult(): each enrich* call's ready,
// rejected, failed, or unknown outcome is stored under the ticket id and evicted once
// MAX_RETAINED_ENRICHMENTS newer outcomes have landed. Everything lives in the GatekeeperImpl DO's
// KV, shared by the session (which reads) and the apply/reject callbacks (which decide).

import type { ZoomInfoApi } from "./zoominfo-api";
import {
  asResources,
  attrs,
  mapEnrichResult,
  mapIntentSignal,
  mapNewsArticle,
  mapScoop,
  num,
  pageQuery,
  str,
  toSearchPage,
} from "./zoominfo-mapping";
import type {
  CompanyHashtag,
  CompanyRecord,
  ContactRecord,
  CorporateHierarchyRecord,
  EnrichmentKind,
  PageRequest,
} from "./types";

// How many recent enrichment outcomes to retain per connected account. Enough that a Gadget can
// still read back results from earlier in a session, while capping the DO's KV footprint (each
// outcome is small and gated behind a human approval, so this window is generous).
const MAX_RETAINED_ENRICHMENTS = 100;

/** A submitted-but-not-yet-applied enrichment: enough to replay the ZoomInfo call on approval. */
export type PendingEnrichment = {
  kind: EnrichmentKind;
  summary: string;
  attributes: Record<string, unknown>;
  page?: PageRequest;
};

/**
 * The stored outcome once the user has decided (mirrors EnrichmentOutcome minus the "pending" state,
 * which the journal's live record represents). The "unknown" outcome is recorded when a dispatch's
 * outcome cannot be known, so the ticket keeps warning that credits may have been spent even after
 * the user rejects the action.
 */
export type StoredEnrichmentOutcome =
  | { status: "ready"; result: unknown }
  | { status: "rejected" }
  | { status: "failed"; message: string }
  | { status: "unknown"; message: string };

/** The decided-outcome log behind `getEnrichmentResult`, bounded to a recent window per account. */
export class EnrichmentOutcomes {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #key(id: number): string {
    return `enrich:result:${id}`;
  }

  get(id: number): StoredEnrichmentOutcome | undefined {
    return this.#kv.get<StoredEnrichmentOutcome>(this.#key(id));
  }

  put(id: number, outcome: StoredEnrichmentOutcome): void {
    this.#kv.put(this.#key(id), outcome);
    // Bound storage: evict the outcome that has fallen out of the retention window. Ticket ids are
    // dense and monotonic (the journal's id counter), so this keeps at most MAX_RETAINED_ENRICHMENTS
    // recent outcomes readable while preventing unbounded growth over the account's lifetime.
    const evictId = id - MAX_RETAINED_ENRICHMENTS;
    if (evictId >= 1) this.#kv.delete(this.#key(evictId));
  }

  remove(id: number): void {
    this.#kv.delete(this.#key(id));
  }
}

/**
 * Replay an approved enrichment against the ZoomInfo API and shape the response into the same
 * payload the (former) synchronous method would have returned. Dispatches on the stored kind.
 */
export async function performEnrichment(api: ZoomInfoApi, pending: PendingEnrichment): Promise<unknown> {
  const { kind, attributes, page } = pending;
  switch (kind) {
    case "companies": {
      const doc = await api.post("/data/v1/companies/enrich", "CompanyEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<CompanyRecord>(r, res => ({
        id: res.id ?? str(attrs(res).id) ?? "",
        fields: attrs(res),
      })));
    }
    case "corporateHierarchy": {
      const doc = await api.post("/data/v1/companies/corporate-hierarchy/enrich", "CorporateHierarchyEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<CorporateHierarchyRecord>(r, res => ({
        companyId: str(attrs(res).companyId) ?? res.id ?? "",
        fields: attrs(res),
      })));
    }
    case "hashtags": {
      const doc = await api.post("/data/v1/companies/hashtags/enrich", "HashtagEnrich", attributes);
      return asResources(doc).map(r => {
        const a = attrs(r);
        return {
          id: r.id ?? "",
          label: str(a.label),
          displayLabel: str(a.displayLabel),
          description: str(a.description),
          group: str(a.group),
          parentCategory: str(a.parentCategory),
          priority: num(a.priority),
        } satisfies CompanyHashtag;
      });
    }
    case "contacts": {
      const doc = await api.post("/data/v1/contacts/enrich", "ContactEnrich", attributes);
      return asResources(doc).map(r => mapEnrichResult<ContactRecord>(r, res => ({
        id: res.id ?? str(attrs(res).id) ?? "",
        fields: attrs(res),
      })));
    }
    case "intent": {
      const doc = await api.post("/data/v1/intent/enrich", "IntentEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapIntentSignal, page);
    }
    case "scoops": {
      const doc = await api.post("/data/v1/scoops/enrich", "ScoopEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapScoop, page);
    }
    case "news": {
      const doc = await api.post("/data/v1/news/enrich", "NewsEnrich", attributes, pageQuery(page));
      return toSearchPage(doc, mapNewsArticle, page);
    }
  }
}
