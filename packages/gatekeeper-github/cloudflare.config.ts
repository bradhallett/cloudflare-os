import {
  DEFAULT_GATEKEEPER_WRANGLER, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-github",
  entrypoint: ".wrangler/validate/src/github.ts",
  compatibilityFlags: ["nodejs_als"],
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GitHubGatekeeperImpl"] },
  { tag: "v1", new_sqlite_classes: ["GitHubHookDriver"] },
];
