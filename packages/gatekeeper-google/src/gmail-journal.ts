/**
 * Pending-action journal for the Gmail gatekeeper: the queue, decisions, apply markers, and receipts, under the historical gmail storage keys. Free functions project pending state into overlays and submit actions.
 */

import { GmailAction, GmailDraftWriteReceipt, GmailSendAction, GmailSendFingerprint, GmailSentMessageReceipt, StoredGmailAction, actionResourceId, gmailAutoApprovalMetadata, isDraftAction, isLabelAction } from "./gmail-action-types";
import { GmailDraftRegistry } from "./gmail-draft-registry";
import { captureUploadedAttachments } from "./gmail-drafts";
import { GmailLabelRegistry } from "./gmail-labels";
import { GmailContext } from "./gmail-list";
import { GmailLabelChangeAction, GmailOutboundOverlayAction, GmailOverlay, pendingLabelChanges, pendingOutbound } from "./gmail-overlay";
import { GmailDecision, GmailDraftOverlayAction, GmailDraftState, GmailLabelOverlayAction, GmailLabelResource, PendingOverlayAction, isVersionedGmailFingerprint } from "./gmail-state";
import { GmailLabelRaw, gmailMessageIdQueryValue } from "./google-api";
import { GmailAttachmentInput } from "./types";
import { RenderedDescription } from "@gadgets/gatekeeper-kit/action-description";

