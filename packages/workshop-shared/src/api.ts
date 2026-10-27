// This file defines the API spoken between the Gadgets Workshop service and the front-end UI.
//
// The UI is a good old "fat client" SPA. Why not use SSR? Because:
// - Users of this UI are likely to have it open often, maybe even all the time. Startup time is
//   less of a concern than with sites you visit only briefly, and assets are likely to be in cache
//   in any case.
// - The Gadgets themselves are sandboxed on the client side in addition to the server side. This
//   sandboxing requires running code in the browser. It is not plausible to server-side render
//   a Gadget itself.
// - By providing a really clean API boundary between client and server, we make it easier to build
//   alternative clients.
// - SPA is just easier to think about.
//
// The entire API between the client and server is an RPC API, using Cloudflare's JavaScript RPC,
// which essentially allows natural JavaScript / TypeScript interfaces to be exposed over the
// network.
//
// The RPC interface operates over a WebSocket, which the client starts immediately at startup and
// keeps open for the entire lifetime of the session, reconnecting if needed.
//
// Gadgets run inside a sandboxed iframe which has no ability to talk to the outside world at all,
// except postMessage() to the parent frame. Through postMessage() exchanges, the Gadget can speak
// RPC to the Workshop. Among other things, through this interface, the Workshop provides the
// Gadget a stub pointing to the Gadget's server-side Durable Object interface.
//
// Separable domains live in sibling modules and are re-exported below with unchanged
// names: errors.ts (the coded-error family factory), orgs.ts (organizations),
// commerce.ts (SaaS billing, beside its port), bots.ts (declared bots), chat.ts (the
// chat wire grammar: messages, tool calls, stream events), models.ts (AI models),
// workspace.ts (workspace vocabulary), chats.ts (chat sessions), workpieces.ts,
// blueprints.ts, clients.ts (per-workpiece capabilities), overseer.ts (the Overseer
// interface and its mixins), sharing.ts (collaboration and observer bindings), and
// admin.ts (the admin surface). This file stays the single import surface for the
// API, so importers are unaffected by where a domain's code lives.


import type { AdminApi, CloudflareAccountOption, CloudflareUsageInfo, GatekeeperVendorInfo, ServerConfig } from "./admin.js";
import type { BlueprintApiMethods, BlueprintPublicInfo } from "./blueprints.js";
import type { ModelApiMethods } from "./models.js";
import type { WorkspaceOutputMethods } from "./workspace.js";
import type { Overseer } from "./overseer.js";
import type { ObserverConfigCallback } from "./sharing.js";
import type { GadgetMetadataWithTimestamps } from "./workspace.js";
import { RpcStub, RpcTarget } from "capnweb";
import { AccountDescription, AvatarImage, GatekeeperUiFrame, GatekeeperUserSelection, ResourceConfiguratorFrame, SupportedResource, VendorDescription } from "./gatekeeper.js";
import type { UiFeatureFlags } from "./feature-flags.js";
import { codedErrorFamily } from "./errors.js";
import type { OrgApiMethods, OrgMembership } from "./orgs.js";
import type { CommerceApiMethods } from "./commerce.js";
import type { BotApiMethods } from "./bots.js";
import type { AiChatAuthorInfo } from "./chat.js";

export const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21
]);

/**
 * How a connect, reconnect, ensure-resources or sign-in flow starts, as returned by
 * `AuthenticatedApi.connectAccount()` and its siblings. `url` is the gatekeeper's flow URL, which
 * the Workshop opens as a disowned popup. `nonce` is a 64-lowercase-hex secret minted for this
 * flow, which the Workshop writes into that popup's own sessionStorage before navigating it and
 * nowhere else: sessionStorage is per top-level browsing context and per origin, so it survives the
 * trip through the gatekeeper and the provider and is readable again once the popup is back on the
 * Workshop's origin. When the flow finishes, the popup lands on the Workshop's /connect/handoff
 * page, which presents the ticket from its URL fragment together with the nonce
 * (`AuthenticatedApi.completeConnectHandoff()` / `PublicApi.confirmLogin()`). A handoff page opened
 * any other way holds no nonce and redeems nothing. The nonce is single-use and dies with the flow:
 * a connect's after CONNECT_FLOW_LIFETIME_MS (30 minutes, server-side), a sign-in's with its
 * `PendingLogin` attempt.
 */
export type ConnectFlowStart = { url: string; nonce: string };

/**
 * A pending gatekeeper sign-in attempt, returned by `PublicApi.startGatekeeperLogin()`. Holding this
 * stub is the capability to receive the resulting session token; dispose it to abandon the attempt.
 */
