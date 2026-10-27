// Normalization of raw Home Assistant websocket payloads into the gatekeeper's public types,
// plus the entity filter and service-target helpers the session and facets share.

import { fetchRegistrySnapshot } from "./homeassistant-api";
import {
  type AreaInfo,
  type DeviceInfo,
  type EntityFilter,
  type EntityHistory,
  type EntityState,
  type EntitySummary,
  type FloorInfo,
  type HomeAssistantConfig,
  type LabelInfo,
  type LogbookEntry,
  type ServiceCallTarget,
  type ServiceInfo,
} from "./types";

import { HATarget } from "./ha-gatekeeper";

// ---------------------------------------------------------------------------
// Normalization helpers

export function normalizeArea(a: any): AreaInfo {
  return {
    id: a.area_id,
    name: a.name,
    aliases: a.aliases ?? [],
    floorId: a.floor_id ?? undefined,
    icon: a.icon ?? undefined,
    picture: a.picture ?? undefined,
  };
}

export function normalizeFloor(f: any): FloorInfo {
  return {
    id: f.floor_id,
    name: f.name,
    level: f.level ?? undefined,
    icon: f.icon ?? undefined,
    aliases: f.aliases ?? [],
  };
}

export function normalizeLabel(l: any): LabelInfo {
  return {
    id: l.label_id,
    name: l.name,
    color: l.color ?? undefined,
    icon: l.icon ?? undefined,
    description: l.description ?? undefined,
  };
}

export function normalizeDevice(d: any): DeviceInfo {
  return {
    id: d.id,
    name: d.name_by_user ?? d.name ?? d.id,
    manufacturer: d.manufacturer ?? undefined,
    model: d.model ?? undefined,
    hwVersion: d.hw_version ?? undefined,
    swVersion: d.sw_version ?? undefined,
    configEntries: d.config_entries ?? [],
    areaId: d.area_id ?? undefined,
    disabled: d.disabled_by != null,
    labels: d.labels ?? [],
  };
}

export function summarizeEntity(
  snapshot: { entities: any[]; devices: any[]; states: Map<string, any> } | Awaited<ReturnType<typeof fetchRegistrySnapshot>>,
  entityId: string,
): EntitySummary | undefined {
  const registryEntity = (snapshot.entities as any[]).find((e: any) => e.entity_id === entityId);
  const state = snapshot.states.get(entityId);
  if (!registryEntity && !state) return undefined;
  return buildSummary(registryEntity, state, snapshot.devices as any[]);
}

export function buildSummary(registryEntity: any | undefined, state: any | undefined, devices: any[]): EntitySummary {
  const entityId = registryEntity?.entity_id ?? state?.entity_id;
  const domain = String(entityId).split(".")[0];
  const device = registryEntity?.device_id
    ? devices.find((d: any) => d.id === registryEntity.device_id)
    : undefined;
  const areaId =
    registryEntity?.area_id ??
    device?.area_id ??
    undefined;
  const name =
    registryEntity?.name ??
    registryEntity?.original_name ??
    state?.attributes?.friendly_name ??
    entityId;

  const lastChanged = state?.last_changed ? Date.parse(state.last_changed) : undefined;
  const lastUpdated = state?.last_updated ? Date.parse(state.last_updated) : undefined;

  let entityCategory: "config" | "diagnostic" | undefined;
  if (registryEntity?.entity_category === "config") entityCategory = "config";
  else if (registryEntity?.entity_category === "diagnostic") entityCategory = "diagnostic";

  return {
    entityId,
    domain,
    name,
    state: state?.state ?? "unknown",
    icon: registryEntity?.icon ?? state?.attributes?.icon ?? undefined,
    deviceId: registryEntity?.device_id ?? undefined,
    areaId,
    labels: registryEntity?.labels ?? [],
    entityCategory,
    disabled: registryEntity?.disabled_by != null,
    hidden: registryEntity?.hidden_by != null,
    lastChanged: lastChanged && !Number.isNaN(lastChanged) ? lastChanged : undefined,
    lastUpdated: lastUpdated && !Number.isNaN(lastUpdated) ? lastUpdated : undefined,
  };
}

