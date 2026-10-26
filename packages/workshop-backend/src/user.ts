import { RpcStub } from "capnweb";
import {GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, RedactedAiModelConfig, ModelKind, modelKind, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, OutputSummary, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, validateCommitEmail, NotificationSubscriber, NotificationMute, UserNotification, createPlanRefusalError, type DeviceSessionHandoffStart, type BotDefinition, type BotInfo, type BotSelection, type BotSkillChoice, type OrgMemberStatus, type OrgRole} from '@gadgets/workshop-shared/api';
import {Gatekeeper, GatekeeperUser, GatekeeperConnectCallback, ConnectHandoff, AppUiContext, GatekeeperUserSelection, GatekeeperUserSelectionExchange, RedeemedGatekeeperUserSelection} from "@gadgets/workshop-shared/gatekeeper";
import { ambientGatekeeperMode } from "./provisioning-policy.js";
import { isActiveMember } from "./org-access.js";
import { retryOnDoReset } from "./do-retry.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  makeUserStorage, type BlueprintUserRecord, type ConnectedAccountRecord,
  type GadgetRecord, type LoginSessionRecord,
  type PendingDeviceHandoffRecord, type PendingHandoffRecord, type OrgMembershipRecord,
  type UserAiModelRecord, type UserStorage,
  type WorkspaceOutputEntry,
} from "./storage-schema/user-storage.js";
import { allowedModelTiers } from "./user-plan.js";
import { UserBotStore, type ResolvedUserBot } from "./user-bots.js";
import { UserAccountStore } from "./user-accounts.js";
import { UserDirectoryScopeStore, type UserDirectoryScope } from "./user-directory-scope.js";
import { recordAnalytics } from "./analytics";
import { createWorkshopLogger } from "./observability";
import { getGatewayModels, type GatewayModels } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { deleteBlueprintContent } from "./blueprint-archive.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import { resolveBlueprintForUser } from "./blueprint-access.js";
import { readAdminConfig } from "./admin-config.js";
import { refuseUnverifiableWorkspaceCap, resolveEntitlements, workspaceCapFrom } from "./entitlements.js";
import { hashPresentedSecret, hashSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from "./connect-handoff.js";
import { deliver, registerDevice } from "./notification-service.js";
import {
  DEVICE_HANDOFF_LIFETIME_MS, isDeviceHandoffState, sealDeviceSessionHandoff,
  type DeviceSessionCredential, type DeviceSessionHandoff,
} from "./auth/device-session-handoff.js";

const logger = createWorkshopLogger("workshop.user");

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

/** Server-enforced lifetime of a Workshop session issued to a native device. */
export const DEVICE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;

/**
 * How long a user selection ticket (GatekeeperUserSelection) remains
 * redeemable.
 */
export const GATEKEEPER_USER_SELECTION_LIFETIME_MS = 30 * 60 * 1000;



// getSlashCommandProvider is optional on Gatekeeper (present exactly when the gatekeeper offers
// slash commands), so a facet that offers them is viewed through the required-method shape, the
// same derived Pick+Required view slash-commands.ts uses.
type SlashCommandGatekeeperStub = Fetcher<Gatekeeper<any> & Required<
  Pick<Gatekeeper<any>, "getSlashCommandProvider">
>>;


const withholdSecret = (secret: string) => secret === "" ? "" : null;

/** Withholds the non-empty secrets of `config`, for returning it to a client. */
function redactModelConfig(config: AiModelConfig): RedactedAiModelConfig {
  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: withholdSecret(apiToken),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name, withholdSecret(value)]))}),
  };
}

/**
 * Fills in the `null` secrets of `config` from `source`, throwing if `source` is absent or doesn't
 * hold them. Secrets only carry over to the endpoint they were configured for: otherwise a client
 * could point the model at its own server and receive them.
 */
function resolveWithheldSecrets(
    config: RedactedAiModelConfig, source?: AiModelConfig): AiModelConfig {
  let resolve = (secret: string | null, stored: string | undefined, what: string) => {
    if (secret !== null) return secret;
    if (!source) {
      throw new Error(`A value for ${what} is required.`);
    }
    if (source.provider !== config.provider || (source.apiUrl ?? "") !== (config.apiUrl ?? "")) {
      throw new Error(`Please re-enter ${what}, since the provider or API URL changed.`);
    }
    if (stored === undefined) {
      throw new Error(`There is no stored ${what} to keep.`);
    }
    return stored;
  };

  let storedHeader = (name: string) => source?.extraHeaders && Object.hasOwn(source.extraHeaders, name)
      ? source.extraHeaders[name] : undefined;

  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: resolve(apiToken, source?.apiToken, "the API token"),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) =>
            [name, resolve(value, storedHeader(name), `the value of header "${name}"`)]))}),
  };
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
  /** The bot the chat runs as, when one was selected at intake; `aiModel` is then its model. */
  bot?: ResolvedUserBot;
}

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}


