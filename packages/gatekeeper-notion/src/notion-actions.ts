// Phase 2 machinery for the Notion gatekeeper: pending-action storage, provisional IDs for
// not-yet-created pages, response caching, action simulation (so reads reflect pending writes),
// and the apply/revert logic invoked by the gatekeeper DO.
//
// Design: we cache the *base* truth fetched from Notion (with a short TTL) and overlay the list of
// pending (submitted-but-not-yet-applied) actions at read time. submitAction() records an action
// and leaves the base cache untouched; applyAction() performs the real API call and invalidates the
// affected cache entries; rejectAction() simply drops the record so the overlay recomputes without
// it. This keeps cache and simulation cleanly separated.

import {
  NotionApi,
  blocksToMarkdown,
  iconInputToNotion,
  isNotionOutcomeUnknown,
  markdownToBlocks,
  notionUrlFromId,
  databaseSchema,
  itemResponseToSummary,
  pageToMetadata,
  pageToSummary,
  plainToRichText,
  primaryDataSourceId,
  propertiesToValues,
  propertyInputsToNotion,
  type BlockWithChildren,
  type NotionDataSourceResponse,
  type NotionDatabaseResponse,
  type NotionPageResponse,
} from "./notion-api";
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
  type JournalRecord,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription, ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  NotionComment,
  NotionDatabaseSchema,
  NotionIconInput,
  NotionItemSummary,
  NotionPageMetadata,
  NotionPageSummary,
  NotionPropertyInput,
  NotionPropertyValue,
  NotionUser,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type NotionActionParent =
  | { kind: "page"; pageId: string }
  | { kind: "database"; databaseId: string }
  // The page a workspace-level page is created under, chosen when the action is staged so the
  // approver sees it. Absent on records staged before that, which choose it when applied.
  | { kind: "workspace"; pageId?: string; title?: string };

export type NotionAction =
  | { type: "appendContent"; pageId: string; markdown: string }
  | { type: "setTitle"; pageId: string; title: string; previousTitle: string }
  | {
      type: "setProperties";
      pageId: string;
      properties: Record<string, NotionPropertyInput>;
      previousProperties: Record<string, NotionPropertyInput>;
    }
  | { type: "setIcon"; pageId: string; icon: NotionIconInput | null; previousIcon: NotionIconInput | null }
  | { type: "archive"; pageId: string }
  | { type: "restore"; pageId: string }
  | { type: "addComment"; pageId: string; text: string }
  | {
      type: "createPage";
      provisionalId: string;
      parent: NotionActionParent;
      title?: string;
      properties?: Record<string, NotionPropertyInput>;
      content?: string;
      icon?: NotionIconInput;
      /** The parent data source's title column name (e.g. "Name"), so simulated reads key the
       *  title correctly before approval. Absent for non-database parents. */
      titlePropertyName?: string;
    };

export type StoredActionRecord = {
  id: number;
  action: NotionAction;
  /**
   * Lifecycle of a stored action. `claimed` marks the window where the Notion call is in
   * flight: the claim is written before the call, so any later attempt that finds it knows a
   * previous dispatch may have applied and refuses to run again. `failed` is terminal — its
   * `failure` explains itself — and is cleared by a rejection.
   */
  state: "pending" | "claimed" | "applied" | "failed" | "reverted";
  submittedAt: number;
  /** For appendContent revert: the IDs of the blocks created on apply. */
  appendedBlockIds?: string[];
  /** For createPage: the real Notion page ID assigned on apply. */
  createdPageId?: string;
  /** For state "failed": why, and what to answer later attempts with. */
  failure?: string;
};

// The page (provisional or real) an action targets, or null for actions that don't target a page.
function actionPageId(action: NotionAction): string | null {
  if (action.type === "createPage") return action.provisionalId;
  return action.pageId;
}

/** The payload a kind stores: the session-facing action without its discriminator, plus when it
 *  was staged (the simulation views timestamp synthetic pages with it) and the effects apply
 *  records on it (for revert and the views). */
export type NotionKinds = {
  [K in NotionAction as K["type"]]: Omit<K, "type"> & {
    /** When the action was staged, for the synthetic entries the overlays create. */
    submittedAt: number;
    /** For appendContent revert: the IDs of the blocks created on apply. */
    appendedBlockIds?: string[];
    /** For createPage: the real Notion page ID assigned on apply. */
    createdPageId?: string;
  };
};

/** A journal entry as the record-shaped view the simulation and revert helpers consume. */
function recordView(
  id: number,
  action: TaggedAction<NotionKinds>,
  state: JournalRecord<TaggedAction<NotionKinds>>["state"],
): StoredActionRecord {
  const { kind, payload } = action;
  return {
    id,
    action: { type: kind, ...payload } as NotionAction,
    state: state === "staged" ? "pending" : state,
    submittedAt: (payload as { submittedAt?: number }).submittedAt ?? 0,
  };
}

// True when an action's target page resolves to the given (already-resolved) page id.
function resolvesTo(store: NotionStore, action: NotionAction, target: string): boolean {
  const t = actionPageId(action);
  return t !== null && store.resolveId(t) === target;
}

// ---------------------------------------------------------------------------------------------
// Action lifecycle (the kit's `defineActions` engine over the `ActionJournal` this port already
// kept, on its pre-journal keys) + response caching. The pending set below is the journal's
// pending projection; `prov:` rows map a created page's provisional id to its real one.

type Kv = DurableObjectStorage["kv"];

const PAGE_TTL_MS = 30_000;
const CONTENT_TTL_MS = 30_000;
const DB_TTL_MS = 60_000;
const USER_TTL_MS = 60 * 60_000;

type PageCache = { fetchedAt: number; page: NotionPageResponse };
type ContentCache = { fetchedAt: number; markdown: string };
type DbCache = { fetchedAt: number; db: NotionDatabaseResponse };
type DataSourceCache = { fetchedAt: number; dataSource: NotionDataSourceResponse };

export class NotionStore {
  #kv: Kv;
  #api: NotionApi;

