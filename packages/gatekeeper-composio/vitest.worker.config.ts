import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd: Durable Object props (account, facets), the queued-action
 * store on facet SQLite, keyMode generation fencing, the input_required continuation lifecycle,
 * and observer consent admission are all built on `RpcTarget`/`RpcStub`/Durable Objects. The
 * gatekeeper DOs read `ctx.props`, and a `DurableObjectClass` carrying props is only reachable
 * through `ctx.facets` -- so the tests drive them from a hook Durable Object, exactly as the
 * overseer does in production.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          COMPOSIO_ACCOUNT: { className: "ComposioAccount", useSQLite: true },
          COMPOSIO_SINGLETON: { className: "ComposioSingletonGatekeeper", useSQLite: true },
          COMPOSIO_TOOLKIT: { className: "ComposioToolkitGatekeeper", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