export class GmailActionJournal {
  #storage: DurableObjectStorage;
  #kv: DurableObjectStorage["kv"];

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#kv = storage.kv;
  }

  #actionKey(id: number) { return `pending:action:${id}`; }
  #decisionKey(id: number) { return `gmail:decision:${id}`; }
  #applyingKey(id: number) { return `gmail:applying:${id}`; }
  #draftWriteReceiptKey(id: number) { return `gmail:draftWriteReceipt:${id}`; }
  #sendFingerprintKey(id: number) { return `gmail:sendFingerprint:${id}`; }
  #sentAliasKey(rfcMessageId: string) {
    return `gmail:sentAlias:${gmailMessageIdQueryValue(rfcMessageId)}`;
  }
  #sentProviderKey(providerId: string) { return `gmail:sentProvider:${providerId}`; }

  #bumpActionGeneration(): void {
    this.#kv.put("pending:actionGeneration", this.actionGeneration() + 1);
  }

  actionGeneration(): number {
    return this.#kv.get<number>("pending:actionGeneration") ?? 0;
  }

  submit(action: StoredGmailAction): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    this.#bumpActionGeneration();
    return id;
  }

  getAction(id: number): StoredGmailAction | undefined {
    return this.#kv.get<StoredGmailAction>(this.#actionKey(id));
  }

  /** Record the byte-exact state a historical update is about to write; see `exactAfter`. */
  recordExactDraftUpdate(id: number, exactAfter: GmailDraftState): void {
    const action = this.getAction(id);
    if (action?.type !== "draftUpdate") {
      throw new Error("The pending Gmail draft update changed before its write.");
    }
    this.#kv.put(this.#actionKey(id), {...action, exactAfter});
  }

  listActions(): Array<{id: number; action: StoredGmailAction}> {
    return [...this.#kv.list<StoredGmailAction>({prefix: "pending:action:"})]
      .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
      .filter(item => Number.isSafeInteger(item.id))
      .toSorted((a, b) => a.id - b.id);
  }

  /** Replaces a stored action record in place, without bumping the overlay generation. */
  updateAction(id: number, action: StoredGmailAction): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  removeAction(id: number): void {
    const action = this.getAction(id);
    const existed = action !== undefined;
    this.#kv.delete(this.#actionKey(id));
    this.#kv.delete(this.#draftWriteReceiptKey(id));
    this.#kv.delete(this.#sendFingerprintKey(id));
    if (existed) this.#bumpActionGeneration();
  }

  markApplying(id: number): void { this.#kv.put(this.#applyingKey(id), Date.now()); }
  isApplying(id: number): boolean { return this.#kv.get<number>(this.#applyingKey(id)) !== undefined; }
  clearApplying(id: number): void { this.#kv.delete(this.#applyingKey(id)); }

  setDraftWriteReceipt(id: number, receipt: GmailDraftWriteReceipt): void {
    this.#kv.put(this.#draftWriteReceiptKey(id), receipt);
  }

  getDraftWriteReceipt(id: number): GmailDraftWriteReceipt | undefined {
    return this.#kv.get<GmailDraftWriteReceipt>(this.#draftWriteReceiptKey(id));
  }

  setSendFingerprint(id: number, rfcMessageId: string, fingerprint: string): void {
    this.#storage.transactionSync(() => {
      const action = this.getAction(id);
      const expectedMessageId = action?.type === "send"
        ? ("spec" in action ? action.spec.messageId : undefined)
        : action?.type === "draftSend" ? action.messageId : undefined;
      const current = this.#kv.get<GmailSendFingerprint>(this.#sendFingerprintKey(id));
      // A pre-upgrade fingerprint left by a definitively rejected attempt is replaced on the
      // retry; while an attempt's outcome is uncertain, its fingerprint stays as it was sent.
      const migrating = current !== undefined && !isVersionedGmailFingerprint(current.fingerprint) &&
        !this.isApplying(id);
      if (!action || expectedMessageId !== rfcMessageId ||
          (current && (current.rfcMessageId !== rfcMessageId ||
            (current.fingerprint !== fingerprint && !migrating)))) {
        throw new Error("The approved Gmail send fingerprint changed unexpectedly.");
      }
      this.#kv.put(this.#sendFingerprintKey(id), {rfcMessageId, fingerprint});
    });
  }

  getSendFingerprint(id: number, rfcMessageId: string): string | undefined {
    const stored = this.#kv.get<GmailSendFingerprint>(this.#sendFingerprintKey(id));
    if (!stored) return undefined;
    if (stored.rfcMessageId !== rfcMessageId) {
      throw new Error("The stored Gmail send fingerprint belongs to another message.");
    }
    return stored.fingerprint;
  }

  recordSentMessage(
      rfcMessageId: string, message: {id: string; threadId: string},
      submittedAt: number | undefined): GmailSentMessageReceipt {
    const normalizedId = `<${gmailMessageIdQueryValue(rfcMessageId)}>`;
    const receipt: GmailSentMessageReceipt = {
      rfcMessageId: normalizedId, providerId: message.id, threadId: message.threadId,
      ...(submittedAt !== undefined ? {submittedAt} : {}),
    };
    const byAlias = this.#kv.get<GmailSentMessageReceipt>(this.#sentAliasKey(normalizedId));
    const byProvider = this.#kv.get<GmailSentMessageReceipt>(this.#sentProviderKey(message.id));
    for (const existing of [byAlias, byProvider]) {
      if (existing && (existing.rfcMessageId !== receipt.rfcMessageId ||
          existing.providerId !== receipt.providerId || existing.threadId !== receipt.threadId)) {
        throw new Error("The sent Gmail message receipt conflicts with an existing mapping.");
      }
    }
    this.#kv.put(this.#sentAliasKey(normalizedId), receipt);
    this.#kv.put(this.#sentProviderKey(message.id), receipt);
    return receipt;
  }

  sentMessageByRfcMessageId(rfcMessageId: string): GmailSentMessageReceipt | undefined {
    return this.#kv.get<GmailSentMessageReceipt>(this.#sentAliasKey(rfcMessageId));
  }

  sentMessageByProviderId(providerId: string): GmailSentMessageReceipt | undefined {
    return this.#kv.get<GmailSentMessageReceipt>(this.#sentProviderKey(providerId));
  }

  isSentMessage(providerId: string): boolean {
    return this.sentMessageByProviderId(providerId) !== undefined;
  }

  markDraftWriteMissing(id: number, expected: GmailDraftWriteReceipt): void {
    this.#storage.transactionSync(() => {
      const current = this.getDraftWriteReceipt(id);
      if (current?.draftId === expected.draftId && current.messageId === expected.messageId &&
          current.threadId === expected.threadId) {
        this.setDraftWriteReceipt(id, {...current, missing: true});
      }
    });
  }

  setDecision(id: number, decision: GmailDecision): void {
    this.#kv.put(this.#decisionKey(id), decision);
  }

  decisions(): Map<number, GmailDecision> {
    return new Map([...this.#kv.list<GmailDecision>({prefix: "gmail:decision:"})]
      .map(([key, decision]) => [Number(key.slice("gmail:decision:".length)), decision]));
  }

  pruneDecisions(): void {
    const needed = new Set<number>();
    for (const {action} of this.listActions()) {
      if ("dependsOn" in action) {
        for (const dependency of action.dependsOn ?? []) needed.add(dependency);
      }
    }
    for (const id of this.decisions().keys()) {
      if (!needed.has(id)) this.#kv.delete(this.#decisionKey(id));
    }
  }
}

