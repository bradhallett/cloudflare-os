/**
 * Pure draft-domain logic for the Gmail gatekeeper: MIME handling, fingerprints, output computation, and validation.
 */

import { GmailDraftCreateAction, GmailDraftProviderBaseline, GmailDraftWriteReceipt, GmailSendAction, GmailSourceAttachment, GmailUploadedAttachment, actionResourceId, actionSourceAttachment, isDraftAction } from "./gmail-action-types";
import { exactSpecWithSource } from "./gmail-apply";
import { LoadedGmailDraftBase } from "./gmail-draft-stubs";
import { GmailStore, dependenciesFor, draftPending } from "./gmail-journal";
import { GmailContext } from "./gmail-list";
import { GmailDraftAttachmentState, GmailDraftResource, GmailDraftState, GmailForwardSnapshotReference, gmailDraftFingerprint, gmailDraftStateFingerprint, isVersionedGmailFingerprint, unversionedGmailFingerprint } from "./gmail-state";
import { validateGmailAddress, validateGmailBody, validateGmailBodyAlternatives, validateGmailRecipientMaximum, validateGmailSubject, validateOutboundFields } from "./gmail-validate";
import { GmailApi, GmailDraftFull, GmailDraftRaw, GmailMessageRaw, GmailNormalizedRecipients, GmailOutboundAttachment, GmailOutboundMessage, GmailOutboundSpec, GmailParsedDraft, GmailParsedDraftSnapshot, MAX_GMAIL_ATTACHMENT_BYTES, MAX_GMAIL_FORWARD_SOURCE_BYTES, base64UrlDecodedByteLength, decodeBase64UrlToBytes, emailRecipientToAddress, gmailAttachmentInputToOutbound, newGmailMessageId, normalizeContentId, normalizeGmailAttachmentInput, normalizeMessageIdHeader, normalizeReferencesHeader, normalizeTextBody, parseGmailDraft, parseLegacyGmailDraft } from "./google-api";
import { GoogleApiError } from "./google-response";
import { GmailAttachmentInfo, GmailAttachmentInput, GmailComposeOptions, GmailDraftInfo, GmailDraftPatch } from "./types";
import { ActionDescriptionBuilder, RenderedDescription, buildDescription } from "@gadgets/gatekeeper-kit/action-description";

/** Keep draft inspection aligned with the maximum inline-forward message size. */
export const MAX_GMAIL_DRAFT_MIME_BYTES = MAX_GMAIL_FORWARD_SOURCE_BYTES;

export function requireCurrentSourceSnapshot(
    snapshot: GmailSourceAttachment | undefined, sourceMessageId: string | undefined):
    GmailSourceAttachment {
  if (!snapshot || typeof (snapshot as Partial<GmailSourceAttachment>).handle !== "string" ||
      !sourceMessageId || snapshot.messageId !== sourceMessageId) {
    throw new Error(
      "This pending forward uses an obsolete source snapshot. Reject and resubmit it.");
  }
  return snapshot;
}

export function sendSourceSnapshot(action: GmailSendAction): GmailSourceAttachment | undefined {
  if (action.mode === "forward") {
    return requireCurrentSourceSnapshot(action.sourceAttachment, action.sourceMessageId);
  }
  if (action.sourceAttachment) {
    throw new Error("This pending Gmail send has inconsistent source snapshot metadata.");
  }
  return undefined;
}

export function draftSourceSnapshot(action: GmailDraftCreateAction): GmailSourceAttachment | undefined {
  if (action.draft.source?.kind === "forward") {
    const snapshot = requireCurrentSourceSnapshot(
      action.sourceAttachment, action.draft.source.messageId);
    if (action.draft.source.format === "inline") return snapshot;
    const attachment = action.draft.attachments[0];
    if (action.draft.attachments.length !== 1 || !attachment ||
        attachment.contentDigest !== snapshot.digest || attachment.info.size !== snapshot.size ||
        attachment.info.filename !== "forwarded-message.eml" ||
        attachment.info.mimeType !== "message/rfc822" ||
        attachment.info.disposition !== "attachment" || attachment.info.contentId !== undefined) {
      throw new Error(
        "This pending forward draft has inconsistent source snapshot metadata. " +
        "Reject and resubmit it.");
    }
    return snapshot;
  }
  if (action.sourceAttachment) {
    throw new Error("This pending Gmail draft has inconsistent source snapshot metadata.");
  }
  return undefined;
}

/** Every header and body the approver reads, as the fields `buildEncodedEmail` writes them from. */
export type DescribedMessage = {
  from: string;
  replyTo: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId?: string;
  date?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  text: string;
  html?: string;
};

/**
 * The value `buildEncodedEmail` writes for `value`, or `value` itself when the builder refuses it;
 * such an action fails when applied, before anything is sent.
 */
export function asSent(value: string, normalize: (value: string) => string): string {
  try {
    return normalize(value);
  } catch {
    return value;
  }
}

export function referencesAsSent(references: string): string[] {
  try {
    return normalizeReferencesHeader(references);
  } catch {
    return [references];
  }
}

