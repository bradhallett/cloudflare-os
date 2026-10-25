import { describe, expect, it } from "vitest";
import {
  CONTINUATION_ACTION_KIND,
  ToolkitPolicy,
  isAutoApplyEligible,
  resolveToolkitPolicy,
  toolkitWriteActionKind,
} from "../src/policy.js";

describe("ToolkitPolicy chokepoint", () => {
  it("allows everything when no lists are configured", () => {
    const policy = resolveToolkitPolicy();
    expect(policy.allows("github")).toBe(true);
    expect(policy.autoApplyListed("github")).toBe(false);
    expect(policy.excludedToolkits).toEqual([]);
    expect(policy.autoApplyToolkits).toEqual([]);
  });

  it("denies excluded slugs by exact match only", () => {
    const policy = resolveToolkitPolicy({
      excludedToolkits: ["github", "google_calendar"],
      autoApplyToolkits: [],
    });
    expect(policy.allows("github")).toBe(false);
    expect(policy.allows("google_calendar")).toBe(false);
    expect(policy.allows("gitlab")).toBe(true);
    // Exact match: prefixes, casing, and whitespace never match.
    expect(policy.allows("github ")).toBe(true);
    expect(policy.allows("my-github")).toBe(true);
  });

  it("EXCLUDED ALWAYS WINS over the auto-apply list", () => {
    const policy = resolveToolkitPolicy({
      excludedToolkits: ["slack"],
      autoApplyToolkits: ["slack", "linear"],
    });
    expect(policy.allows("slack")).toBe(false);
    expect(policy.autoApplyListed("slack")).toBe(false);
    expect(policy.autoApplyListed("linear")).toBe(true);
    // The raw getter still reports the admin's listing; eligibility goes through autoApplyListed.
    expect(policy.autoApplyToolkits).toContain("slack");
  });

  it("resolveToolkitPolicy copies the caller's arrays", () => {
    const excluded = ["a"];
    const policy = resolveToolkitPolicy({ excludedToolkits: excluded, autoApplyToolkits: [] });
    excluded.push("b");
    expect(policy.excludedToolkits).toEqual(["a"]);
  });
});

describe("isAutoApplyEligible", () => {
  const policy = resolveToolkitPolicy({
    excludedToolkits: [],
    autoApplyToolkits: ["notion"],
  });

  it("requires affirmative createHint or updateHint", () => {
    expect(isAutoApplyEligible(policy, "notion", { tags: ["createHint"] })).toBe(true);
    expect(isAutoApplyEligible(policy, "notion", { tags: ["updateHint"] })).toBe(true);
    expect(isAutoApplyEligible(policy, "notion", { tags: ["createHint", "updateHint"] })).toBe(true);
  });

  it("silence never enables: untagged or empty tags queue normally", () => {
    expect(isAutoApplyEligible(policy, "notion", { tags: [] })).toBe(false);
    expect(isAutoApplyEligible(policy, "notion", {})).toBe(false);
    expect(isAutoApplyEligible(policy, "notion", { tags: ["other"] })).toBe(false);
  });

  it("destructiveHint vetoes even with an affirmative hint present", () => {
    expect(isAutoApplyEligible(policy, "notion", { tags: ["createHint", "destructiveHint"] })).toBe(false);
    expect(isAutoApplyEligible(policy, "notion", { tags: ["updateHint", "destructiveHint"] })).toBe(false);
  });

  it("absence of destructiveHint alone never suffices", () => {
    expect(isAutoApplyEligible(policy, "notion", { tags: ["deleteHint"] })).toBe(false);
  });

  it("requires the admin listing and excludes read-only tools", () => {
    expect(isAutoApplyEligible(policy, "slack", { tags: ["createHint"] })).toBe(false);
    expect(isAutoApplyEligible(policy, "notion", { tags: ["createHint"], readOnly: true })).toBe(false);
  });

  it("never eligible for an excluded toolkit even when listed", () => {
    const excluded = resolveToolkitPolicy({
      excludedToolkits: ["notion"],
      autoApplyToolkits: ["notion"],
    });
    expect(isAutoApplyEligible(excluded, "notion", { tags: ["createHint"] })).toBe(false);
  });

  it("ToolkitPolicy can be constructed directly", () => {
    expect(new ToolkitPolicy(["a"], ["b"]).autoApplyListed("b")).toBe(true);
  });
});

describe("action kinds", () => {
  it("emits the per-toolkit write kind", () => {
    expect(toolkitWriteActionKind("linear")).toEqual({ tag: "composio:linear:write" });
  });

  it("fixes the never-armable continuation kind", () => {
    expect(CONTINUATION_ACTION_KIND).toEqual({ tag: "composio-continue" });
  });
});
