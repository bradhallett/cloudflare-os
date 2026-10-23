// The enrichment action queue. Each enrich* call stores a PendingEnrichment and submits it for
// approval. When the user approves, ZoomInfoGatekeeperImpl.applyAction() replays it against the API
// (spending credits) and stores the result; the Gadget reads it back via getEnrichmentResult().
// Rejection stores a "rejected" outcome and spends nothing. Everything lives in the GatekeeperImpl
// DO's KV, shared by the session (which submits/reads) and the apply/reject callbacks.

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

// A submitted-but-not-yet-applied enrichment: enough to replay the ZoomInfo call on approval.
export type PendingEnrichment = {
  kind: EnrichmentKind;
  summary: string;
  attributes: Record<string, unknown>;
  page?: PageRequest;
};

// The stored outcome once the user has decided (mirrors EnrichmentOutcome minus the "pending" state,
// which is represented by the absence of a stored outcome while the request is still pending). The
// "unknown" outcome is claimed before an approved enrichment is dispatched, so an activation that
// dies past the claim leaves a record that blocks the enrichment from being replayed blind.
export type StoredEnrichmentOutcome =
  | { status: "ready"; result: unknown }
  | { status: "rejected" }
  | { status: "failed"; message: string }
  | { status: "unknown"; message: string };

export class EnrichmentStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #pendingKey(id: number): string {
    return `enrich:pending:${id}`;
  }

  #resultKey(id: number): string {
    return `enrich:result:${id}`;
  }

  submit(pending: PendingEnrichment): number {
    const id = this.#kv.get<number>("enrich:nextId") ?? 1;
    this.#kv.put("enrich:nextId", id + 1);
    this.#kv.put(this.#pendingKey(id), pending);
    return id;
  }

  getPending(id: number): PendingEnrichment | undefined {
    return this.#kv.get<PendingEnrichment>(this.#pendingKey(id));
  }

  removePending(id: number): void {
    this.#kv.delete(this.#pendingKey(id));
  }

  getResult(id: number): StoredEnrichmentOutcome | undefined {
    return this.#kv.get<StoredEnrichmentOutcome>(this.#resultKey(id));
  }

  putResult(id: number, outcome: StoredEnrichmentOutcome): void {
    this.#kv.put(this.#resultKey(id), outcome);
    // Bound storage: evict the enrichment that has fallen out of the retention window. IDs are
    // dense and monotonic (see submit), so this keeps at most MAX_RETAINED_ENRICHMENTS recent
    // outcomes readable while preventing unbounded growth over the account's lifetime. Dropping the
    // pending key too sweeps up any never-decided request that aged out.
    const evictId = id - MAX_RETAINED_ENRICHMENTS;
    if (evictId >= 1) {
      this.#kv.delete(this.#resultKey(evictId));
      this.#kv.delete(this.#pendingKey(evictId));
    }
  }

  removeResult(id: number): void {
    this.#kv.delete(this.#resultKey(id));
  }
}

// Replay an approved enrichment against the ZoomInfo API and shape the response into the same
// payload the (former) synchronous method would have returned. Dispatches on the stored kind.
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
