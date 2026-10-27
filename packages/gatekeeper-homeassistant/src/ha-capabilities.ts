// The whole-instance session: the top-level HomeAssistantSession surface handed to the sandbox,
// which lists and describes the instance's capabilities and constructs the per-resource facets.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type Area,
  type AreaInfo,
  type Dashboard,
  type DashboardInfo,
  type Device,
  type DeviceInfo,
  type Entity,
  type EntityFilter,
  type EntityHistory,
  type EntitySummary,
  type FloorInfo,
  type HomeAssistantConfig,
  type HomeAssistantSession,
  type Label,
  type LabelInfo,
  type LogbookEntry,
  type LovelaceResourceInfo,
  type ServiceCallTarget,
  type ServiceInfo,
} from "./types";

import {
  AreaImpl,
  LabelImpl,
  DeviceImpl,
  EntityImpl,
  DashboardImpl,
} from "./ha-facets";
import {
  normalizeArea,
  normalizeFloor,
  normalizeLabel,
  normalizeDevice,
  buildSummary,
  normalizeConfig,
  normalizeHistoryBundle,
  normalizeLogbook,
  normalizeServices,
  applyEntityFilter,
  coerceDate,
  pendingSuffix,
  buildTarget,
} from "./ha-normalize";
import {
  type SessionContext,
  callApi,
  callWs,
} from "./ha-session-context";

// ---------------------------------------------------------------------------
// Whole-instance Session

