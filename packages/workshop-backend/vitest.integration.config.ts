import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);

// Records the member-sync snapshots and answers the read paths of the optional SAAS_COMMERCE
// port, so the commerce RPC tests exercise the real service-binding seam end to end (see
// __integration__/commerce-rpc.test.ts). Canned answers only; it holds no state of its own
// beyond what the tests read back.
const commerceStub = `
import { WorkerEntrypoint } from "cloudflare:workers";
const memberSyncs = [];
const checkouts = [];
export class CommerceStub extends WorkerEntrypoint {
  listPlans() { return [{ id: "pro", name: "Pro" }]; }
  getOrgBilling() {
    return {
      plan: "pro", seats: 5, assignedSeats: 2, subscriptionStatus: "active",
      monthlySpendCapUsd: 50, overageAllowed: false,
      usage: {
        cycleStart: new Date(0), inputTokens: 101, cacheReadTokens: 13,
        cacheWriteTokens: 17, outputTokens: 19, estimatedCostUsd: 0.5,
      },
    };
  }
  startCheckout(query) { checkouts.push(query); return { url: "https://checkout.example/s/" + query.orgId }; }
  createPortalSession(query) { return { url: "https://portal.example/p/" + query.orgId }; }
  orgMembersChanged(snapshot) { memberSyncs.push(snapshot); }
  memberSyncs() { return memberSyncs; }
  checkouts() { return checkouts; }
  reset() { memberSyncs.length = 0; checkouts.length = 0; }
}
`

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      // The commerce seam needs what wrangler.jsonc deliberately leaves unset (an OSS
      // deployment binds neither): the port itself, and the origin billing flows return to.
      // Nothing else in this suite reads either binding.
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        serviceBindings: {
          SAAS_COMMERCE: { name: "commerce-stub", entrypoint: "CommerceStub" },
        },
        workers: [
          {
            name: "commerce-stub",
            modules: true,
            script: commerceStub,
            compatibilityDate: COMPATIBILITY_DATE,
          },
        ],
        bindings: { PUBLIC_BASE_URL: "https://workshop.example/" },
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      // The reset-recovery tests abort every Durable Object mid-session; capabilities that were
      // held across the abort (e.g. the fire-and-forget AdminSettings install kicked off by the
      // fetch handler) reject on their own schedule, independent of any awaited call.
      if (error.message?.includes("abortAllDurableObjects")) return false;
      // Same, for the test that aborts only the user DO (state.abort with this reason).
      if (error.message?.includes("user-DO reset injected by test")) return false;
    },
  },
});
