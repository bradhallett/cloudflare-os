import { describe, expect, it } from "vitest";
import type { ExecuteEnvelope } from "../src/composio-api.js";
import {
  type AppliedResult,
  ComposioActionDeclinedError,
  ComposioNotDispatchedError,
  ComposioOutcomeUnknownError,
  settleExecute,
  settleTransportFailure,
} from "../src/settlement.js";
import { callMayHaveTakenEffect, McpCallNotDispatchedError } from "@gadgets/mcp-shared/client";

function envelopes() {
  return {
    completed: { resultType: "completed", result: { ok: true }, logId: "log-1" },
    failed: { resultType: "failed", error: "upstream exploded", logId: "log-2" },
    blockedNoLog: { resultType: "blocked", error: "blocked", logId: null },
    blockedWithLog: { resultType: "blocked", error: "blocked", logId: "log-3" },
    inputRequired: {
      resultType: "input_required",
      logId: "log-4",
      inputRequests: [{ id: "q1", question: "Which account?" }],
      requestState: "state-abc",
    },
  } satisfies Record<string, ExecuteEnvelope>;
}

/** Run `body`, expect it to throw `cls`, and hand the narrowed error back. */
function capture<T extends Error>(cls: new (...args: never[]) => T, body: () => void): T {
  try {
    body();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(cls);
    return err as T;
  }
}

describe("settleExecute", () => {
  it("settles completed as applied, returning the result", () => {
    const settled: AppliedResult = settleExecute(envelopes().completed);
    expect(settled.outcome).toBe("applied");
    expect(settled.result).toEqual({ ok: true });
  });

  it("settles failed as declined with the log id, classified not-dispatched", () => {
    const declined = capture(ComposioActionDeclinedError, () => settleExecute(envelopes().failed));
    expect(declined.logId).toBe("log-2");
    expect(callMayHaveTakenEffect(declined)).toBe(false);
  });

  it("settles blocked without log id as terminal known-absent, not-dispatched", () => {
    const nd = capture(ComposioNotDispatchedError, () => settleExecute(envelopes().blockedNoLog));
    expect(nd).toBeInstanceOf(McpCallNotDispatchedError);
    expect(nd.composioNotDispatched).toBe(true);
    expect(callMayHaveTakenEffect(nd)).toBe(false);
  });

  it("settles blocked with log id as terminal outcome-unknown (the tool ran)", () => {
    const unknown = capture(ComposioOutcomeUnknownError, () =>
      settleExecute(envelopes().blockedWithLog));
    expect(unknown.logId).toBe("log-3");
    // It ran, so it must be classified may-have-landed: terminal, never retryable-as-declined.
    expect(callMayHaveTakenEffect(unknown)).toBe(true);
  });

  it("settles input_required as not-dispatched, carrying the continuation payload", () => {
    const nd = capture(ComposioNotDispatchedError, () =>
      settleExecute(envelopes().inputRequired));
    expect(nd.logId).toBe("log-4");
    expect(nd.inputRequests).toEqual([{ id: "q1", question: "Which account?" }]);
    expect(nd.requestState).toBe("state-abc");
    expect(callMayHaveTakenEffect(nd)).toBe(false);
  });
});

describe("settleTransportFailure", () => {
  it("classifies transport errors as terminal outcome-unknown, never not-dispatched", () => {
    const unknown = capture(ComposioOutcomeUnknownError, () =>
      settleTransportFailure(new TypeError("network")));
    expect(callMayHaveTakenEffect(unknown)).toBe(true);
  });
});
