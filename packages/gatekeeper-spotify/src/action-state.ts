// The state machine every queued Spotify action record lives by (see `SpotifyGatekeeperImpl`).
//
// A write is first *staged* while it is being offered to the approval queue, becomes *pending*
// once the queue has taken it, and ends in exactly one terminal state: *approved* (performed on
// Spotify), *rejected*, or *failed* (an apply threw; the overseer may retry). Terminal is
// terminal: a retired record — one already applied or rejected — must never become live again,
// because an applied action that went back to pending could be applied a second time. The paths
// that could do that are the ones that resume after an await (a submit or apply whose RPC reply
// was delayed while the queue applied or rejected the action through another request), so every
// state write goes through `canTransition` rather than assigning `state` at the write site.

/** The lifecycle states of a queued Spotify action record. */
export type ActionState = "staged" | "pending" | "approved" | "rejected" | "failed";

/**
 * The legal steps. `failed` may repeat (each retry that throws re-marks it failed); `approved`
 * and `rejected` have no outgoing edges, which is what keeps applied actions applied.
 */
const TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  staged: ["pending", "approved", "rejected", "failed"],
  pending: ["approved", "rejected", "failed"],
  failed: ["approved", "rejected", "failed"],
  approved: [],
  rejected: [],
};

/** Whether an action record in state `from` may move to `to`. */
export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}
