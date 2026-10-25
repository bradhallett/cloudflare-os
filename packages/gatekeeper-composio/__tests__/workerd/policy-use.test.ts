// Use-time policy enforcement and the review-round hardening: the singleton minted under an
// admin policy hides and refuses excluded toolkits at call time (not just at mint), a facet
// minted *before* an exclusion stops working and stops offering auto-apply once the exclusion
// lands, sessions are created with Composio's server-side require_approval fence, a definite
// pre-execution 4xx settles as refused-but-dispatched-not, answering rounds are single-use under
// concurrency, elicitation text is bounded, and the admin slug validator caps its input.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { githubSpec, READ_TOOL, WRITE_TOOL, type FakeExecute } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");
const completed: FakeExecute[] = [{ resultType: "completed", result: null }];

/** The fake surface with a second toolkit (linear) beside github. */
function twoToolkitSpec(executes: FakeExecute[]) {
  const spec = githubSpec(executes);
  return {
    ...spec,
    toolkits: [
      ...spec.toolkits,
      { slug: "linear", name: "Linear", description: "Linear tools" },
    ],
    tools: {
      ...spec.tools,
      linear: [
        { slug: "LINEAR_GET_ISSUE", name: "Get Linear issue", tags: [], read_only_hint: true },
      ],
    },
  };
}

afterEach(() => hooks.installFake(null));

