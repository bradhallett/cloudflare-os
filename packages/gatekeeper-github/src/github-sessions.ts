// The GitHub gatekeeper's session objects: the repo/issue/pull-request facades the DO hands
// out over RPC, and the webhook delivery target a hook subscription binds. Same shape as
// gatekeeper-gitlab's gitlab-sessions.ts.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  type ApprovalQueue,
  type Cursor,
} from "@gadgets/workshop-shared/gatekeeper";
import { commitIdsOfSummary, isCommitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { SessionGitCache, requestedPageSize } from "@gadgets/gatekeeper-kit/cursors";
import { commitIdsOfPullSummary } from "./git-commits";
import { validateBranchName } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitHubGatekeeperImpl } from "./github-gatekeeper";
import type { EntityKind } from "./github-action-types";
import type {
  GitHubEventHookTarget,
  GitHubHookDelivery,
} from "./github-hooks";
import type { GitHubWebhookEvent } from "./github-webhook-events";
import type {
  GitHubBranchFilter,
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitFilter,
  GitHubCommitSummary,
  GitHubCreateIssueOptions,
  GitHubCreatePullRequestOptions,
  GitHubDiffThread,
  GitHubDiscussionEntry,
  GitHubIssue,
  GitHubIssueDetails,
  GitHubIssueFilter,
  GitHubIssueSearch,
  GitHubIssueSummary,
  GitHubPageOptions,
  GitHubPullRequest,
  GitHubPullRequestDetails,
  GitHubPullRequestDiff,
  GitHubPullRequestFilter,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestReviewDraft,
  GitHubPullRequestSearch,
  GitHubPullRequestSummary,
  GitHubRepoMetadata,
  GitHubRepo as GitHubRepoSession,
  GitHubSubscribeOptions,
  GitHubTagSummary,
} from "./types";

