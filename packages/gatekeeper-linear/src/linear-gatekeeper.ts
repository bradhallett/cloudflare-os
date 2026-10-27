// The per-binding Linear gatekeeper Durable Object: one instance per (account, workspace |
// team | issue) binding. It runs every Linear request through the account's credential source,
// records queued actions and overlays them onto everything it returns (so a caller sees the world
// as if its queued work had landed), tracks which teams' data workspace bindings have observed,
// and mints the sessions agents talk to (linear-sessions.ts).

import { DurableObject, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  applyClaimedAction, markOutcomeUnknown, type ClaimedActionStore,
} from "@gadgets/gatekeeper-kit/outcome-unknown";
import { isLinearOutcomeUnknown, LinearApi, LinearApiError } from "./linear-api";
import type {
  RawComment,
  RawConnection,
  RawCycle,
  RawIssue,
  RawLabel,
  RawOrganization,
  RawProject,
  RawTeam,
  RawUser,
  RawWorkflowState,
} from "./linear-api";
import type {
  ActionDescriptionDraft,
  ActionStatus,
  StoredAction,
  StoredActionDraft,
} from "./linear-action-types";
import { type Env, type LinearGatekeeperImplProps, logger } from "./linear-env";
import { buildIssueFilter, type IssuePageArgs } from "./linear-normalize";
import {
  LinearIssueImpl,
  LinearTeamSessionImpl,
  LinearWorkspaceSessionImpl,
} from "./linear-sessions";
import type { LinearIssue, LinearTeam, LinearWorkspace } from "./types";
import TYPES_CODE from "./types.txt";

