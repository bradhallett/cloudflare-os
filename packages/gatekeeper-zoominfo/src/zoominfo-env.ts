// Configuration shared by every part of the ZoomInfo gatekeeper: the Worker's environment and the
// daily read limit that bounds what a connection's gadgets can spend on API requests.

/** The vendor id: the router's `/gatekeeper/zoominfo/` path segment. */
export const VENDOR_ID = "zoominfo";

/** The Worker's environment. Every value is optional: each has a default or turns a feature off. */
export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  ZOOMINFO_AUTHORIZE_URL?: string;
  ZOOMINFO_TOKEN_URL?: string;
  ZOOMINFO_API_BASE_URL?: string;
  /** ZoomInfo API requests one connection may make per UTC day; `0` removes the limit. */
  ZOOMINFO_DAILY_READ_LIMIT?: string;
};

/**
 * The default `ZOOMINFO_DAILY_READ_LIMIT`. ZoomInfo charges credits only for enrichment, which
 * every single request of is separately user-approved, so this backstop bounds the request spend
 * of unapproved surfaces — searches, lookups, insights, summaries — and of a runaway agent
 * paging through them, not a dollar figure.
 */
export const DEFAULT_DAILY_READ_LIMIT = 1000;

/**
 * The daily read limit in force.
 * @returns The limit, or `null` when reads are unlimited.
 */
export function dailyReadLimit(env: Pick<Env, "ZOOMINFO_DAILY_READ_LIMIT">): number | null {
  const raw = env.ZOOMINFO_DAILY_READ_LIMIT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_DAILY_READ_LIMIT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0) return DEFAULT_DAILY_READ_LIMIT;
  return limit === 0 ? null : limit;
}
