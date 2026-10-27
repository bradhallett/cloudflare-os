// The Home Assistant gatekeeper Durable Object: binding construction (session and capability
// facets), revert snapshots, and the action types shared with the action store and approvals.
// The connect flow and account DO live in homeassistant.ts; session plumbing and capability
// implementations in their own modules.

import {
  DurableObject,
  RpcStub,
} from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  HomeAssistantRest,
  fetchRegistrySnapshot,
  withWebSocket,
  type HomeAssistantCredentials,
} from "./homeassistant-api";
import {
  applyRevertForEntity,
  canRevert,
  executeAction,
  fetchDashboardConfig,
  resolveTargets,
} from "./approvals";
import {
  HOME_ASSISTANT_ACTIONS,
  appliedAction,
  homeAssistantJournal,
  withActionId,
} from "./action-store";
import {
  indexPendingByEntity,
  overlayEntityStates,
  type HAStateRecord,
} from "./simulation";
import {
  type Area,
  type Device,
  type Entity,
  type EntitySummary,
  type HomeAssistantSession,
  type Label,
} from "./types";
import TYPES_CODE from "./types.txt";

import { HomeAssistantSessionImpl } from "./ha-capabilities";
import {
  AreaImpl,
  LabelImpl,
  DeviceImpl,
  EntityImpl,
} from "./ha-facets";
import { summarizeEntity } from "./ha-normalize";
import { type SessionContext } from "./ha-session-context";
import { validateWriteBody } from "./ha-validate";
import type { Env } from "./homeassistant";

// ---------------------------------------------------------------------------
// GatekeeperImpl

type HomeAssistantResourceKind = "instance" | "area" | "label" | "device" | "entity";

type HomeAssistantGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: HomeAssistantResourceKind;
  /** For area, label, device, entity: the resource id. */
  resourceId?: string;
};

/** HA service-call target as accepted by HA itself (snake_case fields). */
export type HATarget = {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  label_id?: string | string[];
  floor_id?: string | string[];
};

/**
 * "Where the write came from" — used to author meaningful action descriptions and (later)
 * to drive simulation overlays. The receiving session may be whole-instance or scoped.
 */
export type ActionOrigin =
  | { kind: "session" }
  | { kind: "entity"; entityId: string }
  | { kind: "area"; areaId: string }
  | { kind: "label"; labelId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "dashboard"; urlPath: string };

/** All side-effecting actions go through the approval queue as one of these. */
export type HomeAssistantAction =
  | {
      id: number;
      type: "callService";
      domain: string;
      service: string;
      data?: Record<string, unknown>;
      target?: HATarget;
      origin: ActionOrigin;
    }
  | {
      id: number;
      type: "fireEvent";
      eventType: string;
      data?: Record<string, unknown>;
      origin: ActionOrigin;
    }
  | {
      id: number;
      type: "saveDashboard";
      /** null = the default "lovelace" dashboard. */
      urlPath: string | null;
      config: unknown;
      origin: ActionOrigin;
    };