/**
 * The non-standard methods the Linear gatekeeper calls on its own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface LinearVerifierApi extends GatekeeperUserVerifier {
  hasWorkspaceAccess(workspaceUrlKey: string): Promise<boolean>;
  hasTeamAccess(workspaceUrlKey: string, teamKeyOrId: string): Promise<boolean>;
  hasIssueAccess(workspaceUrlKey: string, issueRef: string): Promise<boolean>;
}

const METADATA_CACHE_TTL_MS = 60 * 1000;

function snippet(text: string | null | undefined, fallback = ""): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

type TeamObservationCheck = {
  excludeObservers?: string[];
  pendingTeams: string[];
  commit(): void;
};

type ObservedTeamState = true | "pending" | "observed";

@validateRpc()
export class LinearGatekeeperImpl extends DurableObject<Env, LinearGatekeeperImplProps>
    implements Gatekeeper<LinearWorkspace | LinearTeam | LinearIssue> {

  // ---- private API access (token never leaves the DO) ----

  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #run<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    const api = new LinearApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) {
        try { await account.noteCredentialsExpired(); } catch (notifyErr) {
          logger.warn("failed to note credential expiry", {
            event: "credentials.expiry.note.failed", error: notifyErr,
          });
        }
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  #nextCounter(name: string): number {
    const key = `counter:${name}`;
    const value = (this.ctx.storage.kv.get<number>(key) ?? 0) + 1;
    this.ctx.storage.kv.put(key, value);
    return value;
  }

  // ---- helpers used by session impls (local, same-DO calls; non-generic, no token) ----

  nextProvisionalIssueId(): string {
    return `~${this.#nextCounter("provisional")}`;
  }

  nextProvisionalCommentId(): string {
    return `~comment:${this.#nextCounter("comment")}`;
  }

  /** The workspace url key (first path segment of linear.app URLs), used to build canonical URLs. */
  workspaceKey(): string {
    return this.ctx.props.workspaceUrlKey;
  }

  // -------------------------------------------------------------------------
  // Observer tracking (see addObserver/removeObserver). Only workspace bindings track state; team
  // and issue bindings are single ACL units verified up front, with nothing to log or exclude.

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedTeamKey(teamId: string): string { return `observedTeam:${teamId}`; }

  #isTeamObserved(teamId: string): boolean {
    const state = this.ctx.storage.kv.get<ObservedTeamState>(this.#observedTeamKey(teamId));
    return state === true || state === "observed";
  }

  #listTrackedTeams(): string[] {
    const prefix = "observedTeam:";
    return [...this.ctx.storage.kv.list<ObservedTeamState>({ prefix })]
      .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<LinearVerifierApi>]> {
    const prefix = "observer:";
    for (const [key, verifier] of this.ctx.storage.kv.list<Fetcher<LinearVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Workspace bindings only. Marks unknown teams pending and returns current observers who cannot
  // access any pending team in this attempt. Authorization promotes them; failed attempts remain
  // pending and are rechecked on retry.
  async #prepareTeamObservation(teamIds: string[]): Promise<TeamObservationCheck> {
    const pendingTeams = [...new Set(teamIds)].filter(id => !this.#isTeamObserved(id));
    if (pendingTeams.length === 0) return {pendingTeams, commit() {}};
    for (const teamId of pendingTeams) {
      const key = this.#observedTeamKey(teamId);
      if (this.ctx.storage.kv.get<ObservedTeamState>(key) === undefined) {
        this.ctx.storage.kv.put(key, "pending");
      }
    }
    const observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      const access = await Promise.all(pendingTeams.map(
        teamId => verifier.hasTeamAccess(this.ctx.props.workspaceUrlKey, teamId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    const excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingTeams,
      commit: () => {
        for (const teamId of pendingTeams) {
          this.ctx.storage.kv.put(this.#observedTeamKey(teamId), "observed");
        }
      },
    };
  }

  /**
   * Authorize an observation that reveals data belonging to specific team(s). For workspace bindings
   * this also tracks those teams as observed data sets and excludes any observers lacking access to a
   * newly-seen one; for team/issue bindings it is a plain authorizeObservation (the bound resource is
   * a single ACL unit verified up front). Every team-scoped read should go through this rather than
   * calling approvalQueue.authorizeObservation directly. `teamIds` may be empty for workspace-level
   * reads (org metadata, member directory) that any workspace member may see.
   */
  async authorizeTeamObservation(
    queue: RpcStub<ApprovalQueue>,
    teamIds: string[],
    description: ObservationDescription,
  ): Promise<void> {
    const check = this.ctx.props.resourceKind === "workspace" && teamIds.length > 0
      ? await this.#prepareTeamObservation(teamIds)
      : {pendingTeams: [], commit() {}};
    await queue.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  /**
   * Resolve an issue reference (real identifier/UUID, or provisional id) to the id usable against
   * Linear. Throws if a provisional issue's create has not actually been applied yet (used by
   * applyAction/revertAction, which must hit the real API).
   */
  resolveIssueRef(ref: string): string {
    if (!ref.startsWith("~")) return ref;
    const real = this.ctx.storage.kv.get<string>(`provisional:${ref}`);
    if (!real) {
      throw new Error(
        `Issue ${ref} has not been created on Linear yet — its create action has not been applied.`);
    }
    return real;
  }

  // Resolve a label id that may be a provisional `~label:` id (from a pending createLabel) to the
  // real label id its create produced. Returns the id unchanged if already real; undefined for a
  // provisional label whose create hasn't been applied yet.
  #resolveLabelId(id: string): string | undefined {
    if (!id.startsWith("~label:")) return id;
    return this.ctx.storage.kv.get<string>(`provisionalLabel:${id}`);
  }

  // Like #resolveLabelId, but throws if a provisional label hasn't been created yet (used by
  // applyAction, where the create must have been applied first).
  #requireLabelId(id: string): string {
    const real = this.#resolveLabelId(id);
    if (!real) {
      throw new Error(`Label ${id} has not been created on Linear yet — its create action has not been applied.`);
    }
    return real;
  }

  async enqueue(
    approvalQueue: RpcStub<ApprovalQueue>,
    action: StoredActionDraft,
    description: ActionDescriptionDraft,
  ): Promise<void> {
    const id = this.#nextCounter("action");
    this.ctx.storage.kv.put<StoredAction>(`action:${id}`, { ...action, id, status: "pending" } as StoredAction);
    this.#invalidatePendingActions();
    try {
      await approvalQueue.submitAction(id, description);
    } catch (err) {
      // An auto-approval can apply the action mid-flight, which proves the overseer received it --
      // only the reply was lost, and reporting failure would invite a repeated provider write. A
      // missing record proves nothing: a dependency's rejection cascade deletes it too. Any
      // non-pending status (applied, or claimed/failed by a racing approval's apply) proves the
      // same: the overseer holds the id, so leave its record to its own lifecycle.
      const current = this.ctx.storage.kv.get<StoredAction>(`action:${id}`);
      if (current && current.status !== "pending") return;
      if (current) {
        // Drop the record so simulated reads don't show an action no approver can resolve.
        this.ctx.storage.kv.delete(`action:${id}`);
        this.#invalidatePendingActions();
      }
      throw err;
    }
  }

  // ---- simulation: overlay pending (submitted-but-not-applied) actions onto reads ----

  // Memoized within a DO instance; invalidated by #invalidatePendingActions() whenever any action
  // record changes. Avoids re-scanning storage once per issue during a page overlay.
  #pendingActionsCache?: StoredAction[];

  #pendingActions(): StoredAction[] {
    if (!this.#pendingActionsCache) {
      this.#pendingActionsCache = [...this.ctx.storage.kv.list<StoredAction>({ prefix: "action:" })]
        .map(([, value]) => value)
        .filter(a => a.status === "pending" || a.status === "claimed")
        .toSorted((a, b) => a.id - b.id);
    }
    return this.#pendingActionsCache;
  }

  #invalidatePendingActions(): void {
    this.#pendingActionsCache = undefined;
  }

  // Real UUID for a provisional ref, if its create has been applied.
  #provisionalRealId(ref: string): string | undefined {
    return ref.startsWith("~") ? this.ctx.storage.kv.get<string>(`provisional:${ref}`) : ref;
  }

  // Does this action target the given issue? Matches on the issue's UUID, human identifier, or the
  // provisional ref it was created under.
  #actionTargetsIssue(actionRef: string, issue: RawIssue): boolean {
    if (actionRef === issue.id || actionRef === issue.identifier) return true;
    if (actionRef.startsWith("~")) {
      // Either the synthetic provisional issue itself, or a real issue this ref now resolves to.
      if (issue.id === actionRef) return true;
      const real = this.ctx.storage.kv.get<string>(`provisional:${actionRef}`);
      return real !== undefined && real === issue.id;
    }
    return false;
  }

  // Apply pending field/label edits for an issue to a copy. Does not consider archive state
  // (that's handled separately by #isPendingArchived, so direct reads still return the issue).
  #overlayIssue(issue: RawIssue): RawIssue {
    const result: RawIssue = { ...issue };
    let labels = [...(issue.labels?.nodes ?? [])];
    for (const action of this.#pendingActions()) {
      if (!("issueRef" in action) || !this.#actionTargetsIssue(action.issueRef, issue)) continue;
      switch (action.kind) {
        case "updateIssue": {
          const p = action.patch;
          if (p.title !== undefined) result.title = p.title;
          if (p.description !== undefined) result.description = p.description;
          if (p.priority !== undefined) result.priority = p.priority;
          if (p.dueDate !== undefined) result.dueDate = p.dueDate;
          if (p.state !== undefined) result.state = p.state;
          if (p.assignee !== undefined) result.assignee = p.assignee;
          if (p.project !== undefined) result.project = p.project;
          if (p.parent !== undefined) result.parent = p.parent;
          break;
        }
        case "addLabels": {
          const have = new Set(labels.map(l => l.id));
          labels = [...labels, ...action.labels.filter(l => !have.has(l.id))];
          break;
        }
        case "removeLabels": {
          const drop = new Set(action.labelIds);
          labels = labels.filter(l => !drop.has(l.id));
          break;
        }
      }
    }
    result.labels = { nodes: labels, pageInfo: { hasNextPage: false, endCursor: null } };
    return result;
  }

  // True if the most recent pending archive action for this issue archives it.
  #isPendingArchived(issue: RawIssue): boolean {
    let archived = false;
    let seen = false;
    for (const action of this.#pendingActions()) {
      if (action.kind === "archive" && this.#actionTargetsIssue(action.issueRef, issue)) {
        archived = action.archived;
        seen = true;
      }
    }
    return seen && archived;
  }

  // Synthetic issues for pending creates that haven't been applied, after overlaying any pending
  // edits queued against them. Optionally filtered to a team.
  #pendingCreatedIssues(teamId: string | null): RawIssue[] {
    const out: RawIssue[] = [];
    for (const action of this.#pendingActions()) {
      if (action.kind !== "createIssue" || action.createdIssueId) continue;
      if (teamId && action.synthetic.team.id !== teamId) continue;
      if (this.#isPendingArchived(action.synthetic)) continue;
      out.push(this.#overlayIssue(action.synthetic));
    }
    return out;
  }

  // Match pending comments to an issue by the exact ref used, by the resolved real id (so a
  // comment posted on a now-applied provisional issue still shows), or via #actionTargetsIssue
  // when the full issue is available.
  #pendingCommentsFor(issueRef: string, realId: string | undefined, issue: RawIssue | null): RawComment[] {
    const out: RawComment[] = [];
    for (const action of this.#pendingActions()) {
      if (action.kind !== "postComment") continue;
      const matches =
        action.issueRef === issueRef ||
        (realId !== undefined && this.#provisionalRealId(action.issueRef) === realId) ||
        (issue !== null && this.#actionTargetsIssue(action.issueRef, issue));
      if (matches) out.push(action.synthetic);
    }
    return out;
  }

  #pendingCreatedLabels(teamId: string): RawLabel[] {
    const out: RawLabel[] = [];
    for (const action of this.#pendingActions()) {
      if (action.kind === "createLabel" && !action.createdLabelId && action.teamId === teamId) {
        out.push(action.synthetic);
      }
    }
    return out;
  }

  // ---- concrete observation methods (return raw data; sessions normalize + authorize) ----

  async orgRaw(): Promise<RawOrganization> {
    return await this.#run(api => api.getOrganization());
  }

  async teamsPage(after: string | undefined, first: number, includeArchived: boolean): Promise<RawConnection<RawTeam>> {
    return await this.#run(api => api.listTeams({ first, after, includeArchived }));
  }

  async findTeamRaw(keyOrId: string): Promise<RawTeam> {
    const team = await this.#run(api => api.findTeam(keyOrId));
    if (!team) throw new Error(`Linear team not found: ${keyOrId}`);
    return team;
  }

  async projectsPage(teamId: string | null, after: string | undefined, first: number, includeArchived: boolean): Promise<RawConnection<RawProject>> {
    return await this.#run(api => api.listProjects(teamId ? { teamId } : {}, { first, after, includeArchived }));
  }

  // Overlay pending edits onto a fetched page, drop pending-archived issues, and (on the first
  // page) inject pending-created issues for this scope.
  #simulatePage(conn: RawConnection<RawIssue>, after: string | undefined, teamId: string | null,
                includeArchived: boolean | undefined, inject: boolean): RawConnection<RawIssue> {
    const nodes = conn.nodes
      .filter(n => includeArchived || !this.#isPendingArchived(n))
      .map(n => this.#overlayIssue(n));
    const injected = inject && after === undefined ? this.#pendingCreatedIssues(teamId) : [];
    return { nodes: [...injected, ...nodes], pageInfo: conn.pageInfo };
  }

  async issuesPage(args: IssuePageArgs, after: string | undefined, first: number): Promise<RawConnection<RawIssue>> {
    const { filter, orderBy } = buildIssueFilter(args);
    const conn = await this.#run(api => api.listIssues({ first, after, filter, orderBy, includeArchived: args.includeArchived }));
    return this.#simulatePage(conn, after, args.teamId ?? null, args.includeArchived, true);
  }

  async searchPage(term: string, args: IssuePageArgs, after: string | undefined, first: number): Promise<RawConnection<RawIssue>> {
    const { filter } = buildIssueFilter(args);
    const conn = await this.#run(api => api.searchIssues({ term, first, after, filter, includeArchived: args.includeArchived }));
    // No injection for search: synthetic issues can't be meaningfully matched against the query.
    return this.#simulatePage(conn, after, args.teamId ?? null, args.includeArchived, false);
  }

  async issueRaw(ref: string): Promise<RawIssue> {
    // A provisional issue whose create hasn't been applied: return its synthetic, overlaid copy.
    if (ref.startsWith("~") && !this.#provisionalRealId(ref)) {
      const create = this.#pendingActions().find(
        (a): a is Extract<StoredAction, { kind: "createIssue" }> =>
          a.kind === "createIssue" && a.provisionalId === ref);
      if (!create) throw new Error(`Linear issue not found: ${ref}`);
      return this.#overlayIssue(create.synthetic);
    }
    const issue = await this.#run(api => api.getIssue(this.resolveIssueRef(ref)));
    if (!issue) throw new Error(`Linear issue not found: ${ref}`);
    return this.#overlayIssue(issue);
  }

  /**
   * A page of the issue's comments, with pending comments appended after the last real page.
   * `issue`, when the caller has it, lets pending comments staged under the issue's UUID match a
   * `ref` that is its identifier (see #pendingCommentsFor).
   */
  async commentsPage(ref: string, after: string | undefined, first: number,
                     issue: RawIssue | null = null): Promise<RawConnection<RawComment>> {
    // A provisional issue whose create hasn't been applied: only pending comments exist.
    if (ref.startsWith("~") && !this.#provisionalRealId(ref)) {
      const nodes = after === undefined ? this.#pendingCommentsFor(ref, undefined, issue) : [];
      return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
    }
    const id = this.resolveIssueRef(ref);
    const conn = await this.#run(api => api.listComments(id, { first, after }));
    // Comments are oldest-first, so append pending comments once the real pages are exhausted.
    if (!conn.pageInfo.hasNextPage) {
      const pending = this.#pendingCommentsFor(ref, id, issue);
      if (pending.length > 0) return { nodes: [...conn.nodes, ...pending], pageInfo: conn.pageInfo };
    }
    return conn;
  }

  // Short-TTL cache in DO storage for rarely-changing team metadata that sits on hot paths
  // (setState/addLabels/createIssue each resolve these). Avoids redundant GraphQL calls.
  async #cachedFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.ctx.storage.kv.get<{ data: T; expiresAt: number }>(key);
    if (hit && Date.now() < hit.expiresAt) return hit.data;
    const data = await fetcher();
    this.ctx.storage.kv.put(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }

  async workflowStatesRaw(teamId: string): Promise<RawWorkflowState[]> {
    return await this.#cachedFetch(`cache:states:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listWorkflowStates(teamId)));
  }

  /** Real labels only — used internally to resolve label names to real ids. */
  async labelsRaw(teamId: string): Promise<RawLabel[]> {
    return await this.#cachedFetch(`cache:labels:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listLabels(teamId)));
  }

  /** Labels for display to the gadget: real labels plus pending-created ones. */
  async labelsForDisplay(teamId: string): Promise<RawLabel[]> {
    const real = await this.labelsRaw(teamId);
    return [...real, ...this.#pendingCreatedLabels(teamId)];
  }

  async cyclesPage(teamId: string, after: string | undefined, first: number): Promise<RawConnection<RawCycle>> {
    return await this.#run(api => api.listCycles(teamId, { first, after }));
  }

  async getProjectRaw(projectId: string): Promise<RawProject | null> {
    return await this.#run(api => api.getProject(projectId));
  }

  async teamMembersRaw(teamId: string): Promise<RawUser[]> {
    return await this.#cachedFetch(`cache:members:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listTeamMembers(teamId)));
  }

  async findMembersRaw(query: string | undefined): Promise<RawUser[]> {
    const filter = query
      ? { or: [
          { email: { containsIgnoreCase: query } },
          { displayName: { containsIgnoreCase: query } },
          { name: { containsIgnoreCase: query } },
        ] }
      : undefined;
    return await this.#run(api => api.listUsers({ first: 50, filter }));
  }

  /** Resolve an assignee string (email / display name / UUID) to a single member. */
  async resolveMemberRaw(query: string): Promise<RawUser> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query)) {
      const byId = await this.#run(api => api.listUsers({ first: 1, filter: { id: { eq: query } } }));
      if (byId[0]) return byId[0];
    }
    const users = await this.#run(api => api.listUsers({
      first: 10,
      filter: { or: [
        { email: { eqIgnoreCase: query } },
        { displayName: { eqIgnoreCase: query } },
        { name: { eqIgnoreCase: query } },
      ] },
    }));
    if (users.length === 0) throw new Error(`No workspace member matches "${query}".`);
    if (users.length > 1) {
      throw new Error(`"${query}" matches multiple members; use an email or UUID to disambiguate.`);
    }
    return users[0];
  }

  // ---- Gatekeeper interface ----

  async describe(): Promise<ResourceDescription> {
    const kind = this.ctx.props.resourceKind;
    const workspace = this.ctx.props.workspaceUrlKey;

    if (kind === "team") {
      const teamKeyOrId = this.ctx.props.teamKeyOrId!;
      const team = await this.#run(api => api.findTeam(teamKeyOrId));
      return {
        url: `https://linear.app/${workspace}/team/${team?.key ?? teamKeyOrId}`,
        title: team ? `${team.key} · ${team.name}` : `Linear team ${teamKeyOrId}`,
        snippet: snippet(team?.description, "Linear team"),
        suggestedBindingName: "LINEAR_TEAM",
        tsType: "LinearTeam",
      };
    }

    if (kind === "issue") {
      const issueRef = this.ctx.props.issueRef!;
      const issue = await this.#run(api => api.getIssue(issueRef));
      return {
        url: issue?.url ?? `https://linear.app/${workspace}/issue/${issueRef}`,
        title: issue ? `${issue.identifier} ${issue.title}` : `Linear issue ${issueRef}`,
        snippet: snippet(issue?.description, "Linear issue"),
        suggestedBindingName: "LINEAR_ISSUE",
        tsType: "LinearIssue",
      };
    }

    const org = await this.#run(api => api.getOrganization());
    return {
      url: `https://linear.app/${org.urlKey}`,
      title: `${org.name} (Linear)`,
      snippet: "Linear workspace",
      suggestedBindingName: "LINEAR_WORKSPACE",
      tsType: "LinearWorkspace",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<LinearWorkspace | LinearTeam | LinearIssue> {
    switch (this.ctx.props.resourceKind) {
      case "team":
        return new LinearTeamSessionImpl(this, approvalQueue.dup(), this.ctx.props.teamKeyOrId!);
      case "issue":
        return new LinearIssueImpl(this, approvalQueue.dup(), this.ctx.props.issueRef!);
      default:
        return new LinearWorkspaceSessionImpl(this, approvalQueue.dup());
    }
  }

  /**
   * Observer tracking. Strategy depends on the binding's granularity:
   *
   * - Team / Issue binding — "ACL check (single unit)". The binding is one team (or one issue, which
   *   inherits its team's ACL), so we just confirm the observer can see it (hasTeamAccess /
   *   hasIssueAccess, against their own token, honoring team privacy). Nothing read later could be
   *   outside that unit, so no observers are tracked and removeObserver is a no-op.
   *
   * - Workspace binding — "data-set tracking (by team)". Workspace members may belong to different
   *   teams, so we track which teams' data the Gadget has actually observed and verify each observer
   *   against them. addObserver requires workspace membership (so workspace-level metadata and the
   *   member directory are fine to show) plus access to every already-observed team; later, the first
   *   observation of a *new* team excludes any observer lacking it (see #prepareTeamObservation). Verified
   *   observers are remembered (their verifier stored) so that forward-exclusion check can run.
   *
   * The overseer re-runs addObserver on every open, catching loss of access promptly.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<LinearVerifierApi>;
    const ws = this.ctx.props.workspaceUrlKey;

    if (this.ctx.props.resourceKind === "team") {
      const teamKeyOrId = this.ctx.props.teamKeyOrId!;
      if (!(await verifier.hasTeamAccess(ws, teamKeyOrId))) {
        throw new Error(
          `This collaborator does not have access to the Linear team \`${teamKeyOrId}\`, so they ` +
          `cannot be allowed to observe data this workspace read from it.`);
      }
      return;
    }

    if (this.ctx.props.resourceKind === "issue") {
      const issueRef = this.ctx.props.issueRef!;
      if (!(await verifier.hasIssueAccess(ws, issueRef))) {
        throw new Error(
          `This collaborator does not have access to the Linear issue \`${issueRef}\`, so they ` +
          `cannot be allowed to observe data this workspace read from it.`);
      }
      return;
    }

    // Workspace binding.
    if (!(await verifier.hasWorkspaceAccess(ws))) {
      throw new Error(
        `This collaborator is not a member of the Linear workspace \`${ws}\`, so they cannot be ` +
        `allowed to observe it.`);
    }
    const checked = new Set<string>();
    while (true) {
      const teamIds = this.#listTrackedTeams().filter(teamId => !checked.has(teamId));
      if (teamIds.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      const teamAccess = await Promise.all(
        teamIds.map(teamId => verifier.hasTeamAccess(ws, teamId)));
      if (teamAccess.some(hasAccess => !hasAccess)) {
        throw new Error(
          `This collaborator does not have access to a Linear team whose data this workspace has read, ` +
          `so they cannot be allowed to observe it.`);
      }
      for (const teamId of teamIds) checked.add(teamId);
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }

  async applyAction(actionId: number): Promise<void> {
    const store = this.#actionStore();
    await applyClaimedAction(store, actionId, async action => {
      await this.#run(async api => {
        switch (action.kind) {
          case "createIssue": {
            // A parent that was itself a pending create may now be real — resolve its provisional id.
            if (action.input.parentId) action.input.parentId = this.resolveIssueRef(action.input.parentId);
            // Resolve any provisional `~label:` ids (labels created earlier in the batch).
            if (action.input.labelIds) action.input.labelIds = action.input.labelIds.map(id => this.#requireLabelId(id));
            const issue = await api.createIssue(action.input);
            action.createdIssueId = issue.id;
            store.putAction(action);
            this.ctx.storage.kv.put<string>(`provisional:${action.provisionalId}`, issue.id);
            break;
          }
          case "updateIssue": {
            // Resolve a provisional parent id (set via setParent against a pending-created issue).
            if (action.input.parentId) action.input.parentId = this.resolveIssueRef(action.input.parentId);
            await api.updateIssue(this.resolveIssueRef(action.issueRef), action.input);
            break;
          }
          case "addLabels": {
            const issue = await api.getIssue(this.resolveIssueRef(action.issueRef));
            if (!issue) break;
            // Resolve any provisional `~label:` ids to the real labels their create actions produced.
            const add = action.labelIds.map(id => this.#requireLabelId(id));
            const current = (issue.labels?.nodes ?? []).map(l => l.id);
            await api.updateIssue(issue.id, { labelIds: [...new Set([...current, ...add])] });
            break;
          }
          case "removeLabels": {
            const issue = await api.getIssue(this.resolveIssueRef(action.issueRef));
            if (!issue) break;
            // Skip unresolved provisional labels: they were never really attached, so nothing to remove.
            const remove = new Set(action.labelIds.map(id => this.#resolveLabelId(id)).filter((id): id is string => !!id));
            const next = (issue.labels?.nodes ?? []).map(l => l.id).filter(id => !remove.has(id));
            await api.updateIssue(issue.id, { labelIds: next });
            break;
          }
          case "postComment": {
            const comment = await api.createComment(this.resolveIssueRef(action.issueRef), action.body);
            action.createdCommentId = comment.id;
            store.putAction(action);
            break;
          }
          case "createLabel": {
            const label = await api.createLabel({
              teamId: action.teamId, name: action.name, color: action.color, description: action.description,
            });
            action.createdLabelId = label.id;
            store.putAction(action);
            // Map the provisional label id to the real one, so dependent addLabels can resolve it.
            this.ctx.storage.kv.put<string>(`provisionalLabel:${action.synthetic.id}`, label.id);
            // The team's real label set changed; drop the cache so the new label shows promptly.
            this.ctx.storage.kv.delete(`cache:labels:${action.teamId}`);
            break;
          }
          case "archive":
            await api.setIssueArchived(this.resolveIssueRef(action.issueRef), action.archived);
            break;
        }
      });
      // Mark applied and keep the record (so revert can find it). The change is now real, so the
      // simulation overlay (which considers pending and claimed actions) stops applying it.
      action.state = "applied";
      store.putAction(action);
    }, isLinearOutcomeUnknown);
  }

  /**
   * The Linear action records as the kit's claim loop drives them: `applyClaimedAction` speaks
   * `state`, these rows speak `status`, and this adapter is the whole translation.
   */
  #actionStore(): ClaimedActionStore<StoredAction & { state: ActionStatus }> {
    return {
      getAction: id => {
        const action = this.ctx.storage.kv.get<StoredAction>(`action:${id}`);
        return action === undefined ? undefined : { ...action, state: action.status };
      },
      putAction: record => {
        const { state, ...action } = record;
        this.ctx.storage.kv.put<StoredAction>(`action:${action.id}`, { ...action, status: state });
        this.#invalidatePendingActions();
      },
    };
  }

  // Recursively drop every pending action that depends on a rejected provisional issue: edits and
  // comments targeting it (issueRef), and sub-issues / re-parents pointing at it (input.parentId).
  // Sub-issues are themselves creates, so recurse into their provisional ids.
  #cascadeRejectProvisional(provisionalId: string): void {
    this.#invalidatePendingActions();
    this.ctx.storage.kv.delete(`provisional:${provisionalId}`);
    for (const dep of this.#pendingActions()) {
      const targetsRef = "issueRef" in dep && dep.issueRef === provisionalId;
      const targetsParent =
        (dep.kind === "createIssue" || dep.kind === "updateIssue") && dep.input.parentId === provisionalId;
      if (!targetsRef && !targetsParent) continue;
      this.ctx.storage.kv.delete(`action:${dep.id}`);
      if (dep.kind === "createIssue") this.#cascadeRejectProvisional(dep.provisionalId);
    }
    this.#invalidatePendingActions();
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const action = this.ctx.storage.kv.get<StoredAction>(`action:${actionId}`);
    if (!action) return;
    // Undoing an applied action is `revertAction`'s job; a stray reject must not report an
    // effect that landed as discarded.
    if (action.status === "applied") throw new Error(`Linear action ${actionId} is no longer pending.`);
    // A claim left behind means a dispatched write whose outcome is unknown: settle it terminally
    // and say so, never silently discard a write that may have reached Linear.
    if (action.status === "claimed") throw markOutcomeUnknown(this.#actionStore(), { ...action, state: "claimed" });
    // Rejecting a terminal failure is the user clearing the settled record: its write already
    // concluded, so there is nothing to cascade and nothing to restart.
    if (action.status === "failed") {
      this.ctx.storage.kv.delete(`action:${actionId}`);
      this.#invalidatePendingActions();
      return;
    }
    this.ctx.storage.kv.delete(`action:${actionId}`);
    this.#invalidatePendingActions();

    // Rejecting a create invalidates every action queued against its provisional id, which can
    // never be applied. Drop them all and ask the Overseer to restart the gadget.
    if (action.kind === "createIssue") {
      this.#cascadeRejectProvisional(action.provisionalId);
      return { restart: true };
    }

    // Rejecting a label create invalidates any pending addLabels/removeLabels that referenced its
    // provisional id (they could never resolve to a real label). Drop them. No restart needed —
    // createLabel returns no handle the gadget holds.
    if (action.kind === "createLabel") {
      const provisionalLabelId = action.synthetic.id;
      for (const dep of this.#pendingActions()) {
        if ((dep.kind === "addLabels" || dep.kind === "removeLabels") &&
            dep.labelIds.includes(provisionalLabelId)) {
          this.ctx.storage.kv.delete(`action:${dep.id}`);
        }
      }
      this.#invalidatePendingActions();
    }
  }

  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const action = this.ctx.storage.kv.get<StoredAction>(`action:${actionId}`);
    if (!action) throw new Error(`Unknown action: ${actionId}`);

    await this.#run(async api => {
      switch (action.kind) {
        case "createIssue":
          if (action.createdIssueId) {
            await api.deleteIssue(action.createdIssueId);
            this.ctx.storage.kv.delete(`provisional:${action.provisionalId}`);
          }
          break;
        case "updateIssue":
          await api.updateIssue(this.resolveIssueRef(action.issueRef), action.previous);
          break;
        case "addLabels": {
          // Remove the labels we added (only those still present).
          const issue = await api.getIssue(this.resolveIssueRef(action.issueRef));
          if (!issue) break;
          const added = new Set(action.labelIds.map(id => this.#resolveLabelId(id)).filter((id): id is string => !!id));
          const next = (issue.labels?.nodes ?? []).map(l => l.id).filter(id => !added.has(id));
          await api.updateIssue(issue.id, { labelIds: next });
          break;
        }
        case "removeLabels": {
          // Re-add the labels we removed.
          const issue = await api.getIssue(this.resolveIssueRef(action.issueRef));
          if (!issue) break;
          const restore = action.labelIds.map(id => this.#resolveLabelId(id)).filter((id): id is string => !!id);
          const current = (issue.labels?.nodes ?? []).map(l => l.id);
          await api.updateIssue(issue.id, { labelIds: [...new Set([...current, ...restore])] });
          break;
        }
        case "postComment":
          if (action.createdCommentId) await api.deleteComment(action.createdCommentId);
          break;
        case "createLabel":
          if (action.createdLabelId) await api.deleteLabel(action.createdLabelId);
          break;
        case "archive":
          await api.setIssueArchived(this.resolveIssueRef(action.issueRef), !action.archived);
          break;
      }
    });

    // The action has been undone; drop its record so it can't be reverted twice. (Reverting an
    // applied action doesn't affect the pending set, but keep the cache honest regardless.)
    this.ctx.storage.kv.delete(`action:${actionId}`);
    this.#invalidatePendingActions();
  }
}
