// Per-resource session facets (area, label, device, entity, dashboard): the RPC surfaces the
// whole-instance session hands out, each pinned to one resource id.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  overlayDashboardConfig,
  overlayEntityState,
  type HAStateRecord,
} from "./simulation";
import {
  type Area,
  type AreaInfo,
  type Dashboard,
  type DashboardConfig,
  type DashboardInfo,
  type Device,
  type DeviceInfo,
  type Entity,
  type EntityFilter,
  type EntityHistory,
  type EntityState,
  type EntitySummary,
  type FloorInfo,
  type Label,
  type LabelInfo,
  type LightTurnOnData,
  type LogbookEntry,
} from "./types";

import {
  normalizeArea,
  normalizeFloor,
  normalizeLabel,
  normalizeDevice,
  summarizeEntity,
  buildSummary,
  normalizeState,
  normalizeHistoryBundle,
  normalizeLogbook,
  applyEntityFilter,
  coerceDate,
  pendingSuffix,
} from "./ha-normalize";
import {
  type SessionContext,
  callApi,
  callWs,
} from "./ha-session-context";

// ---------------------------------------------------------------------------
// Area session/capability

@validateRpc()
export class AreaImpl extends RpcTarget implements Area {
  #ctx: SessionContext;
  #areaId: string;

