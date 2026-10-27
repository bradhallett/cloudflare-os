import {
  DurableObject,
  RpcStub,
  WorkerEntrypoint,
} from "cloudflare:workers";
import {
  validateRpc,
  skipRpcValidation,
} from "capnweb-validate";
import {
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
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import {
  commitReconnectOrThrow,
  pinForConnect,
  stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import {
  type CallbackResult,
  fetchSubject,
  type PinnedSubject,
  pinRefusal,
} from "./connect-subject";
import {
  clearCredentialExpiryLatch,
  notifyCredentialsExpiredOnce,
} from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  SpotifyApi,
  SpotifyApiError,
  exchangeAuthCode,
  refreshAccessToken,
} from "./spotify-api";
import TYPES_CODE from "./types.txt";
import SPOTIFY_LOGO_SVG from "./spotify-logo.svg";
import SPOTIFY_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import SPOTIFY_PLAYLIST_CONFIGURATOR_HTML from "./generated/playlist-configurator-ui.txt";

import { type Env, ensureConfigured, getBasePath, getBaseUrl, type SpotifyGatekeeperImplProps } from "./spotify-env";
import { parsePlaylistId } from "./spotify-normalize";
import { SpotifyAccountConfiguratorUI, SpotifyPlaylistConfiguratorUI } from "./spotify-configurators";

// Re-exported so the worker's main module still exposes every Durable Object class wrangler binds.
export { SpotifyGatekeeperImpl } from "./spotify-gatekeeper";

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

/**
 * The live credential keys a grant is written to, held as one unit while a reconnect awaits
 * confirmation (see UserAccount.commitReconnect).
 */
type StoredCredentials = {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  scopes: string[];
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

// Scopes requested during connect — broad enough to cover both resource granularities.
const OAUTH_SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played",
  "user-follow-read",
  "user-follow-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
];

const SPOTIFY_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(SPOTIFY_LOGO_SVG)}`;

const ACCOUNT_RESOURCE: SupportedResource = {
  // Whole-instance catch-all (matches any URL), like other single-tenant gatekeepers.
  urlPattern: "https://*",
  title: "Spotify Account",
  description:
    "Whole-account access: profile, catalog search, your library, your playlists, and playback control.",
  icon: { url: SPOTIFY_LOGO_URL },
};

const PLAYLIST_RESOURCE: SupportedResource = {
  urlPattern: "https://open.spotify.com/playlist/:playlistId",
  title: "Spotify Playlist",
  description: "Read and edit a single Spotify playlist.",
  icon: { url: SPOTIFY_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE, PLAYLIST_RESOURCE];

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1DB954; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #1DB954; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #1DB954; font-size: 1.5rem; margin: 0 0 1rem 0;">Spotify Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a Spotify OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

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
  // The early length-mismatch return isn't a timing leak here: both values are fixed-length random
  // hex nonces, so length carries no secret. timingSafeEqual also requires equal-length inputs.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth flow.

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

      const redirectUrl = new URL("https://accounts.spotify.com/authorize");
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", begun.scopes.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("Spotify authorization failed or was denied. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
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
      if (!result) {
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
      displayName: "Spotify",
      url: "https://www.spotify.com",
      logo: { url: SPOTIFY_LOGO_URL },
      color: "#1DB954",
      tagline: "Manage playlists, your library, and playback",
      description:
        "Connect your Spotify account so Cloudflare OS can search the catalog, read and edit your " +
        "library and playlists, and control playback on your devices. Grant whole-account access " +
        "or scope a Gadget to a single playlist.",
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
// UserAccount DO — stores OAuth credentials and refreshes access tokens.

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

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    return { oauthNonce, scopes: OAUTH_SCOPES };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on,
   * null when the callback's nonce doesn't match, or a refusal when the grant came back as a
   * different Spotify account than the connection is pinned to.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, `${getBaseUrl(this.env)}/oauth`);
    if (!grant.refreshToken) {
      throw new Error("Spotify did not return a refresh token.");
    }

    const credentials: StoredCredentials = {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
      scopes: grant.scopes,
    };

    let subject: PinnedSubject;
    try {
      subject = await fetchSubject(credentials.accessToken);
    } catch (error) {
      throw new Error("Could not read which Spotify account authorized this connection. Please try again.",
        { cause: error });
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The connection is pinned to the Spotify user it was made as: a reconnect that comes back
      // as anyone else is refused (Spotify has no token-revocation endpoint, so the refused grant
      // is simply dropped) rather than silently swapping the account every binding reads.
      const staged = stageReconnect(this.ctx.storage.kv, credentials, subject, Date.now(), pinRefusal);
      if ("refused" in staged) return { refused: staged.refused };
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      handoff = await callback.reconnectComplete(staged.stageId);
    } else {
      this.#storeCredentials(credentials);
      const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
      // The pin brackets the handoff: a connect that fails unpins and drops the credentials
      // stored ahead of it.
      handoff = await pinForConnect(this.ctx.storage.kv, subject,
        () => callback.complete(this.ctx.exports.GatekeeperUserImpl({ props })),
        () => {
          this.ctx.storage.kv.delete("refreshToken");
          this.ctx.storage.kv.delete("accessToken");
        });
    }

    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. The kit
   * re-pins the staged subject, adopting a connection made before the pin existed. */
  async commitReconnect(stageId: string): Promise<void> {
    const credentials = commitReconnectOrThrow<StoredCredentials>(
      this.ctx.storage.kv, Date.now(), stageId);
    this.#storeCredentials(credentials);
  }

  #storeCredentials(credentials: StoredCredentials): void {
    this.ctx.storage.kv.put("refreshToken", credentials.refreshToken);
    this.ctx.storage.kv.put("accessToken", credentials.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", credentials.accessTokenExpiresAt);
    this.ctx.storage.kv.put("scopes", credentials.scopes);
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
      throw new Error("Spotify credentials have not been configured for this account.");
    }
    ensureConfigured(this.env);

    let grant;
    try {
      grant = await refreshAccessToken(refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    } catch (err) {
      if (err instanceof SpotifyApiError && (err.isAuthError || err.status === 400)) {
        await this.noteCredentialsExpired();
      }
      throw err;
    }

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("scopes", grant.scopes);
    return grant.accessToken;
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "spotify");
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Spotify exposes no token-revocation endpoint; drop the local credentials. The user can
    // revoke the app's access from their Spotify account settings.
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

  async #withApi<T>(fn: (api: SpotifyApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new SpotifyApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Spotify credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const user = await api.getCurrentUser();
      return {
        displayName: user.display_name ?? user.id,
        uniqueName: user.id,
        avatar: { url: user.images?.[0]?.url ?? "" },
      };
    });
  }

  /** Spotify is not offered as a sign-in identity provider (no verified-email flag exposed). */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const playlistId = parsePlaylistId(url);
    if (playlistId) {
      const props: SpotifyGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "playlist",
        playlistId,
      };
      return { class: this.ctx.exports.SpotifyGatekeeperImpl({ props }), resource: PLAYLIST_RESOURCE };
    }

    // Any other URL is whole-account access against the connected account.
    const props: SpotifyGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      resourceKind: "account",
    };
    return { class: this.ctx.exports.SpotifyGatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const getToken = async () => await this.#userAccount().getAccessToken();

    if (resourceUrlPattern === ACCOUNT_RESOURCE.urlPattern) {
      return {
        iframeHtml: SPOTIFY_ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new SpotifyAccountConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === PLAYLIST_RESOURCE.urlPattern) {
      return {
        iframeHtml: SPOTIFY_PLAYLIST_CONFIGURATOR_HTML,
        ui: new RpcStub(new SpotifyPlaylistConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Spotify resource configurator type: ${resourceUrlPattern}`);
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
   * Mint a verifier representing this account. Spotify uses the "low-stakes" observer strategy (see
   * SpotifyGatekeeperImpl.addObserver): a personal Spotify account is not the kind of restricted
   * corporate data the information-flow model is designed to protect, so any collaborator may
   * observe. The verifier therefore carries no identity and is never consulted — but the overseer
   * mints one on every open, so it must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SpotifyVerifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// A trivial verifier since Spotify's observer strategy is low-stakes.
@validateRpc()
export class SpotifyVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