export interface LoginAttempt extends RpcTarget {
  /**
   * The session token (same format as `login()`; store it and pass it to `authenticate()`) once the
   * sign-in popup has confirmed the attempt's ticket via `PublicApi.confirmLogin()`; null until
   * then, so the caller polls. Throws with a user-facing message once the attempt has expired, the
   * gatekeeper reported a failure, or the token was already received. Holding this stub alone never
   * yields a token: the sign-in URL is a bearer capability, and only the popup this browser opened
   * holds the nonce that confirms it.
   */
  receive(): Promise<string | null>;
}

/** Public API exposed to the internet. */
export interface PublicApi extends RpcTarget {
  /** Confirms that the RPC connection can round-trip without performing application work. */
  ping(): Promise<void>;

  /**
   * Returns deployment-level configuration the client needs at boot (auth mode, available sign-in
   * vendors, whether the Cloudflare limits flow is enabled). Contains no secrets.
   */
  getServerConfig(): Promise<ServerConfig>;

  /**
   * Begin a sign-in via an authentication gatekeeper (e.g. "google", "github", "cloudflare").
   * Returns the `url` the client opens as a disowned popup, the `nonce` it writes into that popup's
   * sessionStorage before navigating it (see `ConnectFlowStart`), and an `attempt` stub the client
   * polls with `receive()` for the session token. When the flow finishes, the popup lands on the
   * Workshop's own /connect/handoff page, which calls `confirmLogin(ticket, nonce)`. The vendor must
   * be auth-capable and allowlisted (see ServerConfig.authVendors); throws otherwise.
   *
   * Dispose `attempt` to abandon the sign-in (e.g. the user closed the popup). Nothing is cancelled
   * server-side: the browser just stops polling, and an unreceived token expires on its own.
   */
  startGatekeeperLogin(vendorId: string): Promise<{ url: string; nonce: string; attempt: RpcStub<LoginAttempt> }>;

  /**
   * Confirm a finished sign-in flow. Called by the /connect/handoff page in the sign-in popup, which
   * has no session: `ticket` is the handoff ticket from the page's URL fragment and `nonce` the one
   * `startGatekeeperLogin()` returned for the same flow, read from the popup's own sessionStorage.
   * Marks the attempt's delivered result as confirmed, so that `LoginAttempt.receive()` releases the
   * token to whoever holds the attempt stub; the popup itself never sees a token. Throws with a
   * user-facing message when the attempt is unknown, expired, or failed, or the ticket is not the
   * attempt's.
   */
  confirmLogin(ticket: string, nonce: string): Promise<void>;

  /** Authenticates the user using an auth token (typically stored in localStorage). */
  authenticate(token: string): Promise<AuthenticatedApi>;

  /**
   * Like authenticate() but the server is expected to be sitting behind Cloudflare Access, and the
   * client is expected to have already authenticated with Access (before they could load the
   * application in their browser at all). The credentials from the Cloudflare Access session will
   * be used to authenticate the user.
   */
  authenticateFromCfAccess(): Promise<AuthenticatedApi>;

  /**
   * Login with username and password.
   *
   * Returns a token to store in local storage and pass to `authenticate()` in the future.
   *
   * Returns null if login failed (no such user or wrong password).
   *
   * `passwordHash` is derived from the user's password as follows:
   *
   *     argon2id({
   *       password,
   *       salt: SERVICE_SALT + encode(username, 'utf8'),
   *       parallelism: 1,
   *       iterations: 3,
   *       memorySize: 64MiB,
   *       hashLength: 32,
   *     });
   *
   * Note that the `passwordHash` itself is NOT stored plaintext by the server -- additional
   * hashing is performed server-side. The overall scheme achieves roughly the same security
   * guarantees as traditional server-side password hashing, but with the added benefit that the
   * server never sees the user's password at all, and also the benefit of performing the expensive
   * hash on the client which tends to have more resources available than a busy server.
   *
   * This API may be disabled when the server uses SSO for authentication.
   */
  login(username: string, passwordHash: Uint8Array): Promise<string | null>;

  /**
   * Create a new account. Returns a token to store in local storage and pass to `authenticate()`
   * in the future.
   *
   * Returns null if the username already exists. (Other kinds of errors may throw exceptions.)
   *
   * See login() (above) for an explanation of the password hashing algorithm.
   *
   * This API may be disabled when the server uses SSO for authentication.
   */
  createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null>;

