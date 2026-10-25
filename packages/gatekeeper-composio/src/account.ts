// The Composio account: one stateful Durable Object per user, implementing the GatekeeperUser
// surface for the Workshop. It owns everything with a lifetime: the active key mode (the
// deployment's project key or the owner's own), the Composio MCP sessions per mode, the per-day
// quota, the REST-assembled toolkit catalog cache, toolkit-policy-frozen facets, observer-consent
// admissions, and the connected upstream accounts. The gatekeeper facets it mints (facet.ts) hold
// no Composio credentials at all — every upstream call funnels back through executeTool() here,
// where the key-mode generation fence, quota, meta-tool refusal, and session management are
// enforced once. README.md explains the design.

import { DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  AgentCatalog,
  AppUiContext,
  ComposioToolkitPolicy,
  Gatekeeper,
  GatekeeperUiFrame,
  GatekeeperUserVerifier,
  SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";

import {
  assembleCatalog,
  findToolkit,
  toolsForToolkit,
  type CatalogEntry,
  type CatalogSnapshot,
} from "./catalog.js";
import {
  ComposioApi,
  ComposioApiError,
  type ConnectedAccountInfo,
  type ExecuteEnvelope,
  type ToolInfo,
} from "./composio-api.js";
import { ToolkitPolicy, resolveToolkitPolicy } from "./policy.js";
import {
  CONNECT_LINK_CALLBACK_PATH,
  dailyCallLimit,
  deploymentApiKey,
  isMetaTool,
} from "./config.js";
import type { SingletonFacetProps, ToolkitFacetProps } from "./facet.js";
import { QuotaTable, quotaDay, type QuotaCounters } from "./quota.js";
import { startAppUi } from "./app-ui.js";
import { TOOLKIT_RESOURCE, composioFetch, logger } from "./worker.js";

/** Which Composio project key this account spends: the deployment's, or the owner's own. */
export type ComposioKeyMode = "deployment" | "own";

const COMPOSIO_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 " +
        "88-88 88.1 88.1 0 0 1-88 88Zm48-88a48 48 0 0 1-48 48v16a64 64 0 0 0 64-64Zm-48-32" +
        "a32 32 0 1 1-32 32 32 32 0 0 1 32-32Z'/></svg>",
    ),
};

/** One tool call dispatched through the account, from a facet (write) or a session (read). */
export type ComposioExecuteRequest = {
  tool: string;
  arguments: unknown;
  /** Connected-account id or alias, when several accounts of the toolkit are connected. */
  account?: string;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
  /**
   * The tool's toolkit, as the stager resolved it from the catalog. The account re-checks the
   * deployment's exclusion policy against it at dispatch, so an admin exclusion reaches actions
   * staged before it. Absent only on pre-upgrade rows: the catalog lookup then backstops.
   */
  toolkitSlug?: string;
  /** The key-mode generation the call was staged under; a mismatch strands it pre-dispatch. */
  generation: number;
  /** Declines an upstream input_required continuation instead of executing (nothing runs). */
  decline?: boolean;
};

/** executeTool()'s answer: a raw envelope to settle, or a refusal that never reached Composio. */
export type ComposioExecuteOutcome =
  | { status: "envelope"; envelope: ExecuteEnvelope }
  | { status: "refused"; message: string }
  | { status: "stranded"; message: string };

/** The account's key-mode state as its own UI and the sessions read it. */
export type ComposioKeyState = {
  keyMode: ComposioKeyMode;
  /** Bumped on every key-mode switch; actions staged under an older one are stranded. */
  generation: number;
  /** True when this deployment has a Composio project key configured. */
  deploymentKeyAvailable: boolean;
  /** True when the owner's own key is set (only meaningful in "own" mode). */
  ownKeySet: boolean;
};

/** What registerFacet() records for the key-mode fence and the sharing arming check. */
export type ComposioFacetRegistration = {
  /** Which DO class the facet is, so the key-switch fan-out pings the right namespace. */
  kind: "singleton" | "toolkit";
  toolkitSlug?: string;
  generation: number;
  autoApplyListed: boolean;
};

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_CACHE_KEY = "catalog-snapshot-v1";
const TOOLKIT_LISTING_LIMIT = 30;
const SEARCH_RESULT_LIMIT = 50;
/** Facet ids are `toolkit:<slug>` / `singleton` names; a slug this long is garbage input. */
const MAX_SLUG_LENGTH = 120;
/** HTTP statuses Composio can only have answered before executing anything. */
const PRE_EXECUTION_4XX: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

