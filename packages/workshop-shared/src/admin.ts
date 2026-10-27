// The admin surface: site/banner/update settings vocabulary, the admin resource and vendor
// grammar, the AdminSettingsView/AdminFormat projections, the deployment-update status, and
// the AdminApi interface the admin UI speaks. Re-exported from api.ts, the single import
// surface of the API.


import type { DeploymentBotAdminMethods } from "./bots.js";
import type { AvatarImage, ComposioToolkitInfo, SupportedResource, VendorDescription } from "./gatekeeper.js";
import type { AdminGatewayProvider, AdminModelView, AiModelProvider, GatewayModel, GatewayModelLevelTest, GatewayModelMode, GatewayModelSettings, GatewayModelTest, ReasoningLevel } from "./models.js";
import type { BlueprintOutput } from "./workspace.js";
/** Maximum length (characters) of the admin announcement / banner text. */
export const MAX_ANNOUNCEMENT_LENGTH = 2000;

/**
 * Accent colors available for the full-width announcement banner. Soft status tints plus the brand
 * color, so a banner need not look like an alert.
 */
export type BannerColor = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

export const BANNER_COLORS: BannerColor[] =
    ['neutral', 'info', 'success', 'warning', 'danger', 'brand'];

export const DEFAULT_BANNER_COLOR: BannerColor = 'info';

export function isBannerColor(value: unknown): value is BannerColor {
  return typeof value === 'string' && (BANNER_COLORS as string[]).includes(value);
}

/** The deployment-wide full-width banner configuration. */
export type BannerConfig = {
  /** Banner text (Markdown supported). Empty string hides the banner. */
  text: string;
  /** Accent color. */
  color: BannerColor;
};

/**
 * Whether `value` is a valid 3- or 6-digit hex color (e.g. "#abc" or "#aabbcc"). Used to validate
 * the admin accent color before it's interpolated into CSS, preventing CSS injection.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** A single gatekeeper resource type in the admin resource-config UI. */
export type AdminResource = {
  /** The resource's urlPattern, used as its stable identifier. */
  urlPattern: string;
  title: string;
  description: string;
  icon?: AvatarImage;
  /** Whether this resource is currently enabled (not in the admin disabled set). */
  enabled: boolean;
};

/**
 * Provisioning mode for an auto-provisioning ("ambient") gatekeeper — one that mints a connected
 * account with no OAuth flow (VendorDescription.autoProvisionsAccount), e.g. the Context Library:
 *   - 'disabled': not available; no account is provisioned and any existing one is dormant.
 *   - 'optional': users opt in from the Connectors page; not forced on anyone (the default).
 *   - 'enabled':  auto-provisioned for every user (forced); they can't remove it.
 */
export const AMBIENT_GATEKEEPER_MODES = ['disabled', 'optional', 'enabled'] as const;
export type AmbientGatekeeperMode = typeof AMBIENT_GATEKEEPER_MODES[number];

export function isAmbientGatekeeperMode(value: unknown): value is AmbientGatekeeperMode {
  return AMBIENT_GATEKEEPER_MODES.includes(value as AmbientGatekeeperMode);
}

/**
 * A vendor's admin-configured policy entry (see `AdminSettingsView.vendorAdminPolicy`). The
 * toolkit lists are the toolkit-policy shape Composio defines (`ComposioToolkitPolicy` in
 * gatekeeper.ts); a vendor whose admin policy needs a different shape gets its own field rather
 * than widening this one.
 */
export type VendorAdminPolicy = {
  excludedToolkits: string[];
  autoApplyToolkits: string[];
};

/**
 * A bound gatekeeper in the admin gatekeeper-config UI, discriminated by `autoProvisions`:
 *   - an ordinary OAuth/resource gatekeeper has a binary `enabled` flag and `resources` to toggle;
 *   - an auto-provisioning ("ambient") gatekeeper has a three-state `ambientMode` and no resources.
 */
export type AdminResourceVendor = {
  vendorId: string;
  displayName: string;
  logo?: AvatarImage;
} & (
  | { autoProvisions: false; enabled: boolean; resources: AdminResource[] }
  | { autoProvisions: true; ambientMode: AmbientGatekeeperMode }
);

