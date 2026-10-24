// Adapter for the optional SaaS commerce port (`SAAS_COMMERCE`). This is the only place the
// Workshop talks to a deployment's commerce service — checkout sessions, the customer portal,
// and the org billing overview all forward through here, and the member sync that claims
// subscription seats is emitted from here. When the binding is absent — every self-hosted/OSS
// deployment — reads throw a clear "not available" error, the member sync is a synchronous
// no-op with no RPC, and behavior is otherwise identical to pre-port code.

import { createLogger } from "@gadgets/observability/logger";
import type { OrgCommerceMember } from "@gadgets/workshop-shared/api";

/** Log fields owned by this module (never checkout URLs or member identities). */
type CommerceLogFields = { event?: string; orgId?: string };

const logger = createLogger<CommerceLogFields>({ component: "workshop.commerce" });

/** The error every commerce read throws when no service is bound. */
export const COMMERCE_UNAVAILABLE =
    "Commerce isn't available on this deployment.";

/** The bound commerce service, or null when the deployment has none. */
export function commercePort(env: Cloudflare.Env) {
  return env.SAAS_COMMERCE ?? null;
}

/**
 * Notifies the commerce service that an org's membership changed — the whole snapshot, every
 * change, fire-and-forget: returns immediately, never throws, and does nothing at all when no
 * service is bound. The service claims and releases subscription seats from the snapshot (an
 * invited member claims their seat immediately); a dropped push is healed by the service's own
 * reconciliation, the same contract as the usage-events seam.
 */
export function notifyOrgMembersChanged(
    env: Cloudflare.Env, orgId: string, name: string,
    members: OrgCommerceMember[]): void {
  const port = commercePort(env);
  if (!port) return;
  void port.orgMembersChanged({ orgId, name, members }).catch(err => {
    logger.warn("org member sync failed", {
      event: "commerce.member_sync_failed", orgId, error: err,
    });
  });
}
