/**
 * Apply-pipeline helpers for the Gmail gatekeeper.
 */

import { GmailDraftSendAction, GmailMessageMutationAction, GmailSendAction, GmailSourceAttachment, StoredGmailAction, hasHistoricalAttachments } from "./gmail-action-types";
import { applyingDraftCreates, mapMatchingApplyingDraftCreate } from "./gmail-draft-stubs";
import { GmailProviderDraft, draftSpec, matchesGmailFingerprint, materializeDraftAttachments, materializeSourceAttachment, outboundSpec, parseSafeGmailDraft, sendSourceSnapshot, uploadedInputs } from "./gmail-drafts";
import { GmailStore } from "./gmail-journal";
import { GmailMutationOperation, mutationLabelChanges } from "./gmail-overlay";
import { gmailDependencyError, gmailDraftFingerprint } from "./gmail-state";
import { GMAIL_BATCH_MODIFY_MAX_IDS, GmailApi, GmailOutboundMessage, GmailOutboundSpec, gmailAttachmentInputToOutbound } from "./google-api";
import { GoogleApiError } from "./google-response";
import { GmailAttachmentInput } from "./types";

export function assertDependencies(store: GmailStore, action: {dependsOn?: number[]}): void {
  const pendingIds = new Set(store.journal.listActions().map(item => item.id));
  const error = gmailDependencyError(action, pendingIds, store.journal.decisions());
  if (error) throw new Error(error);
}

export function providerDraftId(store: GmailStore, logicalId: string): string {
  const resource = store.drafts.getDraft(logicalId);
  if (!resource) throw new Error("Unknown Gmail draft resource.");
  if (resource.status === "rejected") throw new Error("The draft creation prerequisite was rejected.");
  if (resource.status === "deleted") throw new Error("This Gmail draft has been deleted.");
  if (resource.status === "sent") throw new Error("This Gmail draft has already been sent.");
  if (!resource.providerId) {
    throw new Error("The draft does not exist in Gmail yet. Approve its create action first.");
  }
  return resource.providerId;
}

export async function reconcileDraftActionAlias(
    api: GmailApi, store: GmailStore, action: StoredGmailAction): Promise<void> {
  if (action.type !== "draftUpdate" && action.type !== "draftDelete" &&
      action.type !== "draftSend") return;
  if (applyingDraftCreates(store).length === 0) return;
  const resource = store.drafts.getDraft(action.draftId);
  if (!resource?.providerId) return;
  const provider = await api.getDraft(resource.providerId);
  const parsed = await parseSafeGmailDraft(provider.message);
  await mapMatchingApplyingDraftCreate(api, store, provider, parsed);
}

export function providerLabelId(store: GmailStore, logicalId: string): string {
  const resource = store.labels.getLabel(logicalId);
  if (!resource) return logicalId;
  if (resource.status === "rejected") throw new Error("The label creation prerequisite was rejected.");
  if (!resource.providerId) {
    throw new Error("The label does not exist in Gmail yet. Approve its create action first.");
  }
  return resource.providerId;
}

export function isDefinitiveWriteRejection(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 429;
}

export async function applyUncertainWrite<T>(
    store: GmailStore, actionId: number, write: () => Promise<T>): Promise<T> {
  store.journal.markApplying(actionId);
  try {
    return await write();
  } catch (error) {
    // A definitive rejection proves this invocation did not mutate Gmail. Read/reconciliation
    // failures must never reach this path or erase an earlier invocation's uncertain outcome.
    if (isDefinitiveWriteRejection(error)) store.journal.clearApplying(actionId);
    throw error;
  }
}

/**
 * `spec` completed from retained bytes: the forward source first (rebuilt inline, or attached as
 * the original message), then the uploaded files.
 */
export async function exactSpecWithSource(
    api: GmailApi, store: GmailStore, spec: GmailOutboundSpec,
    snapshot: GmailSourceAttachment | undefined, inline = false,
    uploads: GmailAttachmentInput[] = []): Promise<GmailOutboundSpec> {
  if (!snapshot) {
    return uploads.length === 0 ? spec
      : {...spec, attachments: [...spec.attachments, ...uploads.map(gmailAttachmentInputToOutbound)]};
  }
  const bytes = await store.drafts.readFile(snapshot);
  if (inline) {
    if (spec.attachments.length > 0) {
      throw new Error("This inline forward has inconsistent attachment metadata.");
    }
    const message = await api.buildForwardFromBytes(bytes, spec.to, spec.text, {
      cc: spec.cc,
      bcc: spec.bcc,
      ...(spec.html !== undefined ? {html: spec.html} : {}),
      attachments: uploads,
    }, spec.messageId, spec.subject, spec.date);
    if (message.from !== spec.from || message.subject !== spec.subject ||
        message.to.join("\n") !== spec.to.join("\n") ||
        message.cc.join("\n") !== spec.cc.join("\n") ||
        message.bcc.join("\n") !== spec.bcc.join("\n")) {
      throw new Error("The stored forward source no longer matches its approved message.");
    }
    return {
      ...outboundSpec(message),
      ...(spec.date !== undefined ? {date: spec.date} : {}),
    };
  }
  return {
    ...spec,
    attachments: [
      materializeSourceAttachment(bytes, snapshot), ...uploads.map(gmailAttachmentInputToOutbound),
    ],
  };
}