/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private accounts: UserAccountStore;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  #notificationSubscribers = new Map<object, RpcStub<NotificationSubscriber>>();
  #bots: UserBotStore;
  #directory: UserDirectoryScopeStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.#bots = new UserBotStore(env, this.storage);
    this.#directory = new UserDirectoryScopeStore(ctx, this.storage);
    this.accounts = new UserAccountStore(ctx, env, this.storage, this.#directory,
        () => this.#armExpirySweep());
  }

  // -------------------------------------------------------------------------------------------
  // Connected-account RPC surface: thin delegators to #accounts (user-accounts.ts), which owns
  // the vendor map, the account records, ambient provisioning, and the connect-flow handoff.

  getCloudflareGatekeeperAccount() { return this.accounts.getCloudflareGatekeeperAccount(); }
  getCloudflareBilling() { return this.accounts.getCloudflareBilling(); }
  updateCloudflareCredits(creditsRemaining: number | null) {
    return this.accounts.updateCloudflareCredits(creditsRemaining);
  }
  setCloudflareAccountSelection(accountId: string, accountName?: string) {
    return this.accounts.setCloudflareAccountSelection(accountId, accountName);
  }

  listGatekeeperVendors(filter?: GatekeeperVendorFilter) {
    return this.accounts.listGatekeeperVendors(filter ?? {});
  }
  connectAccount(vendorId: string, resourceUrlPatterns?: string[]) {
    return this.accounts.connectAccount(vendorId, resourceUrlPatterns);
  }
  listAddableGatekeepers() { return this.accounts.listAddableGatekeepers(); }
  provisionAmbientAccount(vendorId: string) { return this.accounts.provisionAmbientAccount(vendorId); }
  listProvidedAccounts() { return this.accounts.listProvidedAccounts(); }
  getSingletonGatekeeperClass(accountId: number) {
    return this.accounts.getSingletonGatekeeperClass(accountId);
  }
  startAccountAppUi(accountId: number, options: Pick<AppUiContext, "isAdmin">) {
    return this.accounts.startAccountAppUi(accountId, options);
  }

  ensureAccountResources(accountId: number, resourceUrlPatterns: string[]) {
    return this.accounts.ensureAccountResources(accountId, resourceUrlPatterns);
  }
  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter) {
    return this.accounts.subscribeConnectedAccounts(subscriber, filter);
  }
  disconnectAccount(accountId: number) { return this.accounts.disconnectAccount(accountId); }
  reconnectAccount(accountId: number) { return this.accounts.reconnectAccount(accountId); }
  startResourceConfigurator(accountId: number, resourceUrlPattern: string) {
    return this.accounts.startResourceConfigurator(accountId, resourceUrlPattern);
  }
  startCreationConfigurator(accountId: number, resourceUrlPattern: string) {
    return this.accounts.startCreationConfigurator(accountId, resourceUrlPattern);
  }
  linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date) {
    return this.accounts.linkConnectedAccountFromLogin(account, vendorId, expiresAt);
  }
  putConnectedAccount(record: ConnectedAccountRecord) {
    return this.accounts.putConnectedAccount(record);
  }
  markCredentialsExpired(accountId: number) { return this.accounts.markCredentialsExpired(accountId); }
  markCredentialsRestored(accountId: number, expiresAt?: Date) {
    return this.accounts.markCredentialsRestored(accountId, expiresAt);
  }

  openConnectFlow(accountId: number) { return this.accounts.openConnectFlow(accountId); }
  stagePendingConnect(
      accountId: number, account: Fetcher<GatekeeperUser>, vendorId: string,
      credentialExpiresAt?: Date) {
    return this.accounts.stagePendingConnect(accountId, account, vendorId, credentialExpiresAt);
  }
  stagePendingRestore(accountId: number, stageId: string, credentialExpiresAt?: Date) {
    return this.accounts.stagePendingRestore(accountId, stageId, credentialExpiresAt);
  }
  completeConnectHandoff(ticket: string, nonce: string) {
    return this.accounts.completeConnectHandoff(ticket, nonce);
  }

  getGatekeeperClassFor(accountId: number, url: string) {
    return this.accounts.getGatekeeperClassFor(accountId, url);
  }
  createResourceGatekeeper(vendorId: string, resourceUrlPattern: string, title: string) {
    return this.accounts.createResourceGatekeeper(vendorId, resourceUrlPattern, title);
  }
  getVerifier(accountId: number, expectedVendorId: string) {
    return this.accounts.getVerifier(accountId, expectedVendorId);
  }
  selectableGatekeeperUsers(vendorId: string) {
    return this.accounts.selectableGatekeeperUsers(vendorId);
  }
  describeConnectedAccount(accountId: number) {
    return this.accounts.describeConnectedAccount(accountId);
  }


  async authenticate(token: string): Promise<void> {
    // A deprovisioned account is closed: any surviving record (e.g. staged before the flag was
    // set) must not authenticate. Same failure shape as any other bad token, so the client
    // simply signs out.
    if (this.storage.deprovisioned.get()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    const now = Date.now();
    if ((session.expiresAt && session.expiresAt.getTime() <= now) ||
        (session.pendingUntil && session.pendingUntil.getTime() <= now)) {
      this.storage.sessions.delete(tokenId);
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (session.pendingUntil) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    this.#directory.sync();
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    this.#refuseIfDeprovisioned();
    const isNew = !this.storage.created.get();
    if (isNew) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    this.#directory.sync();
    return isNew;
  }

  // Deprovisioning closes the account (see deprovision()): no sign-in path may create it again
  // or mint a new session afterwards.
  #refuseIfDeprovisioned(): void {
    if (this.storage.deprovisioned.get()) {
      throw new Error("This account has been deprovisioned and can no longer sign in.");
    }
  }

  async #newSessionToken(options: { expiresAt?: Date; pendingUntil?: Date } = {}): Promise<string> {
    let { secret, hash: tokenId } = await newSecretToken();
    this.storage.sessions.put({ tokenId, created: new Date(), ...options });
    return secret.toBase64();
  }

  /**
   * Stage an idempotent, single-use transfer without returning encrypted credentials to page
   * JavaScript. A Workshop session remains inactive until the HTTPS callback consumes the record;
   * an Access token is already bounded by its JWT expiry and is stored only inside `handoff`.
   */
  async stageDeviceSessionHandoff(publicKey: string, state: string, accessJwt?: string)
      : Promise<DeviceSessionHandoffStart> {
    if (!this.storage.created.get()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (!isDeviceHandoffState(state)) throw new Error("Invalid device sign-in state.");
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const existing = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.publicKey !== publicKey) {
        throw new Error("This device sign-in state is already bound to another key.");
      }
      // Reissue only the one-use ticket; a retry must not mint another credential or session.
      const { secret, hash: ticketHash } = await newSecretToken();
      this.storage.pendingDeviceHandoffs.put({ ...existing, ticketHash });
      return { userDoId: this.ctx.id.toString(), ticket: secret.toHex() };
    }
    if (existing) this.#dropPendingDeviceHandoff(existing);

    const { secret: ticket, hash: ticketHash } = await newSecretToken();
    const now = Date.now();
    const handoffExpiresAt = now + DEVICE_HANDOFF_LIFETIME_MS;
    let credential: DeviceSessionCredential;
    let sessionTokenId: string | undefined;
    let deviceSessionExpiresAt: number | undefined;
    if (accessJwt) {
      credential = { kind: "cloudflare-access", token: accessJwt };
    } else {
      const { secret, hash } = await newSecretToken();
      sessionTokenId = hash;
      deviceSessionExpiresAt = now + DEVICE_SESSION_LIFETIME_MS;
      credential = {
        kind: "workshop",
        token: `${this.storage.profile.get().id}:${secret.toBase64()}`,
        expiresAt: deviceSessionExpiresAt,
      };
    }
    const handoff = await sealDeviceSessionHandoff(
        publicKey, state, credential, handoffExpiresAt);
    if (sessionTokenId && deviceSessionExpiresAt) {
      this.storage.sessions.put({
        tokenId: sessionTokenId,
        created: new Date(now),
        expiresAt: new Date(deviceSessionExpiresAt),
        pendingUntil: new Date(handoffExpiresAt),
      });
    }
    this.storage.pendingDeviceHandoffs.put({
      stateHash,
      ticketHash,
      publicKey,
      handoff,
      expiresAt: new Date(handoffExpiresAt),
      sessionTokenId,
    });
    await this.#armExpirySweep();
    logger.info("device session handoff staged", {
      event: "auth.device_handoff.staged",
      credentialKind: credential.kind,
    });
    return { userDoId: this.ctx.id.toString(), ticket: ticket.toHex() };
  }

  /** Consume a staged handoff once and activate its pending Workshop device session, if any. */
  async consumeDeviceSessionHandoff(state: string, ticket: string): Promise<DeviceSessionHandoff | null> {
    if (!isDeviceHandoffState(state)) return null;
    const presentedHash = hashPresentedSecret(ticket);
    if (!presentedHash) return null;
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const pending = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
      this.#dropPendingDeviceHandoff(pending);
      await this.#armExpirySweep();
      return null;
    }
    if (pending.ticketHash !== await presentedHash) return null;
    this.storage.pendingDeviceHandoffs.delete(stateHash);
    if (pending.sessionTokenId) {
      const session = this.storage.sessions.get(pending.sessionTokenId);
      if (!session || !session.pendingUntil || session.pendingUntil.getTime() <= Date.now()) {
        if (session) this.storage.sessions.delete(pending.sessionTokenId);
        await this.#armExpirySweep();
        return null;
      }
      const { pendingUntil: _pendingUntil, ...active } = session;
      this.storage.sessions.put(active);
    }
    await this.#armExpirySweep();
    logger.info("device session handoff consumed", {
      event: "auth.device_handoff.consumed",
      credentialKind: pending.sessionTokenId ? "workshop" : "cloudflare-access",
    });
    return pending.handoff;
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Deletes every session record — browser and device sessions alike — plus every staged device
   * handoff and gatekeeper user-selection ticket, and returns how many session records were
   * deleted. Sessions are validated per request with no cache, so a deleted record fails on the
   * caller's very next `authenticate()`; a staged handoff's ticket can no longer be consumed
   * either, and the session it had staged dies with it (see `#dropPendingDeviceHandoff`).
   */
  async revokeAllSessions(): Promise<number> {
    // Snapshot the ids first: the handoff loop below deletes staged sessions itself, and the
    // loops must not iterate a collection they are mutating.
    let tokenIds = [...this.storage.sessions.list()].map(session => session.tokenId);
    for (let pending of this.storage.pendingDeviceHandoffs.list()) {
      this.#dropPendingDeviceHandoff(pending);
    }
    for (let selection of this.storage.pendingUserSelections.list()) {
      this.storage.pendingUserSelections.delete(selection.ticketHash);
    }
    for (let tokenId of tokenIds) {
      this.storage.sessions.delete(tokenId);
    }
    await this.#armExpirySweep();
    return tokenIds.length;
  }

  /**
   * Every current session record, for an admin surface to list "signed-in browsers and devices".
   * Metadata only: the tokens themselves are unrecoverable by design (only their SHA-256 hash is
   * stored), so a listing cannot be turned into access. `pendingUntil` marks a device session
   * staged but not yet activated by its handoff.
   */
  async listSessions(): Promise<LoginSessionRecord[]> {
    return [...this.storage.sessions.list()];
  }

  /**
   * Closes the account and severs everything that outlives a session:
   *
   * - every session and staged handoff/selection (revokeAllSessions, so the next `authenticate()`
   *   fails and no staged device handoff can be consumed);
   * - every connected gatekeeper account, revoked best-effort like `disconnectAccount()` (a
   *   gatekeeper that throws must not block the rest) and then deleted;
   * - the password (`passwordHashHash` nulled, so `login()` can never succeed again);
   * - push subscriptions, AI Gateway billing state and the daily LLM counter;
   * - the `deprovisioned` flag, set first so every sign-in path (password, gatekeeper, Cloudflare
   *   Access) refuses even if a later step stalls;
   * - the deployment-wide directory, where the user is flagged so collaborator search hides them
   *   (the counterpart of `#syncDirectory()`);
   * - every workspace shared *with* the user, whose collaborator edges are severed so each
   *   affected workspace force-restarts and the user's live chat sessions die with it (see
   *   `#severSharedWorkspaceAccess`);
   * - every org the user belonged to, which they leave so directory scopes, picker
   *   justifications and org-owned workspace baselines stop naming them (see
   *   `#leaveOrgsOnDeprovision`).
   *
   * Not touched: short-lived connect handoffs and flows (the alarm sweep owns those), and the
   * user's own workspaces and data — deprovisioning removes access, not content. Idempotent:
   * a second call finds nothing left to remove.
   */
  async deprovision(): Promise<void> {
    // Flag first, before any await: once set, no authentication path can mint a new session, so a
    // deprovision that stalls partway still leaves the account closed.
    this.storage.deprovisioned.put(true);
    await this.revokeAllSessions();
    // Every gatekeeper account revoked in parallel, best-effort per account like
    // #severSharedWorkspaceAccess: a gatekeeper that throws (or has nothing to revoke) must not
    // block the rest of the teardown — the record still goes, and with it the capability.
    let accounts = [...this.storage.connectedAccounts.list()];
    let revocations = await Promise.allSettled(accounts.map(account => account.account.revoke()));
    for (let [index, result] of revocations.entries()) {
      if (result.status === "rejected") {
        let { vendorId, id } = accounts[index]!;
        logger.error("revoke() failed during deprovision", {
          event: "account.revoke.failed",
          vendorId, accountId: id, error: result.reason,
        });
      }
    }
    for (let account of accounts) this.storage.connectedAccounts.delete(account.id);
    this.storage.passwordHashHash.put(null);
    this.storage.notificationSubscriptions.put({});
    this.storage.cloudflareBilling.put(null);
    this.storage.dailyLlmCount.put(null);
    if (this.storage.created.get()) {
      // Only a created account has a directory record (or a real profile id to flag).
      try {
        await this.ctx.exports.UserDirectoryDurableObject.getByName("")
            .markUserDeprovisioned(this.storage.profile.get().id, true);
      } catch (error) {
        logger.warn("failed to flag deprovisioned user in the directory", {
          event: "user.directory.deprovision.failed",
          error,
        });
      }
    }
    // Independent teardowns of what the account leaves behind — shared workspaces' collaborator
    // edges, org memberships — run concurrently (each is already best-effort per item), so one
    // slow cross-DO hop doesn't serialize the whole deprovision behind it.
    await Promise.allSettled([this.#severSharedWorkspaceAccess(), this.#leaveOrgsOnDeprovision()]);
    logger.info("user deprovisioned", { event: "user.deprovisioned" });
  }

  /**
   * Leaves every org the user belonged to, so a closed account does not linger there as an
   * "active" member: co-members' directory scopes, picker-ticket justifications, and org-owned
   * workspaces' baselines all read the org's own member records, and each leave ends the
   * membership, mirrors this index entry away, and severs the org's workspaces in one move
   * (OrgDurableObject.memberLeave). Best-effort per org, like #severSharedWorkspaceAccess: a
   * leave that fails, or is refused because the user is the org's sole active owner (the org
   * keeps an unreachable owner rather than none, per org-access.ts), leaves a member record
   * nothing can exercise — the deprovisioned user can no longer authenticate, and any org admin
   * may still remove the record by hand. Pending invitations are declined the same way, unless
   * the account was never created (no profile id to leave under), in which case the org's own
   * expiry sweep reclaims them.
   */
  async #leaveOrgsOnDeprovision(): Promise<void> {
    const me = this.storage.profile.get()?.id;
    if (me === undefined) return;
    await Promise.all([...this.storage.orgMemberships.list()].map(async entry => {
      try {
        await this.ctx.exports.OrgDurableObject.getByName(entry.orgId).memberLeave(me);
      } catch (error) {
        logger.warn("failed to remove a deprovisioned user from an organization", {
          event: "deprovision.org.leave.failed",
          orgId: entry.orgId, error,
        });
      }
    }));
  }

  /**
   * Removes the user's collaborator edges from every workspace that was shared with them, so each
   * affected workspace force-restarts (`scheduleAccessRestart`) and the user's live chat sessions
   * die with the restart rather than at their next re-open. Best-effort per workspace: one that
   * cannot be reached keeps its stale edge, which grants nothing — the deprovisioned user can no
   * longer open anything.
   *
   * Two lazy residuals are accepted, consistent with the sharing model's revocation contract
   * (docs/sharing.md, docs/observers.md): only workspaces the user has *opened* are known here
   * (the gadgets index is written on open), so an edge for a share they never opened lingers
   * until its owner removes it — inert, for the same reason; and the post-restart cleanup the
   * restart can cut off (observer teardown, listing refresh) self-heals lazily, exactly as in
   * `removeCollaborator()`.
   */
  async #severSharedWorkspaceAccess(): Promise<void> {
    let profileId = this.storage.profile.get().id;
    let shared = [...this.storage.gadgets.list()].filter(record => record.owner);
    if (shared.length === 0) return;
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(shared.map(workspace =>
        overseers.get(overseers.idFromString(workspace.id))
            .severCollaboratorAccess(profileId)));
    for (let i = 0; i < results.length; i++) {
      let result = results[i];
      if (result.status === "rejected") {
        logger.warn("failed to sever deprovisioned user's workspace access", {
          event: "deprovision.workspace.sever.failed",
          gadgetId: shared[i].id, error: result.reason,
        });
      }
    }
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    this.#refuseIfDeprovisioned();
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: this.ctx.id.toString(),
        source: "gatekeeper",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: this.ctx.id.toString(),
      source: "gatekeeper",
    });
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  /** Exchange the native app's one-time device registration for that device's push subscription. */
  async registerNotificationDevice(deviceRegistrationId: string): Promise<void> {
    let { deviceKey, subscriptionId } = await registerDevice(this.env, deviceRegistrationId);
    this.storage.notificationSubscriptions.put(
        { ...this.storage.notificationSubscriptions.get(), [deviceKey]: subscriptionId });
  }

  /** Subscribe a visible authenticated client to live user notifications. */
  async subscribeToNotifications(
      subscriber: RpcStub<NotificationSubscriber>): Promise<RpcStub<{}>> {
    subscriber = subscriber.dup();
    let token = {};
    this.#notificationSubscribers.set(token, subscriber);
    let unsubscribe = () => {
      let existing = this.#notificationSubscribers.get(token);
      if (!existing) return;
      this.#notificationSubscribers.delete(token);
      existing[Symbol.dispose]();
    };
    subscriber.onRpcBroken(unsubscribe);
    return new RpcStub<{}>({ [Symbol.dispose]: unsubscribe });
  }

  /** See `AuthenticatedApi.setWorkspaceNotificationMute()`. */
  async setWorkspaceNotificationMute(workspaceId: string, mute: NotificationMute | null)
      : Promise<void> {
    let record = this.storage.gadgets.get(workspaceId);
    if (!record) throw new Error("No such workspace belonging to user.");
    record.notificationMute = mute ?? undefined;
    this.storage.gadgets.put(record);
  }

  /**
   * Offer a notification to visible clients; push it to every registered device unless one
   * acknowledges within 3s. A finished task in a workspace the user muted goes nowhere.
   */
  async publishNotification(notification: UserNotification): Promise<void> {
    let mute = this.storage.gadgets.get(notification.workspaceId)?.notificationMute;
    if (notification.kind === "taskCompleted" && mute &&
        ("indefinite" in mute || mute.until.getTime() > Date.now())) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = await Promise.race([
      Promise.any([...this.#notificationSubscribers.values()]
          .map(subscriber => subscriber.notify(notification))).then(() => true, () => false),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 3_000); }),
    ]).finally(() => clearTimeout(timeout));
    if (acknowledged) return;
    let subscriptions = Object.entries(this.storage.notificationSubscriptions.get());
    let results = await Promise.allSettled(subscriptions.map(async ([deviceKey, subscriptionId]) => {
      if (await deliver(this.env, subscriptionId, notification)) return;
      // This subscription is dead; the device gets a new one when its app next opens. Keep one it
      // registered while this delivery was in flight.
      let { [deviceKey]: current, ...others } = this.storage.notificationSubscriptions.get();
      if (current === subscriptionId) this.storage.notificationSubscriptions.put(others);
    }));
    for (let result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  /**
   * Called by the overseer every time a collaborator opens a shared gadget.
   * Creates the record on first open; updates lastActive on subsequent opens.
   *
   * `role` is cached so listings built from this DO can offer the actions it permits without
   * reopening the workspace to ask. Presentation only: every operation is still authorized by the
   * Overseer when attempted.
   */
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this workspace; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      record.role = role;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        created: now,
        lastActive: now,
      });
    }
  }

  /**
   * Updates the presentation-only role cached for a shared workspace listing. Authorization still
   * comes from the Overseer's live sharing graph; this only keeps the listing's available actions
   * accurate after a collaborator is downgraded.
   */
  async updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record?.owner) return;
    record.role = role;
    this.storage.gadgets.put(record);
  }

  /**
   * Forgets a gadget shared with this user: drops it from their workspace listing and its outputs
   * from their Outputs index. Called both when the user dismisses it and when their access is
   * revoked (Overseer.refreshAffectedCollaboratorListings()); it grants and revokes nothing.
   */
  async forgetSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
      this.storage.outputs.byWorkspace.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
    this.storage.profileRev.put(this.storage.profileRev.get() + 1);
    this.#directory.sync();
  }

  async setOwnCommitEmail(email: string | null): Promise<void> {
    let profile = this.storage.profile.get();
    if (email === null) {
      delete profile.commitEmail;
    } else {
      validateCommitEmail(email);
      profile.commitEmail = email;
    }
    this.storage.profile.put(profile);
  }

  async listModels(kind: ModelKind = "language"): Promise<AiChatAuthorInfo[]> {
    return this.#listModels(await getGatewayModels(this.env), kind,
        await allowedModelTiers(this.env, this.ctx.id.toString()));
  }

  #listModels(models: GatewayModels | null, kind: ModelKind,
              tiers: ReadonlySet<string> | null): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];

    // When AI Gateway mode is active, include the gateway models the deployment offers, less
    // any the user's plan may not run.
    if (models) {
      for (let model of models.list(kind)) {
        let tier = models.get(model.id)?.tier;
        if (this.#tierAllowed(tier, tiers)) {
          result.push(model);
        }
      }
    }

    // Also include user-configured models, where users may add their own, skipping any that a
    // gateway model shadows, whatever its mode (see #resolveModel()).
    if (models && !models.userModels) return result;
    for (let model of this.storage.aiModels.list()) {
      if (!models?.get(model.profile.id) &&
          modelKind(model.config.provider, model.config.model) === kind) {
        result.push(model.profile);
      }
    }
    return result;
  }

  /**
   * Whether the user's plan may run a model of `tier`: a model that states no catalog tier, and
   * every model while no entitlements service is bound (see #allowedModelTiers), is never
   * tier-gated. The one home of the plan's model gate — listing (#listModels), refusing
   * (#requireModel) and availability (#botInfo) all ask it, so the three cannot drift.
   */
  #tierAllowed(tier: string | undefined, tiers: ReadonlySet<string> | null): boolean {
    return tier === undefined || tiers === null || tiers.has(tier);
  }

  async addModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig,
                 copySecretsFrom?: string): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let source: AiModelConfig | undefined;
    if (copySecretsFrom !== undefined) {
      source = this.#getHandAddedModel(copySecretsFrom, models).config;
    }
    // A gateway model, whatever its mode, would shadow the new model and leave it unreachable.
    if (this.storage.aiModels.get(profile.id) || models?.get(profile.id)) {
      throw new Error(`A model with ID "${profile.id}" already exists.`);
    }
    this.#putModel(profile, resolveWithheldSecrets(config, source), models);
  }

  async getModelConfig(id: string): Promise<{profile: AiChatAuthorInfo, config: RedactedAiModelConfig}> {
    let {profile, config} = this.#getHandAddedModel(id, await getGatewayModels(this.env));
    return {profile, config: redactModelConfig(config)};
  }

  async updateModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let stored = this.#getHandAddedModel(profile.id, models).config;
    if (config.provider !== stored.provider || config.model !== stored.model) {
      throw new Error("A model's provider and model ID can't be changed.");
    }
    this.#putModel(profile, resolveWithheldSecrets(config, stored), models);
  }

  /** The stored record of a model the user added, throwing for AI Gateway models. */
  #getHandAddedModel(id: string, models: GatewayModels | null): UserAiModelRecord {
    let record = this.storage.aiModels.get(id);
    // A stored model sharing a gateway model's ID is shadowed by it (see listModels()).
    if (!record || models?.get(id)) {
      throw new Error(`No such hand-added model: ${id}`);
    }
    return record;
  }

  #putModel(profile: AiChatAuthorInfo, config: AiModelConfig, models: GatewayModels | null) {
    if (models && !models.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }
    for (let limit of [config.contextWindow, config.outputLimit]) {
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
        throw new Error("Token limits must be positive integers.");
      }
    }

    // capnweb-validate lets through properties that RedactedAiModelConfig omits, and these are a
    // deployment's to set on its own models.
    let {reasoning, compactionInputBudget, behavesLike, capabilities, ...own} = config;

    profile.type = "agent";
    this.storage.aiModels.put({profile, config: own});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting the gateway's own models, whatever their mode.
    let model = (await getGatewayModels(this.env))?.get(id);
    if (model) throw new Error(`Cannot delete built-in model "${model.name}".`);

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.storage.aiModels.get(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Any model that resolves is accepted, hidden ones included (see getExternalMessageChatContext()).
      if (!this.#resolveModel(id, await getGatewayModels(this.env))) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }


  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  /** Read the current daily quota state without counting a call. */
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  /**
   * Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
   * pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
   * so a blocked request never counts.
   */
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. Pure read: call sites replay it across DO resets
   * via retryOnDoReset, so it must stay free of writes and side effects.
   *
   * `bot` names a declared bot to run the chat as (see listBots) and wins over `modelId`: the
   * chat runs on the bot's declared model. A bot or model that no longer resolves throws visibly
   * here, never a silent fallback to another model. */
  async getChatContext(modelId: string | null, bot?: BotSelection): Promise<UserChatContext> {
    let [models, tiers] = await Promise.all(
        [getGatewayModels(this.env), allowedModelTiers(this.env, this.ctx.id.toString())]);
    let result = this.#getChatContext(bot === undefined ? modelId : null, models, tiers);
    if (bot !== undefined) {
      result.bot = await this.#bots.resolve(bot);
      result.aiModel = this.#requireModel(result.bot.modelId, models, tiers);
    }
    return result;
  }

  #getChatContext(modelId: string | null, models: GatewayModels | null,
                 tiers: ReadonlySet<string> | null): UserChatContext {
    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = this.#requireModel(modelId, models, tiers);
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (models) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = models.gateway.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.storage.aiModels.get(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }
    return result;
  }

  // Resolve a model ID the way chats do (see #resolveModel), refusing visibly -- with the most
  // specific reason the ID doesn't resolve -- when it doesn't. Shared by the plain-model and bot
  // paths of getChatContext, so a bot's model refuses exactly like a hand-picked one. A gateway
  // model whose catalog tier the user's plan doesn't include refuses here too (see
  // #allowedModelTiers), so a chat naming one — an existing chat after a downgrade, say — fails
  // visibly rather than silently running a different model.
  #requireModel(id: string, models: GatewayModels | null,
               tiers: ReadonlySet<string> | null): UserAiModelRecord {
    let record = this.#resolveModel(id, models);
    if (record) {
      let tier = models?.get(id)?.tier;
      if (!this.#tierAllowed(tier, tiers)) {
        throw createPlanRefusalError("MODEL_NOT_ON_PLAN",
            `The "${record.profile.name}" model isn't available on your plan.`);
      }
      return record;
    }
    models?.refuseDisabled(id);
    // No gateway model has the ID, so a stored model with it is one the deployment keeps
    // users from running.
    let stored = this.storage.aiModels.get(id);
    if (stored) models?.refuseUserModel(stored.profile.name);
    throw new Error(`No such model: ${id}`);
  }


  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    // An existing chat keeps its model while it still resolves, even once no longer offered. A new
    // conversation takes the user's preferred model only while it is still offered, as the web
    // composer does with its stored choice, and otherwise the first available model.
    let [models, tiers] = await Promise.all(
        [getGatewayModels(this.env), allowedModelTiers(this.env, this.ctx.id.toString())]);
    let selectedModelId = existingChatModelId;
    if (selectedModelId === null || !this.#resolveModel(selectedModelId, models)) {
      let offered = this.#listModels(models, "language", tiers);
      let preferredModel = this.storage.preferredModel.get();
      selectedModelId = (offered.find(model => model.id === preferredModel) ?? offered[0])?.id ?? null;
    }

    return this.#getChatContext(selectedModelId, models, tiers);
  }

  /**
   * Resolve a model ID the way chats do: a gateway model shadows a stored model with the same ID
   * whatever its mode, so a disabled one resolves to nothing rather than to the stored model. No
   * stored model resolves on a gateway deployment whose users may not add their own.
   */
  #resolveModel(id: string, models: GatewayModels | null): UserAiModelRecord | undefined {
    if (models?.get(id)) return models.resolve(id);
    return models && !models.userModels ? undefined : this.storage.aiModels.get(id);
  }

  // --- Declared bots (see the Bot* types in @gadgets/workshop-shared/api) ---

  /**
   * List the bots offered to this user: their own plus the deployment's, merged. A bot whose
   * model no longer resolves for this user is listed `available: false` (with the reason) rather
   * than dropped, so it stays visible wherever it was picked and its chats refuse visibly at
   * start instead of mysteriously changing agent.
   */
  async listBots(): Promise<BotInfo[]> {
    let [models, tiers] = await Promise.all(
        [getGatewayModels(this.env), allowedModelTiers(this.env, this.ctx.id.toString())]);
    let result: BotInfo[] = [];
    for (let record of this.#bots.list()) {
      result.push(this.#botInfo({scope: "user", id: record.id}, record.def, models, tiers));
    }
    for (let {id, def} of (await readAdminConfig(this.env)).deploymentBots) {
      result.push(this.#botInfo({scope: "deployment", id}, def, models, tiers));
    }
    return result;
  }

  #botInfo(selection: BotSelection, def: BotDefinition, models: GatewayModels | null,
           tiers: ReadonlySet<string> | null): BotInfo {
    let model = this.#resolveModel(def.modelId, models);
    // A model the user's plan may not run makes the bot unavailable exactly like one that no
    // longer resolves, so the listing never offers a bot its chat would refuse to start.
    let tier = model ? models?.get(def.modelId)?.tier : undefined;
    let runnable = model !== undefined && this.#tierAllowed(tier, tiers);
    return {
      selection,
      name: def.name,
      ...(def.description ? {description: def.description} : {}),
      modelId: def.modelId,
      ...(model ? {modelName: model.profile.name} : {}),
      available: runnable,
      ...(runnable ? {} : {unavailableReason: "Model not available to you"}),
    };
  }

  /** One of this user's own bots' definitions, as stored (deployment bots are listBots' metadata). */
  async getBot(id: string): Promise<BotDefinition> {
    return this.#bots.get(id);
  }

  /** Create a bot owned by this user, returning its id. The name must be unique among the user's
   * own bots; the definition is capped and trimmed by normalizeBotDefinition. */
  async createBot(def: BotDefinition): Promise<string> {
    return this.#bots.create(def);
  }

  /** Replace one of this user's own bots' definitions, keeping its id (and so every chat's
   * selection of it) stable. */
  async updateBot(id: string, def: BotDefinition): Promise<void> {
    this.#bots.update(id, def);
  }

  /** Delete one of this user's own bots. Chats that used it keep their frozen snapshot, so this
   * is a no-op on an already-deleted bot. */
  async deleteBot(id: string): Promise<void> {
    this.#bots.delete(id);
  }


  /**
   * List the skills this user can declare on a bot: the slash commands offered by their
   * connected accounts' agent singletons (e.g. the Context Library), each carrying the vendor id
   * a BotSkillRef stores. A vendor whose singleton can't be reached -- its class won't mint, its
   * provider won't load -- is skipped, not fatal, exactly like the slash-command catalog.
   */
  async listBotSkills(): Promise<BotSkillChoice[]> {
    // Self-sufficient like listGatekeeperApps: ambient singletons (Context) are provisioned
    // first (idempotent), so the list works even before the user has opened a workspace.
    await this.accounts.ensureAutoProvisionedAccounts();
    let config = await readAdminConfig(this.env);

    let perAccount = await Promise.all([...this.accounts.connectedAccountRecords()].map(async record => {
      if (!record.description.singleton) return [];
      // A "disabled" ambient gatekeeper's account stays dormant (the same test
      // listProvidedAccounts applies): its skills are not offerable while disabled.
      if (record.autoProvisioned && ambientGatekeeperMode(config, record.vendorId) === "disabled") {
        return [];
      }
      try {
        let cls = await this.accounts.getSingletonGatekeeperClass(record.id);
        if (!cls) return [];
        // The singleton runs as a facet of this DO, in the gatekeeper's own worker, exactly as
        // the overseer installs it -- only the class reference crosses over.
        let facet = this.ctx.facets.get<Gatekeeper<any>>(`botSkills${record.id}`, () => ({class: cls}));
        using provider =
            await (facet as unknown as SlashCommandGatekeeperStub).getSlashCommandProvider();
        let providerLabel = record.description.displayName
            ?? record.description.uniqueName ?? record.vendorId;
        let commands = await provider.list();
        return commands.map(command => ({
          vendorId: record.vendorId,
          commandId: command.id,
          name: command.name,
          description: command.description,
          providerLabel,
        }));
      } catch (err) {
        // "Does not implement the method" is how a singleton without slash commands answers
        // (most do not offer any); that absence is expected, so it is not worth a warning.
        let absent = err instanceof TypeError && /does not implement/.test(err.message);
        logger[absent ? "debug" : "warn"]("skipping bot-skill provider", {
          event: "bot.skill.provider.skipped", vendorId: record.vendorId,
          accountId: record.id, error: absent ? undefined : err,
        });
        return [];
      }
    }));

    return perAccount.flat().toSorted((left, right) =>
      left.name.localeCompare(right.name) || left.commandId.localeCompare(right.commandId));
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let result: GadgetMetadataWithTimestamps[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget)) {
        result.push(gadget);
      }
    }
    return result;
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    // Idempotent: a retried creation of the same workspace is completing one that already
    // counts, not adding another, so it is never re-refused by the cap below (an external
    // message that died between registering a workspace and claiming it retries through here).
    if (this.storage.gadgets.get(id)) return;

    // A bound SaaS's plan may cap how many workspaces a user owns; counted are only the rows
    // without an `owner` — the user's own, never ones shared with them. The cap is folded from
    // the answer once (see workspaceCapFrom): an unavailable port refuses creation (fail
    // closed). The cap governs *creating* a workspace only; registering one that already
    // exists is ensureGadgetRegistered(), which is never capped.
    let gate = workspaceCapFrom(await resolveEntitlements(this.env, this.ctx.id.toString()));
    refuseUnverifiableWorkspaceCap(gate, "created");
    if (gate.status === "capped") {
      let owned = [...this.storage.gadgets.list()].filter(record => !record.owner).length;
      if (owned >= gate.cap) {
        throw createPlanRefusalError("WORKSPACE_CAP_REACHED",
            `You've reached your plan's limit of ${gate.cap} workspaces.`);
      }
    }
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }

  async ensureGadgetRegistered(id: string, title: string): Promise<void> {
    // Registers a workspace that already exists — its Overseer holds state — so the plan's
    // workspace cap never applies here: refusing could not undo the workspace, and the cap
    // decision belongs before the workspace is created (newGadget, which the external-message
    // path consults before claiming one).
    if (this.storage.gadgets.get(id)) return;
    this.storage.gadgets.put({id, title, created: new Date()});
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
    this.storage.outputs.byWorkspace.delete(id);
  }

  /**
   * Replace the set of outputs recorded for one workspace. Called by that workspace's Overseer
   * whenever its gadget registry changes and whenever it is opened.
   *
   * A workspace the user no longer tracks (deleted, or a shared one they dismissed) has its
   * entries dropped.
   */
  syncWorkspaceOutputs(workspaceId: string, entries: WorkspaceOutputEntry[]): void {
    this.storage.outputs.byWorkspace.delete(workspaceId);
    if (!this.storage.gadgets.get(workspaceId)) return;
    for (let entry of entries) {
      this.storage.outputs.put({...entry, workspaceId});
    }
  }

  /**
   * Mirror one organization membership into this user's index, or drop it with null. Called by
   * the org's Durable Object whenever the membership changes (see OrgDurableObject). The org is
   * the authority; this index only lets listMyOrgs find the orgs in one read of the user's own
   * object, and every entry is re-checked against its org when read.
   */
  syncOrgMembership(
      orgId: string, membership: { role: OrgRole; status: OrgMemberStatus } | null): void {
    if (membership === null) {
      this.storage.orgMemberships.delete(orgId);
    } else {
      this.storage.orgMemberships.put({ orgId, ...membership });
    }
  }

  /** The user's mirrored org memberships (see syncOrgMembership), sorted by org id. */
  listOrgMemberships(): OrgMembershipRecord[] {
    return [...this.storage.orgMemberships.list()];
  }


  async listOutputs(): Promise<ListOutputsResult> {
    let catchingUp = await this.#backfillOutputs();
    return {outputs: this.#readOutputs(), catchingUp};
  }

  // Ask the user's pre-existing workspaces to populate the outputs index, once. Workspaces push as
  // they change and when opened, so only those predating the index need this.
  //
  // Sweeps one bounded page and reports whether more remains, rather than sweeping everything: a
  // first Outputs load must not wait on every workspace the user has ever created. The caller
  // drains the rest, so the list fills in while the page is open.
  async #backfillOutputs(): Promise<boolean> {
    if (this.storage.outputsBackfilled.get()) return false;

    let startAfter = this.storage.outputsBackfillCursor.get() || undefined;
    let cursor = startAfter ?? "";
    let targets: string[] = [];
    let examined = 0;
    for (let gadget of this.storage.gadgets.list({startAfter, limit: OUTPUTS_BACKFILL_PAGE})) {
      ++examined;
      cursor = gadget.id;
      // A shared workspace is mirrored on open, not swept; a half-created one has nothing yet.
      if (!gadget.owner && isFullyCreated(gadget)) targets.push(gadget.id);
    }
    let done = examined < OUTPUTS_BACKFILL_PAGE;

    let ownerId = this.ctx.id.toString();
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(targets.map(id =>
        overseers.get(overseers.idFromString(id)).getOutputsForOwnerBackfill(ownerId)));

    let failureCount = 0;
    let firstError: unknown;
    for (let [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (result.value) this.syncWorkspaceOutputs(targets[index], result.value);
      } else {
        if (failureCount === 0) firstError = result.reason;
        ++failureCount;
      }
    }

    if (failureCount > 0) {
      logger.warn("failed to backfill outputs for some workspaces", {
        event: "outputs.backfill.partial",
        failureCount,
        error: firstError,
      });
    }

    // Advance past workspaces that failed, rather than retrying them. The index is self-healing,
    // so one missed here reappears the moment it is touched, whereas holding the cursor lets a
    // single unwakeable workspace stall the sweep forever.
    if (done) {
      this.storage.outputsBackfilled.put(true);
    } else {
      this.storage.outputsBackfillCursor.put(cursor);
    }

    // A page where everything failed looks systemic, so stop draining and let the next visit pick
    // up from the next page: draining on would be a burst of doomed calls during an outage.
    if (failureCount > 0 && failureCount === targets.length) return false;
    return !done;
  }

  #readOutputs(): OutputSummary[] {
    let result: OutputSummary[] = [];
    for (let output of this.storage.outputs.list()) {
      let workspace = this.storage.gadgets.get(output.workspaceId);
      if (!workspace || !isFullyCreated(workspace)) continue;
      result.push({
        workspaceId: output.workspaceId,
        workpieceId: output.workpieceId,
        ...(output.output ? {output: output.output} : {}),
        title: output.title,
        workspaceTitle: workspace.title,
        created: output.created,
        lastActive: workspace.lastActive,
        ...(workspace.owner ? {owner: workspace.owner} : {}),
        ...(workspace.role ? {role: workspace.role} : {}),
      });
    }
    result.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return result;
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    // The blueprint may belong to one of the user's orgs, so this is the member-gated read.
    let kvRecord = await resolveBlueprintForUser(
        this.env, this.ctx.exports.OrgDurableObject,
        [...this.storage.orgMemberships.list()].map(entry => entry.orgId), this.ctx.id.name!, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    let orgOwner = kvRecord.owner?.type === "org" ? kvRecord.owner.id : undefined;
    if (existing) {
      existing.metadata = kvRecord.metadata;
      existing.orgOwner = orgOwner;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
      // The org whose member this blueprint belongs to, if any: the listing's live gate.
      orgOwner,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.owner?.type !== "user" || kvRecord.owner.id !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      await deleteBlueprintContent(this.env, kvRecord.owner, id);
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    // An org-owned entry is gated live, like every org read (the lazy-revocation contract,
    // docs/tenancy.md): the record names the org whose member added it, and the listing asks
    // that org again, so a removed member's entry is withheld. The record is kept -- a re-add
    // restores the listing, and opening re-resolves regardless -- and records written before
    // the gate name no org, so they list as they always did.
    let me = this.ctx.id.name!;
    // Every distinct org's gate is asked at once (the mirror image of server.ts's concurrent
    // describeForMember fanout), rather than org N+1's gate starting only after org N's
    // resolves. Each is a pure read, retried across an org-DO reset, memoized per org; an
    // unreadable org answers as if removed, so the listing fails closed.
    let memberOf = new Map<string, Promise<boolean>>();
    let askOrg = (orgId: string) => {
      let gate = memberOf.get(orgId);
      if (gate === undefined) {
        gate = retryOnDoReset(() =>
            this.ctx.exports.OrgDurableObject.getByName(orgId).getMember(me))
            .then(isActiveMember, () => false);
        memberOf.set(orgId, gate);
      }
      return gate;
    };
    for (let record of this.storage.libraryBlueprints.list()) {
      if (record.orgOwner !== undefined && !(await askOrg(record.orgOwner))) continue;
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }








  /**
   * The caller's directory scope (see `UserDirectoryScope`), as `searchUsers` and the gatekeeper
   * user picker compute it. The user's mirrored membership index names the orgs; each org's own
   * member listing — an actor-checked read, so it re-checks this membership live — names the
   * people. An org that cannot be read (the index is stale, the membership ended, or the read
   * failed) contributes nothing: the scope fails closed, so an unreachable org can only shrink
   * discovery, never widen it.
   */
  async getDirectoryScope(): Promise<UserDirectoryScope> {
    return this.#directory.scope();
  }


  /**
   * Mint a single-use ticket for a user selected on behalf of a gatekeeper app,
   * redeemable through that gatekeeper app's exchange capability (see
   * GatekeeperUserSelectionExchangeImpl). Returns null if the selected user is
   * this user, does not exist, or falls outside the caller's directory scope
   * (see `UserDirectoryScope`) — the same scope `searchUsers` covers, so an
   * org's members can be neither searched nor picked from outside it. The
   * ticket records the orgs that justified the pick; redemption re-checks them
   * live. Self-selection uses stable DO identity because ctx.id.name may be
   * absent after a cold start through idFromString().
   */
  async createGatekeeperUserSelection(
      appAccountId: number, selectedUserId: string,
  ): Promise<GatekeeperUserSelection | null> {
    let app = await this.accounts.uiAccountRecord(appAccountId);
    if (!app) throw new Error("No such app.");
    let selectedId = this.ctx.exports.UserDurableObject.idFromName(selectedUserId);
    if (this.ctx.id.equals(selectedId)) return null;
    let selectedProfile = await this.ctx.exports.UserDurableObject.get(selectedId).whoamiIfExists();
    if (!selectedProfile) return null;
    let scope = await this.getDirectoryScope();
    let orgIds = scope.orgs
        .filter(org => org.memberIds.includes(selectedUserId))
        .map(org => org.orgId);
    if (orgIds.length === 0 && !scope.partnerIds.includes(selectedUserId)) return null;
    let profile = { displayName: selectedProfile.name };
    let { secret, hash: ticketHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + GATEKEEPER_USER_SELECTION_LIFETIME_MS);
    this.storage.pendingUserSelections.put({
      ticketHash, appAccountId, vendorId: app.vendorId, selectedUserId, orgIds, expiresAt,
    });
    await this.#armExpirySweep();
    return { ticket: secret.toHex(), profile };
  }

  /**
   * Redeem a ticket returned from createGatekeeperUserSelection. A ticket can
   * only be redeemed once by the gatekeeper app account that minted it. A
   * ticket minted for a different gatekeeper app account is refused without
   * being spent, so a later valid exchange can still redeem it. Returns all of
   * the selected user's eligible same-vendor accounts. The gatekeeper handles
   * zero or multiple results. A ticket represents a Workshop user, not a
   * connected account, so a 1:1 mapping with a connected account is not
   * guaranteed.
   *
   * The pick's justification is re-checked live: for an org-justified ticket,
   * some recorded org must still hold both the selector and the selected as
   * active members (the lazy-revocation contract — a removed member's pending
   * picks die at redemption); a share-justified ticket requires the share
   * relationship to still stand.
   */
  async redeemGatekeeperUserSelection(
      appAccountId: number, ticket: string,
  ): Promise<RedeemedGatekeeperUserSelection[]> {
    let ticketHash = await hashPresentedSecret(ticket);
    let record = ticketHash === undefined
        ? undefined : this.storage.pendingUserSelections.get(ticketHash);
    if (!record || record.appAccountId !== appAccountId) {
      throw new Error("This selection has expired. Please select the user again.");
    }
    this.storage.pendingUserSelections.delete(record.ticketHash);
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new Error("This selection has expired. Please select the user again.");
    }
    let app = await this.accounts.uiAccountRecord(appAccountId);
    if (!app || app.vendorId !== record.vendorId) throw new Error("No such app.");
    if (!(await this.#directory.stillJustified(record))) {
      throw new Error("This selection is no longer available. Please select the user again.");
    }
    return this.ctx.exports.UserDurableObject.getByName(record.selectedUserId)
        .selectableGatekeeperUsers(record.vendorId);
  }














  #dropPendingDeviceHandoff(pending: PendingDeviceHandoffRecord): void {
    this.storage.pendingDeviceHandoffs.delete(pending.stateHash);
    if (pending.sessionTokenId) this.storage.sessions.delete(pending.sessionTokenId);
  }

  // Arm the alarm for the soonest pending expiry, including device sessions and picker selections.
  async #armExpirySweep(): Promise<void> {
    let next: number | undefined;
    let consider = (at: number) => { if (next === undefined || at < next) next = at; };
    for (let flow of this.storage.pendingConnectFlows.list()) consider(flow.expiresAt.getTime());
    for (let pending of this.storage.pendingDeviceHandoffs.list()) {
      consider(pending.expiresAt.getTime());
    }
    for (let session of this.storage.sessions.list()) {
      if (session.expiresAt) consider(session.expiresAt.getTime());
    }
    for (let selection of this.storage.pendingUserSelections.list()) {
      consider(selection.expiresAt.getTime());
    }
    try {
      for (let pending of this.storage.pendingHandoffs.list()) consider(pending.expiresAt.getTime());
    } catch (err) {
      // A record whose stub no longer deserializes (its Worker was unbound) fails the listing, and
      // without a keys-only listing it cannot be deleted either. Staging a new connect must not
      // depend on listing old ones, so arm a retry instead: one warning per lifetime for this user
      // until the Worker is bound again, while the grant the record holds is reachable by nobody.
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.arm.failed", error: err,
      });
      consider(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    }
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Drop unconfirmed connect handoffs, abandoned connect flows and picker selections, and expired
   * device handoffs and sessions. Device handoff cleanup also deletes its unactivated session.
   */
  async alarm(): Promise<void> {
    let now = Date.now();
    let expiredFlows = Array.from(this.storage.pendingConnectFlows.list())
        .filter(flow => flow.expiresAt.getTime() <= now);
    for (let flow of expiredFlows) this.storage.pendingConnectFlows.delete(flow.nonceHash);
    let expiredSelections = Array.from(this.storage.pendingUserSelections.list())
        .filter(selection => selection.expiresAt.getTime() <= now);
    for (let selection of expiredSelections) {
      this.storage.pendingUserSelections.delete(selection.ticketHash);
    }
    let expired: PendingHandoffRecord[] = [];
    try {
      for (let pending of this.storage.pendingHandoffs.list()) {
        if (pending.expiresAt.getTime() <= now) expired.push(pending);
      }
    } catch (err) {
      // Same failure mode as #connectedAccountRecords: a stub for a Worker that is no longer bound
      // fails to deserialize. Leave the sweep for next time (#armExpirySweep bounds the retry).
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.sweep.failed", error: err,
      });
    }
    for (let pending of expired) {
      this.storage.pendingHandoffs.delete(pending.ticketHash);
      await this.accounts.dropPendingConnect(pending);
    }
    for (let pending of Array.from(this.storage.pendingDeviceHandoffs.list())) {
      if (pending.expiresAt.getTime() <= now) this.#dropPendingDeviceHandoff(pending);
    }
    for (let session of Array.from(this.storage.sessions.list())) {
      if ((session.expiresAt?.getTime() ?? Infinity) <= now) {
        this.storage.sessions.delete(session.tokenId);
      }
    }
    await this.#armExpirySweep();
  }









}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<ConnectHandoff> {
    let {accountId, vendorId} = this.ctx.props;
    return this.#getUserStub().stagePendingConnect(accountId, account, vendorId, expiresAt);
  }

  reconnectComplete(stageId: string, expiresAt?: Date): Promise<ConnectHandoff> {
    return this.#getUserStub().stagePendingRestore(this.ctx.props.accountId, stageId, expiresAt);
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

type GatekeeperUserSelectionExchangeProps = {
  selectorUserId: string;
  appAccountId: number;
};

/**
 * The capability exposed to a gatekeeper app for redeeming user selection
 * tickets (AppUiContext.userSelectionExchange). Its props contain the selecting
 * user's ID and the one gatekeeper account startAccountAppUi was called on.
 * Every ticket is redeemed against that scope, so the capability cannot resolve
 * anything that the Workshop did not mint for it.
 */
@validateRpc()
export class GatekeeperUserSelectionExchangeImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperUserSelectionExchangeProps>
    implements GatekeeperUserSelectionExchange {
  /**
   * RPC validation is skipped for the same reason every gatekeeper's
   * getVerifier() skips it: the generated return validator wraps the native
   * Fetcher in a Proxy that Workers RPC then refuses to serialize. The ticket
   * itself is checked by hashPresentedSecret before it is looked up.
   */
  @skipRpcValidation()
  redeem(ticket: string): Promise<RedeemedGatekeeperUserSelection[]> {
    let { selectorUserId, appAccountId } = this.ctx.props;
    let users = this.ctx.exports.UserDurableObject;
    return users.get(users.idFromString(selectorUserId))
        .redeemGatekeeperUserSelection(appAccountId, ticket);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}