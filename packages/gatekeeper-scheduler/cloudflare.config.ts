import {
  CAPNWEB_VALIDATE_BUILD, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-scheduler",
  entrypoint: ".wrangler/validate/src/worker.ts",
  compatibilityFlags: ["nodejs_als"],
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/** Both Durable Objects are reached through ctx.exports; no binding is required. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["ScheduleDriver", "SchedulerGatekeeper"] },
];
