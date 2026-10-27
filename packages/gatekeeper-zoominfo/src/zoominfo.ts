import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  workerVersionTag,
  type AccountDescription,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import { connectHandoffPageHtml, errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  commitReconnectOrThrow, ConnectionSubject,
  pinnedConnectionSubject, pinForConnect, stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import {
  ZoomInfoApi,
  ZoomInfoApiError,
  deriveCodeChallenge,
  exchangeAuthCode,
  generateCodeVerifier,
  refreshAccessToken,
  resolveOAuthConfig,
  type QueryParams,
} from "./zoominfo-api";
import { zoomInfoActions, type ZoomInfoActionHost } from "./zoominfo-actions";
import { EnrichmentOutcomes } from "./zoominfo-enrichment";
import type {
  AccountSummary,
  CompanyEnrichInput,
  CompanyInsightsCriteria,
  CompanyInsights,
  CompanyLookalike,
  CompanyMatch,
  CompanyOutputField,
  CompanyRefInput,
  CompanySearchCriteria,
  ContactEnrichInput,
  ContactLookalike,
  ContactLookalikesCriteria,
  ContactMatch,
  ContactOutputField,
  ContactRecommendation,
  ContactRecommendationsCriteria,
  ContactSearchCriteria,
  CorporateHierarchyOutputField,
  CreditUsage,
  EnrichEntity,
  EnrichFieldInfo,
  EnrichmentKind,
  EnrichmentOutcome,
  EnrichmentTicket,
  Insight,
  IntentEnrichCriteria,
  IntentSearchCriteria,
  IntentSignal,
  LookupFieldName,
  LookupFilters,
  LookupValue,
  NewsArticle,
  NewsEnrichCriteria,
  NewsSearchCriteria,
  PageRequest,
  Scoop,
  ScoopEnrichCriteria,
  ScoopSearchCriteria,
  SearchPage,
  SimilarCompaniesCriteria,
  UsageLimit,
  ZoomInfoSession,
} from "./types";
import TYPES_CODE from "./types.txt";
import ZOOMINFO_LOGO_SVG from "./zoominfo-logo.svg";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { dailyReadLimit, type Env } from "./zoominfo-env";
import {
  asResources,
  attrs,
  bool,
  clean,
  firstResource,
  idValue,
  mapCompanyMatch,
  mapContactMatch,
  mapIntentSignal,
  mapNewsArticle,
  mapScoop,
  num,
  pageQuery,
  str,
  toSearchPage,
} from "./zoominfo-mapping";
import { withinReadLimit, type ReadReservation } from "./zoominfo-reads";
import ZOOMINFO_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { ZoomInfoAccountConfiguratorRpc } from "./configurator/account-configurator-types";

/** What finishing an OAuth flow yields: a handoff page, or a refusal to show. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  /**
   * Set when this flow reconnects an existing account, so its grant is staged rather than made
   * live. The mode travels with the flow instead of living on the account: committing one
   * reconnect while another is in flight must not change how that other flow lands.
   */
  reconnect?: true;
};

type StoredIdentity = {
  displayName?: string;
  uniqueName?: string;
  /** The OIDC `sub` claim, when ZoomInfo's ID token carried one; reconnects pin against it. */
  subject?: string;
};

/** The subject a grant's identity pins the connection to: `id` is what the kit's fence compares,
 * the names are for display and refusal messages. */
type ZoomInfoSubject = ConnectionSubject & {
  displayName?: string;
  uniqueName?: string;
};

/** The values a token grant is persisted as; staged whole during a reconnect (see commitReconnect). */
type StoredGrant = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  scopes: string[];
};