// Exported (like the impls below) for the workerd wiring tests, which instantiate sessions
// directly against fake gatekeepers -- see __tests__/workerd/session-git.test.ts.
@validateRpc()
export class GitHubRepoSessionImpl extends RpcTarget implements GitHubRepoSession {
  #gatekeeper: GitHubGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
    this.#gitCache = new SessionGitCache(approvalQueue, { withhold: id => gatekeeper.isSimulatedCommitId(id) });
  }

  [Symbol.dispose](): void {
    this.#gitCache.dispose();
    (this.#approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getMetadata(): Promise<GitHubRepoMetadata> {
    const metadata = await this.#gatekeeper.repoMetadata();
    await this.#approvalQueue.authorizeObservation({
      title: `Read repository metadata for ${metadata.fullName}`,
      description: `Read basic metadata for the GitHub repository ${metadata.fullName}.`,
    });
    return metadata;
  }

  async createIssue(options: GitHubCreateIssueOptions): Promise<GitHubIssue> {
    const action = await this.#gatekeeper.prepareCreateIssue(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create issue ${options.title}`,
      implementsRevert: false,
    });
    return new GitHubIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId, "issue");
  }

  async createPullRequest(options: GitHubCreatePullRequestOptions): Promise<GitHubPullRequest> {
    const action = await this.#gatekeeper.prepareCreatePullRequest(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create pull request ${options.title}`,
      implementsRevert: false,
    });
    return new GitHubPullRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId);
  }

  /**
   * Opening a capability is not an observation: the caller learns only that the number exists,
   * and the returned stub's getDetails() records the actual read.
   */
  async getIssue(id: string): Promise<GitHubIssue> {
    await this.#gatekeeper.openIssue(id);
    return new GitHubIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), id, "issue");
  }

  async getPullRequest(id: string): Promise<GitHubPullRequest> {
    await this.#gatekeeper.openPullRequest(id, await this.#gitCache.stub());
    return new GitHubPullRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async listIssues(options?: GitHubIssueFilter): Promise<Cursor<GitHubIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List issues`,
      description: `List issues in the GitHub repository.`,
    });
    return this.#gatekeeper.listIssues(options, requestedPageSize(options));
  }

  async searchIssues(query: GitHubIssueSearch): Promise<Cursor<GitHubIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search issues for "${query.text}"`,
      description: `Search issues in the GitHub repository for "${query.text}".`,
    });
    return this.#gatekeeper.searchIssues(query, requestedPageSize(query));
  }

  async listPullRequests(options?: GitHubPullRequestFilter): Promise<Cursor<GitHubPullRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List pull requests`,
      description: `List pull requests in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listPullRequests(
      options, requestedPageSize(options), await this.#gitCache.stub());
    // Simulated ids -- heads of queued pushes, which listings show as if already pushed -- are
    // withheld from advertising: they are not on GitHub yet, and the hint would outlive a
    // rejection (see GitHubGatekeeperImpl.isSimulatedCommitId). Checked live per page, since a
    // push may be queued while the cursor is being drained.
    return await this.#gitCache.wrap(cursor, commitIdsOfPullSummary);
  }

  async searchPullRequests(query: GitHubPullRequestSearch): Promise<Cursor<GitHubPullRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search pull requests for "${query.text}"`,
      description: `Search pull requests in the GitHub repository for "${query.text}".`,
    });
    const cursor = await this.#gatekeeper.searchPullRequests(
      query, requestedPageSize(query), await this.#gitCache.stub());
    // Simulated ids withheld from advertising, as in listPullRequests.
    return await this.#gitCache.wrap(cursor, commitIdsOfPullSummary);
  }

  async listBranches(options?: GitHubBranchFilter): Promise<Cursor<GitHubBranchSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List branches`,
      description: `List branches in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listBranches(options, requestedPageSize(options));
    // A simulated head -- a queued push's commit, which the listing shows as if already pushed
    // -- is withheld from advertising: it is not on GitHub yet, and the hint would outlive a
    // rejection (see GitHubGatekeeperImpl.isSimulatedCommitId). Checked live per page, since a
    // push may be queued while the cursor is being drained.
    return await this.#gitCache.wrap(cursor, branch => [branch.headCommit]);
  }

  async listTags(options?: GitHubPageOptions): Promise<Cursor<GitHubTagSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List tags`,
      description: `List tags in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listTags(requestedPageSize(options));
    return await this.#gitCache.wrap(cursor, tag => [tag.commit]);
  }

  async resolveRef(ref?: string): Promise<string> {
    const { id, fromCache } =
      await this.#gatekeeper.resolveRef(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Resolve ${ref ?? "the default branch"} to a commit id`,
      description: `Resolve ${ref === undefined ? "the default branch" : `"${ref}"`}`
        + ` to commit ${id} in the GitHub repository.`,
    });
    // A cache-served resolution is never advertised, for the same reasons as getCommit.
    if (!fromCache) {
      await this.#gitCache.advertise([id]);
    }
    return id;
  }

  async getCommit(ref?: string): Promise<GitHubCommitDetails> {
    const { details, fromCache } =
      await this.#gatekeeper.getCommit(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Read commit ${details.id.slice(0, 12)}`,
      description: `Read commit ${details.id}`
        + `${ref === undefined ? " (head of the default branch)"
          : ref === details.id ? "" : ` (resolved from "${ref}")`} in the GitHub repository.`,
    });
    // A cache-served read is never advertised: either the commit was populated from this remote
    // in the first place (provenance already recorded; re-advertising is a no-op) or it is part
    // of a pending push (not on the remote yet -- the hint would outlive a rejection).
    if (!fromCache) {
      await this.#gitCache.advertise(commitIdsOfSummary(details));
    }
    return details;
  }

  async push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void> {
    validateBranchName(branch);
    if (!isCommitOid(commitId)) {
      throw new Error(
        `push() requires a full 40-character commit id; got ${JSON.stringify(commitId)}. ` +
        `Use resolveRef() to resolve a truncated id.`);
    }
    const action = await this.#gatekeeper.preparePush(
      branch, commitId, options?.force ?? false, await this.#gitCache.stub());
    if (action === null) return;  // the branch is already at commitId: nothing to do
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Push ${commitId.slice(0, 12)} to ${branch}`,
      pushedCommits: [commitId],
      implementsRevert: true,
    });
  }

  async listCommits(options?: GitHubCommitFilter): Promise<Cursor<GitHubCommitSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List commit history`,
      description: `List commits in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listCommits(
      options, requestedPageSize(options), await this.#gitCache.stub());
    // Pending (queued-push) commits in a simulated listing are withheld from advertising; their
    // GitHub-known parents still advertise.
    return await this.#gitCache.wrap(cursor, commitIdsOfSummary);
  }

  async subscribe(hook: RpcStub<GitHubEventHookTarget>, options?: GitHubSubscribeOptions): Promise<void> {
    await this.#gatekeeper.bindEventHook(this.#approvalQueue, undefined, hook, options);
  }
}

@validateRpc()
export class GitHubIssueImpl extends RpcTarget implements GitHubIssue {
  protected gatekeeper: GitHubGatekeeperImpl;
  protected approvalQueue: RpcStub<ApprovalQueue>;
  protected logicalId: string;
  protected kind: EntityKind;

  constructor(
    gatekeeper: GitHubGatekeeperImpl,
    approvalQueue: RpcStub<ApprovalQueue>,
    logicalId: string,
    kind: EntityKind,
  ) {
    super();
    this.gatekeeper = gatekeeper;
    this.approvalQueue = approvalQueue;
    this.logicalId = logicalId;
    this.kind = kind;
  }

  [Symbol.dispose](): void {
    (this.approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getDetails(): Promise<GitHubIssueDetails> {
    const details = await this.gatekeeper.openIssue(this.logicalId);
    await this.approvalQueue.authorizeObservation({
      title: `Read issue #${details.id}: ${details.title}`,
      description: `Read the full details of issue #${details.id} in ${details.repo.fullName}.`,
    });
    return details;
  }

  async setTitle(title: string): Promise<void> {
    const action = await this.gatekeeper.prepareSetTitle(this.kind, this.logicalId, title);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Rename #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async setBody(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.prepareSetBody(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Edit body of #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async addLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareAddLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Add labels to #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async removeLabels(labels: string[]): Promise<void> {
    const action = await this.gatekeeper.prepareRemoveLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Remove labels from #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async close(reason?: "completed" | "notPlanned"): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "closed", reason);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Close #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async reopen(): Promise<void> {
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "open");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reopen #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async readDiscussion(options?: GitHubPageOptions): Promise<Cursor<GitHubDiscussionEntry>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read discussion for #${this.logicalId}`,
      description: `Read the discussion thread for #${this.logicalId}.`,
    });
    return this.gatekeeper.issueDiscussion(this.kind, this.logicalId, requestedPageSize(options));
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.preparePostComment(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Comment on #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async subscribe(hook: RpcStub<GitHubEventHookTarget>, options?: GitHubSubscribeOptions): Promise<void> {
    await this.gatekeeper.bindEventHook(
      this.approvalQueue, { kind: this.kind, id: this.logicalId }, hook, options);
  }
}

