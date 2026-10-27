import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  workerVersionTag,
  type AccountDescription,
  type AvatarImage,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  commitReconnectOrThrow, ConnectionSubject, pinForConnect, stageReconnect,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { clearCredentialExpiryLatch, notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import INSTANCE_CONFIGURATOR_HTML from "./generated/instance-configurator-ui.txt";
import AREA_CONFIGURATOR_HTML from "./generated/area-configurator-ui.txt";
import LABEL_CONFIGURATOR_HTML from "./generated/label-configurator-ui.txt";
import DEVICE_CONFIGURATOR_HTML from "./generated/device-configurator-ui.txt";
import ENTITY_CONFIGURATOR_HTML from "./generated/entity-configurator-ui.txt";
import {
  HomeAssistantError,
  HomeAssistantRest,
  type HomeAssistantCredentials,
} from "./homeassistant-api";
import TYPES_CODE from "./types.txt";

// The classes and shared types the moved modules own, re-exported so the worker's main module
// still exposes every Durable Object class wrangler binds and every type its siblings import.
export type { HATarget, ActionOrigin, HomeAssistantAction, HomeAssistantRevertInfo } from "./ha-gatekeeper";
export { HomeAssistantGatekeeperImpl } from "./ha-gatekeeper";
export type { SubmitWriteBody } from "./ha-validate";

import {
  InstanceConfiguratorUI,
  AreaConfiguratorUI,
  LabelConfiguratorUI,
  DeviceConfiguratorUI,
  EntityConfiguratorUI,
} from "./ha-configurators";
// ---------------------------------------------------------------------------
// Configuration & nonce helpers

export type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/homeassistant");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Resource descriptors

// Home Assistant brand icon, embedded as an inline SVG data URL.
//
// Source: https://github.com/homarr-labs/dashboard-icons (home-assistant.svg).
//
// The logomark fills its native 512x512 viewBox, so it renders at the same visual weight as the
// other vendor logos (which likewise use tight, fill-the-canvas viewBoxes) wherever a gatekeeper
// logo is shown (the connect card, picker, and admin panel all render it at full size).
const HOMEASSISTANT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<path d="M512 473.3c0 17.6-14.4 32-32 32H32c-17.6 0-32-14.4-32-32v-192c0-17.6 10.2-42.2 22.6-54.6L233.4 16c12.4-12.4 32.8-12.4 45.2 0l210.8 210.8c12.4 12.4 22.6 37 22.6 54.6z" fill="#f2f4f9"/>\
<path d="M489.4 226.7 278.6 16c-12.4-12.4-32.8-12.4-45.2 0L22.6 226.7C10.2 239.1 0 263.7 0 281.3v192c0 17.6 14.4 32 32 32h196.8l-86.7-86.7c-4.5 1.5-9.2 2.4-14.2 2.4-24.1 0-43.7-19.6-43.7-43.7s19.6-43.7 43.7-43.7 43.7 19.6 43.7 43.7c0 5-.9 9.7-2.4 14.2l67.5 67.5V211.8c-14.5-7.1-24.5-22-24.5-39.2 0-24.1 19.6-43.7 43.7-43.7s43.7 19.6 43.7 43.7c0 17.2-10 32.1-24.5 39.2v173.4l67.1-67.1c-1.3-4.2-2-8.6-2-13.2 0-24.1 19.6-43.7 43.7-43.7s43.7 19.6 43.7 43.7-19.6 43.7-43.7 43.7c-5.3 0-10.4-1-15.1-2.8l-93.7 93.7v65.9H480c17.6 0 32-14.4 32-32v-192c0-17.6-10.2-42.2-22.6-54.7" fill="#18bcf2"/>\
</svg>`;

const HOMEASSISTANT_LOGO_URL =
  `data:image/svg+xml;utf8,${encodeURIComponent(HOMEASSISTANT_LOGO_SVG)}`;

const HOMEASSISTANT_ICON: AvatarImage = { url: HOMEASSISTANT_LOGO_URL };

// Whole-instance resource: matches the user's HA base URL. We use `https://*` as a catch-all
// pattern so any HA URL the user pastes will match. The Workshop's resource picker recognizes
// `https://*` as a special "any URL" pattern.
const INSTANCE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Home Assistant",
  description: "Access to a Home Assistant instance: every area, device, entity, and dashboard.",
  icon: HOMEASSISTANT_ICON,
};

/**
 * Each finer-grained granularity is selected via its own configurator UI. The URL patterns use
 * a unique scheme/host marker so the resource picker doesn't confuse them with the catch-all
 * `https://*` whole-instance resource, and so URLPattern.test() routes correctly.
 */
