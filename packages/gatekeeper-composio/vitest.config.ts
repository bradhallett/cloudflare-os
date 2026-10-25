import { defineConfig } from "vitest/config";

/** Pure-logic tests (classification, settlement map, policy chokepoint, quotas) run in Node. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