/**
 * A connectable third-party service: its vendor id, display metadata, and the resource types it
 * offers (empty for an auto-provisioning gatekeeper like the Context Library). Returned by both
 * listGatekeeperVendors and listAddableGatekeepers so the connect UI treats both uniformly.
 */
export type GatekeeperVendorInfo = {
  id: string;
  description: VendorDescription;
  supportedResources: SupportedResource[];
  /**
   * Present when a bound gatekeeper could not be queried. UIs should surface this to the user but
   * not offer it as connectable.
   */
  unavailable?: boolean;
};

/** Maximum length (characters) of the admin-authored agent system-prompt instructions. */
export const MAX_INSTANCE_INSTRUCTIONS_LENGTH = 8000;

/** Maximum length (characters) of the admin-authored site name shown next to the top-bar logo. */
export const MAX_SITE_NAME_LENGTH = 40;

/**
 * What this deployment calls itself when the admin has not set a custom `siteName`. Also the
 * product's own name, so it appears in prose the server and UI address to the user.
 */
export const DEFAULT_SITE_NAME = "Cloudflare OS";

/**
 * The name to display for this deployment. Accepts an unset or not-yet-loaded `siteName` so both
 * the server (reading admin config) and the client (reading ServerConfig) resolve it identically.
 */
export function resolveSiteName(siteName: string | undefined): string {
  return (siteName ?? "").trim() || DEFAULT_SITE_NAME;
}

/** Maximum byte length of an admin-uploaded site logo after browser-side PNG conversion. */
export const MAX_SITE_LOGO_BYTES = 256 * 1024;

/** Maximum width or height of an admin-uploaded site logo in pixels. */
export const MAX_SITE_LOGO_DIMENSION = 512;

/**
 * The default of the deployment's check interval (see AdminApi.setUpdateCheckIntervalMinutes): how
 * many minutes a successful update check is relied on before the deployment asks again.
 */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES = 60;

/** The largest check interval, in minutes, an admin may set: 30 days. */
export const MAX_UPDATE_CHECK_INTERVAL_MINUTES = 43_200;

/**
 * The default of the deployment's minimum age (see AdminApi.setUpdateMinimumAgeHours): how many
 * hours a newer release must have been available before admins are notified of it.
 */
export const DEFAULT_UPDATE_MINIMUM_AGE_HOURS = 24;

/**
 * The default of the deployment's notice snooze (see AdminApi.setUpdateNoticeSnoozeHours): how
 * many hours a dismissed update notice stays hidden in the browser that dismissed it.
 */
export const DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS = 24;

/** The largest minimum age and notice snooze, in hours, an admin may set: 30 days. */
export const MAX_UPDATE_HOURS = 720;

/**
 * The path a Workshop browser POSTs to, through the router, before it reads the update status, so
 * that the backend records the router's current version tag first. The Workshop's other calls
 * travel over one WebSocket, which carries the router's tag only when it opens. Answered with an
 * empty 204.
 */
export const ROUTER_TAG_PROBE_PATH = "/api/router-tag";

/**
 * The path a Workshop browser GETs, through the router, to learn the version id of the backend that
 * new requests reach: `{ version: string | null }`, never cached, `null` where the backend has no
 * version id. A deploy does not move the WebSocket a tab already holds, so a tab whose
 * `ServerConfig.backendVersion` differs is still talking to an older backend, and reconnects.
 */
export const VERSION_PATH = "/api/version";

