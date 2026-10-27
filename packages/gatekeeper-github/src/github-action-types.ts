// The queued-action records the GitHub gatekeeper stores, and the derived state it keeps beside
// them. Declared apart from the Durable Object so the read paths (which overlay pending actions
// onto remote data) and the write paths (which create and apply them) share one vocabulary.
// Same shape as gatekeeper-gitlab's, with GitHub's names and options.

import { GitHubApiError } from "./github-api";
import type { ResourceKind } from "./github-env";
import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitHubCreateIssueOptions,
  GitHubCreatePullRequestOptions,
  GitHubDraftDiffComment,
  GitHubIssueState,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestReviewDraft,
} from "./types";

export type EntityKind = "issue" | "pull";

export type Cached<T> = {
  fetchedAt: number;
  value: T;
  etag?: string;
  generation: number;
};

export type StoredProvisionalResource = {
  kind: EntityKind;
  realId?: string;
};

export type StoredActionState = "staged" | "pending" | "approved" | "rejected";

type BaseAction = {
  approvalId: number;
  submittedAt: number;
  owner: string;
  repo: string;
};

export type CreateIssueAction = BaseAction & {
  type: "createIssue";
  provisionalId: string;
  options: GitHubCreateIssueOptions;
};

export type CreatePullRequestAction = BaseAction & {
  type: "createPullRequest";
  provisionalId: string;
  options: GitHubCreatePullRequestOptions;
};

type BaseEntityAction = BaseAction & {
  targetKind: EntityKind;
  targetId: string;
};

export type SetTitleAction = BaseEntityAction & {
  type: "setTitle";
  title: string;
  previousTitle: string;
};

export type SetBodyAction = BaseEntityAction & {
  type: "setBody";
  bodyMarkdown: string;
  previousBodyMarkdown: string;
};

export type AddLabelsAction = BaseEntityAction & {
  type: "addLabels";
  labels: string[];
  previousLabels: string[];
};

export type RemoveLabelsAction = BaseEntityAction & {
  type: "removeLabels";
  labels: string[];
  previousLabels: string[];
};

export type ChangeStateAction = BaseEntityAction & {
  type: "changeState";
  state: GitHubIssueState;
  reason?: "completed" | "notPlanned";
  previousState: GitHubIssueState;
  previousReason?: "completed" | "notPlanned";
};

export type PostCommentAction = BaseEntityAction & {
  type: "postComment";
  bodyMarkdown: string;
  provisionalCommentId: string;
  /** The comment GitHub created, once the apply dispatched: what its revert deletes. */
  createdCommentId?: number;
};

export type StoredDraftDiffComment = GitHubDraftDiffComment & {
  provisionalCommentId: string;
};

export type PostReviewAction = BaseAction & {
  type: "postReview";
  pullId: string;
  provisionalReviewId: string;
  review: Omit<GitHubPullRequestReviewDraft, "diffComments"> & {
    diffComments?: StoredDraftDiffComment[];
  };
};

export type ReplyToDiffCommentAction = BaseAction & {
  type: "replyToDiffComment";
  pullId: string;
  commentId: string;
  bodyMarkdown: string;
  provisionalCommentId: string;
  /** The reply GitHub created, once the apply dispatched: what its revert deletes. */
  createdCommentId?: number;
};

/**
 * A queued merge, bound at queue time to the head it was approved against (`expectedHeadSha`,
 * sent as the merge's `sha`), so commits pushed in between never merge unreviewed.
 */
export type MergePullRequestAction = BaseAction & {
  type: "mergePullRequest";
  pullId: string;
  options?: GitHubPullRequestMergeOptions;
  expectedHeadSha: string;
  /** The head branch when it lives in this repo (not a fork): the branch queued pushes move. */
  headBranch: string | null;
};

/**
 * A queued git push (see `GitHubRepo.push()`). The expected remote ref state is bound at queue
 * time: what the user approves is "move `branch` from `expectedOldSha` to `newSha`", not "move
 * `branch` from wherever it is by then" -- apply enforces `expectedOldSha` via receive-pack's
 * old-sha compare-and-swap, so a branch that moved between approval and apply fails cleanly
 * instead of being clobbered. `expectedOldSha` doubles as the revert target (`ZERO_OID` means
 * the push creates the branch, and revert deletes it).
 */
export type PushAction = BaseAction & {
  type: "push";
  branch: string;
  expectedOldSha: string;
  newSha: string;
  force: boolean;
};

