// The SessionContext every session/capability object carries (credentials, approval queue,
// auth-error latch) plus the callApi/callWs helpers that ride it.

import { RpcStub } from "cloudflare:workers";
import { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  HomeAssistantError,
  HomeAssistantRest,
  HomeAssistantWebSocket,
  withWebSocket,
  type HomeAssistantCredentials,
  type RegistrySnapshot,
} from "./homeassistant-api";

import { HomeAssistantAction } from "./ha-gatekeeper";
import { SubmitWriteBody } from "./ha-validate";

// ---------------------------------------------------------------------------
// Session context shared by all session/capability objects

export interface SessionContext {
  creds: HomeAssistantCredentials;
  approvalQueue: RpcStub<ApprovalQueue>;
  noteAuthError: () => Promise<void>;

  /** Dispose the dup'd approvalQueue RpcStub held in this context. Idempotent: safe to call
   * more than once. The corresponding Session/capability calls this from its `[Symbol.dispose]`
   * to release the server-side stub when the session is no longer needed. */
  dispose(): void;

  /** Create a fork of this context with its own freshly-`dup()`'d approvalQueue, suitable for
   * passing to a child Session/capability (e.g. the EntityImpl returned by AreaImpl.getEntity).
   * The fork's `dispose()` is independent: disposing the child does NOT dispose the parent.
   * Use this whenever a parent capability hands out a sub-capability that lives independently. */
  fork(): SessionContext;

  /** Submit a side-effecting action to the approval queue. Stores a pending row in DO storage
   * and awaits the approval queue. The action body is enriched with a fresh `id`. */
  submitWrite(body: SubmitWriteBody): Promise<void>;

  /** Fetch a fresh registry snapshot (no caching yet). Used both to enrich action descriptions
   * and to power simulation overlays. */
  registrySnapshot(): Promise<RegistrySnapshot>;

  /** Return the current set of pending (submitted-but-not-yet-applied) actions for this
   * gatekeeper, in chronological (submit) order. Used by reads to overlay simulated state on
   * top of real HA state. Synchronous: pending rows live in DO storage's KV. */
  listPendingActions(): HomeAssistantAction[];

  /** Fetch a registry snapshot AND apply pending-action overlays to its `states` map. Returns
   * the per-entity count of pending changes applied (the sum across all entities). Used by
   * read methods that derive from the states map (listEntities, describe, etc.) so simulation
   * is consistent regardless of which path the read takes. */
  registrySnapshotWithOverlay(): Promise<{ snapshot: RegistrySnapshot; appliedCount: number }>;
}

export async function callApi<T>(ctx: SessionContext, fn: (rest: HomeAssistantRest) => Promise<T>): Promise<T> {
  const rest = new HomeAssistantRest(ctx.creds);
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof HomeAssistantError && e.isAuthError) {
      await ctx.noteAuthError();
    }
    throw e;
  }
}

export async function callWs<T>(ctx: SessionContext, fn: (ws: HomeAssistantWebSocket) => Promise<T>): Promise<T> {
  try {
    return await withWebSocket(ctx.creds, fn);
  } catch (e) {
    if (e instanceof HomeAssistantError && e.isAuthError) {
      await ctx.noteAuthError();
    }
    throw e;
  }
}
