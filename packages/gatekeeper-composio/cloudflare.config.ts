import {
  CAPNWEB_VALIDATE_BUILD, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-composio",
  entrypoint: ".wrangler/validate/src/worker.ts",
  // `global_fetch_strictly_public` is required, not hygiene: every Composio fetch must land on
  // the fixed config base URLs, never a host from third-party response data. `nodejs_als` backs
  // the observability context.
  compatibilityFlags: ["global_fetch_strictly_public", "nodejs_als"],
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** All Durable Objects are reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["ComposioAccount", "ComposioSingletonGatekeeper", "ComposioToolkitGatekeeper"] },
];
