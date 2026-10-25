// The only module that talks HTTP to Composio (plans/composio-gatekeeper.md "Architecture").
// Layering rule inherited from gatekeeper-cloudflare's observability modules: every response is
// validated by hand before use — no blind casts, no zod — and thrown errors carry numeric status
// only, never provider response text (Composio can echo caller data, including secrets, back in
// error bodies). This module never logs anything: not the API key, not session ids, not tool
// arguments, not response bodies; callers log numeric codes from `ComposioApiError.status`.

import { API_BASE } from "./config.js";

/** Which project key a call spends: the deployment's or the user's own. */
export type KeyMode = "deployment" | "own";

/** A toolkit as listed by `GET /toolkits`. */
export interface ToolkitSummary {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
}

/** A tool as listed by `GET /tools`. */
export interface ToolInfo {
  slug: string;
  toolkitSlug: string;
  name: string;
  description?: string;
  tags: string[];
  readOnlyHint: boolean | null;
  inputSchema?: unknown;
}

/** A connected account as listed by `GET /connected_accounts`. */
export interface ConnectedAccountInfo {
  id: string;
  toolkitSlug: string;
  alias?: string;
  /** e.g. "ACTIVE" | "EXPIRED" | ... */
  status: string;
  clientUniqueId?: string;
  createdAt?: string;
}

/** A question a tool asked on the `input_required` path. */
export interface InputRequest {
  id: string;
  question: string;
  options?: string[];
}

/** The four-state execute envelope returned by `POST .../execute`. */
export type ExecuteEnvelope =
  | { resultType: "completed"; result: unknown; logId: string | null }
  | { resultType: "failed"; error: string; logId: string | null }
  | { resultType: "blocked"; error: string; logId: string | null }
  | { resultType: "input_required"; logId: string | null;
      inputRequests: InputRequest[]; requestState: string };

/**
 * A Composio REST failure. `status` is the numeric code callers may log; `message` is our own
 * text, never provider body text (the provider may echo secrets).
 */
export class ComposioApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ComposioApiError";
  }
}

/** The package's one canonical object guard: narrows to a record whose fields remain `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ComposioApiError(502, `Composio returned an invalid response (${field}).`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse `{items, nextCursor?}` cursor pagination envelopes shared by list endpoints. */
function parsePage(value: unknown): { items: unknown[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new ComposioApiError(502, "Composio returned an invalid response (page).");
  }
  const nextCursor = optionalString(value.nextCursor);
  return { items: value.items, nextCursor: nextCursor && nextCursor !== "" ? nextCursor : null };
}

function parseToolkit(value: unknown): ToolkitSummary {
  if (!isRecord(value)) throw new ComposioApiError(502, "Invalid toolkit item.");
  return {
    slug: requireString(value.slug, "toolkit.slug"),
    name: requireString(value.name, "toolkit.name"),
    description: optionalString(value.description),
    logo: optionalString(value.logo),
  };
}

function parseTool(value: unknown, fallbackToolkitSlug: string): ToolInfo {
  if (!isRecord(value)) throw new ComposioApiError(502, "Invalid tool item.");
  const toolkitField = isRecord(value.toolkit) ? value.toolkit : undefined;
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const readOnlyHint =
    typeof value.read_only_hint === "boolean" ? value.read_only_hint :
    typeof value.readOnlyHint === "boolean" ? value.readOnlyHint :
    null;
  return {
    slug: requireString(value.slug, "tool.slug"),
    toolkitSlug: optionalString(toolkitField?.slug) ?? fallbackToolkitSlug,
    name: requireString(value.name, "tool.name"),
    description: optionalString(value.description),
    tags,
    readOnlyHint,
    inputSchema: value.input_parameters ?? value.inputSchema,
  };
}

function parseConnectedAccount(value: unknown): ConnectedAccountInfo {
  if (!isRecord(value)) throw new ComposioApiError(502, "Invalid connected account item.");
  const toolkitField = isRecord(value.toolkit) ? value.toolkit : undefined;
  return {
    id: requireString(value.id, "connected_account.id"),
    toolkitSlug: optionalString(toolkitField?.slug)
      ?? requireString(value.toolkit_slug, "connected_account.toolkit_slug"),
    alias: optionalString(value.alias),
    status: requireString(value.status, "connected_account.status"),
    clientUniqueId: optionalString(value.client_unique_id),
    createdAt: optionalString(value.created_at),
  };
}