  constructor(ctx: SessionContext, areaId: string) {
    super();
    this.#ctx = ctx;
    this.#areaId = areaId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  // Internal: fetch without authorize (used to build descriptions for child reads).
  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<AreaInfo> {
    const snap = await this.#snapshot();
    const area = snap.areas.find((a: any) => a.area_id === this.#areaId);
    if (!area) throw new Error(`Area not found: ${this.#areaId}`);
    const info = normalizeArea(area);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe area: ${info.name}`,
      description: `Read metadata for area "${info.name}" (\`${info.id}\`).`,
    });
    return info;
  }

  async getFloor(): Promise<FloorInfo | null> {
    const snap = await this.#snapshot();
    const area = snap.areas.find((a: any) => a.area_id === this.#areaId);
    if (!area?.floor_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read area floor`,
        description: `Area \`${this.#areaId}\` is not assigned to a floor.`,
      });
      return null;
    }
    const floor = snap.floors.find((f: any) => f.floor_id === area.floor_id);
    const info = floor ? normalizeFloor(floor) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read area floor`,
      description: `Area \`${this.#areaId}\` is on floor "${info?.name ?? area.floor_id}".`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "areaId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    // `buildSummary()` already resolves an entity's area via its device, so a single pass
    // through `applyEntityFilter` with `areaId: this.#areaId` is sufficient.
    const summaries: EntitySummary[] = snap.entities.map((reg: any) =>
      buildSummary(reg, snap.states.get(reg.entity_id), snap.devices),
    );
    const filtered = applyEntityFilter(summaries, { ...filter, areaId: this.#areaId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities in area`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `in area \`${this.#areaId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const snap = await this.#snapshot();
    const result = snap.devices.filter((d: any) => d.area_id === this.#areaId).map(normalizeDevice);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List devices in area`,
      description:
        `Listed ${result.length} device${result.length === 1 ? "" : "s"} ` +
        `in area \`${this.#areaId}\`.`,
    });
    return result;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const deviceIdsInArea = new Set(
      snap.devices.filter((d: any) => d.area_id === this.#areaId).map((d: any) => d.id),
    );
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    const state = snap.states.get(entityId);
    if (!reg && !state) {
      throw new Error(`Entity ${entityId} not found.`);
    }
    const summary = buildSummary(reg, state, snap.devices);
    const inArea =
      summary.areaId === this.#areaId ||
      (summary.deviceId && deviceIdsInArea.has(summary.deviceId));
    if (!inArea) {
      throw new Error(`Entity ${entityId} is not part of area ${this.#areaId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (in area)`,
      description: `Opened capability for entity \`${entityId}\` within area \`${this.#areaId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async getDevice(deviceId: string): Promise<Device> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === deviceId && d.area_id === this.#areaId);
    if (!device) {
      throw new Error(`Device ${deviceId} is not part of area ${this.#areaId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open device capability (in area)`,
      description: `Opened capability for device \`${deviceId}\` within area \`${this.#areaId}\`.`,
    });
    return new DeviceImpl(this.#ctx.fork(), deviceId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { area_id: this.#areaId },
      origin: { kind: "area", areaId: this.#areaId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const deviceIdsInArea = new Set(
      snap.devices.filter((d: any) => d.area_id === this.#areaId).map((d: any) => d.id),
    );
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      const inArea =
        reg.area_id === this.#areaId || (reg.device_id && deviceIdsInArea.has(reg.device_id));
      if (inArea) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read area history`,
        description: `Area \`${this.#areaId}\` has no entities to fetch history for.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read area history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `in area \`${this.#areaId}\` from ${coerceDate(start).toISOString()}` +
        (end ? ` to ${coerceDate(end).toISOString()}` : "") +
        ".",
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Label session/capability

@validateRpc()
export class LabelImpl extends RpcTarget implements Label {
  #ctx: SessionContext;
  #labelId: string;

  constructor(ctx: SessionContext, labelId: string) {
    super();
    this.#ctx = ctx;
    this.#labelId = labelId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<LabelInfo> {
    const snap = await this.#snapshot();
    const label = snap.labels.find((l: any) => l.label_id === this.#labelId);
    if (!label) throw new Error(`Label not found: ${this.#labelId}`);
    const info = normalizeLabel(label);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe label: ${info.name}`,
      description: `Read metadata for label "${info.name}" (\`${info.id}\`).`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "labelId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    for (const reg of snap.entities) {
      const labels: string[] = reg.labels ?? [];
      if (!labels.includes(this.#labelId)) continue;
      summaries.push(buildSummary(reg, snap.states.get(reg.entity_id), snap.devices));
    }
    const filtered = applyEntityFilter(summaries, { ...filter, labelId: this.#labelId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities with label`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `carrying label \`${this.#labelId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    const labels: string[] = reg?.labels ?? [];
    if (!labels.includes(this.#labelId)) {
      throw new Error(`Entity ${entityId} does not carry label ${this.#labelId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (by label)`,
      description: `Opened capability for entity \`${entityId}\` carrying label \`${this.#labelId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { label_id: this.#labelId },
      origin: { kind: "label", labelId: this.#labelId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      const labels: string[] = reg.labels ?? [];
      if (labels.includes(this.#labelId)) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read label history`,
        description: `Label \`${this.#labelId}\` has no entities.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read label history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `carrying label \`${this.#labelId}\`.`,
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Device session/capability

@validateRpc()
export class DeviceImpl extends RpcTarget implements Device {
  #ctx: SessionContext;
  #deviceId: string;

  constructor(ctx: SessionContext, deviceId: string) {
    super();
    this.#ctx = ctx;
    this.#deviceId = deviceId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #snapshot() {
    return await this.#ctx.registrySnapshot();
  }

  async describe(): Promise<DeviceInfo> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === this.#deviceId);
    if (!device) throw new Error(`Device not found: ${this.#deviceId}`);
    const info = normalizeDevice(device);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe device: ${info.name}`,
      description: `Read metadata for device "${info.name}" (\`${this.#deviceId}\`).`,
    });
    return info;
  }

  async getArea(): Promise<AreaInfo | null> {
    const snap = await this.#snapshot();
    const device = snap.devices.find((d: any) => d.id === this.#deviceId);
    if (!device?.area_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read device area`,
        description: `Device \`${this.#deviceId}\` is not assigned to an area.`,
      });
      return null;
    }
    const area = snap.areas.find((a: any) => a.area_id === device.area_id);
    const info = area ? normalizeArea(area) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read device area`,
      description: `Device \`${this.#deviceId}\` is in area "${info?.name ?? device.area_id}".`,
    });
    return info;
  }

  async listEntities(filter?: Omit<EntityFilter, "deviceId">): Promise<EntitySummary[]> {
    const { snapshot: snap, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summaries: EntitySummary[] = [];
    for (const reg of snap.entities) {
      if (reg.device_id !== this.#deviceId) continue;
      summaries.push(buildSummary(reg, snap.states.get(reg.entity_id), snap.devices));
    }
    const filtered = applyEntityFilter(summaries, { ...filter, deviceId: this.#deviceId });
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List entities for device`,
      description:
        `Listed ${filtered.length} entit${filtered.length === 1 ? "y" : "ies"} ` +
        `provided by device \`${this.#deviceId}\`` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return filtered;
  }

  async getEntity(entityId: string): Promise<Entity> {
    const snap = await this.#snapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === entityId);
    if (!reg || reg.device_id !== this.#deviceId) {
      throw new Error(`Entity ${entityId} does not belong to device ${this.#deviceId}.`);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Open entity capability (on device)`,
      description: `Opened capability for entity \`${entityId}\` on device \`${this.#deviceId}\`.`,
    });
    return new EntityImpl(this.#ctx.fork(), entityId);
  }

  async callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#ctx.submitWrite({
      type: "callService",
      domain,
      service,
      data,
      target: { device_id: this.#deviceId },
      origin: { kind: "device", deviceId: this.#deviceId },
    });
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const snap = await this.#snapshot();
    const entityIds: string[] = [];
    for (const reg of snap.entities) {
      if (reg.device_id === this.#deviceId) entityIds.push(reg.entity_id);
    }
    if (entityIds.length === 0) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read device history`,
        description: `Device \`${this.#deviceId}\` has no entities.`,
      });
      return [];
    }
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory(entityIds, coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read device history`,
      description:
        `Read history for ${entityIds.length} entit${entityIds.length === 1 ? "y" : "ies"} ` +
        `on device \`${this.#deviceId}\`.`,
    });
    return histories;
  }
}

// ---------------------------------------------------------------------------
// Entity session/capability

@validateRpc()
export class EntityImpl extends RpcTarget implements Entity {
  #ctx: SessionContext;
  #entityId: string;

  constructor(ctx: SessionContext, entityId: string) {
    super();
    this.#ctx = ctx;
    this.#entityId = entityId;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  get #domain(): string {
    return this.#entityId.split(".")[0];
  }

  async describe(): Promise<EntitySummary> {
    const { snapshot, appliedCount } = await this.#ctx.registrySnapshotWithOverlay();
    const summary = summarizeEntity(snapshot, this.#entityId);
    if (!summary) throw new Error(`Entity not found: ${this.#entityId}`);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe entity: ${summary.name}`,
      description:
        `Read metadata for entity \`${this.#entityId}\` (state: ${summary.state})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return summary;
  }

  async getState(): Promise<EntityState> {
    // Short-circuit: if no pending actions are queued, we don't need the full registry
    // snapshot just to resolve overlay targets — a single REST round-trip suffices. When
    // there ARE pending actions, fetch state + registry in parallel.
    const pending = this.#ctx.listPendingActions();
    let raw: HAStateRecord;
    let appliedCount = 0;
    if (pending.length === 0) {
      raw = (await callApi(this.#ctx, (r) => r.getState(this.#entityId))) as HAStateRecord;
    } else {
      const [rawState, registry] = await Promise.all([
        callApi(this.#ctx, (r) => r.getState(this.#entityId)),
        this.#ctx.registrySnapshot(),
      ]);
      const result = overlayEntityState(rawState as HAStateRecord, pending, registry);
      raw = result.state;
      appliedCount = result.appliedCount;
    }
    const state = normalizeState(raw);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity state`,
      description:
        `Read state of \`${this.#entityId}\` (current: ${state.state})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return state;
  }

  async getDevice(): Promise<DeviceInfo | null> {
    const snap = await this.#ctx.registrySnapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === this.#entityId);
    if (!reg?.device_id) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read entity device`,
        description: `Entity \`${this.#entityId}\` is not provided by a device.`,
      });
      return null;
    }
    const device = snap.devices.find((d: any) => d.id === reg.device_id);
    const info = device ? normalizeDevice(device) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity device`,
      description: `Entity \`${this.#entityId}\` is provided by device "${info?.name ?? reg.device_id}".`,
    });
    return info;
  }

  async getArea(): Promise<AreaInfo | null> {
    const snap = await this.#ctx.registrySnapshot();
    const summary = summarizeEntity(snap, this.#entityId);
    if (!summary?.areaId) {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `Read entity area`,
        description: `Entity \`${this.#entityId}\` is not assigned to an area.`,
      });
      return null;
    }
    const area = snap.areas.find((a: any) => a.area_id === summary.areaId);
    const info = area ? normalizeArea(area) : null;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity area`,
      description: `Entity \`${this.#entityId}\` is in area "${info?.name ?? summary.areaId}".`,
    });
    return info;
  }

  async getLabels(): Promise<LabelInfo[]> {
    const snap = await this.#ctx.registrySnapshot();
    const reg = snap.entities.find((e: any) => e.entity_id === this.#entityId);
    const labelIds: string[] = reg?.labels ?? [];
    const result = snap.labels
      .filter((l: any) => labelIds.includes(l.label_id))
      .map(normalizeLabel);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity labels`,
      description: `Entity \`${this.#entityId}\` carries ${result.length} label${result.length === 1 ? "" : "s"}.`,
    });
    return result;
  }

  async getHistory(start: string | Date, end?: string | Date): Promise<EntityHistory[]> {
    const bundle = await callApi(this.#ctx, (r) =>
      r.getHistory([this.#entityId], coerceDate(start), end ? coerceDate(end) : undefined, false),
    );
    const histories = normalizeHistoryBundle(bundle);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity history`,
      description:
        `Read history for \`${this.#entityId}\` from ${coerceDate(start).toISOString()}` +
        (end ? ` to ${coerceDate(end).toISOString()}` : "") +
        ".",
    });
    return histories;
  }

  async getLogbook(start: string | Date, end?: string | Date): Promise<LogbookEntry[]> {
    const items = await callApi(this.#ctx, (r) =>
      r.getLogbook(coerceDate(start), end ? coerceDate(end) : undefined, this.#entityId),
    );
    const result = normalizeLogbook(items);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read entity logbook`,
      description: `Read ${result.length} logbook entr${result.length === 1 ? "y" : "ies"} for \`${this.#entityId}\`.`,
    });
    return result;
  }

  // ---- Writes ---------------------------------------------------------

  #submitServiceCall(service: string, data?: Record<string, unknown>): Promise<void> {
    return this.#ctx.submitWrite({
      type: "callService",
      domain: this.#domain,
      service,
      data,
      target: { entity_id: this.#entityId },
      origin: { kind: "entity", entityId: this.#entityId },
    });
  }

  async callService(service: string, data?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall(service, data);
  }

  // ---- Typed helpers --------------------------------------------------

  async turnOn(data?: LightTurnOnData | Record<string, unknown>): Promise<void> {
    const mapped = mapLightTurnOnData(data);
    // Pre-validation for light-specific numeric ranges.
    if (mapped) {
      if (typeof mapped.brightness === "number" && (mapped.brightness < 0 || mapped.brightness > 255)) {
        throw new Error("brightness must be between 0 and 255.");
      }
      if (typeof mapped.brightness_pct === "number" && (mapped.brightness_pct < 0 || mapped.brightness_pct > 100)) {
        throw new Error("brightnessPct must be between 0 and 100.");
      }
    }
    await this.#submitServiceCall("turn_on", mapped);
  }

  async turnOff(data?: { transition?: number } | Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("turn_off", data as Record<string, unknown> | undefined);
  }

  async toggle(data?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("toggle", data);
  }

  async open(): Promise<void> {
    await this.#submitServiceCall("open_cover");
  }

  async close(): Promise<void> {
    await this.#submitServiceCall("close_cover");
  }

  async stop(): Promise<void> {
    const d = this.#domain;
    if (d === "cover") await this.#submitServiceCall("stop_cover");
    else if (d === "vacuum") await this.#submitServiceCall("stop");
    else if (d === "media_player") await this.#submitServiceCall("media_stop");
    else await this.#submitServiceCall("stop");
  }

  async setPosition(position: number): Promise<void> {
    if (position < 0 || position > 100) {
      throw new Error("position must be between 0 and 100.");
    }
    await this.#submitServiceCall("set_cover_position", { position });
  }

  async setTemperature(temperature: number, options?: { hvacMode?: string }): Promise<void> {
    const data: Record<string, unknown> = { temperature };
    if (options?.hvacMode != null) data.hvac_mode = options.hvacMode;
    await this.#submitServiceCall("set_temperature", data);
  }

  async setHvacMode(mode: string): Promise<void> {
    await this.#submitServiceCall("set_hvac_mode", { hvac_mode: mode });
  }

  async setFanMode(mode: string): Promise<void> {
    await this.#submitServiceCall("set_fan_mode", { fan_mode: mode });
  }

  async lock(code?: string): Promise<void> {
    const data: Record<string, unknown> = {};
    if (code != null) data.code = code;
    await this.#submitServiceCall("lock", data);
  }

  async unlock(code?: string): Promise<void> {
    const data: Record<string, unknown> = {};
    if (code != null) data.code = code;
    await this.#submitServiceCall("unlock", data);
  }

  async play(): Promise<void> {
    await this.#submitServiceCall("media_play");
  }

  async pause(): Promise<void> {
    await this.#submitServiceCall("media_pause");
  }

  async next(): Promise<void> {
    await this.#submitServiceCall("media_next_track");
  }

  async previous(): Promise<void> {
    await this.#submitServiceCall("media_previous_track");
  }

  async setVolume(volume: number): Promise<void> {
    if (volume < 0 || volume > 1) {
      throw new Error("volume must be between 0 and 1.");
    }
    await this.#submitServiceCall("volume_set", { volume_level: volume });
  }

  async mute(muted: boolean = true): Promise<void> {
    await this.#submitServiceCall("volume_mute", { is_volume_muted: muted });
  }

  async playMedia(mediaContentId: string, mediaContentType: string): Promise<void> {
    await this.#submitServiceCall("play_media", {
      media_content_id: mediaContentId,
      media_content_type: mediaContentType,
    });
  }

