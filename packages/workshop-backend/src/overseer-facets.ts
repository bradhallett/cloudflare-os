import { RpcTarget } from "capnweb";
import { WorkpieceId, AiChatMetadata, ChatAttachmentRef, SlashCommandChoice, SlashCommandRequest, validateBindingName, resolveSiteName } from "@gadgets/workshop-shared/api";
import { applyCodeChange, codeChangeSerializedSize, MAX_CODE_CHANGE_SIZE, requireTextFiles } from "@gadgets/workshop-shared/code-change";
import type { FileContent, CodeContent } from "@gadgets/workshop-shared/code-change";
import { Gatekeeper, ObservationAuthorizer } from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { AiChatAgentContext } from "./storage-schema/overseer-storage";
import { formatBotSection } from "./bot-config";
import type { ResolvedBotSkill, UnavailableBotSkill } from "./bot-config";
import type { UserChatContext } from "./user";
import type { ActionRecord, ChatBindingEntry, GatekeeperClass, GatekeeperRecord } from "./storage-schema/overseer-storage";
import { GIT_BINDING_NAME } from "./agent-session";
import WORKTREE_BINDING_TYPES from "./worktree-binding.txt";
import EXPORTS_BINDING_TYPES from "./exports-binding.txt";
import { readAdminConfig } from "./admin-config";
import { collectSlashCommands, invokeSlashCommand } from "./slash-commands";
import { traceToolApproval } from "./agent-tracing";
import { decodeChatAttachmentText } from "./chat-attachment-validation";
import { OverseerChatRuntime } from "./overseer-chat-runtime";
import type { OverseerRestoreParams, PreparedChatMessage } from "./overseer-support";
import { CHAT_CHANGE_MATERIALIZE_THRESHOLD } from "./overseer-support";
import type { GadgetTailLoopbackProps } from "./overseer-loopbacks";
import { agentApiText, gatekeeperVendorId } from "./overseer-binding-info";
import { stampBindHookAction } from "./overseer-action-log";
import { sanitizeCommandPosition } from "./overseer-message-format";
import { SlashCommandAuthorizerImpl } from "./overseer-gatekeeper-client";
import type { RestoreForgerEntrypoint } from "./overseer-harness";
import { RESTORE_FORGER_WORKER } from "./overseer-harness";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/compatibility-date";

