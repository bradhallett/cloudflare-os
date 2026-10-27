import { WorkpieceId, ChatGadgetPinRecord, AiChatMetadata, AiChatMessage, AiChatAuthorInfo, CollaboratorRole, ChatAttachmentHandle, ChatAttachmentRef, validateBindingName } from "@gadgets/workshop-shared/api";
import { applyCodeChange, codeChangeSerializedSize } from "@gadgets/workshop-shared/code-change";
import type { CodeContent } from "@gadgets/workshop-shared/code-change";
import { chatKey, chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ChatBindingEntry, ChatChangeRecord, GatekeeperCaller, StoredChatMessage, StoredChatMetadata } from "./storage-schema/overseer-storage";
import type { WorkspaceOutputEntry } from "./storage-schema/user-storage";
import { getAiGatewayConfig } from "./ai-gateway";
import { GIT_BINDING_NAME } from "./agent";
import { chatChangeStatuses } from "./agent-compaction";
import { WebFetchEnv } from "./web-fetch";
import { UserDurableObject } from "./user";
import { isLoopLimitError } from "./do-retry";
import { assertChatAttachmentSize, isAllowedChatAttachmentImageMimeType, validateChatAttachmentUpload } from "./chat-attachment-validation";
import { OverseerCore } from "./overseer-core";
import type { BindingLoopbackTarget, GatekeeperLoopbackProps } from "./overseer-loopbacks";
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE, MAX_CHAT_ATTACHMENT_TOTAL_BYTES, validateChatAttachmentId } from "./overseer-chat-attachments";
import { LOOP_LIMIT_RESTART_MIN_AGE_MS } from "./overseer-support";

