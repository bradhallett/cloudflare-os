// The GitHub gatekeeper's response-to-domain normalizers, listing predicates and comparators,
// shared by the Durable Object's read paths (listings, searches, discussion threads) and its
// event descriptions. Same shape as gatekeeper-gitlab's gitlab-normalize.ts.

import { codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { actorFromUser } from "./git-commits";
import type {
  GitHubCompareResponse,
  GitHubIssueCommentResponse,
  GitHubIssueResponse,
  GitHubLabelResponse,
  GitHubPullRequestResponse,
  GitHubPullRequestReviewCommentResponse,
  GitHubPullRequestReviewResponse,
} from "./github-api";
import type {
  GitHubActor,
  GitHubDiffCommentTarget,
  GitHubDiscussionEntry,
  GitHubEventKind,
  GitHubEventReview,
  GitHubIssueDetails,
  GitHubIssueFilter,
  GitHubIssueSearch,
  GitHubIssueSummary,
  GitHubLabel,
  GitHubPullRequestBranchRef,
  GitHubPullRequestDetails,
  GitHubPullRequestEvent,
  GitHubPullRequestFilter,
  GitHubPullRequestSearch,
  GitHubPullRequestSummary,
  GitHubRepoRef,
  GitHubReviewDecision,
  GitHubSubmittedDiffComment,
} from "./types";

export type GitHubDiscussionCommentEntry = Extract<GitHubDiscussionEntry, { kind: "comment" }>;

export function canonicalRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

export function issueUrl(owner: string, repo: string, id: string): string {
  return `${canonicalRepoUrl(owner, repo)}/issues/${id}`;
}

export function pullUrl(owner: string, repo: string, id: string): string {
  return `${canonicalRepoUrl(owner, repo)}/pull/${id}`;
}

export function repoRef(owner: string, repo: string): GitHubRepoRef {
  return {
    owner,
    name: repo,
    fullName: `${owner}/${repo}`,
    url: canonicalRepoUrl(owner, repo),
  };
}

/**
 * The compare response's merge base. GitHub documents `merge_base_commit` as always present; a
 * response without one is treated as malformed rather than approximated -- the base tip
 * (`base_commit`) is *not* the merge base, and reads that need one (tree diffs, merge-base
 * lookups) would silently return wrong data if it stood in.
 */
export function mergeBaseOfCompare(compare: GitHubCompareResponse): GitOid {
  const sha = compare.merge_base_commit?.sha;
  if (sha === undefined) {
    throw new Error("GitHub's compare response did not include a merge base.");
  }
  return sha;
}

function actorsFromUsers(
  users?: Array<{ login: string; name?: string | null; html_url: string; avatar_url?: string }> | null,
): GitHubActor[] {
  const result: GitHubActor[] = [];
  for (const user of users ?? []) {
    const actor = actorFromUser(user);
    if (actor) {
      result.push(actor);
    }
  }
  return result;
}

export function actorFromLogin(login: string): GitHubActor {
  return {
    login,
    url: `https://github.com/${login}`,
  };
}

function labelFromResponse(label: GitHubLabelResponse): GitHubLabel {
  return {
    name: label.name,
    color: label.color,
    description: label.description ?? undefined,
  };
}

export function dedupeLabels(labels: GitHubLabel[]): GitHubLabel[] {
  const seen = new Set<string>();
  const result: GitHubLabel[] = [];

  for (const label of labels) {
    const key = label.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(label);
    }
  }

  return result;
}