/**
 * OverseerFacets: worker/facet loading, gatekeeper usability and description, slash commands, and stub forging.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerFacets extends OverseerChatRuntime {
  /**
   * Remove the named binding edge from the gadget. The target gatekeeper itself survives,
   * possibly no longer bound by any gadget. `forChatId` scopes visibility: an edge pending in
   * some other chat is treated as nonexistent (it isn't this caller's to remove).
   */
  unbindWorkpiece(gadgetId: WorkpieceId, name: string, forChatId?: number): void {
    let gadget = this.getGadgetRecord(gadgetId);
    let edge = gadget.bindings[name];
    if (!edge || (edge.pending && edge.pending.chatId !== forChatId &&
                  forChatId !== undefined)) {
      throw new Error(`No such binding: ${name}`);
    }
    delete gadget.bindings[name];
    this.storage.gadgets.put(gadget);
    this.bumpVersion([gadgetId]);
  }

  /** Rename a binding edge atomically, preserving edge metadata and restarting the gadget once. */
  renameBinding(gadgetId: WorkpieceId, oldName: string, newName: string): void {
    let gadget = this.getGadgetRecord(gadgetId);
    let edge = gadget.bindings[oldName];
    if (!edge) {
      throw new Error(`No such binding: ${oldName}`);
    }
    if (oldName === newName) return;
    validateBindingName(newName);
    if (newName === "GADGET" || newName === GIT_BINDING_NAME) {
      throw new Error(`The binding name \`${newName}\` is reserved.`);
    }
    if (gadget.bindings[newName]) {
      throw new Error(`There is already a binding named "${newName}".`);
    }

    delete gadget.bindings[oldName];
    gadget.bindings[newName] = edge;
    this.storage.gadgets.put(gadget);
    this.bumpVersion([gadgetId]);
  }

  /** The worktree pins of a chat's live code base, as a base-commit map for seedWorktreeEditBases. */
  worktreePinBases(meta: AiChatMetadata): Map<WorkpieceId, string> {
    let bases = new Map<WorkpieceId, string>();
    for (let pin of meta.codeBase?.pins ?? []) {
      if (this.isWorktree(pin.gadgetId)) bases.set(pin.gadgetId, pin.baseCommit);
    }
    return bases;
  }

  /**
   * Live row count that triggers materialization (see submitCodeChange). A field so tests can
   * reach the trigger without a thousand submissions.
   */
  chatChangeMaterializeThreshold = CHAT_CHANGE_MATERIALIZE_THRESHOLD;

  /**
   * The chat's current content: what the next change row will apply to. Cached; treat the result as
   * immutable (it is shared with the cache and with code-change's structure sharing).
   */
  async getCurrentChatContent(chatId: number, meta: AiChatMetadata): Promise<CodeContent> {
    for (let attempt = 0; ; attempt++) {
      let codeBase = this.chatCodeBase(meta);
      let cached = this.chatContentCache.get(chatId);
      if (cached !== undefined && cached.generation === codeBase.generation &&
          cached.revision === codeBase.revision) {
        return cached.content;
      }

      // The builds below await; the sequence token detects a message landing mid-build (e.g. a
      // materialization retiring rows out from under the row scan), and the re-reads pick up
      // rows appended meanwhile.
      let token = this.nextChatSequencePeek(chatId);
      let content = await this.buildChatContent(chatId);
      // Pins established by live rows are not yet declared in any message; their bases enter
      // the content before the rows apply. (Rows before the establishing row never touch the
      // gadget, so establishing all of them up front is equivalent to establishing in order.)
      for (let pin of this.undeclaredMetaPins(chatId, meta)) {
        if (this.isWorktree(pin.gadgetId)) {
          // Lazy, like buildChatContent's worktree pins.
          if (!content.has(pin.gadgetId)) content.set(pin.gadgetId, new Map());
        } else {
          content.set(pin.gadgetId, await this.gitStore.readCommitFiles(pin.baseCommit));
        }
      }

      // Prefetch (awaits) the live rows' worktree edit bases for the synchronous tail below.
      // Commits are immutable, so a prefetched text can never go stale; a row appended during
      // the awaits that needs an unprefetched base is caught in the tail and retried.
      let worktreeBases = this.worktreePinBases(meta);
      let seeds = new Map<string, FileContent | null>();
      if (worktreeBases.size > 0) {
        let probe = content;
        for (let row of this.listLiveChatChanges(chatId, codeBase.generation)) {
          probe = await this.prefetchWorktreeSeeds(probe, row.change, worktreeBases, seeds);
          probe = applyCodeChange(probe, row.change);
        }
      }

      // Synchronous tail: apply the live rows and revalidate the snapshot. A pin established
      // during the awaits -- a first modification's row landing, which moves neither token --
      // is the one change the bases above were computed without (its base tree, or its
      // worktree's lazy base, would be missing under the row), so it re-resolves too; pins only
      // ever grow within a generation, so a count change is the whole test.
      let freshMeta = this.getChatMetaOrThrow(chatId);
      let freshBase = this.chatCodeBase(freshMeta);
      let missedSeed = false;
      if (this.nextChatSequencePeek(chatId) !== token ||
          freshBase.generation !== codeBase.generation ||
          freshBase.pins.length !== codeBase.pins.length) {
        if (attempt >= 4) throw new Error("The chat is changing too quickly; please retry.");
        meta = freshMeta;
        continue;
      }
      for (let row of this.listLiveChatChanges(chatId, freshBase.generation)) {
        let seeded = this.applyPrefetchedWorktreeSeeds(content, row.change, worktreeBases, seeds);
        if (seeded === null) {
          missedSeed = true;  // a row landed during the prefetches; re-resolve
          break;
        }
        content = applyCodeChange(seeded, row.change);
      }
      if (missedSeed) {
        if (attempt >= 4) throw new Error("The chat is changing too quickly; please retry.");
        meta = freshMeta;
        continue;
      }
      this.chatContentCache.set(chatId,
          {generation: freshBase.generation, revision: freshBase.revision, content});
      return content;
    }
  }

  /** The body of Overseer.discardChatDraftChanges(). */
  discardChatDraftChanges(chatId: number): void {
    let meta = this.assertChatNotActive(chatId);
    let codeBase = this.chatCodeBase(meta);
    let rows = this.listLiveChatChanges(chatId, codeBase.generation);
    if (rows.length === 0) {
      return;
    }

    // The second row-discarding path (revertChanges is the other), with the same treatment:
    // meta pins those rows established but never declared in a materialized message die with
    // them (nothing else roots in their bases), and the bump is destructive -- the erased rows
    // are content clients already applied, so they must discard local state and rebuild rather
    // than submit changes rooted in erased history. Any new row-discarding path must do the same,
    // or `codeBase` and the log disagree and queued client submissions can still reference an
    // erased base. (The per-client dedupe records survive -- see submitCodeChange: a straggling
    // retry of an erased row is still acknowledged with its recorded landing spot instead of
    // being applied twice.)
    let declared = this.declaredPins(chatId);
    codeBase.pins = codeBase.pins.filter(pin => declared.has(pin.gadgetId));
    this.deleteAllChatChanges(chatId);
    codeBase.generation += 1;
    codeBase.revision = 0;
    delete codeBase.prior;
    meta.codeBase = codeBase;

    meta.lastActive = this.getChatTimestamp();
    this.storage.chatMeta.put(meta);
    this.proposedChangesChanged(chatId);
  }

  /**
   * Load the dynamic worker representing the given gadget's committed (head-commit) code.
   * Returns the dynamic WorkerStub (which can be used to get any entrypoint).
   *
   * If `chatId` is specified, load the worker from that chat's code doc instead, including its
   * proposed changes. (The caller is presumed to have verified the chat exists and has proposed
   * changes.)
   */
  loadGadgetWorker(gadgetId: WorkpieceId, chatId?: number): WorkerStub {
    let codeVersion = `${this.storage.codeVersion.get()}`;
    let sequence: number | undefined;
    // Snapshotted in the same synchronous step as the cache key's sequence: the loader callback
    // runs asynchronously, and buildChatDoc's as-of-`sequence` reconstruction needs the
    // metadata as it stood then (a merge landing mid-load must not flip e.g. a legacy chat's
    // base out from under the snapshot the key names).
    let meta: AiChatMetadata | undefined;
    if (chatId !== undefined) {
      meta = this.getChatMetaOrThrow(chatId);
      sequence = this.storage.nextChatSequences.get(chatId)?.nextSequence || 0;
      codeVersion += `.${chatId}.${sequence}`;
    }

    return this.env.LOADER.get(`${this.ctx.id}.${codeVersion}.${gadgetId}`, async () => {
      // The snapshot meta above serves the as-of-`sequence` doc build; this re-read only keeps
      // the old fail-on-deleted-chat behavior (don't cache a load for a chat deleted mid-load).
      if (chatId !== undefined) this.getChatMetaOrThrow(chatId);
      let files: ReadonlyMap<string, string>;
      // An unpinned committed gadget tracks mainline head live, in chat context and out (see
      // chatDocOwnsGadget). Head movement invalidates the cached load either way: every merge
      // bumps the codeVersion counter in the cache key.
      if (meta !== undefined && this.chatDocOwnsGadget(meta, gadgetId)) {
        // The cache key snapshotted the chat's next sequence, so exclude any batch recorded
        // after it (a fresh load with a fresh key sees those). Live rows are likewise excluded;
        // callers that want them reflected materialize first, exactly as drafts always worked.
        files = requireTextFiles((await this.buildChatContent(chatId!, sequence! - 1)).get(gadgetId) ?? new Map());
      } else {
        let commitId = this.getGadgetHead(gadgetId);
        files = commitId !== undefined
            ? await this.gitStore.readCommitFiles(commitId)
            : new Map();
      }

      let modules: Record<string, string> = {};
      for (let [file, content] of files) {
        if (file.endsWith(".js")) {
          modules[file] = content;
        }
      }

      let tailProps: GadgetTailLoopbackProps = {
        chatId,
        gadgetId,
        overseerId: this.ctx.id.toString(),
      };

      return {
        // The minimal flag set is deliberate; the compatibility date flows from the repo's
        // single home (COMPATIBILITY_DATE).
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [
          // Make ctx.restore() available.
          "allow_irrevocable_stub_storage",
        ],
        mainModule: "server.js",
        modules,
        env: this.getEnvForLoader(gadgetId, {from: "gadget", chatId, gadgetId}, chatId),
        globalOutbound: null,

        // TODO: Switch to streaming tails when the workerd log spam issue is fixed.
        tails: [this.ctx.exports.GadgetTailLoopback({props: tailProps})],
      };
    });
  }

  /**
   * Load the given gadget's facet (if it's not running already) and return the stub to it.
   *
   * If `chatId` is specified, load the gadget including changes proposed in the given chat
   * thread.
   *
   * The stub is minted through our own ctx.restore() rather than taken from ctx.facets.get()
   * directly: the runtime only lets a facet call *its* ctx.restore() when the request reached it
   * through a stub the parent created with ctx.restore() (that stub is what tells the runtime how
   * to recreate the facet). A bare facet stub carries no such context, so gadget code calling
   * `this.ctx.restore()` -- to hand a persistent callback to a spawned agent or a hook -- would
   * throw. Every stub to a gadget facet therefore comes from here; only [restore]() itself, which
   * is what ctx.restore() invokes, touches the raw facet (see #getGadgetFacetRaw).
   */
  async getGadgetFacetFetcher(gadgetId: WorkpieceId, chatId?: number)
      : Promise<Fetcher<DurableObject>> {
    let params: OverseerRestoreParams = {type: "gadget", gadgetId};
    chatId = this.#resolveGadgetChatId(gadgetId, chatId);
    if (chatId !== undefined) params.chatId = chatId;
    return await this.ctx.restore(params);  // validates the gadget exists, in [restore]()
  }

  // Narrow `chatId` to the case where it actually changes what code runs: the chat proposes
  // changes to *this gadget* (code, provisional creation, or a provisional binding edge -- see
  // proposedChangeWorkpieceIds). Otherwise return undefined to load the main-branch facet: the
  // chat context would run identical code (chatDocOwnsGadget) but as a needlessly separate
  // instance, restarted on every proposedChangesChanged(). A chat that no longer exists (e.g. a
  // chatId sealed into a persistent stub, see OverseerRestoreParams.chatId) likewise resolves to
  // main.
  #resolveGadgetChatId(gadgetId: WorkpieceId, chatId: number | undefined): number | undefined {
    if (chatId === undefined) return undefined;
    let meta = this.storage.chatMeta.get(chatId);
    if (!meta || !this.proposedChangeWorkpieceIds(chatId, meta).includes(gadgetId)) {
      return undefined;
    }
    return chatId;
  }

  // The bare facet stub behind getGadgetFacetFetcher(). Only [restore]() may call this (see the
  // comment there): a request made on the returned stub leaves the facet unable to call its own
  // ctx.restore(). `chatId` must already be resolved by #resolveGadgetChatId.
  #getGadgetFacetRaw(gadgetId: WorkpieceId, chatId: number | undefined): Fetcher<DurableObject> {
    // If we switched chats since the last time we ran the gadget and either the old or new chat
    // has proposed changes, this means we're changing what code is running, so we need to reset
    // the gadget. this.runningChatIds tracks, for each gadget, which chat's proposed changes are
    // running. A null entry means we're running the mainline version (not in a chat, or the chat
    // has no proposed changes).
    //
    // A missing / undefined entry means we haven't seen this gadget yet since the overseer
    // started. Usually this means the facet isn't running, but it's theoretically possible that
    // the overseer hibernated and came back while the facet was running the whole time. At present
    // this is difficult since RPC sessions don't support hibernation, but it's theoretically
    // possible if the gadget is doing some background work that keeps it alive.
    //
    // To handle that situation, we will defensively reset the facet if we don't have a map entry.
    // Aborting a facet that isn't running is a no-op, so this should be harmless in the common
    // case.
    //
    // If/when we support hiberation of the overseer, we'll need to do something more
    // sophisticated.
    let facetName = this.gadgetFacetName(gadgetId);
    let oldChat = this.runningChatIds.get(gadgetId);
    let newChat = chatId ?? null;
    if (newChat !== oldChat) {
      this.ctx.facets.abort(facetName, new Error(
          newChat === null
            ? "Gadget restarted to switch back to main version."
            : "Gadget restarted to test proposed changes."));
      this.runningChatIds.set(gadgetId, newChat);
    }

    return this.ctx.facets.get<DurableObject>(facetName, () => {
      let stub = this.loadGadgetWorker(gadgetId, chatId);

      return {
        class: stub.getDurableObjectClass<any>("Gadget"),
        id: facetName
      };
    });
  }

  /**
   * The gadget's file tree as seen from `chatId` (its chat content; the caller is presumed to
   * have materialized live change rows, see checkChatExistsAndMaterializeChanges) or from
   * mainline. A chat that doesn't own the gadget's code (see chatDocOwnsGadget) reads mainline
   * too: the gadget's head commit, which a gadget with no commit yet doesn't have -- no files.
   */
  async readGadgetFiles(gadgetId: WorkpieceId, chatId?: number)
      : Promise<ReadonlyMap<string, string>> {
    if (this.storage.gadgets.get(gadgetId)?.type === "worktree") {
      // Defense in depth: callers reach this through validated gadget handles, but a worktree id
      // here would materialize a whole repository tree into a gadget-only read -- some of which
      // (the UI bundle) serve use-role clients, who never see worktrees.
      throw new Error(`Workpiece ${gadgetId} is a worktree, not a gadget.`);
    }
    let meta = chatId !== undefined ? this.getChatMetaOrThrow(chatId) : undefined;
    if (meta !== undefined && this.chatDocOwnsGadget(meta, gadgetId)) {
      return (await this.buildChatContent(chatId!)).get(gadgetId) ?? new Map();
    }
    let commitId = this.getGadgetHead(gadgetId);
    return commitId !== undefined ? await this.gitStore.readCommitFiles(commitId) : new Map();
  }

  /**
   * Load a WorkerEntrypoint exported by the gadget, used to implement a hook.
   *
   * TODO: There should be a way to simulate hooks within the context of a particular chat thread,
   *   for testing. But when real-life hooks are delivered they obviously need to go to the
   *   mainline code.
   */
  getGadgetHookEntrypoint(id: number): RpcTarget {
    let gk = this.storage.gatekeepers.get(id);
    if (gk && gk.hook) {
      // GatekeeperRecord.hook predates multi-gadget support (it is set only by the obsolete
      // setBindingHook tool), so it always refers to the default gadget's code.
      let stub = this.loadGadgetWorker(this.resolveGadgetId(undefined));
      let ep = stub.getEntrypoint(gk.hook);

      // TODO: Make possible to return dynamic entrypoint stub over RPC. This Proxy is a hack.
      return new Proxy<RpcTarget>(ep as any, {
        get(target, prop, receiver) {
          // Note: We need `target` to be used as the receiver. If we use `receiver` as the receiver,
          //   we'll get an illegal invocation, as `receiver` points to our Proxy.
          return Reflect.get(target, prop, target);
        },
        getPrototypeOf(target) {
          return RpcTarget.prototype;
        },
      });
    } else {
      throw new Error("Hook is not connected.");
    }
  }

  /**
   * Every stub to a gatekeeper facet is minted through ctx.restore(), for the reason given at
   * getGadgetFacetFetcher(): it lets the gatekeeper call its own ctx.restore() to mint persistent
   * stubs to itself, e.g. a target its push handler delivers events through. The exception is
   * `cls`, for the one caller that has the class in hand but has deliberately not published the
   * record yet (`addGatekeeper`): [restore]() would find no record, so it gets the raw facet.
   */
  async getGatekeeperFacet(id: number, cls?: GatekeeperClass): Promise<Fetcher<Gatekeeper<any>>> {
    if (cls) return this.#getGatekeeperFacetRaw(id, cls);
    return await this.ctx.restore(  // validates the gatekeeper exists, in [restore]()
        {type: "gatekeeper", gatekeeperId: id} satisfies OverseerRestoreParams);
  }

  // The bare facet stub behind getGatekeeperFacet(): a request made on it leaves the facet unable
  // to call its own ctx.restore().
  #getGatekeeperFacetRaw(id: number, cls?: GatekeeperClass): Fetcher<Gatekeeper<any>> {
    return this.ctx.facets.get(`gatekeeper${id}`, async () => {
      let resolved = cls ?? this.storage.gatekeepers.get(id)?.class;
      if (!resolved) {
        throw new Error("no such gatekeeper?");
      }
      return {class: resolved};
    });
  }

  /** Traces an approval step for an action an agent turn submitted. */
  traceAgentActionApproval(record: ActionRecord, state: "requested" | "approved" | "denied") {
    if (record.caller.from !== "agent") return;
    let chatId = record.caller.chatId;
    traceToolApproval(this.getChatAgentContext(chatId), this.ctx.id.toString(), chatId,
        gatekeeperVendorId(this.storage.gatekeepers.get(record.gatekeeperId)), state);
  }

  /**
   * Destroy a gatekeeper (connection) workpiece. Any binding edges pointing at it are severed so
   * no gadget's or agent spawner's env retains a dangling entry. (This is distinct from merely
   * unbinding it from one gadget -- GadgetClient.unbind() -- which leaves the gatekeeper alive,
   * possibly orphaned.)
   */
  removeGatekeeper(id: number) {
    // An agent spawner is proposed by the chats with edges pending on it.
    let affectedChats = this.chatsProposing(id);
    for (let chatId of this.deleteBindingEdges(edge => edge.target === id)) {
      affectedChats.add(chatId);
    }

    // Pushes still queued against this gatekeeper can never apply once it is gone; clean up
    // their pending-push marks like a rejection would. (The action records themselves remain,
    // as the audit log; onRemote/pullableFrom metadata also remains -- a wrong entry only makes
    // a future pull fail with its "reconnect" error.)
    for (let action of Array.from(this.storage.actions.pendingByGatekeeper.get(id))) {
      if (action.type === "action" && action.description.pushedCommits?.length) {
        this.gitCache.clearPushMarks(action.id);
      }
    }

    // Hooks bound through this connection die with it, synchronously: deleting the record is the
    // authoritative kill (startHook re-checks it before every delivery, and the capabilities a
    // firing already received revalidate it per call -- see requireLiveHook), so delivery stops
    // even if the gatekeeper-side disable below never lands. That disable is best-effort and
    // deliberately not awaited -- parking the teardown behind a gatekeeper round trip would keep
    // the connection's data flowing into the gadget for as long as that call took (or forever, if
    // it hangs), with the record gone and nobody verified against it.
    for (let hook of Array.from(this.storage.boundHooks.list())) {
      if (hook.gatekeeperId !== id) continue;
      this.storage.boundHooks.delete(hook.id);
      stampBindHookAction(this.storage, hook.actionId, false, {clearHookId: true});
      if (hook.enabled) {
        this.ctx.waitUntil(hook.controller.disable().catch(error => {
          this.logger.warn("failed to disable hook for a removed connection", {
            event: "gatekeeper.hook.disable.failed", gatekeeperId: id, hookId: hook.id, error,
          });
        }));
      }
    }

    this.ctx.facets.delete(`gatekeeper${id}`);
    this.storage.gatekeepers.delete(id);
    this.rebroadcastChatMeta(affectedChats);
  }

  protected async prepareWorkspaceAttachmentFiles(
      chatId: number, attachments: ChatAttachmentRef[] | undefined): Promise<Map<string, FileContent>> {
    if (!attachments?.length) return new Map();
    let used = new Set<string>();
    // Names live in chat-scoped message metadata, not the workspace-wide payload collection.
    for (const message of this.storage.chats.list({prefix: chatKeyPrefix(chatId)})) {
      if (message.type !== "message") continue;
      for (const attachment of message.attachments ?? []) {
        if (attachment.workspacePath !== undefined) used.add(attachment.workspacePath);
      }
    }

    const worktree = this.scratchWorktree(chatId);
    if (worktree) {
      // Uploads use root filenames. Reserve base and overlay root names (including directories)
      // without loading file contents, so an upload cannot overwrite agent-created work.
      for (const entry of await this.gitCache.walker.listCommitTreePaths(worktree.pinBase)) used.add(entry.path);
      const content = await this.getCurrentChatContent(chatId, this.getChatMetaOrThrow(chatId));
      for (const path of content.get(worktree.id)?.keys() ?? []) used.add(path.split("/")[0]);
    }

    let files = new Map<string, FileContent>();
    for (let attachment of attachments) {
      const data = attachment.oid !== undefined
        ? this.gitStore.readBlob(attachment.oid)
        : this.storage.chatAttachmentContent.get(attachment.id)?.data;
      if (data === undefined) throw new Error("Chat attachment is no longer available.");
      let path = this.attachmentWorkspaceFilename(attachment, used);
      // Keep text OTs where they fit, including a preserved UTF-8 BOM. A supported upload
      // can exceed the OT record budget; use the same immutable byte ingress as binary files
      // rather than accepting it on the first message but rejecting it on later messages.
      const text = decodeChatAttachmentText(attachment.mimeType, data);
      const value: FileContent = text !== undefined && (worktree === undefined ||
          codeChangeSerializedSize({[worktree.id]: [[path, {set: text}]]}) <= MAX_CODE_CHANGE_SIZE) ? text
          : attachment.oid !== undefined ? {oid: attachment.oid, byteLength: data.byteLength}
          : await this.gitStore.writeBlob(data);
      attachment.workspacePath = path;
      files.set(path, value);
    }
    return files;
  }

  /**
   * Whether `id` is NOT blocked pending a scheduled restart (see #gatekeepersPendingRestart).
   * For callers that enumerate connections (listSlashCommands, prepareChatBindings' ambient
   * catalogs) and silently skip a blocked one -- it reappears once the reset lands and clients
   * reconnect. A caller reaching for one specific connection throws via assertGatekeeperUsable
   * instead.
   */
  gatekeeperUsable(id: number): boolean {
    return !this.gatekeepersPendingRestart.has(id);
  }

  /**
   * Throw (retryable) if `id` is blocked pending the scheduled restart; see
   * #gatekeepersPendingRestart. Called from getGatekeeperById (the mint clients pipeline on),
   * openGatekeeperSession (the chokepoint every gatekeeper session passes through), the
   * slash-command invoke in #prepareChatMessage, GadgetClientImpl.bindWithSuggestedName (the
   * latter two take a client-supplied gatekeeper id and reach the connection outside
   * openGatekeeperSession), and startHook (the inbound delivery route, whose arming enable may
   * itself be the widening that scheduled the restart).
   */
  assertGatekeeperUsable(id: number): void {
    if (!this.gatekeeperUsable(id)) {
      throw new Error(
          "The workspace is restarting to apply a connection change. Please retry.");
    }
  }

  /**
   * Invoke slash-command requests before committing their visible event and optional generated
   * message. A result without a message suppresses only the generated message, not the invocation.
   */
  protected async prepareChatMessage(
      message: string | SlashCommandRequest,
      hasAttachments: boolean): Promise<PreparedChatMessage> {
    if (typeof message !== "string") {
      // A built-in command is handled by the Workshop, not a Gatekeeper: there is nothing to invoke
      // here. Committing the event is what makes the turn a compaction turn (see isCompactionTurn).
      // The name is typed but arrives over RPC, and one we don't implement would commit an event and
      // then start a turn with no prompt for the model to answer, so reject it here.
      if (message.id.builtin === true) {
        if (message.id.commandId !== "compact") throw new Error("Unknown built-in slash command.");
        return {slashCommand: message};
      }
      // Held separately because reassigning `message` below widens `id` back to the union.
      let {gatekeeperId} = message.id;
      let record = this.storage.gatekeepers.get(gatekeeperId);
      if (!record?.hasSlashCommands) throw new Error("Slash command provider is not available.");
      // The id is client-supplied, so a connection blocked pending a scope-widening restart must
      // be refused here: the invoke below reads the connection AND mints an observation, both on
      // behalf of a session the reset is about to sever.
      let facet = await this.getGatekeeperFacet(gatekeeperId);
      this.assertGatekeeperUsable(gatekeeperId);
      // Display-only, and from the browser, so a bad value is dropped rather than refused.
      message = {...message, commandPosition: sanitizeCommandPosition(message)};
      using authorizer = new NativeRpcStub<ObservationAuthorizer>(
          new SlashCommandAuthorizerImpl(this.self(), gatekeeperId, {from: "user"}));
      let result = await invokeSlashCommand(facet, message, authorizer);
      if (result.message === undefined) {
        return {slashCommand: message, skillName: result.skillName};
      }
      if (!result.message.trim() && !hasAttachments) {
        throw new Error("Slash command returned an empty message.");
      }
      return {slashCommand: message, message: result.message, skillName: result.skillName};
    }
    if (!message.trim() && !hasAttachments) {
      throw new Error("Cannot send an empty chat message.");
    }
    return {message};
  }

  /**
   * Describe a workpiece -- a gadget or a gatekeeper -- reachable as `envName` in chat `chatId`'s
   * env, for the agent's describeBinding tool.
   */
  async describeBinding(envName: string, id: WorkpieceId, chatId: number): Promise<string> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget?.type === "worktree") {
      return `Binding: ${envName}\n` +
          `\n` +
          `This binding is a worktree titled ${JSON.stringify(gadget.title)}: a file tree ` +
          `rooted at git commit ${gadget.baseCommit}, private to this chat. Read and edit its ` +
          `files with the regular file tools (readFile, writeFile, editFile), passing ` +
          `${JSON.stringify(envName)} as the \`workpiece\` parameter. In executeCode, ` +
          `env.${envName} implements the \`Worktree\` interface as defined below:\n` +
          `\n` +
          `\`\`\`\n` +
          `${agentApiText(WORKTREE_BINDING_TYPES)}` +
          `\`\`\`\n`;
    }
    if (gadget) {
      return `Binding: ${envName}\n` +
          `\n` +
          `This binding gives access to the Gadget ${JSON.stringify(gadget.title)}. It has two ` +
          `properties:\n` +
          `\n` +
          `* \`${envName}.rpc\` is an RPC stub that points at the main Durable Object instance ` +
          `of the Gadget. Calling a method on the stub invokes the same-named method on the ` +
          `class exported by the Gadget's server.js (read that file to learn the API it offers).\n` +
          `* \`${envName}.exports\` exports the Gadget as a file. It implements the ` +
          `\`GadgetExports\` interface as defined below:\n` +
          `\n` +
          `\`\`\`\n` +
          `${agentApiText(EXPORTS_BINDING_TYPES)}` +
          `\`\`\`\n`;
    }
    let gatekeeper = this.storage.gatekeepers.get(id);
    if (!gatekeeper) {
      throw new Error(`The resource behind ${envName} no longer exists.`);
    }
    return this.describeGatekeeper(envName, gatekeeper, chatId);
  }

  async describeGatekeeper(name: string, gatekeeper: GatekeeperRecord, chatId: number)
      : Promise<string> {
    let facet = await this.getGatekeeperFacet(gatekeeper.id);

    let desc = await facet.describe();
    let types = await facet.getTypeScriptTypes();

    return `Binding: ${name}\n` +
        `Title: ${desc.title}\n` +
        `TypeScript type: ${desc.tsType}\n` +
        (desc.hookTsType
            ? `Hook TypeScript type: ${desc.hookTsType}\n` +
              `Hook entrypoint: ${gatekeeper.hook || "(not connected)"}\n`
            : "") +
        `\n` +
        `The binding comes with the following bundle of TypeScript type definitions:\n` +
        `\`\`\`\n` +
        `${types}\n` +
        `\`\`\`\n` +
        this.#describeSpawnerBindings(gatekeeper, chatId);
  }

  // An agent spawner's bindings visible to the chat, for describeGatekeeper(); "" for any other
  // gatekeeper.
  #describeSpawnerBindings(gatekeeper: GatekeeperRecord, chatId: number): string {
    let {bindings} = gatekeeper;
    if (!bindings) return "";
    let lines = this.visibleBindings({bindings}, chatId).map(([name, edge]) => {
      let title = this.storage.gadgets.get(edge.target)?.title ??
          this.storage.gatekeepers.get(edge.target)?.resourceTitle;
      return `* ${name}: ${title === undefined ? "(title unavailable)" : JSON.stringify(title)}` +
          (edge.pending ? " (proposed in this chat: spawned agents get it once the user " +
                          "accepts this chat's changes)" : "");
    });
    return `\n` +
        `Each agent this spawner starts gets the following bindings in its env.\n` +
        `\n` +
        `${lines.join("\n") || "(none)"}\n`;
  }

  async listSlashCommands(): Promise<SlashCommandChoice[]> {
    // A connection blocked pending a scope-widening restart is silently omitted (its commands
    // reappear once the reset lands and clients reconnect) rather than failing the whole listing,
    // as is one removed before its facet is reached.
    let sources = (await Promise.all([...this.storage.gatekeepers.list()]
      .filter(record => record.hasSlashCommands && this.gatekeeperUsable(record.id))
      .map(record => this.getGatekeeperFacet(record.id).then(gatekeeper => ({
        gatekeeperId: record.id,
        providerLabel: record.resourceTitle || `Gatekeeper ${record.id}`,
        gatekeeper,
      }), () => null)))).filter(source => source !== null);
    return [{
      selection: {builtin: true, commandId: "compact"},
      name: "compact",
      description: "Summarize older context while preserving recent messages.",
      providerLabel: resolveSiteName((await readAdminConfig(this.env)).siteName),
    }, ...await collectSlashCommands(sources)];
  }

  // =======================================================================================
  // Blueprint helpers
  // =======================================================================================

  #codeIdMap = new Map<string, WorkerLoaderWorkerCode>;

  /**
   * Forge a persistent stub that restores through the gadget's [restore](params) method. The
   * executeCode harness routes `env.<bindingName>.rpc[restore](params)` here (via RestoreForgerImpl);
   * `bindings` is that execution's own binding map, so the name conveys exactly the env the
   * executed code already holds.
   */
  async forgeRestoreStubForBinding(
      chatId: number, bindings: Record<string, ChatBindingEntry>,
      bindingName: string, params: unknown): Promise<unknown> {
    let entry = bindings[bindingName];
    if (!entry) {
      throw new Error(`No such binding: ${bindingName}`);
    }
    if (entry.type !== "workpiece" ||
        this.storage.gadgets.get(entry.id)?.type !== "gadget") {
      throw new Error(
          `[restore] is only available on Gadget bindings; "${bindingName}" is not a Gadget.`);
    }
    let gadgetId = entry.id;

    // Wacky hack: Load the one-off "forger" worker through `ctx.restore()`, so that it gets
    // imbued with a self-token encoding its restore params as `{ type: "gadget", gadgetId,
    // codeId }`. However, as soon as we remove `codeId` from the table, these params will
    // redirect to point at the gadget instead. Hence, ctx.restore() inside the forger worker
    // actually creates RpcStubs that point at the gadget's `[restore]()` method. Whoa!
    let codeId = crypto.randomUUID();
    let forger: Fetcher<RestoreForgerEntrypoint>;
    try {
      this.#codeIdMap.set(codeId, RESTORE_FORGER_WORKER);
      forger = await this.ctx.restore({type: "gadget", gadgetId, codeId});
    } finally {
      this.#codeIdMap.delete(codeId);
    }

    let stub = await forger.forge(params);

    let targets = this.forgedRestoreTargets.get(chatId);
    if (!targets) {
      targets = new Set();
      this.forgedRestoreTargets.set(chatId, targets);
    }
    targets.add(gadgetId);

    return stub;
  }

  restore(params: OverseerRestoreParams)
      : Fetcher<DurableObject> | Fetcher<RestoreForgerEntrypoint> | Fetcher<Gatekeeper<any>> {
    switch (params.type) {
      case "gadget": {
        if (params.codeId) {
          // The forger worker being loaded through ctx.restore() by forgeRestoreStubForBinding().
          let code = this.#codeIdMap.get(params.codeId);
          if (code) {
            return this.env.LOADER.load(code).getEntrypoint<RestoreForgerEntrypoint>();
          }
        }

        // Old params (persisted before multi-gadget support, sealed inside hook callbacks) have
        // no gadgetId; they resolve to the default gadget. If that gadget was deleted (or there
        // is no default), this fails with an explicit error rather than silently retargeting.
        let gadgetId = this.resolveGadgetId(params.gadgetId);
        this.getGadgetRecord(gadgetId);  // validate it exists
        return this.#getGadgetFacetRaw(
            gadgetId, this.#resolveGadgetChatId(gadgetId, params.chatId));
      }

      case "gatekeeper":
        // Existence only: whether the connection may be used is still decided where it is used
        // (assertGatekeeperUsable, startHook).
        if (!this.storage.gatekeepers.get(params.gatekeeperId)) {
          throw new Error("This connection has been removed from the workspace.");
        }
        return this.#getGatekeeperFacetRaw(params.gatekeeperId);

      default:
        throw new TypeError("Unknown restore params: " + JSON.stringify(params));
    }
  }

  // =======================================================================================
  // Declared bots: the chat snapshot and workspace-scoped skill resolution
  // (see src/bot-config.ts; the bots' runtime -- subagents and DMs -- is overseer-bots.ts)
  // =======================================================================================

  /**
   * The snapshot a bot chat carries (newChat, a mid-chat switch, and every bot child chat):
   * the frozen declaration as botConfig, this workspace's skill resolution, and the composed
   * prompt section. One await (the skill resolution); callers persist it in their own storage
   * transaction so the snapshot lands atomically with what references it.
   */
  protected async snapshotBotForChat(bot: NonNullable<UserChatContext["bot"]>): Promise<{
      botConfig: NonNullable<AiChatAgentContext["botConfig"]>;
      botSkills: ResolvedBotSkill[];
      unavailableBotSkills: UnavailableBotSkill[];
      botSection: string;
  }> {
    let {resolved, unavailable} = await this.#resolveBotSkills(bot.skills);
    return {
      botConfig: {
        selection: bot.selection,
        name: bot.name,
        ...(bot.description !== undefined ? {description: bot.description} : {}),
        instructions: bot.instructions,
        modelId: bot.modelId,
        skills: bot.skills,
      },
      botSkills: resolved,
      unavailableBotSkills: unavailable,
      botSection: formatBotSection(bot, resolved, unavailable),
    };
  }

  // Resolve a bot's declared skills against this workspace's usable connections: a ref matches
  // a {vendorId, commandId} pair some usable gatekeeper offers (see listSlashCommands for the
  // same usability rules). Resolution is workspace-scoped -- a collaborator's bot may declare a
  // skill the workspace cannot resolve, which is recorded, not silent; invoking a workspace
  // skill grants no authority any chat there lacks. Two same-vendor records offering the same
  // commandId are ambiguous and resolve to nothing, never first-match.
  async #resolveBotSkills(skills: {vendorId: string; commandId: string; name: string}[]): Promise<
      {resolved: ResolvedBotSkill[]; unavailable: UnavailableBotSkill[]}> {
    let resolved: ResolvedBotSkill[] = [];
    let unavailable: UnavailableBotSkill[] = [];
    let providers: {vendorId: string; gatekeeperId: number;
        commands: {id: string; name: string; description: string}[]}[] = [];
    for (let record of this.storage.gatekeepers.list()) {
      if (!record.hasSlashCommands || !this.gatekeeperUsable(record.id)) continue;
      let vendorId = gatekeeperVendorId(record);
      if (!vendorId) continue;
      try {
        let facet = await this.getGatekeeperFacet(record.id) as Fetcher<Gatekeeper<any> &
            Required<Pick<Gatekeeper<any>, "getSlashCommandProvider">>>;
        using provider = await facet.getSlashCommandProvider();
        providers.push({vendorId, gatekeeperId: record.id, commands: await provider.list()});
      } catch {
        // A connection that cannot be driven from here offers nothing; skip it.
      }
    }
    for (let skill of skills) {
      let matches = providers.flatMap(provider => provider.vendorId !== skill.vendorId ? [] :
          provider.commands
              .filter(command => command.id === skill.commandId)
              .map(command => ({provider, command})));
      if (matches.length === 1) {
        let {provider, command} = matches[0]!;
        resolved.push({
          gatekeeperId: provider.gatekeeperId,
          commandId: command.id,
          title: command.name,
          description: command.description,
        });
      } else {
        if (matches.length > 1) {
          this.logger.warn("bot skill is ambiguous across connections", {
            event: "bot.skill.ambiguous", vendorId: skill.vendorId, commandId: skill.commandId,
          });
        }
        unavailable.push({vendorId: skill.vendorId, commandId: skill.commandId, name: skill.name});
      }
    }
    return {resolved, unavailable};
  }
}
