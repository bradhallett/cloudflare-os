/**
 * Durable Object KV fake, mirroring the kit's test helper (which is not part of its package
 * exports). Cloning catches in-place mutation and reference comparisons; sorted scans match KV's
 * key order rather than `Map` insertion order.
 */
export type FakeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string; startAfter?: string; end?: string; limit?: number }):
    Iterable<[string, T]>;
  /** Test-only: the keys currently present, lexicographically. */
  keys(): string[];
};

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function fakeKv(): FakeKv {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => {
      const stored = values.get(key);
      return stored === undefined ? undefined : structuredClone(stored) as T;
    },
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: (key) => void values.delete(key),
    list: <T>({ prefix, startAfter, end, limit }:
      { prefix: string; startAfter?: string; end?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix)
          && (startAfter === undefined || key > startAfter) && (end === undefined || key < end))
        .toSorted(byKey)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
    keys: () => [...values.keys()].toSorted(),
  };
}