@validateRpc()
export class GitHubPullRequestImpl extends GitHubIssueImpl implements GitHubPullRequest {
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string) {
    super(gatekeeper, approvalQueue, logicalId, "pull");
    this.#gitCache = new SessionGitCache(approvalQueue, { withhold: id => gatekeeper.isSimulatedCommitId(id) });
  }

  override [Symbol.dispose](): void {
    this.#gitCache.dispose();
    super[Symbol.dispose]();
  }

  async getDetails(): Promise<GitHubPullRequestDetails> {
    const details =
      await this.gatekeeper.openPullRequest(this.logicalId, await this.#gitCache.stub());
    await this.approvalQueue.authorizeObservation({
      title: `Read pull request #${details.id}: ${details.title}`,
      description: `Read the full details of pull request #${details.id} in ${details.repo.fullName}.`,
    });
    // A provisional pull request may carry empty branch shas (advertise() skips them) or a
    // simulated head -- a queued push's commit, withheld from advertising because it is not on
    // GitHub yet and the hint would outlive a rejection.
    await this.#gitCache.advertise(commitIdsOfPullSummary(details));
    return details;
  }

  async readDiff(options?: GitHubPageOptions): Promise<GitHubPullRequestDiff> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff for #${this.logicalId}`,
      description: `Read the diff for pull request #${this.logicalId}.`,
    });
    const diff = await this.gatekeeper.pullDiff(
      this.logicalId, requestedPageSize(options, 20), await this.#gitCache.stub());
    // A simulated head revision (a queued push's commit) is withheld from advertising.
    await this.#gitCache.advertise(
      [diff.revision.baseSha, diff.revision.headSha, diff.revision.mergeBaseSha ?? ""]);
    return diff;
  }

  async getMergeBase(): Promise<string> {
    await this.approvalQueue.authorizeObservation({
      title: `Read merge base for #${this.logicalId}`,
      description: `Read the merge base commit of pull request #${this.logicalId}.`,
    });
    const mergeBase = await this.gatekeeper.pullMergeBase(
      this.logicalId, await this.#gitCache.stub());
    // A merge base is always a commit GitHub itself knows (see pullMergeBase), so it is never
    // withheld.
    await this.#gitCache.advertise([mergeBase]);
    return mergeBase;
  }

  async listCommits(options?: GitHubPageOptions): Promise<Cursor<GitHubCommitSummary>> {
    await this.approvalQueue.authorizeObservation({
      title: `List commits for #${this.logicalId}`,
      description: `List the commits of pull request #${this.logicalId}.`,
    });
    const cursor = await this.gatekeeper.pullCommits(
      this.logicalId, requestedPageSize(options), await this.#gitCache.stub());
    // Pending (queued-push) commits in a simulated listing are withheld from advertising; their
    // GitHub-known parents still advertise. Checked live per page.
    return await this.#gitCache.wrap(cursor, commitIdsOfSummary);
  }

  async readDiffThreads(options?: GitHubPageOptions): Promise<Cursor<GitHubDiffThread>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff threads for #${this.logicalId}`,
      description: `Read diff discussion threads for pull request #${this.logicalId}.`,
    });
    return this.gatekeeper.pullThreads(this.logicalId, requestedPageSize(options, 20));
  }

  async postReview(review: GitHubPullRequestReviewDraft): Promise<void> {
    const action = await this.gatekeeper.preparePostReview(this.logicalId, review);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Submit review for #${this.logicalId}`,
      implementsRevert: false,
    });
  }

  async replyToDiffComment(commentId: string, bodyMarkdown: string): Promise<void> {
    if (commentId.startsWith("~")) {
      throw new Error(
        "Replies to provisional diff comments are not supported until the parent review is approved and GitHub assigns real comment IDs.",
      );
    }
    const action = await this.gatekeeper.prepareReplyToDiffComment(this.logicalId, commentId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reply to diff thread on #${this.logicalId}`,
      implementsRevert: true,
    });
  }

  async merge(options?: GitHubPullRequestMergeOptions): Promise<void> {
    const action = await this.gatekeeper.prepareMergePullRequest(this.logicalId, options);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Merge pull request #${this.logicalId}`,
      implementsRevert: false,
    });
  }
}

/** What a hook's delivery stub restores to: the binding's facet, narrowed to delivering. */
@validateRpc()
export class GitHubHookDeliveryImpl extends RpcTarget implements GitHubHookDelivery {
  readonly #deliver: GitHubHookDelivery["deliver"];

  constructor(deliver: GitHubHookDelivery["deliver"]) {
    super();
    this.#deliver = deliver;
  }

  deliver(callback: RpcStub<GitHubEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          event: GitHubWebhookEvent): Promise<void> {
    return this.#deliver(callback, approvalQueue, event);
  }
}
