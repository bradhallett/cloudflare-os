// Spend gating for AI model bindings: every run()/decide() call on a gadget's language- or
// decision-model binding passes the same usage check a chat turn passes at its head, so a gadget
// cannot bill the platform gateway past its workspace owner's allowance.

import { checkOwnerUsage } from "./ai-gateway-billing/limits/usage-checker.js";
import type { UserDurableObject } from "./user.js";

/**
 * The usage gate every binding call passes: each run()/decide() call draws one call on the
 * workspace owner's allowance and refuses with the checker's reason once it is exhausted.
 * Bindings never route through the owner's own gateway; a funded owner simply clears the gate
 * without consuming the daily counter, since that counter is only spent on the platform gateway.
 *
 * Bindings minted before spend gating carry no ownerUserId in their frozen props, and the stored
 * gatekeeper record cannot supply it (a DurableObjectClass hides its props), so those bindings
 * keep a no-op gate rather than breaking on upgrade.
 */
export function bindingUsageGate(
    env: Cloudflare.Env, ownerUserId: string | undefined,
    users: DurableObjectNamespace<UserDurableObject>): () => Promise<void> {
  if (ownerUserId === undefined) return async () => {};
  return async () => {
    let usage = await checkOwnerUsage(env, ownerUserId, users);
    if (!usage.allowed) throw new Error(usage.reason ?? "Usage limit reached.");
  };
}
