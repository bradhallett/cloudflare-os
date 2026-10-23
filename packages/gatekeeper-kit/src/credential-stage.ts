/**
 * Escrow for credentials a reconnect / ensureResources flow obtained but the Workshop has not yet
 * confirmed came from the account's owner (see `GatekeeperUser.reconnect` in workshop-shared).
 *
 * A reconnect URL is a bearer capability, and gadgets bound to the account read its live credentials
 * straight from the gatekeeper, so a flow that wrote its result live would hand those gadgets a
 * phished victim's tokens with nothing in the way. Instead the flow stages them here and reports
 * `reconnectComplete()`; only `GatekeeperUser.commitReconnect()`, called once the Workshop has
 * verified the completing browser, moves them to the live keys. No read path serves a stage and no
 * other write activates one: an uncommitted stage is replaced by the next, or dropped outright by
 * `discardStagedCredentials`.
 *
 * Every stage carries a random `stageId`, which the flow passes to `reconnectComplete()` so the
 * Workshop's ticket names the exact credentials whose completion minted it. Two reconnects can
 * overlap — the owner's and one a phished victim finished — and a commit that took "whatever is
 * staged" would let the ticket from the first activate the second's credentials.
 *
 * A second fence sits in front of the escrow: the connection is pinned to the subject — the
 * provider-stable account identity — its first connect was verified as, and only that subject's
 * grant may be staged or committed (`stageReconnect` / `commitReconnect`). Whoever holds the
 * reconnect URL, then, can only ever reconnect the account the connection already belongs to.
 */

import { generateNonce, OAUTH_NONCE_LIFETIME_MS } from "./connect-nonce";
import type { KvMutable } from "./kv";

/** KV key holding the staged credentials. */
export const STAGED_CREDENTIALS_KEY = "stagedCredentials";

/** The stored record: the consumer's credentials, the subject the flow verified them as, and the stage's own id and expiry. */
type StagedCredentials<T> = { creds: T; subject?: ConnectionSubject; stageId: string; expiresAt: number };

/** A stage's credentials together with the id a commit must name to take them. */
export type StagedCredentialsView<T> = { creds: T; stageId: string };

/**
 * The stable identity of the account a connection belongs to, as its provider spells it: a
 * GitHub user id, a Google `sub` claim, an Atlassian account id. Only `id` is compared, so a
 * connector widens this with the fields its user-facing refusal wording needs — a login, a
 * workspace name — and those ride along in storage untouched.
 */
export type ConnectionSubject = { id: string };

/** KV key holding the connection's pinned subject. */
export const CONNECTION_SUBJECT_KEY = "connectionSubject";

/**
 * Stages credentials for a later `commitStagedCredentials`, replacing any earlier stage. A caller
 * that can safely dispose the previous live stage must `peekStagedCredentials` immediately before
 * this call, with no await between them, then dispose it after this call.
 * @param kv Durable Object storage.
 * @param creds Whatever the connector needs to write its live keys on commit.
 * @param now Current Unix time in milliseconds.
 * @param ttlMs How long the stage stays committable; the Workshop redeems well within the default.
 * @returns The new stage's id, to pass to `GatekeeperConnectCallback.reconnectComplete()`.
 *
 * @example
 * ```ts
 * const stageId = stageCredentials(this.ctx.storage.kv, { accessToken, scopes }, Date.now());
 * return callback.reconnectComplete(stageId);
 * ```
 */
export function stageCredentials<T>(
  kv: KvMutable,
  creds: T,
  now: number,
  ttlMs: number = OAUTH_NONCE_LIFETIME_MS,
): string {
  const stageId = generateNonce();
  kv.put<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY, { creds, stageId, expiresAt: now + ttlMs });
  return stageId;
}

/**
 * Reads the stored stage, deleting a record no caller could use — null, not an object, or missing
 * a field — so every public reader can keep its `T | null` contract.
 * @param kv Durable Object storage.
 * @returns The stored stage, or `undefined` when there is none.
 */
function storedStage<T>(kv: KvMutable): StagedCredentials<T> | undefined {
  const staged = kv.get<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY);
  if (staged === undefined) return undefined;
  if (typeof staged?.stageId === "string" && Number.isFinite(staged.expiresAt)
      && staged.creds !== undefined && isSubject(staged.subject)) return staged;
  kv.delete(STAGED_CREDENTIALS_KEY);
  return undefined;
}