/**
 * Every header the message is written with, its thread placement, and both bodies, exactly as
 * they will be sent. The identifiers are shown too: a reply's In-Reply-To and References name the
 * message it answers, and every recipient receives them.
 */
export function describeMessage(intro: string, message: DescribedMessage): ActionDescriptionBuilder {
  const builder = buildDescription(intro).inline("From", message.from);
  if (message.replyTo.length) builder.list("Reply-To", message.replyTo);
  if (message.to.length) builder.list("To", message.to);
  if (message.cc.length) builder.list("Cc", message.cc);
  if (message.bcc.length) builder.list("Bcc", message.bcc);
  builder.inline("Subject", message.subject);
  if (message.messageId !== undefined) {
    builder.inline("Message-ID", asSent(message.messageId, normalizeMessageIdHeader));
  } else {
    builder.prose("A new Message-ID is generated when this action is applied.");
  }
  if (message.date !== undefined) {
    builder.inline("Date", message.date);
  } else {
    builder.prose("The Date header is set to the time this action is applied.");
  }
  if (message.inReplyTo) {
    builder.inline("In-Reply-To", asSent(message.inReplyTo, normalizeMessageIdHeader));
  }
  if (message.references) builder.list("References", referencesAsSent(message.references));
  if (message.threadId !== undefined) builder.inline("Thread ID", message.threadId);
  builder.verbatim("Plain text", asSent(message.text, normalizeTextBody));
  if (message.html !== undefined) {
    builder.verbatim("HTML", asSent(message.html, normalizeTextBody), "html");
  }
  return builder;
}

/**
 * Attachments are described by exact metadata and digest. Workspace-supplied bytes leave the
 * description incomplete; files copied unchanged from this provider count as shown.
 */
export function describeAttachment(
    builder: ActionDescriptionBuilder, label: string, attachment: {
      filename: string | null; contentType: string; size: number; digest: string | undefined;
      disposition: string | null | undefined; contentId: string | undefined;
      origin?: "provider" | "agent";
    }): void {
  builder.file(label, {
    name: attachment.filename || "(unnamed)",
    mediaType: attachment.contentType,
    size: attachment.size,
    ...(attachment.digest ? {sha256: attachment.digest} : {}),
    origin: attachment.origin ?? "provider",
  });
  builder.inline(`${label} disposition`,
    attachment.disposition === "inline" ? "inline" : "attachment");
  if (attachment.contentId) {
    builder.inline(`${label} Content-ID`, asSent(attachment.contentId, normalizeContentId));
  }
}

export async function describeOutboundAttachments(
    builder: ActionDescriptionBuilder, attachments: GmailOutboundAttachment[]): Promise<void> {
  for (const [index, attachment] of attachments.entries()) {
    describeAttachment(builder, `Attachment ${index + 1}`, {
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: atob(attachment.data.replace(/\s/g, "")).length,
      digest: await attachmentDigest(attachment),
      disposition: attachment.disposition,
      contentId: attachment.contentId,
      ...(attachment.origin ? {origin: attachment.origin} : {}),
    });
  }
}

/**
 * Every field the message carries, exactly as it will be sent. `threadId` is the Gmail thread the
 * send is placed in, when it has one.
 */
export async function describeOutboundMessage(
    intro: string, message: GmailOutboundMessage,
    threadId?: string): Promise<ActionDescriptionBuilder> {
  const builder = describeMessage(intro, {
    from: message.from,
    replyTo: message.replyTo,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    messageId: message.messageId,
    ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
    ...(message.references ? {references: message.references} : {}),
    ...(threadId !== undefined ? {threadId} : {}),
    text: message.body,
    ...(message.html !== undefined ? {html: message.html} : {}),
  });
  await describeOutboundAttachments(builder, message.attachments);
  return builder;
}

export function outboundSpec(message: GmailOutboundMessage, attachments = message.attachments): GmailOutboundSpec {
  return {
    from: message.from,
    replyTo: message.replyTo,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.body,
    ...(message.html !== undefined ? {html: message.html} : {}),
    messageId: message.messageId,
    ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
    ...(message.references ? {references: message.references} : {}),
    attachments,
  };
}

export function inlineForwardSpec(
    message: GmailOutboundMessage, body: string | undefined,
    options: GmailComposeOptions): GmailOutboundSpec {
  return {
    ...outboundSpec(message, []),
    text: body ?? "",
    ...(options.html !== undefined ? {html: options.html} : {}),
  };
}