  async setSpeed(percentage: number): Promise<void> {
    if (percentage < 0 || percentage > 100) {
      throw new Error("percentage must be between 0 and 100.");
    }
    await this.#submitServiceCall("set_percentage", { percentage });
  }

  async start(): Promise<void> {
    await this.#submitServiceCall("start");
  }

  async returnToBase(): Promise<void> {
    await this.#submitServiceCall("return_to_base");
  }

  async locate(): Promise<void> {
    await this.#submitServiceCall("locate");
  }

  async activate(): Promise<void> {
    await this.#submitServiceCall("turn_on");
  }

  async run(variables?: Record<string, unknown>): Promise<void> {
    await this.#submitServiceCall("turn_on", variables ? { variables } : undefined);
  }

  async press(): Promise<void> {
    await this.#submitServiceCall("press");
  }

  async setValue(value: number): Promise<void> {
    await this.#submitServiceCall("set_value", { value });
  }

  async setText(value: string): Promise<void> {
    await this.#submitServiceCall("set_value", { value });
  }

  async selectOption(option: string): Promise<void> {
    await this.#submitServiceCall("select_option", { option });
  }

  async setDateTime(value: { date?: string; time?: string; datetime?: string }): Promise<void> {
    const data: Record<string, unknown> = {};
    if (value.date != null) data.date = value.date;
    if (value.time != null) data.time = value.time;
    if (value.datetime != null) data.datetime = value.datetime;
    await this.#submitServiceCall("set_datetime", data);
  }