/** A stage's `subject` slot holds a subject or nothing; anything else is corruption, not data. */
function isSubject(value: ConnectionSubject | undefined): boolean {
  return value === undefined
    || (typeof value === "object" && typeof value?.id === "string");
}

/**
 * Reads the stored stage while it is still committable. A non-finite clock reads as expired, so an
 * unusable time source cannot activate a stage.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The live stage, or `undefined` when none is committable.
 */
function liveStage<T>(kv: KvMutable, now: number): StagedCredentials<T> | undefined {
  const staged = storedStage<T>(kv);
  return staged !== undefined && Number.isFinite(now) && now < staged.expiresAt
    ? staged
    : undefined;
}

/**
 * Reads the staged credentials without consuming them, for a connector that needs the id of a stage
 * it wrote earlier in the same flow, or must *use* the credentials once before commit. Every other
 * reader waits for `commitStagedCredentials`.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The staged credentials and their stage id, or `null` when nothing live is staged.
 */
export function peekStagedCredentials<T>(kv: KvMutable, now: number): StagedCredentialsView<T> | null {
  const staged = liveStage<T>(kv, now);
  return staged ? { creds: staged.creds, stageId: staged.stageId } : null;
}

/**
 * Takes the staged credentials, if the stage named by `stageId` is the current one and still live.
 * A matching stage is deleted, so a commit happens at most once; an expired or unusable stage is
 * deleted too rather than left for a later caller. A stage with a *different* id is left in place
 * and `null` is returned: it belongs to a newer flow, whose own ticket is the only thing that may
 * commit it.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @param stageId The id `stageCredentials` returned for the stage being committed.
 * @returns The staged credentials, or `null` when that stage is not live.
 *
 * @example
 * ```ts
 * const staged = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now(), stageId);
 * if (!staged) throw new Error("Nothing to commit.");
 * this.ctx.storage.kv.put("accessToken", staged.accessToken);
 * ```
 */
export function commitStagedCredentials<T>(kv: KvMutable, now: number, stageId: string): T | null {
  const staged = liveStage<T>(kv, now);
  if (staged === undefined) {
    kv.delete(STAGED_CREDENTIALS_KEY);
    return null;
  }
  // Plain comparison: the id is an identity, not a secret. Only the Workshop can reach
  // `commitReconnect`, and it names the id its own record carries.
  if (staged.stageId !== stageId) return null;
  kv.delete(STAGED_CREDENTIALS_KEY);
  return staged.creds;
}

/**
 * Drops a stage and returns what it held, for gatekeeper-owned disposal. Given no `stageId` it drops
 * whatever is staged; given one it drops only that exact stage, so a newer flow's stage survives a
 * cleanup the flow before it scheduled. A record no caller could use is dropped, reporting `null`.
 *
 * Unlike a commit this ignores the stage TTL, which is what lets an abandoned stage be cleaned up
 * long after its window closed — and why the credentials it returns must never be written live.
 * Nothing has confirmed who obtained them, and `commitStagedCredentials` is the only path that may
 * activate a stage. The local deletion must happen before awaiting provider cleanup.
 * @param kv Durable Object storage.
 * @param stageId The exact stage to drop, for a caller that retained the id `stageCredentials` gave it.
 * @returns The dropped credentials, or `null` when nothing matched.
 */
export function discardStagedCredentials<T>(kv: KvMutable, stageId?: string): T | null {
  const staged = storedStage<T>(kv);
  if (staged === undefined || (stageId !== undefined && staged.stageId !== stageId)) return null;
  kv.delete(STAGED_CREDENTIALS_KEY);
  return staged.creds;
}

/**
 * Reads the subject this connection is pinned to. `S` is the connector's own subject shape, so a
 * record staged with display fields reads back with them.
 * @param kv Durable Object storage.
 * @returns The pinned subject, or `undefined` when none is pinned (or a corrupt record was dropped).
 */
export function pinnedConnectionSubject<S extends ConnectionSubject>(kv: KvMutable): S | undefined {
  const pinned = kv.get<S>(CONNECTION_SUBJECT_KEY);
  if (pinned === undefined) return undefined;
  if (typeof pinned?.id === "string") return pinned;
  kv.delete(CONNECTION_SUBJECT_KEY);
  return undefined;
}

/**
 * Pins the connection to the subject its first connect was verified as. Committing a reconnect
 * re-pins on its own, so this is for the first connect alone; clear it again if that connect is
 * unwound, so an abandoned attempt pins nothing.
 * @param kv Durable Object storage.
 * @param subject The subject the connect flow verified the grant as.
 */
