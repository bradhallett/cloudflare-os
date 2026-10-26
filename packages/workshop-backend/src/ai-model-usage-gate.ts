// Spend gating and usage metering for AI model bindings: every run()/decide() call on a gadget's
// language- or decision-model binding passes the same usage check a chat turn passes at its head,
// so a gadget cannot bill the platform gateway past its workspace owner's allowance, and what the
// call spent is metered exactly once.

import type { Usage } from "@earendil-works/pi-ai";
import { checkOwnerUsage } from "./ai-gateway-billing/limits/usage-checker.js";
import { emitUsageEvent, usageTokens } from "./usage-events.js";
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

/**
 * The metering every binding call passes, in one place: the gate above, plus the hook that
 * meters what each call spent to the optional usage-events port (#17's seam — pi reports usage
 * per request, and completeText/decide would otherwise discard it). `modelId` is the catalog id
 * a price table resolves. The hook fires only on completions (never errors) and is
 * fire-and-forget at the port; a binding with no owner on its frozen props (minted before spend
 * gating) gates and meters nowhere, and an unbound port makes emission a no-op.
 */
export function bindingMetering(
    env: Cloudflare.Env, ctx: DurableObjectState, ownerUserId: string | undefined,
    modelId: string): { usageGate: () => Promise<void>, onUsage?: (usage: Usage) => void } {
  let usageGate = bindingUsageGate(env, ownerUserId, ctx.exports.UserDurableObject);
  let onUsage = ownerUserId === undefined ? undefined
      : (usage: Usage) => emitUsageEvent(ctx, env, {
            modelId,
            tokens: usageTokens(usage),
            userId: ownerUserId,
            surface: "binding",
          });
  return { usageGate, onUsage };
}
