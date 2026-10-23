import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the account Durable Object's credentials and identity, and the connect
 * flow's refusal to reconnect as a different Supabase account. The `@validateRpc()` decorators
 * are applied in-memory by the capnweb-validate plugin, since `.wrangler/validate` is not built
 * for tests.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
          BASE_URL: "http://localhost:8787/gatekeeper/supabase",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
