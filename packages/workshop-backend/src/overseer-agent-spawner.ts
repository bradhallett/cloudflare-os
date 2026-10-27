import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { type AgentSpawnerQueue } from "./overseer-gatekeeper-client";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { AgentSpawnerBindingProps } from "./storage-schema/overseer-storage";
import { StaticResourceGatekeeper } from "./ai-models";
import type { AgentSpawnerBinding, CallableAgent, SpawnCallableOptions } from "./agent-spawner-binding";
import AGENT_SPAWNER_BINDING_TYPES from "./agent-spawner-binding.txt";

export class AgentSpawnerGatekeeper
    extends StaticResourceGatekeeper<AgentSpawnerBindingProps, AgentSpawnerBinding> {
  async describe(): Promise<ResourceDescription> {
    return {
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

  /** Takes an AgentSpawnerQueue, which openGatekeeperSession gives every agent spawner. */
  async startSession(queue: NativeRpcStub<AgentSpawnerQueue>)
      : Promise<AgentSpawnerBinding> {
    return new AgentSpawnerBindingImpl(this.ctx, queue.dup());
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
