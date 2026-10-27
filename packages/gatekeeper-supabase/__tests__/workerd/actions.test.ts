// The claim-before-apply lifecycle of a queued SQL statement: the claim is durably taken before
// the statement runs, so a dispatch that dies mid-run (restart, lost reply, duplicate approval)
// can never be mistaken for never-run. A run whose outcome cannot be known — the request never
// answered, or Supabase answered 5xx after possibly applying it — is recorded terminally and
// surfaced; only the operator's rejection clears the record. Supabase is faked at `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import type { SupabaseGatekeeperImplProps } from "../../src/supabase";
import { FakeSupabase, seedAccount, hooks, failure, unwrap } from "./fake-supabase";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A gatekeeper facet on a fresh connected account, with one mutating statement staged. */
async function stagedAction(facetName: string) {
  const sb = new FakeSupabase().install();
  const userObjectId = await seedAccount(sb);
  const props: SupabaseGatekeeperImplProps = { userObjectId, resourceKind: "project", ref: "proj-ref" };
  const actionId = await hooks().stageGatekeeperAction(facetName, props, {
    ref: "proj-ref", sql: "insert into t values (1)",
  });
  return { sb, props, actionId };
}

describe("claim-before-apply", () => {
  it("refuses a replayed apply whose claim was left behind, marking it terminally failed", async () => {
    const { sb, props, actionId } = await stagedAction("claim-replay");
    // A dispatch that died after taking the claim: the record still says `claimed`.
    await hooks().claimGatekeeperAction("claim-replay", props, actionId);

    expect(failure(await hooks().applyGatekeeperAction("claim-replay", props, actionId)))
      .toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(sb.queries).toHaveLength(0);
    expect(await hooks().gatekeeperActionRecord("claim-replay", props, actionId))
      .toMatchObject({ state: "failed" });
    // The terminal record answers every later attempt the same way, still without running SQL.
    expect(failure(await hooks().applyGatekeeperAction("claim-replay", props, actionId)))
      .toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(sb.queries).toHaveLength(0);
  });

  it("refuses to reject a claimed action, settling it before an explicit second rejection", async () => {
    const { props, actionId } = await stagedAction("claim-reject");
    await hooks().claimGatekeeperAction("claim-reject", props, actionId);

    expect(failure(await hooks().rejectGatekeeperAction("claim-reject", props, actionId)))
      .toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(await hooks().gatekeeperActionRecord("claim-reject", props, actionId))
      .toMatchObject({ state: "failed" });

    // The operator's explicit second choice — after checking the database — clears the record.
    unwrap(await hooks().rejectGatekeeperAction("claim-reject", props, actionId));
    expect(await hooks().gatekeeperActionRecord("claim-reject", props, actionId)).toBeUndefined();
  });

  it("treats a transport failure as an unknown outcome and never retries the statement", async () => {
    const { sb, props, actionId } = await stagedAction("claim-transport");
    sb.queryFailure = "transport";

    expect(failure(await hooks().applyGatekeeperAction("claim-transport", props, actionId)))
      .toContain(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(sb.queries).toHaveLength(1);
    expect(await hooks().gatekeeperActionRecord("claim-transport", props, actionId))
      .toMatchObject({ state: "failed" });
    // Retrying the settled record answers with the same terminal message, without re-running SQL.
    expect(failure(await hooks().applyGatekeeperAction("claim-transport", props, actionId)))
      .toContain(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(sb.queries).toHaveLength(1);
  });

  it("treats a 5xx answer as an unknown outcome and never retries the statement", async () => {
    const { sb, props, actionId } = await stagedAction("claim-5xx");
    sb.queryFailure = 503;

    expect(failure(await hooks().applyGatekeeperAction("claim-5xx", props, actionId)))
      .toContain(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(sb.queries).toHaveLength(1);
    expect(await hooks().gatekeeperActionRecord("claim-5xx", props, actionId))
      .toMatchObject({ state: "failed" });
  });

  it("returns a 4xx refusal to pending, where a retry succeeds", async () => {
    const { sb, props, actionId } = await stagedAction("claim-4xx");
    sb.queryFailure = 400;

    expect(failure(await hooks().applyGatekeeperAction("claim-4xx", props, actionId))).toContain("query failed");
    expect(await hooks().gatekeeperActionRecord("claim-4xx", props, actionId))
      .toMatchObject({ state: "pending" });

    sb.queryFailure = null;
    unwrap(await hooks().applyGatekeeperAction("claim-4xx", props, actionId));

    expect(sb.queries).toHaveLength(2);
  });

  it("settles a replay of an already-applied action without running the SQL again", async () => {
    const { sb, props, actionId } = await stagedAction("claim-applied");

    unwrap(await hooks().applyGatekeeperAction("claim-applied", props, actionId));
    unwrap(await hooks().applyGatekeeperAction("claim-applied", props, actionId));

    expect(sb.queries).toHaveLength(1);
    expect(await hooks().gatekeeperActionRecord("claim-applied", props, actionId)).toBeUndefined();
  });

  it("refuses to reject an action that already applied", async () => {
    const { props, actionId } = await stagedAction("reject-applied");

    unwrap(await hooks().applyGatekeeperAction("reject-applied", props, actionId));

    // The record retired on apply; rejecting the stale id would erase a revert trail (or worse,
    // answer for a write that landed), so the engine refuses instead of settling silently.
    expect(failure(await hooks().rejectGatekeeperAction("reject-applied", props, actionId)))
      .toBe(`Action ${actionId} is no longer pending.`);
  });
});
