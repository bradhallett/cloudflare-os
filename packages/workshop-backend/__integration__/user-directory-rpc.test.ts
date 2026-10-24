import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { expect, it, vi } from "vitest";
import server from "../src/server";

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

async function authenticate(publicApi: RpcStub<PublicApi>, prefix: string, displayName: string) {
  const username = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(username, displayName, new Uint8Array([1, 2, 3]));
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return { username, api: await publicApi.authenticate(token) };
}

function setUserSearchEnabled(enabled: boolean): Promise<void> {
  return exports.AdminSettings.getByName("").updateAdminConfig({ userSearchEnabled: enabled });
}

// Needs this suite's in-isolate clock, which the public-API suite can't reach. The viewer and
// target share an org: since searchUsers is org-scoped, co-membership is what makes the target
// findable at all, and the foreign org's identically-named member stays invisible to the viewer.
it("an open capability re-reads the search policy once its cache expires", async () => {
  await setUserSearchEnabled(true);
  using publicApi = await connect();
  const viewer = await authenticate(publicApi, "policyviewer", "Policy Viewer");
  const target = await authenticate(publicApi, "policytarget", "Policy Target");
  const foreign = await authenticate(publicApi, "policyforeign", "Policy Target");
  using viewerApi = viewer.api;
  using _targetApi = target.api;
  using _foreignApi = foreign.api;
  const org = await viewerApi.createOrg("Policy Org");
  await viewerApi.inviteOrgMember(org.id, target.username);
  await target.api.acceptOrgInvitation(org.id);
  await foreign.api.createOrg("Foreign Org");

  const record = { id: target.username, name: "Policy Target" };
  await expect.poll(() => viewerApi.searchUsers("policy target", [])).toEqual([record]);
  // The foreign org's member matches the query just as well; only scope separates them.
  await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([record]);

  const now = Date.now();
  const dateNow = vi.spyOn(Date, "now");
  try {
    await setUserSearchEnabled(false);
    dateNow.mockReturnValue(now + 30_000);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([]);

    await setUserSearchEnabled(true);
    dateNow.mockReturnValue(now + 60_000);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([record]);
  } finally {
    dateNow.mockRestore();
  }
});
