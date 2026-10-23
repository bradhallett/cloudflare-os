import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-homeassistant",
  entrypoint: ".wrangler/validate/src/homeassistant.ts",

  // The instance base URL is user-supplied, and the protocol check at connect time cannot see
  // through a public hostname that resolves (or rebinds) to a private address. This flag is the
  // real SSRF boundary: workerd rejects reserved ranges -- loopback, RFC1918, link-local, cloud
  // metadata -- *after* DNS resolution, which is the only place the check can be sound. It does
  // not break legitimate instances: a deployed Worker has no route to a private network anyway,
  // so reachable instances are public hostnames (Nabu Casa, tunnels), and `wrangler dev`
  // reconfigures its outbound to permit any address, keeping local instances usable in dev.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],

  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "HomeAssistantGatekeeperImpl"] },
];