type ZoomInfoGatekeeperImplProps = {
  userObjectId: string;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
// Lookup taxonomies (industries, job functions, intent topics, entitled enrich fields, …) are
// effectively static reference data, so we cache them per account binding for a day to avoid
// re-fetching on every search. Dynamic reads (search/insights/summaries) are intentionally uncached.
const LOOKUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Full scope set requested at connect: ZoomInfo has no separately-grantable resources here, so we
// request everything this gatekeeper's session can use. The account's package entitlements are the
// real authority — unentitled scopes simply yield empty/forbidden results per call.
//
// These are the only scopes ZoomInfo's authorization server recognizes (verified against the live
// authorize endpoint; unknown scope names — including a would-be `api:data:lookup`, and even
// standard `openid`/`offline_access` — are rejected with `invalid_scope`). Lookup/enrich-field
// reference data has no dedicated scope; access to it comes with the data scopes above.
const OAUTH_SCOPES = [
  "api:data:company",
  "api:data:contact",
  "api:data:intent",
  "api:data:news",
  "api:data:scoops",
  "api:recommendations:read",
  "api:account-summary:read",
  "api:insights:read",
];

const ZOOMINFO_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(ZOOMINFO_LOGO_SVG)}`;

// Whole-account catch-all resource (matches any URL), like other single-tenant gatekeepers.
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "ZoomInfo Account",
  description:
    "Whole-account access: lookup, company/contact/intent/scoop/news search, record enrichment " +
    "(consumes credits), recommendations, and account intelligence — subject to entitlements.",
  icon: { url: ZOOMINFO_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

// Canonical URL for the connected account. ZoomInfo has no per-user public profile URL, so we use
// the app home; the binding is whole-account regardless.
const ACCOUNT_URL = "https://app.zoominfo.com/";

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #EE3524; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #EE3524; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #EE3524; font-size: 1.5rem; margin: 0 0 1rem 0;">ZoomInfo Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a ZoomInfo OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

// A list of agent-chosen names (fields, topics) for an enrichment summary, which sits in the
// description's prose and the title: one code span, so no name can open Markdown or HTML there.
function fieldList(names: readonly (string | number)[]): string {
  return names.length ? codeSpan(names.join(", ")) : "(none)";
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // Both values are fixed-length random hex nonces, so length carries no secret.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/zoominfo");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function ensureConfigured(env: Env): asserts env is Env & { CLIENT_ID: string; CLIENT_SECRET: string } {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The ZoomInfo gatekeeper is not configured.");
  }
}

// Best-effort decode of an OIDC ID token's claims (no signature check — it came straight from the
// token endpoint over TLS). Used only to give the connected account a friendly display name.
function parseIdTokenClaims(idToken: string | null): StoredIdentity {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(payload)) as {
      name?: string;
      email?: string;
      preferred_username?: string;
      sub?: string;
    };
    return {
      displayName: json.name || json.email || json.preferred_username,
      uniqueName: json.email || json.preferred_username || json.sub,
      // The OIDC subject: the stable id ZoomInfo pins a reconnect against.
      subject: json.sub,
    };
  } catch {
    return {};
  }
}

/**
 * The connection subject an identity establishes: the immutable OIDC `sub` claim when the ID token
 * carried one, else the mutable-but-best-available unique name. An identity carrying neither
 * cannot be told from any other account's, so it establishes no subject: its reconnect stages
 * subjectless and the fence does not compare it.
 */
function connectionSubjectOf(identity: StoredIdentity): ZoomInfoSubject | undefined {
  const id = identity.subject ?? identity.uniqueName;
  return id === undefined ? undefined : {
    id,
    ...(identity.displayName !== undefined ? { displayName: identity.displayName } : {}),
    ...(identity.uniqueName !== undefined ? { uniqueName: identity.uniqueName } : {}),
  };
}

/** How an account-carrying record is named in user-facing reconnect refusals. */
function describeZoomInfoAccount(named: { displayName?: string; uniqueName?: string }): string {
  return named.displayName || named.uniqueName || "the original account";
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth (Authorization Code + PKCE) flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Auth initiation: /<doId>/<initiationNonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const oauth = resolveOAuthConfig(env);
      const redirectUrl = new URL(oauth.authorizeUrl);
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
      redirectUrl.searchParams.set("code_challenge", begun.codeChallenge);
      redirectUrl.searchParams.set("code_challenge_method", "S256");
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(
          "ZoomInfo authorization failed or was denied. Please restart the connection flow from Cloudflare OS.",
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const result = await stub.acceptAuthCode(code, oauthNonce);
      if (result === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if ("refused" in result) {
        return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
      }
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "ZoomInfo",
      url: "https://www.zoominfo.com",
      logo: { url: ZOOMINFO_LOGO_URL },
      color: "#EE3524",
      tagline: "Search and enrich B2B company & contact intelligence",
      description:
        "Connect your ZoomInfo account so Cloudflare OS can resolve filter values, search companies, " +
        "contacts, intent signals, scoops, and news, and enrich matched records into full detail. " +
        "Search is free; enrichment consumes ZoomInfo credits. Build agents that assemble target " +
        "account lists, research accounts, and prioritize outreach on buying signals.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores OAuth credentials, performs PKCE token exchange, and refreshes access
// tokens (persisting rotated refresh tokens).

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    clearCredentialExpiryLatch(this.ctx.storage.kv);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  /**
   * Verify the initiation nonce, then mint the PKCE pair for the authorize redirect. The
   * code_verifier is stored server-side (never leaves the DO) and consumed at token exchange.
   */
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    this.ctx.storage.kv.put("codeVerifier", codeVerifier);
    return { oauthNonce, codeChallenge };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on:
   * a handoff, a refusal to show (never the page for a reconnect that pinned a different
   * account), or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    const codeVerifier = this.ctx.storage.kv.get<string>("codeVerifier");
    if (!codeVerifier) return null;
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("codeVerifier");

    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const oauth = resolveOAuthConfig(this.env);
    const grant = await exchangeAuthCode(
      code,
      codeVerifier,
      `${getBaseUrl(this.env)}/oauth`,
      this.env.CLIENT_ID,
      this.env.CLIENT_SECRET,
      oauth.tokenUrl,
    );
    if (!grant.refreshToken) {
      throw new Error("ZoomInfo did not return a refresh token.");
    }

    const storedGrant: StoredGrant = {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
      scopes: grant.scopes,
    };
    const subject = connectionSubjectOf(parseIdTokenClaims(grant.idToken));

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // A reconnect only ever reconnects the account it was made for: the OIDC subject the grant
      // carries must be the one this connection is pinned to. A different account's grant is
      // dropped unstaged (ZoomInfo offers no token revocation endpoint to retire it with).
      const staged = stageReconnect(this.ctx.storage.kv, storedGrant, subject, Date.now(),
        (pinned, granted) => ({
          title: "That's a different ZoomInfo account",
          detail: `This connection is for ${describeZoomInfoAccount(pinned)}, but ZoomInfo ` +
            `authorized ${describeZoomInfoAccount(granted)}. Sign in to ZoomInfo as ` +
            `${describeZoomInfoAccount(pinned)} and reconnect, or connect ` +
            `${describeZoomInfoAccount(granted)} as a separate account.`,
        }));
      if ("refused" in staged) return { refused: staged.refused };
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      handoff = await callback.reconnectComplete(staged.stageId);
    } else {
      this.#writeGrant(storedGrant);
      // The pin lives only as long as the handoff: a connect that fails unpins again and drops
      // the credentials stored ahead of it. A keyless grant carries no subject, so it pins
      // nothing (see `pinForConnect`).
      handoff = await pinForConnect(this.ctx.storage.kv, subject,
        () => {
          const props: ZoomInfoGatekeeperImplProps = { userObjectId: this.ctx.id.toString() };
          return callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
        },
        () => {
          this.ctx.storage.kv.delete("refreshToken");
          this.ctx.storage.kv.delete("accessToken");
        });
    }

    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. The kit
   * re-pins the staged subject when the grant carried one, adopting a connection made before any
   * pin and never moving an established one. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitReconnectOrThrow<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    this.#writeGrant(grant);
  }

  #writeGrant(grant: StoredGrant): void {
    this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", grant.accessTokenExpiresAt);
    this.ctx.storage.kv.put("scopes", grant.scopes);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (token && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) {
      return token;
    }

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("ZoomInfo credentials have not been configured for this account.");
    }
    ensureConfigured(this.env);
    const oauth = resolveOAuthConfig(this.env);

    let grant;
    try {
      grant = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET, oauth.tokenUrl);
    } catch (err) {
      if (err instanceof ZoomInfoApiError && (err.isAuthError || err.status === 400)) {
        await this.noteCredentialsExpired();
      }
      throw err;
    }

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    // ZoomInfo rotates refresh tokens: always persist the new one and drop the consumed one.
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("scopes", grant.scopes);
    return grant.accessToken;
  }

  async getIdentity(): Promise<StoredIdentity> {
    // The connection's pinned subject carries the identity: its names came from the ID token the
    // grant that earned the pin was verified with. A keyless grant pins nothing, so nothing shows.
    return pinnedConnectionSubject<ZoomInfoSubject>(this.ctx.storage.kv) ?? {};
  }

  /**
   * Reserves one ZoomInfo API request against the connection's daily limit (`0` = none). The UTC
   * day the reservation was made against travels with the answer so a straggler can be settled.
   */
  async reserveRead(): Promise<ReadReservation> {
    const limit = dailyReadLimit(this.env);
    if (limit === null) return { ok: true };
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const stored = this.ctx.storage.kv.get<{ day: string; used: number }>("reads");
    const used = stored?.day === day ? stored.used : 0;
    if (used >= limit) {
      const midnight = new Date(`${day}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
      return { ok: false, limit, resetsAt: midnight };
    }
    this.ctx.storage.kv.put("reads", { day, used: used + 1 });
    return { ok: true, day };
  }

  /**
   * Settles one read reserved against `day` with whether the request was spent. A reservation
   * that outlived its day settles nothing: the new day's count isn't its to change.
   */
  async settleRead(day: string, spent: boolean): Promise<void> {
    if (dailyReadLimit(this.env) === null) return;
    const stored = this.ctx.storage.kv.get<{ day: string; used: number }>("reads");
    if (stored?.day !== day) return;
    this.ctx.storage.kv.put("reads", { day, used: Math.max(0, stored.used - (spent ? 0 : 1)) });
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "zoominfo");
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // ZoomInfo exposes no token-revocation endpoint; drop the local credentials. The user can
    // revoke the app's access from their ZoomInfo admin settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#userAccount().getIdentity();
    return {
      displayName: identity.displayName ?? identity.uniqueName ?? "ZoomInfo Account",
      uniqueName: identity.uniqueName,
      avatar: { url: ZOOMINFO_LOGO_URL },
    };
  }

  /** ZoomInfo is not offered as a sign-in identity provider. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const props: ZoomInfoGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return { class: this.ctx.exports.ZoomInfoGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported ZoomInfo resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: ZOOMINFO_ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new ZoomInfoAccountConfiguratorUI()),
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  /**
   * ZoomInfo uses the private-only observer strategy. The verifier is never consulted, but the
   * overseer mints one on every collaborator open, so getVerifier must still return a valid stub.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ZoomInfoVerifier({});
  }
}

// A trivial verifier since ZoomInfoGatekeeperImpl refuses all non-owner observers.
@validateRpc()
export class ZoomInfoVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — whole-account has no inputs; just reports the canonical URL.

class ZoomInfoAccountConfiguratorUI extends RpcTarget implements ZoomInfoAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return ACCOUNT_URL;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl — per-Gadget binding to the connected account.

@validateRpc()
export class ZoomInfoGatekeeperImpl extends DurableObject<Env, ZoomInfoGatekeeperImplProps>
  implements Gatekeeper<ZoomInfoSession> {

  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<ResourceDescription> {
    const identity = await this.#userAccount().getIdentity();
    const title = identity.displayName ? `${identity.displayName}'s ZoomInfo` : "ZoomInfo Account";
    return {
      url: ACCOUNT_URL,
      title,
      snippet:
        "Whole-account access: lookup, search (companies, contacts, intent, scoops, news), " +
        "enrichment (consumes credits), recommendations, and account intelligence.",
      suggestedBindingName: "ZOOMINFO",
      tsType: "ZoomInfoSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return this.#enrichment().set.autoApprovableKinds();
  }

  #makeApi(account: DurableObjectStub<UserAccount>): ZoomInfoApi {
    return new ZoomInfoApi(() => account.getAccessToken(), resolveOAuthConfig(this.env).apiBaseUrl);
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ZoomInfoSession> {
    return new ZoomInfoSessionImpl(
      this.#userAccount(), approvalQueue.dup(), resolveOAuthConfig(this.env).apiBaseUrl, this.ctx.storage.kv);
  }

  /** The enrichment lifecycle and its host, bound once per storage (zoominfo-actions.ts). */
  #enrichment() {
    return zoomInfoActions(this.ctx.storage.kv, this.#enrichmentHost());
  }

  #enrichmentHost(): ZoomInfoActionHost {
    const account = this.#userAccount();
    const outcomes = this.#outcomes();
    return {
      call: fn => withinReadLimit(account, () => callZoomInfo(account, () => fn(this.#makeApi(account)))),
      putOutcome: (id, outcome) => outcomes.put(id, outcome),
    };
  }

  #outcomes(): EnrichmentOutcomes {
    return new EnrichmentOutcomes(this.ctx.storage.kv);
  }

  /**
   * Approved: the engine (zoominfo-actions.ts) replays the queued enrichment against ZoomInfo,
   * spending credits, and records the outcome for the Gadget to read via getEnrichmentResult().
   * A definitive ZoomInfo failure resolves the action as failed rather than re-thrown as
   * retryable: the overseer must not retry a paid operation that may have already charged
   * credits. A failure whose outcome is unknown is recorded terminally as unknown and surfaced,
   * so the enrichment is never replayed blind.
   */
  async applyAction(action: number): Promise<void> {
    await this.#enrichment().set.apply(action);
  }

  /** Rejected: the engine discards the queued enrichment (no credits spent) and records it. */
  async rejectAction(action: number): Promise<void> {
    await this.#enrichment().set.reject(action);
  }

  /**
   * Enrichment isn't revertable: spent credits can't be refunded. The action sets
   * implementsRevert: false, so this is not normally reached; we drop the stored outcome defensively.
   */
  async revertAction(action: number): Promise<void | { message?: string; canRetry?: boolean }> {
    this.#outcomes().remove(action);
    return {
      message:
          "Enrichment can't be reverted: any ZoomInfo credits spent are not refundable. The " +
          "retrieved data has been discarded from this Gadget.",
    };
  }

  /**
   * Observer tracking — strategy A (private-only). This whole-account binding exposes licensed,
   * entitlement-dependent data and account-specific intelligence, and ZoomInfo provides no ACL
   * oracle that can prove another account could read every historical result.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "ZoomInfo data cannot be shared with other users: this workspace's ZoomInfo account may only " +
      "be observed by its owner.",
    );
  }

  async removeObserver(_id: string): Promise<void> {}
}


// Intent- and scoop-signal search filter by firmographics only; ZoomInfo rejects company-identity
// inputs there with an opaque "Invalid field requested" 400. The typed API omits these fields (see
// SignalCompanyFilters), but RPC arguments are plain JSON at runtime, so guard against a force-sent
// identity field and fail with an actionable message pointing at the enrich variant.
const SIGNAL_COMPANY_IDENTITY_FIELDS = ["companyId", "companyName", "companyWebsite"] as const;
function assertNoCompanyIdentity(
  company: Record<string, unknown> | undefined,
  searchMethod: string,
  enrichMethod: string,
): void {
  const offending = SIGNAL_COMPANY_IDENTITY_FIELDS.filter(f => company?.[f] !== undefined);
  if (offending.length > 0) {
    throw new Error(
      `${offending.join(", ")} ${offending.length === 1 ? "is" : "are"} not supported by ` +
        `${searchMethod} — it filters by firmographics only, not company identity. Use ` +
        `${enrichMethod} to retrieve signals for a specific company.`,
    );
  }
}

// ZoomInfo's `state` values are US/Canada regions, so a `state` filter already scopes to that
// country. When `state` and `country` are supplied together ZoomInfo silently ignores `state` and
// broadens the results to the whole country — returning wrong data with no error. Rather than let
// that pass quietly, reject the combination up front so the caller keeps exactly one location
// filter. Applies to every company-filter bag (flat for company search, nested for the others).
function assertCompatibleLocation(company: Record<string, unknown> | undefined, method: string): void {
  if (company?.state !== undefined && company?.country !== undefined) {
    throw new Error(
      `${method}: \`state\` and \`country\` cannot be combined — ZoomInfo ignores \`state\` when ` +
        `\`country\` is also set and returns the whole country. Pass just \`state\` (it already ` +
        `scopes to the US/Canada) or just \`country\`.`,
    );
  }
}


// Run a ZoomInfo API call, translating auth failures into a reconnect-prompting error and notifying
// the account so the user is asked to reconnect. Shared by the session (reads) and applyAction
// (approved enrichments).
async function callZoomInfo<T>(account: DurableObjectStub<UserAccount>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ZoomInfoApiError && error.isAuthError) {
      await account.noteCredentialsExpired();
      throw new Error("ZoomInfo credentials have expired or been revoked. Please reconnect the account.", {
        cause: error,
      });
    }
    throw error;
  }
}

type CachedValue<T> = { value: T; fetchedAt: number };

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget.

@validateRpc()
class ZoomInfoSessionImpl extends RpcTarget implements ZoomInfoSession {
  #account: DurableObjectStub<UserAccount>;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #api: ZoomInfoApi;
  #kv: DurableObjectStorage["kv"];

  constructor(
    account: DurableObjectStub<UserAccount>,
    approvalQueue: RpcStub<ApprovalQueue>,
    apiBaseUrl: string,
    kv: DurableObjectStorage["kv"],
  ) {
    super();
    this.#account = account;
    this.#approvalQueue = approvalQueue;
    this.#api = new ZoomInfoApi(() => account.getAccessToken(), apiBaseUrl);
    this.#kv = kv;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  // Run an API call within the connection's daily read limit, translating auth failures into a
  // reconnect-prompting error. Cache hits skip this chokepoint entirely.
  #call<T>(fn: (api: ZoomInfoApi) => Promise<T>): Promise<T> {
    return withinReadLimit(this.#account, () => callZoomInfo(this.#account, () => fn(this.#api)));
  }

  #observe(title: string, description: string): Promise<void> {
    return this.#approvalQueue.authorizeObservation({ title, description });
  }

  // Read a cached value if still fresh, else undefined. Cache lives in the GatekeeperImpl DO's KV,
  // shared across this binding's sessions and scoped to this connected account.
  #cacheGet<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.#kv.get<CachedValue<T>>(`cache:${key}`);
    if (!hit || Date.now() - hit.fetchedAt >= ttlMs) return undefined;
    return hit.value;
  }

  #cachePut<T>(key: string, value: T): void {
    this.#kv.put<CachedValue<T>>(`cache:${key}`, { value, fetchedAt: Date.now() });
  }

  // Submit a paid enrichment for approval: the engine stages it on the journal (under the
  // pending cap, with the lost-submit-reply guard), describes it for the approver, and hands it
  // to the queue; this returns a ticket the Gadget passes to getEnrichmentResult(). No credits
  // are spent until approval, and `awaitDecision` (declared on the definition) suspends the
  // agent's turn until the user decides.
  async #submitEnrichment(
    kind: EnrichmentKind,
    summary: string,
    attributes: Record<string, unknown>,
    worstCaseCredits: number,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    const { set } = zoomInfoActions(this.#kv, this.#enrichmentHost());
    const id = await set.submit(this.#approvalQueue, "enrich",
      { kind, summary, attributes, ...(page === undefined ? {} : { page }), worstCaseCredits });
    return { id, kind, summary };
  }

  /** The enrichment host over this session's account, API, and shared storage. */
  #enrichmentHost(): ZoomInfoActionHost {
    const outcomes = new EnrichmentOutcomes(this.#kv);
    return {
      call: fn => this.#call(fn),
      putOutcome: (id, outcome) => outcomes.put(id, outcome),
    };
  }

  // -------------------------------------------------------------------------
  // Lookup

  async lookup(fieldName: LookupFieldName, filters?: LookupFilters): Promise<LookupValue[]> {
    const cacheKey = `lookup:${fieldName}:${JSON.stringify(filters ?? {})}`;
    let results = this.#cacheGet<LookupValue[]>(cacheKey, LOOKUP_CACHE_TTL_MS);
    const fromCache = results !== undefined;
    if (results === undefined) {
      const query: QueryParams = clean({
        "filter[category]": filters?.category,
        "filter[parentCategory]": filters?.parentCategory,
        "filter[subCategory]": filters?.subCategory,
        "filter[vendor]": filters?.vendor,
      });
      const doc = await this.#call(api => api.get(`/data/v1/lookup/${encodeURIComponent(fieldName)}`, query));
      results = asResources(doc).map(r => {
        const a = attrs(r);
        const { name, ...rest } = a;
        return { id: r.id ?? "", type: r.type ?? fieldName, name: str(name), attributes: rest } as LookupValue;
      });
      this.#cachePut(cacheKey, results);
    }
    await this.#observe(
      `Lookup ${fieldName}`,
      `Resolved ${results.length} value(s) for the \`${fieldName}\` taxonomy${fromCache ? " (cached)" : ""}.`,
    );
    return results;
  }

  async lookupEnrichFields(entity: EnrichEntity, fieldType: "input" | "output"): Promise<EnrichFieldInfo[]> {
    const cacheKey = `lookupEnrich:${entity}:${fieldType}`;
    let results = this.#cacheGet<EnrichFieldInfo[]>(cacheKey, LOOKUP_CACHE_TTL_MS);
    const fromCache = results !== undefined;
    if (results === undefined) {
      const doc = await this.#call(api =>
        api.get("/data/v1/lookup/enrich", { "filter[entity]": entity, "filter[fieldType]": fieldType }));
      results = asResources(doc).map(r => {
        const a = attrs(r);
        return {
          fieldName: str(a.fieldName) ?? r.id ?? "",
          description: str(a.description) ?? "",
          fieldType: str(a.fieldType),
          accessGranted: bool(a.accessGranted),
        } satisfies EnrichFieldInfo;
      });
      this.#cachePut(cacheKey, results);
    }
    await this.#observe(
      `Lookup ${entity} enrich ${fieldType} fields`,
      `Returned ${results.length} ${fieldType} field(s) for ${entity} enrichment${fromCache ? " (cached)" : ""}.`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Companies

  async searchCompanies(criteria: CompanySearchCriteria, page?: PageRequest): Promise<SearchPage<CompanyMatch>> {
    assertCompatibleLocation(criteria, "searchCompanies");
    const doc = await this.#call(api =>
      api.post("/data/v1/companies/search", "CompanySearch", clean({ ...criteria }), pageQuery(page)));
    const result = toSearchPage(doc, mapCompanyMatch, page);
    await this.#observe(
      "Search ZoomInfo companies",
      `Company search returned ${result.results.length} of ${result.totalResults} match(es).`,
    );
    return result;
  }

  async enrichCompanies(
    inputs: CompanyEnrichInput[],
    outputFields: CompanyOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchCompanyInput = inputs.map(input => clean({ ...input, companyId: idValue(input.companyId) }));
    return this.#submitEnrichment(
      "companies",
      `Enrich ${inputs.length} compan${inputs.length === 1 ? "y" : "ies"} with fields: ` +
        `${fieldList(outputFields)}`,
      { matchCompanyInput, outputFields },
      inputs.length,
    );
  }

  async enrichCorporateHierarchy(
    inputs: CompanyRefInput[],
    outputFields: CorporateHierarchyOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchCompanyInput = inputs.map(input => clean({ ...input, companyId: idValue(input.companyId) }));
    return this.#submitEnrichment(
      "corporateHierarchy",
      `Enrich corporate hierarchy for ${inputs.length} compan${inputs.length === 1 ? "y" : "ies"}, ` +
        `requesting fields: ${fieldList(outputFields)}`,
      { matchCompanyInput, outputFields },
      inputs.length,
    );
  }

  async enrichHashtags(companyId: string): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "hashtags",
      `Fetch hashtags for company ${codeSpan(String(companyId))}`,
      clean({ companyId: idValue(companyId) }),
      1,
    );
  }

  // -------------------------------------------------------------------------
  // Contacts

  async searchContacts(criteria: ContactSearchCriteria, page?: PageRequest): Promise<SearchPage<ContactMatch>> {
    const { company, ...contact } = criteria;
    assertCompatibleLocation(company, "searchContacts");
    const attributes = clean({ ...company, ...contact });
    const doc = await this.#call(api =>
      api.post("/data/v1/contacts/search", "ContactSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapContactMatch, page);
    await this.#observe(
      "Search ZoomInfo contacts",
      `Contact search returned ${result.results.length} of ${result.totalResults} match(es).`,
    );
    return result;
  }

  async enrichContacts(
    inputs: ContactEnrichInput[],
    outputFields: ContactOutputField[],
    requiredFields?: ContactOutputField[],
  ): Promise<EnrichmentTicket> {
    const matchPersonInput = inputs.map(input => clean({
      ...input,
      personId: idValue(input.personId),
      companyId: idValue(input.companyId),
    }));
    return this.#submitEnrichment(
      "contacts",
      `Enrich ${inputs.length} contact${inputs.length === 1 ? "" : "s"} with fields: ` +
        `${fieldList(outputFields)}` +
        `${requiredFields?.length ? `; required: ${fieldList(requiredFields)}` : ""}`,
      clean({ matchPersonInput, outputFields, requiredFields }),
      inputs.length,
    );
  }

  // -------------------------------------------------------------------------
  // Intent

  async searchIntent(criteria: IntentSearchCriteria, page?: PageRequest): Promise<SearchPage<IntentSignal>> {
    const { company, ...intent } = criteria;
    assertNoCompanyIdentity(company, "searchIntent", "enrichIntent");
    assertCompatibleLocation(company, "searchIntent");
    const attributes = clean({ ...company, ...intent });
    const doc = await this.#call(api =>
      api.post("/data/v1/intent/search", "IntentSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapIntentSignal, page);
    await this.#observe(
      "Search ZoomInfo intent signals",
      `Intent search for topics [${criteria.topics.join(", ")}] returned ${result.results.length} ` +
        `of ${result.totalResults} signal(s).`,
    );
    return result;
  }

  async enrichIntent(
    criteria: IntentEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "intent",
      "Fetch intent signals for the company named in the request across topics " +
        `${fieldList(criteria.topics)}`,
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // Scoops

  async searchScoops(criteria: ScoopSearchCriteria, page?: PageRequest): Promise<SearchPage<Scoop>> {
    const { contact, company, ...scoop } = criteria;
    assertNoCompanyIdentity(company, "searchScoops", "enrichScoops");
    assertCompatibleLocation(company, "searchScoops");
    const attributes = clean({ ...contact, ...company, ...scoop });
    const doc = await this.#call(api =>
      api.post("/data/v1/scoops/search", "ScoopSearch", attributes, pageQuery(page)));
    const result = toSearchPage(doc, mapScoop, page);
    await this.#observe(
      "Search ZoomInfo scoops",
      `Scoop search returned ${result.results.length} of ${result.totalResults} scoop(s).`,
    );
    return result;
  }

  async enrichScoops(
    criteria: ScoopEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "scoops",
      "Fetch scoops for the company named in the request",
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // News

  async searchNews(criteria: NewsSearchCriteria, page?: PageRequest): Promise<SearchPage<NewsArticle>> {
    const doc = await this.#call(api =>
      api.post("/data/v1/news/search", "NewsSearch", clean({ ...criteria }), pageQuery(page)));
    const result = toSearchPage(doc, mapNewsArticle, page);
    await this.#observe(
      "Search ZoomInfo news",
      `News search returned ${result.results.length} of ${result.totalResults} article(s).`,
    );
    return result;
  }

  async enrichNews(
    criteria: NewsEnrichCriteria,
    page?: PageRequest,
  ): Promise<EnrichmentTicket> {
    return this.#submitEnrichment(
      "news",
      "Fetch news articles for the company named in the request",
      clean({ ...criteria, companyId: idValue(criteria.companyId) }),
      1,
      page,
    );
  }

  // -------------------------------------------------------------------------
  // Enrichment results

  async getEnrichmentResult(ticket: EnrichmentTicket): Promise<EnrichmentOutcome> {
    const outcomes = new EnrichmentOutcomes(this.#kv);
    const stored = outcomes.get(ticket.id);
    let outcome: EnrichmentOutcome;
    if (stored) {
      // The stored result payload is untyped (see StoredEnrichmentOutcome); its shape was produced
      // by performEnrichment for this ticket's kind, so we re-attach the kind discriminant to form a
      // correctly-shaped EnrichmentReady. This cast is the single trust boundary for that fact.
      outcome = stored.status === "ready"
        ? ({ status: "ready", kind: ticket.kind, result: stored.result } as EnrichmentOutcome)
        : stored;
    } else {
      // Nothing in the window yet: the journal's live record says where the enrichment is. A
      // failed record carries its explanation until the user rejects it; a terminal unknown
      // outcome can land here too, right after a rejection copied it into the window.
      const record = zoomInfoActions(this.#kv, this.#enrichmentHost()).journal.get(ticket.id);
      if (record === undefined) {
        throw new Error(`Unknown ZoomInfo enrichment ticket: ${ticket.id}`);
      }
      outcome = record.state === "failed"
        ? (record.outcome === "unknown"
          ? { status: "unknown", message: record.error }
          : { status: "failed", message: record.error })
        : { status: "pending" };
    }
    await this.#observe(
      `Read ZoomInfo enrichment result #${ticket.id}`,
      `Enrichment \`${ticket.kind}\` (${ticket.summary}): **${outcome.status}**.`,
    );
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Recommendations & lookalikes

  async findSimilarCompanies(criteria: SimilarCompaniesCriteria): Promise<CompanyLookalike[]> {
    const query: QueryParams = clean({
      "filter[companyId]": criteria.companyId,
      "filter[companyName]": criteria.companyName,
      "filter[sameRevenueRange]": criteria.sameRevenueRange,
      "filter[sameCountry]": criteria.sameCountry,
      "filter[sameIndustry]": criteria.sameIndustry,
      "filter[sameEmployeeRange]": criteria.sameEmployeeRange,
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/companies/lookalikes", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      return {
        id: r.id ?? "",
        companyName: str(a.companyName) ?? "",
        score: num(a.score) ?? 0,
        rank: num(a.rank) ?? 0,
        industry: str(a.industry),
        revenueRange: str(a.revenueRange),
        employeeRange: str(a.employeeRange),
        country: str(a.country),
      } satisfies CompanyLookalike;
    });
    await this.#observe("Find similar ZoomInfo companies", `Returned ${results.length} lookalike compan(ies).`);
    return results;
  }

  async findContactLookalikes(criteria: ContactLookalikesCriteria): Promise<ContactLookalike[]> {
    const query: QueryParams = clean({
      "filter[referencePersonId]": idValue(criteria.referencePersonId),
      "filter[targetCompanyId]": idValue(criteria.targetCompanyId),
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/contacts/lookalikes", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      const meta = (r.meta ?? {}) as { referencePersonId?: unknown; referencePersonBrief?: unknown };
      return {
        id: r.id ?? "",
        rank: num(a.rank) ?? 0,
        score: num(a.score) ?? 0,
        lookalikePersonBrief: str(a.lookalikePersonBrief),
        referencePersonId: str(meta.referencePersonId),
        referencePersonBrief: str(meta.referencePersonBrief),
      } satisfies ContactLookalike;
    });
    await this.#observe("Find ZoomInfo contact lookalikes", `Returned ${results.length} lookalike contact(s).`);
    return results;
  }

  async getContactRecommendations(criteria: ContactRecommendationsCriteria): Promise<ContactRecommendation[]> {
    const query: QueryParams = clean({
      "filter[useCaseType]": criteria.useCaseType,
      "filter[ziCompanyId]": idValue(criteria.companyId),
      "page[size]": criteria.limit,
    });
    const doc = await this.#call(api => api.get("/copilot/v1/contacts/recommendations", query));
    const results = asResources(doc).map(r => {
      const a = attrs(r);
      const meta = (r.meta ?? {}) as {
        sourceType?: unknown; referencePersonId?: unknown; referencePersonBrief?: unknown;
      };
      return {
        id: r.id ?? "",
        rank: num(a.rank) ?? 0,
        score: num(a.score) ?? 0,
        reRankingScore: num(a.reRankingScore),
        recommendedPersonBrief: str(a.recommendedPersonBrief),
        sourceType: str(meta.sourceType),
        referencePersonId: str(meta.referencePersonId),
        referencePersonBrief: str(meta.referencePersonBrief),
      } satisfies ContactRecommendation;
    });
    await this.#observe(
      "Get ZoomInfo contact recommendations",
      `Returned ${results.length} recommended contact(s) for ${criteria.useCaseType} at company ` +
        `\`${criteria.companyId}\`.`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Account intelligence

  async getAccountSummary(companyId: string): Promise<AccountSummary> {
    const doc = await this.#call(api =>
      api.get(`/copilot/v1/companies/${encodeURIComponent(companyId)}/account-summary`));
    const resource = firstResource(doc);
    const markdown = str(attrs(resource ?? {}).markdown) ?? "";
    await this.#observe(
      "Get ZoomInfo account summary",
      `Retrieved the account summary for company \`${companyId}\` (${markdown.length} chars).`,
    );
    return { companyId, markdown };
  }

  async askAccountSummary(companyId: string, question: string): Promise<string> {
    const doc = await this.#call(api =>
      api.post(
        `/copilot/v1/companies/${encodeURIComponent(companyId)}/account-summary/actions/ask`,
        "AccountSummaryQuestionRequest",
        { question },
      ));
    const answer = str(attrs(firstResource(doc) ?? {}).answer) ?? "";
    await this.#observe(
      "Ask ZoomInfo account summary",
      `Asked about company \`${companyId}\`: "${question}".`,
    );
    return answer;
  }

  async getCompanyInsights(criteria: CompanyInsightsCriteria): Promise<CompanyInsights[]> {
    const ziCompanyIds = criteria.companyIds.map(id => idValue(id));
    const doc = await this.#call(api =>
      api.post("/copilot/v1/companies/insights", "CompanyInsightsSearch",
        clean({ ziCompanyIds, signalTypes: criteria.signalTypes })));
    const results = asResources(doc).map(r => {
      const rawInsights = (attrs(r).insights ?? []) as Record<string, unknown>[];
      const insights: Insight[] = rawInsights.map(i => ({
        id: str(i.id) ?? "",
        ziCompanyId: str(i.ziCompanyId) ?? "",
        signalId: str(i.signalId) ?? "",
        signalType: str(i.signalType) ?? "",
        signalPayload: (i.signalPayload ?? {}) as Record<string, unknown>,
        insightDate: str(i.insightDate),
        expiresAt: str(i.expiresAt),
        createdAt: str(i.createdAt),
      }));
      return { companyId: r.id ?? "", insights } satisfies CompanyInsights;
    });
    const total = results.reduce((sum, c) => sum + c.insights.length, 0);
    await this.#observe(
      "Get ZoomInfo company insights",
      `Returned ${total} insight signal(s) across ${results.length} compan(ies).`,
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Usage

  async getCreditUsage(): Promise<CreditUsage> {
    const doc = await this.#call(api => api.get("/data/v1/users/usage"));
    const usageList = (attrs(firstResource(doc) ?? {}).usage ?? []) as Record<string, unknown>[];
    const usage: UsageLimit[] = usageList.map(u => ({
      limitType: str(u.limitType) ?? "",
      description: str(u.description),
      totalLimit: num(u.totalLimit),
      currentUsage: num(u.currentUsage),
      usageRemaining: num(u.usageRemaining),
    }));
    await this.#observe("Get ZoomInfo usage", `Retrieved ${usage.length} usage/limit counter(s).`);
    return { usage };
  }
}
