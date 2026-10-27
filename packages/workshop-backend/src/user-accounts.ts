// The connected-account half of the user Durable Object (user.ts): everything between a vendor
// binding and a stored connected account -- vendor listing and connecting, ambient (auto)
// provisioning, the connect-flow handoff, credentials, and the Cloudflare billing link. The DO
// keeps the RPC surface as thin delegators (the user-bots.ts pattern) and owns what spans
// concerns: sessions, the expiry alarm, and gatekeeper user-selection tickets.

import { RpcStub } from "capnweb";
import {
  ConnectedAccountsSubscriber,
  ConnectedAccountsFilter,
  GatekeeperVendorFilter,
  GatekeeperVendorInfo,
  ConnectFlowStart,
  createPlanRefusalError,
} from "@gadgets/workshop-shared/api";
import {
  ActionDescription,
  Gatekeeper,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor,
  AccountDescription,
  VendorDescription,
  SupportedResource,
  AppUiContext,
  ConnectHandoff,
  RedeemedGatekeeperUserSelection,
  ResourceConfiguratorFrame,
  GatekeeperUiFrame,
  ComposioUserPolicy,
} from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import {
  type CloudflareBilling,
  type ConnectedAccountRecord,
  type PendingConnectFlow,
  type PendingHandoffRecord,
  type UserStorage,
} from "./storage-schema/user-storage.js";
import { allowedGatekeepers } from "./user-plan.js";
import { UserDirectoryScopeStore } from "./user-directory-scope.js";
import { createWorkshopLogger } from "./observability";
import { ambientGatekeeperMode, shouldAutoProvisionAccount } from "./provisioning-policy.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import {
  CONNECT_FLOW_LIFETIME_MS,
  PENDING_HANDOFF_LIFETIME_MS,
  handoffTargetOrigin,
  hashPresentedSecret,
  newSecretToken,
} from "./connect-handoff.js";

const logger = createWorkshopLogger("workshop.user");

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
};

// The singleton/UI methods (createAccount on GatekeeperVendor; getSingletonGatekeeperClass /
// startAppUi on GatekeeperUser) are optional on their interfaces. We don't need to probe whether a
// method is present — we already know from the declaration flags (autoProvisionsAccount /
// description.singleton / .providesUi) that we gated on — but TypeScript still can't call an optional
// method on the mapped stub type directly, so we view the stub through a plain shape that marks the
// needed method required. These are derived from the source interfaces (Pick + Required) rather than
// re-declared, so they can't drift. They are intentionally NOT wrapped in Service/Fetcher: a plain
// shape keeps the methods' declared return types (e.g. createAccount's Fetcher<GatekeeperUser>)
// usable directly, the way the runtime stub actually behaves.
type AccountCreatorStub = Required<Pick<GatekeeperVendor, "createAccount">>;
type ResourceCreatorStub = Required<Pick<GatekeeperVendor, "createResource">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser, "getSingletonGatekeeperClass" | "startAppUi">>;
type CreationConfiguratorStub = Required<Pick<GatekeeperUser, "startCreationConfigurator">>;
function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

/**
 * Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
 * Gateway billing flow is Cloudflare-specific, so several places key off this literal.
 */
export const CLOUDFLARE_VENDOR_ID = "cloudflare";
function unavailableGatekeeperVendorInfo(id: string): GatekeeperVendorInfo {
  return {
    id,
    unavailable: true,
    description: {
      displayName: id,
      url: "",
      tagline: "Temporarily unavailable",
      description: "This gatekeeper could not be loaded.",
    },
    supportedResources: [],
  };
}

// Whether any of a vendor's resources matches the filter's URL. Pure over the fetched resource
// list so callers fetch getSupportedResources() once and share it between filtering and the
// returned payload (the old shape fetched it twice: once inside the filter check, once for the
// listing). Throws on a non-string urlPattern, which callers treat as "filtered out".
function matchesResourceUrlFilter(resources: SupportedResource[], resourceUrl: string): boolean {
  for (let resource of resources) {
    if (typeof resource.urlPattern !== "string") {
      // Guard against gatekeepers returning a non-string urlPattern for now.
      //
      // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
      //   even the right thing?
      throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
    }
    if (new URLPattern(resource.urlPattern).test(resourceUrl)) return true;
  }
  return false;
}

/**
 * One instance per user Durable Object (user.ts constructs it as `#accounts` and delegates the
 * account-facing RPC surface to it). Owns the connected-account records, the vendor map, and the
 * connect-handoff staging; shares the DO's storage slice, directory scope, and expiry alarm.
 */
export class UserAccountStore {
  private vendors: Map<string, Service<GatekeeperVendor>>;

  constructor(
    private ctx: DurableObjectState,
    private env: Cloudflare.Env,
    private storage: Pick<UserStorage,
        "connectedAccounts" | "nextAccountId" | "pendingConnectFlows" | "pendingHandoffs"
        | "cloudflareBilling" | "created" | "profile">,
    private directory: UserDirectoryScopeStore,
    private armExpirySweep: () => Promise<void>,
  ) {
    this.vendors = buildGatekeeperVendorMap(env);
  }
  // ---------------------------------------------------------------------------------------------
  // Cloudflare account connection (optional top-up flow).
  // ---------------------------------------------------------------------------------------------