export const AREA_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/area/:areaId",
  title: "Home Assistant Area",
  description: "Access to a single Home Assistant area (room): its devices and entities only.",
  icon: HOMEASSISTANT_ICON,
};

export const LABEL_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/label/:labelId",
  title: "Home Assistant Label",
  description: "Access to all Home Assistant entities carrying a particular label.",
  icon: HOMEASSISTANT_ICON,
};

export const DEVICE_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/device/:deviceId",
  title: "Home Assistant Device",
  description: "Access to a single physical device and the entities it provides.",
  icon: HOMEASSISTANT_ICON,
};

export const ENTITY_RESOURCE: SupportedResource = {
  urlPattern: "https://homeassistant.local/_resource/entity/:entityId",
  title: "Home Assistant Entity",
  description: "Access to a single Home Assistant entity (light, sensor, switch, etc).",
  icon: HOMEASSISTANT_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  INSTANCE_RESOURCE,
  AREA_RESOURCE,
  LABEL_RESOURCE,
  DEVICE_RESOURCE,
  ENTITY_RESOURCE,
];

// ---------------------------------------------------------------------------
// HTML pages for the connect flow

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Home Assistant</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #03a9f4; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #03a9f4; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #03a9f4; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #0288d1; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Home Assistant</h1>
    <p>Provide the URL of your Home Assistant instance and a long-lived access token. Cloudflare OS will use these to read entity states and control devices.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeAttr(params.actionUrl)}">
      <label for="baseUrl">Home Assistant URL</label>
      <input id="baseUrl" name="baseUrl" type="url" required placeholder="https://homeassistant.local:8123" autofocus>
      <div class="hint">Include the protocol (http:// or https://) and port if non-standard. No trailing slash.</div>

      <label for="token">Long-Lived Access Token</label>
      <input id="token" name="token" type="password" required placeholder="eyJhbGc...">
      <div class="hint">Tokens never expire; they grant full account access until revoked in HA.</div>

      <details>
        <summary>How to create a long-lived access token</summary>
        <ol>
          <li>Open your Home Assistant in a browser.</li>
          <li>Click your username in the bottom-left corner.</li>
          <li>Select the <b>Security</b> tab.</li>
          <li>Scroll to the bottom and click <b>Create Token</b> under "Long-lived access tokens".</li>
          <li>Give it a name like "Cloudflare OS", then copy the token and paste it above.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Authorization Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

// The route checks only path shape before reading the form; the account checks the nonce after.
const MAX_CONNECT_FORM_BYTES = 16 * 1024;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        let formData: URLSearchParams;
        try {
          formData = new URLSearchParams(await readTextCapped(req, MAX_CONNECT_FORM_BYTES));
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const baseUrlInput = String(formData.get("baseUrl") ?? "").trim();
        const tokenInput = String(formData.get("token") ?? "").trim();
        if (!baseUrlInput || !tokenInput) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "Both URL and token are required." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        // Normalize URL
        let normalizedUrl: string;
        try {
          const u = new URL(baseUrlInput);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new Error("URL must use http:// or https://");
          }
          // Strip trailing slash
          normalizedUrl = `${u.protocol}//${u.host}${stripTrailingSlashes(u.pathname)}`;
        } catch (e: any) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: `Invalid URL: ${e.message}` }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, normalizedUrl, tokenInput);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Home Assistant",
      url: "https://www.home-assistant.io/",
      logo: HOMEASSISTANT_ICON,
      tagline: "Control your smart home, read sensor state, and edit Lovelace dashboards.",
      description:
          "Connect your Home Assistant instance so Cloudflare OS can read entity state, call services " +
          "to control devices, edit dashboards, and render templates. Build agents that automate " +
          "your home, alert on sensor changes, or generate custom dashboards.",
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }


  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores baseUrl + LLAT for a connected account

interface StoredCredentials {
  baseUrl: string;
  token: string;
}

interface StoredNonce {
  value: string;
  expiresAt: number;
  /**
   * Set when this flow reconnects an existing account, so its grant is staged rather than made
   * live. The mode travels with the flow instead of living on the account: committing one
   * reconnect while another is in flight must not change how that other flow lands.
   */
  reconnect?: true;
  /**
   * Set while a submission is being validated against Home Assistant, so a concurrent submission
   * cannot pass the same nonce; cleared again when validation fails so the user can resubmit.
   */
  connecting?: true;
}

type CompleteConnectionResult =
  | { kind: "ok"; handoff: ConnectHandoff }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

