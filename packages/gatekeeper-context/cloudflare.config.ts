import {
  CAPNWEB_VALIDATE_BUILD, bindings, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-context",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["nodejs_compat"],

  env: {
    // Public-collections snapshot KV. The preview id in `wrangler` preserves existing dev data.
    CONTEXT_COLLECTIONS: bindings.kv(),
    // Optional: add an Artifacts binding named ARTIFACTS to enable Git-backed collections.
  },

});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  kvPreviewIds: { CONTEXT_COLLECTIONS: "gadgets-context-collections" },
} satisfies WranglerExtras;

/** DO classes are reached via ctx.exports; no durable_objects binding needed. */
export const migrations: DurableObjectMigration[] = [
  {
    tag: "v0",
    new_sqlite_classes: [
      "ContextCollectionDurableObject",
      "UserLibraryDurableObject",
      "LibraryRegistryDurableObject",
      "ContextGatekeeper",
    ],
  },
];