  /**
   * Return the connected Cloudflare *gatekeeper* account stub, if any. The AI Gateway billing flow
   * narrows it to CloudflareGatekeeperUser to obtain a usable access token. Null if the user hasn't
   * connected (or signed in with) Cloudflare.
   */
  async getCloudflareGatekeeperAccount(): Promise<Fetcher<CloudflareGatekeeperUser> | null> {
    for (let rec of this.connectedAccountRecords()) {
      if (rec.vendorId === CLOUDFLARE_VENDOR_ID) {
        return rec.account as unknown as Fetcher<CloudflareGatekeeperUser>;
      }
    }
    return null;
  }

  /** The AI Gateway billing state (selected account + cached balance), or null if unset. */
  async getCloudflareBilling(): Promise<CloudflareBilling | null> {
    return this.storage.cloudflareBilling.get();
  }

  /** Update the cached credit balance for the billed account. */
  async updateCloudflareCredits(creditsRemaining: number | null): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.creditsRemaining = creditsRemaining;
    record.creditsUpdatedAt = Date.now();
    this.storage.cloudflareBilling.put(record);
  }

  /**
   * Persist which Cloudflare account to bill. Clears the cached credit balance (it belonged to the
   * old account).
   */
  async setCloudflareAccountSelection(accountId: string, accountName?: string): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.accountId = accountId;
    record.accountName = accountName;
    record.creditsRemaining = undefined;
    record.creditsUpdatedAt = undefined;
    this.storage.cloudflareBilling.put(record);
  }
  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<GatekeeperVendorInfo[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    // Admin-disabled resources/gatekeepers are filtered out here, and so is any vendor the
    // user's plan doesn't offer, which also covers the agent (the Overseer's
    // connectable-vendor/resource list is sourced from this method).
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);
    let planAllowed = await allowedGatekeepers(this.env, this.ctx.id.toString());

    let promises: Promise<GatekeeperVendorInfo | null>[] = [];

    for (let [id, vendor] of this.vendors) {
      if (disabledGatekeeperSet.has(id)) {
        continue;  // Whole gatekeeper disabled by admin.
      }
      if (planAllowed !== null && !planAllowed.has(id.toLowerCase())) {
        continue;  // Not on the user's plan.
      }
      promises.push((async () => {
        try {
          // One getSupportedResources() call is both the filter input and the listed payload
          // (the old shape fetched it twice: once inside the filter check, once for the
          // listing). A filtered listing fetches the resources first and describes only a
          // vendor whose enabled resources match -- a non-match costs one RPC, not two --
          // while an unfiltered one runs the two fetches in parallel, as it always has.
          let supportedResources: SupportedResource[];
          let description: VendorDescription | undefined;
          if (filter?.resourceUrl) {
            supportedResources = await vendor.getSupportedResources(options);
          } else {
            [description, supportedResources] = await Promise.all([
              vendor.describe(),
              vendor.getSupportedResources(options),
            ]);
          }
          let enabledResources =
              filterEnabledResources(config, id, supportedResources);
          // The filter matches what would be pushed (the same enabled basis notifyAdd applies):
          // a URL that matches only an admin-disabled resource hides the vendor entirely.
          if (filter?.resourceUrl &&
              !matchesResourceUrlFilter(enabledResources, filter.resourceUrl)) {
            return null;
          }
          if (enabledResources.length == 0) {
            // Every resource for this vendor is disabled (or it advertised none) — hide the vendor.
            return null;
          }
          if (description === undefined) {
            description = await vendor.describe();
          }

          return {id, description, supportedResources: enabledResources};
        } catch (err) {
          // A filtered listing hides a vendor it cannot load (the old filter check swallowed
          // fetch failures the same way); an unfiltered one surfaces it as unavailable.
          if (filter?.resourceUrl) {
            logger.warn("gatekeeper filter check failed", {
              event: "gatekeeper.filter.check.failed", vendorId: id, error: err,
            });
            return null;
          }
          logger.warn("failed to load gatekeeper vendor", {
            event: "gatekeeper.vendor.load.failed", vendorId: id, error: err,
          });
          return unavailableGatekeeperVendorInfo(id);
        }
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }
  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<ConnectFlowStart> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }
    let normalized = vendorId.toLowerCase();
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(normalized)) {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }
    // The plan gate mirrors #assertResourceEnabled's ordering (admin first), so a connect never
    // completes an OAuth flow only to fail at the first gatekeeper mint.
    let allowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    if (allowed !== null && !allowed.has(normalized)) {
      throw createPlanRefusalError("CONNECTOR_NOT_ON_PLAN",
          `The "${vendorId}" connector isn't available on your plan.`);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback, {resourceUrlPatterns});
    let nonce = await this.openConnectFlow(accountId);
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return { url, nonce };
  }

  /**
   * Iterate every connected-account record, skipping any that fails to load. A record can fail to
   * deserialize when its account stub points at a gatekeeper Worker that's no longer bound in this
   * deployment (workerd throws "Stub refers to a service that doesn't exist"). Skipping it keeps one
   * stale account from breaking listing, provisioning, and opt-in for all the others — the same
   * resilience subscribeConnectedAccounts relies on (it iterates through this).
   */
  *connectedAccountRecords(): Generator<ConnectedAccountRecord> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try {
        rec = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account: failed to load", {
          event: "connected.account.load.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (rec) yield rec;
    }
  }

  // Whether this user already has a connected account for the given vendor.
  #hasAccountForVendor(vendorId: string): boolean {
    for (let rec of this.connectedAccountRecords()) {
      if (rec.vendorId === vendorId) return true;
    }
    return false;
  }
  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
      try {
        let description = await vendor.describe();
        return description.autoProvisionsAccount ? {vendorId, vendor, description} : null;
      } catch (err) {
        logger.warn("failed to describe vendor", {
          event: "vendor.describe.failed", vendorId, error: err,
        });
        return null;
      }
    }));
    return described.filter(v => v !== null);
  }

  /**
   * The ambient gatekeepers the user can opt into now: mode "optional", not yet added, and on
   * the user's plan. Backs the Connectors "Available" section. ("enabled" ones are already
   * provisioned; "disabled" ones, and ones the plan doesn't offer, aren't listed — the same
   * dormancy treatment listProvidedAccounts gives an already-added account.)
   */
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    let config = await readAdminConfig(this.env);
    let planAllowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    return (await this.#ambientVendors())
        .filter(({vendorId}) =>
            ambientGatekeeperMode(config, vendorId) === "optional" && !this.#hasAccountForVendor(vendorId))
        .filter(({vendorId}) => planAllowed === null || planAllowed.has(vendorId.toLowerCase()))
        // Same shape as listGatekeeperVendors; ambient gatekeepers expose no resources.
        .map(({vendorId, description}) => ({id: vendorId, description, supportedResources: []}));
  }

  // Per-vendor dedup of concurrent provisionAmbientAccount() calls — same DO-input-gate race as
  // #ensureAccountsPromise (see its comment below), e.g. a double-click on "Add". Cleared on completion.
  #provisionPromises = new Map<string, Promise<void>>();

  /**
   * Opt into an ambient gatekeeper on demand: mint its connected account for this user (no OAuth).
   * Only when the vendor's mode isn't "disabled" and the user has no account yet. Idempotent.
   */
  provisionAmbientAccount(vendorId: string): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let inFlight = this.#provisionPromises.get(vendorId);
    if (inFlight) return inFlight;
    let promise = this.#provisionAmbientAccount(vendorId)
        .finally(() => { this.#provisionPromises.delete(vendorId); });
    this.#provisionPromises.set(vendorId, promise);
    return promise;
  }

  async #provisionAmbientAccount(vendorId: string): Promise<void> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error("No such service: " + vendorId);

    if (ambientGatekeeperMode(await readAdminConfig(this.env), vendorId) === "disabled") {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }
    // The plan gate mirrors admin-disabled (and #assertResourceEnabled's ordering), so an
    // ambient vendor the plan doesn't offer can't be opted into directly either.
    let allowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    if (allowed !== null && !allowed.has(vendorId)) {
      throw createPlanRefusalError("CONNECTOR_NOT_ON_PLAN",
          `The "${vendorId}" connector isn't available on your plan.`);
    }

    let description = await vendor.describe();
    if (!description.autoProvisionsAccount) {
      throw new Error(`The "${vendorId}" gatekeeper can't be added this way.`);
    }

    if (this.#hasAccountForVendor(vendorId)) return;  // already added

    await this.#createAutoProvisionedAccount(vendorId, vendor);
  }

  // Mint a vendor's connected account with no OAuth flow and persist it as auto-provisioned. The
  // caller must have already confirmed the vendor sets autoProvisionsAccount (so createAccount is
  // present) and that the user has no account for it yet.
  async #createAutoProvisionedAccount(vendorId: string, vendor: Service<GatekeeperVendor>): Promise<void> {
    let account = await (vendor as unknown as AccountCreatorStub).createAccount();
    // Resolve the description before allocating the id, so a describe() failure doesn't burn a slot.
    let description = await account.describe();
    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);
    this.storage.connectedAccounts.put({
      id: accountId,
      account,
      description,
      vendorId,
      autoProvisioned: true,
    });
  }

  // Dedup concurrent ensureAutoProvisionedAccounts() calls. The provisioning loop awaits cross-worker
  // RPCs (describe/createAccount), which releases the DO input gate; without this, two overlapping
  // calls (e.g. the nav listing apps while a gadget opens) could both see "not provisioned" and
  // create duplicate accounts. Cleared on completion so a later call re-checks (e.g. for a gatekeeper
  // bound after this DO started).
  #ensureAccountsPromise?: Promise<void>;

  /**
   * Ensure an auto-provisioned connected account exists for every bound vendor that requests it
   * (VendorDescription.autoProvisionsAccount) and is permitted by the provisioning policy. Idempotent
   * and best-effort: a single failing vendor never blocks the others. Creates at most one account per
   * vendor. Deduped via #ensureAccountsPromise (above); callers reach it through listProvidedAccounts.
   */
  ensureAutoProvisionedAccounts(): Promise<void> {
    return (this.#ensureAccountsPromise ??=
      this.#provisionMissingAccounts().finally(() => { this.#ensureAccountsPromise = undefined; }));
  }

  async #provisionMissingAccounts(): Promise<void> {
    // Which vendors already have an auto-provisioned account?
    let provisioned = new Set<string>();
    for (let rec of this.connectedAccountRecords()) {
      if (rec.autoProvisioned) provisioned.add(rec.vendorId);
    }

    let config = await readAdminConfig(this.env);
    let planAllowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    for (let {vendorId, vendor} of await this.#ambientVendors()) {
      if (provisioned.has(vendorId)) continue;
      // Only "enabled" (forced) vendors are auto-provisioned for everyone. "optional" vendors are
      // added on demand by the user (provisionAmbientAccount); "disabled" ones never.
      if (!shouldAutoProvisionAccount(config, vendorId)) continue;
      // A vendor the user's plan doesn't offer is never auto-provisioned either (the plan gate
      // provisionAmbientAccount applies on demand).
      if (planAllowed !== null && !planAllowed.has(vendorId.toLowerCase())) continue;

      try {
        await this.#createAutoProvisionedAccount(vendorId, vendor);
      } catch (err) {
        logger.error("failed to auto-provision account", {
          event: "account.auto.provision.failed", vendorId, error: err,
        });
      }
    }
  }
  /**
   * Ensure the user's auto-provisioned accounts exist (idempotent; see ensureAutoProvisionedAccounts),
   * then list those that declare an agent singleton and/or a management UI. Folding the ensure in lets
   * callers (gadget open, app nav) provision and read the accounts back in a single round trip to this
   * DO. Callers filter on `description.singleton` (ambient capsules / catalog) or
   * `description.providesUi` (management-UI listing).
   */
  async listProvidedAccounts(): Promise<ProvidedAccountInfo[]> {
    await this.ensureAutoProvisionedAccounts();
    let config = await readAdminConfig(this.env);
    let planAllowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    let result: ProvidedAccountInfo[] = [];
    for (let rec of this.connectedAccountRecords()) {
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      // A "disabled" ambient gatekeeper's account stays dormant: don't surface its singleton capsule
      // or management UI. (Its data is preserved, so re-enabling restores it.) A plan that doesn't
      // offer the vendor dorms it the same way — the account record stays, so disconnecting and
      // re-upgrading both keep working.
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      if (rec.autoProvisioned && planAllowed !== null &&
          !planAllowed.has(rec.vendorId.toLowerCase())) continue;
      result.push({ accountId: rec.id, vendorId: rec.vendorId, description: rec.description });
    }
    return result;
  }
  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   * Returns null while the user's plan doesn't offer the vendor, mirroring the dormancy
   * listProvidedAccounts applies: the account stays, but it is not bound into new chats.
   */
  async getSingletonGatekeeperClass(accountId: number)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    let allowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    if (allowed !== null && !allowed.has(record.vendorId.toLowerCase())) return null;
    let cls = await (record.account as unknown as SingletonAccountStub).getSingletonGatekeeperClass();
    await this.#pushVendorAdminPolicy(record);
    return cls;
  }
  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is
   * supplied fresh by the caller so admin-gated features reflect the user's current status, and
   * `context.orgMemberships` fresh from the org authority (see #freshOrgMemberships) so a
   * gatekeeper resolves org-keyed grants against the memberships the user holds right now — the
   * snapshot delivery AppUiContext promises, and the lazy-revocation hook that retires them when
   * a membership has since ended.
   */
  async startAccountAppUi(
      accountId: number, options: Pick<AppUiContext, "isAdmin">,
  ): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    let userSelectionExchange = this.ctx.exports.GatekeeperUserSelectionExchangeImpl({
      props: { selectorUserId: this.ctx.id.toString(), appAccountId: accountId },
    });
    return (record.account as unknown as SingletonAccountStub).startAppUi({
      isAdmin: options.isAdmin,
      orgMemberships: await this.directory.freshOrgMemberships(),
      userSelectionExchange,
    });
  }

  /**
   * The account record behind one of this user's gatekeeper apps, or undefined
   * if `accountId` is not a UI-providing account the deployment currently
   * offers (the same tests listProvidedAccounts applies, since a "disabled"
   * ambient gatekeeper's account, or one the user's plan doesn't offer, stays
   * dormant).
   */
  async uiAccountRecord(accountId: number): Promise<ConnectedAccountRecord | undefined> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) return undefined;
    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(record.vendorId)) return undefined;
    if (record.autoProvisioned) {
      if (ambientGatekeeperMode(config, record.vendorId) === "disabled") return undefined;
    }
    // A plan that doesn't offer the vendor dorms the account here too (see
    // listProvidedAccounts), so its management UI is unreachable while the record stays.
    let allowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    if (allowed !== null && !allowed.has(record.vendorId.toLowerCase())) return undefined;
    return record;
  }
  /**
   * Make the account's grant cover the resource types `resourceUrlPatterns` names. Only the
   * gatekeeper knows what it was granted, so it decides: it returns the URL of a consent flow that
   * widens the grant, opened here as a connect flow, or no URL when the grant already covers them.
   */
  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[])
      : Promise<ConnectFlowStart | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.ensureResources(resourceUrlPatterns);
    if (url === undefined) {
      // Nothing to grant, yet callers ask for what the account's stored description doesn't list as
      // granted, so that list is out of date. A gatekeeper that renames a resource type's
      // `urlPattern` reads the grants it recorded under the new name, but the description stored
      // here keeps the old one until it is fetched again. Fetch it now, or the UI keeps offering a
      // grant the account already has. Best-effort: null still means nothing needed granting.
      try {
        let description = await record.account.describe();
        let current = this.storage.connectedAccounts.get(accountId);
        if (current) this.storage.connectedAccounts.put({ ...current, description });
      } catch (err) {
        logger.warn("failed to refresh a stale account description", {
          event: "account.describe.refresh.failed", vendorId: record.vendorId, accountId, error: err,
        });
      }
      return null;
    }
    return { url, nonce: await this.openConnectFlow(accountId) };
  }
  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    if (filter?.includeForcedAutoProvisionedAccounts) await this.ensureAutoProvisionedAccounts();

    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    // Snapshot the admin config once for this subscription. Changes take effect when the client
    // re-subscribes (e.g. on reconnect), matching other deployment config.
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    async function notifyAdd(record: ConnectedAccountRecord) {
      // Ambient (auto-provisioned) accounts only appear in the Connectors list when their vendor is
      // "optional" — i.e. the user opted in and can manage/remove it. "enabled" (forced) accounts have
      // nothing to manage, and "disabled" ones are dormant, so both are hidden.
      // Forced accounts are included when observer verification explicitly requests them.
      if (record.autoProvisioned) {
        let mode = ambientGatekeeperMode(config, record.vendorId);
        if (mode === "disabled" ||
            (mode === "enabled" && !filter?.includeForcedAutoProvisionedAccounts)) {
          return;
        }
      }
      if (disabledGatekeeperSet.has(record.vendorId)) {
        return;  // Whole gatekeeper disabled by admin.
      }

      // One getSupportedResources() call is both the filter input and the pushed payload (the
      // old shape fetched it twice: once inside the filter check, once for the notification).
      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = filterEnabledResources(
            config, record.vendorId, await record.account.getSupportedResources());
      } catch (err) {
        if (filter?.resourceUrl) {
          // Filtered subscription: an unloadable account is hidden, exactly like one whose
          // resources don't match (the old filter check swallowed fetch failures the same way).
          logger.warn("gatekeeper filter check failed", {
            event: "gatekeeper.filter.check.failed", vendorId: record.vendorId, error: err,
          });
          return;
        }
        logger.warn("failed to get supported resources for connected account", {
          event: "connected.account.supported.resources.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
      }
      if (filter?.resourceUrl) {
        try {
          if (!matchesResourceUrlFilter(supportedResources, filter.resourceUrl)) return;
        } catch (err) {
          logger.warn("gatekeeper filter check failed", {
            event: "gatekeeper.filter.check.failed", vendorId: record.vendorId, error: err,
          });
          return;
        }
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        logger.error("no such service for connected account", {
          event: "connected.account.service.missing",
          accountId: record.id, vendorId: record.vendorId,
        });
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        logger.warn("failed to describe connected account", {
          event: "connected.account.describe.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
        return;
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // connectedAccountRecords() skips any record that fails to load, so a single stale account
    // (e.g. one whose gatekeeper Worker is no longer bound) doesn't prevent surfacing the others.
    let promises = [...this.connectedAccountRecords()].map(record => notifyAdd(record));

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }
  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      if (account.autoProvisioned) {
        // A forced ("enabled") ambient account can't be removed by the user — the admin controls it.
        if (shouldAutoProvisionAccount(await readAdminConfig(this.env), account.vendorId)) {
          throw new Error("This account is provided automatically and can't be disconnected.");
        }
        // An opt-in ("optional") ambient account: the user added it, so let them remove it. revoke()
        // gives the gatekeeper a chance to delete its own per-user storage (e.g. the account's
        // private collections DO) — it's its cleanup hook, not just OAuth revocation. Best-effort:
        // a gatekeeper that throws (or has nothing to revoke) must not block the user's disconnect.
        try {
          await account.account.revoke();
        } catch (err) {
          logger.error("revoke() failed during disconnect", {
            event: "account.revoke.failed",
            vendorId: account.vendorId, accountId, error: err,
          });
        }
        this.storage.connectedAccounts.delete(accountId);
        logger.info("account disconnected", {
          event: "account.disconnected",
          vendorId: account.vendorId, accountId, autoProvisioned: true,
        });
        return;
      }
      await account.account.revoke();
      this.storage.connectedAccounts.delete(accountId);
      // Disconnecting the Cloudflare account also clears the AI Gateway billing state (selected
      // account + cached balance), which is meaningless without the underlying grant.
      if (account.vendorId === CLOUDFLARE_VENDOR_ID) {
        this.storage.cloudflareBilling.put(null);
      }
      logger.info("account disconnected", {
        event: "account.disconnected",
        vendorId: account.vendorId, accountId, autoProvisioned: false,
      });
    }
  }
  async reconnectAccount(accountId: number): Promise<ConnectFlowStart> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.reconnect();
    return { url, nonce: await this.openConnectFlow(accountId) };
  }
  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }
  async startCreationConfigurator(accountId: number, resourceUrlPattern: string)
      : Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return (record.account as unknown as CreationConfiguratorStub)
        .startCreationConfigurator(resourceUrlPattern);
  }
  /**
   * Persist a connected gatekeeper account that was established during sign-in (rather than via the
   * usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
   * links the account for AI Gateway billing: the login callback resolves this user by verified
   * email, then calls here to store the resulting grant. That grant covers billing only: sign-in
   * requests no gadget-facing resources, so any later resource access is authorized separately.
   * Returns the id of the connected account the grant now backs, so the login callback — which the
   * gatekeeper keeps for that account's lifetime — can find it again.
   */
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<number> {
    let description = await account.describe();
    let uniqueName = description.uniqueName;

    // A repeated sign-in is a re-authorization, so the *fresh* grant is the one we want. If this
    // identity is already connected for this vendor, refresh that record in place rather than letting
    // putConnectedAccount's dedup discard the new grant: keeping the stale record would leave billing
    // broken whenever the old token had expired or was rotated out by this very re-auth — the
    // opposite of what signing in again should accomplish.
    if (uniqueName) {
      let existing = this.#findConnectedAccountByIdentity(vendorId, uniqueName);
      if (existing) {
        // Drop the now-stale grant (a separate gatekeeper-side object from the fresh one), then point
        // the existing record — keeping its id, so UI references stay stable — at the fresh grant.
        try {
          await existing.account.revoke();
        } catch (err) {
          logger.error("failed to revoke stale grant; replacing anyway", {
            event: "account.stale.grant.revoke.failed",
            accountId: existing.id, vendorId, error: err,
          });
        }
        existing.account = account;
        existing.description = description;
        existing.credentialExpiresAt = expiresAt;
        existing.credentialsExpired = false;
        this.storage.connectedAccounts.put(existing);
        return existing.id;
      }
    }

    let id = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(id + 1);
    this.storage.connectedAccounts.put({
      id,
      account,
      description,
      vendorId,
      credentialExpiresAt: expiresAt,
    });
    return id;
  }
  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load via connectedAccountRecords(), for the same
  // reasons as subscribeConnectedAccounts(): a single corrupt record (e.g. one referencing a
  // Worker binding that no longer exists) must not poison the scan and prevent the user from
  // connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    for (let existing of this.connectedAccountRecords()) {
      if (existing.id === excludeId) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }
  async putConnectedAccount(record: ConnectedAccountRecord) {
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put(record);
  }
  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      this.storage.connectedAccounts.put(record);
    }
  }
  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    this.storage.connectedAccounts.put(record);

    // Re-fetch the description since the user may have re-authed with different info. Best-effort:
    // the credentials are live either way, and a record still showing as expired over a failed
    // describe() would send the user back through a reconnect that changes nothing.
    try {
      record.description = await record.account.describe();
      this.storage.connectedAccounts.put(record);
    } catch (err) {
      logger.warn("failed to refresh the description of a restored account", {
        event: "account.describe.refresh.failed", vendorId: record.vendorId, accountId, error: err,
      });
    }
  }
  // --- Connect handoff (see connect-handoff.ts) ---

  /**
   * Start a connect / reconnect / ensure-resources flow for `accountId`: mints the nonce the Workshop
   * tab gives the popup (see ConnectFlowStart) and keeps its hash, so completeConnectHandoff can
   * check that the ticket the flow produces came back through that popup.
   */
  async openConnectFlow(accountId: number): Promise<string> {
    let { secret, hash: nonceHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + CONNECT_FLOW_LIFETIME_MS);
    this.storage.pendingConnectFlows.put({ nonceHash, accountId, expiresAt });
    await this.armExpirySweep();
    return secret.toHex();
  }
  // Store a finished-but-unconfirmed flow and hand back the ticket its page must present, together
  // with the flow's nonce, over the initiating user's session. Only the ticket's hash is kept, and
  // only in this user's DO, so the ticket is redeemable by nobody else (completeConnectHandoff looks
  // it up in the caller's own DO).
  async #stagePendingHandoff(
      record: Omit<PendingHandoffRecord, "ticketHash" | "expiresAt">): Promise<ConnectHandoff> {
    let targetOrigin = handoffTargetOrigin(this.env);
    let { secret, hash: ticketHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    this.storage.pendingHandoffs.put({ ...record, ticketHash, expiresAt });
    await this.armExpirySweep();
    return { targetOrigin, ticket: secret.toHex() };
  }

  /** A gatekeeper finished a connect flow for a reserved account id; stage it until confirmed. */
  async stagePendingConnect(accountId: number, account: Fetcher<GatekeeperUser>, vendorId: string,
                            credentialExpiresAt?: Date): Promise<ConnectHandoff> {
    let description = await account.describe();
    return this.#stagePendingHandoff({
      kind: "connect", accountId, credentialExpiresAt, connect: { account, description, vendorId },
    });
  }

  /**
   * A gatekeeper finished a reconnect/ensureResources flow; its credentials stay staged there under
   * `stageId`, which commitReconnect() names so the ticket activates exactly those credentials.
   */
  stagePendingRestore(accountId: number, stageId: string, credentialExpiresAt?: Date)
      : Promise<ConnectHandoff> {
    return this.#stagePendingHandoff({ kind: "restore", accountId, stageId, credentialExpiresAt });
  }
  /**
   * Redeem a finished flow's handoff. Called by the Workshop's own /connect/handoff page in the popup
   * over the popup's session; `nonce` proves the popup is the one this user's tab opened for that
   * flow. The ticket's record is deleted before anything else, so a ticket is single-use however the
   * rest goes (DO input gates serialize the read and delete) and a wrong nonce still spends it; the
   * nonce's flow is deleted too, so a nonce cannot be retried against another ticket. A staged
   * connect the redemption cannot activate is dropped like an unredeemed one, so no grant is left
   * reachable in a gatekeeper with nothing to revoke it.
   */
  async completeConnectHandoff(ticket: string, nonce: string): Promise<void> {
    let [ticketHash, nonceHash] =
        await Promise.all([hashPresentedSecret(ticket), hashPresentedSecret(nonce)]);
    let record: PendingHandoffRecord | undefined;
    if (ticketHash !== undefined) {
      record = this.storage.pendingHandoffs.get(ticketHash);
      if (record) this.storage.pendingHandoffs.delete(ticketHash);
    }
    let flow: PendingConnectFlow | undefined;
    if (nonceHash !== undefined) {
      flow = this.storage.pendingConnectFlows.get(nonceHash);
      if (flow) this.storage.pendingConnectFlows.delete(nonceHash);
    }
    let now = Date.now();
    if (!record || record.expiresAt.getTime() <= now ||
        !flow || flow.expiresAt.getTime() <= now || flow.accountId !== record.accountId) {
      if (record) await this.dropPendingConnect(record);
      throw new Error("This connection attempt has expired. Please try again.");
    }

    if (record.kind === "connect") {
      if (!record.connect) throw new Error("Corrupt pending connection.");
      try {
        await this.putConnectedAccount({
          id: record.accountId, ...record.connect, credentialExpiresAt: record.credentialExpiresAt,
        });
      } catch (err) {
        await this.dropPendingConnect(record);
        throw err;
      }
      logger.info("account connected", {
        event: "account.connect.completed", vendorId: record.connect.vendorId,
        accountId: record.accountId,
      });
    } else {
      let account = this.storage.connectedAccounts.get(record.accountId);
      if (!account) throw new Error("No such account.");
      if (record.stageId === undefined) throw new Error("Corrupt pending reconnect.");
      // A failed commit changed nothing live, and the gatekeeper's stage expires on its own.
      await account.account.commitReconnect(record.stageId);
      await this.markCredentialsRestored(record.accountId, record.credentialExpiresAt);
      logger.info("account credentials restored", {
        event: "account.reconnect.completed", vendorId: account.vendorId,
        accountId: record.accountId,
      });
    }
  }

  /**
   * Drop a pending handoff that will never activate. A staged connect holds a victim's (or just an
   * abandoned) grant in a reachable gatekeeper DO, so it is revoked, best-effort. A staged restore
   * left nothing live: the gatekeeper's staged credentials stop being committable on their own
   * (commitStagedCredentials refuses an expired stage), though they stay stored until the next
   * reconnect overwrites them; deleting them from here is a follow-up.
   */
  async dropPendingConnect(pending: PendingHandoffRecord): Promise<void> {
    if (pending.kind === "connect" && pending.connect) {
      try {
        await pending.connect.account.revoke();
      } catch (err) {
        logger.warn("failed to revoke unconfirmed connection", {
          event: "connect.handoff.revoke.failed", vendorId: pending.connect.vendorId,
          accountId: pending.accountId, error: err,
        });
      }
    }
    logger.info("unconfirmed connection dropped", {
      event: "connect.handoff.expired", handoffKind: pending.kind, accountId: pending.accountId,
    });
  }
  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);
    await this.#assertResourceEnabled(account.vendorId, resource);
    await this.#pushVendorAdminPolicy(account);
    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern};
  }
  /**
   * Push a vendor's admin-configured policy to its account out-of-band. A vendor with an entry in
   * AdminConfig.vendorAdminPolicy cannot read the admin config itself (its worker runs on freshly
   * provisioned bindings, not the backend's mirror), so the account exposes an updateToolkitPolicy
   * extension (ComposioUserPolicy in workshop-shared) and this pushes the entry right after every
   * capability mint — the account's stored copy stays as fresh as the config the mint was decided
   * against. Only vendors the admin actually configured have entries, so which vendors participate
   * is data, not a name in this file. The push is best-effort, shaped like the deprovision revokes:
   * an account that doesn't implement the extension (a stale entry, a vendor since changed) logs
   * and leaves the account on its last-stored policy rather than failing the mint it rode. The
   * cast follows the SingletonAccountStub pattern: the extension is optional on GatekeeperUser,
   * declared per vendor.
   */
  async #pushVendorAdminPolicy(record: ConnectedAccountRecord): Promise<void> {
    let policy = (await readAdminConfig(this.env)).vendorAdminPolicy[record.vendorId.toLowerCase()];
    if (policy === undefined) return;
    try {
      await (record.account as unknown as ComposioUserPolicy).updateToolkitPolicy(policy);
    } catch (err) {
      logger.error("failed to push vendor admin policy", {
        event: "vendor.policy.push.failed",
        vendorId: record.vendorId, accountId: record.id, error: err,
      });
    }
  }
  /**
   * Mint a gatekeeper class simulating a new resource of a creatable type (see
   * GatekeeperVendor.createResource()). It belongs to no account; the returned `action` is the
   * creation to queue.
   */
  async createResourceGatekeeper(vendorId: string, resourceUrlPattern: string, title: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, typeUrlPattern: string,
                  action: ActionDescription}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error(`Unknown vendor "${vendorId}".`);
    let {class: cls, resource, action} = await (vendor as unknown as ResourceCreatorStub)
        .createResource(resourceUrlPattern, title);
    if (!resource.creatable) {
      throw new Error(`"${resource.title}" resources can't be created. ` +
          "listConnectableResources marks the types that can.");
    }
    await this.#assertResourceEnabled(vendorId, resource);
    return {class: cls, typeUrlPattern: resource.urlPattern, action};
  }
  // Block whole gatekeepers + disabled resources at the core-side chokepoints where a gatekeeper
  // class is minted (reached only via the user/UI-facing Overseer.newGatekeeper, blueprint
  // instantiation, and the agent's createExternalResource -- never from gadget code). An ambient
  // gatekeeper an admin set to "disabled" is blocked here too. Blocking here prevents minting a
  // capability to a disabled resource even if the request bypasses the (separately filtered)
  // picker/agent listings. A bound SaaS's plan composes with these: a vendor the plan doesn't
  // offer is refused the same way, with the admin's settings checked first so an admin-disabled
  // gatekeeper keeps its message when both apply.
  async #assertResourceEnabled(vendorId: string, resource: SupportedResource) {
    let config = await readAdminConfig(this.env);
    let normalized = vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(normalized) ||
        ambientGatekeeperMode(config, normalized) === "disabled") {
      throw new Error(
          `The "${vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }
    if (isResourceDisabled(config, normalized, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }
    let allowed = await allowedGatekeepers(this.env, this.ctx.id.toString());
    if (allowed !== null && !allowed.has(normalized)) {
      throw createPlanRefusalError("CONNECTOR_NOT_ON_PLAN",
          `The "${vendorId}" connector isn't available on your plan.`);
    }
  }
  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it, or to its
   * `applyCreation()` to create the resource in this account. Returns null if the
   * account no longer exists (or never existed). Throws if the account belongs to a different
   * vendor (not a legitimate UI state — only reachable by bypassing client-side filtering).
   *
   * Account *selection* (which of the user's accounts to use for a given binding) is done by the
   * frontend; this method validates and resolves a chosen account to its verifier.
   */
  async getVerifier(accountId: number, expectedVendorId: string)
      : Promise<Fetcher<GatekeeperUserVerifier> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) return null;
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }
  // All currently eligible accounts this selected user has with the requested vendor. The
  // gatekeeper, not the Workshop, decides what zero or multiple accounts mean for its operation.
  async #eligibleGatekeeperAccounts(vendorId: string): Promise<ConnectedAccountRecord[]> {
    if (!this.storage.created.get()) return [];
    vendorId = vendorId.toLowerCase();

    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(vendorId)) return [];

    await this.ensureAutoProvisionedAccounts();

    return [...this.connectedAccountRecords()].filter((record) =>
      record.vendorId === vendorId && areCredentialsValid(record) &&
      (!record.autoProvisioned || ambientGatekeeperMode(config, vendorId) !== "disabled")
    );
  }
  /**
   * Return every currently eligible account belonging to this selected user and
   * vendor, each with its own identity capability and the user's fresh
   * display-name snapshot. Returns an empty array when none qualify; does not
   * choose between multiple accounts. Accounts are resolved at redemption time
   * and need not be the same accounts the user had when the ticket was minted.
   *
   * Each result also carries the selected user's org memberships read afresh from the org
   * authority (#freshOrgMemberships): the snapshot a gatekeeper records at share time is what
   * makes its org-keyed grants resolve for them, from the moment the share lands, and retires
   * orgs whose membership has since ended.
   */
  async selectableGatekeeperUsers(vendorId: string): Promise<RedeemedGatekeeperUserSelection[]> {
    let accounts = await this.#eligibleGatekeeperAccounts(vendorId);
    if (accounts.length === 0) return [];
    let profile = { displayName: this.storage.profile.get().name };
    // Read once and duplicated across the results, like every other per-user fact here.
    let orgMemberships = await this.directory.freshOrgMemberships();
    return Promise.all(accounts.map(async account => ({
      verifier: await account.account.getVerifier(), profile, orgMemberships,
    })));
  }
  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account ? account.description : null;
  }
}
