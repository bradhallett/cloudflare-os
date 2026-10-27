/**
 * The OAuth account Durable Object: one class carrying the whole connect→stage→commit→
 * reconnect→expire lifecycle on the kit's primitives, so a connector writes only what is
 * provider-specific.
 *
 * What the base owns, and the races it closes:
 *
 * - **Handshake.** The initiation→OAuth nonce handoff (`putInitiation`/`advanceToOAuth`/
 *   `claimOAuth`), with the attempt's provider metadata — scopes, redirect, PKCE verifier, whether
 *   the attempt is a first connect, and the connection generation it started under — riding the
 *   nonce record itself, so a callback can only act on an attempt that is still live.
 * - **First connect.** The claim is irrevocable, so the exchange runs after it; the verified
 *   subject pins the connection for the duration of the Workshop handoff (`pinForConnect`), and a
 *   failed handoff unpins, clears the just-stored credentials, and disposes the mint.
 * - **RC-1 (double redeem).** Every grant the flow obtained but could not keep — a subject read
 *   that failed on a first connect, a callback whose account was disconnected mid-flow, a mint a
 *   newer connect overtook — goes to `disposeGrant`, which a connector maps to its provider's
 *   revocation endpoint (or omits, when the provider has none).
 * - **RC-2 (refresh vs reconnect).** Refreshes are single-flight per connection
 *   (`CredentialCoordinator`), and a reconnect — staged or committed — is fenced on the generation
 *   the attempt started under: a refresh that lands after the attempt began cannot make its
 *   `connect` lose, and a commit whose generation was overtaken is refused and its grant disposed
 *   rather than clobbering the newer connection.
 * - **Expiry.** A dead grant notifies the Workshop's callback once (latched), so gadgets learn to
 *   ask for a reconnect exactly once per death; storing a reconnect's grant clears the latch.
 *
 * A subclass implements the provider-shaped hooks and adds its own resource RPCs; the storage
 * layout under it is the coordinator's single `credentials` record plus the pin, stage, and nonce
 * records the kit already defines. Accounts predating the base migrate through
 * `CredentialCoordinator`'s `legacyKeys`/`upgrade` options — override `credentialOptions`,
 * spreading `super.credentialOptions()` first.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ConnectHandoff,
  GatekeeperConnectCallback,
  GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";
import { createPkce } from "./oauth-client";
import {
  advanceToOAuth,
  claimOAuth,
  NONCE_KEY,
  putInitiation,
} from "./connect-handshake";
import { CONNECT_TIMEOUT_MS } from "./connect-nonce";
import { notifyCredentialsExpiredOnce } from "./credential-expiry";
import {
  commitReconnectOrThrow,
  discardStagedCredentials,
  pinForConnect,
  pinnedConnectionSubject,
  stageReconnect,
  type ConnectionSubject,
} from "./credential-stage";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  isConnectionSuperseded,
  isCredentialsExpired,
  type CredentialCoordinatorOptions,
  type CredentialsWithIdentity,
  type RejectionVerdict,
} from "./credentials";

/** What an OAuth callback hands back to the page that finished the flow. */
export type OAuthCallbackResult =
  | { handoff: ConnectHandoff }
  | { refused: { title: string; detail: string } };

/** The attempt metadata an authorization code arrives attached to. */
export type OAuthAttempt = {
  /** The redirect URI the authorization request carried, when the flow uses one. */
  redirectUri?: string;
  /** The PKCE verifier minted for this attempt, when `usesPkce` is true. */
  codeVerifier?: string;
  /** The scopes the attempt asked for. */
  scopes: string[];
  /** Whether this attempt is the account's first connect, as opposed to a reconnect. */
  firstConnect: boolean;
};

/** How the stage escrow carries a reconnect's credentials to its Workshop ticket. */
type ReconnectStage<Creds> = { creds: Creds; startedUnder: string };

/**
 * What a stored attempt carries beyond the handshake's own fields: the connection generation it
 * began under, which both a first connect's `connect` and a reconnect's commit fence on.
 * `firstConnect` stays optional here because `advanceToOAuth` spreads its extra *over* the
 * initiation record, so the base must not re-state the flag the record already carries.
 */
