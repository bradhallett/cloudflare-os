// A Home Assistant connection is pinned to its instance URL: a reconnect submitting credentials
// for a different instance is refused outright — nothing staged, the nonce claim released so the
// owner can resubmit — and a same-instance reconnect stages for the Workshop to commit. A
// same-instance user-swap cannot be detected (HA tokens carry no user id); see
// HomeAssistantSubject in src/homeassistant.ts. The instance is faked at `fetch`; these tests run
// in Node, so the Workers hosting surface is mocked. The kv is a plain Map because the stored
// RPC callback is a mock and must survive storage un-cloned.

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
vi.mock("../src/generated/instance-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/area-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/label-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/device-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/entity-configurator-ui.txt", () => ({ default: "" }));

// Loaded dynamically so every vi.mock above is in effect first; a static import of the module
// (which pulls in the mocked Workers surface) would race the mock registry.
const { UserAccount } = await import("../src/homeassistant");

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

/** Answers pings only for the good token; every other request is unauthorized. */
function fakeHomeAssistant() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    if (url.pathname === "/api/" && auth === "Bearer good-token") {
      return Response.json({ message: "API running." });
    }
    return new Response("unauthorized", { status: 401 });
  }));
}

function accountContext() {
  const store = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => store.get(key) as T | undefined,
  };
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
      },
      setAlarm: () => {},
      deleteAlarm: () => {},
    },
    exports: {
      HomeAssistantUserImpl: ({ props }: { props: unknown }) => props,
    },
  };
  return { ctx, kv, events, callback };
}

async function connected() {
  const parts = accountContext();
  const account = new UserAccount(parts.ctx as never, {} as never);
  fakeHomeAssistant();
  await account.setCallback(parts.callback as never, "initiation-nonce");
  const result = await account.completeConnection("initiation-nonce", "https://ha.example.com", "good-token");
  expect(result).toEqual({ kind: "ok", handoff: { ticket: "handoff" } });
  return { account, ...parts };
}

describe("Home Assistant reconnect pinning", () => {
  it("pins the instance a first connect was made as", async () => {
    const { kv, events } = await connected();
    expect(events).toEqual(["complete"]);
    expect(kv.get("connectionSubject")).toEqual({ id: "https://ha.example.com" });
    expect(kv.get<{ baseUrl: string; token: string }>("credentials"))
      .toEqual({ baseUrl: "https://ha.example.com", token: "good-token" });
  });

  it("refuses a reconnect for a different instance, staging nothing and releasing the nonce", async () => {
    const seeded = await connected();
    await seeded.account.prepareReconnect("reconnect-nonce");
    const result = await seeded.account.completeConnection(
      "reconnect-nonce", "https://other.example.com", "good-token");
    expect(result).toEqual({
      kind: "error",
      message: "This connection is for the Home Assistant instance at https://ha.example.com, " +
        "but you submitted credentials for https://other.example.com. Reconnect with a token " +
        "for https://ha.example.com, or connect https://other.example.com as a separate account.",
    });
    // Nothing was staged and the live credentials are untouched.
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get<{ baseUrl: string }>("credentials")?.baseUrl).toBe("https://ha.example.com");
    expect(seeded.kv.get("connectionSubject")).toEqual({ id: "https://ha.example.com" });
    expect(seeded.events).toEqual(["complete"]);
    // The nonce claim was released: resubmitting the pinned instance now succeeds.
    const retry = await seeded.account.completeConnection(
      "reconnect-nonce", "https://ha.example.com", "good-token");
    expect(retry).toEqual({ kind: "ok", handoff: { ticket: expect.any(String) } });
  });

  it("stages a same-instance reconnect and commits it to the live credentials", async () => {
    const seeded = await connected();
    await seeded.account.prepareReconnect("reconnect-nonce");
    const result = await seeded.account.completeConnection(
      "reconnect-nonce", "https://ha.example.com", "good-token");
    expect(result.kind).toBe("ok");
    const stageId = result.kind === "ok" ? result.handoff.ticket : undefined;
    expect(stageId).toEqual(expect.any(String));
    expect(seeded.events).toEqual(["complete", "reconnect"]);
    // Staged, not live: the token serves until the Workshop commits, and the pin is unchanged.
    expect(seeded.kv.get("stagedCredentials")).toBeDefined();
    expect(seeded.kv.get<{ token: string }>("credentials")?.token).toBe("good-token");
    await seeded.account.commitReconnect(String(stageId));
    expect(seeded.kv.get("connectionSubject")).toEqual({ id: "https://ha.example.com" });
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
  });
});
