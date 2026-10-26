// Durable lifecycle for Home Assistant device actions: staging, the claim taken before the
// device call, and the revert snapshot retained with the applied record.
//
// Home Assistant actions have physical-world effects (locks, lights, alarms), so apply must be
// exactly-once per approval. The whole lifecycle is the kit's `defineActions` engine over an
// `ActionJournal`: the claim is written *before* the device call (`claimBeforeApply`), so any
// later attempt that finds a claimed record it did not take -- a restart, a replayed approval, a
// duplicate click -- knows the call may already have run and refuses to dispatch again instead of
// duplicating the effect. A dispatch whose outcome cannot be known (no response from the
// instance) is recorded terminally and surfaced, never silently retried. The revert snapshot
// taken before the dispatch is retained on the journal's applied record (`retainApplied`), which
// is what `revertAction` reads back.

import {
  ActionJournal,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  type ActionDefinition,
  type ActionJournalKv,
  type ActionSet,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { describeAction } from "./approvals";
import { HomeAssistantError, type RegistrySnapshot } from "./homeassistant-api";
import type { HomeAssistantAction, HomeAssistantRevertInfo } from "./homeassistant";

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

function upgradeLegacyRecord(raw: unknown): TaggedAction<HomeAssistantKinds> | undefined {
  if (!isLegacyPendingRow(raw)) return undefined;
  // The legacy action's own `type` discriminator is the kind; its embedded id is re-stamped on
  // every read, so it rides along in the payload harmlessly.
  return { kind: raw.action.type, payload: raw.action } as TaggedAction<HomeAssistantKinds>;
}

/** Stamps a journal-allocated id onto a submitted body. */
export function withActionId(
  body: TaggedAction<HomeAssistantKinds>["payload"],
  id: number,
): HomeAssistantAction {
  return { ...body, id } as HomeAssistantAction;
}

/** The journal a Home Assistant object's actions live on, adopting the keys its port kept. */
export function homeAssistantJournal(
  kv: ActionJournalKv,
): ActionJournal<TaggedAction<HomeAssistantKinds>> {
  migrateLegacyCounter(kv);
  return new ActionJournal(kv, {
    legacyKeys: { nextIdKey: NEXT_ACTION_ID_KEY, recordPrefix: RECORD_PREFIX },
    upgradeRecord: upgradeLegacyRecord,
  });
}

/**
 * Internal storage row for actions applied before this port, which retained the revert snapshot
 * in its own `applied:<id>` key instead of on the journal record. Retained so `revertAction()`
 * can still undo an action the old store settled.
 */
export type AppliedActionRow = {
  id: number;
  action: HomeAssistantAction;
  revertInfo: HomeAssistantRevertInfo;
  appliedAt: number;
};

/**
 * The applied action `revertAction` reads: the revert snapshot its apply retained on the journal
 * record, or a pre-port `applied:<id>` row.
 * @param journal The gatekeeper object's action journal.
 * @param kv The same object's storage, for legacy applied rows.
 * @param id The applied action id.
 * @returns The action and its revert information, when the id settled.
 */
export function appliedAction(
  journal: ActionJournal<TaggedAction<HomeAssistantKinds>>,
  kv: ActionJournalKv,
  id: number,
): { action: HomeAssistantAction; revertInfo: HomeAssistantRevertInfo } | undefined {
  const record = journal.get(id);
  if (record?.state === "applied") {
    // The retained body carries the snapshot; the action handed back is the write itself.
    const { revert, ...body } = record.action.payload;
    return {
      action: withActionId(body, id),
      revertInfo: revert ?? { type: "noRevert" },
    };
  }
  const legacy = kv.get<AppliedActionRow>(`applied:${id}`);
  return legacy === undefined ? undefined : { action: legacy.action, revertInfo: legacy.revertInfo };
}

/** The submitted body of one write kind, plus the revert snapshot an apply retained with it. */
type KindBody<T extends HomeAssistantAction["type"]> =
  Omit<Extract<HomeAssistantAction, { type: T }>, "id">
  & { revert?: HomeAssistantRevertInfo };

/** The journal's kinds, one per write shape the session submits. */
export type HomeAssistantKinds = {
  callService: KindBody<"callService">;
  fireEvent: KindBody<"fireEvent">;
  saveDashboard: KindBody<"saveDashboard">;
};

/** The gatekeeper operations the declared lifecycle drives. */
export type HomeAssistantActionHost = {
  /** Performs the action against the Home Assistant instance. */
  dispatch(action: HomeAssistantAction): Promise<void>;
  /** Captures the information a later revert needs. Reads only. */
  snapshotForRevert(action: HomeAssistantAction): Promise<HomeAssistantRevertInfo>;
  /** Fetches the registry snapshot that enriches an approval card with friendly names. */
  fetchRegistrySnapshot(): Promise<RegistrySnapshot>;
  /** Notified when the instance rejects the credentials. */
  onAuthError(): Promise<void>;
};

// The registry names only enrich descriptions; an unreachable instance still gets an accurate,
// minimal card naming what the write does.
const EMPTY_REGISTRY: RegistrySnapshot = {
  areas: [], floors: [], labels: [], devices: [], entities: [], states: new Map(),
};

/** The definition every write kind shares: described, claimed, dispatched, and reverted alike. */
function writeKind<T extends HomeAssistantAction["type"]>(
  kind: T,
): ActionDefinition<HomeAssistantKinds[T], HomeAssistantActionHost> {
  return {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: async (body, host) => {
      const action = { ...body, type: kind, id: 0 } as HomeAssistantAction;
      try {
        return describeAction(action, await host.fetchRegistrySnapshot());
      } catch {
        return describeAction(action, EMPTY_REGISTRY);
      }
    },
    apply: async (body, host, { id }) => {
      const action = withActionId(body, id);
      // The snapshot is a read: failing it costs only revert, never the write.
      let revert: HomeAssistantRevertInfo;
      try {
        revert = await host.snapshotForRevert(action);
      } catch {
        revert = { type: "noRevert" };
      }
      try {
        await host.dispatch(action);
      } catch (error) {
        if (error instanceof HomeAssistantError) {
          if (error.isAuthError) await host.onAuthError();
          if (error.outcomeUnknown) {
            // No response arrived, so the call may have reached the instance. Recorded
            // terminally by the kit and surfaced here -- never silently retry a physical effect.
            throw new ActionOutcomeUnknownError(
              `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error.message})`);
          }
        }
        // The instance answered (or the failure is internal): the kit restores pending, so the
        // failure stays retryable, as before.
        throw error;
      }
      // Retained on the applied journal record, which is what `revertAction` reads back.
      return { action: { ...body, revert } };
    },
  };
}

/** The Home Assistant write set, bound once per gatekeeper object to its journal and host. */
export const HOME_ASSISTANT_ACTIONS: ActionSet<HomeAssistantActionHost, HomeAssistantKinds> =
  defineActions<HomeAssistantActionHost, HomeAssistantKinds>({
    callService: writeKind("callService"),
    fireEvent: writeKind("fireEvent"),
    saveDashboard: writeKind("saveDashboard"),
  }, {
    // Credentials are resolved per dispatch, so a reconnect between approval and apply is
    // picked up rather than fenced.
    fence: "none",
    // The applied record is the revert snapshot's home.
    retainApplied: true,
    vendorId: "homeassistant",
  });

