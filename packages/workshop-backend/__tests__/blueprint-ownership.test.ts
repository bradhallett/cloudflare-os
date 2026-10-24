// Blueprint owner subjects: the KV schema's owner field, the org scope it keys records into, the
// member-gated reads that alone can reach an org's blueprints, and the one-shot migration of
// records written before subjects existed. The org DO and the user DO are real (as in org.test.ts),
// so the member gates answer as they do in production.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AiChatAuthorInfo, BlueprintMetadata } from "@gadgets/workshop-shared/api";
import {
  blueprintContentKey, deleteBlueprintContent, readBlueprintRelease,
} from "../src/blueprint-archive";
import {
  orgBlueprintsForMember, resolveBlueprintForUser,
} from "../src/blueprint-access";
import type { OrgDurableObject } from "../src/org";
import { isActiveMember } from "../src/org-access";
import {
  ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, blueprintKvKey, blueprintScopePrefix,
  isReservedBlueprintKey, listOrgBlueprintKvRecords, migrateBlueprintOwnership,
  parseBlueprintKvRecord, readBlueprintKvRecord,
} from "../src/storage-schema/blueprints-kv";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ORG: DurableObjectNamespace<OrgDurableObject>;
  }
}

let counter = 0;

// Fresh ids per test, as production's random ids are: an org's members key records by these.
function newId(prefix: string): string {
  return `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`;
}

const AUTHOR: AiChatAuthorInfo = { type: "user", id: "author", name: "Author" };

function metadataFor(title: string, extra: Partial<BlueprintMetadata> = {}): BlueprintMetadata {
  return {
    title, description: "", author: AUTHOR, created: new Date(0), version: 1,
    lastUpdated: new Date(0), bindings: {}, ...extra,
  };
}

// A record as a writer leaves it in KV.
function recordOf(metadata: BlueprintMetadata, owner?: { type: string; id: string }): string {
  return JSON.stringify({ metadata, ...(owner ? { owner } : {}) });
}

async function putRecord(key: string, value: string): Promise<void> {
  await env.BLUEPRINTS.put(key, value);
}

