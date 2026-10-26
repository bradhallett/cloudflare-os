// The workspace git cache: provenance tracking and push authorization over the git object store.
//
// This layers gatekeeper-facing semantics onto the `gitObjects` collection (git-store.ts):
//
// - `GitCacheImpl` is the per-gatekeeper `GitCache` RPC stub (workshop-shared/gatekeeper.ts).
//   Every stub is scoped to the gatekeeper it was minted for; the stub passed to `applyAction()`
//   is additionally bound to the applying action, which is what enables `buildPack()`.
// - `gitObjectMetadata` records, per oid, which gatekeepers' remotes provably possess the object
//   (`onRemote`), which merely claim to (`pullableFrom`), and which queued actions plan to push
//   it (`pendingPush`). The two source sets differ in evidentiary grade: `onRemote` is entered
//   only by a hash-verified put()/push, `pullableFrom` by advertisements and referent recording.
//   An object's sources and its `pendingPush` marks extend to what it refers to as the object
//   is stored, whatever stores it and in whatever order (see `#extendToReferents`).
//   Metadata routinely exists for objects the store does NOT hold (advertised commits,
//   filtered-out tree entries, oversized blobs we declined to store), which is one of the two
//   reasons it is a separate collection -- the other being that reading a `gitObjects` row means
//   reading the whole object content.
// - `verifyPushAncestry()`/`markPushClosure()` implement `ActionDescription.pushedCommits`
//   authorization at the `submitAction` chokepoint, and the mark lifecycle helpers convert or
//   clear the marks when the action applies, is rejected, or its gatekeeper is deleted.
//
// The pull driver and every lazy read path live in git-walker.ts (`cache.walker`); this file
// keeps the writes, the scoped gatekeeper read view, and the metadata/push machinery.
//
// Trust model note (do not document the view as a confinement boundary): oids are capabilities
// and gatekeepers are trusted with the objects whose oids they know. The scoped read view and
// the ancestry rule are a mistake-safeguard and a simulation aid -- they fail an *accidental*
// push to an unrelated remote closed at queue time -- not defenses against a hostile gatekeeper.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  GitCache,
  GitObjectType,
  GitOid,
  GitPullHints,
} from "@gadgets/workshop-shared/gatekeeper";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { GitObjectMetadataRecord, GitObjectRecord } from "./storage-schema/overseer-storage";
import {
  buildPackStream,
  decodeLooseObject,
  decodePackStream,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommitRefs,
  scanGitTree,
  treeEntryObjectType,
  validateGitObjectType,
  validateGitOid,
  type PackableObject,
} from "./git-codec";
import { createWorkshopLogger } from "./observability";
import {
  GitObjectWalker,
  GitObjectTooLargeError,
  type GitCacheStorage,
  type GitPullDelegate,
  MAX_GIT_OBJECT_SIZE,
} from "./git-walker";

const logger = createWorkshopLogger("workshop.git-cache");

// =======================================================================================
// Constants

/**
 * Maximum packfile size and per-object inflation bound when the DO cache decodes a pack.
 * Native consumers bypass the cache and set their own limits.
 */
export const MAX_GIT_PACK_BYTES = 64 << 20;

// =======================================================================================
// WorkspaceGitCache

/**
 * The overseer-side core of the git cache: gatekeeper-facing writes, the per-gatekeeper scoped
 * read view, and the provenance/push-authorization machinery over the typed storage
 * collections. Local object access, the pull driver, and every lazy read live on `walker`
 * (git-walker.ts); `GitCacheImpl` stubs and the overseer's own paths (submitAction, lazy
 * reads) all funnel through here.
 */
export class WorkspaceGitCache {
  /** The lazy walker: local object access, pulls, and commit/tree/blob reads. */
  readonly walker: GitObjectWalker;

