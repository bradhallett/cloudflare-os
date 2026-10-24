import { RpcStub, RpcTarget } from "capnweb";
import { UiBundle, WorkpieceId, ChatGadgetPinRecord, MainlineMergeGadget, ChatGadgetPinState, AiChatAuthorInfo, ConsoleLogSubscriber, ConsoleLogEvent, AffectedCollaborator, BlueprintBinding, AGENT_SPAWNER_CONNECTION_ID } from "@gadgets/workshop-shared/api";
import { requireTextFiles } from "@gadgets/workshop-shared/code-change";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { GadgetRecord } from "./storage-schema/overseer-storage";
import { commitIdentityForAuthor, filesEqual, threeWayMerge } from "./git-store";
import type { MergeResult } from "./git-store";
import { FormatOffer, listFormatOffers, readAdminConfig } from "./admin-config";
import { listFeaturedBlueprintsFromKv } from "./storage-schema/blueprints-kv";
import { orgBlueprintsForMember } from "./blueprint-access";
import { SharingManager } from "./sharing";
import type { GadgetExportFormat } from "@gadgets/workshop-shared/api";
import { renderGadgetInBrowser } from "./browser-export";
import { defaultExportFormats, exportServerFormat, GADGET_EXPORT_ENTRYPOINT, readCustomExportFormats } from "./gadget-export";
import type { GadgetExportEntrypoint } from "./gadget-export";
import { OverseerChanges } from "./overseer-changes";
import type { SessionKind } from "./overseer-support";
import { LISTING_REFRESH_BATCH } from "./overseer-support";
import { describeBindingKind } from "./overseer-binding-info";

