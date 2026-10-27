/**
 * Read model for the Gmail gatekeeper: read contexts, restriction walks, and message/thread info.
 */

import type { GmailMessageHookTarget } from "./gmail-hooks";
import { GmailLabelSnapshot, GmailStore, labelPending } from "./gmail-journal";
import { publicLabels } from "./gmail-labels";
import { GmailOverlay, LabelPredicate, PendingSentMessage, compileListFilter, overlayMessageInfo, overlayThreadMessages } from "./gmail-overlay";
import { GmailCapabilityScope, gmailRestrictedScope, gmailScopeAllowsMessage } from "./gmail-scope";
import { GmailDraftSource, overlayGmailLabels } from "./gmail-state";
import { combineGmailQueries } from "./gmail-validate";
import { GmailApi, GmailLabelRaw, GmailMessageInfoRaw, GmailMessageRef, GmailThreadMetadataRaw, shouldIncludeSpamTrash, summarizeGmailThread } from "./google-api";
import { SharedApprovalQueue } from "./shared-approval-queue";
import { GmailLabel, GmailMessageInfo, GmailThreadInfo } from "./types";
import { RpcStub } from "cloudflare:workers";

export const GMAIL_LOGICAL_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
export const GMAIL_PROVIDER_ID_RE = /^[a-f0-9]{1,256}$/i;

export const GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE = 500;
export const GMAIL_RESTRICTED_THREAD_RESULT_PAGE_SIZE = 20;
export const MAX_GMAIL_RESTRICTED_THREAD_MESSAGES = 1000;
export const MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES = 20;

/**
 * Whether an ID is a `GmailMessageId`, the RFC Message-ID an outbound method returned, rather
 * than an ID of Gmail's own. Until its send is delivered it is the only ID the message has.
 */
export function isGmailMessageId(id: string): boolean {
  return id.startsWith("<");
}

export type GmailReadContext = {
  api: GmailApi;
  store: GmailStore;
  selfEmail: string;
  searchQuery?: string;
  labelId?: string;
  labelName?: string;
  restricted: boolean;
  providerLabels(): Promise<GmailLabelRaw[]>;
};

/** What every capability of this binding shares, over one approval queue. */
export type GmailContext = GmailReadContext & {
  approvalQueue: SharedApprovalQueue;
  /** Bind `hook` to new mail in `threadId`, or to what the binding lists when undefined. */
  subscribe(threadId: string | undefined, hook: RpcStub<GmailMessageHookTarget>): Promise<void>;
};

export async function currentLabels(ctx: GmailReadContext): Promise<GmailLabelSnapshot> {
  const provider = await ctx.providerLabels();
  const resources = ctx.store.labels.listLabels();
  return {
    labels: overlayGmailLabels(provider, resources, labelPending(ctx.store), ctx.store.journal.decisions()),
    resources,
  };
}

/**
 * Every message's metadata is returned through here, so no read can skip the pending changes.
 * They are applied with the same label resources the result is rendered from, so a label names
 * one thing in both even when its creation was applied while this read was fetching.
 *
 * A message waiting to be sent comes through too, as `PendingSentMessage.info`. It has no thread
 * when Gmail will only assign one on sending it.
 */
export async function messageInfo(
    ctx: GmailContext, provider: Omit<GmailMessageInfoRaw, "threadId"> & {threadId?: string},
    overlay: GmailOverlay, snapshot?: GmailLabelSnapshot): Promise<GmailMessageInfo> {
  const current = snapshot ?? await currentLabels(ctx);
  const raw = overlayMessageInfo(overlay, provider, current.resources);
  return {
    id: raw.id,
    ...(raw.threadId !== undefined ? {threadId: raw.threadId} : {}),
    from: raw.from,
    to: raw.to,
    cc: raw.cc,
    ...(raw.bcc.length ? {bcc: raw.bcc} : {}),
    subject: raw.subject,
    timestamp: raw.timestamp,
    labels: publicLabels(raw.labelIds, current.labels, current.resources),
  };
}

/**
 * Mail waiting to be sent into a thread shows wherever the delivered message would: always to a
 * whole-mailbox capability, and to a restricted one only when its scope admits that very message.
 */
export function admitsPending(scope: GmailCapabilityScope): (sent: PendingSentMessage) => boolean {
  return sent => gmailScopeAllowsMessage(scope, sent.rfcMessageId);
}

/**
 * Every thread summary is built here. A thread has no labels of its own, so its `labels` and
 * `unread` are recomputed from its messages once the pending changes are applied to them. Its
 * count, latest message, participants and timestamp take in the mail waiting to be sent into it
 * that `scope` admits.
 */
export async function threadInfo(
    ctx: GmailContext, provider: GmailThreadMetadataRaw, overlay: GmailOverlay,
    scope: GmailCapabilityScope, snapshot?: GmailLabelSnapshot): Promise<GmailThreadInfo> {
  const current = snapshot ?? await currentLabels(ctx);
  const {labelIds, ...info} = summarizeGmailThread(
    provider.id, provider.snippet,
    overlayThreadMessages(
      overlay, provider.id, provider.messages, current.resources, admitsPending(scope)));
  return {...info, labels: publicLabels(labelIds, current.labels, current.resources)};
}

/** A thread summary, and the `GmailOverlay.generation` it was computed against. */
export type GmailThreadSummary = {info: GmailThreadInfo; generation: number};

export function admitReturnedLabels(ctx: GmailContext, labels: readonly GmailLabel[]): void {
  if (!ctx.restricted) return;
  for (const label of labels) ctx.store.labels.admitLabel(label.id);
}

