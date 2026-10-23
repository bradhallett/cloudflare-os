import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  agentName: string;
  autoProvisioned: boolean;
  blueprintId: string;
  cacheLifetimeMs: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  callbackInitiated: boolean;
  chatId: number;
  /** Declared bots: identifiers, keys, and counters only. A bot's instructions, its composed
   *  prompt section, direct-message text, and tool outputs never enter logs or spans. */
  botKey: string;
  commandId: string;
  /** Count of interrupted agent-turn records found by the constructor's resume sweep. */
  resumeRecords: number;
  dmCount: number;
  fromChatId: number;
  threadId: number;
  toChatId: number;
  treeDmCount: number;
  changeStage: "buffer" | "persist";
  changeIndex: number;
  changeWorkpieceCount: number;
  changeFileCount: number;
  changeEmptyPathCount: number;
  claimedType: string;
  commitCount: number;
  costUsd: number;
  credentialKind: "workshop" | "cloudflare-access";
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  executionId: string;
  failureCount: number;
  gadgetId: string;
  /** Blueprint KV records rewritten by the one-shot owner-subject migration. */
  migratedBlueprintCount: number;
  /** Organization membership events: which org, and (where one was granted or changed) a role.
   *  User ids of members never enter org logs. */
  orgId: string;
  orgRole: "owner" | "admin" | "member";
  gatekeeperId: number | string;
  handoffKind: "connect" | "restore";
  hookId: number;
  logBytes: number;
  missCostUsd: number;
  modelId: string;
  observerId: string;
  oidCount: number;
  oidPrefix: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "no_email" | "signups_disabled";
  path: string;
  pauseEnd: "turn" | "left" | "revert" | "deleted";
  recordedType: string;
  resourceTitle: string;
  resendCostUsd: number;
  sequence: number;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return obsContext.createLogger({ component });
}