type StoredAttempt = Omit<OAuthAttempt, "firstConnect"> & {
  firstConnect?: boolean;
  startedUnder: string;
};

/**
 * The lifecycle every OAuth-backed account DO shares. Type parameters:
 *
 * @typeParam Env The worker's environment binding type.
 * @typeParam Creds The connector's stored grant (tokens, expiry, scopes, provider extras).
 * @typeParam Subject The connector's connection-subject shape (`id` plus display fields).
 */
export abstract class OAuthAccountDO<Env, Creds, Subject extends ConnectionSubject>
  extends DurableObject<Env> {
  /** Built once, from the hooks; the hooks themselves run only on use, never in this initializer. */
  readonly #creds = new CredentialCoordinator<Creds>(this.ctx.storage.kv,
    this.credentialOptions());

  /**
   * Coordinator configuration, assembled from the hooks. A subclass with legacy accounts to
   * migrate overrides this to add `legacyKeys`/`upgrade`, spreading `super.credentialOptions()`
   * first.
   */
  protected credentialOptions(): CredentialCoordinatorOptions<Creds> {
    return {
      expiresAt: creds => this.expiresAt?.(creds),
      refreshSkewMs: this.refreshSkewMs(),
      discardMint: mint => this.disposeGrant?.(mint),
      vendorId: this.vendorId(),
    };
  }

  /** The provider identity this account belongs to, namespacing the expiry latch. */
  protected abstract vendorId(): string;

  /**
   * The scopes an authorization asks for when neither `setCallback` nor `prepareReconnect` was
   * handed any — the connector's static default.
   */
  protected abstract requestedScopes(): string[];

  /**
   * The user facet this account hands its Workshop callback, so `complete()` can name the user the
   * gadgets talk to. Usually one line over `this.ctx.exports`.
   */
  protected abstract userFacet(): Fetcher<GatekeeperUser>;

  /**
   * Exchanges an authorization code for credentials, immediately after the attempt's nonce was
   * claimed. Throwing fails the flow; on a first connect the later failures — the subject read,
   * the missing callback — dispose the mint, since the flow obtained a grant it cannot keep.
   * @param code The provider's authorization code.
   * @param attempt The attempt the code belongs to.
   */
  protected abstract exchange(code: string, attempt: OAuthAttempt): Promise<Creds>;

  /**
   * Reads which provider account `creds` authorizes, before anything is stored. `undefined` means
   * the grant carries no verifiable identity: reconnects then stage subjectless (no fence
   * compares them), but a first connect needs a subject to pin and will fail without one.
   */
  protected abstract subjectOf(creds: Creds): Promise<Subject | undefined>;

  /**
   * Exchanges a refresh token for fresh credentials. Grant death is the refresh throwing; the
   * coordinator classifies it and starts the expiry latch.
   */
  protected abstract refreshCredentials(current: Creds): Promise<Creds>;

  /** The page a reconnect refusal shows, when the grant came back as someone else. */
  protected abstract reconnectRefusal(pinned: Subject, granted: Subject):
    { title: string; detail: string };

  /**
   * The grant's absolute expiry, when the provider states one. Omit when every expiry is unknown;
   * without it the coordinator cannot refresh proactively.
   */
  protected expiresAt?(creds: Creds): number | undefined;

  /** How long before `expiresAt` a token counts as expired. Default: the coordinator's own. */
  protected refreshSkewMs(): number | undefined {
    return undefined;
  }

  /**
   * Revokes a grant the connection will not keep — a refused reconnect, a mint a newer connect
   * overtook, a first connect whose subject read failed, the live and staged grants at `revoke`.
   * Omit when the provider has no revocation endpoint; dropping the local copy is then all the
   * disposal there is.
   */
  protected disposeGrant?(creds: Creds): Promise<void> | void;

  /**
   * Runs after a first connect or reconnect commit made `creds` live — writing derived records,
   * warming secondary caches. Throwing here fails the RPC; the connection is already live.
   * @param creds The credentials just made live.
   * @param subject The subject the flow verified them as, when it read one.
   */
  protected onCredentialsLive?(creds: Creds, subject: Subject | undefined): Promise<void> | void;

  /** The words a gadget sees when the connection's grant is dead. Default wording is generic. */
  protected credentialsExpiredMessage(): string {
    return "This connection has expired. Reconnect it to continue.";
  }

  /** Whether the provider's authorization endpoint takes a PKCE verifier. Default: no. */
  protected usesPkce(): boolean {
    return false;
  }

  /** The redirect URI authorization requests carry, when the connector has a fixed one. */
  protected redirectUri?(): string;

  /** The stored credentials, for subclasses adding resource RPCs on top. */
  protected stored(): Creds | undefined {
    return this.#creds.stored();
  }

  /** The connection's current generation, for subclass RPCs that fence writes of their own. */
  protected connectionGeneration(): string {
    return this.#creds.connectionGeneration();
  }

  /** Stores the connect callback and arms the first-connect attempt. */
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes?: string[]): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    this.ctx.storage.kv.put("callback", callback);
    if (requestedScopes !== undefined) {
      this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    }
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now(), { firstConnect: true });
  }

  /** Arms a reconnect attempt; its grant goes live only when the Workshop's ticket commits. */
  async prepareReconnect(initiationNonce: string, requestedScopes?: string[]): Promise<void> {
    if (requestedScopes !== undefined) {
      this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    }
    putInitiation(this.ctx.storage.kv, initiationNonce, Date.now());
  }

  /**
   * Swaps the initiation nonce for the OAuth-stage nonce, capturing the attempt's provider
   * metadata and the connection generation it started under.
   * @returns What the authorization URL needs, or `null` when the link is stale or spent.
   */
  async beginOAuthFlow(initiationNonce: string, redirectUri?: string):
      Promise<{ oauthNonce: string; scopes: string[]; codeChallenge?: string } | null> {
    // Reading the generation below writes one, which an old link to a deleted account must not.
    if (this.ctx.storage.kv.get(NONCE_KEY) === undefined) return null;
    const pkce = this.usesPkce() ? await createPkce() : undefined;
    const attempt: StoredAttempt = {
      redirectUri: redirectUri ?? this.redirectUri?.(),
      ...(pkce !== undefined ? { codeVerifier: pkce.codeVerifier } : {}),
      startedUnder: this.#creds.connectionGeneration(),
      scopes: this.ctx.storage.kv.get<string[]>("requestedScopes") ?? this.requestedScopes(),
    };
    const oauthNonce = advanceToOAuth(this.ctx.storage.kv, initiationNonce, Date.now(), attempt);
    if (oauthNonce === null) return null;
    return {
      oauthNonce,
      scopes: attempt.scopes,
      ...(pkce !== undefined ? { codeChallenge: pkce.codeChallenge } : {}),
    };
  }

  /**
   * Finishes the code exchange and either completes the first connect (pinned, fenced, disposed on
   * failure), stages the reconnect for its Workshop ticket, or returns the refusal page.
   * @returns The handoff, a refusal to show, or `null` when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<OAuthCallbackResult | null> {
    const kv = this.ctx.storage.kv;
    const attempt = claimOAuth<StoredAttempt>(kv, oauthNonce, Date.now());
    if (attempt === null) return null;

    const creds = await this.exchange(code,
      { ...attempt, firstConnect: attempt.firstConnect === true });
    const callback = kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback === undefined) {
      await this.disposeGrant?.(creds);
      throw new Error(
        "The account was disconnected while it was being authorized. Connect it again.");
    }

    // The subject read can fail without the grant being at fault, but nothing yet stored can prove
    // that, so a first connect disposes the mint; a reconnect's grant is still only staged.
    let subject: Subject | undefined;
    try {
      subject = await this.subjectOf(creds);
    } catch (error) {
      if (attempt.firstConnect) await this.disposeGrant?.(creds);
      throw new Error(
        "Could not read which account authorized this connection. Please try again.",
        { cause: error });
    }

    if (!attempt.firstConnect) {
      const staged = stageReconnect<ReconnectStage<Creds>, Subject>(kv,
        { creds, startedUnder: attempt.startedUnder }, subject, Date.now(),
        (pinned, granted) => this.reconnectRefusal(pinned, granted));
      if ("refused" in staged) {
        await this.disposeGrant?.(creds);
        return { refused: staged.refused };
      }
      // The reconnect URL is a bearer capability, so the new grant stays staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (`commitReconnect`).
      return { handoff: await callback.reconnectComplete(staged.stageId) };
    }

    try {
      this.#creds.connect(creds, { ifGeneration: attempt.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      await this.disposeGrant?.(creds);
      throw new Error(
        "The account was disconnected while it was being authorized. Connect it again.",
        { cause: error });
    }
    // The pin lives only as long as the handoff: a connect that fails unpins again, and a
    // connection the Workshop never took leaves its tokens with nobody, so they are disposed.
    const handoff = await pinForConnect<Subject, ConnectHandoff>(kv, subject,
      () => callback.complete(this.userFacet()),
      async () => {
        const abandoned = this.#creds.stored() ?? creds;
        this.#creds.clear();
        await this.disposeGrant?.(abandoned);
      });
    await this.ctx.storage.deleteAlarm();
    await this.onCredentialsLive?.(this.#creds.stored() ?? creds, subject);
    return { handoff };
  }

  /**
   * Makes the grant staged under `stageId` live, fenced on the generation the attempt started
   * under: a reconnect overtaken by a newer one is refused and its grant disposed.
   * @throws Error when no stage is committable, or when a newer connection won the race.
   */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitReconnectOrThrow<ReconnectStage<Creds>>(this.ctx.storage.kv, Date.now(),
      stageId);
    try {
      this.#creds.connect(staged.creds, { ifGeneration: staged.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      await this.disposeGrant?.(staged.creds);
      throw new Error(
        "This account was reconnected again while this reconnect was finishing, " +
        "so this one was discarded.", { cause: error });
    }
    // The commit re-pinned the staged subject; the live hook sees the connection's subject.
    await this.onCredentialsLive?.(staged.creds,
      pinnedConnectionSubject<Subject>(this.ctx.storage.kv));
  }

  /** The credential read a facet's `CredentialSource` consumes, refreshing when due. */
  async getCredentials(): Promise<CredentialsWithIdentity<Creds>> {
    try {
      return await this.#creds.snapshot(creds => this.refreshCredentials(creds),
        { notify: () => this.#notifyExpired() });
    } catch (error) {
      // A dead grant, a disconnect, a revoke mid-refresh: to the gadget each means one thing.
      if (isCredentialsExpired(error)) {
        throw new CredentialsExpiredError(this.credentialsExpiredMessage(), { cause: error });
      }
      throw error;
    }
  }

  /** Adjudicates the provider's refusal of the credential named by `identity`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return await this.#creds.adjudicateRejection(identity,
      { refresh: creds => this.refreshCredentials(creds), notify: () => this.#notifyExpired() });
  }

  /** Tells the Workshop once, per grant death, that the connection needs a reconnect. */
  async notifyCredentialsExpired(): Promise<void> {
    await this.#notifyExpired();
  }

  /** Drops the account when its connect flow never completed. */
  async alarm(): Promise<void> {
    if (!this.#creds.stored()) await this.ctx.storage.deleteAll();
  }

  /**
   * Disconnects, local-first: the account is cleared before any call to the provider, so nothing
   * can re-arm it meanwhile; disposing of the tokens there is best effort afterwards.
   */
  async revoke(): Promise<void> {
    const live = this.#creds.stored();
    const staged = discardStagedCredentials<ReconnectStage<Creds>>(this.ctx.storage.kv);
    this.#creds.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (staged) await this.disposeGrant?.(staged.creds);
    if (live) await this.disposeGrant?.(live);
  }

  /** The latched one-time expiry notification. */
  async #notifyExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), this.vendorId());
  }
}