export async function walkRestrictedMessages(
    ctx: GmailContext, visit: (messages: readonly GmailMessageRef[]) => boolean,
    allowPartial = false): Promise<void> {
  if (!ctx.restricted) throw new Error("Expected a restricted Gmail binding.");
  const labelIds = ctx.labelId ? [ctx.labelId] : undefined;
  if (!ctx.searchQuery && !labelIds) throw new Error("Restricted Gmail binding has no restriction.");
  const seenTokens = new Set<string>();
  let pages = 0;
  let pageToken: string | undefined;
  do {
    const result = await ctx.api.listMessages(
      GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE, ctx.searchQuery, pageToken, labelIds);
    if (visit(result.messages)) return;
    pages++;
    pageToken = result.nextPageToken;
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
      seenTokens.add(pageToken);
      if (pages === MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES) {
        if (allowPartial) return;
        throw new Error("The Gmail restriction contains too many messages to verify this capability.");
      }
    }
  } while (pageToken);
}

export async function messagesAvailableThroughRestriction(
    ctx: GmailContext, soughtMessageIds: ReadonlySet<string>): Promise<Set<string>> {
  const remaining = new Set(soughtMessageIds);
  const matched = new Set<string>();
  await walkRestrictedMessages(ctx, messages => {
    for (const message of messages) {
      if (remaining.delete(message.id)) matched.add(message.id);
    }
    return remaining.size === 0;
  });
  return matched;
}

export async function messageStillAvailable(ctx: GmailContext, messageId: string): Promise<boolean> {
  if (!ctx.restricted) return true;
  const matched = await messagesAvailableThroughRestriction(ctx, new Set([messageId]));
  return matched.has(messageId);
}

export async function sourceStillAvailable(ctx: GmailContext, source: GmailDraftSource): Promise<boolean> {
  return messageStillAvailable(ctx, source.messageId);
}

export async function restrictedThreadMessageIds(ctx: GmailContext, threadId: string): Promise<string[]> {
  const matched = new Set<string>();
  await walkRestrictedMessages(ctx, messages => {
    for (const message of messages) {
      if (message.threadId === threadId) matched.add(message.id);
    }
    if (matched.size > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES) {
      throw new Error(
        `This restricted Gmail thread contains more than ` +
        `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages.`);
    }
    return false;
  }, true);
  return [...matched];
}

export async function restrictedThreadScope(
    ctx: GmailContext, threadId: string,
    sentMessageIds: readonly string[] = [],
    knownRestrictedMessageIds?: readonly string[]): Promise<GmailCapabilityScope> {
  const restrictedMessageIds = knownRestrictedMessageIds ??
    await restrictedThreadMessageIds(ctx, threadId);
  if (!restrictedMessageIds.length && !sentMessageIds.length) {
    throw new Error("This Gmail thread is not available through this restricted binding.");
  }
  const thread = await ctx.api.getThread(threadId);
  if (thread.id !== threadId) throw new Error("Gmail thread identity changed unexpectedly.");
  if (thread.messages.length > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES) {
    throw new Error(
      `This restricted Gmail thread contains more than ` +
      `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages.`);
  }
  const messageIds = [...new Set(thread.messages.map(message => message.id))];
  const admitted = messageIds.filter(messageId => restrictedMessageIds.includes(messageId));
  for (const messageId of sentMessageIds) {
    if (messageIds.includes(messageId) && ctx.store.journal.isSentMessage(messageId) &&
        !admitted.includes(messageId)) {
      admitted.push(messageId);
    }
  }
  if (!admitted.length) {
    throw new Error("This Gmail thread is not available through this restricted binding.");
  }
  for (let i = 0; i < admitted.length; i += 5) {
    await Promise.all(admitted.slice(i, i + 5).map(async messageId => {
      const metadata = await ctx.api.getMessageMetadata(messageId);
      if (metadata.threadId !== threadId) {
        throw new Error("Gmail message thread identity changed unexpectedly.");
      }
      return undefined;
    }));
  }
  return gmailRestrictedScope(admitted);
}

export function effectiveListQuery(ctx: GmailReadContext, caller?: string): string | undefined {
  return combineGmailQueries(ctx.searchQuery, caller);
}

export function listLabelIds(ctx: GmailReadContext, defaultInbox: boolean): string[] | undefined {
  if (ctx.labelId) return [ctx.labelId];
  if (defaultInbox && !ctx.searchQuery) return ["INBOX"];
  return undefined;
}

/** What a list asks Gmail for, and the label conditions its results must hold to stay listed. */
export type GmailListRequest = {
  query: string | undefined;
  labelIds: string[] | undefined;
  /**
   * Checked against every entry once pending changes are applied, so a list drops what the caller
   * moved out of it. That also drops a stale entry from Gmail's search index, which lags behind
   * label changes. Entries are only ever dropped: one moved into the list appears once Gmail
   * returns it.
   */
  predicates: LabelPredicate[];
};

export function listRequest(
    ctx: GmailReadContext, defaultInbox: boolean, callerQuery?: string): GmailListRequest {
  const query = effectiveListQuery(ctx, callerQuery);
  const labelIds = listLabelIds(ctx, defaultInbox);
  return {
    query,
    labelIds,
    predicates: compileListFilter({
      labelIds,
      // Kept apart, not as the combined query, so each is checked as its own list of terms.
      queries: [ctx.searchQuery, callerQuery].filter(part => part !== undefined),
      includeSpamTrash: shouldIncludeSpamTrash(query, labelIds),
    }),
  };
}