/** All admin-managed deployment settings, returned by AdminApi.getSettings() for the admin UI. */
export type AdminSettingsView = {
  /** Whether new account signups are allowed. */
  signupsEnabled: boolean;
  /** Whether users may search the user directory to find collaborators. */
  userSearchEnabled: boolean;
  /** Site name shown next to the top-bar logo ("" falls back to DEFAULT_SITE_NAME). */
  siteName: string;
  /** Custom deployment logo, or undefined to use the default Cloudflare OS mark. */
  siteLogo?: AvatarImage;
  /** Agent system-prompt instructions ("" when unset). */
  instanceInstructions: string;
  /** Top-bar notice text ("" when unset). */
  announcement: string;
  /** Full-width banner (text + accent color). */
  banner: BannerConfig;
  /** Accent color hex, or "" for the default theme. */
  accentColor: string;
  /** Every bound gatekeeper and its resource types, with enabled state (not hidden when disabled). */
  resourceVendors: AdminResourceVendor[];
  /**
   * Per-vendor admin policy snapshots, keyed by vendor id (currently "composio"; see
   * AdminApi.setVendorAdminPolicy). Exact toolkit slugs; a dead slug matches nothing and is
   * surfaced as a warning by the admin editor (see getComposioToolkitInfo).
   */
  vendorAdminPolicy: Record<string, VendorAdminPolicy>;
  /** The blueprints promoted as standard output formats, in menu order (including disabled ones). */
  formats: AdminFormat[];
  /** The models the deployment provides through AI Gateway. Absent outside AI Gateway mode. */
  gatewayModels?: {
    /** The providers a model may be added under: the ones the gateway both enables and serves. */
    providers: AiModelProvider[];
    /** Every provider the gateway serves, on or off, in the order the models are listed in. */
    providerSettings: AdminGatewayProvider[];
    /** Every gateway model, in any mode, in listing order. */
    models: AdminModelView[];
    /**
     * The reasoning level of each gateway model that has none of its own (see
     * AdminApi.setDefaultReasoning), or null while the deployment sets none.
     */
    defaultReasoning: ReasoningLevel | null;
    /** Whether users may add models of their own (see AdminApi.setUserModelsEnabled). */
    userModelsEnabled: boolean;
    /**
     * Whether the admin UI may suggest models from models.dev while an admin adds one (see
     * AdminApi.setModelsDevSuggestions).
     */
    modelsDevSuggestions: boolean;
  };
};

/**
 * One promoted blueprint, as the admin Formats panel sees it: the deployment's curation plus
 * enough of the blueprint to show what is being curated.
 */
export type AdminFormat = {
  blueprintId: string;

  blueprintTitle: string;

  /**
   * The blueprint's own description, which is the rest of the catalog entry the agent reads;
   * `agentHint` is only its last line.
   */
  blueprintDescription: string;

  /** Presentation after the deployment's overrides are applied. */
  output?: BlueprintOutput;

  /** What the blueprint itself declares, so the panel can show which fields are overridden. */
  declared?: BlueprintOutput;

  /** The deployment's presentation overrides, if any. */
  overrides?: Partial<BlueprintOutput>;

  enabled: boolean;

  /** One line telling the agent when to prefer this format. */
  agentHint: string;

  /**
   * The promoted blueprint no longer exists (deleted after promotion). Such an entry is skipped
   * everywhere else; the panel surfaces it so the admin can remove it.
   */
  missing: boolean;

  /**
   * The blueprint ships with the deployment (see packages/bundled-blueprints and the
   * BUNDLED_BLUEPRINTS the backend's build generates from it), so an upgrade can replace its contents. Curation stays the admin's: an upgrade never re-promotes something they
   * removed, nor resets their overrides.
   */
  bundled: boolean;
};

/**
 * Whether a newer release is available for a deployment the deploy flow installed, returned by
 * AdminApi.getUpdateStatus(). The check fields describe the last successful update check made for
 * the release this backend runs: until one succeeds, `latestReleaseId`, `availableSince` and
 * `checkedAt` are absent and `updateAvailable` is false.
 */
