// The Linear gatekeeper's main module: the HTTP entrypoint (connect URL and OAuth callback),
// the vendor and per-account entrypoints, the account Durable Object that holds the OAuth grant,
// and the observer verifier. The per-binding gatekeeper Durable Object and its sessions live in
// linear-gatekeeper.ts and linear-sessions.ts and are re-exported here so wrangler finds every
// class on the main module.

import { WorkerEntrypoint, DurableObject, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  Gatekeeper,
  VendorDescription,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  AccountDescription,
  ConnectHandoff,
  SupportedResource,
  ResourceConfiguratorFrame,
  workerVersionTag,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  commitReconnectOrThrow, ConnectionSubject, pinForConnect, stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  LinearApi,
  LinearApiError,
  buildAuthorizeUrl,
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
  type LinearOAuthGrant,
} from "./linear-api";
import {
  LinearWorkspaceConfiguratorUI,
  LinearTeamConfiguratorUI,
  LinearIssueConfiguratorUI,
} from "./linear-configurators";
import {
  type Env, getBasePath, getBaseUrl, logger,
  type LinearGatekeeperImplProps, VENDOR_ID,
} from "./linear-env";
import type { LinearVerifierApi } from "./linear-gatekeeper";
import LINEAR_LOGO_SVG from "./linear-logo.svg";
import TYPES_CODE from "./types.txt";
import LINEAR_WORKSPACE_CONFIGURATOR_HTML from "./generated/linear-workspace-configurator-ui.txt";
import LINEAR_TEAM_CONFIGURATOR_HTML from "./generated/linear-team-configurator-ui.txt";
import LINEAR_ISSUE_CONFIGURATOR_HTML from "./generated/linear-issue-configurator-ui.txt";

export { LinearGatekeeperImpl } from "./linear-gatekeeper";
export { LinearIssueImpl, LinearTeamSessionImpl, LinearWorkspaceSessionImpl } from "./linear-sessions";
export type { LinearGatekeeperImplProps } from "./linear-env";
export type { LinearVerifierApi } from "./linear-gatekeeper";

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 3600 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

const OAUTH_SCOPES = ["read", "write"];

const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace",
  title: "Linear Workspace",
  description:
    "Read and manage every team and issue in a Linear workspace. This is the broadest option — " +
    "connect a single team or issue instead to limit what a Gadget can access.",
};

const TEAM_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace/team/:teamKey{/:rest}*",
  title: "Linear Team",
  description: "Read and manage the issues, labels, states, and cycles of a single Linear team.",
};

const ISSUE_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace/issue/:issueId{/:rest}*",
  title: "Linear Issue",
  description: "Read and manage a single Linear issue and its comments.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [WORKSPACE_RESOURCE, TEAM_RESOURCE, ISSUE_RESOURCE];

