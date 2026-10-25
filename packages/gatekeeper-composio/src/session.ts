// The two agent-facing Composio sessions. Every capability a Gadget holds arrives here: the
// ambient singleton (every toolkit in the account's catalog) and the per-toolkit binding, under
// one read/observation and write/approval split — Composio's own `readOnlyHint` annotation
// classifies, and only an affirmative hint reads (plans/composio-gatekeeper.md "Surface").
//
// The sessions never touch Composio themselves: reads dispatch through the account with a
// key-mode generation, writes stage in the owning facet's ActionStore and settle at apply time
// (settlement.ts), and an `input_required` envelope becomes a continuation the agent answers
// through getInputRequest()/continueTool() — each answering round a fresh, never-auto-approved
// action (plans/composio-gatekeeper.md "Execution, approval, settlement").

import { validateRpc } from "capnweb-validate";
import { RpcTarget, type RpcStub } from "cloudflare:workers";
import {
  buildDescription,
  quoteUntrusted,
  sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
import { MAX_TOOL_NAME_CHARS, McpCallNotDispatchedError } from "@gadgets/mcp-shared/client";
import type { StoredAction } from "@gadgets/mcp-shared/session";
import type {
  ActionDescription,
  ActionKind,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";

import type {
  ComposioAccount,
  ComposioExecuteOutcome,
  ComposioExecuteRequest,
} from "./account.js";
import type { InputRequest, ToolInfo } from "./composio-api.js";
import { isMetaTool } from "./config.js";
import {
  CONTINUATION_ACTION_KIND,
  isAutoApplyEligible,
  ToolkitPolicy,
  toolkitWriteActionKind,
} from "./policy.js";
import type {
  ComposioCallResult,
  ComposioInputRequest,
  ComposioSession,
  ComposioToolkit,
  ComposioToolkitListing,
  ComposioToolkitSession,
  ComposioToolInfo,
} from "./types.js";

/** The execution request shape a read dispatches as (no continuation or decline fields). */
type ReadRequest = Pick<ComposioExecuteRequest, "tool" | "arguments" | "account" | "generation">;

/** What a session needs from the gatekeeper facet that owns it: the facet's host surface. */
export interface FacetHost {
  /** Dispatches one read-mode call through the account (key fence and quota apply there). */
  executeRead(request: ReadRequest): Promise<ComposioExecuteOutcome>;
  /** The account's current key-mode generation, to stamp staged writes with. */
  keyGeneration(): Promise<number>;
  /** Stages one approval-queued write in the facet's ActionStore. */
  stageAction(tool: string, args: Record<string, unknown>): StoredAction;
  /** Drops a staged write (a submission that never made it to the queue). */
  discardStagedAction(id: number): void;
  /** Reads one staged action back by id. */
  lookupAction(id: number): StoredAction | undefined;
  /** Stages the next round of an `input_required` continuation (single-use; see facet.ts). */
  continueAction(
    continuationId: string,
    responses: Record<string, unknown>,
  ): Promise<ContinuationRound>;
  /** The questions one continuation asked, or a throw when unknown/answered/expired. */
  readContinuation(continuationId: string): Promise<InputRequest[]>;
  /** Rolls a continuation back to open after its staged answer failed to submit. */
  revertContinuation(continuationId: string): Promise<void>;
  /** Pushes the facet's pending count to the account (its key-switch fence reads the counter). */
  syncPending(): Promise<void>;
}

/** What the session builds on: how it is scoped, and whether writes can ever auto-apply. */
export interface ComposioSessionHost {
  /** Display name for approval titles ("Composio"). */
  readonly serverName: string;
  /** The only toolkits this binding may call; undefined on the ambient singleton. */
  readonly scopeToolkits: string[] | undefined;
  /**
   * The account every dispatch funnels through — its declared class surface, not the RPC
   * stub mapping, which drops `unknown`-bearing members (`ExecuteEnvelope.result`,
   * `ToolInfo.inputSchema`) that are in fact delivered verbatim.
   */
  readonly account: ComposioAccount;
  /** The facet that owns this session's queued actions and continuations. */
  readonly facet: FacetHost;
  /** The toolkit binding's mint-frozen auto-apply arming; undefined on the singleton. */
  readonly arming: ToolkitArming | undefined;
}

/** A toolkit facet's mint-frozen policy, as the session's classification consults it. */
export interface ToolkitArming {
  readonly toolkitSlug: string;
  readonly autoApply: boolean;
  readonly excluded: boolean;
}

/** One staged answering round, as the facet hands it to continueTool(). */
export type ContinuationRound = {
  action: StoredAction;
  payload: {
    continuationId: string;
    toolSlug: string;
    arguments: Record<string, unknown>;
    account?: string;
    requestState: string;
    inputRequests: InputRequest[];
    responses: Record<string, unknown>;
    chainDepth: number;
    generation: number;
  };
};

/** A catalog tool as the session classifies it (the agent-facing shape drops `autoApprovable`). */
export type ScopedToolInfo = ToolInfo & {
  mode: "read" | "action";
  classifiedBy: "server-annotation" | "default";
  autoApprovable: boolean;
};

function requireToolName(method: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${method}() requires a tool name.`);
  }
  if (name.length > MAX_TOOL_NAME_CHARS) {
    throw new Error(`${method}() tool name must be at most ${MAX_TOOL_NAME_CHARS} characters.`);
  }
}

/** The per-toolkit write kind, worded as the facet's auto-apply listing words it. */
function writeActionKind(toolkitSlug: string): ActionKind {
  return {
    ...toolkitWriteActionKind(toolkitSlug),
    label: `all current and future write tools in ${toolkitSlug}`,
  };
}

/** The never-armable kind every continuation round is submitted under. */
const continueActionKind: ActionKind = {
  ...CONTINUATION_ACTION_KIND,
  label: "answering a Composio tool's input request",
};

/**
 * Shared session mechanics. The two concrete sessions (below) apply `@validateRpc()` where they
 * are handed to a Gadget, mirroring mcp-shared's session base.
 */
abstract class ComposioSessionBase extends RpcTarget {
  constructor(
    protected readonly host: ComposioSessionHost,
    protected readonly queue: RpcStub<ApprovalQueue>,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    (this.queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  /** Classifies one catalog tool and computes the per-action auto-apply verdict. */
  protected async classify(tool: ToolInfo): Promise<ScopedToolInfo> {
    const arming = this.host.arming;
    const autoApprovable = arming !== undefined
      && arming.autoApply
      && !arming.excluded
      && !(await this.host.account.sharingState()).enabled
      && isAutoApplyEligible(new ToolkitPolicy([], [tool.toolkitSlug]), tool.toolkitSlug, {
        tags: tool.tags,
        readOnly: tool.readOnlyHint === true,
      });
    return {
      ...tool,
      mode: tool.readOnlyHint === true ? "read" : "action",
      classifiedBy: tool.readOnlyHint === null ? "default" : "server-annotation",
      autoApprovable,
    };
  }

  /** The agent-facing listing shape: the classification without the verdict. */
  protected listed(tool: ScopedToolInfo): ComposioToolInfo {
    return {
      slug: tool.slug,
      toolkitSlug: tool.toolkitSlug,
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      mode: tool.mode,
      classifiedBy: tool.classifiedBy,
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    };
  }

  /** Finds one tool the account knows, refusing meta-tools before anything else. */
  protected async findTool(tool: string): Promise<ScopedToolInfo> {
    if (isMetaTool(tool)) {
      throw new Error(`The "${tool}" meta-tool is disabled by this deployment.`);
    }
    const found = await this.host.account.toolBySlug(tool);
    if (found === undefined) {
      throw new Error(`The Composio account has no tool named "${tool}".`);
    }
    if (
      this.host.scopeToolkits !== undefined
      && !this.host.scopeToolkits.includes(found.toolkitSlug)
    ) {
      throw new Error(`This binding does not grant a tool named "${tool}".`);
    }
    return await this.classify(found);
  }

  /** Maps one read's four-state envelope to a result, refusing known-absent outcomes. */
  protected async settleRead(
    outcome: ComposioExecuteOutcome,
    tool: ScopedToolInfo,
  ): Promise<ComposioCallResult> {
    if (outcome.status !== "envelope") {
      throw new McpCallNotDispatchedError(outcome.message);
    }
    const envelope = outcome.envelope;
    if (envelope.resultType === "input_required") {
      // A read-mode tool should not gate on input; if one does, nothing ran.
      throw new McpCallNotDispatchedError(
        "Composio is waiting for input before executing the tool.");
    }
    if (envelope.resultType === "blocked" && envelope.logId === null) {
      throw new McpCallNotDispatchedError(
        envelope.error !== "" ? envelope.error : "Composio blocked the tool call before it ran.");
    }
    if (envelope.resultType === "blocked") {
      return { status: "failed", message: "Composio ran the tool but blocked its response." };
    }
    const isError = envelope.resultType === "failed";
    const text = JSON.stringify(
      isError ? { error: envelope.error } : (envelope.result ?? null)) ?? "null";
    // Authorize before the data is handed back, per the gatekeeper contract.
    await this.queue.authorizeObservation({
      title: `${this.host.serverName}: read ${sanitizeTitle(tool.name)}`,
      description: buildDescription(
        `Read **${tool.name}** (${tool.slug}) on ${this.host.serverName}` +
          ` and returned its response${isError ? ", which reported an error" : ""}.` +
          (tool.description === undefined ? "" : `\n\n${quoteUntrusted(tool.description, 400)}`),
      ).finish().description,
    });
    return {
      status: "ok",
      content: [{ type: "text", text }],
      text,
      isError,
    };
  }

  async callTool(
    tool: string,
    args?: Record<string, unknown>,
    account?: string,
  ): Promise<ComposioCallResult> {
    requireToolName("callTool", tool);
    const toolArgs = args ?? {};
    if (typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
      throw new Error("callTool() arguments must be an object.");
    }
    const entry = await this.findTool(tool);

    if (entry.mode === "read") {
      const outcome = await this.host.facet.executeRead({
        tool,
        arguments: toolArgs,
        ...(account === undefined ? {} : { account }),
        generation: await this.host.facet.keyGeneration(),
      });
      return await this.settleRead(outcome, entry);
    }

    const staged = this.host.facet.stageAction(tool, {
      tool,
      arguments: toolArgs,
      ...(account === undefined ? {} : { account }),
      generation: await this.host.facet.keyGeneration(),
    });
    const rendered = buildDescription(
      `Call **${entry.name}** (${entry.slug}) on ${this.host.serverName}` +
        ` (${entry.toolkitSlug}); it runs only after approval.` +
        (entry.description === undefined ? "" : `\n\n${quoteUntrusted(entry.description, 400)}`),
    ).json("Arguments", toolArgs).finish();
    const description: ActionDescription = {
      title: `${this.host.serverName}: ${sanitizeTitle(entry.name)}`,
      description: rendered.description,
      ...(rendered.fields === undefined ? {} : { fields: rendered.fields }),
      ...(rendered.descriptionIsComplete === undefined
        ? {}
        : { descriptionIsComplete: rendered.descriptionIsComplete }),
      // Composio describes no inverse for a tool call.
      implementsRevert: false,
      // Nothing about a queued call is simulated, so an agent must wait for the decision.
      awaitDecision: true,
      autoApprovable: entry.autoApprovable,
      actionKind: writeActionKind(entry.toolkitSlug),
    };
    try {
      await this.queue.submitAction(staged.id, description);
    } catch (err) {
      this.host.facet.discardStagedAction(staged.id);
      throw err;
    }
    await this.host.facet.syncPending();
    return {
      status: "pending",
      actionId: staged.id,
      message:
        `Calling "${tool}" on ${this.host.serverName} needs approval. If this is running in an ` +
        `agent's executeCode call, return from this executeCode call now so the approval can ` +
        `appear in chat. After approval, call getActionResult(${staged.id}) for the outcome.`,
    };
  }

  async getActionResult(actionId: number): Promise<ComposioCallResult> {
    if (!Number.isInteger(actionId)) throw new Error("getActionResult() requires an action id.");
    const stored = this.host.facet.lookupAction(actionId);
    if (stored === undefined) throw new Error(`No Composio action with id ${actionId}.`);
    const toolName = typeof stored.args.tool === "string" ? stored.args.tool : stored.toolName;
    const server = this.host.serverName;

    switch (stored.state) {
      case "pending":
      case "applying":
        return {
          status: "pending",
          actionId,
          message: stored.state === "applying"
            ? `Calling "${toolName}" on ${server} was approved and is running.`
            : `Calling "${toolName}" on ${server} is awaiting approval.`,
        };
      case "rejected":
        return {
          status: "rejected",
          message: `Calling "${toolName}" on ${server} was not approved.`,
        };
      case "failed":
        return {
          status: "failed",
          message: stored.error ?? `Calling "${toolName}" on ${server} failed.`,
        };
      case "applied": {
        const result = stored.result
          ?? { status: "ok" as const, content: [], text: "", isError: false };
        const { content, text, isError } = result;
        await this.queue.authorizeObservation({
          title: `${server}: result of ${toolName}`,
          description: buildDescription(
            `Read the response from the approved call to **${toolName}** on ${server}.`,
          ).finish().description,
        });
        // A Composio result is a single JSON text block by construction; narrower blocks, if a
        // stored result ever carried one, are dropped rather than widened into the agent shape.
        return {
          status: "ok",
          content: content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map(block => ({ type: "text" as const, text: block.text })),
          text,
          ...(isError === undefined ? {} : { isError }),
        };
      }
    }
  }

  async getInputRequest(id: string): Promise<ComposioInputRequest[]> {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("getInputRequest() requires a continuation id.");
    }
    const questions = await this.host.facet.readContinuation(id);
    const flattened = questions.map(question => ({
      id: question.id,
      question: question.question.replace(/[\r\n]+/g, " "),
      ...(question.options === undefined ? {} : { options: question.options }),
    }));
    const builder = buildDescription(
      `A queued Composio tool call asked for input before it will run; ` +
        `answering queues a fresh approval-gated action.`,
    );
    for (const question of flattened) {
      builder.verbatim(`Question ${question.id}`, question.question);
    }
    const { description, fields } = builder.finish();
    await this.queue.authorizeObservation({
      title: `${this.host.serverName}: input needed`,
      description,
      ...(fields === undefined ? {} : { fields }),
    });
    return flattened;
  }

  async continueTool(
    id: string,
    responses?: Record<string, unknown>,
  ): Promise<ComposioCallResult> {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("continueTool() requires a continuation id.");
    }
    const answers = responses ?? {};
    if (typeof answers !== "object" || Array.isArray(answers)) {
      throw new Error("continueTool() responses must be an object.");
    }
    const { action, payload } = await this.host.facet.continueAction(id, answers);
    const builder = buildDescription(
      `Answer Composio's questions for **${payload.toolSlug}** ` +
        `(round ${payload.chainDepth} of 3); the tool call runs only after approval.`,
    ).json("Arguments", payload.arguments);
    for (const question of payload.inputRequests) {
      builder.verbatim(`Question ${question.id}`, question.question);
    }
    const rendered = builder.json("Answers", payload.responses).finish();
    const description: ActionDescription = {
      title: `${this.host.serverName}: answer input for ${payload.toolSlug}`,
      description: rendered.description,
      ...(rendered.fields === undefined ? {} : { fields: rendered.fields }),
      ...(rendered.descriptionIsComplete === undefined
        ? {}
        : { descriptionIsComplete: rendered.descriptionIsComplete }),
      implementsRevert: false,
      awaitDecision: true,
      // An answering round can never be pre-approved: the questions are provider-authored.
      autoApprovable: false,
      actionKind: continueActionKind,
    };
    try {
      await this.queue.submitAction(action.id, description);
    } catch (err) {
      this.host.facet.discardStagedAction(action.id);
      await this.host.facet.revertContinuation(id);
      await this.host.facet.syncPending();
      throw err;
    }
    await this.host.facet.syncPending();
    return {
      status: "pending",
      actionId: action.id,
      message:
        `Answering Composio's input request for "${payload.toolSlug}" on ` +
        `${this.host.serverName} needs approval. After approval, call ` +
        `getActionResult(${action.id}) for the outcome; if the tool asks again, the failed ` +
        `result's message names the next input request id.`,
    };
  }
}