  constructor(kv: Kv, api: NotionApi) {
    this.#kv = kv;
    this.#api = api;
  }

  get api(): NotionApi {
    return this.#api;
  }

  /**
   * The action lifecycle shared by this storage's sessions and RPCs: one journal (one submission
   * lane, one resolution queue) per object storage, from the kit's memo. The host is this store —
   * the handlers drive its API client and caches.
   */
  get lifecycle(): { journal: ActionJournal<TaggedAction<NotionKinds>>; set: BoundActionSet<NotionKinds> } {
    return notionActions(this.#kv, this);
  }

  nextProvisionalId(): string {
    const n = this.#kv.get<number>("seq:provisional") ?? 1;
    this.#kv.put("seq:provisional", n + 1);
    return `~${n}`;
  }

  /**
   * Every action this storage holds as a {@link StoredActionRecord} view: pending and claimed
   * (the simulation overlay's inputs), held failures, and applied records retained for revert.
   * Ordered by id.
   */
  allActions(): StoredActionRecord[] {
    const views = [
      ...this.lifecycle.journal.listPending().map((e) => recordView(e.id, e.action, "pending")),
      ...this.lifecycle.journal.listFailed().map((e) => recordView(e.id, e.action, "failed")),
      ...this.retainedRecords(),
    ];
    return views.toSorted((a, b) => a.id - b.id);
  }

  /** Applied records, retained for revert, oldest page first. */
  retainedRecords(): StoredActionRecord[] {
    const views: StoredActionRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = this.lifecycle.journal.listRetained({ limit: 100, cursor });
      for (const entry of page.entries) {
        views.push(recordView(entry.id, entry.action, "applied"));
      }
      if (page.nextCursor === undefined) return views;
      cursor = page.nextCursor;
    }
  }

  /**
   * Pending actions targeting a specific page, in submission order. The page may be addressed by
   * either its provisional id or its real id (the same page can be reached both ways once a creation
   * has been applied), so we compare *resolved* IDs on both sides.
   */
  pendingForPage(pageId: string): StoredActionRecord[] {
    const target = this.resolveId(pageId);
    return this.allActions().filter((r) =>
      (r.state === "pending" || r.state === "claimed") && resolvesTo(this, r.action, target));
  }

  /** Pending and claimed actions, in submission order — the simulation overlay's input set. */
  pendingActions(): StoredActionRecord[] {
    return this.allActions().filter((r) => r.state === "pending" || r.state === "claimed");
  }

  // --- provisional ID resolution ---

  static isProvisional(id: string): boolean {
    return id.startsWith("~");
  }

  setProvisional(provisionalId: string, realId: string): void {
    this.#kv.put(`prov:${provisionalId}`, realId);
  }

  /** Resolve a (possibly provisional) ID to a real Notion ID, if the creating action has applied. */
  resolveId(id: string): string {
    if (!NotionStore.isProvisional(id)) return id;
    return this.#kv.get<string>(`prov:${id}`) ?? id;
  }

  /**
   * True if this provisional ID belongs to a page created in this session (still pending or already
   * applied). Lets getPage() rehydrate a provisional handle.
   */
  knowsProvisional(id: string): boolean {
    if (this.resolveId(id) !== id) return true; // already applied -> real ID mapped
    return this.lifecycle.journal.listPending().some(({ action }) =>
      action.kind === "createPage" && action.payload.provisionalId === id);
  }

  /** The createPage action for a provisional ID, if any. */
  createActionFor(provisionalId: string): StoredActionRecord | undefined {
    return this.lifecycle.journal.listPending().map(({ id, action }) =>
      recordView(id, action, "pending")).find(
      (r) => r.action.type === "createPage" && r.action.provisionalId === provisionalId);
  }

  // --- base data fetch with caching ---

  async getPageResponse(id: string, bypassCache = false): Promise<NotionPageResponse> {
    const realId = this.resolveId(id);
    if (!bypassCache) {
      const cached = this.#kv.get<PageCache>(`cache:page:${realId}`);
      if (cached && Date.now() - cached.fetchedAt < PAGE_TTL_MS) return cached.page;
    }
    const page = await this.#api.retrievePage(realId);
    this.#kv.put<PageCache>(`cache:page:${realId}`, { fetchedAt: Date.now(), page });
    return page;
  }

  async getPageContent(id: string): Promise<string> {
    const realId = this.resolveId(id);
    const cached = this.#kv.get<ContentCache>(`cache:content:${realId}`);
    if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.markdown;
    const tree = await this.#api.fetchBlockTree(realId);
    const markdown = blocksToMarkdown(tree);
    this.#kv.put<ContentCache>(`cache:content:${realId}`, { fetchedAt: Date.now(), markdown });
    return markdown;
  }

  /**
   * Resolve a user to its full form (name/avatar/email), cached — page metadata only includes
   * partial `{id}` users, unlike property values.
   */
  async getUser(id: string): Promise<NotionUser> {
    const cached = this.#kv.get<{ fetchedAt: number; user: NotionUser }>(`cache:user:${id}`);
    if (cached && Date.now() - cached.fetchedAt < USER_TTL_MS) return cached.user;
    const user = await this.#api.retrieveUser(id);
    this.#kv.put(`cache:user:${id}`, { fetchedAt: Date.now(), user });
    return user;
  }

  async getDatabaseResponse(id: string): Promise<NotionDatabaseResponse> {
    const realId = this.resolveId(id);
    const cached = this.#kv.get<DbCache>(`cache:db:${realId}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.db;
    const db = await this.#api.retrieveDatabase(realId);
    this.#kv.put<DbCache>(`cache:db:${realId}`, { fetchedAt: Date.now(), db });
    return db;
  }

  /** The primary data source ID for a database (cached via the database response). */
  async getDataSourceId(databaseId: string): Promise<string> {
    return primaryDataSourceId(await this.getDatabaseResponse(databaseId));
  }

