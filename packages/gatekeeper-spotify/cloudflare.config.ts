import {
  DEFAULT_GATEKEEPER_WRANGLER, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-spotify",
  entrypoint: ".wrangler/validate/src/spotify.ts",
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "SpotifyGatekeeperImpl"] },
];
