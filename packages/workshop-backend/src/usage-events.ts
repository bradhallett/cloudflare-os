// Adapter for the optional SaaS usage-events port (`SAAS_USAGE_EVENTS`). This is the single
// place the OSS core emits meterable model usage — no vendor code lives here. When the binding
// is absent — every self-hosted/OSS deployment — emission is a synchronous no-op with no RPC,
// so behavior is byte-identical to pre-port code. When a port is bound, emission is
// fire-and-forget: the promise is never awaited on the model-call path, and a failing port is
// logged and dropped (usage metering must never block or break a chat or binding call; the
// bound service's own queue retries its vendor writes).

import { createLogger } from "@gadgets/observability/logger";
import type { Usage } from "@earendil-works/pi-ai";
import type { UsageEvent, UsageEventTokens } from "@gadgets/workshop-shared/usage-events";

/** Log fields owned by this module (never token counts or payload contents). */
type UsageEventsLogFields = { surface?: UsageEvent["surface"] };

const logger = createLogger<UsageEventsLogFields>({ component: "workshop.usage_events" });

/**
 * The dedupe id for one emission, stable across redelivery and replay: derived from the AI
 * Gateway log id when one exists (one gateway log is exactly one model request, so a replayed
 * DO input re-emits the same id and the service deduplicates it), else a fresh UUID — random
 * rather than content-derived, because two legitimate identical binding calls (same prompt,
 * same counts) must never collapse into one billed event.
 */
export function usageEventId(aiGatewayLogId: string | undefined): string {
  return aiGatewayLogId ? `gw:${aiGatewayLogId}` : `rnd:${crypto.randomUUID()}`;
}

/**
 * pi's Usage record as the port's token classes: the four base classes verbatim, plus the
 * optional provider splits (`cacheWrite1h` ⊂ `cacheWrite`, `reasoning` ⊂ `output`) only when
 * the provider reported them. Cost fields are deliberately dropped — the bound service prices
 * from its own pinned table (vendor catalog prices drift; a baked-in estimate would too).
 */
export function usageTokens(usage: Usage): UsageEventTokens {
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    ...(usage.cacheWrite1h !== undefined ? {cacheWrite1h: usage.cacheWrite1h} : {}),
    ...(usage.reasoning !== undefined ? {reasoning: usage.reasoning} : {}),
  };
}

/**
 * Emits one usage event to the bound `SAAS_USAGE_EVENTS` port, fire-and-forget: returns
 * immediately, never throws, and does nothing at all when no port is bound. The only
 * bookkeeping is the failure log — the service owns every retry beyond this seam.
 */
export function emitUsageEvent(env: Cloudflare.Env, event: Omit<UsageEvent, "id">): void {
  const port = env.SAAS_USAGE_EVENTS;
  if (!port) return;
  const full: UsageEvent = {...event, id: usageEventId(event.aiGatewayLogId)};
  void port.recordUsage(full).catch(err => {
    logger.warn("usage-event emission failed", {
      event: "usage_events.emit_failed", surface: full.surface, error: err,
    });
  });
}