/** The ambient singleton session: every toolkit this account can reach, in one binding. */
@validateRpc()
export class ComposioSessionImpl extends ComposioSessionBase implements ComposioSession {
  async listToolkits(): Promise<ComposioToolkitListing> {
    const { toolkits, truncated } = await this.host.account.agentToolkits();
    // The listing itself is an observation, authorized before the catalog is handed back.
    await this.queue.authorizeObservation({
      title: `${this.host.serverName}: list toolkits`,
      description: buildDescription(
        `Read the toolkit catalog of this account's ${this.host.serverName} connection ` +
          `(${toolkits.length} listed${truncated ? ", list truncated" : ""}).`,
      ).finish().description,
    });
    const mapped: ComposioToolkit[] = toolkits.map(entry => ({
      slug: entry.slug,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      toolCount: entry.toolCount,
      ...(entry.connected === undefined ? {} : { connected: entry.connected }),
    }));
    return { toolkits: mapped, truncated };
  }

  async listTools(toolkit: string): Promise<ComposioToolInfo[]> {
    if (typeof toolkit !== "string" || toolkit.length === 0) {
      throw new Error("listTools() requires a toolkit slug.");
    }
    const tools = await this.host.account.toolkitTools(toolkit);
    if (tools.length === 0) {
      throw new Error(`"${toolkit}" is not a toolkit in Composio's catalog.`);
    }
    const scoped = await Promise.all(tools.map(tool => this.classify(tool)));
    await this.queue.authorizeObservation({
      title: `${this.host.serverName}: list ${toolkit} tools`,
      description: buildDescription(
        `Read the tool catalog of the **${toolkit}** toolkit on ${this.host.serverName} ` +
          `(${scoped.length} tools).`,
      ).finish().description,
    });
    return scoped.map(tool => this.listed(tool));
  }
}

/** A per-toolkit session: the tools of the one toolkit a binding is scoped to. */
@validateRpc()
export class ComposioToolkitSessionImpl extends ComposioSessionBase implements ComposioToolkitSession {
  async listTools(): Promise<ComposioToolInfo[]> {
    const slug = this.host.arming?.toolkitSlug;
    if (slug === undefined) throw new Error("This binding is not scoped to a toolkit.");
    const tools = await this.host.account.toolkitTools(slug);
    const scoped = await Promise.all(tools.map(tool => this.classify(tool)));
    await this.queue.authorizeObservation({
      title: `${this.host.serverName}: list ${slug} tools`,
      description: buildDescription(
        `Read the tool catalog of the **${slug}** toolkit on ${this.host.serverName} ` +
          `(${scoped.length} tools).`,
      ).finish().description,
    });
    return scoped.map(tool => this.listed(tool));
  }
}