function parseInputRequest(value: unknown): InputRequest {
  if (!isRecord(value)) throw new ComposioApiError(502, "Invalid input request.");
  const options = Array.isArray(value.options)
    ? value.options.filter((o): o is string => typeof o === "string")
    : undefined;
  return {
    id: requireString(value.id, "input_request.id"),
    question: requireString(value.question, "input_request.question"),
    options,
  };
}

function parseExecuteEnvelope(value: unknown): ExecuteEnvelope {
  if (!isRecord(value)) throw new ComposioApiError(502, "Invalid execute response.");
  const logId = optionalString(value.log_id) ?? null;
  switch (value.result_type) {
    case "completed":
      return { resultType: "completed", result: value.result, logId };
    case "failed":
    case "blocked":
      return { resultType: value.result_type, error: optionalString(value.error) ?? "", logId };
    case "input_required": {
      const requests = Array.isArray(value.input_requests)
        ? value.input_requests.map(parseInputRequest)
        : [];
      return {
        resultType: "input_required",
        logId,
        inputRequests: requests,
        requestState: requireString(value.request_state, "execute.request_state"),
      };
    }
    default:
      throw new ComposioApiError(502, "Composio returned an invalid response (result_type).");
  }
}

const PAGE_LIMIT = 500;
const MAX_RETRIES = 3;

/**
 * Composio Platform REST client. `fetchFn` is injectable for tests; production callers pass the
 * deployment key or the account's own key — this class never sees where it came from.
 */
export class ComposioApi {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(apiKey: string, fetchFn?: typeof fetch) {
    this.#apiKey = apiKey;
    this.#fetch = fetchFn ?? fetch;
  }

