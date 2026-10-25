// The input_required continuation lifecycle: the failed-but-retryable origin action whose error
// names the continuation id, getInputRequest()'s questions, the never-auto-approvable answering
// rounds, single use, the three-round chain cap, and the one-hour expiry that declines the call
// upstream. Delete the continuation recording in facet.ts's `#dispatch`, the cap or TTL checks,
// or the autoApprovable: false in session.ts's continueTool, and this file fails.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { githubSpec, WRITE_TOOL } from "./fake.js";

const hooks = env.TEST_HOOKS.getByName("hooks");

/** One continuation row, as the facet DO's storage holds it. */
type ContinuationRow = {
  continuation_id: string; action_id: number; origin_action_id: number;
  state: string; chain_depth: number; request_state: string; generation: number;
};

/** The continuation rows of one facet, read through the facet's gated test hooks (a facet-space
 * DO id is not addressable from the test's namespace binding). */
async function rows(facetName: string): Promise<ContinuationRow[]> {
  return await hooks.continuationRows(facetName) as ContinuationRow[];
}

/** Pulls the continuation id a failed action's message names. */
function continuationIdOf(message: string): string {
  const found = /Input request id "([^"]+)"/.exec(message);
  if (found === null) throw new Error(`no continuation id in: ${message}`);
  return found[1];
}

/** Approves `action`, expecting the input_required settlement, and returns the continuation id. */
async function applyExpectingInput(facetName: string, action: number): Promise<string> {
  const applied = await hooks.applyAction(facetName, action);
  expect(applied.ok).toBe(false);
  if (!applied.ok) {
    expect(applied.name).toBe("ComposioNotDispatchedError");
    expect(applied.message).toContain("waiting for input");
    return continuationIdOf(applied.message);
  }
  throw new Error("the action applied instead of asking for input");
}

/** Opens an own-keyed github session on a fresh facet and returns the first write's action id. */
async function queueWrite(accountName: string, facetName: string): Promise<number> {
  await expect(hooks.provisionOwnKey(accountName, "own-1"))
    .resolves.toEqual({ ok: true, value: null });
  await hooks.toolkitSession(accountName, facetName, { toolkitSlug: "github" });
  const queued = await hooks.callTool(facetName, WRITE_TOOL, { repo: "acme/api" });
  if (!queued.ok || queued.value.status !== "pending") {
    throw new Error(`write tool did not queue: ${JSON.stringify(queued)}`);
  }
  return queued.value.actionId;
}

afterEach(() => hooks.installFake(null));

