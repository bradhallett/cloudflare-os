import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { Gatekeeper, ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { type AgentSpawnerQueue } from "./overseer-gatekeeper-client";
import { DurableObject, RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { AgentSpawnerBindingProps } from "./storage-schema/overseer-storage";
import type { AgentSpawnerBinding, CallableAgent, SpawnCallableOptions } from "./agent-spawner-binding";
import AGENT_SPAWNER_BINDING_TYPES from "./agent-spawner-binding.txt";

export class AgentSpawnerGatekeeper
    extends DurableObject<Cloudflare.Env, AgentSpawnerBindingProps>
    implements Gatekeeper<AgentSpawnerBinding> {
  async describe(): Promise<ResourceDescription> {
    return {
      // TODO: Decide if we need real URLs or if `url` should stop being part of the description.
      url: `http://agent-spawner.local/`,

      title: this.ctx.props.config.displayName,
      snippet: "Allows the gadget to spawn AI agents to perform tasks on given resources.",

      suggestedBindingName: "AGENT_SPAWNER",

      tsType: `AgentSpawnerBinding`,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return AGENT_SPAWNER_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  /** Takes an AgentSpawnerQueue, which openGatekeeperSession gives every agent spawner. */
  async startSession(queue: NativeRpcStub<AgentSpawnerQueue>)
      : Promise<AgentSpawnerBinding> {
    return new AgentSpawnerBindingImpl(this.ctx, queue.dup());
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // The agent spawner itself is not a restricted-access resource: it reads nothing that
    // identifies the observer or leaks private data, so any observer is permitted. What it
    // *reaches* -- the connections its env names -- is modeled in the use-scope closure
    // (#useScopeGatekeeperIds), so observers are verified against those targets directly.
    // No-op (never throws).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

// Deliberately not `implements AgentSpawnerBinding`: capnweb-validate sharpens an implemented
// interface's signatures onto the generated validator, which would reject the string that the
// migration guard in spawnCallable exists to explain. Conformance to the served interface is
// still checked, by startSession()'s return type.
@validateRpc()
class AgentSpawnerBindingImpl extends RpcTarget {
  constructor(private ctx: DurableObjectState<AgentSpawnerBindingProps>,
              private queue: NativeRpcStub<AgentSpawnerQueue>) {
    super();
  }

  async spawn(title: string, prompt: string): Promise<void> {
    // TODO: Should we be calling authorizeObservation() here? It's not really observing anything,
    //   but you might want the audit logs? But also, the agents show up in the chat history so
    //   maybe it's not really necessary to include them in the audit log too.
    return this.queue.spawnAgent(title, prompt, this.ctx.props.creatorUserId);
  }

  // Migration guard: `options` admits a string only so that a gadget written against the old
  // spawnCallable(title, prompt) fails with an explanation rather than a validator type error.
  // The served .d.ts keeps the clean signature. Remove once existing gadgets have been updated.
  async spawnCallable(title: string, options: SpawnCallableOptions | string)
      : Promise<CallableAgent> {
    if (typeof options === "string") {
      throw new Error(
          "spawnCallable(title, prompt) has been replaced by spawnCallable(title, " +
          "{types, mainType}); the agent no longer receives a prompt and calls no longer return " +
          "values. Update the calling code -- call describeBinding on the spawner for the new " +
          "interface.");
    }
    return this.queue.spawnCallableAgent(title, options, this.ctx.props.creatorUserId);
  }

  [Symbol.dispose]() {
    this.queue[Symbol.dispose]();
  }
}
