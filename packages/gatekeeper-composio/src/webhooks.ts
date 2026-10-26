// Webhook receipt for the Composio connector: Standard Webhooks signature verification and the
// hand-validated envelope parser (the composio-api.ts style — no schema library, no blind casts).
// Everything here is pure and runtime-agnostic (WebCrypto exists in Node 18+ and Workers alike),
// so the Node suite covers it without a workerd harness.
//
// Envelope contents are attacker-controllable up to signature verification, which happens in the
// account DO *before* any parsed field is acted on. Nothing in this module logs; callers fence
// untrusted fields when they surface them.

import { WEBHOOK_ROUTE_SUFFIX, gatekeeperBasePath, webhookOrigin } from "./config.js";

/** The event types the connector's single webhook subscription registers. */
export const WEBHOOK_EVENT_TYPES = [
  "composio.trigger.message",
  "composio.connected_account.expired",
] as const;

/** How `user_id` values the connector mints for accounts begin (`workshop-<accountId>`). */
export const ACCOUNT_USER_ID_PREFIX = "workshop-";

/** Standard Webhooks default tolerance between the signed timestamp and receipt (5 minutes). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Receipts larger than this are refused before parsing — envelope bodies are small. */
export const MAX_ENVELOPE_BYTES = 256 * 1024;

/** The account id a Composio `user_id` routes to, or `null` when it is not one of ours. */
export function accountIdForUserValue(userValue: unknown): string | null {
  if (typeof userValue !== "string") return null;
  if (!userValue.startsWith(ACCOUNT_USER_ID_PREFIX)) return null;
  const accountId = userValue.slice(ACCOUNT_USER_ID_PREFIX.length);
  return accountId === "" ? null : accountId;
}

/**
 * The subscription URL Composio delivers to: `${origin}${basePath}/webhook`. Throws (rather than
 * returning null) because the two callers — subscription creation and the app UI's readiness
 * surface — both want the refusal reason verbatim.
 */
export function webhookSubscriptionUrl(env: {
  BASE_URL?: string;
  WEBHOOK_ORIGIN?: string;
}): string {
  const origin = webhookOrigin(env);
  if (origin === null) {
    throw new Error(
      "No https webhook origin: set BASE_URL (production) or WEBHOOK_ORIGIN (dev tunnel) " +
      "before enabling triggers — Composio cannot deliver to an unreachable URL.");
  }
  return `${origin}${gatekeeperBasePath(env)}${WEBHOOK_ROUTE_SUFFIX}`;
}

/**
 * Standard Webhooks HMAC: base64(HMAC-SHA256(secret, `${webhookId}.${timestamp}.${rawBody}`)).
 * The signature header carries one or more `v1,<base64>` candidates separated by spaces (a
 * rotation window signs with both secrets); any match verifies. The timestamp is checked against
 * `now` first so stale captures cannot be replayed past the tolerance window.
 */
export async function verifyWebhookSignature(options: {
  webhookId: string;
  timestamp: string;
  signatureHeader: string;
  rawBody: string;
  secret: string;
  now?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  const { webhookId, timestamp, signatureHeader, rawBody, secret } = options;
  const tolerance = options.toleranceMs ?? WEBHOOK_TOLERANCE_MS;
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || timestamp.trim() === "") return false;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - tsSeconds) * 1000 > tolerance) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${webhookId}.${timestamp}.${rawBody}`),
  ));

  for (const candidate of signatureHeader.split(/\s+/)) {
    const comma = candidate.indexOf(",");
    if (comma === -1 || candidate.slice(0, comma) !== "v1") continue;
    const expected = decodeBase64(candidate.slice(comma + 1));
    if (expected !== null && constantTimeEqual(mac, expected)) return true;
  }
  return false;
}

/** Test/rotation helper producing the `v1,<base64>` header value for a secret. */
export async function signWebhook(options: {
  webhookId: string;
  timestamp: string;
  rawBody: string;
  secret: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${options.webhookId}.${options.timestamp}.${options.rawBody}`),
  );
  return `v1,${encodeBase64(new Uint8Array(mac))}`;
}

