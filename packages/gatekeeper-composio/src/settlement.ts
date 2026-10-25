// The execute-envelope settlement map (plans/composio-gatekeeper.md "Execution, approval,
// settlement"). The apply handler must throw — never return — on anything but `completed`, and
// the declined / known-absent branches must throw not-dispatched classes so mcp-shared's action
// store records a retryable failure instead of outcome-unknown.
//
// Classification: both not-dispatched classes extend mcp-shared's `McpCallNotDispatchedError`,
// so `callMayHaveTakenEffect` (packages/mcp-shared/src/client.ts) identifies them without any
// mcp-shared edit. `ComposioNotDispatchedError` additionally carries the structural marker the
// contract names; plain `Error` fails safe to may-have-landed, which is exactly what
// `ComposioOutcomeUnknownError` (a plain `Error` subclass) must remain.

import { McpCallNotDispatchedError } from "@gadgets/mcp-shared/client";
import type { ExecuteEnvelope, InputRequest } from "./composio-api.js";

/** Structural marker distinguishing connector not-dispatched errors from every other failure. */
export interface NotDispatchedMarker {
  readonly composioNotDispatched: true;
}

/** Tool ran and completed. */
export interface AppliedResult {
  outcome: "applied";
  result: unknown;
}

/** Upstream reported `failed` (including a declined `input_required`) — provably not applied as requested. */
export class ComposioActionDeclinedError extends McpCallNotDispatchedError {
  constructor(
    message: string,
    /** Composio's execution log id for reconciliation, when the envelope carried one. */
    readonly logId: string | null,
  ) {
    super(message);
    this.name = "ComposioActionDeclinedError";
  }
}

/**
 * Terminal known-absent: `blocked` without a log id (the call never ran), `input_required`
 * (nothing executed), or a declined continuation. Classified not-dispatched so the action store
 * records a retryable failure, never outcome-unknown.
 */
export class ComposioNotDispatchedError extends McpCallNotDispatchedError
  implements NotDispatchedMarker {
  readonly composioNotDispatched = true as const;

  constructor(
    message: string,
    /** Composio's execution log id, when the envelope carried one. */
    readonly logId: string | null = null,
    /**
     * Continuation payload present iff the envelope was `input_required`: the questions the tool
     * asked and the opaque state a follow-up execute must echo.
     */
    readonly inputRequests: readonly InputRequest[] = [],
    readonly requestState: string | null = null,
  ) {
    super(message);
    this.name = "ComposioNotDispatchedError";
  }
}

/**
 * Network failure mid-execute — the call may have landed. Terminal (no auto-retry: executes are
 * not idempotent), resolvable by the user against Composio's log via the carried log id.
 */
export class ComposioOutcomeUnknownError extends Error {
  constructor(
    message: string,
    /** Last-known Composio execution log id for reconciliation, when one is available. */
    readonly logId: string | null,
  ) {
    super(message);
    this.name = "ComposioOutcomeUnknownError";
  }
}

/**
 * Map a returned execute envelope to settlement. `completed` yields {@link AppliedResult}; every
 * other state throws the class the settlement table assigns:
 * - `failed` → {@link ComposioActionDeclinedError} (upstream settled it; nothing applied).
 * - `input_required` → {@link ComposioNotDispatchedError} carrying the continuation payload
 *   (`inputRequests`, `requestState`, `logId`) for the facet's continuation row.
 * - `blocked` without `log_id` → {@link ComposioNotDispatchedError} (terminal known-absent).
 * - `blocked` with `log_id` → {@link ComposioOutcomeUnknownError}: the tool ran but its response
 *   was blocked, so the call is not retryable and the log id is the reconciliation handle.
 */
export function settleExecute(envelope: ExecuteEnvelope): AppliedResult {
  switch (envelope.resultType) {
    case "completed":
      return { outcome: "applied", result: envelope.result };
    case "failed":
      throw new ComposioActionDeclinedError(
        "Composio reported the tool call as failed.", envelope.logId);
    case "input_required":
      throw new ComposioNotDispatchedError(
        "Composio is waiting for input before executing the tool.",
        envelope.logId, envelope.inputRequests, envelope.requestState);
    case "blocked":
      if (envelope.logId === null) {
        throw new ComposioNotDispatchedError(
          "Composio blocked the tool call before it ran.", null);
      }
      throw new ComposioOutcomeUnknownError(
        "Composio ran the tool but blocked its response.", envelope.logId);
  }
}

/**
 * Settle a transport-level failure thrown mid-execute (fetch rejection, non-2xx, invalid
 * envelope): the call may have landed, so it is terminal outcome-unknown, never not-dispatched.
 */
export function settleTransportFailure(err: unknown): never {
  throw new ComposioOutcomeUnknownError(
    err instanceof Error ? err.message : String(err),
    null);
}
