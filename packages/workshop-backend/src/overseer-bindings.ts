import { WorkpieceId, AiChatMessage, AiChatAuthorInfo, AiModelConfig, validateBindingName } from "@gadgets/workshop-shared/api";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type { BoundHookRecord, ChatBindingEntry } from "./storage-schema/overseer-storage";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import { ChatBindingScope, applyMessageBindings } from "./project-chat-log";
import { alwaysAvailableResources, GIT_BINDING_NAME } from "./agent-session";
import type { SeedBindingInfo } from "./agent-hooks";
import { reportIssue } from "@gadgets/observability/error-reporting";
import { normalizeAgentCatalog } from "./agent-catalog";
import { obsContext } from "./observability";
import { retryOnDoReset } from "./do-retry";
import { OverseerAgents } from "./overseer-agents";
import { stampBindHookAction } from "./overseer-action-log";
import { fallbackBindingName } from "./overseer-binding-info";
import type { CatalogGatekeeperFacet } from "./overseer-support";
import { assertBindingNameFree } from "./overseer-support";

/**
 * OverseerBindings: workpiece binding and chat binding preparation.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerBindings extends OverseerAgents {
  // Ambient connections whose getAgentCatalog() answered null, which the contract makes permanent
  // for the connection. Held in memory only: a gatekeeper that gains a catalog in a later version
  // is asked again on the next activation, so every chat converges. Ids are never reused, so an
  // entry outliving its record is inert.
  #catalogless = new Set<number>();

  destroyAllLiveChats() {
    for (let chatId of this.liveChats.chatIds()) {
      this.destroyLiveChat(chatId);
    }
  }

  /**
   * Bind `target` (a gatekeeper) into gadget `gadgetId`'s env under `name`. If `chatId` is
   * given, the edge is provisional to that chat (see BindingRecord.pending); the caller is
   * responsible for getting the addition recorded in the chat log so the pending edge gets
   * sequence-stamped (see addChatMessages()).
   */
  bindWorkpiece(gadgetId: WorkpieceId, name: string, target: WorkpieceId,
                chatId?: number): void {
    validateBindingName(name);
    if (name === "GADGET" || name === GIT_BINDING_NAME) {
      throw new Error(`The binding name \`${name}\` is reserved.`);
    }
    let gadget = this.getGadgetRecord(gadgetId);
    assertBindingNameFree(gadget.bindings, name, chatId);
    let targetRecord = this.storage.gatekeepers.get(target);
    if (!targetRecord) {
      let record = this.storage.gadgets.get(target);
      if (record?.type === "worktree") {
        throw new Error(`Worktrees cannot be bound into gadgets.`);
      }
      if (record) {
        throw new Error(`Gadget-to-gadget bindings are not supported yet.`);
      }
      throw new Error(`No such gatekeeper: ${target}`);
    }
    // A permanent edge can put an account-requiring connection into every "use" collaborator's
    // verification scope, since the gadget UI they drive can now invoke it. Snapshot the scope
    // first and compare after, exactly as mergeChatChanges does: the edge widens nothing when it
    // is pending (invisible to them until promotion, which restarts then), when its target is
    // vendorless, or when some other gadget already binds that target -- and severing every
    // session for a rebind that changed nobody's scope is disruption bought for nothing.
    let useScopeBefore = this.accountRequiringUseScope();

    gadget.bindings[name] = {target, ...(chatId !== undefined ? {pending: {chatId}} : {})};
    this.storage.gadgets.put(gadget);

    // The gadget's env changed, so its code must reload.
    this.bumpVersion([gadgetId]);

    this.restartIfUseScopeWidened(
        useScopeBefore, "Gadget restarted because a connection was bound to a gadget.");
  }

  /**
   * Chat deletion's workpiece cleanup: remove the gadgets and worktrees still provisional to the
   * chat (stamped or not -- deleting the chat discards its proposed changes, which were never
   * accepted), every worktree belonging to it (an accepted worktree is still this chat's alone;
   * chatId is permanent), and any binding edges still provisional to it.
   */
  async removeChatWorkpieces(chatId: number): Promise<void> {
    for (let gadget of this.listPendingGadgets(chatId)) {
      await this.removeWorkpiece(gadget.id);
    }
    for (let record of Array.from(this.storage.gadgets.list())) {
      if (record.type === "worktree" && record.chatId === chatId) {
        await this.removeWorkpiece(record.id);
      }
    }
    this.deleteBindingEdges(edge => edge.pending?.chatId === chatId);
  }

  /**
   * Delete a chat outright: the single cleanup point for every table keyed by it. Cancels any
   * waiting external-message response first (so its waiter settles rather than hanging), then
   * removes the workpiece footprint (see removeChatWorkpieces), then sweeps every chat-keyed
   * record in one durable step -- metadata, context, compaction checkpoints, the change stream
   * and its per-client dedupe records, legacy drafts, messages with their attachment content,
   * callback args, undelivered agent calls, bot delegations (either side), model-facing
   * snapshots, and the resume record (so a deleted chat is never resumed; aborting the live
   * agent also clears it via the tracked promise's finally, but the chat may have no live agent
   * in memory, e.g. after a restart before resumption ran). Finally drops the in-memory live
   * state (see destroyLiveChat).
   */
  async destroyChat(chatId: number): Promise<void> {
    let startedAt = Date.now();
    let response = this.storage.gadgetResponseDeliveries.undeliveredByChatId.get(chatId);
    if (response?.status === "waiting") {
      this.deliverExternalMessageResponse(response,
          "The chat was deleted before the agent responded.");
    }

    await this.removeChatWorkpieces(chatId);

    // Buffer prefix scans first: deleting records invalidates the list cursors.
    let checkpoints = Array.from(this.storage.chatCompactions.list({prefix: chatKeyPrefix(chatId)}));
    let changeClients = Array.from(
        this.storage.chatChangeClients.list({prefix: chatKeyPrefix(chatId)}));
    let drafts = Array.from(this.storage.chatDraftUpdates.list({prefix: chatKeyPrefix(chatId)}));
    let messages = Array.from(this.storage.chats.list({prefix: chatKeyPrefix(chatId)}));
    let callbackArgs = Array.from(this.storage.agentCallbackArgs.list({prefix: chatKeyPrefix(chatId)}));
    let pendingCalls = Array.from(this.storage.pendingAgentCalls.list({prefix: chatKeyPrefix(chatId)}));
    let delegations = Array.from([
      ...this.storage.pendingDelegations.byParentChatId.get(chatId),
      ...this.storage.pendingDelegations.byChildChatId.get(chatId),
    ]);
    let modelData = Array.from(this.storage.chatModelData.list({prefix: chatKeyPrefix(chatId)}));

    this.ctx.storage.transactionSync(() => {
      this.storage.chatMeta.delete(chatId);
      this.storage.chatContext.delete(chatId);
      for (let checkpoint of checkpoints) this.storage.chatCompactions.deleteRecord(checkpoint);
      // The chat's change stream: rows (retired included), the straggler-bridge boundary, and the
      // per-client dedupe records (which live exactly as long as the chat -- see submitCodeChange).
      this.deleteAllChatChanges(chatId);
      for (let client of changeClients) this.storage.chatChangeClients.deleteRecord(client);
      // Any pre-conversion legacy drafts (see ChatDraftUpdateRecord).
      for (let draft of drafts) this.storage.chatDraftUpdates.deleteRecord(draft);
      // Delete the chat's messages and the attachment content referenced by them. Attachment
      // metadata is canonical in each message's ChatAttachmentRef, so no separate attachment
      // index is needed.
      for (let msg of messages) {
        if (msg.type === "message") {
          for (let attachment of msg.attachments ?? []) {
            let content = this.storage.chatAttachmentContent.get(attachment.id);
            if (content?.state.type === "committed" && content.state.chatId === chatId) {
              this.storage.chatAttachmentContent.delete(attachment.id);
            }
          }
        }
        this.storage.chats.deleteRecord(msg);
      }
      for (let entry of callbackArgs) this.storage.agentCallbackArgs.deleteRecord(entry);
      for (let entry of pendingCalls) this.storage.pendingAgentCalls.deleteRecord(entry);
      // Bot delegations involving this chat, from either side: a parent's records die with it
      // (nothing will await the children), and a child's die because its awaiting parent must
      // not treat a deleted thread as still running.
      for (let record of delegations) this.storage.pendingDelegations.deleteRecord(record);
      for (let entry of modelData) this.storage.chatModelData.deleteRecord(entry);
      this.storage.activeAgents.delete(chatId);
    });

    // Clean up all in-memory live state for this chat.
    this.destroyLiveChat(chatId);

    this.logger.info("deleted chat", {
      event: "chat.delete.completed", chatId, durationMs: Date.now() - startedAt,
    });
  }

  /**
   * Record a hook as enabled, updating its action-log record to match -- the synchronous state
   * flip at the heart of OverseerClientInterface.enableHook (the gatekeeper-side
   * controller.enable() has already succeeded by the time this runs).
   *
   * The hook and its connection are re-read rather than trusting the caller's captured record:
   * the enable() round trip leaves the input gate open, so deleteHook/removeGatekeeper may have
   * deleted either while it was in flight, and putting the captured record back would silently
   * resurrect an enabled hook on a connection that no longer exists -- one delivering into the
   * gadget (startHook accepts via the record's denormalized vendorId) while being invisible to
   * the widening detector (#accountRequiringUseScope filters on the gatekeeper record). Deleting
   * the record must stay the authoritative kill, so in that case the goal state is "no hook":
   * send the compensating gatekeeper-side disable best-effort and refuse the flip.
   *
   * Enabling can widen every "use" collaborator's verification scope: the connection becomes
   * reachable through the gadget the hook wakes even when no binding edge names it (see
   * #useScopeGatekeeperIds), so the scope is diffed around the flip exactly as bindWorkpiece
   * does. Disabling or deleting a hook only shrinks scope, which never under-verifies anyone, so
   * those paths need no counterpart -- capabilities issued to firings already in flight are
   * revoked by their own per-call revalidation instead (see requireLiveHook).
   */
  enableHookRecord(record: BoundHookRecord): void {
    let current = this.storage.boundHooks.get(record.id);
    if (!current || !this.storage.gatekeepers.get(current.gatekeeperId)) {
      this.ctx.waitUntil(record.controller.disable().catch(error => {
        this.logger.warn("failed to disable a hook removed while enabling", {
          event: "gatekeeper.hook.enable.compensate.failed",
          gatekeeperId: record.gatekeeperId, hookId: record.id, error,
        });
      }));
      throw new Error("The connection or hook was removed while the hook was being enabled.");
    }

    let useScopeBefore = this.accountRequiringUseScope();
    current.enabled = true;
    this.storage.boundHooks.put(current);
    stampBindHookAction(this.storage, current.actionId, true);
    this.restartIfUseScopeWidened(
        useScopeBefore, "Gadget restarted because a connection's hook was enabled.");
  }

  // The quick-model context used for turn-start binding naming, fetched lazily (the naming path
  // runs at most once per legacy message) and resolved from the workspace owner's account.
  // Returns undefined when no quick model is configured (callers fall back to deterministic
  // names).
  async #getNamingQuickModel()
      : Promise<{config: AiModelConfig, initiator: AiChatAuthorInfo} | undefined> {
    if (!this.ownerId) return undefined;
    try {
      // Pure read on a fresh-stub getter: safe to retry once across a user-DO reset.
      let userMeta = await retryOnDoReset(
          () => this.ownerUserDo().getChatContext(null), this.logger);
      return userMeta.quickModel
          ? {config: userMeta.quickModel, initiator: userMeta.profile}
          : undefined;
    } catch (err) {
      this.logger.warn("failed to resolve quick model for binding naming", {
        event: "chat.binding.name.quick.model.failed", error: err,
      });
      return undefined;
    }
  }

  // The binding name an ambient resource takes in a chat: its gatekeeper's suggested binding name,
  // made unique.
  async #ambientBindingName(gatekeeperId: WorkpieceId, isTaken: (name: string) => boolean)
      : Promise<string> {
    let suggested: string | undefined;
    try {
      suggested =
          (await (await this.getGatekeeperFacet(gatekeeperId)).describe()).suggestedBindingName;
    } catch (err) {
      this.logger.warn("failed to fetch suggested binding name for ambient resource", {
        event: "chat.binding.ambient.describe.failed", gatekeeperId, error: err,
      });
    }
    return fallbackBindingName(suggested || "RESOURCE", isTaken);
  }

  /**
   * Prepare and return the chat's seed binding layer, including the always-available (ambient)
   * resources with their discovery catalogs. Called at agent turn start, before history replay.
   *
   * This is the single lazy chokepoint for seeding and naming:
   *   - The seed map (`chatContext.bindings`) is created on first use: normal chats snapshot the
   *     workspace default binding list, spawned chats their frozen spawner env (resolving an
   *     old-style allowlist the same way the storage migration does). Chats created before named
   *     chat bindings are seeded here on their next turn, with zero upfront migration.
   *   - The ambient resource set is captured on first use (ordered by gatekeeper id) and folded
   *     into the seed map, each named by its gatekeeper's suggested binding name. A regular chat
   *     then takes in each ambient resource the workspace gains later, on its next turn.
   *   - Persisted messages that introduced resources but carry no binding name yet -- pasted
   *     resources, plus connection requests from before agents named their own -- are named
   *     (via the quick model when configured, else the gatekeeper's suggested name) and stamped,
   *     so history replay always sees named resources. Stamped = permanent; a crash before
   *     stamping just means naming reruns next turn.
   */
  async prepareChatBindings(chatId: number, chatMessages: AiChatMessage[])
      : Promise<SeedBindingInfo[]> {
    let context = this.getChatAgentContext(chatId);
    let dirty = false;

    if (context.alwaysAvailableCapsuleIds === undefined) {
      // Capture the ambient set + order on first use. Ordered by gatekeeper id (immutable) for
      // determinism. A since-disconnected one stays in the list but becomes inert; ones the
      // workspace gains later are appended below.
      context.alwaysAvailableCapsuleIds = [...this.storage.gatekeepers.list()]
          .filter(gk => gk.creationSpec?.type === "ambient")
          .map(gk => gk.id)
          .toSorted((a, b) => a - b);
      dirty = true;
    }
    let ambientIds = context.alwaysAvailableCapsuleIds;

    if (context.bindings === undefined) {
      let seed: Record<string, WorkpieceId> = Object.create(null);
      if (context.spawnerConfig) {
        // Spawned chats see only the spawner's configured bindings. The frozen config may
        // predate the structured env -- `env?: string[]` was a binding-name allowlist, with
        // absence meaning "unrestricted" -- in which case it is resolved against the current
        // default binding list, mirroring how the storage migration rewrites stored spawner
        // records.
        let env = context.spawnerConfig.env;
        if (env === undefined || Array.isArray(env)) {
          for (let [name, target] of Object.entries(this.defaultBindingList())) {
            if (env === undefined || env.includes(name)) seed[name] = target;
          }
        } else {
          // Drop entries whose targets no longer exist. (A worktree can't be configured --
          // newAgentSpawnerGatekeeper rejects one -- so none can appear here either.)
          for (let [name, target] of Object.entries(env)) {
            if (this.storage.gadgets.get(target)?.type === "gadget" ||
                this.storage.gatekeepers.get(target)) {
              seed[name] = target;
            }
          }
        }
      } else {
        Object.assign(seed, this.defaultBindingList());
      }

      let scratch = context.scratch;
      if (scratch !== undefined &&
          this.storage.gadgets.get(scratch.worktreeId)?.type === "worktree") {
        seed[scratch.bindingName] = scratch.worktreeId;
      }

      // A new seed never takes the automatic env.GIT's name, which a chat binding would shadow
      // (see getEnvForAgent). The name can still arrive from before it was reserved -- a legacy
      // gadget binding in the default list, or an old spawner's frozen env -- so such an entry is
      // renamed rather than dropped, keeping its target reachable. (A chat seeded before the
      // reservation keeps its GIT binding: a seed entry is never renamed.)
      let isSeedNameTaken = (name: string) => name in seed || name === GIT_BINDING_NAME;
      if (GIT_BINDING_NAME in seed) {
        let target = seed[GIT_BINDING_NAME];
        delete seed[GIT_BINDING_NAME];
        seed[fallbackBindingName(GIT_BINDING_NAME, isSeedNameTaken)] = target;
      }

      // Fold the ambient resources into the seed, each named by its gatekeeper's suggested
      // binding name (deduped); skip any whose target already has a name in the seed.
      let seededTargets = new Set(Object.values(seed));
      for (let id of ambientIds) {
        if (seededTargets.has(id)) continue;
        let gk = this.storage.gatekeepers.get(id);
        if (!gk) continue;  // disconnected since the chat took it in -- inert, no name needed
        seed[await this.#ambientBindingName(id, isSeedNameTaken)] = id;
      }

      context.bindings = seed;
      dirty = true;
    }
    let seedMap = context.bindings;

    // --- The naming chokepoint: stamp binding names onto persisted messages that lack them. ---
    // One walk over the seed and the log (see project-chat-log.ts -- the same walk the agent's
    // replay and compaction apply) collects every name in the chat's scope and the target ->
    // name map the stamping below reuses. We scan the caller's in-memory message objects (not a
    // fresh storage listing, which would deserialize separate copies): the caller replays these
    // same objects right after we return, and must see the names we stamp. (This can't reuse
    // chatScopeNames: that method rereads the chat context from storage, where a seed map
    // created just above isn't persisted yet.)
    //
    // Names allocated before the compaction boundary aren't in `chatMessages`, so the
    // checkpoint's entries join the seed in the initial scope; skipping them would hand a new
    // resource a name the prefix already bound, and replay -- which seeds its map from the same
    // checkpoint -- would keep resolving that name to the older target while rendering the new
    // resource's link with it.
    let scope = new ChatBindingScope([
      ...Object.entries(seedMap).map(([name, target]) =>
          [name, {type: "workpiece", id: target}] as [string, ChatBindingEntry]),
      ...this.getActiveChatCompaction(chatId)?.chatBindings ?? [],
    ]);
    scope.taken.add(GIT_BINDING_NAME);
    for (let msg of chatMessages) applyMessageBindings(scope, msg);
    let taken = scope.taken;
    let nameByTarget = scope.nameByTarget;
    let namingLog = chatMessages;
    // Anything the walk saw that lacks a name (an unstamped capsule, or a not-yet-denied
    // connection request) needs one allocated below.
    let anythingToName = namingLog.some(msg =>
        (msg.type === "message" &&
          msg.capsules?.some(capsule => capsule.bindingName === undefined) === true) ||
        (msg.type === "connectionRequest" &&
          msg.state !== "denied" && msg.bindingName === undefined));

    // A regular chat also takes in each ambient resource the workspace gained after the chat
    // started (e.g. the owner turned on Web Search), deduped against every name in its scope. The
    // system prompt keeps the list the chat started with; the agent learns of the new resource from
    // a "catalogChange" message instead (see agent.ts). A spawned chat's env stays its spawner's
    // (see #useScopeGatekeeperIds).
    if (!context.spawnerConfig) {
      let known = new Set(ambientIds);
      let gained = [...this.storage.gatekeepers.list()]
          .filter(gk => gk.creationSpec?.type === "ambient" && !known.has(gk.id))
          .map(gk => gk.id)
          .toSorted((a, b) => a - b);
      for (let id of gained) {
        if (nameByTarget.has(id)) continue;  // a legacy chat's new seed can already bind it
        let name = await this.#ambientBindingName(id, n => taken.has(n));
        seedMap[name] = id;
        taken.add(name);
        nameByTarget.set(id, name);
      }
      if (gained.length > 0) {
        ambientIds = [...ambientIds, ...gained];
        context.alwaysAvailableCapsuleIds = ambientIds;
        dirty = true;
      }
    }

    if (anythingToName) {
      let quick = await this.#getNamingQuickModel();

      // Name one resource: reuse the target's existing name in scope when there is one, else ask
      // the quick model, else fall back to the gatekeeper's suggested binding name (suffixed to
      // uniqueness). Never fails -- worst case the generic fallback names it RESOURCE_<n>.
      let nameFor = async (target: WorkpieceId | undefined, subject: string)
          : Promise<string> => {
        if (target !== undefined) {
          let existing = nameByTarget.get(target);
          if (existing !== undefined) return existing;
        }
        let name = quick ? await this.generateBindingName(subject, taken, quick) : undefined;
        if (name === undefined) {
          let suggested: string | undefined;
          if (target !== undefined && this.storage.gatekeepers.get(target)) {
            try {
              suggested =
                  (await (await this.getGatekeeperFacet(target)).describe()).suggestedBindingName;
            } catch {
              // Fall through to the generic fallback.
            }
          }
          name = fallbackBindingName(suggested || "RESOURCE", n => taken.has(n));
        }
        taken.add(name);
        if (target !== undefined) nameByTarget.set(target, name);
        return name;
      };

      for (let msg of namingLog) {
        let stamped = false;
        if (msg.type === "message") {
          for (let capsule of msg.capsules ?? []) {
            if (capsule.bindingName !== undefined) continue;
            capsule.bindingName =
                await nameFor(capsule.gatekeeperId, capsule.description.title);
            stamped = true;
          }
        } else if (msg.type === "connectionRequest" &&
                   msg.bindingName === undefined && msg.state !== "denied") {
          msg.bindingName = await nameFor(
              msg.gatekeeperId, `${msg.resourceTitle} (${msg.vendorName})`);
          stamped = true;
        }
        if (stamped) {
          // Guard against the chat having been deleted during the awaits above (deleteChat is
          // the single cleanup point; a put here would resurrect a deleted message). Bump the
          // timestamp so offline clients re-receive the mutated message (same pattern as
          // connection accept/deny stamping).
          if (!this.storage.chatMeta.get(chatId)) break;
          msg.timestamp = this.getChatTimestamp();
          this.storage.chats.put(msg);
        }
      }
    }

    // Load the discovery catalogs for the usable ambient set. A connection blocked pending a
    // scope-widening restart is omitted, like the other enumerating routes; one that answered null
    // before is not asked again (see #catalogless).
    //
    // Loaded afresh every turn, since a catalog says what the session can reach now (see
    // AiChatAgentContext.alwaysAvailableResources for how a change reaches the agent). Not an
    // observation: the catalog reaches every chat automatically, so by contract it holds nothing
    // that needs observer verification.
    let catalogs = new Map(await Promise.all(ambientIds
        .filter(id => this.gatekeeperUsable(id) && !this.#catalogless.has(id))
        .map(async (gatekeeperId): Promise<[number, AgentCatalog | null]> => {
          let record = this.storage.gatekeepers.get(gatekeeperId);
          if (!record) return [gatekeeperId, null];  // disconnected since the chat took it in.
          try {
            // getAgentCatalog is optional on Gatekeeper; ambient resources always implement it (the
            // agent relies on it for discovery), answering null when they have none, so we view the
            // facet through CatalogGatekeeperFacet (derived from the contract) to call it directly.
            let facet = await this.getGatekeeperFacet(gatekeeperId) as unknown as
                CatalogGatekeeperFacet;
            let catalog = await facet.getAgentCatalog();
            if (!catalog) {
              this.#catalogless.add(gatekeeperId);
              return [gatekeeperId, null];
            }
            return [gatekeeperId, normalizeAgentCatalog(catalog)];
          } catch (error) {
            reportIssue("overseer.catalog-fallback", error, {
              handled: true,
              attributes: {
                ...obsContext.get(), gadgetId: this.ctx.id.toString(), gatekeeperId,
              },
            });
            this.logger.warn("failed to load agent catalog", {
              event: "agent.catalog.load.failed",
              gatekeeperId, resourceTitle: record.resourceTitle, error,
            });
            // The next turn loads it again, so one failure costs this turn's catalog and no more.
            return [gatekeeperId, null];
          }
        })));

    // Materialize the seed entries, skipping targets that no longer exist (mirroring env build)
    // or that are blocked pending a scope-widening restart (like the enumerating routes above:
    // even the connection's metadata belongs to a scope nobody live was verified against, and
    // the entry reappears once the reset lands); ambient entries carry their catalogs.
    let ambientSet = new Set(ambientIds);
    let result: SeedBindingInfo[] = [];
    for (let [name, target] of Object.entries(seedMap)) {
      let gadget = this.storage.gadgets.get(target);
      if (gadget?.type === "gadget") {
        result.push({name, target, title: gadget.title, isGadget: true});
        continue;
      }
      if (gadget?.type === "worktree" &&
          context.scratch?.worktreeId === gadget.id && gadget.chatId === chatId) {
        result.push({name, target, title: gadget.title, isGadget: false});
        continue;
      }
      if (gadget) continue;  // ordinary agent-created worktrees never seed a chat
      let gk = this.storage.gatekeepers.get(target);
      if (!gk || !this.gatekeeperUsable(gk.id)) continue;
      let info: SeedBindingInfo =
          {name, target, title: gk.resourceTitle || "(untitled resource)", isGadget: false};
      if (ambientSet.has(target)) info.catalog = catalogs.get(target) ?? null;
      result.push(info);
    }

    if (context.alwaysAvailableResources === undefined) {
      context.alwaysAvailableResources = alwaysAvailableResources(result);
      dirty = true;
    }
    if (dirty) {
      // The work above is async, so the chat could have been deleted meanwhile. Don't resurrect
      // its per-chat storage: deleteChat is the single cleanup point (see its comment) and
      // removes chatMeta, so a missing chatMeta means the chat is gone.
      if (this.storage.chatMeta.get(chatId)) {
        this.storage.chatContext.put(context);
      }
    }

    return result;
  }
}
