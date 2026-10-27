import {
  DurableObject,
  RpcStub,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
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
import { connectHandoffPageHtml, errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  clearCredentialExpiryLatch, notifyCredentialsExpiredOnce,
} from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  commitReconnectOrThrow,
  type ConnectionSubject,
  pinForConnect,
  stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { CredentialCoordinator, type RejectionVerdict } from "@gadgets/gatekeeper-kit/credentials";
import {
  CREDENTIALS_EXPIRED_MESSAGE,
  GitHubApi,
  GitHubApiError,
  exchangeAuthCode,
  refreshGitHubGrant,
  revokeOAuthToken,
  withAccountApi,
  type GitHubOAuthGrant,
} from "./github-api";
import {
  getBasePath,
  getBaseUrl,
  type Env,
  type GitHubGatekeeperImplProps,
} from "./github-env";
import { handleWebhookRequest } from "./github-hooks";
import GITHUB_LOGO_SVG from "./github-logo.svg";
import TYPES_CODE from "./types.txt";
import {
  GitHubIssueConfiguratorUI,
  GitHubPullRequestConfiguratorUI,
  GitHubRepoConfiguratorUI,
  type GitHubApiRunner,
} from "./github-configurators";
import GITHUB_ISSUE_CONFIGURATOR_HTML from "./generated/github-issue-configurator-ui.txt";
import GITHUB_PULL_REQUEST_CONFIGURATOR_HTML from "./generated/github-pull-request-configurator-ui.txt";
import GITHUB_REPO_CONFIGURATOR_HTML from "./generated/github-repo-configurator-ui.txt";
import { obsContext } from "./observability.js";

export { GitHubHookController, GitHubHookDriver } from "./github-hooks";
// Re-exported for the workerd wiring tests, which import the session classes from the package
// entrypoint and instantiate them directly against fake gatekeepers.
export { GitHubIssueImpl, GitHubPullRequestImpl, GitHubRepoSessionImpl } from "./github-sessions";
export { GitHubGatekeeperImpl } from "./github-gatekeeper";

const VENDOR_ID = "github";

const logger = obsContext.createLogger({
  component: "gatekeeper.github", vendorId: VENDOR_ID,
});

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

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const GITHUB_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GITHUB_LOGO_SVG)}`;

// `user:email` lets us read the account's primary verified email for sign-in (getAuthenticatedEmail).
const OAUTH_SCOPES = ["repo", "read:user", "user:email"];

// Minimal scopes for sign-in only (verify the user's email). Used when connecting in "auth" mode;
// the resulting grant is transient.
const AUTH_SCOPES = ["read:user", "user:email"];

const REPO_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo",
  title: "GitHub Repository",
  description: "Read and manage issues, pull requests, reviews, and discussions in a GitHub repository.",
};

const ISSUE_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/issues/:number",
  title: "GitHub Issue",
  description: "Read and manage a specific GitHub issue.",
};

const PULL_REQUEST_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/pull/:number",
  title: "GitHub Pull Request",
  description: "Read and manage a specific GitHub pull request and its review threads.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  REPO_RESOURCE,
  ISSUE_RESOURCE,
  PULL_REQUEST_RESOURCE,
];

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
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">GitHub Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a GitHub OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

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
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function ensureConfigured(env: Env): void {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The GitHub gatekeeper is not configured.");
  }
}


export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0] === "webhook" && req.method === "POST") {
      return handleWebhookRequest(req, path[1], env, ctx.exports);
    }

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const redirectUrl = new URL("https://github.com/login/oauth/authorize");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", begun.scopes.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);

      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("GitHub authorization failed. Please restart the connection flow from Cloudflare OS.", {
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
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if ("refused" in result) {
        return htmlResponse(errorPageHtml(result.refused.title, result.refused.detail), 409);
      }
      return htmlResponse(connectHandoffPageHtml(result.handoff));
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "GitHub",
      url: "https://github.com",
      logo: { url: GITHUB_LOGO_URL },
      color: "#f0f0f0",
      tagline: "Triage issues, review PRs, and manage repos",
      description:
          "Connect your GitHub account so Cloudflare OS can read and update issues, pull requests, " +
          "and reviews on the repositories you choose.",
      providesAuth: true,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly ? AUTH_SCOPES : OAUTH_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

/**
 * Stands in for the identity of a token the account no longer serves, so the coordinator's
 * moved-past gate adjudicates it. Never equal to a real identity, which is a hex nonce.
 */
const REPLACED_TOKEN_IDENTITY = "replaced-token";

/** The GitHub user a connection's subject is: `id` is the stable identity; a login can be renamed. */
type ViewerSubject = ConnectionSubject & { login: string };

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

export class UserAccount extends DurableObject<Env> {
  readonly #creds = new CredentialCoordinator<GitHubOAuthGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    // The layout before expiring grants were supported, which only ever held non-expiring ones.
    legacyKeys: ["accessToken", "scopes"],
    upgrade: kv => {
      const accessToken = kv.get<string>("accessToken");
      if (!accessToken) return undefined;
      // That layout latched its expiry notice before delivering it, so a failed delivery left a
      // dead account showing as connected. Re-arm the latch as the grant migrates: at worst the
      // Workshop hears of one death twice.
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      return { accessToken, scopes: kv.get<string[]>("scopes") ?? [] };
    },
    // GitHub revokes one token at a time (see revokeOAuthToken), so dropping a refresh that a
    // reconnect or revoke overtook cannot touch the grant that won.
    discardMint: grant => this.#revokeToken(grant.accessToken),
    vendorId: VENDOR_ID,
  });

  /** How the coordinator refreshes a grant and announces its death to the Workshop. */
  readonly #recovery = {
    refresh: async (grant: GitHubOAuthGrant): Promise<GitHubOAuthGrant> => {
      const { CLIENT_ID, CLIENT_SECRET } = this.env;
      if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("GitHub OAuth is not configured.");
      return await refreshGitHubGrant(CLIENT_ID, CLIENT_SECRET, CREDENTIALS_EXPIRED_MESSAGE)(grant);
    },
    notify: () => notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID),
  };

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes?: string[], ephemeral?: boolean): Promise<void> {
    if (!this.#creds.stored()) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    // Scopes to request in the authorize URL (auth-only for sign-in, or the full set).
    if (requestedScopes) this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      reconnect: true,
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      reconnect: stored.reconnect,
    });
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes };
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, a
   * refusal to show there instead, or null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    ensureConfigured(this.env);
    const clientId = this.env.CLIENT_ID;
    const clientSecret = this.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("GitHub OAuth is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(code, clientId, clientSecret, `${getBaseUrl(this.env)}/oauth`);

    // The connection is pinned to the GitHub user it was made as: the viewer is read now, from the
    // new grant itself, so a reconnect as anyone else is refused before anything is staged.
    let viewer: ViewerSubject;
    try {
      const { user } = await new GitHubApi(async () => grant.accessToken).getViewer();
      if (!Number.isFinite(user.id) || !user.login) {
        throw new Error("GitHub did not say which account authorized this connection.");
      }
      viewer = { id: String(user.id), login: user.login };
    } catch (error) {
      if (!stored.reconnect) await this.#revokeToken(grant.accessToken);
      throw new Error("Could not read which GitHub account authorized this connection. Please try again.",
        { cause: error });
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      const staged = stageReconnect(this.ctx.storage.kv, grant, viewer, Date.now(),
        (pinned, authorized) => ({
          title: "That's a different GitHub account",
          // Another user's grant, which can never share an authorization with the live one; the
          // revoked token is the connector's to dispose below.
          detail: `This connection is for @${pinned.login}, but GitHub authorized @${authorized.login}. ` +
            `Sign in to GitHub as @${pinned.login} and reconnect, or connect @${authorized.login} as a ` +
            "separate account.",
        }));
      if ("refused" in staged) {
        await this.#revokeToken(grant.accessToken);
        return staged;
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile. The stage id ties the Workshop's ticket to
      // this grant, so an overlapping reconnect cannot be committed by it.
      handoff = await callback.reconnectComplete(staged.stageId);
    } else {
      this.#creds.connect(grant);
      // The pin lives only as long as the handoff: a connect that fails unpins again and drops
      // the credentials stored ahead of it.
      handoff = await pinForConnect(this.ctx.storage.kv, viewer,
        () => {
          const props = { userObjectId: this.ctx.id.toString() };
          return callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
        },
        () => { this.#creds.clear(); });
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct. Only the local copy is dropped, with no provider revoke
      // call: the token grants nothing worth revoking, and this is the sign-in path.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        await this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
        return { handoff };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /**
   * Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. The kit's
   * commit is fenced on the connection's pinned subject and re-pins the staged viewer, so a
   * connection made before the pin existed adopts its first reconnect's user, and a same-user
   * rename is followed.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitReconnectOrThrow<GitHubOAuthGrant>(this.ctx.storage.kv, Date.now(), stageId);
    this.#creds.connect(grant);
    // The same user, perhaps renamed, whose own comments and reviews are then the ones its hooks
    // skip (a reconnect as anyone else is refused above). Should this be lost, the driver's hourly
    // check reads it too.
    await this.ctx.exports.GitHubHookDriver.getByName(this.ctx.id.toString()).reconnected()
      .catch((error: unknown) => {
        logger.warn("failed to tell the hook driver of a reconnect", { event: "hooks.account.reconnect.failed", error });
      });
  }


  /**
   * @returns The current access token, refreshing an expiring grant shortly before it expires.
   * @throws `CredentialsExpiredError` when the account is disconnected or its grant is dead, after
   * notifying the Workshop of a death.
   */
  async getAccessToken(): Promise<string> {
    const { creds } = await this.#creds.snapshot(this.#recovery.refresh, this.#recovery);
    return creds.accessToken;
  }

  getScopes(): string[] {
    return this.#creds.stored()?.scopes ?? [];
  }

  /**
   * Adjudicates GitHub's rejection of `accessToken`, notifying the Workshop when the grant is
   * dead. Using a refresh token makes GitHub reject the access token it replaced, so a request
   * that presented a token this account has since replaced -- by a refresh or a reconnect -- failed
   * stale. A rejection of the current token refreshes past it where the grant can.
   */
  async reportTokenRejected(accessToken: string): Promise<RejectionVerdict> {
    const identity = this.#creds.stored()?.accessToken === accessToken
      ? this.#creds.identity()
      : REPLACED_TOKEN_IDENTITY;
    return await this.#creds.adjudicateRejection(identity, this.#recovery);
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.#creds.stored() || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const grant = this.#creds.stored();
    // Fence before the first await: a refresh landing later is then discarded and its tokens
    // revoked (see discardMint), rather than stored after this capture and deleted unrevoked.
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (grant) await this.#revokeToken(grant.accessToken);
  }

  async #revokeToken(accessToken: string): Promise<void> {
    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) return;
    try {
      await revokeOAuthToken(accessToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    } catch (error) {
      logger.error("failed to revoke GitHub OAuth token", {
        event: "oauth.token.revoke.failed", error,
      });
    }
  }
}

/** Runs replay-safe GitHub reads as the account behind `userObjectId`; see withAccountApi. */
function accountReader(
  exports: Cloudflare.Exports, userObjectId: string,
): GitHubApiRunner {
  // The stub is made per call: a configurator outlives the request that created it.
  return fn => withAccountApi(
    exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId)), fn, { replayable: true });
}

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  async #withApi<T>(fn: (api: GitHubApi, scopes: string[]) => Promise<T>): Promise<T> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    const scopes = await account.getScopes();
    return await withAccountApi(account, api => fn(api, scopes));
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async (api, scopes) => {
      const viewer = await api.getViewer();
      return {
        displayName: viewer.user.name ?? viewer.user.login,
        uniqueName: viewer.user.login,
        avatar: { url: viewer.user.avatar_url },
      };
    });
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // GitHub's primary email is verified by GitHub, so it's safe as a sign-in identity.
    return await this.#withApi(api => api.getPrimaryVerifiedEmail());
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      throw new Error(`Unsupported GitHub URL: ${url}`);
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new Error(`Unsupported GitHub URL: ${url}`);
    }

    const [owner, repo, kind, number] = segments;
    const props: GitHubGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      owner,
      repo,
      resourceKind: "repo",
    };

    let resource = REPO_RESOURCE;
    if (kind === "issues" || kind === "pull") {
      // Never widen a malformed issue or PR URL (`/issues/new`, `/pull/12abc`) to the whole repo.
      if (!/^\d+$/.test(number ?? "")) {
        throw new Error(`Unsupported GitHub URL: ${url}`);
      }
      props.resourceKind = kind === "issues" ? "issue" : "pull";
      props.issueNumber = Number(number);
      resource = kind === "issues" ? ISSUE_RESOURCE : PULL_REQUEST_RESOURCE;
    }

    return {
      class: this.ctx.exports.GitHubGatekeeperImpl({ props }),
      resource,
    };
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    const read = accountReader(this.ctx.exports, this.ctx.props.userObjectId);

    if (resourceUrlPattern === REPO_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_REPO_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubRepoConfiguratorUI(read)),
      };
    }

    if (resourceUrlPattern === ISSUE_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_ISSUE_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubIssueConfiguratorUI(read)),
      };
    }

    if (resourceUrlPattern === PULL_REQUEST_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_PULL_REQUEST_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubPullRequestConfiguratorUI(read)),
      };
    }

    throw new Error(`Unsupported GitHub resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    const { userObjectId } = this.ctx.props;
    // A stub of its own for each call: one to a driver that has restarted is broken.
    const driver = () => this.ctx.exports.GitHubHookDriver.getByName(userObjectId);
    let webhooksGone = true;
    try {
      // First, while the account's token can still delete its webhooks. Asked again should its
      // answer be lost, as when it restarts after recording what GitHub failed to delete: it takes
      // up where it was, and says so.
      webhooksGone = await driver().revoke().catch(() => driver().revoke());
    } finally {
      // Kept while GitHub may yet delete one of them, which takes the token, for the disconnect to
      // be tried again; revoked otherwise, even when the driver failed, which mustn't leave a
      // disconnected account's grant live.
      if (webhooksGone) {
        await this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId)).revoke();
      }
    }
    if (!webhooksGone) {
      throw new Error("GitHub failed to delete some of this account's webhooks, so it is still connected. Disconnect it again to finish.");
    }
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(initiationNonce);
    return {
      url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}`,
    };
  }

  async commitReconnect(stageId: string): Promise<void> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  /**
   * Mint a verifier representing this account, used by GitHubGatekeeperImpl.addObserver to confirm
   * a prospective observer is allowed to read a bound repository (see that method). The verifier
   * carries this user's own account id, so when the gatekeeper calls hasRepoAccess() the check runs
   * against the observer's *own* GitHub token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: GitHubVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GitHubVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// GitHub uses the "ACL check (single unit)" observer strategy: a binding is a single repository (or
// a single issue/PR, which inherits the repo's ACL), so verifying an observer reduces to "can this
// user read the repo?".
//
// The verifier is minted by the *observer's* connected account (GatekeeperUserImpl.getVerifier) and
// carries that account's id, so `hasRepoAccess` queries GitHub with the observer's own token: if a
// plain `GET /repos/{owner}/{repo}` succeeds, the observer has at least read access; GitHub returns
// 404 (not 403) for repos a user can't see, so a 404 means "no access". The overseer only ever
// hands this verifier back to a GitHub gatekeeper, so that gatekeeper may trust the boolean result.

type GitHubVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard method the GitHub gatekeeper calls on its own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface GitHubVerifierApi extends GatekeeperUserVerifier {
  hasRepoAccess(owner: string, repo: string): Promise<boolean>;
}

@validateRpc()
export class GitHubVerifier extends WorkerEntrypoint<Env, GitHubVerifierProps>
    implements GitHubVerifierApi {
  async hasRepoAccess(owner: string, repo: string): Promise<boolean> {
    try {
      await accountReader(this.ctx.exports, this.ctx.props.userObjectId)(api => api.getRepo(owner, repo));
      return true;
    } catch (error) {
      // GitHub returns 404 for private repos the token cannot see (to avoid leaking existence), and
      // 403 in some org-policy cases — either way the observer lacks read access.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) {
        return false;
      }
      throw error;
    }
  }
}

