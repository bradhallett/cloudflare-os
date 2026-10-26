// The vendor admin policy a deployment's admin configures (AdminConfig.vendorAdminPolicy) cannot
// be read by the vendor's own worker, so the Workshop pushes each configured vendor's entry to
// its account out-of-band after every capability mint (user.ts #pushVendorAdminPolicy). These
// tests pin that contract at both mint chokepoints against a real UserDurableObject with a
// recording fake account: a configured entry is pushed, a never-configured vendor is left alone,
// and a push the account rejects never fails the mint it rode. The AdminSettings setter's own
// rules (only a bound vendor may gain an entry; null removes any entry) are pinned beside them.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { serializeAdminConfig } from "../src/admin-config.js";
import { AdminSettings } from "../src/admin-settings.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig, type VendorAdminPolicy,
} from "../src/storage-schema/admin-settings-storage.js";
import { UserDurableObject } from "../src/user.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

// What these tests reach into the user DO for: the account record behind a mint (its `storage`
// is private; this widens just the read used here).
type UserInternals = UserDurableObject & {
  storage: {
    connectedAccounts: { list(): Array<{ account: Fetcher<{calls(): Promise<string[]>}> }> };
  };
};

let counter = 0;

// The entry an admin configured for the fake vendor below.
const POLICY: VendorAdminPolicy = { excludedToolkits: ["gitlab"], autoApplyToolkits: ["slack"] };

/**
 * A real UserDurableObject over fresh storage (the plan-enforcement pattern: hand-constructed so
 * its BLUEPRINTS KV serves exactly the admin config given), bound to one auto-provisioning fake
 * vendor whose account facet records every call. `accountProps` reach that facet (see
 * FakeGatekeeperAccount).
 */
function policyUser(admin: Partial<AdminConfig>, accountProps: Record<string, unknown> = {}) {
  // The account's name keys the fake's shared call log, so it is unique per user (and per test).
  const name = `Policy-${++counter}`;
  const stub = env.TEST_USER.getByName(`vendor-admin-policy-${counter}`);
  const vendor = (state: DurableObjectState) => ({
    describe: async () => ({ vendorId: "policykee", autoProvisionsAccount: true }),
    createAccount: () =>
      (state.exports as unknown as {
        FakeGatekeeperAccount(options: { props: unknown }): unknown;
      }).FakeGatekeeperAccount({
        props: { name, singleton: { tsType: "FakeSession" }, ...accountProps },
      }),
  } as unknown as Cloudflare.Env["GATEKEEPER_CONTEXT"]);
  const inDo = <T>(f: (user: UserDurableObject) => T | Promise<T>): Promise<T> =>
      runInDurableObject(stub, (_host: UserDurableObject, state: DurableObjectState) => f(
          new UserDurableObject(state, {
            BLUEPRINTS: {
              get: async () => serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, ...admin }),
            } as unknown as KVNamespace,
            GATEKEEPER_POLICYKEE: vendor(state),
          } as unknown as Cloudflare.Env)));
  // What the account facet has been asked to do. Read inside the Durable Object invocation:
  // a stub carried out of one would fail I/O checks in the next (see runInDurableObject).
  const accountCalls = async (): Promise<string[]> =>
      await inDo(async user => {
        const [record] = [...(user as UserInternals).storage.connectedAccounts.list()];
        return await record.account.calls();
      });
  // Provision the fake vendor's ambient account and return its id, as the tests address a mint.
  const provisionedAccountId = async (): Promise<number> => {
    await inDo(user => user.provisionAmbientAccount("policykee"));
    return (await inDo(user => user.listProvidedAccounts()))[0].accountId;
  };
  return { inDo, accountCalls, provisionedAccountId };
}