describe("singleton policy enforcement", () => {
  it("hides and refuses excluded toolkits at use time; unlisted ones work", async () => {
    hooks.installFake(twoToolkitSpec(completed));
    await expect(hooks.provisionOwnKey("pol-single", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await hooks.singletonSession("pol-single", "single", {
      excludedToolkits: ["github"],
      autoApplyToolkits: [],
    });
    expect(await hooks.policyState("pol-single")).toEqual({
      excludedToolkits: ["github"],
      autoApplyToolkits: [],
    });

    // Excluded: absent from the listing, unknown as a tool, refused as a dispatch.
    const listed = await hooks.listToolkits("single");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.toolkits.map(t => t.slug)).toEqual(["linear"]);
    }
    const githubRead = await hooks.callTool("single", READ_TOOL);
    expect(githubRead.ok).toBe(false);
    if (!githubRead.ok) {
      expect(githubRead.message).toContain(`no tool named "${READ_TOOL}"`);
    }

    // Unlisted toolkits are untouched.
    const linearRead = await hooks.callTool("single", "LINEAR_GET_ISSUE");
    expect(linearRead.ok).toBe(true);
    if (linearRead.ok) expect(linearRead.value.status).toBe("ok");

    // The catalog assembled in one /toolkits sweep and one unfiltered /tools sweep.
    expect(await hooks.getCounts()).toEqual({ toolkits: 1, tools: 1 });
  });

  it("creates sessions with the require_approval fence and the auto-apply exemption", async () => {
    hooks.installFake(twoToolkitSpec(completed));
    await expect(hooks.provisionOwnKey("pol-fence", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await hooks.singletonSession("pol-fence", "fenced", {
      excludedToolkits: [],
      autoApplyToolkits: ["github"],
    });
    const read = await hooks.callTool("fenced", READ_TOOL);
    expect(read.ok).toBe(true);

    const sessions = await hooks.sessionCalls();
    expect(sessions).toHaveLength(1);
    // Session-wide fence over the non-read tags...
    expect(sessions[0]?.requireApproval)
      .toEqual(["createHint", "updateHint", "destructiveHint"]);
    // ...with the admin-listed auto-apply toolkit exempted down to the destructive tag only.
    expect(sessions[0]?.toolsOverride).toEqual([["github", ["destructiveHint"]]]);
  });

  it("omits the tools override entirely when no toolkit is auto-apply listed", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("pol-nofence", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    await hooks.singletonSession("pol-nofence", "plain", {
      excludedToolkits: [],
      autoApplyToolkits: [],
    });
    const read = await hooks.callTool("plain", READ_TOOL);
    expect(read.ok).toBe(true);

    const [session] = await hooks.sessionCalls();
    expect(session?.requireApproval)
      .toEqual(["createHint", "updateHint", "destructiveHint"]);
    expect(session?.toolsOverride).toBeNull();
  });
});

describe("use-time exclusion re-check", () => {
  it("stops a facet minted before the exclusion from working and auto-applying", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("pol-recheck", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    // Armed before any exclusion existed.
    await hooks.toolkitSession("pol-recheck", "stale", {
      toolkitSlug: "github", autoApply: true,
    });
    await expect(hooks.autoApprovableActions("stale")).resolves.toEqual([
      { kind: "composio:github:write", label: "all current and future write tools in GitHub" },
    ]);

    // The exclusion lands through the singleton mint, the kernel's refresh channel.
    await hooks.singletonSession("pol-recheck", "refresh", {
      excludedToolkits: ["github"],
      autoApplyToolkits: ["github"],
    });

    await expect(hooks.autoApprovableActions("stale")).resolves.toEqual([]);
    const queued = await hooks.callTool("stale", WRITE_TOOL, { repo: "acme/api" });
    expect(queued.ok).toBe(false);
    if (!queued.ok) {
      // Hidden, as D1 settled: to the agent an excluded toolkit's tools do not exist.
      expect(queued.message).toContain(`no tool named "${WRITE_TOOL}"`);
    }
    await expect(hooks.pendingActionCount("stale")).resolves.toBe(0);
  });
});

describe("definite pre-execution 4xx", () => {
  it("settles as refused-not-dispatched, retryable, with the reservation released", async () => {
    hooks.installFake(githubSpec([{ status: 422, error: "bad arguments" }]));
    await expect(hooks.provisionOwnKey("pol-4xx", "own-1"))
      .resolves.toEqual({ ok: true, value: null });
    await hooks.toolkitSession("pol-4xx", "tool", { toolkitSlug: "github" });

    const queued = await hooks.callTool("tool", WRITE_TOOL, { repo: "acme/api" });
    expect(queued.ok && queued.value.status).toBe("pending");
    if (!queued.ok || queued.value.status !== "pending") throw new Error("did not queue");
    const actionId = queued.value.actionId;

    const applied = await hooks.applyAction("tool", actionId);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.name).toBe("McpCallNotDispatchedError");
      expect(applied.message).toContain("refused the call before it ran (HTTP 422)");
    }
    // The refusal is terminal for this action and released the quota reservation.
    const failed = await hooks.getActionResult("tool", actionId);
    expect(failed.ok && failed.value.status).toBe("failed");
    const usage = await hooks.usage("pol-4xx");
    expect(usage.own).toEqual({ reserved: 0, settled: 0, refused: 0 });
  });
});

describe("answering rounds under concurrency", () => {
  it("lets exactly one concurrent answer stage; the loser is told it was answered", async () => {
    hooks.installFake(githubSpec([
      {
        resultType: "input_required", requestState: "rs-1",
        inputRequests: [{ id: "q1", question: "Which repository?" }],
      },
      { resultType: "completed", result: null },
    ]));
    await expect(hooks.provisionOwnKey("pol-race", "own-1"))
      .resolves.toEqual({ ok: true, value: null });
    await hooks.toolkitSession("pol-race", "racy", { toolkitSlug: "github" });
    const queued = await hooks.callTool("racy", WRITE_TOOL, { repo: "acme/api" });
    if (!queued.ok || queued.value.status !== "pending") throw new Error("did not queue");

    const applied = await hooks.applyAction("racy", queued.value.actionId);
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error("the action applied instead of asking for input");
    const continuationId = /Input request id "([^"]+)"/.exec(applied.message)?.[1];
    if (continuationId === undefined) throw new Error("no continuation id");

    const answers = await Promise.all([
      hooks.continueTool("racy", continuationId, { q1: "first" }),
      hooks.continueTool("racy", continuationId, { q1: "second" }),
    ]);
    const winners = answers.filter(a => a.ok);
    expect(winners).toHaveLength(1);
    const losers = answers.filter(a => !a.ok);
    expect(losers).toHaveLength(1);
    if (losers[0] !== undefined) {
      expect(losers[0].message).toContain("was already answered");
    }
    // Exactly one answering round was staged (the origin action's retryable failure is spent).
    const { submissions } = await hooks.queueState("racy");
    expect(submissions.filter(s => s.actionKind?.tag === "composio-continue")).toHaveLength(1);
  });
});

