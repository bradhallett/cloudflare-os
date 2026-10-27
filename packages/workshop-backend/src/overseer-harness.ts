import { WorkerEntrypoint, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import type { ChatBindingEntry } from "./storage-schema/overseer-storage";
import { OverseerImpl } from "./overseer-impl";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";

/** Split out of the former overseer.ts (internal). */
export const CODE_MODE_HARNESS =
`import { WorkerEntrypoint, restore } from "cloudflare:workers";
import agent from "agent.js";

export default class extends WorkerEntrypoint {
  verify() {}
  async run(self, restoreForger) {
    let env = this.env;
    if (restoreForger) {
      // Graft the well-known \`restore\` symbol onto each service-binding stub in env -- for a
      // gadget binding, its \`rpc\` stub -- so the executed code can call
      // \`env.SOME_GADGET.rpc[restore](params)\` to forge a persistent stub targeting that
      // gadget's [restore]() method. The symbol property is defined per-instance (not on the
      // shared prototype) so only this execution's own bindings offer it, and it is invisible to
      // RPC serialization, so passing a binding over RPC is unaffected. The capability itself is
      // \`restoreForger\`, a transient stub scoped to this run() call; the overseer resolves the
      // binding name back to the target gadget (and rejects non-gadget bindings with an
      // instructive error).
      for (let [name, value] of Object.entries(env)) {
        let stub = value?.rpc?.constructor?.name === "Fetcher" ? value.rpc : value;
        if (stub?.constructor?.name === "Fetcher") {
          Object.defineProperty(stub, restore, {
            value: params => restoreForger.forge(name, params),
          });
        }
      }
    }
    let result = await agent(self, env, this.ctx);
    if (result !== undefined) console.log("Return value:", result);
  }
}
`;

// A one-off dynamic worker whose only purpose is to call ctx.restore() while pretending to be a
// particular gadget's facet. forgeRestoreStubForBinding() loads it through the overseer's own
// ctx.restore() (see OverseerRestoreParams.codeId), so this worker's self-token names the target
// gadget; the persistent stubs its forge() method creates therefore restore through that gadget's
// [restore]() method.
const RESTORE_FORGER_HARNESS =
`import { WorkerEntrypoint, restore, RpcStub, RpcTarget } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  forge(params) {
    return this.ctx.restore(params);
  }

  [restore](params) {
    // TODO: Add runtime features that allow us to actually invoke the gadget's [restore]()
    // method to return the real target stub. For now, since this is always used to construct
    // stubs that are meant for hooks, and therefore we generally don't expect the stub to be
    // called before being passed to bindHook(), we return a placeholder that throws if called.
    // Once passed to bindHook(), stored, and then read back from storage, the stub will have been
    // replaced with the real thing.
    return new RpcStub(new PlaceholderRpcTarget());
  }
}

class PlaceholderRpcTarget extends RpcTarget {
  constructor() {
    super();

    return new Proxy(this, {
      get(target, prop, receiver) {
        switch (prop) {
          case "then":
          case "dup":
            return undefined;
          default:
            return () => {
              throw new Error(
                  "Tried to invoke a placeholder stub for a persistent hook callback. This " +
                  "stub is only intended to be stored; once loaded back from storage it will " +
                  "work properly. This is a temporary hack until the runtime can be extended " +
                  "with better APIs for sealing/unsealing.");
            };
        }
      },
    });
  }
}
`;

/** Split out of the former overseer.ts (internal). */
export const RESTORE_FORGER_WORKER: WorkerLoaderWorkerCode = {
  compatibilityDate: COMPATIBILITY_DATE,
  compatibilityFlags: [
    // The forger holds no bindings, but lock it down like the code-mode worker anyway.
    "disallow_importable_env",

    // Make ctx.restore() available.
    "allow_irrevocable_stub_storage",
  ],
  mainModule: "forger.js",
  modules: {
    "forger.js": RESTORE_FORGER_HARNESS,
  },
  globalOutbound: null,
};

/** Split out of the former overseer.ts (internal). */
export interface CodeModeEntrypoint extends WorkerEntrypoint {
  verify(): void;
  run(self?: unknown, restoreForger?: NativeRpcStub<RestoreForgerImpl>): Promise<void>;
}

/** Split out of the former overseer.ts (internal). */
export interface RestoreForgerEntrypoint extends WorkerEntrypoint {
  forge(params: unknown): Promise<unknown>;
}

// The capability handed to CODE_MODE_HARNESS's run() that lets executed code invoke
// `env.<name>.rpc[restore](params)`. Only executeCode receives this capability -- gadget workers
// never do -- and it's passed as a transient stub argument to run(), so it lives exactly as
// long as the execution. The binding name is resolved against the execution's own binding map
// on the overseer side, so the capability conveys no authority beyond the env it accompanies.
/** Split out of the former overseer.ts (internal). */
export class RestoreForgerImpl extends NativeRpcTarget {
  // Real private fields: RPC exposes an RpcTarget's properties as well as its methods, so
  // TypeScript-only privacy would leak these to the executed code.
  #impl: OverseerImpl;
  #chatId: number;
  #bindings: Record<string, ChatBindingEntry>;

  constructor(impl: OverseerImpl, chatId: number,
              bindings: Record<string, ChatBindingEntry>) {
    super();
    this.#impl = impl;
    this.#chatId = chatId;
    this.#bindings = bindings;
  }

  forge(bindingName: string, params: unknown): Promise<unknown> {
    return this.#impl.forgeRestoreStubForBinding(
        this.#chatId, this.#bindings, bindingName, params);
  }
}

