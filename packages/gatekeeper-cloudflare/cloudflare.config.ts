import {
  DEFAULT_GATEKEEPER_WRANGLER, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-cloudflare",
  entrypoint: ".wrangler/validate/src/cloudflare.ts",
  compatibilityFlags: ["nodejs_als"],
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount"] },
  { tag: "v1", new_sqlite_classes: ["CloudflareObservabilityGatekeeper"] },
];