  /**
   * Fetch blueprint metadata by ID. Returns null if the blueprint doesn't exist. No
   * authentication required (knowing the ID is sufficient, since a blueprint is "just data").
   */
  getBlueprint(id: string): Promise<BlueprintPublicInfo | null>;

  /**
   * Download a blueprint as a `.gadget` archive stream. The archive contains only
   * BlueprintMetadata plus the current blueprint code snapshot, not the full KV record.
   */
  downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>>;
}

/** Subscription callback for AuthenticatedApi.subscribeConnectedAccounts(). */
export interface ConnectedAccountsSubscriber {
  /**
   * If `credentialsValid` is false, the account's credentials are known to be expired, and the
   * UI should call reconnectAccount() to fix this if the user tries to select this account.
   */
  add(id: number, description: AccountDescription, vendor: VendorDescription,
      supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string): void;
  remove(id: number): void;

  /** Called after add() has been called for all accounts known so far. */
  ready(): void;
}

/** A notification delivered to one authenticated user. */
export type UserNotification = {
  /** Stable identifier shared by the live and push delivery attempts. */
  id: string;

  /** Whether the task finished or is paused on a connection or action-approval prompt. */
  kind: "taskCompleted" | "permissionRequested";

  /** Workspace containing the task. */
  workspaceId: string;

  /** Chat containing the task. */
  chatId: number;

  /** Current human-readable chat title. */
  chatTitle: string;
};

/** How long a workspace's notifications stay muted: until a time, or until the user unmutes it. */
export type NotificationMute = { until: Date, indefinite?: never } | { indefinite: true, until?: never };

/** Callback used by `AuthenticatedApi.subscribeToNotifications()`. */
export interface NotificationSubscriber extends RpcTarget {
  /**
   * Present a notification to the active user. Resolve only once the user has seen it, or is
   * already viewing its chat; if no subscriber resolves promptly, the backend falls back to mobile
   * push delivery.
   */
  notify(notification: UserNotification): Promise<void>;
}

/**
 * When listing gatekeeper vendors or connected accounts, you can filter to only vendors/accounts
 * that support certain features. This type specifies the filter.
 */
export type GatekeeperVendorFilter = {
  /** Filter for vendors that can connect to the given resource. */
  resourceUrl?: string,
};

/** Options for subscribing to connected accounts. */
export type ConnectedAccountsFilter = GatekeeperVendorFilter & {
  /** Ensure and include auto-provisioned accounts forced by deployment policy. */
  includeForcedAutoProvisionedAccounts?: boolean;
};

/**
 * Identifies a workpiece within a workspace. A workpiece is a numbered thing the user (or agent)
 * is working on inside the workspace -- currently a gadget or a gatekeeper (connection), with
 * more types expected later. All workpiece types share one sequential per-workspace ID namespace,
 * so a bare number unambiguously identifies a workpiece of any type, and derived names (facet
 * names) can never collide across types.
 */
export type WorkpieceId = number;

// Matches an ASCII JavaScript identifier, excluding `$`. Deliberately conservative: binding
// names are typed by agents and rendered as `env.NAME`, so full Unicode identifier support buys
// nothing; and while `$` is technically legal in identifiers, it is conventionally reserved for
// special circumstances like code generators, so agents shouldn't be using it.
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ECMAScript reserved words (including strict-mode reservations and literals), which are valid
// per IDENTIFIER_REGEX but cannot follow `.` in all contexts and would confuse both agents and
// humans as binding names.
const RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with",
  // Strict-mode / contextual reservations.
  "await", "implements", "interface", "let", "package", "private", "protected", "public",
  "static", "yield",
]);

/**
 * Validates a binding name, throwing a descriptive Error if it is unacceptable. This is the one
 * shared validator applied at every chokepoint that writes a binding name (gadget binding edges,
 * the workspace default binding list, chat binding maps, spawner env configs, and the agent
 * tools), wherever the map is keyed.
 *
 * A valid name is a JavaScript identifier (see IDENTIFIER_REGEX; reserved words excluded) that is
 * not a dangerous or confusing property name: anything that exists on `Object.prototype`
 * (`__proto__`, `constructor`, `hasOwnProperty`, `toString`, etc.) or `prototype` is rejected,
 * since binding maps are used as plain objects where such names would collide with inherited
 * members -- or worse, mutate the prototype chain.
 *
 * ALL_CAPS_WITH_UNDERSCORES is style guidance only (recommended in tool descriptions and used by
 * generated names), not enforced here.
 */
