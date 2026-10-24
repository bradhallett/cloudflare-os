// The SAAS_COMMERCE port is the seam a hosted deployment's commerce service sits behind (see
// src/commerce.ts and @gadgets/workshop-shared/commerce). These tests pin its contract:
// emission is a synchronous no-op with no service bound (every OSS deployment — no RPC, no
// throw), a failing port is logged and dropped rather than thrown into the caller, and the
// membership snapshot — which is how subscription seats are claimed and released, the port
// having no pull API — is pushed at every membership change, including the two
// invitation-expiry paths that delete a member without any other mutation happening.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it, vi} from "vitest";
import type {OrgCommerceMember} from "@gadgets/workshop-shared/api";
import type {SaasCommercePort} from "@gadgets/workshop-shared/commerce";
import {notifyOrgMembersChanged} from "../src/commerce.js";
import {OrgDurableObject} from "../src/org.js";
import {makeOrgStorage} from "../src/storage-schema/org-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
  }
}

const OWNER = "commerce-owner@example.com";
const INVITEE = "commerce-invitee@example.com";

describe("notifyOrgMembersChanged", () => {
  it("is a synchronous no-op with no port bound: no RPC, no throw", () => {
    expect(() => notifyOrgMembersChanged(
        {} as unknown as Cloudflare.Env, "org", "Acme",
        [{userId: OWNER, role: "owner", status: "active"}]))
        .not.toThrow();
  });

  it("fires the port fire-and-forget: a failing port never throws into the caller", async () => {
    const calls: unknown[][] = [];
    const failing = {
      orgMembersChanged: async (...args: unknown[]) => {
        calls.push(args);
        throw new Error("port down");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => notifyOrgMembersChanged(
        {SAAS_COMMERCE: failing} as unknown as Cloudflare.Env, "org", "Acme", []))
        .not.toThrow();
    // The rejection and the catch that handles it are both microtasks; drain the queue
    // deterministically rather than sleeping (no wall-clock timer is involved).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// The membership snapshot pushed at the port, as the org DO computes it: one entry per member,
// invited members included (a seat is claimed at invite time, before anyone accepts).
type Snapshot = {orgId: string; name: string; members: OrgCommerceMember[]};

// A real OrgDurableObject whose environment carries a port that records every snapshot it is
// pushed, plus a `drive` that runs a scenario inside the DO and returns what the port saw. The
// whole scenario must run inside one `runInDurableObject` closure: the recorded array lives
// DO-side, so only its (serialized) return value comes back to the test.
async function orgWithRecorder(name: string) {
  const stub = env.TEST_ORG.get(env.TEST_ORG.idFromName(`commerce-${name}-${crypto.randomUUID()}`));
  const drive = <T>(
      f: (org: OrgDurableObject, saw: Snapshot[], state: DurableObjectState) => T | Promise<T>,
  ): Promise<T> =>
      runInDurableObject(stub, (_host: OrgDurableObject, state: DurableObjectState) => {
        const saw: Snapshot[] = [];
        const port = {
          orgMembersChanged: async (query: Snapshot) => {
            saw.push(query);
          },
        } as unknown as SaasCommercePort;
        const org = new OrgDurableObject(state, {SAAS_COMMERCE: port} as unknown as Cloudflare.Env);
        return f(org, saw, state);
      });
  return {drive};
}

// Expires the invitee's pending invitation directly in storage, the way wall-clock passage
// would, without going through a mutation that would itself push a snapshot.
function expireInvitation(state: DurableObjectState, inviteeId: string): void {
  const storage = makeOrgStorage(state.storage);
  const invitation = storage.invitations.get(inviteeId);
  if (invitation === null || invitation === undefined) throw new Error("no invitation to expire");
  storage.invitations.put({...invitation, expiresAt: new Date(Date.now() - 1)});
}

describe("the membership snapshot the commerce port receives", () => {
  it("claims a seat at invite time and releases it when the sweep deletes the expiry", async () => {
    const {drive} = await orgWithRecorder("sweep");
    const saw = await drive(async (org, saw) => {
      await org.initializeOrg("Acme", OWNER);
      await org.inviteMember(OWNER, INVITEE);
      return saw;
    });
    // Member order follows storage key order, not call order; the snapshot's contract is the
    // member set (seat count), so compare order-independently.
    const byUser = (a: OrgCommerceMember, b: OrgCommerceMember) => a.userId.localeCompare(b.userId);
    expect(saw.map((snapshot) => [...snapshot.members].toSorted(byUser))).toEqual([
      [{userId: OWNER, role: "owner", status: "active"}],
      [
        {userId: INVITEE, role: "member", status: "invited"},
        {userId: OWNER, role: "owner", status: "active"},
      ],
    ]);

    // The lazy sweep runs on the reads that care; describeForMember is one, and it must push
    // the seat-releasing snapshot (the member record is gone, so the count drops back to 1).
    const afterSweep = await drive(async (org, saw, state) => {
      expireInvitation(state, INVITEE);
      expect(await org.describeForMember(INVITEE)).toBeNull();
      return saw;
    });
    expect(afterSweep).toHaveLength(1);
    expect([...afterSweep[0]!.members].toSorted(byUser))
        .toEqual([{userId: OWNER, role: "owner", status: "active"}]);
  });

  it("an expired invitation refused at accept releases the seat it had claimed", async () => {
    const {drive} = await orgWithRecorder("expired-accept");
    await drive(async (org, _saw, state) => {
      await org.initializeOrg("Globex", OWNER);
      await org.inviteMember(OWNER, INVITEE);
      expireInvitation(state, INVITEE);
      return null;
    });
    const {refusal, saw} = await drive(async (org, saw) => {
      let refusal: unknown = null;
      try {
        await org.acceptInvitation(INVITEE);
      } catch (err) {
        refusal = err;
      }
      return {refusal, saw};
    });
    expect((refusal as Error).message).toBe("That invitation has expired.");
    // The refusal path deletes the member record; the snapshot it pushes must reflect the
    // release, or the seat stays claimed at the vendor forever (there is no pull API).
    expect(saw).toHaveLength(1);
    expect(saw[0]!.members).toEqual([{userId: OWNER, role: "owner", status: "active"}]);
  });

  it("with no port bound, org mutations behave exactly as before the seam", async () => {
    const stub = env.TEST_ORG.get(env.TEST_ORG.idFromName(`commerce-unbound-${crypto.randomUUID()}`));
    const summary = await runInDurableObject(stub, (_host: OrgDurableObject, state: DurableObjectState) => {
      // As in plan-enforcement's orgWithPlan: no binding at all is what makes a deployment OSS.
      const org = new OrgDurableObject(state, {} as unknown as Cloudflare.Env);
      return org.initializeOrg("Initech", OWNER);
    });
    expect(summary.role).toBe("owner");
    expect(summary.status).toBe("active");
  });
});