export function validateForwardFields(
    message: GmailOutboundMessage, body: string | undefined,
    options: GmailComposeOptions): void {
  validateOutboundFields(message, message.subject, body ?? "", options.html);
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function parseSafeGmailDraft(message: GmailMessageRaw): Promise<GmailParsedDraft> {
  if (base64UrlDecodedByteLength(message.raw) > MAX_GMAIL_DRAFT_MIME_BYTES) {
    throw new Error(
      `This Gmail draft exceeds the ${MAX_GMAIL_DRAFT_MIME_BYTES}-byte safe modification limit.`);
  }
  return parseGmailDraft(message);
}

/**
 * Unprefixed persisted hashes used the old parser's calendar and encoded-part canonicalization.
 * Never try that weaker representation for a versioned, byte-exact precondition.
 */
export async function matchesGmailFingerprint(
    message: GmailMessageRaw, expected: string, parsed: GmailParsedDraft): Promise<boolean> {
  if (isVersionedGmailFingerprint(expected)) {
    return await gmailDraftFingerprint(parsed, message.threadId) === expected;
  }
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const legacy = await parseLegacyGmailDraft(message);
  return unversionedGmailFingerprint(await gmailDraftFingerprint(legacy, message.threadId)) === expected;
}

export async function readDraftProviderBaseline(
    api: GmailApi, store: GmailStore, actionId: number,
    receipt: GmailDraftWriteReceipt, approved: ApprovedDraftOutput): Promise<GmailDraftProviderBaseline> {
  let current: GmailDraftRaw;
  try {
    current = await api.getDraft(receipt.draftId);
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      store.journal.markDraftWriteMissing(actionId, receipt);
    }
    throw error;
  }
  if (current.id !== receipt.draftId) {
    throw new Error(
      "The Gmail draft revision changed before its provider-normalized state could be recorded.");
  }
  const parsed = await parseSafeGmailDraft(current.message);
  const fingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
  const provider = {message: current.message, parsed};
  const {exactState, ...output} = await exactDraftOutput(api, store, approved, provider);
  const revised = current.message.id !== receipt.messageId;
  const expectedThreadId = receipt.threadId ?? approved.state.threadId;
  if (revised && (!expectedThreadId || current.message.threadId !== expectedThreadId)) {
    throw new Error(
      "The Gmail draft revision changed before its provider-normalized state could be recorded.");
  }
  // Only an unverified receipt or a later revision needs proof that Gmail holds this write.
  if ((receipt.unverified || revised) &&
      !await holdsDraftOutput(api, store, approved, provider, fingerprint, {exactState, ...output})) {
    throw new Error(
      "The Gmail draft revision changed before its provider-normalized state could be recorded.");
  }
  return {
    draftId: current.id,
    messageId: current.message.id,
    threadId: current.message.threadId,
    fingerprint,
    ...output,
    appliedAttachments: await captureDraftAttachmentIdentities(
      exactState.attachments, parsed, current.message.id),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** Capture each upload's exact bytes. On failure, releases whatever this call captured. */
export async function captureUploadedAttachments(
    store: GmailStore, inputs: readonly GmailAttachmentInput[] = []):
    Promise<GmailUploadedAttachment[]> {
  const captured: GmailUploadedAttachment[] = [];
  try {
    for (const input of inputs) {
      const {filename, mimeType, content} = normalizeGmailAttachmentInput(input);
      const file = await store.drafts.captureFile(new Uint8Array(content));
      captured.push({
        key: `upload-${file.handle}`,
        info: {filename, mimeType, size: file.size, disposition: "attachment", readable: true},
        contentDigest: file.digest,
        file,
      });
    }
    return captured;
  } catch (error) {
    for (const attachment of captured) store.drafts.releaseFile(store.journal, attachment.file);
    throw error;
  }
}

/** Read an uploaded file back as the input it was captured from. */
export async function uploadedInput(
    store: GmailStore, info: GmailAttachmentInfo,
    file: GmailForwardSnapshotReference): Promise<GmailAttachmentInput> {
  const bytes = await store.drafts.readFile(file);
  return {filename: info.filename ?? "", mimeType: info.mimeType, content: bytes.buffer as ArrayBuffer};
}

/** The uploaded files among `attachments`, in order, read back as inputs. */
export function uploadedInputs(
    store: GmailStore, attachments: readonly GmailDraftAttachmentState[]):
    Promise<GmailAttachmentInput[]> {
  return Promise.all(attachments.flatMap(({info, file}) =>
    file ? [uploadedInput(store, info, file)] : []));
}

/** A provider draft revision and its byte-exact parse. */
export type GmailProviderDraft = {message: GmailMessageRaw; parsed: GmailParsedDraft};

/**
 * A draft's non-upload attachments in state order, each matched exactly, once, against the parts
 * the provider draft currently holds. With `legacy`, historical digests may also match through
 * the legacy parse of the same parts.
 */
export async function correlateDraftAttachments(
    attachments: readonly GmailDraftAttachmentState[], provider: GmailProviderDraft | undefined,
    legacy: boolean): Promise<Array<{part: GmailOutboundAttachment; digest: string} | undefined>> {
  const parts = provider?.parsed.attachments ?? [];
  const digests = await Promise.all(parts.map(attachmentDigest));
  let legacyParts: GmailOutboundAttachment[] | undefined;
  let legacyDigests: string[] | undefined;
  const used = new Set<number>();
  const matches: Array<{part: GmailOutboundAttachment; digest: string} | undefined> = [];
  for (const attachment of attachments) {
    if (attachment.file) {
      matches.push(undefined);
      continue;
    }
    let index = parts.findIndex((part, candidate) => !used.has(candidate) &&
      matchesDraftAttachment(attachment, part, digests[candidate]));
    if (index < 0 && provider && legacy) {
      legacyParts ??= (await parseLegacyGmailDraft(provider.message)).attachments;
      legacyDigests ??= await Promise.all(legacyParts.map(attachmentDigest));
      index = legacyParts.findIndex((part, candidate) => !used.has(candidate) &&
        matchesDraftAttachment(attachment, part, legacyDigests![candidate]));
    }
    if (index < 0 || !parts[index]) {
      throw new Error("This draft's attachment no longer matches its approved snapshot.");
    }
    used.add(index);
    matches.push({part: parts[index], digest: digests[index]});
  }
  return matches;
}

/**
 * Re-key historical attachment state, which matches only through the legacy parse, to the
 * provider's exact parts. Never call it for byte-exact state: it would adopt whatever bytes the
 * provider now holds that the legacy parse cannot tell apart.
 */
export async function refreshLegacyDraftAttachments(
    state: GmailDraftState, provider: GmailProviderDraft): Promise<GmailDraftState> {
  const matches = await correlateDraftAttachments(state.attachments, provider, true);
  let changed = false;
  const attachments = state.attachments.map((attachment, index) => {
    const match = matches[index];
    if (!match || (matchesDraftAttachment(attachment, match.part, match.digest) &&
        attachment.info.disposition === (match.part.disposition ?? null))) return attachment;
    changed = true;
    return {
      ...attachment,
      contentDigest: match.digest,
      info: {
        ...attachment.info,
        mimeType: match.part.contentType,
        disposition: match.part.disposition ?? null,
        size: atob(match.part.data.replace(/\s/g, "")).length,
      },
    };
  });
  return changed ? {...state, attachments} : state;
}

/**
 * A draft's attachments in state order: uploads from their retained bytes, every other part from
 * the provider draft, matched through the legacy parse only for historical attachment state.
 */
export async function materializeDraftAttachments(
    store: GmailStore, state: GmailDraftState,
    provider?: GmailProviderDraft, legacy = false): Promise<GmailOutboundAttachment[]> {
  const matches = await correlateDraftAttachments(state.attachments, provider, legacy);
  return Promise.all(state.attachments.map(async (attachment, index) => attachment.file
    ? gmailAttachmentInputToOutbound(await uploadedInput(store, attachment.info, attachment.file))
    : matches[index]!.part));
}

/** A draft write's approved state, its inline-forward snapshot, and their output fingerprint. */
export type ApprovedDraftOutput = {
  state: GmailDraftState;
  snapshot: GmailSourceAttachment | undefined;
  fingerprint: string;
  /** Staged before fingerprints were versioned, so its write may have come from the old MIME builder. */
  historical: boolean;
  /** Its attachment digests predate byte-exact parsing; see `hasHistoricalAttachments`. */
  historicalAttachments: boolean;
  /** The state already re-keyed to the provider's exact parts, when recorded before the write. */
  exactState?: GmailDraftState;
};

/**
 * The approved output as the provider draft holds it: `exactState` re-keys historical attachment
 * digests to the provider's exact parts, and `legacyOutputFingerprint` is the precondition a
 * pre-upgrade successor recorded. Byte-exact attachment state is never re-keyed, and the
 * historical output is rebuilt only for a historical write or a pre-upgrade successor.
 */
export async function exactDraftOutput(
    api: GmailApi, store: GmailStore, approved: ApprovedDraftOutput, provider?: GmailProviderDraft) {
  // A forward's source parts are written from its retained snapshot, not matched to the provider.
  const exactState = approved.exactState ??
    (provider && approved.historicalAttachments && !approved.snapshot
      ? await refreshLegacyDraftAttachments(approved.state, provider) : approved.state);
  const historical = approved.historical ||
    hasUnversionedDraftAction(store, store.drafts.resolveDraftId(approved.state.logicalId));
  return {
    exactState,
    outputFingerprint: exactState === approved.state ? approved.fingerprint
      : await draftOutputFingerprint(api, store, exactState, approved.snapshot),
    ...(historical ? {legacyOutputFingerprint: await draftOutputFingerprint(
      api, store, approved.state, approved.snapshot, true)} : {}),
  };
}

/** Whether a pending action on this draft was staged under an unprefixed precondition. */
export function hasUnversionedDraftAction(store: GmailStore, canonicalId: string): boolean {
  return store.journal.listActions().some(({action}) =>
    (action.type === "draftUpdate" || action.type === "draftDelete" || action.type === "draftSend") &&
    store.drafts.resolveDraftId(action.draftId) === canonicalId && !isVersionedGmailFingerprint(
      action.type === "draftUpdate" ? action.expectedBefore : action.expectedSnapshot));
}

/**
 * Whether the provider revision, whose byte-exact fingerprint is `fingerprint`, holds the approved
 * write's output. A state fingerprint keeps the state's attachment order, but the writer emits
 * inline parts first, so a mismatch is checked against the MIME the write emits. The old MIME
 * builder rewrote calendar and encoded parts, so a historical write is recognized by its
 * historical fingerprint.
 */
export async function holdsDraftOutput(
    api: GmailApi, store: GmailStore, approved: ApprovedDraftOutput, provider: GmailProviderDraft,
    fingerprint: string,
    output: {exactState: GmailDraftState; outputFingerprint: string; legacyOutputFingerprint?: string}):
    Promise<boolean> {
  if (fingerprint === output.outputFingerprint) return true;
  const emitted = await draftWriteMessage(api, store, output.exactState, approved.snapshot, provider);
  const parsed = await parseGmailDraft({
    id: "draft-write", threadId: output.exactState.threadId ?? "draft-write", internalDate: "0",
    raw: emitted.raw,
  });
  return fingerprint === await gmailDraftFingerprint(parsed, output.exactState.threadId) ||
    (approved.historical && output.legacyOutputFingerprint !== undefined &&
      await matchesGmailFingerprint(provider.message, output.legacyOutputFingerprint, provider.parsed));
}

/** The MIME a draft create or update writes for `state`. */
export async function draftWriteMessage(
    api: GmailApi, store: GmailStore, state: GmailDraftState,
    snapshot: GmailSourceAttachment | undefined, provider?: GmailProviderDraft):
    Promise<GmailOutboundMessage> {
  return api.buildOutbound(snapshot
    ? await exactSpecWithSource(api, store, draftSpec(state), snapshot,
      state.source?.format === "inline", await uploadedInputs(store, state.attachments))
    : draftSpec(state, await materializeDraftAttachments(store, state, provider)));
}

export async function captureSourceAttachment(
    store: GmailStore, source: GmailMessageRaw,
    message: GmailOutboundMessage): Promise<GmailSourceAttachment> {
  const bytes = decodeBase64UrlToBytes(source.raw);
  const snapshot = await store.drafts.captureFile(bytes);
  const originals = message.attachments.filter(attachment => !attachment.origin).length;
  return {
    ...snapshot,
    messageId: source.id,
    description: originals > 0
      ? `Inline forward includes ${originals} original attachment(s).`
      : "Inline forward includes the original message body.",
  };
}

export function materializeSourceAttachment(
    bytes: Uint8Array, snapshot: GmailSourceAttachment): GmailOutboundAttachment {
  if (bytes.byteLength !== snapshot.size || bytes.byteLength > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
    throw new Error("The stored forward source no longer matches its approved attachment snapshot.");
  }
  return {
    filename: "forwarded-message.eml",
    contentType: snapshot.contentType ?? "message/rfc822",
    data: bytesToBase64(bytes),
    disposition: "attachment",
    description: snapshot.description,
  };
}

export function validateDraftState(draft: GmailDraftState): void {
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  validateGmailRecipientMaximum(recipients);
  for (const recipient of recipients) validateGmailAddress(recipient);
  validateGmailSubject(draft.subject);
  validateGmailBodyAlternatives(draft.text, draft.html);
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > 96 * 1024) {
    throw new Error("This Gmail draft is too large to stage safely for approval.");
  }
}

export function validateDraftPatch(patch: GmailDraftPatch): void {
  if (patch.text !== undefined) validateGmailBody(patch.text);
  if (patch.html !== undefined && patch.html !== null) validateGmailBody(patch.html);
  if (patch.text !== undefined && patch.html !== undefined && patch.html !== null) {
    validateGmailBodyAlternatives(patch.text, patch.html);
  }
}

export function validateDraftRecipientPatch(
    draft: GmailDraftState, patch: Partial<GmailNormalizedRecipients>): void {
  const fields = ["to", "cc", "bcc"] as const;
  const effective = {
    to: patch.to ?? draft.to,
    cc: patch.cc ?? draft.cc,
    bcc: patch.bcc ?? draft.bcc,
  };
  for (const field of fields) {
    if (patch[field] === undefined) continue;
    const otherAddresses = new Set(fields.filter(other => other !== field)
      .flatMap(other => effective[other])
      .map(recipient => emailRecipientToAddress(recipient).address.toLowerCase()));
    if (effective[field].some(recipient =>
      otherAddresses.has(emailRecipientToAddress(recipient).address.toLowerCase()))) {
      throw new Error("A Gmail draft recipient cannot appear in more than one of To, Cc, or Bcc.");
    }
  }
}

export async function attachmentDigest(attachment: GmailOutboundAttachment): Promise<string> {
  const encoded = attachment.data.replace(/\s/g, "");
  return digestBytes(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)));
}

