import { describe, expect, it } from "vitest";
import {
  CONNECT_LINK_CALLBACK_PATH,
  DEFAULT_DAILY_CALL_LIMIT,
  META_TOOL_SLUGS,
  API_BASE,
  VENDOR_ID,
  dailyCallLimit,
  deploymentApiKey,
  isMetaTool,
} from "../src/config.js";

describe("meta-tool slug registry", () => {
  it("holds exactly the five locked meta-tool slugs", () => {
    expect([...META_TOOL_SLUGS]).toEqual([
      "COMPOSIO_REMOTE_BASH_TOOL",
      "COMPOSIO_REMOTE_WORKBENCH",
      "COMPOSIO_MANAGE_CONNECTIONS",
      "COMPOSIO_SEARCH_TOOLS",
      "MULTI_EXECUTE_TOOL",
    ]);
  });

  it("matches every registered slug exactly", () => {
    for (const slug of META_TOOL_SLUGS) expect(isMetaTool(slug)).toBe(true);
  });

  it("refuses lookalikes: wrong suffix, casing, and ordinary tool slugs", () => {
    // The plan's exact trap: COMPOSIO_REMOTE_BASH is NOT the refused slug.
    expect(isMetaTool("COMPOSIO_REMOTE_BASH")).toBe(false);
    expect(isMetaTool("composio_remote_bash_tool")).toBe(false);
    expect(isMetaTool("GITHUB_CREATE_ISSUE")).toBe(false);
    expect(isMetaTool("")).toBe(false);
  });
});

describe("config constants", () => {
  it("fixes the vendor identity and API base", () => {
    expect(VENDOR_ID).toBe("composio");
    expect(API_BASE).toBe("https://backend.composio.dev/api/v3.1");
    expect(DEFAULT_DAILY_CALL_LIMIT).toBe(500);
    expect(CONNECT_LINK_CALLBACK_PATH).toBe("/gatekeeper/composio/connect-callback");
  });
});

describe("deploymentApiKey", () => {
  it("returns the key when set", () => {
    expect(deploymentApiKey({ COMPOSIO_API_KEY: "sk-live" })).toBe("sk-live");
  });

  it("fails closed when unset, empty, or blank", () => {
    expect(() => deploymentApiKey({})).toThrow(/COMPOSIO_API_KEY/);
    expect(() => deploymentApiKey({ COMPOSIO_API_KEY: "" })).toThrow(/COMPOSIO_API_KEY/);
    expect(() => deploymentApiKey({ COMPOSIO_API_KEY: "   " })).toThrow(/COMPOSIO_API_KEY/);
  });

  it("never includes the value in the thrown error", () => {
    try {
      deploymentApiKey({ COMPOSIO_API_KEY: "" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("COMPOSIO_API_KEY=");
    }
  });
});

describe("dailyCallLimit", () => {
  it("defaults to 500 when unset or blank", () => {
    expect(dailyCallLimit({})).toBe(DEFAULT_DAILY_CALL_LIMIT);
    expect(dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "  " })).toBe(DEFAULT_DAILY_CALL_LIMIT);
  });

  it("parses an explicit override", () => {
    expect(dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "25" })).toBe(25);
  });

  it("rejects non-integer and non-positive values", () => {
    expect(() => dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "abc" })).toThrow();
    expect(() => dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "1.5" })).toThrow();
    expect(() => dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "0" })).toThrow();
    expect(() => dailyCallLimit({ COMPOSIO_DAILY_CALL_LIMIT: "-3" })).toThrow();
  });
});
