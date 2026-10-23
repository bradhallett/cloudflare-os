import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApi, SlackApiError, type SlackInstallation, type SlackOAuthGrant } from "./slack-api";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";

// These tests exercise binding/observer behavior in Node; the production RPC schema is checked
// separately by the Worker prebuild. The only emulation here is the Workers hosting surface.
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
vi.mock("./types.txt", () => ({ default: "" }));
vi.mock("./generated/workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("./generated/conversation-configurator-ui.txt", () => ({ default: "" }));
vi.mock("./generated/thread-configurator-ui.txt", () => ({ default: "" }));

const {
  SlackUserImpl, SlackWorkspaceGatekeeperImpl, SlackConversationGatekeeperImpl,
  SlackThreadGatekeeperImpl, SlackVerifier, UserAccount, SlackCursor,
} = await import("./slack");

class MemoryKv {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  put<T>(key: string, value: T) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
  list<T>({ prefix }: { prefix: string }): Map<string, T> {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}

let installation: SlackInstallation;
let workspaces: { id: string; name: string }[];
const token = { token: "user-token", expires: new Date("2999-01-01") };

function context(initialProps: Record<string, unknown>) {
  let kv = new MemoryKv();
  let account = {
    getTeamId: async () => installation.teamId,
    getInstallation: async () => installation,
    getAccessToken: async () => token,
  };
  let exports = {
    UserAccount: { idFromString: (id: string) => id, get: () => account },
    SlackWorkspaceGatekeeperImpl: vi.fn(({ props }) => props),
    SlackConversationGatekeeperImpl: vi.fn(({ props }) => props),
    SlackThreadGatekeeperImpl: vi.fn(({ props }) => props),
  };
  return { props: initialProps, storage: { kv }, exports };
}

beforeEach(() => {
  installation = { teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" };
  workspaces = [{ id: "TONE", name: "One" }, { id: "TTWO", name: "Two" }];
  vi.spyOn(SlackApi.prototype, "listWorkspaces").mockImplementation(async () => workspaces);
  vi.spyOn(SlackApi.prototype, "getWorkspaceInfo").mockImplementation(async function (this: SlackApi) {
    let teamId = await this.workspaceTeamId();
    return { teamId, name: teamId, domain: teamId.toLowerCase() };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Slack resource binding identity", () => {
  it("retains the workspace from workspace and conversation URLs", async () => {
    let ctx = context({ userObjectId: "account" });
    let user = new SlackUserImpl(ctx as never, {} as never);
    await user.getGatekeeperClassFor("https://app.slack.com/client/TTWO");
    await user.getGatekeeperClassFor("https://app.slack.com/client/TONE/CONE");
    expect(ctx.exports.SlackWorkspaceGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TTWO" },
    });
    expect(ctx.exports.SlackConversationGatekeeperImpl).toHaveBeenCalledWith({
      props: { userObjectId: "account", teamId: "TONE", conversationId: "CONE" },
    });
    await expect(user.getGatekeeperClassFor("https://app.slack.com/client/EORG"))
        .rejects.toThrow("not an enterprise");
  });

  it("resolves a thread's workspace from its permalink host", async () => {
    let resolve = vi.spyOn(SlackApi.prototype, "workspaceIdForDomain").mockResolvedValue("TTWO");
    let ctx = context({ userObjectId: "account" });
    await new SlackUserImpl(ctx as never, {} as never)
        .getGatekeeperClassFor("https://two.slack.com/archives/CTWO/p123000001");
    expect(resolve).toHaveBeenCalledWith("two");
    expect(ctx.exports.SlackThreadGatekeeperImpl).toHaveBeenCalledWith({
      props: expect.objectContaining({ teamId: "TTWO", conversationId: "CTWO" }),
    });
  });

  it("pins a legacy workspace binding independently of later reconnects", async () => {
    installation = { teamId: "TONE" };
    let ctx = context({ userObjectId: "account" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TONE");
    installation = { teamId: "TTWO", isEnterpriseInstall: false };
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TONE");
    expect(ctx.storage.kv.get("boundTeamId")).toBe("TONE");
  });

  it("recovers only an unambiguous legacy org workspace", async () => {
    let ctx = context({ userObjectId: "account" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    await expect(binding.describe()).rejects.toThrow("no unambiguous workspace");
    expect(ctx.storage.kv.get("boundTeamId")).toBeUndefined();
    workspaces = [{ id: "TTWO", name: "Two" }];
    expect((await binding.describe()).url).toBe("https://app.slack.com/client/TTWO");
  });

  it("does not redirect a selected binding after its workspace grant is removed", async () => {
    let binding = new SlackWorkspaceGatekeeperImpl(
        context({ userObjectId: "account", teamId: "TTWO" }) as never, {} as never);
    await binding.describe();
    workspaces = [{ id: "TONE", name: "One" }];
    await expect(binding.describe()).rejects.toMatchObject({ code: "team_access_not_granted" });
  });

  it("revalidates a long-lived cursor when its cached account credential reaches the refresh window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let ctx = context({ userObjectId: "account", teamId: "TONE" });
    let account = ctx.exports.UserAccount.get();
    let currentToken = { token: "org-token", expires: new Date(Date.now() + 60 * 60 * 1000) };
    let getAccessToken = vi.spyOn(account, "getAccessToken").mockImplementation(async () => currentToken);
    let read = vi.fn(async () => Response.json({ ok: true,
      members: [{ id: "WSELF", name: "ddr" }], response_metadata: { next_cursor: "next-page" } }));
    vi.stubGlobal("fetch", read);
    let queue = { dup() { return this; }, authorizeObservation: vi.fn(async () => undefined) };
    let session = await new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never)
        .startSession(queue as never);
    let cursor = await session.listUsers();
    expect(await cursor.next()).toMatchObject([{ id: "WSELF" }]);
    installation = { teamId: "TTWO", isEnterpriseInstall: false };
    workspaces = [{ id: "TTWO", name: "Two" }];
    currentToken = { token: "workspace-token", expires: new Date(Date.now() + 12 * 60 * 60 * 1000) };
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await expect(cursor.next()).rejects.toMatchObject({ code: "team_access_not_granted" });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
    expect(ctx.storage.kv.get("boundTeamId")).toBe("TONE");
  });

  it("commits org metadata only when the staged reconnect is committed", async () => {
    let ctx = context({});
    let account = new UserAccount(ctx as never, {} as never);
    ctx.storage.kv.put("teamId", "TONE");
    ctx.storage.kv.put("teamName", "Old workspace");
    let grant: SlackOAuthGrant = { accessToken: token, grantedScopes: ["users:read"],
      userId: "WSELF", teamId: "", isEnterpriseInstall: true, enterpriseId: "EORG" };
    let stageId = stageCredentials(ctx.storage.kv, grant, Date.now());
    expect(await account.getInstallation()).toEqual({ teamId: "TONE" });
    await account.commitReconnect(stageId);
    expect(await account.getInstallation()).toEqual(installation);
    expect(ctx.storage.kv.get("teamName")).toBeUndefined();
  });

  it("preserves legacy narrow grants for new consent without claiming they can already be read", async () => {
    let ctx = context({});
    let account = new UserAccount(ctx as never, {} as never);
    ctx.storage.kv.put("grantedScopes",
        ["users:read", "channels:history", "groups:history", "im:history", "mpim:history"]);
    expect(await account.getGrantedResourceUrlPatterns()).toEqual([]);
    expect(await account.getResourceUrlPatternsForReconnect())
        .toEqual(["https://*.slack.com/archives/:conversationId/:messageId"]);
    ctx.storage.kv.put("grantedScopes", [
      "users:read", "channels:read", "channels:history", "groups:read", "groups:history",
      "im:read", "im:history", "mpim:read", "mpim:history", "search:read",
    ]);
    expect(await account.getGrantedResourceUrlPatterns()).toEqual([]);
    expect(await account.getResourceUrlPatternsForReconnect()).toEqual([
      "https://app.slack.com/client/:teamId/:conversationId",
      "https://*.slack.com/archives/:conversationId/:messageId",
    ]);
  });
});

describe("Slack org observer isolation", () => {
  it("checks the observer's selected workspace rather than enterprise equality", async () => {
    let binding = new SlackWorkspaceGatekeeperImpl(
        context({ userObjectId: "account", teamId: "TTWO" }) as never, {} as never);
    let observer = { hasWorkspaceAccess: vi.fn(async () => false) };
    await expect(binding.addObserver("observer", observer as never)).rejects.toThrow("not a member");
    expect(observer.hasWorkspaceAccess).toHaveBeenCalledWith("TTWO");
  });

  it("checks tracked and new conversations in that same workspace before disclosure", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TTWO" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    ctx.storage.kv.put("trackedConversation:COLD", "observed");
    let observer = { hasWorkspaceAccess: vi.fn(async () => true),
      hasConversationAccess: vi.fn(async () => true) };
    await binding.addObserver("observer", observer as never);
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("COLD", "TTWO");
    observer.hasConversationAccess.mockResolvedValue(false);
    let queue = { authorizeObservation: vi.fn(async () => undefined) };
    await binding.authorizeConversationObservation(queue as never, ["CNEW"], { title: "Read", description: "Test" });
    expect(observer.hasConversationAccess).toHaveBeenCalledWith("CNEW", "TTWO");
    expect(queue.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      excludeObservers: ["observer"],
    }));
    expect(ctx.storage.kv.get("trackedConversation:CNEW")).toBe("observed");
  });

  it("keeps blocked observations pending so retries recheck observer access", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TONE" });
    let binding = new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never);
    let observer = { hasWorkspaceAccess: vi.fn(async () => true),
      hasConversationAccess: vi.fn(async () => false) };
    await binding.addObserver("observer", observer as never);
    let queue = { authorizeObservation: vi.fn(async () => { throw new Error("blocked"); }) };
    await expect(binding.authorizeConversationObservation(
        queue as never, ["CNEW"], { title: "Read", description: "Test" })).rejects.toThrow("blocked");
    expect(ctx.storage.kv.get("trackedConversation:CNEW")).toBe("pending");
    await expect(binding.authorizeConversationObservation(
        queue as never, ["CNEW"], { title: "Read", description: "Test" })).rejects.toThrow("blocked");
    expect(observer.hasConversationAccess).toHaveBeenCalledTimes(2);
  });

  it("passes workspace identity into conversation and thread observer checks", async () => {
    let observer = { hasConversationAccess: vi.fn(async () => true) };
    let ctx = context({ userObjectId: "account", teamId: "TTWO", conversationId: "CTWO",
      threadTs: "123.000001", permalink: "https://two.slack.com/archives/CTWO/p123000001" });
    await new SlackConversationGatekeeperImpl(ctx as never, {} as never).addObserver("id", observer as never);
    await new SlackThreadGatekeeperImpl(ctx as never, {} as never).addObserver("id", observer as never);
    expect(observer.hasConversationAccess).toHaveBeenNthCalledWith(1, "CTWO", "TTWO");
    expect(observer.hasConversationAccess).toHaveBeenNthCalledWith(2, "CTWO", "TTWO");
  });

  it("treats workspace removal as denial but propagates transient failures", async () => {
    let verifier = new SlackVerifier(context({ userObjectId: "observer" }) as never, {} as never);
    workspaces = [{ id: "TONE", name: "One" }];
    expect(await verifier.hasWorkspaceAccess("TTWO")).toBe(false);
    expect(await verifier.hasConversationAccess("CTWO", "TTWO")).toBe(false);
    vi.spyOn(SlackApi.prototype, "listWorkspaces").mockRejectedValue(new SlackApiError("ratelimited", 429));
    await expect(verifier.hasWorkspaceAccess("TONE")).rejects.toMatchObject({ code: "ratelimited" });
  });
});

describe("Slack cursor page budget", () => {
  // The script these tests walk: pages that come back empty but keep promising more, then one
  // with results — the shape that used to walk the whole workspace inside a single next().
  function emptyUntilFound(): Array<{ items: string[]; nextCursor?: string }> {
    return [
      { items: [], nextCursor: "p2" },
      { items: [], nextCursor: "p3" },
      { items: [], nextCursor: "p4" },
      { items: [], nextCursor: "p5" },
      { items: ["found"] },
    ];
  }

  function scriptedCursor(
      pages: Array<{ items: string[]; nextCursor?: string }>,
      options?: { maxProviderPagesPerCall?: number }) {
    let queue = { dup() { return this; }, [Symbol.dispose]() {} };
    let requested: (string | undefined)[] = [];
    let cursor = new SlackCursor<string>(
        { approvalQueue: queue } as never,
        async (_ctx, current) => {
          requested.push(current);
          return pages[requested.length - 1];
        },
        options);
    return { cursor, requested };
  }

  it("surfaces after the default two provider pages instead of fetching the world", async () => {
    let { cursor, requested } = scriptedCursor(emptyUntilFound());
    expect(await cursor.next()).toEqual([]);
    expect(requested).toEqual([undefined, "p2"]);
    // The budget is per call: draining still reaches every page that has results.
    expect(await cursor.next()).toEqual([]);
    expect(requested).toEqual([undefined, "p2", "p3", "p4"]);
    expect(await cursor.next()).toEqual(["found"]);
    expect(requested).toHaveLength(5);
    await expect(cursor.next()).resolves.toBeNull();
  });

  it("reports null, not an empty page, when the walk ends on empty pages", async () => {
    let { cursor, requested } = scriptedCursor([
      { items: [], nextCursor: "p2" },
      { items: [], nextCursor: "p3" },
      { items: [] },
    ]);
    expect(await cursor.next()).toEqual([]);
    expect(requested).toEqual([undefined, "p2"]);
    await expect(cursor.next()).resolves.toBeNull();
  });

  it("opts in to a deeper window with maxProviderPagesPerCall", async () => {
    let { cursor, requested } =
        scriptedCursor(emptyUntilFound(), { maxProviderPagesPerCall: 4 });
    expect(await cursor.next()).toEqual([]);
    expect(requested).toEqual([undefined, "p2", "p3", "p4"]);
    expect(await cursor.next()).toEqual(["found"]);
    expect(requested).toHaveLength(5);
  });

  it("bounds a workspace member listing to two provider pages per next()", async () => {
    let ctx = context({ userObjectId: "account", teamId: "TONE" });
    let read = vi.fn(async (input: string | URL) => {
      let cursor = new URL(String(input)).searchParams.get("cursor");
      if (cursor === null) {
        return Response.json({ ok: true, members: [], response_metadata: { next_cursor: "p2" } });
      }
      if (cursor === "p2") {
        return Response.json({ ok: true, members: [], response_metadata: { next_cursor: "p3" } });
      }
      return Response.json({ ok: true, members: [{ id: "WSELF", name: "ddr" }] });
    });
    vi.stubGlobal("fetch", read);
    let queue = { dup() { return this; }, authorizeObservation: vi.fn(async () => undefined) };
    let session = await new SlackWorkspaceGatekeeperImpl(ctx as never, {} as never)
        .startSession(queue as never);
    let members = await session.listUsers();
    expect(await members.next()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    // Each provider page is authorized as it is read; the bound caps how many that can be.
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(2);
    expect(await members.next()).toMatchObject([{ id: "WSELF" }]);
    expect(read).toHaveBeenCalledTimes(3);
    await expect(members.next()).resolves.toBeNull();
  });
});

type ReconnectOutcome = { handoff: { ticket: string } } | { refused: { title: string; detail: string } };

  // Node's WebCrypto lacks the Workers-only timingSafeEqual the flow's nonce checks call.
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      ...crypto, randomUUID: () => crypto.randomUUID(), getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: {
        ...crypto.subtle,
        timingSafeEqual: (a: Uint8Array, b: Uint8Array) =>
          a.length === b.length && a.every((byte, i) => byte === b[i]),
      },
    });
  });