  constructor(private storage: GitCacheStorage, puller: GitPullDelegate) {
    this.walker = new GitObjectWalker(storage, puller);
    // Subscribing catches every object stored, whoever stores it: a gatekeeper's put, an import,
    // or GitStore writing through isomorphic-git, which knows nothing of this class.
    //
    // TODO(cleanup): GitStore is the only writer outside this class. Once it is gone, drop the
    // subscription and have this class's two writes (`importObjects` and `#storeVerifiedObject`)
    // call `#extendToReferents` themselves. That saves what the subscription costs on every
    // store: typed-storage reading the old record back, and the handler inflating bytes the
    // writer already had in hand.
    storage.gitObjects.subscribe({
      add: record => this.#extendToReferents(record),
      update: (_old, record) => this.#extendToReferents(record),
      remove: () => {},
    });
  }

  // -------------------------------------------------------------------------------------
  // Gatekeeper writes

  /**
   * `GitCache.put()`: store a hash-verified object on behalf of a gatekeeper. Records proof of
   * possession (`onRemote`), referent pull-routing rows for a tree's entries or a commit's
   * tree/parents, and propagates any pending-push marks to the newly-visible referents. An
   * object over MAX_GIT_OBJECT_SIZE is measured (type + size recorded) but not stored, and the
   * call throws.
   */
  async putFromGatekeeper(gatekeeperId: WorkpieceId, type: GitObjectType, payload: Uint8Array)
      : Promise<GitOid> {
    validateGitObjectType(type);
    let oid = await gitObjectOid(type, payload);
    if (!this.storage.transaction(
        () => this.#storeVerifiedObject(gatekeeperId, oid, { type, payload }))) {
      throw new GitObjectTooLargeError(oid, payload.byteLength);
    }
    return oid;
  }

  /**
   * `GitCache.advertiseCommit()`: record the assertion-grade "my remote has this commit" hint.
   * No observation is involved: an advertisement is workspace-internal pull-routing metadata,
   * not a read.
   */
  advertiseCommit(gatekeeperId: WorkpieceId, commitId: GitOid): void {
    validateGitOid(commitId);
    this.storage.transaction(
        () => this.#recordPullable(gatekeeperId, [{ oid: commitId, type: "commit" }]));
  }

  /**
   * `GitCache.consumePack()`: decode a packfile and store every contained object exactly as the
   * equivalent sequence of put()s would -- same hash-derived oids (poison-proof by
   * construction), same metadata recording and mark propagation, same size-cap handling (an
   * oversized entry is measured, recorded, and skipped rather than stored; it is then also
   * absent from the returned list, which is how a gitPull implementation notices). Returns the
   * stored oids.
   *
   * The pack streams through: small blobs, the bulk of a checkout, are stored as they arrive.
   * Everything else -- oversized blobs included, as a later delta may name one as its base -- is
   * held until the whole pack has verified, then stored the same way, one object per
   * transaction, with commits last: a commit's local presence is what lets `fetchCommit` mount
   * it and skip ever pulling it again, so no commit is stored before every other held object is.
   * A store that throws rolls back only its own object, so a failure partway can leave verified
   * trees, the root tree included, with no commit: nothing treats those as mounted, and lazy
   * reads fault around them. No await separates these stores, so they still reach disk
   * together; one transaction around them all would also undo the earlier objects when a later
   * one throws, but in production it nearly doubled a vscode-size mount's CPU.
   */
  async consumePackFromGatekeeper(gatekeeperId: WorkpieceId, pack: ReadableStream<Uint8Array>)
      : Promise<GitOid[]> {
    let held = new Map<GitOid, PackableObject>();
    let stored: GitOid[] = [];
    let objects = decodePackStream(pack, {
      maxPackSize: MAX_GIT_PACK_BYTES,
      maxObjectSize: MAX_GIT_PACK_BYTES,
      resolveBase: oid => held.get(oid) ?? this.walker.readLocalObject(oid),
    });
    for await (let { oid, ...object } of objects) {
      if (object.type === "blob" && object.payload.byteLength <= MAX_GIT_OBJECT_SIZE) {
        this.storage.transaction(() => this.#storeVerifiedObject(gatekeeperId, oid, object));
        stored.push(oid);
      } else {
        held.set(oid, object);
      }
    }
    let commitsLast = [...held].toSorted(([, a], [, b]) =>
        Number(a.type === "commit") - Number(b.type === "commit"));
    for (let [oid, object] of commitsLast) {
      if (this.storage.transaction(() => this.#storeVerifiedObject(gatekeeperId, oid, object))) {
        stored.push(oid);
      }
    }
    return stored;
  }
  // -------------------------------------------------------------------------------------
  // The scoped gatekeeper read view

  /**
   * The single read behind `GitCache.get()`/`has()`/`stat()`: answers exactly
   * `onRemote(G) ∪ pendingPush(G)` for gatekeeper G and null for everything else. A pendingPush
   * object that is locally absent is pulled through from its recorded sources on demand (that
   * is what lets G simulate a queued cross-remote push); an absent onRemote object is not
   * pulled -- G's own remote has it, and null tells G to ask its remote itself.
   */
  async readForGatekeeper(gatekeeperId: WorkpieceId, oid: GitOid, hints?: GitPullHints)
      : Promise<PackableObject | null> {
    validateGitOid(oid);
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) return null;
    let onRemote = meta.onRemote.includes(gatekeeperId);
    let pendingPush = meta.pendingPush.some(p => p.gatekeeperId === gatekeeperId);
    if (!onRemote && !pendingPush) return null;

    let local = this.walker.readLocalObject(oid);
    if (local === undefined && pendingPush) {
      await this.walker.ensureGitObjects([oid], hints ?? this.walker.exactObjectHints(meta.type));
      local = this.walker.readLocalObject(oid);
    }
    return local ?? null;
  }
  // -------------------------------------------------------------------------------------
  // Push authorization (the `ActionDescription.pushedCommits` machinery)

  /**
   * Verifies that every parent chain from each declared head reaches a commit *proven* on the
   * gatekeeper's remote (`onRemote` -- an advertisement never qualifies), walking cached commit
   * objects only. Throws an agent-visible error for an absent ancestor and for a parentless
   * root that isn't itself proven (no vacuous pass for roots): this is the safeguard that makes
   * an accidental push to an unrelated remote fail closed at queue time. Read-only; call before
   * `markPushClosure()`.
   */
  verifyPushAncestry(gatekeeperId: WorkpieceId, heads: GitOid[]): void {
    let visited = new Set<GitOid>();
    let stack = heads.map(validateGitOid);
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      let meta = this.storage.gitObjectMetadata.get(oid);
      if (meta?.onRemote.includes(gatekeeperId)) {
        // Prefer the decoded local type over the recorded one: an onRemote row's type is
        // usually measured, but marks converted after an applied push carry the walk's
        // assertion-grade stamp, and an assertion must never decide this check when the
        // bytes themselves are on hand.
        let type = this.walker.readLocalObject(oid)?.type ?? meta.type;
        if (type !== "commit") {
          throw new Error(`Cannot push ${oid}: it is a ${type}, not a commit.`);
        }
        continue;  // proven on the destination
      }
      let local = this.walker.readLocalObject(oid);
      if (local === undefined) {
        throw new Error(
            `Cannot push: commit ${oid} in the pushed history is not available in the ` +
            `workspace's git cache, so the history cannot be verified against the destination. ` +
            `A push requires the commit chain from each pushed head down to a commit pulled ` +
            `from (or already pushed to) the destination to be locally available -- in ` +
            `practice, commits authored here on top of a base pulled from that destination. ` +
            `Pushing a pre-existing branch whose intermediate history was never pulled is not ` +
            `supported yet.`);
      }
      if (local.type !== "commit") {
        throw new Error(`Cannot push ${oid}: it is a ${local.type}, not a commit.`);
      }
      let refs = parseGitCommitRefs(local.payload, oid);
      if (refs.parents.length === 0) {
        throw new Error(
            `Cannot push: the pushed history reaches root commit ${oid}, which is not known ` +
            `to the destination. Pushing a history unrelated to the destination is not ` +
            `supported (this protects against accidentally pushing to the wrong repository). ` +
            `If the repositories are genuinely related, first pull a shared ancestor commit ` +
            `from the destination.`);
      }
      stack.push(...refs.parents);
    }
  }

  /**
   * `GitCache.isAncestor()`: whether `ancestor` is reachable from `descendant` (inclusive) by
   * following parent links over locally cached commits. The walk never pulls; a parent chain
   * that leaves the cache simply stops, so false means "not verifiable as an ancestor over
   * cached history". Throws if `descendant` is not itself a locally cached commit, so callers
   * can distinguish "verified not an ancestor" from "history not available". Deliberately not
   * scoped to any gatekeeper's view (see the interface doc): this is what lets a gatekeeper
   * run a fast-forward check before submitting the push that would put the commits in view.
   */
  isAncestor(ancestor: GitOid, descendant: GitOid): boolean {
    validateGitOid(ancestor);
    validateGitOid(descendant);
    let start = this.walker.readLocalObject(descendant);
    if (start === undefined || start.type !== "commit") {
      throw new Error(
          `Cannot check ancestry: ${descendant} is not a commit in the workspace's git cache.`);
    }
    if (ancestor === descendant) return true;
    let visited = new Set<GitOid>([descendant]);
    let stack = [...parseGitCommitRefs(start.payload, descendant).parents];
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      if (oid === ancestor) return true;
      let local = this.walker.readLocalObject(oid);
      // An absent or non-commit parent ends this path: the walk answers over cached commit
      // history only. (A non-commit parent oid means a forged commit; not this method's problem.)
      if (local === undefined || local.type !== "commit") continue;
      stack.push(...parseGitCommitRefs(local.payload, oid).parents);
    }
    return false;
  }

  /**
   * The best common ancestors of two commits, as `git merge-base --all` defines them: every
   * commit reachable from both (a commit reaches itself) that is not reachable from another
   * such commit, in no particular order. Usually there is one, the base for a three-way merge
   * of the two. A criss-cross history has several, and unrelated histories have none.
   *
   * Like `isAncestor()`, this walks locally cached commits and never pulls. A parent chain that
   * leaves the cache stops at the first commit not held: that commit still counts as an
   * ancestor, since a held commit names it, but its own ancestors go unseen. So the answer is
   * exact wherever both histories are wholly held, as a gadget's and a blueprint release's are.
   * Throws if either commit is not itself a locally cached commit.
   */
  mergeBases(a: GitOid, b: GitOid): GitOid[] {
    let ancestryOfA = this.#cachedAncestry(a);
    let ancestryOfB = this.#cachedAncestry(b);
    let common = [...ancestryOfA.keys()].filter(oid => ancestryOfB.has(oid));
    // Every parent of a common ancestor is a common ancestor too, so one of them is reachable
    // from another exactly when it is the parent of one.
    let reachable = new Set(common.flatMap(oid => ancestryOfA.get(oid)!));
    return common.filter(oid => !reachable.has(oid));
  }

  // Every commit reachable from `start`, itself included, over cached history, each with its
  // parents -- or with none, if it is not a locally cached commit and the walk stops there.
  #cachedAncestry(start: GitOid): Map<GitOid, GitOid[]> {
    validateGitOid(start);
    let ancestry = new Map<GitOid, GitOid[]>();
    let stack = [start];
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (ancestry.has(oid)) continue;
      let local = this.walker.readLocalObject(oid);
      let parents: GitOid[] = [];
      if (local?.type === "commit") {
        parents = parseGitCommitRefs(local.payload, oid).parents;
      } else if (oid === start) {
        throw new Error(
            `Cannot find merge bases: ${start} is not a commit in the workspace's git cache.`);
      }
      ancestry.set(oid, parents);
      stack.push(...parents);
    }
    return ancestry;
  }

  /**
   * Marks the push closure of a verified `pushedCommits` declaration: walks from the heads
   * through parents and containment (commit → tree → entries), stamping every visited object
   * `pendingPush {gatekeeperId, actionId}` -- skipping, without descending, objects the remote
   * already knows (`onRemote ∪ pullableFrom`; remotes are closed under containment) and
   * skipping gitlink entries entirely (a submodule commit belongs to a foreign repo). An
   * absent tree/blob that isn't remote-known is still marked; when its bytes later arrive, the
   * mark propagates to its referents under the same rules (see `#extendToReferents`).
   *
   * Callers run this inside the same transaction that persists the action record, so a failed
   * submit strands no marks.
   */
  markPushClosure(gatekeeperId: WorkpieceId, actionId: number, heads: GitOid[]): void {
    this.#markForPush(gatekeeperId, actionId,
        heads.map(oid => ({ oid: validateGitOid(oid), type: "commit" as GitObjectType })));
  }

  // The marking walk worker, shared by markPushClosure (from the declared heads) and lazy
  // propagation at object arrival (from a marked object's referents). Each entry's type comes
  // from its referencing context (assertion-grade).
  #markForPush(gatekeeperId: WorkpieceId, actionId: number,
               initial: { oid: GitOid, type: GitObjectType }[]): void {
    let stack = [...initial];
    while (stack.length > 0) {
      let { oid, type } = stack.pop()!;
      let { meta, dirty } = this.#metaFor(gatekeeperId, oid, type, "asserted");
      if (meta.onRemote.includes(gatekeeperId) || meta.pullableFrom.includes(gatekeeperId) ||
          meta.pendingPush.some(p => p.actionId === actionId)) {
        // Remote-known (skip without descending) or already visited; still persist a type
        // reconciliation so the log never claims a correction that didn't land.
        if (dirty) this.storage.gitObjectMetadata.put(meta);
        continue;
      }
      meta.pendingPush.push({ gatekeeperId, actionId });
      this.storage.gitObjectMetadata.put(meta);  // also lands in byPendingPushAction
      let local = this.walker.readLocalObject(oid);
      if (local !== undefined) stack.push(...this.#referentEntries(oid, local));
    }
  }

  // The containment edges of an object, for the marking walk and mark propagation: a commit
  // points at its tree and parents, a tree at its non-gitlink entries. Gitlink targets are
  // foreign repos' commits and are never walked, pulled, or pushed.
  #referentEntries(oid: GitOid, object: PackableObject): { oid: GitOid, type: GitObjectType }[] {
    if (object.type === "commit") {
      let refs = parseGitCommitRefs(object.payload, oid);
      return [
        { oid: refs.tree, type: "tree" },
        ...refs.parents.map(parent => ({ oid: parent, type: "commit" as GitObjectType })),
      ];
    } else if (object.type === "tree") {
      return scanGitTree(object.payload, oid)
          .filter(entry => entry.mode !== "160000")
          .map(entry => ({ oid: entry.oid, type: treeEntryObjectType(entry.mode) }));
    }
    return [];
  }

  /**
   * Converts an applied action's pending-push marks into `onRemote` proof: the remote genuinely
   * received the objects (they also become re-pullable from it). Idempotent; run it in the same
   * transaction as the action's completion record, so a crash between the push and the
   * conversion strands nothing locally.
   */
  convertPushMarksToOnRemote(actionId: number): void {
    for (let meta of this.#recordsMarkedFor(actionId)) {
      let converted = meta.pendingPush.filter(p => p.actionId === actionId);
      meta.pendingPush = meta.pendingPush.filter(p => p.actionId !== actionId);
      for (let entry of converted) addUnique(meta.onRemote, entry.gatekeeperId);
      this.storage.gitObjectMetadata.put(meta);  // the index entry drops with the array element
    }
  }

  /**
   * Removes a queued push's marks without conversion: the action was rejected, or its
   * gatekeeper was deleted with the push still queued. (A *reverted* applied push keeps
   * `onRemote` -- the remote received the objects; the ref merely rolled back -- so reverts
   * call nothing here.)
   */
  clearPushMarks(actionId: number): void {
    for (let meta of this.#recordsMarkedFor(actionId)) {
      meta.pendingPush = meta.pendingPush.filter(p => p.actionId !== actionId);
      if (meta.pendingPush.length === 0 && meta.onRemote.length === 0 &&
          meta.pullableFrom.length === 0 && meta.size === undefined) {
        this.storage.gitObjectMetadata.delete(meta.oid);
      } else {
        this.storage.gitObjectMetadata.put(meta);
      }
    }
  }

  // The metadata records marked pending-push for one action, materialized before iteration:
  // the callers mutate the collection (and hence the index) mid-loop.
  #recordsMarkedFor(actionId: number): GitObjectMetadataRecord[] {
    return Array.from(this.storage.gitObjectMetadata.byPendingPushAction.get(actionId));
  }

  /**
   * `GitCache.buildPack()`: composes the undeltified packfile carrying the applying action's
   * full pending-push closure. Completes the closure first: any marked object absent from the
   * store is faulted in from its recorded sources (batched by type), and a faulted tree's
   * arrival propagates marks to its children, which may fault in turn -- repeating until no
   * marked object is absent. A mid-stream provenance loss fails the apply with the "reconnect"
   * error from the pull delegate.
   */
  async buildPackForAction(gatekeeperId: WorkpieceId, actionId: number)
      : Promise<ReadableStream<Uint8Array>> {
    for (;;) {
      let missing = this.#recordsMarkedFor(actionId)
          .filter(mark => !this.walker.hasLocalObject(mark.oid));
      if (missing.length === 0) break;
      // One batched fetch per expected type (a fetch's hints carry a single type).
      let byType = new Map<GitObjectType, GitOid[]>();
      for (let mark of missing) {
        let group = byType.get(mark.type);
        if (group === undefined) byType.set(mark.type, group = []);
        group.push(mark.oid);
      }
      for (let [type, oids] of byType) {
        await this.walker.ensureGitObjects(oids, this.walker.exactObjectHints(type));
      }
      // Arrivals may have propagated marks to newly-visible children; loop until closed. The
      // marked set grows monotonically toward the finite closure, and ensureGitObjects throws
      // rather than silently not delivering, so this terminates.
    }

    const marks = this.#recordsMarkedFor(actionId), cache = this;
    async function* objects() { for (const mark of marks) yield await cache.walker.ensureObject(mark.oid, {type: mark.type}); }
    return buildPackStream(marks.length, objects());
  }
  // -------------------------------------------------------------------------------------
  // Metadata plumbing

  // Fetches or creates the metadata row for an oid, reconciling the caller's knowledge of the
  // object's type with what is already recorded. `grade` is the claim's evidentiary grade:
  // "measured" means the type comes from hash-verified bytes in hand, and always wins (two
  // measurements can never conflict -- the oid covers the type header); "asserted" means it
  // comes from a referencing context or an advertisement, and never overrides a measured type
  // (measured iff `size` is recorded -- see the field docs). Among conflicting assertions,
  // "commit" wins and otherwise the first claim is kept: commit-ness is what unlocks operations
  // (worktree creation, push heads), and a false non-commit tag could steer a reader into
  // refusing before pulling, while a false commit tag just makes us pull and discover the
  // truth. Any conflict indicates a forged object or a gatekeeper bug, so all are logged; none
  // is fatal -- a wrong type only mis-shapes advisory pull hints until measured bytes correct
  // it. `dirty` reports a type correction on an existing row, so callers that otherwise skip
  // redundant puts still persist it.
  #metaFor(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType,
           grade: "measured" | "asserted")
      : { meta: GitObjectMetadataRecord, dirty: boolean } {
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) {
      return { meta: { oid, type, onRemote: [], pullableFrom: [], pendingPush: [] },
               dirty: false };
    }
    let dirty = false;
    if (meta.type !== type) {
      let wins = grade === "measured" || (meta.size === undefined && type === "commit");
      logger.warn(wins ? "correcting git object type from conflicting claim"
                       : "ignoring conflicting git object type claim", {
        event: wins ? "git.metadata.type.corrected" : "git.metadata.type.conflict",
        gatekeeperId,
        oidPrefix: oid.slice(0, 12),  // truncated: full oids are capabilities, keep them out
        recordedType: meta.type,
        claimedType: type,
      });
      if (wins) {
        meta.type = type;
        dirty = true;
      }
    }
    return { meta, dirty };
  }

  // Records an assertion-grade pull-routing hint, for an advertised commit or for the referents
  // of an object the gatekeeper is a source of. Like the marking walk, this descends through
  // objects that are held, whose referents the remote must have as well. That is what makes
  // the order objects arrive in immaterial: one stored before its parent could not be given a
  // hint that only the parent's arrival brings. The walk stops at an object the gatekeeper was
  // already a source of, whose referents were given the hint when it became one.
  #recordPullable(gatekeeperId: WorkpieceId, initial: { oid: GitOid, type: GitObjectType }[])
      : void {
    let stack = [...initial];
    while (stack.length > 0) {
      let { oid, type } = stack.pop()!;
      let { meta, dirty } = this.#metaFor(gatekeeperId, oid, type, "asserted");
      let wasSource =
          meta.onRemote.includes(gatekeeperId) || meta.pullableFrom.includes(gatekeeperId);
      if (addUnique(meta.pullableFrom, gatekeeperId) || dirty) {
        this.storage.gitObjectMetadata.put(meta);
      }
      if (wasSource) continue;
      let local = this.walker.readLocalObject(oid);
      if (local !== undefined) stack.push(...this.#referentEntries(oid, local));
    }
  }

  // Records the measurement of an object too large to store: type and exact size (proof-grade,
  // from bytes in hand) plus possession -- the bytes were hash-verified even though declined.
  #recordOversized(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType, size: number)
      : void {
    let { meta } = this.#metaFor(gatekeeperId, oid, type, "measured");
    meta.size = size;
    addUnique(meta.onRemote, gatekeeperId);
    this.storage.gitObjectMetadata.put(meta);
  }

  // The shared put()-equivalent store step (callers wrap in a transaction): an object over
  // MAX_GIT_OBJECT_SIZE is only measured, returning false. Anything else has proof of possession
  // recorded and is then stored, which extends that proof to its referents as pull routing (see
  // `#extendToReferents`). An object already present, measured, and proven for this gatekeeper
  // is left as it is: a pull sends no `have`s, so a retried one, or one for another commit of a
  // mounted repository, carries mostly such objects.
  #storeVerifiedObject(gatekeeperId: WorkpieceId, oid: GitOid, { type, payload }: PackableObject)
      : boolean {
    if (payload.byteLength > MAX_GIT_OBJECT_SIZE) {
      this.#recordOversized(gatekeeperId, oid, type, payload.byteLength);
      return false;
    }
    let { meta } = this.#metaFor(gatekeeperId, oid, type, "measured");
    if (meta.size !== undefined && meta.onRemote.includes(gatekeeperId) &&
        this.walker.hasLocalObject(oid)) {
      return true;
    }
    addUnique(meta.onRemote, gatekeeperId);
    meta.size = payload.byteLength;
    this.storage.gitObjectMetadata.put(meta);
    this.storage.gitObjects.put({ oid, data: encodeLooseObject(type, payload) });
    return true;
  }

  // Extends what is recorded about an object to the objects it refers to. This can only happen
  // once the object's bytes are here to say what those are, so it runs as the object is stored,
  // inside the storing transaction, whatever is storing it (see the constructor):
  // - Every gatekeeper recorded as a source of the object, by proof or by claim, becomes a pull
  //   source for its referents, and on through those of them that are held. Remotes are closed
  //   under containment, so a remote that has the object has them too, whichever way these
  //   bytes arrived.
  // - Every queued push that includes the object includes its referents, under the marking
  //   walk's rules. The walk could mark the object while it was absent, but not see past it.
  #extendToReferents({ oid, data }: GitObjectRecord): void {
    let meta = this.storage.gitObjectMetadata.get(oid);
    // Nothing is recorded about most objects authored here. And a blob refers to nothing, which
    // is worth knowing without inflating it, where its type was measured rather than claimed.
    if (meta === undefined || (meta.size !== undefined && meta.type === "blob")) return;

    let referents = this.#referentEntries(oid, decodeLooseObject(data));
    for (let gatekeeperId of new Set([...meta.onRemote, ...meta.pullableFrom])) {
      this.#recordPullable(gatekeeperId, referents);
    }
    // After the sources, so that a push skips what its destination is now known to have.
    for (let mark of meta.pendingPush) {
      this.#markForPush(mark.gatekeeperId, mark.actionId, referents);
    }
  }
}
// =======================================================================================
// The RPC stub

