// The admin capability facade over the AdminSettings Durable Object (admin-settings.ts):
// obtained via AuthenticatedApi.getAdminApi() (null for non-admins). The admin access check
// happens once when the capability is minted in server.ts, so these methods don't re-check.
// Extracted to its own file so the DO's file is the DO alone.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  AdminApi,
  AdminFormatPatch,
  AdminSettingsView,
  AiModelProvider,
  AmbientGatekeeperMode,
  BannerColor,
  BotDefinition,
  DeploymentUpdateStatus,
  GatewayModel,
  GatewayModelLevelTest,
  GatewayModelMode,
  GatewayModelSettings,
  GatewayModelTest,
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_INSTANCE_INSTRUCTIONS_LENGTH,
  MAX_SITE_NAME_LENGTH,
  ReasoningLevel,
  isAmbientGatekeeperMode,
  isBannerColor,
  isHexColor,
} from "@gadgets/workshop-shared/api";
import { ComposioToolkitInfo } from "@gadgets/workshop-shared/gatekeeper";
import type { AdminSettings } from "./admin-settings.js";
import type { VendorAdminPolicy } from "./storage-schema/admin-settings-storage.js";
import { siteLogoImage, validateSiteLogo } from "./site-logo.js";

// Capability for managing deployment-wide admin settings, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The admin access check happens once
// when the capability is minted in server.ts, so these methods don't re-check. This is a thin
// validation+forwarding facade over the AdminSettings DO — fully user-independent — so a disabled
// gatekeeper/resource can't be re-enabled via a crafted request, and the client never receives a
// stub to the DO's internal methods. Covers branding, agent instructions, signups, gatekeeper
// connector/resource availability, AI Gateway models, and whether an update is available;
// authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  /**
   * `adminUserId` is the requesting admin's identity, forwarded to gatekeepers when listing the
   * resource catalog (some are RBAC-gated per user). It's plain data — not a user-DO dependency.
   */
  constructor(private admin: DurableObjectStub<AdminSettings>, private adminUserId: string) {
    super();
  }

  getSettings(): Promise<AdminSettingsView> {
    return this.admin.getSettings(this.adminUserId);
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ signupsEnabled: enabled });
  }

  async setUserSearchEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ userSearchEnabled: enabled });
  }

  async setSiteName(name: string): Promise<void> {
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<AdminSettingsView['siteLogo']> {
    if (data !== null) validateSiteLogo(data);
    return siteLogoImage(await this.admin.setSiteLogo(data));
  }

  async setInstanceInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ instanceInstructions: text });
  }

  listDeploymentBots(): Promise<(BotDefinition & {id: string})[]> {
    return this.admin.listDeploymentBots();
  }

  addDeploymentBot(id: string, def: BotDefinition): Promise<void> {
    return this.admin.addDeploymentBot(id, def);
  }

  updateDeploymentBot(id: string, def: BotDefinition): Promise<void> {
    return this.admin.updateDeploymentBot(id, def);
  }

  removeDeploymentBot(id: string): Promise<void> {
    return this.admin.removeDeploymentBot(id);
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid gatekeeper mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode);
  }

  setVendorAdminPolicy(vendorId: string, policy: VendorAdminPolicy | null): Promise<void> {
    return this.admin.setVendorAdminPolicy(vendorId, policy);
  }


  getComposioToolkitInfo(slugs: string[]): Promise<ComposioToolkitInfo[] | null> {
    return this.admin.getComposioToolkitInfo(slugs);
  }

  async setAnnouncement(text: string): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text });
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } });
  }

  async setAccentColor(color: string): Promise<void> {
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color });
  }

  isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    return this.admin.isBlueprintFeatured(blueprintId);
  }

  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    return this.admin.setBlueprintFeatured(blueprintId, featured);
  }

  promoteFormat(blueprintId: string): Promise<void> {
    return this.admin.promoteFormat(blueprintId);
  }

  removeFormat(blueprintId: string): Promise<void> {
    return this.admin.removeFormat(blueprintId);
  }

  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    return this.admin.updateFormat(blueprintId, patch);
  }

  setFormatOrder(blueprintIds: string[]): Promise<void> {
    return this.admin.setFormatOrder(blueprintIds);
  }

  setGatewayModelMode(modelId: string, mode: GatewayModelMode): Promise<void> {
    return this.admin.setGatewayModelMode(modelId, mode);
  }

  addGatewayModel(model: GatewayModel): Promise<void> {
    return this.admin.addGatewayModel(model);
  }

  removeGatewayModel(modelId: string): Promise<void> {
    return this.admin.removeGatewayModel(modelId);
  }

  setUserModelsEnabled(enabled: boolean): Promise<void> {
    return this.admin.setUserModelsEnabled(enabled);
  }

  setModelsDevSuggestions(enabled: boolean): Promise<void> {
    return this.admin.setModelsDevSuggestions(enabled);
  }

  setGatewayModelSettings(modelId: string, settings: GatewayModelSettings): Promise<void> {
    return this.admin.setGatewayModelSettings(modelId, settings);
  }

  setDefaultReasoning(level: ReasoningLevel | null): Promise<void> {
    return this.admin.setDefaultReasoning(level);
  }

  setGatewayProviderEnabled(provider: AiModelProvider, enabled: boolean): Promise<void> {
    return this.admin.setGatewayProviderEnabled(provider, enabled);
  }

  testGatewayProvider(provider: AiModelProvider): Promise<GatewayModelTest> {
    return this.admin.testGatewayProvider(provider, this.adminUserId);
  }

  testGatewayModel(modelId: string): Promise<GatewayModelTest> {
    return this.admin.testGatewayModel(modelId, this.adminUserId);
  }

  testNewGatewayModel(model: GatewayModel): Promise<GatewayModelLevelTest[]> {
    return this.admin.testNewGatewayModel(model, this.adminUserId);
  }

  getUpdateStatus(): Promise<DeploymentUpdateStatus | null> {
    return this.admin.getUpdateStatus();
  }

  checkForUpdates(): Promise<DeploymentUpdateStatus | null> {
    return this.admin.checkForUpdates();
  }

  setUpdateChecksEnabled(enabled: boolean): Promise<void> {
    return this.admin.setUpdateChecksEnabled(enabled);
  }

  setUpdateCheckIntervalMinutes(minutes: number): Promise<void> {
    return this.admin.setUpdateCheckIntervalMinutes(minutes);
  }

  setUpdateMinimumAgeHours(hours: number): Promise<void> {
    return this.admin.setUpdateMinimumAgeHours(hours);
  }

  setUpdateNoticeSnoozeHours(hours: number): Promise<void> {
    return this.admin.setUpdateNoticeSnoozeHours(hours);
  }
}