export type DeploymentUpdateStatus = {
  /** The release this backend runs. */
  currentReleaseId: string;
  /** The newest release the last successful check for `currentReleaseId` reported. */
  latestReleaseId?: string;
  /** Whether that check said a release newer than `currentReleaseId` exists. */
  updateAvailable: boolean;
  /**
   * When the first release newer than `currentReleaseId` was published. Absent unless
   * `updateAvailable`.
   */
  availableSince?: Date;
  /**
   * Whether the home page should show admins the update notice now, before the browser applies
   * its own dismissal (see `noticeSnoozeHours`). True exactly when `checksEnabled`, the check says
   * `updateAvailable`, the deployment is not `modified`, and `availableSince` is at least
   * `minimumAgeHours` ago.
   */
  notify: boolean;
  /**
   * Whether the deployment checks for updates by itself (see AdminApi.setUpdateChecksEnabled).
   * When false, `notify` is false and only AdminApi.checkForUpdates() asks for the newest release.
   */
  checksEnabled: boolean;
  /**
   * The deployment's check interval: how many minutes a successful check is relied on before the
   * deployment asks again (see AdminApi.setUpdateCheckIntervalMinutes).
   */
  checkIntervalMinutes: number;
  /**
   * The deployment's minimum age: how many hours a newer release must have been available before
   * `notify` is true (see AdminApi.setUpdateMinimumAgeHours).
   */
  minimumAgeHours: number;
  /**
   * The deployment's notice snooze: how many hours a browser hides the notice after an admin
   * dismisses it there (see AdminApi.setUpdateNoticeSnoozeHours).
   */
  noticeSnoozeHours: number;
  /**
   * Whether this deployment's running code differs from what the deploy flow installed: true
   * exactly when `modifiedWorkers` is non-empty. The deploy flow refuses to upgrade a modified
   * deployment.
   */
  modified: boolean;
  /**
   * The Workers whose running version is neither this installation's current one nor another
   * release of it: they have no version tag, or one the deploy flow did not write for this
   * installation. Each is "backend", "router", or a gatekeeper's install slug. A Worker that did
   * not report its version is in neither this list nor `unfinishedWorkers`.
   */
  modifiedWorkers: string[];
  /**
   * The Workers still running another release of this installation: an update that did not
   * finish, which the deploy flow can finish once no Worker is modified. Named as in
   * `modifiedWorkers`. Unlike those, they do not affect `notify`.
   */
  unfinishedWorkers: string[];
  /** The opaque link that opens the deploy flow for this installation. */
  updateUrl: string;
  /** When the last successful check for `currentReleaseId` was made. */
  checkedAt?: Date;
};

/**
 * Capability for managing deployment-wide admin settings, obtained via
 * AuthenticatedApi.getAdminApi() (which is null for non-admins). The access check happens when the
 * capability is minted, so these methods don't re-check. Covers branding, agent instructions,
 * which gatekeeper connectors/resources are offered, and the models an AI Gateway deployment
 * provides — NOT authentication config (that's env-var driven). Each setter throws on invalid
 * input.
 */
export interface AdminApi extends DeploymentBotAdminMethods {
  /** Read all admin-managed settings for the admin UI in one call. */
  getSettings(): Promise<AdminSettingsView>;

  /** Enable or disable new account signups. Existing users can still log in while signups are closed. */
  setSignupsEnabled(enabled: boolean): Promise<void>;

  /**
   * Enable or disable user directory search. The directory itself is maintained
   * either way, and this switch just controls user access.
   */
  setUserSearchEnabled(enabled: boolean): Promise<void>;

  /**
   * Set the site name shown next to the top-bar logo. Pass "" to reset to DEFAULT_SITE_NAME.
   * Rejects over MAX_SITE_NAME_LENGTH.
   */
  setSiteName(name: string): Promise<void>;

  /** Set the deployment logo from browser-rasterized PNG bytes and return its canonical public
   * image, or undefined after reset. Pass null to restore the default Cloudflare OS mark. The
   * caller must supply decodable PNG data; the server enforces its header, size, and dimensions. */
  setSiteLogo(data: Uint8Array | null): Promise<AvatarImage | undefined>;

  /** Replace the agent system-prompt instructions. Pass "" to clear. Rejects over MAX_INSTANCE_INSTRUCTIONS_LENGTH. */
  setInstanceInstructions(text: string): Promise<void>;

  /**
   * Enable or disable a single gatekeeper resource type, keyed by vendor id + resource urlPattern.
   * Soft enforcement: disabling hides the resource from the connect UI, the resource picker, and the
   * agent; it doesn't revoke a capability a gadget already holds.
   */
  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void>;

  /**
   * Set a gatekeeper's availability. For an auto-provisioning ("ambient") gatekeeper, `mode` is the
   * full three-state (disabled / optional / enabled); for an ordinary gatekeeper only 'disabled' /
   * 'enabled' are valid ('optional' is rejected). Soft enforcement: it doesn't revoke a capability a
   * gadget already holds, and 'disabled' leaves an ambient account's data dormant rather than deleting
   * it.
   */
  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void>;

  /**
   * Set one vendor's admin policy entry (currently the Composio toolkit lists), or remove the
   * vendor's entry with null so the vendor reads its own defaults again, as if never configured.
   * Lists hold exact toolkit slugs; entries matching no live toolkit match nothing and are
   * surfaced as warnings by the admin editor (see getComposioToolkitInfo). An entry with empty
   * lists means "configured to nothing" and still reaches the vendor's accounts. An upsert for a
   * vendor that isn't bound is rejected.
   */
  setVendorAdminPolicy(vendorId: string, policy: VendorAdminPolicy | null): Promise<void>;

