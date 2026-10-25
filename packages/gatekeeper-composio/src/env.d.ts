// Project-specific Env/ctx.exports augmentation for Wrangler's generated types, following the
// gatekeeper-context pattern: the runtime baseline lives in worker-configuration.d.ts and this
// file adds this connector's settings and the main module's exports.

declare namespace Cloudflare {
  interface Env {
    /** The deployment's Composio project API key (deploy-inputs.json secret). Fail-closed when unset. */
    COMPOSIO_API_KEY?: string;
    /** Per-user, per-UTC-day deployment-key call limit; unset means 500 (see config.ts). */
    COMPOSIO_DAILY_CALL_LIMIT?: string;
    /** Where browsers reach this worker; joins Connect Link callback URLs. */
    BASE_URL?: string;
    /**
     * The public origin Composio delivers webhook events to. Placeholder for PR 4 (triggers and
     * webhooks); nothing in PR 3 reads it.
     */
    WEBHOOK_ORIGIN?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./worker.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ComposioAccount"
      | "ComposioSingletonGatekeeper"
      | "ComposioToolkitGatekeeper";
  }
}
