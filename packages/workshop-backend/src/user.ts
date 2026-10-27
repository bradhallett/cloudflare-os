// The user Durable Object: the RPC surface (a thin delegator stratum, the user-bots.ts pattern)
// over the per-concern stores — user-accounts.ts (connected accounts), user-sessions.ts
// (authentication and sessions), user-models.ts (AI models and chat contexts),
// user-workspaces.ts (the workspace index), user-blueprints.ts (blueprints), user-bots.ts
// (declared bots) — plus what spans concerns and stays here: the notifications fan-out, the
// expiry alarm that sweeps every store's short-lived records, and the gatekeeper
// user-selection tickets.

import { RpcStub } from "capnweb";
import {AiChatAuthorInfo, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, validateCommitEmail, NotificationSubscriber, NotificationMute, UserNotification, type BotDefinition, type BotInfo, type BotSelection, type BotSkillChoice} from '@gadgets/workshop-shared/api';
import {Gatekeeper, GatekeeperUser, GatekeeperConnectCallback, ConnectHandoff, AppUiContext, GatekeeperUserSelection, GatekeeperUserSelectionExchange, RedeemedGatekeeperUserSelection} from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  makeUserStorage, type ConnectedAccountRecord,
  type PendingHandoffRecord, type UserStorage,
} from "./storage-schema/user-storage.js";
import { UserBotStore } from "./user-bots.js";
import { UserAccountStore } from "./user-accounts.js";
import { UserModelStore } from "./user-models.js";
import { UserSessionStore } from "./user-sessions.js";
import { getGatewayModels, type GatewayModels } from "./ai-gateway.js";
import { UserWorkspaceStore } from "./user-workspaces.js";
import { UserBlueprintStore } from "./user-blueprints.js";
import { UserDirectoryScopeStore, type UserDirectoryScope } from "./user-directory-scope.js";
import { createWorkshopLogger } from "./observability";

import { allowedModelTiers } from "./user-plan.js";
import type { AdminSettings } from "./admin-settings.js";
import { readAdminConfig } from "./admin-config.js";
import { newSecretToken, PENDING_HANDOFF_LIFETIME_MS, hashPresentedSecret } from "./connect-handoff.js";
import { deliver, registerDevice } from "./notification-service.js";