describe("input_required continuation", () => {
  it("records the questions, settles the answer round, and is single-use", async () => {
    hooks.installFake(githubSpec([
      {
        resultType: "input_required", requestState: "rs-1",
        inputRequests: [
          { id: "q1", question: "Which repository should the issue target?" },
          { id: "q2", question: "What title\r\nshould it have?" },
        ],
      },
      { resultType: "completed", result: { issue: 42 } },
    ]));
    const action = await queueWrite("cont-1", "cont-1-facet");

    const { submissions } = await hooks.queueState("cont-1-facet");
    expect(submissions).toHaveLength(1);
    expect(submissions[0].actionKind?.tag).toBe("composio:github:write");
    expect(submissions[0].implementsRevert).toBe(false);
    expect(submissions[0].awaitDecision).toBe(true);
    expect(submissions[0].autoApprovable).not.toBe(true);

    const continuationId = await applyExpectingInput("cont-1-facet", action);

    // The origin action settled failed (retryable), and the row is open with round 1 recorded.
    const failed = await hooks.getActionResult("cont-1-facet", action);
    expect(failed.ok && failed.value.status).toBe("failed");
    if (failed.ok && failed.value.status === "failed") {
      expect(failed.value.message).toContain(`getInputRequest("${continuationId}")`);
    }
    const [row] = await rows("cont-1-facet");
    expect(row).toMatchObject({
      action_id: action, origin_action_id: action, state: "open",
      chain_depth: 1, request_state: "rs-1",
    });

    // The questions come back flattened, as an authorized observation.
    const questions = await hooks.getInputRequest("cont-1-facet", continuationId);
    expect(questions.ok).toBe(true);
    if (questions.ok) {
      expect(questions.value).toEqual([
        { id: "q1", question: "Which repository should the issue target?" },
        { id: "q2", question: "What title should it have?" },
      ]);
    }
    const { observations } = await hooks.queueState("cont-1-facet");
    // The questions cross as verbatim fields of the whole-binding observation.
    const fieldsJson = observations.at(-1)?.fieldsJson ?? "[]";
    expect(fieldsJson).toContain("Which repository should the issue target?");
    expect(fieldsJson).toContain("What title should it have?");

    // Answering queues a fresh approval-gated action that can never be auto-approved.
    const answering = await hooks.continueTool(
      "cont-1-facet", continuationId, { q1: "acme/api", q2: "Ship it" });
    expect(answering.ok).toBe(true);
    if (!answering.ok || answering.value.status !== "pending") {
      throw new Error("answering round did not queue");
    }
    const round = answering.value.actionId;
    const { submissions: after } = await hooks.queueState("cont-1-facet");
    expect(after[1]).toMatchObject({
      action: round,
      autoApprovable: false,
      implementsRevert: false,
      awaitDecision: true,
      actionKind: { tag: "composio-continue" },
    });

    // Approving the round replays the call with the request state and the answers.
    await expect(hooks.applyAction("cont-1-facet", round)).resolves.toEqual({ ok: true, value: null });
    const [, answered] = await hooks.executeCalls();
    expect(answered).toMatchObject({
      tool: WRITE_TOOL,
      requestState: "rs-1",
      inputResponses: { q1: "acme/api", q2: "Ship it" },
      action: null,
    });
    const settled = await hooks.getActionResult("cont-1-facet", round);
    expect(settled.ok && settled.value.status).toBe("ok");
    await expect(rows("cont-1-facet")).resolves.toEqual([]);

    // The continuation was spent by its answering round.
    const again = await hooks.continueTool("cont-1-facet", continuationId, { q1: "x", q2: "y" });
    expect(again.ok).toBe(false);
    // The spent continuation's row is gone, so a replay is refused as unknown — single-use holds.
    if (!again.ok) expect(again.message).toContain("No Composio input request with id");
  });

  it("caps the chain at three answering rounds", async () => {
    hooks.installFake(githubSpec([
      { resultType: "input_required", requestState: "rs-1", inputRequests: [{ id: "q", question: "Again?" }] },
    ]));
    const action = await queueWrite("cont-2", "cont-2-facet");

    let continuationId = await applyExpectingInput("cont-2-facet", action);
    for (let round = 2; round <= 3; round++) {
      const answering = await hooks.continueTool("cont-2-facet", continuationId, { q: "more" });
      if (!answering.ok || answering.value.status !== "pending") {
        throw new Error(`round ${round} did not queue: ${JSON.stringify(answering)}`);
      }
      continuationId = await applyExpectingInput("cont-2-facet", answering.value.actionId);
      const [row] = await rows("cont-2-facet");
      expect(row?.chain_depth).toBe(round);
    }

    // The fourth round's input_required finds the chain capped: no new continuation is recorded,
    // so the failure carries no continuation id and the rows are gone.
    const answering = await hooks.continueTool("cont-2-facet", continuationId, { q: "once more" });
    if (!answering.ok || answering.value.status !== "pending") {
      throw new Error("the capped round did not queue");
    }
    const capped = await hooks.applyAction("cont-2-facet", answering.value.actionId);
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.name).toBe("ComposioNotDispatchedError");
      expect(capped.message).not.toContain('Input request id "');
    }
    await expect(rows("cont-2-facet")).resolves.toEqual([]);
  });

  it("expires unanswered continuations after an hour and declines them upstream", async () => {
    hooks.installFake(githubSpec([
      { resultType: "input_required", requestState: "rs-9", inputRequests: [{ id: "q9", question: "Proceed?" }] },
      { resultType: "completed", result: null },
    ]));
    const action = await queueWrite("cont-3", "cont-3-facet");
    const continuationId = await applyExpectingInput("cont-3-facet", action);

    await hooks.expireContinuations("cont-3-facet");

    const expired = await hooks.getInputRequest("cont-3-facet", continuationId);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.message).toContain("expired (1 hour)");
      expect(expired.message).toContain("The tool call was declined.");
    }

    // The expiry declined the call upstream: a control execute with action "decline".
    const decline = (await hooks.executeCalls()).at(-1);
    expect(decline).toMatchObject({
      tool: WRITE_TOOL, requestState: "rs-9", action: "decline",
      inputResponses: null,
    });
    await expect(rows("cont-3-facet")).resolves.toEqual([]);

    const late = await hooks.continueTool("cont-3-facet", continuationId, { q9: "yes" });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.message).toContain("No Composio input request with id");
  });

  it("declines upstream when an unanswered continuation's action is rejected", async () => {
    hooks.installFake(githubSpec([
      { resultType: "input_required", requestState: "rs-4", inputRequests: [{ id: "q4", question: "Proceed?" }] },
      { resultType: "completed", result: null },
    ]));
    const action = await queueWrite("cont-4", "cont-4-facet");
    const continuationId = await applyExpectingInput("cont-4-facet", action);

    await expect(hooks.rejectAction("cont-4-facet", action)).resolves.toEqual({ ok: true, value: null });

    expect((await hooks.executeCalls()).at(-1)).toMatchObject({
      requestState: "rs-4", action: "decline",
    });
    await expect(rows("cont-4-facet")).resolves.toEqual([]);
    const rejected = await hooks.getActionResult("cont-4-facet", action);
    // The origin action already settled failed (input_required) at apply time; rejecting it now
    // declines upstream and discards the continuation, leaving the failed settlement in place.
    expect(rejected.ok && rejected.value.status).toBe("failed");

    const spent = await hooks.continueTool("cont-4-facet", continuationId, { q4: "yes" });
    expect(spent.ok).toBe(false);
  });
});
