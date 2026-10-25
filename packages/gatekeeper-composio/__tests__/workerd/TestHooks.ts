// The workerd-suite driver. Everything the suites touch depends on Durable Object plumbing —
// props-carrying facet classes (`ctx.facets`), the queued-action store on facet SQLite, the
// account's key-mode fence, the continuation lifecycle — so the tests drive the real DOs from
// this hook Durable Object, the same way the overseer does in production.
//
// The fake Composio REST surface is installed through worker.ts's `setComposioFetchForTests()`
// seam from HERE, inside the worker, because module state only reaches the account DO when it is
// set in the worker's own module registry — a test-context call would mutate a different copy.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ComposioToolkitPolicy,
  GatekeeperUserVerifier,
  GitCache,
  HookDescription,
  HookController,
  ObservationDescription,
  ComposioToolkitInfo,
} from "@gadgets/workshop-shared/gatekeeper";

import type { ComposioAccount } from "../../src/account.js";
import {
  ComposioSingletonGatekeeper,
  ComposioToolkitGatekeeper,
  type ToolkitFacetProps,
} from "../../src/facet.js";
import type { ComposioSessionImpl, ComposioToolkitSessionImpl } from "../../src/session.js";
import type { ComposioCallResult, ComposioInputRequest } from "../../src/types.js";
import { GatekeeperVendor, setComposioFetchForTests } from "../../src/worker.js";

// ---------------------------------------------------------------------------
// The fake Composio REST surface. A spec is plain JSON so it can cross the RPC boundary from
// the test; the router below turns it into responses shaped exactly as composio-api.ts parses
// them (`{items, nextCursor}` pages, `result_type` execute envelopes).

/** One planned `POST .../execute` response, in call order; the last entry repeats. */
export type FakeExecuteSpec =
  | { resultType: "completed"; result?: unknown; logId?: string | null }
  | { resultType: "failed"; error: string; logId?: string | null }
  | { resultType: "blocked"; error: string; logId?: string | null }
  | {
      resultType: "input_required"; requestState: string; logId?: string | null;
      inputRequests: { id: string; question: string; options?: string[] }[];
    }
  /** A plain HTTP failure: the response returns with this status (e.g. a pre-execution 4xx). */
  | { status: number; error?: string };

/** The whole REST surface the suites need, as plain JSON. */
export type FakeComposioSpec = {
  toolkits: { slug: string; name: string; description?: string }[];
  tools: Record<string, {
    slug: string; name?: string; description?: string;
    tags?: string[]; read_only_hint?: boolean | null; input_parameters?: unknown;
  }[]>;
  connectedAccounts?: { id: string; toolkitSlug: string; alias?: string; status?: string }[];
  /** `POST .../execute` responses in call order; the last repeats when the list runs out. */
  executes: FakeExecuteSpec[];
};

/** One captured `POST .../execute` body, as the tests assert on it. */
export type FakeExecuteCall = {
  tool: string;
  arguments: object | null;
  account: string | null;
  requestState: string | null;
  inputResponses: object | null;
  action: string | null;
};

/** One captured `POST /tool_router/session`, parsed into the concrete fields tests assert on. */
export type FakeSessionCall = {
  composioUserId: string;
  requireApproval: string[] | null;
  toolsOverride: [slug: string, requireApproval: string[]][] | null;
};

/** How many times each catalog route was hit, for subrequest-count assertions. */
export type FakeGetCounts = { toolkits: number; tools: number };

function renderExecute(
  spec: Exclude<FakeExecuteSpec, { status: number }>,
): Record<string, unknown> {
  switch (spec.resultType) {
    case "completed":
      return { result_type: "completed", result: spec.result ?? null, log_id: spec.logId ?? null };
    case "failed":
      return { result_type: "failed", error: spec.error, log_id: spec.logId ?? null };
    case "blocked":
      return { result_type: "blocked", error: spec.error, log_id: spec.logId ?? null };
    case "input_required":
      return {
        result_type: "input_required",
        request_state: spec.requestState,
        input_requests: spec.inputRequests,
        log_id: spec.logId ?? null,
      };
  }
}

