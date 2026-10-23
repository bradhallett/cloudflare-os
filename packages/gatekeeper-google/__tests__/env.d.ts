/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suites' environment. The pools type `env` as `Cloudflare.Env`, so the
// test-only bindings, declared in the vitest configs rather than `wrangler.jsonc`, are added by
// augmenting it.

import type { TestHooks } from "./worker.js";
import type { UserAccount } from "../src/google.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      UserAccount: DurableObjectNamespace<UserAccount>;
    }
  }
}
