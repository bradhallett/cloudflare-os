import { WorkerEntrypoint, DurableObject, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, VendorDescription, GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription, SupportedResource, ResourceConfiguratorFrame, workerVersionTag, type ActionDescription, type ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  commitReconnectOrThrow,
  pinForConnect,
  stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import {
  PreviewOAuth,
  PreviewOAuthConfigurationError,
  type PreviewOAuthState,
} from "@gadgets/gatekeeper-kit/preview-oauth";
import { exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleAccountSubject, getGoogleVerifiedEmail, GoogleAccessToken, revokeGoogleToken } from "./google-api";
import {
  GoogleDocsApi,
} from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import { GoogleSlidesApi } from "./slides-api";
import {
  creationAction,
  newFileTitle,
  type SimulatedFileProps,
} from "./creation";
import {
  getGoogleSlidesTypesCode,
  type GoogleSlidesGatekeeperImplProps,
} from "./slides";
import {
  getGoogleSheetsTypesCode,
  type GoogleSheetsGatekeeperImplProps,
} from "./sheets";
import { DriveApi } from "./drive-api";
import { type DriveObservation } from "./drive-observers";
import {
  type DriveBindingScope,
} from "./drive-session";
import { ChatApi, isChatNoAccessError } from "./chat-api";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { BigQueryApi } from "./bigquery-api";
import {
  GoogleCalendarApi,
} from "./calendar-api";
import TYPES_CODE from "./types.txt";
import CHAT_TYPES_CODE from "./chat-types.txt";
import BIGQUERY_TYPES_CODE from "./bigquery-types.txt";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import {
  BigQueryConfiguratorUI,
  CalendarConfiguratorUI,
  ChatAccountConfiguratorUI,
  ChatSpaceConfiguratorUI,
  ChatThreadConfiguratorUI,
  GmailConfiguratorUI,
  GoogleDocConfiguratorUI,
  GoogleSheetsConfiguratorUI,
  GoogleSlidesConfiguratorUI,
  DriveConfiguratorUI,
} from "./google-configurators";
import BIGQUERY_CONFIGURATOR_HTML from "./generated/bigquery-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import CHAT_ACCOUNT_CONFIGURATOR_HTML from "./generated/chat-account-configurator-ui.txt";
import CHAT_SPACE_CONFIGURATOR_HTML from "./generated/chat-space-configurator-ui.txt";
import CHAT_THREAD_CONFIGURATOR_HTML from "./generated/chat-thread-configurator-ui.txt";
import GMAIL_CONFIGURATOR_HTML from "./generated/gmail-configurator-ui.txt";
import GOOGLE_DOC_CONFIGURATOR_HTML from "./generated/google-doc-configurator-ui.txt";
import GOOGLE_SHEETS_CONFIGURATOR_HTML from "./generated/google-sheets-configurator-ui.txt";
import GOOGLE_SLIDES_CONFIGURATOR_HTML from "./generated/google-slides-configurator-ui.txt";
import DRIVE_CONFIGURATOR_HTML from "./generated/drive-configurator-ui.txt";
import GOOGLE_LOGO_SVG from "./google-logo.svg";
import { obsContext } from "./observability.js";
import { AccessTokenRequest, ACCESS_TOKEN_EXPIRY_SAFETY_MS } from "./auth-retry";
import { Mutex } from "./mutex";
import {
  BIGQUERY_RESOURCE,
  GMAIL_RESOURCE,
  GOOGLE_CALENDAR_RESOURCE,
  GOOGLE_CHAT_RESOURCE,
  GOOGLE_CHAT_SPACE_RESOURCE,
  GOOGLE_CHAT_THREAD_RESOURCE,
  GOOGLE_DOC_RESOURCE,
  GOOGLE_DRIVE_RESOURCE,
  GOOGLE_SHEETS_RESOURCE,
  GOOGLE_SLIDES_RESOURCE,
  RESOURCE_BY_KIND,
  SUPPORTED_RESOURCES,
  creatableKind,
  grantedResourceUrlPatterns,
  hasDriveResourceGrant,
  isPrivateGrant,
  OFFICE_IMPORT_GRANT,
  SHARED_DRIVES_GRANT,
  parseResourceUrl,
  recordedResourceUrlPatterns,
  type RecordedResourceGrant,
} from "./resources";
import {
  OfficeConversion,
  type OfficeKind,
} from "./office-conversion";
import {
  beginStoredOAuthFlow,
  claimStoredOAuthFlow,
  mergeGrantedResources,
  prepareOAuthFlow,
  shouldDeleteCredentialsOnAlarm,
  type OAuthFlowMode,
} from "./oauth-flow";
import { type ObserverBatchResult } from "./observers";
import {
  getBasePath,
  getBaseUrl,
  getGoogleOAuthCallbackUri,
  type GoogleOAuthEnv,
} from "./oauth";
import {
  GMAIL_TYPES_MODULE_PREFIX,
  stripTypeModulePrefix,
} from "./type-bundle";

import { getGoogleDocTypesCode } from "./docs";
import { hasCalendarPrivateAccessRole } from "./calendar-api";
import { getDriveAgentTypesCode } from "./drive";

import type { GmailGatekeeperImplProps } from "./gmail";
import type { GoogleDocGatekeeperImplProps } from "./docs";
import type { GoogleCalendarGatekeeperImplProps } from "./calendar";
import type { GoogleDriveGatekeeperImplProps } from "./drive";
import type { BigQueryGatekeeperImplProps } from "./bigquery";
import type { GoogleChatGatekeeperImplProps } from "./chat";

export { GmailGatekeeperImpl } from "./gmail";
export { GoogleChatGatekeeperImpl } from "./chat";
export { ChatHookController, ChatHookDriver } from "./chat-hooks";
export { GmailHookController, GmailHookDriver } from "./gmail-hooks";
export { GoogleSheetsGatekeeperImpl } from "./sheets";
export { GoogleSlidesGatekeeperImpl } from "./slides";
export { BigQueryGatekeeperImpl } from "./bigquery";
export { GoogleCalendarGatekeeperImpl } from "./calendar";
export { GoogleDocGatekeeperImpl } from "./docs";
export { GoogleDriveGatekeeperImpl, GoogleDriveSessionImpl } from "./drive";
import { handlePubSubPush, type PushHooksEnv } from "./pubsub-push";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "google";
const logger = obsContext.createLogger({
  component: "gatekeeper.google", vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;

// Ceilings on the OAuth round trips that run while holding the credential mutex. Each must be
// bounded: an unbounded hang keeps the mutex, and every caller waiting for a token then queues
// behind it.
const TOKEN_MINT_TIMEOUT_MS = 20 * 1000;
const AUTH_CODE_EXCHANGE_TIMEOUT_MS = 30 * 1000;
const ACCOUNT_SUBJECT_READ_TIMEOUT_MS = 10 * 1000;
const TOKEN_REVOKE_TIMEOUT_MS = 10 * 1000;

// How long a permanent mint failure suppresses further attempts. Long enough to absorb the burst a
// revoke produces (every outstanding token 401s at once, so callers arrive within milliseconds),
// short enough that the account recovers on its own once the cause is fixed — an admin lifting a
// scope restriction leaves nothing for us to observe, so we have to re-ask Google eventually.
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}


// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & GoogleOAuthEnv & PushHooksEnv & {
  // OAuth app credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

// =======================================================================================

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Link Expired</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Google Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please see the README.md for instructions on configuring an OAuth client ID and secret so that this Cloudflare OS instance can access Google APIs.</p>
    </div>
  </body>
</html>`;

const GOOGLE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GOOGLE_LOGO_SVG)}`;

/** Main HTTP entrypoint: OAuth flows and Pub/Sub pushes from Google. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let previewOAuth: PreviewOAuth;
      try {
        previewOAuth = new PreviewOAuth({
          callbackUri: getGoogleOAuthCallbackUri(env),
          env,
        });
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : "Google OAuth callback is not configured.",
          { status: 503 },
        );
      }
      const begun = await stub.beginOAuthFlow(initiationNonce, previewOAuth.redirectUri);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", previewOAuth.redirectUri);
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      // Add newly-requested scopes to any the user already granted, rather than replacing them.
      newUrl.searchParams.set("include_granted_scopes", "true");
      const encodedState = await previewOAuth.createAuthorizationState({
        userObjectId: doId,
        oauthNonce: begun.oauthNonce,
      });
      newUrl.searchParams.set("state", encodedState);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/pubsub" && req.method === "POST") {
      return handlePubSubPush(req, env, ctx.exports);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided", { status: 400 });

      let oauthState: PreviewOAuthState;
      try {
        const previewOAuth = new PreviewOAuth({
          callbackUri: getGoogleOAuthCallbackUri(env),
          env,
        });
        const result = await previewOAuth.handleCallback(url);
        if (result.kind === "relay") {
          return result.response;
        }
        oauthState = result.state;
      } catch (error) {
        const configurationError = error instanceof PreviewOAuthConfigurationError;
        return new Response(error instanceof Error ? error.message : "Invalid Google OAuth state", {
          status: configurationError ? 500 : 400,
        });
      }

      let userObjectId;
      try {
        userObjectId = ctx.exports.UserAccount.idFromString(oauthState.userObjectId);
      } catch {
        return new Response("Error: malformed state", { status: 400 });
      }
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);

      let error = url.searchParams.get("error");
      if (error) {
        if (!await stub.consumeOAuthNonce(oauthState.oauthNonce)) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response("Google authorization was not completed.", { status: 400 });
      }

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      let result = await stub.acceptAuthCode(code, oauthState.oauthNonce);
      if (!result) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if ("refused" in result) {
        return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
      }
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}

// =======================================================================================

// Top-level API exposed to the Workshop.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Google Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google",
      url: "https://google.com",
      logo: { url: GOOGLE_LOGO_URL },
      color: "#e8f0fe",
      tagline: "Draft replies, edit docs, sheets and slides, search Drive, manage calendars, post to Chat, and analyze data",
      description:
          "Connect your Google account to give Cloudflare OS access to Gmail, Google Docs, Google " +
          "Sheets, Google Slides, Google Drive, Google Calendar, Google Chat, and BigQuery. Build " +
          "agents that triage email, draft and edit documents, spreadsheets and presentations, " +
          "search Drive and read native Docs and Sheets, find focus time, " +
          "schedule meetings, follow and post to Chat conversations, or run analytics queries on " +
          "your data.",
      providesAuth: true,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let requestedResources = authOnly
        ? []
        : options?.resourceUrlPatterns ?? SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
    let mode: OAuthFlowMode = authOnly ? "auth" : "connect";
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedResources, mode);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async createResource(resourceUrlPattern: string, title: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    action: ActionDescription;
  }> {
    let kind = creatableKind(resourceUrlPattern);
    let props: SimulatedFileProps = { creation: { title: newFileTitle(title) } };
    let cls: DurableObjectClass<Gatekeeper<any>>;
    switch (kind) {
      case "doc": cls = this.ctx.exports.GoogleDocGatekeeperImpl({props}); break;
      case "sheets": cls = this.ctx.exports.GoogleSheetsGatekeeperImpl({props}); break;
      case "slides": cls = this.ctx.exports.GoogleSlidesGatekeeperImpl({props}); break;
    }
    let resource = RESOURCE_BY_KIND[kind];
    return { class: cls, resource, action: creationAction(resource, props.creation.title) };
  }

  async getTypeScriptTypes(): Promise<string> {
    return [
      stripTypeModulePrefix(TYPES_CODE, GMAIL_TYPES_MODULE_PREFIX), getGoogleDocTypesCode(),
      getGoogleSheetsTypesCode(), getGoogleSlidesTypesCode(), CALENDAR_TYPES_CODE,
      BIGQUERY_TYPES_CODE, getDriveAgentTypesCode(), CHAT_TYPES_CODE,
    ].join("\n");
  }
}

/**
 * A hook driver holding some of an account's hooks, which the account tells to drop them when it
 * is disconnected: Gmail's per mailbox, Chat's per space.
 */
export type HookDriverRef = { kind: "gmail" | "chat"; name: string };

/**
 * What a reconnect flow obtains, held in escrow until commitReconnect() writes it live. The Google
 * account (`sub`) the new grant was verified as travels with the stage as its connection subject,
 * which is what the kit's fence checks and what committing re-pins.
 */
type StagedGoogleCredentials = {
  refreshToken: string;
  accessToken: GoogleAccessToken;
  grantedScopes: string[];
  requestedResources: string[];
};

/** What the locked section of acceptAuthCode() worked out, once it releases the mutex. */
type AuthCodeCompletion = {
  callback: Fetcher<GatekeeperConnectCallback>;
  mode: OAuthFlowMode;
  stageId?: string;
  refused?: { title: string; detail: string };
  /** The account the first-connect grant was verified as; carried out of the locked section so the
   * pin is written around the handoff (see `pinForConnect`), not inside it. */
  subject?: string;
};

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

export class UserAccount extends DurableObject<Env> {
  // Serialize minting, reconnect, and revoke against each other. Minting is a network round trip, so
  // without this a single invalidated token has every concurrent caller mint its own — a burst
  // against Google's token endpoint that may get rate-limited, turning a recoverable 401 into a hard
  // failure. It also keeps a mint from interleaving with credentials being replaced or wiped.
  #credentials = new Mutex();

  // The last mint that failed permanently — revoked credentials, or a scope an admin has blocked.
  #mintFailure: { error: Error; at: number } | undefined;

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedResources: string[], mode: OAuthFlowMode) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    prepareOAuthFlow(this.ctx.storage.kv, initiationNonce, requestedResources, mode, Date.now());
  }

  /** Prepare a reconnect or scope-expansion attempt for this account. */
  async prepareReconnect(initiationNonce: string, requestedResources: string[]) {
    prepareOAuthFlow(
      this.ctx.storage.kv, initiationNonce, requestedResources, "reconnect", Date.now());
  }

  /**
   * The grantable resource `urlPattern`s currently granted on this account. Used to decide
   * whether ensureResources() needs to expand.
   */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return grantedResourceUrlPatterns(this.#recordedGrant());
  }

  /**
   * The resource `urlPattern`s a reconnect must re-request. Unlike the granted set, this keeps a
   * resource whose scope requirements have grown since it was granted, which is the only way the
   * consent screen can ever repair it.
   */
  async getRequestableResourceUrlPatterns(): Promise<string[]> {
    return recordedResourceUrlPatterns(this.#recordedGrant());
  }

  #recordedGrant(): RecordedResourceGrant {
    let resourceUrlPatterns = this.ctx.storage.kv.get<string[]>("grantedResources");
    let oauthScopes = this.ctx.storage.kv.get<string[]>("grantedScopes");
    return {
      ...(resourceUrlPatterns === undefined ? {} : { resourceUrlPatterns }),
      ...(oauthScopes === undefined ? {} : { oauthScopes }),
    };
  }

  /** Begin the stored consent attempt, or return null when its initiation nonce is invalid. */
  async beginOAuthFlow(initiationNonce: string, oauthRedirectUri: string): Promise<{
    oauthNonce: string,
    scopes: string[],
  } | null> {
    let oauthNonce = generateNonce();
    return beginStoredOAuthFlow(
        this.ctx.storage.kv, initiationNonce, oauthNonce, oauthRedirectUri, Date.now());
  }

  consumeOAuthNonce(oauthNonce: string): boolean {
    return claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now()) !== null;
  }
  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, a
   * refusal to show there instead, or null if the OAuth nonce is invalid or expired.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    let flow = claimStoredOAuthFlow(this.ctx.storage.kv, oauthNonce, Date.now());
    if (!flow) return null;

    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    // The credential swap is serialized against minting and revoke, but the callbacks below are
    // not: they are outbound RPCs that can re-enter this object, and awaiting one while holding the
    // mutex would deadlock. So the locked section returns what the notifications need and the
    // notifications happen after it releases.
    let completion = await this.#credentials.run(async (): Promise<AuthCodeCompletion> => {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        // Must have timed out.
        throw new Error("Took too long to complete the authorization. Please try again.");
      }

      let response = await exchangeAuthCode(
          code, clientId, clientSecret, flow.oauthRedirectUri,
          AbortSignal.timeout(AUTH_CODE_EXCHANGE_TIMEOUT_MS));

      if (!response.refreshToken) {
        throw new Error("OAuth exchange didn't return refresh token?");
      }

      // The connection is pinned to the Google account that made it: the subject is read now, from
      // the new grant itself, so a reconnect as anyone else is refused before anything is staged.
      let subject: string;
      try {
        subject = await getGoogleAccountSubject(response.accessToken.token,
          AbortSignal.timeout(ACCOUNT_SUBJECT_READ_TIMEOUT_MS));
      } catch (err) {
        if (flow.mode !== "reconnect") await this.#revokeRefreshToken(response.refreshToken);
        throw new Error("Could not read which Google account authorized this connection. Please try again.",
          { cause: err });
      }

      if (flow.mode === "reconnect") {
        // The reconnect URL is a bearer capability, so the new grant is only staged until the
        // Workshop has confirmed the browser that finished the flow is the owner's (see
        // commitReconnect). The kit refuses a grant for anyone but the pinned account. Bound
        // gadgets keep reading the current token meanwhile.
        let staged = stageReconnect(this.ctx.storage.kv, {
          refreshToken: response.refreshToken, accessToken: response.accessToken,
          grantedScopes: response.grantedScopes, requestedResources: flow.requestedResources,
        }, { id: subject }, Date.now(), () => ({
          title: "That's a different Google account",
          detail: "This connection was made for another Google account than the one that just " +
            "authorized it. Sign in as that account and reconnect, or connect the other " +
            "account as a separate connection.",
        }));
        if ("refused" in staged) {
          // Another account's grant, which can never share an authorization with the live one.
          await this.#revokeRefreshToken(response.refreshToken);
          return { callback, mode: flow.mode, refused: staged.refused };
        }
        return { callback, mode: flow.mode, stageId: staged.stageId };
      }

      this.ctx.storage.kv.put<string>("refreshToken", response.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", response.accessToken);
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put<string[]>("grantedScopes", response.grantedScopes);
      mergeGrantedResources(this.ctx.storage.kv, flow.requestedResources);
      return { callback, mode: flow.mode, stageId: undefined, subject };
    });

    if (completion.refused !== undefined) return { refused: completion.refused };

    let callback = completion.callback;
    let handoff: ConnectHandoff;
    if (completion.stageId !== undefined) {
      handoff = await callback.reconnectComplete(completion.stageId);
    } else {
      let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
      // The pin brackets the handoff only: a connect that fails unpins, drops the credentials it
      // wrote ahead, and revokes the now-orphaned grant (best-effort) rather than leaving a live
      // token nothing will ever use.
      handoff = await pinForConnect(this.ctx.storage.kv,
        completion.subject === undefined ? undefined : { id: completion.subject },
        () => callback.complete(this.ctx.exports.GatekeeperUserImpl({ props })),
        async () => {
          const orphaned = this.ctx.storage.kv.get<string>("refreshToken");
          this.ctx.storage.kv.delete("refreshToken");
          if (orphaned) await this.#revokeRefreshToken(orphaned);
        });

      if (completion.mode === "auth") {
        this.ctx.storage.kv.put("deleteCredentialsOnAlarm", true);
        this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
      } else {
        this.ctx.storage.deleteAlarm();
      }
    }

    return { handoff };
  }

  /** Revokes a grant the connect flow refused or could not use; logged, never fatal to the flow. */
  async #revokeRefreshToken(refreshToken: string): Promise<void> {
    await revokeGoogleToken(refreshToken, AbortSignal.timeout(TOKEN_REVOKE_TIMEOUT_MS)).catch(err => {
      logger.warn("failed to revoke a Google grant", { event: "oauth.grant.revoke.failed", error: err });
    });
  }

  /**
   * Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. The kit keeps
   * the connection pinned to the account the grant was verified as: re-pinning the staged subject
   * adopts a connection made before the pin existed, and never moves an established one.
   */
  async commitReconnect(stageId: string): Promise<void> {
    await this.#credentials.run(async () => {
      let staged = commitReconnectOrThrow<StagedGoogleCredentials>(
          this.ctx.storage.kv, Date.now(), stageId);
      this.ctx.storage.kv.put<string>("refreshToken", staged.refreshToken);
      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", staged.accessToken);
      // These credentials are new, so any recorded permanent failure no longer applies
      this.#mintFailure = undefined;
      this.ctx.storage.kv.put<string[]>("grantedScopes", staged.grantedScopes);
      mergeGrantedResources(this.ctx.storage.kv, staged.requestedResources);
    });
  }

  /**
   * Whether the stored token still satisfies this request, i.e. can be served without minting.
   *
   * A `staleToken` request comes from a caller that just had a 401. It must not be answered from the
   * expiry check — the whole point is that Google rejected a token that had not yet expired. It is
   * satisfied only if the stored token is no longer the one that failed, which means another caller
   * already replaced it and this caller should take theirs.
   *
   * A `reloadStored` request needs no arm of its own: it asks only to bypass the caller's *own* memo,
   * and the stored token is exactly the answer it wants — which is what makes it mint nothing.
   */
  #tokenSatisfies(cached: GoogleAccessToken | undefined, opts?: AccessTokenRequest)
      : cached is GoogleAccessToken {
    if (!cached) return false;
    // Expiry gates every path — no request, however it is phrased, is answered with a token that is
    // already inside the safety window.
    if (cached.expires.valueOf() <= Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) return false;
    if (opts?.staleToken !== undefined) return cached.token !== opts.staleToken;
    return !opts?.forceRefresh;
  }

  async getAccessToken(opts?: AccessTokenRequest): Promise<GoogleAccessToken> {
    let { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) {
      throw new Error("The Google Gatekeeper is not configured.");
    }

    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      throw new Error("no refresh token set");
    }

    // Fast path, deliberately outside the lock: the overwhelmingly common case is a valid cached
    // token, and that must not serialize behind anything.
    let cached = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
    if (this.#tokenSatisfies(cached, opts)) {
      return cached;
    }

    // Serialized so a burst of concurrent 401s collapses into one token exchange. The re-check
    // inside the lock is what does the collapsing — the lock alone would just queue the mints.
    return this.#credentials.run(async () => {
      let fresh = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
      if (this.#tokenSatisfies(fresh, opts)) {
        return fresh;
      }

      // A mint already established that these credentials are permanently dead. Fail the same way
      // without asking Google again — see #mintFailure.
      if (this.#mintFailure && Date.now() - this.#mintFailure.at < MINT_FAILURE_COOLDOWN_MS) {
        throw this.#mintFailure.error;
      }

      // Re-read rather than closing over the outer value: the credentials may have been replaced
      // while this call waited for the lock.
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (!refreshToken) {
        throw new Error("no refresh token set");
      }

      // Logged before the exchange so a mint that fails or hangs still leaves a trace. The events
      // are distinct because their rates mean different things: `expiry` should tick about once per
      // token lifetime, whereas `rejected` means a token was invalidated early and the 401 retry
      // healed it — and a burst of 401s should still produce exactly one.
      logger.info("minting Google access token", {
        event: opts?.staleToken !== undefined
            ? "google.token.mint.rejected"
            : "google.token.mint.expiry",
      });

      // TODO: If new refresh token returned, use it.
      let result = await getAccessToken(refreshToken, clientId, clientSecret,
          AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS));
      if (!result.ok) {
        // Both are permanent, so both mark the connection dead. They differ in the remedy:
        // re-authenticating fixes a revoked grant but cannot grant a scope an admin has blocked.
        let error = new Error(
            result.reason === "policyBlocked"
                ? "A Google Workspace admin has restricted access this connection needs " +
                  `(${result.detail}). Ask your administrator to allow it — re-authenticating ` +
                  "will not help."
                : "Google credentials have expired or been revoked. Please re-authenticate.");
        // Recorded before notifying so only the first caller of a burst does either.
        this.#mintFailure = { error, at: Date.now() };
        this.#notifyCredentialsDead();
        throw error;
      }

      // Backstop for the credential mutators: the mutex already keeps them from interleaving with a
      // mint, so this should be unreachable. It stays because publishing a token minted against a
      // refresh token that is no longer current would resurrect a revoked account.
      if (this.ctx.storage.kv.get<string>("refreshToken") !== refreshToken) {
        logger.warn("discarded a Google access token minted against superseded credentials", {
          event: "google.token.mint.superseded",
        });
        let current = this.ctx.storage.kv.get<GoogleAccessToken>("accessToken");
        if (current) return current;
        throw new Error("Google credentials changed while refreshing. Please try again.");
      }

      this.ctx.storage.kv.put<GoogleAccessToken>("accessToken", result.token);
      return result.token;
    });
  }

  // Tell the workshop the credentials are permanently dead so the UI prompts a reconnect instead of
  // every call failing opaquely. Fire and forget — a notification failure must not mask the error.
  #notifyCredentialsDead(): void {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    callback?.credentialsExpired().catch(notifyErr => {
      logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed", error: notifyErr,
      });
    });
  }

  async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#credentials.run(async () => {
      if (shouldDeleteCredentialsOnAlarm(this.ctx.storage.kv)) {
        await this.#forgetHooks();
        this.ctx.storage.deleteAll();
      }
    });
  }

  async revoke(): Promise<void> {
    await this.#credentials.run(async () => {
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (refreshToken) {
        await revokeGoogleToken(refreshToken, AbortSignal.timeout(TOKEN_REVOKE_TIMEOUT_MS));
      }
      await this.#forgetHooks();
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }

  /**
   * Note that `driver` holds hooks of this account, so that disconnecting it reaches them; false,
   * noting nothing, once the account is disconnected, when no hook of it may be registered.
   */
  async trackHookDriver(driver: HookDriverRef): Promise<boolean> {
    // Serialized with disconnecting, so that a driver is either noted before the account's drivers
    // are told to drop its hooks, or refused once its credentials are gone.
    return await this.#credentials.run(async () => {
      if (!this.ctx.storage.kv.get<string>("refreshToken")) return false;
      this.ctx.storage.kv.put(`hookDriver:${driver.kind}:${driver.name}`, driver);
      return true;
    });
  }

  /**
   * Have every driver holding this account's hooks drop them. Their records are about to go with
   * the credentials, and a driver would otherwise go on reading and renewing for them, failing
   * every time. Best effort: a driver that can't be reached is logged rather than block the
   * disconnect, and drops them itself within a day, when it next asks whether the account knows of
   * it (see trackHookDriver()).
   */
  async #forgetHooks(): Promise<void> {
    const userObjectId = this.ctx.id.toString();
    const results = await Promise.allSettled(
      [...this.ctx.storage.kv.list<HookDriverRef>({ prefix: "hookDriver:" })].map(([, { kind, name }]) =>
        (kind === "gmail" ? this.ctx.exports.GmailHookDriver : this.ctx.exports.ChatHookDriver)
          .getByName(name).forgetAccount(userObjectId)));
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("failed to drop a disconnected account's hooks", {
          event: "hooks.account.forget.failed", error: result.reason,
        });
      }
    }
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let tokenPromise = obj.getAccessToken();
    let grantedResourcesPromise = obj.getGrantedResourceUrlPatterns();
    let token = await tokenPromise;
    let description = await getGoogleAccountDescription(token.token);

    // A private grant is the gatekeeper's own business, never a resource the Workshop can bind.
    description.grantedResourceUrlPatterns =
      (await grantedResourcesPromise).filter(pattern => !isPrivateGrant(pattern));
    return description;
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Contract is Promise<string | null>: never throw. The access token fetch can throw if the
    // (possibly transient sign-in) grant has been cleaned up, and the userinfo call can throw on a
    // non-2xx response — treat any failure as "no email available".
    try {
      let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      let obj = this.ctx.exports.UserAccount.get(id);
      let token = await obj.getAccessToken();
      if (!token) return null;
      return await getGoogleVerifiedEmail(token.token);
    } catch {
      return null;
    }
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let target = parseResourceUrl(url);
    let resource = RESOURCE_BY_KIND[target.kind];
    let userObjectId = this.ctx.props.userObjectId;

    switch (target.kind) {
      case "gmail": {
        let props: GmailGatekeeperImplProps = {
          userObjectId, searchQuery: target.searchQuery, labelName: target.labelName,
        };
        return {class: this.ctx.exports.GmailGatekeeperImpl({props}), resource};
      }
      case "doc": {
        let props: GoogleDocGatekeeperImplProps = {userObjectId, documentId: target.documentId};
        return {class: this.ctx.exports.GoogleDocGatekeeperImpl({props}), resource};
      }
      case "sheets": {
        let props: GoogleSheetsGatekeeperImplProps = {
          userObjectId, spreadsheetId: target.spreadsheetId,
        };
        return {class: this.ctx.exports.GoogleSheetsGatekeeperImpl({props}), resource};
      }
      case "slides": {
        let props: GoogleSlidesGatekeeperImplProps = {
          userObjectId, presentationId: target.presentationId,
        };
        return {class: this.ctx.exports.GoogleSlidesGatekeeperImpl({props}), resource};
      }
      case "calendar": {
        let props: GoogleCalendarGatekeeperImplProps = {
          userObjectId, calendarId: target.calendarId, availabilityMode: target.availabilityMode,
        };
        return {class: this.ctx.exports.GoogleCalendarGatekeeperImpl({props}), resource};
      }
      case "bigquery": {
        let props: BigQueryGatekeeperImplProps = {
          userObjectId,
          scopedProjectId: target.projectId,
          scopedDatasetId: target.datasetId,
          scopedTableId: target.tableId,
        };
        return {class: this.ctx.exports.BigQueryGatekeeperImpl({props}), resource};
      }
      case "chatAccount":
      case "chatSpace":
      case "chatThread": {
        let props: GoogleChatGatekeeperImplProps = {
          userObjectId,
          ...(target.kind !== "chatAccount" ? { spaceId: target.spaceId } : {}),
          ...(target.kind === "chatThread" ? { threadId: target.threadId } : {}),
        };
        return { class: this.ctx.exports.GoogleChatGatekeeperImpl({ props }), resource };
      }
      case "driveAccount":
      case "driveFolder":
      case "driveFile": {
        let scope: DriveBindingScope;
        switch (target.kind) {
          case "driveAccount": scope = { kind: "account" }; break;
          case "driveFolder": scope = { kind: "folder", folderId: target.folderId }; break;
          default: scope = { kind: "file", fileId: target.fileId };
        }
        let props: GoogleDriveGatekeeperImplProps = { userObjectId, scope };
        return { class: this.ctx.exports.GoogleDriveGatekeeperImpl({ props }), resource };
      }
    }
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let account = this.ctx.exports.UserAccount.get(id);
    let getToken = async (opts?: AccessTokenRequest) => await account.getAccessToken(opts);
    // A private grant is read on every call, since it arrives through a pop-up while the dialog is
    // open.
    let holds = (grant: string) => async () =>
      (await account.getGrantedResourceUrlPatterns()).includes(grant);
    let officeConversion = (kind: OfficeKind) => new OfficeConversion(
      kind, async opts => (await getToken(opts)).token, holds(OFFICE_IMPORT_GRANT));

    if (resourceUrlPattern === BIGQUERY_RESOURCE.urlPattern) {
      return {
        iframeHtml: BIGQUERY_CONFIGURATOR_HTML,
        ui: new RpcStub(new BigQueryConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GMAIL_RESOURCE.urlPattern) {
      return {
        iframeHtml: GMAIL_CONFIGURATOR_HTML,
        ui: new RpcStub(new GmailConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_CALENDAR_RESOURCE.urlPattern) {
      return {
        iframeHtml: CALENDAR_CONFIGURATOR_HTML,
        ui: new RpcStub(new CalendarConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_DOC_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_DOC_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleDocConfiguratorUI(getToken, officeConversion("doc"))),
      };
    }

    if (resourceUrlPattern === GOOGLE_SHEETS_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_SHEETS_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleSheetsConfiguratorUI(getToken, officeConversion("sheets"))),
      };
    }

    if (resourceUrlPattern === GOOGLE_SLIDES_RESOURCE.urlPattern) {
      return {
        iframeHtml: GOOGLE_SLIDES_CONFIGURATOR_HTML,
        ui: new RpcStub(new GoogleSlidesConfiguratorUI(getToken, officeConversion("slides"))),
      };
    }

    if (resourceUrlPattern === GOOGLE_CHAT_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatAccountConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === GOOGLE_CHAT_SPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_SPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatSpaceConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === GOOGLE_CHAT_THREAD_RESOURCE.urlPattern) {
      return {
        iframeHtml: CHAT_THREAD_CONFIGURATOR_HTML,
        ui: new RpcStub(new ChatThreadConfiguratorUI()),
      };
    }

    // One picker for the whole account and every type grouped with it: a folder or a file.
    let groupedWith = SUPPORTED_RESOURCES
      .find(resource => resource.urlPattern === resourceUrlPattern)?.groupedWith;
    if (resourceUrlPattern === GOOGLE_DRIVE_RESOURCE.urlPattern ||
        groupedWith === GOOGLE_DRIVE_RESOURCE.urlPattern) {
      return {
        iframeHtml: DRIVE_CONFIGURATOR_HTML,
        ui: new RpcStub(new DriveConfiguratorUI(getToken, holds(SHARED_DRIVES_GRANT))),
      };
    }

    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    await obj.revoke();
  }

  async reconnect(): Promise<{url: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let initiationNonce = generateNonce();
    let requestable = await obj.getRequestableResourceUrlPatterns();
    await obj.prepareReconnect(initiationNonce, requestable);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).commitReconnect(stageId);
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let obj = this.ctx.exports.UserAccount.get(id);
    let granted = new Set(await obj.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) {
      return {};
    }

    // Union the recorded intent, not the covered subset: a resource whose scope requirements grew
    // is missing from `granted`, and asking only for what this call requested would drop it.
    let requestable = await obj.getRequestableResourceUrlPatterns();
    let unionPatterns = [...new Set([...requestable, ...resourceUrlPatterns])];
    let initiationNonce = generateNonce();
    await obj.prepareReconnect(initiationNonce, unionPatterns);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account, used by the Google gatekeepers' addObserver to confirm
   * a prospective observer may read a bound resource. The verifier carries this user's own account
   * id, so the access checks run against the observer's *own* Google token. (The Gmail gatekeeper
   * uses strategy A — it never consults the verifier — but getVerifier must still exist because the
   * overseer mints one on every open.)
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: GoogleVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GoogleVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Google spans several strategies (see each gatekeeper's observer methods):
//   - Gmail Mailbox — strategy A (private-only): addObserver always throws, so the verifier is never
//     consulted (but must exist).
//   - Google Doc — strategy B (ACL check, single unit): hasDocAccess answers whether the observer's
//     own token can open the bound document (Docs API returns 401/403/404 otherwise).
//   - Google Sheets — strategy B (ACL check, single unit): hasSpreadsheetAccess answers whether the
//     observer's own token can open the bound spreadsheet.
//   - Google Slides — strategy B (ACL check, single unit): hasPresentationAccess answers whether the
//     observer's own token can open the bound presentation.
//   - Google Calendar — strategies B/C: hasCalendarWriterAccess covers the bound calendar, while
//     hasCalendarFreeBusyAccess covers foreign calendars read by an all-visible availability query.
//   - BigQuery — strategy C (data-set tracking by dataset): hasDatasetAccess answers whether the
//     observer's own token has IAM access to a dataset (BigQuery returns 401/403/404 otherwise).
//   - Google Chat — strategies A/B: an account binding refuses observers; a conversation or thread
//     binding checks that the observer can open its conversation.
// The overseer only ever hands this verifier back to a Google gatekeeper, which may therefore trust
// the boolean results. Creation uses it too: getUserObjectId names the account a user approved a
// pending creation into, and applyCreation() creates the file through that account.

type GoogleVerifierProps = {
  userObjectId: string;
};

// Extract the HTTP status from the ad-hoc Error messages thrown by the Google API helpers
// (which embed it as `: <status> ` or `[http=<status>]`). Returns undefined if not found.
function httpStatusFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  let m = error.message.match(/\[http=(\d{3})\]/) ?? error.message.match(/:\s(\d{3})(?:\s|$)/);
  return m ? Number(m[1]) : undefined;
}

