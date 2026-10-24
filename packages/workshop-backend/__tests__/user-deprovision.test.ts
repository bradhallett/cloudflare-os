// Session revocation and deprovisioning (UserDurableObject.revokeAllSessions / deprovision):
// revocation is immediately effective because authenticate() reads storage per request, and the
// deprovision checklist covers every kind of state that outlives a session. The Overseer sweep
// runs against a real OverseerDurableObject; scheduleAccessRestart is replaced with a recorder,
// since a real ctx.abort() would kill the test DO (see observer-scope-restart.test.ts).

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { SharingManager } from "../src/sharing.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
import type { UserDurableObject } from "../src/user.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";
// Load the whole backend (the pool's `main`) up front, so its load time doesn't count against
// the first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
  }
}

// The typed collections and singletons behind the public methods, as a test reaches into the
// user's DO (its `storage` is private; this widens just the pieces read or seeded here).
type UserInternals = UserDurableObject & {
  storage: {
    sessions: { list(): Iterable<{ tokenId: string }> };
    pendingDeviceHandoffs: { list(): Iterable<{ stateHash: string }> };
    pendingUserSelections: {
      list(): Iterable<{ ticketHash: string }>;
      put(record: unknown): void;
    };
    connectedAccounts: { list(): Iterable<{ id: number }> };
    gadgets: { list(): Iterable<{ id: string; owner?: unknown }> };
    notificationSubscriptions: { put(value: Record<string, string>): void };
    cloudflareBilling: { put(value: unknown): void };
    dailyLlmCount: { put(value: unknown): void };
    passwordHashHash: { get(): Uint8Array | null };
    deprovisioned: { get(): boolean };
  };
};

// The Overseer implementation behind the DO class, as this test seeds it: the owner identity,
// the sharing manager, and the restart hook it replaces with a recorder.
type OverseerInternals = {
  ownerId?: string;
  ownerProfileId?: string;
  restartReasons?: string[];
  getSharingManager(): Promise<SharingManager>;
  scheduleAccessRestart(reason: string): Promise<void>;
};

function implOf(instance: OverseerDurableObject): OverseerInternals {
  return (instance as unknown as { impl: OverseerInternals }).impl;
}

const state = "ABCDEFab-0000-0000-0000-000000000001";

// A fresh user DO name and matching username, unique per test like the email-keyed DOs are.
function newUserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function appPublicKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  return new Uint8Array(
      await crypto.subtle.exportKey("raw", key.publicKey) as ArrayBuffer)
      .toBase64({ alphabet: "base64url", omitPadding: true });
}

async function authResult(user: DurableObjectStub<UserDurableObject>, token: string) {
  return runInDurableObject(user, async (instance: UserDurableObject) => {
    try {
      await instance.authenticate(token);
      return "ok";
    } catch {
      return "invalid";
    }
  });
}

// Await a stub call's rejection with a single handler; expect(...).rejects would fork the
// underlying JsRpcPromise and report the leftover copy as an unhandled rejection.
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

function inUser<T>(user: DurableObjectStub<UserDurableObject>,
    f: (internals: UserInternals) => T | Promise<T>): Promise<T> {
  return runInDurableObject(user, (instance: UserDurableObject) =>
      f(instance as unknown as UserInternals));
}

// Real time, not fake timers: the waits below are for queued cross-DO RPCs (fire-and-forget
// cleanup landing on another Durable Object), which no clock advance can settle.
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe("revokeAllSessions", () => {
  it("kills browser and staged device sessions immediately, with staged handoffs and selections",
      async () => {
        const id = newUserId("revoke");
        const user = env.TEST_USER.getByName(id);
        const passwordHash = crypto.getRandomValues(new Uint8Array(32));
        const browserToken = await user.createAccount(id, "Revoker", passwordHash);
        expect(await authResult(user, browserToken)).toBe("ok");

        const handoff = await user.stageDeviceSessionHandoff(await appPublicKey(), state);
        // A gatekeeper user-selection ticket staged independently of any flow.
        await inUser(user, internals => {
          internals.storage.pendingUserSelections.put({
            ticketHash: "a".repeat(64),
            appAccountId: 1,
            vendorId: "context",
            selectedUserId: "someone",
            expiresAt: new Date(Date.now() + 60_000),
          });
        });

        // One browser session plus the handoff's staged (pendingUntil) device session.
        expect(await user.revokeAllSessions()).toBe(2);

        expect(await authResult(user, browserToken)).toBe("invalid");
        expect(await user.consumeDeviceSessionHandoff(state, handoff.ticket)).toBeNull();
        await inUser(user, internals => {
          expect([...internals.storage.sessions.list()]).toHaveLength(0);
          expect([...internals.storage.pendingDeviceHandoffs.list()]).toHaveLength(0);
          expect([...internals.storage.pendingUserSelections.list()]).toHaveLength(0);
        });

        // Nothing left to revoke; the count reports zero rather than throwing.
        expect(await user.revokeAllSessions()).toBe(0);
      });
});

