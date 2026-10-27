/**
 * Draft registry for the Gmail gatekeeper: draft resources, aliases, retained files, and the cross-family transactions that complete pending actions against provider state.
 */

import { GmailDraftCreateAction, GmailDraftDeleteAction, GmailDraftProviderBaseline, GmailDraftSendAction, GmailDraftUpdateAction, GmailDraftWriteReceipt, StoredGmailAction, actionFileReferences, actionResourceId, draftFileReferences, hasHistoricalAttachments, isDraftAction, migrateAttachmentState } from "./gmail-action-types";
import { GmailActionJournal } from "./gmail-journal";
import { GmailDraftResource, GmailDraftState, GmailForwardSnapshotReference, GmailForwardSnapshotStore } from "./gmail-state";

export const GMAIL_FORWARD_SNAPSHOT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export class GmailDraftRegistry {
  #storage: DurableObjectStorage;
  #kv: DurableObjectStorage["kv"];
  #files: GmailForwardSnapshotStore;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#kv = storage.kv;
    this.#files = new GmailForwardSnapshotStore(storage);
    const referencedHandles = new Set<string>();
    for (const [key, action] of this.#kv.list<unknown>({prefix: "pending:action:"})) {
      if (!Number.isSafeInteger(Number(key.slice("pending:action:".length)))) continue;
      for (const file of actionFileReferences(action as StoredGmailAction)) referencedHandles.add(file.handle);
    }
    for (const resource of this.listDrafts()) {
      for (const file of draftFileReferences(resource)) referencedHandles.add(file.handle);
    }
    this.#files.pruneUnreferenced(
      referencedHandles, Date.now() - GMAIL_FORWARD_SNAPSHOT_ORPHAN_GRACE_MS);
  }

  #draftKey(id: string) { return `gmail:draft:${id}`; }
  #draftAliasKey(id: string) { return `gmail:draftAlias:${id}`; }

  resolveDraftId(id: string): string {
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current) || seen.size >= 16) {
        throw new Error("Stored Gmail draft aliases are invalid.");
      }
      seen.add(current);
      const next = this.#kv.get<unknown>(this.#draftAliasKey(current));
      if (next === undefined) return current;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("Stored Gmail draft alias is invalid.");
      }
      current = next;
    }
  }

  getDraft(id: string): GmailDraftResource | undefined {
    return this.#kv.get<GmailDraftResource>(this.#draftKey(this.resolveDraftId(id)));
  }

  putDraft(journal: GmailActionJournal, resource: GmailDraftResource): void {
    const previous = this.getDraft(resource.logicalId);
    this.#kv.put(this.#draftKey(resource.logicalId), resource);
    if (!previous) return;
    const kept = new Set(draftFileReferences(resource).map(file => file.handle));
    for (const file of draftFileReferences(previous)) {
      if (!kept.has(file.handle)) this.releaseFile(journal, file);
    }
  }

  deleteDraft(journal: GmailActionJournal, id: string): void {
    const resolved = this.resolveDraftId(id);
    const resource = this.getDraft(resolved);
    this.#kv.delete(this.#draftKey(resolved));
    // Listed up front, as this loop deletes from the listing.
    const aliases = [...this.#kv.list<unknown>({prefix: "gmail:draftAlias:"})];
    for (const [key, target] of aliases) {
      if (target === resolved || key === this.#draftAliasKey(id)) this.#kv.delete(key);
    }
    if (resource) {
      for (const file of draftFileReferences(resource)) this.releaseFile(journal, file);
    }
  }

  listDrafts(): GmailDraftResource[] {
    return [...this.#kv.list<GmailDraftResource>({prefix: "gmail:draft:"})].map(([, value]) => value);
  }

  draftForProvider(providerId: string): GmailDraftResource | undefined {
    return this.listDrafts().find(resource => resource.providerId === providerId);
  }

  mapDraftToProvider(journal: GmailActionJournal,
      logicalId: string, providerId: string,
      expectedApplyingCreateId?: number,
      afterMap?: (resource: GmailDraftResource) => void): GmailDraftResource {
    return this.#storage.transactionSync(() => {
      const resolved = this.resolveDraftId(logicalId);
      const resource = this.#kv.get<GmailDraftResource>(this.#draftKey(resolved));
      if (!resource) throw new Error("Unknown Gmail draft resource.");
      if (resource.status !== "active") {
        throw new Error("The Gmail draft resource is no longer active.");
      }
      if (resource.providerId && resource.providerId !== providerId) {
        throw new Error("The Gmail draft resource is already mapped to another provider draft.");
      }
      if (expectedApplyingCreateId !== undefined) {
        const create = journal.getAction(expectedApplyingCreateId);
        if (create?.type !== "draftCreate" || !journal.isApplying(expectedApplyingCreateId) ||
            this.resolveDraftId(create.draft.logicalId) !== resource.logicalId) {
          throw new Error("The uncertain Gmail draft create changed while it was being reconciled.");
        }
      }
      const duplicate = this.listDrafts().find(candidate =>
        candidate.providerId === providerId && candidate.logicalId !== resource.logicalId);
      if (duplicate) {
        if (journal.listActions().some(({action}) => action.type === "draftCreate" &&
            this.resolveDraftId(action.draft.logicalId) === duplicate.logicalId)) {
          throw new Error("Gmail returned a provider draft ID already owned by another pending create.");
        }
        this.#kv.delete(this.#draftKey(duplicate.logicalId));
        this.#kv.put(this.#draftAliasKey(duplicate.logicalId), resource.logicalId);
      }
      const mergedIds = new Set([resource.logicalId, ...(duplicate ? [duplicate.logicalId] : [])]);
      const mergedActions = journal.listActions().filter(({action}) => isDraftAction(action) &&
        mergedIds.has(this.resolveDraftId(actionResourceId(action)!)));
      const predecessors: number[] = [];
      for (const {id, action} of mergedActions) {
        if (!isDraftAction(action)) continue;
        let retargeted: GmailDraftCreateAction | GmailDraftUpdateAction |
          GmailDraftDeleteAction | GmailDraftSendAction;
        switch (action.type) {
        case "draftCreate":
          retargeted = {
            ...action,
            draft: {...action.draft, logicalId: resource.logicalId},
          };
          break;
        case "draftUpdate":
          retargeted = {
            ...action,
            draftId: resource.logicalId,
            after: {...action.after, logicalId: resource.logicalId},
          };
          break;
        case "draftDelete":
          retargeted = {...action, draftId: resource.logicalId};
          break;
        case "draftSend":
          retargeted = {
            ...action,
            draftId: resource.logicalId,
            approved: {...action.approved, logicalId: resource.logicalId},
          };
          break;
        }
        retargeted = {
          ...retargeted,
          dependsOn: [...new Set([...(retargeted.dependsOn ?? []), ...predecessors])]
            .filter(dependency => dependency !== id),
        };
        journal.updateAction(id, retargeted);
        predecessors.push(id);
      }
      resource.providerId = providerId;
      this.putDraft(journal, resource);
      afterMap?.(resource);
      return resource;
    });
  }

  completeDraftWrite(journal: GmailActionJournal,
      actionId: number, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string,
      expectedReceipt: GmailDraftWriteReceipt = baseline): void {
    const action = journal.getAction(actionId);
    if (action?.type !== "draftCreate" && action?.type !== "draftUpdate") {
      throw new Error("The pending Gmail draft write changed before completion.");
    }
    if (action.type === "draftUpdate") {
      this.#storage.transactionSync(() => this.#completeDraftWrite(journal,
        actionId, this.resolveDraftId(action.draftId), baseline, approvedOutputFingerprint,
        expectedReceipt));
      return;
    }
    let completed = false;
    this.mapDraftToProvider(journal, action.draft.logicalId, baseline.draftId, actionId, resource => {
      this.#completeDraftWrite(journal,
        actionId, resource.logicalId, baseline, approvedOutputFingerprint, expectedReceipt);
      completed = true;
    });
    if (!completed) throw new Error("The Gmail draft write was not completed.");
  }

  completeMatchingDraftUpdate(journal: GmailActionJournal,
      actionId: number, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string): void {
    const action = journal.getAction(actionId);
    if (action?.type !== "draftUpdate") {
      throw new Error("The matching Gmail draft update changed before completion.");
    }
    this.#storage.transactionSync(() => this.#completeDraftWrite(journal,
      actionId, this.resolveDraftId(action.draftId), baseline, approvedOutputFingerprint));
  }

  #completeDraftWrite(journal: GmailActionJournal,
      actionId: number, logicalId: string, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string,
      expectedReceipt?: GmailDraftWriteReceipt): void {
    const action = journal.getAction(actionId);
    if (action?.type !== "draftCreate" && action?.type !== "draftUpdate") {
      throw new Error("The pending Gmail draft write changed before completion.");
    }
    const receipt = journal.getDraftWriteReceipt(actionId);
    if (expectedReceipt && (!journal.isApplying(actionId) || !receipt ||
        receipt.draftId !== expectedReceipt.draftId ||
        receipt.messageId !== expectedReceipt.messageId ||
        receipt.threadId !== expectedReceipt.threadId)) {
      throw new Error("The Gmail draft write receipt changed before completion.");
    }
    const resource = this.getDraft(logicalId);
    if (!resource || resource.providerId !== baseline.draftId || resource.status !== "active") {
      throw new Error("The Gmail draft resource changed before write completion.");
    }

    const pending = journal.listActions();
    const pendingIds = new Set(pending.map(({id}) => id));
    const decisions = journal.decisions();
    const successor = pending.find(({id, action: candidate}) =>
      id > actionId && isDraftAction(candidate) &&
      this.resolveDraftId(actionResourceId(candidate)!) === logicalId &&
      !(candidate.dependsOn ?? []).some(dependency => dependency !== actionId &&
        !pendingIds.has(dependency) && decisions.get(dependency) !== "applied"));
    if (successor && isDraftAction(successor.action)) {
      if (!successor.action.dependsOn?.includes(actionId)) {
        throw new Error("The dependent Gmail draft action lost its write prerequisite.");
      }
      let expected: string;
      let rebased: GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction;
      switch (successor.action.type) {
      case "draftUpdate":
        expected = successor.action.expectedBefore;
        rebased = {
          ...successor.action,
          expectedBefore: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
          ...(hasHistoricalAttachments(successor.action) ? {historicalAttachments: true} : {}),
        };
        break;
      case "draftDelete":
        expected = successor.action.expectedSnapshot;
        rebased = {
          ...successor.action,
          expectedSnapshot: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
        };
        break;
      case "draftSend":
        expected = successor.action.expectedSnapshot;
        rebased = {
          ...successor.action,
          expectedSnapshot: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
          ...(hasHistoricalAttachments(successor.action) ? {historicalAttachments: true} : {}),
        };
        break;
      case "draftCreate":
        throw new Error("A Gmail draft cannot have another create action as its successor.");
      }
      // Only the legacy fingerprint is unversioned, so an old precondition cannot match the others.
      if (expected !== approvedOutputFingerprint && expected !== baseline.outputFingerprint &&
          expected !== baseline.legacyOutputFingerprint) {
        throw new Error("The dependent Gmail draft action no longer matches the approved write output.");
      }
      journal.updateAction(successor.id, rebased);
    }
    // A historical write re-keyed its attachments before writing them. Every later action's copy of
    // those parts can no longer be matched through the legacy parse of what it wrote, so each
    // takes the exact mapping; only the immediate successor's preconditions were rebased above.
    if (action.type === "draftUpdate" && action.exactAfter) {
      for (const {id, action: candidate} of journal.listActions()) {
        if (id <= actionId || (candidate.type !== "draftUpdate" && candidate.type !== "draftSend") ||
            this.resolveDraftId(candidate.draftId) !== logicalId) {
          continue;
        }
        const migrated = candidate.type === "draftUpdate"
          ? migrateAttachmentState(candidate.exactAfter ?? candidate.after, action.after, action.exactAfter)
          : migrateAttachmentState(candidate.exactApproved ?? candidate.approved, action.after, action.exactAfter);
        if (migrated) {
          journal.updateAction(id, candidate.type === "draftUpdate"
            ? {...candidate, exactAfter: migrated} : {...candidate, exactApproved: migrated});
        }
      }
    }

    resource.appliedAttachments = baseline.appliedAttachments;
    resource.attachmentMessageId = baseline.messageId;
    // A queued successor already advanced the resource generation and was rebased above. Without
    // one, completion must advance it so an update currently awaiting authorization detects that
    // its provider baseline changed before it can store stale preconditions.
    if (!successor) resource.version++;
    this.putDraft(journal, resource);

    journal.setDecision(actionId, "applied");
    journal.removeAction(actionId);
    this.releaseActionFiles(journal, action);
    journal.clearApplying(actionId);
    journal.pruneDecisions();
  }

  captureFile(bytes: Uint8Array): Promise<GmailForwardSnapshotReference> {
    return this.#files.capture(bytes);
  }

  readFile(file: GmailForwardSnapshotReference): Promise<Uint8Array> {
    return this.#files.read(file);
  }

  /** Delete a retained file unless a pending action or an active draft still references it. */
  releaseActionFiles(journal: GmailActionJournal, action: StoredGmailAction): void {
    for (const file of actionFileReferences(action)) this.releaseFile(journal, file);
  }

  releaseFile(journal: GmailActionJournal, file: GmailForwardSnapshotReference | undefined): void {
    if (!file) return;
    if (journal.listActions().some(({action}) =>
        actionFileReferences(action).some(other => other.handle === file.handle))) return;
    if (this.listDrafts().some(resource =>
        draftFileReferences(resource).some(other => other.handle === file.handle))) return;
    this.#files.delete(file);
  }

  clearDraftForwardSnapshot(journal: GmailActionJournal, id: string): void {
    const resource = this.getDraft(id);
    if (!resource) return;
    delete resource.forwardSnapshot;
    delete resource.forwardBody;
    delete resource.forwardHtml;
    this.putDraft(journal, resource);
  }

  restoreDraftVersion(journal: GmailActionJournal,
      id: string, submittedVersion: number, previousVersion: number,
      dependencies: readonly number[]): void {
    this.#storage.transactionSync(() => {
      const resource = this.getDraft(id);
      if (resource?.status !== "active" || resource.version !== submittedVersion) return;
      if (dependencies.some(dependency =>
        journal.decisions().get(dependency) === "applied")) return;
      resource.version = previousVersion;
      this.putDraft(journal, resource);
    });
  }

  updateDraftForwardContent(journal: GmailActionJournal, id: string, state: GmailDraftState): void {
    const resource = this.getDraft(id);
    if (!resource?.forwardSnapshot) return;
    resource.forwardBody = state.text;
    if (state.html === undefined) delete resource.forwardHtml;
    else resource.forwardHtml = state.html;
    this.putDraft(journal, resource);
  }

  completeSentAction(journal: GmailActionJournal,
      actionId: number, rfcMessageId: string,
      message: {id: string; threadId: string}): void {
    this.#storage.transactionSync(() => {
      const action = journal.getAction(actionId);
      const expectedMessageId = action?.type === "send"
        ? ("spec" in action ? action.spec.messageId : undefined)
        : action?.type === "draftSend" ? action.messageId : undefined;
      if (!action || !journal.isApplying(actionId) || expectedMessageId !== rfcMessageId) {
        throw new Error("The pending Gmail send changed before completion.");
      }
      journal.recordSentMessage(
        rfcMessageId, message, "submittedAt" in action ? action.submittedAt : undefined);
      if (action.type === "draftSend") {
        const resource = this.getDraft(action.draftId);
        if (!resource || resource.status !== "active") {
          throw new Error("The Gmail draft resource changed before send completion.");
        }
        resource.status = "sent";
        resource.version++;
        delete resource.forwardSnapshot;
        delete resource.forwardBody;
        delete resource.forwardHtml;
        this.putDraft(journal, resource);
      }
      journal.setDecision(actionId, "applied");
      journal.removeAction(actionId);
      this.releaseActionFiles(journal, action);
      journal.clearApplying(actionId);
      journal.pruneDecisions();
    });
  }

  completeMissingDraftUpdate(journal: GmailActionJournal, actionId: number): void {
    this.#storage.transactionSync(() => {
      const action = journal.getAction(actionId);
      const receipt = journal.getDraftWriteReceipt(actionId);
      if (action?.type !== "draftUpdate" || !journal.isApplying(actionId) || !receipt?.missing) {
        throw new Error("The missing Gmail draft update changed before completion.");
      }
      const logicalId = this.resolveDraftId(action.draftId);
      const resource = this.getDraft(logicalId);
      if (!resource || (resource.status !== "active" && resource.status !== "deleted") ||
          resource.providerId !== receipt.draftId) {
        throw new Error("The Gmail draft resource changed before missing update completion.");
      }
      if (resource.status === "active") {
        resource.status = "deleted";
        resource.version++;
      }
      delete resource.forwardSnapshot;
      delete resource.forwardBody;
      delete resource.forwardHtml;
      this.putDraft(journal, resource);
      journal.setDecision(actionId, "applied");
      journal.removeAction(actionId);
      this.releaseActionFiles(journal, action);
      journal.clearApplying(actionId);
      journal.pruneDecisions();
    });
  }
}