export function matchesDraftAttachment(
    attachment: GmailDraftAttachmentState, part: GmailOutboundAttachment, digest: string): boolean {
  // MIMEText emits a regular attachment disposition when the imported part omitted it.
  return digest === attachment.contentDigest &&
    (part.filename || null) === attachment.info.filename &&
    part.contentType === attachment.info.mimeType &&
    (part.disposition ?? "attachment") === (attachment.info.disposition ?? "attachment") &&
    sameContentId(part.contentId, attachment.info.contentId);
}

/**
 * An imported part may carry a bare Content-ID; the writer always emits it bracketed, and Gmail's
 * part listing strips the brackets, so the bracket-free value identifies a part.
 */
export function sameContentId(left: string | undefined, right: string | undefined): boolean {
  return left?.trim().replace(/^<(.*)>$/, "$1") === right?.trim().replace(/^<(.*)>$/, "$1");
}

/**
 * Correlate once against Gmail's actual MIME order, including on write-receipt reconciliation.
 * Equal metadata is not enough: another attachment can have the same name and size.
 */
export async function captureDraftAttachmentIdentities(
    attachments: readonly GmailDraftAttachmentState[], parsed: GmailParsedDraft,
    messageId: string): Promise<NonNullable<GmailDraftResource["appliedAttachments"]>> {
  const digests = await Promise.all(parsed.attachments.map(attachmentDigest));
  const used = new Set<number>();
  return parsed.attachments.map((part, index) => {
    const match = attachments.findIndex((attachment, candidate) => !used.has(candidate) &&
      matchesDraftAttachment(attachment, part, digests[index]));
    if (match < 0) return {key: `provider-${messageId}-${index}`};
    used.add(match);
    const {key, contentDigest, file} = attachments[match];
    return {key, ...(file ? {contentDigest, file} : {})};
  });
}