// True if an error means "the observer's token cannot access this resource" (as opposed to a
// transient failure, which is rethrown so the open fails loudly rather than silently denying).
function isNoAccessStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * The non-standard methods the Google gatekeepers call on their own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 *
 * Declared in its own module so that a gatekeeper living outside this file (Chat) can name it
 * without importing the module that implements it; re-exported here because this is where callers
 * have always found it.
 */
export type { GoogleVerifierApi } from "./google-verifier-types";

@validateRpc()
export class GoogleVerifier extends WorkerEntrypoint<Env, GoogleVerifierProps>
    implements GoogleVerifierApi {
  async #getToken(opts?: AccessTokenRequest): Promise<string> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return (await account.getAccessToken(opts)).token;
  }

  async hasDocAccess(documentId: string): Promise<boolean> {
    let api = new GoogleDocsApi(opts => this.#getToken(opts));
    try {
      await api.getDocumentMetadata(documentId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasSpreadsheetAccess(spreadsheetId: string): Promise<boolean> {
    let api = new GoogleSheetsApi(opts => this.#getToken(opts));
    try {
      await api.getSpreadsheet(spreadsheetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasPresentationAccess(presentationId: string): Promise<boolean> {
    let api = new GoogleSlidesApi(opts => this.#getToken(opts));
    try {
      await api.getPresentationTitle(presentationId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  /**
   * Observers need the roles that see private event details, not merely write access; see
   * `hasCalendarPrivateAccessRole` and the observer notes on GoogleCalendarGatekeeperImpl.
   */
  async hasCalendarWriterAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      return hasCalendarPrivateAccessRole(await api.getCalendar(calendarId));
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasCalendarFreeBusyAccess(calendarId: string): Promise<boolean> {
    let api = new GoogleCalendarApi(opts => this.#getToken(opts));
    try {
      return await api.hasFreeBusyAccess(calendarId);
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasDatasetAccess(projectId: string, datasetId: string): Promise<boolean> {
    let api = new BigQueryApi(opts => this.#getToken(opts));
    try {
      await api.getDataset(projectId, datasetId);
      return true;
    } catch (error) {
      if (isNoAccessStatus(httpStatusFromError(error))) return false;
      throw error;
    }
  }

  async hasChatSpaceAccess(spaceName: string, options: { members?: boolean } = {}): Promise<boolean> {
    let api = new ChatApi(opts => this.#getToken(opts));
    try {
      await api.getSpace(spaceName);
      if (options.members) await api.listMembers(spaceName, { pageSize: 1 });
      return true;
    } catch (error) {
      // Chat answers a space the observer is not a member of with 403 or 404, which
      // isChatNoAccessError recognizes; anything else is transient and must fail the open loudly.
      if (isChatNoAccessError(error)) return false;
      throw error;
    }
  }

  async verifyDriveObservations(
    observations: DriveObservation[],
  ): Promise<ObserverBatchResult> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    let granted = await account.getGrantedResourceUrlPatterns();
    let baselineAllowed = hasDriveResourceGrant(granted);
    if (!baselineAllowed) return { baselineAllowed, allowed: observations.map(() => false) };

    let api = new DriveApi(opts => this.#getToken(opts));
    return {
      baselineAllowed,
      allowed: await api.checkObservations(observations),
    };
  }

  async getUserObjectId(): Promise<string> {
    return this.ctx.props.userObjectId;
  }
}