/**
 * The email a stored send becomes. applyAction() sends exactly this, and a message waiting to be
 * sent is read back from it, so what a caller reads is what the approver is asked to send.
 *
 * `date` stands in for a `Date` header the stored message lacks. Left out, the MIME builder
 * stamps the time of the build. That is right for the email actually sent; a read-back passes
 * the submission time, so repeated reads agree with each other and with the message's timestamp.
 *
 * A draft send that carries no source snapshot takes its attachments from the Gmail draft.
 * `draft` is that draft when the caller has read it already, as applyAction() has in order to
 * check it against what was approved. Otherwise it is read here, unchecked: a read-back shows an
 * edit made in Gmail since the send was submitted, and applying the send then refuses it.
 */
export async function buildPendingOutbound(
    api: GmailApi, store: GmailStore, action: GmailSendAction | GmailDraftSendAction,
    options: {date?: string; draft?: GmailProviderDraft} = {}): Promise<GmailOutboundMessage> {
  const dated = (spec: GmailOutboundSpec): GmailOutboundSpec =>
    spec.date === undefined && options.date !== undefined ? {...spec, date: options.date} : spec;
  if (action.type === "send") {
    return api.buildOutbound(await exactSpecWithSource(
      api, store, dated(action.spec), sendSourceSnapshot(action), action.forwardFormat === "inline",
      await uploadedInputs(store, action.uploadedAttachments ?? [])));
  }
  if (action.sourceAttachment) {
    return api.buildOutbound(await exactSpecWithSource(
      api, store, dated(draftSpec(action.approved)), action.sourceAttachment,
      action.approved.source?.format === "inline",
      await uploadedInputs(store, action.approved.attachments)));
  }
  let draft = options.draft;
  if (!draft) {
    const providerId = store.drafts.getDraft(action.draftId)?.providerId;
    if (providerId) {
      const {message} = await api.getDraft(providerId);
      draft = {message, parsed: await parseSafeGmailDraft(message)};
    } else if (!action.approved.attachments.every(attachment => attachment.file)) {
      throw new Error("This draft's attachments cannot be read until the draft exists in Gmail.");
    }
  }
  // A send whose historical predecessor wrote its parts carries their exact mapping instead.
  return api.buildOutbound(dated(draftSpec(action.approved, await materializeDraftAttachments(
    store, action.exactApproved ?? action.approved, draft,
    !action.exactApproved && hasHistoricalAttachments(action)))));
}

export async function verifyReconciledSend(
    api: GmailApi, action: GmailSendAction, sent: {id: string; threadId: string},
    approvedFingerprint: string): Promise<void> {
  const provider = await api.getMessage(sent.id);
  if (provider.id !== sent.id || provider.threadId !== sent.threadId ||
      (action.threadId !== undefined && provider.threadId !== action.threadId)) {
    throw new Error(
      "A delivered Gmail message matched the approved Message-ID but not the approved thread.");
  }
  const deliveredParsed = await parseSafeGmailDraft(provider);
  if (!await matchesGmailFingerprint(provider, approvedFingerprint, deliveredParsed)) {
    throw new Error(
      "A delivered Gmail message matched the approved Message-ID but had different content.");
  }
}

export async function sentMessageFingerprint(
    raw: string, threadId: string | undefined): Promise<string> {
  const parsed = await parseSafeGmailDraft({
    id: "approved-send",
    threadId: threadId ?? "approved-send",
    internalDate: "0",
    raw,
  });
  return gmailDraftFingerprint(parsed, threadId);
}

/** Actions queued before mutations named exact messages still apply to the whole thread. */
export async function applyLegacyThreadMutation(
    api: GmailApi, threadId: string, operation: GmailMutationOperation,
    labelId: string | undefined): Promise<void> {
  const {add, remove} = mutationLabelChanges(operation, labelId);
  if (add.includes("TRASH")) await api.trashThread(threadId);
  else if (remove.includes("TRASH")) await api.untrashThread(threadId);
  else await api.modifyThread(threadId, add, remove);
}

export async function applyMessageMutation(
    api: GmailApi, store: GmailStore, actionId: number,
    action: GmailMessageMutationAction): Promise<void> {
  const labelId = action.labelId ? providerLabelId(store, action.labelId) : undefined;
  const {add, remove} = mutationLabelChanges(action.operation, labelId);
  const reconciling = store.journal.isApplying(actionId);
  let mayHaveWritten = reconciling;
  store.journal.markApplying(actionId);
  try {
    if (action.target.kind === "thread") {
      await applyLegacyThreadMutation(api, action.target.threadId, action.operation, labelId);
      return;
    }
    const ids = action.target.messageIds;
    for (let i = 0; i < ids.length; i += GMAIL_BATCH_MODIFY_MAX_IDS) {
      const chunk = ids.slice(i, i + GMAIL_BATCH_MODIFY_MAX_IDS);
      try {
        await api.batchModifyMessages(chunk, add, remove);
      } catch (error) {
        if (!(reconciling && error instanceof GoogleApiError && error.status === 404)) throw error;
        // A retry must not wedge on a message deleted since the first attempt, so modify the rest.
        const remaining = await existingMessageIds(api, chunk);
        if (remaining.length) await api.batchModifyMessages(remaining, add, remove);
      }
      mayHaveWritten = true;
    }
  } catch (error) {
    if (!mayHaveWritten && isDefinitiveWriteRejection(error)) store.journal.clearApplying(actionId);
    throw error;
  }
}

export async function existingMessageIds(api: GmailApi, ids: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const found = await Promise.all(batch.map(async id => {
      try {
        await api.getMessageMetadata(id);
        return true;
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) return false;
        throw error;
      }
    }));
    existing.push(...batch.filter((_, j) => found[j]));
  }
  return existing;
}

