/**
 * Action vocabulary for the Gmail gatekeeper: action types, receipts, fingerprints, and the pure helpers that read them.
 */

import { GmailMutationOperation } from "./gmail-overlay";
import { GmailMutationTarget } from "./gmail-scope";
import { GmailDraftAttachmentState, GmailDraftResource, GmailDraftState, GmailForwardSnapshotReference, GmailLabelResource, isVersionedGmailFingerprint } from "./gmail-state";
import { GmailOutboundSpec } from "./google-api";
import { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";

export type GmailSourceAttachment = GmailForwardSnapshotReference & {
  messageId: string;
  description: string;
  contentType?: "application/octet-stream";
};

export type GmailMessageMutationAction = {
  type: "messageMutation";
  operation: GmailMutationOperation;
  target: GmailMutationTarget;
  labelId?: string;
  dependsOn?: number[];
};

export type GmailSendAction = {
  type: "send";
  mode: "new" | "reply" | "forward";
  spec: GmailOutboundSpec;
  uploadedAttachments?: GmailUploadedAttachment[];
  threadId?: string;
  sourceMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  forwardFormat?: "inline";
  /** When the send was submitted, which is when reads date it until it is delivered. */
  submittedAt?: number;
};

/** An attachment the agent uploaded, whose exact bytes this binding retains. */
export type GmailUploadedAttachment = GmailDraftAttachmentState & {file: GmailForwardSnapshotReference};

export type GmailDraftCreateAction = {
  type: "draftCreate";
  draft: GmailDraftState;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
  /** Staged with byte-exact output; an older create may have been written by the old MIME builder. */
  exactOutput?: true;
};

export type GmailDraftUpdateAction = {
  type: "draftUpdate";
  draftId: string;
  after: GmailDraftState;
  expectedBefore: string;
  expectedProviderMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
  /** Set when a pre-upgrade action is rebased, since its new precondition no longer dates it. */
  historicalAttachments?: true;
  /**
   * `after` re-keyed to the provider's exact parts, recorded before a historical update writes
   * them: the written revision re-encodes parts the legacy parse then reads differently.
   */
  exactAfter?: GmailDraftState;
};

export type GmailDraftDeleteAction = {
  type: "draftDelete";
  draftId: string;
  expectedSnapshot: string;
  expectedProviderMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
};

export type GmailDraftSendAction = {
  type: "draftSend";
  draftId: string;
  approved: GmailDraftState;
  expectedSnapshot: string;
  expectedProviderMessageId?: string;
  messageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
  /** As on `GmailDraftUpdateAction`. */
  historicalAttachments?: true;
  /** `approved` re-keyed when a historical predecessor wrote its parts; see `exactAfter`. */
  exactApproved?: GmailDraftState;
  /** As on `GmailSendAction`. */
  submittedAt?: number;
};

/**
 * Whether an update's or send's attachment state was captured before attachment digests were
 * byte-exact, so its provider parts can only be matched through the legacy parse.
 */
export function hasHistoricalAttachments(action: GmailDraftUpdateAction | GmailDraftSendAction): boolean {
  return action.historicalAttachments === true || !isVersionedGmailFingerprint(
    action.type === "draftUpdate" ? action.expectedBefore : action.expectedSnapshot);
}

/**
 * Re-key `state`'s attachments that match `before` (by key and digest) to their counterparts in
 * `exact`, the byte-exact state a historical predecessor wrote. Undefined when nothing changes.
 */
export function migrateAttachmentState(
    state: GmailDraftState, before: GmailDraftState, exact: GmailDraftState): GmailDraftState | undefined {
  let changed = false;
  const attachments = state.attachments.map(attachment => {
    const index = before.attachments.findIndex(part =>
      part.key === attachment.key && part.contentDigest === attachment.contentDigest);
    const migrated = exact.attachments[index];
    if (index < 0 || !migrated || migrated.contentDigest === attachment.contentDigest) return attachment;
    changed = true;
    return {...attachment, contentDigest: migrated.contentDigest, info: {
      ...attachment.info, mimeType: migrated.info.mimeType, disposition: migrated.info.disposition,
      size: migrated.info.size,
    }};
  });
  return changed ? {...state, attachments} : undefined;
}

export type GmailDraftWriteReceipt = {
  draftId: string;
  messageId: string;
  threadId?: string;
  missing?: true;
  unverified?: true;
};

export type GmailSentMessageReceipt = {
  rfcMessageId: string;
  providerId: string;
  threadId: string;
  /** Copied from the send, for a thread mutation that names this message as its last. */
  submittedAt?: number;
};

export type GmailSendFingerprint = {
  rfcMessageId: string;
  fingerprint: string;
};

export type GmailDraftProviderBaseline = GmailDraftWriteReceipt & {
  fingerprint: string;
  appliedAttachments: NonNullable<GmailDraftResource["appliedAttachments"]>;
  outputFingerprint: string;
  /** Present only when a historical write or pre-upgrade successor needs it. */
  legacyOutputFingerprint?: string;
};

export type GmailLabelCreateAction = {
  type: "labelCreate";
  label: GmailLabelResource;
  dependsOn?: number[];
};

export type GmailLabelRenameAction = {
  type: "labelRename";
  labelId: string;
  name: string;
  expectedName: string;
  dependsOn?: number[];
};

export type GmailLabelDeleteAction = {
  type: "labelDelete";
  labelId: string;
  dependsOn?: number[];
};

export type GmailAction =
  | GmailMessageMutationAction | GmailSendAction | GmailDraftCreateAction
  | GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction
  | GmailLabelCreateAction | GmailLabelRenameAction | GmailLabelDeleteAction;

export const MESSAGE_MUTATION_LABELS = {
  archive: "Archive messages",
  trash: "Trash messages",
  markRead: "Mark messages as read",
  markUnread: "Mark messages as unread",
  star: "Star messages",
  unstar: "Unstar messages",
  applyLabel: "Apply labels to messages",
  removeLabel: "Remove labels from messages",
} satisfies Record<GmailMutationOperation, string>;

export type GmailResourceActionType = Exclude<GmailAction["type"], "messageMutation" | "send" | "draftSend">;

export const RESOURCE_ACTION_LABELS = {
  draftCreate: "Create drafts",
  draftUpdate: "Update drafts",
  draftDelete: "Delete drafts",
  labelCreate: "Create labels",
  labelRename: "Rename labels",
  labelDelete: "Delete labels",
} satisfies Record<GmailResourceActionType, string>;

export function actionKinds(labels: Record<string, string>): ActionKind[] {
  return Object.entries(labels).map(([tag, label]) => ({tag, label}));
}

export function gmailAutoApprovalMetadata(
    action: GmailAction,
): Partial<Pick<ActionDescription, "actionKind" | "autoApprovable">> {
  switch (action.type) {
  case "send":
  case "draftSend":
    return {};
  case "messageMutation":
    return {
      actionKind: {tag: action.operation, label: MESSAGE_MUTATION_LABELS[action.operation]},
      autoApprovable: true,
    };
  case "draftCreate":
  case "draftUpdate":
  case "draftDelete":
  case "labelCreate":
  case "labelRename":
  case "labelDelete":
    return {
      actionKind: {tag: action.type, label: RESOURCE_ACTION_LABELS[action.type]},
      autoApprovable: true,
    };
  default:
    action satisfies never;
    throw new Error(`Unknown Gmail action type: ${(action as GmailAction).type}`);
  }
}

/**
 * Legacy non-delivery actions remain applyable. Outbound records fail closed because this state
 * cannot prove whether a previous implementation already attempted delivery.
 */
export type LegacyGmailAction =
  | {type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string}
  | {type: "send"; to: string[]; subject: string; body: string}
  | {
      type: "reply";
      sourceMessageId: string;
      threadId: string;
      body: string;
      replyAll: boolean;
      sourceWasSent?: boolean;
    }
  | {type: "forward"; sourceMessageId: string; to: string[]; body?: string};

export type StoredGmailAction = GmailAction | LegacyGmailAction;

export function isDraftAction(action: StoredGmailAction): action is GmailDraftCreateAction |
    GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction {
  return ["draftCreate", "draftUpdate", "draftDelete", "draftSend"].includes(action.type);
}

export function isLabelAction(action: StoredGmailAction): action is GmailLabelCreateAction |
    GmailLabelRenameAction | GmailLabelDeleteAction {
  return ["labelCreate", "labelRename", "labelDelete"].includes(action.type);
}

export function isLegacyGmailAction(action: StoredGmailAction): action is LegacyGmailAction {
  return action.type === "archive" || action.type === "trash" || action.type === "markRead" ||
    action.type === "markUnread" || action.type === "reply" || action.type === "forward" ||
    (action.type === "send" && !("spec" in action));
}

export function actionSourceAttachment(action: StoredGmailAction): GmailSourceAttachment | undefined {
  if (action.type === "draftCreate") return action.sourceAttachment;
  if (action.type === "draftUpdate" || action.type === "draftDelete" ||
      action.type === "draftSend") return action.sourceAttachment;
  if (action.type === "send" && "spec" in action) return action.sourceAttachment;
  return undefined;
}

export function actionFileReferences(action: StoredGmailAction): GmailForwardSnapshotReference[] {
  const source = actionSourceAttachment(action);
  const attachments = action.type === "draftCreate" ? action.draft.attachments
    : action.type === "draftUpdate" ? action.after.attachments
    : action.type === "draftSend" ? action.approved.attachments
    : action.type === "send" && "spec" in action ? action.uploadedAttachments ?? [] : [];
  return [...(source ? [source] : []), ...attachments.flatMap(attachment =>
    attachment.file ? [attachment.file] : [])];
}

export function draftFileReferences(resource: GmailDraftResource): GmailForwardSnapshotReference[] {
  if (resource.status !== "active") return [];
  return [...(resource.forwardSnapshot ? [resource.forwardSnapshot] : []),
    ...(resource.appliedAttachments ?? []).flatMap(attachment => attachment.file ? [attachment.file] : [])];
}

export function actionResourceId(action: StoredGmailAction): string | undefined {
  if (action.type === "draftCreate") return action.draft.logicalId;
  if (action.type === "draftUpdate" || action.type === "draftDelete" || action.type === "draftSend") {
    return action.draftId;
  }
  if (action.type === "labelCreate") return action.label.logicalId;
  if (action.type === "labelRename" || action.type === "labelDelete") return action.labelId;
  return undefined;
}