const logger = createWorkshopLogger("workshop.user");

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

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private accounts: UserAccountStore;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  #notificationSubscribers = new Map<object, RpcStub<NotificationSubscriber>>();
  #bots: UserBotStore;
  #directory: UserDirectoryScopeStore;
  // The model and blueprint stores snapshot env at construction, like the account store
  // (user-accounts.ts): production never swaps env, and the gateway-models and blueprints
  // tests keep their env rewrite visible to both holders.
  private models: UserModelStore;
  #sessions: UserSessionStore;
  #workspaces: UserWorkspaceStore;
  private blueprints: UserBlueprintStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.#bots = new UserBotStore(env, this.storage);
    this.#directory = new UserDirectoryScopeStore(ctx, this.storage);
    this.accounts = new UserAccountStore(ctx, env, this.storage, this.#directory,
        () => this.#armExpirySweep());
    this.models = new UserModelStore(env, this.ctx.id.toString(), this.storage,
        (bot) => this.#bots.resolve(bot));
    this.#sessions = new UserSessionStore(ctx, env, this.storage, {
      syncDirectory: () => this.#directory.sync(),
      armExpirySweep: () => this.#armExpirySweep(),
    });
    this.#workspaces = new UserWorkspaceStore(ctx, env, this.storage);
    this.blueprints = new UserBlueprintStore(ctx, env, this.storage, this.adminSettings);
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

  // -------------------------------------------------------------------------------------------
  // Session RPC surface: thin delegators to #sessions (user-sessions.ts), which owns
  // authentication, session records, the device-session handoff, and deprovisioning.

  authenticate(token: string) { return this.#sessions.authenticate(token); }
  authenticateFromCfAccess(email: string, allowCreate: boolean) {
    return this.#sessions.authenticateFromCfAccess(email, allowCreate);
  }
  stageDeviceSessionHandoff(publicKey: string, state: string, accessJwt?: string) {
    return this.#sessions.stageDeviceSessionHandoff(publicKey, state, accessJwt);
  }
  consumeDeviceSessionHandoff(state: string, ticket: string) {
    return this.#sessions.consumeDeviceSessionHandoff(state, ticket);
  }
  login(passwordHash: Uint8Array) { return this.#sessions.login(passwordHash); }
  createAccount(username: string, displayName: string, passwordHash: Uint8Array) {
    return this.#sessions.createAccount(username, displayName, passwordHash);
  }
  revokeAllSessions() { return this.#sessions.revokeAllSessions(); }
  listSessions() { return this.#sessions.listSessions(); }
  deprovision() { return this.#sessions.deprovision(); }
  loginOrCreateViaGatekeeper(email: string, allowCreate: boolean) {
    return this.#sessions.loginOrCreateViaGatekeeper(email, allowCreate);
  }
  hasPasswordLogin() { return this.#sessions.hasPasswordLogin(); }
  changePassword(oldHash: Uint8Array, newHash: Uint8Array) {
    return this.#sessions.changePassword(oldHash, newHash);
  }

  // -------------------------------------------------------------------------------------------
  // AI-model RPC surface: thin delegators to the model store (user-models.ts), which owns the
  // hand-added models, the quick/preferred selections, the daily LLM counter, and chat contexts.

  listModels(kind?: Parameters<UserModelStore["listModels"]>[0]) {
    return this.models.listModels(kind);
  }
  addModel(profile: AiChatAuthorInfo, config: Parameters<UserModelStore["addModel"]>[1],
           copySecretsFrom?: string) {
    return this.models.addModel(profile, config, copySecretsFrom);
  }
  getModelConfig(id: string) { return this.models.getModelConfig(id); }
  updateModel(profile: AiChatAuthorInfo, config: Parameters<UserModelStore["updateModel"]>[1]) {
    return this.models.updateModel(profile, config);
  }
  deleteModel(id: string) { return this.models.deleteModel(id); }
  setQuickModel(id: string | null) { return this.models.setQuickModel(id); }
  getQuickModel() { return this.models.getQuickModel(); }
  getPreferredModel() { return this.models.getPreferredModel(); }
  setPreferredModel(id: string | null) { return this.models.setPreferredModel(id); }
  isOnboardingCompleted() { return this.models.isOnboardingCompleted(); }
  completeOnboarding() { return this.models.completeOnboarding(); }
  checkDailyLlmCount(limit: number) { return this.models.checkDailyLlmCount(limit); }
  consumeDailyLlmCall(limit: number) { return this.models.consumeDailyLlmCall(limit); }
  getChatContext(modelId: string | null, bot?: BotSelection) {
    return this.models.getChatContext(modelId, bot);
  }
  getExternalMessageChatContext(existingChatModelId: string | null) {
    return this.models.getExternalMessageChatContext(existingChatModelId);
  }

  // -------------------------------------------------------------------------------------------
  // Workspace RPC surface: thin delegators to #workspaces (user-workspaces.ts), which owns the
  // gadget index, per-workspace outputs and their backfill, and the mirrored org memberships.

  listGadgets() { return this.#workspaces.listGadgets(); }
  updateTitle(gadgetId: string, title: string) {
    return this.#workspaces.updateTitle(gadgetId, title);
  }
  updatePinned(gadgetId: string, pinned: boolean) {
    return this.#workspaces.updatePinned(gadgetId, pinned);
  }
  getGadget(id: string) { return this.#workspaces.getGadget(id); }
  newGadget(id: string, title: string) { return this.#workspaces.newGadget(id, title); }
  ensureGadgetRegistered(id: string, title: string) {
    return this.#workspaces.ensureGadgetRegistered(id, title);
  }
  setGadgetLastActive(id: string, time: Date, totalCost: number | undefined) {
    return this.#workspaces.setGadgetLastActive(id, time, totalCost);
  }
  deleteGadget(id: string) { return this.#workspaces.deleteGadget(id); }
  syncWorkspaceOutputs(workspaceId: string, entries: Parameters<UserWorkspaceStore["syncWorkspaceOutputs"]>[1]) {
    return this.#workspaces.syncWorkspaceOutputs(workspaceId, entries);
  }
  listOutputs() { return this.#workspaces.listOutputs(); }
  setWorkspaceNotificationMute(workspaceId: string, mute: NotificationMute | null) {
    return this.#workspaces.setWorkspaceNotificationMute(workspaceId, mute);
  }
  recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole) {
    return this.#workspaces.recordSharedGadgetOpen(gadgetId, title, ownerProfile, role);
  }
  updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole) {
    return this.#workspaces.updateSharedGadgetRole(gadgetId, role);
  }
  forgetSharedGadget(gadgetId: string) { return this.#workspaces.forgetSharedGadget(gadgetId); }
  syncOrgMembership(
      orgId: string, membership: Parameters<UserWorkspaceStore["syncOrgMembership"]>[1]) {
    return this.#workspaces.syncOrgMembership(orgId, membership);
  }
  listOrgMemberships() { return this.#workspaces.listOrgMemberships(); }

  // -------------------------------------------------------------------------------------------
  // Blueprint RPC surface: thin delegators to the blueprint store (user-blueprints.ts), which owns the
  // published blueprints, the library and its live org gate, the pinned set, and KV/R2 cleanup.

  updateBlueprint(id: string, metadata: Parameters<UserBlueprintStore["updateBlueprint"]>[1], gadgetId: string) {
    return this.blueprints.updateBlueprint(id, metadata, gadgetId);
  }
  importBlueprint(id: string, metadata: Parameters<UserBlueprintStore["importBlueprint"]>[1]) {
    return this.blueprints.importBlueprint(id, metadata);
  }
  deleteBlueprint(id: string) { return this.blueprints.deleteBlueprint(id); }
  isBlueprintPinned(id: string) { return this.blueprints.isBlueprintPinned(id); }
  setBlueprintPinned(id: string, pinned: boolean) {
    return this.blueprints.setBlueprintPinned(id, pinned);
  }
  addBlueprintToLibrary(id: string) { return this.blueprints.addBlueprintToLibrary(id); }
  removeBlueprintFromLibrary(id: string) { return this.blueprints.removeBlueprintFromLibrary(id); }
  isBlueprintInLibrary(id: string) { return this.blueprints.isBlueprintInLibrary(id); }
  deleteOwnedBlueprint(id: string) { return this.blueprints.deleteOwnedBlueprint(id); }
  isBlueprintFeatured(id: string) { return this.blueprints.isBlueprintFeatured(id); }
  setBlueprintFeatured(id: string, featured: boolean) {
    return this.blueprints.setBlueprintFeatured(id, featured);
  }
  getBlueprint(id: string) { return this.blueprints.getBlueprint(id); }
  listBlueprints() { return this.blueprints.listBlueprints(); }
  listLibraryBlueprints() { return this.blueprints.listLibraryBlueprints(); }

  // -------------------------------------------------------------------------------------------
  // Profile, notifications, bots, and the cross-concern records this DO owns itself.

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
    let model = this.models.resolveModel(def.modelId, models);
    // A model the user's plan may not run makes the bot unavailable exactly like one that no
    // longer resolves, so the listing never offers a bot its chat would refuse to start.
    let tier = model ? models?.get(def.modelId)?.tier : undefined;
    let runnable = model !== undefined && this.models.tierAllowed(tier, tiers);
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
   * a BotSkillRef stores. A vendor whose singleton can't be reached -- its class won't mint
   * (including a dormant account: the mint applies the dormancy invariant, see
   * getSingletonGatekeeperClass), its provider won't load -- is skipped, not fatal, exactly
   * like the slash-command catalog.
   */
  async listBotSkills(): Promise<BotSkillChoice[]> {
    // Self-sufficient like listGatekeeperApps: ambient singletons (Context) are provisioned
    // first (idempotent), so the list works even before the user has opened a workspace.
    await this.accounts.ensureAutoProvisionedAccounts();

    let perAccount = await Promise.all([...this.accounts.connectedAccountRecords()].map(async record => {
      if (!record.description.singleton) return [];
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
      // Same failure mode as connectedAccountRecords (user-accounts.ts): a stub for a Worker that is no longer bound
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
      if (pending.expiresAt.getTime() <= now) this.#sessions.dropPendingDeviceHandoff(pending);
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

/** Normalize a signup username: lowercased, and alphanumeric starting with a letter. */
export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
