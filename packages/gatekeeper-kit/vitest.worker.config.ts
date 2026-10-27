import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

/** These suites require workerd-only APIs and persistent verifier-stub storage. */
export default defineConfig({
  plugins: [cloudflareTest({
    main: "./__tests__/workerd/worker.ts",
    miniflare: {
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["allow_irrevocable_stub_storage"],
      durableObjects: {
        TRACKER_HOST: { className: "TrackerHost", useSQLite: true },
        CONFORMANCE_ACCOUNT: { className: "ConformanceAccount", useSQLite: true },
        CONFORMANCE_RESOURCE: { className: "ConformanceResource", useSQLite: true },
      },
    },
  })],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
