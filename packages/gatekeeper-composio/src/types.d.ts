// The agent-facing API of the Composio connector, shipped through types.txt (a symlink to this
// file). Self-contained: no imports, no approval-queue or gatekeeper internals. JSDoc here is
// what the coding agent reads.

/** One Composio toolkit, as listed through a Composio session or catalog search. */
export type ComposioToolkit = {
  /** Exact Composio toolkit slug, e.g. "github". Pass to listTools()/callTool-scoped bindings. */
  slug: string;
  /** Human-readable toolkit name, e.g. "GitHub". */
  name: string;
  /** The toolkit's own description, when Composio supplies one. */
  description?: string;
  /** How many non-meta tools of this toolkit the catalog holds. */
  toolCount: number;
  /** Present (as a connected-account id) when this toolkit has at least one connected account. */
  connected?: string;
};

/** Classification of one tool by this deployment. */
export type ComposioToolMode =
  /** Returns data immediately; every call is recorded as an observation. */
  | "read"
  /** Queued for approval before it runs. */
  | "action";

/**
 * One tool exposed by a Composio session. `mode` follows Composio's own `readOnlyHint`
 * annotation: only an affirmative read hint classifies a read; everything else queues.
 */
export type ComposioToolInfo = {
  /** Exact tool slug, as passed to callTool(). */
  slug: string;
  /** The toolkit this tool belongs to. */
  toolkitSlug: string;
  /** Human-readable tool name. */
  name: string;
  /** The tool's own description, when Composio supplies one. */
  description?: string;
  /** Whether calls are observations or approval-gated actions. */
  mode: ComposioToolMode;
  /** Why the tool was classified this way: always "server-annotation" — Composio's own hint. */
  classifiedBy: "server-annotation" | "default";
  /** JSON Schema for the tool's arguments, when Composio supplies one. */
  inputSchema?: unknown;
};

/** Result of listToolkits(): the toolkits visible to this account, bounded. */
export type ComposioToolkitListing = {
  toolkits: ComposioToolkit[];
  /** True when toolkits were dropped to fit the listing bound. */
  truncated: boolean;
};

/** One question a tool asked before it will run (the `input_required` continuation flow). */
export type ComposioInputRequest = {
  /** Opaque id: pass as the key of your answer in continueTool()'s responses. */
  id: string;
  /** The question the tool asked, flattened to one line. */
  question: string;
  /** Answer options the tool offered, if any. */
  options?: string[];
};

/** A block of content returned by a tool call. */
export type ComposioContent = { type: "text"; text: string };

/**
 * Outcome of callTool() / continueTool().
 *
 * Read-mode tools resolve to "ok" straight away. Everything else is an action: it queues for
 * approval and resolves "pending", then settles through re-invocation as "ok" (the applied
 * result, JSON text), "rejected", or "failed". A "failed" message says whether the call may
 * have taken effect.
 */
export type ComposioCallResult =
  | {
      status: "ok";
      /** Content blocks as returned; a single JSON text block for Composio results. */
      content: ComposioContent[];
      /** All text concatenated, for the common case where that is all you need. */
      text: string;
      /** True when the tool itself reported failure (the call succeeded; the tool did not). */
      isError?: boolean;
    }
  | {
      status: "pending";
      /** The queued action id, for tracing the approval. */
      actionId: number;
      /** Human-readable explanation to relay to the user. */
      message: string;
    }
  | { status: "rejected"; message: string }
  | { status: "failed"; message: string };

/**
 * The ambient Composio session: every toolkit this account can reach, in one binding.
 *
 * Every read is an observation. Every write (a tool whose Composio annotation does not
 * affirm read-only) queues as an approval-gated action. When a tool asks for input before it
 * will run, the call settles as a continuation you answer through getInputRequest() and
 * continueTool() — each answer round queues as a fresh approval-gated action.
 */
export type ComposioSession = {
  /** Lists the toolkits visible to this account (bounded; deployment policy filters some). */
  listToolkits(): Promise<ComposioToolkitListing>;
  /** Lists one toolkit's tools. Throws when the toolkit is unknown or filtered by policy. */
  listTools(toolkit: string): Promise<ComposioToolInfo[]>;
  /**
   * Calls a tool. `account` selects among multiple connected accounts of the toolkit
   * (a connected-account id or alias); omit it when only one is connected. Read-mode tools
   * return their result; everything else queues for approval and returns "pending".
   */
  callTool(tool: string, args?: Record<string, unknown>, account?: string): Promise<ComposioCallResult>;
  /**
   * Reads the questions a tool asked before it will run. `id` is the continuation id named in
   * the pending/failed call's message. Throws when the continuation is unknown or expired.
   */
  getInputRequest(id: string): Promise<ComposioInputRequest[]>;
  /**
   * Answers a tool's questions. Each round queues a fresh approval-gated action (never
   * auto-approved) and returns "pending". Throws when the continuation is unknown, expired,
  /**
   * Reads one queued action's outcome: "pending" until decided, then "ok" (the applied
   * result), "rejected", or "failed". The pending message names the action id to pass here.
   */
  getActionResult(actionId: number): Promise<ComposioCallResult>;
  continueTool(id: string, responses: Record<string, unknown>): Promise<ComposioCallResult>;

  /** Releases the session's approval-queue capability. Called by the host, not the agent. */
  [Symbol.dispose](): void;
};

/**
 * A per-toolkit Composio session: the tools of the one toolkit a binding is scoped to, under
 * the same read/observation and write/approval split as ComposioSession.
 */
export type ComposioToolkitSession = {
  /** Lists the bound toolkit's tools. */
  listTools(): Promise<ComposioToolInfo[]>;
  /** Calls one of the bound toolkit's tools (read → result; write → queued action). */
  callTool(tool: string, args?: Record<string, unknown>, account?: string): Promise<ComposioCallResult>;
  /** Reads the questions a tool asked before it will run (see ComposioSession.getInputRequest). */
  getInputRequest(id: string): Promise<ComposioInputRequest[]>;
  /** Answers a tool's questions; queues a fresh approval-gated action (see ComposioSession.continueTool). */
  continueTool(id: string, responses: Record<string, unknown>): Promise<ComposioCallResult>;

  /** Reads one queued action's outcome (see ComposioSession.getActionResult). */
  getActionResult(actionId: number): Promise<ComposioCallResult>;

  /** Releases the session's approval-queue capability. Called by the host, not the agent. */
  [Symbol.dispose](): void;
};