export function pinConnectionSubject<S extends ConnectionSubject>(kv: KvMutable, subject: S): void {
  kv.put<S>(CONNECTION_SUBJECT_KEY, subject);
}

/**
 * Drops the pin, for a connector clearing the credentials the pin fenced.
 * @param kv Durable Object storage.
 */
export function clearConnectionSubject(kv: KvMutable): void {
  kv.delete(CONNECTION_SUBJECT_KEY);
}

/**
 * Stages a reconnect's credentials together with the subject the flow verified them as, refusing
 * (and staging nothing) when the connection is pinned to a different subject: a reconnect URL is a
 * bearer capability, so anyone can finish one, and only the pinned account's grant may take the
 * stage a Workshop ticket could commit. An unpinned connection — one made before its gatekeeper
 * pinned — stages anything, and its commit adopts the subject it came with.
 *
 * The refusal's words are the connector's: `refused` receives both subjects and returns the page
 * to show. The caller keeps ownership of disposing the refused grant, since whether a provider can
 * revoke one varies.
 * @param kv Durable Object storage.
 * @param creds Whatever the connector needs to write its live keys on commit.
 * @param subject The subject the flow verified the new grant as.
 * @param now Current Unix time in milliseconds.
 * @param refused Words the refusal page shows, given the pinned and the granted subjects.
 * @param ttlMs How long the stage stays committable; the Workshop redeems well within the default.
 * @returns The new stage's id, or the refusal to render in its place. A refusal leaves any earlier
 * stage untouched — it belongs to a flow whose own ticket may still commit it.
 *
 * @example
 * ```ts
 * const staged = stageReconnect(kv, grant, subject, Date.now(), (pinned, granted) => ({
 *   title: "That's a different account",
 *   detail: `This connection is for ${pinned.name}, but the provider authorized ${granted.name}.`,
 * }));
 * if ("refused" in staged) return staged;
 * return callback.reconnectComplete(staged.stageId);
 * ```
 */
export function stageReconnect<T, S extends ConnectionSubject>(
  kv: KvMutable,
  creds: T,
  subject: S,
  now: number,
  refused: (pinned: S, granted: S) => { title: string; detail: string },
  ttlMs: number = OAUTH_NONCE_LIFETIME_MS,
): { stageId: string } | { refused: { title: string; detail: string } } {
  const pinned = pinnedConnectionSubject<S>(kv);
  if (pinned !== undefined && pinned.id !== subject.id) {
    return { refused: refused(pinned, subject) };
  }
  const stageId = generateNonce();
  kv.put<StagedCredentials<T>>(STAGED_CREDENTIALS_KEY,
    { creds, subject, stageId, expiresAt: now + ttlMs });
  return { stageId };
}

/**
 * Commits a reconnect staged by `stageReconnect`, fenced on the connection's pinned subject: the
 * stage's subject must be the pinned one — or absent, for a connection nothing pins yet — or the
 * stage is dropped and `null` returned, the same answer as no stage at all. A stage that passes
 * re-pins the connection to the subject it was verified as, adopting a connection made before its
 * gatekeeper pinned and following a rename. A stage without a subject (a connector that could not
 * read one, or a record from before subjects) commits without touching the pin.
 *
 * Otherwise this is `commitStagedCredentials`: the stage named by `stageId` is taken at most once,
 * an expired stage is dropped, and a stage with a different id is left for its own flow.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @param stageId The id `stageReconnect` returned for the stage being committed.
 * @returns The staged credentials, or `null` when that stage is not committable.
 */
export function commitReconnect<T>(kv: KvMutable, now: number, stageId: string): T | null {
  const staged = liveStage<T>(kv, now);
  if (staged === undefined) {
    kv.delete(STAGED_CREDENTIALS_KEY);
    return null;
  }
  // Plain comparison: the id is an identity, not a secret. Only the Workshop can reach
  // `commitReconnect`, and it names the id its own record carries.
  if (staged.stageId !== stageId) return null;
  if (staged.subject !== undefined) {
    const pinned = pinnedConnectionSubject<ConnectionSubject>(kv);
    if (pinned !== undefined && pinned.id !== staged.subject.id) {
      kv.delete(STAGED_CREDENTIALS_KEY);
      return null;
    }
    pinConnectionSubject(kv, staged.subject);
  }
  kv.delete(STAGED_CREDENTIALS_KEY);
  return staged.creds;
}