  async getDataSourceResponse(dataSourceId: string): Promise<NotionDataSourceResponse> {
    const cached = this.#kv.get<DataSourceCache>(`cache:ds:${dataSourceId}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.dataSource;
    const dataSource = await this.#api.retrieveDataSource(dataSourceId);
    this.#kv.put<DataSourceCache>(`cache:ds:${dataSourceId}`, { fetchedAt: Date.now(), dataSource });
    return dataSource;
  }

  /** The row schema for a database, read from its primary data source. */
  async getDatabaseSchema(databaseId: string): Promise<NotionDatabaseSchema> {
    const dataSourceId = await this.getDataSourceId(databaseId);
    return databaseSchema(await this.getDataSourceResponse(dataSourceId));
  }

  invalidatePage(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:page:${realId}`);
  }

  invalidateContent(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:content:${realId}`);
  }

  invalidateDatabase(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:db:${realId}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Conversions used by simulation

// The empty/default value Notion gives a column when a row is created without setting it, so a
// pending row's property set matches the shape of an approved row.
function defaultValueForType(type: NotionPropertyValue["type"]): NotionPropertyValue {
  switch (type) {
    case "title": return { type: "title", text: "" };
    case "rich_text": return { type: "rich_text", text: "" };
    case "number": return { type: "number", number: null };
    case "select": return { type: "select", option: null };
    case "multi_select": return { type: "multi_select", options: [] };
    case "status": return { type: "status", status: null };
    case "date": return { type: "date", start: null, end: null };
    case "checkbox": return { type: "checkbox", checked: false };
    case "url": return { type: "url", url: null };
    case "email": return { type: "email", email: null };
    case "phone_number": return { type: "phone_number", phoneNumber: null };
    case "people": return { type: "people", people: [] };
    case "relation": return { type: "relation", pageIds: [] };
    case "files": return { type: "files", files: [] };
    case "formula": return { type: "formula", value: null };
    case "rollup": return { type: "rollup", summary: "" };
    case "unique_id": return { type: "unique_id", value: "" };
    case "created_time": return { type: "created_time", time: new Date() };
    case "last_edited_time": return { type: "last_edited_time", time: new Date() };
    case "created_by": return { type: "created_by", user: null };
    case "last_edited_by": return { type: "last_edited_by", user: null };
    default: return { type: "unsupported", rawType: String(type) };
  }
}

/**
 * All columns of a schema with their default (empty) values, used to seed a pending row so it has
 * the same property keys an approved row would.
 */
export function defaultPropertiesFromSchema(schema: NotionDatabaseSchema): Record<string, NotionPropertyValue> {
  const props: Record<string, NotionPropertyValue> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    props[name] = defaultValueForType(prop.type as NotionPropertyValue["type"]);
  }
  return props;
}

// Convert a writable property input into the read value shape, so simulated reads look like real
// ones.
function inputToValue(input: NotionPropertyInput): NotionPropertyValue {
  switch (input.type) {
    case "title":
      return { type: "title", text: input.text };
    case "rich_text":
      return { type: "rich_text", text: input.text };
    case "number":
      return { type: "number", number: input.number };
    case "select":
      return { type: "select", option: input.option };
    case "multi_select":
      return { type: "multi_select", options: input.options };
    case "status":
      return { type: "status", status: input.status };
    case "date":
      return { type: "date", start: input.start, end: input.end ?? null };
    case "checkbox":
      return { type: "checkbox", checked: input.checked };
    case "url":
      return { type: "url", url: input.url };
    case "email":
      return { type: "email", email: input.email };
    case "phone_number":
      return { type: "phone_number", phoneNumber: input.phoneNumber };
    case "people":
      return { type: "people", people: input.userIds.map(id => ({ id })) };
    case "relation":
      return { type: "relation", pageIds: input.pageIds };
    case "files":
      return { type: "files", files: input.files };
  }
}

// ---------------------------------------------------------------------------------------------
// Simulation: overlay pending actions onto base reads.

// Returns the effective archived state implied by pending archive/restore actions, or undefined if
// none touch it.
function pendingArchivedState(records: StoredActionRecord[]): boolean | undefined {
  let state: boolean | undefined;
  for (const r of records) {
    if (r.action.type === "archive") state = true;
    else if (r.action.type === "restore") state = false;
  }
  return state;
}

/** Simulated page metadata. `base` is null for a provisional page that doesn't exist on Notion yet. */
export function simulatePageMetadata(
  base: NotionPageMetadata | null,
  pageId: string,
  records: StoredActionRecord[],
): NotionPageMetadata {
  let meta: NotionPageMetadata;
  if (base) {
    meta = { ...base };
  } else {
    const create = records.find(r => r.action.type === "createPage");
    const action = create?.action.type === "createPage" ? create.action : undefined;
    meta = {
      id: pageId,
      title: action?.title ?? "",
      url: notionUrlFromId(pageId),
      parent:
        action?.parent.kind === "page" ? { type: "page", pageId: action.parent.pageId }
        : action?.parent.kind === "database" ? { type: "database", databaseId: action.parent.databaseId }
        : { type: "workspace" },
      createdAt: new Date(create?.submittedAt ?? Date.now()),
      lastEditedAt: new Date(create?.submittedAt ?? Date.now()),
      createdBy: null,
      lastEditedBy: null,
      archived: false,
      locked: false,
    };
    if (action?.icon) meta.icon = iconInputDisplay(action.icon);
  }
  for (const r of records) {
    const a = r.action;
    if (a.type === "setIcon") meta.icon = a.icon ? iconInputDisplay(a.icon) : undefined;
    else if (a.type === "archive") meta.archived = true;
    else if (a.type === "restore") meta.archived = false;
  }
  // Title can be set via setTitle, the create `title`, or a title-typed property; derive it uniformly.
  meta.title = simulatedTitle(records, meta.title);
  return meta;
}

/**
 * The effective page title after applying pending records, considering every way a title can be
 * set: setTitle(), createPage `title`, and a `title`-typed property in createPage/setProperties.
 */
