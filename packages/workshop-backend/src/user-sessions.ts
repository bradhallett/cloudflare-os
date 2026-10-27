// The session half of the user Durable Object (user.ts): password and Cloudflare Access
// authentication, session tokens and their records, the native device-session handoff, account
// creation, and deprovisioning (which closes everything that outlives a session). The DO keeps
// its RPC surface as thin delegators (the user-bots.ts pattern) and owns what spans concerns:
// the expiry alarm and the gatekeeper user-selection tickets.

import {AUTH_ERROR_CODES, createAuthError, type DeviceSessionHandoffStart} from '@gadgets/workshop-shared/api';
import {
  DEVICE_HANDOFF_LIFETIME_MS, isDeviceHandoffState, sealDeviceSessionHandoff,
  type DeviceSessionCredential, type DeviceSessionHandoff,
} from "./auth/device-session-handoff.js";
import { hashPresentedSecret, hashSecret, newSecretToken } from "./connect-handoff.js";
import { type LoginSessionRecord, type PendingDeviceHandoffRecord, type UserStorage} from "./storage-schema/user-storage.js";
import { recordAnalytics } from "./analytics";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.user");

/** Server-enforced lifetime of a Workshop session issued to a native device. */
export const DEVICE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

/** What the session store needs from its owning DO: directory sync after auth, and the alarm. */
export type UserSessionDeps = {
  /** Mirrors the user into the deployment-wide directory after a successful authentication. */
  syncDirectory(): void;
  /** Re-arms the DO's expiry sweep after a record that expires is stored or removed. */
  armExpirySweep(): Promise<void>;
};

/**
 * The user's authentication and session state: password and Cloudflare Access sign-in, account
 * creation, session records, the native device-session handoff, and deprovisioning. Sessions are
 * validated per request with no cache, so a deleted record fails on the caller's very next
 * authenticate.
 */
export class UserSessionStore {
  constructor(
      private ctx: DurableObjectState,
      private env: Cloudflare.Env,
      private storage: UserStorage,
      private deps: UserSessionDeps,
  ) {}

  async authenticate(token: string): Promise<void> {
    // A deprovisioned account is closed: any surviving record (e.g. staged before the flag was
    // set) must not authenticate. Same failure shape as any other bad token, so the client
    // simply signs out.
    if (this.storage.deprovisioned.get()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    const now = Date.now();
    if ((session.expiresAt && session.expiresAt.getTime() <= now) ||
        (session.pendingUntil && session.pendingUntil.getTime() <= now)) {
      this.storage.sessions.delete(tokenId);
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (session.pendingUntil) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    this.deps.syncDirectory();
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    this.#refuseIfDeprovisioned();
    const isNew = !this.storage.created.get();
    if (isNew) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    this.deps.syncDirectory();
    return isNew;
  }

  // Deprovisioning closes the account (see deprovision()): no sign-in path may create it again
  // or mint a new session afterwards.
  #refuseIfDeprovisioned(): void {
    if (this.storage.deprovisioned.get()) {
      throw new Error("This account has been deprovisioned and can no longer sign in.");
    }
  }

  async #newSessionToken(options: { expiresAt?: Date; pendingUntil?: Date } = {}): Promise<string> {
    let { secret, hash: tokenId } = await newSecretToken();
    this.storage.sessions.put({ tokenId, created: new Date(), ...options });
    return secret.toBase64();
  }

