// The BLUEPRINTS Workers KV namespace's schema: what each key holds, and the helpers that parse
// and read it.
//
// The namespace is the deployment-wide lookup store for published blueprints (see
// docs/blueprints.md), plus two reserved keys that mirror state owned by the AdminSettings
// Durable Object so that hot paths can read it with one KV get. Every value is a JSON string:
//
//   <blueprintId>   A BlueprintKvRecord. Written when a workspace publishes a blueprint
//                   (Overseer's propagateBlueprint), when a user imports an archive (server.ts),
//                   and when the deployment installs its bundled blueprints
//                   (bundled-blueprints.ts).
//   org/<id>/<blueprintId>
//                   A BlueprintKvRecord an organization owns (see BlueprintOwnerSubject). Such
//                   a blueprint is private to the org's members: the public by-id reads never
//                   look inside a scope, so only the member-gated paths (blueprint-access.ts)
//                   can reach it.
//   .featured       The featured blueprints, a BlueprintPublicInfo[]. Written only by
//                   AdminSettings.
//   .adminConfig    The deployment's AdminConfig (see admin-settings-storage.ts). Written only by
//                   AdminSettings; the code that normalizes, serializes and reads it lives in
//                   admin-config.ts.
//
// Unlike the Durable Object schemas beside this file, the namespace has several writers and no
// migration step, so a change here must leave the values already stored readable. Records
// written before owner subjects exist carry a bare `ownerId`; parsing reads that as a user
// subject, and migrateBlueprintOwnership() rewrites such records once, idempotently.
//
// This file has no runtime dependency on any other backend module, so any of them may import it
// without creating a cycle.

import type { BlueprintMetadata, BlueprintPublicInfo } from "@gadgets/workshop-shared/api";

/** Reserved key holding the featured blueprints (see parseFeaturedBlueprints). */
export const FEATURED_BLUEPRINTS_KEY = '.featured';

/**
 * Reserved key holding the deployment-wide admin config (a single JSON object), mirrored here by
 * AdminSettings; see admin-config.ts.
 */
export const ADMIN_CONFIG_KEY = '.adminConfig';

/**
 * Whether `id` is one of the namespace's reserved keys rather than a blueprint's. Blueprint ids
 * can arrive from clients, so anything that reads or deletes a record under a caller-supplied
 * id must refuse these first. (readBlueprintKvRecord does.)
 *
 * The reserved names hold in every scope, and the scope separator `/` is reserved at the root: a
 * caller-supplied id containing one would forge a key inside some org's scope, so such an id is
 * refused wherever it would enter a key.
 */
export function isReservedBlueprintKey(id: string): boolean {
  return id === FEATURED_BLUEPRINTS_KEY || id === ADMIN_CONFIG_KEY || id.includes('/');
}

/**
 * Who a blueprint belongs to: one user (the User DO that published or uploaded it), or the
 * members of one organization. The first resource-owner subject; org-owned gadgets and Context
 * collections (later issues) follow the same shape.
 */
export type BlueprintOwnerSubject = { type: 'user'; id: string } | { type: 'org'; id: string };

/**
 * The KV key a blueprint's record is stored under: `org/<orgId>/<blueprintId>` for an org-owned
 * blueprint, `<blueprintId>` for any other owner -- which is where every record written before
 * scopes already lives.
 */
export function blueprintKvKey(owner: BlueprintOwnerSubject | undefined, blueprintId: string): string {
  return `${blueprintScopePrefix(owner)}${blueprintId}`;
}

/**
 * The scope segment `owner`'s records live under: `org/<orgId>/`, or "" for a user owner or no
 * owner. The one definition of the scope grammar -- R2 content keys (blueprintContentKey) use
 * it too.
 */
export function blueprintScopePrefix(owner: BlueprintOwnerSubject | undefined): string {
  if (owner?.type !== 'org') return '';
  if (owner.id.includes('/')) throw new Error('An org id must not contain "/".');
  return `org/${owner.id}/`;
}

/** A blueprint's record, stored under its id. */
export type BlueprintKvRecord = {
  metadata: BlueprintMetadata;
  /**
   * The subject that owns this blueprint: the User DO that published or uploaded it, or the org
   * whose members it belongs to. Undefined for a blueprint the deployment installed itself,
   * which has no owner. An org-owned record is stored inside its org's scope (blueprintKvKey)
   * and is readable only by that org's members (blueprint-access.ts).
   */
  owner?: BlueprintOwnerSubject;
  /**
   * The owner as records written before owner subjects carry it: a bare user DO id. Read as a
   * `{type: 'user'}` subject (parseBlueprintKvRecord fills `owner` from it); no longer written,
   * and removed by migrateBlueprintOwnership().
   */
  ownerId?: string;
  gadgetId?: string;  // undefined = uploaded, not published from a gadget on this instance
};

/** A record listed from one org's scope, with the blueprint id its scope key names. */
export type ScopedBlueprintRecord = BlueprintKvRecord & { id: string };

/**
 * Restore the Dates in blueprint metadata that has been through JSON, in place. Also used for the
 * metadata section of a `.gadget` archive (see blueprint-archive.ts), which is the same JSON.
 */
