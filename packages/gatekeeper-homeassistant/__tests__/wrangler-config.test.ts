import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// wrangler.jsonc is generated from cloudflare.config.ts; this pins the security boundary flags
// so a regeneration that drops them fails here instead of silently narrowing SSRF protection.
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const raw = readFileSync(configPath, "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
  compatibility_flags: string[];
};

describe("wrangler config", () => {
  it("rejects user-supplied instance hosts that resolve to private addresses", () => {
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });

  it("keeps the storage flag the durable object state machine relies on", () => {
    expect(config.compatibility_flags).toContain("allow_irrevocable_stub_storage");
  });
});