@validateRpc()
export class ComposioAccount extends DurableObject<Cloudflare.Env> {
  readonly #quota: QuotaTable;
  #mutex: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#quota = new QuotaTable(ctx.storage.sql);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS composio_admissions (
      observer_id TEXT PRIMARY KEY,
      admitted_at INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS composio_facets (
      facet_id TEXT PRIMARY KEY,
      facet_kind TEXT NOT NULL CHECK (facet_kind IN ('singleton', 'toolkit')),
      toolkit_slug TEXT,
      generation INTEGER NOT NULL,
      auto_apply_listed INTEGER NOT NULL,
      pending_actions INTEGER NOT NULL DEFAULT 0,
      registered_at INTEGER NOT NULL
    ) STRICT`);
    // Counters recorded before the column existed (dev storages) backfill to fail-closed zero.
    try {
      ctx.storage.sql.exec(
        "ALTER TABLE composio_facets ADD COLUMN pending_actions INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already present.
    }
  }

  /** The stable account id this DO was named with at mint (createAccount's random uuid). */
  get accountId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  /** The Composio user id every REST and session call runs as. */
  get composioUserId(): string {
    return `workshop-${this.accountId}`;
  }

  // -- GatekeeperUser --------------------------------------------------------

  /** Describes the account: an agent singleton plus the full-page Composio app. */
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Composio",
      avatar: COMPOSIO_ICON,
      singleton: { tsType: "ComposioSession" },
      providesUi: { title: "Composio" },
    };
  }

  /** The one grantable resource: the per-toolkit pattern (user-independent, see README). */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [TOOLKIT_RESOURCE];
  }

  /**
   * Mints the facet for one toolkit resource URL. Fails closed — unknown slug (checked against
   * the live catalog), admin-excluded toolkit, or a deployment-mode account with no deployment
   * key all refuse the mint — and freezes the deployment's toolkit policy and the account's
   * current key-mode generation into the facet's props, so a later exclusion or key switch can
   * never widen what an already-minted facet allows.
   */
  async getGatekeeperClassFor(
    url: string,
    composioPolicy?: ComposioToolkitPolicy,
  ): Promise<{ class: DurableObjectClass<Gatekeeper<unknown>>; resource: SupportedResource }> {
    const slug = parseToolkitUrl(url);
    if (slug === null) {
      throw new Error(
        `"${url}" is not a Composio toolkit URL (expected composio://toolkit/<slug>).`);
    }

    const keyState = await this.#keyState();
    if (keyState.keyMode === "deployment" && !keyState.deploymentKeyAvailable) {
      throw new Error(
        "This deployment has no Composio project key configured; no toolkit can be used.");
    }

    const snapshot = await this.#catalog();
    const entry = findToolkit(snapshot, slug);
    if (entry === undefined) {
      throw new Error(`"${slug}" is not a toolkit in Composio's catalog.`);
    }

    const policy = await this.#refreshPolicy(composioPolicy);
    const excluded = !policy.allows(slug);
    if (excluded) {
      throw new Error(
        `The "${entry.name}" toolkit is excluded by this deployment's Composio policy.`);
    }

