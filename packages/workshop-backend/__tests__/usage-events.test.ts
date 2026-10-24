// The SAAS_USAGE_EVENTS port is the seam a hosted deployment meters model usage through (see
// src/usage-events.ts and @gadgets/workshop-shared/usage-events). These tests pin its
// contract: emission is a synchronous no-op when no port is bound (every OSS deployment —
// byte-identical behavior, no RPC), fire-and-forget when one is (a failing port is logged and
// dropped, never thrown into the model-call path), the dedupe id is derived from the gateway
// log id when one exists, and the chat emission seam (OverseerPublishing.addChatMessages, the
// accounting barrier every agent step crosses) delivers the exact payload the billing side
// meters.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {fauxAssistantMessage, fauxText} from "@earendil-works/pi-ai";
import type {Usage} from "@earendil-works/pi-ai";
import type {UsageEvent} from "@gadgets/workshop-shared/usage-events";
import type {OverseerDurableObject} from "../src/overseer";
import {emitUsageEvent, usageEventId, usageTokens} from "../src/usage-events.js";
import {makeStoredAssistantMessage} from "../src/agent.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    SAAS_USAGE_EVENTS: Service<{
      recordUsage(event: UsageEvent): Promise<"queued">;
      events(): Promise<UsageEvent[]>;
      reset(): Promise<void>;
    }>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// pi Usage as a real provider reports it: the four base classes plus both optional splits.
function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 11, cacheRead: 13, cacheWrite: 17, output: 19,
    cacheWrite1h: 7, reasoning: 5, totalTokens: 60,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    ...overrides,
  };
}

describe("usageTokens", () => {
  it("carries the four base classes and the splits pi reported", () => {
    expect(usageTokens(usage())).toStrictEqual({
      input: 11, cacheRead: 13, cacheWrite: 17, output: 19, cacheWrite1h: 7, reasoning: 5,
    });
  });

  it("omits the optional splits a provider did not report rather than zeroing them", () => {
    const {cacheWrite1h, reasoning, ...base} = usage();
    expect(usageTokens(base)).toStrictEqual({input: 11, cacheRead: 13, cacheWrite: 17, output: 19});
  });
});

describe("usageEventId", () => {
  it("keys the id to the gateway log, so a replayed emission deduplicates", () => {
    expect(usageEventId("log-7")).toBe("gw:log-7");
    expect(usageEventId(undefined)).toMatch(/^rnd:/);
    expect(usageEventId(undefined)).not.toBe(usageEventId(undefined));
  });
});

describe("emitUsageEvent", () => {
  it("is a synchronous no-op with no port bound: no RPC, no throw", () => {
    // `{}` is every OSS deployment's env: the binding is simply absent (undefined), so there
    // is no port to call and nothing can throw — reading the missing binding is the only work.
    expect(() =>
        emitUsageEvent({} as Cloudflare.Env, {modelId: "m", tokens: usageTokens(usage()),
            userId: "u", surface: "chat"})).not.toThrow();
  });

  it("fires the port fire-and-forget: a failing port never throws into the caller", async () => {
    const calls: UsageEvent[] = [];
    const failing = {
      recordUsage: async (event: UsageEvent) => { calls.push(event); throw new Error("port down"); },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
        emitUsageEvent({SAAS_USAGE_EVENTS: failing} as unknown as Cloudflare.Env,
            {modelId: "m", tokens: usageTokens(usage()), userId: "u", surface: "binding"}))
        .not.toThrow();
    // The rejection and the catch that handles it are both microtasks; drain the queue
    // deterministically rather than sleeping (no wall-clock timer is involved).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("derives the dedupe id from the gateway log id when the event carries one", async () => {
    await env.SAAS_USAGE_EVENTS.reset();
    emitUsageEvent(env, {
      modelId: "m", tokens: usageTokens(usage()), userId: "u", aiGatewayLogId: "log-9",
      surface: "chat",
    });
    await vi.waitFor(async () => expect(await env.SAAS_USAGE_EVENTS.events()).toHaveLength(1));
    const [event] = await env.SAAS_USAGE_EVENTS.events();
    expect(event!.id).toBe("gw:log-9");
    expect(event!.aiGatewayLogId).toBe("log-9");
    expect(event!.tokens).toStrictEqual(usageTokens(usage()));
  });
});

// The chat seam: addChatMessages is the accounting barrier every agent step crosses, with the
// usage, the model of the step's snapshot, the chat, the owner, and the gateway log id in
// scope. The event must fire exactly once per step with that payload — fire-and-forget, so the
// barrier itself stays synchronous.
describe("addChatMessages emission", () => {
  beforeEach(() => env.SAAS_USAGE_EVENTS.reset());

  async function inKernel<T>(test: (impl: OverseerDurableObject["impl"]) => Promise<T>):
      Promise<T> {
    return await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()),
        async instance => {
          const impl = instance.impl, timestamp = impl.getChatTimestamp();
          impl.storage.chatMeta.put({id: 1, title: "Usage", started: timestamp, lastActive: timestamp});
          impl.ownerId = "owner-1";
          return await test(impl);
        });
  }

  it("emits one event with the step's model, tokens, owner, chat, and gateway log id", async () => {
    await inKernel(async impl => {
      impl.addChatMessages(1, {type: "agent", id: "faux-1", name: "Faux"}, [
        {type: "message", message: "done",
         modelData: makeStoredAssistantMessage(fauxAssistantMessage(fauxText("ok")))},
      ], usage(), "gw-log-1");
    });
    await vi.waitFor(async () => expect(await env.SAAS_USAGE_EVENTS.events()).toHaveLength(1));
    const [event] = await env.SAAS_USAGE_EVENTS.events();
    expect(event).toStrictEqual({
      id: "gw:gw-log-1",
      modelId: "faux-1",
      tokens: usageTokens(usage()),
      userId: "owner-1",
      chatId: 1,
      aiGatewayLogId: "gw-log-1",
      surface: "chat",
    });
  });

  it("emits nothing for a step without usage, without token spend, or without an owner", async () => {
    await inKernel(async impl => {
      const author = {type: "agent" as const, id: "faux-1", name: "Faux"};
      const msgs = [{
        type: "message" as const, message: "done",
        modelData: makeStoredAssistantMessage(fauxAssistantMessage(fauxText("ok"))),
      }];
      impl.addChatMessages(1, author, msgs);                          // no usage at all
      impl.addChatMessages(1, author, msgs, usage({input: 0, cacheRead: 0, cacheWrite: 0,
          output: 0, totalTokens: 0}));                                // usage but no spend
      impl.ownerId = undefined;                                       // pre-ownership workspace
      impl.addChatMessages(1, author, msgs, usage());                 // spend but no owner
    });
    // Fire-and-forget is the contract: the emission exposes no promise to await, so absence
    // can only be observed after the RPC channel has had time to deliver. Deterministic time
    // control is impossible across isolates; this single short delay is the honest bound.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await env.SAAS_USAGE_EVENTS.events()).toEqual([]);
  });
});
