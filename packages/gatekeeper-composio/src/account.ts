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
  EVENTS_PER_WORKSPACE_PER_DAY,
  dailyCallLimit,
  deploymentApiKey,
  isMetaTool,
} from "./config.js";
import { HookDeliveryQueue } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { buildDescription, quoteUntrusted } from "@gadgets/gatekeeper-kit/action-description";
import { capUtf8 } from "./composio-api.js";
import type { SingletonFacetProps, ToolkitFacetProps } from "./facet.js";
import { QuotaTable, quotaDay, type QuotaCounters } from "./quota.js";
import { startAppUi } from "./app-ui.js";
import type { ComposioTriggerInitiator, ComposioTriggerMessage } from "./triggers.js";
import { TOOLKIT_RESOURCE, composioFetch, logger } from "./worker.js";
import {
  WEBHOOK_EVENT_TYPES,
  parseWebhookEnvelope,
  verifyWebhookSignature,
  webhookSubscriptionUrl,
  type ParsedWebhook,
} from "./webhooks.js";

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
/** Reconciliation cadence while any trigger row exists. */
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
/** One queued trigger event's payload cap (96 KiB, past which the payload truncates). */
const MAX_TRIGGER_EVENT_BYTES = 96 * 1024;
/** Expiry notices kept for the app's connection panel. */
const EXPIRY_NOTICES_LIMIT = 50;
/** How long envelope-id dedupe markers live (mirrors the delivery queue's retention). */
const WEBHOOK_SEEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum spacing between upstream subscription listings for the signature self-heal. */
const WEBHOOK_SECRET_REFRESH_MIN_INTERVAL_MS = 60 * 1000;

/** KV key of one trigger's stored initiator capability. */
function triggerCapsKey(triggerId: string): string {
  return `triggerCaps:${triggerId}`;
}

/** KV key of the stored webhook subscription for one key mode. */
function subscriptionKey(mode: ComposioKeyMode): string {
  return `webhookSubscription:${mode}`;
}

/** What the trigger controller forwards at enable time (triggers.ts mints the controller). */
export type ComposioTriggerEnableSpec = {
  triggerId: string;
  triggerSlug: string;
  filters: Record<string, unknown>;
  title: string;
  description: string;
  workspaceId: string;
  gadgetId?: number;
};

/** One composio_triggers row. */
type StoredTriggerRow = {
  trigger_id: string;
  workspace_id: string;
  gadget_id: string | null;
  trigger_slug: string;
  filters_json: string;
  title: string;
  description: string;
  upstream_trigger_id: string | null;
  created_at: number;
};

/** The app-panel projection of a trigger row. */
export type ComposioTriggerRowPublic = {
  triggerId: string;
  workspaceId: string;
  triggerSlug: string;
  title: string;
  createdAt: number;
};

/** The initiator capability stored per trigger (stub storage is enabled for this worker). */
type StoredTriggerCaps = { initiator: ComposioTriggerInitiator };

/** The stored webhook subscription of one key mode (`secret` empty when upstream hid it). */
type StoredWebhookSubscription = { id: string; secret: string; url: string };

/** One connected-account expiry notice, as the app's connection panel shows it. */
export type ExpiryNotice = {
  toolkitSlug: string;
  connectedAccountId: string;
  statusReason?: string;
  at: number;
};

function disposeStub(value: unknown): void {
  const disposable = value as { [Symbol.dispose]?: () => void } | undefined;
  disposable?.[Symbol.dispose]?.();
}