// ---------------------------------------------------------------------------
// The approval queue stand-in. It lives here in the hooks object, so both the captured
// submissions and the observations survive between hook calls and cross back as plain JSON.

/** What the queue captured for one submitted action. */
export type CapturedSubmission = {
  action: number;
  title: string;
  description: string;
  fields: ActionDescription["fields"];
  autoApprovable: boolean | undefined;
  actionKind: { tag: string } | undefined;
  implementsRevert: boolean;
  awaitDecision: boolean | undefined;
};

/** What the queue captured for one authorized observation. */
export type CapturedObservation = { title: string; description: string; fieldsJson: string };

export class TestApprovalQueue extends RpcTarget {
  readonly submissions: CapturedSubmission[] = [];
  readonly observations: CapturedObservation[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push({
      title: description.title, description: description.description,
      // Fields cross as JSON: an `unknown`-carrying member is dropped by RPC type mapping.
      fieldsJson: JSON.stringify(description.fields ?? []),
    });
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.submissions.push({
      action,
      title: description.title,
      description: description.description,
      fields: description.fields,
      autoApprovable: description.autoApprovable,
      actionKind: description.actionKind,
      implementsRevert: description.implementsRevert,
      awaitDecision: description.awaitDecision,
    });
  }

  async getGitCache(): Promise<never> {
    throw new Error("the Composio tests provide no git cache");
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("the Composio tests accept no hooks");
  }
}

/** The one answer the verifier ever gives: access confirmed, without asking any question. */
class TestVerifier extends RpcTarget {
  verify(): void {}
}

// ---------------------------------------------------------------------------


/** The git cache every Composio apply ignores; only its stub-ness matters. */
class UnusedGitCache extends RpcTarget {}

/** A call's outcome: the value, or the name+message of what it threw (error classes do not survive RPC). */
export type Attempt<T> = { ok: true; value: T } | { ok: false; name: string; message: string };

/** A facet as the hooks hold it: an RPC fetcher, with its DO id for storage access. */
type HeldFacet = {
  stub: Fetcher<ComposioSingletonGatekeeper> | Fetcher<ComposioToolkitGatekeeper>;
  facetId: string;
};

type AnySession = ComposioSessionImpl | ComposioToolkitSessionImpl;

export class TestHooks extends DurableObject<Cloudflare.Env> {
  readonly #facets = new Map<string, HeldFacet>();
  readonly #sessions = new Map<string, AnySession>();
  readonly #queues = new Map<string, TestApprovalQueue>();
  #executeCalls: FakeExecuteCall[] = [];
  #sessionCalls: FakeSessionCall[] = [];
  #getCounts: FakeGetCounts = { toolkits: 0, tools: 0 };

  // -- Faking the Composio REST surface --------------------------------------

