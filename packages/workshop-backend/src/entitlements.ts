// Adapter for the optional SaaS entitlements port (`SAAS_ENTITLEMENTS`). This is the single
// place the OSS core consults a hosted SaaS's plan decisions — the usage checker's policy and
// the plan-enforcement seams (model tiers, connectors, workspace caps); no vendor code lives
// here. When the binding is absent — every self-hosted/OSS deployment — each resolver returns
// the built-in env-configured answer with no RPC, so behavior is identical to pre-port code. A
// bound port that fails degrades differently per resolver: the usage policy falls back to the
// env-configured one (an outage never blocks a model call on its own), while the plan gates
// fail closed (see resolveEntitlements).

import { createLogger } from "@gadgets/observability/logger";
import { type Entitlements, type UsagePolicy } from "@gadgets/workshop-shared/entitlements";
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

/**
 * What {@link resolveEntitlements} learned about a user's plan: the port's answer, or which of
 * the two absence kinds applies. `"unbound"` is every OSS deployment — no gate applies, exactly
 * as pre-port code. `"unavailable"` is a bound port that failed — the plan gates read it as the
 * most restrictive answer (see {@link resolveEntitlements}).
 */
export type EntitlementsAnswer =
    | { status: "unbound" }
    | { status: "resolved"; entitlements: Entitlements }
    | { status: "unavailable" };

/**
 * The user's plan entitlements, `{status: "unbound"}` while no entitlements service is bound
 * (every OSS deployment) — the caller then applies no plan gate, as pre-port code did. A bound
 * port that fails yields `{status: "unavailable"}` instead: unlike an unbound deployment, a
 * SaaS's plan gates fail *closed* while its entitlements service is down — the model-tier,
 * connector, and workspace-creation gates each take their most restrictive answer (empty tier
 * set, refused mint, refused creation) rather than silently opening. The failure is logged and
 * never throws into the caller.
 */
export async function resolveEntitlements(
    env: Cloudflare.Env, userId: string): Promise<EntitlementsAnswer> {
  if (!env.SAAS_ENTITLEMENTS) return { status: "unbound" };
  try {
    return {
      status: "resolved",
      entitlements: await env.SAAS_ENTITLEMENTS.getEntitlements({ userId }),
    };
  } catch (err) {
    logger.warn("entitlements consult failed; plan gates fail closed", {
      event: "entitlements.consult_failed", userId, error: err,
    });
    return { status: "unavailable" };
  }
}
