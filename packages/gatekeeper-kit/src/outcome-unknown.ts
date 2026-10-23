/**
 * The outcome-unknown protocol: what a gatekeeper owes when an action was dispatched but its
 * result was never reported -- a lost reply, a dropped connection, an activation that died
 * mid-dispatch. Three rules, one per way the uncertainty is answered:
 *
 * 1. A dispatch that can no longer be reconciled is recorded terminally, never replayed. For an
 *    action set on the action journal, throwing `ActionOutcomeUnknownError` from the handler does
 *    this (see `./actions`); a claim left by a dead activation fails the same way.
 * 2. A dispatch that can be reconciled is marked before it goes out, and the next apply asks the
 *    provider what became of it before repeating it. `AttemptJournal` owns the marker state; the
 *    provider-specific look that settles it stays in the connector. A write whose provider state
 *    can answer without a marker -- a compare-and-scas'd push, a merge bound to a head -- settles
 *    through `desiredStateReached` instead.
 * 3. An action with a dispatch still unreported cannot be rejected: rejecting it would discard a
 *    record that may be the only thing standing between the user and an effect they never saw
 *    confirmed. `AttemptJournal.possiblyApplied` is that check; the refusal wording is the
 *    connector's, for the user it addresses.
 */

import type { KvScannable } from "./kv";

/**
 * Where an attempt journal's markers live. Two journals over one Durable Object must not share a
 * prefix. A `namespace` derives one (`"<namespace>:attempt:"`); a `markerPrefix` adopts storage a
 * gatekeeper already keeps, so porting moves no keys.
 */
export type AttemptKeys = { namespace: string } | { markerPrefix: string };

// Mirrors the action journal's namespace pattern, for the same reason: a derived key must be
// unambiguous, with no separator that could forge a prefix boundary.
const NAMESPACE = /^[A-Za-z0-9_-]+$/;

/**
 * Durable markers for dispatches whose outcome the provider may never report, keyed by action and
 * step. `begin` writes one just before a non-idempotent dispatch goes out; the next apply reads it
 * back with `attempt` and reconciles -- asks the provider what became of the dispatch -- before
 * repeating it; `settle` clears it once the outcome is known either way. A marker survives any
 * crash between the dispatch and its reconciliation, which is the whole point: the re-delivered
 * apply finds it and looks, where an unmarked one would blindly repeat a write that may have
 * landed.
 *
 * The journal owns only the state. What a marker records, and the provider look that settles it,
 * are the connector's -- `SendAttempt`-shaped facts about the world when the dispatch went out, and
 * a reconcile that can tell the dispatch's effect from anything else.
 *
 * @example
 * ```ts
 * const prior = attempts.attempt(actionId, step);
 * if (prior) return await reconcile(actionId, step, prior);  // never repeats blind
 * attempts.begin(actionId, step, { at: Date.now() });
 * const made = await dispatch();
 * attempts.settle(actionId, step);
 * return made;
 * ```
 */
export class AttemptJournal<M> {
  readonly #kv: KvScannable;
  readonly #prefix: string;

  /**
   * Creates an attempt journal.
   * @param kv Durable Object storage for the markers.
   * @param keys `namespace` deriving a prefix, or a `markerPrefix` adopting existing storage.
   */
  constructor(kv: KvScannable, keys: AttemptKeys) {
    this.#kv = kv;
    if ("markerPrefix" in keys) {
      if (!keys.markerPrefix) throw new Error("markerPrefix must not be empty.");
      this.#prefix = keys.markerPrefix;
    } else {
      if (!NAMESPACE.test(keys.namespace ?? "")) {
        throw new Error(
          `Attempt journal namespace "${keys.namespace}" must match ${NAMESPACE.source}.`);
      }
      this.#prefix = `${keys.namespace}:attempt:`;
    }
  }

