import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearGatekeeperImplProps } from "../../src/linear";
import {
  ACME, FakeLinear, failure, hooks, seedAccount, unwrap,
} from "./fake-linear";

afterEach(() => vi.unstubAllGlobals());

describe("legacy kv upgrade", () => {
  /** A gatekeeper facet seeded with the pre-engine storage shape of an existing deployment. */
  async function legacyFacet(entries: Record<string, unknown>) {
    const x = new FakeLinear().install();
    const userObjectId = await seedAccount(x);
    const props: LinearGatekeeperImplProps = {
      userObjectId, workspaceUrlKey: ACME.urlKey, resourceKind: "workspace",
    };
    // The fake only knows auth/viewer queries; answer the create the apply dispatches.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      x.requests.push({ method: "POST", url, body });
      if (body.includes("IssueCreateInput")) {
        return new Response(
          JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "issue-legacy-3", identifier: "ACME-3", team: { id: "team-1" } } } } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return await baseFetch(input, init);
    });
    await hooks().seedGatekeeper("legacy", props, entries);
    return { x, props };
  }

  it("keeps a legacy pending action decidable and adopts the last-issued counter", async () => {
    // Pre-engine shape: `counter:action` held the LAST issued id (3), and rows carry `status`
    // with no journal envelope. Action 3 is pending; action 2 died mid-dispatch (claimed).
    const legacyPending = {
      id: 3, kind: "createIssue", status: "pending",
      input: { teamId: "team-1", title: "Legacy" }, provisionalId: "~3", title: "Legacy",
    };
    const legacyClaimed = {
      id: 2, kind: "createIssue", status: "claimed",
      input: { teamId: "team-1", title: "Claimed" }, provisionalId: "~2", title: "Claimed",
    };
    const { x, props } = await legacyFacet({
      "counter:action": 3, "action:3": legacyPending, "action:2": legacyClaimed,
    });

    // The legacy pending action is still decidable: applying it dispatches the create.
    unwrap(await hooks().applyGatekeeperAction("legacy", props, 3));
    expect(x.requests.filter(r => (r.body ?? "").includes("issueCreate"))).toHaveLength(1);
    // The engine retained the applied record (for revert) and bound the provisional id.
    expect(await hooks().gatekeeperEntry("legacy", props, "retained:action:3"))
      .toMatchObject({ state: "applied" });
    expect(await hooks().gatekeeperEntry("legacy", props, "provisional:~3"))
      .toEqual(expect.any(String));

    // The counter was adopted from last-issued to next-unused: binding advanced it past id 3.
    expect(await hooks().gatekeeperEntry("legacy", props, "counter:action")).toBe(4);

    // The legacy claimed row upgrades to nothing: apply refuses without re-dispatching (the
    // write's outcome was unknown), and a rejection settles the id the overseer holds. The
    // inert raw row itself stays (the journal never claimed it), but it holds no pending slot
    // and never projects again.
    expect(failure(await hooks().applyGatekeeperAction("legacy", props, 2)))
      .toBe("Unknown pending action: 2");
    expect(x.requests.filter(r => (r.body ?? "").includes("issueCreate"))).toHaveLength(1);
    unwrap(await hooks().rejectGatekeeperAction("legacy", props, 2));
  });
});
