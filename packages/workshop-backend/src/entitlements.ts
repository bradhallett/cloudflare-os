// Adapter for the optional SaaS entitlements port (`SAAS_ENTITLEMENTS`). This is the single
// place the OSS core consults a hosted SaaS's plan decisions — the usage checker's policy and
// the plan-enforcement seams (model tiers, connectors, workspace caps); no vendor code lives
// here. When the binding is absent — every self-hosted/OSS deployment — each resolver returns
// the built-in env-configured answer with no RPC, so behavior is identical to pre-port code. A
// bound port that fails degrades differently per resolver: the usage policy falls back to the
// env-configured one (an outage never blocks a model call on its own), while the plan gates
// fail closed (see resolveEntitlements) — through the folds below, not per call site.

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
 * Folds an {@link EntitlementsAnswer} into the allowed-set a plan gate checks: `null` while the
 * deployment is unbound (no gate, as pre-port code), the empty set while the port is
 * unavailable (fail closed — no value passes), else the set of the strings `pick` reads from the
 * entitlements. This is the one place the fail-open/fail-closed policy for set-shaped gates
 * lives; the gates consume the fold instead of restating it.
 */
export function allowedSetFrom(
    answer: EntitlementsAnswer,
    pick: (entitlements: Entitlements) => Iterable<string>,
): ReadonlySet<string> | null {
  if (answer.status === "unbound") return null;
  if (answer.status === "unavailable") return new Set();
  return new Set(pick(answer.entitlements));
}

/** The workspace-creation cap a plan gate enforces, as folded by {@link workspaceCapFrom}. */
export type WorkspaceCapGate =
    | { status: "unavailable" }
    | { status: "capped"; cap: number }
    | { status: "uncapped" };

/**
 * Folds an {@link EntitlementsAnswer} into the workspace-creation cap a plan gate enforces:
 * `unavailable` — a bound port that failed — refuses the creation (fail closed: an outage must
 * not hand out workspaces past a cap it couldn't read), `capped` carries the plan's cap, and
 * `uncapped` is every answer the cap doesn't reach (unbound, or a plan that sets none).
 */
export function workspaceCapFrom(answer: EntitlementsAnswer): WorkspaceCapGate {
  if (answer.status === "unavailable") return { status: "unavailable" };
  let cap = answer.status === "resolved" ? answer.entitlements.maxWorkspaces : undefined;
  return cap === undefined ? { status: "uncapped" } : { status: "capped", cap };
}

/**
 * Whether an {@link EntitlementsAnswer} lets spend continue past the exhausted allowance: only
 * a resolved plan that allows overage does. An unbound deployment is hard-capped exactly as
 * pre-port code was, and an unavailable port keeps the block — overage is granted by no outage.
 */
export function overageAllowedFrom(answer: EntitlementsAnswer): boolean {
  return answer.status === "resolved" && answer.entitlements.overageAllowed;
}

/**
 * The user's plan entitlements, `{status: "unbound"}` while no entitlements service is bound
 * (every OSS deployment) — the caller then applies no plan gate, as pre-port code did. A bound
 * port that fails yields `{status: "unavailable"}` instead: unlike an unbound deployment, a
 * SaaS's plan gates fail *closed* while its entitlements service is down — the model-tier,
 * connector, and workspace-creation gates each take their most restrictive answer (empty tier
 * set, refused mint, refused creation) rather than silently opening. The failure is logged and
 * never throws into the caller.
 *
 * A resolved answer serves later consults for a few seconds (see `ENTITLEMENTS_MEMO_MS`): a
 * billable call consults the port twice in quick succession — the usage policy at the checker's
 * head, the plan gates at session start or at the block — and the memo serves the second read
 * from the first, keeping the hot path at one service-binding round-trip per call. Only the
 * plan is remembered, never an outage: each failed consult retries on the next call, so the
 * gates recover the moment the port does.
 */
export async function resolveEntitlements(
    env: Cloudflare.Env, userId: string): Promise<EntitlementsAnswer> {
  let port = env.SAAS_ENTITLEMENTS;
  if (!port) return { status: "unbound" };
  let memo = entitlementsMemo.get(port)?.get(userId);
  if (memo !== undefined && memo.expiresAt > Date.now()) return memo.answer;
  try {
    let answer: EntitlementsAnswer = {
      status: "resolved",
      entitlements: await port.getEntitlements({ userId }),
    };
    rememberEntitlements(port, userId, answer);
    return answer;
  } catch (err) {
    logger.warn("entitlements consult failed; plan gates fail closed", {
      event: "entitlements.consult_failed", userId, error: err,
    });
    return { status: "unavailable" };
  }
}

// How long a resolved entitlements answer serves later consults (see resolveEntitlements): long
// enough that one billable call's policy consult and plan-gate consults share a round-trip,
// short enough that a plan change lands on the next call.
const ENTITLEMENTS_MEMO_MS = 5_000;

// Resolved answers, per bound port and then per user, so a redirect to a different port object
// (each test builds its own) never reads another's memo. Weakly keyed on the port so a replaced
// binding leaves no entry behind.
const entitlementsMemo = new WeakMap<
    NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
    Map<string, { answer: EntitlementsAnswer, expiresAt: number }>>();

function rememberEntitlements(
    port: NonNullable<Cloudflare.Env["SAAS_ENTITLEMENTS"]>,
    userId: string, answer: EntitlementsAnswer) {
  let answers = entitlementsMemo.get(port);
  if (answers === undefined) {
    answers = new Map();
    entitlementsMemo.set(port, answers);
  }
  // One DO consults a handful of users; a cap that large means the port object is being reused
  // across many (as a test harness may), where serving any stale answer is worse than re-asking.
  if (answers.size >= 64) answers.clear();
  answers.set(userId, { answer, expiresAt: Date.now() + ENTITLEMENTS_MEMO_MS });
}
