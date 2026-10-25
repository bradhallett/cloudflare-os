// The mint chokepoint: every toolkit facet is minted through ComposioAccount.getGatekeeperClassFor,
// which fails closed on an unconfigured deployment key, an unknown slug, or an admin exclusion —
// and freezes the deployment's policy into the facet's props, so two mints under different
// policies never widen each other. Delete a check in getGatekeeperClassFor, or the arming read in
// facet.ts's getAutoApprovableActions, and this file fails.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { DESTRUCTIVE_TOOL, githubSpec, WRITE_TOOL } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");
const completed = [{ resultType: "completed" as const, result: null }];

afterEach(() => hooks.installFake(null));

describe("mint validation (the account's chokepoint)", () => {
  it("refuses every mint while in deployment mode with no deployment key", async () => {
    hooks.installFake(githubSpec(completed));
    const mint = await hooks.mintCheck("mint-nokey", "composio://toolkit/github");
    expect(mint.ok).toBe(false);
    if (!mint.ok) {
      expect(mint.message).toContain("no Composio project key configured");
    }
  });

  it("validates the slug against the live catalog once a key exists", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("mint-slug", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await expect(hooks.mintCheck("mint-slug", "composio://toolkit/github"))
      .resolves.toEqual({ ok: true, value: null });

    const unknown = await hooks.mintCheck("mint-slug", "composio://toolkit/not-a-toolkit");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("is not a toolkit in Composio's catalog");

    const malformed = await hooks.mintCheck("mint-slug", "https://composio.dev/toolkits");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.message).toContain("is not a Composio toolkit URL");
    }
  });

  it("refuses toolkits the deployment excluded", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("mint-excluded", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    const mint = await hooks.mintCheck("mint-excluded", "composio://toolkit/github", {
      excludedToolkits: ["github"],
      autoApplyToolkits: [],
    });
    expect(mint.ok).toBe(false);
    if (!mint.ok) expect(mint.message).toContain("excluded by this deployment's Composio policy");
  });
});

describe("mint-frozen props", () => {
  it("freezes auto-apply arming at mint time, per facet", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("mint-props", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await hooks.mintedToolkitSession("mint-props", "armed", "composio://toolkit/github", {
      excludedToolkits: [],
      autoApplyToolkits: ["github"],
    });
    const armed = await hooks.autoApprovableActions("armed");
    expect(armed).toEqual([
      { kind: "composio:github:write", label: "all current and future write tools in GitHub" },
    ]);

    await hooks.mintedToolkitSession("mint-props", "calm", "composio://toolkit/github", {
      excludedToolkits: [],
      autoApplyToolkits: [],
    });
    await expect(hooks.autoApprovableActions("calm")).resolves.toEqual([]);
  });

  it("never offers auto-apply for destructive tools", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("mint-props", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    // Arm via the session: the write tool lists, the destructive one does not.
    await hooks.toolkitSession("mint-props", "armed-direct", {
      toolkitSlug: "github", autoApply: true,
    });
    const listed = await hooks.autoApprovableActions("armed-direct");
    expect(listed.map(entry => entry.kind)).toEqual(["composio:github:write"]);

    const queued = await hooks.callTool("armed-direct", DESTRUCTIVE_TOOL, { repo: "acme/api" });
    expect(queued.ok).toBe(true);
    if (queued.ok) expect(queued.value.status).toBe("pending");
    const { submissions } = await hooks.queueState("armed-direct");
    expect(submissions).toHaveLength(1);
    expect(submissions[0].autoApprovable).not.toBe(true);
    expect(submissions[0].actionKind?.tag).toBe("composio:github:write");
  });

  it("serves the ambient singleton, which never auto-applies", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("mint-singleton", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await hooks.singletonSession("mint-singleton", "singleton");
    const described = await hooks.describeFacet("singleton");
    expect(described.url).toBe("composio://toolkits");
    await expect(hooks.autoApprovableActions("singleton")).resolves.toEqual([]);

    // The singleton session reaches every toolkit: its write tools queue like any binding's.
    const queued = await hooks.callTool("singleton", WRITE_TOOL, { repo: "acme/api" });
    expect(queued.ok).toBe(true);
    if (queued.ok) expect(queued.value.status).toBe("pending");
  });
});
