// The Composio connector's entrypoint: the vendor the Workshop binds as GATEKEEPER_COMPOSIO, the
// trivial verifier, and the module seam every other module in this package logs and fetches
// through. The Durable Object classes named in cloudflare.config.ts's migration are re-exported
// here so the entrypoint exposes everything the runtime registers. README.md explains the design.

import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import type {
  ComposioToolkitInfo,
  ComposioVendorAdmin,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  workerVersionTag,
} from "@gadgets/workshop-shared/gatekeeper";

import { ComposioApi } from "./composio-api.js";
import {
  CONNECT_LINK_CALLBACK_PATH,
  deploymentApiKey,
  gatekeeperBasePath,
  VENDOR_ID,
} from "./config.js";

import { isAutoApplyEligible } from "./policy.js";
import { MAX_ENVELOPE_BYTES, parseWebhookEnvelope } from "./webhooks.js";
import TYPES_CODE from "./types.txt";
export { default as TYPES_CODE } from "./types.txt";

export { ComposioAccount } from "./account.js";
export {
  ComposioSingletonGatekeeper,
  ComposioToolkitGatekeeper,
} from "./facet.js";
export { startAppUi } from "./app-ui.js";
export { ComposioTriggerHookController } from "./triggers.js";

// ---------------------------------------------------------------------------
// Logging and the Composio fetch seam.
//
// worker.ts is the package's import leaf, so the logger and the fetch override live here and
// every sibling imports them. Tests substitute Composio's REST surface through
// setComposioFetchForTests(): composio-api is the only module that talks HTTP, and it only ever
// sees the fetch function it is handed.

/**
 * The field vocabulary this connector logs against: mcp-shared's (so the ActionStore's logger
 * contract is satisfied) plus the Composio-specific names. Reserved names (secret, token, ...)
 * are blocked by the logger itself; API keys, session ids, redirect URLs, tool arguments and
 * response bodies are never logged.
 */
export type ComposioLogFields = McpLogFields & {
  /** The Composio toolkit a line is about, when one is in scope. */
  toolkitSlug: string;
  /** "deployment" | "own": which project key an operation runs under. */
  keyMode: "deployment" | "own";
  /** A numeric Composio status code (never provider body text). */
  status: number;
  /** The continuation chain depth an input_required round reached. */
  chainDepth: number;
  /** Generic count (pending actions, admissions, ...) for the event on the line. */
  count: number;
  /** The upstream trigger slug a trigger lifecycle line is about. */
  triggerSlug: string;
  /** The workspace a delivered trigger event or quota line belongs to. */
  workspaceId: string;
  /** The webhook envelope kind an ingest line dropped (trigger/expired). */
  webhookType: string;
};

/** The package's one logger; siblings derive scoped copies with .with(). */
export const logger = createLogger<ComposioLogFields>({
  component: "gatekeeper.composio",
  vendorId: VENDOR_ID,
});

/**
 * The logger as mcp-shared's ActionStore sees it. mcp-shared requires its own field vocabulary;
 * {@link ComposioLogFields} extends it, so the same logger serves both.
 */
export const actionStoreLog: McpLog = logger;

let fetchOverride: typeof fetch | undefined;
let testHooksEnabled = false;

/**
 * The fetch function every ComposioApi in this package is constructed with. Production leaves
 * the override unset (the Workers global); tests install a fake REST surface.
 */
export function composioFetch(): typeof fetch {
  return fetchOverride ?? fetch;
}

/**
 * Installs (or, with undefined, restores) the fetch function Composio calls go through. Installing
 * a fake also enables the facets' test-only storage hooks below: a facet created through
 * `ctx.facets` cannot be re-addressed from a test's namespace binding (its id is not valid for
 * `idFromString`), so the workerd suite reaches facet SQLite through gated RPC methods instead.
 */
export function setComposioFetchForTests(fn: typeof fetch | undefined): void {
  fetchOverride = fn;
  testHooksEnabled = fn !== undefined;
}

/** Whether the test seam is active; production is always false. */
export function composioTestHooksEnabled(): boolean {
  return testHooksEnabled;
}

