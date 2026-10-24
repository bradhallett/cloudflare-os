// Usage-event port: the seam a hosted SaaS deployment uses to meter model usage (usage-based
// billing) without any vendor code living in the OSS core. The Workshop declares an optional
// `SAAS_USAGE_EVENTS` service binding (see packages/workshop-backend/src/env.d.ts) implemented
// by a private worker; the OSS core ships no implementation, and emission is a no-op when the
// binding is absent — every self-hosted deployment behaves exactly as before, with no RPC.

import type { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Token counts by class for one model request, mirroring the classes providers bill separately.
 * `cacheWrite1h` and `reasoning` are the optional splits pi reports; they are subsets of
 * `cacheWrite` and `output` respectively, so a meter that only sums the four base classes stays
 * correct.
 */
export interface UsageEventTokens {
  /** Prompt tokens not served from a cache. */
  input: number;
  /** Prompt tokens served from a cache (billed at each provider's cache-read rate). */
  cacheRead: number;
  /** Prompt tokens written to a cache (billed at each provider's cache-write rate). */
  cacheWrite: number;
  /** Completion tokens, including any reasoning tokens. */
  output: number;
  /** The share of `cacheWrite` written with 1h retention, when the provider reports the split. */
  cacheWrite1h?: number;
  /** The share of `output` that was reasoning, when the provider reports the split. */
  reasoning?: number;
}

/**
 * One meterable model request, as the bound usage-events service receives it. Emitted
 * fire-and-forget at the two seams every billable model call crosses (agent chat steps and
 * model-binding `run()`); the core never waits on the port, and a port failure is logged, never
 * thrown into the model-call path.
 */
export interface UsageEvent {
  /**
   * Dedupe id, stable across redelivery and replay: the emitter derives it from the AI Gateway
   * log id when one exists (one gateway log is exactly one model request), else a fresh UUID.
   * The service uses it to skip a duplicate delivery, and forwards it as Polar's `external_id`
   * so Polar deduplicates it too.
   */
  id: string;
  /** The pi model id (`provider/model`), the key a price table resolves. */
  modelId: string;
  /** Token counts by class. */
  tokens: UsageEventTokens;
  /** The user DO id whose usage this is (the workspace owner, or the binding's owner). */
  userId: string;
  /** The chat the request served, when it was an agent chat step. */
  chatId?: number;
  /** The AI Gateway log id, when the request went through one (reconciliation join key). */
  aiGatewayLogId?: string;
  /** Which seam emitted the event: an agent chat step or a gadget model binding. */
  surface: "chat" | "binding";
}

/**
 * What {@link UsageEventsPort.recordUsage} did with an event. Purely informational — the
 * emitter is fire-and-forget and never reads it on the hot path.
 */
export type UsageEventAck = "queued" | "duplicate" | "dropped";

/**
 * Native Workers RPC capability a hosted SaaS deployment implements and binds as the
 * Workshop's optional `SAAS_USAGE_EVENTS` service binding. Purely additive: with no binding,
 * the Workshop emits nothing and behaves exactly as before.
 */
export interface UsageEventsPort extends WorkerEntrypoint {
  /**
   * Records one usage event. Implementations must be fast (a queue write, never a vendor call)
   * and must not throw for a full or failing backend — the contract is fire-and-forget.
   */
  recordUsage(event: UsageEvent): Promise<UsageEventAck>;
}
