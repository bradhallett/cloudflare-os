// Adapter for the optional SaaS entitlements port (`SAAS_ENTITLEMENTS`). This is the single
// place the OSS core consults a hosted SaaS's plan decisions; no vendor code lives here. When
// the binding is absent — every self-hosted/OSS deployment — each resolver returns the built-in
// env-configured answer with no RPC, so behavior is identical to pre-port code.

import { createLogger } from "@gadgets/observability/logger";
import type { UsagePolicy } from "@gadgets/workshop-shared/entitlements";
import { getMinimumCloudflareBalance } from "./ai-gateway-billing/config.js";
import { getDailyLlmCallLimit } from "./ai-gateway-billing/limits/config.js";

/** Log fields owned by this module. */
type EntitlementsLogFields = { userId?: string };

const logger = createLogger<EntitlementsLogFields>({ component: "workshop.entitlements" });

// The env-configured policy every OSS deployment gets, and the fallback when the port fails.
function envUsagePolicy(env: Cloudflare.Env): UsagePolicy {
  return {
    dailyLlmCallLimit: getDailyLlmCallLimit(env),
    minimumBalance: getMinimumCloudflareBalance(env),
  };
}

/**
 * Resolve the usage policy enforced for `userId`'s billable model calls: the bound
 * `SAAS_ENTITLEMENTS` port's answer when one exists, else the env-configured policy. The
 * unbound path is synchronous (no RPC), so the hot path gains nothing when no SaaS is bound.
 * A failing port never blocks or throws into the caller: the failure is logged and the
 * env-configured policy applies.
 */
export async function resolveUsagePolicy(
    env: Cloudflare.Env, userId: string): Promise<UsagePolicy> {
  if (!env.SAAS_ENTITLEMENTS) return envUsagePolicy(env);
  try {
    return await env.SAAS_ENTITLEMENTS.resolveUsagePolicy({ userId });
  } catch (err) {
    logger.warn("usage-policy consult failed; using env-configured policy", {
      event: "entitlements.policy.consult_failed", userId, error: err,
    });
    return envUsagePolicy(env);
  }
}