  /**
   * Records a dispatch marker just before the dispatch goes out. Overwrites an earlier marker for
   * the same step once that marker's dispatch was reconciled to nothing: the new attempt is the
   * one a later crash must answer for, and what it made is judged against its own send time.
   * @param actionId The action the dispatch belongs to.
   * @param step One action's dispatches, distinguished where it makes several (a step index, a
   * call name).
   * @param marker What a reconciliation of this dispatch needs: provider facts captured when it
   * went out.
   */
  begin(actionId: number, step: string, marker: M): void {
    this.#kv.put(this.#key(actionId, step), marker);
  }

  /**
   * Reads a dispatch marker back, for the reconcile a re-delivered apply owes before it repeats
   * the dispatch. Also the double-dispatch guard: a marker present means the dispatch already
   * went out once, so the apply reconciles instead of sending again.
   * @param actionId The action the dispatch belongs to.
   * @param step The dispatch's step.
   * @returns The marker, or `undefined` when this dispatch never went out.
   */
  attempt(actionId: number, step: string): M | undefined {
    return this.#kv.get<M>(this.#key(actionId, step));
  }

  /**
   * Clears a dispatch marker once its outcome is known, landed or refused. Leaving it settled
   * would hold the action's rejection hostage to a dispatch that can no longer surprise anyone.
   * @param actionId The action the dispatch belongs to.
   * @param step The dispatch's step.
   */
  settle(actionId: number, step: string): void {
    this.#kv.delete(this.#key(actionId, step));
  }

  /**
   * Whether any of an action's dispatches is still unreported -- the outcome-unknown protocol's
   * refusal to reject. A rejection discards the record; with a dispatch unreported, that record
   * may be the only warning that the provider may already have changed, so the connector refuses
   * and the user reconciles by applying (which looks) or by checking the provider.
   * @param actionId The action asked to reject.
   * @returns Whether any dispatch of the action is marked unsettled.
   */
  possiblyApplied(actionId: number): boolean {
    const first = this.#kv.list({ prefix: this.#key(actionId, "") })[Symbol.iterator]().next();
    return !first.done;
  }

  /**
   * Drops every marker an action holds, once it resolves. A resolved action never applies again,
   * so its dispatches can no longer surprise anyone.
   * @param actionId The resolved action.
   */
  clear(actionId: number): void {
    for (const [key] of this.#kv.list({ prefix: this.#key(actionId, "") })) {
      this.#kv.delete(key);
    }
  }

  /**
   * Housekeeping: drops the markers of every action not still awaiting a decision, which a
   * resolution or a crash between resolution and cleanup can leave behind. A key under the
   * journal's prefix that names no action id counts as leftover, so a malformed one cannot linger
   * forever.
   * @param waiting The action IDs that may still apply.
   */
  clearExcept(waiting: ReadonlySet<number>): void {
    const leftover: string[] = [];
    for (const [key] of this.#kv.list({ prefix: this.#prefix })) {
      const id = /^([1-9]\d*):/.exec(key.slice(this.#prefix.length));
      if (id === null || !waiting.has(Number(id[1]))) leftover.push(key);
    }
    for (const key of leftover) this.#kv.delete(key);
  }

  /**
   * Builds a marker key.
   * @param actionId The action the dispatch belongs to.
   * @param step The dispatch's step.
   * @returns Storage key for the marker.
   */
  #key(actionId: number, step: string): string {
    return `${this.#prefix}${actionId}:${step}`;
  }
}

/**
 * Settles a re-delivered apply whose dispatch was refused, for a write whose provider state can
 * answer without a dispatch marker: a compare-and-swap'd push refused because the branch moved, a
 * merge refused with "already merged". Reads the provider's current state and compares it with the
 * one the action was approved to leave. Equality is the earlier dispatch's success -- whether it
 * landed and the reply was lost, or a third party's identical write got there first, the approved
 * end state holds and the two are indistinguishable, so the apply is settled as applied.
 * @param readCurrent Reads the state the action was to leave, from the provider.
 * @param desired The state the action was approved to leave.
 * @returns The provider's current state when it is not the desired one, for the refusal to name;
 * `undefined` when the desired state is reached and the apply is settled.
 */
export async function desiredStateReached<T>(
  readCurrent: () => Promise<T>,
  desired: T,
): Promise<T | undefined> {
  const current = await readCurrent();
  return current === desired ? undefined : current;
}
