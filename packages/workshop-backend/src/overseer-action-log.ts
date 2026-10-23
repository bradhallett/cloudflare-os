import { ActionLogEntry } from "@gadgets/workshop-shared/api";
import type { ActionRecord, OverseerStorage } from "./storage-schema/overseer-storage";

/**
 * Raw records examined per page of subscribeToActions()'s startAfter resume replay. Exported
 * for tests.
 */
export const ACTION_REPLAY_PAGE_SIZE = 256;

/** listActions() entries returned per page. Exported for tests. */
export const ACTION_HISTORY_PAGE_DEFAULT_LIMIT = 50;

/** Split out of the former overseer.ts (internal helper). */
export function actionRecordToLog(record: ActionRecord): ActionLogEntry {
  // TODO: ActionRecord and ActionLogEntry are almost identical. The main difference is that
  // ActionRecord includes `action`, which should NOT be provided to the client. We could make
  // the two match more -- just `action` needs to be different.

  // ActionLogEntry omits the gatekeeperId for records that didn't come from a real gatekeeper
  // (built-in agent tools use the BUILTIN_TOOL_GATEKEEPER_ID sentinel).
  let gatekeeperId = record.gatekeeperId >= 0 ? record.gatekeeperId : undefined;

  switch (record.type) {
    case "observation":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        state: record.state,
        type: "observation",
        description: record.description,
      };
    case "action":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        state: record.state,
        type: "action",
        description: record.description,
        resolvedBy: record.resolvedBy,
        autoApproved: record.autoApproved,
        creation: record.action === "create" || undefined,
      };
    case "bindHook":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        state: record.state,
        type: "bindHook",
        hookId: record.hookId,
        description: record.description,
        enabled: record.enabled,
      };
    default:
      record satisfies never;
      throw new TypeError(`Invalid ActionRecord type: ${(record as ActionRecord).type}`);
  }
}

// Reflect a hook toggle (or deletion, which also severs the hookId reference) onto the hook's
// bindHook action record, stamping the state-change time the byLastChanged index keys on.
/** Split out of the former overseer.ts (internal helper). */
export function stampBindHookAction(storage: OverseerStorage, actionId: number, enabled: boolean,
    opts?: {clearHookId?: boolean}): void {
  let actionRecord = storage.actions.get(actionId);
  if (actionRecord?.type !== "bindHook") return;
  actionRecord.enabled = enabled;
  if (opts?.clearHookId) delete actionRecord.hookId;
  actionRecord.appliedAt = new Date();
  storage.actions.put(actionRecord);
}
