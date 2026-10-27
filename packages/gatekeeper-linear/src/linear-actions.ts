// The Linear action lifecycle, as the kit's `defineActions` engine over the `ActionJournal` this
// port keeps on its pre-engine keys (`counter:action` / `action:<id>`): staging under the pending
// cap with the lost-submit-reply guard, the claim taken before a write is dispatched, and the
// unknown-outcome classification. Every write is simulated while pending (the overlay machinery in
// linear-gatekeeper.ts), so the agent continues; applying resolves the provisional ids a pending
// batch traded in (`~N` issues, `~label:` labels) and records what Linear created for revert.

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
import { isLinearOutcomeUnknown, type LinearApi } from "./linear-api";
import type { StoredAction, StoredActionDraft } from "./linear-action-types";

/** The gatekeeper operations the declared lifecycle drives (linear-gatekeeper.ts provides them). */
export type LinearActionHost = {
  /** Runs one Linear call under the account's credentials, translating auth failures. */
  run<T>(fn: (api: LinearApi) => Promise<T>): Promise<T>;
  /** Resolves an issue ref (real or provisional) to a real id, throwing when unapplied. */
  resolveIssueRef(ref: string): string;
  /** Resolves a label id, throwing when a provisional label's create is unapplied. */
  requireLabelId(id: string): string;
  /** Resolves a label id, or `undefined` for an unapplied provisional label. */
  resolveLabelId(id: string): string | undefined;
  /** The real issue id a provisional ref resolved to, if its create was applied. */
  provisionalRealId(ref: string): string | undefined;
  /** Binds a provisional issue id to the real id its applied create produced. */
  putProvisionalIssue(provisionalId: string, realId: string): void;
  /** Binds a provisional label id to the real id its applied create produced. */
  putProvisionalLabel(syntheticId: string, realId: string): void;
  /** Drops a provisional issue binding when its create is rejected. */
  deleteProvisionalIssue(provisionalId: string): void;
  /** Drops a provisional label binding when its create is rejected. */
  deleteProvisionalLabel(syntheticId: string): void;
  /** Drops a team's cached label list after a createLabel applied. */
  invalidateTeamLabels(teamId: string): void;
};

/** The journal's kinds, one per write shape the sessions submit. */
export type LinearKinds = {
  [K in StoredAction["kind"]]: Omit<Extract<StoredActionDraft, { kind: K }>, "kind">;
};

// Rows the pre-engine store wrote carry a `status` the journal never reads; only a pending one is
// still awaiting a decision, so claimed/applied/failed rows drop from view on upgrade (a claim was
// a status field then, and nothing genuinely mid-dispatch can be re-derived). The approver-facing
// presentation is never read back after submit, so a placeholder stands in; every variant field
// rides along verbatim.
function upgradeLegacyRecord(raw: unknown): TaggedAction<LinearKinds> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("kind" in raw) || !("status" in raw)) return undefined;
  const row = raw as StoredAction;
  if (row.status !== "pending") return undefined;
  const { id: _id, status: _status, failure: _failure, kind, ...fields } = row;
  return {
    kind,
    payload: {
      ...fields,
      presentation: {
        title: row.title,
        implementsRevert: true,
        description: "Legacy queued action.",
        fields: [],
      },
    },
  } as TaggedAction<LinearKinds>;
}

/** The journal a Linear gatekeeper's actions live on, adopting the keys this port already kept. */
export function linearJournal(kv: ActionJournalKv): ActionJournal<TaggedAction<LinearKinds>> {
  return new ActionJournal<TaggedAction<LinearKinds>>(kv, {
    legacyKeys: { nextIdKey: "counter:action", recordPrefix: "action:" },
    upgradeRecord: upgradeLegacyRecord,
  });
}

