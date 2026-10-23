// Durable lifecycle for Home Assistant device actions: staging, the claim taken before the
// device call, and the settle that records revert information.
//
// Home Assistant actions have physical-world effects (locks, lights, alarms), so apply must be
// exactly-once per approval. The claim is the kit's `ActionJournal` state machine: the claim is
// written *before* the device call, so any later attempt that finds a claimed record it did not
// take -- a restart, a replayed approval, a duplicate click -- knows the call may already have
// run and refuses to dispatch again instead of duplicating the effect. A dispatch whose outcome
// cannot be known (no response from the instance) is recorded terminally and surfaced, never
// silently retried.
//
// Settle order is the replay contract: the applied row (which `revertAction` reads) is written
// first, then the journal record is removed. A crash between the two heals on the next apply,
// because the applied row is checked before anything dispatches.

import {
  ActionJournal,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  type ActionJournalKv,
} from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { HomeAssistantError } from "./homeassistant-api";
import type { HomeAssistantAction, HomeAssistantRevertInfo, SubmitWriteBody } from "./homeassistant";

// The pre-journal counter held the last *issued* id; the journal's counter holds the next
// *unused* one. The migration seeds the new key from the old value so ids stay strictly
// increasing across the upgrade and no id is ever reissued, then drops the old key (making the
// migration idempotent per activation).
const LEGACY_NEXT_ACTION_ID_KEY = "counter:nextActionId";
const NEXT_ACTION_ID_KEY = "counter:nextFreeActionId";
const RECORD_PREFIX = "pending:";

function migrateLegacyCounter(kv: ActionJournalKv): void {
  const legacy = kv.get<number>(LEGACY_NEXT_ACTION_ID_KEY);
  if (legacy !== undefined) {
    kv.put(NEXT_ACTION_ID_KEY, legacy + 1);
    kv.delete(LEGACY_NEXT_ACTION_ID_KEY);
  }
}

// Rows the hand-rolled store wrote: { id, action, submittedAt }. The embedded action already
// carries its id, which `withActionId` re-stamps from the journal key regardless.
type LegacyPendingRow = { id: number; action: HomeAssistantAction; submittedAt: number };

function isLegacyPendingRow(raw: unknown): raw is LegacyPendingRow {
  if (typeof raw !== "object" || raw === null) return false;
  if (!("id" in raw) || !("action" in raw) || !("submittedAt" in raw)) return false;
  const { id, action, submittedAt } = raw;
  if (typeof id !== "number" || typeof submittedAt !== "number") return false;
  if (typeof action !== "object" || action === null || !("type" in action)) return false;
  return action.type === "callService" || action.type === "fireEvent"
    || action.type === "saveDashboard";
}

function upgradeLegacyRecord(raw: unknown): SubmitWriteBody | undefined {
  return isLegacyPendingRow(raw) ? raw.action : undefined;
}

/** Stamps a journal-allocated id onto a submitted body. */
export function withActionId(body: SubmitWriteBody, id: number): HomeAssistantAction {
  return { ...body, id };
}

/**
 * Internal storage row for actions that have been applied. Retained so that revertAction() can
 * look up the information needed to undo the action. The overseer only passes back the action ID,
 * so all revert information lives here in DO storage rather than being round-tripped through the
 * overseer. Its presence is also the settle marker apply replays against.
 */
export type AppliedActionRow = {
  id: number;
  action: HomeAssistantAction;
  revertInfo: HomeAssistantRevertInfo;
  appliedAt: number;
};

/** The device-facing operations the lifecycle drives. */
export type ActionStoreDeps = {
  kv: ActionJournalKv;
  /** Performs the action against the Home Assistant instance. */
  dispatch: (action: HomeAssistantAction) => Promise<void>;
  /** Captures the information a later revert needs. Reads only; runs before the claim. */
  snapshotForRevert: (action: HomeAssistantAction) => Promise<HomeAssistantRevertInfo>;
  /** Notified when the instance rejects the credentials. */
  onAuthError: () => Promise<void>;
};

export class HomeAssistantActionStore {
  readonly #deps: ActionStoreDeps;
  readonly #journal: ActionJournal<SubmitWriteBody>;
  // Every resolution runs exclusively: a second apply of the same id (or a reject racing one)
  // must queue behind the in-flight dispatch rather than read its claim as a leftover.
  readonly #resolutions = new SerialTaskQueue();

