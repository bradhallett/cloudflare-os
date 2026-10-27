/**
 * Gmail gatekeeper durable object: tokens, sessions, and the applyAction pipeline.
 */
import { GMAIL_PROVIDER_ID_RE } from "./gmail-list";

import { buildPendingOutbound } from "./gmail-apply";
import { parseSafeGmailDraft } from "./gmail-drafts";
import { GmailContext } from "./gmail-list";


import {validateRpc} from "capnweb-validate";
import {DurableObject, RpcStub, restore} from "cloudflare:workers";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier,
  GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  getGoogleAccountDescription, getGoogleAccountSubject, GmailApi,
  GmailDraftRaw,
} from "./google-api";
import { GoogleApiError } from "./google-response";
import type {
  GmailScopedSession, GmailSession,
} from "./types";
import {
  validateGmailLabelName, validateGmailQueryForGrouping,
} from "./gmail-validate";
import {
  gmailDraftFingerprint,
  isVersionedGmailFingerprint,
} from "./gmail-state";
import {
  plainInline,
} from "@gadgets/gatekeeper-kit/action-description";
import {AccessTokenCache, AccessTokenRequest} from "./auth-retry";
import {SharedApprovalQueue} from "./shared-approval-queue";
import {
  type GmailHookDelivery, type GmailHookParams, type GmailMessageHookTarget,
} from "./gmail-hooks";
import {gmailHooksConfigured, type PushHooksEnv} from "./pubsub-push";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & PushHooksEnv;

export type GmailGatekeeperImplProps = {
  userObjectId: string;
  searchQuery?: string;
  labelName?: string;
};

