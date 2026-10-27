// Workspace sharing vocabulary: the observer-binding grammar a blueprint's gadgets may need
// (ObserverBindingNeed and friends, consumed by Overseer.listObserverRequirements), and the
// collaboration surface -- collaborators, presence, permission edges, and share links.
// Re-exported from api.ts, the single import surface of the API.


import type { WorkpieceId } from "./api.js";
import type { AiChatAuthorInfo } from "./chat.js";
import type { RpcTarget } from "capnweb";
/**
 * Why a previously-configured observer binding failed verification on this open attempt. Attached to
 * the ObserverBindingNeed the overseer re-prompts with, so the client can explain what went wrong
 * instead of dead-ending the open.
 */
export type ObserverBindingFailure = {
  /**
   * The account that was tried and rejected (a ConnectedAccountRecord id in the opening user's own
   * User DO). Re-authenticating it in place is usually the fix, so the client should pre-select it
   * and aim its re-authenticate affordance at it. May no longer exist, if the user disconnected it.
   */
  accountId: number;
  /**
   * Human-readable explanation for display: either the error the gatekeeper threw when it refused
   * the account, or a message the overseer authored itself for a cause it can see directly (e.g.
   * the chosen account is no longer connected). Free text: MUST NOT be parsed or matched on.
   */
  reason: string;
};

/**
 * Describes one connection a non-owner must verify using one of their own accounts. Passed to
 * ObserverConfigCallback.configure() when the opening user needs to choose an account; its result
 * echoes `gatekeeperId` in an ObserverAccountChoice.
 */
export type ObserverBindingNeed = {
  /** The overseer-assigned gatekeeper id (a workpiece id). */
  gatekeeperId: WorkpieceId;
  /**
   * The vendor the user must have a connected account for (e.g. "google"). The frontend filters
   * the user's connected accounts by this to find candidates.
   */
  vendorId: string;
  /** Human-readable resource title, for display in the configuration modal. */
  resourceTitle: string;
  /** Canonical resource URL, if known, for display. */
  resourceUrl?: string;
  /**
   * Set only when this binding was already configured but its chosen account failed verification on
   * this attempt (expired credentials, a revoked grant, an upstream outage, or a genuine denial).
   * Absent for a binding that has simply never been configured. Deliberately carries no
   * "credentials valid" flag: the client already has that live from subscribeConnectedAccounts, and
   * a copy on the wire would go stale while the modal is open across an OAuth round trip.
   */
  failure?: ObserverBindingFailure;
};

/**
 * The opening user's chosen account for a single gatekeeper binding. Returned from
 * ObserverConfigCallback.configure().
 */
export type ObserverAccountChoice = {
  /** Matches the ObserverBindingNeed.gatekeeperId being satisfied. */
  gatekeeperId: WorkpieceId;
  /** An account in the opening user's own User DO (a ConnectedAccountRecord id). */
  accountId: number;
};

/**
 * Provided by the client when opening a gadget. Invoked by the overseer ONLY if the opening user
 * must choose connected accounts for one or more gatekeeper bindings before they can observe the
 * gadget. In the common case (owner, or an already-configured observer) this is never called and
 * open() resolves without an extra round trip. The overseer does not resolve open() until this
 * returns. If the user cannot or will not provide the needed accounts, the callback should reject,
 * and the overseer denies the open.
 *
 * `configure()` may be called a second time within one open, for the subset of bindings that failed
 * verification (each carrying an ObserverBindingNeed.failure). This lets the user repair a binding --
 * typically by re-authenticating the account whose credentials expired -- without leaving the flow.
 * The overseer bounds the number of such re-prompts, so a client that resubmits an account that
 * keeps failing eventually gets a denial rather than an endless loop.
 */
export interface ObserverConfigCallback extends RpcTarget {
  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]>;
}

/**
 * The level of access a collaborator (or share key) grants.
 *
 * - "build": full access -- edit code, use and participate in chats, manage bindings, etc. (the
 *   same access the owner has, modulo the owner-only exceptions documented in sharing.md).
 * - "use": may only render, interact with, and export the gadget's deployed UI (getUiBundle(),
 *   connectToGadget(), getExportFormats(), and export()), plus read basic metadata.
 *
 * Roles are ordered build > use. A collaborator's effective role is the maximum role reachable
 * from the owner through their valid permission edges, where each edge grants
 * min(edge role, sharer's effective role). The owner is the implicit root at "build".
 */
export type CollaboratorRole = "build" | "use";

/** One person currently connected to a gadget. */
export type PresenceParticipant = {
  /** Opaque key matching this participant across add/remove events. */
  key: string;
  user: AiChatAuthorInfo;
  role: CollaboratorRole;
};

/**
 * `init` delivers the full roster once on subscribe.
 * `add`/`remove` (keyed by `key`) report changes thereafter.
 */
export interface PresenceSubscriber {
  init(participants: PresenceParticipant[]): void;
  add(participant: PresenceParticipant): void;
  remove(key: string): void;
}

/** Describes how one user came to have collaborator access. */
export type PermissionEdge = {
  created: Date;

  /**
   * The role granted by this edge. Absent on edges created before roles were introduced; such
   * edges are treated as "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
} & ({
  /** Granted directly by another user. */
  type: "user";
  sharer: string;  // profile.id of the person who shared
  note?: string;
} | {
  /** Gained by redeeming a share key. */
  type: "shareKey";

  /**
   * The id of the share link that was redeemed (the hash of its first key). Every key of the link
   * resolves to this id, so redeeming any of them yields this one edge.
   */
  keyId: string;
});

/** Information about a single collaborator, returned by list/add operations. */
export type CollaboratorInfo = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  /**
   * The collaborator's effective role (the maximum role reachable from the owner). Absent implies
   * "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
};

/**
 * Describes a collaborator whose access would change (or did change) as a result of a removal or
 * share key revocation. Used by the preview/confirm flow, which must surface not only users who
 * lose access entirely but also users who would be downgraded to a lower role.
 */
export type AffectedCollaborator = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  /** The effective role before the change. */
  oldRole: CollaboratorRole;

  /** The effective role after the change, or null if the user loses access entirely. */
  newRole: CollaboratorRole | null;
};

/**
 * Information about a share link, for the management UI. Each link may have one or more keys.
 * When users "copy" an existing link, they are getting a new key.
 */
export type ShareLinkInfo = {
  linkId: string;
  note?: string;
  created: Date;
  createdBy: AiChatAuthorInfo;

  /**
   * The role granted to anyone who redeems this link. Absent implies "build" for links created
   * before roles were introduced.
   */
  role?: CollaboratorRole;
};
