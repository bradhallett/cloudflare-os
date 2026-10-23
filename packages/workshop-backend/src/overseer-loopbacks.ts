import { createWorkshopLogger } from "./observability";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { WorkpieceId, ConsoleLogEvent } from "@gadgets/workshop-shared/api";
import { HookInitiator, ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { WorkerEntrypoint, RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { GatekeeperCaller } from "./storage-schema/overseer-storage";
import { OverseerDurableObject } from "./overseer-durable-object";

const logger = createWorkshopLogger("workshop.overseer");

/** Split out of the former overseer.ts (internal helper). */
export type GatekeeperLoopbackProps = {
  overseerId: string;

  target: BindingLoopbackTarget;

  caller: GatekeeperCaller;
};

/** Split out of the former overseer.ts (internal helper). */
export type BindingLoopbackTarget = {
  type: "gadget" | "gatekeeper";
  id: WorkpieceId;
} | {
  type: "worktree";
  id: WorkpieceId;

  // The executeCodeMode execution this loopback was minted for. A worktree binding resolves
  // against the turn state registered for exactly that execution (see #activeWorktreeTurns), so
  // a stub retained past it -- say, stored in a gadget the agent called -- fails closed instead
  // of coming back to life against a later execution's turn.
  executionId: string;
} | {
  // The `env.GIT` binding (see git-binding.ts).
  type: "git";
} | {
  // A gadget binding's `exports` in the agent's executeCode env (see exports-session.ts).
  type: "exports";
  id: WorkpieceId;
};

/**
 * Horrible hack: At present the `env` of a dynamic isolate can contain ServiceStubs but cannot
 * contain RpcStubs. But if we ask the gatekeeper to open a session, we get an RpcStub. So we
 * actually initialize each binding to be a `ServiceStub` pointing at a `GatekeeperLoopback` whose
 * props identify the overseer and target workpiece, so that on each method call it can resolve the
 * target session.
 *
 * The wire protocol this class must keep is dynamic dispatch: gadget and agent code calls
 * `env.<BINDING>.<session method>(...)`, where the session's surface is defined by the target
 * (a vendor session, a gadget facet, or one of the typed session classes) and so is not knowable
 * here. The constructor therefore installs a Proxy whose only job is translating that protocol:
 * every method name maps onto the one declared, @validateRpc()-validated method below, forward(),
 * which is the entire forwarding implementation -- statically visible, directly callable in tests,
 * and the one place a crossing call is checked. Argument types that mean anything (the session's
 * own signatures) are validated at the terminal session, which is reached only through this hop.
 *
 * TODO(multi-gadget): Rename to BindingLoopback. Stubs to this entrypoint aren't stored anywhere,
 * so a rename should be safe.
 */
@validateRpc()
export class GatekeeperLoopback extends WorkerEntrypoint<Cloudflare.Env, GatekeeperLoopbackProps> {
  // The pipelined session RPC every call forwards to, opened once per instance. Property access
  // on the un-awaited promise pipelines (see AGENTS.md): forward() resolves each method stub off
  // it without waiting for the session to open.
  #session: Promise<any>;

  constructor(ctx: ExecutionContext<GatekeeperLoopbackProps>, env: Cloudflare.Env) {
    super(ctx, env);

    let ns = ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(ctx.props.overseerId));

    // @ts-ignore: LSP-only RPC types bug, "type instantiation is excessively deep"
    this.#session = stub.startGatekeeperSession(
        this.ctx.props.target, this.ctx.props.caller);

    let session = this.#session;
    return new Proxy(this, {
      get(target, prop, receiver) {
        // The declared RPC method and symbol probes resolve on the instance; everything else is
        // a session member. Note: We need `target`/`session` to be used as the receiver. If we
        // use `receiver`, we'll get an illegal invocation, as `receiver` points to our Proxy.
        // `forward` is consequently an unforwardable name: a session method literally named
        // "forward" would be shadowed (none exists today).
        if (typeof prop === "symbol" || prop === "forward") {
          return Reflect.get(target, prop, target);
        }
        let member = Reflect.get(session, prop, session);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => target.forward(String(prop), args);
      },
      getPrototypeOf(target) {
        return WorkerEntrypoint.prototype;
      },
    });
  }

  /**
   * Forwards one dynamically-dispatched call to the session, preserving pipelining by returning
   * the pipelined call's result without awaiting it. The arguments cross from gadget/agent code
   * (a separate trust domain from the session), so the surface is validated here for shape and
   * at the terminal session for meaning.
   */
  forward(methodName: string, args: unknown[]): unknown {
    let method: (...args: unknown[]) => unknown =
        Reflect.get(this.#session, methodName, this.#session);
    return method(...args);
  }
}

/** Split out of the former overseer.ts (internal helper). */
export type GatekeeperHookLoopbackProps = {
  overseerId: string;
  hookId: number;
};

/**
 * The per-hook WorkerEntrypoint a gatekeeper's HookInitiator binding resolves to (see
 * bindHook in workshop-shared/gatekeeper.ts): it hands each firing the callback and the
 * ApprovalQueue for logging observations and actions, both straight from the Overseer.
 *
 * Deliberately NOT @validateRpc()-decorated, unlike the other loopback surfaces: the decorator's
 * transform breaks the workerd stub this entrypoint returns for startHook()'s ApprovalQueue --
 * the receiving gatekeeper's authorizeObservation() call then dies with "The RPC receiver does
 * not implement the method" (pinned by the integration suite's hook tests). There is nothing to
 * validate anyway: startHook() takes no arguments, and capnweb-validate 0.3.0 does not validate
 * server-side return values.
 */
export class GatekeeperHookLoopback
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperHookLoopbackProps>
    implements HookInitiator<RpcTarget> {
  startHook(): Promise<
      {callback: NativeRpcStub<RpcTarget>, approvalQueue: NativeRpcStub<ApprovalQueue>}> {
    let ns = this.ctx.exports.OverseerDurableObject;
    let overseer: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));

    // Get an ApprovalQueue for this hook invocation from the overseer.
    // @ts-ignore seems the RPC types aren't working here
    return overseer.startHook(this.ctx.props.hookId);
  }
}

