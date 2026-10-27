/**
 * Session-facing stubs for the Gmail gatekeeper: threads, messages, pending messages, attachments, and hook delivery.
 */

import { buildPendingOutbound } from "./gmail-apply";
import { createDraftFromMessage } from "./gmail-draft-stubs";
import { captureSourceAttachment, describeOutboundMessage, inlineForwardSpec, outboundSpec, parseSafeGmailDraft, validateForwardFields } from "./gmail-drafts";
import type { GmailHookDelivery, GmailHookParams, GmailMessageHookTarget } from "./gmail-hooks";
import { UNDELIVERED_GMAIL_LABELS } from "./gmail-hooks";
import { loadGmailOverlay, submitSendAction } from "./gmail-journal";
import { mutationDescription, mutationTitle, resolveMutableLabel, submitMutation } from "./gmail-labels";
import { GMAIL_PROVIDER_ID_RE, GmailContext, GmailReadContext, GmailThreadSummary, admitReturnedLabels, admitsPending, currentLabels, isGmailMessageId, listRequest, messageInfo, restrictedThreadMessageIds, restrictedThreadScope, threadInfo } from "./gmail-list";
import { GmailMutationOperation, GmailOverlay, PendingSentMessage, messageMayMatch, overlayMessageInfo, pendingThreadMessages } from "./gmail-overlay";
import { GMAIL_MAILBOX_SCOPE, GmailCapabilityScope, GmailMessagesTarget, GmailSentBoundary, gmailRestrictedScope, gmailScopeAllowsMessage, gmailThreadMutationTarget } from "./gmail-scope";
import { MAX_GMAIL_VISIBLE_THREAD_MESSAGES, validateGmailAddress, validateGmailBody, validateOutboundFields } from "./gmail-validate";
import { GmailMessageFull, GmailMessageInfoRaw, GmailMessageRaw, MAX_GMAIL_ATTACHMENT_BYTES, MAX_GMAIL_FORWARD_SOURCE_BYTES, emailRecipientToAddress, enumerateGmailAttachments, gmailMessageIdQueryValue, normalizeEmailRecipients, parseGmailMessageMetadata } from "./google-api";
import { GoogleApiError } from "./google-response";
import { ApprovalQueueRpcTarget } from "./shared-approval-queue";
import { EmailContent, GmailAttachment, GmailAttachmentEntry, GmailAttachmentInfo, GmailComposeOptions, GmailDraft, GmailDraftAttachment, GmailHeader, GmailMessage, GmailMessageInfo, GmailMutableLabel, GmailReplyOptions, GmailThread, GmailThreadInfo } from "./types";
import { sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { RpcStub, RpcTarget } from "cloudflare:workers";

@validateRpc()
export class GmailThreadStub extends ApprovalQueueRpcTarget implements GmailThread {
  #ctx: GmailContext;
  #threadId: string;
  // A restricted scope may admit, by its `GmailMessageId`, a message this binding sent. This is
  // then the thread that message opened before Gmail had the message, and it is how the thread
  // shows that message. Everything that turns the scope into Gmail requests or message
  // capabilities reads it through #providerScope() instead.
  #scope: GmailCapabilityScope;
  #cachedSummary?: GmailThreadSummary;

  constructor(
      ctx: GmailContext, threadId: string, scope: GmailCapabilityScope,
      cachedSummary?: GmailThreadSummary) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#threadId = threadId;
    this.#scope = scope;
    this.#cachedSummary = cachedSummary;
  }

  // The scope in Gmail's own IDs. A message admitted by its `GmailMessageId` becomes the ID
  // Gmail gave it once its send is delivered, and until then admits nothing Gmail has.
  #providerScope(): GmailCapabilityScope {
    if (this.#scope.kind === "mailbox") return this.#scope;
    return gmailRestrictedScope(this.#scope.admittedMessageIds.flatMap(id => {
      if (!isGmailMessageId(id)) return [id];
      const receipt = this.#ctx.store.journal.sentMessageByRfcMessageId(id);
      return receipt?.threadId === this.#threadId ? [receipt.providerId] : [];
    }));
  }

  async #loadInfo(): Promise<GmailThreadInfo> {
    const cached = this.#cachedSummary;
    this.#cachedSummary = undefined;
    // The summary computed when this capability was created serves its first read, unless an
    // action has been submitted, applied or rejected since: it would not reflect that.
    if (cached?.generation === this.#ctx.store.journal.actionGeneration()) return cached.info;
    const overlay = loadGmailOverlay(this.#ctx.store);
    const scope = this.#providerScope();
    if (scope.kind === "mailbox") {
      return threadInfo(
        this.#ctx, await this.#ctx.api.getThreadMetadata(this.#threadId), overlay, this.#scope);
    }
    // A draft message that is being sent or deleted may be gone from Gmail already.
    const admitted = scope.admittedMessageIds.filter(id => !overlay.hiddenMessageIds.has(id));
    const metadata: GmailMessageFull[] = [];
    for (let i = 0; i < admitted.length; i += 5) {
      metadata.push(...await Promise.all(
        admitted.slice(i, i + 5).map(id => this.#ctx.api.getMessageMetadata(id))));
    }
    const info = await threadInfo(this.#ctx, {
      id: this.#threadId,
      snippet: metadata[0]?.snippet,
      messages: metadata.map(parseGmailMessageMetadata),
    }, overlay, this.#scope);
    if (info.messageCount === 0) {
      throw new Error("This restricted Gmail thread admits no messages.");
    }
    return info;
  }

  // The messages this capability shows: Gmail's in thread order, without a draft message that is
  // being sent or deleted, then the mail waiting to be sent into the thread.
  async #members(): Promise<{
    scope: GmailCapabilityScope; providerIds: string[]; pending: PendingSentMessage[];
  }> {
    const overlay = loadGmailOverlay(this.#ctx.store);
    const scope = this.#providerScope();
    const ids = scope.kind === "restricted"
      ? scope.admittedMessageIds
      : (await this.#ctx.api.getThread(this.#threadId)).messages.map(message => message.id);
    return {
      scope,
      providerIds: ids.filter(id => !overlay.hiddenMessageIds.has(id)),
      pending: pendingThreadMessages(overlay, this.#threadId, admitsPending(this.#scope)),
    };
  }

  async getMetadata(): Promise<GmailThreadInfo> {
    const info = await this.#loadInfo();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Gmail thread: ${info.subject}`),
      description: "Read metadata for the messages admitted by this thread capability.",
    });
    admitReturnedLabels(this.#ctx, info.labels);
    return info;
  }

  async messages(): Promise<GmailMessage[]> {
    const {scope, providerIds, pending} = await this.#members();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read ${providerIds.length + pending.length} Gmail thread messages`,
      description: "Create message capabilities for the admitted portion of this thread.",
    });
    return [
      ...providerIds.map(id => new GmailMessageStub(this.#ctx, id, this.#threadId, scope)),
      ...pending.map(sent => new GmailPendingMessageStub(this.#ctx, sent.rfcMessageId)),
    ];
  }

  async messagesVisibleTo(address: string): Promise<GmailMessage[]> {
    validateGmailAddress(address);
    const [normalized] = normalizeEmailRecipients([address]);
    const {scope, providerIds: ids, pending} = await this.#members();
    if (ids.length + pending.length > MAX_GMAIL_VISIBLE_THREAD_MESSAGES) {
      throw new Error(
        `This thread capability has ${ids.length + pending.length} messages; at most ` +
        `${MAX_GMAIL_VISIBLE_THREAD_MESSAGES} can be filtered by participant.`);
    }
    const target = emailRecipientToAddress(normalized).address.toLowerCase();
    const visible: string[] = [];
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const participants = await Promise.all(
        batch.map(id => this.#ctx.api.getMessageParticipants(id)));
      for (let j = 0; j < batch.length; j++) {
        if (participants[j].has(target)) visible.push(batch[j]);
      }
    }
    // Mail waiting to be sent is matched on the sender and recipients it will be sent with.
    const visiblePending = pending.filter(({info}) =>
      [info.from, ...info.to, ...info.cc, ...info.bcc].some(
        participant => participant.address.toLowerCase() === target));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read ${visible.length + visiblePending.length} participant-visible Gmail messages`,
      description: "Filter the admitted thread messages by an exact participant address.",
    });
    return [
      ...visible.map(id => new GmailMessageStub(this.#ctx, id, this.#threadId, scope)),
      ...visiblePending.map(sent => new GmailPendingMessageStub(this.#ctx, sent.rfcMessageId)),
    ];
  }

  // What a `lastMessageId` that is a `GmailMessageId` stands for. A thread summary reports a
  // message this binding sent as `latestMessageId` while that message is the newest, by the ID
  // its send returned. A caller may hold on to that ID until after the send is delivered, so it
  // resolves the same way then; see GmailSentBoundary.
  #sentBoundary(
      overlay: GmailOverlay,
      lastMessageId: string): Pick<GmailSentBoundary, "submittedAt"> | string {
    let rfcMessageId: string | undefined;
    try {
      rfcMessageId = `<${gmailMessageIdQueryValue(lastMessageId)}>`;
    } catch {
      // Malformed, so it names no message of this thread.
    }
    const pending = overlay.sent.find(
      sent => sent.rfcMessageId === rfcMessageId && sent.threadId === this.#threadId);
    if (pending) return {submittedAt: pending.info.timestamp.getTime()};
    const receipt = rfcMessageId === undefined
      ? undefined
      : this.#ctx.store.journal.sentMessageByRfcMessageId(rfcMessageId);
    if (receipt?.threadId !== this.#threadId) {
      throw new Error("lastMessageId is not a message of this thread available to this capability.");
    }
    // A send completed before sends recorded when they were submitted: stop at Gmail's copy.
    if (receipt.submittedAt === undefined) return receipt.providerId;
    return {submittedAt: receipt.submittedAt};
  }

  async #mutate(
      operation: GmailMutationOperation, lastMessageId: string | undefined,
      label?: GmailMutableLabel): Promise<void> {
    // Only the subject is needed, for the approval title, and no pending action changes it. So
    // the summary from when this capability was created still serves, without a fetch for every
    // thread of a list the caller is working through.
    const info = this.#cachedSummary?.info ?? await this.#loadInfo();
    const canonical = label ? await resolveMutableLabel(this.#ctx, label) : undefined;
    const overlay = loadGmailOverlay(this.#ctx.store);
    const scope = this.#providerScope();
    const last = lastMessageId !== undefined && isGmailMessageId(lastMessageId)
      ? this.#sentBoundary(overlay, lastMessageId)
      : lastMessageId;
    // Fix the exact messages now, so mail arriving before approval is never reached. A draft
    // message that is being sent or deleted is not among them: it is gone as far as reads go,
    // and Gmail no longer has it once that action is applied.
    let target: GmailMessagesTarget;
    if (typeof last === "object") {
      const thread = await this.#ctx.api.getThreadMetadata(this.#threadId);
      const messages = thread.messages.filter(
        message => !overlay.hiddenMessageIds.has(message.id));
      // Mail this binding sent has been in the thread, as its reads show it, since it was
      // submitted. That includes the delivered copy of the message `lastMessageId` names.
      target = gmailThreadMutationTarget(scope, messages.map(message => message.id), {
        ...last,
        appearedAt: new Map(messages.map(message => [
          message.id,
          this.#ctx.store.journal.sentMessageByProviderId(message.id)?.submittedAt ??
            message.timestamp.getTime(),
        ])),
      });
    } else {
      const thread = await this.#ctx.api.getThread(this.#threadId);
      if (thread.id !== this.#threadId) {
        throw new Error("Gmail thread identity changed unexpectedly.");
      }
      target = gmailThreadMutationTarget(
        scope,
        thread.messages.map(message => message.id)
          .filter(id => !overlay.hiddenMessageIds.has(id)),
        last);
    }
    await submitMutation(
      this.#ctx,
      operation,
      target,
      `${mutationTitle(operation)}: ${info.subject || "(no subject)"}`,
      mutationDescription(operation, canonical),
      canonical);
  }

  async archive(lastMessageId?: string): Promise<void> {
    await this.#mutate("archive", lastMessageId);
  }
  async trash(lastMessageId?: string): Promise<void> { await this.#mutate("trash", lastMessageId); }
  async markRead(lastMessageId?: string): Promise<void> {
    await this.#mutate("markRead", lastMessageId);
  }
  async markUnread(lastMessageId?: string): Promise<void> {
    await this.#mutate("markUnread", lastMessageId);
  }
  async star(lastMessageId?: string): Promise<void> { await this.#mutate("star", lastMessageId); }
  async unstar(lastMessageId?: string): Promise<void> {
    await this.#mutate("unstar", lastMessageId);
  }
  @skipRpcValidation()
  async applyLabel(label: GmailMutableLabel, lastMessageId?: string): Promise<void> {
    await this.#mutate("applyLabel", lastMessageId, label);
  }
  @skipRpcValidation()
  async removeLabel(label: GmailMutableLabel, lastMessageId?: string): Promise<void> {
    await this.#mutate("removeLabel", lastMessageId, label);
  }
  async subscribeNewMessages(hook: RpcStub<GmailMessageHookTarget>): Promise<void> {
    await this.#ctx.subscribe(this.#threadId, hook);
  }
}

@validateRpc()
export class GmailMessageStub extends ApprovalQueueRpcTarget implements GmailMessage {
  #ctx: GmailContext;
  #messageId: string;
  #threadId: string;
  #scope: GmailCapabilityScope;
  #cachedRaw?: GmailMessageRaw;
  #cachedInfo?: GmailMessageInfoRaw;

  constructor(
      ctx: GmailContext, messageId: string, threadId: string, scope: GmailCapabilityScope,
      cachedRaw?: GmailMessageRaw, cachedInfo?: GmailMessageInfoRaw) {
    if (!gmailScopeAllowsMessage(scope, messageId)) {
      throw new Error("Message is outside this Gmail capability's admitted scope.");
    }
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
    this.#scope = scope;
    this.#cachedRaw = cachedRaw;
    this.#cachedInfo = cachedInfo;
  }

  async #raw(): Promise<GmailMessageRaw> {
    this.#cachedRaw ??= await this.#ctx.api.getMessage(this.#messageId);
    if (this.#cachedRaw.threadId !== this.#threadId) {
      throw new Error("Gmail message thread identity changed unexpectedly.");
    }
    return this.#cachedRaw;
  }

  async #forwardSource(): Promise<GmailMessageRaw> {
    const metadata = await this.#ctx.api.getMessageMetadata(this.#messageId);
    if ((metadata.sizeEstimate ?? 0) > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot forward this message: it exceeds the ${MAX_GMAIL_FORWARD_SOURCE_BYTES}-byte safe limit.`);
    }
    return this.#raw();
  }

  async #info(): Promise<GmailMessageInfoRaw> {
    const metadata = await this.#ctx.api.getMessageMetadata(this.#messageId);
    if (metadata.threadId !== this.#threadId) {
      throw new Error("Gmail message thread identity changed unexpectedly.");
    }
    this.#cachedInfo = parseGmailMessageMetadata(metadata);
    return this.#cachedInfo;
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const overlay = loadGmailOverlay(this.#ctx.store);
    const info = await messageInfo(this.#ctx, await this.#info(), overlay);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Gmail message: ${info.subject}`),
      description: "Read sender, recipients, timestamp, subject, and labels for this message.",
    });
    admitReturnedLabels(this.#ctx, info.labels);
    return info;
  }

  async getHeaders(): Promise<GmailHeader[]> {
    let headers: GmailHeader[];
    if (this.#cachedRaw) {
      headers = await this.#ctx.api.parseMessageHeaders(this.#cachedRaw);
    } else {
      const full = await this.#ctx.api.getMessageFull(this.#messageId);
      if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
      headers = this.#ctx.api.collectMessageHeaders(full.payload?.headers ?? []);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail message headers",
      description: `Read ${headers.length} ordered headers from this message.`,
    });
    return headers;
  }

  async thread(): Promise<GmailThread> {
    const scope = this.#scope.kind === "mailbox"
      ? this.#scope
      : await restrictedThreadScope(
        this.#ctx,
        this.#threadId,
        this.#scope.admittedMessageIds.filter(messageId => this.#ctx.store.journal.isSentMessage(messageId)),
      );
    return new GmailThreadStub(this.#ctx, this.#threadId, scope);
  }

  async getContent(): Promise<EmailContent> {
    let rawInfo: GmailMessageInfoRaw;
    let content: EmailContent;
    if (this.#cachedRaw) {
      const parsed = await this.#ctx.api.parseMessage(this.#cachedRaw);
      rawInfo = parsed.info;
      content = parsed.content;
    } else {
      const full = await this.#ctx.api.getMessageFull(this.#messageId);
      if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
      rawInfo = parseGmailMessageMetadata(full);
      content = await this.#ctx.api.getMessageContent(full);
    }
    this.#cachedInfo = rawInfo;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Read Gmail message: ${rawInfo.subject}`),
      description: "Read the plain-text and HTML representations of this message.",
    });
    return content;
  }

  async attachments(): Promise<GmailAttachmentEntry[]> {
    const full = await this.#ctx.api.getMessageFull(this.#messageId);
    if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
    const snapshots = enumerateGmailAttachments(this.#messageId, full.payload);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List ${snapshots.length} Gmail attachments`,
      description: "Read attachment and inline MIME-part metadata for this message.",
    });
    return snapshots.map(snapshot => ({
      info: snapshot.info,
      attachment: new GmailAttachmentStub(
        this.#ctx, snapshot.info, () => this.#ctx.api.getAttachmentContent(snapshot)),
    }));
  }

  async #reply(body: string, replyAll: boolean, options: GmailReplyOptions = {}): Promise<string> {
    validateGmailBody(body);
    if (options.html !== undefined) validateGmailBody(options.html);
    const source = await this.#ctx.api.getMessageMetadata(this.#messageId);
    const message = await this.#ctx.api.buildReplyFromMetadata(source, body, replyAll, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    await submitSendAction(this.#ctx, {
      type: "send",
      mode: "reply",
      spec: outboundSpec(message, []),
      threadId: this.#threadId,
      sourceMessageId: this.#messageId,
      submittedAt: Date.now(),
    }, {
      title: sanitizeTitle(`${replyAll ? "Reply all" : "Reply"}: ${message.subject}`),
      ...(await describeOutboundMessage(
        replyAll ? "Send a reply to all calculated recipients." : "Send a reply.", message,
        this.#threadId))
        .inline("Source message", this.#messageId)
        .inline("Threading mode", "reply in source thread")
        .finish(),
    }, options.attachments);
    return message.messageId;
  }

  async reply(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#reply(body, false, options);
  }

  async replyAll(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#reply(body, true, options);
  }

  async forward(
      to: string[], body?: string, options: GmailComposeOptions = {}): Promise<string> {
    const source = await this.#forwardSource();
    const message = await this.#ctx.api.buildForwardRaw(source, to, body, options);
    validateForwardFields(message, body, options);
    const snapshot = await captureSourceAttachment(this.#ctx.store, source, message);
    try {
      await submitSendAction(this.#ctx, {
        type: "send",
        mode: "forward",
        spec: inlineForwardSpec(message, body, options),
        sourceMessageId: this.#messageId,
        sourceAttachment: snapshot,
        forwardFormat: "inline",
        submittedAt: Date.now(),
      }, {
        title: sanitizeTitle(`Forward: ${message.subject}`),
        ...(await describeOutboundMessage(
          "Forward this message inline with its original body and attachments.", message))
          .inline("Source message", this.#messageId)
          .inline("Threading mode", "new forward message")
          .finish(),
      }, options.attachments);
      return message.messageId;
    } catch (error) {
      this.#ctx.store.drafts.releaseFile(this.#ctx.store.journal, snapshot);
      throw error;
    }
  }

  async #createReplyDraft(
      body: string, replyAll: boolean, options: GmailReplyOptions = {}): Promise<GmailDraft> {
    validateGmailBody(body);
    const source = await this.#ctx.api.getMessageMetadata(this.#messageId);
    const message = await this.#ctx.api.buildReplyFromMetadata(source, body, replyAll, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    return createDraftFromMessage(this.#ctx, message, {
      source: {kind: "reply", messageId: this.#messageId},
      threadId: this.#threadId,
      uploads: options.attachments,
    });
  }

  async createReplyDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#createReplyDraft(body, false, options);
  }

  async createReplyAllDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#createReplyDraft(body, true, options);
  }

  async createForwardDraft(
      to: string[], body?: string, options: GmailComposeOptions = {}): Promise<GmailDraft> {
    const source = await this.#forwardSource();
    const message = await this.#ctx.api.buildForwardRaw(source, to, body, options);
    validateForwardFields(message, body, options);
    const snapshot = await captureSourceAttachment(this.#ctx.store, source, message);
    return createDraftFromMessage(this.#ctx, message, {
      source: {kind: "forward", messageId: this.#messageId, format: "inline"},
      sourceSnapshot: snapshot,
      forwardInput: {body, options},
      uploads: options.attachments,
    });
  }

  async #mutate(operation: GmailMutationOperation, label?: GmailMutableLabel): Promise<void> {
    const rawInfo = await this.#info();
    const canonical = label ? await resolveMutableLabel(this.#ctx, label) : undefined;
    await submitMutation(
      this.#ctx,
      operation,
      {kind: "messages", messageIds: [this.#messageId]},
      `${mutationTitle(operation)}: ${rawInfo.subject || "(no subject)"}`,
      mutationDescription(operation, canonical),
      canonical);
  }

  async archive(): Promise<void> { await this.#mutate("archive"); }
  async trash(): Promise<void> { await this.#mutate("trash"); }
  async markRead(): Promise<void> { await this.#mutate("markRead"); }
  async markUnread(): Promise<void> { await this.#mutate("markUnread"); }
  async star(): Promise<void> { await this.#mutate("star"); }
  async unstar(): Promise<void> { await this.#mutate("unstar"); }
  @skipRpcValidation()
  async applyLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("applyLabel", label); }
  @skipRpcValidation()
  async removeLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("removeLabel", label); }
}

/**
 * A message this binding sent, opened by the `GmailMessageId` its send returned.
 *
 * Gmail has no such message until the send is approved, so until then this serves the message
 * from the pending action, as the email that will be sent. Once the send is delivered the same
 * capability is Gmail's copy, with nothing for its holder to do; if the send is rejected instead,
 * it reports that the message was not sent. Each call works out afresh where the message stands.
 *
 * The simulated message is read-only. Changing, answering or forwarding it would queue an action
 * on a message that has no Gmail ID yet, and new mail has no thread until Gmail assigns one.
 */

@validateRpc()
export class GmailPendingMessageStub extends ApprovalQueueRpcTarget implements GmailMessage {
  #ctx: GmailContext;
  #rfcMessageId: string;
  #delivered?: GmailMessageStub;
  #email?: Promise<GmailMessageRaw>;

  constructor(ctx: GmailContext, rfcMessageId: string) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#rfcMessageId = rfcMessageId;
  }

  #current(): {delivered: GmailMessageStub} | {sent: PendingSentMessage; overlay: GmailOverlay} {
    const receipt = this.#ctx.store.journal.sentMessageByRfcMessageId(this.#rfcMessageId);
    if (receipt) {
      // Scoped as getMessage() scopes mail sent through the binding.
      this.#delivered ??= new GmailMessageStub(
        this.#ctx, receipt.providerId, receipt.threadId,
        this.#ctx.restricted ? gmailRestrictedScope([receipt.providerId]) : GMAIL_MAILBOX_SCOPE);
      return {delivered: this.#delivered};
    }
    const overlay = loadGmailOverlay(this.#ctx.store);
    const sent = overlay.sent.find(candidate => candidate.rfcMessageId === this.#rfcMessageId);
    if (!sent) throw new Error("This message was not sent.");
    return {sent, overlay};
  }

  // The email as it will be sent, built once for this capability. Its `Date` is the submission
  // time unless the message already carries one; the email actually sent is dated at the send.
  // This fails while a draft's attachments cannot be read from Gmail, as after a draft send
  // whose outcome is unknown, where Gmail may have consumed the draft.
  async #pendingEmail(sent: PendingSentMessage): Promise<GmailMessageRaw> {
    const build = async (): Promise<GmailMessageRaw> => {
      const action = this.#ctx.store.journal.getAction(sent.actionId);
      if (action?.type !== "draftSend" && !(action?.type === "send" && "spec" in action)) {
        throw new Error("This message was not sent.");
      }
      const {raw} = await buildPendingOutbound(
        this.#ctx.api, this.#ctx.store, action, {date: sent.info.timestamp.toUTCString()});
      // Only `raw` is read: the parsers take a stored message, and this one is not stored yet.
      return {id: "pending-send", threadId: "pending-send", internalDate: "0", raw};
    };
    const email = this.#email ??= build();
    try {
      return await email;
    } catch (error) {
      if (this.#email === email) this.#email = undefined;
      throw error;
    }
  }

  // Gmail's copy, which alone can be changed, answered or forwarded.
  #deliveredFor(method: string): GmailMessageStub {
    const current = this.#current();
    if ("delivered" in current) return current.delivered;
    throw new Error(`${method}() is available once this message has been delivered.`);
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const current = this.#current();
    if ("delivered" in current) return current.delivered.getMetadata();
    const {sent, overlay} = current;
    const info = await messageInfo(this.#ctx, {...sent.info, threadId: sent.threadId}, overlay);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Gmail message: ${info.subject}`),
      description: "Read sender, recipients, timestamp, subject, and labels for this message.",
    });
    admitReturnedLabels(this.#ctx, info.labels);
    return info;
  }

  async getHeaders(): Promise<GmailHeader[]> {
    const current = this.#current();
    if ("delivered" in current) return current.delivered.getHeaders();
    const headers = await this.#ctx.api.parseMessageHeaders(
      await this.#pendingEmail(current.sent));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail message headers",
      description: `Read ${headers.length} ordered headers from this message.`,
    });
    return headers;
  }

  async thread(): Promise<GmailThread> {
    const current = this.#current();
    if ("delivered" in current) return current.delivered.thread();
    const threadId = current.sent.threadId;
    if (threadId === undefined) {
      throw new Error("thread() is available once this message has been delivered.");
    }
    if (!this.#ctx.restricted) return new GmailThreadStub(this.#ctx, threadId, GMAIL_MAILBOX_SCOPE);
    // A restricted binding sees its own reply in the thread only through the capability opened
    // from that reply, as it does once the reply is delivered. The scope admits the reply by the
    // only ID it has, next to whatever the restriction admits of the thread. That may be
    // nothing, if the message replied to no longer matches.
    const matching = await restrictedThreadMessageIds(this.#ctx, threadId);
    const scope = matching.length
      ? await restrictedThreadScope(this.#ctx, threadId, [], matching)
      : gmailRestrictedScope([]);
    return new GmailThreadStub(this.#ctx, threadId, gmailRestrictedScope([
      ...(scope.kind === "restricted" ? scope.admittedMessageIds : []), this.#rfcMessageId,
    ]));
  }

  async getContent(): Promise<EmailContent> {
    const current = this.#current();
    if ("delivered" in current) return current.delivered.getContent();
    const {content} = await this.#ctx.api.parseMessage(await this.#pendingEmail(current.sent));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeTitle(`Read Gmail message: ${current.sent.info.subject}`),
      description: "Read the plain-text and HTML representations of this message.",
    });
    return content;
  }

  async attachments(): Promise<GmailAttachmentEntry[]> {
    const current = this.#current();
    if ("delivered" in current) return current.delivered.attachments();
    const parsed = await parseSafeGmailDraft(await this.#pendingEmail(current.sent));
    const attachments = parsed.attachments.map(attachment => {
      const data = attachment.data.replace(/\s/g, "");
      const size = atob(data).length;
      const contentId = attachment.contentId?.replace(/^<|>$/g, "");
      const info: GmailAttachmentInfo = {
        filename: attachment.filename || null,
        mimeType: attachment.contentType,
        size,
        disposition: attachment.disposition ?? null,
        ...(contentId ? {contentId} : {}),
        readable: size <= MAX_GMAIL_ATTACHMENT_BYTES,
      };
      return {info, data};
    });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List ${attachments.length} Gmail attachments`,
      description: "Read attachment and inline MIME-part metadata for this message.",
    });
    return attachments.map(({info, data}) => ({
      info,
      attachment: new GmailAttachmentStub(this.#ctx, info, async () => {
        const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
        return bytes.buffer as ArrayBuffer;
      }),
    }));
  }

  async reply(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#deliveredFor("reply").reply(body, options);
  }

  async replyAll(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#deliveredFor("replyAll").replyAll(body, options);
  }

  async forward(to: string[], body?: string, options?: GmailComposeOptions): Promise<string> {
    return this.#deliveredFor("forward").forward(to, body, options);
  }

  async createReplyDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#deliveredFor("createReplyDraft").createReplyDraft(body, options);
  }

  async createReplyAllDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#deliveredFor("createReplyAllDraft").createReplyAllDraft(body, options);
  }

  async createForwardDraft(
      to: string[], body?: string, options?: GmailComposeOptions): Promise<GmailDraft> {
    return this.#deliveredFor("createForwardDraft").createForwardDraft(to, body, options);
  }

  async archive(): Promise<void> { await this.#deliveredFor("archive").archive(); }
  async trash(): Promise<void> { await this.#deliveredFor("trash").trash(); }
  async markRead(): Promise<void> { await this.#deliveredFor("markRead").markRead(); }
  async markUnread(): Promise<void> { await this.#deliveredFor("markUnread").markUnread(); }
  async star(): Promise<void> { await this.#deliveredFor("star").star(); }
  async unstar(): Promise<void> { await this.#deliveredFor("unstar").unstar(); }
  @skipRpcValidation()
  async applyLabel(label: GmailMutableLabel): Promise<void> {
    await this.#deliveredFor("applyLabel").applyLabel(label);
  }
  @skipRpcValidation()
  async removeLabel(label: GmailMutableLabel): Promise<void> {
    await this.#deliveredFor("removeLabel").removeLabel(label);
  }

  [Symbol.dispose](): void {
    this.#delivered?.[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}

@validateRpc()
export class GmailAttachmentStub extends ApprovalQueueRpcTarget implements GmailAttachment {
  #ctx: GmailContext;
  #info: GmailAttachmentInfo;
  #read: () => Promise<ArrayBuffer>;
  #validate?: () => void;

  constructor(
      ctx: GmailContext, info: GmailAttachmentInfo, read: () => Promise<ArrayBuffer>,
      validate?: () => void) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#info = info;
    this.#read = read;
    this.#validate = validate;
  }

  async getMetadata(): Promise<GmailAttachmentInfo> {
    this.#validate?.();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail attachment metadata",
      description: "Read filename, MIME type, size, disposition, and availability.",
    });
    this.#validate?.();
    return this.#info;
  }

  async getContent(): Promise<ArrayBuffer> {
    this.#validate?.();
    if (!this.#info.readable || this.#info.size > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment is unavailable or exceeds the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe limit.`);
    }
    const content = await this.#read();
    this.#validate?.();
    if (content.byteLength !== this.#info.size || content.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error("Attachment no longer matches the authorized snapshot.");
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail attachment content",
      description: `Read ${content.byteLength} bytes from this snapshot-bound MIME part.`,
    });
    this.#validate?.();
    return content;
  }
}

@validateRpc()
export class GmailDraftAttachmentStub extends GmailAttachmentStub implements GmailDraftAttachment {
  #remove: () => Promise<void>;

  constructor(
      ctx: GmailContext, info: GmailAttachmentInfo, read: () => Promise<ArrayBuffer>,
      validate: () => void, remove: () => Promise<void>) {
    super(ctx, info, read, validate);
    this.#remove = remove;
  }

  async remove(): Promise<void> {
    await this.#remove();
  }
}

// ── Hook delivery ───────────────────────────────────────────────────

/**
 * What a hook's delivery stub restores to: one firing at a time, of a message only if it is new
 * mail the binding would list (in the hook's thread, for a thread hook).
 */

@validateRpc()
export class GmailHookDeliveryImpl extends RpcTarget implements GmailHookDelivery {
  constructor(
    private readonly params: GmailHookParams,
    private readonly readContext: () => Promise<GmailReadContext>,
    private readonly context: (read: GmailReadContext, approvalQueue: RpcStub<ApprovalQueue>) => GmailContext,
  ) {
    super();
  }

  async deliver(callback: RpcStub<GmailMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                messageId: string): Promise<void> {
    if (!GMAIL_PROVIDER_ID_RE.test(messageId)) throw new TypeError("Invalid Gmail message ID.");
    const {threadId} = this.params;
    // Re-checks the pinned account and the bound label, as opening a session does.
    const read = await this.readContext();
    let metadata: GmailMessageFull;
    try {
      metadata = await read.api.getMessageMetadata(messageId);
    } catch (error) {
      // Deleted since it arrived.
      if (error instanceof GoogleApiError && error.status === 404) return;
      throw error;
    }
    if (metadata.id !== messageId) throw new Error("Gmail message identity changed unexpectedly.");
    const provider = parseGmailMessageMetadata(metadata);
    if (provider.labelIds.some(label => UNDELIVERED_GMAIL_LABELS.includes(label))) return;
    if (threadId !== undefined && provider.threadId !== threadId) return;
    const overlay = loadGmailOverlay(read.store);
    if (overlay.hiddenMessageIds.has(messageId)) return;
    // The same admission as listMessages(): the inbox, or the bound label.
    const labels = await currentLabels(read);
    if (!messageMayMatch(overlayMessageInfo(overlay, provider, labels.resources).labelIds,
        listRequest(read, threadId === undefined).predicates)) {
      return;
    }

    // Only now, so a skipped message takes no reference to the approval queue.
    const ctx = this.context(read, approvalQueue);
    const scope = ctx.restricted ? gmailRestrictedScope([messageId]) : GMAIL_MAILBOX_SCOPE;
    const message = new GmailMessageStub(ctx, messageId, provider.threadId, scope, undefined, provider);
    let info: GmailMessageInfo;
    try {
      info = await messageInfo(ctx, provider, overlay, labels);
      await ctx.approvalQueue.authorizeObservation({
        title: sanitizeTitle(`New Gmail message: ${info.subject}`),
        description: "Read the sender, recipients, timestamp, subject, and labels of a new message this hook watches for.",
      });
    } catch (error) {
      message[Symbol.dispose]();
      throw error;
    }
    admitReturnedLabels(ctx, info.labels);
    await callback.receiveMessage({info, message});
  }
}

