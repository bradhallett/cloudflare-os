/**
 * Cursor builders for the Gmail gatekeeper's message, thread, and restricted-thread listings.
 */

import { CursorPager } from "./cursor";
import { loadGmailOverlay } from "./gmail-journal";
import { GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE, GMAIL_RESTRICTED_THREAD_RESULT_PAGE_SIZE, GmailContext, GmailListRequest, MAX_GMAIL_RESTRICTED_THREAD_MESSAGES, MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES, admitReturnedLabels, currentLabels, messageInfo, threadInfo } from "./gmail-list";
import { messageMayMatch, overlayMessageInfo, overlayThreadMessages, threadMayMatch } from "./gmail-overlay";
import { GMAIL_MAILBOX_SCOPE, GmailCapabilityScope, gmailRestrictedScope, groupGmailMessagesByThread } from "./gmail-scope";
import { GmailMessageStub, GmailThreadStub } from "./gmail-stubs";
import { GmailMessageInfoRaw, GmailMessageRef, parseGmailMessageMetadata } from "./google-api";
import { ApprovalQueueRpcTarget, RpcCursor } from "./shared-approval-queue";
import { GmailMessageEntry, GmailThreadEntry } from "./types";
import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export function disposeEntryTargets<Entry>(
    entries: readonly Entry[], target: (entry: Entry) => ApprovalQueueRpcTarget): void {
  for (const entry of entries) {
    try {
      target(entry)[Symbol.dispose]();
    } catch {
      // Continue releasing the rest of the unreturned page.
    }
  }
}

/** A cursor page's Gmail reads, five at a time. */
export async function fetchInBatches<Item, Result>(
    items: readonly Item[], fetch: (item: Item) => Promise<Result>): Promise<Result[]> {
  const results: Result[] = [];
  for (let i = 0; i < items.length; i += 5) {
    results.push(...await Promise.all(items.slice(i, i + 5).map(fetch)));
  }
  return results;
}

export type OwnedGmailMessageEntry = Omit<GmailMessageEntry, "message"> & {message: GmailMessageStub};
export type OwnedGmailThreadEntry = Omit<GmailThreadEntry, "thread"> & {thread: GmailThreadStub};