/**
 * The identity of part `index` of provider revision `messageId`. Parts of the revision this
 * gatekeeper last wrote keep the keys, and retained upload files, they were written with.
 */
export function providerAttachmentIdentity(
    resource: GmailDraftResource, messageId: string,
    index: number): NonNullable<GmailDraftResource["appliedAttachments"]>[number] {
  return (resource.attachmentMessageId === messageId
    ? resource.appliedAttachments?.[index] : undefined) ?? {key: `provider-${messageId}-${index}`};
}

export async function parsedDraftToState(
    logicalId: string, resource: GmailDraftResource, draft: GmailDraftRaw,
    parsed: GmailParsedDraft, fallbackFrom: string): Promise<GmailDraftState> {
  const attachments: GmailDraftAttachmentState[] = await Promise.all(parsed.attachments.map(
    async (attachment, index) => {
      const encoded = attachment.data.replace(/\s/g, "");
      const size = atob(encoded).length;
      const contentDigest = await attachmentDigest(attachment);
      const applied = providerAttachmentIdentity(resource, draft.message.id, index);
      return {
        key: applied.key,
        info: {
          filename: attachment.filename || null,
          mimeType: attachment.contentType,
          size,
          disposition: attachment.disposition ?? null,
          ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
          readable: size <= MAX_GMAIL_ATTACHMENT_BYTES,
        },
        contentDigest,
        ...(applied.file && applied.contentDigest === contentDigest ? {file: applied.file} : {}),
      };
    }));
  const inlineForward = resource.source?.kind === "forward" && resource.source.format === "inline" &&
    resource.forwardSnapshot;
  return {
    logicalId,
    providerId: draft.id,
    from: parsed.from ?? fallbackFrom,
    replyTo: parsed.replyTo,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    ...(parsed.date !== undefined ? {date: parsed.date} : {}),
    subject: parsed.subject,
    text: inlineForward && resource.forwardBody !== undefined ? resource.forwardBody : parsed.text,
    ...(inlineForward && resource.forwardHtml !== undefined
      ? {html: resource.forwardHtml}
      : !inlineForward && parsed.html !== undefined ? {html: parsed.html} : {}),
    ...(parsed.messageId ? {rfcMessageId: parsed.messageId} : {}),
    ...(parsed.inReplyTo ? {inReplyTo: parsed.inReplyTo} : {}),
    ...(parsed.references ? {references: parsed.references} : {}),
    timestamp: Number(draft.message.internalDate) || resource.createdAt,
    ...(resource.source ? {source: resource.source} : {}),
    attachments,
    version: resource.version,
  };
}

