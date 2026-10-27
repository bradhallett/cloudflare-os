// The blueprint vocabulary: screenshot upload paths and helpers, blueprint metadata and
// the public/library projections, sources, per-user summaries, and binding assignments.
// Also home of BlueprintApiMethods, the blueprint methods of AuthenticatedApi.
// Re-exported from api.ts, the single import surface of the API.


import type { AiChatAuthorInfo } from "./chat.js";
import type { Overseer } from "./overseer.js";
import type { BlueprintBinding } from "./workpieces.js";
import type { BlueprintOutput } from "./workspace.js";
import type { RpcStub } from "capnweb";
export type BlueprintScreenshotUpload = {
  mimeType: "image/jpeg" | "image/png";
  content: Uint8Array;
};

export const BLUEPRINT_SCREENSHOT_R2_PREFIX = 'screenshots/';
export const BLUEPRINT_SCREENSHOT_PATH_PREFIX = '/blueprint-screenshot/';

export function blueprintScreenshotUrl(id: string, metadata: { screenshot?: true, lastUpdated: Date }): string | undefined {
  return metadata.screenshot ?
      `${BLUEPRINT_SCREENSHOT_PATH_PREFIX}${id}?v=${metadata.lastUpdated.valueOf()}` : undefined;
}

/**
 * General metadata about a blueprint. Stored (in slightly different wrapper records) in
 * three locations: Gadget DO, User DO, and KV.
 */
export type BlueprintMetadata = {
  title: string;
  description: string;  // longer-form description of what the blueprint does
  author: AiChatAuthorInfo;
  created: Date;

  version: number;       // increments every time the blueprint is updated
  lastUpdated: Date;

  /**
   * The git commit this version of the blueprint is: its *release commit*, whose tree holds the
   * blueprint's files. The blueprint's content is a packfile of that commit.
   *
   * Absent on a blueprint stored before releases were commits, whose content is a snapshot of
   * its files alone.
   */
  commitId?: string;

  /**
   * If present, a screenshot is stored separately from the metadata. The server uses this
   * to decide when to include a derived screenshotUrl.
   */
  screenshot?: true;

  /**
   * What instantiating this blueprint produces. Absent means a generic app. Inherited by gadgets
   * created from this blueprint, and preserved when such a gadget is republished as a blueprint.
   */
  output?: BlueprintOutput;

  /** Key = binding name. */
  bindings: Record<string, BlueprintBinding>;
};

/** Public view (returned by PublicApi.getBlueprint). */
export type BlueprintPublicInfo = {
  id: string;
  metadata: BlueprintMetadata;

  /** If present, browser-loadable URL for the public screenshot. */
  screenshotUrl?: string;
};

/** Gadget-side summary (returned by Overseer.listBlueprints). */
export type BlueprintGadgetSummary = {
  id: string;
  title: string;
  description: string;
  version: number;
  codeVersionDate: Date;  // timestamp of the exported code version
  screenshotUrl?: string;
  dirty?: boolean;        // true if last publish failed and needs retry
  deleting?: true;        // present if the blueprint's deletion failed partway; retry the delete

  /**
   * Present if the gadget the blueprint is published from has committed files other than the
   * ones the blueprint last published: Overseer.updateBlueprint() with `updateCode` would
   * publish them. It goes by the files alone, so a gadget whose history has moved on but whose
   * files are back as they were published has none.
   */
  unpublishedChanges?: true;
};

/**
 * Where a blueprint the user owns came from. This distinguishes the case the UI cares about — the
 * source workspace still exists, so it can be opened and it owns deletion of the blueprint — from
 * the two cases where it does not, so no caller has to infer that from display text. `workspaceId`
 * is reachable only in the case where opening it is meaningful.
 */
export type BlueprintSource =
    // Published from a workspace that still exists. `workspaceTitle` is its current title.
    { type: "workspace"; workspaceId: string; workspaceTitle: string }
    // Published from a workspace that has since been deleted.
  | { type: "deletedWorkspace" }
    // Added to the user's library rather than published from one of their workspaces.
  | { type: "imported" };

