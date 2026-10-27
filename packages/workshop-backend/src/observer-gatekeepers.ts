import type { AffectedCollaborator, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ObserverRecord, OverseerStorage } from "./storage-schema/overseer-storage";
import type { WorkshopLogger } from "./observability";

/**
 * The workspace's observer bookkeeping: the in-flight tail of addObserver/removeObserver RPC
 * chains per (observer, gatekeeper) pair, and the best-effort teardowns that walk them. Owned
 * by OverseerMainline as a collaborator, so the lock state and the removal routines live in
 * exactly one place.
 */
export class ObserverGatekeepers {
  /**
   * Tail of the in-flight addObserver/removeObserver chain per `${observerId}/${gatekeeperId}`
   * (see withLock). In-memory only, entries dropped as each chain drains; the calls it orders
   * are themselves re-run/repaired across DO restarts.
   */
  #locks = new Map<string, Promise<void>>();

  /**
   * @param host The owning workspace DO, narrow slice: the gatekeeper facet fetcher, the
   *     storage tables the teardowns read, and the logger.
   */
  constructor(private host: {
    getGatekeeperFacet(id: WorkpieceId): Promise<unknown>;
    storage: Pick<OverseerStorage, "gatekeepers" | "observers">;
    logger: WorkshopLogger;
  }) {}

  /**
   * Serialize this DO's addObserver/removeObserver RPCs per (observer, gatekeeper) pair. The
   * overseer is the only caller of either, so ordering our own calls is enough to close the
   * race between an exclusion teardown's in-flight removeObserver and a fresh open's
   * addObserver on the same pair: the add either lands first or waits for the removal and
   * re-registers cleanly.
   */
  async withLock<T>(observerId: string, gatekeeperId: number, fn: () => Promise<T>)
      : Promise<T> {
    let key = `${observerId}/${gatekeeperId}`;
    let prior = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    let tail = new Promise<void>(resolve => { release = resolve; });
    this.#locks.set(key, tail);
    tail.then(() => {
      // Drop the entry once the chain drains; a newer tail means someone queued behind us.
      if (this.#locks.get(key) === tail) {
        this.#locks.delete(key);
      }
    });
    await prior;  // never rejects: each holder settles its own tail via the finally below
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Best-effort `removeObserver(observerId)` across the given gatekeeper ids. Never throws;
   * logs and continues on error. An orphaned observer entry only ever causes superfluous
   * future checks, never a data leak: a registration is what admits an open, and every open
   * re-runs addObserver, so a stale one grants nothing on its own.
   */
  async removeFromGatekeepers(observerId: string, gatekeeperIds: number[]): Promise<void> {
    await Promise.all(gatekeeperIds.map(async id => {
      try {
        await this.withLock(observerId, id, async () => {
          let facet = await this.host.getGatekeeperFacet(id) as {
            removeObserver(observerId: string): Promise<void>;
          };
          await facet.removeObserver(observerId);
        });
      } catch (err) {
        this.host.logger.warn("failed to remove observer from gatekeeper", {
          event: "gatekeeper.observer.remove.failed", gatekeeperId: id, observerId, error: err,
        });
      }
    }));
  }

  /**
   * Tear down observer records for collaborators who lost access as a result of a sharing
   * change. For each affected collaborator who is now fully unauthorized (newRole === null)
   * and has an observer record: best-effort removeObserver on all gatekeeper facets, then
   * delete the record. All calls are best-effort -- an orphaned observer entry only causes
   * superfluous checks, never a data leak: a registration is what admits an open, and every
   * open re-runs addObserver, so a stale one grants nothing on its own. See
   * observers-implementation-plan.md §5 Step 6.
   */
  async tearDownLostObservers(affected: AffectedCollaborator[]): Promise<void> {
    let gatekeeperIds = [...this.host.storage.gatekeepers.list()].map(gk => gk.id);
    for (let entry of affected) {
      if (entry.newRole !== null) continue;  // downgraded but still has access -> keep record
      let observer: ObserverRecord | undefined =
          this.host.storage.observers.get(entry.profile.id);
      if (!observer) continue;
      this.host.storage.observers.delete(observer.profileId);
      await this.removeFromGatekeepers(observer.observerId, gatekeeperIds);
    }
  }
}
