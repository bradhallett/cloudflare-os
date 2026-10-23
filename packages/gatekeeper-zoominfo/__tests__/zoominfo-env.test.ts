import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_READ_LIMIT, dailyReadLimit } from "../src/zoominfo-env";

describe("dailyReadLimit", () => {
  it("defaults when unset or blank", () => {
    expect(dailyReadLimit({})).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit({ ZOOMINFO_DAILY_READ_LIMIT: "" })).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit({ ZOOMINFO_DAILY_READ_LIMIT: "  " })).toBe(DEFAULT_DAILY_READ_LIMIT);
  });

  it("reads a configured limit", () => {
    expect(dailyReadLimit({ ZOOMINFO_DAILY_READ_LIMIT: "7" })).toBe(7);
  });

  it("removes the limit at zero", () => {
    expect(dailyReadLimit({ ZOOMINFO_DAILY_READ_LIMIT: "0" })).toBeNull();
  });

  it.each(["-1", "1.5", "not-a-number", "1e3", `${Number.MAX_SAFE_INTEGER + 1}`])(
    "falls back to the default on %s",
    raw => {
      expect(dailyReadLimit({ ZOOMINFO_DAILY_READ_LIMIT: raw })).toBe(DEFAULT_DAILY_READ_LIMIT);
    });
});
