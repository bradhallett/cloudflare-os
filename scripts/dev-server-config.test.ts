import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";

import {
  devWranglerConfigs,
  gatekeeperBaseUrl,
  getDevServerConfig,
  getWranglerPortFromBackendHost,
} from "./dev-server-config.ts";
import { isGatekeeperPackage, readDeployablePackages } from "./release/manifest-lib.ts";
import { resolveScanRoots } from "./scan-roots.ts";

describe("gatekeeperBaseUrl", () => {
  it("mounts a single-word gatekeeper at its own name", () => {
    assert.equal(gatekeeperBaseUrl("gatekeeper-google", "localhost:8787"),
        "http://localhost:8787/gatekeeper/google");
  });

  // The dev router binds gatekeepers as the deploy service does (GATEKEEPER_<folded slug>), so
  // the URL the gatekeeper is told it serves at has to use the same fold: production serves
  // gatekeeper-mcp-portal at /gatekeeper/mcpportal, and customer deployments registered their
  // OAuth redirect URIs against that path — dev must not spell it "mcp-portal".
  it("folds a multi-word gatekeeper to its production slug", () => {
    assert.equal(gatekeeperBaseUrl("gatekeeper-mcp-portal", "localhost:8787"),
        "http://localhost:8787/gatekeeper/mcpportal");
  });

  it("uses the configured backend host", () => {
    assert.equal(gatekeeperBaseUrl("gatekeeper-x", "tunnel.example.com:9000"),
        "http://tunnel.example.com:9000/gatekeeper/x");
  });
});

describe("getWranglerPortFromBackendHost", () => {
  it("extracts a port from a localhost backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:9000"), "9000");
  });

  it("extracts a port from an IPv6 backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("[::1]:9001"), "9001");
  });

  it("returns null when the backend host has no port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost"), null);
  });

  it("rejects invalid ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid IPv6 ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("[::1]:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects port zero", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:0"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid hosts", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("http://localhost:9000"),
        /VITE_BACKEND_HOST must include a valid host/);
  });
});

describe("getDevServerConfig", () => {
  it("uses VITE_BACKEND_HOST as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig([], "localhost:9000"), {
      backendHost: "localhost:9000",
      wranglerPort: "9000",
    });
  });

  it("uses --port as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig(["--port", "8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  it("accepts --port=value", () => {
    assert.deepEqual(getDevServerConfig(["--port=8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  for (const args of [["--port"], ["--port", "nope"], ["--port=0"], ["--port=65536"]]) {
    it(`rejects invalid arguments: ${args.join(" ")}`, () => {
      assert.throws(() => getDevServerConfig(args), /--port must be an integer between 1 and 65535/);
    });
  }
});

describe("devWranglerConfigs", () => {
  it("spawns the workshop backend beside the dev-router, before the gatekeepers", () => {
    assert.deepEqual(
        devWranglerConfigs({
          backendDir: "/repo/packages/workshop-backend",
          gatekeepers: [{ dir: "/repo/packages/gatekeeper-github" }],
          plainWorkers: [],
        }),
        [
          "wrangler.dev.jsonc",
          "/repo/packages/workshop-backend/wrangler.dev.jsonc",
          "/repo/packages/gatekeeper-github/wrangler.dev.jsonc",
        ]);
  });

  // The regression this pins: 553a48c5 rebuilt this list from the package scan's gatekeeper and
  // overlay-plain-worker filters, which select everything except the backend, and every /api
  // request came back 503 "Worker workshop-backend not found". The backend is a core package that
  // no filter ever selects, so the empty-scan case is the one that must still spawn it.
  it("still spawns the backend when the scan finds no other workers", () => {
    assert.deepEqual(
        devWranglerConfigs({
          backendDir: "/repo/packages/workshop-backend",
          gatekeepers: [],
          plainWorkers: [],
        }),
        ["wrangler.dev.jsonc", "/repo/packages/workshop-backend/wrangler.dev.jsonc"]);
  });

  it("spawns overlay plain workers after the gatekeepers", () => {
    assert.deepEqual(
        devWranglerConfigs({
          backendDir: "/repo/packages/workshop-backend",
          gatekeepers: [{ dir: "/repo/packages/gatekeeper-x" }],
          plainWorkers: [{ dir: "/overlay/saas-billing" }],
        }),
        [
          "wrangler.dev.jsonc",
          "/repo/packages/workshop-backend/wrangler.dev.jsonc",
          "/repo/packages/gatekeeper-x/wrangler.dev.jsonc",
          "/overlay/saas-billing/wrangler.dev.jsonc",
        ]);
  });

  it("spawns every worker the dev-router binds on a clean core checkout", () => {
    // A service binding whose target worker is not in the same multi-config `wrangler dev`
    // session answers every request with 503 "Worker ... not found", so every worker the router
    // binds must have its config in the -c list: the backend, from the committed wrangler.jsonc,
    // and each gatekeeper, bound at startup from the same scan.
    const packages = readDeployablePackages(resolveScanRoots([]));
    const backend = packages.find((pkg) => pkg.name === "workshop-backend");
    assert.ok(backend, "the core package scan does not find workshop-backend");
    const gatekeepers = packages.filter((pkg) => isGatekeeperPackage(pkg.name));
    const plainWorkers =
        packages.filter((pkg) => pkg.overlay === true && !isGatekeeperPackage(pkg.name));
    const configs = devWranglerConfigs({ backendDir: backend.dir, gatekeepers, plainWorkers });

    const router = parse(readFileSync("wrangler.jsonc", "utf8")) as {
      services?: { service: string }[];
    };
    const boundWorkers = [
      ...(router.services?.map((service) => service.service) ?? []),
      ...gatekeepers.map((gk) => gk.name),
    ];
    assert.ok(
        boundWorkers.includes("workshop-backend"),
        "the dev-router no longer binds WORKSHOP_BACKEND, so this test has gone vacuous");

    for (const name of boundWorkers) {
      const pkg = packages.find((p) => p.name === name);
      assert.ok(pkg, `the dev-router binds ${name}, which the package scan does not find`);
      const devConfig = join(pkg.dir, "wrangler.dev.jsonc");
      assert.ok(
          configs.includes(devConfig),
          `the dev-router binds ${name} but the dev session does not spawn it: ` +
          `${devConfig} is not in the -c list`);
    }
  });
});
