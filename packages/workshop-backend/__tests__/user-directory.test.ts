import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_SCOPE_IDS, type UserDirectoryDurableObject } from "../src/user-directory.js";
// Load the whole backend (the pool's `main`) up front. Otherwise the pool loads it on the first
// RPC into the Durable Object, and that slow load counts against the first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

function directory(name: string) {
  return env.TEST_USER_DIRECTORY.getByName(`${name}-${crypto.randomUUID()}`);
}

function user(id: string, name: string) {
  return { id, name };
}

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise (each .then mints a fresh RPC continuation), and the leftover copy is reported as
// an unhandled rejection (see overseer-hooks.test.ts).
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

describe("UserDirectoryDurableObject", () => {
  it("upserts profiles, matches name or id case-insensitively, and excludes requested users", async () => {
    const stub = directory("upsert");
    await stub.syncUser(user("ada@example.com", "Ada Lovelace"), 0);
    await stub.syncUser(user("grace@example.com", "Grace Hopper"), 0);

    await expect(stub.searchUsers("LOVE", [], ["ada@example.com", "grace@example.com"]))
      .resolves.toEqual([
        user("ada@example.com", "Ada Lovelace"),
      ]);
    await expect(stub.searchUsers("love", ["ada@example.com"],
      ["ada@example.com", "grace@example.com"])).resolves.toEqual([]);
    await expect(stub.searchUsers("grace@", ["ada@example.com"],
      ["ada@example.com", "grace@example.com"])).resolves.toEqual([
        user("grace@example.com", "Grace Hopper"),
      ]);

    await stub.syncUser(user("ada@example.com", "Augusta Ada King"), 1);
    await expect(stub.searchUsers("lovelace", [], ["ada@example.com"])).resolves.toEqual([]);
    await expect(stub.searchUsers("augusta", [], ["ada@example.com"])).resolves.toEqual([
      user("ada@example.com", "Augusta Ada King"),
    ]);
  });

  it("keeps the highest revision when syncs arrive out of order", async () => {
    const stub = directory("revision");
    await stub.syncUser(user("ada@example.com", "Newest"), 2);
    // A stale sync (an older snapshot that lost the race) and a replay of the same revision are
    // both ignored; only a higher revision replaces the record.
    await stub.syncUser(user("ada@example.com", "Stale"), 1);
    await stub.syncUser(user("ada@example.com", "Replay"), 2);
    await expect(stub.searchUsers("ada@", [], ["ada@example.com"])).resolves.toEqual([
      user("ada@example.com", "Newest"),
    ]);

    await stub.syncUser(user("ada@example.com", "Newer Still"), 3);
    await expect(stub.searchUsers("ada@", [], ["ada@example.com"])).resolves.toEqual([
      user("ada@example.com", "Newer Still"),
    ]);
  });

  it("ranks the earliest match first and treats pattern characters literally", async () => {
    const stub = directory("rank");
    await stub.syncUser(user("al@example.com", "Al Li"), 0);
    await stub.syncUser(user("sally@example.com", "Sally"), 0);
    await stub.syncUser(user("%percent", "Percent"), 0);
    await stub.syncUser(user("q@example.com", "A \"Quoted\" AND Person"), 0);

    const scope = ["al@example.com", "sally@example.com", "%percent", "q@example.com"];
    await expect(stub.searchUsers("al", [], scope)).resolves.toEqual([
      user("al@example.com", "Al Li"),
      user("sally@example.com", "Sally"),
    ]);
    await expect(stub.searchUsers("%", [], scope)).resolves.toEqual([
      user("%percent", "Percent"),
    ]);
    await expect(stub.searchUsers("\"Quoted\" AND", [], scope)).resolves.toEqual([
      user("q@example.com", "A \"Quoted\" AND Person"),
    ]);
    await expect(stub.searchUsers("  ", [], scope)).resolves.toEqual([]);
  });

  it("ranks an exact canonical id ahead of an identical display name", async () => {
    const stub = directory("exact-id-rank");
    await stub.syncUser(user("attacker@example.com", "victim@example.com"), 0);
    await stub.syncUser(user("victim@example.com", "Real Victim"), 0);

    await expect(stub.searchUsers("victim@example.com", [],
      ["attacker@example.com", "victim@example.com"])).resolves.toEqual([
      user("victim@example.com", "Real Victim"),
      user("attacker@example.com", "victim@example.com"),
    ]);
  });

  it("does not match across the name/id boundary", async () => {
    const stub = directory("boundary");
    await stub.syncUser(user("ada@example.com", "Grace"), 0);

    await expect(stub.searchUsers("ceada", [], ["ada@example.com"])).resolves.toEqual([]);
    await expect(stub.searchUsers("grace", [], ["ada@example.com"])).resolves.toEqual([
      user("ada@example.com", "Grace"),
    ]);
    // The stored id and name are separated by a newline, so a query may not contain one.
    await expectRejection(
      stub.searchUsers("com\ngra", [], ["ada@example.com"]), "no line breaks");
    await expectRejection(
      stub.searchUsers("com\rgra", [], ["ada@example.com"]), "no line breaks");
  });

  it("bounds the query length and the distinct exclusions", async () => {
    const stub = directory("bounds");
    await stub.syncUser(user("ada@example.com", "Ada"), 0);

    await expect(stub.searchUsers("a".repeat(1000), [], ["ada@example.com"]))
      .resolves.toEqual([]);
    await expectRejection(
      stub.searchUsers("a".repeat(1001), [], ["ada@example.com"]), "at most 1000 characters");

    const distinct = Array.from({ length: 1000 }, (_, index) => `user${index}`);
    await expect(stub.searchUsers("ada", distinct, ["ada@example.com"]))
      .resolves.toEqual([user("ada@example.com", "Ada")]);
    // Duplicates collapse before the limit applies; one more distinct id is over it.
    await expect(stub.searchUsers("ada", [...distinct, ...distinct], ["ada@example.com"]))
      .resolves.toEqual([
        user("ada@example.com", "Ada"),
      ]);
    await expectRejection(stub.searchUsers("ada", [...distinct, "user1000"], ["ada@example.com"]),
      "At most 1000 users");
  });

  it("applies exclusions before capping broad matches at ten results", async () => {
    const stub = directory("limit");
    await Promise.all(Array.from({ length: 12 }, (_, index) => stub.syncUser(user(
      `user${index.toString().padStart(2, "0")}@example.com`,
      `Common Person ${index.toString().padStart(2, "0")}`,
    ), 0)));

    const scope = Array.from({ length: 12 },
      (_, index) => `user${index.toString().padStart(2, "0")}@example.com`);
    const results = await stub.searchUsers("common", [
      "user00@example.com",
      "user01@example.com",
    ], scope);
    expect(results).toHaveLength(10);
    expect(results.map(result => result.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `user${(index + 2).toString().padStart(2, "0")}@example.com`),
    );
  });

  it("hides a deprovisioned user, and a later profile sync cannot un-hide them", async () => {
    const dir = directory("deprovisioned");
    await dir.syncUser(user("gone@example.com", "Gone User"), 1);
    await dir.syncUser(user("stay@example.com", "Stay User"), 1);
    const everyone = ["gone@example.com", "stay@example.com"];
    expect((await dir.searchUsers("gone", [], everyone)).map(result => result.id))
        .toEqual(["gone@example.com"]);

    await dir.markUserDeprovisioned("gone@example.com", true);
    expect(await dir.searchUsers("gone", [], everyone)).toEqual([]);

    // The user's own DO still syncs profile updates (e.g. a display-name change landing late);
    // the upsert must not resurrect the flag it doesn't know about.
    await dir.syncUser(user("gone@example.com", "Renamed"), 5);
    expect(await dir.searchUsers("gone", [], everyone)).toEqual([]);
    expect(await dir.searchUsers("renamed", [], everyone)).toEqual([]);

    // Unflagging restores them, with the latest synced profile.
    await dir.markUserDeprovisioned("gone@example.com", false);
    expect(await dir.searchUsers("renamed", [], everyone))
        .toEqual([user("gone@example.com", "Renamed")]);
  });

  it("flags a user whose directory record has not arrived yet", async () => {
    const dir = directory("deprovisioned-missing");
    await dir.markUserDeprovisioned("never@example.com", true);
    // The profile sync races the flag (deprovision runs while a sync is in flight); whichever
    // lands first, the flag wins.
    await dir.syncUser(user("never@example.com", "Late Sync"), 3);
    expect(await dir.searchUsers("never", [], ["never@example.com"])).toEqual([]);
  });

  it("returns only the ids the caller's scope names, however well anyone else matches", async () => {
    const stub = directory("scope");
    await stub.syncUser(user("insider@example.com", "Pat Inside"), 0);
    await stub.syncUser(user("outsider@example.com", "Patricia Outside"), 0);

    // The outsider is the better "pat" match; a scope that omits her hides her entirely.
    await expect(stub.searchUsers("pat", [], ["insider@example.com"])).resolves.toEqual([
      user("insider@example.com", "Pat Inside"),
    ]);
    await expect(stub.searchUsers("patricia", [], ["insider@example.com"])).resolves.toEqual([]);
  });

  it("bounds the distinct ids a scope may name", async () => {
    const stub = directory("scope-bounds");
    await stub.syncUser(user("ada@example.com", "Ada"), 0);

    const scope = Array.from({ length: MAX_SCOPE_IDS }, (_, index) => `user${index}`);
    await expect(stub.searchUsers("ada", [], scope)).resolves.toEqual([]);
    // Duplicates collapse before the limit applies; one more distinct id is over it.
    await expect(stub.searchUsers("ada", [], [...scope, ...scope])).resolves.toEqual([]);
    await expectRejection(stub.searchUsers("ada", [], [...scope, "one-more"]),
      `A search scope may name at most ${MAX_SCOPE_IDS} users.`);
  });
});
