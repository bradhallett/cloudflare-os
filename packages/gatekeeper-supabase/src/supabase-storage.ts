// DO-key-value storage for the Supabase gatekeeper: the pending-action queue (mutating SQL
// statements parked between submission and approval) and the metadata cache (stable read-only
// results, invalidated in one stroke by a generation bump when an action is applied).
//
// The queue is the kit's `ActionJournal` state machine, on this port's pre-journal keys: a claim
// is written *before* the SQL runs, so any later attempt that finds a claimed record it did not
// take -- a restart, a replayed approval, a duplicate click -- knows the statement may already
// have run and refuses to run it again. A run whose outcome cannot be known (no response from
// Supabase) is recorded terminally and surfaced, never silently retried.

import {
  ActionJournal, type ActionJournalKv, type JournalRecord,
} from "@gadgets/gatekeeper-kit/actions";
import type { SupabaseValue } from "./types";

/** A mutating SQL statement queued for human approval and applied once approved. */
export type StoredExecuteAction = {
  ref: string;
  sql: string;
  params?: SupabaseValue[];
  submittedAt: number;
};

// Rows the pre-journal store wrote: the action payload itself, without the journal's state
// envelope. They become pending records -- none of them was mid-run when the store swapped.
function upgradeLegacyRecord(raw: unknown): StoredExecuteAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("ref" in raw) || !("sql" in raw)) return undefined;
  const { ref, sql, params, submittedAt } = raw as Partial<StoredExecuteAction>;
  if (typeof ref !== "string" || typeof sql !== "string") return undefined;
  return { ref, sql, params: params as SupabaseValue[] | undefined, submittedAt: submittedAt ?? 0 };
}

export class PendingActionStore {
  #journal: ActionJournal<StoredExecuteAction>;

  constructor(kv: ActionJournalKv) {
    this.#journal = new ActionJournal(kv, {
      legacyKeys: { nextIdKey: "pending:nextActionId", recordPrefix: "pending:action:" },
      upgradeRecord: upgradeLegacyRecord,
    });
  }

  /** Queues a statement as submitted (the approver has been handed the id). */
  submit(action: StoredExecuteAction): number {
    const id = this.#journal.allocate(action);
    this.#journal.markSubmitted(id);
    return id;
  }

  /** The journal record for an id, whatever its state. */
  record(id: number): JournalRecord<StoredExecuteAction> | undefined {
    return this.#journal.get(id);
  }

  /** The queued statement itself, or undefined when no record exists. */
  get(id: number): StoredExecuteAction | undefined {
    return this.#journal.get(id)?.action;
  }

  /** Removes the record outright, both tiers. */
  remove(id: number): void {
    this.#journal.remove(id);
  }

  /** @returns The journal driving this store, for the claim lifecycle apply runs. */
  journal(): ActionJournal<StoredExecuteAction> {
    return this.#journal;
  }
}

// A cached value with the generation it was written under and the time it was fetched.
type Cached<T> = { value: T; fetchedAt: number; generation: number };

/**
 * Cache for stable, read-only metadata (project info, schema introspection, etc.). Backed by the
 * gatekeeper DO's KV storage and keyed within a "generation" that is bumped when an action is
 * applied, so structural changes invalidate cached schema in one stroke.
 */
export class SupabaseCache {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #generation(): number {
    return this.#kv.get<number>("cache:generation") ?? 0;
  }

  bumpGeneration(): void {
    this.#kv.put("cache:generation", this.#generation() + 1);
  }

  get<T>(key: string, ttlMs: number): T | undefined {
    const cached = this.#kv.get<Cached<T>>(`cache:entry:${key}`);
    if (!cached || cached.generation !== this.#generation()) return undefined;
    if (Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    return cached.value;
  }

  put<T>(key: string, value: T): void {
    this.#kv.put<Cached<T>>(`cache:entry:${key}`, {
      fetchedAt: Date.now(),
      value,
      generation: this.#generation(),
    });
  }
}
