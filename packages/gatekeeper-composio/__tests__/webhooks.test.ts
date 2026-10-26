import { describe, expect, it } from "vitest";
import {
  ACCOUNT_USER_ID_PREFIX,
  MAX_ENVELOPE_BYTES,
  accountIdForUserValue,
  parseWebhookEnvelope,
  signWebhook,
  verifyWebhookSignature,
  webhookSubscriptionUrl,
} from "../src/webhooks.js";

const NOW_MS = 1_700_000_000_000;
const nowSeconds = Math.floor(NOW_MS / 1000);

function triggerEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_1",
    type: "composio.trigger.message",
    timestamp: "2026-01-01T00:00:00Z",
    data: { subject: "hello" },
    metadata: {
      trigger_id: "ti_123",
      trigger_slug: "github_issue_opened",
      user_id: `${ACCOUNT_USER_ID_PREFIX}0a1b2c3d-e4f5-6a7b-8c9d-0e1f2a3b4c5d`,
    },
    ...overrides,
  });
}

describe("signWebhook / verifyWebhookSignature", () => {
  const body = triggerEnvelope();

  it("verifies a freshly signed delivery", async () => {
    const signature = await signWebhook({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      rawBody: body,
      secret: "whsec_test",
    });
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: signature,
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await signWebhook({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      rawBody: body,
      secret: "whsec_test",
    });
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: signature,
      rawBody: body.replace("hello", "goodbye"),
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const stale = String(nowSeconds - 301);
    const signature = await signWebhook({
      webhookId: "msg_1",
      timestamp: stale,
      rawBody: body,
      secret: "whsec_test",
    });
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: stale,
      signatureHeader: signature,
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(false);
  });

  it("accepts the boundary of the tolerance window and rejects replay past it", async () => {
    const boundary = String(nowSeconds - 300);
    const signature = await signWebhook({
      webhookId: "msg_1",
      timestamp: boundary,
      rawBody: body,
      secret: "whsec_test",
    });
    const options = {
      webhookId: "msg_1",
      timestamp: boundary,
      signatureHeader: signature,
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    };
    expect(await verifyWebhookSignature(options)).toBe(true);
    expect(await verifyWebhookSignature({ ...options, now: NOW_MS + 1000 })).toBe(false);
  });

  it("verifies against any candidate in a multi-candidate rotation header", async () => {
    const oldSignature = await signWebhook({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      rawBody: body,
      secret: "whsec_old",
    });
    const newSignature = await signWebhook({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      rawBody: body,
      secret: "whsec_new",
    });
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: `${oldSignature} ${newSignature}`,
      rawBody: body,
      secret: "whsec_new",
      now: NOW_MS,
    })).toBe(true);
    // A rotation header where only the old secret matches still fails against the new secret.
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: oldSignature,
      rawBody: body,
      secret: "whsec_new",
      now: NOW_MS,
    })).toBe(false);
  });

  it("ignores non-v1 candidates and malformed digests", async () => {
    const signature = await signWebhook({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      rawBody: body,
      secret: "whsec_test",
    });
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: `v2,AAAA ${signature}`,
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(true);
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: String(nowSeconds),
      signatureHeader: "v1,!!!not-base64!!!",
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(false);
  });

  it("rejects a non-numeric or empty timestamp outright", async () => {
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: "not-a-number",
      signatureHeader: "v1,AAAA",
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(false);
    expect(await verifyWebhookSignature({
      webhookId: "msg_1",
      timestamp: " ",
      signatureHeader: "v1,AAAA",
      rawBody: body,
      secret: "whsec_test",
      now: NOW_MS,
    })).toBe(false);
  });
});

