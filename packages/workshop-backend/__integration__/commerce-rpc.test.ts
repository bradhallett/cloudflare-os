// The commerce RPC surface (see src/server.ts's commerce section and
// @gadgets/workshop-shared/commerce) over the real WebSocket RPC session, against a real
// SAAS_COMMERCE service binding backed by this suite's CommerceStub worker. What is pinned:
// every method re-derives org authority from live membership (an owner passes, a plain member
// and an outsider are refused before the port is called), checkout/portal calls are anchored to
// the deployment's own origin, seat counts are validated before the port sees them, reads pass
// the port's answer through verbatim, and the member-sync snapshot — which is how seats are
// claimed and released — follows every membership change made through the RPC. The no-binding
// (OSS) behavior is covered by __tests__/commerce.test.ts at the port level.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { OrgCommerceMember, PublicApi } from "@gadgets/workshop-shared/api";
import { expect, it, vi } from "vitest";
import server from "../src/server";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    SAAS_COMMERCE: Service<{
      memberSyncs(): Promise<Array<{orgId: string; name: string; members: OrgCommerceMember[]}>>;
      checkouts(): Promise<Array<{orgId: string; plan: string; seats: number; successUrl: string}>>;
      reset(): Promise<void>;
    }>;
  }
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function authenticate(publicApi: RpcStub<PublicApi>, prefix: string) {
  const username = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(username, "Commerce Tester", new Uint8Array([1, 2, 3]));
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return { username, api: await publicApi.authenticate(token) };
}

it("org authority gates every commerce method; reads pass the port through verbatim", async () => {
  await env.SAAS_COMMERCE.reset();
  using publicApi = await connect();
  const owner = await authenticate(publicApi, "commerceowner");
  const member = await authenticate(publicApi, "commercemember");
  const outsider = await authenticate(publicApi, "commerceoutsider");

  // The org under test: owner-administered, with `member` invited and joined.
  const org = await owner.api.createOrg("Acme Commerce");
  await owner.api.inviteOrgMember(org.id, member.username);
  await member.api.acceptOrgInvitation(org.id);

  // The plan list is the port's, verbatim (empty is the no-binding shape, not asserted here).
  expect(await owner.api.listCommercePlans()).toEqual([{id: "pro", name: "Pro"}]);

  // The billing overview is the port's answer for the presented org, verbatim.
  const billing = await owner.api.getOrgBilling(org.id);
  expect(billing).toMatchObject({
    plan: "pro", seats: 5, assignedSeats: 2, subscriptionStatus: "active",
    monthlySpendCapUsd: 50, overageAllowed: false,
  });
  expect(billing.usage).toMatchObject({
    inputTokens: 101, cacheReadTokens: 13, cacheWriteTokens: 17,
    outputTokens: 19, estimatedCostUsd: 0.5,
  });
  expect(new Date(billing.usage!.cycleStart).getTime()).toBe(0);

  // A plain member and a non-member are both refused, with the port's answer never reaching
  // them — authority is re-derived from live membership in the org Durable Object.
  for (const api of [member.api, outsider.api]) {
    await expect(api.getOrgBilling(org.id))
        .rejects.toThrow("Only an active owner or admin of the organization may manage its billing.");
    await expect(api.startOrgCheckout(org.id, "pro", 1))
        .rejects.toThrow("Only an active owner or admin of the organization may manage its billing.");
    await expect(api.openOrgBillingPortal(org.id))
        .rejects.toThrow("Only an active owner or admin of the organization may manage its billing.");
  }
});

it("checkout and portal calls carry the deployment's own origin; seat counts are validated first", async () => {
  await env.SAAS_COMMERCE.reset();
  using publicApi = await connect();
  const owner = await authenticate(publicApi, "commercelinks");
  const org = await owner.api.createOrg("Origin Co");

  const checkout = await owner.api.startOrgCheckout(org.id, "pro", 3);
  expect(checkout.url).toBe(`https://checkout.example/s/${org.id}`);
  const portal = await owner.api.openOrgBillingPortal(org.id);
  expect(portal.url).toBe(`https://portal.example/p/${org.id}`);

  // The port received the org, plan, seats, and a return URL anchored to PUBLIC_BASE_URL —
  // built server-side, never from client input.
  const checkouts = await env.SAAS_COMMERCE.checkouts();
  expect(checkouts).toEqual([{
    orgId: org.id, plan: "pro", seats: 3,
    successUrl: `https://workshop.example/saas/checkout/return?org=${encodeURIComponent(org.id)}`,
  }]);

  // Fractional and zero seat counts are refused before the port is called.
  for (const seats of [1.5, 0]) {
    await expect(owner.api.startOrgCheckout(org.id, "pro", seats))
        .rejects.toThrow("Seats must be a whole number of at least one.");
  }
  expect(await env.SAAS_COMMERCE.checkouts()).toHaveLength(1);
});

it("the member-sync snapshot follows every membership change made over the RPC", async () => {
  await env.SAAS_COMMERCE.reset();
  using publicApi = await connect();
  const owner = await authenticate(publicApi, "syncowner");
  const invitee = await authenticate(publicApi, "syncinvitee");

  const org = await owner.api.createOrg("Sync Co");

  // The pushes are fire-and-forget across the service binding, so wait for each state rather
  // than sleeping. Seats: claimed at invite time (the invited member is in the snapshot),
  // kept at accept (status flips to active), released at removal (the member disappears).
  // Member order follows the org's storage key order, so compare sorted.
  const syncedMembers = async () => {
    const syncs = await env.SAAS_COMMERCE.memberSyncs();
    return syncs.filter((s) => s.orgId === org.id).map((s) => ({
      orgId: s.orgId, name: s.name,
      members: [...s.members].toSorted((a, b) => a.userId.localeCompare(b.userId)),
    }));
  };

  await vi.waitFor(async () => {
    expect(await syncedMembers()).toEqual([{
      orgId: org.id, name: "Sync Co",
      members: [{userId: owner.username, role: "owner", status: "active"}],
    }]);
  });

  await owner.api.inviteOrgMember(org.id, invitee.username);
  await vi.waitFor(async () => {
    expect((await syncedMembers()).at(-1)).toEqual({
      orgId: org.id, name: "Sync Co",
      members: [
        {userId: invitee.username, role: "member", status: "invited"},
        {userId: owner.username, role: "owner", status: "active"},
      ],
    });
  });

  await invitee.api.acceptOrgInvitation(org.id);
  await vi.waitFor(async () => {
    expect((await syncedMembers()).at(-1)).toEqual({
      orgId: org.id, name: "Sync Co",
      members: [
        {userId: invitee.username, role: "member", status: "active"},
        {userId: owner.username, role: "owner", status: "active"},
      ],
    });
  });

  await owner.api.removeOrgMember(org.id, invitee.username);
  await vi.waitFor(async () => {
    expect((await syncedMembers()).at(-1)).toEqual({
      orgId: org.id, name: "Sync Co",
      members: [{userId: owner.username, role: "owner", status: "active"}],
    });
  });
});
