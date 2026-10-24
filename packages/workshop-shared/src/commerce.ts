// SaaS commerce port: the seam a hosted SaaS deployment uses to sell subscriptions — checkout
// sessions, the customer portal, per-org billing state, and the member sync that claims seats —
// without any vendor code living in the OSS core. The Workshop declares an optional
// `SAAS_COMMERCE` service binding (see packages/workshop-backend/src/env.d.ts) implemented by a
// private worker, exactly like the `SAAS_ENTITLEMENTS` and `SAAS_USAGE_EVENTS` seams: the OSS
// core ships no implementation and no config declares the binding. The Workshop checks org
// authority itself before every call (the org Durable Object owns membership), so the bound
// service only ever receives org ids an active org admin presented — it never re-derives
// authority from its own state.

import type { WorkerEntrypoint } from "cloudflare:workers";
import type { OrgBillingOverview, OrgCommerceMember } from "./api.js";

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
