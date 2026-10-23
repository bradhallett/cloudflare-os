// The Overseer's five loopback surfaces (review finding C4 / kernel F4) all carry @validateRpc().
// For the two dynamic-dispatch classes (GatekeeperLoopback, AgentSelfLoopback) every call now
// flows through the one declared, validated method (forward/deliverCallback), so malformed
// arguments are rejected by validation before the loopback body runs -- exactly what the
// undecorated surfaces lacked. capnweb-validate is deliberately NOT mocked here, so importing
// overseer.ts compiles the generated validators (the commit-reads.test.ts pattern).
//
// The other three have no argument surface validation can reject: startHook() takes no
// arguments, and the tail loopbacks' tail/tailStream are workerd lifecycle entrypoints that
// capnweb-validate passes through unvalidated by design; their tests cover delivery (and that
// decorating the class does not disturb the lifecycle wiring).
//
// The loopbacks are constructed directly with a fake Overseer namespace: their forwarding is plain
// JavaScript from the constructor's Proxy to the Overseer stub, so no workerd RPC pool is needed --
// and unlike the old all-Proxy surfaces, the declared methods are resolvable on the prototype, so
// the classes stay exercisable even where the pool emulates RPC by prototype lookup.

/// <reference path="../worker-configuration.d.ts" />

import { describe, expect, it } from "vitest";
import {
  AgentSelfLoopback,
  CodeModeTailLoopback,
  GatekeeperHookLoopback,
  GatekeeperLoopback,
  GadgetTailLoopback,
} from "../src/overseer.js";

// One recorded call to the fake Overseer DO stub.
type Call = { method: string, args: unknown[] };

// A fake Overseer DO stub: each named method records its arguments and delegates to `handlers`.
// Everything the loopbacks do with the stub is plain calls, so no further emulation is needed.
function recordingOverseer(handlers: Record<string, (...args: never[]) => unknown>) {
  let calls: Call[] = [];
  let stub: Record<string, unknown> = {};
  for (let [method, handler] of Object.entries(handlers)) {
    stub[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return handler(...(args as never[]));
    };
  }
  return { stub, calls };
}

// The ExecutionContext shape the loopback constructors consume: props identifying the Overseer and
// target, plus the exports namespace the constructor resolves the Overseer DO through.
function fakeCtx(props: object, stub: Record<string, unknown>): never {
  return {
    props,
    exports: {
      OverseerDurableObject: {
        idFromString: (id: string) => ({ id }),
        get: () => stub,
      },
    },
  } as never;
}

// Captures however a malformed call surfaces -- validators may throw synchronously or reject.
async function outcome(fn: () => unknown): Promise<unknown> {
  try {
    await Promise.resolve().then(fn);
    return undefined;
  } catch (err) {
    return err;
  }
}

const PROPS = { overseerId: "ov1" };

describe("GatekeeperLoopback", () => {
  function make(target = { type: "git" }, caller = { from: "agent", chatId: 7 }) {
    let sessionCalls: Call[] = [];
    let session = {
      postMessage: (text: string) => {
        sessionCalls.push({ method: "postMessage", args: [text] });
        return `sent:${text}`;
      },
      ready: false,
    };
    let { stub, calls } = recordingOverseer({
      startGatekeeperSession: () => session,
    });
    let loopback = new GatekeeperLoopback(
        fakeCtx({ ...PROPS, target, caller }, stub), {} as never);
    return { loopback, calls, sessionCalls };
  }

  it("forwards dynamically-dispatched calls through the declared forward() method", () => {
    let { loopback, sessionCalls } = make();

    // The public wire protocol: any session method name, invoked directly on the binding.
    expect((loopback as unknown as { postMessage(text: string): string }).postMessage("hi"))
        .toBe("sent:hi");
    expect(sessionCalls).toEqual([{ method: "postMessage", args: ["hi"] }]);

    // Non-function session members (property reads) pass through untouched.
    expect((loopback as unknown as { ready: boolean }).ready).toBe(false);
    expect(sessionCalls).toEqual([{ method: "postMessage", args: ["hi"] }]);
  });

  it("opens the session once with this loopback's props", () => {
    let { calls } = make();
    expect(calls.map(call => call.method)).toEqual(["startGatekeeperSession"]);
  });

  it("rejects malformed forward() calls by validation, before the session is touched", async () => {
    let { loopback, sessionCalls } = make();
    let loopbackAny = loopback as unknown as Record<string, (...args: unknown[]) => unknown>;

    let err = (await outcome(() => loopbackAny.forward("postMessage", "not an array"))) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("capnweb-validate");
    err = (await outcome(() => loopbackAny.forward(123, []))) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("capnweb-validate");

    expect(sessionCalls).toEqual([]);
  });
});

