// The SQL action lifecycle, as the kit's `defineActions` engine over the `ActionJournal` this
// port already kept (on its pre-engine keys): staging (under the pending cap, with the
// lost-submit-reply guard), the claim taken before the statement runs, and the
// unknown-outcome classification. Deciding a statement is exactly-once per approval: the claim
// is durably written before the SQL runs, so a dispatch that dies mid-run is never mistaken for
// never-run, and a run whose outcome cannot be known is recorded terminally and surfaced rather
// than silently retried.

import {
  ActionDefinition,
  ActionJournal,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  type ActionJournalKv,
  type BoundActionSet,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import { SupabaseApiError, isSupabaseOutcomeUnknown } from "./supabase-api";
import type { SupabaseValue } from "./types";
import { VENDOR_ID } from "./observability";

/** A mutating SQL statement queued for human approval and applied once approved. */
export type ExecuteAction = {
  ref: string;
  sql: string;
  params?: SupabaseValue[];
};

/** The journal's kinds, one per write shape the session submits. */
export type SupabaseKinds = { execute: ExecuteAction };

/** The gatekeeper operations the declared lifecycle drives. */
export type SupabaseActionHost = {
  /** Runs the statement against the project; the row payload is ignored (as pre-engine applies did). */
  runQuery(ref: string, sql: string, params?: SupabaseValue[]): Promise<unknown>;
  /** Signals the account so the user is prompted to reconnect after an auth failure. */
  noteExpired(): Promise<void>;
  /** Invalidates cached schema metadata, which an applied statement may have changed. */
  bumpGeneration(): void;
};

// Rows the pre-engine journal wrote carry a `submittedAt` the journal never read; they become
// pending records -- none of them was mid-run when the store swapped (a claim is a journal state).
function upgradeLegacyRecord(raw: unknown): TaggedAction<SupabaseKinds> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("ref" in raw) || !("sql" in raw)) return undefined;
  const { ref, sql, params } = raw as Partial<ExecuteAction>;
  if (typeof ref !== "string" || typeof sql !== "string") return undefined;
  return { kind: "execute", payload: { ref, sql, params } };
}

/** The journal a Supabase object's SQL actions live on, adopting the keys its port kept. */
export function supabaseJournal(kv: ActionJournalKv): ActionJournal<TaggedAction<SupabaseKinds>> {
  return new ActionJournal<TaggedAction<SupabaseKinds>>(kv, {
    legacyKeys: { nextIdKey: "pending:nextActionId", recordPrefix: "pending:action:" },
    upgradeRecord: upgradeLegacyRecord,
  });
}

/** The SQL definition: shown verbatim, claimed before the run, classified on failure. */
const EXECUTE: ActionDefinition<ExecuteAction, SupabaseActionHost> = {
  // This gatekeeper doesn't simulate writes, so the agent shouldn't continue (and read back
  // un-applied state) until the user decides on this statement.
  delivery: "await-decision",
  claimBeforeApply: true,
  describe(payload) {
    return {
      title: "Run SQL on Supabase",
      // A field shows the statement literally, so nothing in it can escape into the prose.
      ...buildDescription(
        `Execute a mutating SQL statement against Supabase project ${codeSpan(payload.ref)}.`)
        .verbatim("SQL", payload.sql, "sql")
        .json("Parameters", payload.params ?? [])
        .finish(),
      // Arbitrary SQL cannot be automatically reverted.
      implementsRevert: false,
    };
  },
  async apply(payload, host) {
    try {
      await host.runQuery(payload.ref, payload.sql, payload.params);
    } catch (error) {
      // On expired/revoked credentials, signal the account so the user is prompted to reconnect.
      // A plain throw sends the engine's apply loop back to pending, so the action stays queued
      // and can be retried after reconnecting.
      if (error instanceof SupabaseApiError && error.isAuthError) {
        await host.noteExpired();
        throw new Error(
          "Supabase credentials have expired or been revoked. Reconnect the account, then retry.",
          { cause: error });
      }
      if (isSupabaseOutcomeUnknown(error)) {
        // No definitive answer arrived, so the statement may have landed. Record the action
        // terminally with the reason and surface it; a rejection clears the record after the
        // user checks the database.
        throw new ActionOutcomeUnknownError(
          `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error instanceof Error ? error.message : String(error)})`);
      }
      // Supabase answered with a refusal (or the failure is internal): the statement did not
      // land, so the record goes back to pending and the failure stays retryable, as before.
      throw error;
    }
  },
};

/** The Supabase SQL set, bound once per object storage to its journal and host. */
const SUPABASE_ACTIONS = defineActions<SupabaseActionHost, SupabaseKinds>(
  { execute: EXECUTE },
  // A statement runs under the account's live credentials whatever connection produced it; the
  // pre-engine records carried no fence either.
  {
    fence: "none",
    vendorId: VENDOR_ID,
    afterResolve: (host, outcome) => {
      if (outcome === "applied") host.bumpGeneration();
    },
  },
);

// One journal (and so one submission lane and one resolution queue) per object storage: the kit
// refuses two journals over one keyspace. The session submits and the gatekeeper applies, both
// through this memo; the first caller's host wins, and every caller builds an equivalent one.
const actions = new WeakMap<
  ActionJournalKv,
  { journal: ActionJournal<TaggedAction<SupabaseKinds>>; set: BoundActionSet<SupabaseKinds> }
>();

/**
 * The bound SQL lifecycle for one object's storage: the journal (for the staging hooks tests
 * need) and the action set (for submit, apply, and reject).
 */
export function supabaseActions(
  kv: ActionJournalKv,
  host: SupabaseActionHost,
): { journal: ActionJournal<TaggedAction<SupabaseKinds>>; set: BoundActionSet<SupabaseKinds> } {
  let memo = actions.get(kv);
  if (memo === undefined) {
    const journal = supabaseJournal(kv);
    memo = { journal, set: SUPABASE_ACTIONS.bind(journal, host) };
    actions.set(kv, memo);
  }
  return memo;
}