export function validateBindingName(name: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(
        `Invalid binding name "${name}": binding names must be JavaScript identifiers ` +
        `(letters, digits, and '_', not starting with a digit).`);
  }
  if (RESERVED_WORDS.has(name)) {
    throw new Error(`Invalid binding name "${name}": this is a reserved word in JavaScript.`);
  }
  if (name === "prototype" || name in Object.prototype) {
    throw new Error(
        `Invalid binding name "${name}": this name collides with a built-in object property.`);
  }
}

/**
 * Throws unless `email` is acceptable as `AiChatAuthorInfo.commitEmail`: `local@domain`, at most
 * 254 characters, with no whitespace, control characters, or angle brackets. This is not full
 * address validation; it exists so the value cannot break out of a git `Name <email>` header.
 */
export function validateCommitEmail(email: string): void {
  if (email.length > 254 || !/^[^\p{Cc}\s<>@]+@[^\p{Cc}\s<>@]+$/u.test(email)) {
    throw new Error(`Invalid commit email: expected an address like name@example.com.`);
  }
}

/** Stable error codes attached to expected failures from `AuthenticatedApi.openGadget()`. */
export const OPEN_GADGET_ERROR_CODES = {
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  workspaceAccessDenied: "WORKSPACE_ACCESS_DENIED",
  shareLinksDisabled: "SHARE_LINKS_DISABLED",
} as const;

/** An expected failure code from `AuthenticatedApi.openGadget()`. */
export type OpenGadgetErrorCode =
    typeof OPEN_GADGET_ERROR_CODES[keyof typeof OPEN_GADGET_ERROR_CODES];

const openGadgetErrors = codedErrorFamily(OPEN_GADGET_ERROR_CODES, {
  [OPEN_GADGET_ERROR_CODES.workspaceNotFound]: "Workspace not found.",
  [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied]: "You don't have access to this workspace.",
  [OPEN_GADGET_ERROR_CODES.shareLinksDisabled]:
      "Share links are disabled for this workspace because it contains sensitive data. " +
      "The owner must add each person directly.",
});

/** Creates an expected `openGadget()` error with a machine-readable code. */
export const createOpenGadgetError = openGadgetErrors.create;

/** Reads the machine-readable code from an expected `openGadget()` error. */
export const getOpenGadgetErrorCode = openGadgetErrors.getCode;

/** Stable error codes attached to authentication failures. */
export const AUTH_ERROR_CODES = {
  invalidSessionToken: "INVALID_SESSION_TOKEN",
  notAuthenticatedWithAccess: "NOT_AUTHENTICATED_WITH_ACCESS",
} as const;

/** An expected authentication failure code. */
export type AuthErrorCode = typeof AUTH_ERROR_CODES[keyof typeof AUTH_ERROR_CODES];

/** Messages for auth failures thrown without a surviving code; clients match these only as a
 * classification fallback. */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  [AUTH_ERROR_CODES.invalidSessionToken]: "invalid session token",
  [AUTH_ERROR_CODES.notAuthenticatedWithAccess]: "Not authenticated with Access.",
};

const authErrors = codedErrorFamily(AUTH_ERROR_CODES, AUTH_ERROR_MESSAGES);

/** Creates an authentication failure with a machine-readable code. */
export const createAuthError = authErrors.create;

/** Reads the machine-readable code from an authentication failure. */
export const getAuthErrorCode = authErrors.getCode;

/** Stable error codes attached to plan-enforcement refusals (the #16 chokepoints beyond the
 * usage checker's `usage_limit` chat error: model tiers, gatekeeper connectors, workspace caps).
 * Clients read them to offer a plan upgrade instead of a bare error. */
export const PLAN_REFUSAL_CODES = {
  modelNotOnPlan: "MODEL_NOT_ON_PLAN",
  connectorNotOnPlan: "CONNECTOR_NOT_ON_PLAN",
  workspaceCapReached: "WORKSPACE_CAP_REACHED",
} as const;

/** A plan-enforcement refusal code; the message names the refused thing, so it is composed at
 * the throw site rather than fixed per code. */
export type PlanRefusalCode = typeof PLAN_REFUSAL_CODES[keyof typeof PLAN_REFUSAL_CODES];

const planRefusalErrors = codedErrorFamily(PLAN_REFUSAL_CODES);

/** Creates a plan-enforcement refusal carrying its machine-readable code; the message names the
 * refused thing, so it is composed at the throw site and passed in. */
export function createPlanRefusalError(code: PlanRefusalCode, message: string):
    Error & { code: PlanRefusalCode } {
  return planRefusalErrors.create(code, message);
}

/** Reads the plan-refusal code from an error, if it carries one. */
export const getPlanRefusalCode = planRefusalErrors.getCode;

