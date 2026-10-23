import { describe, expect, it } from "vitest";
import {
  clearConnectionSubject,
  commitReconnect,
  commitStagedCredentials,
  CONNECTION_SUBJECT_KEY,
  ConnectionSubject,
  discardStagedCredentials,
  peekStagedCredentials,
  pinnedConnectionSubject,
  pinConnectionSubject,
  stageCredentials,
  stageReconnect,
  STAGED_CREDENTIALS_KEY,
} from "../src/credential-stage";
import { OAUTH_NONCE_LIFETIME_MS } from "../src/connect-nonce";
import { fakeKv } from "./fake-kv";

type Grant = { accessToken: string; scopes: string[] };
const GRANT: Grant = { accessToken: "new-token", scopes: ["repo"] };

describe("credential stage", () => {
  it("pins the durable key", () => {
    expect(STAGED_CREDENTIALS_KEY).toBe("stagedCredentials");
  });

  it("commits what was staged exactly once, to the id it handed out", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(stageId).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toEqual(GRANT);
    expect(kv.keys()).toEqual([]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toBeNull();
  });

  it("refuses a ticket from an earlier stage and leaves the newer stage for its own", () => {
    // Two reconnects overlapped: the owner's (or an attacker's) finished first, then a phished
    // victim's replaced the stage. The first flow's ticket must not activate the second's tokens.
    const kv = fakeKv();
    const first = stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000);
    const second = stageCredentials(kv, { ...GRANT, accessToken: "second" }, 1_200);
    expect(first).not.toBe(second);

    expect(commitStagedCredentials<Grant>(kv, 1_500, first)).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({
      creds: { ...GRANT, accessToken: "second" }, stageId: second,
    });
    expect(commitStagedCredentials<Grant>(kv, 1_500, second)).toEqual({ ...GRANT, accessToken: "second" });
    expect(kv.keys()).toEqual([]);
  });

  it("discards an expired stage rather than committing it", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(commitStagedCredentials<Grant>(kv, 1_000 + OAUTH_NONCE_LIFETIME_MS, stageId)).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("drops an expired stage only by its exact id, for disposal", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000, 100);

    // A cleanup an earlier flow scheduled must not drop the stage that replaced it.
    expect(discardStagedCredentials<Grant>(kv, "wrong-stage")).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    // Past its TTL nothing can commit or read it, but its own flow can still dispose of it.
    expect(peekStagedCredentials<Grant>(kv, 1_200)).toBeNull();
    expect(discardStagedCredentials<Grant>(kv, stageId)).toEqual(GRANT);
    expect(kv.keys()).toEqual([]);
  });

  it("honours a caller-chosen lifetime", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_200, 500);

    expect(peekStagedCredentials<Grant>(kv, 1_600)?.creds).toEqual(GRANT);
    expect(peekStagedCredentials<Grant>(kv, 1_700)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_600, stageId)).toEqual(GRANT);
  });

  it("peeks without consuming and fails closed on a corrupt or unusable clock", () => {
    const kv = fakeKv();
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({ creds: GRANT, stageId });
    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({ creds: GRANT, stageId });
    expect(peekStagedCredentials<Grant>(kv, Number.NaN)).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);

    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, stageId, expiresAt: "soon" });
    expect(commitStagedCredentials<Grant>(kv, 1_000, stageId)).toBeNull();
    expect(kv.keys()).toEqual([]);

    // A record written before stages carried an id is unusable, not committable by anyone.
    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, expiresAt: 5_000 });
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_000, "")).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("drops a record no caller could use, whichever reader finds it", () => {
    const kv = fakeKv();
    kv.put(STAGED_CREDENTIALS_KEY, null);

    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
    expect(kv.keys()).toEqual([]);

    kv.put(STAGED_CREDENTIALS_KEY, "garbage");
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(kv.keys()).toEqual([]);

    kv.put(STAGED_CREDENTIALS_KEY, { stageId: "abc", expiresAt: 5_000 });
    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("drops whatever is staged when no id is named, touching nothing else", () => {
    const kv = fakeKv();
    kv.put("tokens", { access_token: "live" });
    stageCredentials(kv, GRANT, 1_000, 0);

    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(discardStagedCredentials<Grant>(kv)).toEqual(GRANT);
    expect(kv.keys()).toEqual(["tokens"]);
    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
    expect(kv.keys()).toEqual(["tokens"]);
  });
});

type User = ConnectionSubject & { login: string };
const ALICE: User = { id: "1", login: "alice" };
const BOB: User = { id: "2", login: "bob" };

