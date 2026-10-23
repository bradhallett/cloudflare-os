import { WorkpieceId, AiChatAuthorInfo, GatekeeperCreationSpec, BlueprintBinding, BlueprintMetadata, SpawnerEnvTarget, BlueprintScreenshotUpload, BLUEPRINT_SCREENSHOT_R2_PREFIX, modelKind } from "@gadgets/workshop-shared/api";
import { VendorDescription, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { chatKey } from "./storage-schema/overseer-storage";
import type { BlueprintGadgetRecord, ChatBindingEntry, StoredAssistantMessage } from "./storage-schema/overseer-storage";
import { commitIdentityForAuthor } from "./git-store";
import type { Usage } from "@earendil-works/pi-ai";
import { AiGatewayLogRetryableError, getAiGatewayLogCost } from "./ai-gateway";
import type { AiGatewayLogRoute } from "./ai-gateway";
import type { AiChatMessageBodyWithModelData, WorktreeTurnAccess } from "./agent";
import { blueprintContentKey, deleteBlueprintContent, readBlueprintRelease } from "./blueprint-archive";
import { buildReleasePack, buildSnapshotRelease, encodeReleaseCommit, releasesMergedBy } from "./blueprint-release";
import type { Release } from "./blueprint-release";
import { encodeGitTree, gitObjectOid, parseGitCommitRefs } from "./git-codec";
import type { BlueprintKvRecord } from "./storage-schema/blueprints-kv";
import { retryOnDoReset } from "./do-retry";
import { OverseerFacets } from "./overseer-facets";
import { defaultBlueprintBindingTitle } from "./overseer-binding-info";
import type { CodeModeEntrypoint } from "./overseer-harness";
import { CODE_MODE_HARNESS, RestoreForgerImpl } from "./overseer-harness";
import type { OverseerImpl } from "./overseer-impl";
import { OverseerCore } from "./overseer-core";

/**
 * OverseerPublishing: binding metadata, blueprint releases and propagation, agent chat messages and costs, code mode, and vendor listings.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerPublishing extends OverseerFacets {
  // Collect binding metadata from the given gadget's binding edges for blueprint creation/update.
  collectBindingMetadata(gadgetId: WorkpieceId): Record<string, BlueprintBinding> {
    let bindings: Record<string, BlueprintBinding> = {};

    let gadget = this.getGadgetRecord(gadgetId);
    // Only permanent edges: a pending edge belongs to some chat's unaccepted proposal.
    let edges = this.visibleBindings(gadget);

    // For symbolic spawner env references: target workpiece -> the blueprint binding name that
    // will map to it -- the (first) edge name bound to it, or a spawner-only binding once one is
    // synthesized below -- so spawner env entries sharing a target share one blueprint binding
    // (and thus one gatekeeper after instantiation). Only edges that the blueprint actually
    // exports are registered (see the loop below), so an env entry never names a binding missing
    // from `bindings`. Plus the set of all names claimed so far (every edge name up front, even
    // ones the blueprint drops, so a synthesized spawner-only binding can never collide with an
    // edge processed later).
    let edgeNameByTarget = new Map<WorkpieceId, string>();
    let takenNames = new Set(edges.map(([name]) => name));

    // Agent spawners are processed after all other edges (see below) so their synthesized
    // bindings dedupe against the complete real set.
    let spawnerEdges: Array<{
      bindingName: string,
      spec: GatekeeperCreationSpec & {type: "agentSpawner"},
      base: {title: string, description: string},
      suggestValue: boolean,
    }> = [];

    for (let [bindingName, edge] of edges) {
      let gk = this.storage.gatekeepers.get(edge.target);
      if (!gk) continue;  // dangling edge (gatekeeper destroyed)

      // Singleton gatekeepers (e.g. the Context Library) are auto-provided to every gadget, not
      // user-configured, so they're excluded from blueprints (re-added automatically on open). This
      // also covers an ambient capsule the agent promoted to a named binding via setGadgetBinding.
      if (gk.creationSpec?.type === "ambient") continue;

      // Annotation is optional. When absent, the binding is included with an empty
      // description and no resource suggestion. Legacy records may carry an `included:
      // false` flag; honor it for backwards compatibility, but the current UI no longer
      // surfaces an exclusion control.
      let annotation = edge.blueprintAnnotation;
      if (annotation?.included === false) continue;

      let spec = gk.creationSpec;

      if (!spec) {
        throw new Error(
          `Binding "${bindingName}" has no creation spec (created before blueprint support).`
        );
      }

      // This edge is exported, so it can serve as the blueprint binding for its target in spawner
      // env references. Registered here rather than in a pass over all edges, so that a dropped
      // edge (dangling, ambient, or legacy `included: false`) never lends its name to an env entry.
      if (!edgeNameByTarget.has(edge.target)) edgeNameByTarget.set(edge.target, bindingName);

      let base = {
        title: annotation?.title || defaultBlueprintBindingTitle(gk, bindingName),
        description: annotation?.description ?? "",
      };
      let suggestValue = annotation?.suggestValue ?? false;

      if (spec.type === "gatekeeper") {
        bindings[bindingName] = {
          ...base,
          type: "gatekeeper",
          gatekeeperName: spec.vendorId,
          // Use the vendor's URL pattern, not the specific resource URL.
          // Fall back to resourceUrl for gatekeepers created before typeUrlPattern was stored.
          typeUrlPattern: spec.typeUrlPattern || spec.resourceUrl!,
          ...(suggestValue ? {resourceUrl: spec.resourceUrl} : {}),
        };
      } else if (spec.type === "aiModel") {
        bindings[bindingName] = {
          ...base,
          type: "aiModel",
          ...(suggestValue
            ? {suggestedModel: {provider: spec.provider, modelName: spec.modelName}}
            : {}),
          ...(modelKind(spec.provider, spec.modelName) === "decision"
              ? {modelKind: "decision"} : {}),
        };
      } else if (spec.type === "agentSpawner") {
        spawnerEdges.push({bindingName, spec, base, suggestValue});
      }
    }

    // Agent spawner bindings: workpiece IDs are workspace-local, so a spawner's env transfers
    // symbolically (see SpawnerEnvTarget). Each env entry references the exporting gadget
    // itself, one of the gadget's own bindings by name, or -- for a target bound by no edge --
    // an additional top-level binding synthesized just to feed the spawner (marked
    // `spawnerOnly`), which the user fills at instantiation time like any other binding.
    for (let {bindingName, spec, base, suggestValue} of spawnerEdges) {
      let env: Record<string, SpawnerEnvTarget> = {};
      for (let [envName, target] of Object.entries(spec.config.env)) {
        if (target === gadgetId) {
          env[envName] = {type: "gadget"};
          continue;
        }
        let edgeName = edgeNameByTarget.get(target);
        if (edgeName !== undefined) {
          env[envName] = {type: "binding", name: edgeName};
          continue;
        }
        if (this.storage.gadgets.get(target)) {
          throw new Error(`Cannot create a blueprint: agent spawner binding "${bindingName}" ` +
              `gives its agents access to another gadget ("${envName}"), which blueprints ` +
              `cannot express yet.`);
        }
        let targetGk = this.storage.gatekeepers.get(target);
        if (!targetGk) {
          throw new Error(`Cannot create a blueprint: agent spawner binding "${bindingName}" ` +
              `gives its agents access to a resource ("${envName}") that no longer exists. ` +
              `Remove it from the spawner's configuration first.`);
        }
        let targetSpec = targetGk.creationSpec;
        if (targetSpec?.type === "gatekeeper" || targetSpec?.type === "aiModel") {
          // Synthesize a spawner-only binding, named after the spawner env name (suffixed if an
          // edge already claims it), described from the target's own creation spec.
          let synthName = envName;
          for (let i = 2; takenNames.has(synthName); i++) synthName = `${envName}_${i}`;
          takenNames.add(synthName);
          let synthBase = {
            title: defaultBlueprintBindingTitle(targetGk, synthName),
            description: "",
            spawnerOnly: true as const,
          };
          bindings[synthName] = targetSpec.type === "gatekeeper"
              ? {
                  ...synthBase,
                  type: "gatekeeper",
                  gatekeeperName: targetSpec.vendorId,
                  typeUrlPattern: targetSpec.typeUrlPattern || targetSpec.resourceUrl!,
                }
              : {
                  ...synthBase,
                  type: "aiModel",
                  ...(modelKind(targetSpec.provider, targetSpec.modelName) === "decision"
                      ? {modelKind: "decision"} : {}),
                };
          // Register the synthesized binding so any later env entry (in this or another spawner)
          // targeting the same workpiece references it instead of synthesizing a duplicate.
          edgeNameByTarget.set(target, synthName);
          env[envName] = {type: "binding", name: synthName};
        } else {
          throw new Error(`Cannot create a blueprint: agent spawner binding "${bindingName}" ` +
              `gives its agents access to a resource ("${envName}") of a kind that blueprints ` +
              `cannot express.`);
        }
      }

      let binding: BlueprintBinding = {
        ...base,
        type: "agentSpawner",
        env,
      };
      if (suggestValue) {
        if (spec.config.modelId === null) {
          binding.suggestedModel = null;
        } else if (spec.modelProvider && spec.modelName) {
          binding.suggestedModel = {provider: spec.modelProvider, modelName: spec.modelName};
        }
      }
      bindings[bindingName] = binding;
    }

    return bindings;
  }

  // Validate that a gadget head is publishable to a blueprint, returning it. "No code" means
  // the head is absent (a permanent gadget created outside any chat, before its first accept)
  // *or* an empty tree (an accepted creation with no files yet -- a legitimate head, just not a
  // publishable one): either way the archive would be empty, which instantiation refuses.
  async assertPublishableCommit(commitId: string | undefined): Promise<string> {
    if (commitId !== undefined &&
        (await this.gitStore.readCommitFiles(commitId)).size > 0) {
      return commitId;
    }
    throw new Error("This gadget has no code to publish. Accept some code first.");
  }

  // Mints the blueprint's next release (see blueprint-release.ts) from the tree of the gadget
  // commit `sourceCommit`: writes the release commit, records it on `record` -- which the caller
  // stores by propagating it -- and returns the pack to propagate with it. If that tree is what
  // the blueprint's latest release already holds, and the gadget has merged no other blueprint
  // since, there is nothing to release: the record is left alone and undefined is returned.
  //
  // The release's first parent is the release before it. For a record last published before
  // releases were commits, that is the snapshot release of the files it published, which is the
  // release everyone who reads that content derives from it. Such a record's first release here
  // is minted even over an unchanged tree, since it is what moves the stored content to a pack.
  //
  // Its other parents are the releases of other blueprints that the gadget has merged since, so
  // that whoever holds this release can find what it has in common with theirs. A first parent
  // always belongs to the blueprint's own lineage, so a blueprint with no release yet to come
  // before those gets an empty one: release 0, the root of its lineage.
  async mintBlueprintRelease(record: BlueprintGadgetRecord, sourceCommit: string)
      : Promise<Uint8Array | undefined> {
    let tree = await this.gitStore.commitTree(sourceCommit);
    let previous = record.releases?.at(-1)?.releaseCommit;
    let unchanged = previous !== undefined && await this.gitStore.commitTree(previous) === tree;
    if (previous === undefined && record.commitId !== undefined) {
      let snapshot = await buildSnapshotRelease(
          await this.gitStore.readCommitFiles(record.commitId));
      await this.gitCache.importObjects(snapshot.objects.values());
      previous = snapshot.commitId;
    }
    let merged = await this.releasesMergedSince(sourceCommit, record.commitId, previous);
    if (unchanged && merged.length === 0) return undefined;

    let publication = {
      author: commitIdentityForAuthor(record.metadata.author),
      title: record.metadata.title,
      timestamp: new Date(),
    };
    let mint = async (release: Pick<Release, "tree" | "parents" | "version">) => {
      let payload = encodeReleaseCommit({ ...release, ...publication });
      await this.gitCache.importObjects([{ type: "commit", payload }]);
      return await gitObjectOid("commit", payload);
    };

    if (previous === undefined && merged.length > 0) {
      let emptyTree = await gitObjectOid("tree", encodeGitTree([]));
      previous = await mint({ tree: emptyTree, parents: [], version: 0 });
    }
    let version = record.metadata.version + 1;
    let parents = previous === undefined ? [] : [previous, ...merged];
    let releaseCommit = await mint({ tree, parents, version });

    record.releases = [...record.releases ?? [], { version, releaseCommit, sourceCommit }];
    record.commitId = sourceCommit;
    delete record.codeVersion;
    record.metadata.version = version;
    record.metadata.commitId = releaseCommit;
    return await this.buildBlueprintPack(releaseCommit);
  }

  // The blueprint releases merged into a gadget on the way from its commit `since` to its
  // commit `head`, or in the whole of `head`'s history if `since` is undefined, in the order
  // they were merged. Those that `previous` (a release, if given) or another of them already
  // has in its history are left out, as naming them again would say nothing.
  //
  // A commit merged a release only if it marks it as one (see releasesMergedBy). Its other
  // parents are the gadget's own history: its first parent, and any other commit of the
  // gadget's that it merged, such as a chat's own files. The walk follows all of those, since a
  // mark can lie off the first-parent chain -- a blueprint proposal's merge, reached through the
  // files of the chat that held it when the chat was brought up to date. It never enters a
  // release's history, which holds no commit of the gadget's own, and stops at the history of
  // `since`. A commit's releases come after those of its first parent's history and then of its
  // other parents', which makes the order oldest first.
  async releasesMergedSince(head: string, since: string | undefined, previous: string | undefined)
      : Promise<string[]> {
    let read = (oid: string) => {
      let object = this.gitCache.readLocalObject(oid);
      if (object?.type !== "commit") throw new Error(`Commit ${oid} is not in the git store.`);
      let releases = releasesMergedBy(object.payload, oid);
      let own = parseGitCommitRefs(object.payload, oid).parents
          .filter(parent => !releases.includes(parent));
      return {releases, own};
    };

    // `since` and everything in its own history, which the walk below is not to enter.
    let reached = new Set<string>();
    for (let pending = since === undefined ? [] : [since]; pending.length > 0;) {
      let oid = pending.pop()!;
      if (reached.has(oid)) continue;
      reached.add(oid);
      pending.push(...read(oid).own);
    }

    // Depth first, finishing a commit only once its own parents are finished.
    let merged: string[] = [];
    let stack: {oid: string, commit?: ReturnType<typeof read>}[] = [{oid: head}];
    while (stack.length > 0) {
      let top = stack.at(-1)!;
      if (top.commit !== undefined) {
        stack.pop();
        merged.push(...top.commit.releases);
      } else if (reached.has(top.oid)) {
        stack.pop();
      } else {
        reached.add(top.oid);
        top.commit = read(top.oid);
        // Reversed, so that the first parent is the first to be taken off the stack.
        stack.push(...top.commit.own.toReversed().map(oid => ({oid})));
      }
    }
    return merged.filter((release, index) =>
        merged.indexOf(release) === index &&
        !(previous !== undefined && this.gitCache.isAncestor(release, previous)) &&
        !merged.some(other => other !== release && this.gitCache.isAncestor(release, other)));
  }

  // Builds the pack of a release this workspace minted. A release always yields the same bytes.
  async buildBlueprintPack(releaseCommit: string): Promise<Uint8Array> {
    return await buildReleasePack(oid => this.gitCache.readLocalObject(oid), releaseCommit);
  }

  // Loads the release that `metadata` describes into the workspace's git store, returning its
  // release commit. Throws if its content is missing or invalid, having stored none of it. The
  // metadata is the caller's to read (see readBlueprintRelease()).
  //
  // This is the one way a blueprint's objects enter the workspace, so what
  // readBlueprintRelease() admits is all that one can add to the store.
  async loadBlueprint(blueprintId: string, metadata: BlueprintMetadata): Promise<string> {
    let release = await readBlueprintRelease(this.env, blueprintId, metadata);
    await this.gitCache.importObjects(release.objects.values());
    return release.commitId;
  }

  // Propagate a blueprint to User DO, KV, and R2.
  // If `pack` is provided, it is the pack of the record's latest release, and is uploaded to R2.
  // If omitted (metadata-only update), the R2 content is left unchanged -- unless the record is
  // still dirty from an earlier attempt, which may not have got as far as uploading its latest
  // release. That release is then uploaded again.
  async propagateBlueprint(
      record: BlueprintGadgetRecord,
      pack?: Uint8Array,
      screenshot?: BlueprintScreenshotUpload | null,
  ): Promise<void> {
    if (!this.ownerId) throw new Error("Workspace not initialized.");

    let release = record.releases?.at(-1);
    if (!pack && record.dirty && release) {
      pack = await this.buildBlueprintPack(release.releaseCommit);
    }

    // Mark dirty.
    record.dirty = true;
    this.storage.blueprints.put(record);

    // Upload the release to R2 (only when code is being created/updated).
    if (pack) {
      await this.env.BLUEPRINT_CONTENT.put(blueprintContentKey(record.id, record.metadata), pack);
    }

    if (screenshot !== undefined) {
      if (screenshot === null) {
        delete record.metadata.screenshot;
        await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${record.id}`);
      } else {
        record.metadata.screenshot = true;
        await this.env.BLUEPRINT_CONTENT.put(
          `${BLUEPRINT_SCREENSHOT_R2_PREFIX}${record.id}`,
          screenshot.content,
          { httpMetadata: { contentType: screenshot.mimeType } },
        );
      }
    }

    // Propagate to User DO.
    let owner = this.users.get(this.users.idFromString(this.ownerId));
    let isFeatured = await owner.updateBlueprint(
      record.id, record.metadata, this.ctx.id.toString()
    );

    if (isFeatured) {
      await this.ctx.exports.AdminSettings.getByName("").syncFeaturedBlueprint({
        id: record.id,
        metadata: record.metadata,
      });
    }

    // Write to KV.
    let kvRecord: BlueprintKvRecord = {
      metadata: record.metadata,
      ownerId: this.ownerId,
      gadgetId: this.ctx.id.toString(),
    };
    await this.env.BLUEPRINTS.put(record.id, JSON.stringify(kvRecord));

    // Clear dirty flag.
    record.dirty = false;
    this.storage.blueprints.put(record);
  }

  // Delete a blueprint's propagated data (KV, R2, User DO, local).
  async deleteBlueprintPropagation(record: BlueprintGadgetRecord): Promise<void> {
    if (!this.ownerId) throw new Error("Workspace not initialized.");

    // Delete from KV first (stops public access).
    await this.env.BLUEPRINTS.delete(record.id);

    // Delete all historical versions from R2.
    await deleteBlueprintContent(this.env, record.id);
    await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${record.id}`);

    // Delete from User DO.
    let owner = this.users.get(this.users.idFromString(this.ownerId));
    await this.ctx.exports.AdminSettings.getByName("").deleteFeaturedBlueprint(record.id);
    await owner.deleteBlueprint(record.id);

    // Delete from local collection.
    this.storage.blueprints.delete(record.id);
  }

  postAgentChatMessage(chatId: number, author: AiChatAuthorInfo, message: string) {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) {
      // Chat thread deleted?
      return;
    }

    let timestamp = this.getChatTimestamp();
    this.storage.chats.put({
      chatId,
      sequence: this.nextChatSequence(chatId),
      timestamp,
      author,
      type: "message",
      message
    });
  }

  postAgentErrorMessage(chatId: number, author: AiChatAuthorInfo, message: string, code?: string) {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) {
      // Chat thread deleted?
      return;
    }

    // An error ends the turn early. Log the steers it never read first, so the error stays the
    // chat's last message, and a Retry reads them.
    if (meta.queuedSteers) this.logQueuedSteers(meta, true);

    let timestamp = this.getChatTimestamp();
    this.storage.chats.put({
      chatId,
      sequence: this.nextChatSequence(chatId),
      timestamp,
      author,
      type: "error",
      message,
      ...(code ? { code } : {}),
    });
  }

  addChatMessages(chatId: number, author: AiChatAuthorInfo,
        msgs: AiChatMessageBodyWithModelData[],
        usage?: Usage, aiGatewayLogId?: string,
        aiGatewayLogRoute?: AiGatewayLogRoute): void {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) {
      // Chat thread deleted?
      return;
    }

    for (let {modelData, ...msg} of msgs) {
      if (msg.type === "changes") {
        // (A message's `pins` need no validation or mirroring here: pins are validated and
        // mirrored into the chat's code base when the establishing row is *appended* -- see
        // submitCodeChange / commitAgentStep -- and the message merely makes the
        // establishment durable log history. Proposed-ness needs no bookkeeping either: it is
        // derived from pins and pending records, see proposedChangeWorkpieceIds.)
        this.proposedChangesChanged(chatId);
      }

      let sequence = this.nextChatSequence(chatId);

      // Stamp provisional gadget creations and binding additions recorded by this "changes"
      // message with its sequence: merge/revert compare it to decide promotion/deletion, and an
      // unstamped pending record/edge whose chat has no active turn is a crash orphan (see
      // reconcilePendingGadgets()). The stamp happens in the same synchronous step as the
      // message write, so the log and the registry can never disagree.
      if (msg.type === "changes") {
        for (let {gadgetId} of msg.createdGadgets ?? []) {
          let gadget = this.storage.gadgets.get(gadgetId);
          if (gadget?.pending?.chatId === chatId && gadget.pending.sequence === undefined) {
            gadget.pending.sequence = sequence;
            this.storage.gadgets.put(gadget);
          }
        }
        // A recorded worktree creation is permanent at once rather than stamped: creating a
        // worktree proposes nothing (see proposedChangeWorkpieceIds), so neither an accept nor a
        // revert has anything to decide about it -- a revert rolls back its content and head,
        // never the worktree itself (see WorktreeRecord.pending).
        for (let {worktreeId} of msg.createdWorktrees ?? []) {
          let worktree = this.storage.gadgets.get(worktreeId);
          if (worktree?.pending?.chatId === chatId && worktree.pending.sequence === undefined) {
            delete worktree.pending;
            this.storage.gadgets.put(worktree);
          }
        }
        for (let {gadgetId, name} of msg.addedBindings ?? []) {
          let gadget = this.storage.gadgets.get(gadgetId);
          let edge = gadget?.type === "gadget" ? gadget.bindings[name] : undefined;
          if (gadget && edge?.pending?.chatId === chatId &&
              edge.pending.sequence === undefined) {
            edge.pending.sequence = sequence;
            this.storage.gadgets.put(gadget);
          }
        }
        // Advance worktree heads the message records (the agent's commit() advancements; see
        // AiChatMessageBody.worktreeCommits), in the same synchronous step as the message write
        // so the log and the registry can never disagree. The previousHead chain is validated
        // rather than trusted: nothing may move a worktree's head while its chat's turn holds
        // it, so a mismatch is a bug, and failing the barrier (rolling the whole step back)
        // beats desynchronizing the record from the log.
        for (let {worktreeId, commit, previousHead} of msg.worktreeCommits ?? []) {
          let worktree = this.storage.gadgets.get(worktreeId);
          if (worktree?.type !== "worktree" || worktree.chatId !== chatId) {
            throw new Error(
                `worktreeCommits names a workpiece that is not this chat's worktree: ` +
                `${worktreeId}`);
          }
          if (worktree.headCommit !== previousHead) {
            throw new Error(`Worktree ${worktreeId}'s head moved during the turn.`);
          }
          worktree.headCommit = commit;
          this.storage.gadgets.put(worktree);
        }
      }

      this.storage.chats.put({
        chatId,
        sequence,
        timestamp: this.getChatTimestamp(),
        author,
        ...msg,
      });

      // The step's model-facing snapshot lands beside its message in the same synchronous step
      // (atomic under the output gate), so the two can never disagree. Destructured off `msg`
      // above so it can't leak into the client-visible record.
      if (modelData) {
        this.storage.chatModelData.put({chatId, sequence, message: modelData});
      }
    }

    if (usage !== undefined) {
      meta.totalTokens = usage.totalTokens;
      meta.promptTokens =
          (meta.promptTokens ?? 0) + usage.input + usage.cacheRead + usage.cacheWrite;
      meta.cacheReadTokens = (meta.cacheReadTokens ?? 0) + usage.cacheRead;
      meta.cacheWriteTokens = (meta.cacheWriteTokens ?? 0) + usage.cacheWrite;
    }

    meta.lastActive = this.getChatTimestamp();
    this.storage.chatMeta.put(meta);

    if (aiGatewayLogId && aiGatewayLogRoute) {
      // Best-effort UI accounting only. The log ID is not persisted, so a DO restart can lose
      // this update. Do not use this total as a billing source of truth.
      void this.#getCostFromAiGateway(chatId, aiGatewayLogRoute, aiGatewayLogId, usage?.cost.total);
    } else if (usage?.cost.total) {
      // No AI Gateway log to consult (direct provider access, or a gateway response that didn't
      // surface a log id): fall back to the caller's catalog-priced estimate.
      this.#addChatCost(chatId, usage.cost.total);
    }
  }

  getChatModelData(chatId: number, sequence: number): StoredAssistantMessage | undefined {
    return this.storage.chatModelData.get(chatKey(chatId, sequence))?.message;
  }

  // Adds an inference cost (in dollars) to a chat's running total and the workspace-wide total.
  #addChatCost(chatId: number, cost: number) {
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta) {
      // Chat thread deleted?
      return;
    }

    meta.totalCost = (meta.totalCost ?? 0) + cost;

    // Even though this is not really activity, we need to update lastActive for the subscription
    // machinery to work correctly.
    meta.lastActive = this.getChatTimestamp();

    this.storage.chatMeta.put(meta);
    this.storage.totalCost.put(this.storage.totalCost.get() + cost);
  }

  // Fetches an AI Gateway log entry and adds the cost to the given chat ID's cost indicator.
  // If the gateway can't produce a (positive) cost -- fetch failure, or the gateway doesn't
  // price this model -- falls back to `estimatedCost` (the caller's catalog-priced estimate)
  // so the indicator degrades to an estimate rather than silently omitting the turn.
  //
  // TODO: Get AI gateway to add cost data to response headers -- it's dumb that we need a
  //   separate request!
  async #getCostFromAiGateway(chatId: number, route: AiGatewayLogRoute, aiGatewayLogId: string,
                              estimatedCost?: number) {
    let cost: number | undefined;
    try {
      for (let attempt = 0; attempt < 4; ++attempt) {
        try {
          cost = await getAiGatewayLogCost(this.env, route, aiGatewayLogId);
          break;
        } catch (err) {
          if (!(err instanceof AiGatewayLogRetryableError) || attempt === 3) throw err;
          await scheduler.wait(1000 * 2 ** attempt);
        }
      }
    } catch (err) {
      // This is an async operation without any caller waiting so there's not much we can do with
      // this error beyond falling back to the estimate below.
      // TODO: If we ever use this for billing we'll want to make it more reliable, perhaps by
      //   storing unfetched log IDs in storage and retrying fetches.
      this.logger.warn("failed to fetch AI Gateway cost log", {
        event: "ai.gateway.cost.log.fetch.failed", error: err,
      });
    }

    cost ||= estimatedCost;
    if (cost) {
      this.#addChatCost(chatId, cost);
    }
  }

  #codeModeResolvers = new Map<string, (trace: TraceItem) => void>();

  #codeModeOutputSubscribers = new Map<string, (delta: string) => void>();

  async executeCodeMode(chatId: number, code: string,
                        initiator: AiChatAuthorInfo, initiatorModelId: string,
                        bindings: Record<string, ChatBindingEntry>,
                        onOutputText?: (delta: string) => void,
                        worktreeTurn?: WorktreeTurnAccess)
      : Promise<string> {
    let bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let executionId: string = bytes.toBase64();

    // Register the turn's worktree state for the worktree binding loopbacks (see
    // startGatekeeperSession's "worktree" case), for exactly this execution's duration -- the
    // executionId is minted into the loopbacks below, so stubs from other executions never
    // resolve against this registration.
    if (worktreeTurn !== undefined) {
      this.activeWorktreeTurns.set(chatId, {access: worktreeTurn, initiator, executionId});
    }

    if (onOutputText) {
      this.#codeModeOutputSubscribers.set(executionId, onOutputText);
    }

    let tracePromise = new Promise<TraceItem>(resolve => {
      this.#codeModeResolvers.set(executionId, resolve);
    });

    try {
      let tailProps = {
        executionId,
        overseerId: this.ctx.id.toString(),
      };

      let workerDef: WorkerLoaderWorkerCode = {
        compatibilityDate: "2026-02-01",
        compatibilityFlags: [
          // disallow_importable_env also disallows importable ctx.exports, to prevent the code
          // from calling itself in a loop.
          "disallow_importable_env",

          // Make ctx.restore() available.
          "allow_irrevocable_stub_storage",
        ],
        mainModule: "harness.js",
        modules: {
          "harness.js": CODE_MODE_HARNESS,
          "agent.js": code,
        },
        // The agent's env holds the chat's named bindings (see getEnvForAgent).
        env: this.getEnvForAgent(chatId, bindings, executionId),
        tails: [this.ctx.exports.CodeModeTailLoopback({props: tailProps})],
        globalOutbound: null,
      };

      let entrypoint = this.env.LOADER.load(workerDef).getEntrypoint<CodeModeEntrypoint>();

      // First check the code actually starts up. Treat startup errors as total failures.
      await entrypoint.verify();

      // Create the `self` magic object that allows executed code to call back into this
      // chat thread. Uses the initiator's user ID for model resolution on callbacks.
      let selfStub = this.ctx.exports.AgentSelfLoopback({props: {
        overseerId: this.ctx.id.toString(),
        chatId,
        initiatorUserId: this.users.idFromName(initiator.id).toString(),
        initiatorModelId,
      }});

      let error: string | undefined;
      try {
        // The forger is a transient stub argument, so the capability to forge persistent
        // gadget-restore stubs lives exactly as long as this run() call.
        await entrypoint.run(selfStub, new RestoreForgerImpl(this.self(), chatId, bindings));
      } catch (err) {
        if (err instanceof Error && err.stack) {
          error = err.stack;
        } else {
          error = `${err}`;
        }
        onOutputText?.(`\n\nUncaught exception: ${error}`);
      }

      let timeout = scheduler.wait(5000).then(() => { return null; })
      let trace = await Promise.race([tracePromise, timeout])

      if (!trace) {
        // Trace must have been lost... give up waiting.
        throw new Error("Timed out waiting for logs from code execution.");
      }

      let log = trace.logs.map(log => {
        // Message is an array of params.
        return (log.message as any[]).map(part => {
          return typeof part === "string" ? part : JSON.stringify(part)
        }).join(" ");
      }).join("\n");

      if (error !== undefined) {
        log += `\n\nUncaught exception: ${error}`;
      } else if (log === "") {
        log = "(function succeeded with no output)";
      }

      return log;
    } finally {
      // Guarded by executionId so this cleanup can never clobber a newer registration.
      if (this.activeWorktreeTurns.get(chatId)?.executionId === executionId) {
        this.activeWorktreeTurns.delete(chatId);
      }
      this.#codeModeOutputSubscribers.delete(executionId);
      this.#codeModeResolvers.delete(executionId);
      this.forgedRestoreTargets.delete(chatId);
    }
  }

  // Short-TTL cache for the gatekeeper vendor list. The list is derived from static
  // GATEKEEPER_* bindings, so it barely changes, but the connection hooks below (and the agent's
  // system prompt) call it on every turn — caching avoids hammering the user DO each time.
  #vendorsCache: {
    expires: number;
    promise: Promise<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]>;
  } | null = null;

  protected listGatekeeperVendorsCached() {
    let now = Date.now();
    if (this.#vendorsCache && this.#vendorsCache.expires > now) {
      return this.#vendorsCache.promise;
    }
    let promise = retryOnDoReset(
        () => this.ownerUserStub().listGatekeeperVendors(), this.logger);
    // Don't cache failures: drop the entry so the next call retries.
    promise.catch(() => {
      if (this.#vendorsCache?.promise === promise) this.#vendorsCache = null;
    });
    this.#vendorsCache = { expires: now + OverseerCore.VENDORS_CACHE_TTL_MS, promise };
    return promise;
  }

  async deliverCodeModeTrace(executionId: string, trace: TraceItem) {
    let resolver = this.#codeModeResolvers.get(executionId);
    if (resolver) {
      resolver(trace);
      this.#codeModeResolvers.delete(executionId);
    } else {
      this.logger.error("received unexpected code mode trace", {
        event: "code.mode.trace.unexpected", executionId,
      });
    }
  }

  deliverCodeModeText(executionId: string, delta: string) {
    this.#codeModeOutputSubscribers.get(executionId)?.(delta);
  }
}
