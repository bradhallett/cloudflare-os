import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { WorkpieceId, GatekeeperClient, AiChatMessage, AiChatAuthorInfo, AiChatMessageBody, GatekeeperCreationSpec, validateBindingName } from "@gadgets/workshop-shared/api";
import { Gatekeeper, ActionDescription, ObservationDescription, resolveRequestedResource, HookController, HookDescription } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ActionRecord, GatekeeperCaller, GatekeeperClass, GatekeeperRecord } from "./storage-schema/overseer-storage";
import { WorktreeSessionImpl } from "./worktree-session";
import { GitImpl } from "./git-binding";
import { GadgetExportsImpl } from "./exports-session";
import { chatChangeStatuses } from "./agent-compaction";
import { autoApprovalRule } from "./auto-approval";
import { retryOnDoReset } from "./do-retry";
import { OverseerBlueprints } from "./overseer-blueprints";
import type { SessionKind } from "./overseer-support";
import { ApprovalQueueImpl, GatekeeperClientImpl } from "./overseer-gatekeeper-client";
import type { BindingLoopbackTarget } from "./overseer-loopbacks";
import { BUILTIN_TOOL_GATEKEEPER_ID } from "./overseer-chat-attachments";
import { gatekeeperVendorId } from "./overseer-binding-info";