/** Whether `code` is a plan-refusal code — the client-side test for error surfaces. */
export const isPlanRefusalCode = planRefusalErrors.isCode;

/**
 * One user as listed in the deployment-wide user directory (see
 * `AuthenticatedApi.searchUsers`).
 */
export type UserDirectoryRecord = {
  /**
   * Canonical user identifier: email for Access / sign-in accounts, username
   * for password accounts.
   */
  id: string;

  /** The user's current display name. */
  name: string;
};

/** Routing identity and one-use proof posted by the authenticated browser to redeem a transfer. */
export type DeviceSessionHandoffStart = {
  /** Durable Object identifier for the staging user; this value is not secret. */
  userDoId: string;
  /** Single-use 256-bit secret in lowercase hex; only its hash is stored server-side. */
  ticket: string;
};

/** Top-level API exposed to the user after they have authenticated. */
export interface AuthenticatedApi extends RpcTarget, OrgApiMethods, CommerceApiMethods, BotApiMethods,
    ModelApiMethods, WorkspaceOutputMethods, BlueprintApiMethods {
  /**
   * Get profile info for the user who is logged in, plus their organization memberships
   * (see `WhoamiInfo`). The memberships are the user's mirrored index — a display snapshot;
   * every org-derived authority re-checks membership where it matters.
   */
  whoami(): Promise<WhoamiInfo>;

  /**
   * Stage a two-minute, single-use device-session transfer for a native app. The state is an
   * opaque 16–512 character URL-safe value and the key is an uncompressed P-256 public key encoded
   * as unpadded base64url. The encrypted credential remains server-side until the browser POSTs
   * the returned ticket to `/api/device-session/callback`, which redirects to the fixed, claimed
   * HTTPS app link. Repeating a live state reissues its ticket and invalidates the previous one.
   */
  beginDeviceSessionHandoff(publicKey: string, state: string)
    : Promise<DeviceSessionHandoffStart>;

  /** Set the user's own display name, seen in chats, etc. */
  setOwnDisplayName(name: string): Promise<void>;

  /**
   * Set the email address used on git commits the user authors, or clear it with null to fall
   * back to one derived from their user ID. Rejects an address `validateCommitEmail` refuses.
   */
  setOwnCommitEmail(email: string | null): Promise<void>;

  /**
   * Find other users of this deployment by a case-insensitive substring of
   * their display name or id, for inviting collaborators. Excludes the caller
   * and every user named by `excludeIds`. Returns at most 10 records, earliest
   * substring match first.
   *
   * Scoped to the caller's directory scope — the active co-members of every org they belong to,
   * plus the owners of workspaces shared with them — so one org's members are never enumerable
   * from another. Adding an out-of-scope collaborator by exact id
   * (`Overseer.addCollaborator()`) still works; the directory is discovery, not authority.
   *
   * Rejects a `query` longer than 1000 characters or containing a line break,
   * and more than 1000 distinct ids to exclude, the caller's own included.
   *
   * Returns no records while the admin has user search turned off
   * (`ServerConfig.userSearchEnabled`); inviting by exact username/email via
   * `Overseer.addCollaborator()` still works then.
   */
  searchUsers(query: string, excludeIds: string[]): Promise<UserDirectoryRecord[]>;

  /**
   * Change the user's password, if using password-based authentication.
   *
   * See `PublicApi.login()` for an explanation of the hashing algorithm.
   */
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void>;

  /**
   * Whether this account has a password set. False for accounts created via an OAuth provider, in
   * which case the change-password UI should be hidden.
   */
  hasPasswordLogin(): Promise<boolean>;

  /**
   * Connect the native app's one-time central device registration to this authenticated user. Each
   * registered device gets push; a device that registers again replaces its own subscription. The
   * deployment never receives an APNs device token or Cloudflare account token.
   */
  registerNotificationDevice(deviceRegistrationId: string): Promise<void>;

  /**
   * Subscribe while this client can visibly present notifications. Dispose the returned handle
   * when the page becomes hidden so the backend can promptly fall back to mobile push.
   */
  subscribeToNotifications(
      subscriber: RpcStub<NotificationSubscriber>): Promise<RpcStub<{}>>;

  /**
   * Mute a workspace in the user's list, so its finished tasks notify no tab or device, or unmute
   * it with null. Permission requests still come through.
   */
  setWorkspaceNotificationMute(workspaceId: string, mute: NotificationMute | null): Promise<void>;

  /** Resolve UI feature flags for the authenticated user. */
  getUiFeatureFlags(): Promise<UiFeatureFlags>;

  /** Returns true if the user has completed the onboarding wizard. */
  isOnboardingCompleted(): Promise<boolean>;

  /** Mark the onboarding wizard as completed. */
  completeOnboarding(): Promise<void>;

  // --- Optional Cloudflare limits / top-up flow (only meaningful when enabled server-side) ---

  /** Get the user's current free-tier usage and connected-account balance. */
  getCloudflareUsage(): Promise<CloudflareUsageInfo>;

  /**
   * List the Cloudflare accounts the connected grant can access. Used to prompt account selection
   * when the user has more than one. Returns an empty array if not connected. Connecting Cloudflare
   * is done via the Cloudflare gatekeeper (connectAccount("cloudflare")) or by signing in with it.
   */
  listCloudflareAccounts(): Promise<CloudflareAccountOption[]>;

  /**
   * Select which Cloudflare account to bill. Persists the choice. Throws if the account isn't
   * accessible.
   */
  selectCloudflareAccount(accountId: string): Promise<void>;

  /**
   * Upload a user avatar image. The data should be a compressed image (JPEG/PNG), ideally under
   * 50 KB. Pass null to remove the avatar.
   */
  setAvatar(data: Uint8Array | null): Promise<void>;

  /**
   * Fetch a user's avatar image by user ID. Returns null if no avatar has been set.
   * Accepts any user ID so that other users' avatars can be displayed (e.g. in chat).
   */
  getAvatar(userId: string): Promise<Uint8Array | null>;

  /**
   * Open an existing gadget.
   *
   * If `shareKey` is provided, the server redeems it before opening, adding the caller as a
   * collaborator. If the key is invalid or expired, the call throws an exception. If the gadget has
   * `ownerInvitesOnly` set (see `GadgetMetadata`), a caller the owner has not added directly
   * is refused with a `shareLinksDisabled` coded exception. This design
   * allows share-key redemption and gadget opening in a single round trip, and further calls
   * can be pipelined on the returned Overseer.
   *
   * To allow for pipelining, this throws an exception if the gadget doesn't exist. Expected
   * missing and authorization failures carry a code from `OPEN_GADGET_ERROR_CODES`.
   *
   * `configureObservers` is invoked only when the opening user is a non-owner who must choose
   * connected accounts for one or more gatekeeper bindings before they can observe the gadget (see
   * ObserverConfigCallback). It is never called for the owner or an already-configured observer,
   * so the common-case open is still a single pipelined round trip.
   *
   * TODO(multi-gadget): This should be renamed to openWorkspace().
   */
  openGadget(id: string, shareKey?: string,
             configureObservers?: RpcStub<ObserverConfigCallback>): Promise<RpcStub<Overseer>>;

  /**
   * Create a new workspace. It will start out titled "Untitled Workspace".
   *
   * Note: A gadget is considered "provisional" until it has some sort of activity, such as a
   *   chat message or code edit. Provisional gadgets do not appear on the home page and will be
   *   automatically deleted after some time. Note in particular that calling
   *   new*Gatekeeper() will not clear the provisional bit (as long as the gatekeeper isn't bound
   *   into a gadget), so provisional gadgets are useful to allow the user to write an initial
   *   chat message without explicitly creating a new gadget.
   *
   * TODO(multi-gadget): This should be renamed to newWorkspace().
   */
  newGadget(): Promise<RpcStub<Overseer>>;

  /**
   * List metadata about all the user's Gadgets. Used to display the front-page listing.
   *
   * Provisional gadgets are hidden.
   *
   * TODO: Pagination, sort options.
   */
  listGadgets(): Promise<GadgetMetadataWithTimestamps[]>;

  /** Pin or unpin this workspace in the user's list. */
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void>;

  /** List all third-party services that this account can connect to. */
  listGatekeeperVendors(filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]>;

  /**
   * Connect this account to a specific account on a third-party service. Returns the URL which the
   * Workshop opens as a disowned popup to complete the authorization, plus the flow's nonce (see
   * `ConnectFlowStart`). When the flow finishes, the popup lands on the Workshop's own
   * /connect/handoff page, which redeems the handoff with completeConnectHandoff() over its own
   * session; only then is the account added to the list, which can be observed through
   * subscribeConnectedAccounts().
   *
   * `resourceUrlPatterns`, if given, limits the connection to the authorization needed for those
   * grantable resource types (those with `grantable`; see `SupportedResource`). If omitted,
   * authorization for all of the vendor's resource types is requested. An empty array is meaningful
   * and distinct from omitting it: it requests no resource authorization at all, which is how a
   * caller connects an account for a non-resource purpose (e.g. billing) without asking the user to
   * grant data access it will never use.
   */
  connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<ConnectFlowStart>;

  /**
   * Redeem a finished connect flow's handoff. Called by the Workshop's own /connect/handoff page
   * running in the popup, over the popup's session, which is the initiating user's (the SPA
   * authenticates as any Workshop tab does: from the shared localStorage token, or from the
   * Cloudflare Access identity in an Access deployment). `ticket` is the handoff ticket from the
   * page's URL fragment; `nonce` must be the one connectAccount() / reconnectAccount() /
   * ensureAccountResources() returned for the flow that produced the ticket, read from the popup's
   * own sessionStorage. Both are single-use. Activates the pending connect / reconnect /
   * ensure-resources grant, after which the account (or its restored credentials) appears via
   * subscribeConnectedAccounts(). Throws with a user-facing message if the ticket or nonce is
   * unknown to this user, already used, or expired, or they belong to different flows.
   */
  completeConnectHandoff(ticket: string, nonce: string): Promise<void>;

  /**
   * Ensure the authorization for the listed grantable resource types (by `urlPattern`) is granted
   * on a connected account, expanding if needed. Returns a flow to open as a disowned popup (as for
   * connectAccount()) to authorize them, or null if nothing was needed. Completion is redeemed via
   * completeConnectHandoff(); the updated grant is then observable via subscribeConnectedAccounts().
   * Returning null also re-reads the account's description, so a list of granted resource types
   * that was out of date is corrected and observable the same way.
   */
  ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<ConnectFlowStart | null>;

  /**
   * List the auto-provisioning ("ambient") gatekeepers the user can opt into right now: those set to
   * 'optional' by the admin that the user hasn't added yet. Rendered as an "Available" section on the
   * Connectors page. ('enabled' ones are already provisioned; 'disabled' ones aren't offered.) Returns
   * the same shape as listGatekeeperVendors (with no resources) so the connect UI handles both
   * identically, routing on `description.autoProvisionsAccount`.
   */
  listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]>;

  /**
   * Opt into an ambient gatekeeper: mint its connected account for this user (no OAuth flow). Only
   * works while the vendor's mode is 'optional' (or 'enabled') and the user has no account yet; the
   * new account then appears via subscribeConnectedAccounts(). Throws otherwise.
   */
  provisionAmbientAccount(vendorId: string): Promise<void>;

  /**
   * Subscribe to the list of third-party accounts connected to the user's account.
   *
   * Dispose the returned stub to cancel the subscription.
   *
   * This is subscription-based because the flow to connect a new account completes in a separate
   * window. When it completes, we want the list of accounts in the Workshop UI to update
   * immediately, to give the user feedback that the account is now connected.
   */
  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>>;

  /** Remove a connected account, revoking the token. */
  disconnectAccount(accountId: number): Promise<void>;

  /**
   * Get the UI used to choose a specific resource from a connected account.
   *
   * `accountId` is the user's connected account that provides this resource.
   * `resourceUrlPattern` is the `urlPattern` associated with the supported resource.
   */
  startResourceConfigurator(
    accountId: number,
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame>;

  /**
   * Get the UI in which the approver of a creation of the type `resourceUrlPattern` configures it
   * in their connected account `accountId` (see SupportedResource.creationConfigurator). The
   * frame's collectResourceUrl() gives CreationApproval.configuration.
   */
  startCreationConfigurator(accountId: number, resourceUrlPattern: string)
      : Promise<GatekeeperUiFrame>;

  /**
   * Remove a shared gadget from the user's home page listing. Does NOT revoke the user's
   * access -- if they open the gadget again (e.g., via link), it reappears on their home page.
   */
  dismissSharedGadget(gadgetId: string): Promise<void>;

  /**
   * Re-authenticate a connected account whose credentials have expired (or may be about to
   * expire). Returns a flow to open as a disowned popup (as for connectAccount()). Once the OAuth
   * flow completes and the popup's /connect/handoff page redeems the handoff via
   * completeConnectHandoff(), the account is updated and subscribers are notified with
   * credentialsValid: true.
   */
  reconnectAccount(accountId: number): Promise<ConnectFlowStart>;

  // --- Gatekeeper management apps ---

  /**
   * List the gatekeepers that expose a full-page management UI (VendorDescription.providesUi) and are
   * available to this user. The Workshop renders a nav entry + page per entry. Independent of whether
   * the gatekeeper is a singleton.
   */
  listGatekeeperApps(): Promise<GatekeeperAppInfo[]>;

  /**
   * Get the app frame (self-contained iframe HTML + the gatekeeper's `ui` capability) for the given
   * gatekeeper id, or null if there is no such UI-providing gatekeeper. The Workshop hosts the HTML
   * in a sandboxed iframe and exposes `ui` to it over a MessagePort RPC session.
   */
  getGatekeeperApp(id: string): Promise<GatekeeperUiFrame | null>;

  /**
   * Mint a single-use ticket for a user selected on behalf of a gatekeeper app,
   * redeemable through that gatekeeper app's exchange capability (see
   * `GatekeeperUserSelectionExchange`). Returns null if the selected user does
   * not exist, or is outside the caller's directory scope (the active
   * co-members of their orgs, plus owners of workspaces shared with them) —
   * the same scope `searchUsers()` covers. The ticket records the orgs that
   * justified the pick, and redemption re-checks them live, so a pick dies
   * with the membership it was justified by.
   */
  createGatekeeperUserSelection(
      vendorId: string, selectedUserId: string,
  ): Promise<GatekeeperUserSelection | null>;

  // --- Deployment admin ---

  /**
   * Whether the current user is a deployment admin. Used by the client to decide whether to show
   * the admin UI.
   */
  amIAdmin(): Promise<boolean>;

  /**
   * Returns a capability for managing deployment-wide admin settings, or null when the caller is not
   * an admin. The access check happens once here, so the returned stub's methods need no per-call
   * checks. (Authentication config — sign-in providers, password login — is intentionally not
   * managed here; it stays env-var driven.)
   */
  getAdminApi(): Promise<RpcStub<AdminApi> | null>;

  // TODO:
  // - Edit permissions on a connected account.
}