  /**
   * Check Composio toolkit slugs against the vendor's live catalog and count each one's tools:
   * those eligible for auto-apply (tagged createHint or updateHint, not destructiveHint) and those
   * tagged destructive. Returns null when the Composio gatekeeper isn't bound, so the editor can
   * say it cannot validate rather than show a wrong answer.
   *
   * Vendor-named deliberately, per the `VendorAdminPolicy` principle above: the counts follow
   * Composio's own tag grammar, and a second vendor growing toolkit validation gets its own
   * extension method set, not a parameterized version of this one.
   */
  getComposioToolkitInfo(slugs: string[]): Promise<ComposioToolkitInfo[] | null>;

  /**
   * Set the top-bar notice (centered text in the top navigation bar). Pass "" to clear. Rejects over
   * MAX_ANNOUNCEMENT_LENGTH.
   */
  setAnnouncement(text: string): Promise<void>;

  /**
   * Set the full-width banner. Pass an empty text to hide it. Rejects over MAX_ANNOUNCEMENT_LENGTH or
   * an invalid color.
   */
  setBanner(text: string, color: BannerColor): Promise<void>;

  /**
   * Set the deployment accent color (hex, e.g. "#3b82f6"). Pass "" to reset to the default theme.
   * Rejects an invalid hex color.
   */
  setAccentColor(color: string): Promise<void>;

  /**
   * Returns whether the blueprint is featured on the deployment. Returns null when the blueprint
   * can't be featured (e.g. it isn't a listable blueprint).
   */
  isBlueprintFeatured(blueprintId: string): Promise<boolean | null>;

  /** Mark or unmark a blueprint as featured on the deployment. */
  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void>;

  // --- Standard output formats ---
  //
  // Promotion is what makes a blueprint one of the deployment's standard formats: offered in the
  // "New ..." menu and listed first for the agent. A blueprint declaring what it produces is
  // presentation, and never enough on its own.

  /**
   * Offer a blueprint as a standard format, appended last in menu order. Throws if the blueprint
   * doesn't exist. Promoting one that already is leaves its curation and menu position alone, so
   * that retrying a promotion whose mirror write failed repairs it rather than being refused.
   */
  promoteFormat(blueprintId: string): Promise<void>;

  /**
   * Stop offering a blueprint as a standard format, and forget the deployment's curation of it.
   * The blueprint itself is untouched.
   *
   * Refused for a bundled blueprint (see `AdminFormat.bundled`), which the deployment installed
   * and will reinstall: `enabled: false` withdraws it without discarding the admin's overrides,
   * hint and menu position.
   */
  removeFormat(blueprintId: string): Promise<void>;

  /**
   * Update one promoted format. Only the provided fields change. `agentHint: ""` clears the hint;
   * an `overrides` field set to null reverts that field to the blueprint's own declaration.
   */
  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void>;

  /** Reorder the menu. `blueprintIds` must be a permutation of the currently promoted ids. */
  setFormatOrder(blueprintIds: string[]): Promise<void>;

  // --- AI Gateway models ---
  //
  // The models the deployment provides through AI Gateway (AdminSettingsView.gatewayModels). Each
  // of these throws outside AI Gateway mode.

  /**
   * Set how the deployment offers one of its gateway models (see GatewayModelMode). Setting the
   * model's default mode forgets the override, so the model follows its default from then on.
   * Throws if `modelId` is not one of the deployment's gateway models.
   *
   * 'disabled' revokes nothing that is stored: the chats, spawners, preferences and gadget model
   * bindings that name the model keep naming it, and stop resolving for as long as it is disabled.
   */
  setGatewayModelMode(modelId: string, mode: GatewayModelMode): Promise<void>;

