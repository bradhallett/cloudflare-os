import { describe, expect, it } from "vitest";
import { startHarness, TEST_GATEKEEPER_DIR } from "../src/harness";

// Production binds gatekeepers as GATEKEEPER_<SLUG> with the deploy service's install-slug
// charset (SLUG_RE in scripts/release/manifest-lib.ts). The harness must refuse anything else:
// an environment it would happily boot — a vendor id of "my_gk" against a route of
// /gatekeeper/my-gk — is a topology no customer instance can have. The validation runs before any
// worker boots, so these cases are cheap refusals.
describe("harness gatekeeper binding validation", () => {
  it.each(["MY_GK", "my-gk", "my.gk", "1st", "x".repeat(21)])(
      "rejects the binding %j before booting anything",
      async (binding) => {
        await expect(
            startHarness({ gatekeepers: [{ binding, dir: TEST_GATEKEEPER_DIR }] }),
        ).rejects.toThrow(/cannot exist in production/);
      });
});
