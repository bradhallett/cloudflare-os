/**
 * The outcome-unknown protocol: what a gatekeeper owes when an action was dispatched but its
 * result was never reported -- a lost reply, a dropped connection, an activation that died
 * mid-dispatch. Three rules, one per way the uncertainty is answered:
 *
 * 1. A dispatch that can no longer be reconciled is recorded terminally, never replayed. For an
 *    action set on the action journal, throwing `ActionOutcomeUnknownError` from the handler does
 *    this (see `./actions`); a claim left by a dead activation fails the same way. A connector
 *    that keeps its own action records gets the same loop from `applyClaimedAction`, below.
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

import { ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE } from "./actions";
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
 * The lifecycle states of a connector-owned action record driven by `applyClaimedAction`, which is
 * for connectors that keep their own action records rather than the action journal. `claimed` marks
 * the window where the provider call is in flight: the claim is written before the call, so any
 * later attempt that finds it knows a previous dispatch may have applied and refuses to run again.
 * `failed` is terminal — its `failure` explains itself — and is cleared by a rejection. `reverted`
 * is settled too: a replayed apply settles into it instead of dispatching again.
 */
export type ClaimedActionState = "pending" | "claimed" | "applied" | "failed" | "reverted";

/** A record `applyClaimedAction` can drive. */
export type ClaimedActionRecord = {
  state: ClaimedActionState;
  /** For state "failed": why, and what to answer later attempts with. */
  failure?: string;
};

/** The record storage `applyClaimedAction` drives a connector's own action records over. */
export type ClaimedActionStore<R extends ClaimedActionRecord> = {
  /** Reads one action record. */
  getAction(id: number): R | undefined;
  /** Writes one action record. */
  putAction(record: R): void;
};

/**
 * The claim-state loop for a connector that keeps its own action records: the guards a replayed
 * apply owes (settled is settled, a terminal failure answers itself, a leftover claim means a
 * dispatch whose outcome is unknown), the claim taken before the first provider call, and the
 * outcome-unknown classification that turns an unanswered dispatch into a terminal failure. The
 * connector supplies only its provider dispatch — which marks the record applied itself, so it can
 * persist intermediates (created ids, revert snapshots) on the record it was handed — and its
 * outcome-unknown classifier.
 *
 * @param store The connector's action record storage.
 * @param id The action to apply.
 * @param dispatch Performs the action against the provider. Receives the record already in state
 * "claimed" and must set it applied (or reverted) and store it on success.
 * @param isOutcomeUnknown Whether an error the dispatch raised means the provider may have applied
 * the write without a definitive answer arriving.
 * @throws Whatever the dispatch threw; an outcome-unknown failure is rethrown as an
 * `ActionOutcomeUnknownError` after being recorded terminally.
 */
export async function applyClaimedAction<R extends ClaimedActionRecord>(
  store: ClaimedActionStore<R>,
  id: number,
  dispatch: (record: R) => Promise<void>,
  isOutcomeUnknown: (error: unknown) => boolean,
): Promise<void> {
  const record = store.getAction(id);
  if (record === undefined) throw new Error(`Unknown action: ${id}`);
  // The Workshop marks its side approved only after this RPC returns, so a replayed apply
  // (restart, retry, duplicate click) settles here instead of dispatching again.
  if (record.state === "applied" || record.state === "reverted") return;
  // A terminal failure answers every later attempt with the same message, no provider call.
  if (record.state === "failed") {
    throw new Error(record.failure ?? "This action previously failed.");
  }
  // A claim left behind means a previous dispatch's outcome is unknown: the call may have reached
  // the provider. Record it terminally and surface it — never silently re-run a write.
  if (record.state === "claimed") throw markOutcomeUnknown(store, record);

  // Claim before the first provider call: the record durably says a dispatch began, so an
  // interrupted apply can never be mistaken for never-run. A fresh copy, so the record the
  // dispatch mutates (and persists its intermediates on) is exactly the claimed one.
  const claimed = { ...record, state: "claimed" } as R;
  store.putAction(claimed);
  try {
    await dispatch(claimed);
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      // No definitive answer arrived, so the write may have landed. Record the action terminally
      // with the reason and surface it; a rejection clears the record after the user checks.
      const message = `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error instanceof Error ? error.message : String(error)})`;
      store.putAction({ ...claimed, state: "failed", failure: message });
      throw new ActionOutcomeUnknownError(message);
    }
    // The provider answered with a refusal (or the failure is internal): the write did not land,
    // so the record goes back to pending and the failure stays retryable, as before. Any
    // intermediate the dispatch already persisted survives, so a retry builds on it.
    store.putAction({ ...claimed, state: "pending" });
    throw error;
  }
}

/**
 * Records that the outcome of a dispatched action cannot be known, and returns the error that
 * surfaces it. Terminal: only a rejection clears the record. For the apply loop above, and for a
 * connector's reject path, which owes the same refusal while a dispatch may be unreported.
 * @param store The connector's action record storage.
 * @param record The claimed record whose dispatch's outcome is unknown.
 * @returns The error to throw.
 */
export function markOutcomeUnknown<R extends ClaimedActionRecord>(
  store: ClaimedActionStore<R>,
  record: R,
): ActionOutcomeUnknownError {
  store.putAction({ ...record, state: "failed", failure: APPLY_OUTCOME_UNKNOWN_MESSAGE });
  return new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
}

/**
 * Settles a re-delivered apply whose dispatch was refused, for a write whose provider state can
 * answer without a dispatch marker: a compare-and-swap'd push refused because the branch moved, a
 * merge refused with "already merged". Reads the provider's current state and compares it with the
 * one the action was approved to leave. Equality is the earlier dispatch's success -- whether it
 * landed and the reply was lost, or a third party's identical write got there first, the approved
 * end state holds and the two are indistinguishable, so the apply is settled as applied.
 *
 * `T` is compared by identity, so it must be a primitive or interned value; both call sites pass
 * `string | null`.
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
