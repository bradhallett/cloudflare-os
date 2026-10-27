// Normalization: Linear's raw GraphQL objects to the public session shapes (./types), the
// priority/state value maps those translations run through, and the pure issue-filter
// construction the gatekeeper's paged reads send back to the API.

import type {
  LinearComment,
  LinearCycleSummary,
  LinearIssueDetails,
  LinearIssueSummary,
  LinearLabel,
  LinearPriority,
  LinearProjectRef,
  LinearProjectStatus,
  LinearProjectSummary,
  LinearStateCategory,
  LinearTeamSummary,
  LinearUser,
  LinearWorkflowState,
} from "./types";
import type {
  RawComment,
  RawCycle,
  RawIssue,
  RawLabel,
  RawProject,
  RawTeam,
  RawUser,
  RawWorkflowState,
} from "./linear-api";

// ---- value mapping ----

export const PRIORITY_TO_NUM: Record<LinearPriority, number> = {
  none: 0, urgent: 1, high: 2, medium: 3, low: 4,
};
const NUM_TO_PRIORITY: LinearPriority[] = ["none", "urgent", "high", "medium", "low"];

export function numToPriority(value: number): LinearPriority {
  return NUM_TO_PRIORITY[value] ?? "none";
}

const STATE_CATEGORIES: LinearStateCategory[] =
  ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

export function toStateCategory(type: string | null | undefined): LinearStateCategory {
  return STATE_CATEGORIES.includes(type as LinearStateCategory)
    ? (type as LinearStateCategory)
    : "backlog";
}

const PROJECT_STATUSES: LinearProjectStatus[] =
  ["backlog", "planned", "started", "paused", "completed", "canceled"];

export function toProjectStatus(state: string | null | undefined): LinearProjectStatus {
  return PROJECT_STATUSES.includes(state as LinearProjectStatus)
    ? (state as LinearProjectStatus)
    : "backlog";
}

// ---- normalization (raw GraphQL -> public Session shapes) ----

export function normUser(user: RawUser | null | undefined): LinearUser | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName ?? undefined,
    email: user.email ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    active: user.active ?? true,
  };
}

export function normLabel(label: RawLabel): LinearLabel {
  return { id: label.id, name: label.name, color: label.color ?? undefined };
}

export function normState(state: RawWorkflowState): LinearWorkflowState {
  return {
    id: state.id,
    name: state.name,
    type: toStateCategory(state.type),
    color: state.color ?? undefined,
    position: state.position ?? undefined,
  };
}

export function teamUrl(wsKey: string, key: string): string {
  return `https://linear.app/${wsKey}/team/${key}`;
}

export function normTeamSummary(team: RawTeam, wsKey: string): LinearTeamSummary {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    url: teamUrl(wsKey, team.key),
    description: team.description ?? undefined,
    private: team.private ?? false,
  };
}

export function normProjectRef(project: RawProject): LinearProjectRef {
  return { id: project.id, name: project.name, url: project.url };
}

export function normProjectSummary(project: RawProject): LinearProjectSummary {
  return {
    ...normProjectRef(project),
    status: toProjectStatus(project.state),
    lead: normUser(project.lead),
    progress: project.progress ?? undefined,
    startDate: project.startDate ?? undefined,
    targetDate: project.targetDate ?? undefined,
  };
}

export function isCycleActive(cycle: RawCycle): boolean {
  const now = Date.now();
  const starts = cycle.startsAt ? Date.parse(cycle.startsAt) : NaN;
  const ends = cycle.endsAt ? Date.parse(cycle.endsAt) : NaN;
  return !Number.isNaN(starts) && !Number.isNaN(ends) && now >= starts && now <= ends;
}

export function normCycle(cycle: RawCycle): LinearCycleSummary {
  return {
    id: cycle.id,
    number: cycle.number,
    name: cycle.name ?? undefined,
    startsAt: cycle.startsAt ?? undefined,
    endsAt: cycle.endsAt ?? undefined,
    isActive: isCycleActive(cycle),
  };
}

export function normIssueSummary(issue: RawIssue, wsKey: string): LinearIssueSummary {
  return {
    id: issue.identifier,
    uuid: issue.id,
    title: issue.title,
    url: issue.url,
    state: {
      name: issue.state?.name ?? "Unknown",
      type: toStateCategory(issue.state?.type),
    },
    priority: numToPriority(issue.priority),
    assignee: normUser(issue.assignee),
    labels: (issue.labels?.nodes ?? []).map(normLabel),
    team: {
      id: issue.team.id,
      key: issue.team.key,
      name: issue.team.name,
      url: teamUrl(wsKey, issue.team.key),
    },
    project: issue.project ? normProjectRef(issue.project) : null,
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
    completedAt: issue.completedAt ? new Date(issue.completedAt) : undefined,
    canceledAt: issue.canceledAt ? new Date(issue.canceledAt) : undefined,
    dueDate: issue.dueDate ?? undefined,
  };
}

export function normIssueDetails(issue: RawIssue, wsKey: string): LinearIssueDetails {
  return {
    ...normIssueSummary(issue, wsKey),
    descriptionMarkdown: issue.description ?? "",
    creator: normUser(issue.creator),
    parent: issue.parent
      ? { id: issue.parent.identifier, uuid: issue.parent.id, title: issue.parent.title, url: issue.parent.url }
      : null,
    cycle: issue.cycle ? normCycle(issue.cycle) : null,
    branchName: issue.branchName ?? undefined,
  };
}

export function normComment(comment: RawComment): LinearComment {
  return {
    id: comment.id,
    author: normUser(comment.user),
    bodyMarkdown: comment.body,
    createdAt: new Date(comment.createdAt),
    updatedAt: comment.updatedAt ? new Date(comment.updatedAt) : undefined,
    url: comment.url,
  };
}

// ---- GraphQL issue-filter construction (pure) ----

export type IssuePageArgs = {
  teamId?: string;
  state?: string;
  assignee?: string;
  labels?: string[];
  priority?: LinearPriority;
  projectId?: string;
  sort?: "created" | "updated" | "priority";
  includeArchived?: boolean;
};

export function buildIssueFilter(args: IssuePageArgs): { filter: Record<string, unknown>; orderBy: "createdAt" | "updatedAt" } {
  const and: Record<string, unknown>[] = [];
  if (args.teamId) and.push({ team: { id: { eq: args.teamId } } });
  if (args.state) {
    if (STATE_CATEGORIES.includes(args.state as LinearStateCategory)) {
      and.push({ state: { type: { eq: args.state } } });
    } else {
      and.push({ state: { name: { eqIgnoreCase: args.state } } });
    }
  }
  if (args.assignee) {
    and.push({ assignee: { or: [
      { email: { eqIgnoreCase: args.assignee } },
      { displayName: { eqIgnoreCase: args.assignee } },
      { name: { eqIgnoreCase: args.assignee } },
    ] } });
  }
  for (const label of args.labels ?? []) {
    and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
  }
  if (args.priority) and.push({ priority: { eq: PRIORITY_TO_NUM[args.priority] } });
  if (args.projectId) and.push({ project: { id: { eq: args.projectId } } });

  const orderBy = args.sort === "created" ? "createdAt" : "updatedAt";
  return { filter: and.length > 0 ? { and } : {}, orderBy };
}
