import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyRelease } from "./verify-release.ts";

/** A release dir holding one worker whose every module blob is on disk, as `build-release` writes. */
function releaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
  mkdirSync(join(dir, "modules"));
  const sha256 = "a".repeat(64);
  writeFileSync(join(dir, "modules", sha256), "blob");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    workers: {
      "saas-billing": {
        mainModule: "worker.ts",
        modules: [{ name: "worker.ts", type: "esm", sha256, size: 4, r2Key: `blobs/modules/${sha256}` }],
      },
    },
  }));
  return dir;
}

test("a complete release verifies, reporting the worker count", () => {
  const dir = releaseDir();
  try {
    assert.equal(verifyRelease(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing module blob fails, naming the worker and the hash", () => {
  const dir = releaseDir();
  try {
    rmSync(join(dir, "modules"), { recursive: true });
    assert.throws(() => verifyRelease(dir), /saas-billing module blob missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest with no workers, or a worker without a main module, fails", () => {
  const empty = releaseDir();
  try {
    writeFileSync(join(empty, "manifest.json"), JSON.stringify({ workers: {} }));
    assert.throws(() => verifyRelease(empty), /manifest lists no workers/);
    writeFileSync(join(empty, "manifest.json"), JSON.stringify({
      workers: { "saas-billing": { modules: [] } },
    }));
    assert.throws(() => verifyRelease(empty), /saas-billing has no main module/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
