import type { CreatedWorkpieceName } from "./messageTypes";

/**
 * The pending "changes" messages one agent turn produced (see pendingChangeByTurnItemSeq):
 * reverting from `revertFrom` through `through` undoes the batch, deleting the creations.
 */
export type PendingTurnChanges = {
  revertFrom: number;
  through: number;
  createdWorkpieces: CreatedWorkpieceName[];
};

/**
 * Suffix appended to discard labels when the discarded changes include gadget creations, since
 * reverting also deletes the created gadgets: " (deletes gadgets “A”, “B”)".
 */
export function describeCreatedWorkpieceDeletion(created: CreatedWorkpieceName[] | undefined): string {
  if (!created || created.length === 0) return "";
  const titles = created.map((c) => `“${c.title}”`);
  return ` (deletes ${titles.length === 1 ? "gadget" : "gadgets"} ${titles.join(", ")})`;
}

/** Label for the per-turn discard-changes button. */
export function getDiscardLabel(
  isTrailing: boolean | undefined,
  createdWorkpieces?: CreatedWorkpieceName[],
): string {
  const base = isTrailing
    ? "Discard changes from this response"
    : "Discard changes from this response and later responses";
  return base + describeCreatedWorkpieceDeletion(createdWorkpieces);
}

/** Label for the per-message discard button on a user's saved edits. */
export function getSavedEditsDiscardLabel(
  isTrailing: boolean | undefined,
  createdWorkpieces?: CreatedWorkpieceName[],
): string {
  const base = isTrailing
    ? "Discard saved edits"
    : "Discard saved edits and later changes";
  return base + describeCreatedWorkpieceDeletion(createdWorkpieces);
}