export function reviveBlueprintMetadata(metadata: BlueprintMetadata): BlueprintMetadata {
  metadata.created = new Date(metadata.created);
  metadata.lastUpdated = new Date(metadata.lastUpdated);
  return metadata;
}

export function parseBlueprintKvRecord(raw: string): BlueprintKvRecord {
  let kvRecord = JSON.parse(raw) as BlueprintKvRecord;
  kvRecord.metadata = reviveBlueprintMetadata(kvRecord.metadata);
  // A record written before owner subjects carries a bare ownerId; every reader sees a subject.
  if (kvRecord.owner === undefined && kvRecord.ownerId !== undefined) {
    kvRecord.owner = { type: 'user', id: kvRecord.ownerId };
  }
  return kvRecord;
}

export function parseFeaturedBlueprints(raw: string): BlueprintPublicInfo[] {
  let featured = JSON.parse(raw) as BlueprintPublicInfo[];
  for (let entry of featured) {
    entry.metadata = reviveBlueprintMetadata(entry.metadata);
  }
  return featured;
}

export function serializeFeaturedBlueprints(featured: BlueprintPublicInfo[]): string {
  return JSON.stringify(featured);
}

/**
 * The env a blueprint KV read needs. Narrowed to the one binding so helpers that only read
 * blueprints can be called from anywhere holding it, without passing a whole env around.
 */
export type BlueprintKvEnv = Pick<Cloudflare.Env, 'BLUEPRINTS'>;

export async function readBlueprintKvRecord(
  env: BlueprintKvEnv,
  blueprintId: string,
): Promise<BlueprintKvRecord | null> {
  if (isReservedBlueprintKey(blueprintId)) {
    return null;
  }

  let raw = await env.BLUEPRINTS.get(blueprintId);
  if (!raw) {
    return null;
  }

  let record = parseBlueprintKvRecord(raw);
  // An org-owned record belongs in its org's scope, which this root read cannot reach; finding
  // one here means a corrupt or hand-crafted write, and it fails closed rather than publishes.
  return record.owner?.type === 'org' ? null : record;
}

/**
 * Every record stored in `orgId`'s scope. Only the member-gated paths (blueprint-access.ts)
 * reach this: the listing is the org's blueprint catalogue, visible to its members alone.
 */
export async function listOrgBlueprintKvRecords(
  env: BlueprintKvEnv,
  orgId: string,
): Promise<ScopedBlueprintRecord[]> {
  let prefix = blueprintScopePrefix({ type: 'org', id: orgId });
  let result: ScopedBlueprintRecord[] = [];
  let cursor: string | undefined;
  do {
    let listing = await env.BLUEPRINTS.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (let key of listing.keys) {
      let blueprintId = key.name.slice(prefix.length);
      if (isReservedBlueprintKey(blueprintId)) continue;
      let raw = await env.BLUEPRINTS.get(key.name);
      if (raw) {
        result.push({ ...parseBlueprintKvRecord(raw), id: blueprintId });
      }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor !== undefined);
  return result;
}

/**
 * Rewrite every pre-subject record's bare `ownerId` into an `owner` subject of `{type: 'user'}`,
 * in place, once: a record that already carries `owner` (or none, as a bundled blueprint's does)
 * is left untouched, so re-running is a no-op. Reserved keys and scoped records are never
 * touched. Returns how many records were rewritten, for the trigger's log.
 *
 * Reading does not wait for this: parseBlueprintKvRecord already reads a bare `ownerId` as a
 * user subject, so a deployment the migration has not run on behaves identically. It exists so
 * the legacy shape is written out rather than read forever.
 */
export async function migrateBlueprintOwnership(env: BlueprintKvEnv): Promise<number> {
  let migrated = 0;
  let cursor: string | undefined;
  do {
    let listing = await env.BLUEPRINTS.list(cursor === undefined ? {} : { cursor });
    for (let key of listing.keys) {
      if (isReservedBlueprintKey(key.name)) continue;
      let raw = await env.BLUEPRINTS.get(key.name);
      if (!raw) continue;
      // Inspected as raw JSON, not through parseBlueprintKvRecord: that fills `owner` from
      // `ownerId`, which here would make every legacy record look already migrated.
      let record = JSON.parse(raw) as BlueprintKvRecord | null;
      if (record === null || typeof record !== 'object' ||
          record.owner !== undefined || typeof record.ownerId !== 'string') {
        continue;
      }
      let { ownerId, ...rest } = record;
      await env.BLUEPRINTS.put(key.name, JSON.stringify({ ...rest, owner: { type: 'user', id: ownerId } }));
      migrated++;
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor !== undefined);
  return migrated;
}

export async function listFeaturedBlueprintsFromKv(
  env: BlueprintKvEnv,
): Promise<BlueprintPublicInfo[]> {
  let raw = await env.BLUEPRINTS.get(FEATURED_BLUEPRINTS_KEY);
  if (!raw) {
    return [];
  }

  return parseFeaturedBlueprints(raw);
}