/** Describes a gatekeeper's management app, for the Workshop nav + page. */
export type GatekeeperAppInfo = {
  /**
   * The vendor id (the GATEKEEPER_<ID> binding suffix, lowercased), used as the URL slug at
   * /gatekeepers/$id. This is the vendor, not a specific account: it assumes one management-UI
   * account per vendor per user, which holds for today's auto-provisioned singletons.
   */
  id: string;
  /** Title for the nav entry / page header. */
  title: string;
  /** Optional icon. */
  icon?: AvatarImage;
};

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------
// The org grammar and the org-management methods of AuthenticatedApi live in ./orgs.ts, the
// single home of the org-role grammar (import it rather than re-declaring the literals);
// re-exported here so this file stays the one import surface.

export type {
  OrgRole,
  OrgMemberStatus,
  OrgInvitePolicy,
  OrgMember,
  OrgSummary,
  OrgMembership,
} from "./orgs.js";
export { MAX_ORG_NAME_LENGTH } from "./orgs.js";

/**
 * The signed-in user's own profile and organization memberships, as returned by
 * `AuthenticatedApi.whoami()`. A wider view of `AiChatAuthorInfo` for the user themself; other
 * users' profiles never carry memberships.
 */
export type WhoamiInfo = AiChatAuthorInfo & {
  /** The user's org memberships at the time of the call (see `OrgMembership`). */
  orgs: OrgMembership[];
};

