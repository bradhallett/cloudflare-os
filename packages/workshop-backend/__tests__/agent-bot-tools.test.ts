// The bot-conditional tool installs are siblings of the built-in table, not nested inside the
// spawned-agent filter: a bot chat (botConfig set, spawnerConfig unset) must be offered
// activateSkill, and a chat whose initiator has bots must be offered delegateToBot/messageBot,
// while a plain chat gets neither. Drives the real runAgent against a real OverseerImpl with
// pi's faux provider, inspecting the tools each step is offered.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { runAgent } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "bot-tools-owner";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 4;

let doCounter = 0;

async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`agent-bot-tools-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => ({ profile: OWNER }) }),
    };
    impl.startAgent = () => {};
    await fn(impl);
  });
}

function seedChat(
    impl: any,
    {botConfig, delegatableBots}: {
      botConfig?: object,
      delegatableBots?: {key: string, name: string, description?: string}[],
    } = {}): void {
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
    author: OWNER, type: "message", message: "Hi",
  });
  if (botConfig !== undefined) {
    impl.storage.chatContext.put({chatId: CHAT_ID, botConfig: botConfig as any});
  }
  if (delegatableBots !== undefined) {
    impl.listDelegatableBots = async () => delegatableBots;
  }
}

// Runs one agent turn whose model answers immediately, returning the tool names it was offered.
async function offeredTools(impl: any): Promise<string[]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let offered: string[] | undefined;
  faux.setResponses([fauxAssistantMessage(fauxText("Done."))].map(step => (context: TranscriptContext) => {
    offered = getCurrentTools(context.messages).map(tool => tool.name).toSorted();
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  if (offered === undefined) throw new Error("the model was never offered tools");
  return offered;
}

function botConfigValue(): object {
  return {
    selection: { type: "user", userId: "bot-owner" },
    name: "Chatbot",
    instructions: "Be helpful.",
    modelId: "faux-model",
    skills: [],
  };
}

describe("bot tool installs", () => {
  it("a bot chat is offered activateSkill", () => withImpl(async impl => {
    seedChat(impl, {botConfig: botConfigValue()});
    expect(await offeredTools(impl)).toContain("activateSkill");
  }));

  it("a chat whose initiator has bots is offered delegateToBot and messageBot", () => withImpl(async impl => {
    seedChat(impl, {delegatableBots: [{key: "u:3", name: "Helper", description: "Helps."}]});
    let offered = await offeredTools(impl);
    expect(offered).toContain("delegateToBot");
    expect(offered).toContain("messageBot");
    expect(offered).not.toContain("activateSkill");
  }));

  it("a plain chat is offered neither bot tool", () => withImpl(async impl => {
    seedChat(impl);
    let offered = await offeredTools(impl);
    expect(offered).not.toContain("activateSkill");
    expect(offered).not.toContain("delegateToBot");
    expect(offered).not.toContain("messageBot");
  }));
});
