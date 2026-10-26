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
  HookTargetMetadata,
  ObservationDescription,
  ComposioToolkitInfo,
} from "@gadgets/workshop-shared/gatekeeper";

import type {
  ComposioAccount,
  ComposioTriggerRowPublic,
  ExpiryNotice,
} from "../../src/account.js";
import {
  ComposioSingletonGatekeeper,
  ComposioToolkitGatekeeper,
  type ToolkitFacetProps,
} from "../../src/facet.js";
import type { ComposioSessionImpl, ComposioToolkitSessionImpl } from "../../src/session.js";
import type {
  ComposioCallResult,
  ComposioInputRequest,
  ComposioTriggerFiring,
} from "../../src/types.js";
import { signWebhook } from "../../src/webhooks.js";
import { GatekeeperVendor, accountByName, setComposioFetchForTests } from "../../src/worker.js";
import { BindMarkerCallback } from "../worker.js";

/** The initiator entrypoint's test surface (minted through ctx.exports, never imported). */
type TestInitiatorFetcher = {
  configure(mode: string): void;
  read(): {
    firings: ComposioTriggerFiring[];
    observations: { title: string; description: string }[];
    startHookCalls: number;
    initiatorDisposed: number;
    callbacksDisposed: number;
  };
  reset(): void;
};
type TestInitiatorExports = {
  TestTriggerInitiator(options: object): TestInitiatorFetcher;
};
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

/** What the queue captured for one bound hook (enable/disable drive it from here). */
export type CapturedHook = { title: string; description: string };

/** One hook binding the queue holds: the controller fetcher, kept for enable/disable drives. */
type HeldHook = {
  controller: Fetcher<HookController<RpcTarget>>;
};

/** What the queue captured for one authorized observation. */
export type CapturedObservation = { title: string; description: string; fieldsJson: string };

export class TestApprovalQueue extends RpcTarget {
  readonly submissions: CapturedSubmission[] = [];
  readonly observations: CapturedObservation[] = [];
  readonly heldHooks: HeldHook[] = [];
  readonly hookDescriptions: CapturedHook[] = [];

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
    controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    description: HookDescription,
  ): Promise<void> {
    this.heldHooks.push({ controller: controller as Fetcher<HookController<RpcTarget>> });
    this.hookDescriptions.push({ title: description.title, description: description.description });
  }
}

// ---------------------------------------------------------------------------
// The fake trigger/webhook upstream: in-memory state the fetch router below
// serves, so suites can assert on every captured call and inject drift.

type FakeSubscription = { id: string; webhook_url: string; enabled_events: string[]; secret: string };
type FakeInstance = {
  id: string; trigger_name: string; user_id: string;
  trigger_config: unknown; disabled_at: string | null;
};

class FakeTriggerUpstream {
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly instances = new Map<string, FakeInstance>();
  readonly upserts: { slug: string; userId: string; config: unknown }[] = [];
  readonly instanceDeletes: string[] = [];
  readonly subscriptionCreates: { url: string; events: string[] }[] = [];
  readonly subscriptionPatches: { id: string; url?: string; events?: string[] }[] = [];
  readonly rotations: string[] = [];
  readonly subscriptionDeletes: string[] = [];
  subscriptionListings = 0;
  failUpserts = 0;
  failListing = false;
  #nextId = 1;

  secret(): string {
    return [...this.subscriptions.values()][0]?.secret ?? "";
  }

