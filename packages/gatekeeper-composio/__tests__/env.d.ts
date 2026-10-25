/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`, so the
// test-only binding is declared by augmenting that — which is what lets the tests read `env`
// without a cast (pattern from gatekeeper-cloudflare's suite).

import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // The gatekeeper Durable Objects are bound in `vitest.worker.config.ts`, not
      // `cloudflare.config.ts`, so they too are absent from the generated types.
      COMPOSIO_ACCOUNT: DurableObjectNamespace<import("./worker.js").ComposioAccount>;
      COMPOSIO_SINGLETON: DurableObjectNamespace<
        import("./worker.js").ComposioSingletonGatekeeper
      >;
      COMPOSIO_TOOLKIT: DurableObjectNamespace<
        import("./worker.js").ComposioToolkitGatekeeper
      >;
      // Declared in `vitest.worker.config.ts` rather than `cloudflare.config.ts`, so it is absent
      // from the generated `worker-configuration.d.ts`.
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
    }
  }
}
