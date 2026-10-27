// The enrichment action lifecycle, as the kit's `defineActions` engine over an `ActionJournal`:
// staging (with the pending cap and the lost-submit-reply guard), the claim taken before the
// credit-spending dispatch, terminal unknown-outcome records, and rejection. The decided outcomes
// the Gadget reads back live in the bounded window in zoominfo-enrichment.ts.
//
// A ZoomInfo enrichment spends credits the moment ZoomInfo answers, so apply must be exactly-once
// per approval: the claim is written *before* the dispatch (`claimBeforeApply`), so a rejection
// arriving mid-flight can never supersede a live dispatch (ZC-1) and a replayed or crashed apply
// never dispatches blind. A definitive failure is terminal (the overseer must not retry a paid
// call that already answered); a dispatch whose outcome cannot be known is recorded as unknown and
// surfaced, never silently retried.

import {
  ActionApplyError,
  ActionJournal,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  type ActionDefinition,
  type ActionJournalKv,
  type BoundActionSet,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { isOutcomeUnknown, type ZoomInfoApi } from "./zoominfo-api";
import {
  performEnrichment,
  type PendingEnrichment,
  type StoredEnrichmentOutcome,
} from "./zoominfo-enrichment";
import { ReadLimitError } from "./zoominfo-reads";
import { VENDOR_ID } from "./zoominfo-env";

/**
 * A submitted enrichment as the journal stores it: the replay inputs plus the worst-case credit
 * cost the approval card discloses. Rows staged before the engine port carry no cost figure, so
 * `describe` omits the cost line for them.
 */
export type EnrichmentAction = PendingEnrichment & { worstCaseCredits?: number };

/** The journal's kinds, one per write shape the session submits. */
export type ZoomInfoKinds = { enrich: EnrichmentAction };

/** The session/gatekeeper operations the declared lifecycle drives. */
export type ZoomInfoActionHost = {
  /**
   * Runs one ZoomInfo call within the connection's daily read budget, translating auth failures
   * into a reconnect-prompting error.
   */
  call<T>(fn: (api: ZoomInfoApi) => Promise<T>): Promise<T>;
  /** Records a decided outcome for the Gadget's `getEnrichmentResult` readback. */
  putOutcome(id: number, outcome: StoredEnrichmentOutcome): void;
};

// Rows the pre-engine store wrote at `enrich:pending:<id>`: the enrichment inputs, without the
// journal's state envelope or a cost figure. They become pending records -- none of them was
// mid-dispatch when the store swapped (a claim was an outcome-store write back then).
function upgradeLegacyEnrichment(raw: unknown): TaggedAction<ZoomInfoKinds> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("kind" in raw) || !("summary" in raw) || !("attributes" in raw)) return undefined;
  const { kind, summary, attributes, page } = raw as Partial<EnrichmentAction>;
  if (typeof kind !== "string" || typeof summary !== "string" || typeof attributes !== "object") {
    return undefined;
  }
  return {
    kind: "enrich",
    payload: { kind, summary, attributes, ...(page === undefined ? {} : { page }) },
  };
}

/** The journal a ZoomInfo object's enrichments live on, adopting the keys its port kept. */
export function zoomInfoJournal(
  kv: ActionJournalKv,
): ActionJournal<TaggedAction<ZoomInfoKinds>> {
  return new ActionJournal<TaggedAction<ZoomInfoKinds>>(kv, {
    legacyKeys: { nextIdKey: "enrich:nextId", recordPrefix: "enrich:pending:" },
    upgradeRecord: upgradeLegacyEnrichment,
  });
}