/** User-side summary (returned by AuthenticatedApi.listOwnBlueprints and getOwnBlueprint). */
export type BlueprintUserSummary = {
  id: string;
  title: string;
  description: string;
  /** Where this blueprint came from, and whether that origin is still openable. */
  source: BlueprintSource;
  version: number;
  lastUpdated: Date;
  pinned?: boolean;
};

/** User-side library summary (returned by AuthenticatedApi.listLibraryBlueprints). */
export type BlueprintLibrarySummary = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
  pinned?: boolean;
};

/**
 * Binding assignment (input to newGadgetFromBlueprint).
 * When instantiating a blueprint, the user provides a Record mapping binding name ->
 * assignment. Every required binding in the blueprint must have a corresponding entry.
 */
export type BlueprintBindingAssignment = {
  type: "gatekeeper";
  accountId: number;      // user's connected account ID
  resourceUrl: string;
} | {
  type: "aiModel";
  modelId: string;        // one of the user's configured models
} | {
  type: "agentSpawner";
  modelId: string | null; // model to run, or null for no agent
};

/**
 * The blueprint methods of AuthenticatedApi: the signed-in user's own blueprints, the
 * library, featured listings, pinning, and the creation/import paths that make a gadget
 * from a blueprint. Split out of the session core so the blueprint vocabulary and its
 * methods live in one module.
 */
export interface BlueprintApiMethods {
  /**
   * List all blueprints created by the current user (from User DO). Useful for an audit
   * view in Settings.
   */
  listOwnBlueprints(): Promise<BlueprintUserSummary[]>;

  /** Return a blueprint created by the current user, or null if it is not owned by this user. */
  getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null>;

  /**
   * List the blueprints currently in the user's library. This includes uploaded `.gadget`
   * archives (stored locally) and blueprints saved by reference from other publishers.
   */
  listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]>;

  /**
   * Pin a blueprint for quick reuse on the home page. Pinning a public blueprint that isn't
   * already yours or in your library saves it to your library first.
   */
  setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void>;

  /** Returns whether the blueprint is pinned by the current user. */
  isBlueprintPinned(blueprintId: string): Promise<boolean>;

  /**
   * List the deployment-wide featured blueprints. This is served from a KV snapshot rather
   * than directly from the AdminSettings durable object.
   */
  listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]>;

  /**
   * Add a blueprint to the user's library by reference, caching the current public metadata
   * snapshot for list rendering.
   */
  addBlueprintToLibrary(blueprintId: string): Promise<void>;

  /**
   * Remove a blueprint from the user's library. If the library entry was uploaded by the
   * current user, this also deletes the backing blueprint content from storage.
   */
  removeBlueprintFromLibrary(blueprintId: string): Promise<void>;

  /**
   * Returns info about whether the blueprint is in the user's library.
   * Returns null if not in library, or { uploaded } if it is.
   */
  isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null>;

  /**
   * Create a new gadget from a blueprint. Reads the blueprint from KV, downloads code from
   * R2, creates a new Overseer DO, initializes it with the blueprint's code, and creates
   * gatekeepers from the provided binding assignments.
   *
   * Every required binding in the blueprint must have a corresponding entry in `bindings`,
   * keyed by binding name. Throws if any are missing or if accountId/modelId are invalid.
   *
   * The returned Overseer can be used immediately (pipelining-friendly).
   */
  newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>>;

  /**
   * Delete a blueprint that the user owns. Works even if the source gadget has been deleted
   * (operates on User DO + KV directly).
   */
  deleteOrphanedBlueprint(blueprintId: string): Promise<void>;

  /**
   * Import a `.gadget` archive from another Workshop instance. The imported blueprint is stored
   * as a local blueprint owned by the current user.
   */
  importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string>;
}