/**
 * The subject credentials pin the connection to: the Home Assistant instance itself, spelled by
 * its normalized base URL. Long-lived access tokens carry no user identity the API will report
 * back, so the instance is the only provable subject — a token for the SAME instance under a
 * DIFFERENT user passes the fence below, and that swap is undetectable here (it is only prevented
 * by the instance's own token discipline, not by this Gatekeeper).
 */
type HomeAssistantSubject = ConnectionSubject;

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    clearCredentialExpiryLatch(this.ctx.storage.kv);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
      reconnect: true,
    });
  }

  /**
   * Validates the nonce without claiming it, for the GET preview of the form. A submission that
   * fails validation releases its claim (see completeConnection), so the user can resubmit.
   */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(
    nonce: string,
    baseUrl: string,
    token: string,
  ): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.connecting || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }
    // Claim the nonce before the first await. The Durable Object's input gate does not cover the
    // outbound ping, so a second submission arriving meanwhile would otherwise validate the same
    // nonce, complete the connection a second time, and later revoke the account this one activated.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    // Validate that the URL+token can actually talk to HA.
    const creds: HomeAssistantCredentials = { baseUrl, token };
    try {
      const rest = new HomeAssistantRest(creds);
      await rest.ping();
    } catch (e: any) {
      this.#releaseNonceClaim(nonce);
      const msg = e instanceof HomeAssistantError
        ? e.message
        : `Unable to reach Home Assistant: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated — except a reconnect, whose submission may still
    // be refused below; that path releases its claim instead so the owner can resubmit.
    if (!stored.reconnect) this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      // Callback evicted — should not normally happen.
      return { kind: "error", message: "Connection callback expired. Please restart." };
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new credentials are only staged until the
      // Workshop has confirmed the browser that finished the flow is the owner's (see
      // commitReconnect). Bound gadgets keep reading the current token meanwhile. The connection
      // is pinned to its instance, so credentials for a different instance are refused outright —
      // nothing is staged — and the claim on the nonce is released so the owner can resubmit the
      // pinned instance's token. (A same-instance user-swap cannot be detected; see
      // HomeAssistantSubject.)
      const subject: HomeAssistantSubject = { id: baseUrl };
      const staged = stageReconnect<StoredCredentials, HomeAssistantSubject>(
        this.ctx.storage.kv, { baseUrl, token }, subject, Date.now(),
        (pinned, submitted) => ({
          title: "That's a different Home Assistant instance",
          detail: "This connection is for the Home Assistant instance at " + pinned.id +
            ", but you submitted credentials for " + submitted.id + ". Reconnect with a token " +
            "for " + pinned.id + ", or connect " + submitted.id + " as a separate account.",
        }));
      if ("refused" in staged) {
        this.#releaseNonceClaim(nonce);
        return { kind: "error", message: staged.refused.detail };
      }
      // Accepted: the nonce is spent.
      this.ctx.storage.kv.delete("nonce");
      try {
        handoff = await callback.reconnectComplete(staged.stageId);
      } catch (e) {
        return { kind: "error", message: `Failed to notify workshop: ${e instanceof Error ? e.message : e}` };
      }
    } else {
      this.ctx.storage.kv.put<StoredCredentials>("credentials", { baseUrl, token });
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      try {
        const props: HomeAssistantUserImplProps = { userObjectId: this.ctx.id.toString() };
        // The pin brackets the handoff: a connect that fails unpins and drops the credentials
        // stored ahead of it.
        handoff = await pinForConnect(this.ctx.storage.kv, { id: baseUrl },
          () => callback.complete(this.ctx.exports.HomeAssistantUserImpl({ props })),
          () => { this.ctx.storage.kv.delete("credentials"); });
      } catch (e) {
        return { kind: "error", message: `Failed to notify workshop: ${e instanceof Error ? e.message : e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  // Releases a failed submission's claim without reopening a nonce that another flow replaced while
  // this request was suspended. Synchronous storage makes the check and put one step.
  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || !stored.connecting || !constantTimeEqual(stored.value, nonce)) return;
    const { connecting: _, ...released } = stored;
    this.ctx.storage.kv.put<StoredNonce>("nonce", released);
  }

  /** Makes the credentials staged under `stageId` live; see GatekeeperUser.commitReconnect. The
   * kit's commit is fenced on the connection's pinned subject and re-pins the staged subject, so
   * an account made before the pin existed adopts its first reconnect's instance. */
  async commitReconnect(stageId: string): Promise<void> {
    const creds = commitReconnectOrThrow<StoredCredentials>(this.ctx.storage.kv, Date.now(), stageId);
    this.ctx.storage.kv.put<StoredCredentials>("credentials", creds);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  getCredentials(): HomeAssistantCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("Home Assistant credentials are not configured for this account.");
    }
    return creds;
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "homeassistant");
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type HomeAssistantUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class HomeAssistantUserImpl
  extends WorkerEntrypoint<Env, HomeAssistantUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<HomeAssistantCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#getCreds();
    const rest = new HomeAssistantRest(creds);
    let displayName = "Home Assistant";
    let uniqueName = creds.baseUrl;
    try {
      const config = await rest.getConfig();
      if (config?.location_name) displayName = `Home Assistant (${config.location_name})`;
      if (config?.location_name) uniqueName = `${config.location_name} @ ${creds.baseUrl}`;
    } catch (e) {
      if (e instanceof HomeAssistantError && e.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
      }
      // Ignore other failures; fall back to defaults.
    }
    return {
      displayName,
      uniqueName,
      avatar: HOMEASSISTANT_ICON,
    };
  }

  /** This gatekeeper does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const userAccount = this.#userAccount();
    const credsGetter = async () => await userAccount.getCredentials();

    switch (resourceUrlPattern) {
      case INSTANCE_RESOURCE.urlPattern:
        return {
          iframeHtml: INSTANCE_CONFIGURATOR_HTML,
          ui: new RpcStub(new InstanceConfiguratorUI(credsGetter)),
        };
      case AREA_RESOURCE.urlPattern:
        return {
          iframeHtml: AREA_CONFIGURATOR_HTML,
          ui: new RpcStub(new AreaConfiguratorUI(credsGetter)),
        };
      case LABEL_RESOURCE.urlPattern:
        return {
          iframeHtml: LABEL_CONFIGURATOR_HTML,
          ui: new RpcStub(new LabelConfiguratorUI(credsGetter)),
        };
      case DEVICE_RESOURCE.urlPattern:
        return {
          iframeHtml: DEVICE_CONFIGURATOR_HTML,
          ui: new RpcStub(new DeviceConfiguratorUI(credsGetter)),
        };
      case ENTITY_RESOURCE.urlPattern:
        return {
          iframeHtml: ENTITY_CONFIGURATOR_HTML,
          ui: new RpcStub(new EntityConfiguratorUI(credsGetter)),
        };
      default:
        throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error(`Invalid Home Assistant URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme for Home Assistant: ${parsed.protocol}`);
    }

    const userObjectId = this.ctx.props.userObjectId;

    // Detect a "fine-grained" resource URL: https://homeassistant.local/_resource/<kind>/<id>
    if (parsed.hostname === "homeassistant.local") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments[0] === "_resource" && segments.length >= 3) {
        const kind = segments[1];
        const id = decodeURIComponent(segments.slice(2).join("/"));
        // Build props fresh in each case with `resourceKind` set explicitly, so adding a new
        // granularity later cannot silently fall through into a default value.
        switch (kind) {
          case "area":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "area", resourceId: id },
              }),
              resource: AREA_RESOURCE,
            };
          case "label":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "label", resourceId: id },
              }),
              resource: LABEL_RESOURCE,
            };
          case "device":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "device", resourceId: id },
              }),
              resource: DEVICE_RESOURCE,
            };
          case "entity":
            return {
              class: this.ctx.exports.HomeAssistantGatekeeperImpl({
                props: { userObjectId, resourceKind: "entity", resourceId: id },
              }),
              resource: ENTITY_RESOURCE,
            };
          default:
            throw new Error(`Unsupported Home Assistant resource kind: ${kind}`);
        }
      }
    }

    // Any other http(s) URL is treated as whole-instance access against the connected account.
    return {
      class: this.ctx.exports.HomeAssistantGatekeeperImpl({
        props: { userObjectId, resourceKind: "instance" },
      }),
      resource: INSTANCE_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  /**
   * Mint a verifier representing this account. Home Assistant uses the "low-stakes" observer
   * strategy (see HomeAssistantGatekeeperImpl.addObserver): it is a self-hosted personal system,
   * and its long-lived access token is all-or-nothing (HA exposes no per-user/per-entity ACL we
   * could verify an observer against), so there is nothing meaningful to check. The verifier
   * carries no identity and is never consulted — but the overseer mints one on every open, so it
   * must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.HomeAssistantVerifier({});
  }
}

// A trivial verifier since Home Assistant's observer strategy is low-stakes.
@validateRpc()
export class HomeAssistantVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
