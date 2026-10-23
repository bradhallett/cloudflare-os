// The free quick-model calls a chat makes on the side -- thread titles, gadget titles, binding
// names -- pass the workspace owner's usage gate before reaching a model (see
// OverseerImpl.#allowQuickModelCall). When the owner's free tier is spent they are skipped
// silently; when allowed they proceed to the model step.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). The owner's user DO is
// replaced with a fake whose quota answer the test controls, and the model config is one whose
// getModel() throws synchronously, so "the call reached the model step" is observable as the
// generator's failure log event rather than a network request.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

// A Workers AI model with no credentials: getModel() throws synchronously, so a generator that
// gets past the gate fails at the model step and logs its failure event.
const BROKEN_MODEL_CONFIG = { provider: "cloudflare", model: "@cf/test/model", apiToken: "" };

let doCounter = 0;

// Runs `fn` against a fresh overseer whose limits flow is enabled and whose owner's user DO
// reports the given free-tier answer, recording how many calls were consumed and which failure
// events the generators logged.
function withQuota(
    withinLimits: boolean, fn: (impl: any) => Promise<void>,
): Promise<{ consumed: number, events: string[] }> {
  let stub = env.TEST_OVERSEER.getByName(`quick-model-gate-${++doCounter}`);
  return runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let events: string[] = [];
    impl.logger = {
      warn: (_msg: string, fields: { event: string }) => { events.push(fields.event); },
      debug: () => {}, info: () => {}, error: () => {},
    };
    let consumed = 0;
    impl.ownerId = OWNER_USER_ID;
    impl.env = { ...impl.env, ENABLE_CLOUDFLARE_LIMITS: "true" };
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        getChatContext: async () => ({ profile: OWNER }),
        getCloudflareGatekeeperAccount: async () => null,
        consumeDailyLlmCall: async (limit: number) => {
          consumed++;
          const used = withinLimits ? limit - 1 : limit;
          return { withinLimits, remaining: limit - used, limit, used, resetAt: "..." };
        },
      }),
    };
    await fn(impl);
    return { consumed, events };
  });
}

describe("quick-model usage gate", () => {
  it("skips thread-title generation once the owner's free tier is spent", async () => {
    let { consumed, events } = await withQuota(false, async (impl: any) => {
      impl.storage.chatMeta.put(
          { id: CHAT_ID, title: "New Chat", started: new Date(0), lastActive: new Date(0) });
      await impl.generateThreadTitle(CHAT_ID, "build me a calculator", BROKEN_MODEL_CONFIG, OWNER);
      // The title must survive unregenerated: the call was skipped before the model step.
      expect(impl.storage.chatMeta.get(CHAT_ID).title).toBe("New Chat");
    });
    expect(consumed).toBe(1);
    expect(events).toEqual([]);
  });

  it("lets thread-title generation reach the model step while the free tier lasts", async () => {
    let { consumed, events } = await withQuota(true, async (impl: any) => {
      impl.storage.chatMeta.put(
          { id: CHAT_ID, title: "New Chat", started: new Date(0), lastActive: new Date(0) });
      await impl.generateThreadTitle(CHAT_ID, "build me a calculator", BROKEN_MODEL_CONFIG, OWNER);
    });
    expect(consumed).toBe(1);
    // The broken model config throws once the gate lets the call through.
    expect(events).toEqual(["chat.title.generate.failed"]);
  });

  it("skips gadget-title generation once the owner's free tier is spent", async () => {
    let { consumed, events } = await withQuota(false, async (impl: any) => {
      await impl.generateGadgetTitle(CHAT_ID, BROKEN_MODEL_CONFIG, OWNER);
    });
    expect(consumed).toBe(1);
    expect(events).toEqual([]);
  });

  it("skips binding-name generation once the owner's free tier is spent", async () => {
    let { consumed, events } = await withQuota(false, async (impl: any) => {
      let name = await impl.generateBindingName(
          "A document holding the quarterly plan", new Set(),
          { config: BROKEN_MODEL_CONFIG, initiator: OWNER });
      // Falls back to the caller's deterministic naming, not an error.
      expect(name).toBeUndefined();
    });
    expect(consumed).toBe(1);
    expect(events).toEqual([]);
  });
});
