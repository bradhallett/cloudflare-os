// The workspace half of the user Durable Object (user.ts): the user's gadget index (own and
// shared-with-them workspaces), per-workspace outputs and their backfill sweep, the mirrored org
// memberships, and the notification-mute and shared-gadget bookkeeping the listing reads. The DO
// keeps its RPC surface as thin delegators (the user-bots.ts pattern).

import {GadgetMetadataWithTimestamps, GadgetMetadata, AiChatAuthorInfo, CollaboratorRole, NotificationMute, OutputSummary, ListOutputsResult, createPlanRefusalError, type OrgMemberStatus, type OrgRole} from '@gadgets/workshop-shared/api';
import { type GadgetRecord, type OrgMembershipRecord, type UserStorage, type WorkspaceOutputEntry} from "./storage-schema/user-storage.js";
import { refuseUnverifiableWorkspaceCap, resolveEntitlements, workspaceCapFrom } from "./entitlements.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.user");

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

/** The workspace storage keys this store owns (a slice of the user DO's UserStorage). */
export type UserWorkspaceStorage = Pick<UserStorage,
    "gadgets" | "outputs" | "outputsBackfilled" | "outputsBackfillCursor" | "orgMemberships">;

/**
 * The user's workspace index: their own gadgets and the ones shared with them, the outputs
 * recorded per workspace (with the one-shot backfill sweep for workspaces predating the index),
 * the mirrored org memberships, and the notification-mute setting each listing reads.
 */
export class UserWorkspaceStore {
  constructor(
      private ctx: DurableObjectState,
      private env: Cloudflare.Env,
      private storage: UserWorkspaceStorage,
  ) {}

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

  /** See `AuthenticatedApi.setWorkspaceNotificationMute()`. */
  async setWorkspaceNotificationMute(workspaceId: string, mute: NotificationMute | null)
      : Promise<void> {
    let record = this.storage.gadgets.get(workspaceId);
    if (!record) throw new Error("No such workspace belonging to user.");
    record.notificationMute = mute ?? undefined;
    this.storage.gadgets.put(record);
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
}
