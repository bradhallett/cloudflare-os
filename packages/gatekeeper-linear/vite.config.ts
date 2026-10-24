import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus the
 * package's `test` task. Every test here exercises RpcTarget/Durable Object behaviour in workerd,
 * so the task is the single workerd pass (there is no Node suite to keep a separate command for).
 * The workerd suite imports the generated configurator modules, so `test` generates them first --
 * a cold checkout (CI) has no earlier build to have left them behind.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      test: {
        ...vitestTask(["vitest run -c vitest.worker.config.ts"]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