    const props: ToolkitFacetProps = {
      accountObjectId: this.ctx.id.toString(),
      toolkitSlug: slug,
      excluded,
      autoApply: policy.autoApplyListed(slug),
      generation: keyState.generation,
    };
    return {
      class: this.ctx.exports.ComposioToolkitGatekeeper({ props }),
      resource: TOOLKIT_RESOURCE,
    };
  }

  /** The toolkit catalog browser lives in the app UI, not a resource configurator. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<GatekeeperUiFrame> {
    throw new Error("Composio is configured through its app, not a resource configurator.");
  }

  /** Confirms the toolkit URL names a usable toolkit; nothing further is ever staged. */
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    if (resourceUrlPatterns.length > 1) {
      throw new Error("Composio grants one toolkit resource at a time.");
    }
    // Route through the mint checks so exclusion and fail-closed behavior cannot drift; the
    // mint re-reads the freshest persisted policy, so an admin exclusion bites here too.
    const url = resourceUrlPatterns[0];
    if (url !== undefined) await this.getGatekeeperClassFor(url);
    return {};
  }

  /**
   * Revokes the account: deletes every connected upstream account (best-effort), tears down the
   * Composio sessions, then drops all state. PR 4 adds trigger-instance and webhook-subscription
   * teardown here (see plans/composio-gatekeeper.md "Keys" — the subscription is per project).
   */
  async revoke(): Promise<void> {
    await this.#serialized(async () => {
      try {
        const api = await this.#api();
        for (const connected of await api.listConnectedAccounts(this.composioUserId)) {
          await api.deleteConnectedAccount(connected.id);
        }
      } catch (err) {
        logger.warn("revocation could not delete connected accounts", {
          event: "account.revoke.connected-accounts-failed", error: err,
        });
      }
      await this.#deleteSessions();
      logger.info("account revoked", { event: "account.revoke.completed" });
    });
    // SQLite goes with the namespace; the upstream connected accounts above are the state that
    // outlives this object.
    await this.ctx.storage.deleteAll();
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Composio is auto-provisioned and has no reconnect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Composio is auto-provisioned and has no reconnect flow.");
  }

  /** Composio fronts third-party accounts, not identities; nothing verified to report. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ComposioVerifier({});
  }

  /** The ambient singleton's facet; it serves every toolkit at once (see facet.ts). */
  async getSingletonGatekeeperClass(composioPolicy?: ComposioToolkitPolicy)
      : Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    // The singleton facet carries no frozen policy: it re-reads the persisted one at use time.
    // The kernel passes it fresh at every mint, so this is the policy's main refresh channel.
    await this.#refreshPolicy(composioPolicy);
    const props: SingletonFacetProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.ComposioSingletonGatekeeper({ props });
  }

  /** The full-page Composio app (catalog browser, keys, sharing, usage). */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    return startAppUi(context, this);
  }

  /**
   * Persists `composioPolicy` when the call carried one, then resolves the freshest policy seen
   * (facet mint, singleton mint). An undefined policy never overwrites: absence means "this call
   * carried none", never "the deployment emptied its lists".
   */
  async #refreshPolicy(composioPolicy?: ComposioToolkitPolicy): Promise<ToolkitPolicy> {
    if (composioPolicy !== undefined) {
      await this.ctx.storage.put("toolkitPolicy", {
        excludedToolkits: composioPolicy.excludedToolkits,
        autoApplyToolkits: composioPolicy.autoApplyToolkits,
      });
    }
    return resolveToolkitPolicy(
      await this.ctx.storage.get<ComposioToolkitPolicy>("toolkitPolicy"));
  }

  /** The freshest toolkit policy seen, for the facets' and sessions' use-time re-checks. */
  async policyState(): Promise<ComposioToolkitPolicy | undefined> {
    return await this.ctx.storage.get<ComposioToolkitPolicy>("toolkitPolicy");
  }

  // -- Key mode and quota ----------------------------------------------------

  /** The account's key-mode state. */
  async keyState(): Promise<ComposioKeyState> {
    return await this.#keyState();
  }

  /**
   * Switches to the owner's own Composio key. Refused while any facet still holds a pending
   * (approval-queued or open-continuation) action — those actions were authorized against the
   * current project, and a silent switch would spend a different project's quota under them.
   * Otherwise: bumps the generation (stranding still-staged actions pre-dispatch), deletes the
   * Composio sessions, and invalidates the catalog cache. The key itself is validated live by
   * the app UI before it ever reaches here.
   */
  async provisionOwnKey(key: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      throw new Error("An own Composio key is required.");
    }
    await this.#switchKeyMode("own", key);
  }

  /**
   * Returns to the deployment key. Same fence and fencing semantics as provisionOwnKey(): a
   * clear is a switch, and own-key actions still staged are stranded rather than run.
   */
  async dropOwnKey(): Promise<void> {
    await this.#switchKeyMode("deployment", undefined);
  }

  async #switchKeyMode(mode: ComposioKeyMode, ownKey: string | undefined): Promise<void> {
    await this.#serialized(async () => {
      const pending = this.#pendingFanOut();
      if (pending > 0) {
        throw new Error(
          `Cannot switch the Composio key while ${pending} queued action(s) are still ` +
          "awaiting approval or input. Approve, reject, or let them expire first.");
      }

      await this.#deleteSessions();
      const generation = (await this.ctx.storage.get<number>("generation") ?? 1) + 1;
      await this.ctx.storage.put("generation", generation);
      await this.ctx.storage.put("keyMode", mode);
      if (ownKey === undefined) await this.ctx.storage.delete("ownApiKey");
      else await this.ctx.storage.put("ownApiKey", ownKey);
      await this.ctx.storage.delete(CATALOG_CACHE_KEY);

      logger.info("key mode switched", {
        event: "account.key.switched", keyMode: mode, count: generation,
      });
    });
  }

  /**
   * Dispatches one tool call to Composio under the account's active key and quota. Transport
   * failures settle the quota first (the call may have landed) and then rethrow raw: the caller
   * applies its own settlement policy — ActionStore already fails plain errors closed. The
   * four-state envelope is the caller's to settle: reads map it directly, writes run
   * settleExecute() (settlement.ts).
   */
  async executeTool(request: ComposioExecuteRequest): Promise<ComposioExecuteOutcome> {
    const keyState = await this.#keyState();
    if (request.generation !== keyState.generation) {
      return {
        status: "stranded",
        message:
          "The Composio key was switched after this action was approved, so it was not run. " +
          "Stage it again under the new key.",
      };
    }
    if (request.decline === true) {
      // A decline is a control message ("run nothing"), so it skips the meta-tool check and
      // the quota; it still needs the active key and session to reach Composio at all.
      let declineKey: string;
      try {
        declineKey = await this.#activeApiKey(keyState);
      } catch (err) {
        return { status: "refused", message: err instanceof Error ? err.message : String(err) };
      }
      const api = new ComposioApi(declineKey, composioFetch());
      const sessionId = await this.#ensureSession(api, keyState.keyMode, keyState.generation);
      const envelope = await api.execute(sessionId, {
        tool: request.tool,
        arguments: request.arguments,
        ...(request.account === undefined ? {} : { account: request.account }),
        ...(request.requestState === undefined ? {} : { requestState: request.requestState }),
        action: "decline",
      });
      return { status: "envelope", envelope };
    }
    if (isMetaTool(request.tool)) {
      return {
        status: "refused",
        message: `The "${request.tool}" meta-tool is disabled by this deployment.`,
      };
    }
    const policy = await this.#refreshPolicy();
    const toolkitSlug = request.toolkitSlug ?? await this.#cachedToolToolkit(request.tool);
    if (toolkitSlug !== undefined && !policy.allows(toolkitSlug)) {
      // Use-time exclusion: the admin excluded this toolkit after the action staged, so the
      // dispatch is refused (never reaches Composio) exactly like a fresh submit would be.
      logger.info("call refused: toolkit excluded by deployment policy", {
        event: "account.execute.excluded-toolkit", toolkitSlug,
      });
      return {
        status: "refused",
        message:
          `The "${toolkitSlug}" toolkit is excluded by this deployment's Composio policy.`,
      };
    }

    let apiKey: string;
    try {
      apiKey = await this.#activeApiKey(keyState);
    } catch (err) {
      return { status: "refused", message: err instanceof Error ? err.message : String(err) };
    }

    const quotaKey = `${keyState.keyMode}:${quotaDay()}`;
    const limit = keyState.keyMode === "own"
      ? Number.MAX_SAFE_INTEGER
      : dailyCallLimit(this.env);
    const reservation = this.#quota.reserve(quotaKey, limit);
    if (!reservation.allowed) {
      logger.info("call refused: daily quota exhausted", {
        event: "account.execute.quota-refused",
        keyMode: keyState.keyMode, count: reservation.used,
      });
      return {
        status: "refused",
        message:
          `The Composio daily call limit (${limit}) is exhausted for today (UTC). ` +
          (keyState.keyMode === "deployment"
            ? "It resets at midnight UTC, or set your own Composio key in the Composio app."
            : "It resets at midnight UTC."),
      };
    }

    const api = new ComposioApi(apiKey, composioFetch());
    try {
      const sessionId = await this.#ensureSession(api, keyState.keyMode, keyState.generation);
      if (await this.ctx.storage.get<number>("generation") !== keyState.generation) {
        // A key switch interleaved after the entry check (a read holds no pending-action
        // fence): nothing was dispatched, so give the reservation back and strand the call.
        this.#quota.release(quotaKey);
        return {
          status: "stranded",
          message:
            "The Composio key was switched while this call was starting, so it was not run. " +
            "Stage it again under the new key.",
        };
      }
      const envelope = await api.execute(sessionId, {
        tool: request.tool,
        arguments: request.arguments,
        ...(request.account === undefined ? {} : { account: request.account }),
        ...(request.requestState === undefined ? {} : { requestState: request.requestState }),
        ...(request.inputResponses === undefined
          ? {} : { inputResponses: request.inputResponses }),
      });
      // input_required means nothing ran yet, and a blocked-without-logId call was refused
      // upstream: both release the reservation. Everything else settled against it.
      if (envelope.resultType === "input_required"
        || (envelope.resultType === "blocked" && envelope.logId === null)) {
        this.#quota.release(quotaKey);
      } else {
        this.#quota.settle(quotaKey);
      }
      return { status: "envelope", envelope };
    } catch (err) {
      if (err instanceof ComposioApiError && PRE_EXECUTION_4XX.has(err.status)) {
        // Composio answered a definite pre-execution failure (bad request, auth, unknown
        // tool/session, unprocessable): the call provably never ran, so the reservation goes
        // back and the caller settles not-dispatched rather than outcome-unknown.
        this.#quota.release(quotaKey);
        logger.info("composio refused the call before execution", {
          event: "account.execute.pre-execution-refused",
          keyMode: keyState.keyMode, status: err.status,
        });
        return {
          status: "refused",
          message: `Composio refused the call before it ran (HTTP ${err.status}).`,
        };
      }
      // A transport failure may still have landed at Composio: settle, never release.
      this.#quota.settle(quotaKey);
      if (err instanceof ComposioApiError) {
        logger.warn("composio request failed mid-execute", {
          event: "account.execute.transport-failed",
          keyMode: keyState.keyMode, status: err.status,
        });
      }
      throw err;
    }
  }

  /** Today's quota usage for the app's usage panel (per-mode counters, see quota.ts). */
  async usage(): Promise<{ deployment: QuotaCounters; own: QuotaCounters; limit: number }> {
    const day = quotaDay();
    return {
      deployment: this.#quota.counts(`deployment:${day}`),
      own: this.#quota.counts(`own:${day}`),
      limit: dailyCallLimit(this.env),
    };
  }

  // -- Facet registration and the sharing fence ------------------------------

  /**
   * Records one facet's live pending count, pushed at every action/continuation transition
   * (the key-switch fence sums these; facets cannot be re-addressed from here).
   */
  async notePendingCount(facetId: string, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("notePendingCount() requires a non-negative integer count.");
    }
    this.ctx.storage.sql.exec(
      "UPDATE composio_facets SET pending_actions = ? WHERE facet_id = ?",
      count,
      facetId,
    );
  }

  /**
   * Records a facet at first use. Registration is idempotent (re-registered on every facet
   * activation) and carries the mint-time generation, so the pending counter below always
   * names a facet the account knows.
   */
  async registerFacet(facetId: string, registration: ComposioFacetRegistration): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO composio_facets
         (facet_id, facet_kind, toolkit_slug, generation, auto_apply_listed, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(facet_id) DO UPDATE SET
         facet_kind = excluded.facet_kind,
         toolkit_slug = excluded.toolkit_slug,
         generation = excluded.generation,
         auto_apply_listed = excluded.auto_apply_listed`,
      facetId,
      registration.kind,
      registration.toolkitSlug ?? null,
      registration.generation,
      registration.autoApplyListed ? 1 : 0,
      Date.now(),
    );
    logger.info("facet registered", {
      event: "account.facet.registered",
      ...(registration.toolkitSlug === undefined
        ? {}
        : { toolkitSlug: registration.toolkitSlug }),
      count: registration.generation,
    });
  }

  /** Enables observer sharing; refused while any facet has auto-apply armed (see README). */
  async setSharingEnabled(on: boolean): Promise<void> {
    if (on) {
      const armed = this.armedAutoApplySlugs();
      if (armed.length > 0) {
        throw new Error(
          "Observer sharing cannot be enabled while auto-apply is armed for: " +
          `${armed.join(", ")}. Disarm those toolkits on the connections page first.`);
      }
    }
    await this.ctx.storage.put("sharingEnabled", on);
    logger.info("observer sharing toggled", {
      event: on ? "account.sharing.enabled" : "account.sharing.disabled",
    });
  }

  /** The toolkits whose facets have auto-apply armed, for the sharing refusal above. */
  armedAutoApplySlugs(): string[] {
    const rows = this.ctx.storage.sql.exec<{ toolkit_slug: string }>(
      `SELECT toolkit_slug FROM composio_facets WHERE auto_apply_listed = 1
         AND toolkit_slug IS NOT NULL`,
    ).toArray();
    return [...new Set(rows.map(row => row.toolkit_slug))];
  }

  /** The app's sharing panel state. */
  async sharingState(): Promise<{ enabled: boolean; count: number }> {
    return {
      enabled: await this.ctx.storage.get<boolean>("sharingEnabled") === true,
      count: this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT count(*) AS count FROM composio_admissions").one().count,
    };
  }

  /**
   * Admits one observer. Fail-closed: without the owner's explicit sharing consent nobody is
   * admitted, whatever the verifier says — sharing hands the whole Composio toolkit surface to
   * the observer's agents, so it stays an owner decision (see README, "Sharing and consent").
   */
  async admitObserver(observerId: string): Promise<void> {
    if (await this.ctx.storage.get<boolean>("sharingEnabled") !== true) {
      throw new Error(
        "The account owner has not enabled observer sharing for Composio. Sharing is refused.");
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO composio_admissions (observer_id, admitted_at) VALUES (?, ?) " +
      "ON CONFLICT(observer_id) DO NOTHING",
      observerId, Date.now(),
    );
    logger.info("observer admitted", {
      event: "account.observer.admitted",
      count: this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT count(*) AS count FROM composio_admissions").one().count,
    });
  }

  /** Forgets one admitted observer; forgetting an unknown id is a no-op. */
  async forgetObserver(observerId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM composio_admissions WHERE observer_id = ?", observerId);
  }

  // -- Toolkit catalog and connections --------------------------------------

  /**
   * The cached REST catalog, refreshed on a 6-hour TTL (and dropped on key switches). The
   * catalog comes from REST, not the session's MCP listing, because Composio's catalog runs to
   * thousands of tools and session toolsets are deliberately narrow (see README).
   */
  async #catalog(): Promise<CatalogSnapshot> {
    const cached = await this.ctx.storage.get<StoredCatalog>(CATALOG_CACHE_KEY);
    if (cached !== undefined && Date.now() - cached.assembledAt < CATALOG_TTL_MS) {
      return { ...cached, toolsBySlug: new Map(cached.toolsBySlug) };
    }
    const snapshot = await assembleCatalog(await this.#api());
    const stored: StoredCatalog = {
      entries: snapshot.entries,
      toolsBySlug: [...snapshot.toolsBySlug.entries()],
      assembledAt: snapshot.assembledAt,
    };
    await this.ctx.storage.put(CATALOG_CACHE_KEY, stored);
    logger.info("catalog assembled from REST", {
      event: "account.catalog.assembled", count: snapshot.entries.length,
    });
    return snapshot;
  }

  /**
   * One tool by exact slug across the whole catalog, for the singleton session's lookups.
   * Excluded toolkits are hidden here too: to the agent their tools do not exist.
   */
  async toolBySlug(toolSlug: string): Promise<ToolInfo | undefined> {
    const policy = await this.#refreshPolicy();
    const tool = (await this.#catalog()).toolsBySlug.get(toolSlug);
    return tool !== undefined && policy.allows(tool.toolkitSlug) ? tool : undefined;
  }

  /** One toolkit's tools, as the toolkit facet and the session list them; excluded → none. */
  async toolkitTools(toolkitSlug: string): Promise<ToolInfo[]> {
    if (!(await this.#refreshPolicy()).allows(toolkitSlug)) return [];
    return toolsForToolkit(await this.#catalog(), toolkitSlug);
  }

  /** The whole catalog for the session's listTools()-free surfaces; facets scope by slug. */
  async #catalogEntries(): Promise<CatalogEntry[]> {
    const policy = await this.#refreshPolicy();
    return (await this.#catalog()).entries.filter(entry => policy.allows(entry.slug));
  }

  /**
   * The toolkit of `tool` per the cached catalog, when a snapshot is cached at all — a
   * warm-cache-only backstop for requests that predate the `toolkitSlug` field.
   */
  async #cachedToolToolkit(tool: string): Promise<string | undefined> {
    const cached = await this.ctx.storage.get<StoredCatalog>(CATALOG_CACHE_KEY);
    if (cached === undefined) return undefined;
    return cached.toolsBySlug.find(([slug]) => slug === tool)?.[1]?.toolkitSlug;
  }

  /**
   * Search for the app's catalog browser: catalog entries whose slug, name, or description
   * match every term, with this account's connected accounts joined in.
   */
  async searchToolkits(query: string): Promise<{
    entries: CatalogEntry[];
    connected: ConnectedAccountInfo[];
  }> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(term => term.length > 0);
    const [entries, connectedAccounts] = await Promise.all([
      this.#catalogEntries(),
      this.#connectedAccounts(),
    ]);
    const matches = entries
      .filter(entry => {
        if (terms.length === 0) return true;
        const haystack =
          `${entry.slug} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
        return terms.every(term => haystack.includes(term));
      })
      .toSorted((a, b) => a.slug.localeCompare(b.slug))
      .slice(0, SEARCH_RESULT_LIMIT);
    const connectedSlugs = new Set(matches.map(entry => entry.slug));
    return {
      entries: matches,
      connected: connectedAccounts.filter(account => connectedSlugs.has(account.toolkitSlug)),
    };
  }

  /**
   * The agent-facing toolkit listing: connected toolkits first, bounded, each carrying its
   * first connected-account id so the agent knows to pass `account` for multi-account tools.
   */
  async agentToolkits(): Promise<{
    toolkits: Array<CatalogEntry & { connected?: string }>;
    truncated: boolean;
  }> {
    const [entries, connectedAccounts] = await Promise.all([
      this.#catalogEntries(),
      this.#connectedAccounts(),
    ]);
    const connectedBySlug = new Map<string, ConnectedAccountInfo>();
    for (const account of connectedAccounts) {
      if (!connectedBySlug.has(account.toolkitSlug)) {
        connectedBySlug.set(account.toolkitSlug, account);
      }
    }
    const ordered: Array<CatalogEntry & { connected?: string }> = entries
      .map(entry => {
        const connected = connectedBySlug.get(entry.slug);
        return connected === undefined ? entry : { ...entry, connected: connected.id };
      });
    ordered.sort((a, b) =>
      Number(b.connected !== undefined) - Number(a.connected !== undefined));
    return {
      toolkits: ordered.slice(0, TOOLKIT_LISTING_LIMIT),
      truncated: ordered.length > TOOLKIT_LISTING_LIMIT,
    };
  }

  /** The bounded agent catalog for facet.getAgentCatalog(): connected toolkits first. */
  async agentCatalog(): Promise<AgentCatalog> {
    const [entries, connectedAccounts] = await Promise.all([
      this.#catalogEntries(),
      this.#connectedAccounts(),
    ]);
    const connectedSlugs = new Set(connectedAccounts.map(account => account.toolkitSlug));
    const ordered = entries
      .map(entry => ({
        id: entry.slug,
        title: entry.name,
        description: connectedSlugs.has(entry.slug)
          ? `${entry.toolCount} tools, connected.`
          : `${entry.toolCount} tools (not connected yet)`,
      }))
      .toSorted((a, b) =>
        Number(connectedSlugs.has(b.id)) - Number(connectedSlugs.has(a.id)));
    return boundAgentCatalog(ordered.slice(0, TOOLKIT_LISTING_LIMIT));
  }

  /** Lists this account's connected upstream accounts. */
  async listConnected(): Promise<ConnectedAccountInfo[]> {
    return await (await this.#api()).listConnectedAccounts(this.composioUserId);
  }

  /** The status of one connected account, or null if Composio no longer knows it. */
  async pollConnected(connectedAccountId: string): Promise<{ status: string } | null> {
    const account = await (await this.#api()).getConnectedAccount(connectedAccountId);
    return account === null ? null : { status: account.status };
  }

  /**
   * Mints a Connect Link for one toolkit inside the account's active session. The redirect URL
   * is a bearer capability and is returned to the app only, never logged. The callback URL
   * names this worker's connect-callback route — a placeholder in PR 3 (see README, "PR 4").
   */
  async connectToolkit(toolkitSlug: string, alias?: string): Promise<{
    redirectUrl: string;
    connectedAccountId: string;
  }> {
    const keyState = await this.#keyState();
    const api = new ComposioApi(await this.#activeApiKey(keyState), composioFetch());
    const sessionId = await this.#ensureSession(api, keyState.keyMode, keyState.generation);
    const callbackUrl = this.env.BASE_URL === undefined
      ? CONNECT_LINK_CALLBACK_PATH
      : new URL(CONNECT_LINK_CALLBACK_PATH, this.env.BASE_URL).href;
    const link = await api.createConnectLink(sessionId, {
      toolkit: toolkitSlug,
      ...(alias === undefined ? {} : { alias }),
      callbackUrl,
    });
    logger.info("connect link minted", { event: "account.connect.link-minted", toolkitSlug });
    return link;
  }

  /** Disconnects one upstream account; its credentials stay Composio's to drop. */
  async disconnectToolkit(connectedAccountId: string): Promise<void> {
    await (await this.#api()).deleteConnectedAccount(connectedAccountId);
    logger.info("connected account deleted", { event: "account.connect.disconnected" });
  }

  /** Renames a connected account (aliases are labels, never identity). */
  async renameConnected(connectedAccountId: string, alias: string): Promise<void> {
    await (await this.#api()).setAlias(connectedAccountId, alias);
  }

  // -- Internals ------------------------------------------------------------

  async #keyState(): Promise<ComposioKeyState> {
    const [keyMode, generation, ownApiKey] = await Promise.all([
      this.ctx.storage.get<ComposioKeyMode>("keyMode"),
      this.ctx.storage.get<number>("generation"),
      this.ctx.storage.get<string>("ownApiKey"),
    ]);
    return {
      keyMode: keyMode ?? "deployment",
      generation: generation ?? 1,
      deploymentKeyAvailable: this.env.COMPOSIO_API_KEY !== undefined,
      ownKeySet: ownApiKey !== undefined,
    };
  }

  /** The API key for the active mode; throws a user-facing refusal when there is none. */
  async #activeApiKey(keyState: ComposioKeyState): Promise<string> {
    if (keyState.keyMode === "own") {
      const key = await this.ctx.storage.get<string>("ownApiKey");
      if (key === undefined) {
        throw new Error(
          "This account is set to its own Composio key, but none is set. " +
          "Add one in the Composio app.");
      }
      return key;
    }
    return deploymentApiKey(this.env);
  }

  /** A ComposioApi over the active key. */
  async #api(): Promise<ComposioApi> {
    const keyState = await this.#keyState();
    return new ComposioApi(await this.#activeApiKey(keyState), composioFetch());
  }

  /**
   * The account's Composio session for the active mode, created on first use. Creation configures
   * Composio's server-side `tags.require_approval` fence (non-read tags) with the admin-listed
   * auto-apply toolkits exempted down to the destructive tag — defense in depth, never the
   * authority. A key switch racing the create leaves the stray session unstored: it belongs to
   * the old key the switch already discarded.
   */
  async #ensureSession(
    api: ComposioApi,
    mode: ComposioKeyMode,
    generation: number,
  ): Promise<string> {
    const key = mode === "own" ? "ownSessionId" : "deploymentSessionId";
    const existing = await this.ctx.storage.get<string>(key);
    if (existing !== undefined) return existing;
    const autoApplyToolkits = (await this.#refreshPolicy()).autoApplyListedSlugs();
    const { sessionId } = await api.createSession(this.composioUserId, autoApplyToolkits);
    if (await this.ctx.storage.get<number>("generation") !== generation) {
      await api.deleteSession(sessionId).catch(() => {});
      return sessionId;
    }
    await this.ctx.storage.put(key, sessionId);
    logger.info("composio session created", {
      event: "account.session.created", keyMode: mode, count: autoApplyToolkits.length,
    });
    return sessionId;
  }

  /**
   * Deletes both modes' sessions (idempotent upstream); never throws into a switch path. A
   * switch may run while no key is usable at all (a fresh deployment-mode account switching to
   * its own key): then no session could ever have been created, so the stored ids just drop.
   */
  async #deleteSessions(): Promise<void> {
    const [deploymentSessionId, ownSessionId] = await Promise.all([
      this.ctx.storage.get<string>("deploymentSessionId"),
      this.ctx.storage.get<string>("ownSessionId"),
    ]);
    if (deploymentSessionId === undefined && ownSessionId === undefined) return;
    let api: ComposioApi | undefined;
    try {
      api = await this.#api();
    } catch (err) {
      logger.warn("could not build a Composio client to delete sessions", {
        event: "account.session.delete-no-client", error: err,
      });
    }
    for (const [key, sessionId] of [
      ["deploymentSessionId", deploymentSessionId] as const,
      ["ownSessionId", ownSessionId] as const,
    ]) {
      if (sessionId === undefined) continue;
      if (api !== undefined) {
        try {
          await api.deleteSession(sessionId);
        } catch (err) {
          logger.warn("could not delete composio session", {
            event: "account.session.delete-failed", error: err,
          });
        }
      }
      await this.ctx.storage.delete(key);
    }
  }

  /** This account's connected upstream accounts; unreachable Composio yields an empty list. */
  async #connectedAccounts(): Promise<ConnectedAccountInfo[]> {
    try {
      return await (await this.#api()).listConnectedAccounts(this.composioUserId);
    } catch (err) {
      logger.warn("could not list connected accounts", {
        event: "account.connect.list-failed", error: err,
      });
      return [];
    }
  }

  /**
   * Counts pending actions across every registered facet. Facet stubs cannot be re-addressed
   * across facet spaces, so each facet pushes its own count here at every transition (staged,
   * settled, expired, abandoned — see ComposioFacetCore.syncPending) and the fence sums the
   * recorded counters: a facet with queued approvals must never be talked over by a key switch.
   */
  #pendingFanOut(): number {
    return this.ctx.storage.sql.exec<{ pending: number }>(
      "SELECT COALESCE(SUM(pending_actions), 0) AS pending FROM composio_facets",
    ).one().pending;
  }

  /** Runs `operation` under the account's mutex, serializing key-mode state changes. */
  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutex.then(operation, operation);
    this.#mutex = run.then(() => {}, () => {});
    return await run;
  }
}

type StoredCatalog = {
  entries: CatalogSnapshot["entries"];
  toolsBySlug: [string, ToolInfo][];
  assembledAt: number;
};

/** Parses composio://toolkit/<slug>; null when the URL is not one. */
export function parseToolkitUrl(url: string): string | null {
  if (url.length > "composio://toolkit/".length + MAX_SLUG_LENGTH) return null;
  // WHATWG URLs treat the authority of a non-special scheme as a host, so composio://toolkit/x
  // parses with pathname "/x" — match the literal shape instead of re-reading a parsed URL.
  const match = /^composio:\/\/toolkit\/([^/?#]+)$/.exec(url);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding is just an unparseable URL, not a crash.
    return null;
  }
}