  async trigger(): Promise<void> {
    await this.#submitServiceCall("trigger");
  }

  async reload(): Promise<void> {
    await this.#submitServiceCall("reload");
  }

  async notify(message: string, title?: string, data?: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = { message };
    if (title != null) payload.title = title;
    if (data != null) payload.data = data;
    await this.#submitServiceCall("send_message", payload);
  }
}

function mapLightTurnOnData(data?: LightTurnOnData | Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  // If this looks like a LightTurnOnData (has any of the known keys), map to HA's snake_case
  // naming. Otherwise pass through as-is.
  const known = [
    "brightness",
    "brightnessPct",
    "colorTemp",
    "colorTempKelvin",
    "rgbColor",
    "xyColor",
    "hsColor",
    "colorName",
    "transition",
    "effect",
    "flash",
  ];
  const looksTyped = known.some((k) => k in data);
  if (!looksTyped) return data as Record<string, unknown>;

  const d = data as LightTurnOnData;
  const out: Record<string, unknown> = {};
  if (d.brightness != null) out.brightness = d.brightness;
  if (d.brightnessPct != null) out.brightness_pct = d.brightnessPct;
  if (d.colorTemp != null) out.color_temp = d.colorTemp;
  if (d.colorTempKelvin != null) out.color_temp_kelvin = d.colorTempKelvin;
  if (d.rgbColor != null) out.rgb_color = d.rgbColor;
  if (d.xyColor != null) out.xy_color = d.xyColor;
  if (d.hsColor != null) out.hs_color = d.hsColor;
  if (d.colorName != null) out.color_name = d.colorName;
  if (d.transition != null) out.transition = d.transition;
  if (d.effect != null) out.effect = d.effect;
  if (d.flash != null) out.flash = d.flash;
  return out;
}

