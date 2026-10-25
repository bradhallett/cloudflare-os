import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-composio",
  entrypoint: ".wrangler/validate/src/worker.ts",
  // `allow_irrevocable_stub_storage`: hook initiator stubs (triggers land in PR 4, the flag ships
  // with the worker so the migration never changes). `global_fetch_strictly_public` is required,
  // not hygiene: `session.mcp.url` is third-party response data that never passes user-pasted
  // validation. `nodejs_als` backs the observability context.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** All Durable Objects are reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["ComposioAccount", "ComposioSingletonGatekeeper", "ComposioToolkitGatekeeper"] },
];