export function dependenciesFor(store: GmailStore, resourceId: string, kind: "draft" | "label"): number[] {
  const decisions = store.journal.decisions();
  const pending = store.journal.listActions();
  const pendingIds = new Set(pending.map(item => item.id));
  const canonicalId = kind === "draft" ? store.drafts.resolveDraftId(resourceId) : resourceId;
  const actions = pending.filter(({action}) => {
    if (kind === "draft") {
      return isDraftAction(action) &&
        store.drafts.resolveDraftId(actionResourceId(action)!) === canonicalId;
    }
    return isLabelAction(action) && actionResourceId(action) === canonicalId;
  });
  const terminal = actions.find(item =>
    item.action.type === "draftDelete" || item.action.type === "draftSend" ||
    item.action.type === "labelDelete");
  if (terminal) {
    const operation = terminal.action.type === "draftSend" ? "send" : "deletion";
    throw new Error(
      `This ${kind} already has a pending ${operation}. Resolve that action before ` +
      "submitting another one.");
  }
  const invalid = actions.find(item =>
    "dependsOn" in item.action &&
    item.action.dependsOn?.some(dependency =>
      !pendingIds.has(dependency) && decisions.get(dependency) !== "applied"));
  if (invalid) {
    throw new Error(
      `This ${kind} has a pending action with an invalid prerequisite. Reject that action before ` +
      "submitting another one.");
  }
  return actions.map(item => item.id);
}

export function draftPending(store: GmailStore): PendingOverlayAction<GmailDraftOverlayAction>[] {
  const pending: PendingOverlayAction<GmailDraftOverlayAction>[] = [];
  for (const {id, action} of store.journal.listActions()) {
    if (!isDraftAction(action)) continue;
    const logicalId = store.drafts.resolveDraftId(actionResourceId(action)!);
    switch (action.type) {
    case "draftCreate":
      pending.push({id, action: {
        type: action.type,
        draft: {...action.draft, logicalId},
        dependsOn: action.dependsOn,
      }});
      break;
    case "draftUpdate":
      pending.push({id, action: {
        type: action.type,
        draftId: logicalId,
        after: {...action.exactAfter ?? action.after, logicalId},
        dependsOn: action.dependsOn,
      }});
      break;
    case "draftDelete":
      pending.push({id, action: {
        type: action.type, draftId: logicalId, dependsOn: action.dependsOn,
      }});
      break;
    case "draftSend":
      pending.push({id, action: {
        type: action.type, draftId: logicalId, dependsOn: action.dependsOn,
      }});
      break;
    }
  }
  return pending;
}

export function labelPending(store: GmailStore): PendingOverlayAction<GmailLabelOverlayAction>[] {
  return store.journal.listActions().filter(item => isLabelAction(item.action)) as
    PendingOverlayAction<GmailLabelOverlayAction>[];
}