// ---------------------------------------------------------------------------
// The one SupportedResource: a grantable pattern matching every per-toolkit instance. Browsing
// the catalog lives in the gatekeeper app, not here (see plans/composio-gatekeeper.md "Surface").

const TOOLKIT_RESOURCE: SupportedResource = {
  urlPattern: "composio://toolkit/*",
  title: "Composio Toolkit",
  description:
    "One toolkit from the Composio catalog, such as github or slack. The agent gets that " +
    "toolkit's tools through the Composio broker; upstream credentials stay at Composio.",
  grantable: true,
};
export { TOOLKIT_RESOURCE };
@validateRpc()
export class GatekeeperVendor
  extends WorkerEntrypoint<Cloudflare.Env>
  implements ComposioVendorAdmin
{
  /** Describes the auto-provisioned Composio vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Composio",
      url: "https://composio.dev",
      tagline: "Reach hundreds of apps through one brokered connector",
      description:
        "Connect toolkits from Composio's catalog — GitHub, Slack, Linear, Notion, Gmail and " +
        "hundreds more — so agents can read and act in them. Upstream accounts connect through " +
        "Composio; this deployment spends its Composio project key unless you bring your own.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** The version tag of this Worker's running version, for the deployment's admins. */
  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  /**
   * Mints a new Composio account. The account is a stateful Durable Object, so the mint names a
   * stable instance (by a fresh random account id) rather than relying on a props-carrying class
   * object, which addresses a fresh instance per call — fine for the stateless scheduler/context
   * accounts, wrong for one that owns SQLite and KV state.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ComposioAccount.getByName(crypto.randomUUID()) as unknown as
      Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Composio is auto-provisioned and has no OAuth connect flow.");
  }

  /** Exactly one user-independent grantable resource: the per-toolkit pattern. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [TOOLKIT_RESOURCE];
  }

  /** The resource getGatekeeperClassFor mints facets for; kept beside the vendor's answer. */
  static toolkitResource(): SupportedResource {
    return TOOLKIT_RESOURCE;
  }

  /** Returns the agent-facing ComposioSession / ComposioToolkitSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Live validation of admin-entered toolkit slugs against Composio's catalog, with per-toolkit
   * counts under the auto-apply eligibility rule. Runs on the deployment key and fails closed
   * when it is unset — the admin editor would otherwise validate against nothing. Capped at 25
   * slugs per call (each known slug costs a paginated walk): an unbounded array from the admin
   * editor would fan out past the Workers subrequest limit.
   */
  async getToolkitInfo(slugs: string[]): Promise<ComposioToolkitInfo[]> {
    if (slugs.length > 25) {
      throw new Error("getToolkitInfo validates at most 25 toolkit slugs per call.");
    }
    const api = new ComposioApi(deploymentApiKey(this.env), composioFetch());
    const known = new Set<string>();
    await api.forEachToolkit(batch => {
      for (const toolkit of batch) known.add(toolkit.slug);
    });

    return await Promise.all(slugs.map(async slug => {
      if (!known.has(slug)) {
        return { slug, exists: false, eligibleToolCount: 0, destructiveToolCount: 0 };
      }
      // Count under the rule the auto-apply classification applies — the affirmative-tag rule
      // from policy.ts; the listing itself is what the admin is deciding here.
      let eligibleToolCount = 0;
      let destructiveToolCount = 0;
      await api.forEachTool(slug, batch => {
        for (const tool of batch) {
          if (tool.tags.includes("destructiveHint")) destructiveToolCount++;
          else if (isAutoApplyEligible(tool)) eligibleToolCount++;
        }
      });
      return { slug, exists: true, eligibleToolCount, destructiveToolCount };
    }));
  }
}

// ---------------------------------------------------------------------------
// Account addressing. The account is a stateful DO reached through ctx.exports, whose runtime
// stub type drops `unknown`-bearing members (`ExecuteEnvelope.result`, `ToolInfo.inputSchema`)
// that are in fact delivered verbatim — one shared cast per addressing mode keeps that fact
// written down once instead of copied at every call site.

