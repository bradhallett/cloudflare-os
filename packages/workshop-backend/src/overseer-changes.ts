import { WorkpieceId, ChatGadgetPinRecord, MainlineMergeGadget, ChatCodeBase, ChatGadgetPinState, CodeChangeSubmission, AiChatMetadata, AiChatAuthorInfo, BlueprintMerge } from "@gadgets/workshop-shared/api";
import { applyCodeChange, changedGadgets, codeChangeSerializedSize, composeCodeChange, MAX_CODE_CHANGE_SIZE, transformCodeChange, validateCodeChangeContent, validateCodeChangeSchema } from "@gadgets/workshop-shared/code-change";
import type { CodeContent, CodeChange } from "@gadgets/workshop-shared/code-change";
import { chatChangeClientKey, chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ChatChangeBoundaryRecord, ChatChangeRecord, WorktreeRecord } from "./storage-schema/overseer-storage";
import type { Usage } from "@earendil-works/pi-ai";
import type { AiGatewayLogRoute } from "./ai-gateway";
import { agentCodeChangeShape } from "./agent-session";
import type { AgentStepChange, AiChatMessageBodyWithModelData } from "./agent-hooks";
import { OverseerPublishing } from "./overseer-publishing";
import { AGENT_RUNNING_ERROR_MESSAGE, CHAT_CHANGE_AUTHOR_SPLIT_MS, CHAT_CHANGE_CLIENT_ID_PATTERN, chatStreamGoneError, submissionDigest, validateOid } from "./overseer-support";