// A gzipped Yjs snapshot of `files`, as pre-release content was stored (see readBlueprintRelease).
async function snapshotContent(files: Record<string, string>): Promise<Uint8Array> {
  let doc = new Y.Doc();
  let map = doc.getMap<Y.Text>();
  for (let [path, text] of Object.entries(files)) map.set(path, new Y.Text(text));
  let compressed = new Response(Y.encodeStateAsUpdateV2(doc) as BufferSource).body!
      .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

// An org with `owner` and `member`, both active, as invite and acceptance leave them.
async function orgWithMembers(): Promise<{ orgId: string; owner: string; member: string; outsider: string }> {
  let orgId = newId("org");
  let owner = newId("alice");
  let member = newId("bob");
  let outsider = newId("carol");
  let org = env.TEST_ORG.getByName(orgId);
  await org.initializeOrg("Acme", owner);
  await org.inviteMember(owner, member, "member");
  await org.acceptInvitation(member);
  return { orgId, owner, member, outsider };
}

describe("blueprint owner subjects", () => {
  it("parses records with a subject owner unchanged, and a legacy ownerId as a user subject", () => {
    let metadata = metadataFor("Subject");
    expect(parseBlueprintKvRecord(recordOf(metadata, { type: "user", id: "u1" })).owner)
        .toEqual({ type: "user", id: "u1" });
    expect(parseBlueprintKvRecord(recordOf(metadata, { type: "org", id: "o1" })).owner)
        .toEqual({ type: "org", id: "o1" });
    expect(parseBlueprintKvRecord(recordOf(metadata)).owner).toBeUndefined();
    let legacy = parseBlueprintKvRecord(
        JSON.stringify({ metadata, ownerId: "legacy-user" }));
    expect(legacy.owner).toEqual({ type: "user", id: "legacy-user" });
  });

  it("reserves the mirror keys, and any id carrying the scope separator", () => {
    expect(isReservedBlueprintKey(FEATURED_BLUEPRINTS_KEY)).toBe(true);
    expect(isReservedBlueprintKey(ADMIN_CONFIG_KEY)).toBe(true);
    expect(isReservedBlueprintKey("a/b")).toBe(true);
    expect(isReservedBlueprintKey(`${newId("org")}/${newId("bp")}`)).toBe(true);
    expect(isReservedBlueprintKey("01".repeat(16))).toBe(false);
    expect(isReservedBlueprintKey("format.document")).toBe(false);
  });

  it("keys org-owned records into their scope, and everything else at the root", () => {
    expect(blueprintScopePrefix({ type: "org", id: "o1" })).toBe("org/o1/");
    expect(blueprintScopePrefix({ type: "user", id: "u1" })).toBe("");
    expect(blueprintScopePrefix(undefined)).toBe("");
    expect(blueprintKvKey({ type: "org", id: "o1" }, "bp")).toBe("org/o1/bp");
    expect(blueprintKvKey({ type: "user", id: "u1" }, "bp")).toBe("bp");
    expect(blueprintKvKey(undefined, "bp")).toBe("bp");
    // An org id with a separator would forge a second scope level, so it is refused outright.
    expect(() => blueprintScopePrefix({ type: "org", id: "a/b" })).toThrow(/org id/);
  });

  it("scopes R2 content keys by owner subject", () => {
    let metadata = { ...metadataFor("Scoped"), commitId: "a".repeat(40) };
    expect(blueprintContentKey({ type: "org", id: "o1" }, "bp", metadata))
        .toBe(`org/o1/bp/${"a".repeat(40)}`);
    expect(blueprintContentKey({ type: "user", id: "u1" }, "bp", metadata))
        .toBe(`bp/${"a".repeat(40)}`);
    expect(blueprintContentKey(undefined, "bp", metadata)).toBe(`bp/${"a".repeat(40)}`);
  });

  it("reads org-scoped content through readBlueprintRelease, and deletes only the scope", async () => {
    let orgId = newId("org");
    let owner = { type: "org" as const, id: orgId };
    let metadata = { ...metadataFor("Scoped content"), version: 7 };  // snapshot form: no commitId
    let content = await snapshotContent({ "client.js": "one\n" });
    await env.BLUEPRINT_CONTENT.put(blueprintContentKey(owner, "scoped", metadata), content);
    // A same-named blueprint outside the scope stays a distinct object.
    await env.BLUEPRINT_CONTENT.put(blueprintContentKey(undefined, "scoped", metadata), "other");

    let release = await readBlueprintRelease(env, owner, "scoped", metadata);
    expect(release.commitId).toBeTruthy();

    await deleteBlueprintContent(env, owner, "scoped");
    expect(await env.BLUEPRINT_CONTENT.head(blueprintContentKey(owner, "scoped", metadata)))
        .toBeNull();
    expect((await env.BLUEPRINT_CONTENT.head(
        blueprintContentKey(undefined, "scoped", metadata!)))?.size).toBe("other".length);

    await deleteBlueprintContent(env, undefined, "scoped");
    expect(await env.BLUEPRINT_CONTENT.head(
        blueprintContentKey(undefined, "scoped", metadata))).toBeNull();
  });

  it("hides a scoped record from the public by-id read, and lists it in its org's scope", async () => {
    let { orgId } = await orgWithMembers();
    let metadata = metadataFor("Org blueprint");
    await putRecord(blueprintKvKey({ type: "org", id: orgId }, "org-only"), recordOf(metadata));

    // The public read never enters a scope, so the blueprint does not exist by id...
    expect(await readBlueprintKvRecord(env, "org-only")).toBeNull();
    // ...while the org's own listing is exactly it, with the id its scope key names.
    expect(await listOrgBlueprintKvRecords(env, orgId))
        .toEqual([{ ...parseBlueprintKvRecord(recordOf(metadata)), id: "org-only" }]);

    // A corrupt root record claiming an org owner fails closed rather than publishing.
    await putRecord("forged-org-owner", recordOf(metadata, { type: "org", id: orgId }));
    expect(await readBlueprintKvRecord(env, "forged-org-owner")).toBeNull();
  }, 30000);

  it("resolves a scoped record for a member alone, live at read time", async () => {
    let { orgId, owner, member, outsider } = await orgWithMembers();
    let metadata = metadataFor("Members only");
    await putRecord(blueprintKvKey({ type: "org", id: orgId }, "member-only"), recordOf(metadata));

    let resolve = (userId: string, orgIds: string[]) =>
        resolveBlueprintForUser(env, env.TEST_ORG, orgIds, userId, "member-only");

    // Members -- the owner and an ordinary one -- read it through their org index.
    expect((await resolve(owner, [orgId]))?.metadata.title).toBe("Members only");
    expect((await resolve(member, [orgId]))?.metadata.title).toBe("Members only");
    // A user in no org, or in the wrong one, sees nothing at all.
    expect(await resolve(outsider, [])).toBeNull();
    expect(await resolve(outsider, [newId("other-org")])).toBeNull();
    // A stale index entry finds no record: the index is discovery, not access.
    expect(await resolve(outsider, [orgId])).toBeNull();
    // An invited-but-not-accepted member is no member yet.
    let pending = newId("dave");
    await env.TEST_ORG.getByName(orgId).inviteMember(owner, pending, "member");
    expect(await resolve(pending, [orgId])).toBeNull();

    // Removal is lazy revocation: nothing is rewritten, the next read simply refuses.
    await env.TEST_ORG.getByName(orgId).removeMember(owner, member);
    expect(await resolve(member, [orgId])).toBeNull();

    // A root record answers ahead of any scope, as the public share link it is.
    await putRecord("public-first", recordOf(metadataFor("Public")));
    expect((await resolveBlueprintForUser(env, env.TEST_ORG, [orgId], outsider, "public-first"))
        ?.metadata.title).toBe("Public");
    expect((await resolveBlueprintForUser(env, env.TEST_ORG, [], outsider, "public-first"))
        ?.metadata.title).toBe("Public");
  }, 30000);

  it("lists org blueprints for a member, and only those", async () => {
    let first = await orgWithMembers();
    let secondOrgId = newId("org");
    await env.TEST_ORG.getByName(secondOrgId).initializeOrg("Beta", first.owner);

    let firstMetadata = metadataFor("First org's");
    let secondMetadata = metadataFor("Second org's");
    await putRecord(
        blueprintKvKey({ type: "org", id: first.orgId }, "firsts"), recordOf(firstMetadata));
    await putRecord(
        blueprintKvKey({ type: "org", id: secondOrgId }, "seconds"), recordOf(secondMetadata));

    // The owner belongs to both orgs, so sees both blueprints.
    let both = await orgBlueprintsForMember(env, env.TEST_ORG, [first.orgId, secondOrgId], first.owner);
    expect(both.map(entry => entry.id).toSorted()).toEqual(["firsts", "seconds"]);
    // The member belongs to one; the outsider's index names an org it does not answer for.
    let one = await orgBlueprintsForMember(env, env.TEST_ORG, [first.orgId], first.member);
    expect(one.map(entry => entry.id)).toEqual(["firsts"]);
    expect(await orgBlueprintsForMember(env, env.TEST_ORG, [first.orgId], first.outsider))
        .toEqual([]);
  }, 30000);

  it("interprets membership records: active alone is standing", () => {
    expect(isActiveMember({ status: "active" } as never)).toBe(true);
    expect(isActiveMember({ status: "invited" } as never)).toBe(false);
    expect(isActiveMember(null)).toBe(false);
  });

  it("migrates legacy records once, touching nothing else", async () => {
    let legacyId = newId("legacy");
    let subjectId = newId("subject");
    let unownedId = newId("unowned");
    let reservedValue = JSON.stringify({ untouched: true });
    await putRecord(legacyId, JSON.stringify({ metadata: metadataFor("Legacy"), ownerId: "old-user" }));
    let subjectBefore = recordOf(metadataFor("Subject"), { type: "user", id: "u1" });
    await putRecord(subjectId, subjectBefore);
    await putRecord(unownedId, recordOf(metadataFor("Unowned")));
    await putRecord(FEATURED_BLUEPRINTS_KEY, reservedValue);
    await putRecord(ADMIN_CONFIG_KEY, reservedValue);

    expect(await migrateBlueprintOwnership(env)).toBe(1);

    let migrated = await env.BLUEPRINTS.get(legacyId);
    expect(JSON.parse(migrated!)).toEqual(
        { metadata: expect.anything(), owner: { type: "user", id: "old-user" } });
    // Already a subject, never owned, and the reserved mirrors: byte-for-byte as they were.
    expect(await env.BLUEPRINTS.get(subjectId)).toBe(subjectBefore);
    expect(JSON.parse((await env.BLUEPRINTS.get(unownedId))!)).toEqual(
        { metadata: expect.anything() });
    expect(await env.BLUEPRINTS.get(FEATURED_BLUEPRINTS_KEY)).toBe(reservedValue);
    expect(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY)).toBe(reservedValue);

    // Idempotent: a second run rewrites nothing.
    expect(await migrateBlueprintOwnership(env)).toBe(0);
    expect(JSON.parse((await env.BLUEPRINTS.get(legacyId))!)).toEqual(
        JSON.parse(migrated!));
  });

  it("adds an org's blueprint to a member's library alone, through the user DO", async () => {
    let { orgId, member, outsider } = await orgWithMembers();
    let metadata = metadataFor("Org library");
    await putRecord(blueprintKvKey({ type: "org", id: orgId }, "library-only"), recordOf(metadata));

    // The member's own DO resolves the blueprint as its membership allows.
    await env.TEST_USER.getByName(member).addBlueprintToLibrary("library-only");
    expect(await env.TEST_USER.getByName(member).isBlueprintInLibrary("library-only"))
        .toEqual({ uploaded: false });

    // The outsider's DO, with no membership to answer for, sees no such blueprint. (Asserted
    // with try/catch rather than expect().rejects: a remote Durable Object rejection awaited
    // only through vitest's rejects chain still surfaces as a workerd unhandled error.)
    try {
      await env.TEST_USER.getByName(outsider).addBlueprintToLibrary("library-only");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/Blueprint not found/);
    }
  }, 30000);
});