// ---------------------------------------------------------------------------
// SaaS commerce — org billing (see @gadgets/workshop-shared/commerce for the port)
// ---------------------------------------------------------------------------
// The billing display types and the commerce methods of AuthenticatedApi live in ./commerce.ts
// beside the port that consumes them; re-exported here so this file stays the one import
// surface.

export type {
  CommercePlan,
  OrgCommerceMember,
  OrgUsageSummary,
  OrgBillingOverview,
} from "./commerce.js";

// ---------------------------------------------------------------------------
// Context Library — pluggable separate worker (packages/gatekeeper-context)
// ---------------------------------------------------------------------------
//
// The Context Library lives in its own Worker, bound as the auto-provisioned gatekeeper
// GATEKEEPER_CONTEXT. Core implements none of its logic and owns none of its types (those live in
// the gatekeeper package): the account mints a management capability (the iframe app's `ui`, treated
// opaquely here) and a read session (the agent read-path, auto-provided as an unnamed capsule).


// ---------------------------------------------------------------------------
// Domain modules -- barrel re-exports
// ---------------------------------------------------------------------------
export * from "./sharing.js";
export * from "./admin.js";
export * from "./models.js";
export * from "./workspace.js";
export * from "./chats.js";
export * from "./workpieces.js";
export * from "./blueprints.js";
export * from "./clients.js";
export * from "./overseer.js";
