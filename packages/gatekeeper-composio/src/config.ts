// Static configuration for the Composio connector: vendor identity, API base, deployment-key
// access, the daily call limit, and the one shared meta-tool slug registry (read by the execute
// refusal, the catalog filter, and UI copy alike — plans/composio-gatekeeper.md "Execution").

/** Vendor id used in logger config and admin config keys. */
export const VENDOR_ID = "composio";

/** Composio Platform REST surface; the only origin composio-api.ts talks to. */
export const API_BASE = "https://backend.composio.dev/api/v3.1";

/** Default per-user, per-UTC-day call limit when COMPOSIO_DAILY_CALL_LIMIT is unset. */
export const DEFAULT_DAILY_CALL_LIMIT = 500;

/**
 * Meta-tool slugs refused at execute time and filtered from the catalog. Arbitrary code execution
 * on Composio infra is outside this platform's sandbox premise; no admin setting re-enables it.
 * Note `COMPOSIO_REMOTE_BASH_TOOL`, not `COMPOSIO_REMOTE_BASH`.
 */
export const META_TOOL_SLUGS = [
  "COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_SEARCH_TOOLS", "MULTI_EXECUTE_TOOL",
] as const;

const META_TOOL_SET: ReadonlySet<string> = new Set(META_TOOL_SLUGS);

/** Whether `slug` is one of the refused meta-tool slugs (exact match). */
export function isMetaTool(slug: string): boolean {
  return META_TOOL_SET.has(slug);
}
/**
 * The webhook route this worker serves relative to its public origin: `${basePath}/webhook` on
 * the gatekeeper's BASE_URL (see webhooks.ts), alongside the connect-callback sibling below.
 */
export const WEBHOOK_ROUTE_SUFFIX = "/webhook";

/**
 * Placeholder callback route for Connect Link flows; the webhook route landed beside it.
 * Declared here so the constant has a single home.
 */
export const CONNECT_LINK_CALLBACK_PATH = "/gatekeeper/composio/connect-callback";

/**
 * Per-workspace, per-UTC-day cap on delivered trigger events. Composio redelivers on failure and
 * the fan-out is per trigger, so a runaway upstream must not be able to spend unbounded delivery
 * or callback attention; over-limit events are dropped and counted visibly in the app UI.
 */
export const EVENTS_PER_WORKSPACE_PER_DAY = 500;

/**
 * The deployment project key. Throws a clear error when unset — the vendor fails closed rather
 * than running without credentials.
 */
export function deploymentApiKey(env: { COMPOSIO_API_KEY?: string }): string {
  const key = env.COMPOSIO_API_KEY;
  if (key === undefined || key.trim() === "") {
    throw new Error(
      "COMPOSIO_API_KEY is not set. Install the Composio connector with a project API key.");
  }
  return key;
}

/**
 * The per-user daily call limit. Unset means {@link DEFAULT_DAILY_CALL_LIMIT}; a set but invalid
 * value (non-integer or < 1) throws rather than silently arming an unusable limit.
 */
export function dailyCallLimit(env: { COMPOSIO_DAILY_CALL_LIMIT?: string }): number {
  const raw = env.COMPOSIO_DAILY_CALL_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CALL_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`COMPOSIO_DAILY_CALL_LIMIT must be a positive integer, got ${raw}.`);
  }
  return parsed;
}

/**
 * The webhook origin for this deployment. Production reads the manifest-templated BASE_URL;
 * WEBHOOK_ORIGIN (a tunnel's public origin, same var as the GitHub connector) overrides it for
 * local development, where the dev server's origin is not publicly reachable. Returns `null`
 * when neither yields an https origin — callers must refuse rather than register an unreachable
 * or plain-http subscription URL.
 */
export function webhookOrigin(env: {
  BASE_URL?: string;
  WEBHOOK_ORIGIN?: string;
}): string | null {
  const raw = env.WEBHOOK_ORIGIN?.trim() || env.BASE_URL?.trim();
  if (raw === undefined || raw === "") return null;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return null;
  }
  return origin.startsWith("https://") ? origin : null;
}

/**
 * The base path of the gatekeeper's route under the public origin, from BASE_URL (e.g.
 * `https://host/gatekeeper/composio` → `/gatekeeper/composio`). Empty when BASE_URL is unset
 * (production always sets it; tests may not).
 */
export function gatekeeperBasePath(env: { BASE_URL?: string }): string {
  const raw = env.BASE_URL?.trim();
  if (raw === undefined || raw === "") return "";
  try {
    return new URL(raw).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}
