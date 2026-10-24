// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  entrySequenceId,
  latestUserMessageEntry,
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