@validateRpc()
export class ComposioAccount extends DurableObject<Cloudflare.Env> {
  readonly #quota: QuotaTable;
  readonly #triggerQueue: HookDeliveryQueue<ComposioTriggerMessage>;
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
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS composio_triggers (
      trigger_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      gadget_id TEXT,
      trigger_slug TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      upstream_trigger_id TEXT,
      created_at INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS composio_events (
      workspace_id TEXT NOT NULL,
      day TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, day)
    ) STRICT`);
    this.#triggerQueue = new HookDeliveryQueue<ComposioTriggerMessage>(
      ctx.storage.kv,
      () => {
        // Dropped-after-retries is visibility, not an error: the queue's retention already
        // bounds the state, and the per-day event counters below keep the loss countable.
        logger.warn("trigger delivery dropped after final attempt", {
          event: "account.trigger.delivery.dropped",
        });
      },
    );
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
   * Revokes the account: deletes every connected upstream account and trigger instance
   * (best-effort, the own-mode project's webhook subscription with them), tears down the
   * Composio sessions, then drops all state. The deployment project's webhook subscription
   * survives — it is shared by every account of this deployment.
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
      try {
        const api = await this.#api();
        for (const row of this.#triggerRows()) {
          if (row.upstream_trigger_id !== null) {
            await api.deleteTriggerInstance(row.upstream_trigger_id).catch(() => {});
          }
        }
        if ((await this.#keyState()).keyMode === "own") {
          const stored = await this.#storedSubscription("own");
          if (stored !== undefined) {
            await api.deleteWebhookSubscription(stored.id).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn("revocation could not clean up trigger instances", {
          event: "account.revoke.triggers-failed", error: err,
        });
      }
      for (const row of this.#triggerRows()) {
        const caps = await this.ctx.storage.get<StoredTriggerCaps>(
          triggerCapsKey(row.trigger_id));
        disposeStub(caps?.initiator);
      }
      await this.ctx.storage.deleteAlarm();
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

      const previousMode = (await this.ctx.storage.get<ComposioKeyMode>("keyMode"))
        ?? "deployment";
      const previousOwnKey = await this.ctx.storage.get<string>("ownApiKey");
      await this.#deleteSessions();
      const generation = (await this.ctx.storage.get<number>("generation") ?? 1) + 1;
      await this.ctx.storage.put("generation", generation);
      await this.ctx.storage.put("keyMode", mode);
      if (ownKey === undefined) await this.ctx.storage.delete("ownApiKey");
      else await this.ctx.storage.put("ownApiKey", ownKey);
      await this.ctx.storage.delete(CATALOG_CACHE_KEY);
      await this.#migrateTriggersForKeySwitch(previousMode, previousOwnKey);

      logger.info("key mode switched", {
        event: "account.key.switched", keyMode: mode, count: generation,
      });
    });
  }

  /**
   * Moves every trigger to the new key's project after a switch: the old project's instances
   * are deleted (the old own project's webhook subscription with them — the deployment
   * project's subscription is shared and stays), the instances are re-created under the new
   * key, and the new mode's subscription is ensured. All best-effort with warns: the
   * generation fence already stopped in-flight work, and reconciliation heals what it can see
   * — but an old-project instance no new key can list may orphan, which is logged, not fatal.
   */
  async #migrateTriggersForKeySwitch(
    previousMode: ComposioKeyMode,
    previousOwnKey: string | undefined,
  ): Promise<void> {
    const rows = this.#triggerRows();
    let previousApi: ComposioApi | undefined;
    if (previousMode === "own") {
      if (previousOwnKey !== undefined) {
        previousApi = new ComposioApi(previousOwnKey, composioFetch());
      }
      const stored = await this.#storedSubscription("own");
      if (stored !== undefined) {
        if (previousApi !== undefined) {
          try {
            await previousApi.deleteWebhookSubscription(stored.id);
          } catch (err) {
            logger.warn("could not delete the previous own project's webhook subscription", {
              event: "account.webhook.own-subscription-delete-failed", error: err,
            });
          }
        }
        await this.ctx.storage.delete(subscriptionKey("own"));
      }
    } else {
      try {
        previousApi = new ComposioApi(deploymentApiKey(this.env), composioFetch());
      } catch {
        // No deployment key was ever configured; nothing was created under it either.
      }
    }

    if (rows.length === 0) return;
    let nextApi: ComposioApi | undefined;
    try {
      const keyState = await this.#keyState();
      nextApi = new ComposioApi(await this.#activeApiKey(keyState), composioFetch());
    } catch {
      // The new mode has no usable key (e.g. switching back to a keyless deployment): drop the
      // upstream pointers so reconciliation recreates the instances once a key exists again.
      this.ctx.storage.sql.exec("UPDATE composio_triggers SET upstream_trigger_id = NULL");
      logger.warn("key switch left trigger instances uncreated: no usable key", {
        event: "account.trigger.switch-no-key",
      });
      return;
    }
    for (const row of rows) {
      if (previousApi !== undefined && row.upstream_trigger_id !== null) {
        try {
          await previousApi.deleteTriggerInstance(row.upstream_trigger_id);
        } catch (err) {
          logger.warn("could not delete an old-project trigger instance", {
            event: "account.trigger.old-instance-delete-failed", error: err,
          });
        }
      }
      try {
        const upstreamId = await nextApi.upsertTriggerInstance(row.trigger_slug, {
          composioUserId: this.composioUserId,
          triggerConfig: JSON.parse(row.filters_json) as Record<string, unknown>,
        });
        this.ctx.storage.sql.exec(
          "UPDATE composio_triggers SET upstream_trigger_id = ? WHERE trigger_id = ?",
          upstreamId, row.trigger_id,
        );
      } catch (err) {
        logger.warn("could not recreate a trigger instance under the new key", {
          event: "account.trigger.switch-recreate-failed",
          triggerSlug: row.trigger_slug, error: err,
        });
      }
    }
    try {
      const keyState = await this.#keyState();
      await this.#ensureSubscription(keyState.keyMode, nextApi);
    } catch (err) {
      logger.warn("could not ensure the webhook subscription after a key switch", {
        event: "account.webhook.subscription-switch-failed", error: err,
      });
    }
    await this.#planAlarmAfterMutation();
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

  /**
   * Today's quota usage for the app's usage panel: per-mode call counters (quota.ts) plus the
   * per-workspace trigger-event counters, summed across workspaces for the day (UTC).
   */
  async usage(): Promise<{
    deployment: QuotaCounters;
    own: QuotaCounters;
    limit: number;
    events: { delivered: number; dropped: number; limit: number };
  }> {
    const day = quotaDay();
    const eventRows = this.ctx.storage.sql.exec<{ delivered: number; dropped: number }>(
      "SELECT delivered, dropped FROM composio_events WHERE day = ?", day,
    ).toArray();
    return {
      deployment: this.#quota.counts(`deployment:${day}`),
      own: this.#quota.counts(`own:${day}`),
      limit: dailyCallLimit(this.env),
      events: {
        delivered: eventRows.reduce((sum, row) => sum + row.delivered, 0),
        dropped: eventRows.reduce((sum, row) => sum + row.dropped, 0),
        limit: EVENTS_PER_WORKSPACE_PER_DAY,
      },
    };
  }

  // -- Triggers and webhooks -------------------------------------------------

  /**
   * Arms one trigger: creates (or repairs) the project's webhook subscription, upserts the
   * upstream instance, and only then records the row and stores the initiator — an upstream
   * failure leaves no local state, so a failed enable can always be retried as a fresh enable.
   * Serialized with every other trigger mutation and reconciliation.
   */
  async enableTrigger(
    spec: ComposioTriggerEnableSpec,
    initiator: ComposioTriggerInitiator,
  ): Promise<void> {
    await this.#serialized(async () => {
      const keyState = await this.#keyState();
      const api = new ComposioApi(await this.#activeApiKey(keyState), composioFetch());
      await this.#ensureSubscription(keyState.keyMode, api);
      let upstreamId: string;
      try {
        upstreamId = await api.upsertTriggerInstance(spec.triggerSlug, {
          composioUserId: this.composioUserId,
          triggerConfig: spec.filters,
        });
      } catch (err) {
        // Only the numeric code is safe to surface: message text can quote request data.
        const status = err instanceof ComposioApiError ? err.status : 502;
        throw new Error(`Composio upstream unavailable (HTTP ${status}); trigger not armed.`, { cause: err });
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO composio_triggers
           (trigger_id, workspace_id, gadget_id, trigger_slug, filters_json, title, description,
            upstream_trigger_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trigger_id) DO UPDATE SET
           upstream_trigger_id = excluded.upstream_trigger_id`,
      spec.triggerId, spec.workspaceId,
      spec.gadgetId !== undefined ? String(spec.gadgetId) : null, spec.triggerSlug,
        JSON.stringify(spec.filters), spec.title, spec.description, upstreamId, Date.now(),
      );
      await this.ctx.storage.put(triggerCapsKey(spec.triggerId), { initiator });
      await this.#planAlarmAfterMutation();
      logger.info("trigger enabled", {
        event: "account.trigger.enabled",
        triggerSlug: spec.triggerSlug, workspaceId: spec.workspaceId,
      });
    });
  }

  /**
   * Disarms one trigger: the upstream instance is deleted first (a failure is logged and left
   * to reconciliation), then the queued deliveries are cancelled, the initiator disposed, and
   * the row and capability record dropped. Idempotent: an unknown id is a no-op. The
   * `workspaceId` fence refuses a row armed by another workspace (the scheduler's rule).
   */
  async disableTrigger(triggerId: string, workspaceId: string): Promise<void> {
    await this.#serialized(async () => {
      const row = this.#triggerRow(triggerId);
      this.#triggerQueue.cancel(triggerId);
      if (row === undefined) {
        await this.#planAlarmAfterMutation();
        return;
      }
      if (row.workspace_id !== workspaceId) {
        // The scheduler's fence: a session of one workspace cannot disarm another
        // workspace's trigger by its bare id.
        throw new Error(
          `Trigger ${quoteUntrusted(triggerId, 80)} does not belong to this workspace.`);
      }
      if (row.upstream_trigger_id !== null) {
        try {
          await (await this.#api()).deleteTriggerInstance(row.upstream_trigger_id);
        } catch (err) {
          logger.warn("could not delete trigger instance upstream", {
            event: "account.trigger.upstream-delete-failed", error: err,
          });
        }
      }
      await this.#dropTriggerState(triggerId);
      await this.#planAlarmAfterMutation();
      logger.info("trigger disabled", {
        event: "account.trigger.disabled", triggerSlug: row.trigger_slug,
      });
    });
  }

  /** The account's triggers, for the app's trigger panel. */
  async listTriggers(): Promise<ComposioTriggerRowPublic[]> {
    return this.#triggerRows().map(row => ({
      triggerId: row.trigger_id,
      workspaceId: row.workspace_id,
      triggerSlug: row.trigger_slug,
      title: row.title,
      createdAt: row.created_at,
    }));
  }

  /**
   * Ingests one webhook delivery. Signature first — everything else about the envelope is
   * attacker-controllable — then parse, dedupe on the envelope id (upstream is at-least-once;
   * the id is stable across retries), then the per-kind handling below. Returns the HTTP status
   * the worker should answer with: 401 (bad signature), 400 (malformed), 200 (handled or
   * intentionally dropped — dropping must ACK, or Composio would redeliver a dead letter
   * forever).
   */
  async ingestWebhook(
    rawBody: string,
    webhookId: string,
    timestamp: string,
    signature: string,
  ): Promise<number> {
    const keyState = await this.#keyState();
    const verified = await this.#verifyInboundWebhook(
      keyState.keyMode, rawBody, webhookId, timestamp, signature);
    if (!verified) return 401;
    const parsed = parseWebhookEnvelope(rawBody);
    if (!parsed.ok) {
      logger.info("webhook envelope malformed", { event: "webhook.ingest.malformed" });
      return 400;
    }
    const event = parsed.event;
    if (event.kind === "unknown") {
      logger.info("webhook event of unsubscribed type acknowledged", {
        event: "webhook.ingest.unknown-type",
      });
      return 200;
    }
    let status = 200;
    await this.#serialized(async () => {
      const seenKey = `webhookSeen:${event.eventId}`;
      if (await this.ctx.storage.get(seenKey) !== undefined) {
        status = 200; // A redelivery of an already-ingested envelope: ACK and do nothing.
        return;
      }
      // The marker goes down only after the ingest succeeded: a crash mid-ingest leaves it
      // absent, so the redelivery retries instead of ACKing a lost event (the queue's own
      // message-id dedupe still suppresses a double delivery).
      if (event.kind === "trigger") {
        await this.#ingestTriggerEvent(event);
      } else {
        await this.#recordExpiryNotice(event);
      }
      await this.ctx.storage.put(seenKey, Date.now());
    });
    return status;
  }

  /** Routes one verified trigger event to its row, quota, and delivery queue. */
  async #ingestTriggerEvent(event: Extract<ParsedWebhook, { kind: "trigger" }>): Promise<void> {
    const row = this.ctx.storage.sql.exec<StoredTriggerRow>(
      "SELECT * FROM composio_triggers WHERE upstream_trigger_id = ?",
      event.upstreamTriggerId,
    ).toArray()[0];
    if (row === undefined) {
      // Unknown or already-disabled upstream instance (a redelivery racing disable): ACK so
      // Composio stops retrying; nothing here is in a recoverable state.
      logger.info("webhook trigger event for unknown instance acknowledged", {
        event: "webhook.ingest.unknown-trigger",
      });
      return;
    }
    const day = quotaDay();
    const counters = this.ctx.storage.sql.exec<{ delivered: number }>(
      "SELECT delivered FROM composio_events WHERE workspace_id = ? AND day = ?",
      row.workspace_id, day,
    ).toArray()[0];
    if ((counters?.delivered ?? 0) >= EVENTS_PER_WORKSPACE_PER_DAY) {
      this.#countEvent(row.workspace_id, day, "dropped");
      logger.warn("trigger event dropped: workspace daily event limit reached", {
        event: "webhook.ingest.event-quota-dropped", workspaceId: row.workspace_id,
      });
      return;
    }
    this.#countEvent(row.workspace_id, day, "delivered");
    const serializedData = JSON.stringify(event.data ?? null);
    const dataJson = capUtf8(serializedData, MAX_TRIGGER_EVENT_BYTES);
    this.#triggerQueue.enqueue(row.trigger_id, event.eventId, {
      eventId: event.eventId,
      triggerSlug: event.triggerSlug,
      timestamp: event.timestamp === undefined
        || !Number.isFinite(Date.parse(event.timestamp))
        ? null
        : Date.parse(event.timestamp),
      dataJson,
      truncated: dataJson.length < serializedData.length,
    }, Date.now());
    await this.#planAlarmAfterMutation();
  }

  /** Records one connected-account expiry notice (bounded, newest first). */
  async #recordExpiryNotice(
    event: Extract<ParsedWebhook, { kind: "connected_account_expired" }>,
  ): Promise<void> {
    const notices = await this.ctx.storage.get<ExpiryNotice[]>("expiryNotices") ?? [];
    notices.unshift({
      toolkitSlug: event.toolkitSlug,
      connectedAccountId: event.connectedAccountId,
      ...(event.statusReason === undefined ? {} : { statusReason: event.statusReason }),
      at: Date.now(),
    });
    await this.ctx.storage.put("expiryNotices", notices.slice(0, EXPIRY_NOTICES_LIMIT));
    logger.info("connected account expiry noticed", {
      event: "webhook.ingest.account-expired", toolkitSlug: event.toolkitSlug,
    });
  }

  /** The bounded expiry-notice list for the app's connection panel. */
  async expiryNotices(): Promise<ExpiryNotice[]> {
    return await this.ctx.storage.get<ExpiryNotice[]>("expiryNotices") ?? [];
  }

  /**
   * Rotates the active mode's webhook signing secret upstream and stores the replacement. In
   * deployment mode the subscription is project-wide, so every account's stored copy self-heals
   * on its next ingest (see #verifyInboundWebhook).
   */
  async rotateWebhookSecret(): Promise<void> {
    await this.#serialized(async () => {
      const keyState = await this.#keyState();
      const api = new ComposioApi(await this.#activeApiKey(keyState), composioFetch());
      const stored = await this.#storedSubscription(keyState.keyMode);
      if (stored === undefined) {
        await this.#ensureSubscription(keyState.keyMode, api);
        return;
      }
      const secret = await api.rotateWebhookSecret(stored.id);
      await this.ctx.storage.put(subscriptionKey(keyState.keyMode), { ...stored, secret });
      logger.info("webhook signing secret rotated", {
        event: "account.webhook.secret-rotated", keyMode: keyState.keyMode,
      });
    });
  }

  /**
   * The webhook surface for the app's panel: the URL Composio delivers to, and whether the
   * subscription exists yet (it is created on the first trigger enable or rotation).
   */
  async webhookState(): Promise<{ url: string | null; subscribed: boolean }> {
    let url: string | null = null;
    try {
      url = webhookSubscriptionUrl(this.env);
    } catch {
      url = null;
    }
    const keyState = await this.#keyState();
    return {
      url,
      subscribed: await this.#storedSubscription(keyState.keyMode) !== undefined,
    };
  }

  /** The DO's alarm: reconcile (15-minute cadence while triggers exist), deliver, replan. */
  async alarm(): Promise<void> {
    const now = Date.now();
    await this.#serialized(async () => {
      await this.#pruneWebhookSeen(now);
      const hasTriggers = this.#triggerRows().length > 0;
      const last = await this.ctx.storage.get<number>("lastReconcileAt") ?? 0;
      if (hasTriggers && now - last >= RECONCILE_INTERVAL_MS) {
        await this.#reconcile(now);
      }
    });
    // Deliveries run outside the mutex: a callback that calls back into this account (a read,
    // a trigger listing) must not deadlock against the delivery that invoked it.
    await this.#triggerQueue.run(now, (triggerId, message) =>
      this.#deliverTrigger(triggerId, message));
    await this.#serialized(() => this.#planAlarm());
  }

  /**
   * Delivers one queued event: startHook → authorizeObservation → onTrigger, each failure
   * thrown for the queue's backoff. The stubs each lease returns (initiator, approval queue,
   * callback) are disposed per attempt; the stored capability record survives for the next one.
   */
  async #deliverTrigger(triggerId: string, message: ComposioTriggerMessage): Promise<void> {
    const row = this.#triggerRow(triggerId);
    if (row === undefined) return; // Disabled mid-queue; the message completes and drops.
    const caps = await this.ctx.storage.get<StoredTriggerCaps>(triggerCapsKey(triggerId));
    if (caps === undefined) return;
    let hookResult: Awaited<ReturnType<ComposioTriggerInitiator["startHook"]>> | undefined;
    try {
      // @ts-expect-error Worker RPC promises are disposable even though the mapped type omits it.
      using hookCall = caps.initiator.startHook();
      hookResult = await hookCall;
      if (hookResult === undefined || hookResult === null) {
        throw new Error("The workspace refused the trigger delivery (startHook).");
      }
      const preview = capUtf8(message.dataJson, 512);
      let previewValue: unknown = preview;
      try {
        previewValue = JSON.parse(preview);
      } catch {
        // The preview cut mid-JSON (any payload over the cap), or the payload itself was
        // truncated at ingest: either way the raw capped text still describes it.
      }
      await hookResult.approvalQueue.authorizeObservation({
        title: row.title,
        description: buildDescription(
          `Deliver Composio trigger ${quoteUntrusted(message.triggerSlug, 80)} event ` +
            `${quoteUntrusted(message.eventId, 80)} to this workspace.` +
            (message.truncated ? " The payload was truncated in transit." : ""),
        ).json("Payload preview", previewValue).finish().description,
      });
      let data: unknown = null;
      try {
        data = JSON.parse(message.dataJson);
      } catch {
        // A truncated payload cannot parse; deliver the truncation marker instead.
      }
      await hookResult.callback.onTrigger({
        triggerId,
        eventId: message.eventId,
        triggerSlug: message.triggerSlug,
        ...(message.timestamp !== null && Number.isFinite(message.timestamp)
          ? { timestamp: new Date(message.timestamp).toISOString() }
          : {}),
        data,
      });
    } finally {
      if (hookResult !== undefined && hookResult !== null) {
        disposeStub(hookResult.approvalQueue);
        disposeStub(hookResult.callback);
      }
      disposeStub(caps.initiator);
    }
  }

  /**
   * Walks the upstream active-instance list against local rows and repairs drift both ways:
   * a local row with no (or a disabled) upstream instance is re-upserted, and an upstream
   * instance with no local row (a disable whose delete failed, or a pre-key-switch leftover
   * in this project) is deleted. Client-filtered to this account's Composio user id.
   */
  async #reconcile(now: number): Promise<void> {
    let api: ComposioApi;
    try {
      api = await this.#api();
    } catch (err) {
      logger.warn("trigger reconcile skipped: no usable key", {
        event: "account.trigger.reconcile-no-key", error: err,
      });
      return;
    }
    const rows = this.#triggerRows();
    const byUpstream = new Map(
      rows.filter(row => row.upstream_trigger_id !== null)
        .map(row => [row.upstream_trigger_id as string, row]));
    const upstreamIds = new Set<string>();
    const disabledUpstream: StoredTriggerRow[] = [];
    try {
      await api.forEachActiveTriggerInstance(batch => {
        for (const instance of batch) {
          if (instance.composioUserId !== this.composioUserId) continue;
          upstreamIds.add(instance.id);
          if (instance.disabledAt !== null) {
            const row = byUpstream.get(instance.id);
            if (row !== undefined) disabledUpstream.push(row);
          }
        }
      });
    } catch (err) {
      logger.warn("trigger reconcile listing failed", {
        event: "account.trigger.reconcile-list-failed", error: err,
      });
      return; // Retry at the next interval; nothing was mutated.
    }
    for (const instanceId of upstreamIds) {
      if (byUpstream.has(instanceId)) continue;
      try {
        await api.deleteTriggerInstance(instanceId);
        logger.info("reconcile deleted an orphaned trigger instance", {
          event: "account.trigger.reconcile-deleted",
        });
      } catch (err) {
        logger.warn("reconcile could not delete an orphaned trigger instance", {
          event: "account.trigger.reconcile-delete-failed", error: err,
        });
      }
    }
    const repaired = new Set(disabledUpstream.map(row => row.trigger_id));
    for (const row of [...disabledUpstream,
      ...rows.filter(pending => pending.upstream_trigger_id === null
        || !upstreamIds.has(pending.upstream_trigger_id))]) {
      if (row.upstream_trigger_id !== null && upstreamIds.has(row.upstream_trigger_id)
        && !repaired.has(row.trigger_id)) {
        continue;
      }
      try {
        const filters = JSON.parse(row.filters_json) as Record<string, unknown>;
        const upstreamId = await api.upsertTriggerInstance(row.trigger_slug, {
          composioUserId: this.composioUserId,
          triggerConfig: filters,
        });
        this.ctx.storage.sql.exec(
          "UPDATE composio_triggers SET upstream_trigger_id = ? WHERE trigger_id = ?",
          upstreamId, row.trigger_id,
        );
      } catch (err) {
        logger.warn("reconcile could not re-upsert a trigger instance", {
          event: "account.trigger.reconcile-upsert-failed",
          triggerSlug: row.trigger_slug, error: err,
        });
      }
    }
    await this.ctx.storage.put("lastReconcileAt", now);
  }

  /**
   * Ensures the project-level webhook subscription exists and points here: create, or on 409
   * adopt the existing row (PATCHing it when URL or events drifted). The signing secret is
   * stored per key mode — deployment mode shares one project (and thus one subscription) across
   * every account, own mode owns its project alone.
   */
  async #ensureSubscription(mode: ComposioKeyMode, api: ComposioApi): Promise<void> {
    const url = webhookSubscriptionUrl(this.env);
    const existing = await this.#storedSubscription(mode);
    if (existing !== undefined && existing.url === url) return;
    try {
      const created = await api.createWebhookSubscription(url, [...WEBHOOK_EVENT_TYPES]);
      await this.ctx.storage.put(subscriptionKey(mode), {
        id: created.id,
        secret: created.secret ?? "",
        url,
      });
      logger.info("webhook subscription created", {
        event: "account.webhook.subscription-created", keyMode: mode,
      });
      return;
    } catch (err) {
      if (!(err instanceof ComposioApiError) || err.status !== 409) throw err;
    }
    const subscriptions = await api.listWebhookSubscriptions();
    const ours = subscriptions.find(sub => sub.webhookUrl === url) ?? subscriptions[0];
    if (ours === undefined) {
      throw new Error("Composio reports a conflicting webhook subscription but lists none.");
    }
    if (ours.webhookUrl !== url
      || !WEBHOOK_EVENT_TYPES.every(type => ours.enabledEvents.includes(type))) {
      await api.updateWebhookSubscription(ours.id, {
        webhookUrl: url,
        enabledEvents: [...WEBHOOK_EVENT_TYPES],
      });
    }
    await this.ctx.storage.put(subscriptionKey(mode), {
      id: ours.id,
      secret: ours.secret ?? "",
      url,
    });
    logger.info("webhook subscription adopted", {
      event: "account.webhook.subscription-adopted", keyMode: mode,
    });
  }

  /**
   * Verifies one inbound delivery against the stored secret for `mode`, self-healing once
   * through the subscription listing when the stored secret no longer matches (an upstream
   * rotation, or another deployment-mode account rotating the shared project secret). The
   * heal spends a billed upstream listing, so it never runs for an account holding nothing
   * to verify against (no stored subscription and no trigger rows) and at most once per
   * interval per mode: forged traffic on the unauthenticated route must not burn quota.
   */
  async #verifyInboundWebhook(
    mode: ComposioKeyMode,
    rawBody: string,
    webhookId: string,
    timestamp: string,
    signature: string,
  ): Promise<boolean> {
    const stored = await this.#storedSubscription(mode);
    if (stored !== undefined && stored.secret !== ""
      && await verifyWebhookSignature({
        webhookId, timestamp, signatureHeader: signature, rawBody, secret: stored.secret,
      })) {
      return true;
    }
    if (stored === undefined && this.#triggerRows().length === 0) {
      // Nothing of this account's was ever armed or subscribed: the signature can only be
      // verified by spending upstream quota, so refuse instead (the 401 stands).
      return false;
    }
    const healed = await this.#refreshSubscriptionSecret(mode);
    return healed !== null && healed.secret !== ""
      && await verifyWebhookSignature({
        webhookId, timestamp, signatureHeader: signature, rawBody, secret: healed.secret,
      });
  }

  /** Re-reads the subscription secret from the listing, storing what it finds. */
  async #refreshSubscriptionSecret(mode: ComposioKeyMode): Promise<StoredWebhookSubscription | null> {
    const stored = await this.#storedSubscription(mode);
    const refreshKey = `webhookSecretRefresh:${mode}`;
    if (Date.now() - (await this.ctx.storage.get<number>(refreshKey) ?? 0)
      < WEBHOOK_SECRET_REFRESH_MIN_INTERVAL_MS) {
      return stored ?? null;
    }
    try {
      const api = await this.#api();
      const subscriptions = await api.listWebhookSubscriptions();
      // The stamp goes down even on a miss, so a heal storm (forged or failing) stays throttled.
      await this.ctx.storage.put(refreshKey, Date.now());
      const ours = subscriptions.find(sub => stored !== undefined && sub.id === stored.id)
        ?? subscriptions.find(sub => sub.webhookUrl === (stored?.url ?? ""))
        ?? subscriptions[0];
      if (ours === undefined || ours.secret === null) return null;
      const updated: StoredWebhookSubscription = {
        id: ours.id, secret: ours.secret,
        url: stored?.url ?? ours.webhookUrl,
      };
      await this.ctx.storage.put(subscriptionKey(mode), updated);
      return updated;
    } catch (err) {
      logger.warn("could not refresh the webhook subscription secret", {
        event: "account.webhook.secret-refresh-failed", error: err,
      });
      return null;
    }
  }

  async #storedSubscription(mode: ComposioKeyMode): Promise<StoredWebhookSubscription | undefined> {
    return await this.ctx.storage.get<StoredWebhookSubscription>(subscriptionKey(mode));
  }

  /** Drops one trigger's row, capability record, and queued deliveries (initiator disposed). */
  async #dropTriggerState(triggerId: string): Promise<void> {
    const caps = await this.ctx.storage.get<StoredTriggerCaps>(triggerCapsKey(triggerId));
    if (caps !== undefined) disposeStub(caps.initiator);
    this.#triggerQueue.cancel(triggerId);
    this.ctx.storage.sql.exec(
      "DELETE FROM composio_triggers WHERE trigger_id = ?", triggerId);
    await this.ctx.storage.delete(triggerCapsKey(triggerId));
  }

  #triggerRow(triggerId: string): StoredTriggerRow | undefined {
    return this.ctx.storage.sql.exec<StoredTriggerRow>(
      "SELECT * FROM composio_triggers WHERE trigger_id = ?", triggerId,
    ).toArray()[0];
  }

  #triggerRows(): StoredTriggerRow[] {
    return this.ctx.storage.sql.exec<StoredTriggerRow>(
      "SELECT * FROM composio_triggers ORDER BY created_at DESC",
    ).toArray();
  }

  #countEvent(workspaceId: string, day: string, kind: "delivered" | "dropped"): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO composio_events (workspace_id, day, delivered, dropped)
         VALUES (?, ?, ?, 0)
       ON CONFLICT(workspace_id, day) DO UPDATE SET ${kind} = ${kind} + 1`,
      workspaceId, day, kind === "delivered" ? 1 : 0,
    );
  }

  /** Expires the 24h webhook-seen markers (the same window the delivery queue retains). */
  async #pruneWebhookSeen(now: number): Promise<void> {
    const cutoff = now - WEBHOOK_SEEN_TTL_MS;
    const stale: string[] = [];
    const seen = await this.ctx.storage.list<number>({ prefix: "webhookSeen:" });
    for (const [key, at] of seen) {
      if (typeof at === "number" && at < cutoff) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  /** Replans the alarm from scratch (called from inside a firing alarm). */
  async #planAlarm(): Promise<void> {
    const now = Date.now();
    const due = this.#triggerQueue.nextDue();
    const hasTriggers = this.#triggerRows().length > 0;
    let next: number | undefined = due;
    if (hasTriggers) {
      const last = await this.ctx.storage.get<number>("lastReconcileAt") ?? now;
      const reconcileDue = last + RECONCILE_INTERVAL_MS;
      next = next === undefined ? reconcileDue : Math.min(next, reconcileDue);
    }
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(now + 1000, next));
    }
  }

  /** After a mutation outside the alarm: pull the alarm in, never push it out. */
  async #planAlarmAfterMutation(): Promise<void> {
    const due = this.#triggerQueue.nextDue();
    const hasTriggers = this.#triggerRows().length > 0;
    let next: number | undefined = due;
    if (hasTriggers) {
      const reconcileDue = (await this.ctx.storage.get<number>("lastReconcileAt") ?? 0)
        + RECONCILE_INTERVAL_MS;
      next = next === undefined ? reconcileDue : Math.min(next, reconcileDue);
    }
    if (next === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    }
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
