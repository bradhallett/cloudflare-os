// The account Durable Object: a connection pinned to the Linear user *and workspace* it was made
// as. A reconnect as anyone else, or into any other workspace, is refused and the new grant
// revoked; a same-user-same-workspace reconnect stages until the Workshop commits it; an account
// connected before pinning existed adopts its first reconnect's user; a first connect records the
// user it was made as. Linear is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import type { LinearGatekeeperImplProps } from "../../src/linear";
import { TestCallback } from "./worker";
import worker from "../../src/linear";
import {
  ACME, ALICE_ACME, ALICE_GLOBEX, BOB_ACME, FakeLinear, GLOBEX, accountStub, failure, hooks,
  reconnectAs, seedAccount, storedGrant, storedSubject, unwrap,
} from "./fake-linear";

afterEach(() => {
  vi.unstubAllGlobals();
  TestCallback.failComplete = false;
});

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

/**
 * Runs a first connect inside a fresh account, Linear authorizing `user` in `workspace`: the
 * handoff on success, the thrown error when the Workshop never takes the connection. The
 * decorated account entrypoint cannot be minted from a Durable Object under the vite validation
 * plugin, so its undecorated twin (`TestUser`) is swapped in for the call.
 */
async function firstConnectAs(
  x: FakeLinear, id: string, user: typeof ALICE_ACME, workspace: typeof ACME,
): Promise<unknown> {
  const initiation = generateNonce();
  await hooks().installCallback(id, initiation);
  return await runInDurableObject(accountStub(id), async (instance, state) => {
    // This pool cannot mint the decorated account entrypoint (see `TestUser`); its twin's
    // exports factory stands in.
    Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
    const flow = await instance.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the connect did not start");
    const code = `code-${user.id}-${workspace.id}-${crypto.randomUUID()}`;
    x.codes.set(code, { user, workspace });
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}

describe("reconnecting", () => {
  it("refuses a reconnect as another user in the same workspace, revoking the grant", async () => {
    const x = new FakeLinear().install();
    const id = await seedAccount(x, ALICE_ACME, ACME);
    await hooks().installCallback(id, generateNonce());
    const before = await storedGrant(id);
    const result = await reconnectAs(x, id, BOB_ACME, ACME);
    expect(result).toEqual({
      refused: {
        title: "That's a different Linear account",
        detail: expect.stringContaining("This connection is for Alice Arnott in the Acme workspace, but Linear authorized Bob B in the Acme workspace."),
      },
    });
    // The refused grant was revoked with Linear — access and refresh token — and the live grant
    // is untouched.
    expect(x.revocations).toHaveLength(2);
    expect(x.revocations).not.toContain(before!.accessToken);
    expect(x.revocations).not.toContain(before!.refreshToken);
    expect(await storedGrant(id)).toEqual(before);
    expect(await storedSubject(id)).toMatchObject({ userId: ALICE_ACME.id, orgId: ACME.id });
    // Nothing was staged: no commit is awaiting confirmation.
    expect(failure(await hooks().account(id, "commitReconnect", "not-a-stage")))
      .toMatch(/No reconnect is awaiting/);
  });

  it("refuses a reconnect as the same user into another workspace, revoking the grant", async () => {
    const x = new FakeLinear().install();
    const id = await seedAccount(x, ALICE_ACME, ACME);
    await hooks().installCallback(id, generateNonce());
    const before = await storedGrant(id);
    const result = await reconnectAs(x, id, ALICE_GLOBEX, GLOBEX);
    expect(result).toEqual({
      refused: {
        title: "That's a different Linear account",
        detail: expect.stringContaining("This connection is for Alice Arnott in the Acme workspace, but Linear authorized Alice Arnott in the Globex workspace."),
      },
    });
    expect(x.revocations).toHaveLength(2);
    expect(x.revocations).not.toContain(before!.accessToken);
    expect(x.revocations).not.toContain(before!.refreshToken);
    expect(await storedGrant(id)).toEqual(before);
    expect(await storedSubject(id)).toMatchObject({ userId: ALICE_ACME.id, orgId: ACME.id });
  });

  it("stages a same-user same-workspace reconnect until the Workshop commits it", async () => {
    const x = new FakeLinear().install();
    const id = await seedAccount(x, ALICE_ACME, ACME);
    await hooks().installCallback(id, generateNonce());
    const before = await storedGrant(id);
    const result = await reconnectAs(x, id, ALICE_ACME, ACME) as { handoff: { ticket: string } };
    expect(await storedGrant(id)).toEqual(before);
    unwrap(await hooks().account(id, "commitReconnect", result.handoff.ticket));
    const after = await storedGrant(id);
    expect(after!.accessToken).toMatch(/^linoauth_user-alice_org-acme_\d+$/);
    expect(after!.accessToken).not.toBe(before!.accessToken);
    expect(await storedSubject(id)).toMatchObject({ userId: ALICE_ACME.id, orgId: ACME.id });
    // The stage is spent: a second commit of the same stage is refused.
    expect(failure(await hooks().account(id, "commitReconnect", result.handoff.ticket)))
      .toMatch(/No reconnect is awaiting/);
  });

  it("adopts the pin on the first reconnect of an account connected before pinning", async () => {
    const x = new FakeLinear().install();
    const id = await seedAccount(x, ALICE_ACME, ACME, { subject: false });
    await hooks().installCallback(id, generateNonce());
    // No stored subject means nothing to compare against, so the reconnect lands — and pins.
    const landed = await reconnectAs(x, id, ALICE_GLOBEX, GLOBEX) as { handoff: { ticket: string } };
    unwrap(await hooks().account(id, "commitReconnect", landed.handoff.ticket));
    expect(await storedSubject(id)).toMatchObject({ userId: ALICE_GLOBEX.id, orgId: GLOBEX.id });
    // From then on the connection refuses its original workspace.
    const result = await reconnectAs(x, id, ALICE_ACME, ACME);
    expect(result).toEqual({
      refused: {
        title: "That's a different Linear account",
        detail: expect.stringContaining("This connection is for Alice Arnott in the Globex workspace"),
      },
    });
  });
});

describe("connecting", () => {
  it("records the user and workspace a first connect is made as", async () => {
    const x = new FakeLinear().install();
    const id = env.USER_ACCOUNT.newUniqueId().toString();
    const result = await firstConnectAs(x, id, ALICE_ACME, ACME) as { handoff: unknown };
    expect(result.handoff).toBeDefined();
    expect(await storedSubject(id)).toMatchObject({ userId: ALICE_ACME.id, orgId: ACME.id, orgUrlKey: ACME.urlKey });
  });

  it("drops the recorded user when the Workshop never takes the connection", async () => {
    const x = new FakeLinear().install();
    TestCallback.failComplete = true;
    const id = env.USER_ACCOUNT.newUniqueId().toString();
    await expect(firstConnectAs(x, id, ALICE_ACME, ACME)).rejects.toThrow(/Workshop unreachable/);
    expect(await storedGrant(id)).toBeUndefined();
    expect(await storedSubject(id)).toBeUndefined();
  });
});

describe("the connect link", () => {
  it("shows the refusal page when Linear authorized a different account", async () => {
    const x = new FakeLinear().install();
    const id = await seedAccount(x, ALICE_ACME, ACME);
    const initiation = generateNonce();
    await hooks().installCallback(id, initiation);
    unwrap(await hooks().account(id, "prepareReconnect", initiation));
    const start = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/linear/${id}/${initiation}`), env, ctx());
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain("https://linear.app/oauth/authorize");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const code = `code-${BOB_ACME.id}-${ACME.id}-page`;
    x.codes.set(code, { user: BOB_ACME, workspace: ACME });
    const callback = await worker.fetch(
      new Request(`http://localhost:8787/gatekeeper/linear/oauth?code=${code}&state=${state}`), env, ctx());
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("That&#39;s a different Linear account");
  });
});
describe("claim-before-apply", () => {
  // Action records live on the gatekeeper Durable Object, not the account. A create-issue parked
  // mid-dispatch durably says `claimed`, so any later attempt knows the outcome is unknown rather
  // than never-run. The record is seeded raw in the engine journal's shape — no validated entry
  // point can produce one on demand.
  const claimedAction = {
    v: 2, state: "claimed",
    action: {
      kind: "createIssue",
      payload: {
        input: { teamId: "team-1", title: "Claimed" }, provisionalId: "~p7",
        title: "Claimed",
        presentation: { title: "Claimed", implementsRevert: true, description: "Seeded.", fields: [] },
      },
    },
  };

  /** A gatekeeper facet on a fresh connected account, holding the given entries verbatim. */
  async function claimedFacet(facetName: string, entries: Record<string, unknown>) {
    const x = new FakeLinear().install();
    const userObjectId = await seedAccount(x);
    const props: LinearGatekeeperImplProps = {
      userObjectId, workspaceUrlKey: ACME.urlKey, resourceKind: "workspace",
    };
    await hooks().seedGatekeeper(facetName, props, entries);
    return { x, props };
  }

  it("settles a replayed apply against the claim, never re-running the write", async () => {
    const { x, props } = await claimedFacet("claim-apply", { "action:7": claimedAction });

    const replay = await hooks().applyGatekeeperAction("claim-apply", props, 7);

    expect(failure(replay)).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(await hooks().gatekeeperEntry("claim-apply", props, "action:7"))
      .toMatchObject({ state: "failed" });
    // The terminal record answers every later attempt the same way, without a Linear call.
    expect(failure(await hooks().applyGatekeeperAction("claim-apply", props, 7)))
      .toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(x.requests.filter(r => (r.body ?? "").includes("issueCreate"))).toHaveLength(0);
  });

  it("refuses to reject a claimed action, settling it before an explicit second rejection", async () => {
    const { props } = await claimedFacet("claim-reject", { "action:7": claimedAction });

    expect(failure(await hooks().rejectGatekeeperAction("claim-reject", props, 7)))
      .toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(await hooks().gatekeeperEntry("claim-reject", props, "action:7"))
      .toMatchObject({ state: "failed" });
    // The operator's explicit second choice clears the settled record.
    unwrap(await hooks().rejectGatekeeperAction("claim-reject", props, 7));
    expect(await hooks().gatekeeperEntry("claim-reject", props, "action:7")).toBeUndefined();
  });

  it("answers a duplicate apply of an already-applied action with success, no second write", async () => {
    const applied = {
      ...claimedAction, state: "applied",
      action: { ...claimedAction.action, payload: { ...claimedAction.action.payload, createdIssueId: "issue-7" } },
    };
    const { x, props } = await claimedFacet("claim-applied", { "retained:action:7": applied });

    unwrap(await hooks().applyGatekeeperAction("claim-applied", props, 7));

    expect(x.requests.filter(r => (r.body ?? "").includes("issueCreate"))).toHaveLength(0);
  });

  it("strands dependents of a rejected provider create as failed, never applying them", async () => {
    // A pending createIssue provides `~1`; a pending updateIssue depends on it. Rejecting the
    // create must make the update unapplicable: the engine strands it as a failed record whose
    // reason names the decision, instead of dispatching anything to Linear. (If the dependsOn
    // wiring in linear-actions.ts were broken, the apply would instead fail with the resolver's
    // "has not been created on Linear yet" error — a different message.)
    const presentation = { title: "Seeded", implementsRevert: true, description: "Seeded.", fields: [] };
    const create = {
      v: 2, state: "pending",
      action: {
        kind: "createIssue",
        payload: { input: { teamId: "team-1", title: "Parent" }, provisionalId: "~1", title: "Parent",
          presentation },
      },
    };
    const update = {
      v: 2, state: "pending",
      action: {
        kind: "updateIssue",
        payload: { issueRef: "~1", input: { title: "New" }, previous: {}, patch: {},
          title: "Edit parent", presentation },
      },
    };
    const { x, props } = await claimedFacet(
      "strand-dependents", { "action:1": create, "action:2": update });

    const rejected = unwrap(await hooks().rejectGatekeeperAction("strand-dependents", props, 1));
    expect(rejected).toEqual({ restart: true });
    expect(await hooks().gatekeeperEntry("strand-dependents", props, "action:2"))
      .toMatchObject({ state: "failed", undispatched: true });
    expect(failure(await hooks().applyGatekeeperAction("strand-dependents", props, 2)))
      .toBe("This action needed action 1, which did not complete.");
    expect(x.requests.filter(r => (r.body ?? "").includes("issueUpdate"))).toHaveLength(0);
  });
});
