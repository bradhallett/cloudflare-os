// A mid-alarm eviction consumes the keep-alive alarm without re-arming it (runAlarmTasks'
// success-path recompute never ran). The fresh constructor's resume sweep then retries each
// interrupted agent; a transient prepare failure -- the user DO is itself restarting -- parks the
// record silently for the next sweep. Two re-arm paths must hold: the alarm loop's resumeErrors
// rethrow relies on the platform retrying, and once that budget is spent the finally clause arms
// a fresh wake-up itself; a park outside the alarm handler (the constructor sweep) arms directly
// via #updateAlarm, which still counts the parked record as agent work. This test drives the
// alarm-context park end to end and pins the spent-retry-budget re-arm.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

interface OverseerInternals {
  ctx: DurableObjectState;
  ownerId: string;
  users: unknown;
  getChatTimestamp(): Date;
  runAlarmTasks(retryCount?: number): Promise<void>;
  storage: {
    chatMeta: { put(meta: object): void; get(id: number): { activeAgent?: object } | undefined };
    chats: { put(message: AiChatMessage): void; list(): Iterable<AiChatMessage> };
    activeAgents: {
      put(record: object): void;
      get(id: number): { chatId: number; resumeAttempts?: number } | undefined;
    };
  };
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const PROFILE: AiChatAuthorInfo = { type: "agent", id: "m1", name: "Model" };

let doCounter = 0;

describe("resume retry after a transient prepare failure", () => {
  it("parks silently and re-arms the alarm once the retry budget is spent", {timeout: 20000},
      async () => {
    let name = `resume-retry-alarm-${++doCounter}`;
    let stub = env.TEST_OVERSEER.getByName(name);
    await runInDurableObject(stub, async (instance) => {
      let impl = (instance as unknown as { impl: OverseerInternals }).impl;
      impl.ownerId = "owner-1";
      // The user DO is "also restarting": every getChatContext rejects with the DO-reset shape,
      // so the resume's prepare step fails transiently and takes the silent-park path.
      impl.users = {
        idFromString: (id: string) => id,
        get: () => ({
          getChatContext: async () => {
            throw Object.assign(new Error("simulated user DO reset"), { durableObjectReset: true });
          },
          listBots: async () => [],
          setGadgetLastActive: async () => {},
        }),
      } as unknown as OverseerInternals["users"];
      let t0 = impl.getChatTimestamp();
      let t1 = impl.getChatTimestamp();
      impl.storage.chatMeta.put(
          { id: 1, title: "Chat", started: t0, lastActive: t1, activeAgent: PROFILE } as object);
      impl.storage.chats.put({
        chatId: 1, sequence: 0, timestamp: t1, author: OWNER, type: "message", message: "Hi",
      });
      impl.storage.activeAgents.put({
        chatId: 1, modelId: "m1", initiator: OWNER, initiatorUserId: "owner-1",
        callbackInitiated: false,
      } as object);
      // The alarm handler's sweep resumes the record; the transient prepare failure parks it and
      // the handler rethrows (resumeErrors) for the platform's alarm retry. At the last retry
      // the finally clause must arm a fresh wake-up itself.
      await impl.runAlarmTasks(6).catch(() => {});
    });
    let out = await runInDurableObject(stub, async (instance) => {
      let impl = (instance as unknown as { impl: OverseerInternals }).impl;
      let messages = [...impl.storage.chats.list()].filter(m => m.chatId === 1);
      return {
        parked: impl.storage.activeAgents.get(1)?.resumeAttempts === 1,
        markerKept: impl.storage.chatMeta.get(1)?.activeAgent !== undefined,
        errorVisible: messages.some(m => m.type === "error"),
        alarm: await impl.ctx.storage.getAlarm(),
      };
    });
    // The record parked silently -- no chat-visible error, marker kept for the retry -- and the
    // spent-budget path re-armed the alarm, so the next sweep actually runs.
    expect(out.parked).toBe(true);
    expect(out.markerKept).toBe(true);
    expect(out.errorVisible).toBe(false);
    expect(out.alarm).not.toBeNull();
  });
});
