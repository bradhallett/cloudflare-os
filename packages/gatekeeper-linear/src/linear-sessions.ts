// The RPC sessions agents and gadgets talk to: one per bound resource kind (workspace, team,
// issue). Reads page through the gatekeeper's raw data, normalize it, and authorize each
// observation; writes queue actions for approval and read back the world as if they had landed.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import {
  type ActionDescriptionBuilder, buildDescription, plainInline, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import type {
  IssueCreateInput,
  RawComment,
  RawCycle,
  RawIssue,
  RawLabel,
  RawProject,
  RawTeam,
  RawUser,
  RawWorkflowState,
} from "./linear-api";
import { StreamingCursor, disposeStub } from "./linear-cursors";
import type { LinearGatekeeperImpl } from "./linear-gatekeeper";
import {
  PRIORITY_TO_NUM,
  type IssuePageArgs,
  normComment,
  normCycle,
  normState,
  normIssueDetails,
  normIssueSummary,
  normLabel,
  normProjectSummary,
  normTeamSummary,
  normUser,
} from "./linear-normalize";
import type {
  LinearComment,
  LinearCreateIssueOptions,
  LinearCreateLabelOptions,
  LinearCycleSummary,
  LinearIssue,
  LinearIssueDetails,
  LinearIssueFilter,
  LinearIssueSearch,
  LinearIssueSummary,
  LinearLabel,
  LinearPageOptions,
  LinearPriority,
  LinearProjectSummary,
  LinearTeam,
  LinearTeamMetadata,
  LinearTeamSummary,
  LinearUser,
  LinearWorkflowState,
  LinearWorkspace,
  LinearWorkspaceMetadata,
} from "./types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

function clampPageSize(size?: number): number {
  if (!size || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Session: Workspace

@validateRpc()
export class LinearWorkspaceSessionImpl extends RpcTarget implements LinearWorkspace {
  #gk: LinearGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;
  #wsKey: string;

  constructor(gk: LinearGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
    this.#wsKey = gk.workspaceKey();
  }

  [Symbol.dispose](): void {
    disposeStub(this.#queue);
  }

  async getMetadata(): Promise<LinearWorkspaceMetadata> {
    const org = await this.#gk.orgRaw();
    // Workspace-level metadata is visible to any workspace member, so no team attribution is needed.
    await this.#gk.authorizeTeamObservation(this.#queue, [], {
      title: "Read workspace info",
      description: `Read metadata for the Linear workspace **${org.name}**.`,
    });
    return { id: org.id, name: org.name, urlKey: org.urlKey, url: `https://linear.app/${org.urlKey}` };
  }

  async listTeams(options?: LinearPageOptions): Promise<Cursor<LinearTeamSummary>> {
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawTeam, LinearTeamSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.teamsPage(after, first, options?.includeArchived ?? false),
      raw => normTeamSummary(raw, this.#wsKey),
      items => ({ title: "List teams", description: `Listed ${items.length} team(s) in the workspace.` }),
      // Each listed team is itself a data set whose existence/metadata (incl. private teams) the
      // observer must be allowed to see.
      teams => teams.map(t => t.id),
    );
  }

  async getTeam(teamKeyOrId: string): Promise<LinearTeam> {
    return new LinearTeamSessionImpl(this.#gk, this.#queue.dup(), teamKeyOrId);
  }

  async listProjects(options?: LinearPageOptions): Promise<Cursor<LinearProjectSummary>> {
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawProject, LinearProjectSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.projectsPage(null, after, first, options?.includeArchived ?? false),
      normProjectSummary,
      items => ({ title: "List projects", description: `Listed ${items.length} project(s) in the workspace.` }),
      // A project's access is gated by the team(s) it belongs to (populated by the workspace-wide
      // query via PROJECT_LIST_FIELDS), so attribute the listing to all of them.
      projects => projects.flatMap(p => (p.teams?.nodes ?? []).map(t => t.id)),
    );
  }

  async listIssues(filter?: LinearIssueFilter): Promise<Cursor<LinearIssueSummary>> {
    const first = clampPageSize(filter?.resultsPerPage);
    const args = issueArgs(filter);
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.issuesPage(args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "List issues", description: `Listed ${items.length} issue(s) across the workspace.` }),
      issues => issues.map(i => i.team.id),
    );
  }

  async searchIssues(query: LinearIssueSearch): Promise<Cursor<LinearIssueSummary>> {
    const first = clampPageSize(query.resultsPerPage);
    const args = issueArgs(query);
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.searchPage(query.text, args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "Search issues", description: `Searched workspace issues for "${query.text}" (${items.length} result(s)).` }),
      issues => issues.map(i => i.team.id),
    );
  }

  async getIssue(id: string): Promise<LinearIssue> {
    return new LinearIssueImpl(this.#gk, this.#queue.dup(), id);
  }

  async createIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    return await createIssueViaQueue(this.#gk, this.#queue, options, { requireTeam: true });
  }

  async findMembers(query?: string): Promise<LinearUser[]> {
    const users = await this.#gk.findMembersRaw(query);
    // The workspace member directory is visible to any workspace member, so no team attribution.
    await this.#gk.authorizeTeamObservation(this.#queue, [], {
      title: "Find members",
      description: `Looked up ${users.length} workspace member(s)${query ? ` matching "${query}"` : ""}.`,
    });
    return users.map(u => normUser(u)!).filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Session: Team