describe("parseWebhookEnvelope", () => {
  it("parses a trigger envelope and routes by workshop- user_id", () => {
    const result = parseWebhookEnvelope(triggerEnvelope());
    expect(result).toEqual({
      ok: true,
      event: {
        kind: "trigger",
        eventId: "evt_1",
        upstreamTriggerId: "ti_123",
        triggerSlug: "github_issue_opened",
        routedAccountId: "0a1b2c3d-e4f5-6a7b-8c9d-0e1f2a3b4c5d",
        data: { subject: "hello" },
        timestamp: "2026-01-01T00:00:00Z",
      },
    });
  });

  it("refuses a trigger envelope whose user_id is not one of ours", () => {
    const result = parseWebhookEnvelope(triggerEnvelope({
      metadata: { trigger_id: "ti_123", trigger_slug: "s", user_id: "someone-else" },
    }));
    expect(result).toEqual({ ok: false, error: "unroutable_trigger" });
  });

  it("refuses a trigger envelope without metadata fields", () => {
    expect(parseWebhookEnvelope(triggerEnvelope({ metadata: {} }))).toEqual({
      ok: false,
      error: "unroutable_trigger",
    });
    expect(parseWebhookEnvelope(triggerEnvelope({ metadata: "nope" }))).toEqual({
      ok: false,
      error: "missing_metadata",
    });
  });

  it("parses a connected_account_expired envelope with and without user_id", () => {
    const withUser = parseWebhookEnvelope(JSON.stringify({
      id: "evt_2",
      type: "composio.connected_account.expired",
      timestamp: "2026-01-01T00:00:00Z",
      data: {
        id: "ca_9",
        user_id: `${ACCOUNT_USER_ID_PREFIX}0a1b2c3d-e4f5-6a7b-8c9d-0e1f2a3b4c5d`,
        status_reason: "token_refresh_failed",
        toolkit: { slug: "github" },
      },
    }));
    expect(withUser.ok && withUser.event.kind === "connected_account_expired"
      && withUser.event.routedAccountId === "0a1b2c3d-e4f5-6a7b-8c9d-0e1f2a3b4c5d"
      && withUser.event.connectedAccountId === "ca_9"
      && withUser.event.toolkitSlug === "github"
      && withUser.event.statusReason === "token_refresh_failed").toBe(true);

    // Upstream may drop the deprecated user_id: parseable, but unroutable.
    const withoutUser = parseWebhookEnvelope(JSON.stringify({
      id: "evt_3",
      type: "composio.connected_account.expired",
      data: { id: "ca_9", toolkit: { slug: "github" } },
    }));
    expect(withoutUser.ok && withoutUser.event.kind === "connected_account_expired"
      && withoutUser.event.routedAccountId === null).toBe(true);
  });

  it("acks unknown event types as unknown", () => {
    const result = parseWebhookEnvelope(JSON.stringify({
      id: "evt_4",
      type: "composio.something.new",
    }));
    expect(result).toEqual({ ok: true, event: { kind: "unknown", eventId: "evt_4", type: "composio.something.new" } });
  });

  it("refuses malformed bodies with fixed reasons", () => {
    expect(parseWebhookEnvelope("not json")).toEqual({ ok: false, error: "invalid_json" });
    expect(parseWebhookEnvelope("[1,2]")).toEqual({ ok: false, error: "not_an_object" });
    expect(parseWebhookEnvelope("{}")).toEqual({ ok: false, error: "missing_id" });
    expect(parseWebhookEnvelope(JSON.stringify({ id: "x" }))).toEqual({
      ok: false,
      error: "missing_type",
    });
  });

  it("refuses an oversized envelope before parsing", () => {
    expect(parseWebhookEnvelope("x".repeat(MAX_ENVELOPE_BYTES + 1))).toEqual({
      ok: false,
      error: "envelope_too_large",
    });
  });
});

describe("accountIdForUserValue", () => {
  it("strips the prefix only from strings that carry it", () => {
    expect(accountIdForUserValue(`${ACCOUNT_USER_ID_PREFIX}abc`)).toBe("abc");
    expect(accountIdForUserValue("workshop-")).toBeNull();
    expect(accountIdForUserValue("other-abc")).toBeNull();
    expect(accountIdForUserValue(123)).toBeNull();
  });
});

describe("webhookSubscriptionUrl", () => {
  it("builds from BASE_URL including its base path", () => {
    expect(webhookSubscriptionUrl({
      BASE_URL: "https://gadgets.example.com/gk/composio",
    })).toBe("https://gadgets.example.com/gk/composio/webhook");
  });

  it("prefers the WEBHOOK_ORIGIN dev override, keeping BASE_URL's base path (github precedent)", () => {
    expect(webhookSubscriptionUrl({
      BASE_URL: "http://localhost:8787/somewhere",
      WEBHOOK_ORIGIN: "https://tunnel.example.com",
    })).toBe("https://tunnel.example.com/somewhere/webhook");
  });

  it("throws without an https origin", () => {
    expect(() => webhookSubscriptionUrl({})).toThrow(/https webhook origin/);
    expect(() => webhookSubscriptionUrl({ BASE_URL: "http://plain.example.com" })).toThrow(
      /https webhook origin/,
    );
  });
});
