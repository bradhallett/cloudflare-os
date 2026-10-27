import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The deploy-config var registry, and why it needs a guard.
 *
 * `packages/workshop-backend/src/env.d.ts` is the canonical list of deployment-configurable
 * backend vars: a declaration there is the type-level half of a contract whose other halves live
 * in three places that cannot see each other -- `run-dev-server.ts`'s OPTIONAL_FEATURE_VARS (what
 * a dev shell can pass into a local backend), `preview/staging-config.ts`'s resolver families
 * (what a preview deployment configures), and the deploy service's PUT-time injection (documented
 * as a prose contract in `release/manifest-lib.ts`, since that service lives outside this repo).
 * Each hand-lists an overlapping subset, and the lists drifted before: SAAS_MODE was declared and
 * read by the backend but passed through by nothing, so a local `SAAS_MODE=true pnpm dev-server`
 * silently ran with it stripped.
 *
 * This suite is the guard the drift called for: env.d.ts declarations carry a trailing
 * `@deploy-config` marker (the explicit filter -- the interface also declares bindings like
 * WORKERS_AI and SAAS_* service seams that are *not* shell-configurable), and every consumer list
 * must (a) name only marked vars and (b) together cover all of them. Adding a deploy-configurable
 * var without wiring any path that sets it -- or reading a new one in a script without declaring
 * it -- fails here rather than shipping a local-vs-production divergence.
 *
 * `node --test` on the platform runner, like the other workspace guards in this directory; the
 * paths are resolved from this file's location so an invocation from any cwd sees the same tree.
 */

const ROOT = join(import.meta.dirname, "..");
const ENV_DTS = join(ROOT, "packages/workshop-backend/src/env.d.ts");
const RUN_DEV_SERVER = join(ROOT, "scripts/run-dev-server.ts");
const STAGING_CONFIG = join(ROOT, "scripts/preview/staging-config.ts");
const MANIFEST_LIB = join(ROOT, "scripts/release/manifest-lib.ts");

/** env.d.ts declarations whose line carries the `@deploy-config` marker: the canonical set. */
function canonicalVars(): string[] {
  const source = readFileSync(ENV_DTS, "utf8");
  const vars = [...source.matchAll(
      /^[ \t]*([A-Z][A-Z0-9_]*)\?\s*:[^;]*;\s*\/\/[^\n]*@deploy-config/gm)]
      .map(match => match[1]);
  assert.ok(vars.length > 0, "no @deploy-config declarations found in env.d.ts");
  return vars;
}

/** The string literal entries of run-dev-server.ts's OPTIONAL_FEATURE_VARS array. */
function optionalFeatureVars(): string[] {
  const source = readFileSync(RUN_DEV_SERVER, "utf8");
  const block = source.match(/const OPTIONAL_FEATURE_VARS = \[([\s\S]*?)\];/);
  assert.ok(block, "OPTIONAL_FEATURE_VARS array literal not found in run-dev-server.ts");
  return [...block[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map(match => match[1]);
}

/**
 * `process.env.NAME` reads in a script, minus the tooling vars that configure the script's own
 * plumbing rather than the deployment: PREVIEW_* identify the preview being built,
 * CLOUDFLARE_ACCOUNT_ID is the wrangler target account, and VITE_* is frontend build config.
 */
function envVarReads(path: string, tooling: ReadonlySet<string>): string[] {
  const source = readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!tooling.has(match[1])) names.add(match[1]);
  }
  return [...names];
}

/**
 * The vars the deploy service injects at PUT time, from the prose contract in manifest-lib.ts
 * ("instance-state vars (ADMINS, CLOUDFLARE_OS_DEPLOYMENT, CF_ACCESS_*, CF_AI_GATEWAY*)"). A
 * trailing `*` is a prefix over the canonical set, so the assertion also holds the comment to the
 * names it names: the contract is the only in-repo record of that third list.
 */
function deployServiceVars(canonical: ReadonlySet<string>): string[] {
  const source = readFileSync(MANIFEST_LIB, "utf8");
  const list = source.match(/instance-state vars \(([^)]*)\)/);
  assert.ok(list, "the backendExtraVars contract comment (instance-state vars (...)) not found");
  const vars = new Set<string>();
  for (const token of list[1].split(",")) {
    const name = token.trim();
    if (name.endsWith("*")) {
      const prefix = name.slice(0, -1);
      for (const candidate of canonical) {
        if (candidate.startsWith(prefix)) vars.add(candidate);
      }
    } else {
      vars.add(name);
    }
  }
  return [...vars];
}

const STAGING_TOOLING = new Set([
  "PREVIEW_NAME", "PREVIEW_PR_NUMBER", "PREVIEW_ADMINS", "PREVIEW_WORKERS_DEV_HOST",
  "PREVIEW_GITHUB_CLIENT_ID", "PREVIEW_GITHUB_CLIENT_SECRET", "CLOUDFLARE_ACCOUNT_ID",
]);
const DEV_SERVER_TOOLING = new Set(["VITE_BACKEND_HOST"]);

describe("deploy-config var registry", () => {
  const canonical = canonicalVars();
  const canonicalSet = new Set(canonical);

  /** Asserts every name in `names` is a marked env.d.ts declaration, naming any that is not. */
  function assertOnlyCanonical(names: string[], label: string): void {
    const unknown = names.filter(name => !canonicalSet.has(name));
    assert.deepEqual(
        unknown, [],
        `${label} read${unknown.length === 1 ? "s" : ""} var${unknown.length === 1 ? "" : "s"} ` +
            `not marked @deploy-config in env.d.ts: ${unknown.join(", ")}. Either the declaration ` +
            `is missing, or the read is deployment tooling that belongs in this test's filter.`);
  }

  it("marks each canonical var exactly once", () => {
    assert.deepEqual(new Set(canonical).size, canonical.length, `duplicate markers: ${canonical}`);
  });

  it("run-dev-server's OPTIONAL_FEATURE_VARS only names canonical deploy vars", () => {
    assertOnlyCanonical(optionalFeatureVars(), "run-dev-server's OPTIONAL_FEATURE_VARS");
  });

  it("run-dev-server's direct env reads only name canonical deploy vars", () => {
    assertOnlyCanonical(
        envVarReads(RUN_DEV_SERVER, DEV_SERVER_TOOLING), "run-dev-server's direct");
  });

  it("staging-config only reads canonical deploy vars beyond its preview tooling", () => {
    assertOnlyCanonical(envVarReads(STAGING_CONFIG, STAGING_TOOLING), "staging-config's");
  });

  it("the deploy-service PUT-time contract only names canonical deploy vars", () => {
    assertOnlyCanonical(deployServiceVars(canonicalSet), "the deploy-service contract comment");
  });

  it("every canonical var reaches the backend through some path", () => {
    const covered =
        new Set([...optionalFeatureVars(), ...deployServiceVars(canonicalSet),
          ...envVarReads(STAGING_CONFIG, STAGING_TOOLING)]);
    const uncovered = canonical.filter(name => !covered.has(name));
    assert.deepEqual(
        uncovered, [],
        `@deploy-config vars no consumer sets or passes: ${uncovered.join(", ")}. Wire one ` +
            `(OPTIONAL_FEATURE_VARS, a staging family, or the deploy-service contract) or unmark ` +
            `the declaration.`);
  });
});
