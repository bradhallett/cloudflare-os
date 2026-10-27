import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { GatekeeperClient, GatekeeperCreationSpec, WorkpieceId, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { CallableAgent, SpawnCallableOptions } from "./agent-spawner-binding";
import type { AiChatAgentContext } from "./storage-schema/overseer-storage";
import { Gatekeeper, ResourceDescription, ApprovalQueue, ActionDescription, ObservationAuthorizer, ObservationDescription, HookController, HookDescription, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import type { BoundHookRecord, GatekeeperCaller, GatekeeperRecord } from "./storage-schema/overseer-storage";
import { GitCacheImpl } from "./git-cache";
import { OverseerImpl } from "./overseer-impl";
import type { SessionKind } from "./overseer-support";
import { connectionTypeFromCreationSpec } from "./overseer-binding-info";

@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class GatekeeperClientImpl<Session extends RpcCompatible<Session>>
    extends RpcTarget implements GatekeeperClient<Session> {
  // See GadgetClientImpl: `joinedAs` counts a collaborator's retained capability toward
  // #hasCollaboratorSession; omitted for the owner's and for internal construction.
  // `actorUserId` (hex user DO ID of the client holding this capability) feeds analytics only.
  #leaveSession?: () => void;

  constructor(private impl: OverseerImpl, private id: number,
      private facet: Fetcher<Gatekeeper<Session>>,
      private actorUserId: string,
      joinedAs?: SessionKind) {
    super();
    if (joinedAs) this.#leaveSession = impl.joinSession(joinedAs);
  }

  [Symbol.dispose]() {
    this.#leaveSession?.();
  }

  async remove(): Promise<void> {
    let record = this.impl.storage.gatekeepers.get(this.id);
    this.impl.removeGatekeeper(this.id);
    this.impl.recordGadgetAnalytics({
      event_name: "connection_removed",
      user_id: this.actorUserId,
      gatekeeper_id: this.id,
      connection_type: connectionTypeFromCreationSpec(record?.creationSpec?.type),
      vendor_id: record?.creationSpec?.type === "gatekeeper" ? record.creationSpec.vendorId : undefined,
    });
  }

  async getId(): Promise<number> {
    return this.id;
  }

  #getRecord(): GatekeeperRecord {
    let record = this.impl.storage.gatekeepers.get(this.id);
    if (!record) throw new Error("No such gatekeeper.");
    return record;
  }

  async getTitle(): Promise<string> {
    return this.#getRecord().resourceTitle || "(title unavailable)";
  }

  async setTitle(title: string): Promise<void> {
    // This changes only the display title used locally within this workspace (resourceTitle is a
    // denormalized copy of the remote resource's title), never the remote resource.
    let record = this.#getRecord();
    record.resourceTitle = title;
    this.impl.storage.gatekeepers.put(record);
  }

  async describe(): Promise<ResourceDescription> {
    return this.facet.describe();
  }

  async openSession(): Promise<RpcStub<Session>> {
    return this.impl.openGatekeeperSession(this.id, this.facet, {from: "user"});
  }

  async getCreationSpec(): Promise<GatekeeperCreationSpec> {
    let record = this.#getRecord();
    if (!record.creationSpec) {
      throw new Error("This gatekeeper has no creation spec (created before blueprint support).");
    }
    return record.creationSpec;
  }
}

// ObservationAuthorizer handed to a slash-command provider. Scoped to one Gatekeeper; observations
// only (no actions or hooks).
@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class SlashCommandAuthorizerImpl extends NativeRpcTarget implements ObservationAuthorizer {
  constructor(private impl: OverseerImpl, private gatekeeperId: number,
              private caller: GatekeeperCaller) {
    super();
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.impl.authorizeObservation(this.gatekeeperId, description, this.caller);
  }

  async getGitCache(): Promise<GitCache> {
    return new GitCacheImpl(this.impl.gitCache, this.gatekeeperId);
  }
}

// Re-resolve a hook's record and refuse unless it is still enabled and its connection usable.
// Deleting or disabling the record is the authoritative kill (removeGatekeeper, deleteHook,
// disableHook), and the capabilities startHook issues are held outside this DO -- in other DOs
// (e.g. a scheduler driver), across resets -- so each call through them checks the record *now*
// rather than trusting the moment of issue. The gatekeeperId check additionally keeps a
// quarantined connection refused on the hook routes: the enable that armed a hook may itself be
// the widening that scheduled a restart, and a shrink-then-rewiden leaves stale firings pointing
// at a connection pending re-verification (see #gatekeepersPendingRestart).
/** Loads a hook record, throwing unless it is live. */
export function requireLiveHook(impl: OverseerImpl, hookId: number): BoundHookRecord {
  let record = impl.storage.boundHooks.get(hookId);
  if (!record?.enabled) throw new Error("Hook has been deleted or disabled.");
  impl.assertGatekeeperUsable(record.gatekeeperId);
  return record;
}

// The callback startHook returns to each firing: a wrapper that re-resolves the stored callback
// through requireLiveHook on every call, so it dies with the hook -- the per-firing revocation
// the session contract on Gatekeeper.bindHook documents. The stored record.callback itself never
// leaves the DO again: it is a persistent stub (it survives row deletion and DO resets), so once
// issued it could never be revoked, and a holder would keep a live write channel into the gadget
// after a disable/delete shrank every collaborator's verification scope.
//
// The wrapper covers the root callback only. Capabilities a callback method *returns* reach the
// firing as independent stubs (the bindHook contract permits hooks to pass and return them) and
// are not re-checked per call. That is deliberate: the holder is a gatekeeper bound by the session
// contract, and this is a guard against a stale firing by mistake, not a revocable membrane.
/** Builds the RPC callback stub handed to a gatekeeper so it can fire a hook. */
export function makeHookFiringCallback(impl: OverseerImpl, hookId: number): NativeRpcStub<RpcTarget> {
  // The proxy target must be callable for the `apply` trap to ever fire (a Proxy over a
  // non-callable target is itself non-callable), and the bindHook contract allows the bound
  // callback to be a function type, invoked by calling the firing's callback directly. An arrow
  // function also has no `prototype` own-property to conflict with the wildcard `get` below.
  // TODO: workerd bug: a Proxy returned as an RpcTarget is judged non-pipelineable, so wrap
  //   it in a stub manually.
  return new NativeRpcStub(new Proxy((() => {}) as unknown as RpcTarget, {
    // Both traps are async so a refusal is a rejection of that call, not a synchronous throw
    // escaping into the RPC machinery that invokes the function (workerd reports that as
    // uncaught, too).
    async apply(_target, _thisArg, args: unknown[]) {
      let record = requireLiveHook(impl, hookId);
      return Reflect.apply(record.callback as any, undefined, args);
    },
    get(_target, prop) {
      // All wildcard properties of a stub appear as functions, so `then` must come back
      // undefined (this is not a thenable) and symbols are never RPC methods -- the same
      // dispositions as getGadgetFacet's proxy over the gadget facet.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return async (...args: unknown[]) => {
        let record = requireLiveHook(impl, hookId);
        return Reflect.apply((record.callback as any)[prop], record.callback, args);
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }));
}

@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class ApprovalQueueImpl extends RpcTarget implements ApprovalQueue {
  /**
   * `hookId` is set only on the queue startHook returns with each firing: that queue is held by
   * the gatekeeper across awaits (even other DOs), so like the firing's callback it revalidates
   * the hook per call -- otherwise a firing raced by a disable/delete could keep authorizing
   * observations against a scope the shrink already excluded someone from (or set
   * containsRestrictedData). Session queues (openGatekeeperSession) pass no hookId: they are
   * bounded by the facet's in-DO lifetime, which the session chokepoints already gate.
   */
  constructor(protected impl: OverseerImpl, protected gatekeeperId: number,
              private caller: GatekeeperCaller, private hookId?: number) {
    super();
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.authorizeObservation(this.gatekeeperId, description, this.caller);
  }

  async getGitCache(): Promise<GitCache> {
    return new GitCacheImpl(this.impl.gitCache, this.gatekeeperId);
  }

  submitAction(action: number, description: ActionDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.submitAction(this.gatekeeperId, action, description, this.caller);
  }

  bindHook<Hook extends RpcTarget>(
        controller: Fetcher<HookController<Hook>>, callback: NativeRpcStub<Hook>,
        description: HookDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.bindHook(this.gatekeeperId, controller, callback, description, this.caller);
  }
}

/**
 * The approval queue an agent spawner's sessions receive (see openGatekeeperSession), which also
 * starts agents as that spawner. A spawner from before creationSpec existed can't be told apart
 * from other gatekeepers, so it gets a plain queue and can't spawn.
 */
export interface AgentSpawnerQueue extends ApprovalQueue {
  /**
   * Implements AgentSpawnerBinding.spawn(), resolving the model from the account of
   * `creatorUserId` (see AgentSpawnerBindingProps): the agent starts at once on `prompt`.
   */
  spawnAgent(title: string, prompt: string, creatorUserId?: string): Promise<void>;

  /**
   * Implements AgentSpawnerBinding.spawnCallable(), resolving the model as spawnAgent() does:
   * the chat is created with no messages, and the agent starts when the first call is made on
   * the returned stub. The declarations the agent implements are frozen on the chat context,
   * where the system-prompt builder reads them.
   */
  spawnCallableAgent(title: string, options: SpawnCallableOptions, creatorUserId?: string)
      : Promise<CallableAgent>;
}

@validateRpc()
/** Split out of the former overseer.ts (internal helper). */
export class AgentSpawnerQueueImpl extends ApprovalQueueImpl implements AgentSpawnerQueue {
  async spawnAgent(title: string, prompt: string, creatorUserId?: string): Promise<void> {
    let {chatId, meta, userMeta, author, initiatorUserId} =
        await this.#createSpawnedChat(title, creatorUserId);

    if (userMeta.aiModel) {
      meta.activeAgent = userMeta.aiModel.profile;
      this.impl.storage.chatMeta.put(meta);
    }

    this.impl.storage.chats.put({
      chatId,
      sequence: this.impl.nextChatSequence(chatId),
      timestamp: meta.started,
      author,

      type: "message",
      message: prompt,
    });

    if (userMeta.aiModel) {
      // Fire off the agent (asynchronously).
      this.impl.startAgent(chatId, userMeta.aiModel, author, initiatorUserId);
    } else {
      // TODO: Flag as needing user attention.
    }
  }

  /**
   * Implements AgentSpawnerBinding.spawnCallable(): the chat is created with no messages, and
   * the agent starts when the first call is made on the returned stub. The declarations the agent
   * implements are frozen on the chat context, where the system-prompt builder reads them.
   */
  async spawnCallableAgent(title: string, options: SpawnCallableOptions, creatorUserId?: string)
      : Promise<CallableAgent> {
    let {chatId, initiatorUserId, modelId} =
        await this.#createSpawnedChat(title, creatorUserId, options);

    // A stub that delivers calls to the new chat thread, like the `self` magic object. Each call
    // is recorded by deliverAgentCallback(), which starts the agent when it is idle; with no
    // model configured, calls are still appended to the chat, for a human to pick up.
    return this.impl.ctx.exports.AgentSelfLoopback({props: {
      overseerId: this.impl.ctx.id.toString(),
      chatId,
      initiatorUserId,
      initiatorModelId: modelId,
    }}) as unknown as CallableAgent;
  }

  // The spawner's config and bindings, from its record.
  #spawner() {
    let record = this.impl.storage.gatekeepers.get(this.gatekeeperId);
    if (record?.creationSpec?.type !== "agentSpawner") {
      throw new Error("This agent spawner has been deleted.");
    }
    return {config: record.creationSpec.config, bindings: record.bindings ?? {}};
  }

  // Creates the chat for a spawned agent: its metadata, and a context carrying the frozen spawner
  // config (plus, for a callable agent, the interface declarations) and the seed binding layer.
  // Writes no messages; the caller decides how the chat starts.
  async #createSpawnedChat(
      title: string, creatorUserId: string | undefined, spawnerTypes?: SpawnCallableOptions) {
    if (!this.impl.ownerId) throw new Error("Workspace has been deleted.");

    // Resolve the model from the creating user's account (falls back to owner for
    // bindings created before collaborator support).
    let resolveUserId = creatorUserId ?? this.impl.ownerId;
    let initiatorUserId = this.impl.users.idFromString(resolveUserId).toString();
    let user = this.impl.users.get(this.impl.users.idFromString(resolveUserId));
    let userMeta = await user.getChatContext(this.#spawner().config.modelId);

    // Read again after the await, across which the spawner may have been deleted or edited.
    let {config, bindings: edges} = this.#spawner();

    let chatId = this.impl.nextChatId();
    let timestamp = this.impl.getChatTimestamp();
    let meta: AiChatMetadata = {
      id: chatId,
      title,
      started: timestamp,
      lastActive: timestamp,
      spawnerName: config.displayName,
    };
    this.impl.storage.chatMeta.put(meta);

    // Snapshot the spawner's accepted bindings as the chat's seed binding layer -- the spawned
    // agent sees only these, never the workspace default list. Entries whose targets no longer
    // exist are dropped.
    let bindings: Record<string, WorkpieceId> = Object.create(null);
    for (let [name, {target}] of this.impl.visibleBindings({bindings: edges})) {
      if (this.impl.storage.gadgets.get(target)?.type === "gadget" ||
          this.impl.storage.gatekeepers.get(target)) {
        bindings[name] = target;
      }
    }

    let context: AiChatAgentContext = {
      chatId, spawnerConfig: {...config, env: bindings}, bindings,
    };
    if (spawnerTypes) context.spawnerTypes = spawnerTypes;
    this.impl.storage.chatContext.put(context);

    let author = this.impl.gadgetAuthorFor(userMeta.profile);
    return {chatId, meta, userMeta, author, initiatorUserId, modelId: config.modelId};
  }
}

// =======================================================================================