export function parsedDraftSnapshotToState(
    logicalId: string, resource: GmailDraftResource, draft: GmailDraftFull,
    parsed: GmailParsedDraftSnapshot, fallbackFrom: string): GmailDraftState {
  const inlineForward = resource.source?.kind === "forward" && resource.source.format === "inline" &&
    resource.forwardSnapshot;
  return {
    logicalId,
    providerId: draft.id,
    from: parsed.from ?? fallbackFrom,
    replyTo: parsed.replyTo,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    ...(parsed.date !== undefined ? {date: parsed.date} : {}),
    subject: parsed.subject,
    text: inlineForward && resource.forwardBody !== undefined ? resource.forwardBody : parsed.text,
    ...(inlineForward && resource.forwardHtml !== undefined
      ? {html: resource.forwardHtml}
      : !inlineForward && parsed.html !== undefined ? {html: parsed.html} : {}),
    ...(parsed.messageId ? {rfcMessageId: parsed.messageId} : {}),
    ...(parsed.inReplyTo ? {inReplyTo: parsed.inReplyTo} : {}),
    ...(parsed.references ? {references: parsed.references} : {}),
    timestamp: Number(draft.message.internalDate) || resource.createdAt,
    ...(resource.source ? {source: resource.source} : {}),
    attachments: parsed.attachments.map((snapshot, index) => {
      const {key, contentDigest, file} = providerAttachmentIdentity(resource, draft.message.id, index);
      return {key, info: snapshot.info, ...(file ? {contentDigest, file} : {})};
    }),
    version: resource.version,
  };
}