/** Captured at apply time so we can later restore the prior state via revertAction(). */
export type HomeAssistantRevertInfo =
  | {
      type: "stateSnapshot";
      previous: Array<{
        entityId: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;
      originalAction: HomeAssistantAction & { type: "callService" };
    }
  | {
      type: "dashboardSnapshot";
      urlPath: string | null;
      previousConfig: unknown;
    }
  | { type: "noRevert" };

@validateRpc()
export class HomeAssistantGatekeeperImpl
  extends DurableObject<Env, HomeAssistantGatekeeperImplProps>
  implements Gatekeeper<HomeAssistantSession | Area | Label | Device | Entity>
{
  // Claim-before-apply lifecycle for device actions, over this object's storage. Credentials are
  // resolved per dispatch, so a reconnect between approval and apply is picked up.
  readonly #journal = homeAssistantJournal(this.ctx.storage.kv);
  readonly #actions = HOME_ASSISTANT_ACTIONS.bind(this.#journal, {
    dispatch: async action => executeAction(action, await this.#getCreds()),
    snapshotForRevert: async action => this.#snapshotForRevert(action, await this.#getCreds()),
    fetchRegistrySnapshot: async () => fetchRegistrySnapshot(await this.#getCreds()),
    onAuthError: () => this.#userAccount().noteCredentialsExpired(),
  });

  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<HomeAssistantCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    const creds = await this.#getCreds();
    const { resourceKind, resourceId } = this.ctx.props;
    const baseUrl = creds.baseUrl;

    switch (resourceKind) {
      case "instance": {
        let title = "Home Assistant";
        try {
          const config = await new HomeAssistantRest(creds).getConfig();
          if (config?.location_name) title = config.location_name;
        } catch {}
        return {
          url: baseUrl,
          title,
          snippet: `Whole-instance access to ${title} (${baseUrl}).`,
          suggestedBindingName: "HOMEASSISTANT",
          tsType: "HomeAssistantSession",
        };
      }
      case "area": {
        const { areas } = await this.#snapshotMaps();
        const area = areas.get(resourceId!);
        const name = area?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/areas/area/${encodeURIComponent(resourceId!)}`,
          title: `Area: ${name}`,
          snippet: `Home Assistant area "${name}".`,
          suggestedBindingName: "HOMEASSISTANT_AREA",
          tsType: "Area",
        };
      }
      case "label": {
        const { labels } = await this.#snapshotMaps();
        const label = labels.get(resourceId!);
        const name = label?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/labels`,
          title: `Label: ${name}`,
          snippet: `All entities carrying the Home Assistant label "${name}".`,
          suggestedBindingName: "HOMEASSISTANT_LABEL",
          tsType: "Label",
        };
      }
      case "device": {
        const { devices } = await this.#snapshotMaps();
        const device = devices.get(resourceId!);
        const name = device?.name_by_user ?? device?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/devices/device/${encodeURIComponent(resourceId!)}`,
          title: `Device: ${name}`,
          snippet: `Home Assistant device "${name}"${device?.manufacturer ? ` (${device.manufacturer}${device.model ? " " + device.model : ""})` : ""}.`,
          suggestedBindingName: "HOMEASSISTANT_DEVICE",
          tsType: "Device",
        };
      }
      case "entity": {
        const summary = await this.#summarizeEntity(resourceId!).catch(() => undefined);
        const name = summary?.name ?? resourceId!;
        return {
          url: `${baseUrl}/config/entities/entity/${encodeURIComponent(resourceId!)}`,
          title: `Entity: ${name}`,
          snippet: `Home Assistant entity \`${resourceId}\`.`,
          suggestedBindingName: "HOMEASSISTANT_ENTITY",
          tsType: "Entity",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<HomeAssistantSession | Area | Label | Device | Entity> {
    const ctx = await this.#sessionContext(approvalQueue.dup());
    const { resourceKind, resourceId } = this.ctx.props;
    switch (resourceKind) {
      case "instance":
        return new HomeAssistantSessionImpl(ctx);
      case "area":
        return new AreaImpl(ctx, resourceId!);
      case "label":
        return new LabelImpl(ctx, resourceId!);
      case "device":
        return new DeviceImpl(ctx, resourceId!);
      case "entity":
        return new EntityImpl(ctx, resourceId!);
    }
  }

  async applyAction(actionId: number): Promise<void> {
    // The overseer only knows the numeric action ID; the full action and its claim-before-apply
    // lifecycle live on the resource's action journal in DO storage (action-store.ts).
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return await this.#actions.reject(actionId);
  }

  async revertAction(
    actionId: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // The overseer passes back only the action ID; the apply retained everything we need
    // (including the original action, inside `stateSnapshot.originalAction` /
    // `dashboardSnapshot`) on the journal's applied record.
    const applied = appliedAction(this.#journal, this.ctx.storage.kv, actionId);
    if (!applied) {
      throw new Error(`No applied Home Assistant action exists with id ${actionId}.`);
    }
    const revertInfo = applied.revertInfo;
    const creds = await this.#getCreds();
    switch (revertInfo.type) {
      case "noRevert":
        throw new Error("This action cannot be reverted.");
      case "stateSnapshot": {
        // Open one WebSocket for the whole batch.
        const failures: string[] = [];
        await withWebSocket(creds, async (ws) => {
          for (const prev of revertInfo.previous) {
            try {
              await applyRevertForEntity(prev, revertInfo.originalAction, ws);
            } catch (e: any) {
              failures.push(`${prev.entityId}: ${e?.message ?? e}`);
            }
          }
        });
        if (failures.length > 0) {
          return {
            message:
              failures.length === revertInfo.previous.length
                ? `Failed to revert: ${failures.join("; ")}`
                : `Reverted ${revertInfo.previous.length - failures.length} of ${revertInfo.previous.length} entities. Failures: ${failures.join("; ")}`,
            canRetry: failures.length < revertInfo.previous.length,
          };
        }
        return;
      }
      case "dashboardSnapshot": {
        await withWebSocket(creds, async (ws) => {
          await ws.send({
            type: "lovelace/config/save",
            url_path: revertInfo.urlPath,
            config: revertInfo.previousConfig,
          });
        });
        return;
      }
    }
  }

  /**
   * Observer tracking: Home Assistant uses the "low-stakes" strategy. It is a self-hosted personal
   * system, and the connection is a long-lived access token that grants the same all-or-nothing
   * access as the HA user who created it — HA has no per-user/per-entity ACL oracle we could verify
   * an observer against. So any collaborator may observe: addObserver/removeObserver are no-ops and
   * we never set excludeObservers on observations.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // ---------------------------------------------------------------------
  // Internal helpers

  async #sessionContext(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<SessionContext> {
    const creds = await this.#getCreds();
    return this.#buildSessionContext(creds, approvalQueue);
  }

  /** Synchronous helper used by `#sessionContext` and `SessionContext.fork()` to construct a
   * SessionContext given already-resolved credentials and an already-dup'd approvalQueue. */
  #buildSessionContext(
    creds: HomeAssistantCredentials,
    approvalQueue: RpcStub<ApprovalQueue>,
  ): SessionContext {
    const self = this;
    let disposed = false;
    const ctx: SessionContext = {
      creds,
      approvalQueue,
      noteAuthError: () => self.#userAccount().noteCredentialsExpired(),
      dispose() {
        if (disposed) return;
        disposed = true;
        // Release the server-side RpcStub for our dup'd approvalQueue. We cast through
        // `unknown` because RpcStub's TS type doesn't expose Symbol.dispose in workshop-shared's
        // capnweb dependency, but the runtime object does implement it (see gatekeeper-github
        // for the same pattern).
        try {
          (approvalQueue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
        } catch {
          // Already-disposed / runtime-missing dispose: ignore.
        }
      },
      async submitWrite(body) {
        // Validate body up front so malformed calls fail immediately with a clear message
        // (rather than ending up in the approval queue or hitting Home Assistant later).
        validateWriteBody(body);

        // The set's submit describes the action -- registry names when reachable, minimal text
        // otherwise -- allocates, and stages it on the approval queue, rolling back a submission
        // the queue refused.
        await self.#actions.submit(approvalQueue, body.type, body);
      },
      async registrySnapshot() {
        return await fetchRegistrySnapshot(creds);
      },
      listPendingActions() {
        return self.#journal.listPending().map(({ id, action }) => withActionId(action.payload, id));
      },
      async registrySnapshotWithOverlay() {
        const snapshot = await fetchRegistrySnapshot(creds);
        const pending = self.#journal.listPending().map(({ id, action }) => withActionId(action.payload, id));
        if (pending.length === 0) {
          return { snapshot, appliedCount: 0 };
        }
        const index = indexPendingByEntity(pending, snapshot);
        if (index.size === 0) {
          return { snapshot, appliedCount: 0 };
        }
        // Build a new states map with overlays applied.
        const newStates = new Map<string, any>(snapshot.states);
        let totalApplied = 0;
        const stateRecords: HAStateRecord[] = [];
        const seenIds: string[] = [];
        for (const entityId of index.keys()) {
          const real = snapshot.states.get(entityId);
          if (!real) continue;
          stateRecords.push(real as HAStateRecord);
          seenIds.push(entityId);
        }
        if (stateRecords.length > 0) {
          const { states: overlaid, totalApplied: applied } = overlayEntityStates(
            stateRecords,
            index,
          );
          totalApplied = applied;
          for (let i = 0; i < overlaid.length; i++) {
            newStates.set(seenIds[i], overlaid[i]);
          }
        }
        return {
          snapshot: { ...snapshot, states: newStates },
          appliedCount: totalApplied,
        };
      },
      fork() {
        // Wrap the parent's `approvalQueue` in a fresh `dup()` so the child session can be
        // disposed independently of the parent. Synchronous: reuses `creds` rather than
        // re-running `#getCreds`.
        return self.#buildSessionContext(creds, approvalQueue.dup());
      },
    };
    return ctx;
  }


  async #snapshotForRevert(
    action: HomeAssistantAction,
    creds: HomeAssistantCredentials,
  ): Promise<HomeAssistantRevertInfo> {
    if (!canRevert(action)) return { type: "noRevert" };

    if (action.type === "saveDashboard") {
      const previousConfig = await fetchDashboardConfig(action.urlPath, creds);
      return { type: "dashboardSnapshot", urlPath: action.urlPath, previousConfig };
    }

    if (action.type === "callService") {
      // The registry snapshot already includes the current states for every entity (it's
      // built from /api/states + the WS registries), so we can read prior state directly
      // from it instead of issuing one REST round-trip per targeted entity.
      const registry = await fetchRegistrySnapshot(creds);
      const targets = resolveTargets(action.target, registry);
      const previous: Array<{
        entityId: string;
        state: string;
        attributes: Record<string, unknown>;
      }> = [];
      for (const entityId of targets) {
        const state = registry.states.get(entityId);
        if (!state) continue;
        previous.push({
          entityId: state.entity_id,
          state: state.state,
          attributes: state.attributes ?? {},
        });
      }
      return {
        type: "stateSnapshot",
        previous,
        originalAction: action,
      };
    }

    return { type: "noRevert" };
  }

  async #snapshotMaps(): Promise<{
    areas: Map<string, any>;
    labels: Map<string, any>;
    devices: Map<string, any>;
    entities: Map<string, any>;
  }> {
    const creds = await this.#getCreds();
    const snapshot = await fetchRegistrySnapshot(creds);
    return {
      areas: new Map<string, any>(snapshot.areas.map((a: any) => [a.area_id, a])),
      labels: new Map<string, any>(snapshot.labels.map((l: any) => [l.label_id, l])),
      devices: new Map<string, any>(snapshot.devices.map((d: any) => [d.id, d])),
      entities: new Map<string, any>(snapshot.entities.map((e: any) => [e.entity_id, e])),
    };
  }

  async #summarizeEntity(entityId: string): Promise<EntitySummary | undefined> {
    const creds = await this.#getCreds();
    const snapshot = await fetchRegistrySnapshot(creds);
    return summarizeEntity(snapshot, entityId);
  }
}
