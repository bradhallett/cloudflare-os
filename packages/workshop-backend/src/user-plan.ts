import { resolveEntitlements } from "./entitlements.js";

/**
 * The model tiers the user's plan may run, or null while no entitlements service is bound
 * (every OSS deployment — no gate, identical to pre-port behavior). A gateway model that
 * states a catalog tier absent from the set is neither listed nor resolved; a model with no
 * tier, and any model a user stored themselves, is never tier-gated. A bound service that
 * fails yields the empty set — no tiered model runs — so an outage fails closed.
 */
export async function allowedModelTiers(
    env: Cloudflare.Env, userId: string): Promise<ReadonlySet<string> | null> {
  let answer = await resolveEntitlements(env, userId);
  if (answer.status === "unbound") return null;
  if (answer.status === "unavailable") return new Set();
  return new Set(answer.entitlements.allowedModelTiers);
}

/**
 * The gatekeeper vendors the user's plan may connect, or null while no entitlements service
 * is bound (no gate, as pre-port behavior and every OSS deployment). A bound service that
 * fails yields the empty set — every vendor is withheld — so an outage fails closed. Shared
 * by the connector surfaces (listing, connect, ambient provisioning and surfacing) and
 * resource gating, the same way allowedModelTiers serves the model surfaces.
 */
export async function allowedGatekeepers(
    env: Cloudflare.Env, userId: string): Promise<ReadonlySet<string> | null> {
  let answer = await resolveEntitlements(env, userId);
  if (answer.status === "unbound") return null;
  if (answer.status === "unavailable") return new Set();
  return new Set(answer.entitlements.allowedGatekeepers.map(id => id.toLowerCase()));
}