/** The enrichment definition: disclosed cost, claimed dispatch, and a decision-recorded rejection. */
const ENRICH: ActionDefinition<EnrichmentAction, ZoomInfoActionHost> = {
  // No simulation: suspend the agent until the user decides rather than letting it read back
  // un-enriched state, exactly as the pre-engine submission's `awaitDecision` did.
  delivery: "await-decision",
  claimBeforeApply: true,
  describe(payload) {
    // The request body is what leaves the workspace (names, emails, company identifiers), so the
    // approver sees it exactly, after the summary and the cost.
    const cost = payload.worstCaseCredits === undefined ? "" :
      `\n\n**Credit cost:** up to **${payload.worstCaseCredits}** ZoomInfo bulk-data ` +
      `credit${payload.worstCaseCredits === 1 ? "" : "s"} (fewer if records are already under ` +
      `management; none for no-match/error results). Charged only on approval.`;
    return {
      title: `ZoomInfo: ${payload.summary}`,
      // The request body is what leaves the workspace (names, emails, company identifiers), so
      // the approver sees it exactly, in the fields after the summary and the cost.
      ...buildDescription(`${payload.summary}${cost}`)
        .json("Request", payload.attributes)
        .json("Page", payload.page ?? {})
        .finish(),
      // Spent credits can't be refunded, so there is no automatic revert.
      implementsRevert: false,
    };
  },
  async apply(payload, host, ctx) {
    let result: unknown;
    try {
      result = await host.call(api => performEnrichment(api, payload));
    } catch (error) {
      // The reservation was refused before any dispatch, so no credits were spent and the claim
      // was false: a plain throw sends the engine's apply loop back to pending, leaving the
      // enrichment retryable exactly as it was.
      if (error instanceof ReadLimitError) throw error;
      // The request may have reached ZoomInfo and been charged: record the outcome terminally as
      // unknown so the enrichment is never replayed blind -- a re-apply answers with the stored
      // message instead of calling ZoomInfo again. The window copy is written while the journal
      // record still exists, so the ticket keeps warning that credits may have been spent even
      // after the user rejects the action (which deletes the record).
      if (isOutcomeUnknown(error)) {
        host.putOutcome(ctx.id, { status: "unknown", message: APPLY_OUTCOME_UNKNOWN_MESSAGE });
        throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
      }
      // ZoomInfo answered with a definitive refusal: the action is resolved as failed (the
      // overseer must not retry a paid operation), and the Gadget reads the failure.
      throw new ActionApplyError(error instanceof Error ? error.message : String(error));
    }
    host.putOutcome(ctx.id, { status: "ready", result });
  },
  async reject(_payload, host, ctx) {
    host.putOutcome(ctx.id, { status: "rejected" });
  },
};

/** The ZoomInfo enrichment set, bound once per object storage to its journal and host. */
const ZOOMINFO_ACTIONS = defineActions<ZoomInfoActionHost, ZoomInfoKinds>(
  { enrich: ENRICH },
  // Enrichments are authority-independent reads of provider data: the dispatch runs under the
  // account's live credentials whatever connection produced the payload, as before the port.
  { fence: "none", vendorId: VENDOR_ID },
);

// One journal (and so one submission lane and one resolution queue) per object storage: the kit
// refuses two journals over one keyspace. The session submits and the gatekeeper applies, both
// through this memo; the first caller's host wins, and every caller builds an equivalent one over
// the same account DO.
const actions = new WeakMap<
  DurableObjectStorage["kv"],
  { journal: ActionJournal<TaggedAction<ZoomInfoKinds>>; set: BoundActionSet<ZoomInfoKinds> }
>();

/**
 * The bound enrichment lifecycle for one object's storage: the journal (for decision-state
 * readback) and the action set (for submit, apply, and reject).
 */
export function zoomInfoActions(
  kv: DurableObjectStorage["kv"],
  host: ZoomInfoActionHost,
): { journal: ActionJournal<TaggedAction<ZoomInfoKinds>>; set: BoundActionSet<ZoomInfoKinds> } {
  let memo = actions.get(kv);
  if (memo === undefined) {
    const journal = zoomInfoJournal(kv);
    memo = { journal, set: ZOOMINFO_ACTIONS.bind(journal, host) };
    actions.set(kv, memo);
  }
  return memo;
}