  constructor(deps: ActionStoreDeps) {
    this.#deps = deps;
    migrateLegacyCounter(deps.kv);
    this.#journal = new ActionJournal<SubmitWriteBody>(deps.kv, {
      legacyKeys: { nextIdKey: NEXT_ACTION_ID_KEY, recordPrefix: RECORD_PREFIX },
      upgradeRecord: upgradeLegacyRecord,
    });
  }

  /**
   * Reserves the next action id and stages the body for submission to the approval queue.
   * @param body The action as submitted, before its id is assigned.
   * @returns The staged action, with its id stamped in.
   */
  allocate(body: SubmitWriteBody): HomeAssistantAction {
    return withActionId(body, this.#journal.allocate(body));
  }

  /**
   * Confirms the approval queue accepted a staged action.
   * @param id Action id returned by `allocate`.
   */
  markSubmitted(id: number): void {
    this.#journal.markSubmitted(id);
  }

  /**
   * Removes a staged action whose submission to the approval queue failed.
   * @param id Action id returned by `allocate`.
   */
  rollbackSubmission(id: number): void {
    this.#journal.rollbackSubmission(id);
  }

  /** @returns Pending and in-flight (claimed) actions, in id order, for read-time simulation. */
  pendingActions(): HomeAssistantAction[] {
    return this.#journal.listPending().map(({ id, action }) => withActionId(action, id));
  }

  /**
   * Applies an approved action to the instance. Idempotent for an already-applied id, and
   * refuses (terminally) when an earlier attempt's claim means the device outcome is unknown.
   * @param id Action id returned by `allocate`.
   */
  apply(id: number): Promise<void> {
    return this.#resolutions.run(() => this.#applyRecord(id));
  }

  /**
   * Rejects a queued action: drops it, once nothing about it may still be in flight.
   * @param id Action id returned by `allocate`.
   */
  reject(id: number): Promise<void> {
    return this.#resolutions.run(() => this.#rejectRecord(id));
  }

  /** @returns The applied row `revertAction` reads, if the id settled. */
  getApplied(id: number): AppliedActionRow | undefined {
    return this.#deps.kv.get<AppliedActionRow>(`applied:${id}`);
  }

  #applyRecord(id: number): Promise<void> {
    // The applied row is the durable settle: the overseer records its approval only after this
    // RPC returns, so a replayed apply (restart, retry, duplicate click) settles here instead of
    // dispatching again, and finishes the record-removal a crash interrupted mid-settle.
    if (this.getApplied(id) !== undefined) {
      this.#journal.remove(id);
      return Promise.resolve();
    }
    const record = this.#journal.get(id);
    if (record === undefined) {
      return Promise.reject(new Error(`No queued Home Assistant action exists with id ${id}.`));
    }
    // A record still staged was left by a submission whose reply was lost; this callback proves
    // the overseer holds the id, so promote it rather than strand it.
    this.#journal.markSubmitted(id);
    // A terminal failure answers every later attempt with the same message, no device call.
    if (record.state === "failed") return Promise.reject(new Error(record.error));
    if (record.state === "claimed") return Promise.reject(this.#failUnknownOutcome(id));

    const action = withActionId(record.action, id);
    return this.#dispatchClaimed(action);
  }

  async #dispatchClaimed(action: HomeAssistantAction): Promise<void> {
    const id = action.id;
    // The revert snapshot is a read, so it runs before the claim: a crash between the two wastes
    // only the snapshot, and the claim window stays as narrow as it can be -- it opens
    // immediately before the device call.
    let revertInfo: HomeAssistantRevertInfo;
    try {
      revertInfo = await this.#deps.snapshotForRevert(action);
    } catch {
      // If we can't snapshot, proceed without revert.
      revertInfo = { type: "noRevert" };
    }

    this.#journal.markClaimed(id);
    try {
      await this.#deps.dispatch(action);
    } catch (error) {
      if (error instanceof HomeAssistantError) {
        if (error.isAuthError) await this.#deps.onAuthError();
        if (error.outcomeUnknown) {
          // No response arrived, so the call may have reached the instance. Record the action
          // terminally with the reason and surface it -- never silently retry a physical effect.
          const message = `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error.message})`;
          this.#journal.markFailed(id, message, { outcome: "unknown" });
          throw new ActionOutcomeUnknownError(message);
        }
      }
      // The instance answered (or the failure is internal): the action did not run, so the
      // record goes back to pending and the failure stays retryable, as before.
      this.#journal.restorePending(id);
      throw error;
    }

    // Settled: the applied row first (it is the replay marker and revertAction's source), then
    // the journal record. A crash between the two heals on the next apply.
    this.#deps.kv.put<AppliedActionRow>(`applied:${id}`, {
      id,
      action,
      revertInfo,
      appliedAt: Date.now(),
    });
    this.#journal.remove(id);
  }

  #rejectRecord(id: number): void {
    const record = this.#journal.get(id);
    if (record === undefined) return;
    this.#journal.markSubmitted(id);
    if (record.state === "claimed") {
      // The device call may already have run; deleting the record would discard the only trace
      // that it might have. The user checks the instance, then rejects again to clear the
      // failure this records.
      throw this.#failUnknownOutcome(id);
    }
    // Rejecting a recorded failure is the user clearing it after checking the instance; a
    // still-pending record simply goes. No simulation state exists to clean up beyond this.
    this.#journal.remove(id);
  }

  // Records that the outcome of a dispatched action cannot be known, and returns the error that
  // surfaces it. Terminal: only a rejection clears the record.
  #failUnknownOutcome(id: number): Error {
    this.#journal.markFailed(id, APPLY_OUTCOME_UNKNOWN_MESSAGE, { outcome: "unknown" });
    return new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
  }
}