  /**
   * Add a model to the ones the deployment provides, listed after its provider's suggested models
   * and 'enabled' by default. Throws if the model is malformed (an empty or over-long ID or name,
   * an over-long `behavesLike`, a token limit that isn't a positive integer), if the gateway does
   * not serve and enable its provider (see AdminSettingsView.gatewayModels), if a suggested or
   * added model already has its ID, if the model runtime does not know its `behavesLike` under
   * its provider, or if what its context window reserves for the response (its output limit, or
   * WORKERS_AI_OUTPUT_LIMIT for a Cloudflare model that gives none) leaves a prompt no room.
   */
  addGatewayModel(model: GatewayModel): Promise<void>;

  /**
   * Remove a model added with addGatewayModel(), along with its mode and settings. Throws if no
   * added model has this ID; a suggested model can't be removed, only disabled.
   *
   * Removing frees the ID rather than reserving it. The chats, spawners and preferences that name
   * the model resolve again if a model is later added under the same ID. A gadget model binding
   * minted for it carries its own provider and model, so while users may add their own models
   * (see setUserModelsEnabled) it runs once the model is removed, even if the model was disabled.
   * To shut a model off, disable it instead.
   */
  removeGatewayModel(modelId: string): Promise<void>;

  /**
   * Set whether users may add models of their own, which run through the deployment's gateway
   * like the models it provides. On by default.
   *
   * Off makes the deployment's models the only ones: a user can't add or edit a model, and the
   * models users added are neither listed nor resolved. A gadget model binding stops at its next
   * call unless a gateway model has its provider and model. Nothing stored is deleted, so the
   * models users added work again once this is back on.
   */
  setUserModelsEnabled(enabled: boolean): Promise<void>;

  /**
   * Set whether the admin UI may suggest models from models.dev while an admin adds one. Off by
   * default.
   *
   * The admin's browser reads the setting and, with it on, downloads models.dev's public model
   * list while an admin adds a model, to fill in the add-model form. It changes nothing the server
   * does: the server never contacts models.dev, and addGatewayModel() validates a suggested model
   * like any other.
   */
  setModelsDevSuggestions(enabled: boolean): Promise<void>;

  /**
   * Replace what the deployment sets for one of its gateway models (see GatewayModelSettings):
   * a field left out of `settings` is unset, and an empty `settings` unsets everything. Throws
   * if `modelId` is not one of the deployment's gateway models, or if the compaction budget is
   * not a positive whole number within the model's maximum (see
   * AdminModelView.maxCompactionInputBudget).
   *
   * The reasoning level may be one the model lacks, since it is fitted to the model when a
   * request is made (see ReasoningLevel).
   */
  setGatewayModelSettings(modelId: string, settings: GatewayModelSettings): Promise<void>;

  /**
   * Set the reasoning level of every gateway model that has none of its own, or null for each
   * model's built-in behaviour. It never applies to a model a user added.
   */
  setDefaultReasoning(level: ReasoningLevel | null): Promise<void>;

  /**
   * Turn a provider on or off beside the ones CF_AI_GATEWAY_PROVIDERS lists. On is the same as
   * listing it there: its suggested models appear in their default modes, models can be added
   * under it, and so can users' own while those are allowed. Throws for a provider the gateway
   * does not serve, and when turning off one that the variable lists: it is a floor, which an
   * admin adds to.
   *
   * Off takes the provider's models out of the deployment's and deletes nothing: their modes and
   * settings, and the models added under the provider, are kept for when it is back on. It stops
   * neither a model a user already added under the provider nor a gadget model binding already
   * minted for one of its models, which setUserModelsEnabled(false) does.
   */
  setGatewayProviderEnabled(provider: AiModelProvider, enabled: boolean): Promise<void>;

  /**
   * Send one small request to the first of a provider's SUGGESTED_MODELS through the gateway, as
   * the admin, and report what happened within 15 seconds: the Workshop can't see which provider
   * keys the gateway holds. It works on a provider that is off, and changes nothing. Throws for
   * a provider the gateway does not serve; a request that fails is a result (see
   * GatewayModelTest).
   *
   * A pass says that one model answered once. A 401 or 403 does not tell a provider key the
   * gateway lacks from a CF_AI_GATEWAY_API_TOKEN that may not run models. The request is a
   * quick one that takes none of a model's settings: testGatewayModel() sends a model the
   * request its chats would.
   */
  testGatewayProvider(provider: AiModelProvider): Promise<GatewayModelTest>;

