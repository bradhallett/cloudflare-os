// A reconnect pins the Notion account it was made as: the owner the new grant names must match
// the pinned one. A mismatch is refused without staging anything and the new grant dropped
// (Notion offers no revocation endpoint). A grant naming NO owner cannot be told from any
// account's, so it stages subjectless and its commit leaves the pin exactly as it was. Notion is
// faked at `fetch`; these tests run in Node, so the Workers hosting surface is mocked.

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
vi.mock("../src/notion-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/notion-item-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/notion-workspace-configurator-ui.txt", () => ({ default: "" }));

// Loaded dynamically so every vi.mock above is in effect first; a static import of the module
// (which pulls in the mocked Workers surface) would race the mock registry.
const { UserAccount } = await import("../src/notion");

// Node's WebCrypto lacks the Workers-only timingSafeEqual the flow's nonce checks call.
beforeEach(() => {
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
type FakeOwner = { id: string; name?: string; avatarUrl?: string } | null | undefined;

const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/** The owner the fake Notion names in the next token response, and its access token. */
let owner: FakeOwner;
let nextToken: string;
function accountContext() {
  let store = new Map<string, unknown>();
  let events: string[] = [];
  let callback = {
    complete: vi.fn(async () => { events.push("complete"); return { ticket: "handoff" }; }),
    reconnectComplete: vi.fn(async (stageId: string) => {
      events.push("reconnect");
      return { ticket: stageId };
    }),
  };
  let kv = {
    get: <T>(key: string) => store.get(key) as T | undefined,
  };
  let ctx = {
    id: { toString: () => "account" },
    props: {},
    storage: {
      kv: {
        get: <T>(key: string) => store.get(key) as T | undefined,
        put: (key: string, value: unknown) => void store.set(key, value),
        delete: (key: string) => void store.delete(key),
        list: () => new Map(store),
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

function fakeNotion() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    if (String(input) === TOKEN_URL) {
      const ownerObject = owner === null || owner === undefined
        ? null
        : { type: "user", user: { id: owner.id, name: owner.name, avatar_url: owner.avatarUrl } };
      return Response.json({
        access_token: nextToken,
        owner: ownerObject,
        workspace_id: "ws-1",
        workspace_name: "Acme",
      });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  }));
}

async function connected() {
  owner = { id: "owner-alice", name: "Alice" };
  nextToken = "one-token";
  const parts = accountContext();
  const account = new UserAccount(parts.ctx as never, { CLIENT_ID: "cid", CLIENT_SECRET: "secret" } as never);
  fakeNotion();
  const initiation = "initiation-nonce-aaaaaaaaaaaaaaaaaaaa";
  await account.setCallback(parts.callback as never, initiation);
  const flow = await account.beginOAuthFlow(initiation);
  if (!flow) throw new Error("the connect did not start");
  const result = await account.acceptAuthCode("code-1", flow.oauthNonce);
  return { account, ...parts, result };
}

/** Runs a reconnect whose grant names `nextOwner` (or none, for undefined). */
async function reconnectAs(
  account: InstanceType<typeof UserAccount>, nextOwner: FakeOwner,
): Promise<ReconnectOutcome> {
  owner = nextOwner;
  nextToken = "two-token";
  const initiation = "initiation-nonce-bbbbbbbbbbbbbbbbbbbb";
  await account.prepareReconnect(initiation);
  const flow = await account.beginOAuthFlow(initiation);
  if (!flow) throw new Error("the reconnect did not start");
  return await account.acceptAuthCode("code-2", flow.oauthNonce) as ReconnectOutcome;
}

describe("Notion reconnect pinning", () => {
  it("pins the owner a first connect was made as, and skips the pin when the grant names none", async () => {
    const { kv, events, result } = await connected();
    expect(result).toEqual({ handoff: { ticket: "handoff" } });
    expect(events).toEqual(["complete"]);
    expect(kv.get("connectionSubject")).toEqual({ id: "owner-alice", name: "Alice" });

    // A subjectless first connect pins nothing; a later named reconnect adopts the pin.
    owner = undefined;
    nextToken = "anon-token";
    const anon = accountContext();
    const anonAccount = new UserAccount(anon.ctx as never, { CLIENT_ID: "cid", CLIENT_SECRET: "secret" } as never);
    fakeNotion();
    const initiation = "initiation-nonce-aaaaaaaaaaaaaaaaaaaa";
    await anonAccount.setCallback(anon.callback as never, initiation);
    const flow = await anonAccount.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the connect did not start");
    await anonAccount.acceptAuthCode("code-1", flow.oauthNonce);
    expect(anon.kv.get("connectionSubject")).toBeUndefined();
  });

  it("refuses a reconnect that authorized a different account, staging nothing", async () => {
    const seeded = await connected();
    const result = await reconnectAs(seeded.account, { id: "owner-bob", name: "Bob" });
    expect(result).toEqual({
      refused: {
        title: "That's a different Notion account",
        detail: expect.stringContaining("This connection is for Alice, but Notion authorized Bob"),
      },
    });
    // The refused grant was dropped (Notion has no revocation endpoint): nothing was staged and
    // the connection is untouched.
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get("accessToken")).toBe("one-token");
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "owner-alice" });
    expect(seeded.events).toEqual(["complete"]);
  });

  it("stages a same-account reconnect and commits it to the live token", async () => {
    const seeded = await connected();
    const result = await reconnectAs(seeded.account, { id: "owner-alice", name: "Alice" }) as { handoff: { ticket: string } };
    expect(seeded.events).toEqual(["complete", "reconnect"]);
    // Staged, not live: the old token serves until the Workshop commits.
    expect(seeded.kv.get("accessToken")).toBe("one-token");
    expect(seeded.kv.get<{ stageId: string }>("stagedCredentials")?.stageId).toBe(result.handoff.ticket);
    await seeded.account.commitReconnect(result.handoff.ticket);
    expect(seeded.kv.get("accessToken")).toBe("two-token");
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "owner-alice" });
  });

  it("stages a subjectless reconnect subjectless, whose commit leaves the pin as it was", async () => {
    const seeded = await connected();
    const result = await reconnectAs(seeded.account, undefined) as { handoff: { ticket: string } };
    expect(seeded.events).toEqual(["complete", "reconnect"]);
    // The stage carries no subject, so the kit's fence ignores it and the commit keeps the pin.
    expect(seeded.kv.get<{ subject?: unknown }>("stagedCredentials")?.subject).toBeUndefined();
    await seeded.account.commitReconnect(result.handoff.ticket);
    expect(seeded.kv.get("accessToken")).toBe("two-token");
    expect(seeded.kv.get("connectionSubject")).toEqual({ id: "owner-alice", name: "Alice" });
  });
});
