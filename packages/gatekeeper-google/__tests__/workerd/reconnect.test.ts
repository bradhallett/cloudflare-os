// The account's OAuth completion is pinned to the Google account it was made as: a reconnect as
// anyone else is refused and the grant Google issued for it is revoked, while a same-account
// reconnect only stages, going live when the Workshop commits it. Google is faked at `fetch`.

import { env, runInDurableObject } from "cloudflare:test";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import type { UserAccount } from "../../src/google";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectCallbackEvents } from "./worker";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/** A token-endpoint grant, numbered so tests can tell them apart. */
function grant(n: number): Record<string, unknown> {
  return {
    access_token: `ya29-${n}`, expires_in: 3600, refresh_token: `rt-${n}`,
    scope: "openid email profile",
  };
}

/** Google's token, userinfo and revoke endpoints, answered by the test's handlers. */
class FakeGoogle {
  /** Tokens revoked through the revoke endpoint, in order. */
  readonly revoked: string[] = [];
  respondToken: () => Response = () => json({ error: "unexpected_token_request" }, 500);
  respondUserinfo: () => Response = () => json({ sub: "alice-subject", email: "alice@example.test" });

  constructor() {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      this.#handle(new Request(input, init)));
  }

  async #handle(request: Request): Promise<Response> {
    if (request.url === TOKEN_URL) return this.respondToken();
    if (request.url === USERINFO_URL) return this.respondUserinfo();
    if (request.url === REVOKE_URL) {
      const form = await request.formData();
      this.revoked.push(String(form.get("token")));
      return json({});
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  }
}

type TestExports = {
  TestConnectCallback(options: { props: { name: string } }): Fetcher<GatekeeperConnectCallback>;
};

const exportsOf = (state: DurableObjectState) => state.exports as unknown as TestExports;

let connections = 0;

/** Connects a fresh account through the OAuth flow, with Google answering the code exchange. */
async function connect(google: FakeGoogle) {
  const name = `account-${++connections}`;
  const id = env.UserAccount.newUniqueId();
  const account = env.UserAccount.get(id);
  await runInDurableObject(account, async (instance, state) => {
    await instance.setCallback(
      exportsOf(state).TestConnectCallback({ props: { name } }), "initiation-nonce", [], "connect");
  });
  google.respondToken = () => json(grant(1));
  const begun = await account.beginOAuthFlow("initiation-nonce", "https://example.test/oauth");
  expect(await account.acceptAuthCode("code", begun!.oauthNonce)).not.toBeNull();
  return { account, id, events: () => connectCallbackEvents.get(name) ?? [] };
}

/** The live grant and the subject it is pinned to, as plain data. */
async function storedConnection(userObjectId: string) {
  return await runInDurableObject(
    env.UserAccount.get(env.UserAccount.idFromString(userObjectId)),
    async (_instance, state) => ({
      refreshToken: await state.storage.kv.get<string>("refreshToken"),
      pinnedSubject: await state.storage.kv.get<{ id: string }>("connectionSubject"),
    }));
}

/** Runs a reconnect up to the callback, with Google authorizing `subject`. */
async function reconnectAs(
  google: FakeGoogle, account: DurableObjectStub<UserAccount>, subject: string) {
  google.respondToken = () => json(grant(2));
  google.respondUserinfo = () => json({ sub: subject, email: "someone@example.test" });
  await account.prepareReconnect("reconnect-nonce", []);
  const begun = await account.beginOAuthFlow("reconnect-nonce", "https://example.test/oauth");
  if (!begun) throw new Error("the reconnect did not start");
  return await account.acceptAuthCode("code-2", begun.oauthNonce);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconnecting", () => {
  it("refuses a reconnect as another Google account, and revokes what Google granted it",
    async () => {
      const google = new FakeGoogle();
      const { account, id, events } = await connect(google);
      const before = await storedConnection(id.toString());
    expect(before).toEqual({ refreshToken: "rt-1", pinnedSubject: { id: "alice-subject" } });

      const result = await reconnectAs(google, account, "bob-subject");

      expect(result).toEqual({
        refused: {
          title: "That's a different Google account",
          detail: expect.stringContaining("made for another Google account"),
        },
      });
      // Bob's new grant, and only it; Alice's live grant and pin are untouched.
      expect(google.revoked).toEqual(["rt-2"]);
      expect(await storedConnection(id.toString())).toEqual(before);
      expect(events()).toEqual(["complete"]);
    });

  it("stages a same-account reconnect, committing it only when the Workshop says so", async () => {
    const google = new FakeGoogle();
    const { account, id, events } = await connect(google);
    const before = await storedConnection(id.toString());

    const result = await reconnectAs(google, account, "alice-subject");

    if (result === null || !("handoff" in result)) throw new Error("expected a handoff");
    expect(await storedConnection(id.toString())).toEqual(before);
    expect(google.revoked).toEqual([]);
    const stageId = events().at(-1)!.slice("reconnectComplete:".length);
    await account.commitReconnect(stageId);

    expect(await storedConnection(id.toString()))
      .toEqual({ refreshToken: "rt-2", pinnedSubject: { id: "alice-subject" } });
    expect(google.revoked).toEqual([]);
    const failure = await runInDurableObject(account, async instance => {
      try {
        await instance.commitReconnect(stageId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toMatch(/No reconnect is awaiting/);
  });

  it("admits and pins a reconnect of an account connected before the pin existed", async () => {
    const google = new FakeGoogle();
    const { account, id } = await connect(google);
    // The account predates pinning: nothing recorded which Google account it belongs to.
    await runInDurableObject(env.UserAccount.get(env.UserAccount.idFromString(id.toString())),
      (_instance, state) => {
        state.storage.kv.delete("connectionSubject");
      });

    const result = await reconnectAs(google, account, "bob-subject");

    if (result === null || !("handoff" in result)) throw new Error("expected a handoff");
    const stageId = (connectCallbackEvents.get(`account-${connections}`) ?? [])
      .at(-1)!.slice("reconnectComplete:".length);
    await account.commitReconnect(stageId);
    expect(await storedConnection(id.toString()))
      .toEqual({ refreshToken: "rt-2", pinnedSubject: { id: "bob-subject" } });
  });

  it("refuses to finish a connect when Google will not say which account authorized", async () => {
    const google = new FakeGoogle();
    const id = env.UserAccount.newUniqueId();
    await runInDurableObject(env.UserAccount.get(id), async (instance, state) => {
      await instance.setCallback(
        exportsOf(state).TestConnectCallback({ props: { name: "unreadable" } }),
        "initiation-nonce", [], "connect");
      google.respondToken = () => json(grant(1));
      google.respondUserinfo = () => json({ error: "insufficient permissions" }, 403);
      const begun = await instance.beginOAuthFlow("initiation-nonce", "https://example.test/oauth");

      await expect(instance.acceptAuthCode("code", begun!.oauthNonce))
        .rejects.toThrow(/Could not read which Google account/);
      expect(state.storage.kv.get("refreshToken")).toBeUndefined();
      expect(state.storage.kv.get("connectionSubject")).toBeUndefined();
    });
    // The grant Google issued was revoked rather than left dangling.
    expect(google.revoked).toEqual(["rt-1"]);
  });
});