describe("elicitation bounds", () => {
  it("truncates oversized questions and drops beyond five", async () => {
    const long = "x".repeat(3 * 1024);
    hooks.installFake(githubSpec([
      {
        resultType: "input_required", requestState: "rs-1",
        inputRequests: [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `q${n}`, question: long })),
      },
      { resultType: "completed", result: null },
    ]));
    await expect(hooks.provisionOwnKey("pol-caps", "own-1"))
      .resolves.toEqual({ ok: true, value: null });
    await hooks.toolkitSession("pol-caps", "capped", { toolkitSlug: "github" });
    const queued = await hooks.callTool("capped", WRITE_TOOL, { repo: "acme/api" });
    if (!queued.ok || queued.value.status !== "pending") throw new Error("did not queue");

    const applied = await hooks.applyAction("capped", queued.value.actionId);
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error("the action applied instead of asking for input");
    const continuationId = /Input request id "([^"]+)"/.exec(applied.message)?.[1];
    if (continuationId === undefined) throw new Error("no continuation id");

    const questions = await hooks.getInputRequest("capped", continuationId);
    expect(questions.ok).toBe(true);
    if (questions.ok) {
      expect(questions.value).toHaveLength(5);
      for (const question of questions.value) {
        expect(new TextEncoder().encode(question.question).byteLength)
          .toBeLessThanOrEqual(2 * 1024);
      }
    }
  });

  it("records no continuation when the request state exceeds 16 KiB", async () => {
    hooks.installFake(githubSpec([
      {
        resultType: "input_required", requestState: "s".repeat(17 * 1024),
        inputRequests: [{ id: "q1", question: "Which repository?" }],
      },
      { resultType: "completed", result: null },
    ]));
    await expect(hooks.provisionOwnKey("pol-state", "own-1"))
      .resolves.toEqual({ ok: true, value: null });
    await hooks.toolkitSession("pol-state", "fat", { toolkitSlug: "github" });
    const queued = await hooks.callTool("fat", WRITE_TOOL, { repo: "acme/api" });
    if (!queued.ok || queued.value.status !== "pending") throw new Error("did not queue");

    const applied = await hooks.applyAction("fat", queued.value.actionId);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.name).toBe("ComposioNotDispatchedError");
      // Terminal, with no continuation id to answer.
      expect(applied.message).not.toContain("getInputRequest");
    }
    const failed = await hooks.getActionResult("fat", queued.value.actionId);
    expect(failed.ok && failed.value.status).toBe("failed");
  });
});

describe("admin slug validation cap", () => {
  it("refuses more than 25 slugs and validates within the cap", async () => {
    hooks.installFake(githubSpec(completed));
    await expect(hooks.provisionOwnKey("pol-cap", "own-1"))
      .resolves.toEqual({ ok: true, value: null });

    const tooMany = await hooks.getToolkitInfo(
      Array.from({ length: 26 }, (_, i) => `slug-${i}`));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toContain("at most 25 toolkit slugs");

    const ok = await hooks.getToolkitInfo(["github", "not-a-toolkit"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual([
        { slug: "github", exists: true, eligibleToolCount: 1, destructiveToolCount: 1 },
        { slug: "not-a-toolkit", exists: false, eligibleToolCount: 0, destructiveToolCount: 0 },
      ]);
    }
  });
});
