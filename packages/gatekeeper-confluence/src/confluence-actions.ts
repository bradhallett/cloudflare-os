// Phase 2 machinery for the Confluence gatekeeper: the action lifecycle (as the kit's
// `defineActions` engine over an `ActionJournal` on this connector's pre-engine keys),
// provisional IDs for not-yet-created content, response caching, and action simulation (so
// reads reflect pending writes), plus the apply/reject/revert seams the gatekeeper DO calls.
//
// Design (mirrors the Notion gatekeeper): we cache the *base* truth fetched from Confluence (short
// TTL) and overlay pending (submitted-but-unapplied) actions at read time. submit() records an
// action and leaves the cache untouched; apply() performs the real API call and invalidates
// affected cache entries; reject() drops the record so the overlay recomputes without it.

import type { RpcStub } from "cloudflare:workers";
import {
  type ActionDescriptionBuilder,
  buildDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import {
  ActionJournal,
  ActionOutcomeUnknownError,
  APPLY_OUTCOME_UNKNOWN_MESSAGE,
  defineActions,
  type ActionDefinition,
  type ActionJournalKv,
  type BoundActionSet,
  type JournalEntry,
  type JournalRecord,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { ActionFileStore, type ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionDescription, ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  ConfluenceApi,
  contentBodyMarkdown,
  contentToSummary,
  isConfluenceOutcomeUnknown,
  type ContentResponse,
} from "./confluence-api";
import { markdownToStorage, storageToMarkdown } from "./confluence-markdown";
import type { Comment, ContentSummary, ContentType } from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type ContentParent =
  | { type: "space"; spaceKey: string }
  | { type: "page"; parentId: string; spaceKey?: string };

export type ConfluenceAction =
  | {
      type: "createContent";
      provisionalId: string;
      kind: ContentType;
      parent: ContentParent;
      title: string;
      content?: string;
      status: "current" | "draft";
    }
  | { type: "setContent"; contentId: string; markdown: string; previousMarkdown: string }
  | { type: "appendContent"; contentId: string; markdown: string; previousMarkdown?: string }
  | { type: "setTitle"; contentId: string; title: string; previousTitle: string }
  | { type: "addComment"; contentId: string; text: string }
  | { type: "addLabel"; contentId: string; name: string }
  | { type: "removeLabel"; contentId: string; name: string }
  | UploadAttachmentAction
  | { type: "trash"; contentId: string }
  | { type: "restore"; contentId: string };

/**
 * The file bytes live in the chunk store until the action is applied or rejected, keeping the
 * action record itself small. Records queued before that store existed carry them inline as `data`
 * instead; `ConfluenceStore.readAttachment` still accepts those.
 */
export type UploadAttachmentAction = {
  type: "uploadAttachment";
  contentId: string;
  filename: string;
  mediaType: string;
  file: ActionFileReference;
  comment?: string;
};

/** Bookkeeping a journal payload carries beside its action's own fields. */
type PayloadMeta = {
  /** When the action was staged, which simulation shows for pending comments and creations. */
  submittedAt?: number;
  /** For createContent / addComment: the real content ID assigned on apply (retained for revert). */
  createdContentId?: string;
  /** For uploadAttachment: the attachment ID assigned on apply (retained for revert). */
  createdAttachmentId?: string;
};

/** One action kind's payload: the action object minus its discriminator, plus the meta fields. */
type ActionPayload<T extends { type: string }> = Omit<T, "type"> & PayloadMeta;

/** The journal's kinds, one per action shape the sessions submit. */
export type ConfluenceKinds = {
  [K in ConfluenceAction["type"]]: ActionPayload<Extract<ConfluenceAction, { type: K }>>;
};

/** Any kind name. */
type Kind = keyof ConfluenceKinds & string;

/**
 * The read-side view of one journal record, as the simulation and the sessions see it. `state` is
 * the record's journal state; `submittedAt` comes from the payload (the journal itself keeps no
 * clock), reading 0 for records that predate it.
 */
export type StoredActionRecord = {
  id: number;
  action: ConfluenceAction;
  state: "pending" | "claimed" | "applied" | "failed" | "reverted";
  submittedAt: number;
  /** For createContent / addComment: the real content ID assigned on apply. */
  createdContentId?: string;
  /** For uploadAttachment: the attachment ID assigned on apply. */
  createdAttachmentId?: string;
  /** For state "failed": why, and what to answer later attempts with. */
  failure?: string;
};

/** Rebuilds the discriminable action object a payload was staged from. */
function withType<K extends Kind>(kind: K, payload: ConfluenceKinds[K]): ConfluenceAction {
  return toViewAction({ kind, payload } as TaggedAction<ConfluenceKinds>);
}

/** The content (provisional or real) an action targets, or null if it targets none. */
function actionContentId(action: ConfluenceAction): string | null {
  return action.type === "createContent" ? action.provisionalId : action.contentId;
}

// ---------------------------------------------------------------------------------------------
// Action declarations

const kind = (tag: string, label: string): NonNullable<ActionDescription["actionKind"]> =>
  ({ tag: `confluence.${tag}`, label });

/** The approval-catalog kind for each action type, shared by every definition of that tag. */
function actionKindFor(type: ConfluenceAction["type"]): NonNullable<ActionDescription["actionKind"]> {
  switch (type) {
    case "createContent": return kind("createContent", "Create page/blog post");
    case "setContent":
    case "appendContent": return kind("editContent", "Edit page content");
    case "setTitle": return kind("setTitle", "Rename content");
    case "addComment": return kind("addComment", "Add comment");
    case "addLabel":
    case "removeLabel": return kind("label", "Add/remove label");
    case "uploadAttachment": return kind("uploadAttachment", "Upload attachment");
    case "trash":
    case "restore": return kind("trash", "Trash content");
  }
}

// Starts a description naming, by ID, the existing content an action writes to or under.
function onContent(intro: string, contentId: string, label = "Content ID"): ActionDescriptionBuilder {
  const builder = buildDescription(intro).inline(label, contentId);
  return ConfluenceStore.isProvisional(contentId)
    ? builder.prose("An ID starting with `~` names content created by an earlier action in this workspace.")
    : builder;
}

// The approver's text, built so every value the agent supplied (bodies, comments, titles, labels)
// is shown in full in a field, and the completeness claim is the builder's. An uploaded attachment
// is agent-supplied bytes the approver cannot read as text, so it is named by size and digest and
// never claims completeness.
function describeAction(action: ConfluenceAction): ActionDescription {
  switch (action.type) {
    case "createContent": {
      const noun = action.kind === "blogpost" ? "blog post" : "page";
      const { parent } = action;
      const builder = parent.type === "page"
        ? onContent(`Create a new ${noun} as a child page.`, parent.parentId, "Parent page ID")
        : buildDescription(`Create a new ${noun} in a space.`);
      if (parent.spaceKey !== undefined) builder.inline("Space", parent.spaceKey);
      return {
        title: `Create Confluence ${noun}`,
        ...builder
          .inline("Provisional ID", action.provisionalId)
          .inline("Title", action.title)
          .inline("Status", action.status)
          .verbatim("Content", action.content ?? "", "markdown")
          .finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    }
    case "setContent":
      return {
        title: "Replace Confluence page content",
        ...onContent("Replace the body with the content below.", action.contentId)
          .verbatim("Content", action.markdown, "markdown")
          .finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "appendContent":
      return {
        title: "Append to Confluence page",
        ...onContent("Append the content below to the body.", action.contentId)
          .verbatim("Content", action.markdown, "markdown")
          .finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "setTitle":
      return {
        title: "Rename Confluence content",
        ...onContent("Change the title.", action.contentId)
          .inline("Current title", action.previousTitle)
          .inline("New title", action.title)
          .finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "addComment":
      return {
        title: "Comment on Confluence content",
        ...onContent("Post a comment.", action.contentId).verbatim("Comment", action.text).finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "addLabel":
      return {
        title: "Add label to Confluence content",
        ...onContent("Add a label.", action.contentId).inline("Label", action.name).finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "removeLabel":
      return {
        title: "Remove label from Confluence content",
        ...onContent("Remove a label.", action.contentId).inline("Label", action.name).finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "uploadAttachment":
      return {
        title: "Upload attachment to Confluence",
        // The bytes themselves are not shown, so the builder makes no completeness claim.
        ...onContent("Upload a file as an attachment.", action.contentId)
          .file("File", {
            name: action.filename,
            mediaType: action.mediaType,
            size: action.file.size,
            sha256: action.file.digest,
            origin: "agent",
          })
          .verbatim("Comment", action.comment ?? "")
          .finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "trash":
      return {
        title: "Move Confluence content to trash",
        ...onContent("Move this content to the trash (reversible).", action.contentId).finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
    case "restore":
      return {
        title: "Restore Confluence content from trash",
        ...onContent("Restore this content from the trash.", action.contentId).finish(),
        implementsRevert: true,
        actionKind: actionKindFor(action.type),
      };
  }
}

function requireResolved(store: ConfluenceStore, id: string): string {
  const resolved = store.resolveId(id);
  if (ConfluenceStore.isProvisional(resolved)) {
    throw new Error(`Cannot apply: content ${id} has not been created yet.`);
  }
  return resolved;
}

/**
 * The status to send when updating a page/blog post. Preserves an existing draft so that editing
 * a draft doesn't publish it: `updateContent` defaults status to "current", and passing "current"
 * for a draft transitions it to published.
 */
function preservedStatus(current: ContentResponse): "draft" | "current" {
  return current.status === "draft" ? "draft" : "current";
}

// The provisional references a payload consumes: the content it targets, and a creation's parent.
function dependsOnRefs(action: ConfluenceAction): readonly string[] {
  const refs: string[] = [];
  if (action.type === "createContent") {
    if (action.parent.type === "page" && ConfluenceStore.isProvisional(action.parent.parentId)) {
      refs.push(action.parent.parentId);
    }
  } else if (ConfluenceStore.isProvisional(action.contentId)) {
    refs.push(action.contentId);
  }
  return refs;
}

async function applyCreateContent(
  payload: ConfluenceKinds["createContent"], store: ConfluenceStore,
): Promise<PayloadMeta> {
  const spaceKey = payload.parent.spaceKey;
  if (!spaceKey) throw new Error("Cannot create content without a space.");
  const spaceId = await store.getSpaceId(spaceKey);
  const storageValue = markdownToStorage(payload.content ?? "");
  const created = payload.kind === "blogpost"
    ? await store.api.createBlogPost({ spaceId, title: payload.title, status: payload.status, storageValue })
    : await store.api.createPage({
        spaceId,
        title: payload.title,
        status: payload.status,
        storageValue,
        parentId: payload.parent.type === "page"
          ? requireResolved(store, payload.parent.parentId)
          : undefined,
      });
  store.setProvisional(payload.provisionalId, created.id);
  return { createdContentId: created.id };
}

async function applySetContent(
  payload: ConfluenceKinds["setContent"], store: ConfluenceStore,
): Promise<void> {
  const id = requireResolved(store, payload.contentId);
  const current = await store.getContentResponse(id, true);
  await store.api.updateContent({
    id,
    type: current.type === "blogpost" ? "blogpost" : "page",
    title: current.title,
    version: (current.version?.number ?? 1) + 1,
    storageValue: markdownToStorage(payload.markdown),
    status: preservedStatus(current),
  });
  store.invalidateContent(id);
}

async function applyAppendContent(
  payload: ConfluenceKinds["appendContent"], store: ConfluenceStore,
): Promise<void> {
  const id = requireResolved(store, payload.contentId);
  const current = await store.getContentResponse(id, true);
  const combined = (current.body?.storage?.value ?? "") + markdownToStorage(payload.markdown);
  await store.api.updateContent({
    id,
    type: current.type === "blogpost" ? "blogpost" : "page",
    title: current.title,
    version: (current.version?.number ?? 1) + 1,
    storageValue: combined,
    status: preservedStatus(current),
  });
  store.invalidateContent(id);
}

async function applySetTitle(
  payload: ConfluenceKinds["setTitle"], store: ConfluenceStore,
): Promise<void> {
  const id = requireResolved(store, payload.contentId);
  const current = await store.getContentResponse(id, true);
  await store.api.updateContent({
    id,
    type: current.type === "blogpost" ? "blogpost" : "page",
    title: payload.title,
    version: (current.version?.number ?? 1) + 1,
    storageValue: current.body?.storage?.value ?? "",
    status: preservedStatus(current),
  });
  store.invalidateContent(id);
}

async function applyAddComment(
  payload: ConfluenceKinds["addComment"], store: ConfluenceStore,
): Promise<PayloadMeta> {
  const id = requireResolved(store, payload.contentId);
  // The comment container type must match the target (blog posts reject a "page" container).
  const target = await store.getContentResponse(id, true);
  const created = await store.api.addComment(id, markdownToStorage(payload.text),
    target.type === "blogpost" ? "blogpost" : "page");
  return { createdContentId: created.id };
}

async function applyAddLabel(
  payload: ConfluenceKinds["addLabel"], store: ConfluenceStore,
): Promise<void> {
  await store.api.addLabel(requireResolved(store, payload.contentId), payload.name);
  store.invalidateContent(payload.contentId);
}

async function applyRemoveLabel(
  payload: ConfluenceKinds["removeLabel"], store: ConfluenceStore,
): Promise<void> {
  await store.api.removeLabel(requireResolved(store, payload.contentId), payload.name);
  store.invalidateContent(payload.contentId);
}

/** Rebuilds the upload action object an upload payload was staged from. */
function toUploadAction(payload: ConfluenceKinds["uploadAttachment"]): UploadAttachmentAction {
  return { type: "uploadAttachment", ...payload };
}

async function applyUploadAttachment(
  payload: ConfluenceKinds["uploadAttachment"], store: ConfluenceStore,
): Promise<PayloadMeta> {
  const id = requireResolved(store, payload.contentId);
  const action = toUploadAction(payload);
  const created = await store.api.uploadAttachment(id, {
    filename: action.filename, mediaType: action.mediaType, comment: action.comment,
    data: await store.readAttachment(action),
  });
  store.releaseAttachment(action);
  return { createdAttachmentId: created.id };
}

async function applyTrash(
  payload: ConfluenceKinds["trash"], store: ConfluenceStore,
): Promise<void> {
  const id = requireResolved(store, payload.contentId);
  await store.api.trashContent(id, await store.getContentKind(id));
  store.invalidateContent(payload.contentId);
}

async function applyRestore(
  payload: ConfluenceKinds["restore"], store: ConfluenceStore,
): Promise<void> {
  await store.api.restoreContent(requireResolved(store, payload.contentId));
  store.invalidateContent(payload.contentId);
}

// One definition per kind: simulated delivery (so the agent reads its own writes back), the
// pre-dispatch claim, and the outcome-unknown classification the old claim loop applied.
function defineKind<K extends Kind>(
  kindName: K,
  apply: (payload: ConfluenceKinds[K], store: ConfluenceStore) => Promise<PayloadMeta | void>,
): ActionDefinition<ConfluenceKinds[K], ConfluenceStore> {
  return {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    kind: actionKindFor(kindName),
    describe: payload => {
      // The kit supplies `actionKind` from the declaration, so the description drops its own.
      const { actionKind: _actionKind, ...presentation } = describeAction(withType(kindName, payload));
      return presentation;
    },
    provides: payload =>
      kindName === "createContent"
        ? [(payload as ConfluenceKinds["createContent"]).provisionalId]
        : [],
    dependsOn: payload => dependsOnRefs(withType(kindName, payload)),
    async apply(payload, store) {
      try {
        const updates = await apply(payload, store);
        return updates === undefined
          ? undefined
          : { action: { ...payload, ...updates } as ConfluenceKinds[K] };
      } catch (error) {
        if (isConfluenceOutcomeUnknown(error)) {
          // No definitive answer arrived, so the write may have landed. Record the action
          // terminally with the reason and surface it; a rejection clears the record after
          // the user checks Confluence.
          throw new ActionOutcomeUnknownError(
            `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error instanceof Error ? error.message : String(error)})`);
        }
        // Confluence answered with a refusal (or the failure is internal): the write did not
        // land, so the record goes back to pending and the failure stays retryable, as before.
        throw error;
      }
    },
    async reject(payload, store) {
      if (kindName !== "uploadAttachment") return;
      store.releaseAttachment(toUploadAction(payload as ConfluenceKinds["uploadAttachment"]));
    },
  };
}

const CONFLUENCE_ACTION_DEFS: { [K in Kind]: ActionDefinition<ConfluenceKinds[K], ConfluenceStore> } = {
  createContent: defineKind("createContent", applyCreateContent),
  setContent: defineKind("setContent", applySetContent),
  appendContent: defineKind("appendContent", applyAppendContent),
  setTitle: defineKind("setTitle", applySetTitle),
  addComment: defineKind("addComment", applyAddComment),
  addLabel: defineKind("addLabel", applyAddLabel),
  removeLabel: defineKind("removeLabel", applyRemoveLabel),
  uploadAttachment: defineKind("uploadAttachment", applyUploadAttachment),
  trash: defineKind("trash", applyTrash),
  restore: defineKind("restore", applyRestore),
};

const CONFLUENCE_KINDS: ReadonlySet<string> = new Set(Object.keys(CONFLUENCE_ACTION_DEFS));

/** The Confluence action set, bound once per object storage to its journal and store. */
const CONFLUENCE_ACTIONS = defineActions<ConfluenceStore, ConfluenceKinds>(
  CONFLUENCE_ACTION_DEFS,
  // The dispatch runs under the account's live credentials whatever connection produced the
  // payload, as the pre-engine records (which carried no fence) did.
  {
    fence: "none",
    vendorId: "confluence",
    // Revert reads applied records back (previous values, created ids), so they are retained.
    retainApplied: true,
    isResolvedReference: (store, ref) => store.resolveId(ref) !== ref,
  },
);

// ---------------------------------------------------------------------------------------------
// Legacy rows: the bespoke store's records, adopted onto the journal's keys

/**
 * Converts a row the pre-engine store wrote at `action:<id>` into a journal action. `applied` and
 * `reverted` rows return `undefined` here — the adoption pass below settles them at the right tier
 * (or drops them), because a lazy upgrade can only ever read as pending.
 */
function upgradeLegacyAction(raw: unknown): TaggedAction<ConfluenceKinds> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { action, submittedAt, createdContentId, createdAttachmentId } = raw as {
    action?: unknown;
    submittedAt?: unknown;
    createdContentId?: unknown;
    createdAttachmentId?: unknown;
  };
  if (typeof action !== "object" || action === null) return undefined;
  const { type, ...rest } = action as Record<string, unknown> & { type?: unknown };
  if (typeof type !== "string" || !CONFLUENCE_KINDS.has(type)) return undefined;
  const payload: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries({ submittedAt, createdContentId, createdAttachmentId })) {
    if (value !== undefined) payload[key] = value;
  }
  return { kind: type, payload } as TaggedAction<ConfluenceKinds>;
}

/**
 * One-time adoption of the rows the bespoke store left behind, for the states a lazy upgrade
 * cannot express: `applied` moves to the retained tier (keeping its revert trail), a leftover
 * `claim` or terminal `failure` becomes the failed record it already was, and `reverted` rows are
 * inert and dropped. Pending rows upgrade lazily in place. Idempotent: a row the journal wrote
 * (`v` marker) is skipped.
 */
function adoptLegacyActionRows(
  kv: ActionJournalKv,
  journal: ActionJournal<TaggedAction<ConfluenceKinds>>,
): void {
  const adoptions: [id: number, record: JournalRecord<TaggedAction<ConfluenceKinds>>][] = [];
  const deletions: string[] = [];
  for (const [key, raw] of kv.list<unknown>({ prefix: "action:" })) {
    if (typeof raw === "object" && raw !== null && "v" in raw) continue;
    const id = Number(key.slice("action:".length));
    if (!Number.isInteger(id) || id < 1) continue;
    const state = (raw as { state?: unknown }).state;
    if (state === "reverted") {
      deletions.push(key);
      continue;
    }
    if (state !== "applied" && state !== "claimed" && state !== "failed") continue;
    const action = upgradeLegacyAction(raw);
    if (action === undefined) continue;
    if (state === "applied") {
      adoptions.push([id, { state: "applied", action }]);
    } else if (state === "claimed") {
      // A dispatch was in flight when the store swapped: its outcome is unknown, exactly as the
      // old claim loop answered a leftover claim.
      adoptions.push([id, {
        state: "failed", action, error: APPLY_OUTCOME_UNKNOWN_MESSAGE, outcome: "unknown" as const,
      }]);
    } else {
      const failure = (raw as { failure?: unknown }).failure;
      adoptions.push([id, {
        state: "failed", action,
        error: typeof failure === "string" ? failure : "This action previously failed.",
      }]);
    }
  }
  for (const key of deletions) kv.delete(key);
  for (const [id, record] of adoptions) journal.adopt(id, record);
}

// One journal (and so one submission lane and one resolution queue) per object storage: the kit
// refuses two journals over one keyspace. The gatekeeper DO builds a fresh ConfluenceStore per
// call; every one of them is an equivalent host, and the first caller's binding wins.
const boundActions = new WeakMap<
  ActionJournalKv,
  { journal: ActionJournal<TaggedAction<ConfluenceKinds>>; set: BoundActionSet<ConfluenceKinds> }
>();

/**
 * The bound action lifecycle for one object's storage, adopting the pre-engine keys
 * (`seq:action` / `action:<id>`) so deployed records upgrade in place.
 */
function confluenceActions(
  kv: ActionJournalKv,
  store: ConfluenceStore,
): { journal: ActionJournal<TaggedAction<ConfluenceKinds>>; set: BoundActionSet<ConfluenceKinds> } {
  let memo = boundActions.get(kv);
  if (memo === undefined) {
    const journal = new ActionJournal<TaggedAction<ConfluenceKinds>>(kv, {
      legacyKeys: { nextIdKey: "seq:action", recordPrefix: "action:" },
      upgradeRecord: upgradeLegacyAction,
    });
    adoptLegacyActionRows(kv, journal);
    memo = { journal, set: CONFLUENCE_ACTIONS.bind(journal, store) };
    boundActions.set(kv, memo);
  }
  return memo;
}

// ---------------------------------------------------------------------------------------------
// Store: caching + pending-action views (backed by the gatekeeper DO's KV storage)

type Storage = Pick<DurableObjectStorage, "kv" | "transactionSync">;
const CONTENT_TTL_MS = 30_000;
const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
// How long an attachment file may go unreferenced by a pending action before it is swept: long
// enough that no staging still in flight could be about to reference it.
const ATTACHMENT_FILE_GRACE_MS = 60 * 60 * 1000;

type ContentCache = { fetchedAt: number; content: ContentResponse };

/** The simulation view of one journal entry: its action, projected as pending. */
function simView(entry: JournalEntry<TaggedAction<ConfluenceKinds>>): StoredActionRecord {
  return {
    id: entry.id,
    action: toViewAction(entry.action),
    state: "pending",
    submittedAt: (entry.action.payload as PayloadMeta).submittedAt ?? 0,
  };
}

function toViewAction(tagged: TaggedAction<ConfluenceKinds>): ConfluenceAction {
  return { type: tagged.kind, ...tagged.payload } as ConfluenceAction;
}

export class ConfluenceStore {
  #kv: Storage["kv"];
  #api: ConfluenceApi;
  #files: ActionFileStore;
  /** The action journal this storage's lifecycle runs on. */
  readonly journal: ActionJournal<TaggedAction<ConfluenceKinds>>;
  /** The bound action set: submit, apply, and reject. */
  readonly actionSet: BoundActionSet<ConfluenceKinds>;

  constructor(storage: Storage, api: ConfluenceApi) {
    this.#kv = storage.kv;
    this.#api = api;
    this.#files = new ActionFileStore(storage, {
      filePrefix: "confluence:actionFile:",
      allocationPrefix: "confluence:actionFileAllocation:",
      maxFileBytes: MAX_ATTACHMENT_FILE_BYTES,
      maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
    });
    const { journal, set } = confluenceActions(storage.kv, this);
    this.journal = journal;
    this.actionSet = set;
  }

  get api(): ConfluenceApi {
    return this.#api;
  }

  // --- provisional IDs ---

  nextProvisionalId(): string {
    const n = this.#kv.get<number>("seq:provisional") ?? 1;
    this.#kv.put("seq:provisional", n + 1);
    return `~${n}`;
  }

  // --- pending actions ---

  /** One journal record as the sessions and tests read it, or `undefined` when absent. */
  getAction(id: number): StoredActionRecord | undefined {
    const record = this.journal.get(id);
    if (record === undefined) return undefined;
    const view = {
      id,
      action: toViewAction(record.action),
      submittedAt: (record.action.payload as PayloadMeta).submittedAt ?? 0,
    };
    switch (record.state) {
      case "failed":
        return { ...view, state: "failed", failure: record.error };
      case "applied": {
        const meta = record.action.payload as PayloadMeta;
        return {
          ...view,
          state: "applied",
          ...(meta.createdContentId !== undefined ? { createdContentId: meta.createdContentId } : {}),
          ...(meta.createdAttachmentId !== undefined
            ? { createdAttachmentId: meta.createdAttachmentId } : {}),
        };
      }
      default:
        return { ...view, state: record.state === "staged" ? "pending" : record.state };
    }
  }

  /** Pending and claimed actions, projected onto reads in ID order. */
  pendingActions(): StoredActionRecord[] {
    return this.journal.listPending().map(simView);
  }

  /** Pending actions targeting a piece of content (addressed by either provisional or real ID). */
  pendingForContent(contentId: string): StoredActionRecord[] {
    const target = this.resolveId(contentId);
    return this.pendingActions().filter(r => {
      const t = actionContentId(r.action);
      return t !== null && this.resolveId(t) === target;
    });
  }

  // --- attachment files ---

  /**
   * Retains upload bytes for a pending action. Files no pending action references (a staging that
   * failed after capture, or an apply cut short before releasing them) are swept first, once old
   * enough that no in-flight staging could still be about to reference them.
   */
  captureAttachment(data: Uint8Array): Promise<ActionFileReference> {
    const referenced = new Set<string>();
    for (const { action } of this.pendingActions()) {
      // Legacy inline records have no `file`; nothing of theirs lives in the chunk store.
      if (action.type === "uploadAttachment" && action.file) referenced.add(action.file.handle);
    }
    this.#files.pruneUnreferenced(referenced, Date.now() - ATTACHMENT_FILE_GRACE_MS);
    return this.#files.capture(data);
  }

  readAttachment(action: UploadAttachmentAction): Promise<Uint8Array> {
    const inline = (action as { data?: unknown }).data;
    return inline instanceof Uint8Array ? Promise.resolve(inline) : this.#files.read(action.file);
  }

  releaseAttachment(action: UploadAttachmentAction): void {
    this.#files.delete(action.file);
  }

  // --- provisional ID resolution ---

  static isProvisional(id: string): boolean {
    return id.startsWith("~");
  }

  setProvisional(provisionalId: string, realId: string): void {
    this.#kv.put(`prov:${provisionalId}`, realId);
  }

  resolveId(id: string): string {
    if (!ConfluenceStore.isProvisional(id)) return id;
    return this.#kv.get<string>(`prov:${id}`) ?? id;
  }

  knowsProvisional(id: string): boolean {
    if (this.resolveId(id) !== id) return true;
    return this.pendingActions().some(r => r.action.type === "createContent" && r.action.provisionalId === id);
  }

  createActionFor(provisionalId: string): StoredActionRecord | undefined {
    return this.pendingActions().find(
      r => r.action.type === "createContent" && r.action.provisionalId === provisionalId);
  }

  // --- cached base reads ---

  async getContentResponse(id: string, bypassCache = false): Promise<ContentResponse> {
    const realId = this.resolveId(id);
    if (!bypassCache) {
      const cached = this.#kv.get<ContentCache>(`cache:content:${realId}`);
      if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.content;
    }
    const content = await this.#api.getContentById(realId);
    this.#kv.put<ContentCache>(`cache:content:${realId}`, { fetchedAt: Date.now(), content });
    return content;
  }

  /** The kind (page vs blog post) of a piece of content, resolved (and cached) via its response. */
  async getContentKind(id: string): Promise<ContentType> {
    return contentKindOf(await this.getContentResponse(id));
  }

  /** Resolve a space key to its numeric v2 space ID (cached). */
  async getSpaceId(key: string): Promise<string> {
    const cached = this.#kv.get<string>(`space:${key}`);
    if (cached) return cached;
    const space = await this.#api.getSpaceByKey(key);
    this.#kv.put(`space:${key}`, space.id);
    return space.id;
  }

  invalidateContent(id: string): void {
    this.#kv.delete(`cache:content:${this.resolveId(id)}`);
  }
}

const contentKindOf = (c: ContentResponse): ContentType => (c.type === "blogpost" ? "blogpost" : "page");

// ---------------------------------------------------------------------------------------------
// Simulation: overlay pending actions onto base reads.

/** The effective title after applying pending records (setTitle / createContent). */
export function simulateTitle(records: StoredActionRecord[], baseTitle: string): string {
  let title = baseTitle;
  for (const r of records) {
    if (r.action.type === "setTitle") title = r.action.title;
    else if (r.action.type === "createContent") title = r.action.title;
  }
  return title;
}

/** The effective body Markdown after applying pending records. `base` is null for provisional content. */
export function simulateBody(base: string | null, records: StoredActionRecord[]): string {
  let body = base ?? "";
  for (const r of records) {
    const a = r.action;
    if (a.type === "setContent") body = a.markdown;
    else if (a.type === "appendContent") body = body ? `${body}\n\n${a.markdown}` : a.markdown;
    else if (a.type === "createContent" && base === null && a.content) body = a.content;
  }
  return body;
}

/** The effective label set after applying pending add/removeLabel records. */
export function simulateLabels(base: string[], records: StoredActionRecord[]): string[] {
  const labels = [...base];
  for (const r of records) {
    if (r.action.type === "addLabel") {
      if (!labels.includes(r.action.name)) labels.push(r.action.name);
    } else if (r.action.type === "removeLabel") {
      const i = labels.indexOf(r.action.name);
      if (i >= 0) labels.splice(i, 1);
    }
  }
  return labels;
}

/** Base comments plus pending ones (only appended on the first page to avoid duplication). */
export function simulateComments(base: Comment[], records: StoredActionRecord[]): Comment[] {
  const out = [...base];
  for (const r of records) {
    if (r.action.type === "addComment") {
      out.push({ id: `~comment-${r.id}`, text: r.action.text, author: null, createdAt: new Date(r.submittedAt) });
    }
  }
  return out;
}

/** The effective trashed state implied by pending trash/restore actions, or undefined if untouched. */
export function simulateTrashed(records: StoredActionRecord[]): boolean | undefined {
  let state: boolean | undefined;
  for (const r of records) {
    if (r.action.type === "trash") state = true;
    else if (r.action.type === "restore") state = false;
  }
  return state;
}

// A summary for a provisional (not-yet-created) piece of content.
function provisionalSummary(record: StoredActionRecord, store: ConfluenceStore): ContentSummary {
  const a = record.action;
  if (a.type !== "createContent") throw new Error("not a create action");
  const records = store.pendingForContent(a.provisionalId);
  return {
    id: a.provisionalId,
    type: a.kind,
    title: simulateTitle(records, a.title),
    spaceKey: a.parent.spaceKey,
    url: `${store.api.webBase}/pages/${a.provisionalId}`,
    status: a.status === "draft" ? "draft" : "current",
    createdAt: new Date(record.submittedAt),
    lastUpdatedAt: new Date(record.submittedAt),
  };
}

// Drop base items that are pending-trashed and append provisional creations matching `keep`.
function overlayList(
  base: ContentSummary[],
  store: ConfluenceStore,
  keep: (action: Extract<ConfluenceAction, { type: "createContent" }>) => boolean,
  includeProvisional: boolean,
): ContentSummary[] {
  const pending = store.pendingActions();
  const keptIds = new Set(
    pending
      .filter(r => r.action.type === "createContent" && keep(r.action))
      .map(r => (r.action as Extract<ConfluenceAction, { type: "createContent" }>).provisionalId));
  const trashed = new Set(
    pending.flatMap(r => r.action.type === "trash" ? [r.action.contentId] : []));
  return [
    ...base.filter(c => !trashed.has(c.id) && !keptIds.has(c.id)),
    ...(includeProvisional
      ? pending
          .filter(r => r.action.type === "createContent" && keep(r.action))
          .map(r => provisionalSummary(r, store))
      : []),
  ];
}

/** Overlay for a space's content listing (pages or blog posts). */
export function overlaySpaceContent(
  base: ContentSummary[], store: ConfluenceStore, spaceKey: string, type: ContentType, firstPage: boolean,
): ContentSummary[] {
  return overlayList(base, store, a =>
    a.kind === type && a.parent.spaceKey === spaceKey && a.parent.type === "space", firstPage);
}

/** Overlay for a page's child-page listing. */
export function overlayChildPages(
  base: ContentSummary[], store: ConfluenceStore, parentId: string, firstPage: boolean,
): ContentSummary[] {
  return overlayList(base, store, a =>
    a.parent.type === "page" && store.resolveId(a.parent.parentId) === store.resolveId(parentId),
  firstPage);
}

/** Overlay for search results. */
export function overlaySearch(
  base: ContentSummary[], store: ConfluenceStore, firstPage: boolean, typeFilter?: ContentType,
): ContentSummary[] {
  return overlayList(base, store, a => !typeFilter || a.kind === typeFilter, firstPage);
}

// ---------------------------------------------------------------------------------------------
// Observation / action descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

// ---------------------------------------------------------------------------------------------
// Staging / apply / reject / revert: thin seams over the engine, keeping the DO's call shapes

/**
 * Record a pending action and submit it for approval. The engine's staging owns the lost-reply
 * guard (a record the overseer proved it received is kept; one still staged is rolled back). A
 * rolled-back upload's staged bytes are released here, since the engine removes the record without
 * the reject hook.
 */
export async function stageAction(
  store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, action: ConfluenceAction,
): Promise<number> {
  const { type, ...payload } = action;
  try {
    return await store.actionSet.submit(
      approvalQueue, type, { ...payload, submittedAt: Date.now() } as ConfluenceKinds[Kind]);
  } catch (error) {
    if (action.type === "uploadAttachment"
        && !store.pendingActions().some(r =>
          r.action.type === "uploadAttachment" && r.action.file?.handle === action.file.handle)) {
      store.releaseAttachment(action);
    }
    throw error;
  }
}

/** Applies an approved action through the engine's claim/retry/unknown-outcome loop. */
export async function applyStoredAction(store: ConfluenceStore, id: number): Promise<void> {
  await store.actionSet.apply(id);
}

// Pending actions stranded by rejecting a creation: everything targeting the (now-nonexistent)
// content, transitively through child creations under it. The engine marks these terminally
// failed; this computes whether there were any, for the restart hint.
function pendingDependents(store: ConfluenceStore, provisionalId: string): StoredActionRecord[] {
  const pending = store.pendingActions().filter(
    r => !(r.action.type === "createContent" && r.action.provisionalId === provisionalId));
  const dead = new Set<string>([provisionalId]);
  for (;;) {
    let added = false;
    for (const r of pending) {
      if (r.action.type === "createContent" && r.action.parent.type === "page"
          && dead.has(r.action.parent.parentId) && !dead.has(r.action.provisionalId)) {
        dead.add(r.action.provisionalId);
        added = true;
      }
    }
    if (!added) break;
  }
  return pending.filter(r => {
    const t = actionContentId(r.action);
    return t !== null && dead.has(t);
  });
}

/**
 * Rejects an action: the engine removes the record, releases what staging set up (an upload's
 * bytes), and strands — rather than silently deleting — actions left targeting content a rejected
 * creation never made; those become terminal failures the user can clear. `restart` is requested
 * exactly when rejecting leaves the session's view unable to settle without one: dependents of a
 * rejected creation, or sibling actions still pending on the same content.
 */
export async function rejectStoredAction(store: ConfluenceStore, id: number): Promise<void | { restart?: boolean }> {
  const record = store.getAction(id);
  if (record === undefined) return;
  let restart = record.action.type === "createContent"
    && pendingDependents(store, record.action.provisionalId).length > 0;
  await store.actionSet.reject(id);
  if (!restart) {
    const target = actionContentId(record.action);
    restart = target !== null && store.pendingForContent(target).length > 0;
  }
  return restart ? { restart: true } : undefined;
}

type RevertResult = void | { message?: string; canRetry?: boolean; restart?: boolean };

/**
 * Reverts an applied action. The retained record carries what revert needs (previous values,
 * created ids); a successful revert removes it — the engine has no "reverted" state, and removal
 * matches the old semantics where a settled revert stopped blocking older reverts.
 */
export async function revertStoredAction(store: ConfluenceStore, id: number): Promise<RevertResult> {
  const record = store.getAction(id);
  if (record === undefined) throw new Error(`Unknown action: ${id}`);

  const result = await revertAction(store, record);
  // A returned message means the undo couldn't be performed; leave the record applied.
  if (!(result && "message" in result)) store.journal.remove(id);
  return result;
}

async function revertAction(store: ConfluenceStore, record: StoredActionRecord): Promise<RevertResult> {
  const api = store.api;
  const action = record.action;

  switch (action.type) {
    case "createContent":
      if (record.createdContentId) await api.trashContent(record.createdContentId, action.kind);
      return;
    case "setContent":
    case "appendContent": {
      if (action.type === "appendContent" && action.previousMarkdown === undefined) {
        return { message: "Cannot automatically revert this append (the prior content was not captured)." };
      }
      const id2 = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id2, true);
      await api.updateContent({
        id: id2,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: markdownToStorage(action.previousMarkdown ?? ""),
        status: preservedStatus(current),
      });
      store.invalidateContent(id2);
      return;
    }
    case "setTitle": {
      const id2 = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id2, true);
      await api.updateContent({
        id: id2,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: action.previousTitle,
        version: (current.version?.number ?? 1) + 1,
        storageValue: current.body?.storage?.value ?? "",
        status: preservedStatus(current),
      });
      store.invalidateContent(id2);
      return;
    }
    case "addComment":
      if (record.createdContentId) await api.deleteComment(record.createdContentId);
      return;
    case "addLabel":
      await api.removeLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      return;
    case "removeLabel":
      await api.addLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      return;
    case "uploadAttachment":
      if (record.createdAttachmentId) await api.deleteAttachment(record.createdAttachmentId);
      return;
    case "trash":
      await api.restoreContent(requireResolved(store, action.contentId));
      store.invalidateContent(action.contentId);
      return;
    case "restore": {
      const id = requireResolved(store, action.contentId);
      await api.trashContent(id, await store.getContentKind(id));
      store.invalidateContent(action.contentId);
      return;
    }
  }
}

// Re-exports used by sessions for base reads.
export { contentBodyMarkdown, contentToSummary, storageToMarkdown };
