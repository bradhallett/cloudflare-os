import { describe, expect, it } from "vitest";
import { ZoomInfoApiError, ZoomInfoTransportError, isOutcomeUnknown } from "../../src/zoominfo-api";

describe("isOutcomeUnknown", () => {
  it("counts a lost answer as unknown", () => {
    expect(isOutcomeUnknown(new ZoomInfoTransportError("fetch failed"))).toBe(true);
  });

  it("counts a 5xx answer as unknown — the request reached ZoomInfo", () => {
    expect(isOutcomeUnknown(new ZoomInfoApiError(500, "internal"))).toBe(true);
    expect(isOutcomeUnknown(new ZoomInfoApiError(503, "unavailable"))).toBe(true);
  });

  it("counts a definitive answer, including a refusal, as known", () => {
    expect(isOutcomeUnknown(new ZoomInfoApiError(400, "bad request"))).toBe(false);
    expect(isOutcomeUnknown(new ZoomInfoApiError(401, "unauthorized"))).toBe(false);
    expect(isOutcomeUnknown(new ZoomInfoApiError(429, "rate limited"))).toBe(false);
    expect(isOutcomeUnknown(new Error("anything else"))).toBe(false);
    expect(isOutcomeUnknown(undefined)).toBe(false);
  });
});

describe("ZoomInfoTransportError", () => {
  it("carries its cause", () => {
    const cause = new TypeError("network");
    const error = new ZoomInfoTransportError("fetch failed", { cause });
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("ZoomInfoTransportError");
  });
});
