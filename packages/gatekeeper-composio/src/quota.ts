// Reserve-then-settle daily call caps, the gatekeeper-x pattern adapted to a DO's SQLite
// storage. Keys are `${keyMode}:${utcDate}`, so counters never carry across a UTC day boundary;
// `release` gives reservations back when a call provably never dispatched, and `settle` moves
// reservations to settled once a call took effect (a settled call still counts toward the day's
// limit — only a release frees capacity).

import type { ComposioKeyMode } from "./account.js";

/** Quota counter key: `${keyMode}:${utcDate}` — build with {@link quotaKey}. */
export type QuotaKey = `${"deployment" | "own"}:${string}`;

/** The quota counter key for one key mode and UTC day. */
export function quotaKey(mode: ComposioKeyMode, day: string): QuotaKey {
  return `${mode}:${day}`;
}

/** The three counters kept per key. */
export interface QuotaCounters {
  reserved: number;
  settled: number;
  refused: number;
}

/** The UTC calendar day (yyyy-mm-dd) a timestamp falls in — the quota reset boundary. */
export function quotaDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * One table of per-key call counters inside a Durable Object. The schema is created (idempotently)
 * in the constructor, mirroring mcp-shared's `ActionStore`.
 *
 * Invariants: `reserved` counts in-flight reservations, `settled` counts calls that took effect,
 * and the limit applies to `reserved + settled`. `refused` is a visibility counter only.
 */
export class QuotaTable {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS composio_quota (
      key TEXT PRIMARY KEY,
      reserved INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0,
      refused INTEGER NOT NULL DEFAULT 0
    ) STRICT`);
  }

  #counters(key: QuotaKey): QuotaCounters {
    const row = this.#sql.exec<{ reserved: number; settled: number; refused: number }>(
      "SELECT reserved, settled, refused FROM composio_quota WHERE key = ?", key,
    ).toArray()[0];
    return row ?? { reserved: 0, settled: 0, refused: 0 };
  }

  /**
   * Reserve one call against `limit`. On success the reservation is already counted; on refusal
   * the `refused` counter increments so exhaustion stays visible.
   */
  reserve(key: QuotaKey, limit: number):
    { allowed: true; used: number } | { allowed: false; used: number } {
    const { reserved, settled } = this.#counters(key);
    const used = reserved + settled;
    if (used >= limit) {
      this.#sql.exec(
        "INSERT INTO composio_quota (key, reserved, settled, refused) VALUES (?, 0, 0, 1) " +
        "ON CONFLICT(key) DO UPDATE SET refused = refused + 1",
        key);
      return { allowed: false, used };
    }
    this.#sql.exec(
      "INSERT INTO composio_quota (key, reserved, settled, refused) VALUES (?, 1, 0, 0) " +
      "ON CONFLICT(key) DO UPDATE SET reserved = reserved + 1",
      key);
    return { allowed: true, used: used + 1 };
  }

  /** Record that `n` reserved calls (default 1) took effect; they still count toward the limit. */
  settle(key: QuotaKey, n = 1): void {
    // MAX(...) floors `reserved` at 0: a settle racing a release (or replaying a drifted
    // counter) must not push it negative, where it would silently *raise* headroom.
    this.#sql.exec(
      "UPDATE composio_quota SET reserved = MAX(reserved - ?, 0), settled = settled + ? " +
        "WHERE key = ?",
      n, n, key);
  }

  /** Give `n` reservations (default 1) back — the call provably never dispatched. */
  release(key: QuotaKey, n = 1): void {
    this.#sql.exec(
      "UPDATE composio_quota SET reserved = MAX(reserved - ?, 0) WHERE key = ?", n, key);
  }

  /** The current counters for `key` (zeros when unseen). */
  counts(key: QuotaKey): QuotaCounters {
    return this.#counters(key);
  }
}
