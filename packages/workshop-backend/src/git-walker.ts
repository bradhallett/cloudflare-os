// The lazy git-object walker over the workspace git object store (see git-cache.ts for the
// provenance/push-authorization layer that owns the store):
//
// - local object access (`hasLocalObject`/`readLocalObject`/`importObjects`) with no view
//   scoping and no pulls, for objects already stored;
// - `ensureGitObjects()`, the pull driver: it routes a fault to the object's recorded sources
//   and calls `Gatekeeper.gitPull()` through the overseer-provided delegate;
// - the lazy read paths (`ensureObject`, `readFileAtCommit*`, `listTreeEntries`,
//   `readCommitTree`, `readFilesAtCommit`, ...) that parse git objects via the hand-rolled
//   codec (git-codec.ts) rather than isomorphic-git, because each step must know the expected
//   type and the referencing object to shape `GitPullHints`. Writes never fault and stay in
//   git-store.ts on isomorphic-git.

import type { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import type {
  GitObjectType,
  GitOid,
  GitPullHints,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  READ_FILES_RESPONSE_BUDGET,
  type FileAtCommit,
  type TreeNode,
  type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { GitObjectMetadataRecord, GitObjectRecord } from "./storage-schema/overseer-storage";
import type { BytesRef } from "@gadgets/workshop-shared/code-change";
import {
  decodeLooseObject,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommitRefs,
  parseGitTree,
  type GitTreeEntry,
  type PackableObject,
} from "./git-codec";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.git-cache");

// =======================================================================================
// Constants

/**
 * Maximum payload size of a single git object the cache will accept from a gatekeeper (a put(),
 * or a pack entry). The git store (git-store.ts) writes each object, deflated, as one row of
 * Durable Object SQLite storage, and the platform caps a row at 8 MiB (8,388,608 bytes). Even
 * incompressible content deflates to barely more than its own size, so an object of up to
 * 8,000,000 bytes always fits, with room to spare. A put() beyond this is rejected -- but measured
 * first, so the size lands in metadata and later reads of the object fail fast instead of
 * re-downloading it.
 *
 * This bounds only what is brought in from remotes. It is never applied to an object the store
 * already holds: whatever storage accepted is readable.
 */
export const MAX_GIT_OBJECT_SIZE = 8_000_000;

/**
 * Blob size fetched eagerly when pulling a worktree base: the pull requests the base commit with
 * `filterBlobSize: EAGER_BLOB_LIMIT`, so the commit, its full tree structure, and every blob
 * under this limit arrive in one fetch, and only genuinely large files pay a lazy fault's
 * latency on first access. Both the worktree-creation pull and a later fault against a base
 * whose trees are missing (a commit known only locally at creation; see #resolveEntryAt) use
 * this shape.
 */
export const EAGER_BLOB_LIMIT = 64 * 1024;
// =======================================================================================
// Storage

/** The slice of the Overseer's typed storage the git cache operates on. */
export interface GitCacheStorage {
  gitObjects: Collection<GitObjectRecord, string>;
  gitObjectMetadata: Collection<GitObjectMetadataRecord, string> & {
    byPendingPushAction: NonUniqueIndex<GitObjectMetadataRecord, number>;
  };
  transaction<T>(callback: () => T): T;
}

/**
 * How the cache reaches a gatekeeper to pull objects. Implemented by the overseer over
 * `getGatekeeperFacet()` + `Gatekeeper.gitPull()`; injected so the cache stays testable with a
 * mock and so this module needs no facet plumbing.
 */
export interface GitPullDelegate {
  /**
   * Invoke `Gatekeeper.gitPull(oids, hints)` and consume its pack with that source's provenance
   * and the cache's size limits. Must throw if the gatekeeper record no longer exists (provenance
   * loss: the error should tell the user to reconnect) or if the pull fails.
   */
  pull(gatekeeperId: WorkpieceId, oids: GitOid[], hints: GitPullHints): Promise<void>;
}
// =======================================================================================
// Errors

/**
 * A git blob (or other object) is beyond MAX_GIT_OBJECT_SIZE, either measured (a rejected put
 * recorded its exact size) or inferred from a blob-filtered pull that omitted it. Read paths
 * translate this into a path-specific "file is too large" error.
 */
export class GitObjectTooLargeError extends Error {
  constructor(public readonly oid: GitOid, size?: number) {
    super(size !== undefined
        ? `git object ${oid} is ${size} bytes, over the ${MAX_GIT_OBJECT_SIZE}-byte limit`
        : `git object ${oid} exceeds the ${MAX_GIT_OBJECT_SIZE}-byte limit`);
  }
}

/**
 * A worktree file's *content* cannot be presented as text: the blob is unavailable at the
 * supported size (a remote's blob the cache declined or a filtered pull omitted; see
 * MAX_GIT_OBJECT_SIZE) or is not valid UTF-8 text (binary). The message is the agent-visible, path-
 * flavored description. Distinct from path-shape errors (symlink/gitlink/directory) and from
 * transient pull failures so callers can tell "fine to overwrite whole, but unreadable and
 * undiffable" apart from errors that must propagate: the Worktree binding's writeFile falls
 * back to a whole-file `set` on this error (and only this error), and its grep/diff render it
 * as a skip note.
 */
export class UnreadableContentError extends Error {}
// =======================================================================================
// Tree entry kinds (the agent-facing vocabulary for the five git modes)

/** What a tree entry is, as surfaced to file listings. */
export type GitTreeEntryKind = "file" | "executable" | "dir" | "symlink" | "submodule";

/** One entry of a directory listing produced by `listTreeEntries()`. */
export interface GitTreeDirEntry {
  name: string;
  kind: GitTreeEntryKind;
  oid: GitOid;
}

/** One entry of a path-keyed listing produced by `listCommitTreePaths()`. */
export interface GitTreePathEntry {
  /** Full path from the commit's tree root. */
  path: string;
  kind: GitTreeEntryKind;
  oid: GitOid;
}

/** The entry at one path of a commit's tree, as resolved by `pathEntryAtCommit()`. */
export interface GitPathEntry {
  kind: GitTreeEntryKind;
  oid: GitOid;
  /**
   * The object whose payload holds the entry -- its containing tree, or the commit itself for
   * the root -- the hint a later read of the entry's object should carry.
   */
  referencedBy: GitOid;
}

const MODE_KINDS: Record<GitTreeEntry["mode"], GitTreeEntryKind> = {
  "100644": "file",
  "100755": "executable",
  "40000": "dir",
  "120000": "symlink",
  "160000": "submodule",
};
const TEXT_DECODER_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// =======================================================================================
// GitObjectWalker

/**
 * The overseer-side lazy walker over the git object store: local object access, the pull
 * driver, and every commit/tree/blob read path. One instance per Overseer, owned by the
 * `WorkspaceGitCache` (git-cache.ts) as `cache.walker` and shared with its callers.
 */
export class GitObjectWalker {
  constructor(private storage: GitCacheStorage, private puller: GitPullDelegate) {}

  // -------------------------------------------------------------------------------------
  // Local object access

  /** Whether the store holds the object locally (no view scoping, no pulls). */
  hasLocalObject(oid: GitOid): boolean {
    return this.storage.gitObjects.get(oid) !== undefined;
  }

  /** Reads and decodes a locally-stored object, or undefined (no view scoping, no pulls). */
  readLocalObject(oid: GitOid): PackableObject | undefined {
    let record = this.storage.gitObjects.get(oid);
    return record === undefined ? undefined : decodeLooseObject(record.data);
  }

  /**
   * Stores objects that came from no gatekeeper -- a blueprint release's -- in one storage
   * transaction. Each goes under the oid computed here from its content, so nothing a caller
   * passes can poison the store. The objects are attributed to no remote: one that nothing was
   * recorded about stays that way, like a commit authored here, so no gatekeeper's scoped view
   * answers for it. An object already held is left as it is, along with whatever metadata it
   * has.
   *
   * There is no size cap; the caller bounds what it imports.
   */
  async importObjects(objects: Iterable<PackableObject>): Promise<void> {
    let entries = await Promise.all(Array.from(objects, async object =>
        ({ ...object, oid: await gitObjectOid(object.type, object.payload) })));
    this.storage.transaction(() => {
      for (let { oid, type, payload } of entries) {
        if (this.hasLocalObject(oid)) continue;
        this.storage.gitObjects.put({ oid, data: encodeLooseObject(type, payload) });
      }
    });
  }
  /**
   * Ensures the given objects are locally present, pulling any that are missing from their
   * recorded sources (`onRemote ∪ pullableFrom`, trying each recorded gatekeeper on failure).
   * All requests in one call share `hints` (batch callers group by expected type).
   *
   * Throws if an object cannot be obtained -- with one deliberate exception folded into the
   * error type: a requested *blob* still absent after a successful pull whose hints carried a
   * blob filter is reported as GitObjectTooLargeError ("unavailable at the supported size")
   * rather than as a pull failure. Nothing is recorded for it, so a later read simply retries;
   * a gatekeeper bug that wrongly omits a blob self-heals instead of wedging the file.
   */
  async ensureGitObjects(oids: GitOid[], hints: GitPullHints): Promise<void> {
    let missing = [...new Set(oids)].filter(oid => !this.hasLocalObject(oid));
    if (missing.length === 0) return;

    // Fail fast on objects whose measured size already proves them unstorable.
    for (let oid of missing) {
      let size = this.storage.gitObjectMetadata.get(oid)?.size;
      if (size !== undefined && size > MAX_GIT_OBJECT_SIZE) {
        throw new GitObjectTooLargeError(oid, size);
      }
    }

    let triedSources = new Map<GitOid, Set<WorkpieceId>>();
    let lastError: unknown;
    while (true) {
      missing = missing.filter(oid => !this.hasLocalObject(oid));
      if (missing.length === 0) return;

      // Group the still-missing objects by each one's next untried recorded source.
      let groups = new Map<WorkpieceId, GitOid[]>();
      for (let oid of missing) {
        let meta = this.storage.gitObjectMetadata.get(oid);
        let sources = [...new Set([...(meta?.onRemote ?? []), ...(meta?.pullableFrom ?? [])])];
        let tried = triedSources.get(oid) ?? new Set();
        let next = sources.find(source => !tried.has(source));
        if (next === undefined) {
          throw new Error(
              `Could not pull git object ${oid}: ` +
              (sources.length === 0
                  ? "no connection is known to provide it."
                  : `every connection that could provide it failed. Last error: ` +
                    `${lastError instanceof Error ? lastError.message : String(lastError)}`));
        }
        let group = groups.get(next);
        if (group === undefined) groups.set(next, group = []);
        group.push(oid);
      }

      for (let [gatekeeperId, groupOids] of groups) {
        for (let oid of groupOids) {
          let tried = triedSources.get(oid);
          if (tried === undefined) triedSources.set(oid, tried = new Set());
          tried.add(gatekeeperId);
        }
        try {
          await this.puller.pull(gatekeeperId, groupOids, hints);
        } catch (err) {
          lastError = err;
          logger.warn("git pull from source failed", {
            event: "git.pull.source.failed", gatekeeperId, oidCount: groupOids.length,
            error: err,
          });
          continue;
        }
        // The filtered-omission carve-out: a blob the pull's own filter suppressed is "too
        // large", not "pull failed" (see the method doc).
        if (hints.type === "blob" && hints.filterBlobSize !== undefined) {
          let omitted = groupOids.find(oid => !this.hasLocalObject(oid));
          if (omitted !== undefined) throw new GitObjectTooLargeError(omitted);
        }
      }
    }
  }

  /**
   * The lazy walker's fault-and-parse step: returns the object, pulling it on a miss with
   * exact-object hints shaped from the expected type and the referencing object. Throws if the
   * object cannot be obtained or is not of the expected type.
   *
   * `eagerTree` widens a commit/tree miss into the worktree-creation pull shape -- the whole
   * tree closure plus blobs up to EAGER_BLOB_LIMIT in one round trip (see #resolveEntryAt) --
   * instead of one object per fault. It changes only how much a *miss* pulls; a locally present
   * object never pulls anything.
   */
  async ensureObject(oid: GitOid,
                     expected: { type: GitObjectType, referencedBy?: GitOid, eagerTree?: boolean })
      : Promise<PackableObject> {
    let local = this.readLocalObject(oid);
    if (local === undefined) {
      await this.ensureGitObjects([oid],
          expected.eagerTree && expected.type !== "blob"
              ? { type: expected.type,
                  ...(expected.referencedBy !== undefined
                      ? { referencedBy: expected.referencedBy } : {}),
                  commitHistory: { kind: "depth", depth: 1 },
                  filterBlobSize: EAGER_BLOB_LIMIT }
              : this.exactObjectHints(expected.type, expected.referencedBy));
      local = this.readLocalObject(oid);
      if (local === undefined) {
        // ensureGitObjects throws on failure; this is a defensive backstop.
        throw new Error(`git object ${oid} is unavailable`);
      }
    }
    if (local.type !== expected.type) {
      throw new Error(`git object ${oid} is a ${local.type}, but a ${expected.type} was expected`);
    }
    return local;
  }

  /**
   * The pull-hint defaults for an exact-object fault: depth-1 (never deepen history), tree:0
   * alongside a commit want, tree:1 alongside a tree want (which already excludes the entries'
   * blobs), and a blob filter at the storable limit alongside a blob want -- so an oversized
   * blob either never arrives (the filter honored: the carve-out surfaces "too large") or
   * arrives huge (put()'s size rejection measures and records it). Either way, no absence-based
   * bookkeeping.
   */
  exactObjectHints(type: GitObjectType, referencedBy?: GitOid): GitPullHints {
    return {
      type,
      ...(referencedBy !== undefined ? { referencedBy } : {}),
      commitHistory: { kind: "depth", depth: 1 },
      ...(type === "commit" ? { filterTreeDepth: 0 } : {}),
      ...(type === "tree" ? { filterTreeDepth: 1 } : {}),
      ...(type === "blob" ? { filterBlobSize: MAX_GIT_OBJECT_SIZE + 1 } : {}),
    };
  }

  /**
   * Reads one file of a commit's tree by path, walking only the trees along the path (no
   * full-tree materialization) and fault-pulling whatever is missing. Regular files only:
   * a symlink or submodule (gitlink) path throws a descriptive error naming its target, a
   * directory path or absent entry throws "no such file", and oversized or binary (non-UTF-8 /
   * NUL-bearing) content throws a clean, path-specific error.
   */
  async readFileAtCommit(commitOid: GitOid, path: string): Promise<string> {
    let text = await this.readFileAtCommitIfExists(commitOid, path);
    if (text === undefined) throw new Error(`${path}: no such file`);
    return text;
  }

  /**
   * Like `readFileAtCommit`, but an absent path (including a path whose leading segments don't
   * resolve to directories, or one naming a directory) returns undefined instead of throwing.
   * Every other failure -- symlink/gitlink paths, oversized or binary content, a pull failure --
   * still throws its descriptive error. This is the lazy base resolver behind worktree session
   * content: "no base text" is an ordinary state there ("edit of absent file" is then the
   * change's own validation error), while the throwing errors describe the file itself.
   */
  async readFileAtCommitIfExists(commitOid: GitOid, path: string): Promise<string | undefined> {
    return (await this.readFileAtCommitWithOid(commitOid, path))?.text;
  }

  /** Resolve one regular file to its existing immutable Git blob reference. */
  async fileBytesAtCommit(commitOid: GitOid, path: string): Promise<BytesRef | undefined> {
    const {tree, entry} = await this.#resolveEntryAt(commitOid, path);
    if (!entry) return undefined;
    if (entry.mode === "40000") throw new Error(`${path} is a directory`);
    if (entry.mode === "160000") throw new Error(submoduleMessage(path, entry.oid));
    if (entry.mode === "120000") {
      throw new Error(symlinkMessage(path, await this.#readBlob(entry.oid, tree, path)));
    }
    const payload = await this.#readBlob(entry.oid, tree, path);
    return {oid: entry.oid, byteLength: payload.byteLength};
  }

  /**
   * `readFileAtCommitIfExists` that also reports the blob's oid -- the file's content address,
   * which a later `fileOidAtCommit` on another commit compares equal iff the content is
   * byte-identical. Same rules and errors otherwise.
   */
  async readFileAtCommitWithOid(commitOid: GitOid, path: string)
      : Promise<{ text: string, oid: GitOid } | undefined> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry === undefined || entry.mode === "40000") return undefined;
    switch (entry.mode) {
      case "160000":
        throw new Error(submoduleMessage(path, entry.oid));
      case "120000":
        // The symlink target *is* the blob's content, so the error tells the agent everything.
        throw new Error(symlinkMessage(path, await this.#readBlob(entry.oid, tree, path)));
      default:
        return { text: decodeBlobText(await this.#readBlob(entry.oid, tree, path), path),
                 oid: entry.oid };
    }
  }

  /**
   * The blob oid of the regular file at `path` in a commit's tree, or undefined when the path is
   * absent or names anything else (directory, symlink, gitlink). Walks only the trees along the
   * path and never reads the blob, so it answers "is this file still the content I saw?" -- by
   * comparison with a stamp from `readFileAtCommitWithOid` or `blobOid` -- at tree-walk cost.
   */
  async fileOidAtCommit(commitOid: GitOid, path: string): Promise<GitOid | undefined> {
    let { entry } = await this.#resolveEntryAt(commitOid, path);
    return entry?.mode === "100644" || entry?.mode === "100755" ? entry.oid : undefined;
  }

  /**
   * Lists one directory of a commit's tree (the root when `path` is omitted), surfacing every
   * entry with its kind per the five-mode vocabulary. Trees along the path fault in if missing;
   * blobs are never touched.
   */
  async listTreeEntries(commitOid: GitOid, path?: string): Promise<GitTreeDirEntry[]> {
    let treeOid: GitOid;
    let referencedBy: GitOid;
    if (path === undefined || path === "") {
      let commit = await this.ensureObject(commitOid, { type: "commit" });
      treeOid = parseGitCommitRefs(commit.payload, commitOid).tree;
      referencedBy = commitOid;
    } else {
      let resolved = await this.#resolveEntryAt(commitOid, path);
      if (resolved.entry === undefined || resolved.entry.mode !== "40000") {
        throw new Error(`${path}: no such directory`);
      }
      treeOid = resolved.entry.oid;
      referencedBy = resolved.tree;
    }
    let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy });
    return parseGitTree(tree.payload, treeOid).map(entry => ({
      name: entry.name,
      kind: MODE_KINDS[entry.mode],
      oid: entry.oid,
    }));
  }

  // Walks a commit's tree along `path`, returning the tree containing the final segment and
  // that segment's entry. `entry` is undefined when the path doesn't resolve -- the final
  // segment is absent, or an intermediate segment is absent or not a directory (absence takes
  // one shape so readFileAtCommitIfExists can report "no base text" uniformly).
  //
  // This is the worktree base resolver, so a miss anywhere along the walk pulls eagerly
  // (`eagerTree`): the first fault against a base commit brings the whole tree closure and
  // every small blob in one round trip -- the same shape as the worktree-creation pull --
  // rather than one gatekeeper round trip per path segment. Reads that follow hit locally.
  async #resolveEntryAt(commitOid: GitOid, path: string)
      : Promise<{ tree: GitOid, entry: GitTreeEntry | undefined }> {
    let segments = splitTreePath(path);
    let name = segments.pop()!;
    let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
    let treeOid = parseGitCommitRefs(commit.payload, commitOid).tree;
    let referencedBy = commitOid;
    for (let segment of segments) {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      let entry = parseGitTree(tree.payload, treeOid).find(e => e.name === segment);
      if (entry === undefined || entry.mode !== "40000") {
        return { tree: treeOid, entry: undefined };
      }
      referencedBy = treeOid;
      treeOid = entry.oid;
    }
    let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
    return { tree: treeOid, entry: parseGitTree(tree.payload, treeOid).find(e => e.name === name) };
  }

  /**
   * The kind and oid of the entry at `path` in a commit's tree, or undefined when the path
   * doesn't resolve. `""` names the root directory (whose oid is the root tree). Trees along the
   * walk fault in as needed; blob content is never read.
   */
  async pathEntryAtCommit(commitOid: GitOid, path: string): Promise<GitPathEntry | undefined> {
    if (path === "") {
      let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
      return { kind: "dir", oid: parseGitCommitRefs(commit.payload, commitOid).tree,
               referencedBy: commitOid };
    }
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    return entry === undefined ? undefined
        : { kind: MODE_KINDS[entry.mode], oid: entry.oid, referencedBy: tree };
  }

  /**
   * Lists a commit's tree by full path: the entries of the directory at `path` (the root when
   * omitted or `""`), each with its five-mode kind, descending into subdirectories when
   * `recursive`. Throws "no such directory" when `path` doesn't name a directory. Trees fault in
   * as needed (eagerly, like every worktree base walk); blob content is never read, so listings
   * carry no sizes.
   */
  async listCommitTreePaths(commitOid: GitOid, path?: string, options?: { recursive?: boolean })
      : Promise<GitTreePathEntry[]> {
    let scope = path ?? "";
    let root = await this.pathEntryAtCommit(commitOid, scope);
    if (root === undefined || root.kind !== "dir") {
      throw new Error(`${scope}: no such directory`);
    }
    let out: GitTreePathEntry[] = [];
    let walk = async (treeOid: GitOid, referencedBy: GitOid, prefix: string): Promise<void> => {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      for (let entry of parseGitTree(tree.payload, treeOid)) {
        let entryPath = prefix + entry.name;
        out.push({ path: entryPath, kind: MODE_KINDS[entry.mode], oid: entry.oid });
        if (options?.recursive && entry.mode === "40000") {
          await walk(entry.oid, treeOid, `${entryPath}/`);
        }
      }
    };
    await walk(root.oid, root.referencedBy, scope === "" ? "" : `${scope}/`);
    return out;
  }

  /**
   * A commit's whole tree as nested `TreeNode`s (the client-facing shape behind
   * `Overseer.listTree`): each directory's entries in `parseGitTree` order, names not paths, no
   * oids. The nested sibling of `listCommitTreePaths`: the same eager-tree walk, emitting nodes
   * instead of prefixed paths. Blob content is never read.
   */
  async readCommitTree(commitOid: GitOid): Promise<TreeNode[]> {
    let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
    let walk = async (treeOid: GitOid, referencedBy: GitOid): Promise<TreeNode[]> => {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      let nodes: TreeNode[] = [];
      for (let entry of parseGitTree(tree.payload, treeOid)) {
        let kind = MODE_KINDS[entry.mode];
        nodes.push(kind === "dir"
            ? { name: entry.name, kind, children: await walk(entry.oid, treeOid) }
            : { name: entry.name, kind });
      }
      return nodes;
    };
    return walk(parseGitCommitRefs(commit.payload, commitOid).tree, commitOid);
  }

  /**
   * The content of several files at a commit in one round trip (the read behind
   * `Overseer.readFilesAtCommit`; see its doc for the contract). Entries resolve along the
   * eager-tree walk, every missing blob is pulled in one batch (`ensureBlobs`), and the results
   * come back in request order -- stopping once the accumulated blob bytes exceed
   * READ_FILES_RESPONSE_BUDGET, so the remaining paths are simply omitted. Per-file conditions
   * become `absent`/`unreadable` entries; a pull failure throws.
   */
  async readFilesAtCommit(commitOid: GitOid, paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    let entries = new Map<string, GitPathEntry | undefined>();
    for (let path of paths) {
      if (!entries.has(path)) entries.set(path, await this.pathEntryAtCommit(commitOid, path));
    }
    // Symlink blobs are fetched too: the target *is* the blob, and it names the link in the
    // unreadable message, as every other read of a symlink does.
    let blobs: GitOid[] = [];
    for (let entry of entries.values()) {
      if (entry !== undefined && entry.kind !== "dir" && entry.kind !== "submodule") {
        blobs.push(entry.oid);
      }
    }
    let tooLarge = await this.ensureBlobs(blobs);

    let out: [path: string, FileAtCommit][] = [];
    let bytes = 0;
    for (let path of paths) {
      if (bytes > READ_FILES_RESPONSE_BUDGET) break;
      let entry = entries.get(path);
      if (entry === undefined || entry.kind === "dir") {
        out.push([path, { kind: "absent" }]);
      } else if (entry.kind === "submodule") {
        out.push([path, { kind: "unreadable", message: submoduleMessage(path, entry.oid) }]);
      } else if (tooLarge.has(entry.oid)) {
        out.push([path, { kind: "unreadable", message: tooLargeMessage(path) }]);
      } else {
        try {
          // Local by now (ensureBlobs), so this is a decode, not a fault.
          let payload = await this.#readBlob(entry.oid, entry.referencedBy, path);
          if (entry.kind === "symlink") {
            out.push([path, { kind: "unreadable", message: symlinkMessage(path, payload) }]);
          } else {
            let text = decodeBlobText(payload, path);
            bytes += payload.byteLength;
            out.push([path, { kind: "text", text }]);
          }
        } catch (err) {
          if (!(err instanceof UnreadableContentError)) throw err;
          out.push([path, { kind: "unreadable", message: err.message }]);
        }
      }
    }
    return out;
  }

  /**
   * The set of paths whose non-directory entry differs between two commits' trees (added,
   * removed, or changed in oid or mode), walking only differing subtrees and fault-pulling
   * whatever is missing. Blob content is never read. Symlink and gitlink entries are reported like files (callers render
   * them with their descriptive errors), and a name that is a file on one side and a directory
   * on the other contributes both the file path and the directory's differing contents.
   */
  async changedFilePathsBetween(aCommit: GitOid, bCommit: GitOid): Promise<Set<string>> {
    let out = new Set<string>();
    if (aCommit === bCommit) return out;
    let treeOf = async (oid: GitOid) => {
      let commit = await this.ensureObject(oid, { type: "commit", eagerTree: true });
      return parseGitCommitRefs(commit.payload, oid).tree;
    };
    await this.#diffTreesLazy(
        await treeOf(aCommit), aCommit, await treeOf(bCommit), bCommit, "", out);
    return out;
  }

  // Accumulates the differing non-directory paths of two trees (either may be absent) into
  // `out`. `aRef`/`bRef` are the referencing objects for pull hints.
  async #diffTreesLazy(aOid: GitOid | undefined, aRef: GitOid, bOid: GitOid | undefined,
                       bRef: GitOid, prefix: string, out: Set<string>): Promise<void> {
    if (aOid === bOid) return;
    let entriesOf = async (oid: GitOid | undefined, referencedBy: GitOid) => {
      if (oid === undefined) return new Map<string, GitTreeEntry>();
      let tree = await this.ensureObject(oid, { type: "tree", referencedBy, eagerTree: true });
      return new Map(parseGitTree(tree.payload, oid).map(entry => [entry.name, entry]));
    };
    let aEntries = await entriesOf(aOid, aRef);
    let bEntries = await entriesOf(bOid, bRef);
    for (let name of new Set([...aEntries.keys(), ...bEntries.keys()])) {
      let a = aEntries.get(name);
      let b = bEntries.get(name);
      if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
      let path = prefix + name;
      let aDir = a?.mode === "40000";
      let bDir = b?.mode === "40000";
      if (aDir || bDir) {
        // Descend the tree side(s); a non-tree entry opposite a tree is one more difference.
        await this.#diffTreesLazy(aDir ? a!.oid : undefined, aOid ?? aRef,
                                  bDir ? b!.oid : undefined, bOid ?? bRef, `${path}/`, out);
        if ((a !== undefined && !aDir) || (b !== undefined && !bDir)) out.add(path);
      } else {
        out.add(path);
      }
    }
  }

  /**
   * Enforces the write side of the tree-entry modes decision on a worktree path: writing over a
   * symlink or submodule (gitlink) throws the same descriptive error reading one does, and a
   * path naming a base *directory* throws too -- a write there could never commit (git trees
   * cannot hold a file and a directory of one name; writeChangedFilesAsCommit rejects the
   * shape), so failing at the write keeps the error next to its cause instead of surfacing at
   * a far-away commit or accept. An absent path (a new file) and a regular file of either mode
   * pass -- including files whose *content* is unreadable (oversized/binary), since a
   * whole-file write is coherent against any base. Base entries only: a conflicting shape the
   * overlay itself creates (`set a/b` then `set a`) is caught by commit-time tree building,
   * the backstop for everything this write-time check can't see.
   */
  async assertWorktreePathWritable(commitOid: GitOid, path: string): Promise<void> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry?.mode === "120000") {
      // The target is the blob's content; the message tells the agent everything (same as reads).
      throw new Error(symlinkMessage(path, await this.#readBlob(entry.oid, tree, path)));
    }
    if (entry?.mode === "160000") {
      throw new Error(submoduleMessage(path, entry.oid));
    }
    if (entry?.mode === "40000") {
      throw new Error(`${path} is a directory`);
    }
  }

  /**
   * Resolves a commit id -- exactly 40 lowercase hex digits, as git itself emits them -- against
   * *local knowledge only*: the object store plus the metadata rows written by gatekeepers' puts
   * and advertisements. Never a remote lookup. Returns the oid without pulling anything; the
   * caller decides whether to fetch.
   *
   * Abbreviated ids are deliberately not accepted: knowing a commit's id is the capability to
   * read the commit, and a short prefix is guessable. (Remote truncated-id resolution, where a
   * human supplied one, is a gatekeeper API, e.g. GitHub's getCommit, which returns and
   * advertises the full oid.)
   *
   * Errors are agent-readable: a malformed id, an unknown commit ("look it up via the connection
   * first"), and a locally-present non-commit. An id known only from metadata resolves regardless
   * of its recorded type (the reader rule: an assertion-grade non-commit tag must not refuse the
   * operation without pulling, so the caller's pull lets the decoded bytes decide).
   */
  resolveCommitId(id: string): GitOid {
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new Error(
          `${JSON.stringify(id)} is not a full git commit id: expected 40 lowercase hex digits.`);
    }
    let local = this.readLocalObject(id);
    if (local !== undefined) {
      if (local.type !== "commit") {
        throw new Error(`${id} is a ${local.type}, not a commit.`);
      }
      return id;
    }
    if (this.storage.gitObjectMetadata.get(id) === undefined) {
      throw new Error(
          `Commit ${id} is not known to this workspace. Look it up through the connection that ` +
          `provides the repository first (e.g. its commit or branch APIs), which makes it ` +
          `available here.`);
    }
    return id;
  }

  /**
   * Resolves a commit id (see resolveCommitId) to a commit a worktree can be rooted at.
   * When the commit is absent locally but a gatekeeper is recorded as a source, performs the
   * *initial pull* -- one fetch for the commit, its full tree structure, and every blob under
   * EAGER_BLOB_LIMIT -- so ordinary reads never fault. Any locally-present commit works with no
   * gatekeeper at all (a gadget's history, another worktree's commit).
   */
  async fetchCommit(commitId: string): Promise<GitOid> {
    let commit = this.resolveCommitId(commitId);
    if (!this.hasLocalObject(commit)) {
      // Known only from gatekeeper metadata: pull eagerly. (A locally-present commit skips this;
      // any of its tree/blob objects missing locally fault in lazily on first read.)
      await this.ensureGitObjects([commit], {
        type: "commit",
        commitHistory: { kind: "depth", depth: 1 },
        filterBlobSize: EAGER_BLOB_LIMIT,
      });
    }
    let local = this.readLocalObject(commit);
    if (local === undefined) {
      // ensureGitObjects throws on failure; defensive backstop.
      throw new Error(`Commit ${commit} could not be fetched.`);
    }
    if (local.type !== "commit") {
      // The reader rule let an assertion-grade metadata row through resolveCommitId; the pulled
      // bytes have now decided.
      throw new Error(`${commit} is a ${local.type}, not a commit.`);
    }
    return commit;
  }

  /**
   * Reads a blob as UTF-8 text under the file-content rules every worktree read applies --
   * UnreadableContentError, path-flavored, for oversized or binary content -- fault-pulling the
   * blob on a miss (`referencedBy` shapes the pull hints; `path` names the file in errors).
   * For batch callers (grep) that ensured the blobs beforehand -- and for re-reading a blob an
   * earlier read already pulled, where no referencing object is known -- this is a local read.
   */
  async readTextBlob(oid: GitOid, referencedBy: GitOid | undefined, path: string)
      : Promise<string> {
    return decodeBlobText(await this.#readBlob(oid, referencedBy, path), path);
  }

  /**
   * Ensures a batch of blobs is locally present in one pull (retried minus each blob that
   * proves oversized), for readers that then decode them locally (`readTextBlob`/`#readBlob`
   * on a present blob never faults). Returns the oids that could not be obtained because they
   * exceed MAX_GIT_OBJECT_SIZE -- measured, or omitted by the pull's own blob filter -- so the
   * caller can report each affected path instead of failing the batch. Every other failure
   * throws. Never a serial walk-and-fetch: this is the reason batch readers gather their oids
   * first.
   */
  async ensureBlobs(oids: Iterable<GitOid>): Promise<Set<GitOid>> {
    let missing = new Set([...oids].filter(oid => !this.hasLocalObject(oid)));
    let tooLarge = new Set<GitOid>();
    while (missing.size > 0) {
      try {
        await this.ensureGitObjects([...missing], this.exactObjectHints("blob"));
        break;
      } catch (err) {
        if (err instanceof GitObjectTooLargeError && missing.has(err.oid)) {
          tooLarge.add(err.oid);
          missing.delete(err.oid);
          continue;  // retry the rest of the batch (already-pulled blobs are skipped)
        }
        throw err;
      }
    }
    return tooLarge;
  }

  // Reads a blob for a file path, translating unavailable-at-size into the path-specific error.
  // A blob the store holds is returned whatever its size: size limits apply only to what is
  // brought in (see MAX_GIT_OBJECT_SIZE), never to reading what was stored.
  async #readBlob(oid: GitOid, referencedBy: GitOid | undefined, path: string)
      : Promise<Uint8Array> {
    let blob: PackableObject;
    try {
      blob = await this.ensureObject(oid, { type: "blob", referencedBy });
    } catch (err) {
      if (err instanceof GitObjectTooLargeError) {
        throw new UnreadableContentError(tooLargeMessage(path), { cause: err });
      }
      throw err;
    }
    return blob.payload;
  }
}

