// The Composio gatekeeper facets: one ambient singleton (every toolkit the account can reach)
// and one per-toolkit facet per binding. The facets hold no Composio credentials at all — every
// upstream call funnels back through the account's executeTool(), where the key-mode generation
// fence, quota, and session management are enforced once (account.ts; README "Design").
//
// What lives here is everything with a per-binding lifetime: the approval-gated action store
// (mcp-shared's ActionStore over facet SQLite) and the `input_required` continuation lifecycle —
// recorded at settlement, single-use, TTL-bounded, chain-capped at three rounds, and declined
// upstream when it expires or is rejected (plans/composio-gatekeeper.md "Execution, approval,
// settlement").

import { validateRpc } from "capnweb-validate";
import { DurableObject, RpcStub } from "cloudflare:workers";
import { ActionStore, REVERT_UNSUPPORTED_MESSAGE } from "@gadgets/mcp-shared/action-store";
import type { StoredAction } from "@gadgets/mcp-shared/session";
import {
  McpCallNotDispatchedError,
  McpProtocolError,
  type McpClient,
  type McpToolCallResult,
} from "@gadgets/mcp-shared/client";
import type {
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  GitCache,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";

import type {
  ComposioAccount,
  ComposioExecuteOutcome,
  ComposioExecuteRequest,
} from "./account.js";
import type { InputRequest, ToolInfo } from "./composio-api.js";
import { toolkitWriteActionKind } from "./policy.js";
import {
  ComposioActionDeclinedError,
  ComposioNotDispatchedError,
  settleExecute,
} from "./settlement.js";
import {
  ComposioSessionImpl,
  ComposioToolkitSessionImpl,
  type ComposioSessionHost,
  type ContinuationRound,
} from "./session.js";
import type { ComposioSession, ComposioToolkitSession } from "./types.js";
import { TYPES_CODE, actionStoreLog, composioTestHooksEnabled, logger } from "./worker.js";

/** Props the account freezes into a per-toolkit facet at mint (see account.getGatekeeperClassFor). */
export type ToolkitFacetProps = {
  accountObjectId: string;
  toolkitSlug: string;
  /** Always false at mint today (excluded slugs refuse the mint); frozen so it can only narrow. */
  excluded: boolean;
  /** The deployment's auto-apply listing for this toolkit at mint. */
  autoApply: boolean;
  /** The account's key-mode generation at mint; a mismatch strands staged actions. */
  generation: number;
};

/** Props the account freezes into the ambient singleton facet. */
export type SingletonFacetProps = { accountObjectId: string };

/** One persisted `input_required` continuation row. */
type ContinuationRow = {
  continuation_id: string;
  action_id: number;
  origin_action_id: number;
  tool_slug: string;
  args_json: string;
  account: string | null;
  request_state: string;
  input_requests_json: string;
  input_responses_json: string | null;
  generation: number;
  chain_depth: number;
  expires_at: number;
  state: "open" | "staged";
  created_at: number;
};

/** A continuation lives one hour: long enough to answer, short enough not to haunt the queue. */
const CONTINUATION_TTL_MS = 3_600_000;
/** Composio chains are capped at three answering rounds (the agent sees "round N of 3"). */
const MAX_CHAIN_DEPTH = 3;
/** Bounded retention: expired rows go first, then oldest, beyond this many. */
const MAX_CONTINUATIONS = 20;
const MAX_CONTINUATION_ARGS_BYTES = 64 * 1024;
const encoder = new TextEncoder();

/**
 * Everything the two facets share: the action store, the continuation table, dispatch and
 * settlement, and the Gatekeeper surface. Subclasses supply their props-derived identity and
 * the session class they mint.
 */
abstract class ComposioFacetCore<Props> extends DurableObject<Cloudflare.Env, Props> {
  #actionStore: ActionStore | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS composio_continuations (
      continuation_id TEXT PRIMARY KEY,
      action_id INTEGER NOT NULL UNIQUE,
      origin_action_id INTEGER NOT NULL,
      tool_slug TEXT NOT NULL,
      args_json TEXT NOT NULL,
      account TEXT,
      request_state TEXT NOT NULL,
      input_requests_json TEXT NOT NULL,
      input_responses_json TEXT,
      generation INTEGER NOT NULL,
      chain_depth INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'staged')),
      created_at INTEGER NOT NULL
    ) STRICT`);
    // A fresh activation means any persisted 'staged' row belonged to an interrupted answering
    // round: roll it back to open so the agent can answer again rather than wedging it.
    ctx.storage.sql.exec(
      `UPDATE composio_continuations SET state = 'open' WHERE state = 'staged'`);
  }

  protected abstract readonly facetKind: "singleton" | "toolkit";
  protected abstract readonly accountObjectId: string;
  protected abstract readonly toolkitSlug: string | undefined;
  /** The key-mode generation this facet was minted under (1 for the singleton). */
  protected abstract readonly mintGeneration: number;
  /** Whether the account should count this facet as having auto-apply armed. */
  protected abstract readonly autoApplyListed: boolean;

  /**
   * The owning account, which every upstream call funnels back through. Delivered over RPC
   * but re-typed to its declared surface: the runtime's RPC type mapping drops
   * `unknown`-bearing members (`ExecuteEnvelope.result`, `ToolInfo.inputSchema`) that are in
   * fact delivered verbatim.
   */
  protected account(): ComposioAccount {
    const account = this.ctx.exports.ComposioAccount;
    return account.get(account.idFromString(this.accountObjectId)) as unknown as ComposioAccount;
  }

  #actions(): ActionStore {
    this.#actionStore ??= new ActionStore(this.ctx.storage.sql);
    return this.#actionStore;
  }

  /**
   * Records this facet with the account (idempotent upsert). Awaited before anything that can
   * hold an action, so the account's key-switch fan-out always sees this facet first.
   */
  protected async register(): Promise<void> {
    await this.account().registerFacet(this.ctx.id.toString(), {
      kind: this.facetKind,
      ...(this.toolkitSlug === undefined ? {} : { toolkitSlug: this.toolkitSlug }),
      generation: this.mintGeneration,
      autoApplyListed: this.autoApplyListed,
    });
    await this.syncPending();
  }

  // -- Dispatch and settlement ----------------------------------------------

  /** The request an approved first-round action dispatches as. */
  #originRequest(action: number): ComposioExecuteRequest {
    const stored = this.#actions().get(action);
    if (stored === undefined) throw new Error(`Composio action ${action} is unknown.`);
    return {
      tool: String(stored.args.tool),
      arguments: stored.args.arguments,
      ...(typeof stored.args.account === "string" ? { account: stored.args.account } : {}),
      generation: typeof stored.args.generation === "number"
        ? stored.args.generation
        : this.mintGeneration,
    };
  }

  /** The request a staged continuation round dispatches as. */
  #continuationRequest(row: ContinuationRow): ComposioExecuteRequest {
    return {
      tool: row.tool_slug,
      arguments: JSON.parse(row.args_json),
      ...(row.account === null ? {} : { account: row.account }),
      requestState: row.request_state,
      ...(row.input_responses_json === null
        ? {}
        : { inputResponses: JSON.parse(row.input_responses_json) }),
      generation: row.generation,
    };
  }

  /**
   * Runs one approved action against the account and settles the envelope. Throws, never
   * returns, on anything but `completed`: not-dispatched outcomes throw retryable classes so the
   * ActionStore records them as safely re-stageable, everything else fails closed.
   */
  async #dispatch(action: number): Promise<McpToolCallResult> {
    const row = this.#continuationByAction(action);
    const request = row === undefined
      ? this.#originRequest(action)
      : this.#continuationRequest(row);
    const outcome: ComposioExecuteOutcome = await this.account().executeTool(request);
    if (outcome.status !== "envelope") {
      // Refused (quota, meta-tool, no key) or stranded (key switch): nothing reached Composio.
      this.#deleteRows(action);
      throw new McpCallNotDispatchedError(outcome.message);
    }
    try {
      const applied = settleExecute(outcome.envelope);
      this.#deleteRows(action);
      return {
        content: [{ type: "text", text: JSON.stringify(applied.result ?? null) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof ComposioNotDispatchedError) {
        const continuationId = this.#recordContinuation(action, request, err);
        if (continuationId === undefined) throw err;
        // The agent's only channel to this continuation is the failed action's message, so the
        // rethrown error names the id there (see types.d.ts on getInputRequest).
        throw new ComposioNotDispatchedError(
          `${err.message} Input request id "${continuationId}": call getInputRequest(` +
            `"${continuationId}") on the session to read the questions, then continueTool(` +
            `"${continuationId}", answers) to answer.`,
          err.logId,
          err.inputRequests,
          err.requestState,
        );
      }
      if (err instanceof ComposioActionDeclinedError) {
        // Provably not applied as requested: retryable, so the ActionStore records it so.
        this.#deleteRows(action);
        throw new McpProtocolError(err.message, undefined, "declined");
      }
      // Outcome-unknown and transport failures stay terminal; plain errors already fail closed.
      this.#deleteRows(action);
      throw err;
    }
  }

  /**
   * Records one `input_required` outcome, replacing any prior row for this action. Returns the
   * continuation id, or undefined when the chain is capped, the args outgrew the row, or the
   * envelope carried no questions (all terminal: nothing is recorded).
   */
  #recordContinuation(
    action: number,
    request: ComposioExecuteRequest,
    err: ComposioNotDispatchedError,
  ): string | undefined {
    if (err.inputRequests.length === 0) return undefined;
    const prior = this.#continuationByAction(action);
    if (prior !== undefined) this.#deleteRows(action);
    const chainDepth = (prior?.chain_depth ?? 0) + 1;
    if (chainDepth > MAX_CHAIN_DEPTH) {
      logger.info("continuation chain capped; the tool call stays unanswered", {
        event: "facet.continuation.capped", actionId: action, chainDepth,
        ...(this.toolkitSlug === undefined ? {} : { toolkitSlug: this.toolkitSlug }),
      });
      return undefined;
    }
    const argsJson = JSON.stringify(request.arguments);
    if (encoder.encode(argsJson).byteLength > MAX_CONTINUATION_ARGS_BYTES) return undefined;
    const continuationId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO composio_continuations
         (continuation_id, action_id, origin_action_id, tool_slug, args_json, account,
          request_state, input_requests_json, input_responses_json, generation, chain_depth,
          expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'open', ?)`,
      continuationId,
      action,
      prior?.origin_action_id ?? action,
      request.tool,
      argsJson,
      request.account ?? null,
      err.requestState ?? "",
      JSON.stringify(err.inputRequests),
      request.generation,
      chainDepth,
      Date.now() + CONTINUATION_TTL_MS,
      Date.now(),
    );
    this.#prune();
    logger.info("continuation recorded", {
      event: "facet.continuation.recorded", actionId: action, chainDepth,
      ...(this.toolkitSlug === undefined ? {} : { toolkitSlug: this.toolkitSlug }),
    });
    return continuationId;
  }

  /** Drops expired rows, then oldest beyond the retention bound. */
  #prune(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM composio_continuations WHERE expires_at <= ?`, Date.now());
    this.ctx.storage.sql.exec(
      `DELETE FROM composio_continuations WHERE continuation_id IN (
         SELECT continuation_id FROM composio_continuations
         ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      MAX_CONTINUATIONS,
    );
  }

  #deleteRows(action: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM composio_continuations WHERE action_id = ? OR origin_action_id = ?`,
      action,
      action,
    );
  }

  #continuationByAction(action: number): ContinuationRow | undefined {
    return this.ctx.storage.sql.exec<ContinuationRow>(
      `SELECT * FROM composio_continuations WHERE action_id = ?`, action).toArray()[0];
  }

  #continuationById(continuationId: string): ContinuationRow | undefined {
    return this.ctx.storage.sql.exec<ContinuationRow>(
      `SELECT * FROM composio_continuations WHERE continuation_id = ?`,
      continuationId).toArray()[0];
  }

  /** The open, unexpired row for `continuationId`, or a throw explaining its terminal state. */
  async #requireOpenRow(continuationId: string): Promise<ContinuationRow> {
    const row = this.#continuationById(continuationId);
    if (row === undefined) {
      throw new Error(`No Composio input request with id "${continuationId}".`);
    }
    if (row.state !== "open") {
      throw new Error(
        `The Composio input request with id "${continuationId}" was already answered.`);
    }
    if (Date.now() > row.expires_at) {
      await this.#expireRow(row);
      await this.syncPending();
      throw new Error(
        `The Composio input request with id "${continuationId}" expired (1 hour). ` +
        "The tool call was declined.");
    }
    return row;
  }

  /** Declines one continuation upstream (nothing runs), best-effort. */
  async #declineRow(row: ContinuationRow): Promise<void> {
    try {
      await this.account().executeTool({
        tool: row.tool_slug,
        arguments: JSON.parse(row.args_json),
        ...(row.account === null ? {} : { account: row.account }),
        requestState: row.request_state,
        generation: row.generation,
        decline: true,
      });
    } catch (err) {
      logger.warn("could not decline an expired composio continuation", {
        event: "facet.continuation.decline-failed", error: err,
      });
    }
  }

  async #expireRow(row: ContinuationRow): Promise<void> {
    this.#deleteRows(row.action_id);
    await this.#declineRow(row);
    logger.info("continuation expired; declined upstream", {
      event: "facet.continuation.expired",
      ...(this.toolkitSlug === undefined ? {} : { toolkitSlug: this.toolkitSlug }),
    });
  }

  // -- Session host surface (session.ts drives through these) ----------------

  executeRead(
    request: Pick<ComposioExecuteRequest, "tool" | "arguments" | "account" | "generation">,
  ): Promise<ComposioExecuteOutcome> {
    return this.account().executeTool(request);
  }

  async keyGeneration(): Promise<number> {
    return (await this.account().keyState()).generation;
  }

  stageAction(tool: string, args: Record<string, unknown>): StoredAction {
    return this.#actions().stage(tool, args);
  }

  discardStagedAction(id: number): void {
    this.#actions().discard(id);
  }

  lookupAction(id: number): StoredAction | undefined {
    return this.#actions().get(id);
  }

  /**
   * Stages the next answering round for one continuation: single-use (the row flips to staged),
   * re-validated for every question answered, and fenced against a key switch since the round
   * it continues.
   */
  async continueAction(
    continuationId: string,
    responses: Record<string, unknown>,
  ): Promise<ContinuationRound> {
    const row = await this.#requireOpenRow(continuationId);
    const generation = await this.keyGeneration();
    if (generation !== row.generation) {
      this.#deleteRows(row.action_id);
      await this.syncPending();
      throw new Error(
        "The Composio key was switched, so this tool call was abandoned. Start it again.");
    }
    const inputRequests = JSON.parse(row.input_requests_json) as InputRequest[];
    for (const question of inputRequests) {
      if (!Object.hasOwn(responses, question.id)) {
        throw new Error(`An answer for "${question.id}" is required (see getInputRequest).`);
      }
    }
    const args = JSON.parse(row.args_json) as Record<string, unknown>;
    const staged = this.stageAction(row.tool_slug, {
      tool: row.tool_slug,
      arguments: args,
      responses,
      ...(row.account === null ? {} : { account: row.account }),
      generation: row.generation,
      continuationId,
    });
    this.ctx.storage.sql.exec(
      `UPDATE composio_continuations
         SET action_id = ?, input_responses_json = ?, state = 'staged'
       WHERE continuation_id = ?`,
      staged.id,
      JSON.stringify(responses),
      continuationId,
    );
    await this.syncPending();
    return {
      action: staged,
      payload: {
        continuationId,
        toolSlug: row.tool_slug,
        arguments: args,
        ...(row.account === null ? {} : { account: row.account }),
        requestState: row.request_state,
        inputRequests,
        responses,
        chainDepth: row.chain_depth,
        generation: row.generation,
      },
    };
  }

  async readContinuation(continuationId: string): Promise<InputRequest[]> {
    const row = await this.#requireOpenRow(continuationId);
    return JSON.parse(row.input_requests_json) as InputRequest[];
  }

  async revertContinuation(continuationId: string): Promise<void> {
    // Back to the origin action with no recorded answers, so the round can be staged afresh.
    this.ctx.storage.sql.exec(
      `UPDATE composio_continuations
         SET state = 'open', action_id = origin_action_id, input_responses_json = NULL
       WHERE continuation_id = ?`,
      continuationId,
    );
    await this.syncPending();
  }

  /** Pending (approval-queued or open-continuation) actions, for the account's switch fence. */
  pendingActionCount(): number {
    // Constructs the store first so mcp_actions exists on a facet that never staged one.
    this.#actions();
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT (SELECT count(*) FROM mcp_actions WHERE state IN ('pending', 'applying'))
              + (SELECT count(*) FROM composio_continuations) AS count`,
    ).one().count;
  }

  /**
   * Pushes this facet's pending count to the account. Facet stubs cannot be re-addressed across
   * facet spaces, so the account's key-switch fence reads a counter the facets maintain at every
   * transition (staged, settled, expired, abandoned) rather than pinging the facet DOs.
   */
  async syncPending(): Promise<void> {
    await this.account().notePendingCount(this.ctx.id.toString(), this.pendingActionCount());
  }

  // -- Gatekeeper surface ----------------------------------------------------

  getTypeScriptTypes(): Promise<string> {
    return Promise.resolve(TYPES_CODE);
  }

  async applyAction(action: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.register();
    // The store hands its consumer a client-taking thunk; Composio dispatches through the
    // account instead, so the consumer ignores the thunk and settles #dispatch's result.
    await this.#actions().apply(
      action,
      async (_fn: (client: McpClient) => Promise<McpToolCallResult>) =>
        await this.#dispatch(action),
      actionStoreLog,
    );
    await this.syncPending();
  }

  async rejectAction(action: number): Promise<void> {
    await this.register();
    const row = this.#continuationByAction(action);
    if (row !== undefined) {
      await this.#declineRow(row);
      this.#deleteRows(action);
    }
    this.#actions().reject(action);
    await this.syncPending();
  }

  revertAction(_action: number): Promise<{ message: string }> {
    return Promise.resolve({ message: REVERT_UNSUPPORTED_MESSAGE });
  }

  /**
   * Admits an observer under the account's owner-consent flag (fail-closed there). The verifier
   * is never interrogated: sharing this connector hands over its whole tool surface, so it stays
   * an owner decision (plans/composio-gatekeeper.md "Ambient singleton"; README "Sharing").
   */
  async addObserver(id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.account().admitObserver(id);
    logger.info("observer admitted under the owner's sharing consent", {
      event: "facet.observer.admitted", count: 1,
    });
  }

  async removeObserver(id: string): Promise<void> {
    await this.account().forgetObserver(id);
  }

  // -- Test-only storage hooks -------------------------------------------------
  // A facet created through `ctx.facets` cannot be re-addressed from a test's namespace binding
  // (its id is not valid for `idFromString`), so the workerd suite manipulates and inspects the
  // facet's SQLite through these instead. Every method throws unless the worker's test seam is
  // active (see setComposioFetchForTests), which production never does.

  async testRewindStagedGeneration(action: number, generation: number): Promise<void> {
    if (!composioTestHooksEnabled()) throw new Error("test hooks are not enabled");
    this.ctx.storage.sql.exec(
      "UPDATE mcp_actions SET args_json = json_set(args_json, '$.generation', ?) WHERE id = ?",
      generation, action,
    );
  }

  async testExpireContinuations(): Promise<void> {
    if (!composioTestHooksEnabled()) throw new Error("test hooks are not enabled");
    this.ctx.storage.sql.exec("UPDATE composio_continuations SET expires_at = 1000");
  }

  async testContinuationRows(): Promise<unknown[]> {
    if (!composioTestHooksEnabled()) throw new Error("test hooks are not enabled");
    return this.ctx.storage.sql.exec("SELECT * FROM composio_continuations").toArray()
      .map(row => ({ ...row }));
  }
}

/** The ambient singleton: every toolkit this account can reach, in one binding. */
@validateRpc()
export class ComposioSingletonGatekeeper
  extends ComposioFacetCore<SingletonFacetProps>
  implements Gatekeeper<ComposioSession>
{
  protected override readonly facetKind = "singleton" as const;
  protected override readonly accountObjectId = this.ctx.props.accountObjectId;
  protected override readonly toolkitSlug: string | undefined = undefined;
  protected override readonly mintGeneration = 1;
  protected override readonly autoApplyListed = false;

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<ComposioSessionImpl> {
    await this.register();
    const host: ComposioSessionHost = {
      serverName: "Composio",
      scopeToolkits: undefined,
      account: this.account(),
      facet: this,
      arming: undefined,
    };
    return new ComposioSessionImpl(host, queue.dup() as RpcStub<ApprovalQueue>);
  }

  async describe(): Promise<ResourceDescription> {
    const { toolkits, truncated } = await this.account().agentToolkits();
    const connected = toolkits.filter(entry => entry.connected !== undefined).length;
    return {
      url: "composio://toolkits",
      title: "Composio",
      snippet:
        `Every toolkit in this account's Composio catalog (${toolkits.length} listed` +
        `${truncated ? ", list truncated" : ""}, ${connected} connected). Reads are ` +
        "observations; every write needs approval.",
      suggestedBindingName: "composio",
      tsType: "ComposioSession",
    };
  }

  /** The singleton never arms: writes always queue. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    await this.register();
    return [];
  }

  async getAgentCatalog(): Promise<AgentCatalog> {
    return await this.account().agentCatalog();
  }
}

/** One per-toolkit binding, scoped to the tools of its mint-frozen toolkit. */
@validateRpc()
export class ComposioToolkitGatekeeper
  extends ComposioFacetCore<ToolkitFacetProps>
  implements Gatekeeper<ComposioToolkitSession>
{
  protected override readonly facetKind = "toolkit" as const;
  protected override readonly accountObjectId = this.ctx.props.accountObjectId;
  protected override readonly toolkitSlug = this.ctx.props.toolkitSlug;
  protected override readonly mintGeneration = this.ctx.props.generation;
  protected override readonly autoApplyListed = this.ctx.props.autoApply;

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<ComposioToolkitSessionImpl> {
    await this.register();
    const host: ComposioSessionHost = {
      serverName: "Composio",
      scopeToolkits: [this.ctx.props.toolkitSlug],
      account: this.account(),
      facet: this,
      arming: {
        toolkitSlug: this.ctx.props.toolkitSlug,
        autoApply: this.ctx.props.autoApply,
        excluded: this.ctx.props.excluded,
      },
    };
    return new ComposioToolkitSessionImpl(host, queue.dup() as RpcStub<ApprovalQueue>);
  }

  async describe(): Promise<ResourceDescription> {
    const slug = this.ctx.props.toolkitSlug;
    let name = slug;
    let toolCount = 0;
    let reads = 0;
    let connected = false;
    try {
      const [tools, { toolkits }] = await Promise.all([
        this.account().toolkitTools(slug),
        this.account().agentToolkits(),
      ]);
      toolCount = tools.length;
      reads = tools.filter(tool => tool.readOnlyHint === true).length;
      const entry = toolkits.find(candidate => candidate.slug === slug);
      name = entry?.name ?? slug;
      connected = entry?.connected !== undefined;
    } catch {
      // Catalog unreachable: describe from props alone rather than failing the mint UI.
    }
    return {
      url: `composio://toolkit/${slug}`,
      title: name,
      snippet:
        `${toolCount} tools (${reads} read-only, ${toolCount - reads} requiring approval) ` +
        `through Composio${connected ? ", connected" : ""}.`,
      suggestedBindingName: `COMPOSIO_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
        .replace(/_+$/, "")}`,
      tsType: "ComposioToolkitSession",
    };
  }

  /**
   * The potential auto-apply set: armed only when the mint froze auto-apply for this toolkit,
   * the account has not enabled observer sharing (the two are mutually exclusive), and nothing
   * excluded it. The per-action verdict at submit time is the binding gate.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    await this.register();
    const props = this.ctx.props;
    if (!props.autoApply || props.excluded) return [];
    if ((await this.account().sharingState()).enabled) return [];
    const { toolkits } = await this.account().agentToolkits();
    const name = toolkits.find(entry => entry.slug === props.toolkitSlug)?.name
      ?? props.toolkitSlug;
    return [{
      ...toolkitWriteActionKind(props.toolkitSlug),
      label: `all current and future write tools in ${name}`,
    }];
  }

  async getAgentCatalog(): Promise<AgentCatalog> {
    const slug = this.ctx.props.toolkitSlug;
    const [tools, { toolkits }] = await Promise.all([
      this.account().toolkitTools(slug).catch((): ToolInfo[] => []),
      this.account().agentToolkits(),
    ]);
    const entry = toolkits.find(candidate => candidate.slug === slug);
    return boundAgentCatalog([{
      id: slug,
      title: entry?.name ?? slug,
      description: `${tools.length} tools via Composio` +
        `${entry?.connected !== undefined ? ", connected." : "."}`,
    }]);
  }
}
