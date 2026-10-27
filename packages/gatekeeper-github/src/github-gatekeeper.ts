import { DurableObject, RpcStub, restore } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type Cursor,
  type Gatekeeper,
  type GitCache,
  type GitOid,
  type GitPullHints,
  type GitPullTransfer,
  type GatekeeperUserVerifier,
  type ActionKind,
  type ObservationDescription,
  type ResourceDescription,
  type SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { codeSpan, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import {
  APPLY_OUTCOME_UNKNOWN_MESSAGE, ActionJournal, ActionOutcomeUnknownError, type JournalRecord,
} from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import {
  GitHubApi,
  GitHubApiError,
  withAccountApi,
  type ConditionalRequestResult,
  type GitHubCompareResponse,
  type GitHubIssueCommentResponse,
  type GitHubIssueResponse,
  type GitHubLabelResponse,
  type GitHubPullFileResponse,
  type GitHubPullRequestResponse,
  type GitHubPullRequestReviewCommentResponse,
  type GitHubPullRequestReviewResponse,
  type PinnedRepo,
} from "./github-api";
import { webhookOrigin, type Env } from "./github-env";
import type { GitHubVerifierApi } from "./github";
import TYPES_CODE from "./types.txt";
import {
  HOOKS_NOT_CONFIGURED,
  type GitHubEventHookTarget,
  type GitHubHookDelivery,
  type GitHubHookParams,
} from "./github-hooks";
import type { GitHubWebhookEvent } from "./github-webhook-events";
import { assertIssueSearchResultsInRepo, buildIssueSearchQuery } from "./github-search";
import {
  MAX_DIFF_BLOB_BYTES,
  changedPathsBetweenTrees,
  diffGitTrees,
  parseGitTreePayload,
  parseUnifiedPatch,
  type TreeDiffSource,
} from "@gadgets/gatekeeper-kit/git-diff";
import { ArrayCursor, SessionGitCache } from "@gadgets/gatekeeper-kit/cursors";
import { commitIdsOfSummary, isCommitOid, parseGitCommitPayload } from "@gadgets/gatekeeper-kit/git-objects";
import { startGitPull } from "@gadgets/gatekeeper-kit/git-pull-transfer";
import {
  GitRefUpdateRejectedError,
  ZERO_OID,
  emptyPackBytes,
  pushGitRefUpdate,
  simulateBranchHead,
  validateBranchName,
} from "@gadgets/gatekeeper-kit/git-transport";
import { desiredStateReached } from "@gadgets/gatekeeper-kit/outcome-unknown";
import {
  actorFromUser,
  commitDetailsFromGitObject,
  commitIdsOfPullSummary,
  normalizeBranchSummary,
  normalizeCommitDetails,
  normalizeCommitSummary,
  normalizeTagSummary,
} from "./git-commits";
import {
  describeGitHubAction,
  remainingLabels,
} from "./github-descriptions";
import {
  ACTION_KINDS,
  BINDING_ACTIONS,
  autoApprovalOf,
  isCasBound,
  isGitHubOutcomeUnknown,
  type AddLabelsAction,
  type Cached,
  type ChangeStateAction,
  type CreateIssueAction,
  type CreatePullRequestAction,
  type EntityKind,
  type GitHubAction,
  type MergePullRequestAction,
  type PostCommentAction,
  type PostReviewAction,
  type PushAction,
  type RemoveLabelsAction,
  type ReplyToDiffCommentAction,
  type SetBodyAction,
  type SetTitleAction,
  type StoredActionRecord,
  type StoredProvisionalResource,
} from "./github-action-types";
import {
  PULL_REQUEST_ACTION_WORDS,
  actorFromLogin,
  canonicalRepoUrl,
  commentTargetFromResponse,
  dedupeLabels,
  denormalizeStateReason,
  discussionCommentFromResponse,
  eventReview,
  issueComparator,
  issueMatchesFilter,
  issueMatchesSearch,
  issueUrl,
  isOwnHead,
  listEventKinds,
  mergeBaseOfCompare,
  normalizeIssueDetails,
  normalizeIssueSummary,
  normalizePullDetails,
  normalizePullSummary,
  normalizeStateReason,
  parseDate,
  pullComparator,
  pullMatchesFilter,
  pullMatchesSearch,
  pullUrl,
  refChange,
  repoRef,
  reviewDecisionFromState,
  stableKey,
  submittedDiffCommentFromResponse,
  summarizeIssueDetails,
  summarizePullDetails,
  textSnippet,
  type GitHubDiscussionCommentEntry,
  type PullSearchRow,
} from "./github-normalize";
import { StreamingCursor } from "./github-cursors";
import type {
  GitHubActor,
  GitHubBranchFilter,
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitFilter,
  GitHubCommitSummary,
  GitHubCreateIssueOptions,
  GitHubCreatePullRequestOptions,
  GitHubDiffCommentTarget,
  GitHubDiffThread,
  GitHubDiscussionEntry,
  GitHubEvent,
  GitHubEventKind,
  GitHubEventReview,
  GitHubIssue,
  GitHubIssueDetails,
  GitHubIssueFilter,
  GitHubIssueSearch,
  GitHubIssueState,
  GitHubIssueSummary,
  GitHubLabel,
  GitHubPageOptions,
  GitHubPullRequest,
  GitHubPullRequestBranchRef,
  GitHubPullRequestDetails,
  GitHubPullRequestDiffFile,
  GitHubPullRequestEvent,
  GitHubPullRequestFilter,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestReviewDraft,
  GitHubPullRequestRevision,
  GitHubPullRequestSearch,
  GitHubPullRequestSummary,
  GitHubRepo as GitHubRepoSession,
  GitHubRepoMetadata,
  GitHubRepoRef,
  GitHubReviewDecision,
  GitHubSubmittedDiffComment,
  GitHubSubscribeOptions,
  GitHubTagSummary,
} from "./types";
import {
  GitHubHookDeliveryImpl,
  GitHubIssueImpl,
  GitHubPullRequestImpl,
  GitHubRepoSessionImpl,
} from "./github-sessions";
import { obsContext } from "./observability.js";
import type { GitHubGatekeeperImplProps } from "./github-env";

// The GitHub gatekeeper Durable Object: one instance per bound resource, holding the account's
// queued actions, the simulation overlay they describe, and the workspace git cache wiring. The
// account, vendor and user entrypoints stay in github.ts; the session facades it hands out live
// in github-sessions.ts. Same shape as gatekeeper-gitlab's gitlab-gatekeeper.ts.

const VENDOR_ID = "github";

const logger = obsContext.createLogger({
  component: "gatekeeper.github", vendorId: VENDOR_ID,
});

type CachedIssueSearchResult = {
  html_url: string;
  summary: GitHubIssueSummary;
};

type StoredCommentCacheState = {
  depth: number;
  freshness: number;
  exhausted: boolean;
  chunkSize?: number;
  ids: string[];
};

type StoredDiscussionCommentState = StoredCommentCacheState;

type StoredPullReviewCommentState = StoredCommentCacheState;

type StoredViewer = {
  actor: GitHubActor;
  fetchedAt: number;
};



/**
 * A `base...head` pull request comparison computed as if the head branch's queued pushes had
 * already landed (see `#simulatedPullComparison`). `pendingCommitIds` are the commits that are
 * not on GitHub yet -- sessions must not advertise them.
 */
type SimulatedPullComparison = {
  revision: GitHubPullRequestRevision;
  files: GitHubPullRequestDiffFile[];
  additions: number;
  deletions: number;
  totalCommits: number;
  /** Oldest-first: GitHub's `compare(base...anchor)` commits, then the pending chain. */
  commitSummaries: GitHubCommitSummary[];
  pendingCommitIds: GitOid[];
};

const ENTITY_CACHE_TTL_MS = 30 * 1000;
const LIST_CACHE_TTL_MS = 15 * 1000;
// For values that are pure functions of immutable inputs (e.g. the merge base of two commits,
// keyed by both shas): never stale, so only a generation bump (`#clearCaches`) evicts them.
const IMMUTABLE_CACHE_TTL_MS = Infinity;
const VIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCUSSION_SYNC_OVERLAP_MS = 5 * 1000;
const DISCUSSION_SYNC_BAIL_LIMIT = 500;
const MAX_REPLY_TARGET_HOPS = 50;
// Cap on the queued-but-not-yet-pushed commits walked when simulating a branch's history
// (mirrors GitHub's own 250-commit cap on compare listings).
const MAX_PENDING_CHAIN_COMMITS = 250;
// Applied actions stay revertible while they are among the newest this many; older ones are
// retired by the retention sweep (`#housekeepRetained`).
const RETAINED_ACTION_LIMIT = 200;

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}