export function textSnippet(markdown?: string, fallback = ""): string {
  const text = (markdown ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return fallback;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

export function parseDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

export function normalizeStateReason(reason?: string | null): "completed" | "notPlanned" | undefined {
  switch (reason) {
    case "completed":
      return "completed";
    case "not_planned":
      return "notPlanned";
    default:
      return undefined;
  }
}

export function denormalizeStateReason(reason?: "completed" | "notPlanned"): "completed" | "not_planned" | null {
  switch (reason) {
    case "completed":
      return "completed";
    case "notPlanned":
      return "not_planned";
    default:
      return null;
  }
}

export function reviewDecisionFromState(state: string): GitHubReviewDecision {
  switch (state) {
    case "APPROVED":
      return "approve";
    case "CHANGES_REQUESTED":
      return "requestChanges";
    default:
      return "comment";
  }
}

export function normalizeIssueSummary(owner: string, repo: string, response: GitHubIssueResponse): GitHubIssueSummary {
  return {
    repo: repoRef(owner, repo),
    id: String(response.number),
    url: issueUrl(owner, repo, String(response.number)),
    title: response.title,
    state: response.state,
    labels: response.labels.map(labelFromResponse),
    author: actorFromUser(response.user),
    assignees: actorsFromUsers(response.assignees),
    createdAt: new Date(response.created_at),
    updatedAt: new Date(response.updated_at),
    closedAt: parseDate(response.closed_at),
    commentCount: response.comments,
  };
}

export function normalizeIssueDetails(owner: string, repo: string, response: GitHubIssueResponse): GitHubIssueDetails {
  return {
    ...normalizeIssueSummary(owner, repo, response),
    bodyMarkdown: response.body ?? "",
  };
}

function normalizePullBranchRef(
  fallbackOwner: string,
  fallbackRepo: string,
  response: GitHubPullRequestResponse["head"],
): GitHubPullRequestBranchRef {
  const branchRepo = response.repo;
  const owner = branchRepo?.owner.login ?? fallbackOwner;
  const repo = branchRepo?.name ?? fallbackRepo;
  return {
    ref: response.ref,
    sha: response.sha,
    repo: repoRef(owner, repo),
  };
}

/**
 * Whether a pull request's head branch is in the bound repository rather than a fork. Compared
 * with the base repository from the same response, not with props: those keep the case the
 * binding's URL was typed in, and the name from before a rename.
 */
export function isOwnHead(pull: Pick<GitHubPullRequestSummary, "head" | "base">): boolean {
  return pull.head.repo.fullName === pull.base.repo.fullName;
}

export function normalizePullSummary(
  owner: string,
  repo: string,
  response: GitHubPullRequestResponse,
): GitHubPullRequestSummary {
  return {
    ...normalizeIssueSummary(owner, repo, response),
    draft: response.draft,
    merged: !!response.merged_at,
    head: normalizePullBranchRef(owner, repo, response.head),
    base: normalizePullBranchRef(owner, repo, response.base),
  };
}

export function normalizePullDetails(
  owner: string,
  repo: string,
  response: GitHubPullRequestResponse,
): GitHubPullRequestDetails {
  return {
    ...normalizeIssueDetails(owner, repo, response),
    ...normalizePullSummary(owner, repo, response),
    mergeable: response.mergeable ?? undefined,
    requestedReviewers: actorsFromUsers(response.requested_reviewers),
    commits: response.commits,
    additions: response.additions,
    deletions: response.deletions,
    changedFiles: response.changed_files,
  };
}

export function summarizeIssueDetails(details: GitHubIssueDetails): GitHubIssueSummary {
  const { bodyMarkdown: _bodyMarkdown, ...summary } = details;
  return summary;
}

export function summarizePullDetails(details: GitHubPullRequestDetails): GitHubPullRequestSummary {
  const {
    bodyMarkdown: _bodyMarkdown,
    mergeable: _mergeable,
    requestedReviewers: _requestedReviewers,
    commits: _commits,
    additions: _additions,
    deletions: _deletions,
    changedFiles: _changedFiles,
    ...summary
  } = details;
  return summary;
}

export function stableKey(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function matchesAllLabels(item: { labels: GitHubLabel[] }, labels?: string[]): boolean {
  if (!labels || labels.length === 0) return true;
  const available = new Set(item.labels.map(label => label.name.toLowerCase()));
  return labels.every(label => available.has(label.toLowerCase()));
}

/** GitHub matches logins case-insensitively. */
function sameLogin(login: string | undefined, wanted: string): boolean {
  return login?.toLowerCase() === wanted.toLowerCase();
}

/** The structured predicates issue and pull request searches share with the issue listing. */
export function issueMatchesFilter(
  item: GitHubIssueSummary | GitHubPullRequestSummary,
  filter?: Pick<GitHubIssueFilter, "state" | "labels" | "author" | "assignee">,
): boolean {
  if (!filter) return true;
  const { state, labels, author, assignee } = filter;
  if (state && state !== "all" && item.state !== state) return false;
  if (!matchesAllLabels(item, labels)) return false;
  if (author && !sameLogin(item.author?.login, author)) return false;
  if (assignee && !item.assignees.some(actor => sameLogin(actor.login, assignee))) return false;
  return true;
}

export function pullMatchesFilter(item: GitHubPullRequestSummary, filter?: GitHubPullRequestFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (filter.head) {
    // `owner:ref` or a bare `ref`; refs are case-sensitive, owners are logins.
    const colon = filter.head.indexOf(":");
    if (item.head.ref !== filter.head.slice(colon + 1)) return false;
    if (colon >= 0 && !sameLogin(item.head.repo.owner, filter.head.slice(0, colon))) return false;
  }
  if (filter.base && item.base.ref !== filter.base) return false;
  return true;
}

export function issueMatchesSearch(item: GitHubIssueDetails, query: GitHubIssueSearch): boolean {
  return issueMatchesFilter(item, query)
    && `${item.title}\n${item.bodyMarkdown}`.toLowerCase().includes(query.text.toLowerCase());
}

/** A pull request summary carrying its body, which the text search matches against. */
export type PullSearchRow = GitHubPullRequestSummary & { bodyMarkdown: string };

export function pullMatchesSearch(item: PullSearchRow, query: GitHubPullRequestSearch): boolean {
  return issueMatchesFilter(item, query)
    && (query.merged === undefined || item.merged === query.merged)
    && (query.draft === undefined || item.draft === query.draft)
    && `${item.title}\n${item.bodyMarkdown}`.toLowerCase().includes(query.text.toLowerCase());
}

export function issueComparator(
  sort: "created" | "updated" | "comments" = "created",
  direction: "asc" | "desc" = "desc",
): (a: GitHubIssueSummary, b: GitHubIssueSummary) => number {
  const factor = direction === "asc" ? 1 : -1;
  return (a, b) => {
    let delta = 0;
    switch (sort) {
      case "comments":
        delta = a.commentCount - b.commentCount;
        break;
      case "updated":
        delta = a.updatedAt.getTime() - b.updatedAt.getTime();
        break;
      default:
        delta = a.createdAt.getTime() - b.createdAt.getTime();
        break;
    }
    if (delta === 0) {
      delta = a.id.localeCompare(b.id);
    }
    return delta * factor;
  };
}

export function pullComparator(
  sort: "created" | "updated" | "popularity" | "long-running" = "created",
  direction: "asc" | "desc" = sort === "created" ? "desc" : "asc",
): (a: GitHubPullRequestSummary, b: GitHubPullRequestSummary) => number {
  const factor = direction === "asc" ? 1 : -1;
  return (a, b) => {
    let delta = 0;
    switch (sort) {
      case "popularity":
        // Absent from listing rows (see GitHubPullRequestSummary); rank those as uncommented.
        delta = (a.commentCount ?? 0) - (b.commentCount ?? 0);
        break;
      case "updated":
      case "long-running":
        delta = a.updatedAt.getTime() - b.updatedAt.getTime();
        break;
      default:
        delta = a.createdAt.getTime() - b.createdAt.getTime();
        break;
    }
    if (delta === 0) {
      delta = a.id.localeCompare(b.id);
    }
    return delta * factor;
  };
}

function parseDiffSide(side?: "LEFT" | "RIGHT" | null): "old" | "new" {
  return side === "LEFT" ? "old" : "new";
}

export function commentTargetFromResponse(comment: GitHubPullRequestReviewCommentResponse): GitHubDiffCommentTarget {
  if (comment.subject_type === "file") {
    return {
      path: comment.path,
      subjectType: "file",
    };
  }

  return {
    path: comment.path,
    subjectType: "line",
    line: comment.line ?? comment.original_line ?? 1,
    side: parseDiffSide(comment.side),
    startLine: comment.start_line ?? comment.original_start_line ?? undefined,
    startSide: comment.start_side ? parseDiffSide(comment.start_side) : undefined,
  };
}

export function discussionCommentFromResponse(comment: GitHubIssueCommentResponse): GitHubDiscussionCommentEntry {
  return {
    kind: "comment",
    id: String(comment.id),
    author: actorFromUser(comment.user),
    bodyMarkdown: comment.body ?? "",
    createdAt: new Date(comment.created_at),
    updatedAt: parseDate(comment.updated_at),
    url: comment.html_url,
  };
}

export function submittedDiffCommentFromResponse(comment: GitHubPullRequestReviewCommentResponse): GitHubSubmittedDiffComment {
  return {
    id: String(comment.id),
    threadId: String(comment.in_reply_to_id ?? comment.id),
    target: commentTargetFromResponse(comment),
    author: actorFromUser(comment.user),
    bodyMarkdown: comment.body ?? "",
    createdAt: new Date(comment.created_at),
    updatedAt: parseDate(comment.updated_at),
    url: comment.html_url,
  };
}

export const PULL_REQUEST_ACTION_WORDS: Record<GitHubPullRequestEvent["action"], string> = {
  opened: "opened",
  closed: "closed",
  merged: "merged",
  reopened: "reopened",
  readyForReview: "marked ready for review",
  pushed: "pushed to",
};

const EVENT_KIND_NAMES: Record<GitHubEventKind, string> = {
  issue: "issue",
  pullRequest: "pull request",
  comment: "comment",
  review: "review",
  push: "push",
  tag: "tag",
};

/** E.g. "issue, comment and push". */
export function listEventKinds(kinds: GitHubEventKind[], conjunction: "and" | "or"): string {
  const names = kinds.map(kind => EVENT_KIND_NAMES[kind]);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}

/** What a push did to a branch or tag, e.g. "moving it from `a` to `b`". */
export function refChange(before: string | undefined, after: string | undefined): string {
  if (after === undefined) return "deleting it";
  return `${before === undefined ? "creating it at" : `moving it from ${codeSpan(before)} to`} ${codeSpan(after)}`;
}

export function eventReview(review: GitHubPullRequestReviewResponse): GitHubEventReview {
  return {
    id: String(review.id),
    author: actorFromUser(review.user),
    // Webhooks spell the state in lower case, the REST API in upper case.
    decision: reviewDecisionFromState(review.state.toUpperCase()),
    bodyMarkdown: review.body ?? "",
    ...review.commit_id ? { commitId: review.commit_id } : {},
    ...review.submitted_at ? { submittedAt: new Date(review.submitted_at) } : {},
    url: review.html_url,
  };
}
