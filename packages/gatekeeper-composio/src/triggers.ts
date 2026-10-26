// The trigger hook controller: the immutable activation object a Composio session mints per
// createTrigger() call, on the Scheduled Tasks contract (workshop-shared's HookController). The
// workshop's approval gate drives `enable(initiator, target)` once the user approves arming the
// trigger and `disable()` when they deny it, the gadget unbinds, or the session deletes it — the
// controller itself holds no state, it only forwards to the account Durable Object that owns
// every trigger row, delivery, and the upstream instance.

import { validateRpc } from "capnweb-validate";
import { WorkerEntrypoint, type RpcStub, type RpcTarget } from "cloudflare:workers";
import type {
  ApprovalQueue,
  HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";

import type { ComposioAccount } from "./account.js";
import { accountById } from "./worker.js";
import type { ComposioTriggerFiring, ComposioTriggerHook } from "./types.js";

/** The hook target a gadget implements for `onTrigger` (see types.d.ts for the agent docs). */
export type ComposioTriggerHookTarget = RpcTarget & ComposioTriggerHook;

/*
 * The RPC surfaces below restate workshop-shared's `HookInitiator`/`HookController` as the
 * minimal methods this connector actually calls: the shared interfaces extend WorkerEntrypoint
 * with generic parameters, whose resolved surface (fetch, then/catch) cannot appear in a
 * @validateRpc signature. The overseer still hands over the full initiator at runtime; these
 * are the views of it this package declares and validates.
 */

/** The callback stub one `startHook()` lease hands back, as delivery calls it. */
export interface ComposioTriggerCallbackTarget extends RpcTarget {
  onTrigger(firing: ComposioTriggerFiring): Promise<void>;
}

/**
 * The persistent initiator the workshop hands the controller at enable time, reduced to the
 * one method the account calls per delivery.
 */
export interface ComposioTriggerInitiatorService extends RpcTarget {
  startHook(): Promise<{
    callback: RpcStub<ComposioTriggerCallbackTarget>;
    approvalQueue: RpcStub<ApprovalQueue>;
  }>;
}

/** The initiator as it crosses (and is stored by) this connector's RPC surfaces. */
export type ComposioTriggerInitiator = RpcStub<ComposioTriggerInitiatorService>;

/** The controller as its callers (session, approval gate) see it over RPC. */
export interface ComposioTriggerControllerService extends WorkerEntrypoint {
  enable(initiator: ComposioTriggerInitiator, target: HookTargetMetadata): Promise<void>;
  disable(): Promise<void>;
}


/**
 * What a trigger controller is minted from. Immutable for the controller's lifetime: a config
 * change is a disable plus a fresh createTrigger under a new id, never a props mutation.
 */
export interface ComposioTriggerControllerProps {
  /** The account DO's id, as a hex string — the controller's only way back to its state. */
  accountObjectId: string;
  /** The minting facet's inherited workspace scope; fences disable as the scheduler's does. */
  workspaceId: string;
  /** The local trigger id the session generated and will return to the agent. */
  triggerId: string;
  /** The upstream Composio trigger slug. */
  triggerSlug: string;
  /** The trigger's own upstream configuration, passed through uninterpreted. */
  filters: Record<string, unknown>;
  /** Display title/description, exactly as the enable-gate approval showed them. */
  title: string;
  description: string;
}

/** The wire shape of one queued delivery inside the account DO's hook delivery queue. */
export interface ComposioTriggerMessage {
  /** The envelope id — the upstream idempotency key, stable across redeliveries. */
  eventId: string;
  triggerSlug: string;
  /** Upstream event time (epoch ms), when Composio sent one. */
  timestamp: number | null;
  /** The payload as capped JSON (see MAX_TRIGGER_EVENT_BYTES). */
  dataJson: string;
  /** Whether `dataJson` was truncated below the full upstream payload. */
  truncated: boolean;
}

/**
 * The trigger controller, structurally on the Scheduled Tasks `HookController` contract: the
 * signature is restated with this package's validated initiator view (see the surfaces above)
 * rather than the shared interface's generic one.
 */
@validateRpc()
export class ComposioTriggerHookController
  extends WorkerEntrypoint<Cloudflare.Env, ComposioTriggerControllerProps>
{
  /** Arms the trigger: the account records the initiator and creates the upstream instance. */
  enable(
    initiator: ComposioTriggerInitiator,
    target: HookTargetMetadata,
  ): Promise<void> {
    const props = this.ctx.props;
    return this.#account().enableTrigger({
      triggerId: props.triggerId,
      triggerSlug: props.triggerSlug,
      filters: props.filters,
      title: props.title,
      description: props.description,
      workspaceId: target.workspaceId,
      ...(target.gadgetId !== undefined ? { gadgetId: target.gadgetId } : {}),
    }, initiator);
  }

  /** Disarms the trigger: upstream instance deleted, initiator disposed, rows dropped. */
  disable(): Promise<void> {
    return this.#account().disableTrigger(
      this.ctx.props.triggerId, this.ctx.props.workspaceId);
  }

  #account(): ComposioAccount {
    return accountById(this.ctx.exports.ComposioAccount, this.ctx.props.accountObjectId);
  }
}