export function simulatedTitle(records: StoredActionRecord[], baseTitle: string): string {
  let title = baseTitle;
  for (const r of records) {
    const a = r.action;
    if (a.type === "setTitle") {
      title = a.title;
    } else if (a.type === "createPage") {
      if (a.title !== undefined) title = a.title;
      const tp = Object.values(a.properties ?? {}).find(p => p.type === "title");
      if (tp && tp.type === "title") title = tp.text;
    } else if (a.type === "setProperties") {
      const tp = Object.values(a.properties).find(p => p.type === "title");
      if (tp && tp.type === "title") title = tp.text;
    }
  }
  return title;
}

function iconInputDisplay(icon: NotionIconInput): string {
  return "emoji" in icon ? icon.emoji : icon.imageUrl;
}

/**
 * Simulated page property values. For a provisional page (`base` null), `seed` supplies the
 * parent database's full column set with default values so the shape matches an approved row.
 */
export function simulatePageProperties(
  base: Record<string, NotionPropertyValue> | null,
  records: StoredActionRecord[],
  seed?: Record<string, NotionPropertyValue>,
): Record<string, NotionPropertyValue> {
  const props: Record<string, NotionPropertyValue> = base ? { ...base } : { ...seed };
  // The title column name for a provisional row: prefer the create action's recorded data-source
  // title column (e.g. "Name") so the simulated shape matches the post-approval shape.
  const create = records.find(r => r.action.type === "createPage");
  const titleKey = create?.action.type === "createPage" ? create.action.titlePropertyName : undefined;
  // Seed provisional pages from their create action.
  if (!base && create?.action.type === "createPage") {
    for (const [name, input] of Object.entries(create.action.properties ?? {})) {
      props[name] = inputToValue(input);
    }
    if (create.action.title !== undefined) setTitleValue(props, create.action.title, titleKey);
  }
  for (const r of records) {
    const a = r.action;
    if (a.type === "setProperties") {
      for (const [name, input] of Object.entries(a.properties)) props[name] = inputToValue(input);
    } else if (a.type === "setTitle") {
      setTitleValue(props, a.title, titleKey);
    }
  }
  return props;
}

function setTitleValue(
  props: Record<string, NotionPropertyValue>,
  title: string,
  titleKey?: string,
): void {
  const entry = Object.entries(props).find(([, v]) => v.type === "title");
  if (entry) props[entry[0]] = { type: "title", text: title };
  else props[titleKey ?? "title"] = { type: "title", text: title };
}

// Run Markdown through the same Markdown -> Notion blocks -> Markdown round-trip that an apply +
// read-back would, so the simulation reflects the (lossy) conversion (heading clamp, `*` -> `-`,
// nested lists flattened, tables/blank lines collapsed, etc.) rather than echoing the raw input.
function normalizeAppendedMarkdown(markdown: string): string {
  const blocks = markdownToBlocks(markdown) as Array<Record<string, unknown>>;
  return blocksToMarkdown(blocks.map(block => ({ block: block as BlockWithChildren["block"] })));
}

