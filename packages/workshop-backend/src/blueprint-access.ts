// Subject-scoped access to blueprint records: the member-gated reads and listings that can
// reach an org's blueprints. A user-owned or unowned blueprint is public by id (a blueprint id
// is a bearer share link, see docs/blueprints.md); an org-owned one is stored inside its org's
// KV scope (blueprintKvKey), which the public by-id reads never enter. Every path here
// re-checks membership against the org's own Durable Object when access matters — the
// lazy-revocation contract of docs/tenancy.md: a removed member's access ends at the next
// check, without any cascade, and a later re-add restores it.

import type { OrgDurableObject } from './org.js';
import { isActiveMember } from './org-access.js';
import { retryOnDoReset } from './do-retry.js';
import {
  blueprintKvKey, isReservedBlueprintKey, listOrgBlueprintKvRecords, parseBlueprintKvRecord,
  readBlueprintKvRecord, type BlueprintKvEnv, type BlueprintKvRecord, type ScopedBlueprintRecord,
} from './storage-schema/blueprints-kv.js';

/**
 * Resolve `blueprintId` as `userId` may read it, or null when they may not. A record at the
 * namespace root answers first, as it does for the public reads; otherwise the blueprint, if it
 * exists, is an org's, and only a member of that org gets it. `orgIds` is the caller's org
 * index (discovery only — UserDurableObject.listOrgMemberships); the org itself answers the
 * membership question, so a stale index entry finds no record and a removed member is refused.
 */
export async function resolveBlueprintForUser(
    env: BlueprintKvEnv, orgs: DurableObjectNamespace<OrgDurableObject>,
    orgIds: string[], userId: string, blueprintId: string): Promise<BlueprintKvRecord | null> {
  let record = await readBlueprintKvRecord(env, blueprintId);
  if (record !== null) return record;
  if (isReservedBlueprintKey(blueprintId)) return null;
  for (let orgId of orgIds) {
    if (orgId.includes('/')) continue;
    let raw = await env.BLUEPRINTS.get(blueprintKvKey({type: 'org', id: orgId}, blueprintId));
    if (raw === null) continue;
    // The record exists in an org's scope: only a member of that org reads it, checked live.
    // A pure read, retried across an org-DO reset like the server's org reads (retryOnDoReset).
    if (!isActiveMember(await retryOnDoReset(() => orgs.getByName(orgId).getMember(userId))))
      return null;
    return parseBlueprintKvRecord(raw);
  }
  return null;
}

/**
 * The blueprints `userId`'s orgs own, as their member: each org's scoped records, listed only
 * once its Durable Object has answered for the user. Duplicate org ids would list twice; the
 * caller's index keys them, so there are none.
 */
export async function orgBlueprintsForMember(
    env: BlueprintKvEnv, orgs: DurableObjectNamespace<OrgDurableObject>,
    orgIds: string[], userId: string): Promise<ScopedBlueprintRecord[]> {
  let result: ScopedBlueprintRecord[] = [];
  for (let orgId of orgIds) {
    if (orgId.includes('/')) continue;
    // Live membership again, retried as a read (see resolveBlueprintForUser).
    if (!isActiveMember(await retryOnDoReset(() => orgs.getByName(orgId).getMember(userId))))
      continue;
    result.push(...await listOrgBlueprintKvRecords(env, orgId));
  }
  return result;
}