/**
 * The `GitCache` stub handed to gatekeepers (see workshop-shared/gatekeeper.ts for the
 * interface contract). Minted per gatekeeper -- the identity scopes both metadata attribution
 * (put/advertise record this gatekeeper as the source) and the read view. The overseer
 * additionally binds the stub passed to `applyAction()` to the applying action, which is what
 * makes `buildPack()` available; session-scoped stubs (from
 * `ObservationAuthorizer.getGitCache()`) have no action and `buildPack()` throws.
 */
@validateRpc()
export class GitCacheImpl extends RpcTarget implements GitCache {
  constructor(private cache: WorkspaceGitCache, private gatekeeperId: WorkpieceId,
              private actionId?: number) {
    super();
  }

  async get(id: GitOid, hints?: GitPullHints)
      : Promise<{ type: GitObjectType, content: Uint8Array } | null> {
    let object = await this.cache.readForGatekeeper(this.gatekeeperId, id, hints);
    return object === null ? null : { type: object.type, content: object.payload };
  }

  async has(id: GitOid): Promise<boolean> {
    return await this.cache.readForGatekeeper(this.gatekeeperId, id) !== null;
  }

  async stat(id: GitOid): Promise<{ type: GitObjectType, size: number } | null> {
    let object = await this.cache.readForGatekeeper(this.gatekeeperId, id);
    return object === null ? null : { type: object.type, size: object.payload.byteLength };
  }

  async put(type: GitObjectType, content: Uint8Array): Promise<GitOid> {
    return this.cache.putFromGatekeeper(this.gatekeeperId, type, content);
  }

  async advertiseCommit(commitId: GitOid): Promise<void> {
    this.cache.advertiseCommit(this.gatekeeperId, commitId);
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    if (this.actionId === undefined) {
      throw new Error(
          "buildPack() is only available on the action-scoped GitCache stub passed to " +
          "applyAction(); a session-time stub has no action.");
    }
    return this.cache.buildPackForAction(this.gatekeeperId, this.actionId);
  }

  async consumePack(pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    return this.cache.consumePackFromGatekeeper(this.gatekeeperId, pack);
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    return this.cache.isAncestor(ancestor, descendant);
  }
}
// =======================================================================================
// Small helpers
function addUnique<T>(array: T[], value: T): boolean {
  if (array.includes(value)) return false;
  array.push(value);
  return true;
}
