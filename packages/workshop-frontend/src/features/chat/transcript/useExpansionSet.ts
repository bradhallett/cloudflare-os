import { useCallback, useMemo, useState } from "react";

/**
 * One kind of expandable transcript row (tool calls, actions, errors, compaction
 * summaries): the set of currently-expanded keys, the toggle that flips one key, and the
 * reset that collapses all. Passed whole into transcript prop groups, so rows never hold
 * the setter. The object identity changes only when the keys do — memoized rows that take
 * it stay stable across unrelated re-renders.
 */
export interface ExpansionSet<T> {
  /** The currently expanded keys. */
  readonly keys: ReadonlySet<T>;
  /** Flips one key between collapsed and expanded. */
  toggle(key: T): void;
  /** Collapses every key. */
  reset(): void;
}

/** State for one kind of expandable transcript row; see {@link ExpansionSet}. */
export function useExpansionSet<T>(): ExpansionSet<T> {
  const [keys, setKeys] = useState<ReadonlySet<T>>(() => new Set<T>());
  const toggle = useCallback((key: T) => {
    setKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setKeys(new Set<T>());
  }, []);
  return useMemo(() => ({ keys, toggle, reset }), [keys, toggle, reset]);
}