  /**
   * Send one request to a gateway model the way a chat turn would, through the gateway, as the
   * admin, and report what happened within 30 seconds. The request asks for the reasoning level
   * in effect for the model (its own, else the deployment's default, else what BuiltInReasoning
   * describes), with the capabilities stated for it and the flags of the model it behaves like,
   * under a response cap of at most 2,048 tokens. A level that a model takes as a token budget
   * comes out of that cap, so it is cut to the room the cap leaves and is smaller than a chat's.
   * It works on a model in any mode, hidden and disabled included, and changes nothing. Throws
   * outside AI Gateway mode and for an ID that names no gateway model; a request that fails is a
   * result (see GatewayModelTest).
   *
   * A pass says that the model answered that one request. It costs more than
   * testGatewayProvider(), whose quick request is capped at a few tokens.
   */
  testGatewayModel(modelId: string): Promise<GatewayModelTest>;

  /**
   * Test a model as described, without adding it. It sends one request the way a chat turn would
   * with no reasoning level set (so asking for what BuiltInReasoning describes, whatever the
   * deployment's default level is), and one at each reasoning level the model would list once
   * added (see AdminModelView.reasoningLevels). The requests are sent together, through the
   * gateway, as the admin, each under testGatewayModel()'s response cap and time limit. The
   * results come with the request that set no level first, then the levels from least to most.
   * It stores nothing. Throws outside AI Gateway mode and for a model addGatewayModel() would
   * refuse, for the same reason; a request that fails is a result (see GatewayModelLevelTest).
   *
   * A pass says that the model answered that one request. A model that lists every level is sent
   * eight requests, each of which may use the whole response cap.
   */
  testNewGatewayModel(model: GatewayModel): Promise<GatewayModelLevelTest[]>;

  /**
   * Whether a newer release is available. Null unless the deploy flow installed this deployment.
   * While automatic update checks are off (see setUpdateChecksEnabled) it asks no one and reports
   * the last check made for the running release, if any.
   */
  getUpdateStatus(): Promise<DeploymentUpdateStatus | null>;

  /**
   * Ask now for the newest release, whether or not automatic update checks are on, and return
   * the status that check produces. Null unless the deploy flow installed this deployment. Throws
   * when the check fails.
   */
  checkForUpdates(): Promise<DeploymentUpdateStatus | null>;

  /**
   * Set whether the deployment checks for updates by itself. On by default. When off,
   * getUpdateStatus() makes no outbound call and admins are never notified; checkForUpdates()
   * still asks.
   */
  setUpdateChecksEnabled(enabled: boolean): Promise<void>;

  /**
   * Set how many minutes a successful update check is relied on before the deployment asks again,
   * DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES by default. A failed check is retried after the interval
   * or 15 minutes, whichever is shorter. The deployment asks only while an admin is using it
   * (getUpdateStatus() makes the check when one is due), never on a schedule of its own. Throws
   * unless `minutes` is a whole number from 1 to MAX_UPDATE_CHECK_INTERVAL_MINUTES.
   */
  setUpdateCheckIntervalMinutes(minutes: number): Promise<void>;

  /**
   * Set how many hours a newer release must have been available before admins are notified of
   * it, DEFAULT_UPDATE_MINIMUM_AGE_HOURS by default. It delays the notice only: an update always
   * installs the newest release. 0 notifies as soon as a check reports an update. Throws unless
   * `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   */
  setUpdateMinimumAgeHours(hours: number): Promise<void>;

  /**
   * Set how many hours a dismissed update notice stays hidden in the browser that dismissed it,
   * DEFAULT_UPDATE_NOTICE_SNOOZE_HOURS by default. 0 means a closed notice comes back on the next
   * visit to Home. Throws unless `hours` is a whole number from 0 to MAX_UPDATE_HOURS.
   */
  setUpdateNoticeSnoozeHours(hours: number): Promise<void>;
}

/** A partial edit to one promoted format. Absent fields are left alone. */
export type AdminFormatPatch = {
  enabled?: boolean;
  agentHint?: string;
  /**
   * Per-field presentation overrides. A field set to null reverts to the blueprint's declaration;
   * a field left absent is unchanged.
   */
  overrides?: {[K in keyof BlueprintOutput]?: BlueprintOutput[K] | null};
};