/** Length-checked, constant-time byte comparison (a plain `===` on derived strings is fine too,
 * but this avoids early-exit on the digest prefix without depending on string interning). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strict base64 decode (standard alphabet, no whitespace) → bytes, or `null` when malformed. */
function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** One parsed, shape-verified webhook envelope. `data` stays `unknown`: it is untrusted payload. */
export type ParsedWebhook =
  | {
    kind: "trigger";
    eventId: string;
    upstreamTriggerId: string;
    triggerSlug: string;
    routedAccountId: string;
    data: unknown;
    timestamp?: string;
  }
  | {
    kind: "connected_account_expired";
    eventId: string;
    routedAccountId: string | null;
    connectedAccountId: string;
    toolkitSlug: string;
    statusReason?: string;
    timestamp?: string;
  }
  | { kind: "unknown"; eventId: string; type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parses a raw (not yet verified) envelope body. Structural failures return `{ ok: false }` with
 * a fixed reason — never echoing body content — so the ingest path can 4xx without leaking
 * attacker-supplied text into logs.
 */
export function parseWebhookEnvelope(rawBody: string):
  { ok: true; event: ParsedWebhook } | { ok: false; error: string } {
  if (rawBody.length > MAX_ENVELOPE_BYTES) return { ok: false, error: "envelope_too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(parsed)) return { ok: false, error: "not_an_object" };
  const eventId = requireString(parsed, "id");
  if (eventId === undefined) return { ok: false, error: "missing_id" };
  const type = requireString(parsed, "type");
  if (type === undefined) return { ok: false, error: "missing_type" };
  const metadata = parsed.metadata;

  if (type === "composio.trigger.message") {
    if (!isRecord(metadata)) return { ok: false, error: "missing_metadata" };
    const upstreamTriggerId = requireString(metadata, "trigger_id");
    const userValue = requireString(metadata, "user_id");
    const routedAccountId = userValue !== undefined ? accountIdForUserValue(userValue) : null;
    if (upstreamTriggerId === undefined || routedAccountId === null) {
      return { ok: false, error: "unroutable_trigger" };
    }
    return {
      ok: true,
      event: {
        kind: "trigger",
        eventId,
        upstreamTriggerId,
        triggerSlug: requireString(metadata, "trigger_slug") ?? "unknown",
        routedAccountId,
        data: parsed.data,
        timestamp: requireString(parsed, "timestamp"),
      },
    };
  }

  if (type === "composio.connected_account.expired") {
    // Routing rides the deprecated top-level `data.user_id`; upstream may drop it, in which
    // case the event is logged and dropped (there is no other account hint in the envelope).
    const data = isRecord(parsed.data) ? parsed.data : undefined;
    const userValue = data !== undefined ? requireString(data, "user_id") : undefined;
    const connectedAccountId = data !== undefined ? requireString(data, "id") : undefined;
    const toolkit = data !== undefined && isRecord(data.toolkit) ? data.toolkit : undefined;
    const toolkitSlug = toolkit !== undefined ? requireString(toolkit, "slug") : undefined;
    if (connectedAccountId === undefined || toolkitSlug === undefined) {
      return { ok: false, error: "malformed_expired" };
    }
    return {
      ok: true,
      event: {
        kind: "connected_account_expired",
        eventId,
        routedAccountId: userValue !== undefined ? accountIdForUserValue(userValue) : null,
        connectedAccountId,
        toolkitSlug,
        statusReason: data !== undefined ? requireString(data, "status_reason") : undefined,
        timestamp: requireString(parsed, "timestamp"),
      },
    };
  }

  return { ok: true, event: { kind: "unknown", eventId, type } };
}