/**
 * OverseerMainline: mainline updates, gadget facets and exports, blueprint/format listings, tail delivery, sharing, and owner profile.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerMainline extends OverseerChanges {
  /**
   * The body of Overseer.updateChatFromMainline(), running under the chat's operation lock
   * (callers hold withChatLock).
   */
  async updateChatFromMainline(chatId: number, author: AiChatAuthorInfo)
      : Promise<{conflictPaths: string[]}> {
    let meta = this.assertChatNotActive(chatId);

    // Live change rows are part of the chat's current content, so materialize them first: the merge
    // must take them as input, and its own message must be recorded after them.
    let materialized = this.materializeChatChanges(chatId, meta);
    if (materialized) meta = materialized.meta;

    // Everything read from here through the merge computation must still describe the chat when
    // the results are written back below; the sequence peek and stream position are the
    // revalidation tokens (a submission landing during the awaits appends a row without
    // appending a message, so both are needed).
    let sequenceToken = this.nextChatSequencePeek(chatId);
    let codeBase = this.chatCodeBase(meta);
    let generationToken = codeBase.generation;
    let revisionToken = codeBase.revision;

    // Only *pinned* gadgets can be stale: an unpinned gadget was never modified in this chat,
    // so it tracks mainline head live and there is nothing to merge into. (Every permanent
    // gadget has a head -- an empty tree before it has code (see GadgetRecord.commitId) -- so
    // "modified in this chat" always means "pinned", possibly at that empty tree.) Pins whose
    // gadget has been deleted are skipped -- there is no head to merge. Heads that advance
    // *during* the merge below are fine without revalidation: each pin is advanced only to the
    // commit actually merged, so the chat simply comes out still stale.
    let stale: {record: GadgetRecord, pin: ChatGadgetPinState}[] = [];
    for (let pin of codeBase.pins) {
      let record = this.storage.gadgets.get(pin.gadgetId);
      // Worktree pins are never stale: a worktree has no mainline head to merge from.
      if (record?.type === "gadget" && record.commitId !== undefined &&
          record.commitId !== pin.mergedCommit) {
        stale.push({record, pin});
      }
    }
    if (stale.length === 0) {
      return {conflictPaths: []};
    }

    // Merge each stale gadget: the mainline commit the chat last merged (the pin's
    // `mergedCommit`) is the base -- explicitly known, so no merge-base discovery -- the head is
    // one side and the chat's files the other. Conflicting hunks keep inline diff3 markers for
    // the user (or their agent) to clean up. Every merge is computed before anything is written.
    let content = await this.getCurrentChatContent(chatId, meta);
    let merges: {pin: ChatGadgetPinState, head: string, bindingName: string,
                 chatFiles: Map<string, string>, mainlineFiles: Map<string, string>,
                 result: MergeResult}[] = [];
    for (let {record, pin} of stale) {
      let base = await this.gitStore.readCommitFiles(pin.mergedCommit);
      let mainlineFiles = await this.gitStore.readCommitFiles(record.commitId!);
      let chatFiles = requireTextFiles(content.get(pin.gadgetId) ?? new Map());
      let result = threeWayMerge(base, mainlineFiles, chatFiles,
          {base: "merged base", ours: "mainline", theirs: "this chat"});
      merges.push({pin, head: record.commitId!, bindingName: record.bindingName, chatFiles,
                   mainlineFiles, result});
    }

    // Commit each merge (see MainlineMergeGadget): `S`, the chat's files before the update, on
    // the commit the chat's changes were made on (the pin's base), and `M = [H, S]`, the result,
    // with mainline first since it is the gadget's own history. The pin re-roots at `M` and
    // records `H` as merged. A chat whose files are already in mainline's history had nothing
    // of its own to merge, so it re-roots at `H` itself. These are content-addressed object
    // writes, harmless if the revalidation below refuses; a discarded chat leaves them dangling.
    let identity = commitIdentityForAuthor(author);
    let declarations: ChatGadgetPinRecord[] = [];
    let gadgets: MainlineMergeGadget[] = [];
    let conflictPaths: string[] = [];
    for (let {pin, head, bindingName, chatFiles, mainlineFiles, result} of merges) {
      let chatCommit = filesEqual(chatFiles, await this.gitStore.readCommitFiles(pin.baseCommit))
          ? pin.baseCommit
          : await this.gitStore.writeFilesAsCommit(chatFiles, {
              parents: [pin.baseCommit],
              author: identity,
              message: `Chat before update: ${meta.title}`,
              timestamp: new Date(),
            });
      let mergeCommit = this.gitCache.isAncestor(chatCommit, head) &&
              filesEqual(result.files, mainlineFiles)
          ? head
          : await this.gitStore.writeFilesAsCommit(result.files, {
              parents: [head, chatCommit],
              author: identity,
              message: `Merge latest changes into chat: ${meta.title}`,
              timestamp: new Date(),
            });
      declarations.push({gadgetId: pin.gadgetId, baseCommit: mergeCommit,
                         ...(mergeCommit !== head ? {mergedCommit: head} : {})});
      gadgets.push({gadgetId: pin.gadgetId, baseCommit: pin.mergedCommit, chatCommit,
                    conflictPaths: result.conflictPaths});
      conflictPaths.push(...result.conflictPaths.map(path => `${bindingName}/${path}`));
    }
    conflictPaths.sort();

    // The awaits above are interleaving points. The chat lock excludes sibling mutations, but
    // an agent turn could have started, and new messages or rows could have been recorded;
    // re-read the chat state and refuse rather than record a merge computed against stale
    // content. (Chat deletion is caught by the meta re-read throwing.)
    let freshMeta = this.assertChatNotActive(chatId);
    let freshCodeBase = this.chatCodeBase(freshMeta);
    if (this.nextChatSequencePeek(chatId) !== sequenceToken ||
        freshCodeBase.generation !== generationToken ||
        freshCodeBase.revision !== revisionToken) {
      throw new Error("The chat changed while merging from mainline; please retry.");
    }

    // One synchronous step, in this order: the message that declares the re-roots, then the
    // pins it declares, the end of the change stream and a destructive generation bump, as a
    // revert does. A client rebuilds from the log on seeing the new generation, so the message
    // has to be in the log by then. Every live row was materialized above, and the revision
    // token rules out any since, so deleting the rows loses nothing the server accepted; a
    // collaborator's keystrokes not yet acknowledged are dropped, as a revert drops them.
    this.materializeChatChanges(chatId, freshMeta, {
      author, pins: declarations, mainlineMerge: {conflictPaths, gadgets},
    });
    let updatedMeta = this.getChatMetaOrThrow(chatId);
    let updatedCodeBase = this.chatCodeBase(updatedMeta);
    updatedCodeBase.pins = updatedCodeBase.pins.map(pin => {
      let declaration = declarations.find(decl => decl.gadgetId === pin.gadgetId);
      return declaration === undefined ? pin : {
        gadgetId: pin.gadgetId,
        baseCommit: declaration.baseCommit,
        mergedCommit: declaration.mergedCommit ?? declaration.baseCommit,
      };
    });
    this.deleteAllChatChanges(chatId);
    updatedCodeBase.generation += 1;
    updatedCodeBase.revision = 0;
    delete updatedCodeBase.prior;
    updatedMeta.codeBase = updatedCodeBase;
    updatedMeta.lastActive = this.getChatTimestamp();
    this.storage.chatMeta.put(updatedMeta);
    this.proposedChangesChanged(chatId);

    return {conflictPaths};
  }

  /**
   * Get an RpcStub for the gadget facet, which can be returned to the client.
   *
   * `joinAs` counts the returned stub toward #hasCollaboratorSession for its own lifetime, like
   * every other capability minted into a collaborator's session (see GadgetClientImpl): the facet
   * is a live channel into the gadget's state -- including whatever an enabled hook writes into
   * it -- and a stub that escaped the count would let a scope widening find no session to sever
   * while the retained stub kept reading. Passed by the collaborator-facing connectToGadget
   * mints; omitted for the owner's and for internal callers (binding loopbacks already live
   * inside a counted session).
   *
   * Since facet stubs currently can't be sent over RPC, the stub is wrapped in a Proxy to make it
   * look like an RpcTarget instead.
   */
  async getGadgetFacet(gadgetId: WorkpieceId, chatId?: number, joinAs?: SessionKind)
      : Promise<RpcStub<any>> {
    let facet = await this.getGadgetFacetFetcher(gadgetId, chatId);
    let leaveSession = joinAs ? this.joinSession(joinAs) : undefined;

    let self = this;

    // TODO: Make possible to return facet stub over RPC. This Proxy is a hack.
    let proxy = new Proxy(facet, {
      get(target, prop, receiver) {
        // The lease ends when the client disposes the stub. (The DO reset that severs sessions
        // releases it implicitly, by discarding this object -- and joinSession's leave is
        // idempotent, so a double dispose is harmless.)
        if (prop === Symbol.dispose && leaveSession) {
          let inner = Reflect.get(target, prop, target);
          return () => {
            leaveSession!();
            if (typeof inner === "function") Reflect.apply(inner, target, []);
          };
        }

        // Note: We need `target` to be used as the receiver. If we use `receiver` as the receiver,
        //   we'll get an illegal invocation, as `receiver` points to our Proxy.
        let method = Reflect.get(target, prop, target);

        // Note that all wildcart properties of a stub appear as functions. So this check only
        // really catches when `get()` returns `undefined`, as it does e.g. for the property
        // named "then". Also if the prop is a symbol then it's definitely not an RPC so we handle
        // that here.
        if (typeof method !== "function" || typeof prop === "symbol") return method;

        // HACK: We're going to assume all top-level properties are methods, and we are going to
        //   intercept exceptions thrown by these methods and deliver them to the console log
        //   subscriber. In theory we shouldn't have to do this, because these exceptions should
        //   be reported to the tail worker. However, for some reason, that isn't working --
        //   possibly a runtime bug which needs investigation.
        // TODO: Fix exception reporting it tail workers so we can remove this hack.
        return (...args: any[]) => {
          let result: Promise<any> = Reflect.apply(method, target, args);
          return result.catch((err: any) => {
            let msg = err;
            if (err instanceof Error) {
              // Sadly the caught errors are missing any useful stack at the moment. Perhaps if
              // we at least specify the method that was called it's somewhat useful to the agent.
              msg = `${err}\n    at ${prop}()`;
            }

            let event: ConsoleLogEvent = {
              timestamp: new Date(),
              level: "error",
              message: [msg],
            };
            self.deliverGadgetLogs(chatId ?? null, [event]);
            throw err;
          });
        }
      },
      getPrototypeOf(target) {
        return RpcTarget.prototype;
      },
    });

    // Explicitly construct an RpcStub around the proxy to work around a workerd bug where
    // returning an RpcTarget proxy as the top-level return value from an RPC isn't detected
    // correctly.
    // @ts-expect-error NativeRpcStub still has infinite recursion problems, fixed in Cap'n Web.
    return new NativeRpcStub(proxy) as RpcStub<any>;
  }

  async getGadgetUiBundle(gadgetId: WorkpieceId, chatId?: number): Promise<UiBundle | null> {
    // TODO: Bundle the UI? For now we just return client.js.
    this.checkChatExistsAndMaterializeChanges(chatId);
    let jsCode = (await this.readGadgetFiles(gadgetId, chatId)).get("client.js");
    return jsCode !== undefined ? {jsCode} : null;
  }

  async getGadgetExportFormats(gadgetId: WorkpieceId, chatId?: number)
      : Promise<GadgetExportFormat[]> {
    this.checkChatExistsAndMaterializeChanges(chatId);
    let resolved = await this.#resolveGadgetExportFormats(gadgetId, chatId);
    resolved.gadget?.[Symbol.dispose]();
    return resolved.formats;
  }

  async exportGadget(gadgetId: WorkpieceId, formatId: string, chatId?: number)
      : Promise<ReadableStream<Uint8Array>> {
    this.checkChatExistsAndMaterializeChanges(chatId);
    let {formats, handler, gadget} = await this.#resolveGadgetExportFormats(gadgetId, chatId);
    if (!gadget) throw new Error("The Gadget server stub is unavailable.");
    using exportGadget = gadget;
    let format = formats.find(candidate => candidate.id === formatId);
    if (!format) throw new Error(`This Gadget does not support export format: ${formatId}`);

    if (format.mode === "server") {
      if (!handler) throw new Error("The Gadget export handler is unavailable.");
      return await exportServerFormat(() =>
        handler.export(exportGadget, format.id));
    } else {
      let browser = this.env.BROWSER;
      if (!browser) throw new Error("Gadget export is not configured for this deployment.");
      let bundle = await this.getGadgetUiBundle(gadgetId, chatId);
      if (!bundle) throw new Error("This Gadget does not have a UI to export.");
      let title = this.getGadgetRecord(gadgetId).title;
      return renderGadgetInBrowser(browser, bundle.jsCode, title, exportGadget.dup(), format);
    }
  }

  checkChatExistsAndMaterializeChanges(chatId?: number): void {
    if (chatId !== undefined) {
      let meta = this.getChatMetaOrThrow(chatId);
      if (!meta.activeAgent) this.materializeChatChanges(chatId, meta);
    }
  }

  async #resolveGadgetExportFormats(gadgetId: WorkpieceId, chatId?: number): Promise<{
    formats: GadgetExportFormat[];
    handler: Fetcher<GadgetExportEntrypoint> | null;
    gadget: NativeRpcStub<any> | null;
  }> {
    let files = await this.readGadgetFiles(gadgetId, chatId);
    if (!files.has("server.js")) return {formats: [], handler: null, gadget: null};

    let handler = this.loadGadgetWorker(gadgetId, chatId)
      .getEntrypoint<GadgetExportEntrypoint>(GADGET_EXPORT_ENTRYPOINT);
    // getGadgetFacet() wraps this native stub for Cap'n Web's type system, but this path invokes
    // native Worker RPC and needs its actual runtime type.
    let gadget = await this.getGadgetFacet(gadgetId, chatId) as unknown as NativeRpcStub<any>;
    try {
      let formats = await readCustomExportFormats(handler, gadget);
      return formats === null
        ? {
          formats: files.has("client.js") ? defaultExportFormats() : [],
          handler: null,
          gadget,
        }
        : {formats, handler, gadget};
    } catch (error) {
      gadget[Symbol.dispose]();
      throw error;
    }
  }

  async getInstanceInstructions(): Promise<string> {
    try {
      // Cheap single KV get from the mirror AdminSettings maintains; avoids the singleton DO.
      return (await readAdminConfig(this.env)).instanceInstructions;
    } catch (err) {
      this.logger.warn("failed to read instance instructions", {
        event: "instance.instructions.read.failed", error: err,
      });
      return "";
    }
  }

  getPromptCacheSalt(): string {
    let salt = this.storage.promptCacheSalt.get();
    if (salt === undefined) {
      salt = crypto.randomUUID();
      this.storage.promptCacheSalt.put(salt);
    }
    return salt;
  }

  async listConnectableVendors(): Promise<{id: string, displayName: string}[]> {
    try {
      let vendors = await this.listGatekeeperVendorsCached();
      return vendors.map(v => ({id: v.id, displayName: v.description.displayName}));
    } catch (err) {
      this.logger.warn("failed to list connectable vendors", {
        event: "connectable.vendors.list.failed", error: err,
      });
      return [];
    }
  }

  async listConnectableResources(vendorId: string): Promise<string> {
    if (vendorId === AGENT_SPAWNER_CONNECTION_ID) {
      return `"${vendorId}" is an agent spawner, which offers no resources: request one with ` +
          `requestConnection, passing vendorId="${vendorId}" and no resourceUrl.`;
    }
    let vendors = await this.listGatekeeperVendorsCached();
    let vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) {
      return `Unknown vendor "${vendorId}". Available vendors: ` +
          `${[...vendors.map(v => v.id), AGENT_SPAWNER_CONNECTION_ID].join(", ")}.`;
    }
    if (vendor.supportedResources.length === 0) {
      return `Vendor "${vendorId}" (${vendor.description.displayName}) offers no connectable ` +
          `resources.`;
    }
    let lines = [`Resource types offered by "${vendorId}" (${vendor.description.displayName}):`];
    for (let r of vendor.supportedResources) {
      lines.push(`* ${r.title} — urlPattern: ${r.urlPattern}` +
          `${r.creatable ? " (creatable with createExternalResource)" : ""}\n  ${r.description}`);
    }
    lines.push(
        `\nTo request one, call requestConnection with vendorId="${vendorId}" and a resourceUrl ` +
        `matching one of the patterns above (or omit resourceUrl to let the user pick).`);
    return lines.join("\n");
  }

  /**
   * List the blueprints the turn's initiator could instantiate with createGadget: their own
   * published blueprints, the ones their organizations own, their blueprint library, and the
   * deployment's featured set. Blueprint libraries are per-user, so this lists the initiator's --
   * a collaborator driving the agent gets their own library, not the workspace owner's. There is
   * no search index; these corpora are small, so the formatted text is handed to the model to
   * scan directly.
   */
  async listAvailableBlueprints(initiator: AiChatAuthorInfo): Promise<string> {
    // User DOs are named by user identifier, and `initiator.id` is one: the initiating user for
    // "user" turns, the spawning gadget's owner for "gadget" turns (see AiChatAuthorInfo) -- the
    // same resolution executeCodeMode uses for its self-loopback props.
    let userStub = this.users.get(this.users.idFromName(initiator.id));
    let orgIds = (await userStub.listOrgMemberships()).map(entry => entry.orgId);
    let [own, orgs, library, featured, formats] = await Promise.all([
      userStub.listBlueprints(),
      orgBlueprintsForMember(this.env, this.ctx.exports.OrgDurableObject, orgIds, initiator.id),
      userStub.listLibraryBlueprints(),
      listFeaturedBlueprintsFromKv(this.env),
      this.#listStandardFormats(),
    ]);

    // A blueprint can appear in several lists at once (e.g. in the library and featured); the
    // first source to claim an id wins.
    let seen = new Set<string>();
    let sections: string[] = [];
    let add = (id: string, title: string, source: string, description: string,
               bindings?: Record<string, BlueprintBinding>) => {
      if (seen.has(id)) return;
      seen.add(id);
      let lines = [
        `* blueprintId: ${id}`,
        `  ${JSON.stringify(title)} — ${source}`,
      ];
      let bindingNames = Object.entries(bindings ?? {});
      if (bindingNames.length > 0) {
        lines.push(`  Bindings required: ` +
            bindingNames.map(([name, b]) => `${name} (${describeBindingKind(b)})`).join(", "));
      }
      if (description) {
        lines.push(...description.split("\n").map(line => `  ${line}`));
      }
      sections.push(lines.join("\n"));
    };

    // Standard formats first, and labelled as preferred.
    for (let format of formats) {
      let source = `a standard format on this deployment` +
          (format.agentHint ? ` -- ${format.agentHint}` : ``);
      add(format.blueprintId, format.output.noun, source, format.description, format.bindings);
    }

    for (let blueprint of own) {
      // BlueprintUserSummary carries no binding metadata; createGadget's output describes the
      // bindings after instantiation.
      add(blueprint.id, blueprint.title, `published by you`, blueprint.description);
    }
    for (let blueprint of orgs) {
      add(blueprint.id, blueprint.metadata.title, `published by one of your organizations`,
          blueprint.metadata.description, blueprint.metadata.bindings);
    }
    for (let blueprint of library) {
      add(blueprint.id, blueprint.metadata.title, `in your library`,
          blueprint.metadata.description, blueprint.metadata.bindings);
    }
    for (let blueprint of featured) {
      add(blueprint.id, blueprint.metadata.title, `featured on this deployment`,
          blueprint.metadata.description, blueprint.metadata.bindings);
    }

    if (sections.length === 0) {
      return "No blueprints are available to this user.";
    }
    let preamble = `Blueprints available to instantiate (pass the blueprintId to createGadget)`;
    if (formats.length > 0) {
      preamble += `. The standard formats are listed first: when the user asks for something one ` +
          `of them produces, instantiate it rather than building an equivalent from scratch`;
    }
    return `${preamble}:\n\n` + sections.join("\n");
  }

  /**
   * A short standing note about the deployment's standard formats, for the system prompt. Carried
   * on every turn because "make me a quick doc" doesn't prompt an agent to call `listBlueprints`.
   */
  async describeStandardFormats(): Promise<string> {
    let formats = await this.#listStandardFormats();
    if (formats.length === 0) return "";

    // No worked examples: the nouns are the deployment's, listed below, and may be plural.
    return `# Standard output formats\n\n` +
        `This deployment offers these as ready-made outputs, and users ask for them by name. When ` +
        `the user asks for something one of them produces, instantiate that blueprint with ` +
        `\`createGadget\` rather than writing an equivalent from scratch -- including when the ` +
        `workspace already contains Gadgets, since the user is asking for a new output alongside ` +
        `them rather than for an existing one to be repurposed. If the Gadget they are talking ` +
        `about already *is* one of these, work on that one instead: asking to change an existing ` +
        `output is not a request for a second one.\n\n` +
        formats.map(format =>
            `* ${format.output.noun} (plural: ${format.output.plural}) — blueprintId: ` +
            `${format.blueprintId}` + (format.agentHint ? `; ${format.agentHint}` : ``)).join("\n");
  }

  // The deployment's standard output formats, as offered to the user (see listFormatOffers) plus
  // the admin's hint about when to prefer each. Best-effort.
  async #listStandardFormats(): Promise<FormatOffer[]> {
    try {
      return await listFormatOffers(this.env, await readAdminConfig(this.env));
    } catch (err) {
      this.logger.warn("failed to list standard formats for the agent", {
        event: "formats.agent.list.failed", error: err,
      });
      return [];
    }
  }

  #tailSubscribers: Set<RpcStub<ConsoleLogSubscriber>> = new Set();

  async deliverGadgetLogs(chatId: number | null, logs: ConsoleLogEvent[]) {
    for (let sub of this.#tailSubscribers) {
      sub.event(chatId, logs).catch(() => {
        sub[Symbol.dispose]();
        this.#tailSubscribers.delete(sub);
      });
    }
  }

  async subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>> {
    let sub = subscriber.dup();
    sub.onRpcBroken(_ => unsubscribe());
    this.#tailSubscribers.add(sub);

    let self = this;
    function unsubscribe() {
      self.#tailSubscribers.delete(sub);
      sub[Symbol.dispose]();
    }

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    });
  }

  // Tail of the in-flight addObserver/removeObserver chain per `${observerId}/${gatekeeperId}`
  // (see #withObserverGatekeeperLock). In-memory only, entries dropped as each chain drains; the
  // calls it orders are themselves re-run/repaired across DO restarts.
  #observerGatekeeperLocks = new Map<string, Promise<void>>();

  /**
   * Serialize this DO's addObserver/removeObserver RPCs per (observer, gatekeeper) pair. The
   * overseer is the only caller of either, so ordering our own calls is enough to close the race
   * between an exclusion teardown's in-flight removeObserver and a fresh open's addObserver on
   * the same pair: the add either lands first or waits for the removal and re-registers cleanly.
   */
  protected async withObserverGatekeeperLock<T>(
      observerId: string, gatekeeperId: number, fn: () => Promise<T>): Promise<T> {
    let key = `${observerId}/${gatekeeperId}`;
    let prior = this.#observerGatekeeperLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    let tail = new Promise<void>(resolve => { release = resolve; });
    this.#observerGatekeeperLocks.set(key, tail);
    tail.then(() => {
      // Drop the entry once the chain drains; a newer tail means someone queued behind us.
      if (this.#observerGatekeeperLocks.get(key) === tail) {
        this.#observerGatekeeperLocks.delete(key);
      }
    });
    await prior;  // never rejects: each holder settles its own tail via the finally below
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Best-effort `removeObserver(observerId)` across the given gatekeeper ids. Never throws; logs
   * and continues on error. An orphaned observer entry only ever causes superfluous future checks,
   * never a data leak: a registration is what admits an open, and every open re-runs addObserver,
   * so a stale one grants nothing on its own.
   */
  protected async removeObserverFromGatekeepers(observerId: string, gatekeeperIds: number[]): Promise<void> {
    await Promise.all(gatekeeperIds.map(async id => {
      try {
        await this.withObserverGatekeeperLock(observerId, id,
            async () => (await this.getGatekeeperFacet(id)).removeObserver(observerId));
      } catch (err) {
        this.logger.warn("failed to remove observer from gatekeeper", {
          event: "gatekeeper.observer.remove.failed", gatekeeperId: id, observerId, error: err,
        });
      }
    }));
  }

  /**
   * Tear down observer records for collaborators who lost access as a result of a sharing change.
   * For each affected collaborator who is now fully unauthorized (newRole === null) and has an
   * observer record: best-effort removeObserver on all gatekeeper facets, then delete the record.
   * All calls are best-effort -- an orphaned observer entry only causes superfluous future checks,
   * never a data leak: a registration is what admits an open, and every open re-runs addObserver,
   * so a stale one grants nothing on its own. See observers-implementation-plan.md §5 Step 6.
   */
  async tearDownLostObservers(affected: AffectedCollaborator[]): Promise<void> {
    let gatekeeperIds = [...this.storage.gatekeepers.list()].map(gk => gk.id);
    for (let entry of affected) {
      if (entry.newRole !== null) continue;  // downgraded but still has access -> keep record
      let observer = this.storage.observers.get(entry.profile.id);
      if (!observer) continue;
      this.storage.observers.delete(observer.profileId);
      await this.removeObserverFromGatekeepers(observer.observerId, gatekeeperIds);
    }
  }

  /**
   * Reconcile this workspace's cached listing for collaborators whose access changed: remove it
   * for those who lost access entirely, and refresh the presentation-only role for those who were
   * downgraded.
   */
  async refreshAffectedCollaboratorListings(affected: AffectedCollaborator[]): Promise<void> {
    let gadgetId = this.ctx.id.toString();

    // Fanned out because these are independent DO round-trips: revoking a share link can affect
    // everyone who joined through it, and one await each would make revocation take as long as the
    // slowest collaborator times their number. Chunked to cap how many are in flight at once, not
    // how many are made in total.
    for (let i = 0; i < affected.length; i += LISTING_REFRESH_BATCH) {
      let batch = affected.slice(i, i + LISTING_REFRESH_BATCH);
      let results = await Promise.allSettled(batch.map(entry => {
        let user = this.users.get(this.users.idFromName(entry.profile.id));
        return entry.newRole === null
          ? user.forgetSharedGadget(gadgetId)
          : user.updateSharedGadgetRole(gadgetId, entry.newRole);
      }));
      for (let j = 0; j < results.length; j++) {
        let result = results[j];
        if (result.status !== "rejected") continue;
        this.logger.warn("failed to refresh affected collaborator's workspace listing", {
          event: "shared.gadget.access.refresh.failed", gadgetId, error: result.reason,
        });
      }
    }
  }

  /**
   * Get the owner's profile ID, using the in-memory cache when available. The owner's
   * profile ID never changes, so this is safe to cache for the lifetime of the DO instance.
   * The cache is populated eagerly when the owner calls open(), but if only collaborators
   * have opened this instance we fetch it via RPC on first use.
   */
  async getOwnerProfileId(): Promise<string> {
    const ownerProfileId = this.ownerProfileId;
    if (ownerProfileId !== undefined) {
      return ownerProfileId;
    }

    if (!this.ownerId) throw new Error("Workspace is not initialized.");
    const ownerDo = this.users.get(this.users.idFromString(this.ownerId));
    const ownerProfile = await ownerDo.whoami();
    this.ownerProfileId = ownerProfile.id;
    return ownerProfile.id;
  }

  #sharingManager?: SharingManager;

  /**
   * Collaborator authorization / sharing / permission logic. Memoized for the DO instance.
   * Resolving the owner's profile ID may require an RPC on first use; thereafter it's cached.
   */
  async getSharingManager(): Promise<SharingManager> {
    if (!this.#sharingManager) {
      this.#sharingManager = new SharingManager(
          this.storage, await this.getOwnerProfileId(), () => this.storage.ownerInvitesOnly.get());
    }
    return this.#sharingManager;
  }
}
