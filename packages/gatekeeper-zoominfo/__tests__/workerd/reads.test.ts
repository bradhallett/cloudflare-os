// The daily read cap: a session read spends budget; past the limit the read is refused without
// reaching ZoomInfo; a lost answer still counts (the request may have been spent); and a settled
// unspent reservation gives the budget back. `ZOOMINFO_DAILY_READ_LIMIT` is 1 in this suite.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE, FakeZoomInfo, accountStub, failure, hooks, seedAccount } from "./fake-zoominfo";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Reads = { day: string; used: number };

async function storedReads(userObjectId: string): Promise<Reads | undefined> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<Reads>("reads"));
}

const props = (id: string) => ({ userObjectId: id });

describe("the daily read limit", () => {
  it("refuses the read after the day's budget is spent, without calling ZoomInfo", async () => {
    const zi = new FakeZoomInfo().install();
    const id = await seedAccount(zi, ALICE);
    const first = await hooks().run(`reads-1`, props(id), [["searchCompanies", {}]]);
    expect(unwrap(first)).toBeTruthy();
    expect(zi.tokens.has(`zi-access-${ALICE.sub}`)).toBe(true);

    const second = await hooks().run(`reads-2`, props(id), [["searchCompanies", {}]]);
    expect(failure(second)).toContain("used today's 1 ZoomInfo reads");
    expect(failure(second)).toContain("limit resets at");
    // The refusal was counted as no further spend.
    expect(await storedReads(id)).toEqual({ day: new Date().toISOString().slice(0, 10), used: 1 });
  });

  it("keeps the read counted when the answer was lost — it may have been spent", async () => {
    const zi = new FakeZoomInfo().install();
    zi.failEnrich = "abort";
    const id = await seedAccount(zi, ALICE);
    // A lost enrichment dispatch: unknown outcome, reservation kept.
    const lost = await hooks().run(`lost-1`, props(id), [
      ["enrichCompanies", [{ companyId: "1001" }], ["id", "name"]],
    ]);
    const ticket = unwrap(lost) as { id: number };
    expect(ticket).toBeTruthy();
    const applied = await hooks().applyAction(`lost-1`, props(id), ticket.id);
    expect(failure(applied)).toContain("may or may not have taken effect");
    expect(await storedReads(id)).toEqual({ day: new Date().toISOString().slice(0, 10), used: 1 });
  });

  it("keeps the read counted when ZoomInfo answered 5xx — the request reached it", async () => {
    const zi = new FakeZoomInfo().install();
    zi.failEnrich = 503;
    const id = await seedAccount(zi, ALICE);
    const submitted = await hooks().run(`reads-5xx`, props(id), [
      ["enrichCompanies", [{ companyId: "1001" }], ["id", "name"]],
    ]);
    const ticket = unwrap(submitted) as { id: number };
    const applied = await hooks().applyAction(`reads-5xx`, props(id), ticket.id);
    expect(failure(applied)).toContain("may or may not have taken effect");
    // A 5xx answer proves ZoomInfo received (and counted) the request, so the budget settles it
    // as spent exactly like a lost answer.
    expect(await storedReads(id)).toEqual({ day: new Date().toISOString().slice(0, 10), used: 1 });
  });

  it("returns an unspent reservation's budget", async () => {
    const id = await seedAccount(new FakeZoomInfo(), ALICE);
    const day = new Date().toISOString().slice(0, 10);
    const reserved = unwrap(await hooks().account(id, "reserveRead")) as { ok: true; day: string };
    expect(reserved.day).toBe(day);
    unwrap(await hooks().account(id, "settleRead", reserved.day, false));
    expect(await storedReads(id)).toEqual({ day, used: 0 });
  });
});

function unwrap<T>(outcome: { ok: T } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}
