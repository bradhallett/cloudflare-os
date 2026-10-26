// Test worker for the workerd suite: re-exports the production entrypoint so miniflare can bind
// the Durable Objects, and adds the TestHooks Durable Object the suites drive everything through
// (see ./workerd/TestHooks.ts for why it has to be a Durable Object). The trigger initiator below
// mirrors the scheduler's harness: a WorkerEntrypoint with module-level state, so a stored stub
// survives storage round trips and its recordings cross back as plain JSON.

export { default } from "../src/worker.js";
export {
  ComposioAccount,
  ComposioSingletonGatekeeper,
  ComposioToolkitGatekeeper,
  ComposioVerifier,
  ComposioTriggerHookController,
  GatekeeperVendor,
  startAppUi,
} from "../src/worker.js";

export { TestHooks } from "./workerd/TestHooks.js";

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { ComposioTriggerFiring, ComposioTriggerHook } from "../src/types.js";

// ---------------------------------------------------------------------------
// The persistent trigger initiator: what the overseer hands
// ComposioTriggerHookController.enable(), standing in for the workshop's own
// HookInitiator. startHook() mints the callback and approval queue each delivery
// actually uses; everything it observes lands in module state the tests read
// back through any instance.

type InitiatorMode = "success" | "start-reject" | "authorization-reject" | "callback-reject";

let initiatorMode: InitiatorMode = "success";
let firings: ComposioTriggerFiring[] = [];
let observations: { title: string; description: string }[] = [];
let startHookCalls = 0;
let initiatorDisposed = 0;
let callbacksDisposed = 0;

/** The approval queue one delivery's startHook hands back. */
class TestDeliveryQueue extends RpcTarget implements Pick<ApprovalQueue, "authorizeObservation"> {
  async authorizeObservation(observation: { title: string; description: string }): Promise<void> {
    if (initiatorMode === "authorization-reject") {
      throw new Error("observation refused by an observer");
    }
    observations.push({ title: observation.title, description: observation.description });
  }
}

/** The callback one delivery's startHook hands back; records every firing. */
class TestTriggerCallback extends RpcTarget implements ComposioTriggerHook {
  async onTrigger(firing: ComposioTriggerFiring): Promise<void> {
    firings.push(firing);
    if (initiatorMode === "callback-reject") throw new Error("callback refused");
  }
  [Symbol.dispose](): void {
    callbacksDisposed++;
  }
}

/** A session-side callback stand-in: createTrigger only needs it to be stubbable. */
export class BindMarkerCallback extends RpcTarget implements ComposioTriggerHook {
  async onTrigger(): Promise<void> {}
}

/** Test-only persistent trigger initiator (the scheduler harness pattern). */
export class TestTriggerInitiator extends WorkerEntrypoint {
  async startHook(): Promise<{
    callback: RpcTarget & ComposioTriggerHook;
    approvalQueue: RpcTarget;
  }> {
    startHookCalls++;
    if (initiatorMode === "start-reject") throw new Error("workspace refused the hook");
    return { callback: new TestTriggerCallback(), approvalQueue: new TestDeliveryQueue() };
  }

  configure(mode: InitiatorMode): void {
    initiatorMode = mode;
  }

  read(): {
    firings: ComposioTriggerFiring[];
    observations: { title: string; description: string }[];
    startHookCalls: number;
    initiatorDisposed: number;
    callbacksDisposed: number;
  } {
    return {
      firings: [...firings],
      observations: [...observations],
      startHookCalls,
      initiatorDisposed,
      callbacksDisposed,
    };
  }

  reset(): void {
    initiatorMode = "success";
    firings = [];
    observations = [];
    startHookCalls = 0;
    initiatorDisposed = 0;
    callbacksDisposed = 0;
  }

  [Symbol.dispose](): void {
    initiatorDisposed++;
  }
}