@validateRpc()
export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailScopedSession | GmailSession> {
  #applying = new Set<number>();
  #verifiedToken?: string;
  #subjectToken?: string;
  #tokenSubject?: string;
  #tokens = new AccessTokenCache(opts => {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  async #getTokenSubject(token: string): Promise<string> {
    if (token !== this.#subjectToken) {
      this.#tokenSubject = await getGoogleAccountSubject(token);
      this.#subjectToken = token;
    }
    return this.#tokenSubject!;
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    const token = await this.#tokens.get(opts);
    if (token !== this.#verifiedToken) {
      const pinned = this.ctx.storage.kv.get<string>("gmail:accountSubject");
      if (pinned && pinned !== await this.#getTokenSubject(token)) {
        throw new Error(
          "This Gmail binding belongs to a different Google account. Reconnect the original account.");
      }
      this.#verifiedToken = token;
    }
    return token;
  }

  async #getSelfEmail(): Promise<string> {
    const cached = this.ctx.storage.kv.get<string>("selfEmail");
    const token = await this.#getAccessToken();
    const [subject, description] = await Promise.all([
      this.#getTokenSubject(token), getGoogleAccountDescription(token),
    ]);
    if (!description.uniqueName) throw new Error("Google account has no email address.");
    const pinned = this.ctx.storage.kv.get<string>("gmail:accountSubject");
    if (pinned && pinned !== subject) {
      throw new Error(
        "This Gmail binding belongs to a different Google account. Reconnect the original account.");
    }
    // Legacy bindings predate subject pinning. Verify their last known email once before adopting
    // a stable subject; after that, Workspace primary-email renames are safe to accept.
    if (!pinned && cached && cached.toLowerCase() !== description.uniqueName.toLowerCase()) {
      throw new Error(
        "This Gmail binding belongs to a different Google account. Reconnect the original account.");
    }
    if (!pinned) this.ctx.storage.kv.put("gmail:accountSubject", subject);
    this.ctx.storage.kv.put("selfEmail", description.uniqueName);
    return description.uniqueName;
  }

  async #resolveBindingLabel(api: GmailApi): Promise<{id?: string; name?: string}> {
    if (this.ctx.props.labelName === undefined) return {};
    validateGmailLabelName(this.ctx.props.labelName);
    const labels = await api.listLabelRecords();
    const storedId = this.ctx.storage.kv.get<string>("gmail:bindingLabelId");
    if (storedId) {
      const label = labels.find(item => item.id === storedId);
      if (!label) {
        throw new Error(
          "The Gmail label bound to this connection no longer exists. Reconnect a label explicitly.");
      }
      return {id: storedId, name: label.name};
    }
    const label = labels.find(item => item.name === this.ctx.props.labelName);
    if (!label) throw new Error(`Gmail label not found: ${this.ctx.props.labelName}`);
    // Once recorded, a rename/delete/recreate by name can never retarget this binding.
    this.ctx.storage.kv.put("gmail:bindingLabelId", label.id);
    return {id: label.id, name: label.name};
  }

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.labelName !== undefined) {
      validateGmailLabelName(this.ctx.props.labelName);
      return {
        url: `https://mail.google.com/mail/#label/${encodeURIComponent(this.ctx.props.labelName)}`,
        title: `Gmail label: ${this.ctx.props.labelName}`,
        snippet: `Gmail messages with label: ${this.ctx.props.labelName}`,
        suggestedBindingName: "GMAIL_LABEL",
        tsType: "GmailScopedSession",
        hookTsType: "GmailMessageHook",
      };
    }
    if (this.ctx.props.searchQuery !== undefined) {
      validateGmailQueryForGrouping(this.ctx.props.searchQuery);
      return {
        url: `https://mail.google.com/mail/#search/${encodeURIComponent(this.ctx.props.searchQuery)}`,
        title: `Gmail: ${this.ctx.props.searchQuery}`,
        snippet: "Gmail messages matching the connected search",
        suggestedBindingName: "GMAIL_SEARCH",
        tsType: "GmailScopedSession",
      };
    }
    return {
      url: "https://mail.google.com/mail/",
      title: "Gmail Inbox",
      snippet: "Your personal Gmail inbox",
      suggestedBindingName: "GMAIL_INBOX",
      tsType: "GmailSession",
      hookTsType: "GmailMessageHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [...actionKinds(MESSAGE_MUTATION_LABELS), ...actionKinds(RESOURCE_ACTION_LABELS)];
  }

  async startSession(
      approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GmailScopedSession | GmailSession> {
    const ctx = this.#context(await this.#readContext(), approvalQueue);
    return ctx.restricted ? new GmailScopedSessionImpl(ctx) : new GmailSessionImpl(ctx);
  }

  [restore](params: GmailHookParams): GmailHookDelivery {
    // The binding's own props decide admission; `params` can only narrow it to a thread.
    if (params.threadId !== undefined && !GMAIL_PROVIDER_ID_RE.test(params.threadId)) {
      throw new TypeError("Invalid Gmail thread ID.");
    }
    return new GmailHookDeliveryImpl(
      params, () => this.#readContext(), (read, approvalQueue) => this.#context(read, approvalQueue));
  }

  async #readContext(): Promise<GmailReadContext> {
    if (this.ctx.props.searchQuery !== undefined) {
      validateGmailQueryForGrouping(this.ctx.props.searchQuery);
    }
    const selfEmail = await this.#getSelfEmail();
    const api = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));
    const bindingLabel = await this.#resolveBindingLabel(api);
    return {
      api,
      store: newGmailStore(this.ctx.storage),
      selfEmail,
      searchQuery: this.ctx.props.searchQuery,
      labelId: bindingLabel.id,
      labelName: bindingLabel.name,
      restricted: this.ctx.props.searchQuery !== undefined || bindingLabel.id !== undefined,
      providerLabels: () => api.listLabelRecords(),
    };
  }

  #context(read: GmailReadContext, approvalQueue: RpcStub<ApprovalQueue>): GmailContext {
    const ctx: GmailContext = {
      ...read,
      approvalQueue: new SharedApprovalQueue(approvalQueue.dup()),
      subscribe: (threadId, hook) => this.#subscribe(ctx, threadId, hook),
    };
    return ctx;
  }

  async #subscribe(
      ctx: GmailContext, threadId: string | undefined, hook: RpcStub<GmailMessageHookTarget>): Promise<void> {
    if (!gmailHooksConfigured(this.env)) throw new Error("Gmail hooks are not configured on this deployment.");
    if (ctx.searchQuery !== undefined) {
      throw new Error(
        "A Gmail search binding can't be watched for new mail. Connect the inbox or a label instead.");
    }
    const {emailAddress} = await ctx.api.getProfile();
    const params: GmailHookParams = threadId === undefined ? {} : {threadId};
    using delivery: RpcStub<GmailHookDelivery> = await this.ctx.restore(params);
    const controller = this.ctx.exports.GmailHookController({props: {
      ...params,
      key: crypto.randomUUID(),
      mailbox: emailAddress.toLowerCase(),
      userObjectId: this.ctx.props.userObjectId,
      // Only the driver's prefilter: the inbox for a mailbox hook, the bound label on a label
      // binding, and nothing for a thread hook on a whole mailbox.
      labelId: threadId === undefined ? ctx.labelId ?? "INBOX" : ctx.labelId,
      delivery,
    }});
    const label = ctx.labelName === undefined ? undefined : `"${plainInline(ctx.labelName)}"`;
    const watched = threadId === undefined
      ? `received ${label ? `with the Gmail label ${label}` : "in the Gmail inbox"}`
      : `received in Gmail thread ${threadId}${label ? ` with the label ${label}` : ""}`;
    await ctx.approvalQueue.bindHook(controller, hook, {
      title: "Watch for new Gmail messages",
      description: `Call this hook with each new message ${watched}, letting it read that message ` +
        "and queue replies and changes for approval.",
    });
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    const store = newGmailStore(this.ctx.storage);
    const initialAction = store.journal.getAction(actionId);
    if (!initialAction) throw new Error(`Unknown pending Gmail action: ${actionId}`);
    if (this.#applying.has(actionId)) throw new Error(`Gmail action ${actionId} is already applying.`);
    this.#applying.add(actionId);
    try {
      const selfEmail = await this.#getSelfEmail();
      const api = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

      await reconcileDraftActionAlias(api, store, initialAction);
      const action = store.journal.getAction(actionId);
      if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);
      if ("dependsOn" in action) assertDependencies(store, action);
      if (isLegacyGmailAction(action) &&
          (action.type === "send" || action.type === "reply" || action.type === "forward")) {
        throw new Error(
          "This legacy outbound Gmail action cannot be retried safely. Inspect Sent mail to " +
          "determine whether it was delivered before rejecting or resubmitting it.");
      }
      if ((this.ctx.props.searchQuery !== undefined || this.ctx.props.labelName !== undefined) &&
          isLegacyGmailAction(action)) {
        throw new Error(
          "This legacy Gmail action cannot be applied through a restricted binding safely.");
      }

      switch (action.type) {
      case "messageMutation":
        await applyMessageMutation(api, store, actionId, action);
        break;
      case "send": {
        // Refuse inconsistent snapshot metadata on every path, including those that only
        // reconcile a send Gmail already has.
        sendSourceSnapshot(action);
        const receipt = store.journal.sentMessageByRfcMessageId(action.spec.messageId);
        if (receipt) {
          store.drafts.completeSentAction(store.journal, actionId, action.spec.messageId, {
            id: receipt.providerId,
            threadId: receipt.threadId,
          });
          return;
        }
        if (store.journal.isApplying(actionId)) {
          const existing = await api.findMessageByRfcMessageId(action.spec.messageId, "delivered");
          if (!existing) {
            throw new Error(
              "The previous Gmail send outcome is still unknown; refusing to risk duplicate delivery.");
          }
          let approvedFingerprint = store.journal.getSendFingerprint(actionId, action.spec.messageId);
          if (!approvedFingerprint) {
            approvedFingerprint = await sentMessageFingerprint(
              (await buildPendingOutbound(api, store, action)).raw, action.threadId);
            store.journal.setSendFingerprint(actionId, action.spec.messageId, approvedFingerprint);
          }
          await verifyReconciledSend(api, action, existing, approvedFingerprint);
          store.drafts.completeSentAction(store.journal, actionId, action.spec.messageId, existing);
          return;
        }
        const message = await buildPendingOutbound(api, store, action);
        store.journal.setSendFingerprint(
          actionId, action.spec.messageId,
          await sentMessageFingerprint(message.raw, action.threadId));
        const sent = await applyUncertainWrite(
          store, actionId, () => api.sendRawMessage(message.raw, action.threadId));
        store.drafts.completeSentAction(store.journal, actionId, action.spec.messageId, sent);
        return;
      }
      case "draftCreate": {
        const resource = store.drafts.getDraft(action.draft.logicalId);
        if (!resource || resource.status !== "active") {
          throw new Error("The provisional Gmail draft is no longer active.");
        }
        const approved = await approvedCreateOutput(api, store, action);
        const storedReceipt = store.journal.getDraftWriteReceipt(actionId);
        if (storedReceipt) {
          const baseline = await readDraftProviderBaseline(api, store, actionId, storedReceipt, approved);
          store.drafts.completeDraftWrite(store.journal, actionId, baseline, approved.fingerprint, storedReceipt);
          return;
        }
        if (resource.providerId) {
          const current = await api.getDraft(resource.providerId);
          const parsed = await parseSafeGmailDraft(current.message);
          const provider = {message: current.message, parsed};
          const fingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
          const {exactState, ...output} = await exactDraftOutput(api, store, approved, provider);
          if (!await holdsDraftOutput(api, store, approved, provider, fingerprint, {exactState, ...output})) {
            throw new Error(
              "The mapped Gmail draft no longer matches the approved create action.");
          }
          const receipt = {
            draftId: resource.providerId,
            messageId: current.message.id,
            threadId: current.message.threadId,
          };
          store.journal.setDraftWriteReceipt(actionId, receipt);
          store.drafts.completeDraftWrite(store.journal, actionId, {
            ...receipt,
            ...output,
            fingerprint,
            appliedAttachments: await captureDraftAttachmentIdentities(
              exactState.attachments, parsed, current.message.id),
          }, approved.fingerprint);
          return;
        }
        if (store.journal.isApplying(actionId)) {
          if (!action.draft.rfcMessageId) {
            throw new Error("The staged Gmail draft has no stable Message-ID for reconciliation.");
          }
          const existing = await api.findDraftByRfcMessageId(action.draft.rfcMessageId);
          if (!existing) {
            draftSourceSnapshot(action);
            throw new Error(
              "The previous Gmail draft creation outcome is still unknown; refusing to create a duplicate.");
          }
          const current = await api.getDraft(existing.id);
          const receipt = {
            draftId: existing.id,
            messageId: current.message.id,
            threadId: current.message.threadId,
            unverified: true as const,
          };
          store.journal.setDraftWriteReceipt(actionId, receipt);
          const parsed = await parseSafeGmailDraft(current.message);
          const provider = {message: current.message, parsed};
          const fingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
          const {exactState, ...output} = await exactDraftOutput(api, store, approved, provider);
          if (!await holdsDraftOutput(api, store, approved, provider, fingerprint, {exactState, ...output})) {
            throw new Error(
              "The reconciled Gmail draft no longer matches the approved create action.");
          }
          store.drafts.completeDraftWrite(store.journal, actionId, {
            ...receipt,
            ...output,
            fingerprint,
            appliedAttachments: await captureDraftAttachmentIdentities(
              exactState.attachments, parsed, current.message.id),
          }, approved.fingerprint);
          return;
        }
        const message = await draftWriteMessage(api, store, action.draft, approved.snapshot);
        const created = await applyUncertainWrite(
          store, actionId, () => api.createDraft(message.raw, action.draft.threadId));
        const receipt = {
          draftId: created.id,
          messageId: created.message.id,
          ...(created.message.threadId ? {threadId: created.message.threadId} : {}),
        };
        store.journal.setDraftWriteReceipt(actionId, receipt);
        const baseline = await readDraftProviderBaseline(api, store, actionId, receipt, approved);
        store.drafts.completeDraftWrite(store.journal, actionId, baseline, approved.fingerprint, receipt);
        return;
      }
      case "draftUpdate": {
        const storedReceipt = store.journal.getDraftWriteReceipt(actionId);
        if (storedReceipt?.missing) {
          store.drafts.completeMissingDraftUpdate(store.journal, actionId);
          return;
        }
        const id = providerDraftId(store, action.draftId);
        const approved = {state: action.after, snapshot: action.sourceAttachment,
          historical: !isVersionedGmailFingerprint(action.expectedBefore),
          historicalAttachments: hasHistoricalAttachments(action),
          ...(action.exactAfter ? {exactState: action.exactAfter} : {}),
          fingerprint: await draftOutputFingerprint(api, store, action.after, action.sourceAttachment)};
        if (storedReceipt) {
          const baseline = await readDraftProviderBaseline(api, store, actionId, storedReceipt, approved);
          store.drafts.completeDraftWrite(store.journal, actionId, baseline, approved.fingerprint, storedReceipt);
          store.drafts.updateDraftForwardContent(store.journal, action.draftId, action.after);
          return;
        }
        const current = await api.getDraft(id);
        const reconciling = store.journal.isApplying(actionId);
        if (!reconciling && action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to update it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        const provider = {message: current.message, parsed};
        const currentFingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
        // Re-keying fails on a drifted draft, so a fresh write must reach the fences below first.
        const reconciled = reconciling ? await exactDraftOutput(api, store, approved, provider) : undefined;
        if (reconciled ? await holdsDraftOutput(api, store, approved, provider, currentFingerprint, reconciled)
            : currentFingerprint === approved.fingerprint) {
          const {exactState, ...output} = reconciled ?? await exactDraftOutput(api, store, approved);
          store.drafts.completeMatchingDraftUpdate(store.journal, actionId, {
            draftId: id,
            messageId: current.message.id,
            fingerprint: currentFingerprint,
            ...output,
            appliedAttachments: await captureDraftAttachmentIdentities(
              exactState.attachments, parsed, current.message.id),
          }, approved.fingerprint);
          store.drafts.updateDraftForwardContent(store.journal, action.draftId, action.after);
          return;
        }
        // Gmail replaces a draft's message ID on every edit but offers no conditional write.
        // Checking both identity and content catches every stale revision visible to this preflight.
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to update it.");
        }
        if (!await matchesGmailFingerprint(current.message, action.expectedBefore, parsed)) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to apply a different update.");
        }
        // A forward's source parts come from its retained snapshot, so only other drafts re-key.
        // The write re-encodes what it re-keys, so the mapping is recorded before it can land.
        const writeState = action.exactAfter ?? (approved.historicalAttachments && !action.sourceAttachment
          ? await refreshLegacyDraftAttachments(action.after, provider) : action.after);
        if (writeState !== action.after && !action.exactAfter) {
          store.journal.recordExactDraftUpdate(actionId, writeState);
        }
        const message = await draftWriteMessage(api, store, writeState, action.sourceAttachment, provider);
        const updated = await applyUncertainWrite(
          store, actionId, () => api.updateDraft(id, message.raw, action.after.threadId));
        if (updated.id !== id) {
          throw new Error("Gmail returned a different draft after updating it.");
        }
        const receipt = {
          draftId: updated.id,
          messageId: updated.message.id,
          threadId: updated.message.threadId ?? current.message.threadId,
        };
        store.journal.setDraftWriteReceipt(actionId, receipt);
        const baseline = await readDraftProviderBaseline(
          api, store, actionId, receipt, {...approved, exactState: writeState});
        store.drafts.completeDraftWrite(store.journal, actionId, baseline, approved.fingerprint, receipt);
        store.drafts.updateDraftForwardContent(store.journal, action.draftId, action.after);
        return;
      }
      case "draftDelete": {
        const existing = store.drafts.getDraft(action.draftId);
        if (store.journal.isApplying(actionId) && existing?.status === "deleted") break;
        const reconciling = store.journal.isApplying(actionId);
        const id = providerDraftId(store, action.draftId);
        let current: GmailDraftRaw;
        try {
          current = await api.getDraft(id);
        } catch (error) {
          if (!(error instanceof GoogleApiError && error.status === 404)) {
            throw error;
          }
          const resource = store.drafts.getDraft(action.draftId);
          if (!resource) {
            throw new Error(
              "The Gmail draft resource disappeared while being deleted.", {cause: error});
          }
          resource.status = "deleted";
          resource.version++;
          store.drafts.putDraft(store.journal, resource);
          store.drafts.clearDraftForwardSnapshot(store.journal, action.draftId);
          store.journal.clearApplying(actionId);
          break;
        }
        if (current.id !== id) throw new Error("Gmail returned a different draft during deletion.");
        // A successful GET of this exact draft proves the earlier DELETE did not complete.
        if (reconciling) store.journal.clearApplying(actionId);
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to delete it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        if (!await matchesGmailFingerprint(current.message, action.expectedSnapshot, parsed)) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to delete a different revision.");
        }
        try {
          await applyUncertainWrite(store, actionId, () => api.deleteDraft(id));
        } catch (error) {
          if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
        }
        const resource = store.drafts.getDraft(action.draftId)!;
        resource.status = "deleted";
        resource.version++;
        store.drafts.putDraft(store.journal, resource);
        store.drafts.clearDraftForwardSnapshot(store.journal, action.draftId);
        break;
      }
      case "draftSend": {
        const resource = store.drafts.getDraft(action.draftId)!;
        const receipt = action.messageId
          ? store.journal.sentMessageByRfcMessageId(action.messageId)
          : undefined;
        if (receipt) {
          store.drafts.completeSentAction(store.journal, actionId, action.messageId!, {
            id: receipt.providerId,
            threadId: receipt.threadId,
          });
          return;
        }
        if (store.journal.isApplying(actionId)) {
          const sent = action.messageId
            ? await api.findMessageByRfcMessageId(action.messageId, "delivered")
            : undefined;
          if (!sent) {
            throw new Error(
              "The previous Gmail draft send outcome is still unknown; refusing to risk duplicate delivery.");
          }
          const sentMessage = await api.getMessage(sent.id);
          if (sentMessage.id !== sent.id ||
              (action.approved.threadId !== undefined &&
               sentMessage.threadId !== action.approved.threadId)) {
            throw new Error(
              "A delivered Gmail message matched the approved Message-ID but not the approved draft.");
          }
          const sentParsed = await parseSafeGmailDraft(sentMessage);
          let approvedOutputFingerprint = store.journal.getSendFingerprint(actionId, action.messageId!);
          if (!approvedOutputFingerprint) {
            approvedOutputFingerprint = await draftOutputFingerprint(
              api, store, action.exactApproved ?? action.approved, action.sourceAttachment);
            store.journal.setSendFingerprint(actionId, action.messageId!, approvedOutputFingerprint);
          }
          if (!await matchesGmailFingerprint(sentMessage, approvedOutputFingerprint, sentParsed)) {
            throw new Error(
              "A delivered Gmail message matched the approved Message-ID but had different content.");
          }
          store.drafts.completeSentAction(store.journal, actionId, action.messageId!, sent);
          return;
        }
        const id = providerDraftId(store, action.draftId);
        const current = await api.getDraft(id);
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to send it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        if (!await matchesGmailFingerprint(current.message, action.expectedSnapshot, parsed)) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to send different content.");
        }
        const approved = await buildPendingOutbound(
          api, store, action, {draft: {message: current.message, parsed}});
        if (action.messageId) {
          store.journal.setSendFingerprint(
            actionId, action.messageId,
            await sentMessageFingerprint(approved.raw, action.approved.threadId));
        }
        const sent = await applyUncertainWrite(
          store, actionId, () => api.sendDraft(id, approved.raw, action.approved.threadId));
        if (action.messageId) {
          store.drafts.completeSentAction(store.journal, actionId, action.messageId, sent);
          return;
        }
        resource.status = "sent";
        resource.version++;
        store.drafts.putDraft(store.journal, resource);
        store.drafts.clearDraftForwardSnapshot(store.journal, action.draftId);
        break;
      }
      case "labelCreate": {
        const resource = store.labels.getLabel(action.label.logicalId);
        if (!resource || resource.status !== "active") {
          throw new Error("The provisional Gmail label is no longer active.");
        }
        if (resource.providerId) {
          const existing = (await api.listLabelRecords()).find(
            label => label.id === resource.providerId && label.type === "user");
          if (!existing || existing.name !== resource.name) {
            throw new Error("The mapped Gmail label no longer matches its approved creation.");
          }
          break;
        }
        if (store.journal.isApplying(actionId)) {
          const matches = (await api.listLabelRecords()).filter(
            label => label.type === "user" && label.name === action.label.name);
          if (matches.length !== 1) {
            throw new Error(
              "The previous Gmail label creation outcome is unknown; refusing to map or create a label.");
          }
          store.labels.mapLabelToProvider(store.journal, actionId, matches[0]);
          break;
        }
        const created = await applyUncertainWrite(
          store, actionId, () => api.createLabel(action.label.name));
        store.labels.mapLabelToProvider(store.journal, actionId, created);
        break;
      }
      case "labelRename": {
        const id = providerLabelId(store, action.labelId);
        const current = await api.getLabel(id);
        if (current.type !== "user") throw new Error("Only custom Gmail labels can be renamed.");
        if (current.name !== action.name) {
          if (current.name !== action.expectedName) {
            throw new Error(
              "The Gmail label changed outside this approval sequence; refusing to rename it.");
          }
          const renamed = await applyUncertainWrite(
            store, actionId, () => api.renameLabel(id, action.name));
          if (renamed.name !== action.name) {
            throw new Error("Gmail returned a different label name after renaming it.");
          }
        }
        const resource = store.labels.getLabel(action.labelId);
        if (resource) {
          resource.name = action.name;
          store.labels.putLabel(resource);
        }
        break;
      }
      case "labelDelete": {
        const id = providerLabelId(store, action.labelId);
        try {
          await applyUncertainWrite(store, actionId, () => api.deleteLabel(id));
        } catch (error) {
          if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
        }
        const resource = store.labels.getLabel(action.labelId);
        if (resource) {
          resource.status = "deleted";
          store.labels.putLabel(resource);
        }
        break;
      }
      case "archive": await api.modifyThread(action.threadId, [], ["INBOX"]); break;
      case "trash": await api.trashThread(action.threadId); break;
      case "markRead": await api.modifyThread(action.threadId, [], ["UNREAD"]); break;
      case "markUnread": await api.modifyThread(action.threadId, ["UNREAD"], []); break;
      default:
        action satisfies never;
        throw new Error(`Unknown Gmail action type: ${(action as {type: string}).type}`);
      }

      store.journal.setDecision(actionId, "applied");
      store.journal.removeAction(actionId);
      store.drafts.releaseActionFiles(store.journal, action);
      store.journal.clearApplying(actionId);
      store.journal.pruneDecisions();
    } finally {
      this.#applying.delete(actionId);
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    const store = newGmailStore(this.ctx.storage);
    const action = store.journal.getAction(actionId);
    if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);
    const receipt = store.journal.getDraftWriteReceipt(actionId);
    const writeReceipt = (action.type === "draftCreate" || action.type === "draftUpdate")
      ? receipt
      : undefined;
    if (this.#applying.has(actionId) ||
        (store.journal.isApplying(actionId) &&
         !(action.type === "draftCreate" && writeReceipt !== undefined))) {
      throw new Error(
        `Gmail action ${actionId} has an uncertain provider outcome and must be reconciled first.`);
    }
    if (receipt && !receipt.missing && action.type === "draftCreate") {
      // The stable Message-ID proves the remote write is real even if its content changed before
      // reconciliation. Preserve that provider draft while rejecting the local pending action.
      store.drafts.mapDraftToProvider(store.journal, action.draft.logicalId, receipt.draftId, actionId);
    }
    store.journal.setDecision(actionId, "rejected");
    store.journal.removeAction(actionId);
    store.drafts.releaseActionFiles(store.journal, action);
    store.journal.clearApplying(actionId);
    if (action.type === "draftCreate") {
      const resource = store.drafts.getDraft(action.draft.logicalId);
      if (resource) {
        // Rejecting reconciliation cannot undo an identified provider write, so keep it visible.
        if (receipt?.missing) resource.status = "deleted";
        else if (!resource.providerId) resource.status = "rejected";
        resource.version++;
        store.drafts.putDraft(store.journal, resource);
        if (resource.status === "rejected" || receipt?.missing) {
          store.drafts.clearDraftForwardSnapshot(store.journal, action.draft.logicalId);
        }
      }
    } else if (action.type === "draftUpdate" || action.type === "draftDelete" ||
        action.type === "draftSend") {
      const resource = store.drafts.getDraft(action.draftId);
      if (resource) {
        if (receipt?.missing) resource.status = "deleted";
        resource.version++;
        store.drafts.putDraft(store.journal, resource);
      }
    } else if (action.type === "labelCreate") {
      const resource = store.labels.getLabel(action.label.logicalId);
      if (resource) {
        resource.status = "rejected";
        store.labels.putLabel(resource);
      }
    }
    const hasDependents = store.journal.listActions().some(item =>
      "dependsOn" in item.action && item.action.dependsOn?.includes(actionId));
    store.journal.pruneDecisions();
    return hasDependents ? {restart: true} : undefined;
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Gmail actions are not revertible.");
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "Gmail data is private to the connected account owner and cannot be shared with observers.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

import { MESSAGE_MUTATION_LABELS, RESOURCE_ACTION_LABELS, actionKinds, hasHistoricalAttachments, isLegacyGmailAction } from "./gmail-action-types";
import { applyMessageMutation, applyUncertainWrite, assertDependencies, providerDraftId, providerLabelId, reconcileDraftActionAlias, sentMessageFingerprint, verifyReconciledSend } from "./gmail-apply";
import { approvedCreateOutput } from "./gmail-draft-stubs";
import { captureDraftAttachmentIdentities, draftOutputFingerprint, draftSourceSnapshot, draftWriteMessage, exactDraftOutput, holdsDraftOutput, matchesGmailFingerprint, readDraftProviderBaseline, refreshLegacyDraftAttachments, sendSourceSnapshot } from "./gmail-drafts";
import { newGmailStore } from "./gmail-journal";
import { GmailReadContext } from "./gmail-list";
import { GmailScopedSessionImpl, GmailSessionImpl } from "./gmail-session";
import { GmailHookDeliveryImpl } from "./gmail-stubs";
