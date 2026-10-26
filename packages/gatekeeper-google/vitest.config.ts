import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Declaration compilation needs headroom when the full graph shares cloud CPUs.
    testTimeout: 15_000,
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // The kit's cursor engine (see src/cursor.ts) declares `RpcTarget`s, which only exist inside
      // workerd; this lets the Node-pool suites that page through it import it at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
