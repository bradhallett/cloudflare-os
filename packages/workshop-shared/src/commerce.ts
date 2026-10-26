// SaaS commerce port: the seam a hosted SaaS deployment uses to sell subscriptions — checkout
// sessions, the customer portal, per-org billing state, and the member sync that claims seats —
// without any vendor code living in the OSS core. The Workshop declares an optional
// `SAAS_COMMERCE` service binding (see packages/workshop-backend/src/env.d.ts) implemented by a
// private worker, exactly like the `SAAS_ENTITLEMENTS` and `SAAS_USAGE_EVENTS` seams: the OSS
// core ships no implementation and no config declares the binding. The Workshop checks org
// authority itself before every call (the org Durable Object owns membership), so the bound
// service only ever receives org ids an active org admin presented — it never re-derives
// authority from its own state.
//
// This file also holds the client-facing billing surface: the display types
// `getOrgBilling()` and `listCommercePlans()` report (`CommercePlan`, `OrgCommerceMember`,
// `OrgUsageSummary`, `OrgBillingOverview`) and the commerce methods of `AuthenticatedApi`
// (`CommerceApiMethods`). api.ts re-exports all of them, so importers of
// `@gadgets/workshop-shared/api` are unaffected by this module holding them.

import type { WorkerEntrypoint } from "cloudflare:workers";
import type { Entitlements } from "./entitlements.js";
import type { OrgMember } from "./orgs.js";

/**
 * A subscription plan the deployment's commerce service offers, as
 * `AuthenticatedApi.listCommercePlans()` lists it for the plan picker.
 */
export type CommercePlan = {
  /** The plan's opaque id, exactly what `startOrgCheckout()` expects. */
  id: string;
  /** Display name (e.g. "Pro"). */
  name: string;
};

/**
 * One member of an org as the commerce member-sync carries them: enough to claim and release
 * the org's subscription seats (an invited member claims their seat immediately) without
 * re-deriving membership, which the org Durable Object has already authority-checked. Picked
 * from `OrgMember` so the mirror cannot drift from the org's grammar.
 */
export type OrgCommerceMember = Pick<OrgMember, "userId" | "role" | "status">;

/** The org's usage in one billing cycle, as `getOrgBilling()` reports it. */
export type OrgUsageSummary = {
  /** Start of the billing cycle the totals cover. */
  cycleStart: Date;
  /** Prompt tokens not served from a cache, across the org's metered model calls. */
  inputTokens: number;
  /** Prompt tokens served from a cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to a cache. */
  cacheWriteTokens: number;
  /** Completion tokens, reasoning included. */
  outputTokens: number;
  /**
   * The cycle's estimated metered cost (USD) at the billing service's own pinned price table —
   * an estimate for reconciliation, never the invoice. Null while any metered model is unpriced.
   */
  estimatedCostUsd: number | null;
};

/**
 * The org's billing state for the org settings page, as `getOrgBilling()` reports it. Mirror of
 * the derived entitlements plus the subscription's status and the current cycle's usage; the
 * entitlements half is picked from `Entitlements` so it cannot drift from that contract.
 */
export type OrgBillingOverview = Pick<
  Entitlements,
  "plan" | "seats" | "monthlySpendCapUsd" | "overageAllowed"
> & {
  /** Seats claimed per the member mirror — active members plus pending invitations. */
  assignedSeats: number;
  /**
   * The subscription's status as the billing service derives it from the vendor's state (e.g.
   * "active", "trialing", "past_due"; "none" with no subscription). Display-only.
   */
  subscriptionStatus: string;
  /** The current cycle's usage; null while the billing service knows no cycle. */
  usage: OrgUsageSummary | null;
};

/** A checkout session the commerce service starts for an org. */
export interface OrgCheckoutQuery {
  /** The org buying, already authority-checked by the caller. */
  orgId: string;
  /** The plan to subscribe to: one of the ids `listPlans()` returned. */
  plan: string;
  /** Seat count to price the subscription at (at least 1). */
  seats: number;
  /**
   * Where the checkout host returns the buyer afterwards (success and cancel alike) — built by
   * the caller from the deployment's own origin, never from client input.
   */
  successUrl: string;
}

/**
 * Native Workers RPC capability a hosted SaaS deployment implements and binds as the Workshop's
 * optional `SAAS_COMMERCE` service binding. Purely additive: with no binding, the Workshop's
 * commerce methods throw a clear "not available" error and nothing else changes.
 */
export interface SaasCommercePort extends WorkerEntrypoint {
  /**
   * The plans the deployment offers, for the plan picker. Ordered by the service; ids are
   * opaque to the core and exactly what {@link startCheckout} expects in `query.plan`.
   */
  listPlans(): Promise<Array<{ id: string; name: string }>>;

  /**
   * The org's billing overview for the org settings page: derived plan, licensed and claimed
   * seats, spend cap, overage allowance, subscription status, and the current cycle's usage.
   */
  getOrgBilling(query: { orgId: string }): Promise<OrgBillingOverview>;

  /**
   * Starts a hosted checkout session for the org and returns its URL. The browser redirects
   * there; the checkout host returns the buyer to `successUrl` when the flow finishes.
   */
  startCheckout(query: OrgCheckoutQuery): Promise<{ url: string }>;

  /**
   * Mints a scoped customer-portal URL for the org (payment method, invoices, seat billing),
   * expiring on the vendor's own schedule.
   */
  createPortalSession(query: { orgId: string; returnUrl: string }): Promise<{ url: string }>;

  /**
   * Notifies the service that the org's membership changed — the whole snapshot, every change,
   * fire-and-forget by contract (the service's own reconciliation heals a dropped push). The
   * service uses the snapshot to claim and release subscription seats (an invited member claims
   * their seat immediately) and to keep its org records in step. `name` is the org's current
   * name so a creation push can adopt the vendor-side records.
   */
  orgMembersChanged(query: {
    orgId: string;
    name: string;
    members: OrgCommerceMember[];
  }): Promise<void>;
}

/**
 * The SaaS-commerce methods of `AuthenticatedApi`, meaningful only when the `SAAS_COMMERCE`
 * binding is present: with no binding, `listCommercePlans()` reports an empty list and the
 * other methods throw a clear "not available" error.
 */
export interface CommerceApiMethods {
  /**
   * The subscription plans this deployment's commerce service offers, for the plan picker.
   * Empty when no commerce service is bound (self-hosted deployments).
   */
  listCommercePlans(): Promise<CommercePlan[]>;

  /**
   * The org's billing overview for the org settings page: derived plan, licensed and claimed
   * seats, spend cap, overage allowance, subscription status, and the current billing cycle's
   * usage (#17's usage report). Active owners and admins only. Throws when no commerce service
   * is bound.
   */
  getOrgBilling(orgId: string): Promise<OrgBillingOverview>;

  /**
   * Starts a hosted checkout session to subscribe the org to `plan` at `seats` seats, returning
   * the checkout URL for the browser to redirect to; the checkout host returns the buyer to the
   * Workshop's SaaS checkout-return page afterwards. Active owners and admins only. Throws when
   * no commerce service is bound.
   */
  startOrgCheckout(orgId: string, plan: string, seats: number): Promise<{ url: string }>;

  /**
   * Mints a scoped customer-portal URL for the org (payment method, invoices, seat billing) and
   * returns it for the browser to open. Active owners and admins only. Throws when no commerce
   * service is bound.
   */
  openOrgBillingPortal(orgId: string): Promise<{ url: string }>;
}
