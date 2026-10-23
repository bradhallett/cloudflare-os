import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { GatekeeperClient, GatekeeperCreationSpec } from "@gadgets/workshop-shared/api";
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
  // TODO: Same workerd bug as startGatekeeperHook: a Proxy returned as an RpcTarget is judged
  //   non-pipelineable, so wrap it in a stub manually.
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
  // `hookId` is set only on the queue startHook returns with each firing: that queue is held by
  // the gatekeeper across awaits (even other DOs), so like the firing's callback it revalidates
  // the hook per call -- otherwise a firing raced by a disable/delete could keep authorizing
  // observations against a scope the shrink already excluded someone from (or set
  // containsRestrictedData). Session queues (openGatekeeperSession) pass no hookId: they are
  // bounded by the facet's in-DO lifetime, which the session chokepoints already gate.
  constructor(private impl: OverseerImpl, private gatekeeperId: number,
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

// =======================================================================================