const LINEAR_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(LINEAR_LOGO_SVG)}`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #5e6ad2; color: white; border: none; border-radius: 4px; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem;">Linear Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6;">Please configure a Linear OAuth client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
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

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// HTTP handler — the browser OAuth flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Step 1: user opens the connect link (<doId>/<nonce>) -> redirect to Linear's consent screen.
    // Validate the DO id is 64 hex chars (not just 64 chars) so idFromString() can't throw a 500.
    if (path.length === 2 && /^[0-9a-f]{64}$/.test(path[0]) && /^[0-9a-f]{64}$/.test(path[1])) {
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

      const redirectUrl = buildAuthorizeUrl({
        clientId: env.CLIENT_ID,
        redirectUri: `${getBaseUrl(env)}/oauth`,
        state: `${doId}:${begun.oauthNonce}`,
        scopes: begun.scopes,
      });
      return Response.redirect(redirectUrl, 302);
    }

    // Step 2: Linear redirects back here with code + state.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("Linear authorization failed. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const state = url.searchParams.get("state");
      if (!state) return badRequest("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return badRequest("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return badRequest("Error: no 'code' provided");

      // Validate the DO id shape before idFromString(), which throws (→ unhandled 500) on garbage.
      if (!/^[0-9a-f]{64}$/.test(doId)) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
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
      displayName: "Linear",
      url: "https://linear.app",
      logo: { url: LINEAR_LOGO_URL },
      color: "#f4f5f8",
      tagline: "Triage, create, and update issues",
      description:
        "Connect your Linear account so Cloudflare OS can read and manage issues, projects, and " +
        "comments across the teams you choose.",
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
// UserAccount DO — stores OAuth credentials and handles token refresh.

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
 * The Linear account a connection is pinned to: one user in one workspace. A reconnect that
 * comes back as anyone else, or into any other workspace, is refused and its grant revoked.
 * `id` is what the kit's fence compares, the `${userId}:${orgId}` pair; the names are for the
 * refusal's words.
 */
type PinnedSubject = ConnectionSubject & {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
  orgUrlKey: string;
};

/** How the callback ended: a handoff for the browser, or a refusal to show it. */
type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

/** Reads the Linear user and workspace an access token belongs to. */
async function fetchSubject(accessToken: string): Promise<PinnedSubject> {
  const { user, organization } = await new LinearApi(async () => accessToken).getViewer();
  return {
    id: `${user.id}:${organization.id}`,
    userId: user.id,
    userName: user.displayName ?? user.name,
    orgId: organization.id,
    orgName: organization.name,
    orgUrlKey: organization.urlKey,
  };
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<LinearOAuthGrant>("grant")) {
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
   * different Linear user or workspace than the connection is pinned to.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<CallbackResult | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("Linear OAuth is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode({
      code,
      clientId: this.env.CLIENT_ID,
      clientSecret: this.env.CLIENT_SECRET,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
    });

    let subject: PinnedSubject;
    try {
      subject = await fetchSubject(grant.accessToken);
    } catch (error) {
      // A first connect's unreadable grant leaves tokens nobody owns, so revoke it; a
      // reconnect's is just dropped, keeping the live grant as it is.
      if (!stored.reconnect) await this.#revokeGrant(grant);
      throw new Error("Could not read which Linear account authorized this connection. Please try again.",
        { cause: error });
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The connection is pinned to the Linear user and workspace it was made as: a reconnect
      // that comes back as anyone else, or into any other workspace, is refused and its grant
      // revoked, rather than silently swapping the account every binding reads.
      const staged = stageReconnect(this.ctx.storage.kv, grant, subject, Date.now(),
        (pinned, granted) => ({
          title: "That's a different Linear account",
          detail: `This connection is for ${pinned.userName} in the ${pinned.orgName} workspace, but ` +
            `Linear authorized ${granted.userName} in the ${granted.orgName} workspace. Sign in to ` +
            `Linear as ${pinned.userName} and reconnect, or connect the other account separately.`,
        }));
      if ("refused" in staged) {
        await this.#revokeGrant(grant);
        return { refused: staged.refused };
      }
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile.
      handoff = await callback.reconnectComplete(staged.stageId);
    } else {
      this.ctx.storage.kv.put<LinearOAuthGrant>("grant", grant);
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      // The pin lives only as long as the handoff: a connect that fails unpins again and drops
      // the grant stored ahead of it.
      handoff = await pinForConnect(this.ctx.storage.kv, subject,
        () => {
          const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
          return callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
        },
        () => { this.ctx.storage.kv.delete("grant"); });
    }

    await this.ctx.storage.deleteAlarm();
    return { handoff };
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. The kit
   * re-pins the staged subject, adopting a connection made before the pin existed. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitReconnectOrThrow<LinearOAuthGrant>(this.ctx.storage.kv, Date.now(), stageId);
    this.ctx.storage.kv.put<LinearOAuthGrant>("grant", grant);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  /** Returns a currently-valid access token, refreshing it first if it is about to expire. */
  async getAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<LinearOAuthGrant>("grant");
    if (!grant) throw new Error("Linear credentials have not been configured for this account.");

    if (Date.now() < grant.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return grant.accessToken;
    }
    if (!grant.refreshToken || !this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      return grant.accessToken;
    }

    try {
      const refreshed = await refreshAccessToken({
        refreshToken: grant.refreshToken,
        clientId: this.env.CLIENT_ID,
        clientSecret: this.env.CLIENT_SECRET,
      });
      this.ctx.storage.kv.put<LinearOAuthGrant>("grant", refreshed);
      return refreshed.accessToken;
    } catch (err) {
      // A revoked/expired refresh token (invalid_grant) means the connection is dead. Notify the
      // Workshop here, since the error type is lost when it crosses the RPC boundary to the caller.
      if (err instanceof LinearApiError && err.isAuthError) {
        await this.noteCredentialsExpired();
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: err });
      }
      throw err;
    }
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), VENDOR_ID);
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<LinearOAuthGrant>("grant")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const grant = this.ctx.storage.kv.get<LinearOAuthGrant>("grant");
    if (grant) await this.#revokeGrant(grant);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Revokes a grant's tokens, best-effort: a token Linear already refuses is not worth failing over. */
  async #revokeGrant(grant: LinearOAuthGrant): Promise<void> {
    try {
      await revokeToken(grant.accessToken);
      if (grant.refreshToken) await revokeToken(grant.refreshToken);
    } catch (err) {
      logger.error("failed to revoke Linear token", {
        event: "oauth.token.revoke.failed", error: err,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes and serves configurators.

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements GatekeeperUser {
  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    const api = new LinearApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) {
        try { await account.noteCredentialsExpired(); } catch (notifyErr) {
          logger.warn("failed to note credential expiry", {
            event: "credentials.expiry.note.failed", error: notifyErr,
          });
        }
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const { user } = await api.getViewer();
      return {
        displayName: user.displayName ?? user.name,
        uniqueName: user.email ?? user.name,
        avatar: { url: user.avatarUrl ?? "" },
      };
    });
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // This vendor does not advertise providesAuth, so this is never used for sign-in.
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
    const parsed = new URL(url);
    if (parsed.hostname !== "linear.app") {
      throw new Error(`Unsupported Linear URL: ${url}`);
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const workspaceUrlKey = segments[0];
    if (!workspaceUrlKey) {
      throw new Error(`Unsupported Linear URL: ${url}`);
    }

    const props: LinearGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      workspaceUrlKey,
      resourceKind: "workspace",
    };
    let resource = WORKSPACE_RESOURCE;

    if (segments[1] === "team" && segments[2]) {
      props.resourceKind = "team";
      props.teamKeyOrId = decodeURIComponent(segments[2]);
      resource = TEAM_RESOURCE;
    } else if (segments[1] === "issue" && segments[2]) {
      props.resourceKind = "issue";
      props.issueRef = decodeURIComponent(segments[2]);
      resource = ISSUE_RESOURCE;
    }

    return { class: this.ctx.exports.LinearGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const account = this.#account();
    const getToken = () => account.getAccessToken();

    if (resourceUrlPattern === WORKSPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_WORKSPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearWorkspaceConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === TEAM_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_TEAM_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearTeamConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === ISSUE_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_ISSUE_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearIssueConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Linear resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  /**
   * Mint a verifier representing this account, used by LinearGatekeeperImpl.addObserver to confirm a
   * prospective observer may read a bound team/issue (and, for workspace bindings, the workspace and
   * each accessed team). The verifier carries this user's own account id, so the access checks run
   * against the observer's *own* Linear token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: LinearVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.LinearVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Linear uses the "ACL check (single unit)" strategy for team and issue bindings, and "data-set
// tracking (by team)" for workspace bindings (see LinearGatekeeperImpl observer methods). All three
// reduce to per-observer access questions answered against the observer's *own* token:
//   - hasWorkspaceAccess(urlKey): the observer belongs to the workspace (their viewer's organization
//     urlKey matches). Gates workspace-level metadata/member-directory reads, which any member sees.
//   - hasTeamAccess(urlKey, teamKeyOrId): the observer is in the workspace AND can see the team.
//     Linear's `teams` query only returns teams visible to the token's user, so a private team the
//     observer isn't a member of resolves to null — honoring team privacy. Public teams resolve for
//     any member. Team UUIDs are global, so this also rejects a same-key team in another workspace.
//   - hasIssueAccess(urlKey, issueRef): the observer is in the workspace AND can see the issue
//     (issues inherit their team's ACL, so getIssue returns null when the team is hidden).
// The overseer only ever hands this verifier back to a Linear gatekeeper, which may therefore trust
// the boolean results.

type LinearVerifierProps = {
  userObjectId: string;
};



@validateRpc()
export class LinearVerifier extends WorkerEntrypoint<Env, LinearVerifierProps>
    implements LinearVerifierApi {
  #orgUrlKey?: Promise<string | null>;

  #api(): LinearApi {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return new LinearApi(() => account.getAccessToken());
  }

  // Memoized within this instance: the urlKey of the workspace the observer's token belongs to, or
  // null if the token is broken/expired (a token that can't demonstrate access is treated as "no
  // access" rather than failing the whole open; the observer is re-checked on their next open).
  #workspaceUrlKey(): Promise<string | null> {
    if (!this.#orgUrlKey) {
      this.#orgUrlKey = (async () => {
        try {
          return (await this.#api().getOrganization()).urlKey;
        } catch (error) {
          if (error instanceof LinearApiError && error.isAuthError) return null;
          throw error;
        }
      })();
    }
    return this.#orgUrlKey;
  }

  async hasWorkspaceAccess(workspaceUrlKey: string): Promise<boolean> {
    return (await this.#workspaceUrlKey()) === workspaceUrlKey;
  }

  async hasTeamAccess(workspaceUrlKey: string, teamKeyOrId: string): Promise<boolean> {
    if (!(await this.hasWorkspaceAccess(workspaceUrlKey))) return false;
    try {
      return (await this.#api().findTeam(teamKeyOrId)) !== null;
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) return false;
      throw error;
    }
  }

  async hasIssueAccess(workspaceUrlKey: string, issueRef: string): Promise<boolean> {
    if (!(await this.hasWorkspaceAccess(workspaceUrlKey))) return false;
    try {
      return (await this.#api().getIssue(issueRef)) !== null;
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) return false;
      throw error;
    }
  }
}