@validateRpc()
export class HomeAssistantSessionImpl extends RpcTarget implements HomeAssistantSession {
  #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async getConfig(): Promise<HomeAssistantConfig> {
    const config = normalizeConfig(await callApi(this.#ctx, (r) => r.getConfig()));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Home Assistant configuration",
      description:
        `Fetched the HA instance configuration ` +
        `(location: "${config.locationName}", version ${config.version}, ` +
        `timezone ${config.timeZone}).`,
    });
    return config;
  }

  async listAreas(): Promise<AreaInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "config/area_registry/list" }),
    );
    const result = list.map(normalizeArea);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant areas",
      description: `Listed ${result.length} area${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listFloors(): Promise<FloorInfo[]> {
    const list = await callWs(this.#ctx, async (ws) => {
      try {
        return await ws.send<any[]>({ type: "config/floor_registry/list" });
      } catch {
        return [];
      }
    });
    const result = list.map(normalizeFloor);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant floors",
      description: `Listed ${result.length} floor${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listLabels(): Promise<LabelInfo[]> {
    const list = await callWs(this.#ctx, async (ws) => {
      try {
        return await ws.send<any[]>({ type: "config/label_registry/list" });
      } catch {
        return [];
      }
    });
    const result = list.map(normalizeLabel);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant labels",
      description: `Listed ${result.length} label${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "config/device_registry/list" }),
    );
    const result = list.map(normalizeDevice);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant devices",
      description: `Listed ${result.length} device${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listEntities(filter?: EntityFilter): Promise<EntitySummary[]> {
    const { snapshot, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    const seen = new Set<string>();
    for (const reg of snapshot.entities) {
      const summary = buildSummary(reg, snapshot.states.get(reg.entity_id), snapshot.devices);
      summaries.push(summary);
      seen.add(reg.entity_id);
    }
    for (const [entityId, state] of snapshot.states) {
      if (seen.has(entityId)) continue;
      summaries.push(buildSummary(undefined, state, snapshot.devices));
    }
    const filtered = applyEntityFilter(summaries, filter);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant entities",
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"}` +
        (filter ? ` (filter: ${JSON.stringify(filter)})` : "") +
        pendingSuffix(appliedCount) +
        ".",
    });
    return filtered;
  }

  async listDomains(): Promise<string[]> {
    const states = await callApi(this.#ctx, (r) => r.getStates());
    const set = new Set<string>();
    for (const s of states) {
      const id: string = s.entity_id;
      const idx = id.indexOf(".");
      if (idx > 0) set.add(id.slice(0, idx));
    }
    const result = [...set].toSorted();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant integration domains",
      description: `Listed ${result.length} domain${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listServices(domain?: string): Promise<ServiceInfo[]> {
    const raw = await callApi(this.#ctx, (r) => r.getServices());
    let services = normalizeServices(raw);
    if (domain) services = services.filter((s) => s.domain === domain);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Home Assistant services",
      description:
        `Listed ${services.length} service${services.length === 1 ? "" : "s"}` +
        (domain ? ` in domain \`${domain}\`` : "") +
        ".",
    });
    return services;
  }

  async getArea(id: string): Promise<Area> {
    const snapshot = await this.#ctx.registrySnapshot();
    const area = snapshot.areas.find((a: any) => a.area_id === id);
    if (!area) throw new Error(`Area not found: ${id}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open area capability`,
      description: `Opened a capability for area "${area.name}" (\`${id}\`).`,
    });
    // Fork the context: the returned AreaImpl is a separate stub with its own approvalQueue
    // dup, so disposing it doesn't release ours.
    return new AreaImpl(this.#ctx.fork(), id);
  }

  async getLabel(id: string): Promise<Label> {
    const snapshot = await this.#ctx.registrySnapshot();
    const label = snapshot.labels.find((l: any) => l.label_id === id);
    if (!label) throw new Error(`Label not found: ${id}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open label capability`,
      description: `Opened a capability for label "${label.name}" (\`${id}\`).`,
    });
    return new LabelImpl(this.#ctx.fork(), id);
  }

  async getDevice(id: string): Promise<Device> {
    const snapshot = await this.#ctx.registrySnapshot();
    const device = snapshot.devices.find((d: any) => d.id === id);
    if (!device) throw new Error(`Device not found: ${id}`);
    const name = device.name_by_user ?? device.name ?? id;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open device capability`,
      description: `Opened a capability for device "${name}" (\`${id}\`).`,
    });
    return new DeviceImpl(this.#ctx.fork(), id);
  }

  async getEntity(entityId: string): Promise<Entity> {
    const state = await callApi(this.#ctx, (r) => r.getState(entityId));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability`,
      description: `Opened a capability for entity \`${entityId}\` (current state: ${state.state}).`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async getDashboard(urlPath: string): Promise<Dashboard> {
    // We don't make a round-trip to HA here, but for consistency with the other `get*`
    // capability accessors (`getArea`, `getEntity`, etc.) we still record the act of obtaining
    // the capability in the approval queue. Actual dashboard reads (describe / getConfig) and
    // writes (saveConfig) authorize / submit themselves separately.
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open dashboard capability`,
      description: `Opened a capability for Lovelace dashboard \`${urlPath}\`.`,
    });
    return new DashboardImpl(this.#ctx.fork(), urlPath);
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: ServiceCallTarget,
  ): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: buildTarget(target),
      origin: { kind: "session" },
    });
  }

  async fireEvent(eventType: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "fireEvent",
      eventType,
      data,
      origin: { kind: "session" },
    });
  }

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    const result = await callApi(this.#ctx, (r) => r.renderTemplate(template, variables));
    const preview = template.length > 80 ? template.slice(0, 77) + "..." : template;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Render Jinja template",
      description:
        `Rendered template \`${preview}\`. Templates can read every entity in the instance, ` +
        `so the result may incorporate state from anywhere in Home Assistant.`,
    });
    return result;
  }

  async getHistory(
    entityIds: string[],
    start: string | Date,
    end?: string | Date,
  ): Promise<EntityHistory[]> {
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read entity history",
      description:
        `Read state history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `from ${coerceDate(start).toISOString()}${end ? ` to ${coerceDate(end).toISOString()}` : ""}.`,
    });
    return histories;
  }

  async getLogbook(
    start: string | Date,
    end?: string | Date,
    entityId?: string,
  ): Promise<LogbookEntry[]> {
    const items = await callApi(this.#ctx, (r) =>
      r.getLogbook(coerceDate(start), end ? coerceDate(end) : undefined, entityId),
    );
    const result = normalizeLogbook(items);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Home Assistant logbook",
      description:
        `Read ${result.length} logbook entr${result.length === 1 ? "y" : "ies"} ` +
        `from ${coerceDate(start).toISOString()}${end ? ` to ${coerceDate(end).toISOString()}` : ""}` +
        (entityId ? ` for entity \`${entityId}\`` : "") +
        ".",
    });
    return result;
  }

  async listDashboards(): Promise<DashboardInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "lovelace/dashboards/list" }),
    );
    const result = list.map((d: any) => ({
      urlPath: d.url_path,
      title: d.title,
      icon: d.icon ?? undefined,
      mode: (d.mode ?? "storage") as "storage" | "yaml",
      showInSidebar: d.show_in_sidebar ?? true,
      requireAdmin: d.require_admin ?? false,
    }));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Lovelace dashboards",
      description: `Listed ${result.length} dashboard${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async listLovelaceResources(): Promise<LovelaceResourceInfo[]> {
    const list = await callWs(this.#ctx, async (ws) =>
      ws.send<any[]>({ type: "lovelace/resources" }),
    );
    const result = list.map((r: any) => ({ id: r.id, url: r.url, type: r.type }));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Lovelace resources",
      description: `Listed ${result.length} custom Lovelace resource${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }
}
