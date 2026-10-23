// Pure JSON:API plumbing for the ZoomInfo gatekeeper: reading resources out of a document, the
// small coercion helpers the mappers lean on, page/query shaping, and the resource → typed-shape
// mappers for every record the session returns. Everything here is a pure function over a parsed
// response, shared by the session's reads and the enrichment replay.

import type { JsonApiDoc, JsonApiResource, QueryParams } from "./zoominfo-api";
import type {
  CompanyMatch,
  ContactMatch,
  EnrichMatchStatus,
  EnrichResult,
  IntentSignal,
  NewsArticle,
  PageRequest,
  Scoop,
  SearchPage,
} from "./types";

export function asResources(doc: JsonApiDoc): JsonApiResource[] {
  if (Array.isArray(doc.data)) return doc.data;
  return doc.data ? [doc.data] : [];
}

export function firstResource(doc: JsonApiDoc): JsonApiResource | null {
  const resources = asResources(doc);
  return resources[0] ?? null;
}

export function attrs(resource: JsonApiResource): Record<string, unknown> {
  return resource.attributes ?? {};
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Coerce an id-like value to a number when it is a numeric string (ZoomInfo expects int64 ids in
 * enrich/insight inputs), leaving non-numeric values untouched.
 */
export function idValue(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(Number(value)) && value.trim() !== "" ? Number(value) : value;
}

/**
 * Drop undefined entries so we don't send empty attribute keys. Generic so callers keep their
 * narrow value types (e.g. a query-param bag stays assignable to QueryParams).
 */
export function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function pageQuery(page?: PageRequest): QueryParams {
  const query: QueryParams = {};
  if (page?.page !== undefined) query["page[number]"] = page.page;
  if (page?.pageSize !== undefined) query["page[size]"] = page.pageSize;
  if (page?.sort !== undefined) query["sort"] = page.sort;
  return query;
}

export function toSearchPage<T>(doc: JsonApiDoc, map: (r: JsonApiResource) => T, page?: PageRequest): SearchPage<T> {
  const results = asResources(doc).map(map);
  const pageNumber = doc.meta?.page?.number ?? page?.page ?? 1;
  const pageSize = page?.pageSize ?? 25;
  const totalResults = doc.meta?.totalResults ?? results.length;
  const hasMore = doc.links?.next !== undefined || pageNumber * pageSize < totalResults;
  return { results, totalResults, page: pageNumber, pageSize, hasMore };
}

const MATCHED_STATUSES = new Set<EnrichMatchStatus>(["FULL_MATCH", "COMPANY_ONLY_MATCH", "CONTACT_ONLY_MATCH"]);
const ERROR_STATUSES = new Set<EnrichMatchStatus>(["INVALID_INPUT", "LIMIT_EXCEEDED"]);

export function mapEnrichResult<T>(resource: JsonApiResource, buildRecord: (r: JsonApiResource) => T): EnrichResult<T> {
  const meta = (resource.meta ?? {}) as { matchStatus?: EnrichMatchStatus; input?: unknown };
  const matchStatus: EnrichMatchStatus =
    meta.matchStatus ?? (resource.type === "NoMatch" ? "NO_MATCH" : "FULL_MATCH");

  if (ERROR_STATUSES.has(matchStatus)) {
    return { status: "error", input: meta.input, message: matchStatus };
  }
  const hasRecord = resource.type !== "NoMatch" && resource.attributes !== undefined &&
    MATCHED_STATUSES.has(matchStatus);
  if (!hasRecord) {
    return { status: "noMatch", matchStatus, input: meta.input };
  }
  // Best-effort: if ZoomInfo tells us the record is already under management, no credit was charged;
  // otherwise assume a credit was charged (worst case).
  const managementStatus = (resource.attributes as { managementStatus?: { underManagement?: boolean } })
    ?.managementStatus;
  const creditCharged = managementStatus?.underManagement !== true;
  return { status: "matched", matchStatus, record: buildRecord(resource), creditCharged };
}

// ---------------------------------------------------------------------------
// Resource → typed-shape mappers (module-level; pure functions over JSON:API resources).

export function mapCompanyMatch(resource: JsonApiResource): CompanyMatch {
  const a = attrs(resource);
  return {
    id: resource.id ?? "",
    name: str(a.name) ?? "",
    website: str(a.website),
    city: str(a.city),
    state: str(a.state),
    country: str(a.country),
    revenue: str(a.revenue),
    employeeCount: str(a.employeeCount),
    logoUrl: str(a.logo),
  };
}

export function mapContactMatch(resource: JsonApiResource): ContactMatch {
  const a = attrs(resource);
  const company = a.company as { id?: unknown; name?: unknown } | undefined;
  return {
    id: resource.id ?? "",
    firstName: str(a.firstName),
    middleName: str(a.middleName),
    lastName: str(a.lastName),
    jobTitle: str(a.jobTitle),
    managementLevel: str(a.managementLevel),
    contactAccuracyScore: num(a.contactAccuracyScore),
    hasEmail: bool(a.hasEmail),
    hasDirectPhone: bool(a.hasDirectPhone),
    hasMobilePhone: bool(a.hasMobilePhone),
    company: company ? { id: str(company.id) ?? "", name: str(company.name) } : undefined,
  };
}

export function mapIntentSignal(resource: JsonApiResource): IntentSignal {
  const a = attrs(resource);
  const company = (a.company ?? {}) as Record<string, unknown>;
  const recommended = (a.recommendedContacts ?? []) as Record<string, unknown>[];
  const locations = (a.topSignalLocations ?? []) as Record<string, unknown>[];
  return {
    category: str(a.category),
    topic: str(a.topic) ?? "",
    signalScore: num(a.signalScore) ?? 0,
    audienceStrength: str(a.audienceStrength),
    signalDate: str(a.signalDate),
    spikesInDateRange: num(a.spikesInDateRange),
    company: {
      id: str(company.id) ?? "",
      name: str(company.name),
      website: str(company.website),
      hasOtherTopicConsumption: bool(company.hasOtherTopicConsumption),
    },
    recommendedContacts: recommended.map(c => ({
      id: str(c.id) ?? "",
      firstName: str(c.firstName),
      lastName: str(c.lastName),
      jobTitle: str(c.jobTitle),
      companyName: str(c.companyName),
      jobFunctions: ((c.jobFunctions ?? []) as Record<string, unknown>[]).map(f => ({
        name: str(f.name),
        department: str(f.department),
      })),
    })),
    topSignalLocations: locations.map(l => ({
      city: str(l.city),
      state: str(l.state),
      country: str(l.country),
    })),
  };
}

export function mapScoop(resource: JsonApiResource): Scoop {
  const a = attrs(resource);
  const company = a.company as { id?: unknown; name?: unknown } | undefined;
  const topics = (a.topics ?? []) as Record<string, unknown>[];
  const types = (a.types ?? []) as Record<string, unknown>[];
  const contacts = (a.contacts ?? []) as Record<string, unknown>[];
  return {
    id: resource.id ?? "",
    publishedDate: str(a.publishedDate),
    originalPublishedDate: str(a.originalPublishedDate),
    linkText: str(a.linkText),
    link: str(a.link),
    description: str(a.description),
    updateText: str(a.updateText),
    topics: topics.map(t => ({ id: str(t.id) ?? "", topic: str(t.topic) ?? "" })),
    types: types.map(t => ({ id: str(t.id) ?? "", type: str(t.type) ?? "" })),
    company: company ? { id: str(company.id) ?? "", name: str(company.name) } : undefined,
    contacts: contacts.map(c => ({
      id: str(c.id) ?? "",
      firstName: str(c.firstName),
      lastName: str(c.lastName),
      jobTitle: str(c.jobTitle),
      jobFunction: ((c.jobFunction ?? []) as Record<string, unknown>[]).map(f => ({
        name: str(f.name),
        department: str(f.department),
      })),
    })),
  };
}

export function mapNewsArticle(resource: JsonApiResource): NewsArticle {
  const a = attrs(resource);
  const companies = (a.company ?? []) as Record<string, unknown>[];
  return {
    domain: str(a.domain),
    title: str(a.title),
    url: str(a.url),
    imageUrl: str(a.imageUrl),
    pageDate: str(a.pageDate),
    categories: (a.categories ?? []) as string[],
    description: str(a.description),
    company: companies.map(c => ({ id: str(c.id) ?? "", name: str(c.name) })),
  };
}