describe("deprovision", () => {
  it("runs the full checklist: sessions, handoffs, accounts, password, re-auth, directory",
      async () => {
        const id = newUserId("depro");
        const user = env.TEST_USER.getByName(id);
        const passwordHash = crypto.getRandomValues(new Uint8Array(32));
        const browserToken = await user.createAccount(id, "Deprovisioned", passwordHash);
        const handoff = await user.stageDeviceSessionHandoff(await appPublicKey(), state);

        // A connected gatekeeper account whose revoke() the fake records by name.
        const accountName = `${id}-account`;
        await inUser(user, async internals => {
          const account = internals.ctx.exports.FakeGatekeeperAccount(
              { props: { name: accountName } });
          await internals.linkConnectedAccountFromLogin(account, "context");
        });

        await inUser(user, internals => {
          internals.storage.notificationSubscriptions.put({ deviceKey: "subscription-1" });
          internals.storage.cloudflareBilling.put({ accountId: "cf-account" });
          internals.storage.dailyLlmCount.put({ day: "2026-10-23", count: 3 });
        });

        // The user is findable in the directory until deprovisioning hides them. The user DO
        // reaches the same directory DO (named "") that the test reads here. The directory holds
        // no membership of its own, so the test passes the user's id as the search scope too.
        const directory = env.TEST_USER_DIRECTORY.getByName("");
        await directory.syncUser({ id, name: "Deprovisioned" }, 1);
        expect((await directory.searchUsers(id, [], [id])).map(found => found.id)).toEqual([id]);

        await user.deprovision();

        // Sessions gone: the browser token and the staged handoff are both dead.
        expect(await authResult(user, browserToken)).toBe("invalid");
        expect(await user.consumeDeviceSessionHandoff(state, handoff.ticket)).toBeNull();
        // Connected account revoked ("describe" is from linking it) and deleted.
        const hooks = env.TEST_GATEKEEPER_USER_PICKER.getByName("");
        expect(await hooks.accountCalls(accountName)).toEqual(["describe", "revoke"]);
        // Password unusable, and every sign-in path refuses the closed account.
        expect(await user.login(passwordHash)).toBeNull();
        await expectRejection(
            user.authenticateFromCfAccess(id, true), "can no longer sign in");
        await expectRejection(
            user.loginOrCreateViaGatekeeper(id, true), "can no longer sign in");
        // Directory: hidden from collaborator search even while still in the caller's scope.
        expect(await directory.searchUsers(id, [], [id])).toEqual([]);
        await inUser(user, internals => {
          expect([...internals.storage.connectedAccounts.list()]).toHaveLength(0);
          expect(internals.storage.passwordHashHash.get()).toBeNull();
          expect(internals.storage.deprovisioned.get()).toBe(true);
        });

        // Idempotent: a second pass finds nothing left and still resolves.
        await expect(user.deprovision()).resolves.toBeUndefined();
      });
});

describe("deprovision sweeps shared workspaces", () => {
  it("severs the user's collaborator edges and force-restarts the workspace", async () => {
    const id = newUserId("swept");
    const ownerProfileId = `owner-${id}`;
    const workspaceName = `ws-${id}`;
    const overseer = env.TEST_OVERSEER.getByName(workspaceName);
    const workspaceId = env.TEST_OVERSEER.idFromName(workspaceName).toString();

    await runInDurableObject(overseer, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);
      // Seed the owner identity so the sharing manager needs no User DO round trip, then share
      // the workspace with the user the way an owner's addCollaborator would.
      impl.ownerId = `owner-do-${id}`;
      impl.ownerProfileId = ownerProfileId;
      const sharing = await impl.getSharingManager();
      await sharing.addCollaborator({
        caller: { profileId: ownerProfileId, isOwner: true },
        profile: { type: "user", id, name: "Swept User" },
        role: "build",
      });
      // Record restarts instead of performing them; a real ctx.abort() kills the test DO.
      impl.restartReasons = [];
      impl.scheduleAccessRestart = (reason: string) => {
        impl.restartReasons!.push(reason);
        return Promise.resolve();
      };
    });

    const user = env.TEST_USER.getByName(id);
    const passwordHash = crypto.getRandomValues(new Uint8Array(32));
    await user.createAccount(id, "Swept User", passwordHash);
    // The gadgets index the sweep reads is written by the Overseer on every collaborator open.
    await user.recordSharedGadgetOpen(
        workspaceId, "Shared Workspace", { type: "user", id: ownerProfileId, name: "Owner" },
        "build");
    expect((await inUser(user, internals => [...internals.storage.gadgets.list()]))
        .map(record => record.id)).toEqual([workspaceId]);

    await user.deprovision();

    // The edge is gone: the user has no effective role in the workspace's permission graph,
    // and the workspace was force-restarted to sever their live chat sessions.
    const after = await runInDurableObject(overseer, async (instance: OverseerDurableObject) => {
      const impl = implOf(instance);
      const sharing = await impl.getSharingManager();
      return { role: await sharing.getEffectiveRole(id), restartReasons: [...impl.restartReasons!] };
    });
    expect(after.role).toBeUndefined();
    expect(after.restartReasons)
        .toEqual(["Gadget restarted to revoke access for a deprovisioned user."]);

    // The post-restart listing refresh (fire-and-forget) drops the shared workspace from the
    // user's index once the deprovision call has returned. Bounded wait: the refresh is a
    // queued incoming RPC on the same DO, with no promise the test could await instead.
    let gadgets = await inUser(user, internals => [...internals.storage.gadgets.list()]);
    for (let attempt = 0; attempt < 50 && gadgets.length > 0; attempt++) {
      await delay(20);
      gadgets = await inUser(user, internals => [...internals.storage.gadgets.list()]);
    }
    expect(gadgets).toEqual([]);

    // A second deprovision sweeps nothing: no edge to sever, no restart.
    await user.deprovision();
    const restarts = await runInDurableObject(overseer, async (instance: OverseerDurableObject) =>
        [...implOf(instance).restartReasons!]);
    expect(restarts).toHaveLength(1);
  });
});