/**
 * A gatekeeper vendor offered as a sign-in method. The login/signup pages render a "Continue with
 * ..." button per entry, alongside (never replacing) username/password. Built from auth-capable
 * gatekeepers (VendorDescription.providesAuth) that are in the deployment's auth allowlist.
 */
export type AuthVendorInfo = {
  /** The gatekeeper vendor id (the GATEKEEPER_<NAME> binding suffix, lowercased), e.g. "google". */
  vendorId: string;
  /** Display name, logo, and brand color from the gatekeeper's VendorDescription. */
  displayName: string;
  logo?: AvatarImage;
  color?: string;
};

/**
 * Deployment-level configuration that the client needs at boot to decide what UI to render.
 * Returned by `PublicApi.getServerConfig()`. Contains no secrets.
 */
export type ServerConfig = {
  /**
   * Auth-capable, allowlisted gatekeeper vendors offered as sign-in methods. Empty when none are
   * configured (password-only).
   */
  authVendors: AuthVendorInfo[];

  /**
   * Whether username/password login is available. Defaults to true; an installation can disable it
   * (DISABLE_PASSWORD_AUTH) to be OAuth-only. Forced true if no auth vendor is configured, to avoid
   * locking everyone out.
   */
  passwordAuthEnabled: boolean;

  /**
   * Whether the optional Cloudflare free-tier limits + top-up flow is enabled. When false (the
   * default, e.g. self-hosted), usage is unlimited and the credits UI is hidden.
   */
  cloudflareLimitsEnabled: boolean;
  /**
   * Whether this deployment runs in hosted SaaS mode (env-driven, default false). The compile-time
   * `VITE_SAAS` build flag decides which frontend bundle has SaaS surfaces at all; this value lets
   * that bundle also learn the backend's mode at runtime.
   */
  saasEnabled: boolean;


  /**
   * Whether new account signups are allowed (admin-configurable, default true). The signup page
   * hides the create-account form when false.
   */
  signupsEnabled: boolean;

  /**
   * Whether users may search the user directory to find collaborators. When not explicitly
   * configured, this defaults to the opposite of `signupsEnabled`. When false the share UI offers
   * only an exact username/email field.
   */
  userSearchEnabled: boolean;

  /**
   * Site name shown next to the top-bar logo (admin-configurable). Empty falls back to
   * DEFAULT_SITE_NAME.
   */
  siteName: string;

  /** Custom deployment logo, or undefined to use the default Cloudflare OS mark. */
  siteLogo?: AvatarImage;

  /** Deployment-wide top-bar notice (centered text in the top navigation bar). Empty when none is set. */
  announcement: string;

  /** Deployment-wide full-width banner shown across the top of the app. Empty text hides it. */
  banner: string;
  bannerColor: BannerColor;

  /**
   * Deployment accent (brand) color as a hex string, or "" to use the default theme. The client
   * overrides the brand CSS variables with this (and derived shades) at runtime.
   */
  accentColor: string;

  /**
   * The version id of the backend answering this connection, or undefined where it has none.
   * Compared with what VERSION_PATH answers to notice a connection that outlived a deploy.
   */
  backendVersion?: string;
};

/**
 * Usage + Cloudflare-connection status for the optional limits flow. Returned by
 * `AuthenticatedApi.getCloudflareUsage()`.
 */
export type CloudflareUsageInfo = {
  /** Whether the limits flow is enabled at all. When false, the rest is informational only. */
  cloudflareLimitsEnabled: boolean;
  /** When true, the user has unlimited access (limits disabled) and counters are not tracked. */
  unlimited: boolean;

  /** Free-tier daily usage. */
  dailyUsed: number;
  dailyLimit: number;
  remaining: number;
  /** ISO timestamp when the daily window resets. */
  resetAt?: string;

  /** Whether the user has connected a Cloudflare account. */
  connected: boolean;
  /** The connected account's AI Gateway credit balance (USD), or null if unknown/not connected. */
  balance: number | null;
  accountId?: string;
  accountName?: string;
  /**
   * True when connected but the user has multiple Cloudflare accounts and must pick which one to
   * bill before usage can proceed. The client should prompt with selectCloudflareAccount().
   */
  needsAccountSelection?: boolean;
};

/** A Cloudflare account available to a connected user. Returned by `listCloudflareAccounts()`. */
export type CloudflareAccountOption = {
  accountId: string;
  accountName: string;
};