type AgentSelfLoopbackProps = {
  overseerId: string;
  chatId: number;
  initiatorUserId: string;
  initiatorModelId: string | null;  // null for a callable agent whose spawner has no model
};

/**
 * The `self` magic object passed to code executed via the agent's `executeCode` tool, and the
 * stub returned by an agent spawner's spawnCallable(). Calling any method on it (e.g.,
 * self.foo(123)) delivers a callback message to the chat thread and activates the agent to
 * respond. The call resolves once the callback is durably recorded and returns nothing; the
 * arguments must be storable (any RPC stubs among them must be persistent stubs). This is a
 * WorkerEntrypoint so it produces a Fetcher that can be passed over RPC and stored in Durable
 * Object KV storage.
 *
 * The wire protocol is dynamic dispatch -- callers name any method -- so the constructor installs
 * a Proxy whose only job is translating `stub.<methodName>(...args)` onto the one declared,
 * @validateRpc()-validated method below, deliverCallback(), which is the entire forwarding
 * implementation. `deliverCallback` is therefore a reserved name: a callback literally named
 * "deliverCallback" would reach the method instead of being recorded.
 * TODO: Would be awesome if the agent could pass a sub-object like `self.foo`, and then be told
 *   later e.g. "foo.callback() was called". This requires that we implement RpcPromise
 *   serializability in the built-in RPC system, matching Cap'n Web.
 */
@validateRpc()
export class AgentSelfLoopback
    extends WorkerEntrypoint<Cloudflare.Env, AgentSelfLoopbackProps> {
  #overseer: DurableObjectStub<OverseerDurableObject>;

  constructor(ctx: ExecutionContext<AgentSelfLoopbackProps>, env: Cloudflare.Env) {
    super(ctx, env);

    let ns = ctx.exports.OverseerDurableObject;
    this.#overseer = ns.get(ns.idFromString(ctx.props.overseerId));

    return new Proxy<AgentSelfLoopback>(<any>this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop === 'deliverCallback') {
          return Reflect.get(target, prop, target);
        }
        return (...args: unknown[]) => target.deliverCallback(String(prop), args);
      },
      getPrototypeOf(target) {
        return WorkerEntrypoint.prototype;
      },
    });
  }

  /** Delivers one `self.<methodName>(...args)` call to the chat thread (see class docs). */
  deliverCallback(methodName: string, args: unknown[]): Promise<void> {
    let { chatId, initiatorUserId, initiatorModelId } = this.ctx.props;
    return this.#overseer.deliverAgentCallback(
        chatId, methodName, args, initiatorUserId, initiatorModelId);
  }
}

