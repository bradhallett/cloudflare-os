import type { UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;
/**
 * The most users a search scope may name. The caller-supplied scope is the search's security
 * boundary (no match outside it may return), so it is capped the same way the exclusions are
 * rather than silently truncated.
 */
export const MAX_SCOPE_IDS = 10_000;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDirectoryScopeStore.sync()`).
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL,
      deprovisioned INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
    // Deployments created before the flag column lack it. ADD COLUMN fails once it exists, and
    // that failure is the "already migrated" signal, so it is swallowed.
    try {
      ctx.storage.sql.exec(`ALTER TABLE users ADD COLUMN deprovisioned INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already present.
    }
  }

  /**
   * Insert or update one user's record. `rev` is the user DO's profile revision: a record already
   * at a higher revision is left alone, so syncs that arrive out of order still converge on the
   * newest profile. The deprovisioned flag is deliberately not part of the update, so a sync can
   * never clear it (see markUserDeprovisioned).
   */
  syncUser(record: UserDirectoryRecord, rev: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, record.name, `${record.id}\n${record.name}`.toLowerCase(), rev);
  }

  /**
   * Flag (or unflag) `id`'s record as deprovisioned, the directory-side counterpart of
   * `UserDirectoryScopeStore.sync()`: a deprovisioned user is hidden from collaborator search,
   * and no later profile sync can undo the flag. The user DO's own `deprovisioned` singleton
   * is what refuses re-authentication; this only removes the user from search.
   */
  markUserDeprovisioned(id: string, deprovisioned: boolean): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev, deprovisioned) VALUES (?, '', '', -1, ?)
       ON CONFLICT (id) DO UPDATE SET deprovisioned = excluded.deprovisioned`,
      id, deprovisioned ? 1 : 0);
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`,
   * every deprovisioned user, and admitting only ids in `includeIds` — the caller's directory
   * scope, which the caller computed from org memberships it re-checked live; the directory
   * holds no membership of its own. The id is indexed first so an exact id starts at position
   * one; ties sort by id then name. Rejects a query over `MAX_QUERY_LENGTH` characters or
   * containing a line break, more than `MAX_EXCLUDE_IDS` distinct exclusions, or a scope over
   * `MAX_SCOPE_IDS` distinct ids (a scope is never silently truncated: a person dropped from it
   * would become unfindable, so an oversized scope fails loudly instead).
   */
  searchUsers(query: string, excludeIds: string[], includeIds: string[]): UserDirectoryRecord[] {
    // Name and id are joined by a newline in search_text, so a needle containing one could match
    // across the two fields.
    if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
      throw new Error(
          `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
    }
    const excluded = [...new Set(excludeIds)];
    if (excluded.length > MAX_EXCLUDE_IDS) {
      throw new Error(`At most ${MAX_EXCLUDE_IDS} users can be excluded from a search.`);
    }
    const scope = [...new Set(includeIds)];
    if (scope.length > MAX_SCOPE_IDS) {
      throw new Error(`A search scope may name at most ${MAX_SCOPE_IDS} users.`);
    }
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id IN (SELECT value FROM json_each(?))
         AND id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
         AND NOT deprovisioned
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(scope), JSON.stringify(excluded), needle, needle,
    ).toArray();
  }
}
