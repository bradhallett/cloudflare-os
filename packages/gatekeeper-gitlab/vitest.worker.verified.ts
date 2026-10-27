import { defineConfig } from "vitest/config";
import config from "./vitest.worker.config";

/**
 * Verification-only wrapper for the pre-existing txt-module config-load timing race
 * (see /tmp/tn4/fix-FixInfraQuick.md): the extra async delay moves the config load past the
 * race window. Uncommitted; removed before any PR.
 */
export default defineConfig(async () => {
  await new Promise(resolve => setTimeout(resolve, 1500));
  return config as never;
});
