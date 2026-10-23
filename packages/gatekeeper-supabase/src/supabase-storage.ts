// DO-key-value storage for the Supabase gatekeeper: the pending-action queue (mutating SQL
// statements parked between submission and approval) and the metadata cache (stable read-only
// results, invalidated in one stroke by a generation bump when an action is applied).

import type { SupabaseValue } from "./types";

// A mutating SQL statement queued for human approval and applied once approved.
export type StoredExecuteAction = {
  ref: string;
  sql: string;
  params?: SupabaseValue[];
  submittedAt: number;
};
// A cached value with the generation it was written under and the time it was fetched.
type Cached<T> = { value: T; fetchedAt: number; generation: number };

export class PendingActionStore {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #key(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: StoredExecuteAction): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#key(id), action);
    return id;
  }

  get(id: number): StoredExecuteAction | undefined {
    return this.#kv.get<StoredExecuteAction>(this.#key(id));
  }

  remove(id: number): void {
    this.#kv.delete(this.#key(id));
  }
}

// Cache for stable, read-only metadata (project info, schema introspection, etc.). Backed by the
// gatekeeper DO's KV storage and keyed within a "generation" that is bumped when an action is
// applied, so structural changes invalidate cached schema in one stroke.
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
