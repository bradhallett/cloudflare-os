import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The workerd project: the account Durable Object's credentials and identity, the connect
 * flow's refusal to reconnect as a different Supabase account, and the gatekeeper's
 * claim-before-apply lifecycle. The `@validateRpc()` decorators are applied in-memory by the
 * capnweb-validate plugin, since `.wrangler/validate` is not built for tests.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          // The gatekeeper reads `ctx.props`, and a `DurableObjectClass` carrying props is only
          // reachable through `ctx.facets` — so the tests drive it from a hook Durable Object,
          // exactly as the overseer does in production, rather than a plain namespace binding.
          SUPABASE_GATEKEEPER: { className: "SupabaseGatekeeperImpl", useSQLite: true },
          // The gatekeeper with action-staging hooks (see worker.ts), registered so `ctx.exports`
          // carries it.
          SEEDED_SUPABASE_GATEKEEPER: { className: "SeededSupabaseGatekeeper", useSQLite: true },
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
