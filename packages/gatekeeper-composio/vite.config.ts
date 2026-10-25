import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ settings for this package. The management app's own build config lives in
 * `vite.app.config.ts`; Vite+ reads per-package settings only from `vite.config.*`, so the two
 * cannot share a file. There is no configurator build (see plans/composio-gatekeeper.md §Surface:
 * the one SupportedResource is a plain URL pattern with no user inputs).
 */
export default defineConfig({
  run: {
    tasks: {
      // Node suite (pure logic) plus the workerd suite; see the module for why the vitest scratch
      // paths have to be excluded for this to cache at all.
      test: vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
      "clean:error-reporting-artifacts": {
        command: "gadgets-clean-error-reporting .",
        cache: false,
      },
      "build:app": {
        command: "node build-app.ts",
        dependsOn: ["clean:error-reporting-artifacts"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/dist-app/**", base: "workspace" },
            { pattern: "!**/src/generated/**", base: "workspace" },
            { pattern: "!**/.wrangler/**", base: "workspace" },
          ],
          output: ["dist-app/**", "src/generated/app.txt"],
          env: ["VITE_FRONTEND_ERROR_REPORTING"],
        },
      },
      "build:app:dev": {
        command: "node build-app.ts --dev",
        dependsOn: ["clean:error-reporting-artifacts"],
        cache: {
          input: [
            { auto: true },
            { pattern: "!**/dist-app/**", base: "workspace" },
            { pattern: "!**/src/generated/**", base: "workspace" },
            { pattern: "!**/.wrangler/**", base: "workspace" },
          ],
          output: ["src/generated/app.txt"],
          env: ["VITE_FRONTEND_ERROR_REPORTING"],
        },
      },
    },
  },
});
