import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        // nodejs_als enables observability context; experimental enables the Reporter stub below
        // and the streaming_tail_worker flag (which workerd refuses without experimental mode).
        compatibilityFlags: ["experimental", "nodejs_als", "streaming_tail_worker"],
        serviceBindings: {
          ERROR_REPORTER: { name: "reporter", entrypoint: "ErrorReporter" },
        },
        // Invocations are only traced (span.isTraced === true) when a tail consumer is attached;
        // the no-op "span-sink" below exists solely so tracing.test.ts can observe span lifetime.
        tails: ["span-sink"],
        workers: [{
          name: "span-sink",
          modules: true,
          compatibilityDate: COMPATIBILITY_DATE,
          // The sink opts into the streaming tail path (workerd refuses tailStream without it;
          // see tracing.test.ts's header) — the same experimental mode the main pool enables.
          compatibilityFlags: ["streaming_tail_worker"],
          // The no-op tail() silences workerd's legacy tail delivery, which it attempts alongside
          // the streaming path.
          script: `export default { tail: () => {}, tailStream: () => () => {} }`,
        }, {
          name: "reporter",
          modules: true,
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";
            let lastEvent;
            export class ErrorReporter extends WorkerEntrypoint {
              async report(event) {
                // The "reporter-failure" site simulates a down reporter so the caller's
                // isolation can be tested. workerd logs this guest throw server-side
                // ("Error: reporter down" attributed to ErrorReporter.report) — that line is
                // expected test output, not a failure in reportIssue.
                if (event.failureSite === "reporter-failure") {
                  throw new Error("reporter down");
                }
                lastEvent = event;
              }
              async clear() { lastEvent = undefined; }
              async getLast() { return lastEvent; }
            }
          `,
        }],
      },
    }),
  ],
  test: {
    testTimeout: 60_000,
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started; only two files here import `cloudflare:workers`, so the
    // rest would pass under a Node fallback without noticing.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