// =======================================================================================
// Small helpers

// The path-flavored descriptions of the three entry shapes that have no readable text. Shared
// by the throwing reads (the message is the error) and readFilesAtCommit (it is the
// `unreadable` entry), so both surfaces say the same thing.
function symlinkMessage(path: string, target: Uint8Array): string {
  return `${path} is a symlink to ${new TextDecoder().decode(target)}`;
}

function submoduleMessage(path: string, target: GitOid): string {
  return `${path} is a submodule (gitlink) pointing at commit ${target}`;
}

function tooLargeMessage(path: string): string {
  return `${path} is too large to read (over ${MAX_GIT_OBJECT_SIZE} bytes)`;
}
/** Decode a Git blob payload as strict text. */
export function decodeBlobText(payload: Uint8Array, path: string): string {
  if (payload.includes(0)) throw new UnreadableContentError(`${path} is not a text file`);
  try {
    return TEXT_DECODER_STRICT.decode(payload);
  } catch {
    throw new UnreadableContentError(`${path} is not a text file`);
  }
}
// Splits and validates a file path against the same shape rules git-store enforces on writes:
// no empty segments, no "." or "..".
function splitTreePath(path: string): string[] {
  let segments = path.split("/");
  for (let segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`invalid file path: ${path}`);
    }
  }
  return segments;
}
