import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";

import type { FailedChatSend } from "./failedSends";
import {
  buildChatDisplayEntries,
  continuesUserGroup,
  isUserMessageEntry,
  rhythmTopClass,
} from "./chatDisplayEntries";

const AGENT = { type: "agent", id: "model-a", name: "Agent" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AGENT, ...body };
}

function userMessage(sequence: number, text: string, userId = "user-1"): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp: new Date(sequence * 1000),
    author: { type: "user", id: userId, name: userId },
    type: "message",
    message: text,
  };
}

function failedSend(id: string): FailedChatSend {
  return {
    id,
    chatId: 1,
    timestamp: new Date(),
    payload: { message: "never arrived", modelId: null },
  };
}

describe("buildChatDisplayEntries with failed sends", () => {
  it("appends failed sends as bubbles after every durable message", () => {
    const first = failedSend("a");
    const second = failedSend("b");
    const entries = buildChatDisplayEntries(
      [message(1, { type: "message", message: "answer" })],
      new Map(),
      [],
      undefined,
      [first, second],
    );

    expect(entries.map((e) => e.type)).toEqual(["message", "failedSend", "failedSend"]);
    expect(entries[1]).toMatchObject({ key: "failed-a", send: first });
    expect(entries[2]).toMatchObject({ key: "failed-b", send: second });
  });

  it("renders no failedSend entries when none are given", () => {
    const entries = buildChatDisplayEntries([message(1, { type: "message", message: "hi" })], new Map());
    expect(entries.map((e) => e.type)).toEqual(["message"]);
  });
});

describe("failed-send spacing", () => {
  it("reads a failed send as one of the user's messages", () => {
    const entry = buildChatDisplayEntries([], new Map(), [], undefined, [failedSend("a")])[0];
    expect(isUserMessageEntry(entry)).toBe(true);
  });

  it("never groups a failed send with surrounding user messages", () => {
    const prev = { type: "message", key: "m1", message: userMessage(1, "hi") } as const;
    const send = { type: "failedSend", key: "failed-a", send: failedSend("a") } as const;
    const next = { type: "message", key: "m2", message: userMessage(2, "again") } as const;
    expect(continuesUserGroup(prev as never, send as never)).toBe(false);
    expect(continuesUserGroup(send as never, next as never)).toBe(false);
  });

  it("spaces a failed send from an agent message like any user message", () => {
    const agent = { type: "message", key: "m1", message: message(1, { type: "message", message: "answer" }) } as const;
    const send = { type: "failedSend", key: "failed-a", send: failedSend("a") } as const;
    expect(rhythmTopClass(agent as never, send as never)).toBe("mt-5");
  });
});
