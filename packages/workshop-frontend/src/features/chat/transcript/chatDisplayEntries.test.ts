// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";

import type { FailedChatSend } from "./failedSends";
import {
  buildChatDisplayEntries,
  continuesUserGroup,
  entrySequenceId,
  isUserMessageEntry,
  latestUserMessageEntry,
  rhythmTopClass,
  type ChatDisplayEntry,
} from "./chatDisplayEntries";

const agentMessage = (sequence: number): ChatDisplayEntry =>
  ({
    type: "message",
    key: `agent-${sequence}`,
    message: {
      type: "message",
      sequence,
      author: { type: "agent", id: "model", name: "Model" },
    },
  }) as unknown as ChatDisplayEntry;

const userMessage = (sequence: number, id = "me"): ChatDisplayEntry =>
  ({
    type: "message",
    key: `user-${sequence}`,
    message: {
      type: "message",
      sequence,
      author: { type: "user", id, name: "Me" },
    },
  }) as unknown as ChatDisplayEntry;

const workRun = (lastMessageSequence: number): ChatDisplayEntry =>
  ({
    type: "workRun",
    key: `work-${lastMessageSequence}`,
    toolCalls: [],
    observations: [],
    toolCallGroups: [],
    lastMessageSequence,
    lastMessageTimestamp: new Date(),
  }) as unknown as ChatDisplayEntry;

describe("entrySequenceId", () => {
  it("reads the newest message each row type stands in for", () => {
    expect(entrySequenceId(agentMessage(7))).toBe(7);
    expect(entrySequenceId(workRun(12))).toBe(12);
    expect(
      entrySequenceId({
        type: "modelChange",
        key: "m",
        author: { type: "agent", id: "model", name: "Model" },
        sequence: 3,
      }),
    ).toBe(3);
    expect(
      entrySequenceId({
        type: "compactionBoundary",
        key: "c",
        boundary: { to: 5, summary: "summarized" },
      } as ChatDisplayEntry),
    ).toBe(5);
    expect(
      entrySequenceId({
        type: "compactionCut",
        key: "cc",
        boundary: { to: 5, summary: "summarized" },
      } as ChatDisplayEntry),
    ).toBe(5);
  });
});

describe("latestUserMessageEntry", () => {
  it("finds the newest user message row", () => {
    const entries = [
      userMessage(1),
      agentMessage(2),
      userMessage(3),
      agentMessage(4),
    ];
    expect(latestUserMessageEntry(entries)).toEqual({ key: "user-3", sequence: 3 });
  });

  it("skips rows that are not the user's own messages", () => {
    expect(latestUserMessageEntry([agentMessage(1), workRun(2)])).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(latestUserMessageEntry([])).toBeNull();
  });
});

const AGENT = { type: "agent", id: "model-a", name: "Agent" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AGENT, ...body };
}

function durableUserMessage(sequence: number, text: string, userId = "user-1"): AiChatMessage {
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
    const prev = { type: "message", key: "m1", message: durableUserMessage(1, "hi") } as const;
    const send = { type: "failedSend", key: "failed-a", send: failedSend("a") } as const;
    const next = { type: "message", key: "m2", message: durableUserMessage(2, "again") } as const;
    expect(continuesUserGroup(prev as never, send as never)).toBe(false);
    expect(continuesUserGroup(send as never, next as never)).toBe(false);
  });

  it("spaces a failed send from an agent message like any user message", () => {
    const agent = { type: "message", key: "m1", message: message(1, { type: "message", message: "answer" }) } as const;
    const send = { type: "failedSend", key: "failed-a", send: failedSend("a") } as const;
    expect(rhythmTopClass(agent as never, send as never)).toBe("mt-5");
  });
});
