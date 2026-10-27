// DO-key-value storage for the Supabase gatekeeper: the metadata cache for stable read-only
// results, invalidated in one stroke by a generation bump when an SQL action is applied. The
// SQL action queue itself lives on the kit's `ActionJournal` (see supabase-actions.ts).

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