  /** Installs (or, with null, removes) the fake REST surface the account and vendor call. */
  installFake(spec: FakeComposioSpec | null): void {
    if (spec === null) {
      this.#executeCalls = [];
      this.#sessionCalls = [];
      this.#getCounts = { toolkits: 0, tools: 0 };
      setComposioFetchForTests(undefined);
      return;
    }
    const calls: FakeExecuteCall[] = [];
    this.#executeCalls = calls;
    const sessionCalls: FakeSessionCall[] = [];
    this.#sessionCalls = sessionCalls;
    const getCounts: FakeGetCounts = { toolkits: 0, tools: 0 };
    this.#getCounts = getCounts;
    const plans = spec.executes.length > 0
      ? spec.executes
      : [{ resultType: "completed" as const, result: null }];
    let executeIndex = 0;
    const fake: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v3\.1/, "");
      const method = init?.method ?? "GET";
      if (method === "GET" && path === "/toolkits") {
        getCounts.toolkits++;
        return Response.json({ items: spec.toolkits, nextCursor: null });
      }
      if (method === "GET" && path === "/tools") {
        getCounts.tools++;
        const toolkit = url.searchParams.get("toolkits");
        if (toolkit === null) {
          // The unfiltered global sweep: every tool, its toolkit embedded per item.
          const items = Object.entries(spec.tools).flatMap(([slug, tools]) =>
            tools.map(tool => ({ ...tool, toolkit: { slug } })));
          return Response.json({ items, nextCursor: null });
        }
        return Response.json({ items: spec.tools[toolkit] ?? [], nextCursor: null });
      }
      if (method === "GET" && path === "/connected_accounts") {
        return Response.json({ items: spec.connectedAccounts ?? [], nextCursor: null });
      }
      if (method === "POST" && path === "/tool_router/session") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const tags = (body.tags as { require_approval?: string[] } | undefined)
          ?.require_approval ?? null;
        const tools = body.tools as
          | Record<string, { tags?: { require_approval?: string[] } }>
          | undefined;
        sessionCalls.push({
          composioUserId: String(body.composio_user_id ?? ""),
          requireApproval: tags,
          toolsOverride: tools === undefined
            ? null
            : Object.entries(tools)
              .map(([slug, entry]) => [slug, entry.tags?.require_approval ?? []] as const),
        });
        return Response.json({
          id: "sess-1",
          mcp: { url: "https://mcp.example/sess-1", headers: { "x-api-key": "fake" } },
        });
      }
      if (method === "DELETE" && path === "/tool_router/session/sess-1") {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "/tool_router/session/sess-1/execute") {
        const plan = plans[Math.min(executeIndex++, plans.length - 1)];
        if ("status" in plan) {
          return Response.json(
            { error: plan.error ?? "fake Composio error" },
            { status: plan.status },
          );
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({
          tool: String(body.tool),
          arguments: body.arguments as object | null,
          account: typeof body.account === "string" ? body.account : null,
          requestState: typeof body.request_state === "string" ? body.request_state : null,
          inputResponses: (body.input_responses ?? null) as object | null,
          action: typeof body.action === "string" ? body.action : null,
        });
        return Response.json(renderExecute(plan));
      }
      return new Response("no such route in the fake Composio", { status: 404 });
    };
    setComposioFetchForTests(fake);
  }

  /** Every `POST .../execute` body seen so far, in order. */
  executeCalls(): FakeExecuteCall[] {
    return this.#executeCalls;
  }

  /** Every `POST /tool_router/session` body seen so far, in order. */
  sessionCalls(): FakeSessionCall[] {
    return this.#sessionCalls;
  }

  /** How many catalog GETs the fake served, for subrequest-count assertions. */
  getCounts(): FakeGetCounts {
    return this.#getCounts;
  }


  // -- Accounts ---------------------------------------------------------------
  //
  // The account is typed as its declared class surface, not the RPC stub mapping: the runtime's
  // mapping drops `unknown`-bearing members (`ExecuteEnvelope.result`, `ToolInfo.inputSchema`)
  // that are in fact delivered verbatim (same note as facet.ts's `account()`.

  #account(accountName: string): ComposioAccount {
    return this.ctx.exports.ComposioAccount.getByName(accountName) as unknown as ComposioAccount;
  }
  #accountObjectId(accountName: string): string {
    return this.ctx.exports.ComposioAccount.getByName(accountName).id.toString();
  }


  async keyState(accountName: string) {
    return await this.#account(accountName).keyState();
  }

  provisionOwnKey(accountName: string, key: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).provisionOwnKey(key);
      return null;
    });
  }

  dropOwnKey(accountName: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).dropOwnKey();
      return null;
    });
  }

  async sharingState(accountName: string) {
    return await this.#account(accountName).sharingState();
  }

  setSharing(accountName: string, on: boolean): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).setSharingEnabled(on);
      return null;
    });
  }

  // -- Mints (the account's validation chokepoint) ------------------------------

  /** Runs the account's mint validation and reports the refusal, if any. */
  mintCheck(
    accountName: string, url: string, policy?: ComposioToolkitPolicy,
  ): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).getGatekeeperClassFor(url, policy);
      return null;
    });
  }

  // -- Facets and sessions ------------------------------------------------------

  async #startSession(
    facetName: string,
    mint: () =>
      | DurableObjectClass<ComposioSingletonGatekeeper>
      | DurableObjectClass<ComposioToolkitGatekeeper>,
  ): Promise<void> {
    const stub = this.ctx.facets.get(facetName, () => ({ class: mint() }));
    const queue = new TestApprovalQueue();
    // The RPC-mapped parameter and return types lose the declared shapes (stub-to-stub conversion
    // noise plus the `unknown`-member drop), so both cross as their declared surfaces.
    const session = await stub.startSession(
      new RpcStub(queue) as unknown as Parameters<typeof stub.startSession>[0],
    ) as unknown as AnySession;
    this.#facets.set(facetName, {
      stub,
      // The runtime hands back a DurableObjectStub; its id names the DO for storage access.
      facetId: (stub as unknown as DurableObjectStub<ComposioToolkitGatekeeper>).id.toString(),
    });
    this.#queues.set(facetName, queue);
    this.#sessions.set(facetName, session);
  }

  /** Instantiates a toolkit facet directly (as an already-minted binding) and opens a session. */
  async toolkitSession(
    accountName: string,
    facetName: string,
    arming: { toolkitSlug: string; autoApply?: boolean; excluded?: boolean },
  ): Promise<void> {
    const props: ToolkitFacetProps = {
      accountObjectId: this.#accountObjectId(accountName),
      toolkitSlug: arming.toolkitSlug,
      excluded: arming.excluded === true,
      autoApply: arming.autoApply === true,
      generation: (await this.#account(accountName).keyState()).generation,
    };
    await this.#startSession(
      facetName, () => this.ctx.exports.ComposioToolkitGatekeeper({ props }));
  }

  /** Mints through the account's validation chokepoint, then opens a session on the minted facet. */
  async mintedToolkitSession(
    accountName: string,
    facetName: string,
    url: string,
    policy?: ComposioToolkitPolicy,
  ): Promise<void> {
    const minted = await this.#account(accountName).getGatekeeperClassFor(url, policy);
    await this.#startSession(facetName, () => minted.class as DurableObjectClass<
      ComposioToolkitGatekeeper
    >);
  }

  /**
   * The ambient singleton facet for one account, and a session on it. With a policy the mint
   * goes through the account (persisting it, as the kernel's mint does); without one the facet
   * is instantiated directly, the state an older deployment's facet is left in.
   */
  async singletonSession(
    accountName: string,
    facetName: string,
    policy?: ComposioToolkitPolicy,
  ): Promise<void> {
    const klass = policy === undefined
      ? this.ctx.exports.ComposioSingletonGatekeeper({
        props: { accountObjectId: this.#accountObjectId(accountName) },
      })
      : (await this.#account(accountName).getSingletonGatekeeperClass(policy)) as DurableObjectClass<ComposioSingletonGatekeeper>;
    await this.#startSession(facetName, () => klass);
  }

  /** The account's freshest persisted policy, for use-time re-check assertions. */
  async policyState(accountName: string) {
    return await this.#account(accountName).policyState();
  }

  /** The singleton session's listing, for exclusion-hiding assertions. */
  listToolkits(
    facetName: string,
  ): Promise<Attempt<{ toolkits: { slug: string; toolCount: number }[]; truncated: boolean }>> {
    return this.#attempt(() =>
      (this.#session(facetName) as ComposioSessionImpl).listToolkits());
  }

  /** The account's quota counters, for release assertions. */
  async usage(accountName: string) {
    return await this.#account(accountName).usage();
  }

  /** Runs the vendor's admin slug validation against the installed fake. The vendor always
   * runs on the deployment key; the fake surface makes any non-empty key work. */
  getToolkitInfo(
    slugs: string[],
  ): Promise<Attempt<ComposioToolkitInfo[]>> {
    return this.#attempt(async () => {
      const vendor = new GatekeeperVendor({} as never, {
        ...this.env,
        COMPOSIO_API_KEY: this.env.COMPOSIO_API_KEY ?? "test-deployment-key",
      });
      return await vendor.getToolkitInfo(slugs);
    });
  }

  #facet(facetName: string): HeldFacet["stub"] {
    const facet = this.#facets.get(facetName);
    if (facet === undefined) throw new Error(`no facet named "${facetName}" in the test hooks`);
    return facet.stub;
  }

  #session(facetName: string): AnySession {
    const session = this.#sessions.get(facetName);
    if (session === undefined) throw new Error(`no session named "${facetName}" in the test hooks`);
    return session;
  }

  /** The facet DO's id, so tests can reach its storage through `runInDurableObject`. */
  facetId(facetName: string): string {
    const facet = this.#facets.get(facetName);
    if (facet === undefined) throw new Error(`no facet named "${facetName}" in the test hooks`);
    return facet.facetId;
  }

  // -- Driving a session ------------------------------------------------------

  callTool(
    facetName: string, tool: string, args?: Record<string, unknown>, account?: string,
  ): Promise<Attempt<ComposioCallResult>> {
    return this.#attempt(() => this.#session(facetName).callTool(tool, args, account));
  }

  getActionResult(facetName: string, actionId: number): Promise<Attempt<ComposioCallResult>> {
    return this.#attempt(() => this.#session(facetName).getActionResult(actionId));
  }

  getInputRequest(facetName: string, id: string): Promise<Attempt<ComposioInputRequest[]>> {
    return this.#attempt(() => this.#session(facetName).getInputRequest(id));
  }

  continueTool(
    facetName: string, id: string, responses: Record<string, unknown>,
  ): Promise<Attempt<ComposioCallResult>> {
    return this.#attempt(() => this.#session(facetName).continueTool(id, responses));
  }

  // -- Driving a facet directly -------------------------------------------------

  applyAction(facetName: string, action: number): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      // The interface-mandated git-cache stub; Composio never touches it.
      await this.#facet(facetName).applyAction(
        action,
        new RpcStub(new UnusedGitCache()) as unknown as RpcStub<GitCache>,
      );
      return null;
    });
  }

  rejectAction(facetName: string, action: number): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#facet(facetName).rejectAction(action);
      return null;
    });
  }

  /** Rewinds a staged action's frozen generation, the state a switch-under-staging race leaves. */
  rewindStagedGeneration(facetName: string, action: number, generation: number): Promise<void> {
    return this.#facet(facetName).testRewindStagedGeneration(action, generation);
  }

  /** Expires every open continuation row, as the 1-hour TTL eventually does. */
  expireContinuations(facetName: string): Promise<void> {
    return this.#facet(facetName).testExpireContinuations();
  }

  /** The facet's continuation rows, for lifecycle assertions. */
  continuationRows(facetName: string): Promise<unknown[]> {
    return this.#facet(facetName).testContinuationRows();
  }

  async pendingActionCount(facetName: string): Promise<number> {
    return await this.#facet(facetName).pendingActionCount();
  }

  /** The facet's auto-apply list, flattened to the fields the suites assert on. */
  async autoApprovableActions(facetName: string): Promise<
    { kind: string; label: string }[]
  > {
    const kinds = await this.#facet(facetName).getAutoApprovableActions();
    return kinds.map(kind => ({ kind: kind.tag, label: kind.label }));
  }

  async describeFacet(
    facetName: string,
  ): Promise<{ url: string; title: string; suggestedBindingName: string }> {
    return await this.#facet(facetName).describe() as unknown as {
      url: string; title: string; suggestedBindingName: string;
    };
  }

  addObserver(facetName: string, observerId: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#facet(facetName).addObserver(
        observerId, new RpcStub(new TestVerifier()) as unknown as Fetcher<GatekeeperUserVerifier>);
      return null;
    });
  }

  removeObserver(facetName: string, observerId: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#facet(facetName).removeObserver(observerId);
      return null;
    });
  }

  /** What the facet's queue captured: submissions and observations, in order. */
  queueState(facetName: string): {
    submissions: CapturedSubmission[];
    observations: CapturedObservation[];
  } {
    const queue = this.#queues.get(facetName);
    if (queue === undefined) throw new Error(`no queue named "${facetName}" in the test hooks`);
    return { submissions: [...queue.submissions], observations: [...queue.observations] };
  }

  async #attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (err) {
      return {
        ok: false,
        name: err instanceof Error ? err.name : String(err),
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
