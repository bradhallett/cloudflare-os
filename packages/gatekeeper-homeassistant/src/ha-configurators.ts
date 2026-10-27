// Resource configurators for Home Assistant: the narrow read-only RPC surfaces (instance, area,
// label, device, entity) exposed to the sandboxed configurator iframe. Credentials stay in a
// WeakMap keyed by the RpcTarget instance, never on the instance itself.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { type HomeAssistantInstanceConfiguratorRpc } from "./configurator/instance-configurator-types";
import {
  type HomeAssistantAreaConfiguratorRpc,
  type HomeAssistantDeviceConfiguratorRpc,
  type HomeAssistantEntityConfiguratorRpc,
  type HomeAssistantLabelConfiguratorRpc,
  type HomeAssistantConfiguratorOption,
} from "./configurator/resource-configurator-types";
import {
  HomeAssistantRest,
  fetchRegistrySnapshot,
  withWebSocket,
  type HomeAssistantCredentials,
} from "./homeassistant-api";
import { AREA_RESOURCE, DEVICE_RESOURCE, ENTITY_RESOURCE, LABEL_RESOURCE } from "./homeassistant";


// ---------------------------------------------------------------------------
// Configurator UI for the whole-instance resource.
//
// The configurator runs in a sandboxed iframe and is treated as untrusted. We expose ONLY a
// narrow set of read-only helper methods; credentials are kept private via a closure (the
// credentials getter is stored in a WeakMap keyed by the RpcTarget instance, not on the
// instance itself).

const instanceConfiguratorGetters = new WeakMap<
  object,
  () => Promise<HomeAssistantCredentials>
>();

@validateRpc()
export class InstanceConfiguratorUI extends RpcTarget implements HomeAssistantInstanceConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    instanceConfiguratorGetters.set(this, getCredentials);
  }

  async resourceUrl(): Promise<string> {
    const getter = instanceConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    return creds.baseUrl;
  }

  async describeInstance(): Promise<{ name: string; baseUrl: string }> {
    const getter = instanceConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    let name = "Home Assistant";
    try {
      const config = await new HomeAssistantRest(creds).getConfig();
      if (config?.location_name) name = config.location_name;
    } catch (e) {
      // Ignore; fall back to default name.
    }
    return { name, baseUrl: creds.baseUrl };
  }
}

// ---------------------------------------------------------------------------
// Configurators for fine-grained resources (area, label, device, entity).
//
// Each is given a credentials-getter closure (stored in a WeakMap so it isn't accessible as an
// RPC property). They only expose read-only listing methods.

const resourceConfiguratorGetters = new WeakMap<
  object,
  () => Promise<HomeAssistantCredentials>
>();

async function getResourceConfiguratorCreds(target: object): Promise<HomeAssistantCredentials> {
  const getter = resourceConfiguratorGetters.get(target);
  if (!getter) throw new Error("Configurator is not initialized.");
  return await getter();
}

const AUTOCOMPLETE_LIMIT = 200;

function matchesSearch(haystackParts: (string | undefined | null)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const corpus = haystackParts.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => corpus.includes(term));
}

function buildAreaUrl(areaId: string): string {
  return `${AREA_RESOURCE.urlPattern.replace(":areaId", encodeURIComponent(areaId))}`;
}
function buildLabelUrl(labelId: string): string {
  return `${LABEL_RESOURCE.urlPattern.replace(":labelId", encodeURIComponent(labelId))}`;
}
function buildDeviceUrl(deviceId: string): string {
  return `${DEVICE_RESOURCE.urlPattern.replace(":deviceId", encodeURIComponent(deviceId))}`;
}
function buildEntityUrl(entityId: string): string {
  return `${ENTITY_RESOURCE.urlPattern.replace(":entityId", encodeURIComponent(entityId))}`;
}

@validateRpc()
export class AreaConfiguratorUI extends RpcTarget implements HomeAssistantAreaConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listAreas(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      const list = await ws.send<any[]>({ type: "config/area_registry/list" });
      const options: HomeAssistantConfiguratorOption[] = list
        .filter((a: any) => matchesSearch([a.name, a.area_id, ...(a.aliases ?? [])], query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((a: any) => ({
          value: a.area_id,
          title: a.name ?? a.area_id,
          subtitle: a.floor_id ? `Floor: ${a.floor_id}` : undefined,
        }));
      return options;
    });
  }

  async resourceUrl(areaId: string | null | undefined): Promise<string> {
    if (!areaId) throw new Error("No area selected.");
    return buildAreaUrl(areaId);
  }
}

