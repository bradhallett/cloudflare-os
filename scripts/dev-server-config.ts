import { join } from "node:path";

import { releaseShortName } from "./release/manifest-lib.ts";

/**
 * The port a `VITE_BACKEND_HOST` names, as a string, or null when it names no port. Throws on a
 * value that is not a bare `host[:port]`.
 */
export function getWranglerPortFromBackendHost(backendHost: string): string | null {
  const trimmed = backendHost.trim();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    if (/(^.*\]:|^[^:]+:)[^:]+$/.test(trimmed)) {
      throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
    }
    throw new Error("VITE_BACKEND_HOST must include a valid host with an optional port.");
  }

  if (!url.port) return null;

  const port = Number(url.port);
  if (port < 1) {
    throw new Error("VITE_BACKEND_HOST must include a valid port between 1 and 65535.");
  }

  return url.port;
}

/**
 * Resolve where the dev server's backend lives: an explicit `--port` wins, else
 * `VITE_BACKEND_HOST`, else `localhost:8787`.
 */
export function getDevServerConfig(args: readonly string[], envBackendHost?: string): {
  backendHost: string;
  wranglerPort: string | null;
} {
  let commandLinePort: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--port" && !arg.startsWith("--port=")) continue;

    if (commandLinePort !== null) {
      throw new Error("--port may only be specified once.");
    }

    const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
    if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) {
      throw new Error("--port must be an integer between 1 and 65535.");
    }
    commandLinePort = String(Number(value));
  }

  if (commandLinePort !== null) {
    return {
      backendHost: `localhost:${commandLinePort}`,
      wranglerPort: commandLinePort,
    };
  }

  const backendHost = envBackendHost?.trim() || "localhost:8787";
  return {
    backendHost,
    wranglerPort: getWranglerPortFromBackendHost(backendHost),
  };
}

/**
 * The `-c` config list for the dev session's multi-config `wrangler dev`, which starts from the
 * repo root: the dev-router, the workshop backend, then every gatekeeper and overlay plain worker.
 *
 * The backend is a core package that is neither a gatekeeper nor an overlay plain worker, so no
 * scan filter ever selects it — yet the dev-router binds it as WORKSHOP_BACKEND, and Wrangler
 * answers 503 "Worker ... not found" for a service binding whose target is not in the same dev
 * session. It is named explicitly here, where a test can pin that, because run-dev-server.ts is
 * a top-to-bottom script that spawns Wrangler at import time and so cannot be imported by one.
 */
export function devWranglerConfigs(
  { backendDir, gatekeepers, plainWorkers }: {
    /** The workshop backend's package directory (WORKSHOP_BACKEND_DIR in run-dev-server.ts). */
    backendDir: string;
    /** Gatekeeper packages, as `readDeployablePackages` finds them. */
    gatekeepers: readonly { dir: string }[];
    /** Overlay plain workers: non-gatekeeper packages from extra scan roots. */
    plainWorkers: readonly { dir: string }[];
  },
): string[] {
  return [
    "wrangler.dev.jsonc",
    join(backendDir, "wrangler.dev.jsonc"),
    ...gatekeepers.map((gk) => join(gk.dir, "wrangler.dev.jsonc")),
    ...plainWorkers.map((pkg) => join(pkg.dir, "wrangler.dev.jsonc")),
  ];
}

/**
 * The base URL the dev server tells a gatekeeper it is served at, behind the dev router.
 *
 * Uses the folded release shortName (`gatekeeperBindingName` in manifest-lib.ts is the matching
 * binding spelling), because production serves every gatekeeper at that folded path — customer
 * deployments registered their OAuth redirect URIs against it, so `gatekeeper-mcp-portal` is
 * `/gatekeeper/mcpportal` in dev too, never `/gatekeeper/mcp-portal`.
 */
export function gatekeeperBaseUrl(pkgName: string, backendHost: string): string {
  return `http://${backendHost}/gatekeeper/${releaseShortName(pkgName)}`;
}
