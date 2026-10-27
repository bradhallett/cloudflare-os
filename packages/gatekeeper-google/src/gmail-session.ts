/**
 * Session surface for the Gmail gatekeeper.
 */

import type { GmailMessageHookTarget } from "./gmail-hooks";
import { gmailFullThreadCursor, gmailMessageCursor, gmailRestrictedThreadCursor } from "./gmail-cursors";
import { GmailDraftStub, createDraftFromMessage, gmailDraftCursor, loadSimulatedDraft } from "./gmail-draft-stubs";
import { describeOutboundMessage, outboundSpec } from "./gmail-drafts";
import { dependenciesFor, loadGmailOverlay, submitAction, submitSendAction } from "./gmail-journal";
import { SYSTEM_LABELS, ensureLabelResource, resolveMutableLabel } from "./gmail-labels";
import { GMAIL_LOGICAL_ID_RE, GMAIL_PROVIDER_ID_RE, GmailContext, currentLabels, listRequest, messageStillAvailable, restrictedThreadMessageIds, restrictedThreadScope, sourceStillAvailable, threadInfo } from "./gmail-list";
import { GMAIL_MAILBOX_SCOPE, GmailCapabilityScope, gmailRestrictedScope } from "./gmail-scope";
import { CanonicalMutableLabel, GmailLabelResource, newGmailLogicalId } from "./gmail-state";
import { GmailMessageStub, GmailPendingMessageStub, GmailThreadStub } from "./gmail-stubs";
import { validateGmailLabelName, validateOutboundFields } from "./gmail-validate";
import { GmailMessageFull, gmailMessageIdQueryValue, parseGmailMessageMetadata } from "./google-api";
import { GoogleApiError } from "./google-response";
import { ApprovalQueueRpcTarget } from "./shared-approval-queue";
import type { EmailAddress, GmailComposeOptions, GmailCustomLabel, GmailDraft, GmailDraftEntry, GmailDraftInput, GmailLabel, GmailMessage, GmailMessageEntry, GmailScopedSession, GmailSession, GmailSystemLabel, GmailThread, GmailThreadEntry } from "./types";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { validateRpc } from "capnweb-validate";
import { RpcStub } from "cloudflare:workers";

@validateRpc()
export class GmailSessionImpl extends ApprovalQueueRpcTarget implements GmailSession {
  #ctx: GmailContext;

