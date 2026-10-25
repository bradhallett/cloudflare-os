// The observer-consent fence: nobody is admitted without the owner's explicit sharing consent
// (fail-closed, whatever the verifier says), sharing cannot be enabled while auto-apply is armed,
// and an armed facet stops auto-applying while sharing is on. Delete the consent check in
// account.ts's admitObserver, the armed check in setSharingEnabled, or the sharing read in
// facet.ts's getAutoApprovableActions, and this file fails.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { githubSpec } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");

afterEach(() => hooks.installFake(null));

describe("observer consent", () => {
  it("admits nobody without the owner's explicit sharing consent", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await hooks.toolkitSession("consent-1", "consent-1-facet", { toolkitSlug: "github" });

    const admitted = await hooks.addObserver("consent-1-facet", "observer-1");
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) {
      expect(admitted.message).toContain("has not enabled observer sharing for Composio");
    }
    await expect(hooks.sharingState("consent-1")).resolves.toEqual({ enabled: false, count: 0 });
  });

  it("admits under the owner's consent, and forgetting is idempotent", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await hooks.toolkitSession("consent-2", "consent-2-facet", { toolkitSlug: "github" });
    await expect(hooks.setSharing("consent-2", true)).resolves.toEqual({ ok: true, value: null });

    await expect(hooks.addObserver("consent-2-facet", "observer-1"))
      .resolves.toEqual({ ok: true, value: null });
    await expect(hooks.sharingState("consent-2")).resolves.toEqual({ enabled: true, count: 1 });

    await expect(hooks.removeObserver("consent-2-facet", "observer-1"))
      .resolves.toEqual({ ok: true, value: null });
    await expect(hooks.sharingState("consent-2")).resolves.toEqual({ enabled: true, count: 0 });

    // Forgetting an unknown observer is a no-op, not an error.
    await expect(hooks.removeObserver("consent-2-facet", "observer-1"))
      .resolves.toEqual({ ok: true, value: null });
  });

  it("refuses to enable sharing while auto-apply is armed", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    // Arming listings read the toolkit catalog, which needs a key: provision the owner's own.
    await expect(hooks.provisionOwnKey("consent-3", "own-1"))
      .resolves.toEqual({ ok: true, value: null });
    await hooks.toolkitSession("consent-3", "consent-3-facet", {
      toolkitSlug: "github", autoApply: true,
    });
    // The armed facet really does list auto-apply actions first.
    await expect(hooks.autoApprovableActions("consent-3-facet")).resolves.toHaveLength(1);

    const enabled = await hooks.setSharing("consent-3", true);
    expect(enabled.ok).toBe(false);
    if (!enabled.ok) {
      expect(enabled.message)
        .toContain("Observer sharing cannot be enabled while auto-apply is armed for: github");
    }
    await expect(hooks.sharingState("consent-3")).resolves.toEqual({ enabled: false, count: 0 });
  });

  it("stops an armed facet from auto-applying while sharing is on", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    // Enable sharing while nothing is armed...
    await hooks.toolkitSession("consent-4", "consent-4-calm", { toolkitSlug: "github" });
    await expect(hooks.setSharing("consent-4", true)).resolves.toEqual({ ok: true, value: null });

    // ...then arm a facet anyway: the sharing fence inside the facet disarms its listings.
    await hooks.toolkitSession("consent-4", "consent-4-armed", {
      toolkitSlug: "github", autoApply: true,
    });
    await expect(hooks.autoApprovableActions("consent-4-armed")).resolves.toEqual([]);
  });
});