/**
 * OverseerGatekeepers: gatekeeper sessions, captured actions, observation, hooks, and connection requests.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerGatekeepers extends OverseerBlueprints {
  // The body of Overseer.revertChanges(), running under the chat's operation lock (callers
  // hold withChatLock).
  async revertChanges(chatId: number, revertFrom: number, author: AiChatAuthorInfo)
      : Promise<void> {
    this.assertChatNotActive(chatId);

    // Reap crash orphans first. (Reconciliation is best-effort, so an unstamped record can
    // still survive a failed reap; it has no sequence and is not covered by this revert.) This
    // is the only await before the revert lands; reconciliation is an idempotent repair, safe
    // to run whether or not the revert below proceeds.
    await this.reconcilePendingGadgets(chatId);

    // Everything from the meta re-read (which rechecks the agent after the await above) through
    // the message and record writes below is synchronous, landing atomically under the output
    // gate: nothing can interleave between what we examine here, the "changes" messages the
    // revert message will cover, and the mutations recording the revert.
    let meta = this.assertChatNotActive(chatId);
    let messages = [...this.storage.chats.list({prefix: chatKeyPrefix(chatId)})];
    let statuses = chatChangeStatuses(messages);
    let stillProposed = (msg: AiChatMessage) =>
        msg.type === "changes" && msg.sequence >= revertFrom &&
        statuses.get(msg.sequence) === undefined;

    // A revert that erases the chat's conversion boundary (the synthetic message the git-storage
    // migration wrote; see AiChatMessageBody.conversionBoundary) must also cover every earlier
    // still-proposed "changes" message: the boundary's change collapsed the surviving
    // pre-conversion edits into one batch, and the legacy messages that recorded them survive
    // only as content-less proposed markers, so a revert erasing the boundary while keeping any
    // of them would leave the chat forever proposing batches whose content is unreconstructable.
    // Reverting everything (the discard-all path's revertFrom 0) or from after the boundary
    // works normally.
    let boundary = messages.find(msg => msg.type === "changes" && msg.conversionBoundary);
    if (boundary !== undefined && revertFrom <= boundary.sequence &&
        messages.some(msg => msg.type === "changes" && msg.sequence < revertFrom &&
                      statuses.get(msg.sequence) === undefined)) {
      throw new Error("Cannot discard these changes by themselves: changes from before this " +
          "chat's conversion to git-backed storage were collapsed into a single batch and can " +
          "only be discarded together. Discard all of the chat's pending changes instead.");
    }

    // A still-proposed mainline merge that records no `gadgets` cannot be reverted: it advanced
    // the chat's pins to commits whose content arrived in that very update, so erasing the
    // update would leave the pins claiming content the chat no longer has -- and a later accept
    // would then silently overwrite those mainline changes. Rolling the pins back needs their
    // pre-merge values, which only a merge that records `gadgets` keeps (see the pin settlement
    // below). (An *accepted* mainline merge is untouched by reverts, so it doesn't block
    // anything. Scanned over canonical history, since a compaction checkpoint keeps no trace of
    // individual messages.)
    for (let msg of messages) {
      if (msg.type === "changes" && msg.mainlineMerge !== undefined &&
          msg.mainlineMerge.gadgets === undefined && stillProposed(msg)) {
        throw new Error("Cannot revert changes that include an update from mainline: the " +
            "update brought in other chats' accepted work, which the revert would silently " +
            "discard. Edit or revert the files directly instead.");
      }
    }

    if (!messages.some(stillProposed)) {
      // Revert affects no materialized changes (every "changes" message at or after revertFrom
      // is already merged or reverted -- and any provisional gadget's stamped creation sits on
      // a still-proposed message, so nothing needs deleting either), so no revert message is
      // recorded. Outstanding drafts are still strictly newer than every message -- inside the
      // reverted range by definition -- so they are discarded exactly as a draft discard would
      // (unlogged pins die with them, generation bump); with no drafts this is a full no-op.
      this.discardChatDraftChanges(chatId);
      return;
    }

    // Delete provisional binding edges whose addition falls within the reverted range:
    // rejecting the chat's changes rejects the edges they added. (Edges on a gadget doomed
    // below go with its whole record instead.)
    let doomed = this.listPendingGadgets(chatId).filter(gadget =>
        gadget.pending!.sequence !== undefined && gadget.pending!.sequence >= revertFrom);
    let doomedIds = new Set(doomed.map(gadget => gadget.id));
    for (let gadget of this.storage.gadgets.list()) {
      if (gadget.type !== "gadget" || doomedIds.has(gadget.id)) continue;
      let removed = false;
      for (let [name, edge] of Object.entries(gadget.bindings)) {
        if (edge.pending?.chatId === chatId && edge.pending.sequence !== undefined &&
            edge.pending.sequence >= revertFrom) {
          delete gadget.bindings[name];
          removed = true;
        }
      }
      if (removed) {
        this.storage.gadgets.put(gadget);
        this.bumpVersion([gadget.id]);
      }
    }

    let timestamp = this.getChatTimestamp();

    let revertMessage: AiChatMessage = {
      chatId,
      sequence: this.nextChatSequence(chatId),
      timestamp,
      author,

      type: "revert",
      revertFrom,
    };
    this.storage.chats.put(revertMessage);

    // Settle the pins, one record per field. `declaredPins` reads the log as it now stands --
    // including the revert message just written -- so a pin's base is its last surviving
    // declaration's, which a reverted re-root hands back to the declaration before it. Pins
    // declared only by reverted messages drop out, as do meta-only pins with no logged
    // declaration at all (established by rows that never materialized: those rows die below,
    // and nothing else roots in their bases).
    //
    // `mergedCommit` goes back to what the earliest reverted update from mainline records it
    // was before (MainlineMergeGadget.baseCommit), and nothing else moves it. Not the
    // surviving declaration's `mergedCommit`: an update from before re-roots advanced the pin
    // without declaring anything, so the declaration can be behind the content the chat still
    // holds, and the next update would merge against too old a base.
    let codeBase = this.chatCodeBase(meta);
    let declared = this.declaredPins(chatId);
    let mergedBefore = new Map<WorkpieceId, string>();
    for (let msg of messages) {
      if (msg.type !== "changes" || !stillProposed(msg)) continue;
      for (let {gadgetId, baseCommit} of msg.mainlineMerge?.gadgets ?? []) {
        if (!mergedBefore.has(gadgetId)) mergedBefore.set(gadgetId, baseCommit);
      }
    }
    codeBase.pins = codeBase.pins.flatMap(pin => {
      let declaration = declared.get(pin.gadgetId);
      if (declaration === undefined) return [];
      return [{
        gadgetId: pin.gadgetId,
        baseCommit: declaration.baseCommit,
        mergedCommit: mergedBefore.get(pin.gadgetId) ?? pin.mergedCommit,
      }];
    });

    // Roll back worktree heads: a revert covering a `worktreeCommits`-bearing message returns
    // each affected worktree's head to the *earliest* reverted advancement's previousHead --
    // entries are ordered within a message and messages by sequence, so the first one seen per
    // worktree is the state before any reverted commit, however many the range covers. The
    // commit objects themselves remain (content-addressed, now dangling, like auto-commits), so
    // e.g. a queued push naming a rolled-back commit id stays valid. This applies equally to a
    // worktree whose creation the revert covers: the worktree itself survives (see
    // WorktreeRecord.pending).
    let rolledBackWorktrees = new Set<WorkpieceId>();
    for (let msg of messages) {
      if (msg.type !== "changes" || !stillProposed(msg)) continue;
      for (let {worktreeId, previousHead} of msg.worktreeCommits ?? []) {
        if (rolledBackWorktrees.has(worktreeId)) continue;
        rolledBackWorktrees.add(worktreeId);
        let record = this.storage.gadgets.get(worktreeId);
        if (record?.type === "worktree" && record.chatId === chatId) {
          record.headCommit = previousHead;
          this.storage.gadgets.put(record);
        }
      }
    }

    // Erase all change rows: live rows are strictly newer than every materialized message, so they
    // fall inside the reverted range by definition -- and retired rows' transform window is
    // meaningless across a destructive bump, whose erased content nothing can transform onto.
    // The bump is destructive (`prior` absent, boundary record gone): already-applied changes are
    // erased, so clients whose content contains them must discard local state and rebuild
    // rather than submit changes rooted in erased history. The stream restarts at revision 0 --
    // revisions are scoped to the generation, so a delayed event or retry can't be
    // misattributed to the new stream.
    this.deleteAllChatChanges(chatId);
    codeBase.generation += 1;
    codeBase.revision = 0;
    delete codeBase.prior;
    meta.codeBase = codeBase;

    meta.lastActive = timestamp;
    this.refoldChatCompactions(chatId, revertFrom, [...messages, revertMessage]);
    this.storage.chatMeta.put(meta);
    this.proposedChangesChanged(chatId);

    // Only now delete the provisional gadgets whose creation the revert rejected -- the revert
    // message is also how the agent learns of the rejection on its next turn (revert messages
    // are surfaced to the model during history replay). Deletion awaits (removeWorkpiece is the
    // full path: hooks, facet, registry entry; a pending gadget's files exist only in the
    // chat's proposed changes, so its mainline root has nothing to clear), and a destructive
    // change must never outrun its durable record: with the revert already recorded, a failure
    // or crash here leaves records whose creation the log marks reverted, which the next
    // reconcilePendingGadgets run reaps. This one does exactly that (the records' creations are
    // now marked reverted), keeping the deletion path single.
    await this.reconcilePendingGadgets(chatId);
  }

  // `joinAs` counts the returned client toward #hasCollaboratorSession for its lifetime; passed by
  // the collaborator-facing mints, omitted for the owner's and for internal callers (see
  // GadgetClientImpl). `actorUserId` is who the returned client acts for, for analytics only.
  async addGatekeeper(
      cls: GatekeeperClass, creationSpec: GatekeeperCreationSpec, actorUserId: string,
      joinAs?: SessionKind)
      : Promise<GatekeeperClient<any>> {
    let id = this.allocateWorkpieceId();
    let gatekeeperRecord: GatekeeperRecord = {
      id,
      class: cls,
      creationSpec,
    };

    // The record is published only once, below, after describe() resolves -- the facet takes the
    // class directly so it needs no record to exist yet. Publishing it before the await instead
    // would expose the connection for as long as describe() takes, which is entirely before
    // #restartIfSessionsAffected severs the sessions that were never verified against it: the DO's
    // input gate is open across the await, ids are allocated sequentially, so a live build session
    // can guess this one, and getGatekeeperById (OverseerClientInterface) gates on nothing but
    // existence.
    let facet = await this.getGatekeeperFacet(id, cls);
    try {
      let description = await facet.describe();
      gatekeeperRecord.resourceTitle = description.title;
      gatekeeperRecord.resourceUrl = description.url;
      gatekeeperRecord.hasSlashCommands = description.hasSlashCommands;
      this.storage.gatekeepers.put(gatekeeperRecord);
    } catch (error) {
      // Still the right teardown with nothing published: it deletes the facet we just created, and
      // deleting an unwritten record is a no-op.
      this.removeGatekeeper(id);
      throw error;
    }

    // A new account-requiring connection is in every "build" collaborator's verification scope
    // immediately -- a live build session can getGatekeeperById() and openSession() on it with no
    // observer check -- so sever those sessions. It is in no "use" collaborator's scope until some
    // gadget binds it, which restarts then. A vendorless spec (aiModel/agentSpawner) is in nobody's
    // scope (#inScopeGatekeepers skips it), so it widens nothing at creation -- including an
    // agentSpawner's env targets: an unbound spawner is unreachable and its env names
    // pre-existing records, so those enter "use" scope only when a gadget binds the spawner,
    // which the transitive bind/promotion/hook diffs pick up (#useScopeGatekeeperIds).
    //
    // When sessions were severed, additionally block the id until the reset lands: the record was
    // published above (it must be durable before the reset) but the severed sessions stay live for
    // the reset's response-delivery delay, and nothing else stops them reaching the new id in that
    // window. Publish, restart-check, and mark share one synchronous block, so no request can
    // interleave between the record appearing and the block taking effect.
    if (creationSpec && "vendorId" in creationSpec) {
      if (this.restartIfSessionsAffected(
          "Gadget restarted because a new connection was added.", "build")) {
        this.gatekeepersPendingRestart.add(id);
      }
    }

    return new GatekeeperClientImpl<any>(
        this.self(), id, await this.getGatekeeperFacet(id), actorUserId, joinAs);
  }

  // Open the session behind a binding loopback.
  startGatekeeperSession(target: BindingLoopbackTarget, caller: GatekeeperCaller): Promise<any> {
    switch (target.type) {
      case "gadget": {
        if (caller.from === "agent") {
          this.#getOrCreateCapturedActions(caller.chatId).accessedGadget = true;
        }
        let chatId = "chatId" in caller ? caller.chatId : undefined;
        return this.getGadgetFacet(target.id, chatId);
      }

      case "gatekeeper":
        return this.getGatekeeperFacet(target.id)
            .then(facet => this.openGatekeeperSession(target.id, facet, caller));

      case "worktree": {
        // The programmatic Worktree binding (worktree-session.ts). A worktree's uncommitted
        // content and buffered effects live in the agent turn, so the session resolves against
        // the turn state executeCodeMode registered for the calling chat -- reachable only from
        // the agent's own executeCode (never gadgets: worktrees can't be bound into them), and
        // only while the *minting* execution runs: the loopback's executionId must match the
        // registered turn's, so a stub retained past its execution (e.g. stored in a gadget)
        // fails closed here rather than reviving against a later execution's turn.
        if (caller.from !== "agent") {
          throw new Error("Worktree bindings are only available to the agent's executeCode.");
        }
        let record = this.getWorktreeRecord(target.id);
        if (record.chatId !== caller.chatId) {
          throw new Error(`No such worktree: ${target.id}`);
        }
        let turn = this.activeWorktreeTurns.get(caller.chatId);
        if (turn === undefined || turn.executionId !== target.executionId) {
          throw new Error(
              "This worktree binding is no longer live; worktree bindings are usable only " +
              "while the executeCode call they were provided to is running.");
        }
        // Commits go to the turn's initiator: in a collaborative chat, a collaborator's work is
        // attributed to the collaborator, matching how accepted commits use the acting user's
        // profile.
        let initiator = turn.initiator;
        return Promise.resolve(
            new WorktreeSessionImpl(this, target.id, turn.access, async () => initiator));
      }

      case "exports":
        if (caller.from !== "agent") {
          // Currently unreachable, since the gadget export API is only exposed
          // to the workshop agent.
          throw new Error("Gadget exports are only available to the agent's executeCode.");
        }
        this.#getOrCreateCapturedActions(caller.chatId).accessedGadget = true;
        return Promise.resolve(new GadgetExportsImpl(this, target.id, caller.chatId));

      case "git":
        return Promise.resolve(new GitImpl(this, () => this.#gitAuthorFor(caller)));

      default:
        target satisfies never;
        throw new TypeError("Unknown binding target type.");
    }
  }

  // Who commits made through `caller`'s env.GIT are attributed to: for the agent, its turn's
  // initiator, exactly as its commits through a createWorktree binding are; for everything else
  // -- gadget code, with no user behind it -- the identity a spawned agent's turn carries, with
  // the owner standing in for a spawner's creator. Resolved at commit time, so read-only use
  // of env.GIT never waits on the owner's DO.
  async #gitAuthorFor(caller: GatekeeperCaller): Promise<AiChatAuthorInfo> {
    let turn = caller.from === "agent" ? this.activeWorktreeTurns.get(caller.chatId) : undefined;
    if (turn !== undefined) return turn.initiator;
    return this.gadgetAuthorFor(await retryOnDoReset(() => this.ownerUserDo().whoami(), this.logger));
  }

  // Maps chat ID to action numbers recently performed by that chat's agent. These are drained into
  // the chat log after the tool returns. `awaitDecision` is true if any captured action needs it.
  #capturedActions = new Map<number, {actions: number[], accessedGadget: boolean,
                                      awaitDecision: boolean}>();

  // Maps chat ID to connectionRequest message bodies created by that chat's agent during the
  // current step. Spliced into the chat log after the tool call returns (see
  // consumeCapturedConnectionRequests), so they appear after the assistant's tool-call message.
  #capturedConnectionRequests = new Map<number, AiChatMessageBody[]>();

  #getOrCreateCapturedActions(chatId: number) {
    let result = this.#capturedActions.get(chatId);
    if (!result) {
      result = {actions: [], accessedGadget: false, awaitDecision: false};
      this.#capturedActions.set(chatId, result);
    }
    return result;
  }

  protected async associateAction(caller: GatekeeperCaller, actionId: number) {
    try {
      if (caller.from === "agent") {
        this.#getOrCreateCapturedActions(caller.chatId).actions.push(actionId);
      } else if (caller.from !== "hook" && caller.chatId !== undefined && this.ownerId) {
        let owner = this.users.get(this.users.idFromString(this.ownerId));
        let userMeta = await owner.getChatContext(null);
        this.addChatMessages(caller.chatId, this.gadgetAuthorFor(userMeta.profile),
                             [{type: "action", actionId}]);
      }
    } catch (err) {
      this.logger.warn("failed to post action chat message", {
        event: "action.chat.message.post.failed", actionId, error: err,
      });
    }
  }

  async authorizeObservation(gatekeeperId: number, description: ObservationDescription,
                             caller: GatekeeperCaller): Promise<void> {
    // Forward exclusion: the gatekeeper may name observers who must not see this observation. Since
    // v1 has no per-thread hiding, the only way to let such an observation proceed is if no named
    // observer could reach it -- either they have lost access in the sharing graph, or this
    // connection has left their role's verification scope. See
    // observers-implementation-plan.md §5 Step 5.
    if (description.excludeObservers && description.excludeObservers.length > 0) {
      await this.enforceExcludeObservers(gatekeeperId, description.excludeObservers);
    }

    // Setting ownerInvitesOnly narrows access to direct owner grants (see
    // SharingManager.computeEffectiveRoles), so the first observation to set it snapshots who had
    // access beforehand. The manager may need an RPC on first use; from the flag read below through
    // the diff after the writes, nothing awaits.
    let sharing = description.ownerInvitesOnly && !this.storage.ownerInvitesOnly.get()
        ? await this.getSharingManager() : undefined;
    let baseline = sharing && !this.storage.ownerInvitesOnly.get()
        ? sharing.computeEffectiveRoles() : undefined;

    if (description.containsRestrictedData) {
      this.storage.containsRestrictedData.put(true);
    }
    if (description.ownerInvitesOnly) {
      this.storage.ownerInvitesOnly.put(true);
    }

    let actionId = this.storage.nextActionId.get();
    this.storage.nextActionId.put(actionId + 1);

    let gatekeeper = this.storage.gatekeepers.get(gatekeeperId);

    let record: ActionRecord = {
      id: actionId,
      gatekeeperId,
      caller,
      resourceTitle: gatekeeper?.resourceTitle,
      resourceUrl: gatekeeper?.resourceUrl,
      createdAt: new Date(),
      state: "approved",
      type: "observation",
      description
    };

    this.storage.actions.put(record);
    this.associateAction(caller, actionId);

    if (sharing && baseline) {
      let affected = sharing.computeAffectedByOwnerInvitesOnly(baseline);
      if (affected.length > 0) {
        // Anyone who joined through a link or through another collaborator just lost access (or
        // was downgraded), so sever live sessions as removeCollaborator does, after the writes
        // above. The cleanup is best-effort and not awaited: the observation shouldn't wait on
        // gatekeeper and User-DO round trips, and whatever the restart cuts off self-heals (see
        // removeCollaborator).
        this.scheduleAccessRestart(
            "Gadget restarted to revoke access for people the owner did not add directly.");
        this.tearDownLostObservers(affected)
            .then(() => this.refreshAffectedCollaboratorListings(affected))
            .catch(err => {
              this.logger.warn("failed to clean up after ownerInvitesOnly revoked access", {
                event: "sharing.owner.invites.only.cleanup.failed", error: err,
              });
            });
      }
    }
  }

  // Record an observation that originated from a built-in agent tool (not a gatekeeper).
  // The `gatekeeperId` is set to the BUILTIN_TOOL_GATEKEEPER_ID sentinel so that downstream
  // code (which expects a gatekeeper to dereference for approve/reject) never touches it —
  // observations bypass the approve/reject paths anyway.
  async recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void> {
    let caller: GatekeeperCaller = {from: "agent", chatId};

    let actionId = this.storage.nextActionId.get();
    this.storage.nextActionId.put(actionId + 1);

    let record: ActionRecord = {
      id: actionId,
      gatekeeperId: BUILTIN_TOOL_GATEKEEPER_ID,
      caller,
      resourceTitle,
      resourceUrl,
      createdAt: new Date(),
      state: "approved",
      type: "observation",
      description
    };

    this.storage.actions.put(record);
    this.associateAction(caller, actionId);
  }

  async submitAction(gatekeeperId: number, action: number | "create",
                     description: ActionDescription, caller: GatekeeperCaller)
      : Promise<void> {
    // An in-flight facet RPC can outlive removeGatekeeper, and a pending action on a removed
    // connection could never be approved or rejected (both dereference the facet).
    let gatekeeper = this.storage.gatekeepers.get(gatekeeperId);
    if (!gatekeeper) {
      throw new Error(
          "This action was blocked because the connection it was submitted through has been " +
          "removed from this workspace.");
    }

    // Restricted mode: the approver vouches for the text they read, and a push's commits cannot
    // be reviewed as text here, so a push is refused outright until there is a UI to review
    // commits. Any other action pends for manual approval; one whose description is not complete
    // (ActionDescription.descriptionIsComplete) is flagged to the approver rather than refused.
    // The message reaches the agent as the tool error.
    if (this.storage.containsRestrictedData.get() && description.pushedCommits?.length) {
      throw new Error(
          "This workspace has observed sensitive data. To prevent leaks, an action is only accepted " +
          "when the approver can review everything it will send, and a git push cannot be " +
          "reviewed as of yet.");
    }

    // Push authorization (see ActionDescription.pushedCommits): before anything is queued,
    // verify that every declared head's ancestry reaches a commit proven on this gatekeeper's
    // remote. This is the chokepoint that makes an accidental push to an unrelated remote fail
    // closed at queue time, with the error propagating to the submitting gatekeeper (and on to
    // the agent). Read-only; the marking walk below runs only if this passes.
    if (description.pushedCommits !== undefined && description.pushedCommits.length > 0) {
      this.gitCache.verifyPushAncestry(gatekeeperId, description.pushedCommits);
    }

    let actionId = this.storage.nextActionId.get();
    this.storage.nextActionId.put(actionId + 1);

    let record: ActionRecord = {
      id: actionId,
      gatekeeperId,
      caller,
      resourceTitle: gatekeeper.resourceTitle,
      resourceUrl: gatekeeper.resourceUrl,
      action,
      createdAt: new Date(),
      state: "pending",
      type: "action",
      description
    };

    // The marking walk stamps the verified push closure "pending push" -- the read grant that
    // lets the gatekeeper simulate the queued push -- in the same transaction that persists the
    // action record, so the marks and the action can never disagree.
    this.storage.transaction(() => {
      if (description.pushedCommits !== undefined && description.pushedCommits.length > 0) {
        this.gitCache.markPushClosure(gatekeeperId, actionId, description.pushedCommits);
      }
      this.storage.actions.put(record);
    });
    this.associateAction(caller, actionId);

    // Same auto-approval gate the drainer uses, named because awaitDecision uses it too. The drain
    // is deferred because applying calls back into the gatekeeper facet still awaiting submitAction.
    let willAutoApprove = autoApprovalRule(this.storage, gatekeeperId, description) !== undefined;
    if (!willAutoApprove) this.traceAgentActionApproval(record, "requested");

    // Only agent turns suspend on awaitDecision, and only when a manual decision is pending: on this
    // action, or on an earlier one the in-order drain stops at. Auto-approved actions keep the
    // seamless behavior the user opted into.
    if (caller.from === "agent" && description.awaitDecision && (!willAutoApprove ||
        [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)].some(queued =>
            queued.type === "action" &&
            autoApprovalRule(this.storage, gatekeeperId, queued.description) === undefined))) {
      this.#getOrCreateCapturedActions(caller.chatId).awaitDecision = true;
    }

    if (willAutoApprove) {
      this.ctx.waitUntil(this.drainAutoApprovals(gatekeeperId));
    }
  }

  async bindHook<Hook extends RpcTarget>(
        gatekeeperId: number, controller: Fetcher<HookController<Hook>>,
        callback: NativeRpcStub<Hook>, description: HookDescription, caller: GatekeeperCaller)
        : Promise<void> {
    let hookId = this.storage.nextHookId.get();
    this.storage.nextHookId.put(hookId + 1);

    let actionId = this.storage.nextActionId.get();
    this.storage.nextActionId.put(actionId + 1);

    // Hooks start out disabled, until the user enables them. (But we could consider changing
    // that.)
    let enabled = false;

    // Which gadget does this hook wake (for bookkeeping; the callback itself already
    // encapsulates the correct restore target)? A gadget caller names itself. An agent caller
    // forged the callback via `env.<GADGET>.rpc[restore]` during the currently-running executeCode
    // invocation, so when exactly one gadget had a stub forged there, attribute the hook to it;
    // otherwise (or for other callers) fall back to the workspace's first gadget.
    // TODO: Replace this heuristic with introspection of the callback stub's actual restore
    //   target once the runtime offers an API for that.
    let gadgetId: WorkpieceId | undefined;
    if (caller.from === "gadget" && caller.gadgetId !== undefined) {
      gadgetId = caller.gadgetId;
    } else {
      gadgetId = (caller.from === "agent" ? this.#soleForgedRestoreTarget(caller.chatId) : undefined)
          ?? this.executeCodeRestoreTarget();
    }

    let gatekeeper = this.storage.gatekeepers.get(gatekeeperId);

    this.storage.boundHooks.put({
      id: hookId,
      actionId,
      gatekeeperId,
      ...(gadgetId !== undefined ? {gadgetId} : {}),
      vendorId: gatekeeperVendorId(gatekeeper),
      controller: controller as unknown as Fetcher<HookController<RpcTarget>>,
      callback: callback as unknown as NativeRpcStub<RpcTarget>,
      description,
      enabled,
    });

    let record: ActionRecord = {
      id: actionId,
      gatekeeperId,
      caller,
      resourceTitle: gatekeeper?.resourceTitle,
      resourceUrl: gatekeeper?.resourceUrl,
      createdAt: new Date(),
      state: "approved",
      type: "bindHook",
      hookId,
      description,
      enabled,
    };

    this.storage.actions.put(record);
    this.associateAction(caller, actionId);
  }

  // Every gatekeeper session -- GatekeeperClientImpl.openSession and binding loopbacks via
  // startGatekeeperSession alike -- passes through here, so this is where a connection still
  // blocked pending a scope-widening restart is refused (see #gatekeepersPendingRestart).
  openGatekeeperSession<Session extends RpcCompatible<Session>>(
      id: number, facet: Fetcher<Gatekeeper<Session>>, caller: GatekeeperCaller)
      : Promise<RpcStub<Session>> {
    this.assertGatekeeperUsable(id);
    // @ts-expect-error TODO: Remove annotation when Cap'n Web fixes cyclic type issues
    return facet.startSession(new ApprovalQueueImpl(this, id, caller));
  }

  consumeCapturedActions(chatId: number)
      : {actions: number[], accessedGadget: boolean, awaitDecision: boolean} | undefined {
    let result = this.#capturedActions.get(chatId);
    this.#capturedActions.delete(chatId);
    // Submission latched this, but the user may decide while the tool still runs, before the step's
    // action cards exist for an approval to resume from. So stop only for an awaited action that is
    // still pending, or was rejected (which ends the turn).
    if (result) {
      result.awaitDecision &&= result.actions.some(id => {
        let record = this.storage.actions.get(id);
        return record?.type === "action" && record.description.awaitDecision &&
            record.state !== "approved";
      });
    }
    return result;
  }

  // Records a pending connection request. `requested` is true only when a request was actually
  // created (and an accept/deny card will appear); when false, the request was rejected for the
  // reason in `message` and the agent should fix it and retry — the turn must NOT end (see the
  // `connectionRequested` flag in agent.ts).
  async requestConnection(chatId: number, input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;
    bindingName: string;
  }): Promise<{ requested: boolean; message: string }> {
    // The agent loop already validated the binding name against the chat's scope; re-validate
    // its shape here defensively (this is the boundary that persists it).
    validateBindingName(input.bindingName);

    // Resolve the vendor's display name (and validate it exists).
    let vendors = await this.listGatekeeperVendorsCached();
    let vendor = vendors.find(v => v.id === input.vendorId);
    if (!vendor) {
      return { requested: false, message:
          `Cannot request a connection: unknown vendor "${input.vendorId}". ` +
          `Available vendors: ${vendors.map(v => v.id).join(", ") || "(none)"}.` };
    }

    // Resolve the exact resource this request maps to, using the same precedence the accept modal
    // uses. If it can't be resolved, REJECT the request: otherwise the user would get an accept
    // card that opens a blank "create new connection" picker. The agent is told what to fix.
    let resolved = resolveRequestedResource(vendor.supportedResources, input.resourceUrl);
    if (!resolved.ok) {
      return { requested: false, message:
          `Cannot request a connection for "${vendor.description.displayName}": ${resolved.reason}` };
    }

    let requestId = `${chatId}:${crypto.randomUUID()}`;
    let body: AiChatMessageBody = {
      type: "connectionRequest",
      requestId,
      vendorId: input.vendorId,
      vendorName: vendor.description.displayName,
      vendorLogoUrl: vendor.description.logo?.url,
      resourceTitle: resolved.resource.title,
      resourceUrl: input.resourceUrl,
      resourceUrlPattern: resolved.resource.urlPattern,
      reason: input.reason,
      state: "pending",
      // Claims the name in the chat's scope from this moment until denial; on acceptance the
      // resource enters the chat's env under it.
      bindingName: input.bindingName,
    };

    let list = this.#capturedConnectionRequests.get(chatId);
    if (!list) {
      list = [];
      this.#capturedConnectionRequests.set(chatId, list);
    }
    list.push(body);

    return { requested: true, message:
        `Connection request sent to the user for "${vendor.description.displayName}". ` +
        `Awaiting their decision; your turn will end now. If they accept, you'll be resumed with ` +
        `access to the resource; if they deny, your turn stays ended until the user messages you.` };
  }

  consumeCapturedConnectionRequests(chatId: number): AiChatMessageBody[] {
    let result = this.#capturedConnectionRequests.get(chatId) ?? [];
    this.#capturedConnectionRequests.delete(chatId);
    return result;
  }

  // If exactly one gadget has had a restore stub forged in the chat's current executeCode
  // invocation, return it. Used by bindHook() to attribute the hook to the gadget its callback
  // (probably) restores to.
  #soleForgedRestoreTarget(chatId: number): WorkpieceId | undefined {
    let targets = this.forgedRestoreTargets.get(chatId);
    return targets?.size === 1 ? targets.values().next().value : undefined;
  }
}