// ---------------------------------------------------------------------------
// Dashboard

@validateRpc()
export class DashboardImpl extends RpcTarget implements Dashboard {
  #ctx: SessionContext;
  #urlPath: string;

  constructor(ctx: SessionContext, urlPath: string) {
    super();
    this.#ctx = ctx;
    this.#urlPath = urlPath;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  // Internal helper (no authorize) used by saveConfig() to look up the mode.
  async #describeRaw(): Promise<DashboardInfo> {
    return await callWs(this.#ctx, async (ws) => {
      const list = await ws.send<any[]>({ type: "lovelace/dashboards/list" });
      const found = list.find((d: any) => d.url_path === this.#urlPath);
      if (!found) {
        if (this.#urlPath === "lovelace") {
          return {
            urlPath: "lovelace",
            title: "Overview",
            mode: "storage",
            showInSidebar: true,
            requireAdmin: false,
          };
        }
        throw new Error(`Dashboard not found: ${this.#urlPath}`);
      }
      return {
        urlPath: found.url_path,
        title: found.title,
        icon: found.icon ?? undefined,
        mode: (found.mode ?? "storage") as "storage" | "yaml",
        showInSidebar: found.show_in_sidebar ?? true,
        requireAdmin: found.require_admin ?? false,
      };
    });
  }

