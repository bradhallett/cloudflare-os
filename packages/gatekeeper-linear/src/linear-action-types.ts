// The Linear action records: what a queued write stores in the gatekeeper DO, and the
// approver-facing description draft submitted beside it. The apply/reject/revert methods that
// drive these records live on LinearGatekeeperImpl (linear-gatekeeper.ts).

import type { RenderedDescription } from "@gadgets/gatekeeper-kit/action-description";
import type {
  IssueCreateInput,
  IssueUpdateInput,
  RawComment,
  RawIssue,
  RawLabel,
  RawProject,
  RawUser,
  RawWorkflowState,
} from "./linear-api";

// ---------------------------------------------------------------------------
// Action records — stored in the gatekeeper DO and applied/reverted on approval.

/**
 * Lifecycle state of a stored action: pending until claimed by the applier, then applied or
 * failed once the Linear API call resolves.
 */
export type ActionStatus = "pending" | "claimed" | "applied" | "failed";

/**
 * A display-level patch merged into a RawIssue when simulating a pending updateIssue action.
 * Captured at submit time (with resolved display objects) so reads need no extra lookups.
 */
export type IssueOverlayPatch = {
  title?: string;
  description?: string;
  priority?: number;
  dueDate?: string | null;
  state?: RawWorkflowState;
  assignee?: RawUser | null;
  project?: RawProject | null;
  parent?: RawIssue["parent"];
};

/**
 * A stored action record: the discriminated union of every action kind the Linear gatekeeper can
 * queue, tagged with its lifecycle state and, once terminal, its failure reason. The DO persists
 * these; approval applies the forward call and keeps the record for revert.
 */
export type StoredAction = { id: number; status: ActionStatus; failure?: string } & (
  | { kind: "createIssue"; input: IssueCreateInput;
      provisionalId: string; createdIssueId?: string; synthetic: RawIssue; title: string }
  | { kind: "updateIssue"; issueRef: string;
      input: IssueUpdateInput; previous: IssueUpdateInput; patch: IssueOverlayPatch; title: string }
  | { kind: "addLabels"; issueRef: string;
      labelIds: string[]; labels: RawLabel[]; title: string }
  | { kind: "removeLabels"; issueRef: string;
      labelIds: string[]; title: string }
  | { kind: "postComment"; issueRef: string; body: string;
      createdCommentId?: string; synthetic: RawComment; title: string }
  | { kind: "createLabel"; teamId: string; name: string;
      color?: string; description?: string; createdLabelId?: string; synthetic: RawLabel; title: string }
  | { kind: "archive"; issueRef: string; archived: boolean; title: string }
);

/**
 * Distributive Omit so the union's variant-specific fields survive; enqueue assigns id + status.
 */
export type StoredActionDraft = StoredAction extends infer T
  ? T extends { id: number } ? Omit<T, "id" | "status"> : never
  : never;

/**
 * The approver-facing text is always built with `buildDescription`, so every value the agent
 * supplied is shown in full and the completeness claim is the builder's, never hand-set.
 */
export type ActionDescriptionDraft = { title: string; implementsRevert: boolean } & RenderedDescription;