/** The slice of a Durable Object namespace that addresses an account. */
type AccountNamespace = {
  idFromString(hexId: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
  getByName(name: string): DurableObjectStub;
};

/** The account DO by its hex object id, re-typed to its declared surface. */
export function accountById(
  ns: AccountNamespace,
  hexId: string,
): import("./account.js").ComposioAccount {
  return ns.get(ns.idFromString(hexId)) as unknown as import("./account.js").ComposioAccount;
}

/** The account DO by its stable name, re-typed to its declared surface. */
export function accountByName(
  ns: AccountNamespace,
  name: string,
): import("./account.js").ComposioAccount {
  return ns.getByName(name) as unknown as import("./account.js").ComposioAccount;
}

// ---------------------------------------------------------------------------
// Verifier. Composio admits observers only under the owner's explicit sharing consent, verified
// against the account DO's consent flag; the verifier itself is never interrogated.

@validateRpc()
export class ComposioVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// HTTP surface. The vendor stays the RPC entrypoint (bindings name `GatekeeperVendor`); the
// default object adds the plain-HTTP routes the outside world reaches: Composio's webhook
// deliveries and the Connect Link completion page. The webhook route routes by unverified
// envelope contents only to pick a Durable Object — the account verifies the Standard Webhooks
// signature before any parsed field is acted on, so a forged user_id reaches at most an
// unsatisfiable 401. Body contents are never logged here.

const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Connect Link completion page: static, inert (polling confirms completion, never this URL). */
const CONNECT_CALLBACK_HTML =
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
  "<title>Composio connection</title></head>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Connection complete</h1>" +
  "<p>You can close this window and return to the Workshop.</p></body></html>";

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = gatekeeperBasePath(env);
    const relPath = url.pathname.slice(basePath.length);

    if (request.method === "POST"
      && (relPath === "/webhook" || (basePath === "" && url.pathname === "/webhook"))) {
      return await handleWebhook(request, ctx);
    }

    const callbackPath = basePath === "" ? "/connect-callback" : `${basePath}/connect-callback`;
    if (url.pathname === callbackPath || url.pathname === CONNECT_LINK_CALLBACK_PATH) {
      return new Response(CONNECT_CALLBACK_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/** Routes one webhook delivery to the account its (unverified) envelope names. */
async function handleWebhook(request: Request, ctx: ExecutionContext): Promise<Response> {
  const webhookId = request.headers.get("webhook-id") ?? "";
  const timestamp = request.headers.get("webhook-timestamp") ?? "";
  const signature = request.headers.get("webhook-signature") ?? "";
  if (webhookId === "" || timestamp === "" || signature === "") {
    return new Response(null, { status: 400 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_ENVELOPE_BYTES) {
    return new Response(null, { status: 413 });
  }
  const parsed = parseWebhookEnvelope(rawBody);
  if (!parsed.ok) {
    return new Response(null, { status: 400 });
  }
  const event = parsed.event;
  if (event.kind === "unknown") {
    // An event type this deployment never subscribed to; ACK so Composio stops delivering it.
    return new Response(null, { status: 200 });
  }
  if (event.routedAccountId === null) {
    // Connected-account expiry without the deprecated user_id field: no account to route to.
    logger.info("webhook event unroutable, acknowledged and dropped", {
      event: "webhook.ingest.unroutable",
      webhookType: event.kind,
    });
    return new Response(null, { status: 200 });
  }
  if (!ACCOUNT_ID_PATTERN.test(event.routedAccountId)) {
    // Never a name this deployment minted (createAccount uses uuids); ACK rather than mint
    // junk Durable Objects from forged posts.
    logger.info("webhook routed to a non-account id, acknowledged", {
      event: "webhook.ingest.bad-account",
    });
    return new Response(null, { status: 200 });
  }
  const account = accountByName(ctx.exports.ComposioAccount, event.routedAccountId);
  const status = await account.ingestWebhook(rawBody, webhookId, timestamp, signature);
  return new Response(null, { status });
}