describe("connection subject pin", () => {
  it("pins the durable key", () => {
    expect(CONNECTION_SUBJECT_KEY).toBe("connectionSubject");
  });

  it("refuses a reconnect verified as a different subject than the pin, staging nothing", () => {
    const kv = fakeKv();
    pinConnectionSubject(kv, ALICE);
    // An overlapping flow's stage: the refusal must leave it for its own ticket to commit.
    const earlier = stageCredentials(kv, GRANT, 1_000);

    const outcome = stageReconnect(kv, { ...GRANT, accessToken: "bob-token" }, BOB, 1_200,
      (pinned, granted) => ({
        title: "That's a different account",
        detail: `for @${pinned.login}, not @${granted.login}`,
      }));

    expect(outcome).toEqual({
      refused: { title: "That's a different account", detail: "for @alice, not @bob" },
    });
    expect(peekStagedCredentials<Grant>(kv, 1_200)).toEqual({ creds: GRANT, stageId: earlier });
  });

  it("stages the pinned subject's own reconnect, and one for a connection nothing pins", () => {
    const kv = fakeKv();
    let outcome = stageReconnect(kv, GRANT, ALICE, 1_000, () => ({ title: "", detail: "" }));
    expect("stageId" in outcome).toBe(true);
    expect("stageId" in outcome && commitReconnect<Grant>(kv, 1_100, outcome.stageId)).toEqual(GRANT);

    // The commit above pinned ALICE; her own reconnect — renamed — stages again.
    const renamed: User = { id: "1", login: "alice-new" };
    outcome = stageReconnect(kv, { ...GRANT, accessToken: "renamed" }, renamed, 1_200,
      () => ({ title: "", detail: "" }));
    expect("refused" in outcome).toBe(false);
  });

  it("re-pins at commit: adopting a connection made before any pin, and following a rename", () => {
    const kv = fakeKv();
    const adopted = stageReconnect(kv, GRANT, ALICE, 1_000, () => ({ title: "", detail: "" }));
    expect("stageId" in adopted
      && commitReconnect<Grant>(kv, 1_100, adopted.stageId)).toEqual(GRANT);
    expect(pinnedConnectionSubject<User>(kv)).toEqual(ALICE);

    const renamed: User = { id: "1", login: "alice-new" };
    const followed = stageReconnect(kv, GRANT, renamed, 1_200, () => ({ title: "", detail: "" }));
    if ("stageId" in followed) commitReconnect<Grant>(kv, 1_300, followed.stageId);
    expect(pinnedConnectionSubject<User>(kv)).toEqual(renamed);
    clearConnectionSubject(kv);
    expect(kv.keys()).toEqual([]);
  });

  it("drops at commit a stage whose subject contradicts the pin", () => {
    const kv = fakeKv();
    pinConnectionSubject(kv, ALICE);
    // A stage slipped past the pin — say, hand-written while a rename raced — must not commit.
    const stageId = stageCredentials(kv, GRANT, 1_000);
    const record = kv.get<{ creds: Grant; stageId: string; expiresAt: number }>(STAGED_CREDENTIALS_KEY);
    kv.put(STAGED_CREDENTIALS_KEY, { ...record, subject: BOB });

    expect(commitReconnect<Grant>(kv, 1_100, stageId)).toBeNull();
    expect(kv.keys()).toEqual([CONNECTION_SUBJECT_KEY]);
    expect(pinnedConnectionSubject<User>(kv)).toEqual(ALICE);
  });

  it("commits a subjectless stage without touching the pin", () => {
    const kv = fakeKv();
    pinConnectionSubject(kv, ALICE);
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(commitReconnect<Grant>(kv, 1_100, stageId)).toEqual(GRANT);
    expect(pinnedConnectionSubject<User>(kv)).toEqual(ALICE);
  });

  it("drops a corrupt pin rather than pinning to garbage", () => {
    const kv = fakeKv();
    kv.put(CONNECTION_SUBJECT_KEY, { login: "no-id" });
    expect(pinnedConnectionSubject<User>(kv)).toBeUndefined();
    expect(kv.keys()).toEqual([]);

    const outcome = stageReconnect(kv, GRANT, BOB, 1_000, () => ({ title: "", detail: "" }));
    expect("refused" in outcome).toBe(false);
  });

  it("reads the connector's own subject shape back", () => {
    const kv = fakeKv();
    pinConnectionSubject(kv, ALICE);
    expect(pinnedConnectionSubject<User>(kv)?.login).toBe("alice");
  });
});