export type PendingGmailActions = ReturnType<GmailActionJournal["listActions"]>;

export function labelChangePending(
    actions: PendingGmailActions): PendingOverlayAction<GmailLabelChangeAction>[] {
  return actions.flatMap(({id, action}) =>
    action.type === "messageMutation" || action.type === "archive" || action.type === "trash" ||
        action.type === "markRead" || action.type === "markUnread"
      ? [{id, action}]
      : []);
}

/**
 * Outbound actions queued by earlier versions are left out: they fail closed when applied, so
 * nothing they describe will be sent.
 */
export function outboundPending(
    actions: PendingGmailActions): PendingOverlayAction<GmailOutboundOverlayAction>[] {
  return actions.flatMap(({id, action}) =>
    (action.type === "send" && "spec" in action) || action.type === "draftSend" ||
        action.type === "draftDelete"
      ? [{id, action}]
      : []);
}

/**
 * The pending actions message and thread reads must reflect. An action being applied stays in.
 * For a label change that is harmless: Gmail has made the change or is about to, and patching a
 * label Gmail already changed does nothing. For a send it can show the message twice in its
 * thread, as Gmail's copy and as the pending one, from when Gmail accepts the send until the
 * store records it. That is accepted.
 *
 * Load this before fetching what it will patch. Loaded afterwards, it would miss an action that
 * finished applying during the fetch, and show the fetched state without it.
 */
export function loadGmailOverlay(store: GmailStore): GmailOverlay {
  const pending = store.journal.listActions();
  const decisions = store.journal.decisions();
  return {
    generation: store.journal.actionGeneration(),
    labelChanges: pendingLabelChanges(
      labelChangePending(pending), decisions, id => store.labels.getLabel(id)),
    ...pendingOutbound(outboundPending(pending), decisions, Date.now()),
  };
}

export async function submitAction(
    ctx: GmailContext, action: GmailAction,
    description: {title: string} & RenderedDescription,
    onFailure?: () => void): Promise<number> {
  const id = ctx.store.journal.submit(action);
  try {
    await ctx.approvalQueue.submitAction(id, {
      ...description,
      implementsRevert: false,
      ...gmailAutoApprovalMetadata(action),
    });
    return id;
  } catch (error) {
    // A concurrent child may already reference this ID. Preserve an explicit rejection until all
    // such children are resolved rather than letting a missing prerequisite look applied.
    ctx.store.journal.setDecision(id, "rejected");
    ctx.store.journal.removeAction(id);
    ctx.store.drafts.releaseActionFiles(ctx.store.journal, action);
    onFailure?.();
    ctx.store.journal.pruneDecisions();
    throw error;
  }
}

/**
 * Retains the uploads for the queued send. A failed submission releases them: `submitAction`
 * removes the action it stored, and anything captured before that is released here.
 */
export async function submitSendAction(
    ctx: GmailContext, action: GmailSendAction, description: {title: string} & RenderedDescription,
    inputs: readonly GmailAttachmentInput[] = []): Promise<void> {
  const uploadedAttachments = await captureUploadedAttachments(ctx.store, inputs);
  try {
    await submitAction(ctx, {...action, uploadedAttachments}, description);
  } catch (error) {
    for (const attachment of uploadedAttachments) ctx.store.drafts.releaseFile(ctx.store.journal, attachment.file);
    throw error;
  }
}

export type GmailLabelSnapshot = {labels: GmailLabelRaw[]; resources: GmailLabelResource[]};

export type GmailStore = {
  journal: GmailActionJournal;
  drafts: GmailDraftRegistry;
  labels: GmailLabelRegistry;
};

export function newGmailStore(storage: DurableObjectStorage): GmailStore {
  return {
    journal: new GmailActionJournal(storage),
    drafts: new GmailDraftRegistry(storage),
    labels: new GmailLabelRegistry(storage),
  };
}

