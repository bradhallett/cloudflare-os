import { describe, expect, it } from "vitest";
import { QuotaTable, quotaDay, quotaKey } from "../src/quota.js";

type Row = { reserved: number; settled: number; refused: number };

/**
 * Minimal in-memory stand-in for a Durable Object's `SqlStorage`, understanding exactly the
 * statements `QuotaTable` issues. Rows live in a Map; each `exec` returns a cursor over the
 * matched rows (empty for writes, one row for the key select).
 */
class FakeSql {
  readonly rows = new Map<string, Row>();

  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): {
    toArray(): T[];
    one(): T;
  } {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE")) return cursor<T>([]);
    if (q.startsWith("SELECT")) {
      const key = String(bindings[0]);
      const row = this.rows.get(key);
      return cursor<T>(row === undefined ? [] : [{ ...row } as unknown as T]);
    }
    if (q.startsWith("INSERT")) {
      const key = String(bindings[0]);
      if (q.includes("refused = refused + 1")) {
        const row = this.rows.get(key);
        if (row === undefined) this.rows.set(key, { reserved: 0, settled: 0, refused: 1 });
        else row.refused += 1;
      } else {
        const row = this.rows.get(key);
        if (row === undefined) this.rows.set(key, { reserved: 1, settled: 0, refused: 0 });
        else row.reserved += 1;
      }
      return cursor<T>([]);
    }
    if (q.includes("settled = settled")) {
      const [n, key] = [Number(bindings[0]), String(bindings[2])];
      const row = this.rows.get(key);
      if (row !== undefined) {
        row.reserved -= n;
        row.settled += n;
      }
      return cursor<T>([]);
    }
    if (q.startsWith("UPDATE")) {
      const [n, key] = [Number(bindings[0]), String(bindings[1])];
      const row = this.rows.get(key);
      if (row !== undefined) row.reserved -= n;
      return cursor<T>([]);
    }
    throw new Error(`FakeSql cannot handle: ${q}`);
  }
}

function cursor<T extends Record<string, unknown>>(rows: T[]): {
  toArray(): T[]; one(): T;
} {
  return { toArray: () => rows, one: () => rows[0] };
}

function table(): { quota: QuotaTable; sql: FakeSql } {
  const sql = new FakeSql();
  return { quota: new QuotaTable(sql as unknown as SqlStorage), sql };
}

describe("quotaDay", () => {
  it("formats the UTC calendar day", () => {
    // 2026-10-25T23:30Z is already the 26th in UTC+1; the quota day is still the 25th.
    expect(quotaDay(Date.UTC(2026, 9, 25, 23, 30))).toBe("2026-10-25");
    expect(quotaDay(Date.UTC(2026, 9, 26, 0, 0))).toBe("2026-10-26");
  });
});

describe("QuotaTable reserve/settle/release", () => {
  it("counts reservations against the limit and refuses past it", () => {
    const { quota } = table();
    const key = quotaKey("deployment", "2026-10-25");
    expect(quota.reserve(key, 2)).toEqual({ allowed: true, used: 1 });
    expect(quota.reserve(key, 2)).toEqual({ allowed: true, used: 2 });
    expect(quota.reserve(key, 2)).toEqual({ allowed: false, used: 2 });
    expect(quota.counts(key)).toEqual({ reserved: 2, settled: 0, refused: 1 });
  });

  it("settle moves reservations to settled and they still count toward the limit", () => {
    const { quota } = table();
    const key = quotaKey("own", "2026-10-25");
    quota.reserve(key, 2);
    quota.reserve(key, 2);
    quota.settle(key);
    expect(quota.counts(key)).toEqual({ reserved: 1, settled: 1, refused: 0 });
    // A settled call still consumed quota: the next reservation is refused.
    expect(quota.reserve(key, 2)).toEqual({ allowed: false, used: 2 });
    quota.release(key);
    expect(quota.reserve(key, 2)).toEqual({ allowed: true, used: 2 });
  });

  it("settle supports batch counts", () => {
    const { quota } = table();
    const key = quotaKey("deployment", "2026-10-25");
    quota.reserve(key, 10);
    quota.reserve(key, 10);
    quota.settle(key, 2);
    expect(quota.counts(key)).toEqual({ reserved: 0, settled: 2, refused: 0 });
  });

  it("release gives reservations back and frees capacity", () => {
    const { quota } = table();
    const key = quotaKey("deployment", "2026-10-25");
    quota.reserve(key, 1);
    quota.release(key);
    expect(quota.counts(key)).toEqual({ reserved: 0, settled: 0, refused: 0 });
    expect(quota.reserve(key, 1)).toEqual({ allowed: true, used: 1 });
  });

  it("release supports batch counts", () => {
    const { quota } = table();
    const key = quotaKey("deployment", "2026-10-25");
    quota.reserve(key, 10);
    quota.reserve(key, 10);
    quota.release(key, 2);
    expect(quota.counts(key)).toEqual({ reserved: 0, settled: 0, refused: 0 });
  });

  it("counts returns zeros for an unseen key", () => {
    expect(table().quota.counts(quotaKey("own", "2026-01-01"))).toEqual({
      reserved: 0, settled: 0, refused: 0,
    });
  });

  it("keeps key modes independent within one day", () => {
    const { quota } = table();
    const day = quotaDay(Date.UTC(2026, 9, 25));
    quota.reserve(quotaKey("deployment", day), 1);
    expect(quota.reserve(quotaKey("own", day), 1)).toEqual({ allowed: true, used: 1 });
    expect(quota.counts(quotaKey("deployment", day))).toEqual({ reserved: 1, settled: 0, refused: 0 });
  });
});

describe("UTC day boundaries", () => {
  it("a new UTC day starts a fresh bucket even after exhaustion", () => {
    const { quota } = table();
    const endOfDay = Date.UTC(2026, 9, 25, 23, 59, 59);
    const nextDay = Date.UTC(2026, 9, 26, 0, 0, 0);
    const dayA = quotaKey("deployment", quotaDay(endOfDay));
    const dayB = quotaKey("deployment", quotaDay(nextDay));
    expect(quotaDay(endOfDay)).not.toBe(quotaDay(nextDay));

    expect(quota.reserve(dayA, 1)).toEqual({ allowed: true, used: 1 });
    expect(quota.reserve(dayA, 1)).toEqual({ allowed: false, used: 1 });

    // The refused counter belongs to day A; day B is unaffected and fully funded.
    expect(quota.reserve(dayB, 1)).toEqual({ allowed: true, used: 1 });
    expect(quota.counts(dayA)).toEqual({ reserved: 1, settled: 0, refused: 1 });
    expect(quota.counts(dayB)).toEqual({ reserved: 1, settled: 0, refused: 0 });
  });

  it("constructor schema creation is idempotent over one storage instance", () => {
    const sql = new FakeSql();
    expect(() => new QuotaTable(sql as unknown as SqlStorage)).not.toThrow();
  });
});
