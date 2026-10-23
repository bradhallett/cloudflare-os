// The enrichment outcome classes: a definitive answer (4xx) fails the action for good; an
// unknown outcome (lost answer or 5xx) stores "unknown", reports it, blocks re-execution without
// another dispatch, and survives rejection — only the owner may conclude otherwise. The daily
// limit is 1 in this suite, which the single dispatch of each scenario stays within.


import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE, FakeZoomInfo, failure, hooks, seedAccount, unwrap } from "./fake-zoominfo";

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = (id: string) => ({ userObjectId: id });

type Ticket = { id: number };
type StoredOutcome = { status: "pending" | "ready" | "failed" | "unknown"; message?: string };

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
    unwrap(await hooks().applyAction("enrich-400", props(id), ticket.id));
    const stored = unwrap(await hooks().run("enrich-400", props(id), [
      ["getEnrichmentResult", ticket],
    ])) as StoredOutcome;
    expect(stored.status).toBe("failed");
    expect(zi.enrichRequests).toBe(1);
  });
});
