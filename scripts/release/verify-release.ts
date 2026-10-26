#!/usr/bin/env node

// Verifies a built release directory: the manifest lists at least one worker, every worker has a
// main module, and every module blob the manifest names exists on disk at `modules/<sha256>`. CI's
// release-smoke job runs this after `build-release.ts` — whose own exit code is the main gate —
// to catch a build that "succeeds" while emitting a manifest whose blobs are not all on disk; the
// internal pipeline can run the same check against a candidate mirror.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReleaseManifest } from "./manifest-lib.ts";

/** Verify the release in `outDir`, throwing on the first broken invariant. */
export function verifyRelease(outDir: string): number {
  const out = resolve(outDir);
  const manifest: ReleaseManifest = JSON.parse(readFileSync(`${out}/manifest.json`, "utf8"));
  const workers = Object.entries(manifest.workers);
  if (workers.length === 0) throw new Error("release smoke: manifest lists no workers");
  for (const [name, worker] of workers) {
    if (worker.mainModule === undefined) {
      throw new Error(`release smoke: ${name} has no main module`);
    }
    for (const mod of worker.modules) {
      if (!existsSync(`${out}/modules/${mod.sha256}`)) {
        throw new Error(`release smoke: ${name} module blob missing: ${mod.sha256}`);
      }
    }
  }
  console.log(`release smoke: ${workers.length} workers, all module blobs present`);
  return workers.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag !== -1 ? process.argv[outFlag + 1] : undefined;
  if (!outDir) throw new Error("usage: verify-release.ts --out <dir>");
  verifyRelease(outDir);
}