/** Split out of the former overseer.ts (internal helper). */
export type GadgetTailLoopbackProps = {
  chatId?: number;

  // Which gadget's worker these logs come from.
  gadgetId: WorkpieceId;

  overseerId: string;
};

/**
 * What a loaded gadget's tail worker (old-style `tail` or streaming `tailStream`) delivers to.
 * The workerd runtime invokes these lifecycle entrypoints, which capnweb-validate deliberately
 * passes through unvalidated; the decorator still covers any other method this class ever grows.
 */
@validateRpc()
export class GadgetTailLoopback extends WorkerEntrypoint<Cloudflare.Env, GadgetTailLoopbackProps> {
  async #deliver(logs: ConsoleLogEvent[]) {
    let ns = this.ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));
    await stub.deliverGadgetLogs(this.ctx.props.chatId ?? null, logs);
  }

  /**
   * New-style streaming tail worker. Delivers gadget console logs to the product UI in real time.
   * Do not console.log the tail events here — they spam wrangler dev and are not ops logs.
   */
  tailStream(event: TailStream.TailEvent<TailStream.Onset>)
      : TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType> {
    return {
      log: (event: TailStream.TailEvent<TailStream.Log>) => {
        let log: ConsoleLogEvent = {
          timestamp: new Date(event.timestamp),
          level: event.event.level,
          message: event.event.message as any[]
        }
        return this.#deliver([log]);
      },

      exception: (event: TailStream.TailEvent<TailStream.Exception>) => {
        let log: ConsoleLogEvent = {
          timestamp: new Date(event.timestamp),
          level: "error",
          message: [event.event.message, event.event.stack]
        }
        return this.#deliver([log]);
      },
    };
  }

  /**
   * Old-style tail worker. Logs are delayed until the end of the RPC event, which can be annoying
   * for calls that do things like register subscriptions.
   */
  async tail(events: TraceItem[]) {
    if (events.length != 1) {
      logger.error("unexpected gadget trace size", {
        event: "gadget.trace.size.unexpected",
        gadgetId: this.ctx.props.overseerId,
        chatId: this.ctx.props.chatId,
        size: events.length,
      });
      return;
    }

    let event: TraceItem = events[0];

    // HACK: Convert trace to serializable value by round-tripping to JSON.
    // TODO: Make traces serializable in workerd.
    event = JSON.parse(JSON.stringify(event));

    let logs: ConsoleLogEvent[] = event.logs.map(log => {
      let result: ConsoleLogEvent = {
        timestamp: new Date(log.timestamp),
        level: log.level as ConsoleLogEvent["level"],
        message: log.message,
      };
      return result;
    });

    for (let err of event.exceptions) {
      // Pretend errors were logged using console.error().
      logs.push({
        timestamp: new Date(err.timestamp),
        level: "error",
        message: [err.message],
      });
    }

    await this.#deliver(logs);
  }
}

type CodeModeLoopbackProps = {
  executionId: string;
  overseerId: string;
};

/**
 * What an executeCode run's tail worker delivers its trace to. As with GadgetTailLoopback, the
 * runtime-invoked `tail` here is a capnweb-validate passthrough; the decorator covers any other
 * method this class ever grows.
 */
@validateRpc()
export class CodeModeTailLoopback extends WorkerEntrypoint<Cloudflare.Env, CodeModeLoopbackProps> {
  // TODO: Use tailStream here, but see comment in GadgetTailLoopback about excessive log spam
  //   on workerd console, need to fix that first.

  async tail(events: TraceItem[]) {
    if (events.length != 1) {
      logger.error("unexpected code mode trace size", {
        event: "code.mode.trace.size.unexpected",
        gadgetId: this.ctx.props.overseerId,
        executionId: this.ctx.props.executionId,
        size: events.length,
      });
      return;
    }

    let event: TraceItem = events[0];
    if (event.event && ("rpcMethod" in event.event) && event.event.rpcMethod === "verify") {
      // ignore verify() call
      return;
    }

    // HACK: Convert trace to serializable value by round-tripping to JSON.
    // TODO: Make traces serializable in workerd.
    event = JSON.parse(JSON.stringify(event));

    let ns = this.ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));
    await stub.deliverCodeModeTrace(this.ctx.props.executionId, event);
  }
}