/** Simulated page body Markdown. */
export function simulatePageContent(
  base: string | null,
  records: StoredActionRecord[],
): string {
  const parts: string[] = [];
  if (base) parts.push(base);
  for (const r of records) {
    const a = r.action;
    if (a.type === "createPage" && !base && a.content) parts.push(normalizeAppendedMarkdown(a.content));
    else if (a.type === "appendContent") parts.push(normalizeAppendedMarkdown(a.markdown));
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Simulated comment list (base comments plus pending ones). */
export function simulateComments(
  base: NotionComment[],
  records: StoredActionRecord[],
): NotionComment[] {
  const out = [...base];
  for (const r of records) {
    if (r.action.type === "addComment") {
      out.push({
        id: `~comment-${r.id}`,
        text: r.action.text,
        author: null,
        createdAt: new Date(r.submittedAt),
      });
    }
  }
  return out;
}

// Build a page summary for a pending (not-yet-created) page, folding in any subsequent pending
// edits to that provisional page (setProperties/setTitle) so the row reflects the latest state.
function createdPageSummary(
  record: StoredActionRecord,
  store: NotionStore,
  seed?: Record<string, NotionPropertyValue>,
): NotionPageSummary {
  const action = record.action;
  if (action.type !== "createPage") throw new Error("not a createPage action");
  const records = store.pendingForPage(action.provisionalId);
  const properties = simulatePageProperties(null, records, seed);
  const meta = simulatePageMetadata(null, action.provisionalId, records);
  return {
    id: action.provisionalId,
    title: meta.title,
    url: notionUrlFromId(action.provisionalId),
    createdAt: new Date(record.submittedAt),
    lastEditedAt: new Date(meta.lastEditedAt.getTime()),
    properties,
  };
}

// Pending records targeting a given real page ID, resolving provisional IDs so that edits queued
// against a now-applied creation still match the real row.
function recordsTargeting(
  store: NotionStore,
  pending: StoredActionRecord[],
  realId: string,
): StoredActionRecord[] {
  return pending.filter(r => {
    const target = actionPageId(r.action);
    return target !== null && store.resolveId(target) === realId;
  });
}

// The pending createPage actions in scope for a list overlay, excluding ones the session also
// archived while pending.
function createdInScope(
  store: NotionStore,
  predicate: (action: Extract<NotionAction, { type: "createPage" }>) => boolean,
): StoredActionRecord[] {
  return store.pendingActions().filter(r => {
    if (r.action.type !== "createPage" || !predicate(r.action)) return false;
    return pendingArchivedState(store.pendingForPage(r.action.provisionalId)) !== true;
  });
}

/**
 * Overlay pending changes onto a batch of database query rows. `firstPage` controls whether
 * pending newly-created rows are prepended (only on the first page, to avoid duplication).
 *
 * NOTE: pending created rows ignore the query's filter and sort — they are always surfaced so the
 * agent sees its own writes. This is a documented simulation limitation.
 */
export function overlayDatabaseRows(
  rows: NotionPageSummary[],
  databaseId: string,
  store: NotionStore,
  firstPage: boolean,
  seed?: Record<string, NotionPropertyValue>,
): NotionPageSummary[] {
  const pending = store.pendingActions();
  let result = rows.map(row => {
    const records = recordsTargeting(store, pending, row.id);
    if (records.length === 0) return row;
    return {
      ...row,
      title: simulatedTitle(records, row.title),
      properties: simulatePageProperties(row.properties, records),
    };
  });
  // Drop rows archived while pending.
  result = result.filter(row => pendingArchivedState(recordsTargeting(store, pending, row.id)) !== true);
  if (firstPage) {
    const created = createdInScope(
      store,
      a => a.parent.kind === "database" && a.parent.databaseId === databaseId,
    ).map(r => createdPageSummary(r, store, seed));
    result = [...created, ...result];
  }
  return result;
}

/** Overlay pending child pages created under a page (and drop pending-archived children). */
export function overlayChildPages(
  items: NotionItemSummary[],
  parentPageId: string,
  store: NotionStore,
  firstPage: boolean,
): NotionItemSummary[] {
  const pending = store.pendingActions();
  let result = items.filter(
    item => pendingArchivedState(recordsTargeting(store, pending, item.id)) !== true,
  );
  if (firstPage) {
    const created = createdInScope(
      store,
      a => a.parent.kind === "page" && store.resolveId(a.parent.pageId) === store.resolveId(parentPageId),
    ).map(r => itemFromCreated(createdPageSummary(r, store)));
    result = [...created, ...result];
  }
  return result;
}

function itemFromCreated(summary: NotionPageSummary): NotionItemSummary {
  return {
    kind: "page",
    id: summary.id,
    title: summary.title,
    url: summary.url,
    createdAt: summary.createdAt,
    lastEditedAt: summary.lastEditedAt,
  };
}

/**
 * Overlay pending changes onto search results: drop pending-archived items, and prepend pending
 * created pages (only when the caller isn't filtering to databases, since created items are pages).
 */
export function overlaySearch(
  items: NotionItemSummary[],
  store: NotionStore,
  firstPage: boolean,
  kindFilter?: "page" | "database",
): NotionItemSummary[] {
  const pending = store.pendingActions();
  let result = items.map(item => {
    const records = recordsTargeting(store, pending, item.id);
    return records.length ? { ...item, title: simulatedTitle(records, item.title) } : item;
  });
  result = result.filter(
    item => pendingArchivedState(recordsTargeting(store, pending, item.id)) !== true,
  );
  if (firstPage && kindFilter !== "database") {
    const created = createdInScope(store, () => true).map(r => itemFromCreated(createdPageSummary(r, store)));
    result = [...created, ...result];
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Observation descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

// ---------------------------------------------------------------------------------------------
// Action descriptions

// Starts a description naming, by ID, the page an action writes to or under.
function onPage(intro: string, pageId: string, label = "Page ID"): ActionDescriptionBuilder {
  const builder = buildDescription(intro).inline(label, pageId);
  return NotionStore.isProvisional(pageId)
    ? builder.prose("An ID starting with `~` names a page created by an earlier action in this workspace.")
    : builder;
}

/**
 * The approver's text, built so every value the agent supplied (page bodies, comments, titles,
 * property values, icons) is shown in full in a field, and the completeness claim is
 * the builder's.
 */
export function describeAction(action: NotionAction): ActionDescription {
  switch (action.type) {
    case "appendContent":
      return {
        title: "Append content to Notion page",
        ...onPage("Append the following Markdown to the page body.", action.pageId)
          .verbatim("Content", action.markdown, "markdown")
          .finish(),
        implementsRevert: true,
      };
    case "setTitle":
      return {
        title: "Rename Notion page",
        ...onPage("Change the page title.", action.pageId)
          .inline("Current title", action.previousTitle)
          .inline("New title", action.title)
          .finish(),
        implementsRevert: true,
      };
    case "setProperties":
      return {
        title: "Update Notion page properties",
        ...onPage("Update the page's properties to the values below.", action.pageId)
          .json("Properties", action.properties)
          .finish(),
        implementsRevert: true,
      };
    case "setIcon":
      return {
        title: "Change Notion page icon",
        ...(action.icon
          ? onPage("Set the page icon.", action.pageId).inline("Icon", iconInputDisplay(action.icon)).finish()
          : onPage("Remove the page icon.", action.pageId).finish()),
        implementsRevert: true,
      };
    case "archive":
      return {
        title: "Move Notion page to trash",
        ...onPage("Move the page to the Notion trash (reversible).", action.pageId).finish(),
        implementsRevert: true,
      };
    case "restore":
      return {
        title: "Restore Notion page from trash",
        ...onPage("Restore the page from the Notion trash.", action.pageId).finish(),
        implementsRevert: true,
      };
    case "addComment":
      return {
        title: "Comment on Notion page",
        ...onPage("Post a comment.", action.pageId).verbatim("Comment", action.text).finish(),
        // The Notion public API can't delete comments, so this can't be reverted automatically.
        implementsRevert: false,
      };
    case "createPage": {
      const { parent } = action;
      let builder: ActionDescriptionBuilder;
      if (parent.kind === "page") {
        builder = onPage("Create a new page as a sub-page.", parent.pageId, "Parent page ID");
      } else if (parent.kind === "database") {
        builder = buildDescription("Create a new page as a database row.")
          .inline("Database ID", parent.databaseId);
      } else if (parent.pageId !== undefined) {
        // Workspace-level: the API needs a concrete parent, so the page lands under the most
        // recently edited shared page, found when the action was staged.
        builder = buildDescription(
          "Create a new page under the most recently edited shared page, chosen now (Notion has " +
          "no top-level page).")
          .inline("Parent page ID", parent.pageId)
          .inline("Parent page title", parent.title ?? "");
      } else {
        builder = buildDescription(
          "Create a new page under the most recently edited shared page, chosen when this action " +
          "is approved (Notion has no top-level page).");
      }
      builder.inline("Provisional ID", action.provisionalId);
      // The title the page is created with, as `buildCreateBody` resolves it: a database row takes
      // a title-typed entry in the properties over `title`, and the properties field shows it.
      const titleProperty = Object.values(action.properties ?? {}).some(p => p.type === "title");
      const titleOverridden = titleProperty && (parent.kind === "database" || action.title === undefined);
      if (!titleOverridden) builder.inline("Title", action.title ?? "");
      // A database row's title is written under the data source's title column, a property name
      // apply sends alongside the value.
      if (parent.kind === "database" && action.title !== undefined) {
        const key = titlePropertyKey(true, action.properties, action.titlePropertyName);
        if (key !== undefined) builder.inline("Title property", key);
      }
      if (action.properties) builder.json("Properties", action.properties);
      builder.verbatim("Content", action.content ?? "", "markdown");
      if (action.icon) builder.inline("Icon", iconInputDisplay(action.icon));
      return {
        title: "Create Notion page",
        ...builder.finish(),
        implementsRevert: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The declared lifecycle (kit defineActions) and its storage.

/**
 * Rethrows a dispatch error under the kit's terminal classification: an outcome Notion never
 * decisively answered is terminal and surfaced, never silently retried; anything else stays
 * retryable (the engine returns the record to pending, as the claim loop did).
 */
function rethrowClassified(error: unknown): never {
  if (isNotionOutcomeUnknown(error)) {
    throw new ActionOutcomeUnknownError(
      `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${error instanceof Error ? error.message : String(error)})`);
  }
  throw error;
}

/** The nine kinds' declared behavior: what the approver sees, what each consumes and creates, and
 *  the Notion dispatch that applies them. Payload effects come back as `{ action }` updates the
 *  engine persists, so revert and the simulation views see them without bespoke storage. */
const NOTION_DEFS = {
  appendContent: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["appendContent"]) =>
      describeAction({ type: "appendContent", ...payload }),
    dependsOn: (payload: NotionKinds["appendContent"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["appendContent"], store: NotionStore) {
      try {
        const ids = await store.api.appendBlockChildren(
          requireResolved(store, payload.pageId), markdownToBlocks(payload.markdown));
        store.invalidateContent(payload.pageId);
        return { action: { ...payload, appendedBlockIds: ids } };
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  setTitle: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["setTitle"]) => describeAction({ type: "setTitle", ...payload }),
    dependsOn: (payload: NotionKinds["setTitle"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["setTitle"], store: NotionStore) {
      try {
        await store.api.updatePage(requireResolved(store, payload.pageId), {
          properties: { [await titlePropName(store, payload.pageId)]: { title: plainToRichText(payload.title) } },
        });
        store.invalidatePage(payload.pageId);
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  setProperties: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["setProperties"]) =>
      describeAction({ type: "setProperties", ...payload }),
    dependsOn: (payload: NotionKinds["setProperties"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["setProperties"], store: NotionStore) {
      try {
        await store.api.updatePage(requireResolved(store, payload.pageId), {
          properties: propertyInputsToNotion(payload.properties),
        });
        store.invalidatePage(payload.pageId);
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  setIcon: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["setIcon"]) => describeAction({ type: "setIcon", ...payload }),
    dependsOn: (payload: NotionKinds["setIcon"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["setIcon"], store: NotionStore) {
      try {
        await store.api.updatePage(requireResolved(store, payload.pageId), {
          icon: payload.icon ? iconInputToNotion(payload.icon) : null,
        });
        store.invalidatePage(payload.pageId);
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  archive: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["archive"]) => describeAction({ type: "archive", ...payload }),
    dependsOn: (payload: NotionKinds["archive"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["archive"], store: NotionStore) {
      try {
        await store.api.updatePage(requireResolved(store, payload.pageId), { archived: true });
        store.invalidatePage(payload.pageId);
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  restore: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["restore"]) => describeAction({ type: "restore", ...payload }),
    dependsOn: (payload: NotionKinds["restore"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["restore"], store: NotionStore) {
      try {
        await store.api.updatePage(requireResolved(store, payload.pageId), { archived: false });
        store.invalidatePage(payload.pageId);
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  addComment: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["addComment"]) =>
      describeAction({ type: "addComment", ...payload }),
    dependsOn: (payload: NotionKinds["addComment"]) =>
      NotionStore.isProvisional(payload.pageId) ? [payload.pageId] : [],
    async apply(payload: NotionKinds["addComment"], store: NotionStore) {
      try {
        await store.api.createComment({
          parent: { page_id: requireResolved(store, payload.pageId) },
          rich_text: plainToRichText(payload.text),
        });
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
  createPage: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: (payload: NotionKinds["createPage"]) => describeAction({ type: "createPage", ...payload }),
    // The new page is addressable by its provisional id until a real one replaces it.
    provides: (payload: NotionKinds["createPage"]) => [payload.provisionalId],
    dependsOn: (payload: NotionKinds["createPage"]) =>
      payload.parent.kind === "page" && NotionStore.isProvisional(payload.parent.pageId)
        ? [payload.parent.pageId]
        : [],
    async apply(payload: NotionKinds["createPage"], store: NotionStore) {
      try {
        const parent = await resolveCreateParent(store, payload.parent);
        const body = buildCreateBody(
          parent, payload.title, payload.properties, payload.content, payload.icon,
          payload.titlePropertyName);
        const page = await store.api.createPage(body);
        // Bind immediately, then persist the effect through the engine's payload update — a crash
        // between the two still leaves the Notion page reachable for revert via the binding.
        store.setProvisional(payload.provisionalId, page.id);
        return { action: { ...payload, createdPageId: page.id } };
      } catch (error) {
        rethrowClassified(error);
      }
    },
  },
} as const satisfies NotionDefinitions;

// A set declaring dependsOn needs the host to answer whether a provisional reference has been
// bound to a real page — which is exactly the store's own resolution map.
const isResolvedReference = (store: NotionStore, ref: string): boolean =>
  store.resolveId(ref) !== ref;

/** The Notion action set options: this port's records carry no fence, so actions survive
 *  re-authorization of the same workspace; applied records stay until revert removes them. */
const NOTION_SET_OPTIONS = {
  fence: "none",
  retainApplied: true,
  vendorId: "notion",
  isResolvedReference,
} as const;

type NotionDefinitions = {
  [K in keyof NotionKinds]: ActionDefinition<NotionKinds[K], NotionStore>;
};

/**
 * Converts a legacy pre-journal row. Only records still awaiting a decision upgrade: the kit
 * coerces every converted row to pending, so anything else would come back as a re-appliable
 * ghost and must drop — a `claimed` row's dispatch was in flight when the store swapped and its
 * outcome is unknowable, so it drops like the other settled states rather than blindly
 * re-dispatching (applied pages stay reachable through their `prov:` bindings; failed and
 * reverted rows are inert).
 */
function upgradeLegacyRecord(raw: unknown): TaggedAction<NotionKinds> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { action, state } = raw as { action?: unknown; state?: unknown };
  if (typeof action !== "object" || action === null) return undefined;
  if (state !== "pending") return undefined;
  const { type, ...payload } = action as { type?: unknown };
  if (typeof type !== "string" || !(type in NOTION_DEFS)) return undefined;
  return { kind: type as keyof NotionKinds, payload } as TaggedAction<NotionKinds>;
}

/**
 * The lifecycle for one object's storage: the journal (this port's pre-journal keys, so deployed
 * records upgrade in place) and the action set bound to the first store that arrives. Hosts are
 * interchangeable — each wraps its own API client over the same token store — so first binding
 * wins, per the kit's one-journal-per-keyspace rule.
 */
const lifecycles = new WeakMap<
  ActionJournalKv,
  { journal: ActionJournal<TaggedAction<NotionKinds>>; set: BoundActionSet<NotionKinds> }
>();

/** The bound Notion lifecycle for one object's storage. */
export function notionActions(
  kv: ActionJournalKv,
  host: NotionStore,
): { journal: ActionJournal<TaggedAction<NotionKinds>>; set: BoundActionSet<NotionKinds> } {
  let memo = lifecycles.get(kv);
  if (memo === undefined) {
    const journal = new ActionJournal<TaggedAction<NotionKinds>>(kv, {
      legacyKeys: { nextIdKey: "seq:action", recordPrefix: "action:" },
      upgradeRecord: upgradeLegacyRecord,
    });
    memo = { journal, set: defineActions<NotionStore, NotionKinds>(NOTION_DEFS, NOTION_SET_OPTIONS).bind(journal, host) };
    lifecycles.set(kv, memo);
  }
  return memo;
}

/** Revert a previously-applied action. Returns guidance if the revert can't fully complete. */
export async function revertNotionAction(
  store: NotionStore,
  record: StoredActionRecord,
): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const api = store.api;
  const action = record.action;

  // For actions that revert by restoring a captured "previous" value, refuse if a newer *still-
  // applied* action touched an overlapping field on the same page — restoring would clobber it. The
  // user must revert the newer change(s) first (a successful revert clears the "applied" flag, so
  // reverting newest-first works).
  if (laterConflictingApplied(store, record)) {
    return {
      message:
        "A newer change was applied to this page after this action. Revert the newer change(s) " +
        "first, then retry — reverting now would overwrite them.",
      canRetry: true,
    };
  }

  switch (action.type) {
    case "appendContent": {
      for (const blockId of record.appendedBlockIds ?? []) {
        await api.deleteBlock(blockId);
      }
      store.invalidateContent(action.pageId);
      break;
    }
    case "setTitle": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: { [await titlePropName(store, action.pageId)]: { title: plainToRichText(action.previousTitle) } } });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setProperties": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: propertyInputsToNotion(action.previousProperties) });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setIcon": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { icon: action.previousIcon ? iconInputToNotion(action.previousIcon) : null });
      store.invalidatePage(action.pageId);
      break;
    }
    case "archive": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: false });
      store.invalidatePage(action.pageId);
      break;
    }
    case "restore": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: true });
      store.invalidatePage(action.pageId);
      break;
    }
    case "createPage": {
      if (record.createdPageId) {
        await api.updatePage(record.createdPageId, { archived: true });
        store.invalidatePage(record.createdPageId);
      }
      break;
    }
    case "addComment":
      // Can't be undone via the API; leave the record applied so it isn't treated as reverted.
      return { message: "Notion comments can't be deleted through the API; please remove the comment manually." };
  }

  // The caller drops the journal record: a successful revert must stop blocking earlier reverts
  // on the same page (the same effect the old "reverted" state had, without the tombstone).
}

// The set of logical fields an action mutates (for revert conflict detection). Actions that only
// add content (append/comment/create) return an empty set — reverting them never clobbers a field.
function mutatedFields(action: NotionAction): string[] {
  switch (action.type) {
    case "setTitle": return ["title"];
    case "setProperties": return ["title", "props"]; // may include the title property
    case "setIcon": return ["icon"];
    case "archive":
    case "restore": return ["archived"];
    default: return [];
  }
}

// True if a later (higher-ID) still-applied action mutated a field overlapping this action's, on the
// same page. Compares *resolved* IDs so an edit made through the provisional-id session and one made
// through a real-id session (after the page was created) are recognized as the same page.
// Successful reverts clear the "applied" state, so they stop counting here.
function laterConflictingApplied(store: NotionStore, record: StoredActionRecord): boolean {
  const fields = new Set(mutatedFields(record.action));
  if (fields.size === 0) return false;
  const rawTarget = actionPageId(record.action);
  if (!rawTarget) return false;
  const target = store.resolveId(rawTarget);
  return store.allActions().some(r => {
    if (r.id <= record.id || r.state !== "applied") return false;
    const t = actionPageId(r.action);
    if (t === null || store.resolveId(t) !== target) return false;
    return mutatedFields(r.action).some(f => fields.has(f));
  });
}

// ---------------------------------------------------------------------------------------------
// Apply helpers

function requireResolved(store: NotionStore, id: string): string {
  const resolved = store.resolveId(id);
  if (NotionStore.isProvisional(resolved)) {
    throw new Error(
      `Cannot apply this action yet: it targets a page (${id}) whose creation has not been ` +
      `approved. Approve the page creation first.`,
    );
  }
  return resolved;
}

type NotionCreateParent =
  | { type: "page_id"; page_id: string }
  | { type: "data_source_id"; data_source_id: string };

async function resolveCreateParent(
  store: NotionStore,
  parent: NotionActionParent,
): Promise<NotionCreateParent> {
  if (parent.kind === "page") {
    return { type: "page_id", page_id: requireResolved(store, parent.pageId) };
  }
  if (parent.kind === "database") {
    // A database row's parent is its data source (works on any API version).
    const databaseId = requireResolved(store, parent.databaseId);
    return { type: "data_source_id", data_source_id: await store.getDataSourceId(databaseId) };
  }
  // Workspace-level: the page chosen when the action was staged, or for a record staged before
  // that was recorded, the most recently edited shared page now.
  const pageId = parent.pageId ?? (await findWorkspaceParentPage(store)).id;
  return { type: "page_id", page_id: pageId };
}

/**
 * The page a workspace-level page is created under: the Notion API needs a concrete parent, so this
 * is the most recently edited page shared with the connection.
 */
export async function findWorkspaceParentPage(store: NotionStore): Promise<{ id: string; title: string }> {
  const search = await store.api.search({
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 1,
  });
  const parentPage = search.results[0];
  if (!parentPage) {
    throw new Error(
      "No writable Notion page is shared with this connection to create the page under.",
    );
  }
  const { id, title } = itemResponseToSummary(parentPage);
  return { id, title };
}

async function titlePropName(store: NotionStore, pageId: string): Promise<string> {
  const page = await store.getPageResponse(pageId, true);
  const entry = Object.entries(page.properties ?? {}).find(([, p]) => p.type === "title");
  return entry ? entry[0] : "title";
}

// The property `buildCreateBody` writes a page's `title` under. A sub-page's is always `title`. A
// database row's is the data source's title column, named by `titlePropertyName` when known and
// `Name` otherwise, or none when a title-typed entry in `properties` already supplies the title.
function titlePropertyKey(
  isDatabaseRow: boolean,
  properties: Record<string, NotionPropertyInput> | undefined,
  titlePropertyName: string | undefined,
): string | undefined {
  if (!isDatabaseRow) return "title";
  const hasTitle = properties ? Object.values(properties).some(p => p.type === "title") : false;
  return hasTitle ? undefined : titlePropertyName ?? "Name";
}

/** The Notion create-page request body for a staged `createPage` action and its resolved parent. */
export function buildCreateBody(
  parent: NotionCreateParent,
  title: string | undefined,
  properties: Record<string, NotionPropertyInput> | undefined,
  content: string | undefined,
  icon: NotionIconInput | undefined,
  titlePropertyName?: string,
): Record<string, unknown> {
  const notionProperties: Record<string, unknown> = properties
    ? propertyInputsToNotion(properties)
    : {};

  if (title !== undefined) {
    const key = titlePropertyKey(parent.type === "data_source_id", properties, titlePropertyName);
    if (key !== undefined) notionProperties[key] = { title: plainToRichText(title) };
  }

  const body: Record<string, unknown> = { parent, properties: notionProperties };
  if (icon) body["icon"] = iconInputToNotion(icon);
  if (content) body["children"] = markdownToBlocks(content);
  return body;
}

/**
 * Record a pending action and submit it to the approval queue for later approval. The engine
 * stages the record (under its pending cap), describes it for the approver, and rolls the staging
 * back if the submit fails without proof the overseer holds the id. Returns the action ID.
 */
export async function stageAction(
  store: NotionStore,
  approvalQueue: RpcStub<ApprovalQueue>,
  action: NotionAction,
): Promise<number> {
  const { type, ...payload } = action;
  return await store.lifecycle.set.submit(approvalQueue, type, {
    ...payload, submittedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------------------------
// Overseer-facing dispatch (called by the gatekeeper DO's applyAction/rejectAction/revertAction).

export async function applyStoredAction(store: NotionStore, id: number): Promise<void> {
  // The claim-state loop (settled-is-settled, terminal failure, claim-before-dispatch, outcome
  // unknown) is the kit's; the connector declared only its Notion dispatch and classifier.
  await store.lifecycle.set.apply(id);
}

export async function rejectStoredAction(store: NotionStore, id: number): Promise<void | { restart?: boolean }> {
  const record = store.lifecycle.journal.get(id);
  if (!record) return;
  // Rejecting a page creation strands every pending action that targeted that provisional page
  // (they could never be applied — the page won't exist), including sub-pages created under it and
  // their edits, transitively — the engine marks them terminally failed instead of dropping them.
  // The Gadget already observed simulated state built on them, so ask for a restart. Same for a
  // mid-stack edit: the overlay the Gadget observed is inconsistent with the remaining stack.
  const target = record.action.kind === "createPage"
    ? record.action.payload.provisionalId
    : record.action.payload.pageId;
  const restart = record.action.kind === "createPage" || store.pendingForPage(target).length > 0;
  await store.lifecycle.set.reject(id);
  return restart ? { restart: true } : undefined;
}

export async function revertStoredAction(
  store: NotionStore,
  id: number,
): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const record = store.lifecycle.journal.get(id);
  if (!record) throw new Error(`Unknown action: ${id}`);
  const result = await revertNotionAction(
    store, recordView(id, record.action, record.state === "applied" ? "applied" : "pending"));
  // A successful revert drops the record: it stops blocking earlier reverts on the same page, the
  // same effect the old "reverted" state had. Guidance results keep the record applied.
  if (result === undefined) store.lifecycle.journal.remove(id);
  return result;
}

// Re-exports used by sessions for base reads.
export { pageToMetadata, pageToSummary, propertiesToValues };