// One provider call, classified: an outcome Linear never definitively answered is terminal and
// unknown, never retried blind; everything else stays retryable pending, as before the engine.
async function dispatch<T>(host: LinearActionHost, fn: (api: LinearApi) => Promise<T>): Promise<T> {
  try {
    return await host.run(fn);
  } catch (error) {
    if (isLinearOutcomeUnknown(error)) {
      throw new ActionOutcomeUnknownError(`${APPLY_OUTCOME_UNKNOWN_MESSAGE} `
        + `(${error instanceof Error ? error.message : String(error)})`);
    }
    throw error;
  }
}

// Provisional refs a payload consumes: the issue it targets, a parent it nests under, and any
// provisional labels it attaches.
function consumedRefs(payload: {
  issueRef?: string; input?: { parentId?: string | null }; labelIds?: string[];
}): string[] {
  return [
    ...(payload.issueRef?.startsWith("~") ? [payload.issueRef] : []),
    ...(payload.input?.parentId?.startsWith("~") ? [payload.input.parentId] : []),
    ...(payload.labelIds?.filter(id => id.startsWith("~label:")) ?? []),
  ];
}

const CREATE_ISSUE: ActionDefinition<LinearKinds["createIssue"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  provides: payload => [payload.provisionalId],
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    // A parent or label that was itself a pending create may now be real — resolve its ref. The
    // payload is never mutated in place; resolved ids stay locals for this dispatch only.
    const parentId = payload.input.parentId
      ? host.resolveIssueRef(payload.input.parentId) : undefined;
    const labelIds = payload.input.labelIds?.map(id => host.requireLabelId(id));
    const issue = await dispatch(host, api => api.createIssue({
      ...payload.input,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(labelIds !== undefined ? { labelIds } : {}),
    }));
    host.putProvisionalIssue(payload.provisionalId, issue.id);
    return { action: { ...payload, createdIssueId: issue.id } };
  },
  reject: async (payload, host) => {
    host.deleteProvisionalIssue(payload.provisionalId);
  },
};

const UPDATE_ISSUE: ActionDefinition<LinearKinds["updateIssue"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    // Resolve a provisional parent id (set via setParent against a pending-created issue).
    const parentId = payload.input.parentId
      ? host.resolveIssueRef(payload.input.parentId) : undefined;
    await dispatch(host, api => api.updateIssue(host.resolveIssueRef(payload.issueRef), {
      ...payload.input,
      ...(parentId !== undefined ? { parentId } : {}),
    }));
  },
};

const ADD_LABELS: ActionDefinition<LinearKinds["addLabels"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    await dispatch(host, async api => {
      const issue = await api.getIssue(host.resolveIssueRef(payload.issueRef));
      if (!issue) return;
      // Resolve any provisional `~label:` ids to the real labels their create actions produced.
      const add = payload.labelIds.map(id => host.requireLabelId(id));
      const current = (issue.labels?.nodes ?? []).map(l => l.id);
      await api.updateIssue(issue.id, { labelIds: [...new Set([...current, ...add])] });
    });
  },
};

const REMOVE_LABELS: ActionDefinition<LinearKinds["removeLabels"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    await dispatch(host, async api => {
      const issue = await api.getIssue(host.resolveIssueRef(payload.issueRef));
      if (!issue) return;
      // Skip unresolved provisional labels: they were never really attached, so nothing to remove.
      const remove = new Set(payload.labelIds.map(id => host.resolveLabelId(id))
        .filter((id): id is string => !!id));
      const next = (issue.labels?.nodes ?? []).map(l => l.id).filter(id => !remove.has(id));
      await api.updateIssue(issue.id, { labelIds: next });
    });
  },
};

const POST_COMMENT: ActionDefinition<LinearKinds["postComment"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    const comment = await dispatch(host, api =>
      api.createComment(host.resolveIssueRef(payload.issueRef), payload.body));
    return { action: { ...payload, createdCommentId: comment.id } };
  },
};

