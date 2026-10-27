// The enrichment outcome classes: a definitive answer (4xx) fails the action for good; an
// unknown outcome (lost answer or 5xx) stores "unknown", reports it, blocks re-execution without
// another dispatch, and survives rejection — only the owner may conclude otherwise. The daily
// limit is 1 in this suite, which the single dispatch of each scenario stays within.


import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeZoomInfo, failure, hooks, seedAccount, unwrap } from "./fake-zoominfo";

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = (id: string) => ({ userObjectId: id });

type Ticket = { id: number };
type StoredOutcome = { status: "pending" | "ready" | "failed" | "unknown" | "rejected"; message?: string };

async function submit(facet: string, id: string): Promise<Ticket> {
  const result = await hooks().run(facet, props(id), [
    ["enrichCompanies", [{ companyId: "1001" }], ["id", "name"]],
  ]);
  return unwrap(result) as Ticket;
}

describe("enrichment outcomes", () => {
  it("treats a 5xx answer as unknown: reported, stored, and never re-executed", async () => {
    const zi = new FakeZoomInfo().install();
    zi.failEnrich = 503;
    const id = await seedAccount(zi);
    const ticket = await submit("enrich-500", id);

    const first = await hooks().applyAction("enrich-500", props(id), ticket.id);
    expect(failure(first)).toContain("may or may not have taken effect");
    expect(zi.enrichRequests).toBe(1);

    // The pending action is gone; the stored unknown outcome blocks a second dispatch.
    zi.failEnrich = undefined;
    const second = await hooks().applyAction("enrich-500", props(id), ticket.id);
    expect(failure(second)).toContain("may or may not have taken effect");
    expect(zi.enrichRequests).toBe(1);

    const stored = unwrap(await hooks().run("enrich-500", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(stored.status).toBe("unknown");

    // Rejecting the action cannot conclude what ZoomInfo never answered.
    unwrap(await hooks().rejectAction("enrich-500", props(id), ticket.id));
    const after = unwrap(await hooks().run("enrich-500", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(after.status).toBe("unknown");
  });

  it("treats a lost answer as unknown, keeping the read counted", async () => {
    const zi = new FakeZoomInfo().install();
    zi.failEnrich = "abort";
    const id = await seedAccount(zi);
    const ticket = await submit("enrich-abort", id);
    const applied = await hooks().applyAction("enrich-abort", props(id), ticket.id);
    expect(failure(applied)).toContain("may or may not have taken effect");
    expect(zi.enrichRequests).toBe(1);
    const stored = unwrap(await hooks().run("enrich-abort", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(stored.status).toBe("unknown");
  });

  it("fails the action for good on a definitive answer", async () => {
    const zi = new FakeZoomInfo().install();
    zi.failEnrich = 400;
    const id = await seedAccount(zi);
    const ticket = await submit("enrich-400", id);
    // The apply surfaces the failure (the engine records it terminally; the overseer must not
    // retry a paid call that already answered) and the Gadget reads the recorded outcome.
    expect(failure(await hooks().applyAction("enrich-400", props(id), ticket.id))).toBeTruthy();
    const stored = unwrap(await hooks().run("enrich-400", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(stored.status).toBe("failed");
    expect(zi.enrichRequests).toBe(1);
  });

  it("records a rejection that lands during a refused apply, without ever dispatching (ZC-1)", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi);
    // Spend the day's single read (the limit is 1 in this suite) so the apply stops inside its
    // read reservation -- exactly the await window where a rejection used to be able to land
    // between the pending check and a claim.
    const spent = await hooks().run("claim-budget", props(id), [["searchCompanies", {}]]);
    expect(unwrap(spent)).toBeTruthy();

    const ticket = await submit("claim-race", id);
    const raced = unwrap(await hooks().rejectDuringApply("claim-race", props(id), ticket.id)) as {
      apply: { error?: string };
      rejection: unknown;
    };

    // The refusal answers the apply: nothing was dispatched, so no credits were spent.
    expect(raced.apply.error).toContain("used today's 1 ZoomInfo reads");
    expect(zi.enrichRequests).toBe(0);

    // The engine serializes decisions, so the rejection lands after the refused apply restores
    // the enrichment to pending -- the user's decision is recorded ("rejected" over a dispatch
    // that never ran), and no zombie pending action survives the race.
    expect((raced.rejection as { error?: string }).error).toBeUndefined();
    const stored = unwrap(await hooks().run("claim-race", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(stored.status).toBe("rejected");
    const retry = await hooks().applyAction("claim-race", props(id), ticket.id);
    expect(failure(retry)).toBeTruthy();
    expect(zi.enrichRequests).toBe(0);
  });

  it("refuses a submission past the engine's pending cap instead of queueing it unbounded", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi);
    // Fill the journal's pending slots (default cap 50), all against one gatekeeper instance;
    // submissions dispatch nothing, so none is ever decided or pruned along the way.
    for (let i = 0; i < 50; i++) {
      const result = await hooks().run("cap", props(id), [
        ["enrichCompanies", [{ companyId: `100${i % 10}` }], ["id", "name"]],
      ]);
      expect(unwrap(result)).toBeTruthy();
    }
    const overflow = await hooks().run("cap", props(id), [
      ["enrichCompanies", [{ companyId: "1001" }], ["id", "name"]],
    ]);
    expect(failure(overflow)).toContain("Too many pending actions");
  });
});