/**
 * OverseerChats: chat content assembly, change listings, pins, agent environments, attachments, outputs and liveness bookkeeping.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerChats extends OverseerCore {
  /**
   * Forcefully tear down all live state for a chat (e.g. on deletion). Cancels any running agent.
   * (Undelivered calls to the agent live in storage -- `pendingAgentCalls` -- not here; deleteChat
   * removes them itself.)
   */
  destroyLiveChat(chatId: number) {
    this.settleSubagentWaiters(chatId);
    this.cacheWarmer.end(chatId, "deleted");
    this.resumeErrors.delete(chatId);
    this.unregisterRunningAgent(chatId);
    let meta = this.storage.chatMeta.get(chatId);
    if (meta?.activeAgent) {
      delete meta.activeAgent;
      this.storage.chatMeta.put(meta);
      this.updateAlarm();
    }
    let ctx = this.liveChats.get(chatId);
    if (!ctx) return;

    // Cancel running agent.
    ctx.cancelController?.abort(new Error("Chat deleted."));

    this.liveChats.delete(chatId);
    this.invalidateChatContent(chatId);
  }

  /**
   * Rebuild a chat's content -- `gadgetId -> (path -> text)` for every gadget whose files live
   * in the chat's change stream -- from the chat log. Content is epoch-scoped: a merge message with
   * `epochBoundary` (or a migrated chat's `conversionBoundary` changes message) discards
   * everything before it (the merged content lives in commits from then on), and within an
   * epoch each non-reverted "changes" message contributes first the base trees of any pins it
   * declares, then its change. Commits are immutable, so reconstruction of closed epochs is
   * deterministic from the log alone.
   *
   * With `through`, the content is reconstructed *as the log stood at that sequence*: later
   * messages -- including epoch boundaries and merge/revert markings -- haven't happened from
   * the caller's viewpoint, so they are excluded outright (a boundary recorded after `through`
   * must not wipe the snapshot it postdates).
   *
   * Live (unmaterialized) change rows are deliberately NOT included: callers that need them either
   * materialize first (accept, update-from-mainline, UI bundle loads) or apply them on top
   * themselves (getCurrentChatContent).
   */
  async buildChatContent(chatId: number, through?: number): Promise<CodeContent> {
    let messages = [...this.storage.chats.list({prefix: chatKeyPrefix(chatId)})];
    if (through !== undefined) {
      messages = messages.filter(msg => msg.sequence <= through);
    }
    let statuses = chatChangeStatuses(messages);
    let content: CodeContent = new Map();
    // Worktree pins established in the current epoch: their bases are lazy (see the worktree
    // branch below), so this map is what seedWorktreeEditBases resolves against.
    let worktreeBases = new Map<WorkpieceId, string>();
    for (let msg of messages) {
      if (msg.type === "merge" && msg.epochBoundary) {
        content = new Map();
        worktreeBases.clear();
        // Merges from before worktrees pinned on modification re-pinned every worktree at the
        // boundary and recorded it here (each base the auto-commit -- or unchanged pin base --
        // whose tree was the chat's content at the reset). Still honored so those epochs fold
        // as they were written; nothing writes the field anymore (see mergeChanges).
        for (let pin of msg.worktreePins ?? []) {
          worktreeBases.set(pin.worktreeId, pin.baseCommit);
          content.set(pin.worktreeId, new Map());
        }
        continue;
      }
      if (msg.type !== "changes") continue;
      if (statuses.get(msg.sequence) === "reverted") continue;
      if (msg.conversionBoundary) {
        content = new Map();
        worktreeBases.clear();
      }
      for (let pin of msg.pins ?? []) {
        if (this.isWorktree(pin.gadgetId)) {
          // A worktree's base is a whole repository tree, so it is never materialized: the entry
          // starts empty and holds only touched paths, with edits' base texts seeded on demand
          // from the pinned commit.
          worktreeBases.set(pin.gadgetId, pin.baseCommit);
          content.set(pin.gadgetId, new Map());
        } else {
          content.set(pin.gadgetId, await this.gitStore.readCommitFiles(pin.baseCommit));
        }
      }
      if (msg.change !== undefined) {
        content = await this.seedWorktreeEditBases(content, msg.change, worktreeBases);
        content = applyCodeChange(content, msg.change);
      }
    }
    return content;
  }

  invalidateChatContent(chatId: number): void {
    this.chatContentCache.delete(chatId);
  }

  /**
   * The live window's summary at the given (generation, revision) -- the caller's current code
   * base position -- served from #liveWindowCache when it is current for that position and
   * recomputed from one listing of the live rows otherwise.
   */
  protected liveWindowSummary(chatId: number, codeBase: {generation: number, revision: number})
      : {bytes: number, count: number} {
    let cached = this.liveWindowCache.get(chatId);
    if (cached !== undefined && cached.generation === codeBase.generation &&
        cached.revision === codeBase.revision) {
      return cached;
    }
    let liveRows = this.listLiveChatChanges(chatId, codeBase.generation);
    let entry = {
      generation: codeBase.generation, revision: codeBase.revision,
      bytes: liveRows.reduce((sum, row) => sum + codeChangeSerializedSize(row.change), 0),
      count: liveRows.length,
    };
    this.liveWindowCache.set(chatId, entry);
    return entry;
  }

  /**
   * The given generation's rows with revision > afterRevision, in revision order, retired rows
   * included. This is the transform window: a submission based at `afterRevision` rebases over
   * exactly these. Returns undefined if the window has a gap (rows expired past the retention
   * horizon), in which case the submission must be rejected rather than mistransformed.
   */
  listChatChangesSince(chatId: number, generation: number, afterRevision: number,
                       throughRevision: number): ChatChangeRecord[] | undefined {
    if (afterRevision >= throughRevision) return [];
    let rows = [...this.storage.chatChanges.list({
      prefix: chatKeyPrefix(chatId, generation),
      startAfter: chatKey(chatId, generation, afterRevision),
      end: chatKey(chatId, generation, throughRevision + 1),
    })];
    if (rows.length !== throughRevision - afterRevision ||
        rows[0].revision !== afterRevision + 1) {
      return undefined;
    }
    return rows;
  }

  /**
   * The generation's live (unretired) rows, in revision order: the rows not yet materialized
   * into a "changes" message.
   */
  listLiveChatChanges(chatId: number, generation: number): ChatChangeRecord[] {
    return [...this.storage.chatChanges.list({
      prefix: chatKeyPrefix(chatId, generation),
    })].filter(row => !row.retired);
  }

  /**
   * The workpieces this chat currently proposes changes to: pinned in the chat's current epoch
   * (a gadget or worktree joins the pin stream when its code is first modified -- see
   * ChatCodeBase), or -- gadgets only -- created provisionally by the chat or targeted by a
   * provisional binding edge the chat added (which changes the gadget's env even though its code
   * is untouched). Purely derived: pins and pending records are maintained transactionally with
   * the changes themselves (established with their rows, rolled back by revert/discard,
   * evaporated by the accept's epoch reset), so there is no cached flag to drift out of step --
   * this replaces the stored `hasProposedChanges` bit and the recompute machinery that existed
   * to fight exactly that. (A chat from before worktree pins meant modification can hold a
   * worktree pin that proves nothing, which reads as proposed here until its first accept drops
   * it -- see mergeChanges. Accepted: few such chats exist, and one click clears it.)
   *
   * A worktree's *creation* alone proposes nothing, unlike a gadget's: accepting adds a pending
   * gadget to the workspace, whereas a worktree stays private to its chat either way, so an
   * agent that checks a repository out only to read it would otherwise raise the pending-changes
   * banner over a chat with nothing to accept. For the same reason no revert deletes a worktree
   * (see WorktreeRecord.pending).
   */
  proposedChangeWorkpieceIds(chatId: number, meta: AiChatMetadata): WorkpieceId[] {
    let ids = new Set<WorkpieceId>();
    for (let pin of meta.codeBase?.pins ?? []) {
      // A removed workpiece's pin outlives it (see removeWorkpiece) but proposes nothing.
      if (this.storage.gadgets.get(pin.gadgetId)) ids.add(pin.gadgetId);
    }
    for (let record of this.storage.gadgets.list()) {
      if (ids.has(record.id) || record.type !== "gadget") continue;
      if (record.pending?.chatId === chatId ||
          Object.values(record.bindings).some(edge => edge.pending?.chatId === chatId)) {
        ids.add(record.id);
      }
    }
    for (let record of this.storage.gatekeepers.list()) {
      if (Object.values(record.bindings ?? {}).some(edge => edge.pending?.chatId === chatId)) {
        ids.add(record.id);
      }
    }
    return [...ids].toSorted((a, b) => a - b);
  }

  /**
   * A chat metadata record as delivered to clients: the stored row with the derived
   * `proposedChangeWorkpieces` list attached (see proposedChangeWorkpieceIds) and the retired
   * `hasProposedChanges` flag dropped (see StoredChatMetadata). Never mutates the input.
   */
  chatMetaForClient(stored: StoredChatMetadata): AiChatMetadata {
    let meta: StoredChatMetadata = {...stored};
    delete meta.hasProposedChanges;
    let proposed = this.proposedChangeWorkpieceIds(stored.id, stored);
    if (proposed.length > 0) {
      meta.proposedChangeWorkpieces = proposed;
    }
    return meta;
  }

  /**
   * Erase every change row of the chat (a destructive bump, or chat deletion): retired rows too,
   * since a destructively-closed stream is not bridgeable.
   */
  deleteAllChatChanges(chatId: number): void {
    for (let row of Array.from(this.storage.chatChanges.list({prefix: chatKeyPrefix(chatId)}))) {
      this.storage.chatChanges.deleteRecord(row);
    }
    this.storage.chatChangeBoundaries.delete(chatId);
    this.chatContentCache.delete(chatId);
    this.liveWindowCache.delete(chatId);
  }

  /**
   * Each gadget's last pin declaration on a surviving (non-reverted) "changes" message in the
   * chat's current epoch: the one its content is rooted at (see ChatGadgetPinRecord). Meta pins
   * missing from the map are what materialization must stamp onto its message (see
   * materializeChatChanges), and what pin rollback removes when the rows that established them
   * are discarded; a revert also takes each surviving pin's base from here.
   */
  declaredPins(chatId: number): Map<WorkpieceId, ChatGadgetPinRecord> {
    let messages = [...this.storage.chats.list({prefix: chatKeyPrefix(chatId)})];
    let statuses = chatChangeStatuses(messages);
    let declared = new Map<WorkpieceId, ChatGadgetPinRecord>();
    for (let msg of messages) {
      if (msg.type === "merge" && msg.epochBoundary) {
        declared.clear();
        // An older merge's worktree re-pins (see AiChatMessageBody.worktreePins) are
        // declarations in the new epoch: nothing may re-declare them (a duplicate declaration
        // would reset the worktree's content mid-fold), and a revert must not drop them (they
        // root content that survived the accept; merges themselves are never reverted) -- the
        // next accept's epoch reset is what retires such a pin.
        for (let pin of msg.worktreePins ?? []) {
          declared.set(pin.worktreeId, {gadgetId: pin.worktreeId, baseCommit: pin.baseCommit});
        }
      } else if (msg.type === "changes" && statuses.get(msg.sequence) !== "reverted") {
        if (msg.conversionBoundary) declared.clear();
        for (let pin of msg.pins ?? []) declared.set(pin.gadgetId, pin);
      }
    }
    return declared;
  }

  /**
   * Pins in the chat's live state (see ChatGadgetPinState) whose establishment no surviving
   * current-epoch "changes" message records yet, as the log records them. A pin lands in
   * `codeBase` atomically with the row that needed it; its durable log declaration lands when
   * the rows materialize.
   */
  undeclaredMetaPins(chatId: number, meta: AiChatMetadata): ChatGadgetPinRecord[] {
    let pins = meta.codeBase?.pins ?? [];
    if (pins.length === 0) return [];
    let declared = this.declaredPins(chatId);
    return pins.filter(pin => !declared.has(pin.gadgetId))
        .map(({gadgetId, baseCommit, mergedCommit}) => ({
          gadgetId, baseCommit, ...(mergedCommit !== baseCommit ? {mergedCommit} : {}),
        }));
  }

  makeBindingLoopback(target: BindingLoopbackTarget, caller: GatekeeperCaller) {
    let props: GatekeeperLoopbackProps = {
      overseerId: this.ctx.id.toString(),
      target,
      caller,
    };
    return this.ctx.exports.GatekeeperLoopback({props});
  }

  /**
   * Build the flat `env` handed to a gadget's dynamically-loaded worker: the gadget's named
   * bindings plus `GADGET` (the gadget's self-stub, kept for back-compat with existing gadget
   * code). `forChatId` scopes visibility of provisional binding edges: an edge pending in that
   * chat is included (the chat's own preview/test runs see its proposed additions), while edges
   * pending in other chats -- or in any chat, when loading mainline -- are treated as
   * nonexistent.
   */
  getEnvForLoader(gadgetId: WorkpieceId, caller: GatekeeperCaller, forChatId?: number): object {
    let env: Record<string, any> = {}
    let gadget = this.getGadgetRecord(gadgetId);
    env.GADGET = this.makeBindingLoopback({type: "gadget", id: gadgetId}, caller);
    // Before the named bindings, so an edge named GIT from before the name was reserved still
    // shadows it (see bindWorkpiece). The agent's describeBinding tool mirrors this order when
    // describing a gadget's bindings (see describeBinding in agent.ts).
    env[GIT_BINDING_NAME] = this.makeBindingLoopback({type: "git"}, caller);
    for (let [name, edge] of this.visibleBindings(gadget, forChatId)) {
      env[name] = this.makeBindingLoopback({type: "gatekeeper", id: edge.target}, caller);
    }
    return env;
  }

  /**
   * Build the agent's executeCode env from the chat's binding map: each name resolves to a
   * gadget's `{rpc, exports}` pair, a gatekeeper session stub, or an agent callback's stored
   * arguments.
   * Entries whose targets no longer exist are silently skipped, mirroring the deleted-gadget
   * behavior elsewhere. `executionId` is the calling executeCodeMode run, minted into worktree
   * loopbacks so they are usable only from within that execution.
   */
  getEnvForAgent(chatId: number, bindings: Record<string, ChatBindingEntry>,
                 executionId: string): object {
    let caller: GatekeeperCaller = {from: "agent", chatId};
    // This must be a *plain* object: it becomes the loaded worker's `env`, and the loader's
    // serializer rejects anything else (including a null-prototype object) with DataCloneError.
    // So prototype-pollution safety comes from validation instead: names from before name
    // validation existed (or hostile stored data) that would collide with -- or, like
    // "__proto__", mutate -- Object.prototype members fail the shared validator and are skipped.
    let env: Record<string, any> = {};

    // Before the chat's bindings, so a chat binding named GIT shadows it -- matching
    // describeBinding (see describeBinding in agent.ts).
    env[GIT_BINDING_NAME] = this.makeBindingLoopback({type: "git"}, caller);

    for (let [name, entry] of Object.entries(bindings)) {
      try {
        validateBindingName(name);
      } catch (err) {
        this.logger.warn("skipping chat binding with invalid name", {
          event: "chat.binding.env.name.invalid", chatId, error: err,
        });
        continue;
      }
      switch (entry.type) {
        case "workpiece": {
          let record = this.storage.gadgets.get(entry.id);
          if (record?.type === "gadget") {
            env[name] = {
              rpc: this.makeBindingLoopback({type: "gadget", id: entry.id}, caller),
              exports: this.makeBindingLoopback({type: "exports", id: entry.id}, caller),
            };
          } else if (record?.type === "worktree") {
            // The programmatic Worktree binding (see worktree-session.ts). Served through the
            // loopback like every binding, resolving against this execution's registered
            // worktree state -- the executionId is what keeps it live for exactly this
            // executeCode run (see startGatekeeperSession's "worktree" case).
            env[name] = this.makeBindingLoopback(
                {type: "worktree", id: entry.id, executionId}, caller);
          } else if (this.storage.gatekeepers.get(entry.id)) {
            env[name] = this.makeBindingLoopback({type: "gatekeeper", id: entry.id}, caller);
          }
          break;
        }
        case "value": {
          // Agent callback arguments — embed the stored args array directly in env. Any stubs
          // inside are persistent stubs (that is what made the record storable), so they work
          // directly in env.
          let stored = this.storage.agentCallbackArgs.get(
              chatKey(chatId, entry.messageSequence));
          if (!stored) {
            throw new Error("missing agentCallbackArgs value");
          }
          env[name] = stored.args;
          break;
        }
        default:
          entry satisfies never;
      }
    }
    return env;
  }

  proposedChangesChanged(chatId: number) {
    for (let [gadgetId, runningChatId] of this.runningChatIds) {
      if (runningChatId === chatId) {
        this.ctx.facets.abort(this.gadgetFacetName(gadgetId), new Error(
            "Gadget restarted because the proposed changes changed."));
      }
    }
  }

  sameChatAuthor(left: AiChatAuthorInfo, right: AiChatAuthorInfo): boolean {
    return left.type === right.type && left.id === right.id && left.name === right.name;
  }

  /** The display author for a batch of rows: the shared author, or a "Multiple Authors" marker. */
  normalizeRowAuthor(rows: ChatChangeRecord[]): AiChatAuthorInfo {
    if (rows.length === 0) {
      throw new Error("Cannot normalize an empty row batch.");
    }
    let first = rows[0].author;
    if (rows.every(row => this.sameChatAuthor(row.author, first))) {
      return first;
    }
    return {
      type: "user",
      id: first.id,
      name: "Multiple Authors",
    };
  }

  /**
   * Whether a chat's uncommitted content holds this gadget's files: the gadget is pinned in the
   * chat, or has no committed code (chat-created gadgets live only in the chat's change stream).
   * Otherwise the gadget tracks mainline head live, and chat context doesn't change what its
   * code reads return. This is the one rule behind every chat-context read of gadget code --
   * previews (loadGadgetWorker), UI bundles, and the agent's file tools all follow the same
   * split.
   */
  chatDocOwnsGadget(meta: AiChatMetadata, gadgetId: WorkpieceId): boolean {
    let record = this.storage.gadgets.get(gadgetId);
    return record?.type !== "gadget" || record.commitId === undefined ||
        (meta.codeBase?.pins ?? []).some(pin => pin.gadgetId === gadgetId);
  }

  /**
   * Apply all currently-eligible pending actions of the given gatekeeper, in ascending id order.
   * Stops at the first pending action that is NOT auto-eligible (i.e. a manual gate) or that throws
   * while applying -- it is never skipped ahead of. This preserves in-order application and the
   * invariant that nothing is silently applied past a human gate.
   *
   * Delegates to the single-flight drainer, which guards against concurrent drains for the same
   * gatekeeper double-applying an action (the DO's input gate is open across the apply await).
   */
  drainAutoApprovals(gatekeeperId: number): Promise<void> {
    return this.autoApprovalDrainer.drain(gatekeeperId);
  }

  isPreparingChatMessage(chatId: number): boolean {
    return this.preparingChatMessages.has(chatId);
  }

  waitForChatMessagePreparation(chatId: number): Promise<void> | undefined {
    return this.preparingChatMessages.get(chatId);
  }

  /**
   * The author of work this workspace's gadgets do on `user`'s behalf -- spawned agent turns,
   * agent callbacks, gadget code's own calls: accounted to `user`, displayed under the workspace
   * title, and committing with `user`'s commit email (see AiChatAuthorInfo "gadget").
   */
  gadgetAuthorFor(user: AiChatAuthorInfo): AiChatAuthorInfo {
    return {
      type: "gadget",
      id: user.id,
      name: this.storage.title.get(),
      ...(user.commitEmail !== undefined && {commitEmail: user.commitEmail}),
    };
  }

  async getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array> {
    let content = this.storage.chatAttachmentContent.get(validateChatAttachmentId(id));
    if (!content || content.state.type !== "committed" || content.state.chatId !== chatId) {
      throw new Error("Chat attachment not found.");
    }
    if (content.data !== undefined) return content.data;
    if (content.state.oid !== undefined) return this.gitStore.readBlob(content.state.oid);
    if (content.state.workspaceCommitId === undefined ||
        content.state.workspacePath === undefined) {
      throw new Error("Chat attachment has no stored content.");
    }
    const entry = await this.gitCache.walker.pathEntryAtCommit(
        content.state.workspaceCommitId, content.state.workspacePath);
    if (!entry || entry.kind === "dir" || entry.kind === "submodule") {
      throw new Error("Chat attachment content is missing from Git.");
    }
    return (await this.gitCache.walker.ensureObject(entry.oid,
      {type: "blob", referencedBy: entry.referencedBy})).payload;
  }

  /**
   * Prepare a stored chat message for delivery to a client: inline image attachment bytes
   * (non-image attachments are fetched on demand via getChatAttachmentContent()), strip the
   * retired Yjs payload from pre-conversion "changes" messages -- it is kept on disk as
   * rollback insurance (see overseer-git-migration.ts) but nothing can apply it, so it must not
   * ship as dead weight on the wire (it is not part of the message's API type).
   */
  hydrateChatMessageForClient(msg: StoredChatMessage): AiChatMessage {
    if (msg.type === "changes" && "update" in msg) {
      let {update: _, ...rest} = msg;
      msg = rest;
    }
    if (msg.type !== "message" || !msg.attachments?.length) return msg;
    let attachments = msg.attachments.map((a) => {
      if (!isAllowedChatAttachmentImageMimeType(a.mimeType)) {
        return a;
      }
      let content = this.storage.chatAttachmentContent.get(a.id);
      if (content?.state.type === "committed" && content.state.chatId === msg.chatId &&
          content.state.oid !== undefined) {
        return {...a, content: this.gitStore.readBlob(content.state.oid)};
      }
      if (!content?.data) return a;
      return {...a, content: content.data};
    });
    return {...msg, attachments};
  }

  /**
   * Look up the attachments that the client wants to send.
   *
   * Verify uploaded Git blobs and canonicalize their message metadata before publication.
   * Legacy staged handles remain readable during client upgrades.
   */
  canonicalizeChatAttachmentRefs(
    attachments?: ChatAttachmentHandle[],
  ): ChatAttachmentRef[] | undefined {
    if (!attachments || attachments.length === 0) return undefined;
    if (attachments.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`You can attach up to ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} attachments.`);
    }

    let total = 0;
    let result: ChatAttachmentRef[] = [];
    let seenIds = new Set<string>();
    for (let attachment of attachments) {
      if ("oid" in attachment) {
        const content = this.gitStore.readBlob(attachment.oid);
        assertChatAttachmentSize(content.byteLength);
        const upload = validateChatAttachmentUpload({
          mimeType: attachment.mimeType, name: attachment.name,
          content,
        });
        total += content.byteLength;
        result.push({id: crypto.randomUUID(), oid: attachment.oid,
          mimeType: upload.mimeType, name: upload.name, size: content.byteLength});
        continue;
      }
      let id = validateChatAttachmentId(attachment.id);
      if (seenIds.has(id)) throw new Error("Duplicate chat attachment.");
      seenIds.add(id);
      let content = this.storage.chatAttachmentContent.get(id);
      if (!content || content.state.type !== "staged") {
        throw new Error("Chat attachment not found.");
      }
      let data = content.data;
      if (data === undefined) throw new Error("Staged chat attachment has no content.");
      assertChatAttachmentSize(data.byteLength);
      total += data.byteLength;
      result.push({
        id,
        mimeType: content.state.mimeType,
        name: content.state.name,
        size: data.byteLength,
      });
    }
    if (total > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Attached files are too large.");
    }
    return result;
  }

  commitChatAttachments(
      chatId: number, attachments?: ChatAttachmentRef[], workspaceCommitId?: string): void {
    for (let attachment of attachments ?? []) {
      let id = validateChatAttachmentId(attachment.id);
      if (attachment.oid !== undefined) {
        this.storage.chatAttachmentContent.put({fileId: id, state: {
          type: "committed", chatId, oid: attachment.oid,
          workspacePath: attachment.workspacePath,
        }});
        continue;
      }
      let content = this.storage.chatAttachmentContent.get(id);
      if (!content || content.state.type !== "staged") {
        throw new Error("Chat attachment is no longer available.");
      }
      if (attachment.workspacePath !== undefined) {
        if (workspaceCommitId === undefined) {
          throw new Error("Workspace attachment is missing its Git source commit.");
        }
        this.storage.chatAttachmentContent.put({
          fileId: id,
          // Client message hydration is synchronous. Retain bounded image bytes for previews
          // until that API can stream the immutable Git-backed attachment instead.
          ...(isAllowedChatAttachmentImageMimeType(attachment.mimeType)
            ? {data: content.data} : {}),
          state: {
            type: "committed",
            chatId,
            workspacePath: attachment.workspacePath,
            workspaceCommitId,
          },
        });
      } else {
        this.storage.chatAttachmentContent.put({
          fileId: id,
          data: content.data,
          state: {type: "committed", chatId},
        });
      }
    }
  }

  /**
   * Provides web-fetch with the Workers AI binding and AI Gateway config it needs to call
   * `env.WORKERS_AI.toMarkdown()`. The initiator is needed for AI Gateway metadata.
   */
  getWebFetchEnv(): WebFetchEnv {
    if (this.storage.containsRestrictedData.get()) {
      // TODO: Disallwing fetches is a bit draconian. Ideally, we would have some way to detect
      //   if a URL is well-known, and therefore not a leak problem. E.g. if the URL is already in
      //   a search index, then it's not leaking anything. If we had a search provider we could
      //   trust... for now though, we will be extra-careful specifically when prohibiting sharing.
      throw new Error(
          "This workspace has observed sensitive data. To prevent leaks, the workspace is prohibited " +
          "from fetching from public web sites.");
    }

    return {
      ai: this.env.WORKERS_AI,
      gateway: getAiGatewayConfig(this.env),
    };
  }

  // What is the last active time that we know the user DO has been made aware of?
  #lastActiveTimeKnownToUserDo?: Date;

  // What is the last active time we've seen locally?
  #lastActiveTimeKnownToUs?: Date;

  // Do we currently have a timeout scheduled after which we plan to send a last active update?
  #lastActiveBumpScheduled: boolean = false;

  /** Update the last-active time and cost counter as recorded for this gadget in the user-level DO. */
  bumpLastActive(now: Date = new Date()) {
    if (this.#lastActiveTimeKnownToUs && this.#lastActiveTimeKnownToUs >= now) {
      // Redundant bump.
      return;
    }

    this.#lastActiveTimeKnownToUs = now;

    if (this.#lastActiveBumpScheduled) {
      // Wait for the scheduled bump, which will see our update to #lastActiveTimeKnownToUs.
      return;
    }

    // Only bump once a minute to reduce network traffic.
    let timeToNextBump: number = this.#lastActiveTimeKnownToUserDo
        ? this.#lastActiveTimeKnownToUserDo.getTime() + 60000 - now.getTime()
        : 0;

    if (timeToNextBump <= 0) {
      // Bump now!
      // Let this run async -- no need to make the caller wait for it.
      this.#bumpLastActiveImpl();
    } else {
      // Schedule bump in the future, coalescing with any other bumps that happen before then.
      this.#lastActiveBumpScheduled = true;
      scheduler.wait(timeToNextBump).then(() => {
        this.#lastActiveBumpScheduled = false;
        if (!this.#lastActiveTimeKnownToUserDo ||
            this.#lastActiveTimeKnownToUserDo < this.#lastActiveTimeKnownToUs!) {
          this.#bumpLastActiveImpl();
        }
      });
    }
  }

  async #bumpLastActiveImpl() {
    try {
      if (!this.ownerId) {
        // Gadget must have been deleted, ignore.
        return;
      }

      let owner = this.users.get(this.users.idFromString(this.ownerId));

      this.#lastActiveTimeKnownToUserDo = this.#lastActiveTimeKnownToUs!;
      await owner.setGadgetLastActive(this.ctx.id.toString(), this.#lastActiveTimeKnownToUs!,
                                      this.storage.totalCost.get());
    } catch (err) {
      this.logger.warn("failed to bump gadget last-active on user DO", {
        event: "gadget.last.active.bump.failed",
        gadgetId: this.ctx.id.toString(), error: err,
      });
      this.restartIfLoopLimited(err);

      // Force retry on next bump.
      this.#lastActiveTimeKnownToUserDo = undefined;
    }
  }

  // --- Outputs index -------------------------------------------------------------------
  //
  // Each non-provisional gadget here is an "output". The `gadgets` registry is authoritative, but
  // the Outputs page lists across all of a user's workspaces, so the registry is mirrored into an
  // index in each interested user's DO (see UserDurableObject.syncWorkspaceOutputs()).

  /**
   * This workspace's outputs, as pushed to a user's index. Provisional gadgets are excluded: they
   * are proposals inside a chat, not things the user has made yet.
   *
   * Whole-snapshot rather than a delta, so that a user's index can be brought into line with this
   * workspace in one call from anywhere, without either side reconciling per workpiece.
   */
  outputsSnapshot(): WorkspaceOutputEntry[] {
    let entries: WorkspaceOutputEntry[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (gadget.type !== "gadget" || gadget.pending) continue;  // worktrees have no outputs
      entries.push({
        workpieceId: gadget.id,
        title: gadget.title,
        created: gadget.created,
        ...(gadget.output ? {output: gadget.output} : {}),
      });
    }
    return entries;
  }

  /**
   * Push the current snapshot into one user's index. Best-effort: the index is a denormalized
   * view, so a failed push costs a stale Outputs page until the next change or open, never
   * correctness.
   * Returns whether the index actually took it. Failures are logged rather than thrown -- an index
   * is a convenience view and the workspace itself is unaffected -- but callers that remember what
   * they have sent need to know the difference.
   */
  async syncOutputsTo(user: DurableObjectStub<UserDurableObject>,
                      snapshot = this.outputsSnapshot()): Promise<boolean> {
    try {
      await user.syncWorkspaceOutputs(this.ctx.id.toString(), snapshot);
      return true;
    } catch (err) {
      this.logger.warn("failed to sync workspace outputs to user DO", {
        event: "workspace.outputs.sync.failed", gadgetId: this.ctx.id.toString(), error: err,
      });
      this.restartIfLoopLimited(err);
      return false;
    }
  }

  /**
   * Force every client to disconnect and re-authenticate, so that no session outlives a change to
   * what its holder is entitled to. Both checks that gate a session run only at open() (see the
   * sharing docs), so without this a stale session would survive until something else happened to
   * disconnect it. Two kinds of change need it:
   * - Access removed or downgraded (removeCollaborator, revokeShareLink, workspace deletion):
   *   someone who just lost access could keep using the session they already have.
   * - Verification scope widened (see #restartIfSessionsAffected): a collaborator's live session
   *   was verified against a smaller set of gatekeepers than the workspace now holds.
   *
   * A third use changes nobody's entitlement (see restartIfLoopLimited): the restart replaces this
   * instance, and with it the exhausted loop counter that was refusing its calls to user objects.
   *
   * We restart by aborting the whole DO. Aborting propagates to clients: the `notifyClosed` stub
   * handed to each session is disposed without being called, which AuthenticatedApiImpl detects
   * and reacts to by killing the browser WebSocket, forcing a reconnect that re-runs open() and
   * re-checks the (now-changed) permission graph. These events are rare, so the disruption is
   * acceptable -- and DOs restart unpredictably anyway, so reconnects need to be made as painless
   * as possible regardless.
   *
   * Two precautions before the abort:
   * - `ctx.abort()` does not respect the output gate, so we explicitly flush the triggering change
   *   to disk with `ctx.storage.sync()`. Otherwise a restart could come back with the change lost,
   *   leaving the removed user still authorized (or the widened scope unrecorded). By the same
   *   token, callers must schedule the restart *after* the write that triggered it, never before
   *   further writes in the same turn -- those would be racing the abort.
   * - We delay the abort briefly so the triggering RPC's response can reach the caller (typically
   *   the owner, who is also connected and will be disconnected) before their connection drops.
   *   Without the delay their own removeCollaborator()/revokeShareLink() call might reject with a
   *   connection error even though it succeeded.
   */
  async scheduleAccessRestart(reason: string): Promise<void> {
    await this.ctx.storage.sync();
    await scheduler.wait(100);
    this.ctx.abort(reason);
  }

  // Whether restartIfLoopLimited has scheduled a restart of this instance.
  #loopLimitRestartScheduled = false;

  /**
   * Restart if `err` is the runtime's loop-limit rejection (see isLoopLimitError) of one of this
   * object's own calls to a user object: once its outgoing channels hold an exhausted counter
   * every such call is refused until this instance is replaced. Only rejections of those calls are
   * passed in (wrapUserDo's stubs, the last-active bump and the outputs sync) -- code the workspace
   * runs or calls (gadgets, agents, gatekeeper facets) can throw the same message at will, and
   * must not be able to restart a shared workspace. A rejection the user object relays whole from
   * something it called, such as a connected gatekeeper account, cannot be told apart and counts.
   * At most one restart per instance, and none while the instance is young: that bounds how often
   * a restart that did not clear the condition repeats.
   */
  restartIfLoopLimited(err: unknown): void {
    if (!isLoopLimitError(err) || this.#loopLimitRestartScheduled) return;
    if (Date.now() - this.streamGeneration < LOOP_LIMIT_RESTART_MIN_AGE_MS) return;
    this.#loopLimitRestartScheduled = true;
    this.logger.error("restarting workspace to clear an exhausted subrequest depth", {
      event: "workspace.loop.limit.restart", error: err,
    });
    this.scheduleAccessRestart("Gadget restarted because its subrequest depth was exhausted.");
  }

  /**
   * Sessions are authorized and verified only at open(), so widening what a live session's holder
   * must be verified against leaves that session holding unverified access. Restart everyone --
   * the same mechanism used when access is revoked -- so each client's next open() re-runs
   * authorizeCollaborator/ensureObserver against the new scope.
   *
   * The condition is a live *session*, not an entry in the sharing graph: the only thing a restart
   * achieves is severing sessions that were admitted at the narrower scope, so a workspace where
   * only the owner is connected has nothing to sever no matter who it is shared with (the owner is
   * never an observer). Counting sessions rather than consulting the graph also keeps this
   * synchronous, so a widening cannot be missed because an async lookup failed, and the restart is
   * scheduled at the moment of the change rather than an RPC round trip later.
   *
   * `affectedRole` names whose scope the caller widened, since the two roles widen independently
   * (#inScopeGatekeepers): a new connection enters every "build" collaborator's scope but no "use"
   * collaborator's until some gadget binds it, and binding one enters "use" scope having been in
   * "build" scope since it was created. A session holding the other role therefore has no new
   * verification requirements, and severing it would buy nothing. Omit the argument for a restart
   * that isn't a widening at all (one that must sever regardless of role).
   *
   * Note that ensureAmbientCapsules() calls addGatekeeper() from inside open(), so on a shared
   * workspace the first open after an ambient capsule appears bounces itself once; the capsule
   * exists by then, so the client's retry is clean.
   * Returns whether a restart was scheduled, so a caller that just published a widened
   * capability knows to hold it back until the reset lands (see #gatekeepersPendingRestart).
   */
  protected restartIfSessionsAffected(reason: string, affectedRole?: CollaboratorRole): boolean {
    if (!this.hasCollaboratorSession(affectedRole)) return false;
    this.scheduleAccessRestart(reason);
    return true;
  }
}
