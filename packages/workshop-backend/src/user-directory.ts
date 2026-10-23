import type { UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDurableObject.#syncDirectory`).
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
   * UserDurableObject.#syncDirectory(): a deprovisioned user is hidden from collaborator search,
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
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds` and
   * every deprovisioned user. The id is indexed first so an exact id starts at position one; ties
   * sort by id then name. Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line
   * break, and more than `MAX_EXCLUDE_IDS` distinct exclusions.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
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
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
         AND NOT deprovisioned
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excluded), needle, needle,
    ).toArray();
  }
}
