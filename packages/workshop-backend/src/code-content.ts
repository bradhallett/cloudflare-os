import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { CodeChange, CodeContent, FileContent } from "@gadgets/workshop-shared/code-change";

/**
 * The one worktree-edit base-seeding rule, shared by every fold that applies chat changes to a
 * content map: before a change applies, every `edit` of a worktree the map holds a base for --
 * and whose path the map does not already hold -- is read at that base and seeded in (copy on
 * write), so the edit applies and validates exactly as if the whole base tree had been
 * materialized. Only edits need bases (a `set` is valid against any state and a `remove` of an
 * absent path is a no-op), so untouched files are never read. A path absent from the base stays
 * absent -- "edit of absent file" is then the change's own validation error -- while unreadable
 * content (oversized/binary/symlink) throws its descriptive error, which ingestion surfaces to
 * the submitter. (One deliberate quirk falls out for hand-rolled clients only: a row that edits
 * a path an earlier row removed re-seeds the base text rather than failing -- every fold applies
 * the same rule in the same order, so all replicas agree; the shipped producers never emit that
 * sequence.)
 *
 * Callers: the overseer's change ingestion (`seedWorktreeEditBases` and the prefetch/apply pair
 * in overseer-core.ts) and the agent's replay (agent-replay.ts) -- the latter deliberately applies the
 * identical rule so replay reconstructs byte-identical content.
 *
 * @param content The content map the change will apply to.
 * @param change The change whose edit paths need bases.
 * @param hasBase Whether the map's holder has a base commit for the worktree (pinned or
 *     otherwise tracked). Workpieces without one are skipped wholesale.
 * @param seedPath Reads one worktree path's base text (or null/undefined when absent). May
 *     memoize; may seed elsewhere too (the agent's reader faults into its session content).
 * @returns The seeded content: `content` itself when nothing needed a base, a copy otherwise.
 */
export async function seedEditBases(
    content: CodeContent, change: CodeChange,
    hasBase: (worktreeId: WorkpieceId) => boolean,
    seedPath: (worktreeId: WorkpieceId, path: string) => Promise<FileContent | null | undefined>,
  ): Promise<CodeContent> {
  let result = content;
  for (let [key, entries] of Object.entries(change)) {
    let worktreeId = Number(key);
    if (!hasBase(worktreeId)) continue;
    for (let [path, fileChange] of entries) {
      if (!("edit" in fileChange) || result.get(worktreeId)?.has(path)) continue;
      let text = await seedPath(worktreeId, path);
      if (text === undefined || text === null) continue;
      if (result === content) result = new Map(content);
      let files = new Map(result.get(worktreeId));
      files.set(path, text);
      result.set(worktreeId, files);
    }
  }
  return result;
}

/**
 * The synchronous half of the prefetched variant: seeds a change's worktree edit bases from the
 * `${worktreeId}:${path}` -> text (or null, for absent) map an interrupted
 * {@link seedEditBases} prefetch filled, or returns null when a needed base wasn't prefetched
 * (the row landed mid-prefetch; the caller retries the whole read). Applies the same rule as
 * {@link seedEditBases}, including the copy-on-write and the skip for already-held paths.
 *
 * @param content The content map the change will apply to.
 * @param change The change whose edit paths need bases.
 * @param worktreeBases The worktree base commits the map's holder tracks; worktrees absent
 *     from it are skipped wholesale.
 * @param seeds The prefetch memo, keyed `${worktreeId}:${path}`.
 * @returns The seeded content, or null when a needed base is missing from `seeds`.
 */
export function applyPrefetchedEditBases(
    content: CodeContent, change: CodeChange, worktreeBases: Map<WorkpieceId, string>,
    seeds: Map<string, FileContent | null>): CodeContent | null {
  let result = content;
  for (let [key, entries] of Object.entries(change)) {
    let worktreeId = Number(key);
    if (!worktreeBases.has(worktreeId)) continue;
    for (let [path, fileChange] of entries) {
      if (!("edit" in fileChange) || result.get(worktreeId)?.has(path)) continue;
      let text = seeds.get(`${worktreeId}:${path}`);
      if (text === undefined) return null;
      if (text === null) continue;  // absent from the base: the edit's own validation reports
      if (result === content) result = new Map(content);
      let files = new Map(result.get(worktreeId));
      files.set(path, text);
      result.set(worktreeId, files);
    }
  }
  return result;
}
