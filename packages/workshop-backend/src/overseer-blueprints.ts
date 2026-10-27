import { WorkpieceId, ChatGadgetPinState, MergeChangesResult, AiChatMessage, AiChatAuthorInfo, BlueprintMetadata, BlueprintOutput, BlueprintMerge, ApplyBlueprintResult, GadgetUpstream } from "@gadgets/workshop-shared/api";
import { requireTextFiles } from "@gadgets/workshop-shared/code-change";
import type { FileContent } from "@gadgets/workshop-shared/code-change";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { ChatChangeBoundaryRecord, GadgetRecord } from "./storage-schema/overseer-storage";
import { commitIdentityForAuthor, filesEqual, threeWayMerge } from "./git-store";
import { formatMissingBlueprintBindings } from "./agent-prompt";
import { deploymentOutputForBlueprint, readAdminConfig } from "./admin-config";
import { chatChangeStatuses } from "./agent-compaction";
import { sanitizeBlueprintOutput } from "./blueprint-archive";
import { releaseMergeHeader } from "./blueprint-release";
import { encodeGitTree, gitObjectOid } from "./git-codec";
import { resolveBlueprintForUser } from "./blueprint-access";
import { retryOnDoReset } from "./do-retry";
import type { UserChatContext } from "./user";
import { OverseerBindings } from "./overseer-bindings";
import { acceptWriteError } from "./overseer-support";