export type GitHubAction =
  | CreateIssueAction
  | CreatePullRequestAction
  | SetTitleAction
  | SetBodyAction
  | AddLabelsAction
  | RemoveLabelsAction
  | ChangeStateAction
  | PostCommentAction
  | PostReviewAction
  | ReplyToDiffCommentAction
  | MergePullRequestAction
  | PushAction;

/**
 * The kind of each action, which users' auto-approval rules key on, so a tag must never change. A
 * force push has a kind of its own: enabling ordinary pushes does not let history be rewritten.
 */
export const ACTION_KINDS = {
  createIssue: { tag: "github.createIssue", label: "Create issues" },
  createPullRequest: { tag: "github.createPullRequest", label: "Create pull requests" },
  setTitle: { tag: "github.setTitle", label: "Rename issues and pull requests" },
  setBody: { tag: "github.setBody", label: "Edit issue and pull request bodies" },
  addLabels: { tag: "github.addLabels", label: "Add labels" },
  removeLabels: { tag: "github.removeLabels", label: "Remove labels" },
  changeState: { tag: "github.changeState", label: "Close and reopen issues and pull requests" },
  postComment: { tag: "github.postComment", label: "Post comments" },
  postReview: { tag: "github.postReview", label: "Submit reviews that comment or request changes" },
  replyToDiffComment: { tag: "github.replyToDiffComment", label: "Reply to diff threads" },
  mergePullRequest: { tag: "github.mergePullRequest", label: "Merge pull requests" },
  push: { tag: "github.push", label: "Push commits" },
  forcePush: { tag: "github.forcePush", label: "Force-push commits" },
} satisfies Record<GitHubAction["type"] | "forcePush", ActionKind>;

type AutoApprovalKind = keyof typeof ACTION_KINDS;

// The auto-approvable kinds each binding's session can submit, so a pre-approval UI lists only
// those its actions can carry. Merges never appear: they are never auto-approvable.
const ISSUE_ACTIONS: AutoApprovalKind[] =
  ["setTitle", "setBody", "addLabels", "removeLabels", "changeState", "postComment"];
const PULL_ACTIONS: AutoApprovalKind[] = [...ISSUE_ACTIONS, "postReview", "replyToDiffComment"];
export const BINDING_ACTIONS: Record<ResourceKind, AutoApprovalKind[]> = {
  repo: ["createIssue", "createPullRequest", ...PULL_ACTIONS, "push", "forcePush"],
  issue: ISSUE_ACTIONS,
  pull: PULL_ACTIONS,
};

/**
 * The action's kind, and whether it may be applied without a person once the user has enabled
 * that kind. Every action may be except a merge and an approving review, which always wait for a
 * person: an approval shares its kind with the other reviews, so enabling those never covers it.
 */
export function autoApprovalOf(action: GitHubAction): Pick<ActionDescription, "actionKind" | "autoApprovable"> {
  const kind: AutoApprovalKind = action.type === "push" && action.force ? "forcePush" : action.type;
  return {
    actionKind: ACTION_KINDS[kind],
    autoApprovable: action.type !== "mergePullRequest" &&
      !(action.type === "postReview" && action.review.decision === "approve"),
  };
}

/**
 * Whether a dispatch failure leaves GitHub's outcome unknown. Transport failures and server
 * errors might have committed; client errors, git compare-and-swap refusals, and validation
 * failures definitively did not.
 * @param error The failure thrown by a dispatch.
 * @returns Whether the provider effect is unknown.
 */
export function isGitHubOutcomeUnknown(error: unknown): boolean {
  if (error instanceof GitHubApiError) return error.status >= 500;
  // A failed `fetch` throws TypeError; `AbortSignal.timeout` aborts with a TimeoutError
  // DOMException. Both mean the request's fate is unknown.
  return error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError");
}

export type StoredActionRecord = {
  action: GitHubAction;
  state: StoredActionState;
  appliedAt?: number;
  rejectedAt?: number;
  /** Legacy field, read only by the one-time adoption onto the action journal. */
  revertInfo?: { type: "issueComment" | "reviewComment"; commentId: number };
};

/**
 * Whether an action's provider call is compare-and-swap bound -- a push whose ref update carries
 * its queue-time old sha, a merge bound to the head it was approved at -- so re-delivering it can
 * never repeat the effect: GitHub refuses the repeat and the refusal path settles the apply. An
 * interrupted dispatch of such an action stays appliable; an unbound one may have committed, so
 * its outcome is terminal-unknown instead.
 * @param action The action being applied.
 * @returns Whether a re-dispatch is provider-refused.
 */
export function isCasBound(action: GitHubAction): boolean {
  return action.type === "push" || action.type === "mergePullRequest";
}

