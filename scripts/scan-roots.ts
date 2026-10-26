// Extra deployable-package scan roots: how a private overlay workspace ships its own workers
// through this repo's scripts. Deployable discovery keys on a wrangler.jsonc in any direct child
// of a root directory, and every discovery site — config generation
// (generate-worker-configs.ts), the dev server (run-dev-server.ts), staging previews
// (preview/staging-config.ts), the release build (release/build-release.ts) and the manifest
// golden test (release/manifest-lib.test.ts) — resolves its roots through this module so those
// surfaces cannot drift.

import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The repo's own packages directory: always scanned, and always the FIRST root
 * {@link resolveScanRoots} returns. Packages found only under later roots are overlay packages
 * (`DeployablePackage.overlay` in release/manifest-lib.ts), which classify more permissively —
 * core package names must still classify under core's own rules.
 */
export const DEFAULT_PACKAGES_DIR = join(ROOT, "packages");

/**
 * Extra scan roots named by repeatable `--scan-root <dir>` flags, in order. Every other argument
 * is ignored, so callers whose own parsing is strict about unknown flags (build-release.ts) can
 * throw on those themselves while delegating `--scan-root` here.
 */
export function scanRootArgs(argv: readonly string[]): string[] {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--scan-root") continue;
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error(`--scan-root must be followed by a directory path, got: ${value ?? "nothing"}`);
    }
    roots.push(value);
  }
  return roots;
}

/**
 * The scan roots to read deployable packages from: the repo's packages/ dir, then the given extra
 * roots (typically {@link scanRootArgs} output), then any in the WORKER_SCAN_ROOTS env var
 * (path.delimiter-separated, so a pnpm script can add a root without argv plumbing). Absolute,
 * deduplicated, in that order.
 */
export function resolveScanRoots(extraRoots: readonly string[]): string[] {
  const fromEnv = (process.env.WORKER_SCAN_ROOTS ?? "").split(delimiter).filter(Boolean);
  return [...new Set([DEFAULT_PACKAGES_DIR, ...extraRoots, ...fromEnv].map((dir) => resolve(dir)))];
}
