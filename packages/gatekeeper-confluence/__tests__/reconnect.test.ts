// A reconnect pins the Atlassian account it was made as: the account id the new grant reports
// must match the pinned one. A mismatch is refused without staging anything and the new grant is
// dropped (Atlassian offers no revocation endpoint); a match hands off a stage to commit. A
// profile that cannot be read fails the flow, since the grant cannot be pinned to anyone.
// Atlassian is faked at `fetch`; these tests run in Node, so the Workers hosting surface is mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  class Target { [Symbol.dispose]() {} }
  class Stub { dup() { return this; } }
  return { WorkerEntrypoint: Entrypoint, DurableObject: Entrypoint, RpcTarget: Target, RpcStub: Stub };
});
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/confluence-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/confluence-site-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/confluence-space-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/confluence-page-configurator-ui.txt", () => ({ default: "" }));

// Loaded dynamically so every vi.mock above is in effect first; a static import of the module
// (which pulls in the mocked Workers surface) would race the mock registry.
const { UserAccount } = await import("../src/confluence");

// Node's WebCrypto lacks the Workers-only timingSafeEqual the flow's nonce checks call; the
// exchange counter resets so token literals stay stable per test.
beforeEach(() => {
  exchangedTokens = [];
  vi.stubGlobal("crypto", {
    ...crypto, getRandomValues: crypto.getRandomValues.bind(crypto),
    subtle: {
      ...crypto.subtle,
      timingSafeEqual: (a: Uint8Array, b: Uint8Array) =>
        a.length === b.length && a.every((byte, i) => byte === b[i]),
    },
  });
});

type ReconnectOutcome = { handoff: { ticket: string } } | { refused: { title: string; detail: string } };

const AUTH_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ME_URL = "https://api.atlassian.com/me";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/** The identity the fake Atlassian reports for the next exchange's access token. */
let identity: { accountId: string; name?: string; email?: string };
let exchangedTokens: string[] = [];

function accountContext() {
  let store = new Map<string, unknown>();
  let kv = { get: <T>(key: string) => store.get(key) as T | undefined };
  let events: string[] = [];
  let callback = {
    complete: vi.fn(async () => { events.push("complete"); return { ticket: "handoff" }; }),
    reconnectComplete: vi.fn(async (stageId: string) => {
      events.push("reconnect");
      return { ticket: stageId };
    }),
  };
  let ctx = {
    id: { toString: () => "account" },
    props: {},
    storage: {
      kv: {
        get: <T>(key: string) => store.get(key) as T | undefined,
        put: (key: string, value: unknown) => void store.set(key, value),
        delete: (key: string) => void store.delete(key),
        list: () => new Map([...store].filter(([key]) => key.startsWith("action:"))),
      },
      setAlarm: () => {},
      deleteAlarm: () => {},
    },
    exports: {
      UserAccount: { idFromString: (id: string) => id },
      GatekeeperUserImpl: ({ props }: { props: unknown }) => props,
    },
  };
  return { ctx, kv, events, callback };
}

/** Answers Atlassian's token, identity, and accessible-resources endpoints. */
function fakeAtlassian() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === AUTH_TOKEN_URL) {
      const token = `access-${exchangedTokens.length + 1}`;
      exchangedTokens.push(token);
      return Response.json({ access_token: token, refresh_token: `refresh-${token}` });
    }
    if (url === ME_URL) return Response.json({ account_id: identity.accountId, name: identity.name, email: identity.email });
    if (url === RESOURCES_URL) return Response.json([]);
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

async function connected() {
  identity = { accountId: "acc-alice", name: "Alice", email: "alice@example.com" };
  const parts = accountContext();
  const account = new UserAccount(parts.ctx as never, { CLIENT_ID: "cid", CLIENT_SECRET: "secret" } as never);
  fakeAtlassian();
  const initiation = "initiation-nonce-aaaaaaaaaaaaaaaaaaaa";
  await account.setCallback(parts.callback as never, initiation);
  const flow = await account.beginOAuthFlow(initiation);
  if (!flow) throw new Error("the connect did not start");
  const result = await account.acceptAuthCode("code-1", flow.oauthNonce);
  return { account, ...parts, result };
}

/** Runs a reconnect whose identity reads as `next`. */
async function reconnectAs(
  account: InstanceType<typeof UserAccount>, next: { accountId: string; name?: string; email?: string },
): Promise<ReconnectOutcome | { error: Error }> {
  identity = next;
  const initiation = "initiation-nonce-bbbbbbbbbbbbbbbbbbbb";
  await account.prepareReconnect(initiation);
  const flow = await account.beginOAuthFlow(initiation);
  if (!flow) throw new Error("the reconnect did not start");
  try {
    return await account.acceptAuthCode("code-2", flow.oauthNonce) as ReconnectOutcome;
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

describe("Confluence reconnect pinning", () => {
  it("pins the Atlassian account a first connect was made as", async () => {
    const { kv, events, result } = await connected();
    expect(result).toEqual({ handoff: { ticket: "handoff" } });
    expect(events).toEqual(["complete"]);
    expect(kv.get("connectionSubject")).toEqual(
      { id: "acc-alice", name: "Alice", email: "alice@example.com" });
  });

  it("refuses a reconnect that authorized a different account, staging nothing", async () => {
    const seeded = await connected();
    const result = await reconnectAs(seeded.account,
      { accountId: "acc-bob", name: "Bob", email: "bob@example.com" }) as ReconnectOutcome;
    expect(result).toEqual({
      refused: {
        title: "That's a different Atlassian account",
        detail: expect.stringContaining(
          "This connection is for alice@example.com, but Atlassian authorized bob@example.com"),
      },
    });
    // The refused grant was dropped (Atlassian has no revocation endpoint): nothing was staged
    // and the connection is untouched.
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get<{ accessToken: string }>("grant")?.accessToken).toBe("access-1");
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "acc-alice" });
    expect(seeded.events).toEqual(["complete"]);
  });

  it("stages a same-account reconnect and commits it to the live grant", async () => {
    const seeded = await connected();
    const result = await reconnectAs(seeded.account,
      { accountId: "acc-alice", name: "Alice Renamed", email: "alice@example.com" }) as { handoff: { ticket: string } };
    expect(seeded.events).toEqual(["complete", "reconnect"]);
    // Staged, not live: the old token serves until the Workshop commits.
    expect(seeded.kv.get<{ accessToken: string }>("grant")?.accessToken).toBe("access-1");
    expect(seeded.kv.get<{ stageId: string }>("stagedCredentials")?.stageId).toBe(result.handoff.ticket);
    await seeded.account.commitReconnect(result.handoff.ticket);
    expect(seeded.kv.get<{ accessToken: string }>("grant")?.accessToken).toBe("access-2");
    // The pin follows the rename, not just the id.
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "acc-alice", name: "Alice Renamed" });
  });

  it("fails the flow when the authorizing account cannot be read", async () => {
    const seeded = await connected();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === AUTH_TOKEN_URL) return Response.json({ access_token: "access-3", refresh_token: "refresh-3" });
      if (url === ME_URL) return new Response("gone", { status: 500 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const initiation = "initiation-nonce-cccccccccccccccccccc";
    await seeded.account.prepareReconnect(initiation);
    const flow = await seeded.account.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    await expect(seeded.account.acceptAuthCode("code-3", flow.oauthNonce))
      .rejects.toThrow("Could not read which Atlassian account authorized this connection");
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "acc-alice" });
  });
});