describe("AgentSelfLoopback", () => {
  const PROPS = {
    overseerId: "ov1",
    chatId: 5,
    initiatorUserId: "user-1",
    initiatorModelId: "model-1",
  };

  function make() {
    let { stub, calls } = recordingOverseer({
      deliverAgentCallback: () => Promise.resolve(),
    });
    let loopback = new AgentSelfLoopback(fakeCtx(PROPS, stub), {} as never);
    return { loopback, calls };
  }

  it("delivers any method name with its arguments to the chat thread", async () => {
    let { loopback, calls } = make();

    await (loopback as unknown as { composeEmail(...args: unknown[]): Promise<void> })
        .composeEmail("a@example.com", { draft: true });
    expect(calls).toEqual([{
      method: "deliverAgentCallback",
      args: [5, "composeEmail", ["a@example.com", { draft: true }], "user-1", "model-1"],
    }]);
  });

  it("rejects malformed deliverCallback() calls by validation, before anything is delivered",
      async () => {
    let { loopback, calls } = make();
    let loopbackAny = loopback as unknown as Record<string, (...args: unknown[]) => unknown>;

    let err = (await outcome(() => loopbackAny.deliverCallback("m", "not an array"))) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("capnweb-validate");
    err = (await outcome(() => loopbackAny.deliverCallback(42, []))) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("capnweb-validate");

    expect(calls).toEqual([]);
  });
});

describe("GatekeeperHookLoopback", () => {
  it("startHook() resolves the hook callback and approval queue from the overseer", async () => {
    let pair = { callback: {}, approvalQueue: {} };
    let { stub, calls } = recordingOverseer({ startHook: () => pair });
    let loopback =
        new GatekeeperHookLoopback(fakeCtx({ ...PROPS, hookId: 3 }, stub), {} as never);

    // Not `toBe`: the validator wraps resolved stub-typed returns, so identity is not preserved.
    expect(await loopback.startHook()).toEqual(pair);
    expect(calls).toEqual([{ method: "startHook", args: [3] }]);
  });

  // No malformed-call rejection test: startHook() takes no arguments (extra arguments are
  // dropped by validation), and capnweb-validate 0.3.0 does not validate server-side return
  // values, so there is no argument surface here for validation to reject.
});

const TRACE: TraceItem = {
  event: null,
  eventTimestamp: null,
  logs: [{ timestamp: 1700000000000, level: "log", message: ["hello", 1] }],
  exceptions: [{ timestamp: 1700000000001, message: "boom", name: "Error" }],
  diagnosticsChannelEvents: [],
  scriptName: "gadget",
  outcome: "ok",
  executionModel: "stateless",
  truncated: false,
  cpuTime: 1,
  wallTime: 2,
};

describe("GadgetTailLoopback", () => {
  function make(chatId = 9) {
    let { stub, calls } = recordingOverseer({
      deliverGadgetLogs: () => Promise.resolve(),
    });
    let loopback =
        new GadgetTailLoopback(fakeCtx({ ...PROPS, gadgetId: "g1", chatId }, stub), {} as never);
    return { loopback, calls };
  }

  it("tail(events) delivers the trace's logs and exceptions as console events", async () => {
    let { loopback, calls } = make();

    await loopback.tail([TRACE]);
    expect(calls).toEqual([{
      method: "deliverGadgetLogs",
      args: [9, [
        { timestamp: new Date(1700000000000), level: "log", message: ["hello", 1] },
        { timestamp: new Date(1700000000001), level: "error", message: ["boom"] },
      ]],
    }]);
  });

  // No malformed-call rejection tests here: tail/tailStream are workerd lifecycle entrypoints
  // that capnweb-validate passes through unvalidated (see the class doc comment).

  it("tailStream(event) returns handlers that deliver streamed logs", async () => {
    let { loopback, calls } = make();

    let handlers = await loopback.tailStream({
      invocationId: "inv",
      spanContext: { traceId: "t", spanId: "s" },
      timestamp: new Date(0),
      sequence: 0,
      event: {
        type: "onset",
        attributes: [],
        spanId: "s",
        executionModel: "stateless",
        info: { type: "jsrpc" },
      },
    });
    if (typeof handlers !== "object" || typeof handlers.log !== "function") {
      throw new Error("tailStream must return an object with a log handler");
    }

    await handlers.log({
      invocationId: "inv",
      spanContext: { traceId: "t", spanId: "s" },
      timestamp: new Date(0),
      sequence: 1,
      event: { type: "log", level: "info", message: ["streamed"] },
    });
    expect(calls).toEqual([{
      method: "deliverGadgetLogs",
      args: [9, [{ timestamp: new Date(0), level: "info", message: ["streamed"] }]],
    }]);
  });
});

describe("CodeModeTailLoopback", () => {
  function make() {
    let { stub, calls } = recordingOverseer({
      deliverCodeModeTrace: () => Promise.resolve(),
    });
    let loopback =
        new CodeModeTailLoopback(fakeCtx({ ...PROPS, executionId: "e1" }, stub), {} as never);
    return { loopback, calls };
  }

  it("tail(events) delivers the single trace to the overseer", async () => {
    let { loopback, calls } = make();

    await loopback.tail([TRACE]);
    expect(calls).toEqual([{ method: "deliverCodeModeTrace", args: ["e1", TRACE] }]);
  });

  it("does not deliver the executeCode verify() round trip", async () => {
    let { loopback, calls } = make();

    await loopback.tail([{ ...TRACE, event: { type: "jsrpc", rpcMethod: "verify" } }]);
    expect(calls).toEqual([]);
  });

});
