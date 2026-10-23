import { WorkpieceId, CodeChangeSubmission, CollaboratorRole, SlashCommandRequest } from "@gadgets/workshop-shared/api";
import { Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { BindingRecord, ExternalMessageRecord } from "./storage-schema/overseer-storage";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";

export const AGENT_RUNNING_ERROR_MESSAGE = "Agent is running, wait for it to finish.";

// Per-chat in-memory state, used while an agent is running.
/** Split out of the former overseer.ts (internal helper). */
export type LiveChatContext = {
  /** Abort controller for the running agent. */
  cancelController: AbortController;
};

/** Split out of the former overseer.ts (internal helper). */
export type PreparedChatMessage = {
  slashCommand?: SlashCommandRequest;
  message?: string;
  skillName?: string;
};

/** Split out of the former overseer.ts (internal helper). */
export type PreparedScratchWorktree = {
  commitId: string;
  bindingName: string;
};

// getAgentCatalog is optional on Gatekeeper; ambient capsules always implement it. After confirming
// the gatekeeper is an ambient capsule, we view its facet through this derived (Pick + Required)
// shape to call it — same optional-method-on-a-stub pattern as user.ts's SingletonAccountStub.
/** Split out of the former overseer.ts (internal helper). */
export type CatalogGatekeeperFacet =
    Fetcher<Gatekeeper<any> & Required<Pick<Gatekeeper<any>, "getAgentCatalog">>>;

/** Split out of the former overseer.ts (internal helper). */
export type ExternalMessageResponseTargetRegistration = {
  idempotencyKey: string;
  chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
};

/** Split out of the former overseer.ts (internal helper). */
export type ExternalMessageResponseTargetRegistrationDecision =
  | {
      reuseExisting: false;
    }
  | {
      reuseExisting: true;
      record: ExternalMessageRecord;
    };

/** Split out of the former overseer.ts (internal helper). */
export type ExternalMessageSubmitInput = {
  callerEmail: string;
  externalChatKey: string;
  idempotencyKey: string;
  prompt: string;
  chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
  title: string;
};

// The binding edges one record holds -- a gadget's, or an agent spawner's -- and how to write
// them back. `save(true)` also reloads a gadget, whose running env the edges are; a spawner
// needs no reload, since each spawn reads its bindings afresh.
/** Split out of the former overseer.ts (internal helper). */
export type BindingHolder = {
  id: WorkpieceId;
  bindings: Record<string, BindingRecord>;
  save(reload?: boolean): void;
};

// Throws unless `name` is free for a new edge in `bindings`, proposed in `chatId` if given. A
// pending edge is invisible to other chats for reads but still occupies its name for writes:
// allowing a second proposal under the same name would mean accepting both silently overwrites
// one with the other.
/** Split out of the former overseer.ts (internal helper). */
export function assertBindingNameFree(
    bindings: Record<string, BindingRecord>, name: string, chatId?: number): void {
  let existing = bindings[name];
  if (existing?.pending && existing.pending.chatId !== chatId) {
    throw new Error(`The binding name "${name}" is already proposed by another chat. ` +
        `Accept or revert that chat's changes first, or choose a different name.`);
  }
  if (existing) throw new Error(`There is already a binding named "${name}".`);
}

// If live change rows exist whose newest author differs from a new submission's author and the
// stream has been idle this long, the older author's rows are materialized into their own
// "changes" message first, keeping attribution per author (see submitCodeChange).
/** Split out of the former overseer.ts (internal helper). */
export const CHAT_CHANGE_AUTHOR_SPLIT_MS = 60_000;

// Materialize the live row window into a "changes" message once it grows past this many rows,
// so a long editing session can't grow the window (and its subscribe-replay cost) without bound.
// The job is compacting keystroke-granularity ops into few large composed ops -- rows arrive
// per edit burst, so this is sized in "a screenful of typing", not lines. Byte growth is
// bounded separately (MAX_CODE_CHANGE_SIZE, enforced at row-append time). Thanks to the
// retired-row grace window this stales nobody: a submission based inside the materialized range
// still transforms over the retired rows.
/** Split out of the former overseer.ts (internal helper). */
export const CHAT_CHANGE_MATERIALIZE_THRESHOLD = 1000;

// How long retired rows are kept as a transform window before lazy expiry. Late submissions are
// in-flight-RTT scale, so a minute is generous; a submission whose base has aged out is rejected
// (the client discards and rebuilds).
/** Split out of the former overseer.ts (internal helper). */
export const CHAT_CHANGE_RETIRED_TTL_MS = 60_000;

// The shape a CodeChangeSubmission.clientId must take. Deliberately strict: the token is
// client-minted (a UUID satisfies this), becomes part of a storage key, and needs no other
// structure.
/** Split out of the former overseer.ts (internal helper). */
export const CHAT_CHANGE_CLIENT_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/** Split out of the former overseer.ts (internal helper). */
export const AGENT_RESPONSE_DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1000;

// How long after agent work becomes outstanding (a turn starts, or a call to a callable agent is
// recorded) the keep-alive alarm fires. See #agentKeepAliveTime.
/** Split out of the former overseer.ts (internal helper). */
export const AGENT_KEEPALIVE_ALARM_MS = 60_000;

// The platform retries a failed alarm six times. Other durable work must remain scheduled after
// that budget is exhausted; model-lookup retries have their own per-execution budget below.
/** Split out of the former overseer.ts (internal helper). */
export const ALARM_MAX_RETRIES = 6;

/** Split out of the former overseer.ts (internal helper). */
export const AGENT_RESUME_MAX_ATTEMPTS = 4;

// How old a workspace instance must be before a loop-limit rejection restarts it. See
// OverseerImpl.restartIfLoopLimited.
/** Split out of the former overseer.ts (internal helper). */
export const LOOP_LIMIT_RESTART_MIN_AGE_MS = 60_000;

// The error an accept throws when writing a workpiece's commit fails (most likely because
// storage refused a file too large to hold, which the git store's error names), prefixed with
// the workpiece as the user knows it. An accept writes its objects before it moves anything, so
// the chat keeps its changes and can be accepted again once the cause is fixed.
/** Split out of the former overseer.ts (internal helper). */
export function acceptWriteError(workpiece: string, err: unknown): Error {
  return new Error(`Cannot accept changes to ${workpiece}: ${stringifyError(err)}`, {cause: err});
}

// Safely convert an unknown thrown value to a human-readable string.
// Plain objects would otherwise render as "[object Object]".
/** Split out of the former overseer.ts (internal helper). */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Compute a unique value to use as session affinity for a chat thread. Workers AI in particular
// wants a session affinity value to enable prompt caching. (But we compute it regardless of
// provider since other providers might want it too.)
/** Split out of the former overseer.ts (internal helper). */
export async function computeSessionAffinity(gadgetId: string, chatId: number): Promise<string> {
  // Hex prefix for hash personalization.
  let input = new TextEncoder().encode(`e26339049e055b01:${gadgetId}:${chatId}`);
  let hash = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(hash).toHex();
}

// The rejection for a code-change submission whose claimed base cannot be reached from the chat's
// current stream: a destructively-closed generation, a transform window that has aged out, or a
// bridge-ineligible gadget. Final for the client's local state: it must discard its local edits
// and rebuild from fresh metadata (see Overseer.submitCodeChange).
/** Split out of the former overseer.ts (internal helper). */
export function chatStreamGoneError(): Error {
  return new Error("The chat's code base changed (its changes were merged, reverted, or " +
      "discarded) and this edit cannot be carried across; rebuild from fresh metadata.");
}

// Digest of a submission's content, stored on the per-client dedupe record so a same-seq retry
// can be verified byte-for-byte (see ChatChangeClientRecord.digest). Covers everything that affects
// what the change does; a conforming retry resends the identical payload, so its serialization --
// and hence the digest -- matches.
/** Split out of the former overseer.ts (internal helper). */
export async function submissionDigest(submission: CodeChangeSubmission): Promise<string> {
  let bytes = new TextEncoder().encode(JSON.stringify({
    generation: submission.generation,
    revision: submission.revision,
    pins: submission.pins ?? [],
    change: submission.change,
  }));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

// Validates a client-supplied commit oid before it reaches the git store.
/** Split out of the former overseer.ts (internal helper). */
export function validateOid(oid: string): string {
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error("Invalid commit id.");
  }
  return oid;
}

// How many affected collaborator listings to refresh at once after a sharing change.
/** Split out of the former overseer.ts (internal helper). */
export const LISTING_REFRESH_BATCH = 16;

/** Params sealed into persistent stubs that restore to a gadget or gatekeeper facet. */
export type OverseerRestoreParams = {
  /** This is a stub pointing at the gadget. [restore]() will return the facet stub. */
  type: "gadget";

  /**
   * Which gadget to restore to. Optional, resolving to `defaultGadgetId` when absent: instances
   * recorded before multi-gadget support are persisted in the wild, sealed inside hook callback
   * stubs where a migration cannot rewrite them. If absent and the workspace has no default
   * gadget (or the default gadget was deleted), restoration fails with an explicit error.
   */
  gadgetId?: WorkpieceId;

  /**
   * Present when the stub was minted to run the gadget with this chat's proposed changes
   * (getGadgetFacetFetcher only sets it once #resolveGadgetChatId has confirmed the chat really
   * does propose changes to the gadget). Because the gadget's own ctx.restore() chains off the
   * stub it was called through, a persistent stub minted by the proposed version carries this
   * too, and so keeps restoring to that version for as long as the chat still proposes changes
   * to the gadget -- the code that created the stub is the code that knows what to do with it.
   * Once the chat is committed, discarded or deleted, the same params resolve to main.
   */
  chatId?: number;

  /**
   * A hack: If present, and if the code injection table currently contains this ID, then
   * instead of returning the gadget stub, [restore]() loads a dynamic worker.
   *
   * This is a super-tricky hack used by forgeRestoreStubForBinding(): to forge a persistent stub
   * targeting a gadget's [restore]() method, we put the tiny "forger" worker's code into the
   * table under `codeId`, call ctx.restore() with `codeId` (loading the forger), then clear the
   * ID from the table. When the forger then calls ctx.restore(P) on our behalf, the resulting
   * stub is persisted with these params as its self-token -- which, `codeId` no longer matching,
   * now restores through the gadget's [restore]() method.
   */
  codeId?: string;
} | {
  /**
   * A stub pointing at a gatekeeper (connection) facet, minted by getGatekeeperFacet(). Like a
   * gadget's, the gatekeeper's own ctx.restore() chains off it, so the persistent stubs it mints
   * to itself stop restoring once the connection is removed.
   */
  type: "gatekeeper";
  gatekeeperId: WorkpieceId;
};

// What kind of capability an open session holds, for OverseerImpl.joinSession(). The owner's
// session is a "build" capability but never an observer's, so it is counted apart from the
// collaborator roles.
/** Split out of the former overseer.ts (internal helper). */
export type SessionKind = CollaboratorRole | "owner";
