import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/** An "action" message: a gatekeeper permission request or observation card. */
export type ActionChatMessage = Extract<AiChatMessage, { type: "action" }>;
/** A "changes" message: one recorded batch of code changes. */
export type ChangeChatMessage = Extract<AiChatMessage, { type: "changes" }>;

/** An "action" message whose log is an observation (a resource the agent read). */
export type ObservationChatMessage = ActionChatMessage & {
  actionLog: NonNullable<ActionChatMessage["actionLog"]> & { type: "observation" };
};

/**
 * A workpiece created by a turn's pending changes (see `createdGadgets` on the "changes"
 * message body). Reverting the turn deletes it, so discard affordances name it. Worktrees don't
 * count: no revert deletes a worktree (see `createdWorktrees`).
 */
export type CreatedWorkpieceName = { type: "gadget"; title: string };

/** The creations one "changes" message records that reverting it would delete. */
export function createdWorkpiecesOf(m: ChangeChatMessage): CreatedWorkpieceName[] {
  return (m.createdGadgets ?? []).map(({ title }) => ({ type: "gadget" as const, title }));
}

/**
 * Whether the message records nothing but worktree creations. Reverting such a message changes
 * nothing, since no revert deletes a worktree, so it gets no discard affordance.
 */
export function recordsOnlyWorktreeCreations(m: ChangeChatMessage): boolean {
  return !!m.createdWorktrees?.length && m.change === undefined && !m.pins?.length &&
    !m.createdGadgets?.length && !m.addedBindings?.length && !m.worktreeCommits?.length &&
    m.mainlineMerge === undefined && !m.conversionBoundary;
}

/** Whether the message is an action message whose log is an observation. */
export function isObservationActionMessage(msg: AiChatMessage): msg is ObservationChatMessage {
  return msg.type === "action" && msg.actionLog?.type === "observation";
}