@validateRpc()
export class GitHubGatekeeperImpl extends DurableObject<Env, GitHubGatekeeperImplProps>
  implements Gatekeeper<GitHubRepoSession | GitHubIssue | GitHubPullRequest> {

  /**
   * Commit ids this instance has served from the workspace git cache as part of simulating
   * queued pushes (branch heads *and* the intermediate commits of pending chains). Session
   * advertising callbacks consult it (via `isSimulatedCommitId`) to withhold these ids: they are
   * not on GitHub yet, so advertising one would record a wrong pull-routing hint that outlives a
   * rejection. In-memory only -- entries are always recorded in the same call that returns the
   * ids, so a restart cannot leak an unfiltered id.
   */
  #servedSimulatedCommitIds = new Set<GitOid>();

  #userAccount() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #repoPin?: Promise<PinnedRepo | undefined>;

  /**
   * The bound repository with its GitHub id, which lets the API follow GitHub's redirects for a
   * renamed repo and refuse every other (see PinnedRepo). The id is read once from the repository
   * root, the one path whose redirect is followed unpinned (see redirectTarget), and stored; until
   * a probe succeeds every other redirect is refused. A probe GitHub redirected anywhere else is
   * not retried while this instance lives; any other failure is retried by the next call.
   */
  #pinnedRepo(): Promise<PinnedRepo | undefined> {
    const { owner, repo } = this.ctx.props;
    return this.#repoPin ??= (async () => {
      let id = this.ctx.storage.kv.get<number>("repoId");
      if (id === undefined) {
        try {
          ({ id } = await withAccountApi(this.#userAccount(), api => api.getRepo(owner, repo),
            { replayable: true }));
          this.ctx.storage.kv.put("repoId", id);
        } catch (error) {
          logger.warn("failed to pin the GitHub repository id; refusing all redirects", {
            event: "repo.pin.failed", error,
          });
          if (!(error instanceof GitHubApiError && error.status >= 300 && error.status < 400)) {
            this.#repoPin = undefined;
          }
          return undefined;
        }
      }
      return { owner, repo, id };
    })();
  }

  async #withApi<T>(fn: (api: GitHubApi) => Promise<T>): Promise<T> {
    return await withAccountApi(this.#userAccount(), fn, { repo: await this.#pinnedRepo() });
  }

  /**
   * `#withApi` for reads safe to send twice: a token a refresh replaced in flight reruns `fn` once
   * instead of failing. An apply's follow-up reads need this, since failing them after GitHub
   * accepted the mutation leaves the action pending, and retrying it repeats the mutation.
   */
  async #readApi<T>(fn: (api: GitHubApi) => Promise<T>): Promise<T> {
    return await withAccountApi(this.#userAccount(), fn,
      { replayable: true, repo: await this.#pinnedRepo() });
  }

  #counterKey(name: string): string {
    return `counter:${name}`;
  }

  #nextCounter(name: string): number {
    const key = this.#counterKey(name);
    const value = (this.ctx.storage.kv.get<number>(key) ?? 0) + 1;
    this.ctx.storage.kv.put(key, value);
    return value;
  }

  #nextProvisionalResourceId(): string {
    return `~${this.#nextCounter("resource")}`;
  }

  #nextProvisionalCommentId(prefix: string): string {
    return `~${prefix}${this.#nextCounter(prefix)}`;
  }

  #cacheKey(kind: string, ...parts: string[]): string {
    return ["cache", kind, ...parts].join(":");
  }

  #cacheGeneration(): number {
    return this.ctx.storage.kv.get<number>("cacheGeneration") ?? 0;
  }

  #loadCached<T>(key: string, ttlMs: number): T | undefined {
    const cached = this.ctx.storage.kv.get<Cached<T>>(key);
    if (!cached) return undefined;
    if (cached.generation !== this.#cacheGeneration()) return undefined;
    if (Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    return cached.value;
  }

  #getCachedRecord<T>(key: string): Cached<T> | undefined {
    const cached = this.ctx.storage.kv.get<Cached<T>>(key);
    if (!cached) return undefined;
    if (cached.generation !== this.#cacheGeneration()) return undefined;
    return cached;
  }

  /**
   * Stores `value`, read under cache `generation` (taken before the read began). Skipped when an
   * apply has moved the generation since: the read may have straddled it and seen the old state.
   * Best-effort: a value past Durable Object storage's 2 MB cap is left uncached, not an error.
   */
  #storeCached<T>(key: string, value: T, generation: number, etag?: string): void {
    if (generation !== this.#cacheGeneration()) return;
    try {
      this.ctx.storage.kv.put<Cached<T>>(key, { fetchedAt: Date.now(), value, etag, generation });
    } catch (error) {
      logger.warn("failed to cache a GitHub read", { event: "cache.store.failed", error });
    }
  }

  /** The cached value under `key`, else `load()`'s result, cached for later reads. */
  async #cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.#loadCached<T>(key, ttlMs);
    if (cached !== undefined) return cached;
    const generation = this.#cacheGeneration();
    const value = await load();
    this.#storeCached(key, value, generation);
    return value;
  }

  async #loadCachedWithEtag<T>(
    key: string,
    ttlMs: number,
    loader: (etag?: string) => Promise<ConditionalRequestResult<T>>,
  ): Promise<T> {
    const cached = this.#getCachedRecord<T>(key);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.value;
    }

    const generation = this.#cacheGeneration();
    const response = await loader(cached?.etag);
    if (response.status === 304) {
      if (!cached) {
        throw new Error(`GitHub returned 304 for uncached resource ${key}.`);
      }
      this.#storeCached(key, cached.value, generation, response.headers.get("etag") ?? cached.etag);
      return cached.value;
    }

    this.#storeCached(key, response.data, generation, response.headers.get("etag") ?? undefined);
    return response.data;
  }

  #clearCaches(): void {
    this.ctx.storage.kv.put("cacheGeneration", this.#cacheGeneration() + 1);
  }

  #discussionCommentStateKey(realId: string): string {
    return `discussionComments:${realId}:state`;
  }

  #discussionCommentEntryPrefix(realId: string): string {
    return `discussionComments:${realId}:entry:`;
  }

  #discussionCommentEntryKey(realId: string, commentId: string): string {
    return `${this.#discussionCommentEntryPrefix(realId)}${commentId}`;
  }

  #getDiscussionCommentState(realId: string): StoredDiscussionCommentState | undefined {
    return this.ctx.storage.kv.get<StoredDiscussionCommentState>(this.#discussionCommentStateKey(realId));
  }

  #putDiscussionCommentState(realId: string, state: StoredDiscussionCommentState): void {
    this.ctx.storage.kv.put(this.#discussionCommentStateKey(realId), state);
  }

  #ensureDiscussionCommentState(realId: string, commentCount?: number): StoredDiscussionCommentState {
    const existing = this.#getDiscussionCommentState(realId);
    if (existing) {
      if (commentCount === 0 && existing.depth === 0 && !existing.exhausted) {
        existing.exhausted = true;
        this.#putDiscussionCommentState(realId, existing);
      }
      return existing;
    }

    const state: StoredDiscussionCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: commentCount === 0,
      ids: [],
    };
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  #resetDiscussionCommentState(realId: string, commentCount?: number): StoredDiscussionCommentState {
    const existing = this.#getDiscussionCommentState(realId);
    for (const commentId of existing?.ids ?? []) {
      this.ctx.storage.kv.delete(this.#discussionCommentEntryKey(realId, commentId));
    }

    const state: StoredDiscussionCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: commentCount === 0,
      ids: [],
    };
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  #readIndexedEntries<T>(ids: string[], prefix: string, label: string): T[] {
    const entries = new Map<string, T>();
    for (const [key, value] of this.ctx.storage.kv.list<T>({ prefix })) {
      entries.set(key.slice(prefix.length), value);
    }

    return ids.map(id => {
      const entry = entries.get(id);
      if (!entry) {
        throw new Error(`Cached GitHub ${label} ${id} is missing.`);
      }
      return entry;
    });
  }

  #readDiscussionCommentSlice(realId: string, offset: number, limit: number): GitHubDiscussionCommentEntry[] {
    const state = this.#getDiscussionCommentState(realId);
    if (!state) return [];

    return this.#readIndexedEntries<GitHubDiscussionCommentEntry>(
      state.ids.slice(offset, offset + limit),
      this.#discussionCommentEntryPrefix(realId),
      "discussion comment",
    );
  }

  async #syncDiscussionComments(realId: string, commentCount?: number): Promise<StoredDiscussionCommentState> {
    let state = this.#ensureDiscussionCommentState(realId, commentCount);
    if (commentCount !== undefined && state.depth > commentCount) {
      state = this.#resetDiscussionCommentState(realId, commentCount);
    }
    if (Date.now() - state.freshness < ENTITY_CACHE_TTL_MS) {
      return state;
    }

    const since = new Date(Math.max(0, state.freshness - DISCUSSION_SYNC_OVERLAP_MS)).toISOString();
    const knownIds = new Set(state.ids);
    const updates = new Map<string, GitHubDiscussionCommentEntry>();
    const appended: GitHubDiscussionCommentEntry[] = [];
    let changedCount = 0;

    for (let page = 1; ; page += 1) {
      const batch = await this.#withApi(api =>
        api.listIssueComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          since,
        ));
      changedCount += batch.length;
      if (changedCount > DISCUSSION_SYNC_BAIL_LIMIT) {
        return this.#resetDiscussionCommentState(realId, commentCount);
      }

      for (const comment of batch) {
        const normalized = discussionCommentFromResponse(comment);
        if (knownIds.has(normalized.id)) {
          updates.set(normalized.id, normalized);
        } else if (state.exhausted) {
          appended.push(normalized);
          knownIds.add(normalized.id);
        }
      }

      if (batch.length < 100) {
        break;
      }
    }

    for (const [commentId, comment] of updates) {
      this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, commentId), comment);
    }

    if (appended.length > 0) {
      appended.sort((a, b) => {
        const delta = a.createdAt.getTime() - b.createdAt.getTime();
        return delta === 0 ? a.id.localeCompare(b.id) : delta;
      });
      for (const comment of appended) {
        this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, comment.id), comment);
        state.ids.push(comment.id);
      }
      state.depth = state.ids.length;
    }

    state.freshness = Date.now();
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  async #materializeDiscussionCommentDepth(
    realId: string,
    targetDepth: number,
    chunkHint: number,
  ): Promise<StoredDiscussionCommentState> {
    let state = this.#ensureDiscussionCommentState(realId);
    if (targetDepth <= state.depth || state.exhausted) {
      return state;
    }

    const chunkSize = Math.max(1, Math.min(100, state.chunkSize ?? chunkHint));
    state.chunkSize = chunkSize;
    let restarted = false;

    while (state.depth < targetDepth && !state.exhausted) {
      const knownIds = new Set(state.ids);
      const page = Math.floor(state.depth / chunkSize) + 1;
      const batch = await this.#withApi(api =>
        api.listIssueComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          chunkSize,
        ));
      const normalized = batch.map(discussionCommentFromResponse);

      if (state.depth > 0 && normalized.some(comment => knownIds.has(comment.id))) {
        if (restarted) {
          throw new Error(`GitHub discussion pagination shifted while loading #${realId}. Retry the request.`);
        }
        state = this.#resetDiscussionCommentState(realId);
        state.chunkSize = chunkSize;
        restarted = true;
        continue;
      }

      restarted = false;
      for (const comment of normalized) {
        if (knownIds.has(comment.id)) continue;
        this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, comment.id), comment);
        state.ids.push(comment.id);
        knownIds.add(comment.id);
      }

      state.depth = state.ids.length;
      if (batch.length < chunkSize) {
        state.exhausted = true;
        state.freshness = Date.now();
      }
      this.#putDiscussionCommentState(realId, state);
    }

    return state;
  }

  #pullReviewCommentStateKey(realId: string): string {
    return `pullReviewComments:${realId}:state`;
  }

  #pullReviewCommentEntryPrefix(realId: string): string {
    return `pullReviewComments:${realId}:entry:`;
  }

  #pullReviewCommentEntryKey(realId: string, commentId: string): string {
    return `${this.#pullReviewCommentEntryPrefix(realId)}${commentId}`;
  }

  #getPullReviewCommentState(realId: string): StoredPullReviewCommentState | undefined {
    return this.ctx.storage.kv.get<StoredPullReviewCommentState>(this.#pullReviewCommentStateKey(realId));
  }

  #putPullReviewCommentState(realId: string, state: StoredPullReviewCommentState): void {
    this.ctx.storage.kv.put(this.#pullReviewCommentStateKey(realId), state);
  }

  #ensurePullReviewCommentState(realId: string): StoredPullReviewCommentState {
    const existing = this.#getPullReviewCommentState(realId);
    if (existing) {
      return existing;
    }

    const state: StoredPullReviewCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: false,
      ids: [],
    };
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  #resetPullReviewCommentState(realId: string): StoredPullReviewCommentState {
    const existing = this.#getPullReviewCommentState(realId);
    for (const commentId of existing?.ids ?? []) {
      this.ctx.storage.kv.delete(this.#pullReviewCommentEntryKey(realId, commentId));
    }

    const state: StoredPullReviewCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: false,
      ids: [],
    };
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  #readAllPullReviewComments(realId: string): GitHubPullRequestReviewCommentResponse[] {
    const state = this.#getPullReviewCommentState(realId);
    if (!state) return [];

    return this.#readIndexedEntries<GitHubPullRequestReviewCommentResponse>(
      state.ids,
      this.#pullReviewCommentEntryPrefix(realId),
      "pull review comment",
    );
  }

  async #syncPullReviewComments(realId: string): Promise<StoredPullReviewCommentState> {
    const state = this.#ensurePullReviewCommentState(realId);
    if (Date.now() - state.freshness < ENTITY_CACHE_TTL_MS) {
      return state;
    }

    const since = new Date(Math.max(0, state.freshness - DISCUSSION_SYNC_OVERLAP_MS)).toISOString();
    const knownIds = new Set(state.ids);
    const updates = new Map<string, GitHubPullRequestReviewCommentResponse>();
    const appended: GitHubPullRequestReviewCommentResponse[] = [];
    let changedCount = 0;

    for (let page = 1; ; page += 1) {
      const batch = await this.#readApi(api =>
        api.listPullRequestReviewComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          since,
        ));
      changedCount += batch.length;
      if (changedCount > DISCUSSION_SYNC_BAIL_LIMIT) {
        return this.#resetPullReviewCommentState(realId);
      }

      for (const comment of batch) {
        const commentId = String(comment.id);
        if (knownIds.has(commentId)) {
          updates.set(commentId, comment);
        } else if (state.exhausted) {
          appended.push(comment);
          knownIds.add(commentId);
        }
      }

      if (batch.length < 100) {
        break;
      }
    }

    for (const [commentId, comment] of updates) {
      this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
    }

    if (appended.length > 0) {
      appended.sort((a, b) => {
        const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return delta === 0 ? a.id - b.id : delta;
      });
      for (const comment of appended) {
        const commentId = String(comment.id);
        this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
        state.ids.push(commentId);
      }
      state.depth = state.ids.length;
    }

    state.freshness = Date.now();
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  async #materializeAllPullReviewComments(realId: string): Promise<GitHubPullRequestReviewCommentResponse[]> {
    let state = this.#ensurePullReviewCommentState(realId);
    const chunkSize = Math.max(1, Math.min(100, state.chunkSize ?? 100));
    state.chunkSize = chunkSize;
    let restarted = false;

    while (!state.exhausted) {
      const knownIds = new Set(state.ids);
      const page = Math.floor(state.depth / chunkSize) + 1;
      const batch = await this.#withApi(api =>
        api.listPullRequestReviewComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          chunkSize,
        ));

      if (state.depth > 0 && batch.some(comment => knownIds.has(String(comment.id)))) {
        if (restarted) {
          throw new Error(`GitHub pull review comment pagination shifted while loading #${realId}. Retry the request.`);
        }
        state = this.#resetPullReviewCommentState(realId);
        state.chunkSize = chunkSize;
        restarted = true;
        continue;
      }

      restarted = false;
      for (const comment of batch) {
        const commentId = String(comment.id);
        if (knownIds.has(commentId)) continue;
        this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
        state.ids.push(commentId);
        knownIds.add(commentId);
      }

      state.depth = state.ids.length;
      if (batch.length < chunkSize) {
        state.exhausted = true;
        state.freshness = Date.now();
      }
      this.#putPullReviewCommentState(realId, state);
    }

    return this.#readAllPullReviewComments(realId);
  }

  /**
   * The action store: the kit journal over the exact keys this gatekeeper kept before it, so a
   * ported record moves nowhere. `upgradeRecord` is the old row shape minus its wrapper; the
   * one-time adoption below rewrites every old row before anything else reads the store.
   */
  #actions: ActionJournal<GitHubAction> = this.#actionJournal();

  /** Serializes applies and discards: a discard's cascade reads records an apply may settle. */
  #resolutions = new SerialTaskQueue();

  #actionJournal(): ActionJournal<GitHubAction> {
    const journal = new ActionJournal<GitHubAction>(this.ctx.storage.kv, {
      legacyKeys: { nextIdKey: "nextActionId", recordPrefix: "action:" },
      upgradeRecord: raw => (raw as StoredActionRecord).action,
    });
    this.#adoptActionRecords(journal);
    return journal;
  }

  /**
   * One-time port of the records this gatekeeper kept by hand onto the journal. Idempotent by
   * construction: an in-place adopt overwrites the legacy row atomically, a retired row's adopt
   * lands before its delete so a crash between them leaves both for the rerun to finish, and the
   * marker rules out a rerun once complete.
   * @param journal The freshly constructed journal adopting the records.
   */
  #adoptActionRecords(journal: ActionJournal<GitHubAction>): void {
    const kv = this.ctx.storage.kv;
    if (kv.get("actionRecordsV2") !== undefined) return;
    // The old counter held the last issued id; the journal's holds the next unused one.
    const lastIssued = kv.get<number>("counter:action");
    if (lastIssued !== undefined) {
      kv.put("nextActionId", lastIssued + 1);
      kv.delete("counter:action");
    }
    for (const [key, record] of kv.list<StoredActionRecord>({ prefix: "action:" })) {
      const id = Number(key.slice("action:".length));
      // A journal-written row here is this port's own earlier work on a rerun, or a retired
      // row it moved onto the key; only legacy rows are ours to convert.
      if (journal.hasRecord(id)) continue;
      journal.adopt(id,
        { state: record.state === "staged" ? "staged" : "pending", action: record.action });
    }
    for (const [key, record] of kv.list<StoredActionRecord>({ prefix: "retiredAction:" })) {
      const id = Number(key.slice("retiredAction:".length));
      // The journal's record for this id lands on a different key: if it is already there, an
      // earlier attempt adopted this row and only the delete is left to finish.
      if (journal.hasRecord(id)) {
        kv.delete(key);
        continue;
      }
      if (record.state === "approved") {
        // A revert's target rides on the action itself now; the wrapper record is gone.
        journal.adopt(id, {
          state: "applied",
          action: {
            ...record.action,
            ...(record.revertInfo ? { createdCommentId: record.revertInfo.commentId } : {}),
          },
        });
      } else {
        journal.adopt(id, {
          state: "failed",
          action: record.action,
          error: `GitHub action ${id} was discarded, or something it depended on was, so it cannot be applied.`,
          undispatched: true,
        });
      }
      // After the adopt: a crash leaves both rows, and the rerun finishes this delete.
      kv.delete(key);
    }
    kv.put("actionRecordsV2", true);
  }

  #requireActionRecord(approvalId: number): JournalRecord<GitHubAction> {
    const record = this.#actions.get(approvalId);
    if (!record) {
      throw new Error(`No queued GitHub action exists with id ${approvalId}.`);
    }
    return record;
  }

  #listPendingActions(): GitHubAction[] {
    return this.#actions.listPending().map(({ action }) => action);
  }

  #markActionPending(action: GitHubAction): void {
    this.#actions.markSubmitted(action.approvalId);
    if (action.type === "createIssue" || action.type === "createPullRequest") {
      this.ctx.storage.kv.put<StoredProvisionalResource>(`provisional:${action.provisionalId}`, {
        kind: action.type === "createIssue" ? "issue" : "pull",
      });
    }
  }

  #markActionRejected(action: GitHubAction): void {
    this.#actions.markFailed(action.approvalId,
      `GitHub action ${action.approvalId} was discarded, or something it depended on was, so it cannot be applied.`,
      { undispatched: true });
  }

  #actionDependsOnResource(action: GitHubAction, kind: EntityKind, provisionalId: string): boolean {
    switch (action.type) {
      case "createIssue":
      case "createPullRequest":
        return action.provisionalId === provisionalId;
      case "setTitle":
      case "setBody":
      case "addLabels":
      case "removeLabels":
      case "changeState":
      case "postComment":
        return action.targetKind === kind && action.targetId === provisionalId;
      case "postReview":
      case "replyToDiffComment":
      case "mergePullRequest":
        return kind === "pull" && action.pullId === provisionalId;
      case "push":
        return false;  // pushes target a branch, never an issue/PR
    }
  }

  #rejectActionsForResource(kind: EntityKind, provisionalId: string): void {
    for (const pending of this.#listPendingActions()) {
      if (this.#actionDependsOnResource(pending, kind, provisionalId)) {
        this.#markActionRejected(pending);
      }
    }
  }

  /**
   * Discards a push along with every queued `createPullRequest` whose head or base is the push's
   * branch, if that branch no longer exists without it -- on the remote or as the outcome of the
   * remaining queued pushes -- and everything queued against the doomed pull request. A push no
   * create depends on is discarded without reading GitHub, so a dead connection cannot block it.
   * Otherwise the branch is read before anything is marked, so a failed read leaves the push
   * pending and a retried discard still cascades; everything after the read runs without
   * yielding, so a pull request queued during it is cascaded too, and a push applied during it
   * is refused rather than overwritten as discarded. Returns whether anything was cascaded.
   */
  async #rejectPush(push: PushAction): Promise<boolean> {
    const dependsOnBranch = (action: GitHubAction): action is CreatePullRequestAction =>
      action.type === "createPullRequest" &&
      (action.options.head === push.branch || action.options.base === push.branch);
    // `undefined`: not read, since nothing depended on the branch (and without an await, nothing
    // can be queued before the mark); `null`: the branch does not exist on GitHub.
    const realHead = this.#listPendingActions().some(dependsOnBranch)
      ? await this.#withApi(api => api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, push.branch))
      : undefined;
    // The read yields, so a concurrent apply or discard may have settled the push meanwhile.
    const { state } = this.#requireActionRecord(push.approvalId);
    if (state === "applied") {
      throw new Error(`GitHub action ${push.approvalId} was applied while it was being discarded.`);
    }
    if (state === "failed") return false;
    // Marked before simulating, which takes the push out of the queued pushes it overlays.
    this.#markActionRejected(push);
    if (realHead === undefined || this.#simulateBranchHead(push.branch, realHead) !== null) return false;
    const creates = this.#listPendingActions().filter(dependsOnBranch);
    for (const create of creates) {
      this.#rejectActionsForResource("pull", create.provisionalId);  // the create included
      this.ctx.storage.kv.delete(`provisional:${create.provisionalId}`);
    }
    return creates.length > 0;
  }

  #rejectReplyDependencyChain(rootCommentIds: string[]): void {
    const pendingActions = this.#listPendingActions();
    const pendingReplies = pendingActions.filter(
      (action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment",
    );
    const queue = [...rootCommentIds];
    const seen = new Set<string>(rootCommentIds);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      for (const reply of pendingReplies) {
        if (reply.commentId === current) {
          this.#markActionRejected(reply);
          if (!seen.has(reply.provisionalCommentId)) {
            seen.add(reply.provisionalCommentId);
            queue.push(reply.provisionalCommentId);
          }
        }
      }
    }
  }

  #getProvisionalResource(id: string): StoredProvisionalResource | undefined {
    return this.ctx.storage.kv.get<StoredProvisionalResource>(`provisional:${id}`);
  }

  #setProvisionalResource(id: string, record: StoredProvisionalResource): void {
    this.ctx.storage.kv.put(`provisional:${id}`, record);
  }

  #resolveProvisionalId(id: string): string | undefined {
    const provisional = this.#getProvisionalResource(id);
    return provisional?.realId;
  }

  #entityIdMatches(targetId: string, logicalId: string): boolean {
    if (targetId === logicalId) return true;
    const targetResolved = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
    const logicalResolved = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    return !!targetResolved && !!logicalResolved && targetResolved === logicalResolved;
  }

  #pendingActionsForEntity(kind: EntityKind, logicalId: string): GitHubAction[] {
    return this.#listPendingActions().filter(action => {
      if (action.type === "createIssue" || action.type === "createPullRequest" ||
          action.type === "push") {
        return false;
      }

      if (action.type === "postReview" || action.type === "replyToDiffComment" || action.type === "mergePullRequest") {
        if (kind !== "pull") return false;
        return this.#entityIdMatches(action.pullId, logicalId);
      }

      return action.targetKind === kind && this.#entityIdMatches(action.targetId, logicalId);
    });
  }

  #findCreateAction(id: string, kind: EntityKind): CreateIssueAction | CreatePullRequestAction | undefined {
    return this.#listPendingActions().find(action => {
      if (kind === "issue" && action.type === "createIssue") {
        return action.provisionalId === id;
      }
      if (kind === "pull" && action.type === "createPullRequest") {
        return action.provisionalId === id;
      }
      return false;
    }) as CreateIssueAction | CreatePullRequestAction | undefined;
  }

  #rewriteKnownReferences(text: string, requireAll: boolean): string {
    return text.replace(/#(~\d+)/g, (_, provisionalId: string) => {
      const realId = this.#resolveProvisionalId(provisionalId);
      if (!realId && requireAll) {
        throw new Error(
          `Reference ${provisionalId} points to a provisional issue or pull request that has not been created on GitHub yet. Retry after its create action is approved.`,
        );
      }

      return realId ? `#${realId}` : `#${provisionalId}`;
    });
  }

  async #getViewerActor(): Promise<GitHubActor> {
    const viewer = await this.#loadCachedWithEtag<StoredViewer>(
      this.#cacheKey("viewer"),
      VIEWER_CACHE_TTL_MS,
      async etag => {
        const result = await this.#withApi(api => api.getViewerConditional({ ifNoneMatch: etag }));
        if (result.status === 304) {
          return result;
        }

        const actor = actorFromUser(result.data);
        if (!actor) {
          throw new Error("Failed to identify the connected GitHub account.");
        }

        return {
          status: 200,
          headers: result.headers,
          data: {
            actor,
            fetchedAt: Date.now(),
          },
        };
      },
    );
    return viewer.actor;
  }

  #pendingExistingEntityIds(kind: EntityKind): Set<string> {
    const ids = new Set<string>();
    for (const action of this.#listPendingActions()) {
      let targetId: string | undefined;
      switch (action.type) {
        case "setTitle":
        case "setBody":
        case "addLabels":
        case "removeLabels":
        case "changeState":
        case "postComment":
          if (action.targetKind === kind) {
            targetId = action.targetId;
          }
          break;
        case "postReview":
        case "replyToDiffComment":
        case "mergePullRequest":
          if (kind === "pull") {
            targetId = action.pullId;
          }
          break;
        default:
          break;
      }

      if (!targetId) continue;
      const realId = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
      if (realId) {
        ids.add(realId);
      }
    }
    return ids;
  }



  async #getRepoMetadata(): Promise<GitHubRepoMetadata> {
    // "repo-v2": the stored shape gained `defaultBranch`, and etag revalidation can keep an
    // old-shaped entry alive past the TTL indefinitely, so a shape change needs a new key.
    const key = this.#cacheKey("repo-v2", this.ctx.props.owner, this.ctx.props.repo);
    return await this.#loadCachedWithEtag<GitHubRepoMetadata>(key, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getRepoConditional(this.ctx.props.owner, this.ctx.props.repo, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      return {
        status: 200,
        headers: result.headers,
        data: {
          ...repoRef(this.ctx.props.owner, this.ctx.props.repo),
          description: result.data.description ?? undefined,
          visibility: result.data.visibility ?? (result.data.private ? "private" : "public"),
          defaultBranch: result.data.default_branch,
        },
      };
    });
  }

  #getPendingStateInfo(
    targetKind: EntityKind,
    targetId: string,
  ): { state: GitHubIssueState; reason?: "completed" | "notPlanned" } | undefined {
    const latestStateAction = [...this.#pendingActionsForEntity(targetKind, targetId)]
      .toReversed()
      .find((action): action is ChangeStateAction | MergePullRequestAction =>
        action.type === "changeState" || action.type === "mergePullRequest",
      );

    if (!latestStateAction) {
      return undefined;
    }

    if (latestStateAction.type === "mergePullRequest") {
      return { state: "closed" };
    }

    return {
      state: latestStateAction.state,
      reason: latestStateAction.reason,
    };
  }

  async #getCurrentStateInfo(
    targetKind: EntityKind,
    targetId: string,
  ): Promise<{ state: GitHubIssueState; reason?: "completed" | "notPlanned" }> {
    const pending = this.#getPendingStateInfo(targetKind, targetId);
    if (pending) {
      return {
        state: pending.state,
        reason: pending.reason,
      };
    }

    const realId = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
    if (!realId) {
      const details = targetKind === "issue"
        ? await this.#getIssueDetails(targetId)
        : await this.#getPullRequestDetails(targetId);
      return {
        state: details.state,
        reason: undefined,
      };
    }

    const current = await this.#withApi(api => api.getIssue(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
    return {
      state: current.state,
      reason: normalizeStateReason(current.state_reason),
    };
  }

  async #getIssueDetails(logicalId: string): Promise<GitHubIssueDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "issue") {
        throw new Error(`No provisional issue exists with id ${logicalId}`);
      }

      if (provisional.realId) {
        const remote = await this.#getRemoteIssueDetails(provisional.realId);
        return this.#overlayIssueLike(remote, "issue", logicalId);
      }

      const createAction = this.#findCreateAction(logicalId, "issue") as CreateIssueAction | undefined;
      if (!createAction) {
        throw new Error(`Provisional issue ${logicalId} is no longer available.`);
      }

      const provisionalIssue = await this.#buildProvisionalIssueDetails(createAction);
      return this.#overlayIssueLike(provisionalIssue, "issue", logicalId, true);
    }

    return this.#overlayIssueLike(await this.#getRemoteIssueDetails(logicalId), "issue", logicalId);
  }

  async #getPullRequestDetails(logicalId: string, gitCache?: RpcStub<GitCache>): Promise<GitHubPullRequestDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "pull") {
        throw new Error(`No provisional pull request exists with id ${logicalId}`);
      }

      if (provisional.realId) {
        const remote = await this.#getRemotePullRequestDetails(provisional.realId);
        return await this.#overlaySimulatedPullHead(
          this.#overlayIssueLike(remote, "pull", logicalId), gitCache);
      }

      const createAction = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!createAction) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      const provisionalPull = await this.#buildProvisionalPullRequestDetails(createAction, gitCache);
      return this.#overlayIssueLike(provisionalPull, "pull", logicalId, true);
    }

    return await this.#overlaySimulatedPullHead(
      this.#overlayIssueLike(await this.#getRemotePullRequestDetails(logicalId), "pull", logicalId),
      gitCache);
  }

  /**
   * Overlay queued pushes onto an existing pull request's head: when the (same-repo) head branch
   * has pending pushes, the details read as if they had landed -- simulated head sha and
   * recomputed commit/diff stats. `mergeable` is dropped: GitHub's verdict describes the remote
   * head, not the simulated one. Degrades to the remote details if the simulation fails.
   */
  async #overlaySimulatedPullHead(
    details: GitHubPullRequestDetails,
    gitCache?: RpcStub<GitCache>,
  ): Promise<GitHubPullRequestDetails> {
    if (gitCache === undefined || !isOwnHead(details)) {
      return details;
    }
    if (this.#pendingPushActions(details.head.ref).length === 0) return details;
    try {
      const simulated =
        await this.#simulatedPullComparison(gitCache, details.base.ref, details.head.ref);
      if (simulated === null) return details;
      return {
        ...details,
        head: { ...details.head, sha: simulated.revision.headSha },
        commits: simulated.totalCommits,
        additions: simulated.additions,
        deletions: simulated.deletions,
        changedFiles: simulated.files.length,
        mergeable: undefined,
      };
    } catch (error) {
      logger.warn("failed to overlay queued pushes onto pull request details", {
        event: "pull.request.simulated.head.overlay.failed", error,
      });
      return details;
    }
  }

  /**
   * The synchronous sibling of `#overlaySimulatedPullHead` for pull request *summaries* (which
   * carry no diff stats): a same-repo head branch with queued pushes reads at its simulated
   * head. The simulated sha is always a queued push's newSha, so `isSimulatedCommitId` already
   * withholds it from session advertising.
   */
  #overlayPullSummaryHead<T extends GitHubPullRequestSummary>(item: T): T {
    if (!isOwnHead(item)) return item;
    if (this.#pendingPushActions(item.head.ref).length === 0) return item;
    const simulated = this.#simulateBranchHead(item.head.ref, item.head.sha);
    if (simulated === null || simulated === item.head.sha) return item;
    return { ...item, head: { ...item.head, sha: simulated } };
  }

  async #getRemoteIssueDetails(realId: string): Promise<GitHubIssueDetails> {
    const key = this.#cacheKey("issue", realId);
    const details = await this.#loadCachedWithEtag<GitHubIssueDetails>(key, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getIssueConditional(this.ctx.props.owner, this.ctx.props.repo, Number(realId), { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }
      if (result.data.pull_request) {
        throw new Error(`#${realId} is a pull request, not an issue.`);
      }

      return {
        status: 200,
        headers: result.headers,
        data: normalizeIssueDetails(this.ctx.props.owner, this.ctx.props.repo, result.data),
      };
    });
    this.#ensureDiscussionCommentState(realId, details.commentCount);
    return details;
  }

  async #getRemotePullRequestDetails(realId: string): Promise<GitHubPullRequestDetails> {
    const key = this.#cacheKey("pull", realId);
    const details = await this.#loadCachedWithEtag<GitHubPullRequestDetails>(
      key,
      ENTITY_CACHE_TTL_MS,
      async etag => {
        const result = await this.#withApi(api =>
          api.getPullRequestConditional(this.ctx.props.owner, this.ctx.props.repo, Number(realId), { ifNoneMatch: etag })
        );
        if (result.status === 304) {
          return result;
        }

        return {
          status: 200,
          headers: result.headers,
          data: normalizePullDetails(this.ctx.props.owner, this.ctx.props.repo, result.data),
        };
      },
    );
    this.#ensureDiscussionCommentState(realId, details.commentCount);
    this.#ensurePullReviewCommentState(realId);
    return details;
  }

  async #getLiveTopLevelCommentCount(kind: EntityKind, realId: string): Promise<number> {
    if (kind === "issue") {
      const issue = await this.#withApi(api => api.getIssue(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
      if (issue.pull_request) {
        throw new Error(`#${realId} is a pull request, not an issue.`);
      }
      return issue.comments;
    }

    const pull = await this.#withApi(api => api.getPullRequest(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
    return pull.comments;
  }

  async #buildProvisionalIssueDetails(action: CreateIssueAction): Promise<GitHubIssueDetails> {
    const viewer = await this.#getViewerActor();
    return {
      repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      id: action.provisionalId,
      url: issueUrl(this.ctx.props.owner, this.ctx.props.repo, action.provisionalId),
      title: action.options.title,
      state: "open",
      labels: (action.options.labels ?? []).map(name => ({ name })),
      author: viewer,
      assignees: (action.options.assignees ?? []).map(actorFromLogin),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
    };
  }

  async #buildProvisionalPullRequestDetails(
    action: CreatePullRequestAction,
    gitCache?: RpcStub<GitCache>,
  ): Promise<GitHubPullRequestDetails> {
    const viewer = await this.#getViewerActor();
    let baseSha = "";
    let headSha = "";
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    let changedFiles = 0;

    try {
      // The head branch may itself be provisional -- moved, or outright created, by queued
      // pushes. The simulated comparison reads it as if those pushes had landed; only when no
      // overlay applies is GitHub's live compare the truth.
      const simulated =
        await this.#simulatedPullComparison(gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        baseSha = simulated.revision.baseSha;
        headSha = simulated.revision.headSha;
        commits = simulated.totalCommits;
        additions = simulated.additions;
        deletions = simulated.deletions;
        changedFiles = simulated.files.length;
      } else {
        const comparison = await this.#withApi(api => api.compareBranches(
          this.ctx.props.owner,
          this.ctx.props.repo,
          action.options.base,
          action.options.head,
        ));
        this.#recordCompareMergeBase(comparison);
        baseSha = comparison.base_commit.sha;
        headSha = comparison.commits?.at(-1)?.sha ?? comparison.base_commit.sha;
        commits = comparison.total_commits;
        additions = (comparison.files ?? []).reduce((sum, file) => sum + file.additions, 0);
        deletions = (comparison.files ?? []).reduce((sum, file) => sum + file.deletions, 0);
        changedFiles = comparison.files?.length ?? 0;
      }
    } catch (error) {
      logger.warn("failed to compute provisional pull request comparison", {
        event: "pull.request.provisional.comparison.compute.failed", error,
      });
    }

    return {
      repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      id: action.provisionalId,
      url: pullUrl(this.ctx.props.owner, this.ctx.props.repo, action.provisionalId),
      title: action.options.title,
      state: "open",
      labels: [],
      author: viewer,
      assignees: [],
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
      draft: action.options.draft ?? false,
      merged: false,
      head: {
        ref: action.options.head,
        sha: headSha,
        repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      },
      base: {
        ref: action.options.base,
        sha: baseSha,
        repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      },
      mergeable: undefined,
      requestedReviewers: [],
      commits,
      additions,
      deletions,
      changedFiles,
    };
  }

  #overlayIssueLike<T extends GitHubIssueSummary | GitHubIssueDetails | GitHubPullRequestSummary | GitHubPullRequestDetails>(
    base: T,
    kind: EntityKind,
    logicalId: string,
    includeCreate = false,
  ): T {
    const result = structuredClone(base);
    const actions = this.#pendingActionsForEntity(kind, logicalId);
    for (const action of actions) {
      switch (action.type) {
        case "setTitle":
          result.title = action.title;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "setBody":
          if ("bodyMarkdown" in result) {
            result.bodyMarkdown = this.#rewriteKnownReferences(action.bodyMarkdown, false);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        case "addLabels": {
          const existing = new Set(result.labels.map(label => label.name.toLowerCase()));
          for (const label of action.labels) {
            if (!existing.has(label.toLowerCase())) {
              result.labels.push({ name: label });
            }
          }
          result.labels = dedupeLabels(result.labels);
          result.updatedAt = new Date(action.submittedAt);
          break;
        }
        case "removeLabels":
          result.labels = result.labels.filter(label => !action.labels.some(name => name.toLowerCase() === label.name.toLowerCase()));
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "changeState":
          result.state = action.state;
          result.closedAt = action.state === "closed" ? new Date(action.submittedAt) : undefined;
          result.updatedAt = new Date(action.submittedAt);
          if ("merged" in result && action.state === "open") {
            result.merged = false;
          }
          break;
        case "postComment":
          if (result.commentCount !== undefined) result.commentCount += 1;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "mergePullRequest":
          if ("merged" in result) {
            result.state = "closed";
            result.merged = true;
            result.closedAt = new Date(action.submittedAt);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        default:
          break;
      }
    }

    if (includeCreate) {
      const lastAction = actions.at(-1);
      result.updatedAt = lastAction ? new Date(lastAction.submittedAt) : result.updatedAt;
    }

    return result;
  }

  async #buildTouchedIssueSummaries(
    predicate: (item: GitHubIssueDetails) => boolean,
    compare: (a: GitHubIssueSummary, b: GitHubIssueSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitHubIssueSummary[] }> {
    const ids = this.#pendingExistingEntityIds("issue");
    const items = (await Promise.all([...ids].map(async id => this.#getIssueDetails(id))))
      .filter(predicate)
      .map(details => summarizeIssueDetails(details))
      .toSorted(compare);
    return { ids, items };
  }

  async #buildTouchedPullSummaries(
    predicate: (item: GitHubPullRequestDetails) => boolean,
    compare: (a: GitHubPullRequestSummary, b: GitHubPullRequestSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitHubPullRequestSummary[] }> {
    const ids = this.#pendingExistingEntityIds("pull");
    const items = (await Promise.all([...ids].map(async id => this.#getPullRequestDetails(id))))
      .filter(predicate)
      .map(details => summarizePullDetails(details))
      .toSorted(compare);
    return { ids, items };
  }

  async #listIssueSummaries(filter: GitHubIssueFilter | undefined, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    const compare = issueComparator(filter?.sort, filter?.direction);
    const touched = await this.#buildTouchedIssueSummaries(item => issueMatchesFilter(item, filter), compare);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateIssueAction => action.type === "createIssue")
      .map(action => this.#buildProvisionalIssueDetails(action).then(issue => this.#overlayIssueLike(issue, "issue", action.provisionalId, true)))))
      .filter(item => issueMatchesFilter(item, filter))
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    // Pull request rows stay as null placeholders so a page keeps its upstream length, which is
    // what ends the walk. "-v2": the previous entries held filtered (short) pages.
    return new StreamingCursor<GitHubIssueSummary, GitHubIssueSummary | null>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-issues-v2", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<(GitHubIssueSummary | null)[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listIssuesConditional(owner, repo, {
            state: filter?.state,
            labels: filter?.labels?.join(","),
            creator: filter?.author,
            assignee: filter?.assignee,
            sort: filter?.sort,
            direction: filter?.direction,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(item => item.pull_request ? null : normalizeIssueSummary(owner, repo, item)),
          };
        });
      },
      overlay: row => {
        if (row === null || touched.ids.has(row.id)) return null;
        const item = this.#overlayIssueLike(row, "issue", row.id);
        return issueMatchesFilter(item, filter) ? item : null;
      },
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #searchIssueSummaries(query: GitHubIssueSearch, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    const remoteSort = query.sort ?? "created";
    const remoteDirection = query.direction ?? "desc";
    const compare = issueComparator(remoteSort, remoteDirection);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateIssueAction => action.type === "createIssue")
      .map(action => this.#buildProvisionalIssueDetails(action).then(issue => this.#overlayIssueLike(issue, "issue", action.provisionalId, true)))))
      .filter(item => issueMatchesSearch(item, query))
      .toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    const searchQuery = buildIssueSearchQuery(owner, repo, query);
    const assertSearchScope = (results: readonly Pick<GitHubIssueResponse, "html_url">[]) => {
      try {
        assertIssueSearchResultsInRepo(owner, repo, results);
      } catch (error) {
        logger.warn("GitHub issue search scope validation failed", {
          event: "issue.search.scope.validation.failed", error,
        });
        throw error;
      }
    };
    return new StreamingCursor<GitHubIssueSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("search-issues-scoped-v1", stableKey(query), `p${page}`);
        const results = await this.#loadCachedWithEtag<CachedIssueSearchResult[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api =>
            api.searchIssuesConditional(searchQuery, page, perPage, remoteSort, remoteDirection, { ifNoneMatch: etag })
          );
          if (raw.status === 304) {
            return raw;
          }

          assertSearchScope(raw.data.items);
          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.items.map(item => ({
              html_url: item.html_url,
              summary: normalizeIssueSummary(owner, repo, item),
            })),
          };
        });
        assertSearchScope(results);
        return results.map(item => item.summary);
      },
      // Search scope was validated before results entered the cursor. Re-check the structured
      // predicates after the overlay (a queued close leaves a `state: open` search), but never
      // the text: GitHub's search also matches comments.
      overlay: row => {
        const item = this.#overlayIssueLike(row, "issue", row.id);
        return issueMatchesFilter(item, query) ? item : null;
      },
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
    });
  }

  async #listPullSummaries(
    filter: GitHubPullRequestFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator(filter?.sort, filter?.direction);
    const touched = await this.#buildTouchedPullSummaries(item => pullMatchesFilter(item, filter), compare);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action, gitCache).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
      .filter(item => pullMatchesFilter(item, filter))
      .toSorted(compare);
    const injectedItems = [...touched.items.map(item => this.#overlayPullSummaryHead(item)), ...provisionals]
      .toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    return new StreamingCursor<GitHubPullRequestSummary>({
      fetchPage: async (page, perPage) => {
        // "-v2": the previous entries held pages with touched rows filtered out.
        const cacheKey = this.#cacheKey("list-pulls-v2", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubPullRequestSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listPullRequestsConditional(owner, repo, {
            state: filter?.state,
            head: filter?.head
              ? filter.head.includes(":") ? filter.head : `${owner}:${filter.head}`
              : undefined,
            base: filter?.base,
            sort: filter?.sort,
            direction: filter?.direction,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(item => normalizePullSummary(owner, repo, item)),
          };
        });
      },
      overlay: row => {
        if (touched.ids.has(row.id)) return null;
        const item = this.#overlayPullSummaryHead(this.#overlayIssueLike(row, "pull", row.id));
        return pullMatchesFilter(item, filter) ? item : null;
      },
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #searchPullSummaries(
    query: GitHubPullRequestSearch,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator("updated", "desc");

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action, gitCache).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
      .filter(item => pullMatchesSearch(item, query))
      .toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    const state = query.state ?? "all";
    // A walk of the `/pulls` listing, newest-updated first, matched after the overlay. Rows keep
    // their body for the text match; keyed by state alone, so every search shares the pages.
    return new StreamingCursor<GitHubPullRequestSummary, PullSearchRow>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("search-pulls-v2", state, `p${page}`);
        return await this.#loadCachedWithEtag<PullSearchRow[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listPullRequestsConditional(owner, repo, {
            state,
            sort: "updated",
            direction: "desc",
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(item => ({ ...normalizePullSummary(owner, repo, item), bodyMarkdown: item.body ?? "" })),
          };
        });
      },
      overlay: row => {
        const item = this.#overlayPullSummaryHead(this.#overlayIssueLike(row, "pull", row.id));
        if (!pullMatchesSearch(item, query)) return null;
        const { bodyMarkdown: _bodyMarkdown, ...summary } = item;
        return summary;
      },
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
    });
  }

  async #getDiscussionCommentPage(realId: string, page: number, perPage: number): Promise<GitHubDiscussionEntry[]> {
    await this.#materializeDiscussionCommentDepth(realId, page * perPage, perPage);
    return this.#readDiscussionCommentSlice(realId, (page - 1) * perPage, perPage);
  }

  async #getDiscussionReviewPage(realId: string, page: number): Promise<GitHubDiscussionEntry[]> {
    const cacheKey = this.#cacheKey("discussion-reviews", realId, `p${page}`);
    return await this.#loadCachedWithEtag<GitHubDiscussionEntry[]>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const raw = await this.#withApi(api =>
        api.listPullRequestReviewsConditional(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          { ifNoneMatch: etag },
        )
      );
      if (raw.status === 304) {
        return raw;
      }

      const commentsByReviewId = new Map<number, GitHubPullRequestReviewCommentResponse[]>();
      for (const comment of await this.#materializeAllPullReviewComments(realId)) {
        const reviewId = comment.pull_request_review_id;
        if (!reviewId) {
          continue;
        }

        const comments = commentsByReviewId.get(reviewId);
        if (comments) {
          comments.push(comment);
        } else {
          commentsByReviewId.set(reviewId, [comment]);
        }
      }

      const normalized = await Promise.all(raw.data.map(async review => {
        const reviewComments = commentsByReviewId.get(review.id) ?? [];
        return {
          kind: "review" as const,
          id: String(review.id),
          author: actorFromUser(review.user),
          bodyMarkdown: review.body ?? "",
          createdAt: new Date(review.submitted_at ?? new Date().toISOString()),
          updatedAt: parseDate(review.submitted_at),
          url: review.html_url,
          decision: reviewDecisionFromState(review.state),
          diffComments: reviewComments.map(submittedDiffCommentFromResponse),
        };
      }));

      return {
        status: 200,
        headers: raw.headers,
        data: normalized,
      };
    });
  }

  async #getDiscussion(kind: EntityKind, logicalId: string, pageSize: number): Promise<Cursor<GitHubDiscussionEntry>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    const compare = (a: GitHubDiscussionEntry, b: GitHubDiscussionEntry) =>
      a.createdAt.getTime() - b.createdAt.getTime();

    // Build provisional entries from pending actions.
    const viewer = await this.#getViewerActor();
    const provisionals: GitHubDiscussionEntry[] = [];
    for (const action of this.#pendingActionsForEntity(kind, logicalId)) {
      if (action.type === "postComment") {
        provisionals.push({
          kind: "comment",
          id: action.provisionalCommentId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
          createdAt: new Date(action.submittedAt),
          url: `${kind === "issue" ? issueUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId) : pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#comment-${action.provisionalCommentId}`,
        });
      } else if (action.type === "postReview") {
        provisionals.push({
          kind: "review",
          id: action.provisionalReviewId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.review.bodyMarkdown ?? "", false),
          createdAt: new Date(action.submittedAt),
          url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#review-${action.provisionalReviewId}`,
          decision: action.review.decision,
          diffComments: (action.review.diffComments ?? []).map(comment => ({
            id: comment.provisionalCommentId,
            threadId: comment.provisionalCommentId,
            target: comment.target,
            author: viewer,
            bodyMarkdown: this.#rewriteKnownReferences(comment.bodyMarkdown, false),
            createdAt: new Date(action.submittedAt),
            url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${comment.provisionalCommentId}`,
          })),
        });
      }
    }
    provisionals.sort(compare);

    // Fast path: if there is no real entity yet (pure provisional), return provisionals only.
    if (!realId) {
      return new ArrayCursor(provisionals, pageSize);
    }

    let commentCount = kind === "issue"
      ? (await this.#getRemoteIssueDetails(realId)).commentCount
      : (await this.#getRemotePullRequestDetails(realId)).commentCount;
    const discussionState = this.#ensureDiscussionCommentState(realId, commentCount);
    if (discussionState.depth > commentCount) {
      commentCount = await this.#getLiveTopLevelCommentCount(kind, realId);
    }
    await this.#syncDiscussionComments(realId, commentCount);

    if (kind === "issue") {
      return new StreamingCursor<GitHubDiscussionEntry>({
        fetchPage: async (page, perPage) => await this.#getDiscussionCommentPage(realId, page, perPage),
        overlay: item => item,
        comparator: compare,
        injectedItems: provisionals,
        pageSize,
      });
    }

    // Cache miss: stream discussion entries by merging comment pages and review pages.
    // Stateful closure that merges two sorted streams: comments and reviews.
    let commentPage = 1;
    let reviewPage = 1;
    let commentsDone = false;
    let reviewsDone = false;
    let commentBuf: GitHubDiscussionEntry[] = [];
    let reviewBuf: GitHubDiscussionEntry[] = [];

    const fetchPage = async (_virtualPage: number, perPage: number): Promise<GitHubDiscussionEntry[]> => {
      const result: GitHubDiscussionEntry[] = [];

      while (result.length < perPage) {
        // Refill comment buffer if needed.
        if (commentBuf.length === 0 && !commentsDone) {
          commentBuf = await this.#getDiscussionCommentPage(realId, commentPage, 100);
          commentPage += 1;
          if (commentBuf.length < 100) commentsDone = true;
        }

        // Refill review buffer if needed.
        if (reviewBuf.length === 0 && !reviewsDone) {
          reviewBuf = await this.#getDiscussionReviewPage(realId, reviewPage++);
          if (reviewBuf.length < 100) reviewsDone = true;
        }

        // Both sources empty → done.
        if (commentBuf.length === 0 && reviewBuf.length === 0) break;

        // Take the entry with the earlier createdAt.
        let next: GitHubDiscussionEntry | undefined;
        if (commentBuf.length === 0) {
          next = reviewBuf.shift();
        } else if (reviewBuf.length === 0) {
          next = commentBuf.shift();
        } else if (commentBuf[0].createdAt.getTime() <= reviewBuf[0].createdAt.getTime()) {
          next = commentBuf.shift();
        } else {
          next = reviewBuf.shift();
        }

        if (!next) {
          break;
        }
        result.push(next);
      }
      return result;
    };

    return new StreamingCursor<GitHubDiscussionEntry>({
      fetchPage,
      overlay: item => item, // No per-entry simulation overlay for discussion entries.
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
    });
  }

  async #getDiff(
    logicalId: string,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      // The head branch may itself be provisional (moved or created by queued pushes); read the
      // comparison as if those pushes had landed. GitHub's live compare would 404 on a branch
      // that does not exist yet, or silently describe its stale head.
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }

      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", logicalId), action);
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    const details = await this.#getRemotePullRequestDetails(realId);
    // An existing pull request whose head branch has queued pushes reads its diff at the
    // simulated head, like every other read of that branch.
    if (gitCache !== undefined && isOwnHead(details) &&
        this.#pendingPushActions(details.head.ref).length > 0) {
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, details.base.ref, details.head.ref);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }
    }
    // "diff-v2": the stored revision gained `mergeBaseSha`, and old-shaped entries under the
    // previous key may outlive the TTL via etag revalidation.
    const cacheKey = this.#cacheKey("diff-v2", realId, details.base.sha || "pending", details.head.sha || "pending");
    const cached = this.#loadCached<{ revision: GitHubPullRequestRevision; files: GitHubPullRequestDiffFile[] }>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached) {
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }
    const generation = this.#cacheGeneration();

    const revision: GitHubPullRequestRevision = {
      baseSha: details.base.sha,
      headSha: details.head.sha,
      // The PR-files pages below diff against the merge base but never name it; one compare
      // (cached immutably per sha pair) recovers it.
      mergeBaseSha: await this.#mergeBaseOrWarn(details.base.sha, details.head.sha),
    };
    const allFiles: GitHubPullRequestDiffFile[] = [];

    return {
      revision,
      files: new StreamingCursor<GitHubPullRequestDiffFile>({
        fetchPage: async (page, perPage) => {
          const pageCacheKey = this.#cacheKey("diff-files", realId, revision.baseSha || "pending", revision.headSha || "pending", `p${page}`);
          const normalized = await this.#loadCachedWithEtag<GitHubPullRequestDiffFile[]>(
            pageCacheKey,
            ENTITY_CACHE_TTL_MS,
            async etag => {
              const raw = await this.#withApi(api =>
                api.listPullRequestFilesConditional(
                  this.ctx.props.owner,
                  this.ctx.props.repo,
                  Number(realId),
                  page,
                  perPage,
                  { ifNoneMatch: etag },
                )
              );
              if (raw.status === 304) {
                return raw;
              }

              return {
                status: 200,
                headers: raw.headers,
                data: raw.data.map(file => this.#normalizeDiffFile(file)),
              };
            },
          );
          allFiles.push(...normalized);
          if (normalized.length < perPage) {
            this.#storeCached(cacheKey, { revision, files: allFiles }, generation);
          }
          return normalized;
        },
        overlay: item => item,
        comparator: () => 0,
        injectedItems: [],
        pageSize,
      }),
    };
  }

  #normalizeDiffFile(file: GitHubPullFileResponse): GitHubPullRequestDiffFile {
    return {
      path: file.filename,
      previousPath: file.previous_filename,
      // GitHub also reports `changed` (e.g. a mode change) and `unchanged`, outside our union.
      status: file.status === "changed" || file.status === "unchanged" ? "modified" : file.status,
      additions: file.additions,
      deletions: file.deletions,
      // GitHub omits `patch` for binary files and for large text diffs.
      diffOmitted: !file.patch,
      hunks: file.patch ? parseUnifiedPatch(file.patch) : [],
    };
  }

  async #getDiffThreads(logicalId: string, pageSize: number): Promise<Cursor<GitHubDiffThread>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    let base: GitHubDiffThread[] = [];
    if (realId) {
      base = await this.#fetchRemoteDiffThreads(realId);
    }

    const threads = new Map<string, GitHubDiffThread>(base.map(thread => [thread.id, structuredClone(thread)]));
    const viewer = await this.#getViewerActor();
    for (const action of this.#pendingActionsForEntity("pull", logicalId)) {
      if (action.type === "postReview") {
        for (const comment of action.review.diffComments ?? []) {
          threads.set(comment.provisionalCommentId, {
            id: comment.provisionalCommentId,
            target: comment.target,
            isOutdated: false,
            comments: [{
              id: comment.provisionalCommentId,
              reviewId: action.provisionalReviewId,
              author: viewer,
              bodyMarkdown: this.#rewriteKnownReferences(comment.bodyMarkdown, false),
              createdAt: new Date(action.submittedAt),
              url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${comment.provisionalCommentId}`,
            }],
          });
        }
      } else if (action.type === "replyToDiffComment") {
        const thread = [...threads.values()].find(candidate =>
          candidate.id === action.commentId || candidate.comments.some(comment => comment.id === action.commentId),
        );
        if (thread) {
          thread.comments.push({
            id: action.provisionalCommentId,
            author: viewer,
            bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
            createdAt: new Date(action.submittedAt),
            url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${action.provisionalCommentId}`,
          });
        }
      }
    }

    const sorted = [...threads.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
    return new ArrayCursor(sorted, pageSize);
  }

  /**
   * Fetch all review comments for a PR and group them into threads. Grouping requires
   * seeing all comments (replies may reference comments from different pages), so this
   * accumulates all pages before grouping.
   */
  async #fetchRemoteDiffThreads(realId: string): Promise<GitHubDiffThread[]> {
    await this.#syncPullReviewComments(realId);
    const comments = await this.#materializeAllPullReviewComments(realId);

    const byThread = new Map<string, GitHubDiffThread>();
    for (const comment of comments) {
      const threadId = String(comment.in_reply_to_id ?? comment.id);
      let thread = byThread.get(threadId);
      if (!thread) {
        thread = {
          id: threadId,
          target: commentTargetFromResponse(comment),
          isOutdated: comment.position == null && comment.original_position != null,
          comments: [],
        };
        byThread.set(threadId, thread);
      }

      thread.comments.push({
        id: String(comment.id),
        reviewId: comment.pull_request_review_id ? String(comment.pull_request_review_id) : undefined,
        author: actorFromUser(comment.user),
        bodyMarkdown: comment.body ?? "",
        createdAt: new Date(comment.created_at),
        updatedAt: parseDate(comment.updated_at),
        url: comment.html_url,
      });
    }

    return [...byThread.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
  }

  async describe(): Promise<ResourceDescription> {
    switch (this.ctx.props.resourceKind) {
      case "repo": {
        const repo = await this.#getRepoMetadata();
        return {
          url: repo.url,
          title: repo.fullName,
          snippet: repo.description ?? `GitHub repository ${repo.fullName}`,
          suggestedBindingName: "GITHUB_REPO",
          tsType: "GitHubRepo",
          hookTsType: "GitHubEventHook",
        };
      }
      case "issue": {
        const issue = await this.#getIssueDetails(String(this.ctx.props.issueNumber));
        return {
          url: issue.url,
          title: `Issue #${issue.id}: ${issue.title}`,
          snippet: textSnippet(issue.bodyMarkdown, `${issue.state} issue in ${issue.repo.fullName}`),
          suggestedBindingName: "GITHUB_ISSUE",
          tsType: "GitHubIssue",
          hookTsType: "GitHubEventHook",
        };
      }
      case "pull": {
        const pull = await this.#getPullRequestDetails(String(this.ctx.props.issueNumber));
        return {
          url: pull.url,
          title: `Pull Request #${pull.id}: ${pull.title}`,
          snippet: textSnippet(pull.bodyMarkdown, `${pull.state} pull request in ${pull.repo.fullName}`),
          suggestedBindingName: "GITHUB_PULL_REQUEST",
          tsType: "GitHubPullRequest",
          hookTsType: "GitHubEventHook",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return BINDING_ACTIONS[this.ctx.props.resourceKind].map(kind => ACTION_KINDS[kind]);
  }

  async submitActionForApproval(
    approvalQueue: RpcStub<ApprovalQueue>,
    action: GitHubAction,
    presentation: { title: string; implementsRevert: boolean; pushedCommits?: string[] },
  ): Promise<void> {
    // Sessions reserve the id while building the payload; a hand-built action (tests, older
    // callers) numbers itself, so the journal acknowledges the issuance here.
    this.#actions.reserveThrough(action.approvalId);
    this.#actions.stage(action.approvalId, action);
    try {
      // The text and the auto-approval verdict come from the staged payload, not the caller, so
      // they always describe what applies.
      await approvalQueue.submitAction(action.approvalId, {
        ...presentation,
        ...describeGitHubAction(action),
        ...autoApprovalOf(action),
      });
    } catch (error) {
      this.#actions.rollbackSubmission(action.approvalId);
      throw error;
    }

    this.#markActionPending(action);
    this.#clearCaches();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GitHubRepoSession | GitHubIssue | GitHubPullRequest> {
    const queue = approvalQueue.dup();
    switch (this.ctx.props.resourceKind) {
      case "repo":
        return new GitHubRepoSessionImpl(this, queue);
      case "issue":
        return new GitHubIssueImpl(this, queue, String(this.ctx.props.issueNumber), "issue");
      case "pull":
        return new GitHubPullRequestImpl(this, queue, String(this.ctx.props.issueNumber));
    }
  }

  [restore]({ number }: GitHubHookParams): GitHubHookDelivery {
    return new GitHubHookDeliveryImpl((callback, approvalQueue, event) =>
      this.#deliverHookEvent(number, callback, approvalQueue, event));
  }

  /**
   * Binds `hook` to events in the bound repository, or with `target` on one issue or pull request
   * in it (see `GitHubRepo.subscribe()`), first checking that the account may add the webhook
   * that will deliver them.
   */
  async bindEventHook(
    approvalQueue: RpcStub<ApprovalQueue>, target: { kind: EntityKind; id: string } | undefined,
    hook: RpcStub<GitHubEventHookTarget>, options: GitHubSubscribeOptions | undefined,
  ): Promise<void> {
    if (webhookOrigin(this.env) === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    const { owner, repo, userObjectId } = this.ctx.props;
    const watchable: GitHubEventKind[] = target === undefined
      ? ["issue", "pullRequest", "comment", "review", "push", "tag"]
      : target.kind === "issue" ? ["issue", "comment"] : ["pullRequest", "comment", "review"];
    const events = [...new Set(options?.events ?? watchable)];
    if (events.length === 0 || events.some(kind => !watchable.includes(kind))) {
      throw new TypeError(`This can only watch for ${listEventKinds(watchable, "or")} events.`);
    }
    let number: number | undefined;
    if (target !== undefined) {
      const id = target.id.startsWith("~") ? this.#resolveProvisionalId(target.id) : target.id;
      number = Number(id);
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`#${target.id} can't be watched until it is created on GitHub.`);
      }
    }
    const pin = await this.#pinnedRepo();
    if (!pin) throw new Error(`Failed to look up ${owner}/${repo} on GitHub. Please try again.`);
    const { permissions } = await this.#readApi(api => api.getRepo(owner, repo));
    if (!permissions?.admin) {
      throw new Error(`GitHub delivers events to a webhook, which only an admin of ${owner}/${repo} ` +
        "can add, and the connected account is not one.");
    }

    const params: GitHubHookParams = number === undefined ? {} : { number };
    using delivery: RpcStub<GitHubHookDelivery> = await this.ctx.restore(params);
    const controller = this.ctx.exports.GitHubHookController({ props: {
      ...params,
      key: crypto.randomUUID(),
      userObjectId,
      repo: pin,
      events,
      delivery,
    } });
    const watched = number === undefined
      ? `${owner}/${repo}`
      : `${target?.kind === "pull" ? "pull request" : "issue"} #${number} in ${owner}/${repo}`;
    // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
    await approvalQueue.bindHook(controller, hook, {
      title: sanitizeTitle(`Watch ${watched} on GitHub`),
      description: `Call this hook with each ${listEventKinds(events, "and")} event in ${watched}, ` +
        "letting it read each one and queue changes there for approval. Enabling it adds a " +
        "webhook to the repository on GitHub, unless an earlier hook there already has.",
    });
  }

  /**
   * Delivers one event to one firing of a hook on this binding, or (`number`) on one issue or pull
   * request in it, if the binding admits the event: in the bound repository, and its issue or pull
   * request, while the account can still read it. The driver's own filters only spare firings.
   */
  async #deliverHookEvent(
    number: number | undefined, callback: RpcStub<GitHubEventHookTarget>,
    approvalQueue: RpcStub<ApprovalQueue>, stored: GitHubWebhookEvent,
  ): Promise<void> {
    const { owner, repo, resourceKind, issueNumber } = this.ctx.props;
    const pin = await this.#pinnedRepo();
    if (!pin) throw new Error(`Failed to look up ${owner}/${repo} on GitHub.`);
    if (stored.repoId !== pin.id) return;
    // An issue or pull request binding's hooks watch only that one, whatever their parameters say.
    const scope = issueNumber ?? number;
    // A push or a tag concerns no one issue or pull request.
    if (scope !== undefined && !("number" in stored && stored.number === scope)) return;
    const onPullRequest = stored.kind === "pullRequest" || stored.kind === "review"
      || (stored.kind === "comment" && stored.subject.pullRequest);
    if (resourceKind === "issue" && onPullRequest) return;
    if (resourceKind === "pull" && !onPullRequest) return;
    try {
      // The webhook outlives the account's access to the repository, and its connection, so every
      // delivery asks GitHub afresh, never the cache: a revoked account is refused even moments
      // after a delivery that succeeded. Asked by the repository's id, not its name, which a
      // repository renamed since may have left to another; and with the last answer's ETag, so an
      // unchanged repository answers 304, which costs no rate limit.
      await this.#loadCachedWithEtag(this.#cacheKey("repo-access", String(pin.id)), 0, async etag => {
        const result = await this.#withApi(api => api.getRepoByIdConditional(pin.id, { ifNoneMatch: etag }));
        return result.status === 304 ? result : { ...result, data: true };
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      // Nothing to retry, and nothing else would tell why the hook went quiet.
      logger.warn("dropped a GitHub event the account can no longer read", {
        event: "hooks.delivery.unreadable",
      });
      return;
    }

    // Released when receiveEvent() returns, or here if it is never called.
    const capabilities: Disposable[] = [];
    const gitCache = new SessionGitCache(approvalQueue, { withhold: commit => this.isSimulatedCommitId(commit) });
    let event: GitHubEvent;
    try {
      const built = this.#hookEvent(stored, approvalQueue, capabilities);
      event = built.event;
      await approvalQueue.authorizeObservation(built.observation);
      if (built.commitIds.length > 0) await gitCache.advertise(built.commitIds);
    } catch (error) {
      for (const capability of capabilities) capability[Symbol.dispose]();
      throw error;
    } finally {
      gitCache.dispose();
    }
    await callback.receiveEvent(event);
  }

  /**
   * The event a hook receives for `stored`, with capabilities on `approvalQueue` (each also
   * pushed to `capabilities`), the observation delivering it makes, and the commits it names.
   */
  #hookEvent(stored: GitHubWebhookEvent, approvalQueue: RpcStub<ApprovalQueue>, capabilities: Disposable[]):
      { event: GitHubEvent; observation: ObservationDescription; commitIds: GitOid[] } {
    const { owner, repo } = this.ctx.props;
    const where = `${owner}/${repo}`;
    const { id, actor } = stored;
    const by = actor ? ` by ${codeSpan(`@${actor.login}`)}` : "";
    const held = <T extends Disposable>(capability: T): T => (capabilities.push(capability), capability);
    const issue = (number: number) =>
      held(new GitHubIssueImpl(this, approvalQueue.dup(), String(number), "issue"));
    const pullRequest = (number: number) =>
      held(new GitHubPullRequestImpl(this, approvalQueue.dup(), String(number)));
    switch (stored.kind) {
      case "issue": {
        const info = normalizeIssueDetails(owner, repo, stored.issue as GitHubIssueResponse);
        return {
          event: { kind: "issue", id, actor, action: stored.action, info, issue: issue(stored.number) },
          observation: {
            title: sanitizeTitle(`GitHub issue #${info.id} ${stored.action}: ${info.title}`),
            description: `Receive issue #${info.id} in ${where}, ${stored.action}${by}: its title, ` +
              "body, author, assignees, and labels.",
          },
          commitIds: [],
        };
      }
      case "pullRequest": {
        const info = normalizePullDetails(owner, repo, stored.pullRequest as GitHubPullRequestResponse);
        const action = PULL_REQUEST_ACTION_WORDS[stored.action];
        return {
          event: {
            kind: "pullRequest", id, actor, action: stored.action, info,
            pullRequest: pullRequest(stored.number),
          },
          observation: {
            title: sanitizeTitle(`GitHub pull request #${info.id} ${action}: ${info.title}`),
            description: `Receive pull request #${info.id} in ${where}, ${action}${by}: its title, ` +
              "description, author, assignees, reviewers, labels, branches, and size.",
          },
          commitIds: commitIdsOfPullSummary(info),
        };
      }
      case "comment": {
        const subject = this.#eventSubject(stored.number, stored.subject);
        const comment = "comment" in stored
          ? discussionCommentFromResponse(stored.comment as GitHubIssueCommentResponse)
          : submittedDiffCommentFromResponse(stored.diffComment as GitHubPullRequestReviewCommentResponse);
        const on = ("target" in comment ? "the diff of " : "") +
          (stored.subject.pullRequest ? "pull request" : "issue");
        return {
          event: {
            kind: "comment", id, actor, subject, comment,
            ...stored.subject.pullRequest
              ? { pullRequest: pullRequest(stored.number) }
              : { issue: issue(stored.number) },
          },
          observation: {
            title: sanitizeTitle(`GitHub comment on #${subject.id}: ${subject.title}`),
            description: `Read a new comment${by} on ${on} #${subject.id} in ${where}.`,
          },
          commitIds: [],
        };
      }
      case "review": {
        const subject = this.#eventSubject(stored.number, stored.subject);
        const review = eventReview(stored.review as GitHubPullRequestReviewResponse);
        return {
          event: { kind: "review", id, actor, subject, review, pullRequest: pullRequest(stored.number) },
          observation: {
            title: sanitizeTitle(`GitHub review of #${subject.id}: ${subject.title}`),
            description: `Read a review${by} of pull request #${subject.id} in ${where}: its decision ` +
              "and summary.",
          },
          commitIds: review.commitId === undefined ? [] : [review.commitId],
        };
      }
      case "push": {
        const { branch, before, after, forced } = stored;
        return {
          event: {
            kind: "push", id, actor, branch, before, after, forced,
            repo: held(new GitHubRepoSessionImpl(this, approvalQueue.dup())),
          },
          observation: {
            title: sanitizeTitle(`GitHub push to ${branch} in ${where}`),
            description: `Receive a push${by} to branch ${codeSpan(branch)} of ${where}, ${refChange(before, after)}.`,
          },
          commitIds: [before, after].filter(commit => commit !== undefined),
        };
      }
      case "tag": {
        const { tag, before, after } = stored;
        return {
          event: {
            kind: "tag", id, actor, tag, before, after,
            repo: held(new GitHubRepoSessionImpl(this, approvalQueue.dup())),
          },
          observation: {
            title: sanitizeTitle(`GitHub push of tag ${tag} in ${where}`),
            description: `Receive a push${by} of tag ${codeSpan(tag)} in ${where}, ${refChange(before, after)}.`,
          },
          // An annotated tag names its tag object, which is no commit to advertise.
          commitIds: [],
        };
      }
    }
  }

  #eventSubject(number: number, { title, pullRequest }: { title: string; pullRequest: boolean }) {
    const { owner, repo } = this.ctx.props;
    const id = String(number);
    return { repo: repoRef(owner, repo), id, url: (pullRequest ? pullUrl : issueUrl)(owner, repo, id), title };
  }

  /**
   * Stream a self-contained raw pack through this resource's authenticated transport.
   * No new observation: the kernel only requests objects from previously observed commits.
   * Cache ingestion and native checkout share this path; credentials never enter the guest.
   */
  async gitPull(oids: GitOid[], options: GitPullHints): Promise<GitPullTransfer> {
    return this.#withApi(api => startGitPull(
      body => api.fetchGitUploadPack(this.ctx.props.owner, this.ctx.props.repo, body), oids, options));
  }

  async applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void> {
    return this.#resolutions.run(() => this.#applyAction(actionId, cache));
  }

  /**
   * Applies a decided action inside the resolution lane, claiming it first so an activation that
   * dies mid-dispatch can never have the same effect delivered twice.
   * @param actionId The action to apply.
   * @param cache Action-scoped git cache capability.
   */
  async #applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void> {
    const record = this.#requireActionRecord(actionId);
    if (record.state === "applied") {
      // Already applied: the overseer persists its own completion record only after this method
      // returns, so a crash or lost reply in that window re-delivers the apply. Only this durable
      // record can answer it -- the world may have legitimately moved on since -- and throwing
      // would strand the action as forever un-appliable.
      return;
    }
    if (record.state === "failed") {
      // A cascade retires actions the Workshop still shows as pending until the user discards
      // them too, so this is how an apply learns why it cannot run.
      throw new Error(record.error);
    }
    if (record.state === "claimed") {
      // A previous activation died mid-dispatch. For an unbound action the effect may or may not
      // exist at GitHub, so it must never be re-dispatched blindly; a compare-and-swap-bound one
      // is safe to re-deliver, because the provider refuses the repeat and the refusal settles.
      if (isCasBound(record.action)) {
        this.#actions.restorePending(actionId);
        throw new Error(
          `A previous attempt to apply GitHub action ${actionId} was interrupted. Apply it again: ` +
          "its provider call is bound to the state it was approved against, so a repeat cannot land twice.");
      }
      this.#actions.markFailed(actionId, APPLY_OUTCOME_UNKNOWN_MESSAGE, { outcome: "unknown" });
      throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    }

    this.#actions.markClaimed(actionId);
    try {
      const applied = await this.#dispatchAction(record.action, cache);
      this.#actions.retain(actionId, applied);
      this.#clearCaches();
    } catch (error) {
      if (isGitHubOutcomeUnknown(error) && !isCasBound(record.action)) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${detail})`;
        this.#actions.markFailed(actionId, message, { outcome: "unknown" });
        throw new ActionOutcomeUnknownError(message);
      }
      // A definitive refusal -- or an interrupted compare-and-swap-bound dispatch, whose repeat
      // the provider itself refuses and the refusal path settles: the action stays appliable.
      this.#actions.restorePending(actionId);
      throw error;
    }
    this.#housekeepRetained();
  }

  /**
   * Retires applied actions beyond the retention limit, so the retained tier stays bounded and
   * `applied:action:` id memory keeps its promise (a revert of a retired id reports the action
   * unknown, same as any long-gone id). Runs from every apply, inside the resolution lane the
   * apply already holds; the sweep holds the tier near the limit, so the walk stays a page or
   * three of storage.
   */
  #housekeepRetained(): void {
    const ids: number[] = [];
    let cursor: string | undefined;
    do {
      const page = this.#actions.listRetained({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.entries.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    // Storage lists keys lexicographically, so page order is not id order: sort numerically, then
    // retire all but the newest limit. Ids rise over time, so the newest are the latest applies.
    ids.sort((a, b) => a - b);
    for (const id of ids.slice(0, Math.max(ids.length - RETAINED_ACTION_LIMIT, 0))) {
      this.#actions.retire(id);
    }
  }

  /**
   * Performs the provider calls for one action.
   * @param action The action to dispatch.
   * @param cache Action-scoped git cache capability.
   * @returns The action as applied, carrying artifacts the apply created (a created comment's id).
   */
  async #dispatchAction(action: GitHubAction, cache: RpcStub<GitCache>): Promise<GitHubAction> {
    switch (action.type) {
      case "createIssue": {
        const response = await this.#withApi(api => api.createIssue(action.owner, action.repo, {
          title: action.options.title,
          body: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
          labels: action.options.labels,
          assignees: action.options.assignees,
        }));
        this.#setProvisionalResource(action.provisionalId, { kind: "issue", realId: String(response.number) });
        return action;
      }
      case "createPullRequest": {
        let response;
        try {
          response = await this.#withApi(api => api.createPullRequest(action.owner, action.repo, {
            title: action.options.title,
            body: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
            head: action.options.head,
            base: action.options.base,
            draft: action.options.draft,
          }));
        } catch (error) {
          // The typical cause of a validation failure here is ordering: the pull request was
          // queued against a branch whose push is still awaiting approval, and this action was
          // approved first (GitHub then sees a missing branch, or one with no commits against
          // the base). The action stays pending; applying it again after the push works.
          if (error instanceof GitHubApiError && error.status === 422 &&
              this.#pendingPushActions(action.options.head).length > 0) {
            throw new Error(
              `Cannot create this pull request yet: branch "${action.options.head}" has a queued ` +
              `push that has not been applied. Approve the push to "${action.options.head}" ` +
              `first, then approve this pull request.`, { cause: error });
          }
          throw error;
        }
        this.#setProvisionalResource(action.provisionalId, { kind: "pull", realId: String(response.number) });
        return action;
      }
      case "setTitle": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { title: action.title }));
        return action;
      }
      case "setBody": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          body: this.#rewriteKnownReferences(action.bodyMarkdown, true),
        }));
        return action;
      }
      case "addLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.addLabels(action.owner, action.repo, Number(realId), action.labels));
        return action;
      }
      case "removeLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api =>
          api.setLabels(action.owner, action.repo, Number(realId), remainingLabels(action)));
        return action;
      }
      case "changeState": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          state: action.state,
          state_reason: denormalizeStateReason(action.reason),
        }));
        return action;
      }
      case "postComment": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        const response = await this.#withApi(api => api.createIssueComment(
          action.owner,
          action.repo,
          Number(realId),
          this.#rewriteKnownReferences(action.bodyMarkdown, true),
        ));
        return { ...action, createdCommentId: response.id };
      }
      case "postReview": {
        const realId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!realId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.createPullRequestReview(action.owner, action.repo, Number(realId), {
          commit_id: action.review.revision.headSha,
          body: action.review.bodyMarkdown ? this.#rewriteKnownReferences(action.review.bodyMarkdown, true) : undefined,
          event: action.review.decision === "approve"
            ? "APPROVE"
            : action.review.decision === "requestChanges"
              ? "REQUEST_CHANGES"
              : "COMMENT",
          comments: action.review.diffComments?.map(comment => ({
            path: comment.target.path,
            body: this.#rewriteKnownReferences(comment.bodyMarkdown, true),
            line: comment.target.subjectType === "file" ? undefined : comment.target.line,
            side: comment.target.subjectType === "file" ? undefined : comment.target.side === "old" ? "LEFT" : "RIGHT",
            start_line: comment.target.subjectType === "file" ? undefined : comment.target.startLine,
            start_side: comment.target.subjectType === "file" || !comment.target.startSide
              ? undefined
              : comment.target.startSide === "old" ? "LEFT" : "RIGHT",
            subject_type: comment.target.subjectType,
          })),
        }));
        return action;
      }
      case "replyToDiffComment": {
        const pullId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!pullId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        const replyTargetId = await this.#resolveReplyTarget(action.commentId);
        const response = await this.#withApi(api => api.replyToPullRequestReviewComment(
          action.owner,
          action.repo,
          Number(pullId),
          replyTargetId,
          this.#rewriteKnownReferences(action.bodyMarkdown, true),
        ));
        this.ctx.storage.kv.put(`diffAlias:${action.provisionalCommentId}`, String(response.id));
        return { ...action, createdCommentId: response.id };
      }
      case "mergePullRequest": {
        const pullId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!pullId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        await this.#mergePullRequest(Number(pullId), action);
        return action;
      }
      case "push": {
        // No gatekeeper-side object walk: the overseer composes the pack from the action's
        // pending-push marks (`cache.buildPack()` on the action-scoped stub), and this side
        // contributes only send-pack framing plus the ref-update command. The command's old-sha
        // is the queue-time `expectedOldSha` -- receive-pack's compare-and-swap applies to every
        // update, force or not (fast-forward policy was already enforced at queue time), so a
        // branch that moved between approval and apply fails cleanly instead of being clobbered.
        try {
          const pack = await cache.buildPack();
          await this.#withApi(api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(action.owner, action.repo, body),
            { branch: action.branch, oldSha: action.expectedOldSha, newSha: action.newSha },
            pack));
        } catch (error) {
          if (!(error instanceof GitRefUpdateRejectedError)) throw error;
          // Desired-state semantics live in the kit: a head already at `newSha` settles the apply.
          const head = await desiredStateReached(
            () => this.#withApi(api => api.getBranchHead(action.owner, action.repo, action.branch)),
            action.newSha,
          );
          if (head !== undefined) throw this.#pushRefusal(action, head, error);
        }
        return action;
      }
    }
  }

  /** `PUT …/merge` at the bound head, translating GitHub's refusals into agent-actionable reasons. */
  async #mergePullRequest(pullNumber: number, action: MergePullRequestAction): Promise<void> {
    const { owner, repo, options } = action;
    // Stored data the type cannot vouch for: a merge queued before merges were bound has no head
    // branch, and no head unless the agent passed `expectedHeadSha`, which that release sent as
    // `sha` too. Without a head GitHub would merge whatever the head now is.
    const expectedHeadSha = action.expectedHeadSha ?? options?.expectedHeadSha;
    const headBranch = action.headBranch ?? null;
    if (!expectedHeadSha) {
      throw new Error(`The merge of #${pullNumber} was queued without a bound head commit, so it ` +
        `cannot be applied safely. Discard it and queue the merge again.`);
    }
    try {
      await this.#withApi(api => api.mergePullRequest(owner, repo, pullNumber, {
        merge_method: options?.method,
        commit_title: options?.commitTitle,
        commit_message: options?.commitMessage,
        sha: expectedHeadSha,
      }));
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      if (error.status === 405) {
        // "Not mergeable", which is also GitHub's answer once the pull request is merged -- as it
        // is when this apply retries one whose reply was lost. Merged at the bound head is that
        // merge: GitHub checks `sha` before merging, so it can have merged no other.
        const pull = await this.#readApi(api => api.getPullRequest(owner, repo, pullNumber));
        if (pull.merged_at && pull.head.sha === expectedHeadSha) return;
      } else if (error.status === 409) {
        // The usual cause is ordering, as for a create: the merge is bound to the head a queued
        // push will leave, and was approved before that push.
        if (headBranch !== null && this.#pendingPushActions(headBranch)
          .some(push => push.newSha === expectedHeadSha)) {
          throw new Error(
            `Cannot merge #${pullNumber} yet: it was approved at ${expectedHeadSha}, the head the ` +
            `queued push to "${headBranch}" will leave. Approve that push first, then this merge.`,
            { cause: error });
        }
        throw new Error(
          `Pull request #${pullNumber}'s head has moved from ${expectedHeadSha} since the merge ` +
          `was queued; re-read it and merge again so the new commits are reviewed.`,
          { cause: error });
      }
      throw error;
    }
  }

  /** Why receive-pack refused `push`, given the branch's head read back afterwards. */
  #pushRefusal(push: PushAction, head: string | null, error: GitRefUpdateRejectedError): Error {
    const { branch, expectedOldSha } = push;
    const expected = expectedOldSha === ZERO_OID ? null : expectedOldSha;
    const leavesExpected = (action: GitHubAction) =>
      action.type === "push" && action.branch === branch && action.newSha === expected;
    let reason: string;
    if (head === expected) {
      // The compare-and-swap held, so GitHub refused the update itself (a protected branch, a
      // push rule); its reason is passed through, never matched.
      reason = `GitHub refused the push: ${error.reason}`;
    } else if (expected === null) {
      reason = `The push cannot be applied: a branch named "${branch}" was created after this ` +
        `push was queued (the push would have created it). Re-observe the branch and queue a ` +
        `fresh push against its current head.`;
    } else if (this.#listPendingActions().some(leavesExpected)) {
      reason = `The push cannot be applied yet: it builds on ${expected}, the head the queued ` +
        `push to "${branch}" will leave. Approve that push first, then this one.`;
    } else if (this.#actions.listFailed().some(({ action }) => leavesExpected(action))) {
      reason = `The push cannot be applied: it builds on ${expected}, the head of a discarded ` +
        `push to "${branch}". Re-push your commits from the branch's current head.`;
    } else {
      reason = `The push cannot be applied: branch "${branch}" has moved from ${expected}, the ` +
        `head it was approved against. Re-observe the branch and queue a fresh push against ` +
        `its current head.`;
    }
    return new Error(reason, { cause: error });
  }

  async #resolveReplyTarget(commentId: string): Promise<number> {
    const pendingReplies = new Map(
      this.#listPendingActions()
        .filter((action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment")
        .map(action => [action.provisionalCommentId, action]),
    );

    let resolvedCommentId = commentId;
    const seen = new Set<string>();
    while (pendingReplies.has(resolvedCommentId)) {
      if (seen.size >= MAX_REPLY_TARGET_HOPS) {
        throw new Error(`Reply chain for diff comment ${commentId} exceeded ${MAX_REPLY_TARGET_HOPS} hops.`);
      }
      if (seen.has(resolvedCommentId)) {
        throw new Error(`Reply chain for diff comment ${commentId} contains a cycle.`);
      }

      seen.add(resolvedCommentId);
      const pendingReply = pendingReplies.get(resolvedCommentId);
      if (!pendingReply) {
        break;
      }
      resolvedCommentId = pendingReply.commentId;
    }

    const aliased = this.ctx.storage.kv.get<string>(`diffAlias:${resolvedCommentId}`) ?? resolvedCommentId;
    if (!/^\d+$/.test(aliased)) {
      throw new Error(`Diff comment ${resolvedCommentId} has not been created on GitHub yet.`);
    }

    const comment = await this.#withApi(api => api.getPullRequestReviewComment(
      this.ctx.props.owner,
      this.ctx.props.repo,
      Number(aliased),
    ));
    return comment.in_reply_to_id ?? comment.id;
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#resolutions.run(() => this.#rejectAction(actionId));
  }

  /**
   * Discards an action inside the resolution lane: its cascades read records an apply may settle.
   * @param actionId The action to discard.
   */
  async #rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    // Discarded already: a cascade retires actions the Workshop still shows as pending, and the
    // user's discard of one must then succeed rather than strand it. The record held a slot the
    // kit never prunes -- only this rejection releases it -- so remove it: push-refusal
    // explanations cover the discards nobody has rejected yet.
    if (record.state === "failed") {
      this.#actions.remove(actionId);
      return;
    }
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitHub action ${actionId} is no longer pending.`);
    }

    if (action.type === "push") {
      // A queued pull request may depend on this push for its head (or base) branch to exist at
      // all. With the push rejected, such a pull request can never be created -- cascade-reject
      // it (and, transitively, everything queued against it), mirroring how rejecting a
      // provisional create rejects its dependents. A pull request whose branches still exist --
      // really, or through the remaining queued pushes -- is left queued: a later push can still
      // deliver the branch content.
      const cascaded = await this.#rejectPush(action);
      this.#clearCaches();
      return cascaded ? { restart: true } : undefined;
    }

    this.#markActionRejected(action);
    if (action.type === "createIssue" || action.type === "createPullRequest") {
      this.#rejectActionsForResource(action.type === "createIssue" ? "issue" : "pull", action.provisionalId);
      this.ctx.storage.kv.delete(`provisional:${action.provisionalId}`);
      this.#clearCaches();
      return { restart: true };
    }

    if (action.type === "postReview") {
      this.#rejectReplyDependencyChain((action.review.diffComments ?? []).map(comment => comment.provisionalCommentId));
    } else if (action.type === "replyToDiffComment") {
      this.#rejectReplyDependencyChain([action.provisionalCommentId]);
    }

    this.#clearCaches();
    return;
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    switch (action.type) {
      case "setTitle": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { title: action.previousTitle }));
        this.#clearCaches();
        return;
      }
      case "setBody": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { body: action.previousBodyMarkdown }));
        this.#clearCaches();
        return;
      }
      case "addLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        // Only the labels the action introduced: one that was already there stays.
        const introduced = action.labels.filter(label => !action.previousLabels.includes(label));
        for (const label of introduced) {
          await this.#withApi(api => api.removeLabel(action.owner, action.repo, Number(realId), label));
        }
        this.#clearCaches();
        return;
      }
      case "removeLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        // Only the labels the action removed: one that was never there is not added.
        const removed = action.labels.filter(label => action.previousLabels.includes(label));
        if (removed.length > 0) {
          await this.#withApi(api => api.addLabels(action.owner, action.repo, Number(realId), removed));
        }
        this.#clearCaches();
        return;
      }
      case "changeState": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          state: action.previousState,
          state_reason: denormalizeStateReason(action.previousReason),
        }));
        this.#clearCaches();
        return;
      }
      case "postComment": {
        const createdCommentId = action.createdCommentId;
        if (createdCommentId === undefined) {
          return { message: "Missing issue comment revert information.", canRetry: false };
        }
        await this.#withApi(api => api.deleteIssueComment(action.owner, action.repo, createdCommentId));
        this.#clearCaches();
        return;
      }
      case "replyToDiffComment": {
        const createdCommentId = action.createdCommentId;
        if (createdCommentId === undefined) {
          return { message: "Missing review comment revert information.", canRetry: false };
        }
        await this.#withApi(api =>
          api.deletePullRequestReviewComment(action.owner, action.repo, createdCommentId));
        this.#clearCaches();
        return;
      }
      case "push": {
        // Ref rollback: move the branch back to the head the user approved pushing it from
        // (delete it, if the push created it). The command's old-sha is the pushed commit, so
        // work that landed on the branch after the push is never stomped -- the rollback then
        // fails cleanly instead. The pushed objects stay on the remote (they merely go
        // dangling), which is also why the rollback needs no pack contents: an empty pack
        // accompanies the update, and a deletion sends none (the protocol forbids it).
        const deleting = action.expectedOldSha === ZERO_OID;
        try {
          await this.#withApi(async api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(action.owner, action.repo, body),
            {
              branch: action.branch,
              oldSha: action.newSha,
              newSha: deleting ? ZERO_OID : action.expectedOldSha,
            },
            deleting ? null : bytesToStream(await emptyPackBytes())));
        } catch (error) {
          if (error instanceof GitRefUpdateRejectedError) {
            return {
              message: `Branch "${action.branch}" is no longer at the pushed commit ` +
                `${action.newSha}, so it cannot be rolled back automatically. Reset the branch ` +
                `manually if needed.`,
              canRetry: false,
            };
          }
          throw error;
        }
        this.#clearCaches();
        return;
      }
      case "createIssue":
      case "createPullRequest":
      case "postReview":
      case "mergePullRequest":
        return {
          message: "This GitHub action cannot be automatically reverted.",
          canRetry: false,
        };
      default:
        action satisfies never;
    }
  }

  async repoMetadata(): Promise<GitHubRepoMetadata> {
    return this.#getRepoMetadata();
  }

  async openIssue(id: string): Promise<GitHubIssueDetails> {
    return this.#getIssueDetails(id);
  }

  async openPullRequest(id: string, gitCache?: RpcStub<GitCache>): Promise<GitHubPullRequestDetails> {
    return await this.#getPullRequestDetails(id, gitCache);
  }

  async issueDiscussion(kind: EntityKind, id: string, pageSize: number): Promise<Cursor<GitHubDiscussionEntry>> {
    return this.#getDiscussion(kind, id, pageSize);
  }

  async pullDiff(id: string, pageSize: number, gitCache?: RpcStub<GitCache>): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    return this.#getDiff(id, pageSize, gitCache);
  }

  /**
   * The merge base of a pull request's head and base, resolved like `pullDiff`'s revision (same
   * provisional and queued-push simulation paths) but without fetching any diff. Always a commit
   * GitHub itself knows -- even a simulated head's merge base comes from a live compare against
   * the pending chain's anchor -- so sessions may advertise it.
   */
  async pullMergeBase(id: string, gitCache?: RpcStub<GitCache>): Promise<GitOid> {
    if (id.startsWith("~") && !this.#resolveProvisionalId(id)) {
      const action = this.#findCreateAction(id, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${id} is no longer available.`);
      }
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", id), action);
      if (cached.revision.mergeBaseSha === undefined) {
        throw new Error(`GitHub did not report a merge base for pull request ${id}.`);
      }
      return cached.revision.mergeBaseSha;
    }

    const realId = id.startsWith("~") ? this.#resolveProvisionalId(id)! : id;
    const details = await this.#getRemotePullRequestDetails(realId);
    // A head branch with queued pushes reads at its simulated head, like every other read of
    // that branch; its comparison already knows the merge base it diffs from.
    if (gitCache !== undefined && isOwnHead(details) &&
        this.#pendingPushActions(details.head.ref).length > 0) {
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, details.base.ref, details.head.ref);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
    }
    return await this.#getMergeBaseCached(details.base.sha, details.head.sha);
  }

  async pullThreads(id: string, pageSize: number): Promise<Cursor<GitHubDiffThread>> {
    return this.#getDiffThreads(id, pageSize);
  }

  async listIssues(filter: GitHubIssueFilter | undefined, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    return this.#listIssueSummaries(filter, pageSize);
  }

  async searchIssues(query: GitHubIssueSearch, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    return this.#searchIssueSummaries(query, pageSize);
  }

  async listPullRequests(
    filter: GitHubPullRequestFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#listPullSummaries(filter, pageSize, gitCache);
  }

  async searchPullRequests(
    query: GitHubPullRequestSearch,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#searchPullSummaries(query, pageSize, gitCache);
  }

  /** The queued pushes, oldest first (optionally only those targeting `branch`). */
  #pendingPushActions(branch?: string): PushAction[] {
    return this.#listPendingActions().filter((action): action is PushAction =>
      action.type === "push" && (branch === undefined || action.branch === branch));
  }

  /**
   * Whether `commitId` is the head of a push queued on this gatekeeper -- a commit simulation
   * may hand back that is not on GitHub yet. Session read paths consult this to withhold
   * advertisement of such commits (see `getCommit` for why a cache-served result must not be
   * advertised). Deliberately synchronous, so per-page cursor advertising can check it live as
   * pages are drained; sessions hold this object directly and never call it over RPC.
   */
  isCommitPendingPush(commitId: GitOid): boolean {
    return this.#pendingPushActions().some(action => action.newSha === commitId);
  }

  /**
   * Whether `commitId` is a commit simulation may have handed back that is not on GitHub yet: a
   * queued push's head, or any commit this instance served from the workspace git cache while
   * simulating one (pending chains include the intermediate commits between stacked pushes,
   * which `isCommitPendingPush` alone would miss). Session advertising callbacks consult this,
   * synchronously like `isCommitPendingPush`, to withhold such ids from `advertiseCommit()`.
   */
  isSimulatedCommitId(commitId: GitOid): boolean {
    return this.#servedSimulatedCommitIds.has(commitId) || this.isCommitPendingPush(commitId);
  }

  #repoFullName(): string {
    return `${this.ctx.props.owner}/${this.ctx.props.repo}`;
  }

  /**
   * A branch's current remote head (null if the branch does not exist), cached briefly.
   * Simulation reads use this; the push queue path deliberately keeps using the uncached
   * `getBranchHead`, since a push's expected old head must reflect the remote's live state.
   */
  async #getBranchHeadCached(branch: string): Promise<string | null> {
    const key = this.#cacheKey("branch-head", stableKey(branch));
    const { head } = await this.#cachedRead(key, ENTITY_CACHE_TTL_MS, async () => ({
      head: await this.#withApi(api => api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, branch)),
    }));
    return head;
  }

  /**
   * Record a compare response's merge base in the pair-keyed immutable cache: the merge base of
   * two fixed commits never changes, so any compare that names one -- whatever read wanted the
   * compare -- makes later merge-base lookups of that pair free. `headSha` is the compare's head
   * commit when the caller knows it by sha; a compare made by ref otherwise names its own head
   * only as the last listed commit (absent when the compared range is empty or truncated by
   * paging, in which case nothing is recorded).
   */
  #recordCompareMergeBase(compare: GitHubCompareResponse, headSha?: string): void {
    const mergeBase = compare.merge_base_commit?.sha;
    const head = headSha ?? compare.commits?.at(-1)?.sha;
    if (mergeBase === undefined || head === undefined || !isCommitOid(head)) return;
    this.#storeCached(this.#cacheKey("merge-base", compare.base_commit.sha, head), mergeBase, this.#cacheGeneration());
  }

  /**
   * The merge base of two commits: answered from the pair-keyed cache when a previous compare
   * already named it, else by one metadata-only compare call -- page 2 of the paged form, since
   * GitHub puts the changed-files array (up to 300 entries, patches included) only on a
   * compare's first page, while every page carries the metadata this read wants.
   */
  async #getMergeBaseCached(baseSha: string, headSha: string): Promise<GitOid> {
    return await this.#cachedRead(this.#cacheKey("merge-base", baseSha, headSha), IMMUTABLE_CACHE_TTL_MS, async () =>
      mergeBaseOfCompare(await this.#withApi(api =>
        api.compareBranches(this.ctx.props.owner, this.ctx.props.repo, baseSha, headSha,
          { perPage: 1, page: 2 }))));
  }

  /**
   * `#getMergeBaseCached`, degrading a failure (or a sha that is not a full commit id, e.g. a
   * provisional pull request's empty one) to undefined with a warning: the diff read this
   * decorates works without a merge base -- for instance a head commit from a deleted fork that
   * GitHub can no longer compare -- so it must not fail outright.
   */
  async #mergeBaseOrWarn(baseSha: string, headSha: string): Promise<GitOid | undefined> {
    if (!isCommitOid(baseSha) || !isCommitOid(headSha)) return undefined;
    try {
      return await this.#getMergeBaseCached(baseSha, headSha);
    } catch (error) {
      logger.warn("failed to determine a pull request's merge base", {
        event: "pull.request.merge.base.failed", error,
      });
      return undefined;
    }
  }

  /** Whether GitHub knows this commit (the anchor test for pending-chain walks). */
  async #isCommitOnGitHub(oid: GitOid): Promise<boolean> {
    try {
      await this.#getRemoteCommitDetails(oid);
      return true;
    } catch (error) {
      // GitHub answers an unknown branch/tag name with 404 but an unknown full commit id with
      // 422 ("No commit found for SHA: ..."), and this probe is always a full id.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Walk a simulated branch head down to its **anchor** -- the first commit GitHub already knows
   * -- reading the not-yet-pushed commits from the workspace git cache (which serves this
   * gatekeeper's queued-push closure, pulling objects through on demand). Returns the pending
   * first-parent chain newest-first (what simulated listings show), its anchor, and `pending`:
   * every commit reachable from `head` that GitHub lacks, a local merge's side branches included.
   * A chain that leaves the cache or bottoms out with no GitHub-known ancestor throws, as does
   * exceeding the cap, and callers degrade.
   *
   * Every pending id is recorded in `#servedSimulatedCommitIds`, so sessions withhold it from
   * advertising: listed summaries name their parents, and a side parent advertised as
   * remote-known would be left out of the push's pack, which GitHub then rejects.
   *
   * `realHead` is the branch's remote head, the one ancestor known without a probe. It is the
   * only base the pushes `#simulateBranchHead` consumes start from: every other expectation in
   * that chain is a pending newSha, and a push stranded by a rejection is never consumed, so its
   * never-received expectation must not pass as GitHub's.
   */
  async #collectPendingChain(
    gitCache: RpcStub<GitCache>, head: GitOid, realHead: string | null,
  ): Promise<{
    commits: { summary: GitHubCommitSummary; tree: GitOid }[];
    anchor: GitOid;
    pending: GitOid[];
  }> {
    const commits: { summary: GitHubCommitSummary; tree: GitOid }[] = [];
    const pending: GitOid[] = [];
    const seen = new Set<GitOid>();
    let anchor: GitOid | undefined;
    // Depth-first with first parents on top: the walk descends the first-parent chain until the
    // anchor, then drains the side parents stacked along the way.
    const stack = [head];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (seen.has(current)) continue;
      seen.add(current);
      if (current === realHead || await this.#isCommitOnGitHub(current)) {
        anchor ??= current;
        continue;
      }
      if (pending.length === MAX_PENDING_CHAIN_COMMITS) {
        throw new Error(`More than ${MAX_PENDING_CHAIN_COMMITS} commits are queued for push.`);
      }
      const object = await gitCache.get(current);
      if (object === null || object.type !== "commit") {
        throw new Error(`Commit ${current} is not available from the workspace git cache.`);
      }
      const parsed = parseGitCommitPayload(object.content, current);
      this.#servedSimulatedCommitIds.add(current);
      pending.push(current);
      if (anchor === undefined) {
        if (parsed.parents.length === 0) {
          throw new Error(`Commit ${current} has no ancestor known to GitHub.`);
        }
        commits.push({
          summary: commitDetailsFromGitObject(
            current, object.content, canonicalRepoUrl(this.ctx.props.owner, this.ctx.props.repo)),
          tree: parsed.tree,
        });
      }
      stack.push(...parsed.parents.toReversed());
    }
    return { commits, anchor: anchor!, pending };
  }

  /** The tree oid of a commit, from cached bytes when available, else GitHub's commit API. */
  async #treeOidOfCommit(gitCache: RpcStub<GitCache>, sha: GitOid): Promise<GitOid> {
    const object = await gitCache.get(sha);
    if (object !== null && object.type === "commit") {
      return parseGitCommitPayload(object.content, sha).tree;
    }
    return await this.#cachedRead(this.#cacheKey("commit-tree", sha), ENTITY_CACHE_TTL_MS, async () => {
      const result = await this.#withApi(api =>
        api.getCommitConditional(this.ctx.props.owner, this.ctx.props.repo, sha));
      const tree = result.status === 200 ? result.data.commit.tree?.sha : undefined;
      if (tree === undefined) {
        throw new Error(`Could not resolve the tree of commit ${sha}.`);
      }
      return tree;
    });
  }

  /**
   * Object source for the simulated-diff tree walk: the workspace git cache first (the pending
   * side always resolves there -- the queued-push closure pulls through on demand), falling back
   * to GitHub's git-data API for on-remote objects the cache does not hold.
   */
  #treeDiffSource(gitCache: RpcStub<GitCache>): TreeDiffSource {
    const { owner, repo } = this.ctx.props;
    return {
      getTree: async oid => {
        const object = await gitCache.get(oid);
        if (object !== null && object.type === "tree") {
          return parseGitTreePayload(object.content, oid);
        }
        const remote = await this.#withApi(api => api.getGitTree(owner, repo, oid));
        if (remote === null || remote.truncated) return null;
        return remote.tree.map(entry => ({ mode: entry.mode, name: entry.path, oid: entry.sha }));
      },
      getBlob: async oid => {
        const object = await gitCache.get(oid);
        if (object !== null && object.type === "blob") return object.content;
        const remote = await this.#withApi(api =>
          api.getGitBlob(owner, repo, oid, MAX_DIFF_BLOB_BYTES));
        return remote === null || remote === "oversized" ? "unavailable" : remote;
      },
    };
  }

  /**
   * The simulated `base...head` comparison for a pull request whose head branch has queued
   * pushes, computed as if those pushes had already landed: the head is the simulated branch
   * head, the commit list splices GitHub's `compare(base...anchor)` with the pending chain, and
   * the file diff is a local tree diff from the merge base to the simulated head (GitHub cannot
   * compute it -- the pending commits are not on the remote). Returns null when no overlay
   * applies (no cache, no queued pushes, or the remote has invalidated their expectations), so
   * callers fall through to the ordinary remote reads.
   *
   * Results are cached per (base, simulated head); every write action bumps the cache
   * generation, so a queued/applied/rejected push invalidates them.
   *
   * Known gap: a queued push to the *base* branch is not overlaid here -- the comparison uses
   * the base branch's remote state (the merge base against a not-yet-pushed base commit is
   * unknowable to GitHub).
   */
  async #simulatedPullComparison(
    gitCache: RpcStub<GitCache> | undefined,
    baseRef: string,
    headBranch: string,
  ): Promise<SimulatedPullComparison | null> {
    if (gitCache === undefined) return null;
    if (this.#pendingPushActions(headBranch).length === 0) return null;
    const realHead = await this.#getBranchHeadCached(headBranch);
    const simulatedHead = this.#simulateBranchHead(headBranch, realHead);
    if (simulatedHead === null || simulatedHead === realHead) return null;

    // "-v2": `pendingCommitIds` gained merges' side parents, which a hit withholds from advertising.
    const cacheKey = this.#cacheKey("pull-simulated-v2", stableKey(baseRef), simulatedHead);
    const cached = this.#loadCached<SimulatedPullComparison>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) {
      // The served-id set is in-memory; re-record the cached result's pending ids so this
      // instance's advertising filter covers them too.
      for (const id of cached.pendingCommitIds) this.#servedSimulatedCommitIds.add(id);
      return cached;
    }

    const generation = this.#cacheGeneration();
    const chain = await this.#collectPendingChain(gitCache, simulatedHead, realHead);
    const compare = await this.#withApi(api =>
      api.compareBranches(this.ctx.props.owner, this.ctx.props.repo, baseRef, chain.anchor));
    this.#recordCompareMergeBase(compare, chain.anchor);
    // Malformed (merge-base-less) responses throw here, degrading via
    // #simulatedPullComparisonOrWarn: the tree diff below would be wrong against any other base.
    const mergeBase = mergeBaseOfCompare(compare);

    const newTree = chain.commits.length > 0
      ? chain.commits[0].tree
      : await this.#treeOidOfCommit(gitCache, simulatedHead);
    const files = await diffGitTrees(
      this.#treeDiffSource(gitCache), await this.#treeOidOfCommit(gitCache, mergeBase), newTree);

    const result: SimulatedPullComparison = {
      // The pending chain descends from the anchor without touching the base branch, so the
      // diff's merge base is the compare's (base, anchor) one.
      revision: { baseSha: compare.base_commit.sha, headSha: simulatedHead, mergeBaseSha: mergeBase },
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      totalCommits: compare.total_commits + chain.commits.length,
      // Oldest-first, like GitHub's compare and PR commit listings.
      commitSummaries: [
        ...(compare.commits ?? []).map(normalizeCommitSummary),
        ...chain.commits.map(commit => commit.summary).toReversed(),
      ],
      pendingCommitIds: chain.pending,
    };
    this.#storeCached(cacheKey, result, generation);
    return result;
  }

  /**
   * `#simulatedPullComparison`, degrading a simulation failure (e.g. a chain commit no longer
   * pullable) to null with a warning, so read paths fall back to their remote reads rather than
   * failing outright.
   */
  async #simulatedPullComparisonOrWarn(
    gitCache: RpcStub<GitCache> | undefined,
    baseRef: string,
    headBranch: string,
  ): Promise<SimulatedPullComparison | null> {
    try {
      return await this.#simulatedPullComparison(gitCache, baseRef, headBranch);
    } catch (error) {
      logger.warn("failed to simulate a pull request comparison over queued pushes", {
        event: "pull.request.simulated.comparison.failed", error,
      });
      return null;
    }
  }

  /**
   * GitHub's live `base...head` compare for a provisional pull request with no queued-push
   * overlay, cached and normalized. A 404 -- either branch missing from the remote -- becomes an
   * agent-actionable error instead of a raw API failure. Callers key this under
   * `compare-provisional-v2`: the stored revision gained `mergeBaseSha`, and etag revalidation
   * can keep an old-shaped entry alive past the TTL.
   */
  async #compareForProvisionalPull(cacheKey: string, action: CreatePullRequestAction): Promise<{
    revision: GitHubPullRequestRevision;
    files: GitHubPullRequestDiffFile[];
    commits: GitHubCommitSummary[];
  }> {
    try {
      return await this.#loadCachedWithEtag(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
        const comparison = await this.#withApi(api =>
          api.compareBranchesConditional(
            this.ctx.props.owner,
            this.ctx.props.repo,
            action.options.base,
            action.options.head,
            { ifNoneMatch: etag },
          )
        );
        if (comparison.status === 304) {
          return comparison;
        }

        this.#recordCompareMergeBase(comparison.data);
        const revision = {
          baseSha: comparison.data.base_commit.sha,
          headSha: comparison.data.commits?.at(-1)?.sha ?? comparison.data.base_commit.sha,
          mergeBaseSha: comparison.data.merge_base_commit?.sha,
        };
        return {
          status: 200,
          headers: comparison.headers,
          data: {
            revision,
            files: (comparison.data.files ?? []).map(file => this.#normalizeDiffFile(file)),
            commits: (comparison.data.commits ?? []).map(normalizeCommitSummary),
          },
        };
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new Error(
          `Cannot compare branches "${action.options.base}" and "${action.options.head}" for ` +
          `pull request ${action.provisionalId}: at least one of them does not exist on GitHub. ` +
          `Push the missing branch first.`, { cause: error });
      }
      throw error;
    }
  }

  /**
   * The head a branch reads at once its queued pushes are treated as applied (the kit's
   * `simulateBranchHead` over this branch's pending pushes). This is both the simulation read
   * (`listBranches`/`getCommit`) and what the queue path binds the *next* push's `expectedOldSha` to.
   */
  #simulateBranchHead(branch: string, realHead: string | null): string | null {
    return simulateBranchHead(realHead, this.#pendingPushActions(branch));
  }

  // Reads a commit queued for push (or already proven on this remote) from the workspace git
  // cache and synthesizes the details shape from its exact bytes; null if the cache's scoped
  // view doesn't serve it as a commit.
  async #tryReadCachedCommitDetails(
    gitCache: RpcStub<GitCache>, oid: string,
  ): Promise<GitHubCommitDetails | null> {
    const object = await gitCache.get(oid);
    if (object === null || object.type !== "commit") return null;
    return commitDetailsFromGitObject(
      oid, object.content, canonicalRepoUrl(this.ctx.props.owner, this.ctx.props.repo));
  }

  async listBranches(filter: GitHubBranchFilter | undefined, pageSize: number): Promise<Cursor<GitHubBranchSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;

    // Simulation: a branch a queued push *creates* is injected (protected: false, like any new
    // branch) -- but only while the remote still lacks the name, checked against the live
    // branch here, mirroring how a head overlay stops applying once the remote invalidates its
    // expectation (and the same condition apply's zero-id CAS will enforce). If the branch has
    // appeared remotely in the interim, nothing is injected and the real row is listed (with
    // the ordinary head overlay), so reads never hide a branch that genuinely exists. The
    // name filter below only closes the race between this check and the page fetch.
    const injectedNames = new Set<string>();
    const injectedItems: GitHubBranchSummary[] = [];
    const creationsChecked = new Set<string>();
    for (const action of this.#pendingPushActions()) {
      if (action.expectedOldSha !== ZERO_OID || creationsChecked.has(action.branch)) continue;
      creationsChecked.add(action.branch);
      const realHead = await this.#withApi(api =>
        api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, action.branch));
      if (realHead !== null) continue;
      const head = this.#simulateBranchHead(action.branch, null);
      if (head === null) continue;
      injectedNames.add(action.branch);
      if (filter?.protected !== true) {
        // Served-simulated recording (not just isCommitPendingPush coverage): the page carrying
        // this row may be drained after the push is rejected, and the advertising callback must
        // still withhold a head that never reached the remote.
        this.#servedSimulatedCommitIds.add(head);
        injectedItems.push({ name: action.branch, headCommit: head, protected: false });
      }
    }

    return new StreamingCursor<GitHubBranchSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-branches", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubBranchSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listBranchesConditional(owner, repo, {
            protected: filter?.protected,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeBranchSummary),
          };
        });
      },
      // A branch a queued push moves reads at the pushed head (see #simulateBranchHead). The
      // simulated head is recorded as served so the advertising callback withholds it even if
      // the push is rejected between this overlay and the page's advertisement.
      overlay: item => {
        if (injectedNames.has(item.name)) return null;
        const head = this.#simulateBranchHead(item.name, item.headCommit) ?? item.headCommit;
        if (head === item.headCommit) return item;
        this.#servedSimulatedCommitIds.add(head);
        return { ...item, headCommit: head };
      },
      comparator: () => 0,
      injectedItems,
      // Injected rows are snapshots from cursor-build time, but a queued creation can be
      // rejected (or superseded) before the page carrying its row is drained -- re-simulate from
      // the live queue at serve time, dropping the row when no queued creation remains, so a
      // rejected push's branch stops being listed. (The eager loop above already verified the
      // branch is absent remotely; a branch appearing mid-drain is the documented filter race.)
      revalidateInjected: item => {
        const head = this.#simulateBranchHead(item.name, null);
        if (head === null) return null;
        this.#servedSimulatedCommitIds.add(head);
        return head === item.headCommit ? item : { ...item, headCommit: head };
      },
      pageSize,
    });
  }

  async listTags(pageSize: number): Promise<Cursor<GitHubTagSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    return new StreamingCursor<GitHubTagSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-tags", `p${page}`);
        return await this.#loadCachedWithEtag<GitHubTagSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listTagsConditional(owner, repo, {
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeTagSummary),
          };
        });
      },
      overlay: item => item,
      comparator: () => 0,
      injectedItems: [],
      pageSize,
    });
  }

  /**
   * Look up a commit for the session. `fromCache` reports whether the details were served from
   * the workspace git cache rather than from GitHub; the session must not advertise a
   * cache-served result -- either the commit was populated from this remote in the first place
   * (its provenance is already recorded, so advertising again is a no-op) or it is part of a
   * pending push (not on the remote yet, and an advertisement would outlive a rejection as a
   * permanently wrong pull-routing hint that also makes future push marking walks skip the
   * object as remote-known).
   */
  async getCommit(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>)
      : Promise<{ details: GitHubCommitDetails, fromCache: boolean }> {
    // An omitted ref means the default branch, resolved here rather than passed through to
    // GitHub so a queued push to the default branch still simulates.
    const ref = refOrDefault ?? (await this.#getRepoMetadata()).defaultBranch;
    // Simulation: a branch name with queued pushes resolves to its simulated head, read from the
    // workspace git cache (a queued commit reads exactly as it will once pushed).
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      let realHead: string | null = null;
      try {
        realHead = (await this.#getRemoteCommitDetails(ref)).id;
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      }
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        const details = await this.#tryReadCachedCommitDetails(gitCache, simulated);
        if (details !== null) return { details, fromCache: true };
      }
      if (realHead === null) {
        throw new Error(`No commit found for ref "${ref}".`);
      }
      // The overlay was a no-op (e.g. the remote invalidated the queued push's expectation);
      // fall through to the real read.
    }

    try {
      return { details: await this.#getRemoteCommitDetails(ref), fromCache: false };
    } catch (error) {
      // A full commit id GitHub doesn't know yet may be queued for push; serve it from the
      // workspace git cache so the caller sees the world as if the push had landed. GitHub
      // reports an unknown full commit id as 422 ("No commit found for SHA: ..."), not 404 --
      // but accept both, since the guard already requires a full id.
      if (gitCache !== undefined && isCommitOid(ref) &&
          error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        const details = await this.#tryReadCachedCommitDetails(gitCache, ref);
        if (details !== null) return { details, fromCache: true };
      }
      throw error;
    }
  }

  async #getRemoteCommitDetails(ref: string): Promise<GitHubCommitDetails> {
    // Commits are immutable, but `ref` may be a branch or tag name, so the short TTL still applies.
    const cacheKey = this.#cacheKey("commit", stableKey(ref));
    return await this.#loadCachedWithEtag<GitHubCommitDetails>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getCommitConditional(this.ctx.props.owner, this.ctx.props.repo, ref, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      return {
        status: 200,
        headers: result.headers,
        data: normalizeCommitDetails(result.data),
      };
    });
  }

  /**
   * Resolve a ref to a full commit id for the session, without `getCommit`'s full-commit REST
   * read (whose response carries the commit's whole diff). Same simulation semantics: a branch
   * with queued pushes resolves to its simulated head, and a queued-push commit id GitHub does
   * not know yet is confirmed from the workspace git cache -- both reported as `fromCache`,
   * which the session must not advertise (see `getCommit`).
   */
  async resolveRef(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>)
      : Promise<{ id: GitOid; fromCache: boolean }> {
    const ref = refOrDefault ?? (await this.#getRepoMetadata()).defaultBranch;
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      const realHead = await this.#getBranchHeadCached(ref);
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        // Confirm the commit is actually served by the cache's scoped view (as getCommit does)
        // before answering with an id GitHub does not know.
        const object = await gitCache.get(simulated);
        if (object !== null && object.type === "commit") {
          return { id: simulated, fromCache: true };
        }
      }
      if (realHead === null) {
        throw new Error(`No commit found for ref "${ref}".`);
      }
      // The overlay was a no-op; fall through to the real read.
    }

    try {
      return { id: await this.#resolveRemoteRef(ref), fromCache: false };
    } catch (error) {
      // A full commit id GitHub doesn't know yet may be queued for push; confirm it from the
      // workspace git cache so the caller sees the world as if the push had landed. As in
      // getCommit, GitHub's unknown-full-commit-id answer is 422, not 404; accept both.
      if (gitCache !== undefined && isCommitOid(ref) &&
          error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        const object = await gitCache.get(ref);
        if (object !== null && object.type === "commit") return { id: ref, fromCache: true };
      }
      throw error;
    }
  }

  async #resolveRemoteRef(ref: string): Promise<GitOid> {
    // Like #getRemoteCommitDetails: the resolution of a branch or tag name is mutable, hence the
    // short TTL.
    const cacheKey = this.#cacheKey("resolve-ref", stableKey(ref));
    return await this.#loadCachedWithEtag<GitOid>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getCommitShaConditional(this.ctx.props.owner, this.ctx.props.repo, ref, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      const sha = result.data.trim();
      if (!isCommitOid(sha)) {
        throw new Error(`GitHub returned an unexpected response for ref "${ref}".`);
      }
      return { status: 200, headers: result.headers, data: sha };
    });
  }

  async listCommits(
    filter: GitHubCommitFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubCommitSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;

    // A ref naming a branch with queued pushes enumerates from the simulated head: the pending
    // chain (locally filtered) is injected newest-first ahead of GitHub's listing, which starts
    // from the chain's anchor -- the first commit GitHub actually knows. Without this, a branch
    // a queued push creates 404s, and a moved one lists its stale history. An omitted ref means
    // the default branch (see GitHubCommitFilter.ref, matching GitHub's own default for the
    // listing endpoint), so it is resolved before the queued-push check -- otherwise a
    // parameterless listing after a queued default-branch push would show stale remote history
    // while getCommit()/resolveRef() already show the pending head. The metadata read is gated
    // on there being any queued push at all.
    let injected: GitHubCommitSummary[] = [];
    let startRef = filter?.ref;
    if (gitCache !== undefined && this.#pendingPushActions().length > 0) {
      const ref = filter?.ref ?? (await this.#getRepoMetadata()).defaultBranch;
      if (this.#pendingPushActions(ref).length > 0) {
        // From here on the listing names the resolved ref explicitly (simulation success
        // narrows it to the chain's anchor below): the pending check just consulted `ref`, and
        // a listing left to GitHub's live default could name a *different* branch than the one
        // simulated against if the default changed under the cached metadata -- disagreeing
        // with getCommit()/resolveRef(), which resolve from the same cache.
        startRef = ref;
        const realHead = await this.#getBranchHeadCached(ref);
        const simulatedHead = this.#simulateBranchHead(ref, realHead);
        if (simulatedHead !== null && simulatedHead !== realHead) {
          try {
            const chain = await this.#collectPendingChain(gitCache, simulatedHead, realHead);
            injected = await this.#filterPendingCommitsForListing(gitCache, chain, filter);
            startRef = chain.anchor;
          } catch (error) {
            logger.warn("failed to simulate a commit listing over queued pushes", {
              event: "commits.list.simulated.failed", error,
            });
            if (realHead === null) {
              throw new Error(
                `Branch "${ref}" does not exist on GitHub yet and the commits queued to ` +
                `create it could not be read. Retry, or list commits from an existing ref.`,
                { cause: error });
            }
          }
        }
      }
    }

    return new StreamingCursor<GitHubCommitSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-commits", stableKey({ ...filter, ref: startRef }), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubCommitSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listCommitsConditional(owner, repo, {
            sha: startRef,
            path: filter?.path,
            author: filter?.author,
            since: filter?.since?.toISOString(),
            until: filter?.until?.toISOString(),
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeCommitSummary),
          };
        });
      },
      overlay: item => item,
      // Injected pending commits are newer than everything the remote lists (newest-first).
      comparator: () => -1,
      injectedItems: injected,
      pageSize,
    });
  }

  /**
   * Apply a commit listing's filters to a pending chain locally, the way GitHub would have:
   * author matches the commit identity's name or email, since/until compare the committer date,
   * and path membership is decided by a tree diff against the commit's first parent.
   */
  async #filterPendingCommitsForListing(
    gitCache: RpcStub<GitCache>,
    chain: { commits: { summary: GitHubCommitSummary; tree: GitOid }[]; anchor: GitOid },
    filter: GitHubCommitFilter | undefined,
  ): Promise<GitHubCommitSummary[]> {
    const results: GitHubCommitSummary[] = [];
    const path = filter?.path === undefined ? undefined : stripTrailingSlashes(filter.path);
    for (let index = 0; index < chain.commits.length; index++) {
      const { summary, tree } = chain.commits[index];
      if (filter?.author !== undefined &&
          summary.author.email !== filter.author && summary.author.name !== filter.author) {
        continue;
      }
      const date = summary.committer.date ?? summary.author.date;
      if (filter?.since !== undefined && (date === undefined || date < filter.since)) continue;
      if (filter?.until !== undefined && (date === undefined || date > filter.until)) continue;
      if (path !== undefined) {
        const parentTree = index + 1 < chain.commits.length
          ? chain.commits[index + 1].tree
          : await this.#treeOidOfCommit(gitCache, chain.anchor);
        const changed =
          await changedPathsBetweenTrees(this.#treeDiffSource(gitCache), parentTree, tree);
        if (!changed.some(candidate => candidate === path || candidate.startsWith(`${path}/`))) {
          continue;
        }
      }
      results.push(summary);
    }
    return results;
  }

  async pullCommits(
    logicalId: string,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubCommitSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      // The pull request doesn't exist on GitHub yet; simulate its commit list. When the head
      // branch has queued pushes, the spliced simulation is the truth (GitHub's compare would
      // 404 on a branch the queued push creates, or miss the pushed commits); otherwise the
      // branch comparison is, the same source #getDiff uses for provisional pull requests.
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        return new ArrayCursor(simulated.commitSummaries, pageSize);
      }

      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", logicalId), action);
      return new ArrayCursor(cached.commits, pageSize);
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    // An existing pull request whose head branch has queued pushes: list the simulated
    // comparison instead of the remote pages (a force push may even have replaced the listed
    // history, so splicing pages with the pending chain would misreport it).
    if (gitCache !== undefined && this.#pendingPushActions().length > 0) {
      const details = await this.#getRemotePullRequestDetails(realId);
      if (isOwnHead(details) && this.#pendingPushActions(details.head.ref).length > 0) {
        const simulated = await this.#simulatedPullComparisonOrWarn(
          gitCache, details.base.ref, details.head.ref);
        if (simulated !== null) {
          return new ArrayCursor(simulated.commitSummaries, pageSize);
        }
      }
    }
    return new StreamingCursor<GitHubCommitSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("pull-commits", realId, `p${page}`);
        return await this.#loadCachedWithEtag<GitHubCommitSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api =>
            api.listPullRequestCommitsConditional(owner, repo, Number(realId), page, perPage, { ifNoneMatch: etag })
          );
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeCommitSummary),
          };
        });
      },
      overlay: item => item,
      comparator: () => 0,
      injectedItems: [],
      pageSize,
    });
  }

  async prepareCreateIssue(options: GitHubCreateIssueOptions): Promise<CreateIssueAction> {
    return {
      type: "createIssue",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      provisionalId: this.#nextProvisionalResourceId(),
      options,
    };
  }

  async prepareCreatePullRequest(options: GitHubCreatePullRequestOptions): Promise<CreatePullRequestAction> {
    // Queue-time validation: both branches must exist -- on the remote, or as the not-yet-applied
    // outcome of queued pushes (`#simulateBranchHead` overlays those). Failing here surfaces a
    // typo'd or forgotten-to-push branch to the caller immediately, instead of queuing an action
    // GitHub will later refuse.
    for (const [role, branch] of [["head", options.head], ["base", options.base]] as const) {
      const realHead = await this.#getBranchHeadCached(branch);
      if (this.#simulateBranchHead(branch, realHead) === null) {
        throw new Error(role === "head"
          ? `Cannot create a pull request from branch "${branch}": the branch does not exist in ` +
            `${this.#repoFullName()}. Push your commits to the branch first (see push()), then ` +
            `create the pull request.`
          : `Cannot create a pull request into branch "${branch}": the base branch does not ` +
            `exist in ${this.#repoFullName()}.`);
      }
    }
    return {
      type: "createPullRequest",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      provisionalId: this.#nextProvisionalResourceId(),
      options,
    };
  }

  async prepareSetTitle(targetKind: EntityKind, targetId: string, title: string): Promise<SetTitleAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "setTitle",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      title,
      previousTitle: details.title,
    };
  }

  async prepareSetBody(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<SetBodyAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "setBody",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      bodyMarkdown,
      previousBodyMarkdown: details.bodyMarkdown,
    };
  }

  async prepareAddLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<AddLabelsAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "addLabels",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      labels,
      previousLabels: details.labels.map(label => label.name),
    };
  }

  async prepareRemoveLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<RemoveLabelsAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "removeLabels",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      labels,
      previousLabels: details.labels.map(label => label.name),
    };
  }

  async prepareChangeState(
    targetKind: EntityKind,
    targetId: string,
    state: GitHubIssueState,
    reason?: "completed" | "notPlanned",
  ): Promise<ChangeStateAction> {
    const current = await this.#getCurrentStateInfo(targetKind, targetId);
    return {
      type: "changeState",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      state,
      reason,
      previousState: current.state,
      previousReason: current.reason,
    };
  }

  async preparePostComment(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<PostCommentAction> {
    return {
      type: "postComment",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("comment"),
    };
  }

  async preparePostReview(pullId: string, review: GitHubPullRequestReviewDraft): Promise<PostReviewAction> {
    return {
      type: "postReview",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      provisionalReviewId: this.#nextProvisionalCommentId("review"),
      review: {
        ...review,
        diffComments: review.diffComments?.map(comment => ({
          ...comment,
          provisionalCommentId: this.#nextProvisionalCommentId("diff"),
        })),
      },
    };
  }

  async prepareReplyToDiffComment(pullId: string, commentId: string, bodyMarkdown: string): Promise<ReplyToDiffCommentAction> {
    return {
      type: "replyToDiffComment",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      commentId,
      bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("reply"),
    };
  }

  /**
   * Binds the head the merge is approved against: without it, commits pushed between approval
   * and apply -- a fork contributor's, or the agent's own through another approved push -- would
   * merge unreviewed. A same-repo head reads at its simulated head (queued pushes treated as
   * applied, from the queue records rather than the git cache, so a merge queued behind the
   * agent's own push binds that push's commit); a fork's head reads as GitHub reports it; a
   * provisional pull request's at its head branch's simulated head.
   */
  async prepareMergePullRequest(pullId: string, options?: GitHubPullRequestMergeOptions): Promise<MergePullRequestAction> {
    const realId = pullId.startsWith("~") ? this.#resolveProvisionalId(pullId) : pullId;
    let headBranch: string | null;
    let headSha: string | null;
    if (realId === undefined) {
      const create = this.#findCreateAction(pullId, "pull") as CreatePullRequestAction | undefined;
      if (!create) throw new Error(`Provisional pull request ${pullId} is no longer available.`);
      headBranch = create.options.head;
      headSha = this.#simulateBranchHead(headBranch, await this.#getBranchHeadCached(headBranch));
    } else {
      const pull = await this.#getRemotePullRequestDetails(realId);
      headBranch = isOwnHead(pull) ? pull.head.ref : null;
      headSha = headBranch === null ? pull.head.sha : this.#simulateBranchHead(headBranch, pull.head.sha);
    }
    const label = pullId.startsWith("~") ? pullId : `#${pullId}`;
    if (!headSha) {
      throw new Error(
        `Pull request ${label}'s head could not be determined (its head branch does not exist), ` +
        `so the merge cannot be bound to a reviewed state.`);
    }
    if (options?.expectedHeadSha !== undefined && options.expectedHeadSha !== headSha) {
      throw new Error(
        `Cannot merge pull request ${label}: its head is ${headSha}, not the expected ` +
        `${options.expectedHeadSha}. Re-read it and review the new commits before merging.`);
    }
    return {
      type: "mergePullRequest",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      options,
      expectedHeadSha: headSha,
      headBranch,
    };
  }

  /**
   * Prepare a push action, binding the expected remote ref state at queue time: reads the
   * branch's current head and overlays this repo's earlier queued pushes (see
   * `#simulateBranchHead` -- stacked pushes bind each `expectedOldSha` to the previous push's
   * `newSha`, so approving them in order applies cleanly). Returns null when the (simulated)
   * branch is already at `commitId`: the desired end state already holds and there is no side
   * effect to queue.
   *
   * A non-force push must be a fast-forward: `expectedOldSha` must be an ancestor of `commitId`,
   * checked here -- before anything is queued -- by walking the workspace-cached commit chain
   * (`GitCache.isAncestor()`; the chain from an agent-authored commit down to a pulled base is
   * locally cached by construction). Branch creation is exempt (there is no old head to
   * fast-forward from; the zero-id compare-and-swap at apply protects against a branch appearing
   * in the interim), and `force` skips only this policy check -- it does not loosen the old-sha
   * match at apply.
   */
  async preparePush(branch: string, commitId: string, force: boolean,
                    gitCache: RpcStub<GitCache>): Promise<PushAction | null> {
    const realHead = await this.#withApi(api =>
      api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, branch));
    const expectedOldSha = this.#simulateBranchHead(branch, realHead) ?? ZERO_OID;
    if (expectedOldSha === commitId) return null;
    if (!force && expectedOldSha !== ZERO_OID &&
        !(await gitCache.isAncestor(expectedOldSha, commitId))) {
      throw new Error(
        `Cannot push to branch "${branch}": its current head ${expectedOldSha} is not an ` +
        `ancestor of ${commitId}, so this push is not a fast-forward -- the branch has moved ` +
        `past the head this work was based on. Pull the branch's new head and rebase onto it, ` +
        `or pass force: true to overwrite the branch.`);
    }
    return {
      type: "push",
      approvalId: this.#actions.reserveId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      branch,
      expectedOldSha,
      newSha: commitId,
      force,
    };
  }

  /**
   * Observer tracking: GitHub uses the "ACL check (single unit)" strategy. Every binding — repo,
   * issue, or pull request — is scoped to one repository, and issues/PRs inherit the repo's
   * permissions, so the repository is the atomic ACL unit. To admit an observer we simply confirm
   * they can read that repo, using their own token via the verifier (see GitHubVerifier).
   *
   * Because the whole unit is verified up front, there is never a later observation a verified
   * observer shouldn't see, so we set no excludeObservers and need not remember observers;
   * removeObserver is an idempotent no-op. The overseer re-runs addObserver on every open, so loss
   * of the observer's repo access is caught promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<GitHubVerifierApi>;
    const { owner, repo } = this.ctx.props;
    if (!(await verifier.hasRepoAccess(owner, repo))) {
      throw new Error(
        `This collaborator does not have read access to the GitHub repository ${owner}/${repo}, ` +
        `so they cannot be allowed to observe data this workspace read from it.`);
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}
