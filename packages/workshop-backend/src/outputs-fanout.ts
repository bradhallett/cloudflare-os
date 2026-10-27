import type { WorkspaceOutputEntry } from "./storage-schema/user-storage";
import type { WorkshopLogger } from "./observability";

/**
 * The outputs index fan-out: which user DO indexes this workspace keeps live (one token per
 * open session), the dirty flag that coalesces registry bursts into one flush, and the
 * snapshot the last successful push carried. Owned by OverseerChatRuntime as a collaborator;
 * joinOutputsFanout()/markOutputsDirty() delegate to it.
 *
 * The connected-index set is in memory, not persisted, which is what makes fanning out to
 * collaborators safe: revoking access aborts the DO (see scheduleAccessRestart()), so this is
 * destroyed with the sessions it describes and can only be rebuilt by an open() that re-checks
 * the permission graph.
 */
export class OutputsFanout {
  /** User DO ids whose outputs index this workspace is keeping live, one token per session. */
  #connectedIndexes = new Map<string, Set<object>>();

  /** Whether a flush is already queued. Registry mutations arrive in synchronous bursts (a
   * chat's changes may create and stamp several gadgets), so pushes coalesce onto one flush. */
  #flushScheduled = false;

  /** The snapshot every watcher last acknowledged, to suppress pushes that would change nothing. */
  #lastPushed?: string;

  /**
   * @param host The owning workspace DO, narrow slice: the owner's user id (undefined until
   *     the workspace is initialized), the registry snapshot to push, the per-recipient push
   *     (resolving false when it failed), and the logger.
   */
  constructor(private host: {
    ownerId(): string | undefined;
    workspaceId(): string;
    outputsSnapshot(): WorkspaceOutputEntry[];
    syncOutputsTo(userId: string, snapshot: WorkspaceOutputEntry[]): Promise<boolean>;
    logger: WorkshopLogger;
  }) {}

  /**
   * Keep `userId`'s outputs index up to date for the duration of one session. Returns a
   * function that ends it, like joinPresence().
   */
  join(userId: string): () => void {
    let token = {};
    let sessions = this.#connectedIndexes.get(userId);
    if (sessions) {
      sessions.add(token);
    } else {
      this.#connectedIndexes.set(userId, new Set([token]));
    }

    let left = false;
    return () => {
      if (left) return;
      left = true;
      let remaining = this.#connectedIndexes.get(userId);
      if (!remaining) return;
      remaining.delete(token);
      if (remaining.size === 0) this.#connectedIndexes.delete(userId);
    };
  }

  /** Note that the gadget registry changed, scheduling a push to every index that should be live. */
  markDirty(): void {
    if (this.#flushScheduled || this.host.ownerId() === undefined) return;
    this.#flushScheduled = true;
    scheduler.wait(0).then(() => {
      // Cleared before the push, so a change made while it is in flight schedules another.
      this.#flushScheduled = false;
      return this.#syncToWatchers();
    }).catch(err => {
      this.host.logger.warn("failed to flush workspace outputs", {
        event: "workspace.outputs.flush.failed", gadgetId: this.host.workspaceId(), error: err,
      });
    });
  }

  // Push the current snapshot to the owner's index and to every collaborator with a session
  // open. The owner is included whether or not they are connected, since a workspace goes on
  // producing while its owner is away; a disconnected collaborator is caught up by the sync in
  // open().
  async #syncToWatchers(): Promise<void> {
    let ownerId = this.host.ownerId();
    if (ownerId === undefined) return;

    // Built once and shared, rather than once per recipient: the registry is the same for all
    // of them, and rebuilding it per viewer is what made a push cost outputs times viewers.
    let snapshot = this.host.outputsSnapshot();

    // The registry notifies on every gadget update, but this carries only titles and
    // presentation, so code commits, binding edits and activity stamps all produce a snapshot
    // nobody's index would change on. Skipping those is most of the traffic. Safe to compare
    // against what this instance last sent because a newly connected watcher is synced by
    // open() before it joins the fan-out, and a cold DO has nothing recorded and so always
    // pushes.
    let encoded = JSON.stringify(snapshot);
    if (encoded === this.#lastPushed) return;

    let userIds = new Set([ownerId, ...this.#connectedIndexes.keys()]);
    let delivered = await Promise.all([...userIds].map(
        userId => this.host.syncOutputsTo(userId, snapshot)));

    // Recorded only once every index has it, so that a recipient this failed for is included
    // in the next flush instead of being remembered as up to date. If nothing changes again,
    // their open() corrects it.
    if (delivered.every(ok => ok)) this.#lastPushed = encoded;
  }
}