/**
 * OverseerChanges: chat change materialization and code-change submission validation.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerChanges extends OverseerPublishing {
  // The live window's newest row, or undefined if the window is empty. One indexed read: the
  // generation's rows sort by revision, and retirement always covers the generation's entire
  // window at once (see #retireChatChanges), so the live rows are a contiguous suffix -- a
  // retired (or absent) newest row means the window is empty. Read from storage rather than
  // cached so out-of-band row updates can't serve stale attribution data.
  #newestLiveChatChange(chatId: number, generation: number): ChatChangeRecord | undefined {
    for (let row of this.storage.chatChanges.list({
      prefix: chatKeyPrefix(chatId, generation), reverse: true, limit: 1,
    })) {
      return row.retired ? undefined : row;
    }
    return undefined;
  }

  /**
   * Materialize the chat's live change rows into exactly one durable "changes" message. The
   * message's `change` is the rows' composition and its `watermark` names the rows it absorbed;
   * it additionally stamps `pins` for any meta pins not yet declared in the log (closing the
   * meta/log loop: submitCodeChange and the agent's appends establish pins in codeBase
   * atomically with the row that needed them, and this is where the establishment becomes
   * durable log history). The rows are then retired -- kept briefly as a transform window, not
   * deleted -- so late submissions based inside the materialized range still rebase cleanly.
   *
   * One message, always: the composition is kept storable by bounding what accumulates
   * (submitCodeChange materializes the pending window before a row would push its summed size
   * past MAX_CODE_CHANGE_SIZE; the agent's step buffer is bounded by the same cap at the write
   * call), never by splitting the output --
   * splitting would scatter one batch's extras and edits across messages a suffix revert could
   * divide, and would break the agent's message-counting change-ID numbering.
   *
   * `options.extras` lets the agent's step barrier attach its creations/binding additions,
   * updateChatFromMainline its `mainlineMerge` record, and applyBlueprint (or the barrier, for
   * a gadget created from a blueprint) its `blueprintMerges`; a message is written when
   * there is anything at all to record (rows, undeclared pins, or extras). `options.pins` are
   * declarations the caller is about to put into the code base, which re-root their gadgets
   * (see ChatGadgetPinRecord): updateChatFromMainline writes the message that declares them
   * ahead of the pins themselves, since clients rebuild from the log. `options.author`
   * overrides the row-derived author (required when there are no rows). The returned
   * `sequence` is the first written message's.
   */
  materializeChatChanges(chatId: number, meta?: AiChatMetadata, options?: {
    author?: AiChatAuthorInfo,
    allowDuringTurn?: boolean,
    createdGadgets?: {gadgetId: WorkpieceId, title: string, bindingName: string}[],
    createdWorktrees?: {worktreeId: WorkpieceId, title: string, bindingName: string}[],
    addedBindings?: {gadgetId: WorkpieceId, name: string, target: WorkpieceId}[],
    worktreeCommits?: {worktreeId: WorkpieceId, commit: string, previousHead: string}[],
    pins?: ChatGadgetPinRecord[],
    mainlineMerge?: {conflictPaths: string[], gadgets: MainlineMergeGadget[]},
    blueprintMerges?: BlueprintMerge[],
  }): {sequence: number, meta: AiChatMetadata} | undefined {
    if (!meta) {
      meta = this.storage.chatMeta.get(chatId);
      if (!meta) {
        return;
      }
    }

    // Defensive: while a turn runs, only the agent-run machinery itself may materialize (the
    // step barrier and the turn-start sweep).
    if (meta.activeAgent && !options?.allowDuringTurn) {
      throw new Error(AGENT_RUNNING_ERROR_MESSAGE);
    }

    let codeBase = this.chatCodeBase(meta);
    let rows = this.listLiveChatChanges(chatId, codeBase.generation);
    let declared = options?.pins ?? [];
    let pins = [
      ...this.undeclaredMetaPins(chatId, meta)
          .filter(pin => !declared.some(decl => decl.gadgetId === pin.gadgetId)),
      ...declared,
    ];
    let hasExtras = (options?.createdGadgets?.length ?? 0) > 0 ||
        (options?.createdWorktrees?.length ?? 0) > 0 ||
        (options?.addedBindings?.length ?? 0) > 0 ||
        (options?.worktreeCommits?.length ?? 0) > 0 || options?.mainlineMerge !== undefined ||
        (options?.blueprintMerges?.length ?? 0) > 0;
    if (rows.length === 0 && pins.length === 0 && !hasExtras) {
      return;
    }
    // A pins-only materialization needs an explicit author (there are no rows to attribute it
    // to); without one, leave the declarations for the next flush that has rows or an author.
    let author = options?.author ?? (rows.length > 0 ? this.normalizeRowAuthor(rows) : undefined);
    if (author === undefined && rows.length === 0 && !hasExtras) {
      return;
    }

    // No rows means one message with no change of its own, carrying the pins/extras. Pins-first
    // is correct for the same reason getCurrentChatContent establishes them up front: within a
    // message pins apply before changes (see buildChatContent), and every batch row touching a
    // pinned gadget was appended after that pin established.
    let change: CodeChange | undefined;
    for (let row of rows) {
      change = change === undefined ? row.change : composeCodeChange(change, row.change);
    }

    let sequence = this.nextChatSequencePeek(chatId);
    // One transaction for the whole barrier: the watermark message, the row retirements, and
    // the pruning commit or roll back together. A crash between them must never leave live
    // rows already covered by a watermark (the next flush would materialize them a second
    // time) nor retired rows with no message (their changes would silently vanish).
    // commitAgentStep already wraps its call in a storage.transaction; transactionSync nests
    // as a savepoint, so the step barrier stays one unit too.
    try {
      return this.storage.transaction(() => {
        this.addChatMessages(chatId, author!, [{
          type: "changes",
          ...(change !== undefined ? {change} : {}),
          ...(rows.length > 0
              ? {watermark: {changesGeneration: codeBase.generation,
                             throughRevision: rows[rows.length - 1].revision}}
              : {}),
          ...(pins.length > 0 ? {pins} : {}),
          ...(options?.createdGadgets?.length
              ? {createdGadgets: options.createdGadgets} : {}),
          ...(options?.createdWorktrees?.length
              ? {createdWorktrees: options.createdWorktrees} : {}),
          ...(options?.addedBindings?.length
              ? {addedBindings: options.addedBindings} : {}),
          ...(options?.worktreeCommits?.length
              ? {worktreeCommits: options.worktreeCommits} : {}),
          ...(options?.mainlineMerge !== undefined
              ? {mainlineMerge: options.mainlineMerge} : {}),
          ...(options?.blueprintMerges?.length
              ? {blueprintMerges: options.blueprintMerges} : {}),
        }]);

        this.retireChatChanges(rows);
        this.pruneRetiredChatChanges(chatId);
        return {sequence, meta: this.getChatMetaOrThrow(chatId)};
      });
    } catch (err) {
      // The appends advance the in-memory caches even when the transaction rolls back (the
      // same recovery commitAgentStep's catch does); drop them so later reads rebuild from
      // storage.
      this.chatContentCache.delete(chatId);
      this.liveWindowCache.delete(chatId);
      throw err;
    }
  }

  // All publication paths validate durable sources before ACK; text-only gadgets cannot
  // acquire byte state that their runtime cannot compile or display.
  #validateByteChanges(change: CodeChange): void {
    for (const [id, entries] of Object.entries(change)) for (const [, file] of entries) {
      if (!("setBytes" in file)) continue;
      if (!this.isWorktree(Number(id))) throw new Error("Binary mutations require a worktree.");
      this.gitStore.readBlob(file.setBytes.oid, file.setBytes.byteLength);
    }
  }

  /**
   * AgentHooks implementation: the agent step's persistence barrier (see the interface doc for
   * the contract). One storage transaction persists the step's messages (tool-call record
   * first), appends each buffered change as a row -- broadcast immediately, superseding the
   * calls' provisional editPreview* streams (see AiChatSubscriber.changeApplied) -- and
   * materializes them into the step's single "changes" message (tool message first, so a
   * suffix revert can never erase a call while keeping its edits). Each change's `pin` is
   * validated against the gadget's *current* head and mirrored into the chat's code base with
   * its row -- head movement after the barrier merely leaves the chat stale for the accept
   * gate to catch, never retroactively fails the turn. Worktrees the step first modifies are
   * pinned here too, derived rather than declared (see below).
   *
   * The transaction protects server-side storage only: broadcasts fire on write and ignore
   * rollback (deliberate -- rerouting the subscription path through commit is out of scope),
   * so a mid-barrier exception, itself a bug, can leak broadcasts for rolled-back rows. The
   * in-memory content/byte caches *are* restored on rollback (dropped, to rebuild from
   * storage), or they would serve content the rows no longer back.
   */
  async commitAgentStep(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      step: {
        changes: AgentStepChange[],
        createdGadgets: {gadgetId: WorkpieceId, title: string, bindingName: string}[],
        createdWorktrees: {worktreeId: WorkpieceId, title: string, bindingName: string}[],
        addedBindings: {gadgetId: WorkpieceId, name: string, target: WorkpieceId}[],
        worktreeCommits: {worktreeId: WorkpieceId, commit: string, previousHead: string}[],
        blueprintMerges: BlueprintMerge[],
      },
      usage?: Usage, aiGatewayLogId?: string,
      aiGatewayLogRoute?: AiGatewayLogRoute): Promise<boolean> {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) return false;  // chat deleted mid-turn

    for (const [changeIndex, {change}] of step.changes.entries()) {
      try { validateCodeChangeSchema(change); }
      catch (error) {
        this.logger.error("invalid agent transform rejected at persistence", {
          event: "agent.step.change.invalid", chatId, changeStage: "persist", changeIndex, ...agentCodeChangeShape(change),
        });
        throw error;
      }
      this.#validateByteChanges(change);
    }

    // The worktrees this step pins: every worktree of this chat its rows or commits touch that
    // the chat holds no pin for yet. A worktree pins at its accepted commit -- the only base it
    // can have, since only an accept moves it and none can run mid-turn -- so unlike a gadget's
    // head pin there is nothing for the agent to declare or the barrier to validate: the barrier
    // derives the pin from the record (the agent mirrors it in its turn state; see
    // pinWorktreeInSession in agent-session.ts).
    let codeBasePins = this.chatCodeBase(meta).pins;
    let worktreePins = new Map<WorkpieceId, string>();
    for (let id of [...step.changes.flatMap(({change}) => changedGadgets(change)),
                    ...step.worktreeCommits.map(({worktreeId}) => worktreeId)]) {
      let record = this.storage.gadgets.get(id);
      if (record?.type === "worktree" && record.chatId === chatId &&
          !codeBasePins.some(pin => pin.gadgetId === id)) {
        worktreePins.set(id, record.pinBase);
      }
    }

    // Prefetch (awaits) before the synchronous transaction: current content (warming the cache
    // the tail below requires to be current), each new gadget pin's base tree, and the base
    // texts of any worktree paths the buffered changes edit (worktree bases are lazy; see
    // seedWorktreeEditBases), resolved against the chat's worktree pins plus the ones this step
    // establishes.
    let baseFilesByCommit = new Map<string, Map<string, string>>();
    let worktreeBases = new Map<WorkpieceId, string>();
    let worktreeSeeds = new Map<string, string | null>();
    if (step.changes.length > 0) {
      let content = await this.getCurrentChatContent(chatId, meta);
      worktreeBases = new Map([...this.worktreePinBases(meta), ...worktreePins]);
      if (worktreeBases.size > 0) {
        // The probe simulates only the changes' worktree entries: that is all the seed lookups
        // depend on (workpiece entries are independent), and gadget entries may not apply
        // against this fold (e.g. a first edit whose pin's base enters only in the transaction).
        let probe = content;
        for (let {change} of step.changes) {
          let worktreeEntries: CodeChange = {};
          for (let [key, entries] of Object.entries(change)) {
            if (worktreeBases.has(Number(key))) worktreeEntries[Number(key)] = entries;
          }
          probe = await this.prefetchWorktreeSeeds(
              probe, worktreeEntries, worktreeBases, worktreeSeeds);
          probe = applyCodeChange(probe, worktreeEntries);
        }
      }
      for (let {pin} of step.changes) {
        if (pin !== undefined && !baseFilesByCommit.has(pin.baseCommit)) {
          baseFilesByCommit.set(pin.baseCommit,
                                await this.gitStore.readCommitFiles(pin.baseCommit));
        }
      }
    }

    try {
      return this.storage.transaction(() => {
        let fresh = this.storage.chatMeta.get(chatId);
        if (!fresh) return false;  // chat deleted during the prefetches

        // Establish the step's worktree pins before the rows and the message: the pin is what
        // buildChatContent roots the worktree's changes at, and materializeChatChanges'
        // undeclared-pin stamping is what makes it durable log history on this same step's
        // "changes" message -- the one that records the rows or the commit() that pinned, so
        // reverting that message unpins the worktree along with them.
        if (worktreePins.size > 0) {
          let codeBase = this.chatCodeBase(fresh);
          for (let [gadgetId, baseCommit] of worktreePins) {
            if (!codeBase.pins.some(p => p.gadgetId === gadgetId)) {
              codeBase.pins.push({gadgetId, baseCommit, mergedCommit: baseCommit});
            }
          }
          fresh.codeBase = codeBase;
          this.storage.chatMeta.put(fresh);
        }

        if (step.changes.length > 0) {
          let codeBase = this.chatCodeBase(fresh);
          let cached = this.chatContentCache.get(chatId);
          if (cached === undefined || cached.generation !== codeBase.generation ||
              cached.revision !== codeBase.revision) {
            // Nothing should move the stream mid-turn (submissions are rejected and the
            // sibling operations assert no active turn), so a stale cache indicates a bug.
            throw new Error("Chat content changed during an agent step.");
          }
          let content = cached.content;

          for (let {change, pin} of step.changes) {
            let newPins: ChatGadgetPinState[] = [];
            if (pin !== undefined) {
              let pins = this.chatCodeBase(fresh).pins;
              let existing = pins.find(p => p.gadgetId === pin.gadgetId);
              if (existing !== undefined) {
                if (existing.baseCommit !== pin.baseCommit) {
                  throw new Error("Gadget was concurrently pinned at a different commit.");
                }
              } else {
                let record = this.storage.gadgets.get(pin.gadgetId);
                if (record?.type !== "gadget" || record.commitId !== pin.baseCommit) {
                  throw new Error("Pinned commit is no longer the gadget's head; mainline " +
                      "moved while the changes were being made.");
                }
                newPins.push({gadgetId: pin.gadgetId, baseCommit: pin.baseCommit,
                              mergedCommit: pin.baseCommit});
                content = new Map(content);
                content.set(pin.gadgetId, baseFilesByCommit.get(pin.baseCommit)!);
              }
            }
            let seeded = this.applyPrefetchedWorktreeSeeds(
                content, change, worktreeBases, worktreeSeeds);
            if (seeded === null) {
              // The prefetch covered exactly the buffered changes, so this indicates a bug,
              // like the stale-cache check above.
              throw new Error("Chat content changed during an agent step.");
            }
            content = seeded;
            validateCodeChangeContent(change, content);
            content = applyCodeChange(content, change);
            this.appendChatChangeRow(chatId, fresh, author, change, newPins, content);
          }
        }

        this.addChatMessages(chatId, author, msgs, usage, aiGatewayLogId, aiGatewayLogRoute);
        return this.materializeChatChanges(chatId, undefined, {
          author,
          allowDuringTurn: true,
          createdGadgets: step.createdGadgets,
          createdWorktrees: step.createdWorktrees,
          addedBindings: step.addedBindings,
          worktreeCommits: step.worktreeCommits,
          blueprintMerges: step.blueprintMerges,
        }) !== undefined;
      });
    } catch (err) {
      // The transaction rolled the rows back, but the append path already advanced the
      // in-memory caches to reflect them; drop both so later reads rebuild from storage.
      this.chatContentCache.delete(chatId);
      this.liveWindowCache.delete(chatId);
      throw err;
    }
  }

  // The (user, clientId, seq) dedupe step of submitCodeChange: returns the recorded landing spot
  // when the submission is an exact retry of the already-accepted change (OT, unlike a CRDT, does
  // not tolerate double-application), undefined when it is the next expected change, and throws on
  // seq misuse. Synchronous; submitCodeChange runs it both before the prefetches (the fast path)
  // and again in the synchronous append tail, because a concurrent duplicate can land during
  // the awaits between the two.
  #dedupeSubmission(clientKey: string, submission: CodeChangeSubmission, digest: string)
      : {generation: number, revision: number} | undefined {
    let clientRecord = this.storage.chatChangeClients.get(clientKey);
    if (clientRecord !== undefined) {
      if (submission.seq === clientRecord.seq) {
        if (digest !== clientRecord.digest) {
          throw new Error("A submission reused a seq with different content; discard local " +
              "edits and rebuild under a fresh clientId.");
        }
        // A retry of the already-accepted change: acknowledge without re-applying.
        return {generation: clientRecord.generation, revision: clientRecord.revision};
      }
      if (submission.seq !== clientRecord.seq + 1) {
        throw new Error("Out-of-sequence submission; discard local edits and rebuild under a " +
            "fresh clientId.");
      }
    } else if (submission.seq !== 1) {
      throw new Error("Unknown client session with seq > 1; discard local edits and rebuild " +
          "under a fresh clientId.");
    }
    return undefined;
  }

  /**
   * The body of Overseer.submitCodeChange() (see the API doc for the full contract): validate,
   * dedupe, resolve the claimed stream position (bridging across a content-preserving
   * generation boundary when needed), transform over the rows accepted since, validate the
   * transformed change against current content, and append/broadcast -- everything from the final
   * state re-read through the row write in one synchronous step.
   */
  async submitCodeChange(chatId: number, submission: CodeChangeSubmission,
                         author: AiChatAuthorInfo, userId: string)
      : Promise<{generation: number, revision: number}> {
    this.getChatMetaOrThrow(chatId);  // fail fast
    this.#validateSubmissionShape(submission);
    this.#validateByteChanges(submission.change);
    let digest = await submissionDigest(submission);

    // Dedupe by (user, clientId, seq) before anything that can reject the base: a retry of an
    // already-accepted change must get its recorded landing spot back even when its base has since
    // been destructively bumped or an agent turn has started.
    let clientKey = chatChangeClientKey(chatId, userId, submission.clientId);
    let acked = this.#dedupeSubmission(clientKey, submission, digest);
    if (acked !== undefined) {
      return acked;
    }

    // The prefetches below await, so the chat can move meanwhile; on movement that invalidates
    // what was prefetched, re-resolve from fresh state rather than failing the submission.
    for (let attempt = 0; ; attempt++) {
      let meta = this.getChatMetaOrThrow(chatId);
      // While an agent turn is active (or a message is being prepared to start one), reject
      // retryably: the client keeps its queue and resubmits after the turn.
      if (meta.activeAgent || this.isPreparingChatMessage(chatId)) {
        throw new Error(AGENT_RUNNING_ERROR_MESSAGE);
      }
      let codeBase = this.chatCodeBase(meta);

      // Resolve the claimed (generation, revision).
      let bridge: ChatChangeBoundaryRecord | undefined;
      if (submission.generation === codeBase.generation) {
        if (submission.revision > codeBase.revision) {
          throw new Error("Submission claims a revision that does not exist yet.");
        }
      } else if (codeBase.prior !== undefined &&
                 submission.generation === codeBase.prior.generation) {
        // The straggler bridge: the claimed generation was closed by a merge (content-
        // preserving), so the change can be carried across the boundary instead of discarded.
        bridge = this.storage.chatChangeBoundaries.get(chatId);
        if (bridge === undefined || bridge.generation !== submission.generation) {
          throw chatStreamGoneError();
        }
        if (submission.revision > bridge.finalRevision) {
          throw new Error("Submission claims a revision that does not exist.");
        }
      } else {
        throw chatStreamGoneError();
      }

      // Prefetch: current content, and the git data pin validation needs. Which pins apply
      // depends on the transform below, but transforms only ever drop file changes, so prefetching
      // for every *declared* pin (plus every bridge boundary commit) covers all cases.
      let content = await this.getCurrentChatContent(chatId, meta);
      let pinData = new Map<string, {head: string, recentHeads: string[],
                                     baseFiles: Map<string, string>}>();
      let prefetchPin = async (gadgetId: WorkpieceId, baseCommit: string) => {
        if (pinData.has(`${gadgetId}:${baseCommit}`)) return;
        let record = this.storage.gadgets.get(gadgetId);
        let head = record?.type === "gadget" ? record.commitId : undefined;
        if (head === undefined) return;  // validated (and rejected) in the sync tail
        // The head and up to two first-parent steps back, stopping at the declared base. One
        // accept that writes on a merge commit moves the head two steps (`C = [M]`, `M = [H,
        // ...]`), so a client that raced it still declares `H`. First parents only: a head's
        // other parents (a merged release, a chat's snapshot) were never this gadget's head.
        let recentHeads = [head];
        while (recentHeads.length < 3 && recentHeads.at(-1) !== baseCommit) {
          let parent = (await this.gitStore.readCommitObject(recentHeads.at(-1)!)).parent[0];
          if (parent === undefined) break;
          recentHeads.push(parent);
        }
        pinData.set(`${gadgetId}:${baseCommit}`, {
          head, recentHeads, baseFiles: await this.gitStore.readCommitFiles(baseCommit),
        });
      };
      for (let decl of submission.pins ?? []) {
        await prefetchPin(decl.gadgetId, decl.baseCommit);
      }
      if (bridge !== undefined) {
        for (let boundary of bridge.boundaries) {
          if (boundary.commitId !== null) {
            await prefetchPin(boundary.gadgetId, boundary.commitId);
          }
        }
      }

      // Prefetch any worktree edit bases the change needs (worktree content is lazy; see
      // seedWorktreeEditBases). Transforms only ever drop file changes, so prefetching for the
      // submitted change covers the transformed one; the synchronous tail re-checks against
      // fresh content and retries on a miss. A touched worktree the chat holds no pin for yet
      // has exactly one possible base -- its accepted commit, which the tail requires the
      // submission's declaration (or the bridge's boundary) to name -- so it is resolved here
      // from the record.
      let worktreeBases = this.worktreePinBases(meta);
      for (let id of changedGadgets(submission.change)) {
        let record = this.storage.gadgets.get(id);
        if (record?.type === "worktree" && record.chatId === chatId && !worktreeBases.has(id)) {
          worktreeBases.set(id, record.pinBase);
        }
      }
      let worktreeSeeds = new Map<string, string | null>();
      if (worktreeBases.size > 0) {
        await this.prefetchWorktreeSeeds(content, submission.change, worktreeBases,
                                          worktreeSeeds);
        // Enforce the write side of the tree-entry modes on the submission's worktree `set`s
        // and `remove`s, the same check the agent's writeFile tool makes: a path the current
        // content doesn't hold still has its base entry live, and writing over -- or deleting --
        // a symlink, gitlink, or directory is rejected with the descriptive error. Edits need no
        // separate check (their base seeding above throws it). Ingestion-only: recorded rows are
        // never re-checked, so folds stay deterministic.
        for (let [key, entries] of Object.entries(submission.change)) {
          let base = worktreeBases.get(Number(key));
          if (base === undefined) continue;
          for (let [path, fileChange] of entries) {
            if ("edit" in fileChange || content.get(Number(key))?.has(path)) continue;
            await this.gitCache.walker.assertWorktreePathWritable(base, path);
          }
        }
      }

      // ---- synchronous tail: everything below lands atomically under the output gate ----
      // Re-run the dedupe first (before anything that can reject): the prefetches above await
      // non-storage I/O, where the input gate does not hold, so a concurrent duplicate of this
      // very submission can have landed meanwhile -- it must be acknowledged, not re-applied.
      acked = this.#dedupeSubmission(clientKey, submission, digest);
      if (acked !== undefined) {
        return acked;
      }
      let fresh = this.getChatMetaOrThrow(chatId);
      if (fresh.activeAgent || this.isPreparingChatMessage(chatId)) {
        throw new Error(AGENT_RUNNING_ERROR_MESSAGE);
      }
      // The three staleness checks below (generation moved, content cache stale, apply
      // rejected) all bail to a retry; the exhausted-check lives here once, at the bottom.
      let retry = false;
      let result: {generation: number, revision: number} | "retry" | undefined;
      let freshBase = this.chatCodeBase(fresh);
      if (freshBase.generation !== codeBase.generation) {
        // A merge/revert landed during the prefetches. Re-resolve: the bridge (or a rejection)
        // will sort the submission out against the new stream.
        retry = true;
      } else {
        let cached = this.chatContentCache.get(chatId);
        if (cached === undefined || cached.generation !== freshBase.generation ||
            cached.revision !== freshBase.revision) {
          retry = true;
        } else {
          content = cached.content;
          result = this.#applyValidatedSubmission(
              chatId, fresh, freshBase, submission, author, content, pinData, bridge,
              worktreeBases, worktreeSeeds);
        }
      }
      if (retry || result === undefined || result === "retry") {
        if (attempt < 3) continue;
        throw new Error("The chat is changing too quickly; please retry.");
      }

      // Update the dedupe record in the same synchronous step as the append.
      this.storage.chatChangeClients.put({
        chatId, userId, clientId: submission.clientId, seq: submission.seq,
        generation: result.generation, revision: result.revision, digest,
      });

      // Author attribution and window bounds, after the append: if the newest rows belong to a
      // different author who has gone idle, their batch was already materialized just before
      // the append (see below); here, cap the live window's size so a long editing session
      // can't grow subscribe-replay without bound. Thanks to the retired-row grace window this
      // stales nobody. (The append just advanced the window summary to `result`, so this is an
      // O(1) cache read, not a window scan.)
      if (this.liveWindowSummary(chatId, result).count >=
          this.chatChangeMaterializeThreshold) {
        this.materializeChatChanges(chatId);
      }

      return result;
    }
  }

  // The synchronous core of submitCodeChange: transform, validate, and append, using only
  // prefetched git data. Returns "retry" when prefetched state (a pin's validated head) no
  // longer matches storage.
  #applyValidatedSubmission(
      chatId: number, meta: AiChatMetadata, codeBase: ChatCodeBase,
      submission: CodeChangeSubmission, author: AiChatAuthorInfo, content: CodeContent,
      pinData: Map<string, {head: string, recentHeads: string[],
                            baseFiles: Map<string, string>}>,
      bridge: ChatChangeBoundaryRecord | undefined,
      worktreeBases: Map<WorkpieceId, string>,
      worktreeSeeds: Map<string, string | null>)
      : {generation: number, revision: number} | "retry" {
    let transformed = submission.change;

    // Pin declarations to establish: the client's own, except that a bridged change's declarations
    // describe a world that no longer exists -- for gadgets the boundary map covers, the pin is
    // server-derived from the recorded boundary commit instead.
    let declarations = new Map<WorkpieceId, string>();
    for (let decl of submission.pins ?? []) {
      declarations.set(decl.gadgetId, decl.baseCommit);
    }

    if (bridge !== undefined) {
      // Transform over the closed generation's remaining rows to its tip...
      let oldRows = this.listChatChangesSince(
          chatId, bridge.generation, submission.revision, bridge.finalRevision);
      if (oldRows === undefined) throw chatStreamGoneError();
      for (let row of oldRows) {
        transformed = transformCodeChange(row.change, transformed).b;
      }
      // ...then across the boundary. For every touched gadget the boundary map covers, the
      // cross-generation step is the identity map (the boundary commit's tree *is* the chat
      // content at the reset); a bridge-ineligible gadget, or one whose current-generation pin
      // sits at a different base than its boundary commit, rejects the whole submission. Client
      // pin declarations for boundary-map gadgets describe the pre-merge world and are ignored
      // in favor of the map (dropped outright for gadgets the change no longer touches); gadgets
      // unpinned on both sides of the boundary keep the normal first-touch rules.
      let boundaryMap = new Map(bridge.boundaries.map(b => [b.gadgetId, b.commitId]));
      for (let [gadgetId] of declarations) {
        if (boundaryMap.has(gadgetId)) declarations.delete(gadgetId);
      }
      for (let gadgetId of changedGadgets(transformed)) {
        if (!boundaryMap.has(gadgetId)) continue;
        let commitId = boundaryMap.get(gadgetId)!;
        if (commitId === null) throw chatStreamGoneError();
        let existing = codeBase.pins.find(p => p.gadgetId === gadgetId);
        if (existing !== undefined && existing.baseCommit !== commitId) {
          // Carrying a change rooted at the boundary onto content pinned at a since-moved base
          // would need a cross-base merge, which is update-from-mainline's job.
          throw chatStreamGoneError();
        }
        declarations.set(gadgetId, commitId);
      }
      // Land in the current generation: transform over all of its rows.
      let newRows = this.listChatChangesSince(chatId, codeBase.generation, 0, codeBase.revision);
      if (newRows === undefined) throw chatStreamGoneError();
      for (let row of newRows) {
        transformed = transformCodeChange(row.change, transformed).b;
      }
    } else {
      let rows = this.listChatChangesSince(
          chatId, codeBase.generation, submission.revision, codeBase.revision);
      if (rows === undefined) throw chatStreamGoneError();
      for (let row of rows) {
        transformed = transformCodeChange(row.change, transformed).b;
      }
    }

    // Establish pins: validate each declaration against the gadget's current head (tolerating
    // the two heads before it along first parents -- the client raced exactly one accept, which
    // moves the head two steps when it writes on a merge commit) or the worktree's accepted
    // commit, idempotent against an identical existing pin, conflicting against a different one.
    // A pin behind the head is harmless: the accept's stale gate catches it.
    let newPins: ChatGadgetPinState[] = [];
    let validationContent = content;
    for (let [gadgetId, baseCommit] of declarations) {
      let existing = codeBase.pins.find(p => p.gadgetId === gadgetId);
      if (existing !== undefined) {
        if (existing.baseCommit !== baseCommit) {
          throw new Error("The gadget was concurrently pinned at a different commit; rebuild " +
              "from fresh metadata.");
        }
        continue;  // identical declaration: idempotent-accept
      }
      let record = this.storage.gadgets.get(gadgetId);
      if (record?.type === "worktree") {
        // A worktree pins at its accepted commit (WorktreeRecord.pinBase), which only an accept
        // moves -- and an accept bumps the generation, which the tail's generation check already
        // caught -- so an exact match is the whole rule: no parent tolerance, no retry. The
        // content entry starts empty; edits seed their bases lazily (worktreeBases covers this
        // worktree; see the prefetch).
        if (record.chatId !== chatId) {
          throw new Error(`Code change touches another chat's worktree: ${gadgetId}`);
        }
        if (baseCommit !== record.pinBase) {
          throw new Error("Pin declaration does not match the worktree's accepted commit.");
        }
        newPins.push({gadgetId, baseCommit, mergedCommit: baseCommit});
        continue;
      }
      if (record?.type !== "gadget" || record.commitId === undefined) {
        // Only a pending gadget lacks a head (every permanent gadget has one, possibly the
        // empty tree -- see GadgetRecord.commitId); a pending gadget's changes need no pin.
        throw new Error("Cannot pin a gadget that has no committed code.");
      }
      let prefetched = pinData.get(`${gadgetId}:${baseCommit}`);
      if (prefetched === undefined || prefetched.head !== record.commitId) {
        return "retry";  // the head moved during the prefetches; re-resolve
      }
      if (!prefetched.recentHeads.includes(baseCommit)) {
        throw new Error("Pin declaration does not match the gadget's current head.");
      }
      newPins.push({gadgetId, baseCommit, mergedCommit: baseCommit});
      if (validationContent === content) validationContent = new Map(content);
      validationContent.set(gadgetId, prefetched.baseFiles);
    }

    // Every gadget the transformed change still touches must have its content in the stream: a pin
    // (existing or established above), or the gadget is pending in this chat (its changes build its
    // content up from nothing).
    for (let gadgetId of changedGadgets(transformed)) {
      let record = this.storage.gadgets.get(gadgetId);
      if (record === undefined) {
        throw new Error(`Code change touches a nonexistent gadget: ${gadgetId}`);
      }
      if (record.type === "worktree") {
        // Worktrees are chat-private. (This chat's own worktree passes -- though until worktree
        // deliveries reach clients, a hand-rolled client edits it blind.) Pending or not, a
        // worktree's content is its accepted commit's tree, never built up from nothing, so
        // the pin requirement below applies to it from creation.
        if (record.chatId !== chatId) {
          throw new Error(`Code change touches another chat's worktree: ${gadgetId}`);
        }
      } else if (record.pending !== undefined) {
        if (record.pending.chatId !== chatId) {
          throw new Error(`Code change touches a gadget pending in another chat: ${gadgetId}`);
        }
        continue;
      }
      if (!codeBase.pins.some(p => p.gadgetId === gadgetId) &&
          !newPins.some(p => p.gadgetId === gadgetId)) {
        throw new Error("The first modification of a gadget must declare a pin (see " +
            "CodeChangeSubmission.pins).");
      }
    }

    // Seed worktree edit bases (prefetched -- commits are immutable, so the texts can't be
    // stale; a base needed but not prefetched means the content moved during the prefetches).
    let seeded = this.applyPrefetchedWorktreeSeeds(
        validationContent, transformed, worktreeBases, worktreeSeeds);
    if (seeded === null) return "retry";
    validationContent = seeded;

    // Content validation, against exactly what the change will apply to.
    validateCodeChangeContent(transformed, validationContent);

    // Materialize the pending window first when this row must not join it:
    //  - Attribution: the newest live rows belong to a different author who has gone idle, and
    //    one message must never blend two authors' sessions. (Two authors typing *concurrently*
    //    still share a batch, attributed to "Multiple Authors".)
    //  - Size: this row would push the window's summed change size past what one "changes"
    //    message may compose (materialization writes exactly one message, so the bound is
    //    enforced here, where rows accumulate; an unstorable message would wedge
    //    materialization, which retries the same compose until it succeeds). A row that alone
    //    exceeds the cap -- transformation can grow a validated change slightly -- lands in an
    //    empty window and travels alone, in a message storage proved it can hold when the row
    //    itself was written.
    let latest = this.#newestLiveChatChange(chatId, codeBase.generation);
    let authorSplit = latest !== undefined && !this.sameChatAuthor(latest.author, author) &&
        Date.now() - latest.timestamp.getTime() > CHAT_CHANGE_AUTHOR_SPLIT_MS;
    let window = this.liveWindowSummary(chatId, codeBase);
    let byteSplit = window.count > 0 &&
        window.bytes + codeChangeSerializedSize(transformed) > MAX_CODE_CHANGE_SIZE;
    if (authorSplit || byteSplit) {
      this.materializeChatChanges(chatId, meta);
      meta = this.getChatMetaOrThrow(chatId);
      codeBase = this.chatCodeBase(meta);
    }

    let row = this.appendChatChangeRow(
        chatId, meta, author, transformed, newPins,
        applyCodeChange(validationContent, transformed),
        {clientId: submission.clientId, seq: submission.seq});
    return {generation: row.generation, revision: row.revision};
  }

  // Validation of a CodeChangeSubmission beyond its declared type (the trust boundary's stage 1;
  // see validateCodeChangeSchema for the change itself, and that module's header for why neither
  // re-checks the shape capnweb-validate has already established): value formats, ranges, and
  // the cross-checks between the pins and the change.
  #validateSubmissionShape(submission: CodeChangeSubmission): void {
    if (!CHAT_CHANGE_CLIENT_ID_PATTERN.test(submission.clientId)) {
      throw new Error("Invalid clientId.");
    }
    if (!Number.isSafeInteger(submission.seq) || submission.seq < 1) {
      throw new Error("Invalid seq.");
    }
    if (!Number.isSafeInteger(submission.generation) || submission.generation < 0 ||
        !Number.isSafeInteger(submission.revision) || submission.revision < 0) {
      throw new Error("Invalid generation/revision.");
    }
    validateCodeChangeSchema(submission.change);
    let touched = new Set(changedGadgets(submission.change));
    if (touched.size === 0) {
      throw new Error("A code change submission must change something.");
    }
    if (submission.pins !== undefined) {
      let seen = new Set<WorkpieceId>();
      for (let pin of submission.pins) {
        if (!Number.isSafeInteger(pin.gadgetId) || pin.gadgetId < 0 || seen.has(pin.gadgetId)) {
          throw new Error("Invalid pin declaration.");
        }
        seen.add(pin.gadgetId);
        validateOid(pin.baseCommit);
        if (!touched.has(pin.gadgetId)) {
          throw new Error("Pin declaration for a gadget the change does not touch.");
        }
      }
    }
  }

  protected appendWorkspaceAttachments(
      chatId: number, worktree: WorktreeRecord,
      prepared: {change: CodeChange, content: CodeContent}[], author: AiChatAuthorInfo): void {
    for (const {change, content} of prepared) {
      const meta = this.getChatMetaOrThrow(chatId), base = this.chatCodeBase(meta);
      const pins = base.pins.some(pin => pin.gadgetId === worktree.id) ? [] :
        [{gadgetId: worktree.id, baseCommit: worktree.pinBase, mergedCommit: worktree.pinBase}];
      this.appendChatChangeRow(chatId, meta, author, change, pins, content);
      this.materializeChatChanges(chatId, undefined, {author, allowDuringTurn: true});
    }
  }
}