  /** Issue one request; 429 honors `Retry-After` with bounded backoff; errors carry status only. */
  async #request(path: string, init?: RequestInit): Promise<unknown> {
    let retryAfterMs = 0;
    for (let attempt = 0; ; attempt++) {
      if (retryAfterMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, retryAfterMs);
        await promise;
      }
      let response: Response;
      try {
        response = await this.#fetch(`${API_BASE}${path}`, {
          ...init,
          headers: { "x-api-key": this.#apiKey, ...init?.headers },
        });
      } catch {
        throw new ComposioApiError(0, `Composio request failed before a response (${path}).`);
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const seconds = Number(response.headers.get("retry-after"));
        retryAfterMs = Number.isFinite(seconds) && seconds >= 0
          ? Math.min(seconds, 30) * 1000
          : 1000;
        continue;
      }
      if (!response.ok) {
        throw new ComposioApiError(response.status, `Composio returned ${response.status} (${path}).`);
      }
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        throw new ComposioApiError(502, `Composio returned an invalid response (${path}).`);
      }
    }
  }

  /** `GET /toolkits` succeeds — live key validation for BYO. */
  async validateKey(): Promise<void> {
    await this.#request(`/toolkits?limit=1`);
  }

  /** Cursor-paginate `GET /toolkits` (limit 500, Retry-After honored); calls `page` per batch. */
  async forEachToolkit(page: (batch: ToolkitSummary[]) => void): Promise<void> {
    let cursor: string | null = null;
    do {
      const query = `/toolkits?limit=${PAGE_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const parsed = parsePage(await this.#request(query));
      page(parsed.items.map(parseToolkit));
      cursor = parsed.nextCursor;
    } while (cursor !== null);
  }

  /** Cursor-paginate `GET /tools` for one toolkit; calls `page` per batch. */
  async forEachTool(toolkitSlug: string, page: (batch: ToolInfo[]) => void): Promise<void> {
    let cursor: string | null = null;
    do {
      const query = `/tools?toolkits=${encodeURIComponent(toolkitSlug)}&limit=${PAGE_LIMIT}` +
        (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const parsed = parsePage(await this.#request(query));
      page(parsed.items.map((item) => parseTool(item, toolkitSlug)));
      cursor = parsed.nextCursor;
    } while (cursor !== null);
  }

  /**
   * Create a session MCP session for `composioUserId` with every meta-tool knob disabled and
   * multi-account mode on; returns the session id plus the streamable-HTTP endpoint and the
   * `x-api-key`-bearing headers Composio returns verbatim.
   */
  async createSession(composioUserId: string): Promise<{
    sessionId: string; mcpUrl: string; headers: Record<string, string>;
  }> {
    const body = await this.#request("/tool_router/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        composio_user_id: composioUserId,
        mcp: true,
        multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true },
        workbench: { enable: false },
        manage_connections: { enable: false },
        search: { enable: false },
        execute: { enable_multi_execute: false },
      }),
    });
    if (!isRecord(body) || !isRecord(body.mcp) || !isRecord(body.mcp.headers)) {
      throw new ComposioApiError(502, "Composio returned an invalid response (session).");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.mcp.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
    return {
      sessionId: requireString(body.id, "session.id"),
      mcpUrl: requireString(body.mcp.url, "session.mcp.url"),
      headers,
    };
  }

  /** Tear down a session; a 404 (already gone) is success so teardown is idempotent. */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.#request(`/tool_router/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch (err) {
      if (!(err instanceof ComposioApiError) || err.status !== 404) throw err;
    }
  }

  /** Execute one tool call inside a session; returns the raw four-state envelope. */
  async execute(sessionId: string, payload: {
    tool: string; arguments: unknown; account?: string;
    requestState?: string; inputResponses?: Record<string, unknown>; action?: "decline";
  }): Promise<ExecuteEnvelope> {
    const body: Record<string, unknown> = {
      tool: payload.tool,
      arguments: payload.arguments,
    };
    if (payload.account !== undefined) body.account = payload.account;
    if (payload.requestState !== undefined) body.request_state = payload.requestState;
    if (payload.inputResponses !== undefined) body.input_responses = payload.inputResponses;
    if (payload.action !== undefined) body.action = payload.action;
    return parseExecuteEnvelope(await this.#request(
      `/tool_router/session/${encodeURIComponent(sessionId)}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
  }

  /** Cursor-paged connected accounts for one Composio user. */
  async listConnectedAccounts(composioUserId: string): Promise<ConnectedAccountInfo[]> {
    const accounts: ConnectedAccountInfo[] = [];
    let cursor: string | null = null;
    do {
      const query = `/connected_accounts?composio_user_id=${encodeURIComponent(composioUserId)}` +
        `&limit=${PAGE_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const parsed = parsePage(await this.#request(query));
      accounts.push(...parsed.items.map(parseConnectedAccount));
      cursor = parsed.nextCursor;
    } while (cursor !== null);
    return accounts;
  }

  /** One connected account, or null when Composio answers 404. */
  async getConnectedAccount(id: string): Promise<ConnectedAccountInfo | null> {
    try {
      return parseConnectedAccount(
        await this.#request(`/connected_accounts/${encodeURIComponent(id)}`));
    } catch (err) {
      if (!(err instanceof ComposioApiError) || err.status !== 404) throw err;
      return null;
    }
  }

  /** Delete a connected account; 404 (already gone) is success. */
  async deleteConnectedAccount(id: string): Promise<void> {
    try {
      await this.#request(`/connected_accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof ComposioApiError) || err.status !== 404) throw err;
    }
  }

  /** Rename a connected account (aliases are mutable labels, never identity). */
  async setAlias(id: string, alias: string): Promise<void> {
    await this.#request(`/connected_accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias }),
    });
  }

  /** Mint a Connect Link inside a session; returns the redirect URL and the attempt's account id. */
  async createConnectLink(sessionId: string, opts: {
    toolkit: string; alias?: string; callbackUrl: string;
  }): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const body = await this.#request(
      `/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolkit: opts.toolkit,
          ...(opts.alias === undefined ? {} : { alias: opts.alias }),
          callback_url: opts.callbackUrl,
        }),
      });
    if (!isRecord(body)) {
      throw new ComposioApiError(502, "Composio returned an invalid response (link).");
    }
    return {
      redirectUrl: requireString(body.redirect_url, "link.redirect_url"),
      connectedAccountId: requireString(body.connected_account_id, "link.connected_account_id"),
    };
  }
}