export function normalizeState(raw: any): EntityState {
  return {
    entityId: raw.entity_id,
    state: raw.state,
    attributes: raw.attributes ?? {},
    lastChanged: raw.last_changed,
    lastUpdated: raw.last_updated,
    context: raw.context
      ? {
          id: raw.context.id,
          userId: raw.context.user_id ?? null,
          parentId: raw.context.parent_id ?? null,
        }
      : undefined,
  };
}

export function normalizeConfig(raw: any): HomeAssistantConfig {
  return {
    locationName: raw.location_name,
    version: raw.version,
    timeZone: raw.time_zone,
    unitSystem: raw.unit_system ?? {},
    allowlistExternalUrls: raw.allowlist_external_urls ?? undefined,
    latitude: raw.latitude ?? undefined,
    longitude: raw.longitude ?? undefined,
    elevation: raw.elevation ?? undefined,
    currency: raw.currency ?? undefined,
    language: raw.language ?? undefined,
  };
}

export function normalizeHistoryBundle(bundle: any[]): EntityHistory[] {
  // HA returns an array of arrays, one per entity, oldest-first.
  const out: EntityHistory[] = [];
  for (const series of bundle) {
    if (!Array.isArray(series) || series.length === 0) continue;
    const entityId = series[0].entity_id ?? series[0].entityId;
    out.push({
      entityId,
      states: series.map((s: any) => ({
        state: s.state,
        attributes: s.attributes ?? {},
        lastChanged: s.last_changed ?? s.lastChanged,
        lastUpdated: s.last_updated ?? s.lastUpdated,
      })),
    });
  }
  return out;
}

export function normalizeLogbook(items: any[]): LogbookEntry[] {
  return items.map((i: any) => ({
    when: i.when,
    name: i.name,
    message: i.message,
    entityId: i.entity_id ?? undefined,
    state: i.state ?? undefined,
    domain: i.domain ?? undefined,
    contextUserId: i.context_user_id ?? undefined,
  }));
}

export function normalizeServices(raw: any[]): ServiceInfo[] {
  const out: ServiceInfo[] = [];
  for (const domainEntry of raw) {
    const domain = domainEntry.domain;
    const services = domainEntry.services ?? {};
    for (const [serviceName, info] of Object.entries<any>(services)) {
      out.push({
        domain,
        service: serviceName,
        name: info?.name ?? undefined,
        description: info?.description ?? undefined,
        fields: info?.fields ?? undefined,
        target: info?.target ?? undefined,
      });
    }
  }
  return out;
}

export function applyEntityFilter(
  summaries: EntitySummary[],
  filter?: EntityFilter,
): EntitySummary[] {
  const f = filter ?? {};
  const domains = f.domain == null ? undefined : Array.isArray(f.domain) ? f.domain : [f.domain];
  const search = f.search ? f.search.toLowerCase() : undefined;

  return summaries.filter((s) => {
    if (!f.includeDisabled && s.disabled) return false;
    if (!f.includeHidden && s.hidden) return false;
    if (!f.includeAuxiliary && s.entityCategory) return false;
    if (domains && !domains.includes(s.domain)) return false;
    if (f.areaId && s.areaId !== f.areaId) return false;
    if (f.labelId && !s.labels.includes(f.labelId)) return false;
    if (f.deviceId && s.deviceId !== f.deviceId) return false;
    if (search) {
      const hay = `${s.entityId}\n${s.name}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export function coerceDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Render a parenthetical suffix noting how many pending changes were folded into the result.
 * Used in ObservationDescription text. Returns the empty string if no overlay was applied. */
export function pendingSuffix(appliedCount: number): string {
  if (appliedCount <= 0) return "";
  return ` (includes ${appliedCount} pending change${appliedCount === 1 ? "" : "s"})`;
}

export function buildTarget(target?: ServiceCallTarget): HATarget | undefined {
  if (!target) return undefined;
  const out: HATarget = {};
  if (target.entityId != null) out.entity_id = target.entityId;
  if (target.deviceId != null) out.device_id = target.deviceId;
  if (target.areaId != null) out.area_id = target.areaId;
  if (target.labelId != null) out.label_id = target.labelId;
  if (target.floorId != null) out.floor_id = target.floorId;
  return Object.keys(out).length > 0 ? out : undefined;
}