@validateRpc()
export class LinearTeamSessionImpl extends RpcTarget implements LinearTeam {
  #gk: LinearGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;
  #teamKeyOrId: string;
  #wsKey: string;
  #teamPromise?: Promise<RawTeam>;

  constructor(gk: LinearGatekeeperImpl, queue: RpcStub<ApprovalQueue>, teamKeyOrId: string) {
    super();
    this.#gk = gk;
    this.#queue = queue;
    this.#teamKeyOrId = teamKeyOrId;
    this.#wsKey = gk.workspaceKey();
  }

  [Symbol.dispose](): void {
    disposeStub(this.#queue);
  }

  #team(): Promise<RawTeam> {
    if (!this.#teamPromise) {
      this.#teamPromise = this.#gk.findTeamRaw(this.#teamKeyOrId).catch(err => {
        this.#teamPromise = undefined;
        throw err;
      });
    }
    return this.#teamPromise;
  }

  async getMetadata(): Promise<LinearTeamMetadata> {
    const team = await this.#team();
    await this.#gk.authorizeTeamObservation(this.#queue, [team.id], {
      title: "Read team info",
      description: `Read metadata for team **${team.key} · ${team.name}**.`,
    });
    return normTeamSummary(team, this.#wsKey);
  }

  async listIssues(filter?: LinearIssueFilter): Promise<Cursor<LinearIssueSummary>> {
    const team = await this.#team();
    const first = clampPageSize(filter?.resultsPerPage);
    const args = { ...issueArgs(filter), teamId: team.id };
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.issuesPage(args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "List team issues", description: `Listed ${items.length} issue(s) in team ${team.key}.` }),
      () => [team.id],
    );
  }

  async searchIssues(query: LinearIssueSearch): Promise<Cursor<LinearIssueSummary>> {
    const team = await this.#team();
    const first = clampPageSize(query.resultsPerPage);
    const args = { ...issueArgs(query), teamId: team.id };
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.searchPage(query.text, args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "Search team issues", description: `Searched team ${team.key} for "${query.text}" (${items.length} result(s)).` }),
      () => [team.id],
    );
  }

  async getIssue(id: string): Promise<LinearIssue> {
    const team = await this.#team();
    return new LinearIssueImpl(this.#gk, this.#queue.dup(), id, team.id);
  }

  async createIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    const team = await this.#team();
    return await createIssueViaQueue(this.#gk, this.#queue, { ...options, teamId: team.id }, { requireTeam: false }, team.id);
  }

  async listWorkflowStates(): Promise<LinearWorkflowState[]> {
    const team = await this.#team();
    const states = await this.#gk.workflowStatesRaw(team.id);
    await this.#gk.authorizeTeamObservation(this.#queue, [team.id], {
      title: "List workflow states",
      description: `Listed ${states.length} workflow state(s) for team ${team.key}.`,
    });
    return states.map(normState).toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  async listLabels(): Promise<LinearLabel[]> {
    const team = await this.#team();
    const labels = await this.#gk.labelsForDisplay(team.id);
    await this.#gk.authorizeTeamObservation(this.#queue, [team.id], {
      title: "List labels",
      description: `Listed ${labels.length} label(s) for team ${team.key}.`,
    });
    return labels.map(normLabel);
  }

  async createLabel(name: string, options?: LinearCreateLabelOptions): Promise<LinearLabel> {
    const team = await this.#team();
    // Check real labels and any pending-created ones, so two creates can't collide on the same
    // name (which would also collide on the `~label:<name>` provisional id).
    const existing = await this.#gk.labelsForDisplay(team.id);
    // The duplicate check and the description reveal this team, so on a workspace binding the log
    // must only reach observers who may see it. Authorized after the read, as in listLabels, so a
    // failed read records nothing.
    await this.#gk.authorizeTeamObservation(this.#queue, [team.id], {
      title: "Read team for new label",
      description: `Read team ${team.key} and its labels to create a label.`,
    });
    if (existing.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A label named "${name}" already exists in team ${team.key}.`);
    }
    const synthetic: RawLabel = { id: `~label:${name}`, name, color: options?.color ?? null };
    await this.#gk.enqueue(this.#queue, {
      kind: "createLabel", teamId: team.id, name, color: options?.color, description: options?.description,
      synthetic, title: `Create label "${name}"`,
      presentation: {
        title: `Create label "${name}" in ${team.key}`,
        ...describeCreateLabel(team, name, options),
        implementsRevert: true,
      },
    });
    // Pending approval — return the same provisional descriptor that listLabels will show.
    return normLabel(synthetic);
  }

  async listProjects(options?: LinearPageOptions): Promise<Cursor<LinearProjectSummary>> {
    const team = await this.#team();
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawProject, LinearProjectSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.projectsPage(team.id, after, first, options?.includeArchived ?? false),
      normProjectSummary,
      items => ({ title: "List team projects", description: `Listed ${items.length} project(s) for team ${team.key}.` }),
      // Team-scoped listing: the projects are reached through this team, so attribute to it.
      () => [team.id],
    );
  }

  async listCycles(options?: LinearPageOptions): Promise<Cursor<LinearCycleSummary>> {
    const team = await this.#team();
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawCycle, LinearCycleSummary>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.cyclesPage(team.id, after, first),
      normCycle,
      items => ({ title: "List cycles", description: `Listed ${items.length} cycle(s) for team ${team.key}.` }),
      () => [team.id],
    );
  }

  async listMembers(): Promise<LinearUser[]> {
    const team = await this.#team();
    const members = await this.#gk.teamMembersRaw(team.id);
    await this.#gk.authorizeTeamObservation(this.#queue, [team.id], {
      title: "List team members",
      description: `Listed ${members.length} member(s) of team ${team.key}.`,
    });
    return members.map(m => normUser(m)!).filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Session: Issue

@validateRpc()
export class LinearIssueImpl extends RpcTarget implements LinearIssue {
  #gk: LinearGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;
  #ref: string;
  #wsKey: string;
  // When set, this handle is limited to issues in this team (a team-scoped grant). Prevents a
  // team grant from reaching issues in other teams via getIssue / setParent.
  #teamScope?: string;

  constructor(gk: LinearGatekeeperImpl, queue: RpcStub<ApprovalQueue>, ref: string, teamScope?: string) {
    super();
    this.#gk = gk;
    this.#queue = queue;
    this.#ref = ref;
    this.#wsKey = gk.workspaceKey();
    this.#teamScope = teamScope;
  }

  [Symbol.dispose](): void {
    disposeStub(this.#queue);
  }

  // Fetch this issue, enforcing the team scope (if any) so a team grant can't reach other teams.
  // Methods that enqueue an action use #requireIssueForAction, which also authorizes the team.
  // Actions stage the returned issue's `id` as their issueRef: the UUID of a real issue, or the
  // `~N` provisional ID of one whose create is still pending, which keeps them tied to that create.
  async #requireIssue(): Promise<RawIssue> {
    const issue = await this.#gk.issueRaw(this.#ref);
    if (this.#teamScope && issue.team.id !== this.#teamScope) {
      throw new Error(`Issue ${issue.identifier} is not in the team this connection is limited to.`);
    }
    return issue;
  }

  // #requireIssue for a method that enqueues an action. The description shows the issue's IDs,
  // title, state, labels and assignee, so on a workspace binding the log must only reach observers
  // who may see the issue's team (and `extraTeamIds`, such as a new parent's team).
  async #requireIssueForAction(extraTeamIds: string[] = []): Promise<RawIssue> {
    const issue = await this.#requireIssue();
    await this.#gk.authorizeTeamObservation(this.#queue, [...new Set([issue.team.id, ...extraTeamIds])], {
      title: `Read issue ${issue.identifier}`,
      description: `Read issue ${issueLabel(issue)} to describe an action on it.`,
    });
    return issue;
  }

  async getDetails(): Promise<LinearIssueDetails> {
    const issue = await this.#requireIssue();
    await this.#gk.authorizeTeamObservation(this.#queue, [issue.team.id], {
      title: `Read issue ${issue.identifier}`,
      description: `Read details of issue ${issueLabel(issue)}.`,
    });
    return normIssueDetails(issue, this.#wsKey);
  }

  async setTitle(title: string): Promise<void> {
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { title },
      previous: { title: issue.title }, patch: { title },
      title: `Set title of ${issue.identifier}`,
      presentation: {
        title: `Rename ${issue.identifier}`,
        ...onIssue(issue, label => `Change the title of ${label}.`)
          .inline("Current title", issue.title)
          .inline("New title", title)
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async setDescription(descriptionMarkdown: string): Promise<void> {
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { description: descriptionMarkdown },
      previous: { description: issue.description ?? "" }, patch: { description: descriptionMarkdown },
      title: `Edit description of ${issue.identifier}`,
      presentation: {
        title: `Edit description of ${issue.identifier}`,
        ...onIssue(issue, label => `Replace the description of ${label}.`)
          .verbatim("New description", descriptionMarkdown, "markdown")
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async setState(state: string): Promise<void> {
    const issue = await this.#requireIssueForAction();
    const states = await this.#gk.workflowStatesRaw(issue.team.id);
    const target = states.find(s => s.name.toLowerCase() === state.toLowerCase());
    if (!target) {
      throw new Error(`No workflow state named "${state}" in team ${issue.team.key}.`);
    }
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { stateId: target.id },
      previous: { stateId: issue.state?.id }, patch: { state: target },
      title: `Move ${issue.identifier} to ${target.name}`,
      presentation: {
        title: `Move ${issue.identifier} to ${target.name}`,
        ...onIssue(issue, label => `Change the state of ${label}.`)
          .inline("Current state", issue.state?.name ?? "Unknown")
          .inline("New state", target.name)
          .inline("New state ID", target.id)
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async setAssignee(assignee: string | null): Promise<void> {
    const issue = await this.#requireIssueForAction();
    let assigneeId: string | null = null;
    let assigneeUser: RawUser | null = null;
    let label = "Unassign";
    if (assignee !== null) {
      assigneeUser = await this.#gk.resolveMemberRaw(assignee);
      assigneeId = assigneeUser.id;
      label = `Assign to ${plainInline(assigneeUser.displayName ?? assigneeUser.name)}`;
    }
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { assigneeId },
      previous: { assigneeId: issue.assignee?.id ?? null }, patch: { assignee: assigneeUser },
      title: `${label} (${issue.identifier})`,
      presentation: {
        title: `${label}: ${issue.identifier}`,
        ...(assigneeUser
          ? describeAssignee(onIssue(issue, name => `Assign issue ${name}.`), assigneeUser)
          : onIssue(issue, name => `Unassign issue ${name}.`)).finish(),
        implementsRevert: true,
      },
    });
  }
  async setPriority(priority: LinearPriority): Promise<void> {
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { priority: PRIORITY_TO_NUM[priority] },
      previous: { priority: issue.priority }, patch: { priority: PRIORITY_TO_NUM[priority] },
      title: `Set priority of ${issue.identifier}`,
      presentation: {
        title: `Set priority of ${issue.identifier} to ${priority}`,
        ...onIssue(issue, label => `Change the priority of ${label}.`)
          .inline("Priority", priority)
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async addLabels(labels: string[]): Promise<void> {
    const issue = await this.#requireIssueForAction();
    // Resolve against real labels *and* labels created earlier in this session that haven't been
    // applied yet — those are attachable too (their ids resolve to the real label at apply time).
    const teamLabels = await this.#gk.labelsForDisplay(issue.team.id);
    const byName = new Map(teamLabels.map(l => [l.name.toLowerCase(), l]));
    const resolved: RawLabel[] = [];
    for (const name of labels) {
      const found = byName.get(name.toLowerCase());
      if (!found) {
        throw new Error(
          `No label named "${name}" exists in team ${issue.team.key}. ` +
          `Create it with createLabel() first.`);
      }
      resolved.push(found);
    }
    await this.#gk.enqueue(this.#queue, {
      kind: "addLabels", issueRef: issue.id, labelIds: resolved.map(l => l.id), labels: resolved,
      title: `Add labels to ${issue.identifier}`,
      presentation: {
        title: `Add labels to ${issue.identifier}`,
        ...describeLabels(onIssue(issue, label => `Add labels to ${label}.`), resolved)
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async removeLabels(labels: string[]): Promise<void> {
    const issue = await this.#requireIssueForAction();
    const removeNames = new Set(labels.map(l => l.toLowerCase()));
    // Map the requested names to the label ids currently on the issue; ignore names not present.
    const removed = (issue.labels?.nodes ?? []).filter(l => removeNames.has(l.name.toLowerCase()));
    const removeIds = removed.map(l => l.id);
    await this.#gk.enqueue(this.#queue, {
      kind: "removeLabels", issueRef: issue.id, labelIds: removeIds,
      title: `Remove labels from ${issue.identifier}`,
      presentation: {
        title: `Remove labels from ${issue.identifier}`,
        ...(removed.length > 0
          ? describeLabels(onIssue(issue, label => `Remove labels from ${label}.`), removed)
          : onIssue(issue, label =>
            `Remove labels from ${label}. None of the named labels is on this issue, so its labels stay as they are.`))
          .finish(),
        implementsRevert: true,
      },
    });
  }
  async setProject(projectId: string | null): Promise<void> {
    // An empty id means no project, as the description says.
    projectId = projectId || null;
    const issue = await this.#requireIssueForAction();
    const project = projectId ? await this.#gk.getProjectRaw(projectId) : null;
    if (projectId && !project) throw new Error(`Project not found: ${projectId}`);
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { projectId },
      previous: { projectId: issue.project?.id ?? null }, patch: { project },
      title: `Set project of ${issue.identifier}`,
      presentation: {
        title: `${projectId ? "Move" : "Remove"} ${issue.identifier} ${projectId ? "into a project" : "from its project"}`,
        ...(projectId
          ? onIssue(issue, label => `Move ${label} into a project.`)
            .inline("Project ID", projectId).finish()
          : onIssue(issue, label => `Remove ${label} from its project.`)
            .finish()),
        implementsRevert: true,
      },
    });
  }

  async setDueDate(date: string | null): Promise<void> {
    // An empty date clears it, as the description says.
    date = date || null;
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { dueDate: date },
      previous: { dueDate: issue.dueDate ?? null }, patch: { dueDate: date },
      title: `Set due date of ${issue.identifier}`,
      presentation: {
        title: `Set due date of ${issue.identifier}`,
        ...(date
          ? onIssue(issue, label => `Set the due date of ${label}.`)
            .inline("Due date", date).finish()
          : onIssue(issue, label => `Clear the due date of ${label}.`)
            .finish()),
        implementsRevert: true,
      },
    });
  }

  async setParent(parentId: string | null): Promise<void> {
    let resolvedParentId: string | null = null;
    let parentOverlay: NonNullable<RawIssue["parent"]> | null = null;
    const parentTeamIds: string[] = [];
    if (parentId !== null) {
      const parent = await this.#gk.issueRaw(parentId);
      if (this.#teamScope && parent.team.id !== this.#teamScope) {
        throw new Error(`Parent issue ${parent.identifier} is not in the team this connection is limited to.`);
      }
      resolvedParentId = parent.id;
      parentOverlay = { id: parent.id, identifier: parent.identifier, url: parent.url, title: parent.title };
      parentTeamIds.push(parent.team.id);
    }
    const issue = await this.#requireIssueForAction(parentTeamIds);
    await this.#gk.enqueue(this.#queue, {
      kind: "updateIssue", issueRef: issue.id, input: { parentId: resolvedParentId },
      previous: { parentId: issue.parent?.id ?? null }, patch: { parent: parentOverlay },
      title: `Set parent of ${issue.identifier}`,
      presentation: {
        title: `${parentId ? "Set" : "Clear"} parent of ${issue.identifier}`,
        ...(parentOverlay
          ? describeParent(onIssue(issue, label => `Make ${label} a sub-issue.`), parentOverlay).finish()
          : onIssue(issue, label => `Detach ${label} from its parent.`)
            .finish()),
        implementsRevert: true,
      },
    });
  }

  async readComments(options?: LinearPageOptions): Promise<Cursor<LinearComment>> {
    // Resolve the issue (also enforcing team scope, if any) so the comment thread can be attributed
    // to the issue's team for observer tracking.
    const issue = await this.#requireIssue();
    const teamId = issue.team.id;
    const ref = this.#ref;
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawComment, LinearComment>(
      this.#gk,
      this.#queue.dup(),
      after => this.#gk.commentsPage(ref, after, first, issue),
      normComment,
      items => ({ title: `Read comments on ${ref}`, description: `Read ${items.length} comment(s) on issue ${ref}.` }),
      () => [teamId],
    );
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const issue = await this.#requireIssueForAction();
    const synthetic: RawComment = {
      id: this.#gk.nextProvisionalCommentId(),
      body: bodyMarkdown,
      url: issue.url,
      createdAt: new Date().toISOString(),
      user: null,
    };
    await this.#gk.enqueue(this.#queue, {
      kind: "postComment", issueRef: issue.id, body: bodyMarkdown, synthetic,
      title: `Comment on ${issue.identifier}`,
      presentation: {
        title: `Comment on ${issue.identifier}`,
        ...onIssue(issue, label => `Post a comment on ${label}.`)
          .verbatim("Comment", bodyMarkdown, "markdown")
          .finish(),
        implementsRevert: true,
      },
    });
  }

  async createSubIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    const issue = await this.#requireIssue();
    // Always scope the sub-issue handle to the parent issue's team, so an issue-scoped grant (which
    // has no #teamScope of its own) can't use the returned handle to queue cross-team mutations.
    return await createIssueViaQueue(
      this.#gk, this.#queue,
      { ...options, teamId: issue.team.id, parentId: issue.id },
      { requireTeam: false },
      issue.team.id);
  }

  async archive(): Promise<void> {
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "archive", issueRef: issue.id, archived: true, title: `Archive ${issue.identifier}`,
      presentation: {
        title: `Archive ${issue.identifier}`,
        ...onIssue(issue, label => `Archive issue ${label}.`).finish(),
        implementsRevert: true,
      },
    });
  }

  async unarchive(): Promise<void> {
    const issue = await this.#requireIssueForAction();
    await this.#gk.enqueue(this.#queue, {
      kind: "archive", issueRef: issue.id, archived: false, title: `Unarchive ${issue.identifier}`,
      presentation: {
        title: `Unarchive ${issue.identifier}`,
        ...onIssue(issue, label => `Restore archived issue ${label}.`).finish(),
        implementsRevert: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

// How an issue is named in description prose. The title is agent text for an issue created in this
// workspace and provider text otherwise; either way it is flattened so it cannot open Markdown or
// HTML structure that would hide the fields after it.
function issueLabel(issue: RawIssue): string {
  return `**${plainInline(issue.identifier)} ${plainInline(issue.title)}**`;
}

// Issue IDs of the form `~N` stand for an issue a pending createIssue makes (see
// nextProvisionalIssueId); applyAction swaps in the ID Linear assigned once that create is applied.
function isProvisionalIssueId(id: string): boolean {
  return id.startsWith("~");
}

// Label IDs of the form `~label:<name>` stand for a label a pending createLabel makes; applyAction
// swaps in the ID Linear assigned once that create is applied.
function isProvisionalLabelId(id: string): boolean {
  return id.startsWith("~label:");
}

const PROVISIONAL_ISSUE_NOTE =
  "_This ID stands for an issue that an earlier pending action creates, whose description shows " +
  "it as its provisional ID. Applying this action sends the ID Linear assigns to that issue; " +
  "rejecting that action drops this one._";

const PROVISIONAL_LABEL_NOTE =
  "_An ID starting with `~label:` stands for a label that an earlier pending action creates. " +
  "Applying this action uses the ID Linear assigns to that label._";

// Opens the description of an action on an existing issue: the gatekeeper's summary, naming the
// issue by its identifier and title, then the exact ID the stored action applies to.
function onIssue(issue: RawIssue, summary: (label: string) => string): ActionDescriptionBuilder {
  const builder = buildDescription(summary(issueLabel(issue))).inline("Issue ID", issue.id);
  if (isProvisionalIssueId(issue.id)) builder.prose(PROVISIONAL_ISSUE_NOTE);
  return builder;
}

// Names a resolved user exactly. Display names need not be unique, so the ID and email go beside it.
function describeAssignee(builder: ActionDescriptionBuilder, user: RawUser): ActionDescriptionBuilder {
  builder.inline("Assignee", user.displayName ?? user.name).inline("Assignee ID", user.id);
  if (user.email) builder.inline("Assignee email", user.email);
  return builder;
}

// Names resolved labels by name, then lists the exact IDs the action sends.
function describeLabels(builder: ActionDescriptionBuilder, labels: readonly RawLabel[]): ActionDescriptionBuilder {
  builder.list("Labels", labels.map(l => l.name)).list("Label IDs", labels.map(l => l.id));
  if (labels.some(l => isProvisionalLabelId(l.id))) builder.prose(PROVISIONAL_LABEL_NOTE);
  return builder;
}

// Names a parent issue by identifier, then gives the exact ID the action sends.
function describeParent(builder: ActionDescriptionBuilder, parent: NonNullable<RawIssue["parent"]>): ActionDescriptionBuilder {
  builder.inline("Parent issue", parent.identifier).inline("Parent issue ID", parent.id);
  if (isProvisionalIssueId(parent.id)) builder.prose(PROVISIONAL_ISSUE_NOTE);
  return builder;
}

// Every field the new label will carry. Color and description are sent only when given.
function describeCreateLabel(team: RawTeam, name: string, options: LinearCreateLabelOptions | undefined): RenderedDescription {
  const builder = buildDescription(`Create a new label in team ${plainInline(team.key)}.`)
    .inline("Team ID", team.id)
    .inline("Name", name);
  if (options?.color !== undefined) builder.inline("Color", options.color);
  if (options?.description !== undefined) builder.verbatim("Description", options.description);
  return builder.finish();
}

// Every field the new issue will carry, with the agent's values shown in full and the resolved
// provider objects named beside the exact IDs the create sends.
function describeCreateIssue(
  team: RawTeam,
  options: LinearCreateIssueOptions,
  provisionalId: string,
  resolved: {
    stateObj: RawWorkflowState | null;
    assigneeObj: RawUser | null;
    labelObjs: RawLabel[];
    parentObj: RawIssue["parent"];
  },
): RenderedDescription {
  const builder = buildDescription(`Create a new issue in team ${plainInline(team.key)}.`)
    .inline("Team ID", team.id)
    .inline("Provisional ID", provisionalId)
    .inline("Title", options.title)
    .verbatim("Description", options.descriptionMarkdown ?? "", "markdown");
  if (resolved.stateObj) builder.inline("State", resolved.stateObj.name).inline("State ID", resolved.stateObj.id);
  if (resolved.assigneeObj) describeAssignee(builder, resolved.assigneeObj);
  if (resolved.labelObjs.length) describeLabels(builder, resolved.labelObjs);
  if (options.priority) builder.inline("Priority", options.priority);
  if (options.projectId) builder.inline("Project ID", options.projectId);
  if (options.dueDate) builder.inline("Due date", options.dueDate);
  if (resolved.parentObj) describeParent(builder, resolved.parentObj);
  return builder.finish();
}

function issueArgs(filter: LinearIssueFilter | undefined): IssuePageArgs {
  return {
    state: filter?.state,
    assignee: filter?.assignee,
    labels: filter?.labels,
    priority: filter?.priority,
    projectId: filter?.projectId,
    sort: filter?.sort,
    includeArchived: filter?.includeArchived,
  };
}

async function createIssueViaQueue(
  gk: LinearGatekeeperImpl,
  queue: RpcStub<ApprovalQueue>,
  options: LinearCreateIssueOptions,
  opts: { requireTeam: boolean },
  teamScope?: string,
): Promise<LinearIssue> {
  if (!options.teamId && !options.teamKey && opts.requireTeam) {
    throw new Error("createIssue requires a teamKey (or teamId) at this granularity.");
  }
  const teamKeyOrId = options.teamId ?? options.teamKey;
  if (!teamKeyOrId) throw new Error("Could not determine which team to create the issue in.");
  const team = await gk.findTeamRaw(teamKeyOrId);
  const teamId = team.id;

  const input: IssueCreateInput = {
    teamId,
    title: options.title,
    description: options.descriptionMarkdown,
    priority: options.priority ? PRIORITY_TO_NUM[options.priority] : undefined,
    // Empty strings are omitted, matching the description's truthiness checks.
    projectId: options.projectId || undefined,
    dueDate: options.dueDate || undefined,
  };

  // Resolve display objects alongside the ids so the pending issue can be simulated faithfully.
  let stateObj: RawWorkflowState | null = null;
  if (options.state) {
    const states = await gk.workflowStatesRaw(teamId);
    const target = states.find(s => s.name.toLowerCase() === options.state!.toLowerCase());
    if (!target) throw new Error(`No workflow state named "${options.state}" in this team.`);
    input.stateId = target.id;
    stateObj = target;
  }
  let assigneeObj: RawUser | null = null;
  if (options.assignee) {
    assigneeObj = await gk.resolveMemberRaw(options.assignee);
    input.assigneeId = assigneeObj.id;
  }
  const labelObjs: RawLabel[] = [];
  if (options.labels && options.labels.length > 0) {
    // Resolve against real + pending-created labels, like addLabels; provisional `~label:` ids
    // are resolved to real ids in applyAction.
    const teamLabels = await gk.labelsForDisplay(teamId);
    const byName = new Map(teamLabels.map(l => [l.name.toLowerCase(), l]));
    for (const name of options.labels) {
      const found = byName.get(name.toLowerCase());
      if (!found) throw new Error(`No label named "${name}" in the team. Create it with createLabel() first.`);
      labelObjs.push(found);
    }
    input.labelIds = labelObjs.map(l => l.id);
  }
  let projectObj: RawProject | null = null;
  if (options.projectId) {
    projectObj = await gk.getProjectRaw(options.projectId);
  }
  let parentObj: RawIssue["parent"] = null;
  let parentTeamId: string | undefined;
  if (options.parentId) {
    const parent = await gk.issueRaw(options.parentId);
    input.parentId = parent.id;
    parentObj = { id: parent.id, identifier: parent.identifier, url: parent.url, title: parent.title };
    parentTeamId = parent.team.id;
  }

  // The description shows the team, state, label and parent names and the assignee's email, so on
  // a workspace binding the log must only reach observers who may see those teams.
  await gk.authorizeTeamObservation(queue, [...new Set([teamId, parentTeamId ?? teamId])], {
    title: "Read team for new issue",
    description: "Read the team, workflow state, labels, assignee and parent issue named in a new issue.",
  });

  const provisionalId = gk.nextProvisionalIssueId();
  const now = new Date().toISOString();
  const synthetic: RawIssue = {
    id: provisionalId,
    identifier: provisionalId,
    url: `https://linear.app/${gk.workspaceKey()}/issue/${provisionalId}`,
    title: options.title,
    description: options.descriptionMarkdown ?? "",
    priority: input.priority ?? 0,
    createdAt: now,
    updatedAt: now,
    dueDate: options.dueDate || null,
    state: stateObj,
    assignee: assigneeObj,
    labels: { nodes: labelObjs, pageInfo: { hasNextPage: false, endCursor: null } },
    team,
    project: projectObj,
    parent: parentObj,
    cycle: null,
  };

  await gk.enqueue(queue, {
    kind: "createIssue", input, provisionalId, synthetic, title: `Create issue "${options.title}"`,
    presentation: {
      title: `Create issue "${options.title}"`,
      ...describeCreateIssue(team, options, provisionalId, { stateObj, assigneeObj, labelObjs, parentObj }),
      implementsRevert: true,
    },
  });

  return new LinearIssueImpl(gk, queue.dup(), provisionalId, teamScope);
}