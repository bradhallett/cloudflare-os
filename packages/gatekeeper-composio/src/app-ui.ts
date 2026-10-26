// The owner-facing Composio app: the sandboxed full-page UI (catalog browser, connect links,
// key mode, sharing, usage) plus the owner-authenticated `ui` capability behind it. The frame
// HTML is the app agent's build output (app/ → src/generated/app.txt); everything the UI needs
// crosses the MessagePort RPC boundary through ComposioAppUi, exactly as app/types.ts fixes it
// (see plans/composio-gatekeeper.md "Surface").
//
// Connect Links are minted only here — through the account, under the owner fence that hosts
// this frame. The pasted-in key and every mutation ride the same fence. Nothing logged here
// ever includes a key, a redirect URL, or tool arguments.

import { validateRpc } from "capnweb-validate";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { AppUiContext, GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";

import type { ComposioAccount } from "./account.js";
import { ComposioApi } from "./composio-api.js";
import { composioFetch } from "./worker.js";
import type { ComposioAppUiClient } from "../app/types.js";
import APP_HTML from "./generated/app.txt";

/**
 * Serves the Composio app for one account. `context` carries the opening user's admin flag and
 * org memberships; nothing in the app is admin-gated today, so it goes unread.
 */
export function startAppUi(
  _context: AppUiContext,
  account: ComposioAccount,
): GatekeeperUiFrame {
  return { iframeHtml: APP_HTML, ui: new RpcStub(new ComposioAppUi(account)) };
}

/** The `ui` capability the frame holds, method-for-method as the shipped app calls it. */
@validateRpc()
export class ComposioAppUi extends RpcTarget implements ComposioAppUiClient {
  readonly #account: ComposioAccount;

  constructor(account: ComposioAccount) {
    super();
    this.#account = account;
  }

  searchToolkits(query: string) {
    return this.#account.searchToolkits(query);
  }

  async connectToolkit(slug: string, alias?: string) {
    return await this.#account.connectToolkit(slug, alias);
  }

  async pollConnectAttempt(connectedAccountId: string) {
    return await this.#account.pollConnected(connectedAccountId);
  }

  async disconnectToolkit(connectedAccountId: string): Promise<void> {
    await this.#account.disconnectToolkit(connectedAccountId);
  }

  async getKeyMode(): Promise<{ keyMode: "deployment" | "own" }> {
    return { keyMode: (await this.#account.keyState()).keyMode };
  }

  /**
   * Switches to the owner's own Composio key. Validated live first — against the real Composio
   * REST surface — so an invalid key never strands the account in own-key mode with no key that
   * works. The key itself is never logged.
   */
  async setOwnKey(key: string): Promise<void> {
    await new ComposioApi(key, composioFetch()).validateKey();
    await this.#account.provisionOwnKey(key);
  }

  async clearOwnKey(): Promise<void> {
    await this.#account.dropOwnKey();
  }

  async getSharing(): Promise<{ enabled: boolean }> {
    return { enabled: (await this.#account.sharingState()).enabled };
  }

  async setSharing(on: boolean): Promise<void> {
    await this.#account.setSharingEnabled(on);
  }

  async getUsage() {
    return await this.#account.usage();
  }

  /** The account's armed triggers (see account.ts listTriggers). */
  async listTriggers() {
    return await this.#account.listTriggers();
  }

  /** Upstream connected-account expiry notices the webhook route recorded. */
  async expiryNotices() {
    return await this.#account.expiryNotices();
  }

  /** The webhook subscription this account's triggers ride on. */
  async webhookState() {
    return await this.#account.webhookState();
  }

  /** Rotates the subscription signing secret upstream and re-stores it. */
  async rotateWebhookSecret(): Promise<void> {
    await this.#account.rotateWebhookSecret();
  }
}
