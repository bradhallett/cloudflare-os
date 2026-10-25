// Key-mode fencing: the deployment/own key split, the generation counter, the refusal to switch
// keys under queued actions, and the stranding of actions whose generation predates a switch.
// Delete the `pending > 0` check in account.ts's `#switchKeyMode`, or the stranded branch in
// facet.ts's `#dispatch`, and this file fails.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { githubSpec, READ_TOOL, WRITE_TOOL } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");

afterEach(() => hooks.installFake(null));

describe("key mode", () => {
  it("starts in deployment mode, with no deployment key configured in tests", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await expect(hooks.keyState("keys-initial")).resolves.toEqual({
      keyMode: "deployment",
      generation: 1,
      deploymentKeyAvailable: false,
      ownKeySet: false,
    });
  });

  it("refuses reads before any key exists, without reaching Composio", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await hooks.toolkitSession("keys-initial", "no-key", { toolkitSlug: "github" });

    const read = await hooks.callTool("no-key", READ_TOOL, { owner: "octocat" });

    expect(read.ok).toBe(false);
    if (!read.ok) {
      // A read never dispatches, so the refusal is a plain error naming the missing key; only
      // actions that might have dispatched need the not-dispatched error classes.
      expect(read.message).toContain("COMPOSIO_API_KEY is not set");
    }
    expect(await hooks.executeCalls()).toEqual([]);
  });

  it("switches to the owner's own key and back, bumping the generation each way", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: { number: 7 } }]));
    await hooks.toolkitSession("keys-switch", "switch", { toolkitSlug: "github" });

    await expect(hooks.provisionOwnKey("keys-switch", "own-1")).resolves.toEqual({ ok: true, value: null });
    await expect(hooks.keyState("keys-switch")).resolves.toMatchObject({
      keyMode: "own", generation: 2, ownKeySet: true,
    });

    const read = await hooks.callTool("switch", READ_TOOL, { owner: "octocat" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.status).toBe("ok");
    expect(await hooks.executeCalls()).toHaveLength(1);

    await expect(hooks.dropOwnKey("keys-switch")).resolves.toEqual({ ok: true, value: null });
    await expect(hooks.keyState("keys-switch")).resolves.toMatchObject({
      keyMode: "deployment", generation: 3, ownKeySet: false,
    });

    const refused = await hooks.callTool("switch", READ_TOOL, { owner: "octocat" });
    expect(refused.ok).toBe(false);
    expect(await hooks.executeCalls()).toHaveLength(1);
  });

  it("refuses a key switch while an action is queued, and allows it once settled", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await hooks.toolkitSession("keys-fence", "fence", { toolkitSlug: "github" });
    await expect(hooks.provisionOwnKey("keys-fence", "own-1")).resolves.toEqual({ ok: true, value: null });

    const queued = await hooks.callTool("fence", WRITE_TOOL, { repo: "acme/api" });
    expect(queued.ok).toBe(true);
    if (!queued.ok || queued.value.status !== "pending") throw new Error("write tool did not queue");
    const actionId = queued.value.actionId;
    await expect(hooks.pendingActionCount("fence")).resolves.toBe(1);

    const refused = await hooks.provisionOwnKey("keys-fence", "own-2");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("Cannot switch the Composio key while 1 queued");

    await expect(hooks.rejectAction("fence", actionId)).resolves.toEqual({ ok: true, value: null });
    const rejected = await hooks.getActionResult("fence", actionId);
    expect(rejected.ok && rejected.value.status).toBe("rejected");

    await expect(hooks.provisionOwnKey("keys-fence", "own-2")).resolves.toEqual({ ok: true, value: null });
    await expect(hooks.keyState("keys-fence")).resolves.toMatchObject({ keyMode: "own", generation: 3 });
  });

  it("strands an approved action whose staged generation predates the key switch", async () => {
    hooks.installFake(githubSpec([{ resultType: "completed", result: null }]));
    await hooks.toolkitSession("keys-strand", "strand", { toolkitSlug: "github" });
    await expect(hooks.provisionOwnKey("keys-strand", "own-1")).resolves.toEqual({ ok: true, value: null });

    const queued = await hooks.callTool("strand", WRITE_TOOL, { repo: "acme/api" });
    if (!queued.ok || queued.value.status !== "pending") throw new Error("write tool did not queue");
    const actionId = queued.value.actionId;

    // Rewind the staged action's frozen generation to before the own-key switch (generation 2),
    // which is the state a real switch-under-staging race would leave behind.
    await hooks.rewindStagedGeneration("strand", actionId, 1);

    const applied = await hooks.applyAction("strand", actionId);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.name).toBe("McpCallNotDispatchedError");
      expect(applied.message).toContain("The Composio key was switched after this action was approved");
    }
    // Stranded means nothing reached Composio, and the action is spent.
    expect(await hooks.executeCalls()).toEqual([]);
    const failed = await hooks.getActionResult("strand", actionId);
    expect(failed.ok && failed.value.status).toBe("failed");
    await expect(hooks.pendingActionCount("strand")).resolves.toBe(0);
  });
});