export function gmailMessageCursor(
    ctx: GmailContext, request: GmailListRequest,
    capabilityScope: GmailCapabilityScope): Cursor<GmailMessageEntry> {
  return new RpcCursor(new CursorPager<{
    id: string;
    threadId: string;
    snippet?: string;
    }, OwnedGmailMessageEntry>({
    async fetchPage(pageToken) {
      const page = await ctx.api.listMessages(20, request.query, pageToken, request.labelIds);
      return {items: page.messages, nextPageToken: page.nextPageToken};
    },
    async buildEntries(messages) {
      const entries: OwnedGmailMessageEntry[] = [];
      try {
        if (messages.length === 0) return entries;
        const overlay = loadGmailOverlay(ctx.store);
        // A draft's message can turn up in search results. One that is being sent or deleted is
        // gone as far as reads go, and may be gone from Gmail by the time it is fetched.
        const shown = messages.filter(ref => !overlay.hiddenMessageIds.has(ref.id));
        const fetched = await fetchInBatches(shown, async ref => ({
          ref,
          provider: parseGmailMessageMetadata(await ctx.api.getMessageMetadata(ref.id)),
        }));
        // One label snapshot filters and renders the whole page. It is taken once the page's
        // metadata is in, as overlayMessageInfo() requires; the overlay was loaded before it.
        const labels = await currentLabels(ctx);
        for (const {ref, provider} of fetched) {
          if (!messageMayMatch(
              overlayMessageInfo(overlay, provider, labels.resources).labelIds,
              request.predicates)) {
            continue;
          }
          const info = await messageInfo(ctx, provider, overlay, labels);
          const scope = capabilityScope.kind === "mailbox"
            ? capabilityScope
            : gmailRestrictedScope([ref.id]);
          entries.push({info, message: new GmailMessageStub(ctx, ref.id, ref.threadId, scope)});
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.message);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail messages`,
        description: "Fetch the next page of Gmail message results.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.message),
  }), ctx.approvalQueue);
}

export function gmailFullThreadCursor(
    ctx: GmailContext, request: GmailListRequest): Cursor<GmailThreadEntry> {
  return new RpcCursor(new CursorPager<{id: string; snippet?: string}, OwnedGmailThreadEntry>({
    async fetchPage(pageToken) {
      const page = await ctx.api.listThreads(20, request.query, pageToken, request.labelIds);
      return {items: page.threads, nextPageToken: page.nextPageToken};
    },
    async buildEntries(threads) {
      const entries: OwnedGmailThreadEntry[] = [];
      try {
        if (threads.length === 0) return entries;
        const overlay = loadGmailOverlay(ctx.store);
        const fetched = await fetchInBatches(threads, async thread => ({
          thread,
          provider: await ctx.api.getThreadMetadata(thread.id),
        }));
        // After the page's metadata, as in gmailMessageCursor().
        const labels = await currentLabels(ctx);
        for (const {thread, provider} of fetched) {
          // Judged by the messages of Gmail's that the thread still shows. A draft message
          // that is being sent or deleted must not keep the thread listed. Nor must mail
          // waiting to be sent: Gmail did not match it, and it could only keep a thread listed
          // that the caller moved out. So a thread whose only message was such a draft is gone,
          // even when the summary would show the message the draft is being sent as.
          const matched = overlayThreadMessages(
            overlay, provider.id, provider.messages, labels.resources, () => false);
          if (matched.length === 0 || !threadMayMatch(matched, request.predicates)) continue;
          const info = {
            ...await threadInfo(ctx, provider, overlay, GMAIL_MAILBOX_SCOPE, labels),
            ...(thread.snippet !== undefined ? {snippet: thread.snippet} : {}),
          };
          entries.push({
            info,
            thread: new GmailThreadStub(
              ctx, thread.id, GMAIL_MAILBOX_SCOPE, {info, generation: overlay.generation}),
          });
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.thread);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail threads`,
        description: "Fetch the next page of Gmail thread results.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.thread),
  }), ctx.approvalQueue);
}

export async function collectRestrictedThreadGroups(
    ctx: GmailContext, query: string | undefined,
    labelIds: string[] | undefined): Promise<Array<{threadId: string; messages: GmailMessageRef[]}>> {
  const messages: GmailMessageRef[] = [];
  const seenTokens = new Set<string>();
  let pages = 0;
  let pageToken: string | undefined;
  do {
    pages++;
    const page = await ctx.api.listMessages(
      GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE, query, pageToken, labelIds);
    const total = messages.length + page.messages.length;
    if (total > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES ||
        (total >= MAX_GMAIL_RESTRICTED_THREAD_MESSAGES && page.nextPageToken)) {
      throw new Error(
        `This restricted Gmail thread search matches more than ` +
        `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages. Narrow the query or use searchMessages().`);
    }
    messages.push(...page.messages);
    pageToken = page.nextPageToken;
    if (pageToken) {
      if (pages >= MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES) {
        throw new Error(
          `Gmail returned more than ${MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES} pages while ` +
          "collecting restricted thread results. Narrow the query or use searchMessages().");
      }
      if (seenTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
      seenTokens.add(pageToken);
    }
  } while (pageToken);
  return groupGmailMessagesByThread(messages);
}

export function gmailRestrictedThreadCursor(
    ctx: GmailContext, request: GmailListRequest): Cursor<GmailThreadEntry> {
  let pendingGroups: Promise<Array<{threadId: string; messages: GmailMessageRef[]}>> | undefined;
  const getGroups = async () => {
    if (!pendingGroups) {
      pendingGroups = collectRestrictedThreadGroups(ctx, request.query, request.labelIds);
    }
    const current = pendingGroups;
    try {
      return await current;
    } catch (error) {
      if (pendingGroups === current) pendingGroups = undefined;
      throw error;
    }
  };
  return new RpcCursor(new CursorPager<{
    threadId: string;
    messages: GmailMessageRef[];
  }, OwnedGmailThreadEntry>({
    async fetchPage(pageToken) {
      const groups = await getGroups();
      const offset = pageToken === undefined ? 0 : Number(pageToken);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > groups.length) {
        throw new Error("Invalid internal Gmail thread cursor position.");
      }
      const items = groups.slice(offset, offset + GMAIL_RESTRICTED_THREAD_RESULT_PAGE_SIZE);
      const nextOffset = offset + items.length;
      return {
        items,
        ...(nextOffset < groups.length ? {nextPageToken: String(nextOffset)} : {}),
      };
    },
    async buildEntries(groups) {
      const entries: OwnedGmailThreadEntry[] = [];
      try {
        if (groups.length === 0) return entries;
        const overlay = loadGmailOverlay(ctx.store);
        const fetched: Array<{
          group: typeof groups[number];
          metadata: Array<{ref: GmailMessageRef; info: GmailMessageInfoRaw}>;
        }> = [];
        for (const group of groups) {
          // Leaving out a draft message that is being sent or deleted, as gmailMessageCursor().
          const shown = group.messages.filter(ref => !overlay.hiddenMessageIds.has(ref.id));
          fetched.push({group, metadata: await fetchInBatches(shown, async ref => ({
            ref,
            info: parseGmailMessageMetadata(await ctx.api.getMessageMetadata(ref.id)),
          }))});
        }
        // After the page's metadata, as in gmailMessageCursor().
        const labels = await currentLabels(ctx);
        for (const {group, metadata} of fetched) {
          // The group is the messages Gmail matched, so each is checked on its own. Narrowing the
          // thread's scope to the ones still listed is always safe.
          const listed = metadata.filter(item => messageMayMatch(
            overlayMessageInfo(overlay, item.info, labels.resources).labelIds,
            request.predicates));
          const first = listed[0];
          if (!first) continue;
          // The scope names only messages Gmail matched, so the summary leaves out mail waiting
          // to be sent into the thread. A delivered reply counts here only if it matches the
          // binding's restriction, which is not evaluated locally.
          const scope = gmailRestrictedScope(listed.map(item => item.info.id));
          const info = await threadInfo(ctx, {
            id: group.threadId,
            snippet: first.ref.snippet,
            messages: listed.map(item => item.info),
          }, overlay, scope, labels);
          entries.push({
            info,
            thread: new GmailThreadStub(
              ctx, group.threadId, scope, {info, generation: overlay.generation}),
          });
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.thread);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} restricted Gmail threads`,
        description: "Fetch matching messages grouped into scope-preserving thread capabilities.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.thread),
  }), ctx.approvalQueue);
}