  async describe(): Promise<DashboardInfo> {
    const info = await this.#describeRaw();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Describe dashboard: ${info.title}`,
      description: `Read metadata for dashboard \`${this.#urlPath}\` (mode: ${info.mode}).`,
    });
    return info;
  }

  async getConfig(): Promise<DashboardConfig> {
    const real = await callWs(this.#ctx, async (ws) =>
      ws.send<DashboardConfig>({
        type: "lovelace/config",
        url_path: this.#urlPath === "lovelace" ? null : this.#urlPath,
      }),
    );
    // Overlay any pending saveDashboard actions for this dashboard so the reader sees a
    // simulated post-write configuration.
    const pending = this.#ctx.listPendingActions();
    const urlPathArg = this.#urlPath === "lovelace" ? null : this.#urlPath;
    const { config: overlaid, appliedCount } = overlayDashboardConfig(real, urlPathArg, pending);
    const config = overlaid as DashboardConfig;
    const viewCount = Array.isArray(config?.views) ? config.views.length : 0;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read dashboard config: ${this.#urlPath}`,
      description:
        `Read Lovelace configuration for dashboard \`${this.#urlPath}\` ` +
        `(${viewCount} view${viewCount === 1 ? "" : "s"})` +
        pendingSuffix(appliedCount) +
        `.`,
    });
    return config;
  }

  async saveConfig(config: DashboardConfig): Promise<void> {
    // We don't preflight-check YAML-mode dashboards here — doing so would require opening a
    // WebSocket connection at submit time just to read the dashboard list. Instead, executeAction
    // performs the check at apply time, where a WebSocket is already open for the save itself,
    // and HA itself returns an error for YAML-mode dashboards (which propagates as an action
    // failure that the user sees in the approval queue).
    await this.#ctx.submitWrite({
      type: "saveDashboard",
      urlPath: this.#urlPath === "lovelace" ? null : this.#urlPath,
      config: config as unknown,
      origin: { kind: "dashboard", urlPath: this.#urlPath },
    });
  }
}