export function draftInfo(state: GmailDraftState): GmailDraftInfo {
  return {
    id: state.logicalId,
    ...(state.messageId ? {messageId: state.messageId} : {}),
    ...(state.threadId ? {threadId: state.threadId} : {}),
    to: state.to.map(emailRecipientToAddress),
    cc: state.cc.map(emailRecipientToAddress),
    bcc: state.bcc.map(emailRecipientToAddress),
    subject: state.subject,
    timestamp: new Date(state.timestamp),
    ...(state.source ? {
      source: {kind: state.source.kind, messageId: state.source.messageId},
    } : {}),
  };
}

export function draftSpec(
    state: GmailDraftState, attachments: GmailOutboundAttachment[] = []): GmailOutboundSpec {
  return {
    from: state.from,
    replyTo: state.replyTo,
    to: state.to,
    cc: state.cc,
    bcc: state.bcc,
    ...(state.date !== undefined ? {date: state.date} : {}),
    subject: state.subject,
    text: state.text,
    ...(state.html !== undefined ? {html: state.html} : {}),
    messageId: state.rfcMessageId ?? newGmailMessageId(),
    ...(state.inReplyTo ? {inReplyTo: state.inReplyTo} : {}),
    ...(state.references ? {references: state.references} : {}),
    attachments,
  };
}

export function pendingForwardSnapshot(
    store: GmailStore, logicalId: string): GmailSourceAttachment | undefined {
  const resource = store.drafts.getDraft(logicalId);
  if (resource?.source?.kind === "forward" && resource.forwardSnapshot) {
    return {
      ...resource.forwardSnapshot,
      messageId: resource.source.messageId,
      description: "Inline forward source snapshot.",
    };
  }
  const actions = store.journal.listActions()
    .filter(({action}) => isDraftAction(action) &&
      store.drafts.resolveDraftId(actionResourceId(action)!) === logicalId)
    .toReversed();
  for (const {action} of actions) {
    const snapshot = actionSourceAttachment(action);
    if (snapshot) return snapshot;
  }
  return undefined;
}

/**
 * The draft's attachment list as this binding last wrote or queued it, read without Gmail: the
 * revision recorded at the last write, replaced by each valid pending create or update, in the
 * same order `overlayGmailDraft` applies them. Undefined once the draft is inactive or pending
 * deletion or send.
 */
export function localDraftAttachments(
    store: GmailStore, logicalId: string):
    readonly Pick<GmailDraftAttachmentState, "key" | "file">[] | undefined {
  const resource = store.drafts.getDraft(logicalId);
  if (resource?.status !== "active") return undefined;
  const decisions = store.journal.decisions();
  let attachments: readonly Pick<GmailDraftAttachmentState, "key" | "file">[] =
    resource.appliedAttachments ?? [];
  for (const {action} of draftPending(store)) {
    if ((action.dependsOn ?? []).some(id => decisions.get(id) === "rejected")) continue;
    if (action.type === "draftCreate") {
      if (action.draft.logicalId === logicalId) attachments = action.draft.attachments;
    } else if (action.draftId === logicalId) {
      if (action.type !== "draftUpdate") return undefined;
      attachments = action.after.attachments;
    }
  }
  return attachments;
}

export async function inlineForwardMessage(
    api: GmailApi, store: GmailStore, state: GmailDraftState,
    snapshot: GmailSourceAttachment, historical = false): Promise<GmailOutboundMessage> {
  return api.buildForwardFromBytes(await store.drafts.readFile(snapshot), state.to, state.text, {
    cc: state.cc,
    bcc: state.bcc,
    ...(state.html !== undefined ? {html: state.html} : {}),
    attachments: await uploadedInputs(store, state.attachments),
  }, state.rfcMessageId, state.subject, state.date, historical);
}

/**
 * An inline forward's attachment state, each part paired with the part its rebuilt output emits:
 * source parts by their exact bytes, else (for bytes the old builder normalized) in order by
 * metadata, then uploads in order. State captured from the old builder's output can hold parts
 * it duplicated, so metadata comes from the rebuilt part, and a source part the rebuild does not
 * emit is dropped.
 */
export async function rebuiltForwardAttachments(
    attachments: readonly GmailDraftAttachmentState[], rebuilt: GmailOutboundMessage):
    Promise<Array<{attachment: GmailDraftAttachmentState; part: GmailOutboundAttachment}>> {
  const sourceParts = rebuilt.attachments.length - attachments.filter(attachment => attachment.file).length;
  const digests = await Promise.all(rebuilt.attachments.slice(0, sourceParts).map(attachmentDigest));
  const used = new Set<number>();
  const claim = (attachment: GmailDraftAttachmentState, exact: boolean) => {
    const index = rebuilt.attachments.findIndex((part, candidate) =>
      candidate < sourceParts && !used.has(candidate) &&
      (!exact || digests[candidate] === attachment.contentDigest) &&
      matchesForwardPartMetadata(part, attachment));
    if (index >= 0) used.add(index);
    return index;
  };
  // Metadata alone cannot tell same-named parts apart, so exact bytes claim their parts first.
  const exact = attachments.map(attachment => attachment.file ? -1 : claim(attachment, true));
  let upload = sourceParts;
  return attachments.flatMap((attachment, position) => {
    const index = attachment.file ? upload++ : exact[position] >= 0 ? exact[position] : claim(attachment, false);
    const part = rebuilt.attachments[index];
    if (index < 0 || !part) return [];
    const size = atob(part.data.replace(/\s/g, "")).length;
    return [{attachment: {...attachment, info: {
      ...attachment.info, mimeType: part.contentType, size, readable: size <= MAX_GMAIL_ATTACHMENT_BYTES,
    }}, part}];
  });
}

