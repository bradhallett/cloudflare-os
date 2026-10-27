/**
 * Draft capability for the Gmail gatekeeper: draft loading, creation, cursors, and the draft stub.
 */

import { CursorPager } from "./cursor";
import { GmailDraftCreateAction, GmailSourceAttachment, GmailUploadedAttachment, hasHistoricalAttachments } from "./gmail-action-types";
import { disposeEntryTargets } from "./gmail-cursors";
import { ApprovedDraftOutput, GmailProviderDraft, MAX_GMAIL_DRAFT_MIME_BYTES, attachmentDigest, captureUploadedAttachments, describeDraftAction, describeDraftDeletion, draftInfo, draftOutputFingerprint, draftSourceSnapshot, draftSpec, exactDraftOutput, freshDraftPrecondition, holdsDraftOutput, inlineForwardMessage, localDraftAttachments, materializeDraftAttachments, parseSafeGmailDraft, parsedDraftSnapshotToState, parsedDraftToState, pendingForwardSnapshot, providerAttachmentIdentity, rebuiltForwardAttachments, refreshLegacyDraftAttachments, validateDraftPatch, validateDraftRecipientPatch, validateDraftState } from "./gmail-drafts";
import { GmailStore, dependenciesFor, draftPending, submitAction } from "./gmail-journal";
import { GmailContext, messagesAvailableThroughRestriction } from "./gmail-list";
import { GmailDraftAttachmentState, GmailDraftResource, GmailDraftSource, GmailDraftState, applyGmailDraftPatch, gmailDraftFingerprint, newGmailLogicalId, overlayGmailDraft } from "./gmail-state";
import { GmailDraftAttachmentStub } from "./gmail-stubs";
import { validateGmailRecipientCount } from "./gmail-validate";
import { GmailApi, GmailDraftFull, GmailDraftRaw, GmailDraftRef, GmailOutboundMessage, GmailParsedDraft, MAX_GMAIL_ATTACHMENT_BYTES, enumerateGmailAttachments, newGmailMessageId, normalizeEmailRecipients } from "./google-api";
import { GoogleApiError } from "./google-response";
import { ApprovalQueueRpcTarget, RpcCursor } from "./shared-approval-queue";
import { EmailContent, GmailAttachmentInput, GmailComposeOptions, GmailDraft, GmailDraftAttachment, GmailDraftAttachmentEntry, GmailDraftEntry, GmailDraftInfo, GmailDraftPatch } from "./types";
import { sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import {validateRpc} from "capnweb-validate";
import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export function applyingDraftCreates(store: GmailStore): Array<{
  id: number;
  action: GmailDraftCreateAction;
}> {
  return store.journal.listActions().flatMap(({id, action}) =>
    action.type === "draftCreate" && store.journal.isApplying(id) ? [{id, action}] : []);
}

export function applyingDraftCreateForMessageId(
    store: GmailStore, rfcMessageId: string | undefined): {
      id: number;
      action: GmailDraftCreateAction;
    } | undefined {
  if (!rfcMessageId) return undefined;
  const matches = applyingDraftCreates(store).filter(
    ({action}) => action.draft.rfcMessageId === rfcMessageId);
  if (matches.length > 1) {
    throw new Error("Multiple uncertain Gmail draft creates have the same Message-ID.");
  }
  return matches[0];
}

export async function mapMatchingApplyingDraftCreate(
    api: GmailApi, store: GmailStore, provider: GmailDraftRaw,
    parsed?: GmailParsedDraft): Promise<GmailDraftResource | undefined> {
  const current = parsed ?? await parseSafeGmailDraft(provider.message);
  const matched = applyingDraftCreateForMessageId(store, current.messageId);
  if (!matched) return undefined;
  const create = matched.action;
  const resource = store.drafts.getDraft(create.draft.logicalId);
  if (!resource || resource.status !== "active") {
    throw new Error("The uncertain Gmail draft create no longer has an active local resource.");
  }
  if (resource.providerId && resource.providerId !== provider.id) {
    throw new Error("The uncertain Gmail draft create is already mapped to another provider draft.");
  }
  const approved = await approvedCreateOutput(api, store, create);
  const providerDraft = {message: provider.message, parsed: current};
  if (!await holdsDraftOutput(api, store, approved, providerDraft,
      await gmailDraftFingerprint(current, provider.message.threadId),
      await exactDraftOutput(api, store, approved, providerDraft))) {
    throw new Error("A discovered Gmail draft has the approved Message-ID but different content.");
  }
  const mapped = store.drafts.mapDraftToProvider(store.journal, resource.logicalId, provider.id, matched.id);
  // Listing has verified both identity and content. Persist the provider receipt so a later retry
  // can finish reconciliation without creating another draft.
  store.journal.setDraftWriteReceipt(matched.id, {
    draftId: provider.id,
    messageId: provider.message.id,
    threadId: provider.message.threadId,
  });
  return mapped;
}

/** A create's approved output; a create staged before `exactOutput` is verified historically too. */
export async function approvedCreateOutput(
    api: GmailApi, store: GmailStore, action: GmailDraftCreateAction): Promise<ApprovedDraftOutput> {
  const snapshot = draftSourceSnapshot(action);
  return {
    state: action.draft, snapshot, historical: !action.exactOutput, historicalAttachments: false,
    fingerprint: await draftOutputFingerprint(api, store, action.draft, snapshot),
  };
}

export async function ensureProviderDraft(
    ctx: GmailContext, draft: GmailDraftRef): Promise<GmailDraftResource> {
  let mapped = ctx.store.drafts.draftForProvider(draft.id);
  if (applyingDraftCreates(ctx.store).length > 0) {
    let provider: GmailDraftRaw | undefined;
    let rfcMessageId: string | undefined;
    if (draft.message?.id) {
      const metadata = await ctx.api.getMessageMetadata(draft.message.id);
      rfcMessageId = metadata.payload?.headers?.find(
        header => header.name.toLowerCase() === "message-id")?.value.trim();
    } else {
      provider = await ctx.api.getDraft(draft.id);
      rfcMessageId = (await parseSafeGmailDraft(provider.message)).messageId;
    }
    if (applyingDraftCreateForMessageId(ctx.store, rfcMessageId)) {
      provider ??= await ctx.api.getDraft(draft.id);
      const reconciled = await mapMatchingApplyingDraftCreate(ctx.api, ctx.store, provider);
      if (reconciled) return reconciled;
    }
    mapped = ctx.store.drafts.draftForProvider(draft.id);
  }
  if (mapped) return mapped;
  const resource: GmailDraftResource = {
    logicalId: draft.id,
    providerId: draft.id,
    createdAt: Date.now(),
    status: "active",
    version: 0,
  };
  ctx.store.drafts.putDraft(ctx.store.journal, resource);
  return resource;
}

/** `provider` holds the draft's exact revision when its parts were captured; `full` is the part listing otherwise. */
export type LoadedGmailDraftBase = {
  state: GmailDraftState;
  provider?: GmailProviderDraft;
  full?: GmailDraftFull;
};

export async function loadDraftBase(
    ctx: GmailContext, resource: GmailDraftResource, captureAttachments: boolean):
    Promise<LoadedGmailDraftBase | undefined> {
  if (resource.status === "rejected") throw new Error("This provisional Gmail draft was rejected.");
  if (resource.status === "deleted") throw new Error("This Gmail draft has been deleted.");
  if (resource.status === "sent") throw new Error("This Gmail draft has already been sent.");
  if (!resource.providerId) return undefined;
  if (captureAttachments) {
    const snapshot = await ctx.api.getDraftFull(resource.providerId);
    if ((snapshot.message.sizeEstimate ?? 0) > MAX_GMAIL_DRAFT_MIME_BYTES) {
      throw new Error(
        `This Gmail draft exceeds the ${MAX_GMAIL_DRAFT_MIME_BYTES}-byte safe modification limit.`);
    }
    const draft = await ctx.api.getDraft(resource.providerId);
    const parsed = await parseSafeGmailDraft(draft.message);
    return {state: await parsedDraftToState(resource.logicalId, resource, draft, parsed, ctx.selfEmail),
      provider: {message: draft.message, parsed}};
  }
  const full = await ctx.api.getDraftFull(resource.providerId);
  return {state: parsedDraftSnapshotToState(
    resource.logicalId, resource, full, await ctx.api.parseDraftSnapshot(full.message),
    ctx.selfEmail), full};
}

export async function loadSimulatedDraft(
    ctx: GmailContext, logicalId: string,
    captureAttachments = false): Promise<LoadedGmailDraftBase & {resource: GmailDraftResource}> {
  const canonicalId = ctx.store.drafts.resolveDraftId(logicalId);
  const resource = ctx.store.drafts.getDraft(canonicalId);
  if (!resource) throw new Error("Unknown Gmail draft capability.");
  const providerId = resource.providerId;
  const version = resource.version;
  let loaded: LoadedGmailDraftBase | undefined;
  try {
    loaded = await loadDraftBase(ctx, resource, captureAttachments);
  } catch (error) {
    if (!(error instanceof GoogleApiError && error.status === 404 && providerId)) throw error;
    const current = ctx.store.drafts.getDraft(canonicalId);
    if (!current || current.logicalId !== canonicalId || current.providerId !== providerId ||
        current.version !== version || current.status !== "active") {
      throw new Error(
        "The Gmail draft changed identity while it was being read. Retry it.", {cause: error});
    }
    if (hasApplyingDraftSend(ctx.store, canonicalId)) {
      throw new Error("This Gmail draft has an uncertain send outcome.", {cause: error});
    }
    current.status = "deleted";
    current.version++;
    ctx.store.drafts.putDraft(ctx.store.journal, current);
    ctx.store.drafts.clearDraftForwardSnapshot(ctx.store.journal, canonicalId);
    throw new Error("This Gmail draft has been deleted.", {cause: error});
  }
  const resolvedAfterRead = ctx.store.drafts.resolveDraftId(logicalId);
  const current = ctx.store.drafts.getDraft(resolvedAfterRead);
  if (resolvedAfterRead !== canonicalId || !current || current.logicalId !== canonicalId ||
      current.providerId !== providerId || current.version !== version ||
      current.status !== resource.status) {
    throw new Error("The Gmail draft changed identity while it was being read. Retry it.");
  }
  let state = overlayGmailDraft(
    canonicalId, loaded?.state, draftPending(ctx.store), ctx.store.journal.decisions());
  if (!state) throw new Error("This Gmail draft is pending deletion or send.");
  // Only a pending pre-upgrade update contributes attachment digests that need re-keying. An inline
  // forward's source parts are rebuilt from its retained snapshot instead.
  if (loaded?.provider && !current.forwardSnapshot && hasHistoricalDraftUpdate(ctx.store, canonicalId)) {
    state = await refreshLegacyDraftAttachments(state, loaded.provider);
  }
  return {...loaded, state, resource: current};
}

/** Whether a pending update on this draft carries pre-upgrade attachment state. */
export function hasHistoricalDraftUpdate(store: GmailStore, canonicalId: string): boolean {
  return store.journal.listActions().some(({action}) => action.type === "draftUpdate" &&
    store.drafts.resolveDraftId(action.draftId) === canonicalId && hasHistoricalAttachments(action));
}

export async function createDraftFromMessage(
    ctx: GmailContext, message: GmailOutboundMessage, options: {
      source?: GmailDraftSource;
      threadId?: string;
      sourceSnapshot?: GmailSourceAttachment;
      forwardInput?: {body?: string; options: GmailComposeOptions};
      uploads?: readonly GmailAttachmentInput[];
    } = {}): Promise<GmailDraft> {
  const {source, threadId, sourceSnapshot, forwardInput} = options;
  const logicalId = newGmailLogicalId("draft");
  let submitted = false;
  let uploaded: GmailUploadedAttachment[] = [];
  try {
    uploaded = await captureUploadedAttachments(ctx.store, options.uploads);
    const now = Date.now();
    const attachments: GmailDraftAttachmentState[] = await Promise.all(
      message.attachments.filter(attachment => !attachment.origin).map(async (attachment, index) => {
        const bytes = atob(attachment.data.replace(/\s/g, "")).length;
        return {
          key: String(index),
          info: {
            filename: attachment.filename || null,
            mimeType: attachment.contentType,
            size: bytes,
            disposition: attachment.disposition ?? null,
            ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
            readable: bytes <= MAX_GMAIL_ATTACHMENT_BYTES,
          },
          contentDigest: await attachmentDigest(attachment),
        };
      }));
    attachments.push(...uploaded);
    const state: GmailDraftState = {
      logicalId,
      from: message.from,
      replyTo: message.replyTo,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      date: new Date(now).toUTCString(),
      subject: message.subject,
      text: source?.format === "inline" ? forwardInput?.body ?? "" : message.body,
      ...(source?.format === "inline"
        ? (forwardInput?.options.html !== undefined ? {html: forwardInput.options.html} : {})
        : (message.html !== undefined ? {html: message.html} : {})),
      rfcMessageId: message.messageId,
      ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
      ...(message.references ? {references: message.references} : {}),
      ...(threadId ? {threadId} : {}),
      timestamp: now,
      ...(source ? {source} : {}),
      attachments,
      version: 0,
    };
    validateDraftState(state);
    const described = (await describeDraftAction(
      source?.kind === "reply" ? "Create a threaded reply draft."
        : source?.kind === "forward" ? "Create an inline forward draft." : "Create a draft.",
      state, message)).finish();
    const resource: GmailDraftResource = {
      logicalId, ...(source ? {source} : {}), createdAt: now, status: "active", version: 0,
      ...(source?.format === "inline" && sourceSnapshot ? {
        forwardSnapshot: sourceSnapshot,
        forwardBody: forwardInput?.body ?? "",
        ...(forwardInput?.options.html !== undefined
          ? {forwardHtml: forwardInput.options.html} : {}),
      } : {}),
    };
    ctx.store.drafts.putDraft(ctx.store.journal, resource);
    await submitAction(ctx, {
      type: "draftCreate",
      draft: state,
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      exactOutput: true,
    }, {
      title: sanitizeTitle(`Create Gmail draft: ${state.subject || "(no subject)"}`),
      ...described,
    });
    submitted = true;
    return new GmailDraftStub(ctx, logicalId);
  } finally {
    if (!submitted) {
      ctx.store.drafts.deleteDraft(ctx.store.journal, logicalId);
      ctx.store.drafts.releaseFile(ctx.store.journal, sourceSnapshot);
      for (const attachment of uploaded) ctx.store.drafts.releaseFile(ctx.store.journal, attachment.file);
    }
  }
}

export type DraftCursorRef = {logicalId: string; providerId?: string};

export function gmailDraftCursor(ctx: GmailContext): Cursor<GmailDraftEntry> {
  if (ctx.restricted) return restrictedDraftCursor(ctx);
  const emittedLogicalIds = new Set<string>();
  return new RpcCursor(new CursorPager<DraftCursorRef, OwnedGmailDraftEntry>({
    async fetchPage(pageToken) {
      const page = await ctx.api.listDrafts(20, pageToken);
      const items: DraftCursorRef[] = [];
      for (const draft of page.drafts) {
        const resource = await ensureProviderDraft(ctx, draft);
        if (emittedLogicalIds.has(resource.logicalId) ||
            items.some(item => item.logicalId === resource.logicalId)) continue;
        items.push({logicalId: resource.logicalId, providerId: draft.id});
      }
      if (!pageToken) {
        for (const resource of ctx.store.drafts.listDrafts()) {
          if (!resource.providerId && resource.status === "active" &&
              !emittedLogicalIds.has(resource.logicalId) &&
              !items.some(item => item.logicalId === resource.logicalId)) {
            items.unshift({logicalId: resource.logicalId});
          }
        }
      }
      return {items, nextPageToken: page.nextPageToken};
    },
    async buildEntries(items) {
      const entries: OwnedGmailDraftEntry[] = [];
      try {
        for (const item of items) {
          try {
            const {state} = await loadSimulatedDraft(ctx, item.logicalId);
            entries.push({info: draftInfo(state), draft: new GmailDraftStub(ctx, item.logicalId)});
          } catch (error) {
            if (!(error instanceof Error) ||
                !/pending deletion|already been sent|has been deleted|was rejected|uncertain send outcome/
                  .test(error.message)) {
              throw error;
            }
          }
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.draft);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail drafts`,
        description: "Fetch the next page with pending draft changes overlaid.",
      });
      for (const entry of entries) emittedLogicalIds.add(entry.info.id);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.draft),
  }), ctx.approvalQueue);
}

export function restrictedDraftCursor(ctx: GmailContext): Cursor<GmailDraftEntry> {
  const resources = ctx.store.drafts.listDrafts().filter(resource => resource.source &&
    resource.status === "active");
  return new RpcCursor(new CursorPager<GmailDraftResource, OwnedGmailDraftEntry>({
    async fetchPage(pageToken) {
      const offset = pageToken ? Number(pageToken) : 0;
      const items = resources.slice(offset, offset + 20);
      const next = offset + items.length;
      return {items, ...(next < resources.length ? {nextPageToken: String(next)} : {})};
    },
    async buildEntries(items) {
      const entries: OwnedGmailDraftEntry[] = [];
      try {
        const sourceIds = new Set(items.flatMap(resource =>
          resource.source ? [resource.source.messageId] : []));
        const available = await messagesAvailableThroughRestriction(ctx, sourceIds);
        for (const resource of items) {
          if (!resource.source || !available.has(resource.source.messageId)) continue;
          try {
            const {state} = await loadSimulatedDraft(ctx, resource.logicalId);
            entries.push({
              info: draftInfo(state),
              draft: new GmailDraftStub(ctx, resource.logicalId),
            });
          } catch (error) {
            if (!(error instanceof Error) ||
                !/pending deletion|already been sent|has been deleted|was rejected|uncertain send outcome/
                  .test(error.message)) {
              throw error;
            }
          }
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.draft);
        throw error;
      }
    },
    authorize: entries => ctx.approvalQueue.authorizeObservation({
      title: `Read ${entries.length} restricted Gmail drafts`,
      description: "Read only same-binding drafts whose immutable source message remains admitted.",
    }),
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.draft),
  }), ctx.approvalQueue);
}

@validateRpc()
export class GmailDraftStub extends ApprovalQueueRpcTarget implements GmailDraft {
  #ctx: GmailContext;
  #logicalId: string;

  constructor(ctx: GmailContext, logicalId: string) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#logicalId = logicalId;
  }

  async getMetadata(): Promise<GmailDraftInfo> {
    const {state} = await loadSimulatedDraft(this.#ctx, this.#logicalId);
    const info = draftInfo(state);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Read Gmail draft: ${state.subject || "(no subject)"}`),
      description: "Read the draft's simulated identifiers, recipients, subject, and timestamp.",
    });
    return info;
  }

  async getContent(): Promise<EmailContent> {
    const {state} = await loadSimulatedDraft(this.#ctx, this.#logicalId);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, state.logicalId)
      : undefined;
    const message = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, state, sourceSnapshot)
      : undefined;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail draft content",
      description: "Read the draft's simulated plain-text and HTML bodies.",
    });
    return {
      text: message?.body ?? state.text,
      ...((message?.html ?? state.html) !== undefined
        ? {html: message?.html ?? state.html} : {}),
    };
  }

  async attachments(): Promise<GmailDraftAttachmentEntry[]> {
    const {state, resource, full} = await loadSimulatedDraft(this.#ctx, this.#logicalId);
    const logicalId = resource.logicalId;
    const validateVersion = this.#versionValidator(logicalId);
    // A pre-upgrade update recorded the old parser's normalized sizes and types; the provider
    // part's own metadata describes the bytes a read returns.
    const historical = hasHistoricalDraftUpdate(this.#ctx.store, logicalId);
    // Bare indices name the revision an overlay was captured from, which a later write replaces.
    const identified = full !== undefined && resource.attachmentMessageId === full.message.id;
    const source = state.source?.kind === "forward"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId) : undefined;
    if (!full && state.source?.kind === "forward" && state.attachments.length > 0 && !source) {
      throw new Error(
        "This pending forward draft uses an obsolete source snapshot. Reject and resubmit it.");
    }
    const providerSnapshots = full
      ? enumerateGmailAttachments(full.message.id, full.message.payload) : [];
    const providerParts = new Map(full ? providerSnapshots.map((snapshot, index) =>
      [providerAttachmentIdentity(resource, full.message.id, index).key, snapshot] as const) : []);
    const listed = source && state.source?.format === "inline"
      ? await rebuiltForwardAttachments(state.attachments,
        await inlineForwardMessage(this.#ctx.api, this.#ctx.store, state, source))
      : state.attachments.map(attachment => ({attachment, part: undefined}));
    const entries = listed.map(({attachment, part}) => {
      // Overlays queued before provider-qualified keys name parts by bare index. Only reads take
      // this path: removing one edits the overlay, and applying it re-checks the provider snapshot.
      const snapshot = part ? undefined : providerParts.get(attachment.key) ??
        (!identified && /^\d+$/.test(attachment.key) ? providerSnapshots[Number(attachment.key)] : undefined);
      const read = async (): Promise<ArrayBuffer> => {
        if (part) {
          return Uint8Array.from(atob(part.data.replace(/\s/g, "")), char => char.charCodeAt(0))
            .buffer as ArrayBuffer;
        }
        if (snapshot) return this.#ctx.api.getAttachmentContent(snapshot);
        if (source) return (await this.#ctx.store.drafts.readFile(source)).buffer as ArrayBuffer;
        throw new Error("This draft attachment is no longer available.");
      };
      const current = historical && snapshot ? {...attachment, info: {
        ...attachment.info,
        mimeType: snapshot.info.mimeType, size: snapshot.info.size, readable: snapshot.info.readable,
      }} : attachment;
      return {
        info: current.info,
        attachment: this.#attachmentCapability(logicalId, current, read),
      };
    });
    try {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `List ${entries.length} Gmail draft attachments`,
        description: "Read attachment metadata from this exact simulated draft revision.",
      });
      validateVersion();
      return entries;
    } catch (error) {
      disposeEntryTargets(entries, entry => entry.attachment);
      throw error;
    }
  }

  #versionValidator(logicalId: string): () => void {
    const capturedVersion = this.#ctx.store.drafts.getDraft(logicalId)?.version;
    return () => {
      const resolved = this.#ctx.store.drafts.resolveDraftId(logicalId);
      const current = this.#ctx.store.drafts.getDraft(resolved);
      if (resolved !== logicalId || current?.status !== "active" ||
          current.version !== capturedVersion) {
        throw new Error("This draft attachment capability became stale after the draft changed.");
      }
    };
  }

  // A provider or forward-source part is bound to the draft revision it was listed from. An
  // uploaded file stays bound to itself across edits, until it leaves the draft's local
  // attachment list; its bytes come from this binding, so checking Gmail would add nothing.
  #attachmentCapability(
      logicalId: string, attachment: GmailDraftAttachmentState,
      readPart: () => Promise<ArrayBuffer> = () =>
        Promise.reject(new Error("This draft attachment is no longer available."))):
      GmailDraftAttachmentStub {
    const {file} = attachment;
    const read = file
      ? async () => (await this.#ctx.store.drafts.readFile(file)).buffer as ArrayBuffer
      : readPart;
    const validate = file ? () => {
      const current = localDraftAttachments(this.#ctx.store, logicalId)
        ?.find(part => part.key === attachment.key);
      if (current?.file?.handle !== file.handle) {
        throw new Error("This draft attachment capability became stale after the attachment changed.");
      }
    } : this.#versionValidator(logicalId);
    return new GmailDraftAttachmentStub(this.#ctx, attachment.info, read, validate, async () => {
      validate();
      await this.#update({}, state => {
        const target = state.attachments.find(part => part.key === attachment.key);
        if (!target) throw new Error("This draft attachment is no longer available.");
        if (state.source?.kind === "forward" && !target.file) {
          throw new Error("A forward draft's source attachments cannot be removed.");
        }
        return state.attachments.filter(part => part.key !== attachment.key);
      });
    });
  }

  async addAttachment(input: GmailAttachmentInput): Promise<GmailDraftAttachment> {
    const [attachment] = await captureUploadedAttachments(this.#ctx.store, [input]);
    try {
      await this.#update({}, state => [...state.attachments, attachment]);
    } catch (error) {
      this.#ctx.store.drafts.releaseFile(this.#ctx.store.journal, attachment.file);
      throw error;
    }
    return this.#attachmentCapability(this.#ctx.store.drafts.resolveDraftId(this.#logicalId), attachment);
  }

  async update(patch: GmailDraftPatch): Promise<void> {
    await this.#update(patch);
  }

  async #update(
      patch: GmailDraftPatch,
      replaceAttachments?: (state: GmailDraftState) => GmailDraftAttachmentState[]): Promise<void> {
    validateDraftPatch(patch);
    const loaded = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const {state, resource} = loaded;
    const logicalId = resource.logicalId;
    const recipientPatch = {
      ...(patch.to !== undefined ? {to: normalizeEmailRecipients(patch.to)} : {}),
      ...(patch.cc !== undefined ? {cc: normalizeEmailRecipients(patch.cc)} : {}),
      ...(patch.bcc !== undefined ? {bcc: normalizeEmailRecipients(patch.bcc)} : {}),
    };
    validateDraftRecipientPatch(state, recipientPatch);
    const patched = applyGmailDraftPatch(state, {...patch, ...recipientPatch});
    if (replaceAttachments) patched.attachments = replaceAttachments(state);
    const revision = Math.max(patched.version, resource.version + 1);
    // Updating raw MIME necessarily writes Date and Message-ID headers. Persist them in the
    // approved state so retries and later dependent actions never generate different values.
    const after = {
      ...patched,
      date: patched.date ?? new Date().toUTCString(),
      version: revision,
      ...(!/^<[^<>\s@]+@[^<>\s@]+>$/.test(patched.rfcMessageId ?? "")
        ? {rfcMessageId: newGmailMessageId()} : {}),
    };
    validateDraftState(after);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedBefore = await freshDraftPrecondition(this.#ctx, loaded, sourceSnapshot);
    const descriptionMessage = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, after, sourceSnapshot)
      : replaceAttachments ? this.#ctx.api.buildOutbound(draftSpec(after,
        await materializeDraftAttachments(this.#ctx.store, after, loaded.provider)))
      : undefined;
    const described = (await describeDraftAction(
      "Replace this draft with the message below.", after, descriptionMessage))
      .inline("Draft ID", logicalId)
      .finish();
    const previousVersion = resource.version;
    const resolved = this.#ctx.store.drafts.resolveDraftId(logicalId);
    const current = this.#ctx.store.drafts.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== previousVersion) {
      throw new Error("The Gmail draft changed while this update was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version = after.version;
    this.#ctx.store.drafts.putDraft(this.#ctx.store.journal, current);
    await submitAction(this.#ctx, {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
    }, {
      title: sanitizeTitle(`Update Gmail draft: ${after.subject || "(no subject)"}`),
      ...described,
    }, () => this.#ctx.store.drafts.restoreDraftVersion(this.#ctx.store.journal, 
      logicalId, after.version, previousVersion, dependencies));
  }

  async delete(): Promise<void> {
    const loaded = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const {state, resource} = loaded;
    const logicalId = resource.logicalId;
    const version = resource.version;
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedSnapshot = await freshDraftPrecondition(this.#ctx, loaded, sourceSnapshot);
    const resolved = this.#ctx.store.drafts.resolveDraftId(logicalId);
    const current = this.#ctx.store.drafts.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== version) {
      throw new Error("The Gmail draft changed while deletion was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version++;
    const submittedVersion = current.version;
    this.#ctx.store.drafts.putDraft(this.#ctx.store.journal, current);
    await submitAction(this.#ctx, {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
    }, {
      title: sanitizeTitle(`Delete Gmail draft: ${state.subject || "(no subject)"}`),
      ...describeDraftDeletion(state),
    }, () => this.#ctx.store.drafts.restoreDraftVersion(this.#ctx.store.journal, 
      logicalId, submittedVersion, version, dependencies));
  }

  async send(): Promise<string> {
    const loaded = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const {state, resource} = loaded;
    const logicalId = resource.logicalId;
    const version = resource.version;
    const recipients = [...state.to, ...state.cc, ...state.bcc];
    validateGmailRecipientCount(recipients);
    const importedWithNonTextContent = resource.providerId === resource.logicalId &&
      (state.html !== undefined || state.attachments.length > 0);
    if (state.text.length === 0 && !importedWithNonTextContent && state.source?.kind !== "reply" &&
        !(state.source?.kind === "forward" && state.source.format === "inline")) {
      throw new Error("A Gmail draft must contain a plain-text body before it can be sent.");
    }
    validateDraftState(state);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedSnapshot = await freshDraftPrecondition(this.#ctx, loaded, sourceSnapshot);
    // A send action always owns a fresh identity. Imported drafts can reuse a Message-ID from an
    // already-delivered message, which would make ambiguous-send reconciliation unsafe.
    const messageId = newGmailMessageId();
    const approved = {...state, rfcMessageId: messageId};
    const approvedMessage = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, approved, sourceSnapshot)
      : undefined;
    const described = (await describeDraftAction(
      "Send this exact draft snapshot.", approved, approvedMessage))
      .inline("Draft ID", logicalId)
      .finish();
    const resolved = this.#ctx.store.drafts.resolveDraftId(logicalId);
    const current = this.#ctx.store.drafts.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== version) {
      throw new Error("The Gmail draft changed while send was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version++;
    const submittedVersion = current.version;
    this.#ctx.store.drafts.putDraft(this.#ctx.store.journal, current);
    await submitAction(this.#ctx, {
      type: "draftSend",
      draftId: logicalId,
      approved,
      expectedSnapshot,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      messageId,
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
      submittedAt: Date.now(),
    }, {
      title: sanitizeTitle(`Send Gmail draft: ${state.subject || "(no subject)"}`),
      ...described,
    }, () => this.#ctx.store.drafts.restoreDraftVersion(this.#ctx.store.journal, 
      logicalId, submittedVersion, version, dependencies));
    return messageId;
  }
}

export type OwnedGmailDraftEntry = Omit<GmailDraftEntry, "draft"> & {draft: GmailDraftStub};

export function hasApplyingDraftSend(store: GmailStore, logicalId: string): boolean {
  return store.journal.listActions().some(({id, action}) => action.type === "draftSend" &&
    store.journal.isApplying(id) && store.drafts.resolveDraftId(action.draftId) === logicalId);
}
