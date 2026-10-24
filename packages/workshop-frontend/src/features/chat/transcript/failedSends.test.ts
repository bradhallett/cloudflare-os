import { describe, expect, it } from "vitest";

import type { FailedSendPayload } from "./failedSends";
import { failedSendFromRejection } from "./failedSends";

const payload: FailedSendPayload = { message: "hello", modelId: "model-a" };

describe("failedSendFromRejection", () => {
  it("records a definitively rejected send with its exact payload and timestamp", () => {
    const timestamp = new Date("2026-01-01T00:00:00Z");
    const record = failedSendFromRejection(7, payload, new Error("send rejected"), () => timestamp);

    expect(record).not.toBeNull();
    expect(record!.chatId).toBe(7);
    expect(record!.timestamp).toBe(timestamp);
    // The payload is what a retry re-sends, so it must be the very arguments that failed.
    expect(record!.payload).toEqual(payload);
  });

  it("gives each record a distinct id", () => {
    const first = failedSendFromRejection(7, payload, new Error("nope"))!;
    const second = failedSendFromRejection(7, payload, new Error("nope"))!;

    expect(first.id).not.toBe(second.id);
  });

  it("records nothing for a transient failure, where the send may still have gone through", () => {
    expect(failedSendFromRejection(7, payload, new Error("Peer closed WebSocket"))).toBeNull();
  });

  it("records nothing for a send that had no chat yet (no transcript to render in)", () => {
    expect(failedSendFromRejection(null, payload, new Error("send rejected"))).toBeNull();
  });
});