/**
 * OverseerBlueprints: blueprint application and mergeChanges.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerBlueprints extends OverseerBindings {
  /**
   * The body of GadgetClient.applyBlueprint(): proposes, in a new chat, merging the blueprint's
   * current release into the gadget. `userMeta` is the chat context of the user applying it,
   * resolved for the model they named, and `clientUserId` is that user's DO id.
   *
   * Modelled on updateChatFromMainline(): the merge is written as a commit, `M = [H, R]`, which
   * marks the release it merged (see releasesMergedSince), and the new chat is pinned at it,
   * with the gadget's head `H` as the pin's `mergedCommit`. One "changes" message declares the
   * pin and records the proposal (see AiChatMessageBody.blueprintMerges); it carries no change.
   * Nothing here touches the gadget. Accepting the chat is what does, fast-forwarding through
   * `M` (see mergeChanges).
   */
  async applyBlueprint(gadgetId: WorkpieceId, blueprintId: string,
                       options: {allowUnrelated?: boolean}, userMeta: UserChatContext,
                       clientUserId: string)
      : Promise<ApplyBlueprintResult> {
    let author = userMeta.profile;
    // The blueprint may belong to one of the applying user's orgs, so this is the member-gated
    // read, not the public by-id one. Orgs key members by the user identifier -- the user DO's
    // name, which `author.id` is -- not by DO id: the id idFromString() mints carries no `.name`
    // in workerd, so deriving it from `clientUserId` would ask the org about `undefined`.
    let user = this.users.idFromString(clientUserId);
    let kvRecord = await resolveBlueprintForUser(
        this.env, this.ctx.exports.OrgDurableObject,
        (await retryOnDoReset(() => this.users.get(user).listOrgMemberships()))
            .map(entry => entry.orgId),
        author.id, blueprintId);
    if (!kvRecord) throw new Error("Blueprint not found.");
    let {metadata} = kvRecord;
    let release = await this.loadBlueprint(blueprintId, metadata, kvRecord.owner);

    let record = this.getGadgetRecord(gadgetId);
    let head = record.commitId;
    if (head === undefined) {
      // Its files live only in its chat's proposed changes, so there is no head to merge into.
      throw new Error("This gadget is a provisional creation in a chat. Accept the chat's " +
          "changes before applying a blueprint to it.");
    }

    let merge: BlueprintMerge = {
      gadgetId, blueprintId, title: metadata.title, version: metadata.version, commitId: release,
      kind: "follow", conflictPaths: [],
      ...this.#missingBlueprintBindings(metadata, record),
    };
    // The pin the chat is created with, if any: at the merge commit, with the head it merged.
    let pin: ChatGadgetPinState | undefined;
    if (this.gitCache.isAncestor(release, head)) {
      // The gadget's history already holds the release, so there is nothing to merge. What is
      // left to propose is following this blueprint, if the gadget follows another: it may
      // have come by the release through a blueprint derived from this one, or from a copy of
      // this one under another id. Nothing is written and nothing is pinned, so the proposal
      // cannot go stale: the release stays in the history of the head wherever the head moves.
      if (record.upstream?.blueprintId === blueprintId && record.upstream.commitId === release) {
        return {outcome: "upToDate"};
      }
    } else {
      let base = await this.#blueprintMergeBase(record.upstream, head, release, blueprintId);
      if (base === undefined) return {outcome: "baseUnavailable"};
      if (base.unverified && !options.allowUnrelated) return {outcome: "unrelated"};

      let ours = await this.gitStore.readCommitFiles(head);
      let theirs = await this.gitStore.readCommitFiles(release);
      let result = threeWayMerge(base.files, ours, theirs,
          {base: "base", ours: "this gadget", theirs: "blueprint"});

      // The kind is the merge's result: a "follow" if the gadget already had every change the
      // release made, and a "fastForward" if the gadget had none of its own to keep. A conflict
      // makes a "merge" even where no file changes: a file the gadget changed and the release
      // deleted is kept, but whether it should stay is still to be decided.
      merge.kind = filesEqual(result.files, ours) && result.conflictPaths.length === 0
          ? "follow" : filesEqual(ours, base.files) ? "fastForward" : "merge";
      merge.baseCommit = base.commitId;
      merge.conflictPaths = result.conflictPaths;
      if (base.unverified) merge.unverifiedBase = true;

      // Every kind is committed, since the commit is what records the release in the gadget's
      // history; a "follow" as much as any. A content-addressed object write, which a refusal
      // below, or a chat that is discarded, leaves dangling.
      let mergeCommit = await this.gitStore.writeFilesAsCommit(result.files, {
        parents: [head, release],
        author: commitIdentityForAuthor(author),
        message: `Merge blueprint: ${metadata.title} v${metadata.version}`,
        timestamp: new Date(),
        headers: [releaseMergeHeader(release)],
      });
      pin = {gadgetId, baseCommit: mergeCommit, mergedCommit: head};
    }

    // The agent reviews a merge, and nothing else. Lines that merge cleanly can still disagree,
    // which only something that reads the result will catch, and a conflict always needs
    // resolving. Every other proposal leaves the gadget with files that are one side's exactly,
    // its own or the blueprint's.
    let reviewer = merge.kind === "merge" ? userMeta.aiModel : undefined;

    // The awaits above are interleaving points, and an accept in some chat may have moved the
    // gadget's head since it was read. Refuse rather than record a merge into a head that the
    // gadget no longer has.
    let fresh = this.storage.gadgets.get(gadgetId);
    if (fresh?.type !== "gadget" || fresh.commitId !== head) {
      throw new Error("The gadget changed while the blueprint was being applied; please retry.");
    }

    // One transaction, so that the chat exists only with its proposal: one message, which
    // declares the pin the chat is created with and records the proposal. No client holds
    // state for a chat that did not exist, so starting it re-rooted needs no generation bump.
    let chatId!: number;
    this.storage.transaction(() => {
      chatId = this.nextChatId();
      let timestamp = this.getChatTimestamp();
      this.storage.chatMeta.put({
        id: chatId,
        title: `Update from blueprint: ${metadata.title}`,
        started: timestamp,
        lastActive: timestamp,
        ...(pin !== undefined ? {codeBase: {pins: [pin], generation: 0, revision: 0}} : {}),
      });
      this.materializeChatChanges(chatId, undefined, {author, blueprintMerges: [merge]});

      // Set last, since only a turn's own machinery may materialize into a chat that has one
      // running.
      if (reviewer) {
        this.storage.chatMeta.put(
            {...this.getChatMetaOrThrow(chatId), activeAgent: reviewer.profile});
      }
    });

    // The turn has no message to answer. What prompts it is the record of the proposal, which
    // replay renders as the agent's task (see the "changes" case of runAgentPass in agent.ts).
    // Starting it here, with the chat, is what makes it one turn per proposal however many
    // clients are watching.
    if (reviewer) this.startAgent(chatId, reviewer, author, clientUserId);
    return {outcome: "proposed", chatId};
  }

  // Chooses the commit to merge the release `release` into a gadget against, where the history
  // of the gadget's head `head` does not hold that release, and reads its files. `upstream` is
  // what the gadget follows. Returns undefined if the two histories have commits in common but
  // the store holds the files of none: a release's ancestors mostly arrive without theirs.
  //
  // The base is the newest commit that both histories hold. Usually that is the release the
  // gadget last took from this blueprint, or the one that a blueprint derived from another was
  // built on. Histories that have merged each other can have several such commits, of which
  // the one in the blueprint's own lineage is preferred, and then the latest.
  //
  // Histories with nothing in common leave the base to be assumed: the release the gadget last
  // took from the blueprint it follows, or for a gadget with no such release on record, the
  // first commit of its own to have any files. If it is this blueprint that the gadget took
  // the release from, that is no guess. Only a blueprint's publisher can release under its id,
  // so its releases are versions of one thing even where they are not chained to one another,
  // as a bundled blueprint's are not. Otherwise the base is `unverified`, unless it has no
  // files to be wrong about or the release's history holds the very same tree.
  async #blueprintMergeBase(upstream: GadgetUpstream | undefined, head: string, release: string,
                            blueprintId: string)
      : Promise<{commitId: string, files: Map<string, string>, unverified: boolean} | undefined> {
    let common = this.gitCache.mergeBases(head, release);
    if (common.length === 0) {
      let commitId = upstream?.commitId ?? await this.#firstCommitWithFiles(head);
      let files = await this.gitStore.readCommitFilesIfHeld(commitId);
      if (files === undefined) return undefined;
      let taken = upstream?.blueprintId === blueprintId && upstream.commitId !== undefined;
      let unverified = !taken && files.size > 0 &&
          !await this.#historyHoldsTree(release, await this.gitStore.commitTree(commitId));
      return {commitId, files, unverified};
    }

    let held: {commitId: string, files: Map<string, string>, unverified: boolean}[] = [];
    for (let commitId of common) {
      let files = await this.gitStore.readCommitFilesIfHeld(commitId);
      if (files !== undefined) held.push({commitId, files, unverified: false});
    }
    if (held.length <= 1) return held[0];

    for await (let {oid} of this.gitStore.firstParentChain(release)) {
      let inLineage = held.find(base => base.commitId === oid);
      if (inLineage !== undefined) return inLineage;
    }
    let times = await Promise.all(held.map(async base =>
        (await this.gitStore.readCommitObject(base.commitId)).committer.timestamp));
    return held[times.indexOf(Math.max(...times))];
  }

  // The oldest commit of a gadget's own history to have any files, or the oldest of all if
  // none has. `head` is the gadget's head.
  async #firstCommitWithFiles(head: string): Promise<string> {
    let emptyTree = await gitObjectOid("tree", encodeGitTree([]));
    let first: string | undefined;
    let root = head;
    for await (let {oid, commit} of this.gitStore.firstParentChain(head)) {
      root = oid;
      if (commit.tree !== emptyTree) first = oid;
    }
    return first ?? root;
  }

  // Whether `commit` or any commit in its history has the tree `tree`. The whole history has
  // to be held, as a blueprint release's is.
  async #historyHoldsTree(commit: string, tree: string): Promise<boolean> {
    let seen = new Set<string>();
    let pending = [commit];
    for (let oid of pending) {  // sees the parents pushed below
      if (seen.has(oid)) continue;
      seen.add(oid);
      let object = await this.gitStore.readCommitObject(oid);
      if (object.tree === tree) return true;
      pending.push(...object.parent);
    }
    return false;
  }

  // The bindings a blueprint declares that the gadget has none named for, in the form a
  // BlueprintMerge records them. `gadget` is absent for a gadget about to be created, which
  // has no bindings at all. A spawner-only binding has no name in the gadget, so it is listed
  // only when a missing agent spawner's agents get it.
  #missingBlueprintBindings(metadata: BlueprintMetadata, gadget?: GadgetRecord)
      : Pick<BlueprintMerge, "missingBindings"> {
    let bound = new Set(gadget && this.visibleBindings(gadget).map(([name]) => name));
    let missing = Object.entries(metadata.bindings).filter(([name]) => !bound.has(name));
    let spawnerFed = new Set(missing.flatMap(([, binding]) => binding.type === "agentSpawner"
        ? Object.values(binding.env).flatMap(target => target.type === "binding" ? [target.name] : [])
        : []));
    missing = missing.filter(([name, binding]) => !binding.spawnerOnly || spawnerFed.has(name));
    return missing.length > 0 ? {missingBindings: Object.fromEntries(missing)} : {};
  }

  /**
   * The body of Overseer.mergeChanges(), running under the chat's operation lock (callers
   * hold withChatLock). `clientUserId` feeds analytics only.
   */
  async mergeChanges(chatId: number, userMeta: UserChatContext, clientUserId: string)
                     : Promise<MergeChangesResult> {
    let meta = this.assertChatNotActive(chatId);

    // Always merge *everything* the chat proposes: sweep live change rows into a "changes" message
    // first, then accept all proposed changes. Partial accepts are incoherent under the epoch
    // reset below -- an excluded remainder would be rooted in the discarded stream and
    // destroyed with it.
    let result = this.materializeChatChanges(chatId, meta);
    if (result) meta = result.meta;

    // Reap crash-orphaned provisional records first. (Reconciliation is best-effort, so an
    // unstamped record can still survive a failed reap; it has no sequence and is simply not
    // covered by this merge.)
    await this.reconcilePendingGadgets(chatId);

    // Everything read from here through the commit writes must still describe the chat when the
    // mutation tail below runs; the sequence peek and the stream position are the revalidation
    // tokens. The merge covers every message recorded so far, and `mergeThrough` records that
    // durably (the fold and status rules still key on it; see chatChangeStatuses).
    let sequenceToken = this.nextChatSequencePeek(chatId);
    let mergeThrough = sequenceToken - 1;
    let entryCodeBase = this.chatCodeBase(meta);
    let generationToken = entryCodeBase.generation;
    let revisionToken = entryCodeBase.revision;

    // Message statuses drive excluding reverted creations from coverage below. The map stays
    // valid through the whole accept: the sequence-token revalidation after the awaits
    // guarantees no message was recorded since.
    let messages = [...this.storage.chats.list({prefix: chatKeyPrefix(chatId)})];
    let statuses = chatChangeStatuses(messages);

    // The blueprint releases the chat still proposes to merge, by gadget: those recorded on a
    // "changes" message that is neither merged nor reverted (see
    // AiChatMessageBody.blueprintMerges). The log is the only record of a proposal, so a revert
    // withdraws one just by covering its message.
    let blueprintMerges = new Map<WorkpieceId, BlueprintMerge>();
    for (let msg of messages) {
      if (msg.type === "changes" && statuses.get(msg.sequence) === undefined) {
        for (let merge of msg.blueprintMerges ?? []) blueprintMerges.set(merge.gadgetId, merge);
      }
    }

    // Whether the chat proposes anything is read from its state, never from its changes: a
    // pin, a gadget or binding edge pending in it (which is what the UI goes by, see
    // proposedChangeWorkpieceIds), or a surviving blueprint proposal. The changes can't say: a
    // re-root leaves a pin at a merge commit as the whole proposal, with no change recorded
    // anywhere, and a compaction checkpoint keeps nothing of a proposal that changes no file.
    // Once the sweep above has run, a pin exists only while a surviving message of the epoch
    // declares it, so this agrees with the log. (A chat from before worktree pins meant
    // modification can hold a worktree pin that proposes nothing; the epoch reset below drops
    // it -- the auto-commit planning finds the worktree clean -- which is how one accept moves
    // such a chat into the current regime.)
    if (this.proposedChangeWorkpieceIds(chatId, meta).length === 0 && blueprintMerges.size === 0) {
      // Nothing to merge, so this is a no-op.
      return {outcome: "merged"};
    }

    // A pending record (or edge) whose stamp the log already marks reverted is dead, not
    // covered: it survives only because a revert's awaited record deletion failed (see
    // reconcilePendingGadgets, which retries best-effort -- including the call above).
    // Committing or promoting it would resurrect a rejected gadget, so every coverage test
    // below excludes it.
    let revertedStamp = (pending: {sequence?: number} | undefined) =>
        pending?.sequence !== undefined && statuses.get(pending.sequence) === "reverted";

    // Detect whether the workspace has any accepted code yet (for gadget title generation
    // below): the legacy code log (whose version 1 was written at init time, when it exists at
    // all) records no accepted code, and no gadget's head holds any files. Emptiness is
    // measured by tree content, not head presence: every permanent gadget has a head, an
    // empty-tree commit before it has code (see GadgetRecord.commitId).
    let isFirstChange = [...this.storage.code.list({limit: 1, start: 2})].length === 0;
    if (isFirstChange) {
      for (let gadget of this.storage.gadgets.list()) {
        if (gadget.type === "gadget" && gadget.commitId !== undefined &&
            (await this.gitStore.readCommitFiles(gadget.commitId)).size > 0) {
          isFirstChange = false;
          break;
        }
      }
    }

    // Flatten the chat's content as of `mergeThrough` and decide, per gadget, whether this chat
    // changed it. "Changed" is measured against the chat's merged commit -- the mainline content
    // the chat last saw -- so mainline moving on a gadget this chat never touched neither
    // implicates the chat nor blocks the accept.
    let chatContent = await this.buildChatContent(chatId, mergeThrough);
    let pins = new Map(entryCodeBase.pins.map(pin => [pin.gadgetId, pin]));

    // `baseHead` snapshots the head this accept fast-forwards from (also the value the post-await
    // revalidation compares against -- a primitive, so it can't be confused by whatever object
    // the storage layer hands back later). `parent` is the commit the new head is written on,
    // or becomes when nothing needs writing (`reuseParent`); `release` is a release the parent's
    // history lacks, which the new commit merges.
    let toCommit: {record: GadgetRecord, files: Map<string, string>, baseHead?: string,
                   parent?: string, reuseParent: boolean, release?: string}[] = [];
    for (let record of Array.from(this.storage.gadgets.list())) {
      if (record.type === "worktree") {
        // Worktrees never gate an accept and get no head-commit work here: their content stays
        // in the chat's change stream (their head lifecycle is their own), and recording their
        // creation already made them permanent (see WorktreeRecord.pending). The epoch reset
        // preserves their content by advancing their accepted commits -- see the plan below.
        continue;
      }
      if (record.pending &&
          (record.pending.chatId !== chatId || record.pending.sequence === undefined ||
           record.pending.sequence > mergeThrough || revertedStamp(record.pending))) {
        // Pending in another chat (its files exist only in that chat's proposed changes),
        // pending in this chat but not covered by this merge, or an already-reverted creation
        // awaiting cleanup.
        continue;
      }
      let files = requireTextFiles(chatContent.get(record.id) ?? new Map());
      let pin = pins.get(record.id);
      let mergedCommit = pin?.mergedCommit;
      let baseFiles = mergedCommit !== undefined
          ? await this.gitStore.readCommitFiles(mergedCommit)
          : new Map<string, string>();
      // A record still pending here is a covered creation (uncovered ones were skipped above),
      // and a covered creation always gets its first commit -- an empty tree if the gadget has
      // no files yet -- so promotion below can give every accepted gadget a head. Coverage must
      // never be inferred from content equality: an empty gadget compares equal to the empty
      // base, which is how creations used to be dropped from accepts.
      //
      // Nor may a gadget be skipped if the chat proposes merging a blueprint release that its
      // history does not hold yet. The commit is what records the merge, changed files or not:
      // without it the next update from that blueprint would be merged against the wrong base.
      // (Such a gadget is always pinned, or pending here: see applyBlueprint and the agent's
      // createGadget.)
      let release = blueprintMerges.get(record.id)?.commitId;
      if (release !== undefined && record.commitId !== undefined &&
          this.gitCache.isAncestor(release, record.commitId)) {
        release = undefined;
      }
      if (filesEqual(files, baseFiles) && !record.pending && release === undefined) continue;

      // Accepting is only ever a fast-forward: the chat must have already merged the gadget's
      // current head. A stale chat is expected control flow (someone else's accept can land at
      // any time), reported as a value, with no partial effects -- the caller runs
      // updateChatFromMainline() and retries.
      if (record.commitId !== mergedCommit) {
        return {outcome: "stale"};
      }

      // The new head's parent. A pin re-rooted at a merge commit not yet accepted -- one whose
      // first parent is the head the chat merged -- fast-forwards through that commit, so the
      // merge stays in the gadget's history. Any other pin (one that never moved, or one that an
      // update from before re-roots advanced past its base) commits on the head itself.
      let parent = mergedCommit;
      if (pin !== undefined && pin.baseCommit !== pin.mergedCommit &&
          (await this.gitStore.readCommitObject(pin.baseCommit)).parent[0] === pin.mergedCommit) {
        parent = pin.baseCommit;
      }

      // If the chat's files are the parent's own and the parent's history holds every release
      // proposed, the parent itself becomes the head and nothing is written: an accept with no
      // edits after a merge makes the merge commit the head.
      let parentRelease = release;
      if (parent !== mergedCommit) {
        if (parentRelease !== undefined && this.gitCache.isAncestor(parentRelease, parent!)) {
          parentRelease = undefined;
        }
        baseFiles = await this.gitStore.readCommitFiles(parent!);
      }
      let reuseParent = parent !== undefined && parentRelease === undefined &&
          filesEqual(files, baseFiles);
      toCommit.push({record, files, baseHead: record.commitId, parent, reuseParent,
                     release: parentRelease});
    }

    // Write the commits (content-addressed object writes; harmless if the accept below turns out
    // stale after all).
    let identity = commitIdentityForAuthor(userMeta.profile);
    let commits: {gadgetId: WorkpieceId, commitId: string}[] = [];
    for (let {record, files, parent, reuseParent, release} of toCommit) {
      if (reuseParent) {
        commits.push({gadgetId: record.id, commitId: parent!});
        continue;
      }
      let parents = parent !== undefined ? [parent] : [];
      if (release !== undefined) {
        // A merged release is never the first parent, which is the gadget's own previous
        // state. A gadget that has none starts from an empty root, as one instantiated outside
        // any chat does (see initializeFromBlueprint). The commit marks the release as merged,
        // which is what tells it from any other parent (see releasesMergedSince).
        if (parent === undefined) {
          parents.push(await this.gitStore.writeFilesAsCommit(new Map(), {
            parents: [],
            author: identity,
            message: `Create gadget: ${record.title}`,
            timestamp: new Date(),
          }));
        }
        parents.push(release);
      }
      let commitId: string;
      try {
        commitId = await this.gitStore.writeFilesAsCommit(files, {
          parents,
          author: identity,
          message: `Accept changes from chat: ${meta.title}`,
          timestamp: new Date(),
          headers: release !== undefined ? [releaseMergeHeader(release)] : undefined,
        });
      } catch (err) {
        throw acceptWriteError(record.bindingName, err);
      }
      commits.push({gadgetId: record.id, commitId});
    }

    // Plan the worktree accepts: the commit each pinned worktree's accepted commit
    // (WorktreeRecord.pinBase) advances to when the epoch reset below evaporates its pin, so
    // that the content the chat accepted survives as the tree an unpinned worktree reads. That
    // is a fresh local auto-commit capturing the uncommitted overlay when the closed epoch left
    // the worktree dirty, its existing headCommit when the flattened tree happens to equal that
    // commit's (the agent committed and then made no further edits; no new commit needed), and
    // the unchanged pinBase when clean (a commit()-only epoch, or a pin from before pinning
    // meant modification). Auto-commits parent on the old pinBase and use the accepting user's
    // identity, which is cosmetic: they are squashed out of explicit history (reported HEAD
    // stays the last explicit commit, and a later commit() parents on it), so this identity
    // never appears in anything pushed. Like the gadget commits above, these are
    // content-addressed object writes -- harmless if the accept turns out stale below.
    let worktreeAccepts = new Map<WorkpieceId, string>();
    if (entryCodeBase.pins.some(pin => this.isWorktree(pin.gadgetId))) {
      let touchedByWorktree = this.#worktreeTouchedPaths(messages, statuses);
      for (let pin of entryCodeBase.pins) {
        let record = this.storage.gadgets.get(pin.gadgetId);
        if (record?.type !== "worktree") continue;
        let newPinBase = record.pinBase;
        let touched = touchedByWorktree.get(pin.gadgetId);
        if (touched !== undefined && touched.size > 0) {
          // The epoch's overlay as a change map over pinBase: a touched path's current content,
          // or null for one whose folded outcome is absence (a deletion). Touched-but-unchanged
          // paths fold to identical blobs, so tree equality below still detects "clean".
          let files = chatContent.get(pin.gadgetId);
          let changes = new Map<string, FileContent | null>();
          for (let path of touched) changes.set(path, files?.get(path) ?? null);
          let flattened: string;
          try {
            flattened = await this.gitStore.writeChangedTree(record.pinBase, changes);
          } catch (err) {
            throw acceptWriteError(record.title, err);
          }
          if (flattened !== await this.gitStore.commitTree(record.pinBase)) {
            newPinBase = flattened === await this.gitStore.commitTree(record.headCommit)
                ? record.headCommit
                : await this.gitStore.writeCommitForTree(flattened, {
                    parents: [record.pinBase],
                    author: identity,
                    message: `Auto-commit at accept from chat: ${meta.title}`,
                    timestamp: new Date(),
                  });
          }
        }
        worktreeAccepts.set(pin.gadgetId, newPinBase);
      }
    }

    // Everything above this point awaited, so the chat and workspace may have moved in the
    // meantime; re-validate before mutating. The chat lock excludes sibling merge/revert/
    // update-from-mainline calls, but an accept from *another* chat can advance a head, an agent
    // turn can start, and new messages can be recorded -- all detected here: heads against their
    // snapshots, and the chat via a fresh meta read (throws if deleted, or if an agent started)
    // plus the sequence token (anything that would invalidate the doc we flattened appends to
    // the log). Everything from here on is synchronous, so the record, pin, and message writes
    // land atomically under the output gate.
    for (let {record, baseHead} of toCommit) {
      let fresh = this.storage.gadgets.get(record.id);
      if (fresh?.type !== "gadget" || fresh.commitId !== baseHead) {
        return {outcome: "stale"};
      }
    }
    let freshMeta = this.assertChatNotActive(chatId);
    if (this.nextChatSequencePeek(chatId) !== sequenceToken) {
      return {outcome: "stale"};
    }

    // Rows accepted during the awaits above are acknowledged content the flatten didn't cover:
    // submitCodeChange() runs outside the chat lock, appends no message (so the sequence token
    // can't see it), and validated those keystrokes against a generation the epoch reset below
    // hasn't bumped yet. Someone is actively typing, and silently sweeping a mid-keystroke
    // state into the merge would be as wrong as losing it, so give up and let the user retry
    // once the typing has settled. (The straggler bridge is not a substitute: it carries changes
    // that arrive *after* the merge committed, not already-accepted rows the flatten missed.
    // Nothing has been mutated yet, so the rows survive intact.)
    let freshCodeBase = this.chatCodeBase(freshMeta);
    if (freshCodeBase.generation !== generationToken ||
        freshCodeBase.revision !== revisionToken) {
      throw new Error("The chat's code is being actively edited; please retry.");
    }

    // Promotion below can widen every "use" collaborator's verification scope, so snapshot the
    // scope first and compare after. Comparing the effective scope rather than restarting on any
    // promotion matters because most merges promote neither: a gadget with no bindings, or an edge
    // to a vendorless connection, is in nobody's verification scope.
    let useScopeBefore = this.accountRequiringUseScope();

    // Promote provisional gadgets whose creation is covered by this merge: accepting the chat's
    // changes through `mergeThrough` makes them permanent workspace members. Each covered
    // creation sits on an unmerged, unreverted "changes" message at `pending.sequence` (a
    // merged one's gadget is already promoted, and a reverted one's is excluded here exactly as
    // the toCommit loop excluded it), and is in `commits`, so every promoted gadget gets a head
    // in the fast-forward step below -- possibly an empty tree.
    for (let gadget of this.listPendingGadgets(chatId)) {
      if (gadget.pending!.sequence !== undefined && gadget.pending!.sequence <= mergeThrough &&
          !revertedStamp(gadget.pending)) {
        delete gadget.pending;
        this.storage.gadgets.put(gadget);
        this.recordGadgetAnalytics({
          event_name: "workpiece_created",
          user_id: clientUserId,
          workpiece_id: gadget.id,
          source: "chat",
        });
      }
    }

    // Likewise promote provisional binding edges covered by this merge; this is also the moment
    // an edge becomes visible to mainline loads and the derived workspace default binding list.
    // (Reverted additions only survive on a reverted creation's record -- the revert deletes
    // covered edges synchronously otherwise -- but exclude them the same way for coherence.)
    for (let holder of this.bindingHolders()) {
      let promoted = false;
      for (let edge of Object.values(holder.bindings)) {
        if (edge.pending?.chatId === chatId && edge.pending.sequence !== undefined &&
            edge.pending.sequence <= mergeThrough && !revertedStamp(edge.pending)) {
          delete edge.pending;
          promoted = true;
        }
      }
      if (promoted) holder.save();
    }

    // Fast-forward each committed gadget's head.
    for (let {gadgetId, commitId} of commits) {
      let record = this.storage.gadgets.get(gadgetId)!;
      if (record.type !== "gadget") continue;  // unreachable: only gadgets are committed
      record.commitId = commitId;
      this.storage.gadgets.put(record);
    }

    // Each gadget the chat proposed merging a blueprint release into now follows that
    // blueprint, at that release, which its head's history holds: from just above, or from
    // before. (A gadget whose creation this merge did not cover is no part of it.)
    for (let [gadgetId, {blueprintId, commitId}] of blueprintMerges) {
      let record = this.storage.gadgets.get(gadgetId);
      if (record?.type !== "gadget" || record.pending) continue;
      record.upstream = {blueprintId, commitId};
      this.storage.gadgets.put(record);
    }

    // Bump the loader-cache counter so cached workers reload with the new heads (and promoted
    // records) visible.
    this.bumpVersion();
    let timestamp = this.getChatTimestamp();

    let mergeSequence = this.nextChatSequence(chatId);
    this.storage.chats.put({
      chatId,
      sequence: mergeSequence,
      timestamp,
      author: userMeta.profile,

      type: "merge",
      mergeThrough,
      commits,
      // The merge closes the chat's epoch (see the reset below); content reconstruction
      // restarts here. Historical (pre-git) merges lack this, which is how replay tells them
      // apart. (Merges from before worktrees pinned on modification also carry `worktreePins`,
      // which readers still honor; nothing writes it anymore.)
      epochBoundary: true,
    });

    // The boundary map for the straggler bridge: per gadget, the commit whose tree equals the
    // chat's content at this reset. A committed gadget's is the commit just written; an
    // uncommitted pin had no net change relative to its mergedCommit (that's why it wasn't
    // committed), so its content equals head exactly when mergedCommit == head -- otherwise the
    // reset visibly changes the gadget's content (the pin evaporates and the chat snaps to a
    // head it never merged), making it bridge-ineligible and reported in
    // `prior.discontinuousGadgets` so clients rebuild it from head.
    let boundaries: ChatChangeBoundaryRecord["boundaries"] =
        commits.map(({gadgetId, commitId}) => ({gadgetId, commitId}));
    let committedIds = new Set(commits.map(commit => commit.gadgetId));
    let discontinuousGadgets: WorkpieceId[] = [];
    for (let pin of freshCodeBase.pins) {
      if (committedIds.has(pin.gadgetId)) continue;
      // A worktree's new accepted commit is by construction the commit whose tree equals the
      // chat's content at this reset, so it is bridge-eligible and never discontinuous: a
      // bridged row re-pins the worktree at it (the base submitCodeChange requires). (A
      // worktree pin whose record has vanished -- a reverted creation surviving a failed reap
      // -- falls through to the null branch.)
      let accepted = worktreeAccepts.get(pin.gadgetId);
      if (accepted !== undefined) {
        boundaries.push({gadgetId: pin.gadgetId, commitId: accepted});
        continue;
      }
      let record = this.storage.gadgets.get(pin.gadgetId);
      let head = record?.type === "gadget" ? record.commitId : undefined;
      if (head !== undefined && head === pin.mergedCommit) {
        boundaries.push({gadgetId: pin.gadgetId, commitId: head});
      } else {
        boundaries.push({gadgetId: pin.gadgetId, commitId: null});
        discontinuousGadgets.push(pin.gadgetId);
      }
    }

    // Close the epoch: everything the chat proposed now lives in commits, so the chat's code
    // base resets to empty -- every pin evaporates, the change stream restarts at revision 0 under
    // a new generation, and subsequent edits re-pin lazily against the new heads -- for a
    // worktree, against its accepted commit, advanced here to the commit planned above. The
    // bump is content-preserving: the closed generation's rows are retired (not deleted) as the
    // transform window, the boundary record above opens the straggler bridge, and `prior` tells
    // clients how to hand off (see ChatCodeBase.prior). The reset lands on the freshly-read
    // meta so concurrent changes to other fields (e.g. a title rename during the awaits)
    // survive.
    this.retireChatChanges(this.listLiveChatChanges(chatId, generationToken));
    this.pruneRetiredChatChanges(chatId);
    this.storage.chatChangeBoundaries.put(
        {chatId, generation: generationToken, finalRevision: revisionToken, boundaries});
    this.chatContentCache.delete(chatId);
    freshMeta.codeBase = {
      pins: [],
      generation: generationToken + 1,
      revision: 0,
      epoch: mergeSequence,
      prior: {generation: generationToken, finalRevision: revisionToken, discontinuousGadgets},
    };
    freshMeta.lastActive = timestamp;
    this.storage.chatMeta.put(freshMeta);
    for (let [worktreeId, newPinBase] of worktreeAccepts) {
      let record = this.storage.gadgets.get(worktreeId);
      if (record?.type === "worktree" && record.pinBase !== newPinBase) {
        record.pinBase = newPinBase;
        this.storage.gadgets.put(record);
      }
    }

    // Maybe generate gadget title if this was the first accepted code. (A merge covering only
    // binding additions to existing gadgets doesn't count: it creates no commits, so the first
    // merge with code -- including an accepted creation's empty first commit -- still sees
    // isFirstChange and generates the title then.)
    if (isFirstChange && commits.length > 0 && userMeta.quickModel) {
      this.generateGadgetTitle(chatId, userMeta.quickModel, userMeta.profile);
    }
    this.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: clientUserId,
      chat_id: chatId,
      interaction_type: "code_merged",
    });

    // Sever live sessions whose verification scope the promotions widened, now that the writes
    // above have landed: a "use" collaborator's session was admitted against the narrower scope,
    // and the gadget UI they drive can now invoke a connection nobody verified them against.
    // (Everything since the promotions is synchronous, so the scope diffed here is theirs.)
    this.restartIfUseScopeWidened(
        useScopeBefore, "Gadget restarted because accepted changes added gadget bindings.");

    return {outcome: "merged"};
  }

  // The worktree paths the chat's current epoch touched, per worktree, folded from the epoch's
  // surviving "changes" messages under the same rules buildChatContent folds content (reset at
  // epoch boundaries, reverted messages excluded). The accept's re-pin plan needs this alongside
  // the flattened content: content answers what a path holds now, but only the change stream
  // knows which paths were touched at all -- a removed path is simply absent from content, and
  // must enter the auto-commit's change map as a deletion.
  #worktreeTouchedPaths(messages: AiChatMessage[], statuses: Map<number, "merged" | "reverted">)
      : Map<WorkpieceId, Set<string>> {
    let touched = new Map<WorkpieceId, Set<string>>();
    for (let msg of messages) {
      if (msg.type === "merge" && msg.epochBoundary) {
        touched.clear();
        continue;
      }
      if (msg.type !== "changes") continue;
      if (statuses.get(msg.sequence) === "reverted") continue;
      if (msg.conversionBoundary) touched.clear();
      if (msg.change === undefined) continue;
      for (let [key, entries] of Object.entries(msg.change)) {
        let id = Number(key);
        if (!this.isWorktree(id)) continue;
        let paths = touched.get(id);
        if (paths === undefined) touched.set(id, paths = new Set());
        for (let [path] of entries) paths.add(path);
      }
    }
    return touched;
  }

  /**
   * Fetch a blueprint's decoded files, plus formatted notes describing what was copied and which
   * bindings the blueprint's code expects the agent to wire up, for instantiation as a new gadget
   * by the agent's createGadget tool, and the record of that for the creation's "changes"
   * message (see AiChatMessageBody.blueprintMerges). Blueprint ids are bearer capabilities (like
   * blueprint share links), so possession of the id is sufficient to read one; an org-owned
   * blueprint is resolved for `initiator`, as their orgs' member alone. Throws agent-readable
   * errors.
   */
  async fetchBlueprint(initiator: AiChatAuthorInfo, blueprintId: string): Promise<{
    files: Record<string, string>, notes: string, output?: BlueprintOutput,
    merge: Omit<BlueprintMerge, "gadgetId">,
  }> {
    // The blueprint may belong to one of the initiating user's orgs, so this is the member-gated
    // read; their user DO holds the org index it resolves through.
    let orgIds = (await this.users.get(this.users.idFromName(initiator.id)).listOrgMemberships())
        .map(entry => entry.orgId);
    let kvRecord = await resolveBlueprintForUser(
        this.env, this.ctx.exports.OrgDurableObject, orgIds, initiator.id, blueprintId);
    if (!kvRecord) {
      throw new Error(`No such blueprint: ${blueprintId}. Use listBlueprints to see available ` +
          `blueprints.`);
    }
    let commitId = await this.loadBlueprint(blueprintId, kvRecord.metadata, kvRecord.owner);

    // Null prototype so a hostile filename like "__proto__" is an ordinary key.
    let files: Record<string, string> = Object.create(null);
    for (let [file, content] of await this.gitStore.readCommitFiles(commitId)) {
      files[file] = content;
    }

    // Apply the deployment's overrides, so a gadget the agent builds is labelled the same as one
    // the user makes from the New menu (see newGadgetFromBlueprint, which does the same).
    let output = deploymentOutputForBlueprint(await readAdminConfig(this.env), blueprintId,
        sanitizeBlueprintOutput(kvRecord.metadata.output));

    let lines = [`Created the new gadget from blueprint ` +
        `${JSON.stringify(kvRecord.metadata.title)} (blueprintId ${blueprintId}).`];
    if (output) {
      lines.push(`It produces a ${output.noun}; the new gadget is labelled as one throughout the ` +
          `UI.`);
    }

    let filenames = Object.keys(files);
    lines.push("", filenames.length > 0
        ? `Files copied into the new gadget: ${filenames.join(", ")}. Use readFile to inspect ` +
          `them before editing.`
        : `The blueprint contained no files, so the new gadget is empty.`);

    let {bindings} = kvRecord.metadata;
    lines.push("", Object.keys(bindings).length === 0
        ? `The blueprint requires no bindings.`
        : formatMissingBlueprintBindings(bindings, `the new gadget`));

    // What the creation is recorded as. The new gadget's files are the release's exactly, with
    // nothing to merge them against.
    let merge: Omit<BlueprintMerge, "gadgetId"> = {
      blueprintId, title: kvRecord.metadata.title, version: kvRecord.metadata.version, commitId,
      kind: "fastForward", conflictPaths: [],
      ...this.#missingBlueprintBindings(kvRecord.metadata),
    };

    return {files, notes: lines.join("\n"), output, merge};
  }
}
