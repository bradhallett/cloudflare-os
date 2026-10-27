import {
  DEFAULT_GATEKEEPER_WRANGLER, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-confluence",
  entrypoint: ".wrangler/validate/src/confluence.ts",
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  {
    tag: "v0",
    new_sqlite_classes: [
      "UserAccount",
      "ConfluenceSiteGatekeeperImpl",
      "ConfluenceSpaceGatekeeperImpl",
      "ConfluenceContentGatekeeperImpl",
    ],
  },
];