const CREATE_LABEL: ActionDefinition<LinearKinds["createLabel"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  provides: payload => [payload.synthetic.id],
  async apply(payload, host) {
    const label = await dispatch(host, api => api.createLabel({
      teamId: payload.teamId, name: payload.name, color: payload.color, description: payload.description,
    }));
    // Map the provisional label id to the real one, so dependent addLabels can resolve it.
    host.putProvisionalLabel(payload.synthetic.id, label.id);
    // The team's real label set changed; drop the cache so the new label shows promptly.
    host.invalidateTeamLabels(payload.teamId);
    return { action: { ...payload, createdLabelId: label.id } };
  },
  reject: async (payload, host) => {
    host.deleteProvisionalLabel(payload.synthetic.id);
  },
};

const ARCHIVE: ActionDefinition<LinearKinds["archive"], LinearActionHost> = {
  delivery: "continue-with-simulation",
  claimBeforeApply: true,
  describe: payload => payload.presentation,
  dependsOn: payload => consumedRefs(payload),
  async apply(payload, host) {
    await dispatch(host, api =>
      api.setIssueArchived(host.resolveIssueRef(payload.issueRef), payload.archived));
  },
};

/** The Linear action set: every write simulated while pending, claimed before dispatch. */
const LINEAR_ACTIONS = defineActions<LinearActionHost, LinearKinds>(
  {
    createIssue: CREATE_ISSUE, updateIssue: UPDATE_ISSUE, addLabels: ADD_LABELS,
    removeLabels: REMOVE_LABELS, postComment: POST_COMMENT, createLabel: CREATE_LABEL,
    archive: ARCHIVE,
  },
  // Every Linear write runs under the account's live credentials whatever connection produced it;
  // the pre-engine records carried no fence either. Applied records stay for revertAction.
  {
    fence: "none",
    retainApplied: true,
    vendorId: "linear",
    isResolvedReference: (host, ref) => ref.startsWith("~label:")
      ? host.resolveLabelId(ref) !== undefined
      : host.provisionalRealId(ref) !== undefined,
  },
);
// The pre-engine `counter:action` held the LAST issued id, while the journal's id counter must
// hold the NEXT unused one; pointing the journal at the legacy key verbatim would make the first
// post-migration submit refuse the id the last legacy row occupies. One-time fixup on binding:
// advance the counter past every occupied id. Raw reads, like the journal's own: a legacy row
// `upgradeRecord` cannot convert still occupies its id.
function adoptLegacyCounter(kv: ActionJournalKv, journal: ActionJournal<TaggedAction<LinearKinds>>): void {
  let id = kv.get<number>("counter:action") ?? 1;
  const start = id;
  while (kv.get(`action:${id}`) !== undefined || kv.get(`retained:action:${id}`) !== undefined
    || journal.wasApplied(id)) {
    id++;
  }
  if (id !== start) kv.put("counter:action", id);
}

// One journal (and so one submission lane and one resolution queue) per gatekeeper storage: the kit
// refuses two journals over one keyspace. Sessions submit and the gatekeeper applies, both through
// this memo; the first caller's host wins, and every caller builds an equivalent one.
const actions = new WeakMap<
  ActionJournalKv,
  { journal: ActionJournal<TaggedAction<LinearKinds>>; set: BoundActionSet<LinearKinds> }
>();

/**
 * The bound Linear lifecycle for one gatekeeper storage: the journal (for records and views) and
 * the action set (for submit, apply, and reject).
 */
export function linearActions(
  kv: ActionJournalKv,
  host: LinearActionHost,
): { journal: ActionJournal<TaggedAction<LinearKinds>>; set: BoundActionSet<LinearKinds> } {
  let memo = actions.get(kv);
  if (memo === undefined) {
    const journal = linearJournal(kv);
    adoptLegacyCounter(kv, journal);
    memo = { journal, set: LINEAR_ACTIONS.bind(journal, host) };
    actions.set(kv, memo);
  }
  return memo;
}