export function matchesForwardPartMetadata(
    part: GmailOutboundAttachment, attachment: GmailDraftAttachmentState): boolean {
  return (part.filename || null) === attachment.info.filename &&
    (part.disposition ?? "attachment") === (attachment.info.disposition ?? "attachment") &&
    sameContentId(part.contentId, attachment.info.contentId) &&
    part.contentType.split(";")[0].trim().toLowerCase() ===
      attachment.info.mimeType.split(";")[0].trim().toLowerCase();
}

export async function draftOutputFingerprint(
    api: GmailApi, store: GmailStore, state: GmailDraftState,
    snapshot?: GmailSourceAttachment, legacy = false): Promise<string> {
  let fingerprint: string;
  if (state.source?.kind === "forward" && state.source.format === "inline" && snapshot) {
    // A historical fingerprint describes what the old builder wrote, not the current builder.
    const message = await inlineForwardMessage(api, store, state, snapshot, legacy);
    const parsed = await (legacy ? parseLegacyGmailDraft : parseGmailDraft)({
      id: "forward-snapshot", threadId: state.threadId ?? "forward-snapshot",
      internalDate: "0", raw: message.raw,
    });
    fingerprint = await gmailDraftFingerprint(parsed, state.threadId);
  } else {
    fingerprint = await gmailDraftStateFingerprint(state);
  }
  return legacy ? unversionedGmailFingerprint(fingerprint) : fingerprint;
}

/**
 * The fingerprint a fresh action expects the draft to have in Gmail. An inline forward's output is
 * rebuilt from its retained source, but one created before fingerprints were versioned is held in
 * Gmail as the old MIME builder wrote it. When nothing is queued ahead of the action and Gmail's
 * revision matches the rebuilt output's historical fingerprint, the action expects that exact
 * revision instead.
 */
export async function freshDraftPrecondition(
    ctx: GmailContext, loaded: LoadedGmailDraftBase & {resource: GmailDraftResource},
    snapshot: GmailSourceAttachment | undefined): Promise<string> {
  const fingerprint = await draftOutputFingerprint(ctx.api, ctx.store, loaded.state, snapshot);
  const provider = loaded.provider;
  if (!snapshot || !provider ||
      dependenciesFor(ctx.store, loaded.resource.logicalId, "draft").length > 0) {
    return fingerprint;
  }
  const current = await gmailDraftFingerprint(provider.parsed, provider.message.threadId);
  if (current === fingerprint) return fingerprint;
  const historical = await draftOutputFingerprint(ctx.api, ctx.store, loaded.state, snapshot, true);
  return await matchesGmailFingerprint(provider.message, historical, provider.parsed)
    ? current : fingerprint;
}

/**
 * Every field the draft will hold, exactly as it will be written. `message` is the inline
 * forward rebuilt from its source snapshot, whose headers and bodies replace the state's own.
 */
export async function describeDraftAction(
    intro: string, state: GmailDraftState,
    message?: GmailOutboundMessage): Promise<ActionDescriptionBuilder> {
  const threading = message ?? state;
  const builder = describeMessage(intro, {
    from: message?.from ?? state.from,
    replyTo: message?.replyTo ?? state.replyTo,
    to: message?.to ?? state.to,
    cc: message?.cc ?? state.cc,
    bcc: message?.bcc ?? state.bcc,
    subject: message?.subject ?? state.subject,
    ...(state.rfcMessageId !== undefined ? {messageId: state.rfcMessageId} : {}),
    ...(state.date !== undefined ? {date: state.date} : {}),
    ...(threading.inReplyTo ? {inReplyTo: threading.inReplyTo} : {}),
    ...(threading.references ? {references: threading.references} : {}),
    ...(state.threadId !== undefined ? {threadId: state.threadId} : {}),
    text: message?.body ?? state.text,
    ...((message?.html ?? state.html) !== undefined ? {html: message?.html ?? state.html} : {}),
  });
  if (message) {
    await describeOutboundAttachments(builder, message.attachments);
  } else {
    for (const [index, attachment] of state.attachments.entries()) {
      describeAttachment(builder, `Attachment ${index + 1}`, {
        filename: attachment.info.filename,
        contentType: attachment.info.mimeType,
        size: attachment.info.size,
        digest: attachment.contentDigest,
        disposition: attachment.info.disposition,
        contentId: attachment.info.contentId,
        origin: attachment.file ? "agent" : "provider",
      });
    }
  }
  if (state.source) {
    builder.inline("Source", `${state.source.kind} from message ${state.source.messageId}`);
  }
  if (state.inReplyTo) builder.inline("Threading mode", "reply in source thread");
  return builder;
}

export function describeDraftDeletion(state: GmailDraftState): RenderedDescription {
  return buildDescription("Delete this draft without sending it.")
    .inline("Draft ID", state.logicalId)
    .inline("Subject", state.subject)
    .finish();
}

