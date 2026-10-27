import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

/**
 * The shared gatekeeper-configurator tasks plus the validated entrypoint this package's own suite
 * runs against. The worker's entrypoint is `.wrangler/validate/src/mcp.ts` (see
 * `cloudflare.config.ts`), and vitest's default glob runs the test copies capnweb-validate writes
 * under the tree, so `test` needs a fresh tree; unlike the packages `integration-tests` boots,
 * nothing else rebuilds it. The tree is cached as the `build:integration-worker` tasks are:
 * `.wrangler` is left out of the inputs, since the build writes it, and named as the output, so a
 * cache hit has to leave the tree on disk for the suite to read.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      "build:validate": {
        command: withTestTimeout("capnweb-validate build --out .wrangler/validate"),
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
          output: [".wrangler/validate/**"],
        },
      },
      test: {
        ...vitestTask("vitest run"),
        dependsOn: ["build:validate"],
      },
    },
  },
};
