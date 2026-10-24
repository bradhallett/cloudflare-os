// Entitlements & usage-policy port: the seam a hosted SaaS deployment uses to own plan and
// billing decisions without any vendor code living in the OSS core. The Workshop declares an
// optional `SAAS_ENTITLEMENTS` service binding (see packages/workshop-backend/src/env.d.ts)
// implemented by a private worker; the OSS core ships no implementation, and every read falls
// back to the deployment's env-configured behavior when the binding is absent.

import type { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Identifier of the subscription plan a user is entitled to. Opaque to the core: the bound
 * entitlements service assigns the ids (e.g. "free", "pro", "team") and the core only relays
 * and compares them.
 */
export type EntitlementsPlanId = string;

/**
 * Coarse model class a plan may run (e.g. "standard", "premium"). Opaque to the core: the
 * entitlements service assigns tiers and the core only compares membership in
 * `Entitlements.allowedModelTiers` when a model is about to run; it never interprets a tier.
 */
export type ModelTier = string;

/**
 * What a user's subscription entitles them to, as adjudicated by the bound entitlements
 * service. Consulted by the plan-enforcement seams (model catalogs, connector offers); the
 * usage checker itself enforces the derived {@link UsagePolicy}.
 */
export interface Entitlements {
  /** The plan the user's subscription is on. */
  plan: EntitlementsPlanId;
  /** Number of licensed seats on the subscription. */
  seats: number;
  /**
   * Maximum metered spend (USD) per billing cycle. Spend past it proceeds as metered overage
   * when `overageAllowed` is set, and is refused otherwise.
   */
  monthlySpendCapUsd: number;
  /** Whether spend past `monthlySpendCapUsd` may proceed, billed as metered overage. */
  overageAllowed: boolean;
  /** Model tiers the plan may run; a model outside these tiers is refused. */
  allowedModelTiers: ModelTier[];
  /** Gatekeeper vendor ids the plan may connect; an unlisted gatekeeper is not offered. */
  allowedGatekeepers: string[];
}

/**
 * The usage policy the Workshop's usage checker (checkUsageAndBalance) enforces on every
 * billable model call. When the `SAAS_ENTITLEMENTS` service is unbound, the deployment's
 * env-configured values apply, so behavior is identical to pre-port code.
 */
export interface UsagePolicy {
  /** Per-user daily LLM-call limit on the platform free tier. */
  dailyLlmCallLimit: number;
  /** Minimum connected-account balance (USD) required to proceed via the user's own gateway. */
  minimumBalance: number;
}

/**
 * Identifies the Workshop user an entitlements read is resolved for; the service maps the user
 * to its tenant and subscription.
 */
export interface EntitlementsQuery {
  /** The user Durable Object's id string (`DurableObjectId#toString`), stable for the account. */
  userId: string;
}

/**
 * Native Workers RPC capability a hosted SaaS deployment implements and binds as the
 * Workshop's optional `SAAS_ENTITLEMENTS` service binding. Purely additive: with no binding,
 * the Workshop resolves every decision itself and behaves exactly as before.
 */
export interface EntitlementsPort extends WorkerEntrypoint {
  /**
   * The user's entitlements snapshot (plan, seats, spend cap, model tiers, allowed
   * gatekeepers), for plan-enforcement seams and display.
   */
  getEntitlements(query: EntitlementsQuery): Promise<Entitlements>;

  /**
   * The usage policy to enforce for the user's billable model calls. The Workshop falls back
   * to its env-configured policy when this fails, so an entitlements outage never blocks a
   * model call on its own.
   */
  resolveUsagePolicy(query: EntitlementsQuery): Promise<UsagePolicy>;
}
