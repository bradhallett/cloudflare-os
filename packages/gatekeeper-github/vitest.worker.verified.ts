import { defineConfig } from "vitest/config";
import config from "./vitest.worker.config";

export default defineConfig(async () => {
  console.log("VERIFIED-WRAPPER APPLIED");
  await new Promise(resolve => setTimeout(resolve, 1500));
  return config as never;
});