  constructor(ctx: GmailContext) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
  }

  async getMailboxAddress(): Promise<EmailAddress> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail mailbox address",
      description: "Read the email address of the connected Gmail mailbox.",
    });
    return {address: this.#ctx.selfEmail};
  }

  /** Cursor creation discloses nothing; each page authorizes its own observation when fetched. */
  async listThreads(): Promise<Cursor<GmailThreadEntry>> {
    const request = listRequest(this.#ctx, true);
    return this.#ctx.restricted
      ? gmailRestrictedThreadCursor(this.#ctx, request)
      : gmailFullThreadCursor(this.#ctx, request);
  }

  async searchThreads(query: string): Promise<Cursor<GmailThreadEntry>> {
    const request = listRequest(this.#ctx, false, query);
    return this.#ctx.restricted
      ? gmailRestrictedThreadCursor(this.#ctx, request)
      : gmailFullThreadCursor(this.#ctx, request);
  }

  async search(query: string): Promise<Cursor<GmailThreadEntry>> {
    return this.searchThreads(query);
  }

  async listMessages(): Promise<Cursor<GmailMessageEntry>> {
    return gmailMessageCursor(
      this.#ctx, listRequest(this.#ctx, true),
      this.#ctx.restricted ? gmailRestrictedScope([]) : GMAIL_MAILBOX_SCOPE);
  }

  async searchMessages(query: string): Promise<Cursor<GmailMessageEntry>> {
    return gmailMessageCursor(
      this.#ctx, listRequest(this.#ctx, false, query),
      this.#ctx.restricted ? gmailRestrictedScope([]) : GMAIL_MAILBOX_SCOPE);
  }

  /**
   * getMessage/getThread/getDraft record no observation: the caller already holds an opaque,
   * high-entropy ID, so confirming it exists tells them nothing. The stub's reads log themselves.
   */
  async getMessage(id: string): Promise<GmailMessage> {
    let providerId = id;
    let sentThroughBinding = false;
    if (GMAIL_PROVIDER_ID_RE.test(providerId)) {
      sentThroughBinding = this.#ctx.store.journal.isSentMessage(providerId);
    } else {
      let normalizedId: string;
      try {
        normalizedId = `<${gmailMessageIdQueryValue(id)}>`;
      } catch {
        throw new Error("Invalid Gmail message ID.");
      }
      const receipt = this.#ctx.store.journal.sentMessageByRfcMessageId(normalizedId);
      if (!receipt) {
        // Mail this binding is still waiting to send: Gmail has no ID for it to be opened by.
        if (loadGmailOverlay(this.#ctx.store).sent.some(
            sent => sent.rfcMessageId === normalizedId)) {
          return new GmailPendingMessageStub(this.#ctx, normalizedId);
        }
        throw new Error("Unknown Gmail message ID.");
      }
      providerId = receipt.providerId;
      sentThroughBinding = true;
    }
    if (!sentThroughBinding && !await messageStillAvailable(this.#ctx, providerId)) {
      throw new Error("This Gmail message is not available through this restricted binding.");
    }
    let metadata: GmailMessageFull;
    try {
      metadata = await this.#ctx.api.getMessageMetadata(providerId);
    } catch (error) {
      if (this.#ctx.restricted && error instanceof GoogleApiError && error.status === 404) {
        throw new Error(
          "This Gmail message is not available through this restricted binding.", {cause: error});
      }
      throw error;
    }
    if (metadata.id !== providerId) throw new Error("Gmail message identity changed unexpectedly.");
    const info = parseGmailMessageMetadata(metadata);
    const scope = this.#ctx.restricted ? gmailRestrictedScope([providerId]) : GMAIL_MAILBOX_SCOPE;
    return new GmailMessageStub(this.#ctx, providerId, info.threadId, scope, undefined, info);
  }

  async getThread(id: string): Promise<GmailThread> {
    if (!GMAIL_PROVIDER_ID_RE.test(id)) throw new Error("Invalid Gmail thread ID.");
    if (!this.#ctx.restricted) {
      const overlay = loadGmailOverlay(this.#ctx.store);
      const info = await threadInfo(
        this.#ctx, await this.#ctx.api.getThreadMetadata(id), overlay, GMAIL_MAILBOX_SCOPE);
      return new GmailThreadStub(
        this.#ctx, id, GMAIL_MAILBOX_SCOPE, {info, generation: overlay.generation});
    }
    const admitted = await restrictedThreadMessageIds(this.#ctx, id);
    if (!admitted.length) {
      throw new Error("This Gmail thread is not available through this restricted binding.");
    }
    let scope: GmailCapabilityScope;
    try {
      scope = await restrictedThreadScope(this.#ctx, id, [], admitted);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        throw new Error(
          "This Gmail thread is not available through this restricted binding.", {cause: error});
      }
      throw error;
    }
    return new GmailThreadStub(this.#ctx, id, scope);
  }

  async send(
      to: string[], subject: string, body: string, options: GmailComposeOptions = {}): Promise<string> {
    if (this.#ctx.restricted) {
      throw new Error(
        "send() is unavailable on a search- or label-scoped binding. Use a message capability.");
    }
    const message = this.#ctx.api.buildSendRaw(to, subject, body, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    await submitSendAction(this.#ctx, {
      type: "send",
      mode: "new",
      spec: outboundSpec(message, []),
      submittedAt: Date.now(),
    }, {
      title: sanitizeTitle(`Send email: ${message.subject}`),
      ...(await describeOutboundMessage("Send a new email.", message)).finish(),
    }, options.attachments);
    return message.messageId;
  }

  async listDrafts(): Promise<Cursor<GmailDraftEntry>> {
    return gmailDraftCursor(this.#ctx);
  }

  async getDraft(id: string): Promise<GmailDraft> {
    if (!GMAIL_LOGICAL_ID_RE.test(id)) throw new Error("Invalid Gmail draft ID.");
    const resource = this.#ctx.store.drafts.getDraft(id);
    if (!resource) throw new Error("Unknown Gmail draft ID for this binding.");
    if (this.#ctx.restricted &&
        (!resource.source || !await sourceStillAvailable(this.#ctx, resource.source))) {
      throw new Error("This Gmail draft is not available through this restricted binding.");
    }
    const {state} = await loadSimulatedDraft(this.#ctx, resource.logicalId);
    return new GmailDraftStub(this.#ctx, state.logicalId);
  }

  async subscribeNewMessages(hook: RpcStub<GmailMessageHookTarget>): Promise<void> {
    await this.#ctx.subscribe(undefined, hook);
  }

  async createDraft(input: GmailDraftInput): Promise<GmailDraft> {
    if (this.#ctx.restricted) {
      throw new Error("createDraft() is only available on a whole-mailbox Gmail binding.");
    }
    const message = this.#ctx.api.buildSendRaw(
      input.to ?? [], input.subject ?? "", input.text ?? "", input);
    return createDraftFromMessage(this.#ctx, message, {uploads: input.attachments});
  }

  async listLabels(): Promise<GmailLabel[]> {
    if (this.#ctx.restricted) {
      throw new Error("listLabels() is only available on a whole-mailbox Gmail binding.");
    }
    const labels = await currentLabels(this.#ctx);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Gmail labels",
      description: `Read ${labels.labels.length} system and custom Gmail labels.`,
    });
    return labels.labels.filter(label => label.type === "user" || SYSTEM_LABELS.has(label.id))
      .map(label => label.type === "system"
      ? {id: label.id, name: label.name as GmailSystemLabel, type: "system" as const}
      : {id: label.id, name: label.name, type: "custom" as const});
  }

  async createLabel(name: string): Promise<GmailCustomLabel> {
    if (this.#ctx.restricted) {
      throw new Error("createLabel() is only available on a whole-mailbox Gmail binding.");
    }
    validateGmailLabelName(name);
    const existing = (await currentLabels(this.#ctx)).labels.some(
      label => label.type === "user" && label.name === name);
    if (existing) throw new Error("A Gmail label with this name already exists.");
    const logicalId = newGmailLogicalId("label");
    const resource: GmailLabelResource = {logicalId, name, status: "active"};
    this.#ctx.store.labels.putLabel(resource);
    await submitAction(this.#ctx, {type: "labelCreate", label: resource}, {
      title: sanitizeTitle(`Create Gmail label: ${name}`),
      ...buildDescription("Create a Gmail label.").inline("New label", name).finish(),
    }, () => this.#ctx.store.labels.deleteLabel(logicalId));
    return {id: logicalId, name, type: "custom"};
  }

  async renameLabel(label: GmailCustomLabel, name: string): Promise<GmailCustomLabel> {
    if (this.#ctx.restricted) {
      throw new Error("renameLabel() is only available on a whole-mailbox Gmail binding.");
    }
    validateGmailLabelName(name);
    let generation: number;
    let canonical: CanonicalMutableLabel;
    do {
      generation = this.#ctx.store.journal.actionGeneration();
      canonical = await resolveMutableLabel(this.#ctx, label);
    } while (generation !== this.#ctx.store.journal.actionGeneration());
    if (canonical.type !== "custom") throw new Error("System Gmail labels cannot be renamed.");
    const resource = ensureLabelResource(this.#ctx, canonical);
    const dependencies = dependenciesFor(this.#ctx.store, resource.logicalId, "label");
    await submitAction(this.#ctx, {
      type: "labelRename", labelId: resource.logicalId, name,
      expectedName: canonical.name, dependsOn: dependencies,
    }, {
      title: sanitizeTitle(`Rename Gmail label: ${canonical.name}`),
      ...buildDescription("Rename a Gmail label.")
        .inline("Current name", canonical.name).inline("New name", name).finish(),
    });
    return {id: resource.logicalId, name, type: "custom"};
  }

  async deleteLabel(label: GmailCustomLabel): Promise<void> {
    if (this.#ctx.restricted) {
      throw new Error("deleteLabel() is only available on a whole-mailbox Gmail binding.");
    }
    const canonical = await resolveMutableLabel(this.#ctx, label);
    if (canonical.type !== "custom") throw new Error("System Gmail labels cannot be deleted.");
    const resource = ensureLabelResource(this.#ctx, canonical);
    const pendingUses = this.#ctx.store.journal.listActions().filter(item =>
      item.action.type === "messageMutation" && item.action.labelId === resource.logicalId);
    if (pendingUses.length) {
      throw new Error(
        "Resolve pending message actions that use this Gmail label before deleting it.");
    }
    await submitAction(this.#ctx, {
      type: "labelDelete",
      labelId: resource.logicalId,
      dependsOn: dependenciesFor(this.#ctx.store, resource.logicalId, "label"),
    }, {
      title: sanitizeTitle(`Delete Gmail label: ${canonical.name}`),
      ...buildDescription("Delete a Gmail label.").inline("Label", canonical.name).finish(),
    });
  }
}

@validateRpc()
export class GmailScopedSessionImpl extends ApprovalQueueRpcTarget implements GmailScopedSession {
  #mailbox: GmailSessionImpl;

  constructor(ctx: GmailContext) {
    super(ctx.approvalQueue);
    this.#mailbox = new GmailSessionImpl(ctx);
  }

  getMailboxAddress(): Promise<EmailAddress> { return this.#mailbox.getMailboxAddress(); }
  listThreads(): Promise<Cursor<GmailThreadEntry>> { return this.#mailbox.listThreads(); }
  searchThreads(query: string): Promise<Cursor<GmailThreadEntry>> {
    return this.#mailbox.searchThreads(query);
  }
  search(query: string): Promise<Cursor<GmailThreadEntry>> { return this.#mailbox.search(query); }
  listMessages(): Promise<Cursor<GmailMessageEntry>> { return this.#mailbox.listMessages(); }
  searchMessages(query: string): Promise<Cursor<GmailMessageEntry>> {
    return this.#mailbox.searchMessages(query);
  }
  getMessage(id: string): Promise<GmailMessage> { return this.#mailbox.getMessage(id); }
  getThread(id: string): Promise<GmailThread> { return this.#mailbox.getThread(id); }
  listDrafts(): Promise<Cursor<GmailDraftEntry>> { return this.#mailbox.listDrafts(); }
  getDraft(id: string): Promise<GmailDraft> { return this.#mailbox.getDraft(id); }
  subscribeNewMessages(hook: RpcStub<GmailMessageHookTarget>): Promise<void> {
    return this.#mailbox.subscribeNewMessages(hook);
  }

  [Symbol.dispose](): void {
    this.#mailbox[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}