  /** Serves one request; returns undefined when the path is not this upstream's. */
  route(method: string, path: string, init: RequestInit | undefined): Response | undefined {
    const body = (): Record<string, unknown> =>
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "POST" && path === "/webhook_subscriptions") {
      const url = String(body().webhook_url ?? "");
      if ([...this.subscriptions.values()].some(sub => sub.webhook_url === url)) {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      const created: FakeSubscription = {
        id: `sub_${this.#nextId++}`,
        webhook_url: url,
        enabled_events: body().enabled_events as string[] ?? [],
        secret: `whsec_${Math.random().toString(36).slice(2, 10)}`,
      };
      this.subscriptions.set(created.id, created);
      this.subscriptionCreates.push({ url, events: [...created.enabled_events] });
      return Response.json(this.#row(created, true));
    }
    if (method === "GET" && path === "/webhook_subscriptions") {
      this.subscriptionListings++;
      return Response.json({
        items: [...this.subscriptions.values()].map(sub => this.#row(sub, true)),
        nextCursor: null,
      });
    }
    const subMatch = path.match(/^\/webhook_subscriptions\/([^/]+)(\/rotate_secret)?$/);
    if (subMatch !== null) {
      const id = decodeURIComponent(subMatch[1]);
      const sub = this.subscriptions.get(id);
      if (method === "PATCH" && sub !== undefined) {
        const patch = body();
        if (typeof patch.webhook_url === "string") sub.webhook_url = patch.webhook_url;
        if (Array.isArray(patch.enabled_events)) sub.enabled_events = patch.enabled_events as string[];
        this.subscriptionPatches.push({
          id,
          url: typeof patch.webhook_url === "string" ? patch.webhook_url : undefined,
          events: Array.isArray(patch.enabled_events)
            ? patch.enabled_events as string[]
            : undefined,
        });
        // Upstream omits the secret after PATCH; the account keeps its stored copy.
        return Response.json(this.#row(sub, false));
      }
      if (method === "POST" && subMatch[2] === "/rotate_secret" && sub !== undefined) {
        sub.secret = `whsec_rot_${Math.random().toString(36).slice(2, 10)}`;
        this.rotations.push(id);
        return Response.json({ secret: sub.secret });
      }
      if (method === "DELETE" && subMatch[2] === undefined) {
        if (sub === undefined) return new Response(null, { status: 404 });
        this.subscriptions.delete(id);
        this.subscriptionDeletes.push(id);
        return new Response(null, { status: 204 });
      }
    }
    const upsertMatch = path.match(/^\/trigger_instances\/([^/]+)\/upsert$/);
    if (method === "POST" && upsertMatch !== null) {
      const slug = decodeURIComponent(upsertMatch[1]);
      const payload = body();
      const userId = String(payload.user_id ?? "");
      this.upserts.push({ slug, userId, config: payload.trigger_config });
      if (this.failUpserts > 0) {
        this.failUpserts--;
        return Response.json({ error: "upstream unavailable" }, { status: 500 });
      }
      let instance = [...this.instances.values()]
        .find(row => row.user_id === userId && row.trigger_name === slug);
      if (instance === undefined) {
        instance = {
          id: `ti_${this.#nextId++}`, trigger_name: slug, user_id: userId,
          trigger_config: payload.trigger_config, disabled_at: null,
        };
        this.instances.set(instance.id, instance);
      } else {
        instance.trigger_config = payload.trigger_config;
        instance.disabled_at = null;
      }
      return Response.json({ trigger_id: instance.id });
    }
    const manageMatch = path.match(/^\/trigger_instances\/manage\/([^/]+)$/);
    if (method === "DELETE" && manageMatch !== null) {
      const id = decodeURIComponent(manageMatch[1]);
      if (!this.instances.has(id)) return new Response(null, { status: 404 });
      this.instances.delete(id);
      this.instanceDeletes.push(id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/trigger_instances/active") {
      if (this.failListing) {
        return Response.json({ error: "listing failed" }, { status: 500 });
      }
      return Response.json({
        items: [...this.instances.values()].map(row => ({
          id: row.id, trigger_name: row.trigger_name, user_id: row.user_id,
          trigger_config: row.trigger_config, disabled_at: row.disabled_at,
        })),
        nextCursor: null,
      });
    }
    return undefined;
  }

  #row(sub: FakeSubscription, withSecret: boolean): Record<string, unknown> {
    return {
      id: sub.id, webhook_url: sub.webhook_url, enabled_events: sub.enabled_events,
      ...(withSecret ? { secret: sub.secret } : {}),
    };
  }

  /** Rotates the first subscription's secret in place, as upstream would without telling us. */
  rotateFirst(): void {
    const first = [...this.subscriptions.values()][0];
    if (first !== undefined) first.secret = `whsec_rot_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Test-driven mutations of the fake upstream, for drift and failure injection. */
export type FakeTriggerMutation = {
  killInstance?: string;
  disableInstance?: string;
  injectInstance?: {
    id: string; triggerName: string; userId: string;
    triggerConfig?: unknown; disabledAt?: string;
  };
  failUpserts?: number;
  failListing?: boolean;
  /** Rotates the upstream secret WITHOUT telling the account (drift the ingest must self-heal). */
  rotateUpstreamSecret?: boolean;
};

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
  /** This TestHooks DO's id — the workspace scope every facet it mints inherits. */
  scopeId: string;
};

type AnySession = ComposioSessionImpl | ComposioToolkitSessionImpl;

export class TestHooks extends DurableObject<Cloudflare.Env> {
  readonly #facets = new Map<string, HeldFacet>();
  readonly #sessions = new Map<string, AnySession>();
  readonly #queues = new Map<string, TestApprovalQueue>();
  #executeCalls: FakeExecuteCall[] = [];
  #sessionCalls: FakeSessionCall[] = [];
  #getCounts: FakeGetCounts = { toolkits: 0, tools: 0 };
  #triggers = new FakeTriggerUpstream();

  // -- Faking the Composio REST surface --------------------------------------

  /** Installs (or, with null, removes) the fake REST surface the account and vendor call. */
  installFake(spec: FakeComposioSpec | null): void {
    if (spec === null) {
      this.#executeCalls = [];
      this.#sessionCalls = [];
      this.#getCounts = { toolkits: 0, tools: 0 };
      this.#triggers = new FakeTriggerUpstream();
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
      const routed = this.#triggers.route(method, path, init);
      if (routed !== undefined) return routed;
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

  // -- Triggers and webhooks ---------------------------------------------------

  /** The fake trigger upstream's calls and current state, as plain JSON. */
  triggerUpstreamState(): {
    upserts: { slug: string; userId: string; configJson: string }[];
    instanceDeletes: string[];
    subscriptionCreates: { url: string; events: string[] }[];
    subscriptionPatches: { id: string; url?: string; events?: string[] }[];
    rotations: string[];
    subscriptionDeletes: string[];
    subscriptionListings: number;
    instances: { id: string; triggerName: string; userId: string; disabled: boolean }[];
    subscriptions: { id: string; url: string }[];
  } {
    const t = this.#triggers;
    return {
      upserts: t.upserts.map(call => ({
        slug: call.slug, userId: call.userId, configJson: JSON.stringify(call.config ?? null),
      })),
      instanceDeletes: [...t.instanceDeletes],
      subscriptionCreates: t.subscriptionCreates.map(call => ({ ...call })),
      subscriptionPatches: t.subscriptionPatches.map(call => ({ ...call })),
      rotations: [...t.rotations],
      subscriptionDeletes: [...t.subscriptionDeletes],
      subscriptionListings: t.subscriptionListings,
      instances: [...t.instances.values()].map(row => ({
        id: row.id, triggerName: row.trigger_name, userId: row.user_id,
        disabled: row.disabled_at !== null,
      })),
      subscriptions: [...t.subscriptions.values()].map(sub => ({
        id: sub.id, url: sub.webhook_url,
      })),
    };
  }

  /** Mutates the fake upstream: drift and failure injection between calls. */
  mutateTriggers(mutation: FakeTriggerMutation): void {
    const t = this.#triggers;
    if (mutation.killInstance !== undefined) t.instances.delete(mutation.killInstance);
    if (mutation.disableInstance !== undefined) {
      const row = t.instances.get(mutation.disableInstance);
      if (row !== undefined) row.disabled_at = new Date().toISOString();
    }
    if (mutation.injectInstance !== undefined) {
      t.instances.set(mutation.injectInstance.id, {
        id: mutation.injectInstance.id,
        trigger_name: mutation.injectInstance.triggerName,
        user_id: mutation.injectInstance.userId,
        trigger_config: mutation.injectInstance.triggerConfig ?? {},
        disabled_at: mutation.injectInstance.disabledAt ?? null,
      });
    }
    if (mutation.failUpserts !== undefined) t.failUpserts += mutation.failUpserts;
    if (mutation.failListing !== undefined) t.failListing = mutation.failListing;
    if (mutation.rotateUpstreamSecret === true) t.rotateFirst();
  }

  /** The fake's current signing secret (what a signed ingest should use by default). */
  fakeWebhookSecret(): string {
    return this.#triggers.secret();
  }

  /** The persistent trigger initiator entrypoint, as the harness drives it. */
  #initiatorInstance?: TestInitiatorFetcher;
  #initiator(): TestInitiatorFetcher {
    // Cached: each exports.X({}) call mints a fresh DO instance, and recordings must be shared.
    return (this.#initiatorInstance ??=
      (this.ctx.exports as unknown as TestInitiatorExports).TestTriggerInitiator({}));
  }

  /** Registers a trigger through the session: parks it at the approval gate (bindHook). */
  createTrigger(
    facetName: string,
    config: { triggerSlug: string; filters?: Record<string, unknown> },
  ): Promise<Attempt<string>> {
    return this.#attempt(async () => {
      const session = this.#session(facetName) as ComposioSessionImpl;
      return await session.createTrigger(
        {
          triggerSlug: config.triggerSlug,
          ...(config.filters === undefined ? {} : { filters: config.filters }),
        },
        new BindMarkerCallback() as never,
      ) as string;
    });
  }

  /** The approval-gate descriptions createTrigger parked, in bind order. */
  capturedHooks(facetName: string): CapturedHook[] {
    return this.#queue(facetName).hookDescriptions;
  }

  /** What the overseer does on approval: hands the controller a persistent initiator. */
  enableCapturedHook(
    facetName: string,
    index: number,
    target?: HookTargetMetadata,
  ): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#queue(facetName).heldHooks[index].controller.enable(
        this.#initiator() as never,
        target ?? { workspaceId: "ws-test" },
      );
      return null;
    });
  }

  /** What the overseer does on denial or unbind. */
  disableCapturedHook(facetName: string, index: number): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#queue(facetName).heldHooks[index].controller.disable();
      return null;
    });
  }

  /**
   * Delivers one signed webhook envelope straight to the account (the DO call the worker's
   * route makes). Signs with `secret` (default: the fake's current secret) at `ageSeconds`.
   */
  async ingestSignedWebhook(
    accountName: string,
    envelope: Record<string, unknown>,
    options?: { secret?: string; ageSeconds?: number },
  ): Promise<number> {
    const rawBody = JSON.stringify(envelope);
    const webhookId = String(envelope.id ?? `msg_${Math.random().toString(36).slice(2)}`);
    const timestamp = String(Math.floor(Date.now() / 1000) - (options?.ageSeconds ?? 0));
    const signature = await signWebhook({
      webhookId, timestamp, rawBody,
      secret: options?.secret ?? this.#triggers.secret(),
    });
    return await this.#account(accountName).ingestWebhook(rawBody, webhookId, timestamp, signature);
  }

  /** The trigger initiator's recordings, as plain JSON (the full firing type does not cross RPC). */
  async readInitiator(): Promise<{
    firings: { triggerId: string; eventId: string; triggerSlug: string; dataJson: string }[];
    observations: { title: string; description: string }[];
    startHookCalls: number;
    initiatorDisposed: number;
    callbacksDisposed: number;
  }> {
    const read = await this.#initiator().read();
    return {
      firings: read.firings.map(firing => ({
        triggerId: firing.triggerId, eventId: firing.eventId, triggerSlug: firing.triggerSlug,
        dataJson: JSON.stringify(firing.data ?? null),
      })),
      observations: read.observations,
      startHookCalls: read.startHookCalls,
      initiatorDisposed: read.initiatorDisposed,
      callbacksDisposed: read.callbacksDisposed,
    };
  }

  async configureInitiator(mode: string): Promise<void> {
    await this.#initiator().configure(mode);
  }

  async resetInitiator(): Promise<void> {
    await this.#initiator().reset();
  }

  /** The account's armed triggers, for lifecycle assertions. */
  async accountTriggers(accountName: string): Promise<ComposioTriggerRowPublic[]> {
    return await this.#account(accountName).listTriggers();
  }

  async accountExpiryNotices(accountName: string): Promise<ExpiryNotice[]> {
    return await this.#account(accountName).expiryNotices();
  }

  async accountWebhookState(accountName: string) {
    return await this.#account(accountName).webhookState();
  }

  rotateWebhookSecretOnAccount(accountName: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).rotateWebhookSecret();
      return null;
    });
  }

  /** The session's deleteTrigger (observation + account disable). */
  deleteTriggerOnSession(facetName: string, triggerId: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await (this.#session(facetName) as ComposioSessionImpl).deleteTrigger(triggerId);
      return null;
    });
  }

  #queue(facetName: string): TestApprovalQueue {
    const queue = this.#queues.get(facetName);
    if (queue === undefined) throw new Error(`no queue named "${facetName}" in the test hooks`);
    return queue;
  }


  // -- Accounts ---------------------------------------------------------------
  //
  // The account is typed as its declared class surface, not the RPC stub mapping: the runtime's
  // mapping drops `unknown`-bearing members (`ExecuteEnvelope.result`, `ToolInfo.inputSchema`)
  // that are in fact delivered verbatim (same note as facet.ts's `account()`.

  #accountNames = new Set<string>();

  #account(accountName: string): ComposioAccount {
    this.#accountNames.add(accountName);
    return accountByName(this.ctx.exports.ComposioAccount, accountName);
  }

  /**
   * Hands over every account name any test has touched and clears the registry, so a test file
   * can cancel those Durable Objects' alarms before its own tests run: a trailing alarm firing
   * inside a later file would hit that file's fake upstream and corrupt its recordings.
   */
  drainAccountAlarmRegistry(): string[] {
    const names = [...this.#accountNames];
    this.#accountNames.clear();
    return names;
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

  /**
   * Pushes a toolkit policy to the account the way the Workshop does — out-of-band, ahead of
   * any mint (ComposioUserPolicy.updateToolkitPolicy).
   */
  setPolicy(accountName: string, policy: ComposioToolkitPolicy): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).updateToolkitPolicy(policy);
      return null;
    });
  }

  /** Runs the account's mint validation and reports the refusal, if any. */
  mintCheck(accountName: string, url: string): Promise<Attempt<null>> {
    return this.#attempt(async () => {
      await this.#account(accountName).getGatekeeperClassFor(url);
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
      scopeId: this.ctx.id.toString(),
    });
    this.#queues.set(facetName, queue);
    this.#sessions.set(facetName, session);
  }

  /** Instantiates a toolkit facet directly (as an already-minted binding) and opens a session. */
  async toolkitSession(
    accountName: string,
    facetName: string,
    { toolkitSlug }: { toolkitSlug: string },
  ): Promise<void> {
    const props: ToolkitFacetProps = {
      accountObjectId: this.#accountObjectId(accountName),
      toolkitSlug,
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
  ): Promise<void> {
    const minted = await this.#account(accountName).getGatekeeperClassFor(url);
    await this.#startSession(facetName, () => minted.class as DurableObjectClass<
      ComposioToolkitGatekeeper
    >);
  }

  /**
   * The ambient singleton facet for one account, and a session on it. With a policy the mint
   * goes through the account (persisting it first, as the kernel's out-of-band push does);
   * without one the facet is instantiated directly, the state an older deployment's facet is
   * left in.
   */
  async singletonSession(
    accountName: string,
    facetName: string,
    policy?: ComposioToolkitPolicy,
  ): Promise<void> {
    if (policy !== undefined) {
      await this.#account(accountName).updateToolkitPolicy(policy);
    }
    const klass = policy === undefined
      ? this.ctx.exports.ComposioSingletonGatekeeper({
        props: { accountObjectId: this.#accountObjectId(accountName) },
      })
      : (await this.#account(accountName).getSingletonGatekeeperClass()) as DurableObjectClass<ComposioSingletonGatekeeper>;
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

  /** The workspace scope every facet minted by this TestHooks DO inherits (its own id). */
  facetScopeId(facetName: string): string {
    const facet = this.#facets.get(facetName);
    if (facet === undefined) throw new Error(`no facet named "${facetName}" in the test hooks`);
    return facet.scopeId;
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
