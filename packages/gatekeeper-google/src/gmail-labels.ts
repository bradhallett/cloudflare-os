/**
 * Label registry for the Gmail gatekeeper: labels, admissions, and mutation submission.
 */

import { GmailActionJournal, dependenciesFor, labelPending, submitAction } from "./gmail-journal";
import { GmailContext } from "./gmail-list";
import { GmailMutationOperation } from "./gmail-overlay";
import { GmailMessagesTarget } from "./gmail-scope";
import { CanonicalMutableLabel, GmailLabelResource, canonicalizeGmailMutableLabel, overlayGmailLabels } from "./gmail-state";
import { GmailLabelRaw } from "./google-api";
import { GmailCustomLabel, GmailLabel, GmailSystemLabel } from "./types";
import { ActionDescriptionBuilder, buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";

export class GmailLabelRegistry {
  #storage: DurableObjectStorage;
  #kv: DurableObjectStorage["kv"];

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#kv = storage.kv;
  }

  #labelKey(id: string) { return `gmail:label:${id}`; }
  #admittedLabelKey(id: string) { return `gmail:admittedLabel:${id}`; }

  getLabel(id: string): GmailLabelResource | undefined {
    return this.#kv.get<GmailLabelResource>(this.#labelKey(id));
  }

  putLabel(resource: GmailLabelResource): void {
    this.#kv.put(this.#labelKey(resource.logicalId), resource);
  }

  deleteLabel(id: string): void { this.#kv.delete(this.#labelKey(id)); }

  listLabels(): GmailLabelResource[] {
    return [...this.#kv.list<GmailLabelResource>({prefix: "gmail:label:"})].map(([, value]) => value);
  }

  labelForProvider(providerId: string): GmailLabelResource | undefined {
    return this.listLabels().find(resource => resource.providerId === providerId);
  }

  mapLabelToProvider(journal: GmailActionJournal,
      actionId: number, provider: GmailLabelRaw): GmailLabelResource {
    return this.#storage.transactionSync(() => {
      const action = journal.getAction(actionId);
      if (action?.type !== "labelCreate" || !journal.isApplying(actionId) ||
          action.label.name !== provider.name || provider.type !== "user") {
        throw new Error("The uncertain Gmail label creation changed while it was being reconciled.");
      }
      const resource = this.getLabel(action.label.logicalId);
      if (!resource || resource.status !== "active" || resource.name !== action.label.name) {
        throw new Error("The provisional Gmail label is no longer active.");
      }
      if (resource.providerId && resource.providerId !== provider.id) {
        throw new Error("The Gmail label resource is already mapped to another provider label.");
      }
      const duplicate = this.labelForProvider(provider.id);
      if (duplicate && duplicate.logicalId !== resource.logicalId) {
        throw new Error("The Gmail provider label is already mapped to another local resource.");
      }
      resource.providerId = provider.id;
      resource.name = provider.name;
      this.putLabel(resource);
      return resource;
    });
  }

  admitLabel(id: string): void { this.#kv.put(this.#admittedLabelKey(id), true); }

  isLabelAdmitted(id: string): boolean {
    return this.#kv.get<boolean>(this.#admittedLabelKey(id)) === true;
  }
}

export const SYSTEM_LABEL_IDS: GmailSystemLabel[] = [
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PRIMARY", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];
export const SYSTEM_LABELS = new Set<string>(SYSTEM_LABEL_IDS);

export function publicLabels(ids: string[], labels: GmailLabelRaw[], resources: GmailLabelResource[]): GmailLabel[] {
  const byProvider = new Map(resources.filter(item => item.providerId)
    .map(item => [item.providerId!, item]));
  const byId = new Map(labels.map(label => [label.id, label]));
  const result: GmailLabel[] = [];
  for (const id of ids) {
    if (SYSTEM_LABELS.has(id)) {
      result.push({id, name: id as GmailSystemLabel, type: "system"});
      continue;
    }
    const resource = byProvider.get(id);
    const label = byId.get(resource?.logicalId ?? id) ?? byId.get(id);
    if (!label || label.type !== "user") continue;
    result.push({
      id: resource?.logicalId ?? id,
      name: label?.name ?? resource?.name ?? id,
      type: "custom",
    });
  }
  return result;
}

export async function resolveMutableLabel(
    ctx: GmailContext, candidate: unknown): Promise<CanonicalMutableLabel> {
  if (ctx.restricted) {
    const id = candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>).id
      : undefined;
    if (typeof id !== "string" || !ctx.store.labels.isLabelAdmitted(id)) {
      throw new Error("This Gmail label is unavailable through this restricted binding.");
    }
  }
  const provider = await ctx.providerLabels();
  const resources = ctx.store.labels.listLabels();
  const canonical = canonicalizeGmailMutableLabel(candidate, provider, resources);
  if (ctx.restricted && !ctx.store.labels.isLabelAdmitted(canonical.id)) {
    throw new Error("This Gmail label has not been returned by this restricted binding.");
  }
  const current = canonical.type === "custom"
    ? overlayGmailLabels(provider, resources, labelPending(ctx.store), ctx.store.journal.decisions())
      .find(label => label.id === canonical.id)
    : undefined;
  if (canonical.type === "custom" && !current) {
    throw new Error("This Gmail label is pending deletion.");
  }
  return current
    ? {id: canonical.id, name: current.name, type: "custom"}
    : canonical;
}

export function ensureLabelResource(ctx: GmailContext, label: GmailCustomLabel): GmailLabelResource {
  const existing = ctx.store.labels.getLabel(label.id) ?? ctx.store.labels.labelForProvider(label.id);
  if (existing) return existing;
  const resource: GmailLabelResource = {
    logicalId: label.id,
    providerId: label.id,
    name: label.name,
    status: "active",
  };
  ctx.store.labels.putLabel(resource);
  return resource;
}

export function labelActionId(ctx: GmailContext, label: CanonicalMutableLabel): {
  id: string;
  dependencies: number[];
} {
  if (label.type === "system") return {id: label.id, dependencies: []};
  const resource = ensureLabelResource(ctx, label);
  return {
    id: resource.logicalId,
    dependencies: dependenciesFor(ctx.store, resource.logicalId, "label"),
  };
}

export function mutationAliasMethod(
    operation: GmailMutationOperation, label: CanonicalMutableLabel | undefined): string | undefined {
  if (label?.type !== "system") return undefined;
  if (operation === "applyLabel") {
    switch (label.id) {
    case "TRASH": return "trash";
    case "UNREAD": return "markUnread";
    case "STARRED": return "star";
    }
  }
  if (operation === "removeLabel") {
    switch (label.id) {
    case "INBOX": return "archive";
    case "UNREAD": return "markRead";
    case "STARRED": return "unstar";
    }
  }
  return undefined;
}

export async function submitMutation(
    ctx: GmailContext, operation: GmailMutationOperation,
    target: GmailMessagesTarget, title: string,
    description: ActionDescriptionBuilder, label?: CanonicalMutableLabel): Promise<void> {
  const alias = mutationAliasMethod(operation, label);
  if (alias && label) {
    throw new Error(`Use ${alias}() instead of ${operation}() with the ${label.id} system label.`);
  }
  const resolved = label ? labelActionId(ctx, label) : undefined;
  await submitAction(ctx, {
    type: "messageMutation",
    operation,
    target,
    ...(resolved ? {labelId: resolved.id, dependsOn: resolved.dependencies} : {}),
  }, {
    title: sanitizeTitle(title),
    ...describeMutationTarget(description, target, resolved?.id).finish(),
  });
}

export function mutationTitle(operation: GmailMutationOperation): string {
  switch (operation) {
    case "archive": return "Archive";
    case "trash": return "Trash";
    case "markRead": return "Mark read";
    case "markUnread": return "Mark unread";
    case "star": return "Star";
    case "unstar": return "Unstar";
    case "applyLabel": return "Apply label";
    case "removeLabel": return "Remove label";
  }
}

export function mutationDescription(
    operation: GmailMutationOperation, label?: CanonicalMutableLabel): ActionDescriptionBuilder {
  if (operation === "applyLabel" || operation === "removeLabel") {
    return buildDescription(
      `${operation === "applyLabel" ? "Apply" : "Remove"} the resolved Gmail label.`)
      .inline("Label", label?.name ?? "(unknown)");
  }
  return buildDescription(
    `${mutationTitle(operation)} exactly the listed messages; later messages are unaffected.`);
}

export function describeMutationTarget(
    builder: ActionDescriptionBuilder, target: GmailMessagesTarget,
    labelId?: string): ActionDescriptionBuilder {
  builder.inline("Mutation scope", `${target.messageIds.length} message(s)`);
  builder.list("Message IDs", target.messageIds);
  if (labelId !== undefined) builder.inline("Label ID", labelId);
  return builder;
}