describe("vendor admin policy at the mint chokepoints", () => {
  it("pushes the configured entry after the ambient-singleton mint", async () => {
    const { accountCalls, provisionedAccountId, inDo } =
        policyUser({ vendorAdminPolicy: { policykee: POLICY } });
    const accountId = await provisionedAccountId();
    expect(await inDo(user => user.getSingletonGatekeeperClass(accountId))).not.toBeNull();
    expect(await accountCalls()).toContain("updateToolkitPolicy(gitlab|slack)");
  });

  it("pushes the configured entry after the resource mint too", async () => {
    const { accountCalls, provisionedAccountId, inDo } =
        policyUser({ vendorAdminPolicy: { policykee: POLICY } });
    const accountId = await provisionedAccountId();
    const minted = await inDo(user => user.getGatekeeperClassFor(accountId, "policykee:widgets"));
    expect(minted.vendorId).toBe("policykee");
    expect(await accountCalls()).toContain("updateToolkitPolicy(gitlab|slack)");
  });

  it("leaves a never-configured vendor's account alone", async () => {
    const { accountCalls, provisionedAccountId, inDo } = policyUser({});
    const accountId = await provisionedAccountId();
    expect(await inDo(user => user.getSingletonGatekeeperClass(accountId))).not.toBeNull();
    const calls = await accountCalls();
    expect(calls).toContain("getSingletonGatekeeperClass");  // the mint itself happened
    expect(calls.filter(call => call.startsWith("updateToolkitPolicy"))).toEqual([]);
  });

  it("a push the account rejects never fails the mint it rode", async () => {
    const { accountCalls, provisionedAccountId, inDo } = policyUser(
        { vendorAdminPolicy: { policykee: POLICY } }, { failToolkitPolicy: true });
    const accountId = await provisionedAccountId();
    expect(await inDo(user => user.getSingletonGatekeeperClass(accountId))).not.toBeNull();
    expect(await accountCalls()).toContain("updateToolkitPolicy(gitlab|slack)");
  });
});

/**
 * An AdminSettings over fresh storage (the admin-settings-models pattern: constructed on an
 * unrelated Durable Object's state, its KV mirror captured), with the policykee vendor bound
 * only while `bound` is set — the vendor map the setter validates against comes from the env.
 */
function adminSettings() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`vendor-admin-policy-settings-${++counter}`);
  const mirror = { current: null as string | null };
  const inDo = <T>(bound: boolean, f: (admin: AdminSettings) => T | Promise<T>): Promise<T> =>
      runInDurableObject(stub, (_host: UserDirectoryDurableObject, state: DurableObjectState) =>
          f(new AdminSettings(state, {
            BLUEPRINTS: {
              put: async (_key: string, value: string) => { mirror.current = value; },
              get: async () => null,
            },
            ...(bound ? { GATEKEEPER_POLICYKEE: {} } : {}),
          } as unknown as Cloudflare.Env)));
  return { inDo, mirror };
}

describe("AdminSettings.setVendorAdminPolicy", () => {

  it("upserts only a bound vendor (any case), and removes any entry with null", async () => {
    const { inDo, mirror } = adminSettings();
    await inDo(true, admin => admin.setVendorAdminPolicy(
        "POLICYKEE", { excludedToolkits: [" gitlab ", "gitlab"], autoApplyToolkits: [] }));
    expect(await inDo(true, admin => admin.getAdminConfig().vendorAdminPolicy)).toEqual({
      policykee: { excludedToolkits: ["gitlab"], autoApplyToolkits: [] },
    });
    await expect(inDo(true, admin => admin.setVendorAdminPolicy(
        "unknown", { excludedToolkits: [], autoApplyToolkits: [] })))
        .rejects.toThrow('"unknown" is not a bound gatekeeper.');
    // A vendor since uninstalled: its stale entry is still removable (null skips validation).
    await inDo(false, admin => admin.setVendorAdminPolicy("policykee", null));
    expect(await inDo(true, admin => admin.getAdminConfig().vendorAdminPolicy)).toEqual({});
    expect(JSON.parse(mirror.current ?? "null").vendorAdminPolicy).toEqual({});
  });
});
