import {
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
  fetchSubject,
  type PinnedSubject,
  pinRefusal,
} from "./connect-subject";
import {
  OAuthAccountDO,
  type OAuthAttempt,
} from "@gadgets/gatekeeper-kit/oauth-account";
import {
  type CredentialCoordinatorOptions,
  CredentialsExpiredError,
} from "@gadgets/gatekeeper-kit/credentials";
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
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;

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

export class UserAccount extends OAuthAccountDO<Env, StoredCredentials, PinnedSubject> {
  protected vendorId(): string {
    return "spotify";
  }

  protected requestedScopes(): string[] {
    return OAUTH_SCOPES;
  }

  protected userFacet(): Fetcher<GatekeeperUser> {
    const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  protected redirectUri(): string {
    return `${getBaseUrl(this.env)}/oauth`;
  }

  protected async exchange(code: string, attempt: OAuthAttempt): Promise<StoredCredentials> {
    ensureConfigured(this.env);
    const grant = await exchangeAuthCode(
      code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, attempt.redirectUri ?? this.redirectUri());
    if (!grant.refreshToken) {
      throw new Error("Spotify did not return a refresh token.");
    }
    return {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
      scopes: grant.scopes,
    };
  }

  protected subjectOf(creds: StoredCredentials): Promise<PinnedSubject | undefined> {
    return fetchSubject(creds.accessToken);
  }

  protected async refreshCredentials(current: StoredCredentials): Promise<StoredCredentials> {
    ensureConfigured(this.env);
    let grant;
    try {
      grant = await refreshAccessToken(current.refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    } catch (error) {
      // A 400 from the token endpoint is how Spotify reports a dead grant (invalid_grant), and an
      // auth-flagged error says the same; only those are a proven death, so only they expire the
      // connection. Anything else is transient and the caller retries.
      if (error instanceof SpotifyApiError && (error.isAuthError || error.status === 400)) {
        throw new CredentialsExpiredError("The Spotify grant is dead.", { cause: error });
      }
      throw error;
    }
    return {
      refreshToken: grant.refreshToken ?? current.refreshToken,
      accessToken: grant.accessToken,
      accessTokenExpiresAt: Date.now() + grant.expiresIn * 1000,
      scopes: grant.scopes.length > 0 ? grant.scopes : current.scopes,
    };
  }

  protected reconnectRefusal(pinned: PinnedSubject, granted: PinnedSubject): { title: string; detail: string } {
    return pinRefusal(pinned, granted);
  }

  protected expiresAt(creds: StoredCredentials): number | undefined {
    return creds.accessTokenExpiresAt;
  }

  protected refreshSkewMs(): number | undefined {
    return ACCESS_TOKEN_SAFETY_MS;
  }

  protected credentialsExpiredMessage(): string {
    return "Spotify credentials have expired or been revoked. Please reconnect the account.";
  }

  protected credentialOptions(): CredentialCoordinatorOptions<StoredCredentials> {
    return {
      ...super.credentialOptions(),
      // Accounts connected before the kit base stored one key per field; the coordinator migrates
      // such an account on first read and reaps the old keys once the canonical record lands.
      legacyKeys: ["refreshToken", "accessToken", "accessTokenExpiresAt", "scopes"],
      upgrade: kv => {
        const refreshToken = kv.get<string>("refreshToken");
        if (refreshToken === undefined) return undefined;
        return {
          refreshToken,
          accessToken: kv.get<string>("accessToken") ?? "",
          accessTokenExpiresAt: kv.get<number>("accessTokenExpiresAt") ?? 0,
          scopes: kv.get<string[]>("scopes") ?? [],
        };
      },
    };
  }

  /**
   * @returns The current access token, refreshed when it is within the safety window of expiry.
   * @throws `CredentialsExpiredError` when the account is disconnected or its grant is dead, after
   * notifying the Workshop of a death.
   */
  async getAccessToken(): Promise<string> {
    const { creds } = await this.getCredentials();
    return creds.accessToken;
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
        await account.notifyCredentialsExpired();
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