@validateRpc()
export class LabelConfiguratorUI extends RpcTarget implements HomeAssistantLabelConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listLabels(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      let list: any[];
      try {
        list = await ws.send<any[]>({ type: "config/label_registry/list" });
      } catch {
        return [];
      }
      return list
        .filter((l: any) => matchesSearch([l.name, l.label_id, l.description], query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((l: any) => ({
          value: l.label_id,
          title: l.name ?? l.label_id,
          subtitle: l.description ?? undefined,
        }));
    });
  }

  async resourceUrl(labelId: string | null | undefined): Promise<string> {
    if (!labelId) throw new Error("No label selected.");
    return buildLabelUrl(labelId);
  }
}

@validateRpc()
export class DeviceConfiguratorUI extends RpcTarget implements HomeAssistantDeviceConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listDevices(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    return await withWebSocket(creds, async (ws) => {
      const [devices, areas] = await Promise.all([
        ws.send<any[]>({ type: "config/device_registry/list" }),
        ws.send<any[]>({ type: "config/area_registry/list" }).catch(() => []),
      ]);
      const areaNames = new Map<string, string>(
        (areas as any[]).map((a: any) => [a.area_id, a.name]),
      );
      return (devices as any[])
        .filter((d: any) => !d.disabled_by)
        .map((d: any) => ({
          value: d.id,
          title: d.name_by_user ?? d.name ?? d.id,
          subtitle: [d.manufacturer, d.model].filter(Boolean).join(" "),
          meta: d.area_id ? areaNames.get(d.area_id) : undefined,
        }))
        .filter((opt) => matchesSearch([opt.title, opt.subtitle, opt.meta], query))
        .slice(0, AUTOCOMPLETE_LIMIT);
    });
  }

  async resourceUrl(deviceId: string | null | undefined): Promise<string> {
    if (!deviceId) throw new Error("No device selected.");
    return buildDeviceUrl(deviceId);
  }
}

@validateRpc()
export class EntityConfiguratorUI extends RpcTarget implements HomeAssistantEntityConfiguratorRpc {
  constructor(getCredentials: () => Promise<HomeAssistantCredentials>) {
    super();
    resourceConfiguratorGetters.set(this, getCredentials);
  }

  async listEntities(query: string): Promise<HomeAssistantConfiguratorOption[]> {
    const creds = await getResourceConfiguratorCreds(this);
    const snapshot = await fetchRegistrySnapshot(creds);
    const areaNames = new Map<string, string>(
      snapshot.areas.map((a: any) => [a.area_id, a.name]),
    );
    const deviceAreaIds = new Map<string, string | undefined>(
      snapshot.devices.map((d: any) => [d.id, d.area_id]),
    );

    const options: HomeAssistantConfiguratorOption[] = [];
    const seen = new Set<string>();
    for (const reg of snapshot.entities) {
      if (reg.disabled_by || reg.hidden_by) continue;
      const entityId: string = reg.entity_id;
      seen.add(entityId);
      const state = snapshot.states.get(entityId);
      const name =
        reg.name ?? reg.original_name ?? state?.attributes?.friendly_name ?? entityId;
      const areaId = reg.area_id ?? (reg.device_id && deviceAreaIds.get(reg.device_id));
      const areaName = areaId ? areaNames.get(areaId) : undefined;
      options.push({
        value: entityId,
        title: String(name),
        subtitle: entityId,
        meta: areaName,
      });
    }
    // Also include entities present in /api/states but not in the registry.
    for (const [entityId, state] of snapshot.states) {
      if (seen.has(entityId)) continue;
      options.push({
        value: entityId,
        title: state?.attributes?.friendly_name ?? entityId,
        subtitle: entityId,
      });
    }

    return options
      .filter((opt) => matchesSearch([opt.title, opt.subtitle, opt.meta], query))
      .slice(0, AUTOCOMPLETE_LIMIT);
  }

  async resourceUrl(entityId: string | null | undefined): Promise<string> {
    if (!entityId) throw new Error("No entity selected.");
    return buildEntityUrl(entityId);
  }
}