  /**
   * Stage an idempotent, single-use transfer without returning encrypted credentials to page
   * JavaScript. A Workshop session remains inactive until the HTTPS callback consumes the record;
   * an Access token is already bounded by its JWT expiry and is stored only inside `handoff`.
   */
  async stageDeviceSessionHandoff(publicKey: string, state: string, accessJwt?: string)
      : Promise<DeviceSessionHandoffStart> {
    if (!this.storage.created.get()) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    if (!isDeviceHandoffState(state)) throw new Error("Invalid device sign-in state.");
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const existing = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.publicKey !== publicKey) {
        throw new Error("This device sign-in state is already bound to another key.");
      }
      // Reissue only the one-use ticket; a retry must not mint another credential or session.
      const { secret, hash: ticketHash } = await newSecretToken();
      this.storage.pendingDeviceHandoffs.put({ ...existing, ticketHash });
      return { userDoId: this.ctx.id.toString(), ticket: secret.toHex() };
    }
    if (existing) this.dropPendingDeviceHandoff(existing);

    const { secret: ticket, hash: ticketHash } = await newSecretToken();
    const now = Date.now();
    const handoffExpiresAt = now + DEVICE_HANDOFF_LIFETIME_MS;
    let credential: DeviceSessionCredential;
    let sessionTokenId: string | undefined;
    let deviceSessionExpiresAt: number | undefined;
    if (accessJwt) {
      credential = { kind: "cloudflare-access", token: accessJwt };
    } else {
      const { secret, hash } = await newSecretToken();
      sessionTokenId = hash;
      deviceSessionExpiresAt = now + DEVICE_SESSION_LIFETIME_MS;
      credential = {
        kind: "workshop",
        token: `${this.storage.profile.get().id}:${secret.toBase64()}`,
        expiresAt: deviceSessionExpiresAt,
      };
    }
    const handoff = await sealDeviceSessionHandoff(
        publicKey, state, credential, handoffExpiresAt);
    if (sessionTokenId && deviceSessionExpiresAt) {
      this.storage.sessions.put({
        tokenId: sessionTokenId,
        created: new Date(now),
        expiresAt: new Date(deviceSessionExpiresAt),
        pendingUntil: new Date(handoffExpiresAt),
      });
    }
    this.storage.pendingDeviceHandoffs.put({
      stateHash,
      ticketHash,
      publicKey,
      handoff,
      expiresAt: new Date(handoffExpiresAt),
      sessionTokenId,
    });
    await this.deps.armExpirySweep();
    logger.info("device session handoff staged", {
      event: "auth.device_handoff.staged",
      credentialKind: credential.kind,
    });
    return { userDoId: this.ctx.id.toString(), ticket: ticket.toHex() };
  }

  /** Consume a staged handoff once and activate its pending Workshop device session, if any. */
  async consumeDeviceSessionHandoff(state: string, ticket: string): Promise<DeviceSessionHandoff | null> {
    if (!isDeviceHandoffState(state)) return null;
    const presentedHash = hashPresentedSecret(ticket);
    if (!presentedHash) return null;
    const stateHash = await hashSecret(new TextEncoder().encode(state));
    const pending = this.storage.pendingDeviceHandoffs.get(stateHash);
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
      this.dropPendingDeviceHandoff(pending);
      await this.deps.armExpirySweep();
      return null;
    }
    if (pending.ticketHash !== await presentedHash) return null;
    this.storage.pendingDeviceHandoffs.delete(stateHash);
    if (pending.sessionTokenId) {
      const session = this.storage.sessions.get(pending.sessionTokenId);
      if (!session || !session.pendingUntil || session.pendingUntil.getTime() <= Date.now()) {
        if (session) this.storage.sessions.delete(pending.sessionTokenId);
        await this.deps.armExpirySweep();
        return null;
      }
      const { pendingUntil: _pendingUntil, ...active } = session;
      this.storage.sessions.put(active);
    }
    await this.deps.armExpirySweep();
    logger.info("device session handoff consumed", {
      event: "auth.device_handoff.consumed",
      credentialKind: pending.sessionTokenId ? "workshop" : "cloudflare-access",
    });
    return pending.handoff;
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Deletes every session record — browser and device sessions alike — plus every staged device
   * handoff and gatekeeper user-selection ticket, and returns how many session records were
   * deleted. Sessions are validated per request with no cache, so a deleted record fails on the
   * caller's very next `authenticate()`; a staged handoff's ticket can no longer be consumed
   * either, and the session it had staged dies with it (see `dropPendingDeviceHandoff`).
   */
  async revokeAllSessions(): Promise<number> {
    // Snapshot the ids first: the handoff loop below deletes staged sessions itself, and the
    // loops must not iterate a collection they are mutating.
    let tokenIds = [...this.storage.sessions.list()].map(session => session.tokenId);
    for (let pending of this.storage.pendingDeviceHandoffs.list()) {
      this.dropPendingDeviceHandoff(pending);
    }
    for (let selection of this.storage.pendingUserSelections.list()) {
      this.storage.pendingUserSelections.delete(selection.ticketHash);
    }
    for (let tokenId of tokenIds) {
      this.storage.sessions.delete(tokenId);
    }
    await this.deps.armExpirySweep();
    return tokenIds.length;
  }

  /**
   * Every current session record, for an admin surface to list "signed-in browsers and devices".
   * Metadata only: the tokens themselves are unrecoverable by design (only their SHA-256 hash is
   * stored), so a listing cannot be turned into access. `pendingUntil` marks a device session
   * staged but not yet activated by its handoff.
   */
  async listSessions(): Promise<LoginSessionRecord[]> {
    return [...this.storage.sessions.list()];
  }

  /**
   * Closes the account and severs everything that outlives a session:
   *
   * - every session and staged handoff/selection (revokeAllSessions, so the next `authenticate()`
   *   fails and no staged device handoff can be consumed);
   * - every connected gatekeeper account, revoked best-effort like the DO's `disconnectAccount()`
   *   (a gatekeeper that throws must not block the rest) and then deleted;
   * - the password (`passwordHashHash` nulled, so `login()` can never succeed again);
   * - push subscriptions, AI Gateway billing state and the daily LLM counter;
   * - the `deprovisioned` flag, set first so every sign-in path (password, gatekeeper, Cloudflare
   *   Access) refuses even if a later step stalls;
   * - the deployment-wide directory, where the user is flagged so collaborator search hides them
   *   (the counterpart of `UserDirectoryScopeStore.sync()`);
   * - every workspace shared *with* the user, whose collaborator edges are severed so each
   *   affected workspace force-restarts and the user's live chat sessions die with it (see
   *   `#severSharedWorkspaceAccess`);
   * - every org the user belonged to, which they leave so directory scopes, picker
   *   justifications and org-owned workspace baselines stop naming them (see
   *   `#leaveOrgsOnDeprovision`).
   *
   * Not touched: short-lived connect handoffs and flows (the alarm sweep owns those), and the
   * user's own workspaces and data — deprovisioning removes access, not content. Idempotent:
   * a second call finds nothing left to remove.
   */
  async deprovision(): Promise<void> {
    // Flag first, before any await: once set, no authentication path can mint a new session, so a
    // deprovision that stalls partway still leaves the account closed.
    this.storage.deprovisioned.put(true);
    await this.revokeAllSessions();
    // Every gatekeeper account revoked in parallel, best-effort per account like
    // #severSharedWorkspaceAccess: a gatekeeper that throws (or has nothing to revoke) must not
    // block the rest of the teardown — the record still goes, and with it the capability.
    let accounts = [...this.storage.connectedAccounts.list()];
    let revocations = await Promise.allSettled(accounts.map(account => account.account.revoke()));
    for (let [index, result] of revocations.entries()) {
      if (result.status === "rejected") {
        let { vendorId, id } = accounts[index]!;
        logger.error("revoke() failed during deprovision", {
          event: "account.revoke.failed",
          vendorId, accountId: id, error: result.reason,
        });
      }
    }
    for (let account of accounts) this.storage.connectedAccounts.delete(account.id);
    this.storage.passwordHashHash.put(null);
    this.storage.notificationSubscriptions.put({});
    this.storage.cloudflareBilling.put(null);
    this.storage.dailyLlmCount.put(null);
    if (this.storage.created.get()) {
      // Only a created account has a directory record (or a real profile id to flag).
      try {
        await this.ctx.exports.UserDirectoryDurableObject.getByName("")
            .markUserDeprovisioned(this.storage.profile.get().id, true);
      } catch (error) {
        logger.warn("failed to flag deprovisioned user in the directory", {
          event: "user.directory.deprovision.failed",
          error,
        });
      }
    }
    // Independent teardowns of what the account leaves behind — shared workspaces' collaborator
    // edges, org memberships — run concurrently (each is already best-effort per item), so one
    // slow cross-DO hop doesn't serialize the whole deprovision behind it. Each helper never
    // rejects per item, but a throw from either's prolog (a storage read) is logged like the
    // revocations above rather than vanishing into the allSettled.
    let teardowns = [this.#severSharedWorkspaceAccess(), this.#leaveOrgsOnDeprovision()];
    let teardownResults = await Promise.allSettled(teardowns);
    for (let [index, result] of teardownResults.entries()) {
      if (result.status === "rejected") {
        logger.error("teardown step failed during deprovision", {
          event: "user.deprovision.teardown.failed",
          operation: index === 0 ? "severSharedWorkspaceAccess" : "leaveOrgsOnDeprovision",
          error: result.reason,
        });
      }
    }
    logger.info("user deprovisioned", { event: "user.deprovisioned" });
  }

  /**
   * Leaves every org the user belonged to, so a closed account does not linger there as an
   * "active" member: co-members' directory scopes, picker-ticket justifications, and org-owned
   * workspaces' baselines all read the org's own member records, and each leave ends the
   * membership, mirrors this index entry away, and severs the org's workspaces in one move
   * (OrgDurableObject.memberLeave). Best-effort per org, like #severSharedWorkspaceAccess: a
   * leave that fails, or is refused because the user is the org's sole active owner (the org
   * keeps an unreachable owner rather than none, per org-access.ts), leaves a member record
   * nothing can exercise — the deprovisioned user can no longer authenticate, and any org admin
   * may still remove the record by hand. Pending invitations are declined the same way, unless
   * the account was never created (no profile id to leave under), in which case the org's own
   * expiry sweep reclaims them.
   */
  async #leaveOrgsOnDeprovision(): Promise<void> {
    const me = this.storage.profile.get()?.id;
    if (me === undefined) return;
    await Promise.all([...this.storage.orgMemberships.list()].map(async entry => {
      try {
        await this.ctx.exports.OrgDurableObject.getByName(entry.orgId).memberLeave(me);
      } catch (error) {
        logger.warn("failed to remove a deprovisioned user from an organization", {
          event: "deprovision.org.leave.failed",
          orgId: entry.orgId, error,
        });
      }
    }));
  }

  /**
   * Removes the user's collaborator edges from every workspace that was shared with them, so each
   * affected workspace force-restarts (`scheduleAccessRestart`) and the user's live chat sessions
   * die with the restart rather than at their next re-open. Best-effort per workspace: one that
   * cannot be reached keeps its stale edge, which grants nothing — the deprovisioned user can no
   * longer open anything.
   *
   * Two lazy residuals are accepted, consistent with the sharing model's revocation contract
   * (docs/sharing.md, docs/observers.md): only workspaces the user has *opened* are known here
   * (the gadgets index is written on open), so an edge for a share they never opened lingers
   * until its owner removes it — inert, for the same reason; and the post-restart cleanup the
   * restart can cut off (observer teardown, listing refresh) self-heals lazily, exactly as in
   * `removeCollaborator()`.
   */
  async #severSharedWorkspaceAccess(): Promise<void> {
    let profileId = this.storage.profile.get().id;
    let shared = [...this.storage.gadgets.list()].filter(record => record.owner);
    if (shared.length === 0) return;
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(shared.map(workspace =>
        overseers.get(overseers.idFromString(workspace.id))
            .severCollaboratorAccess(profileId)));
    for (let i = 0; i < results.length; i++) {
      let result = results[i];
      if (result.status === "rejected") {
        logger.warn("failed to sever deprovisioned user's workspace access", {
          event: "deprovision.workspace.sever.failed",
          gadgetId: shared[i].id, error: result.reason,
        });
      }
    }
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    this.#refuseIfDeprovisioned();
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: this.ctx.id.toString(),
        source: "gatekeeper",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: this.ctx.id.toString(),
      source: "gatekeeper",
    });
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  /** Drop a staged device handoff and the session it staged but never activated. */
  dropPendingDeviceHandoff(pending: PendingDeviceHandoffRecord): void {
    this.storage.pendingDeviceHandoffs.delete(pending.stateHash);
    if (pending.sessionTokenId) this.storage.sessions.delete(pending.sessionTokenId);
  }
}