describe("Slack reconnect pinning", () => {

  // A connection is pinned to the installation it was made as (`teamId:userId`), so a reconnect
  // as anyone else, or into any other workspace, is refused and the new grant revoked. Slack is
  // faked at `fetch`.
  const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
  const REVOKE_URL = "https://slack.com/api/auth.revoke";

  function accountContext() {
    let kv = new MemoryKv();
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
      storage: { kv, setAlarm: () => {}, deleteAlarm: () => {} },
      exports: { UserAccount: { idFromString: (id: string) => id }, SlackUserImpl: ({ props }: never) => props },
    };
    return { ctx, kv, events, callback };
  }

  /** Answers Slack's token endpoint for `grant`; every revoke is recorded. */
  function fakeSlack(grant: SlackOAuthGrant) {
    let revokes: string[] = [];
    let read = vi.fn(async (input: string | URL, init?: RequestInit) => {
      let url = String(input);
      if (url === TOKEN_URL) {
        return Response.json({
          ok: true,
          team: { id: grant.teamId, name: grant.teamName },
          is_enterprise_install: grant.isEnterpriseInstall,
          enterprise: grant.enterpriseId ? { id: grant.enterpriseId } : undefined,
          authed_user: {
            access_token: grant.accessToken.token,
            expires_in: 12 * 60 * 60,
            refresh_token: grant.refreshToken,
            scope: grant.grantedScopes.join(","),
            id: grant.userId,
          },
        });
      }
      if (url === REVOKE_URL) {
        revokes.push(String(new URLSearchParams(String(init?.body)).get("token")));
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", read);
    return { revokes, read, as: (next: SlackOAuthGrant) => { grant = next; } };
  }

  function grantFor(over: Partial<SlackOAuthGrant>): SlackOAuthGrant {
    return { accessToken: token, grantedScopes: [], userId: "WSELF",
      teamId: "TONE", teamName: "One", isEnterpriseInstall: false, ...over };
  }

  async function connected() {
    let parts = accountContext();
    let account = new UserAccount(parts.ctx as never, { CLIENT_ID: "cid", CLIENT_SECRET: "secret" } as never);
    let slack = fakeSlack(grantFor({}));
    await account.setCallback(parts.callback as never, "initiation-nonce-aaaaaaaaaaaaaaaaaaaa", []);
    let flow = await account.beginOAuthFlow("initiation-nonce-aaaaaaaaaaaaaaaaaaaa");
    if (!flow) throw new Error("the connect did not start");
    await account.acceptAuthCode("code-1", flow.oauthNonce);
    return { account, ...parts, slack };
  }

  /** Runs a reconnect flow whose token exchange hands back `next` instead of the live grant. */
  async function reconnectAs(
    account: InstanceType<typeof UserAccount>, slack: { as(grant: SlackOAuthGrant): void }, next: SlackOAuthGrant,
  ): Promise<ReconnectOutcome> {
    slack.as(next);
    let initiation = `initiation-nonce-${"f".repeat(24)}`;
    await account.prepareReconnect(initiation, []);
    let flow = await account.beginOAuthFlow(initiation);
    if (!flow) throw new Error("the reconnect did not start");
    return await account.acceptAuthCode("code-2", flow.oauthNonce) as ReconnectOutcome;
  }

  it("pins the installation a first connect was made as", async () => {
    let { kv, events } = await connected();
    expect(events).toEqual(["complete"]);
    expect(kv.get("connectionSubject")).toEqual({ id: "TONE:WSELF", teamId: "TONE", userId: "WSELF", teamName: "One" });
  });

  it("refuses a reconnect as another user, revoking the new grant", async () => {
    let seeded = await connected();
    let result = await reconnectAs(seeded.account, seeded.slack, grantFor({
      accessToken: { token: "bob-token", expires: new Date("2999-01-01") },
      refreshToken: "bob-refresh", userId: "WBOB",
    }));
    expect(result).toEqual({
      refused: {
        title: "That's a different Slack account",
        detail: expect.stringContaining(
          "This connection is for user WSELF in One, but Slack authorized user WBOB in One"),
      },
    });
    // Bob's tokens were retired at Slack; nothing was staged and the connection is untouched.
    expect(seeded.slack.revokes).toEqual(["bob-refresh", "bob-token"]);
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get<{ token: string }>("accessToken")?.token).toBe("user-token");
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "TONE:WSELF" });
    expect(seeded.events).toEqual(["complete"]);
  });

  it("refuses a reconnect into another workspace, revoking the new grant", async () => {
    let seeded = await connected();
    let result = await reconnectAs(seeded.account, seeded.slack, grantFor({
      accessToken: { token: "two-token", expires: new Date("2999-01-01") },
      teamId: "TTWO", teamName: "Two",
    }));
    expect(result).toEqual({
      refused: {
        title: "That's a different Slack account",
        detail: expect.stringContaining("This connection is for user WSELF in One, but Slack authorized user WSELF in Two"),
      },
    });
    expect(seeded.slack.revokes).toEqual(["two-token"]);
    expect(seeded.kv.get("stagedCredentials")).toBeUndefined();
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "TONE:WSELF" });
  });

  it("stages a same-account reconnect and commits it to the live grant", async () => {
    let seeded = await connected();
    let result = await reconnectAs(seeded.account, seeded.slack, grantFor({
      accessToken: { token: "one-token-2", expires: new Date("2999-01-01") },
      refreshToken: "one-refresh-2", teamName: "One Renamed",
    })) as { handoff: { ticket: string } };
    // Staged, not live: the old token serves until the Workshop commits.
    expect(seeded.events).toEqual(["complete", "reconnect"]);
    expect(seeded.kv.get<{ token: string }>("accessToken")?.token).toBe("user-token");
    expect(seeded.kv.get("stagedCredentials")).toMatchObject({ stageId: result.handoff.ticket });
    await seeded.account.commitReconnect(result.handoff.ticket);
    expect(seeded.kv.get<{ token: string }>("accessToken")?.token).toBe("one-token-2");
    expect(seeded.kv.get("refreshToken")).toBe("one-refresh-2");
    expect(seeded.kv.get("connectionSubject")).toMatchObject({ id: "TONE:WSELF" });
  });

  it("clears the pin when a first connect the Workshop never takes", async () => {
    let parts = accountContext();
    parts.callback.complete.mockRejectedValue(new Error("workshop gone"));
    let account = new UserAccount(parts.ctx as never, { CLIENT_ID: "cid", CLIENT_SECRET: "secret" } as never);
    fakeSlack(grantFor({}));
    await account.setCallback(parts.callback as never, "initiation-nonce-aaaaaaaaaaaaaaaaaaaa", []);
    let flow = await account.beginOAuthFlow("initiation-nonce-aaaaaaaaaaaaaaaaaaaa");
    if (!flow) throw new Error("the connect did not start");
    await expect(account.acceptAuthCode("code-1", flow.oauthNonce)).rejects.toThrow("workshop gone");
    expect(parts.kv.get("accessToken")).toBeUndefined();
    expect(parts.kv.get("connectionSubject")).toBeUndefined();
  });
});