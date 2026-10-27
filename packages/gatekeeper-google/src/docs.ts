// Google Docs gatekeeper: user-authenticated reads and approved edits of one Google Doc.
//
// Edits queue as actions through the kit's ActionJournal, under the `pending:` keys the private
// store before it wrote; each carries a writeId whose named-range marker in the document proves
// whether a dispatched write already landed, so a re-delivered apply reconciles instead of
// repeating it. See GoogleDocGatekeeperImpl for the apply protocol.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, stageAction } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline } from "@gadgets/gatekeeper-kit/action-description";
import { DocMetadata, GoogleDocSession, type GoogleDocTab } from "./docs-types";
import { errorMessage } from "./google-api";
import DOCS_TYPES_CODE from "./docs-types.txt";
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import {
  DOCS_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "./type-bundle";
import {
  BLANK_DOC_TAB_ID, BlankGoogleDoc, GoogleDocsApi, type GoogleDocReader, type GoogleDocsDocument,
  type GoogleDocsTab,
} from "./docs-api";
import {
  boundProps, createFileOnce, isSimulated, UNCREATED_FILE_ID, type SimulatedFileProps,
} from "./creation";
import {
  applyMarkdownEdit, assertMarkdownWriteComplexity, canonicalizeMarkdownForWrite,
  canonicalizeMarkdownReplacement,
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  type DocTabSnapshot, type EditableMarkdown,
} from "./markdown-converter";
import { DriveApi, isAccountWideRefusal } from "./drive-api";
import { GoogleApiError } from "./google-response";
import { driveModifiedTime } from "./drive-session";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { nativeFileUrl } from "./resources";
import { explainUnopenedFile, officeFileError, officeLabel } from "./office-conversion";
import { obsContext } from "./observability.js";

type Env = Cloudflare.Env;

const logger = obsContext.createLogger({ component: "gatekeeper.google.docs", vendorId: "google" });

let googleDocTypesCode: string | undefined;

/** Joins the Doc session surface with the read-session types agents see in getTypeScriptTypes. */
export function getGoogleDocTypesCode(): string {
  return googleDocTypesCode ??= [
    DOCS_READ_TYPES_CODE,
    stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  /**
   * The tab this edit targets. Absent only on records stored before tab support, which are
   * invalidated rather than retargeted: the first tab is not necessarily the one they meant.
   */
  tabId?: string;
  submittedAt: number;
  baseRevisionId?: string;
  writeId?: string;
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
}

type GoogleDocReplaceAction = GoogleDocActionBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocActionBase & {
  type: "appendText";
  markdown: string;
}

type GoogleDocAction = GoogleDocReplaceAction | GoogleDocAppendAction;

/**
 * Recognizes a queued edit the private store wrote as a bare payload, for the journal's legacy
 * upgrade path. That store kept only unresolved records, so anything recognizable here was
 * pending; everything else at its keys is not ours to resurrect.
 */
function isGoogleDocAction(raw: unknown): raw is GoogleDocAction {
  if (typeof raw !== "object" || raw === null) return false;
  const { type, submittedAt } = raw as Partial<GoogleDocAction>;
  return (type === "replaceText" || type === "appendText") && typeof submittedAt === "number";
}

/** Coerces a legacy bare edit row for the journal; `undefined` leaves anything else invisible. */
function upgradePendingAction(raw: unknown): GoogleDocAction | undefined {
  return isGoogleDocAction(raw) ? raw : undefined;
}

const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** The last document read, replayed for this long before its revision is rechecked. */
export const DOC_SNAPSHOT_TTL_MS = 10_000;
/** The last document read. Pending actions overlay it, so it outlives none. */
const DOC_SNAPSHOT_KEY = "docSnapshot";
/** Name prefix of the named range that marks one Gadgets write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";

type GoogleDocWriteReceipt = { actionId: number; markerId: string };

/** The document revision this binding has already reported, and when it first saw it. */
type GoogleDocMetadataRevision = { revisionId?: string; observedAt: number };
type GoogleDocNamedRange = { id: string; name: string };

function googleDocNamedRanges(tab: GoogleDocsTab): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries<unknown>(tab.namedRanges)) {
    if (!collection || typeof collection !== "object") {
      throw new Error("Google Docs returned invalid named ranges");
    }
    let ranges = (collection as { namedRanges?: unknown }).namedRanges;
    if (!Array.isArray(ranges)) {
      throw new Error("Google Docs returned invalid named ranges");
    }
    for (const range of ranges) {
      if (!range || typeof range !== "object") {
        throw new Error("Google Docs returned an invalid named range");
      }
      let {namedRangeId, name} = range as { namedRangeId?: unknown; name?: unknown };
      if (typeof namedRangeId !== "string" || namedRangeId.length === 0 ||
          (name !== undefined && typeof name !== "string")) {
        throw new Error("Google Docs returned an invalid named range");
      }
      result.push({ id: namedRangeId, name: name ?? fallbackName });
    }
  }
  return result;
}

function googleDocNamedRangeIds(tab: GoogleDocsTab, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/**
 * The write IDs whose content `tab` already contains.
 *
 * A marker and its content go up in one atomic batch, so a marker naming a write ID proves that
 * write committed — including the case where its response was lost and its action is still
 * pending. Simulating such an action over this tab would show its content twice.
 */
function googleDocCommittedWriteIds(tab: GoogleDocsTab): string[] {
  let writeIds = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name.startsWith(WRITE_MARKER_PREFIX)) {
      writeIds.add(range.name.slice(WRITE_MARKER_PREFIX.length));
    }
  }
  return [...writeIds];
}

/** One tab's Markdown rendering, tagged with the writes that tab already contains. */
export type GoogleDocTabSnapshot = DocTabSnapshot & { committedWriteIds: string[] };

/** A whole document as this gatekeeper caches it: one independent rendering per tab. */
export type GoogleDocSnapshot = {
  /** Rendering schema of `tabs`; bumped by the converter that produced them. */
  formatVersion: typeof MARKDOWN_RENDERING_VERSION;
  title: string;
  /** Absent unless the caller can edit the document; see `GoogleDocsDocument.revisionId`. */
  revisionId?: string;
  tabs: GoogleDocTabSnapshot[];
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
}

export function googleDocSnapshot(document: GoogleDocsDocument): GoogleDocSnapshot {
  return {
    formatVersion: MARKDOWN_RENDERING_VERSION,
    title: document.title,
    revisionId: document.revisionId,
    tabs: document.tabs.map(tab => ({
      ...docTabToMarkdown(tab),
      committedWriteIds: googleDocCommittedWriteIds(tab),
    })),
    fetchedAt: Date.now(),
  };
}

/** Accept a cached snapshot only if it predates nothing this code depends on. */
function isGoogleDocSnapshot(value: unknown): value is GoogleDocSnapshot {
  if (!value || typeof value !== "object") return false;
  let {formatVersion, title, tabs, revisionId, fetchedAt} = value as Partial<GoogleDocSnapshot>;
  return formatVersion === MARKDOWN_RENDERING_VERSION && typeof title === "string" &&
      Array.isArray(tabs) && (revisionId === undefined || typeof revisionId === "string") &&
      typeof fetchedAt === "number" && Number.isFinite(fetchedAt);
}

/**
 * Whether an expired snapshot still describes the current document.
 *
 * Google withholds `revisionId` from a caller without edit access, leaving no change token, so
 * such a document is refetched rather than spending a request on an answer that could never
 * confirm the cache.
 */
export async function googleDocRevisionUnchanged(
  docsApi: GoogleDocReader,
  documentId: string,
  cached: GoogleDocSnapshot,
): Promise<boolean> {
  return cached.revisionId !== undefined &&
      await docsApi.getRevisionId(documentId) === cached.revisionId;
}

/**
 * The tab an operation names, or a failure telling the agent how to name one.
 *
 * Omission is resolved from the flattened tab list, so a single root with any child counts as
 * multi-tab. An unknown ID never falls back to the first tab: the caller meant a specific one.
 */
export function resolveGoogleDocTab(
  snapshot: GoogleDocSnapshot,
  tabId: string | undefined,
  operation: "getContent" | "replaceText" | "appendText",
): GoogleDocTabSnapshot {
  if (tabId === undefined) {
    if (snapshot.tabs.length !== 1) {
      throw new Error(
        `${operation}: tabId is required for documents with multiple tabs. ` +
        `Call listTabs() to choose a tab.`);
    }
    return snapshot.tabs[0];
  }
  let tab = snapshot.tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(
      `${operation}: no tab with ID "${tabId}" exists in this document. ` +
      `Call listTabs() to refresh the tab list.`);
  }
  return tab;
}

/** The agent-facing view of one tab: identity and position, never content. */
export function googleDocTabMetadata(tab: DocTabSnapshot): GoogleDocTab {
  return {
    id: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
  };
}

/**
 * How a tab is named in approval and observation text.
 *
 * The ID is included because it is what the write actually targets: titles are user-authored,
 * are not required to be unique, and may be empty. The title sits in prose, so it is flattened
 * with `plainInline` and cannot open Markdown or HTML structure there.
 */
export function googleDocTabLabel(tab: DocTabSnapshot): string {
  return `"${plainInline(tab.title)}" (${tab.tabId})`;
}

function parseGoogleDocWriteReceipt(value: unknown): GoogleDocWriteReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  let { actionId, markerId } = value as { actionId?: unknown; markerId?: unknown };
  if (typeof actionId !== "number" || !Number.isSafeInteger(actionId) || actionId < 1 ||
      typeof markerId !== "string" || markerId.length === 0) {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  return { actionId, markerId };
}

type GoogleDocPendingAction = { id: number; action: GoogleDocAction };

type GoogleDocSimulatedContent = EditableMarkdown & {
  /** The valid document insertion point for an append, absent after trailing structure. */
  appendIndex: number | undefined;
};

function googleDocAppendIndex(tab: GoogleDocTabSnapshot): number | undefined {
  return tab.sourceMap.blocks.at(-1)?.docEnd === tab.bodyEndIndex
    ? tab.bodyEndIndex - 1
    : undefined;
}

function requireGoogleDocAppendIndex(appendIndex: number | undefined): number {
  if (appendIndex === undefined) {
    throw new Error(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.",
    );
  }
  return appendIndex;
}

function googleDocSimulatedContent(tab: GoogleDocTabSnapshot): GoogleDocSimulatedContent {
  return {
    markdown: tab.markdown,
    protectedRanges: tab.sourceMap.protectedRanges,
    appendIndex: googleDocAppendIndex(tab),
  };
}

/** One replay of the pending queue, keyed by the state it was computed from. */
type GoogleDocSimulatedContentCache = {
  baseRevisionId?: string;
  pendingFingerprint: string;
  /** The simulated content of every tab, since one replay covers them all. */
  contentByTabId: Map<string, GoogleDocSimulatedContent>;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
  /** Writes landed in the document, counted so a read awaiting Google across one can tell. */
  writes: number;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

const MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES = 1024 * 1024;
const googleDocActionEncoder = new TextEncoder();

function assertGoogleDocActionMarkdownSize(...values: string[]): void {
  // UTF-16 length is a lower bound on UTF-8 bytes, so an oversized input is refused unencoded.
  let byteLength = values.reduce((total, value) => total + value.length, 0);
  if (byteLength <= MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    byteLength = values.reduce(
      (total, value) => total + googleDocActionEncoder.encode(value).byteLength, 0);
  }
  if (byteLength > MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    throw new Error(
      `Google Doc action Markdown exceeds the ${MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES}-byte ` +
      "safe submission limit.",
    );
  }
  for (let value of values) assertMarkdownWriteComplexity(value);
}
function findUniqueMarkdown(
  markdown: string,
  oldMarkdown: string,
  operation: string,
  tabId: string,
): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}: oldMarkdown must not be empty.`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
      `Make sure the text exactly matches content returned by getContent("${tabId}").`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${tabId}". Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  content: GoogleDocSimulatedContent,
  action: GoogleDocReplaceAction,
  tabId: string,
): GoogleDocSimulatedContent {
  let { oldMarkdown } = action;
  let newMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, action.newMarkdown);
  let start = findUniqueMarkdown(content.markdown, oldMarkdown, "replaceText", tabId);
  if (oldMarkdown === newMarkdown) return content;
  return {
    ...content,
    ...applyMarkdownEdit(content, start, start + oldMarkdown.length, newMarkdown),
  };
}

/**
 * Whether a tab holds nothing but one empty paragraph, as a new document does. An append fills
 * that paragraph rather than following it, in both the simulation and the write. A paragraph whose
 * only content renders as nothing (a chip with no label) is protected, so it is not blank. Empty
 * Markdown counts too: a pending replace that removes a tab's whole content leaves the simulation
 * empty, while the real tab keeps its final paragraph and so renders as `"\n"`.
 */
function isBlankGoogleDocTab({ markdown, protectedRanges }: EditableMarkdown): boolean {
  return (markdown === "" || markdown === "\n") && protectedRanges.length === 0;
}

function appendMarkdownForSimulation(content: EditableMarkdown, appendedMarkdown: string): string {
  let terminatedAppend = appendedMarkdown + "\n";

  if (isBlankGoogleDocTab(content)) return terminatedAppend;
  let { markdown } = content;
  return canonicalizeMarkdownReplacement(
    markdown, markdown + (markdown.endsWith("\n") ? "\n" : "\n\n") + terminatedAppend);
}

function assertGoogleDocActionReplayable(action: GoogleDocAction): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
  if (action.markdownVersion !== MARKDOWN_RENDERING_VERSION) {
    throw new Error(
      "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
      "apply as previewed. Reject it and retry.");
  }
}

function applyGoogleDocActionToContent(
  content: GoogleDocSimulatedContent,
  action: GoogleDocAction,
  tabId: string,
): GoogleDocSimulatedContent {
  assertGoogleDocActionReplayable(action);

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(content, action, tabId);
    case "appendText":
      requireGoogleDocAppendIndex(content.appendIndex);
      return {
        ...content,
        markdown: appendMarkdownForSimulation(
          content, canonicalizeMarkdownForWrite(action.markdown)),
      };
    default:
      action satisfies never;
      throw new Error("unknown Google Doc action type");
  }
}

function invalidateGoogleDocAction(
  pendingActions: ActionJournal<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.update(pending.id, pending.action);
  }
}

/**
 * The tabs that could hold the write marker of an edit targeting `tabId`.
 *
 * A marker lives in the tab its write landed in, so one elsewhere belongs to a different write.
 * A pre-tab-support edit names no tab, so its marker — and therefore the proof that its write
 * already committed — could be in any of them.
 */
function googleDocActionTabs<T extends { tabId: string }>(
  tabs: T[],
  tabId: string | undefined,
): T[] {
  return tabId === undefined ? tabs : tabs.filter(tab => tab.tabId === tabId);
}

/**
 * The tab an edit targets.
 *
 * A record stored before tabs were addressable names none, but the old code refused to read a
 * document with more than one tab, so such a record was approved against a document that had
 * exactly one. A document still holding one tab therefore resolves unambiguously; tabs added
 * since leave the approved target unknowable.
 *
 * Exported for coverage: no current write path can produce such a record.
 */
export function googleDocActionTab(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAction,
): GoogleDocTabSnapshot {
  if (action.tabId === undefined && snapshot.tabs.length !== 1) {
    throw new Error(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  }
  return resolveGoogleDocTab(snapshot, action.tabId, action.type);
}

/**
 * Replay the pending queue over `snapshot`, invalidating any edit that no longer applies.
 *
 * Actions are replayed in global approval order, but each one only touches its own tab, so an
 * edit to one tab can neither shift nor be shifted by an edit to another.
 */
function invalidateUnreplayableGoogleDocActions(
  pendingActions: ActionJournal<GoogleDocAction>,
  snapshot: GoogleDocSnapshot,
  pending: GoogleDocPendingAction[],
  context: string,
): Map<string, GoogleDocSimulatedContent> {
  let contentByTabId = new Map(
    snapshot.tabs.map(tab => [tab.tabId, googleDocSimulatedContent(tab)]),
  );
  for (let record of pending) {
    if (record.action.invalidatedReason) continue;

    try {
      let { tabId } = googleDocActionTab(snapshot, record.action);
      contentByTabId.set(
        tabId,
        applyGoogleDocActionToContent(contentByTabId.get(tabId)!, record.action, tabId),
      );
    } catch (error) {
      invalidateGoogleDocAction(
        pendingActions,
        record,
        `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
        `Reject it and retry if it is still needed.`,
      );
    }
  }

  return contentByTabId;
}

/** The batch requests for one edit, together with the tab they are addressed to. */
function materializeGoogleDocAction(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAction,
): { tab: GoogleDocTabSnapshot; requests: any[] } {
  assertGoogleDocActionReplayable(action);
  let tab = googleDocActionTab(snapshot, action);

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          tab.markdown, action.oldMarkdown, "applyAction(replaceText)", tab.tabId);
      let { requests } = computeReplaceOperations(
          tab.sourceMap,
          tab.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          canonicalizeMarkdownReplacement(action.oldMarkdown, action.newMarkdown),
          tab.tabId);
      return { tab, requests };
    }

    case "appendText": {
      let appendIndex = requireGoogleDocAppendIndex(googleDocAppendIndex(tab));
      let requests = isBlankGoogleDocTab(googleDocSimulatedContent(tab))
        ? markdownToDocRequests(action.markdown, appendIndex, tab.tabId, { resetParagraphs: true })
        : markdownToDocRequests("\n" + action.markdown, appendIndex, tab.tabId,
          { resetParagraphs: true, preserveLeadingParagraph: true });
      return { tab, requests };
    }

    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

export type GoogleDocGatekeeperImplProps = { userObjectId: string; documentId: string } | SimulatedFileProps;

/** The ID of the first tab of a document just created, for the real class to adopt pending edits. */
const CREATED_DOC_TAB_KEY = "createdDocTab";

/**
 * Moves the state a simulated document left in storage onto the created one: pending edits to the
 * blank document's tab target the created document's first tab, and the cached reads of the blank
 * document are dropped.
 */
function adoptBlankDocument(kv: DurableObjectStorage["kv"], journal: ActionJournal<GoogleDocAction>,
    tabId: string): void {
  // Adopts through the object's own journal: a second instance would leave its cached projection
  // unaware that these records were retargeted.
  for (let { id, action } of journal.listPending()) {
    if (action.tabId === BLANK_DOC_TAB_ID) journal.update(id, { ...action, tabId });
  }
  kv.delete(DOC_SNAPSHOT_KEY);
  kv.delete(DOC_METADATA_REVISION_KEY);
  kv.delete(CREATED_DOC_TAB_KEY);
}

// All Google Doc edits (replaceText, appendText, ...) are grouped under a single action kind
const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "Document edits",
};

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = { writes: 0 };
  // Edits queue through the kit journal under the same `pending:` keys the private store wrote,
  // so records a connector already holds stay live, now with the journal's capacity bound.
  #journal = new ActionJournal<GoogleDocAction>(
      this.ctx.storage.kv, { namespace: "pending", upgradeRecord: upgradePendingAction });

  // Serialize applying and rejecting actions, and creating the document, against each other. Every
  // network await below leaves the Durable Object's input gate open, and one action id can arrive
  // twice — the overseer marks a record approved only after applyAction() returns, so two approvals
  // of it both see it pending. Interleaved, both fetch the document and the loser writes content the
  // winner already committed; the write marker is no defence, since the winner's cleanup deletes it
  // before the loser looks. Two approvals of a creation would likewise create two documents.
  #actions = new SerialTaskQueue();
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
    return account.getAccessToken(opts);
  });

  constructor(ctx: DurableObjectState<GoogleDocGatekeeperImplProps>, env: Env) {
    super(ctx, env);
    // The real class's first start after applyCreation(): take over what the blank document left.
    let tabId = ctx.storage.kv.get<string>(CREATED_DOC_TAB_KEY);
    if (tabId !== undefined && !isSimulated(ctx.props)) {
      ctx.storage.transactionSync(() => adoptBlankDocument(ctx.storage.kv, this.#journal, tabId));
    }
  }

  /** The account and document this binding reaches, which a document not yet created has not. */
  get #bound(): { userObjectId: string; documentId: string } {
    return boundProps(this.ctx.props, "doc");
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  #readDocWriteReceipt(): GoogleDocWriteReceipt | undefined {
    return parseGoogleDocWriteReceipt(this.ctx.storage.kv.get<unknown>(DOC_WRITE_RECEIPT_KEY));
  }

  #clearDocWriteReceipt(markerId: string): void {
    if (this.#readDocWriteReceipt()?.markerId === markerId) {
      this.ctx.storage.kv.delete(DOC_WRITE_RECEIPT_KEY);
    }
  }

  async #reconcileDocWriteReceipt(
    api: GoogleDocsApi,
    document: GoogleDocsDocument,
  ): Promise<GoogleDocsDocument> {
    let receipt = this.#readDocWriteReceipt();
    if (!receipt) return document;

    // The marker ID is exact, but its tab is not recorded, so every tab is searched for it.
    let markerExists = document.tabs.some(
      tab => googleDocNamedRanges(tab).some(({ id }) => id === receipt.markerId),
    );
    if (!markerExists) {
      this.#clearDocWriteReceipt(receipt.markerId);
      return document;
    }

    let { documentId } = this.#bound;
    await api.deleteNamedRange(documentId, receipt.markerId);
    this.#clearDocWriteReceipt(receipt.markerId);
    return api.getDocument(documentId);
  }

  /**
   * Hands one proven write from its pending action to a cleanup receipt, atomically.
   *
   * The cached snapshot goes with it. That snapshot predates this write, and once the action stops
   * being pending nothing overlays it, so a read interleaving with the cleanup below would report
   * content older than what is already committed. A read already awaiting Google sees the write
   * counted and fetches again rather than cache what it got.
   */
  #handoffDocWriteReceipt(
    actionId: number,
    markerId: string,
    pendingActions: ActionJournal<GoogleDocAction>,
  ): void {
    this.ctx.storage.transactionSync(() => {
      let existing = this.#readDocWriteReceipt();
      if (existing && existing.markerId !== markerId) {
        throw new Error("A different Google Doc write receipt is already pending cleanup");
      }
      this.ctx.storage.kv.put(DOC_WRITE_RECEIPT_KEY, { actionId, markerId });
      this.ctx.storage.kv.delete(DOC_SNAPSHOT_KEY);
      pendingActions.remove(actionId);
      this.#simulationCache.writes++;
    });
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("doc"),
        title,
        snippet: `Google Doc: ${title} (not created yet)`,
        suggestedBindingName: "GOOGLE_DOC",
        tsType: "GoogleDocSession",
      };
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocumentMetadata(props.documentId);
    // Docs reads an Office file as though it were native but refuses every edit to it, so only
    // Drive can say. When Drive cannot answer, the document is described as it reads.
    let mimeType = await new DriveApi(opts => this.#getAccessToken(opts))
      .getFile(props.documentId).then(file => file.mimeType, () => undefined);
    if (officeLabel("doc", mimeType) !== undefined) throw officeFileError("doc");
    return {
      url: nativeFileUrl("doc", props.documentId),
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDocTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [EDIT_DOCUMENT_ACTION];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let props = this.ctx.props;
    // The journal is the queue of record for the gatekeeper and every session it opens.
    // A blank document always has a revision, so the session never reaches Drive for one.
    return new GoogleDocSessionImpl(
        isSimulated(props)
          ? new BlankGoogleDoc(props.creation.title)
          : new GoogleDocsApi(opts => this.#getAccessToken(opts)),
        new DriveApi(opts => this.#getAccessToken(opts)),
        isSimulated(props) ? UNCREATED_FILE_ID : props.documentId,
        approvalQueue.dup(),
        this.#journal,
        this.ctx.storage,
        this.#simulationCache);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#actions.run(() => this.#applyAction(actionId));
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    return this.#actions.run(() => this.#rejectAction(actionId));
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#actions.run(() => this.#applyCreation(creator));
  }

  async #applyCreation(creator: Fetcher<GatekeeperUserVerifier>)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    let { userObjectId, fileId, resourceUrl, getAccessToken: tokens } = await createFileOnce(
        this.ctx, creator, "doc", (title, getToken) => new GoogleDocsApi(getToken).createDocument(title));
    // Edits queued against the blank document name its tab, which the created one may not share.
    let [tab] = (await new GoogleDocsApi(tokens).getDocument(fileId)).tabs;
    this.ctx.storage.kv.put(CREATED_DOC_TAB_KEY, tab.tabId);
    return {
      class: this.ctx.exports.GoogleDocGatekeeperImpl({props: {userObjectId, documentId: fileId}}),
      resourceUrl,
    };
  }

  async #applyAction(actionId: number): Promise<void> {
    let { documentId } = this.#bound;
    let pendingActions = this.#journal;
    let pending = pendingActions.listPending();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let action = pending[pendingIndex].action;
    // Left pending, not removed: the overseer keeps its own record when this throws, so removing
    // ours would answer the next retry with "unknown action" instead of the reason. Rejecting
    // clears both.
    if (action.invalidatedReason) {
      throw new Error(action.invalidatedReason);
    }

    let firstPending = pending.find(record => !record.action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    if (!action.writeId) {
      action.writeId = crypto.randomUUID();
      pendingActions.update(actionId, action);
    }
    let writeMarkerName = googleDocWriteMarkerName(action.writeId);
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocument(documentId);
    doc = await this.#reconcileDocWriteReceipt(api, doc);
    let snapshot = googleDocSnapshot(doc);
    let markerIds = [...new Set(googleDocActionTabs(doc.tabs, action.tabId)
        .flatMap(tab => googleDocNamedRangeIds(tab, writeMarkerName)))];
    if (markerIds.length > 1) {
      throw new Error(`Google Docs returned multiple write markers for action ${actionId}`);
    }
    let [writeMarkerId] = markerIds;
    if (!writeMarkerId) {
      let materialized: { tab: GoogleDocTabSnapshot; requests: any[] };
      try {
        materialized = materializeGoogleDocAction(snapshot, action);
      } catch (error) {
        // Invalidated, not removed: later edits stop waiting behind it, and approving it again
        // repeats the reason rather than reporting success for a write that never happened.
        logger.error("Google Doc action cannot be applied", {
          event: "google.doc.action.apply.unapplyable",
          actionId, error,
        });
        invalidateGoogleDocAction(
            pendingActions,
            pending[pendingIndex],
            `Pending Google Doc edit could not be applied: ${errorMessage(error)}`);
        this.#simulationCache.current = undefined;
        await this.ctx.storage.put(DOC_SNAPSHOT_KEY, snapshot);
        throw error;
      }
      let { tab, requests } = materialized;
      if (requests.length > 0) {
        let result = await api.batchUpdate(documentId, requests, snapshot.revisionId, {
          name: writeMarkerName,
          rangeStart: tab.bodyEndIndex - 1,
          tabId: tab.tabId,
        }).catch(async (error: unknown) => {
          throw await explainUnopenedFile("doc", error, async () =>
            (await new DriveApi(opts => this.#getAccessToken(opts)).getFile(documentId)).mimeType);
        });
        if (!result.writeMarkerId) {
          throw new Error(`Google Docs did not return a write marker for action ${actionId}`);
        }
        writeMarkerId = result.writeMarkerId;
      }
    }
    if (writeMarkerId) {
      this.#handoffDocWriteReceipt(actionId, writeMarkerId, pendingActions);
      try {
        await api.deleteNamedRange(documentId, writeMarkerId);
        this.#clearDocWriteReceipt(writeMarkerId);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    } else {
      pendingActions.remove(actionId);
    }
    this.#simulationCache.current = undefined;

    // The handoff dropped the snapshot this edit made stale. Only edits queued behind it need the
    // new revision now, to be replayed over it; otherwise the next read fetches it, and an approval
    // that nobody reads after costs no full document read.
    let later = pending.slice(pendingIndex + 1).filter(record => !record.action.invalidatedReason);
    if (writeMarkerId && later.length === 0) return;
    try {
      let refreshedSnapshot = snapshot;
      if (writeMarkerId) {
        refreshedSnapshot = googleDocSnapshot(await api.getDocument(documentId));
      }
      await this.ctx.storage.put(DOC_SNAPSHOT_KEY, refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot,
          later,
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);
    }
  }

  async #rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = this.#journal;
    let pending = pendingActions.listPending();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). The binding is one document, so we just
   * confirm the observer can open it with their own token (hasDocAccess, via the Drive/Docs ACL).
   * The document is the atomic unit (everything read through this binding is that one doc), so no
   * observers are tracked and removeObserver is a no-op. The overseer re-runs addObserver on every
   * open, catching loss of access promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.#bound.documentId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Doc, so they cannot be allowed " +
        "to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocReader;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: ActionJournal<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;

  constructor(
    docsApi: GoogleDocReader,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: ActionJournal<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
  }

  async #getSnapshot(): Promise<GoogleDocSnapshot> {
    for (;;) {
      let writes = this.#simulationCache.writes;
      // A snapshot written before tabs existed has no tab list and is simply replaced.
      let cached = await this.#storage.get<unknown>(DOC_SNAPSHOT_KEY);
      if (isGoogleDocSnapshot(cached) && Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) {
        return cached;
      }
      let snapshot = isGoogleDocSnapshot(cached) &&
          await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)
        ? { ...cached, fetchedAt: Date.now() }
        : googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
      // What Google returned before a write landed is stale: the edit is no longer pending to be
      // replayed over it, so it would read as missing, and edits queued after it could not replay.
      if (writes !== this.#simulationCache.writes) continue;
      await this.#storage.put(DOC_SNAPSHOT_KEY, snapshot);
      return snapshot;
    }
  }

  /**
   * The selected tab's content with every pending edit replayed over it.
   *
   * The selector is resolved before anything is replayed or cached, so naming a tab that does not
   * exist cannot disturb the pending queue.
   */
  async #getSimulatedContent(
    tabId: string | undefined,
    operation: "getContent" | "replaceText" | "appendText",
  ): Promise<GoogleDocSimulatedContent & {
    snapshot: GoogleDocSnapshot,
    tab: GoogleDocTabSnapshot,
  }> {
    let snapshot = await this.#getSnapshot();
    let tab = resolveGoogleDocTab(snapshot, tabId, operation);
    let pending = this.#pendingActions.listPending();
    let pendingFingerprint = googleDocPendingFingerprint(pending);
    let cached = this.#simulationCache.current;
    // An unknown revision cannot be shown to match, so the replay is recomputed.
    if (cached && cached.baseRevisionId !== undefined &&
        cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === pendingFingerprint) {
      let content = cached.contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
      return {snapshot, tab, ...content};
    }

    // An edit whose marker is already in its tab committed even though its response never
    // arrived, so this snapshot contains it. Replaying it would show that content twice; the
    // action stays pending, and applyAction() settles it from the same marker.
    let replayable = pending.filter(({action}) => {
      let {writeId} = action;
      return writeId === undefined || !googleDocActionTabs(snapshot.tabs, action.tabId)
          .some(candidate => candidate.committedWriteIds.includes(writeId));
    });

    let contentByTabId = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot,
        replayable,
        "Pending Google Doc edit could not be replayed against the current document");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.listPending()),
      contentByTabId,
    };
    let content = contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
    return {snapshot, tab, ...content};
  }

  /**
   * Current title, and a modification time that only advances when something changed.
   *
   * Google Docs exposes no modification time, so the moment this binding first saw the current
   * revision stands in for it and is reused for as long as that revision holds — reading a
   * document must not make it look freshly edited. Without edit access there is no revision to
   * date, and Drive's own timestamp is used instead. Pending edits still move it forward, since
   * `getContent()` already shows them.
   */
  async getMetadata(): Promise<DocMetadata> {
    let metadata = await this.#docsApi.getDocumentMetadata(this.#documentId);
    let revisedAt = metadata.revisionId === undefined
        ? await this.#modifiedWithoutRevision()
        : this.#observeDocRevision(metadata.revisionId);
    let pendingActions = this.#pendingActions.listPending()
        .map(({action}) => action)
        .filter(action => !action.invalidatedReason);

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), revisedAt);
    return {
      title: metadata.title,
      lastModified: new Date(lastModified),
    };
  }

  /**
   * The modification time of a document Google reports no revision for.
   *
   * Without edit access there is no revision to date, so Drive is asked instead. An account
   * connected before per-resource grants may not hold the picker's metadata scope, leaving no
   * signal at all; the first observation then stands rather than every read looking like an edit.
   */
  async #modifiedWithoutRevision(): Promise<number> {
    try {
      return driveModifiedTime(await this.#driveApi.getFile(this.#documentId)).valueOf();
    } catch (error) {
      // Only a refused grant means no signal will ever arrive. A quota 403 (also 403), an outage
      // or a malformed body are transient or fixable, and dating the document from one would
      // report a changed document as unchanged for as long as Drive stays unhealthy.
      let refusedGrant = error instanceof GoogleApiError && error.status === 403 &&
          !isAccountWideRefusal(error);
      if (!refusedGrant) throw error;
      logger.warn("no Drive grant to date a Google Doc that has no revision", {
        event: "google.doc.metadata.drive.ungranted", error,
      });
      return this.#observeDocRevision(undefined);
    }
  }

  /**
   * When this binding first saw `revisionId`, recording it if the revision is new.
   *
   * An unreadable record is re-observed rather than rejected: it only dates a revision, so the
   * worst a lost record costs is one timestamp that moves when the document did not. Two absent
   * revisions count as the same: a document that offers no change token must not look edited by
   * every read, which is the opposite of what a cache needs from the same comparison.
   */
  #observeDocRevision(revisionId?: string): number {
    let stored = this.#storage.kv.get<unknown>(DOC_METADATA_REVISION_KEY);
    if (stored && typeof stored === "object") {
      let { revisionId: seen, observedAt } = stored as Partial<GoogleDocMetadataRevision>;
      if (seen === revisionId &&
          typeof observedAt === "number" && Number.isFinite(observedAt)) {
        return observedAt;
      }
    }
    let observedAt = Date.now();
    this.#storage.kv.put<GoogleDocMetadataRevision>(
      DOC_METADATA_REVISION_KEY, { revisionId, observedAt });
    return observedAt;
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    let snapshot = await this.#getSnapshot();

    await this.#approvalQueue.authorizeObservation({
      title: "List Google Doc tabs",
      description: "Read the document's tab names and hierarchy.",
    });

    return snapshot.tabs.map(googleDocTabMetadata);
  }

  async getContent(tabId?: string): Promise<string> {
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "getContent");
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#approvalQueue.authorizeObservation({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }

    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Doc content",
      description:
        `Read the full simulated content of tab ${googleDocTabLabel(selected.tab)} as Markdown.`,
    });
    return selected.markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }
    assertGoogleDocActionMarkdownSize(oldMarkdown, newMarkdown);

    let selected;
    let renderedNewMarkdown: string;
    try {
      selected = await this.#getSimulatedContent(tabId, "replaceText");
      let start = findUniqueMarkdown(
        selected.markdown, oldMarkdown, "replaceText", selected.tab.tabId,
      );
      renderedNewMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
      applyMarkdownEdit(selected, start, start + oldMarkdown.length, renderedNewMarkdown);
      // With no earlier edit to this tab, approval will build exactly these requests.
      if (selected.markdown === selected.tab.markdown) {
        computeReplaceOperations(selected.tab.sourceMap, selected.markdown, start,
          start + oldMarkdown.length, renderedNewMarkdown, selected.tab.tabId);
      }
    } catch (error) {
      // The error says whether that tab, or that text, exists.
      await this.#approvalQueue.authorizeObservation({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;

    let action: GoogleDocAction = {
      type: "replaceText",
      tabId: tab.tabId,
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      oldMarkdown,
      newMarkdown,
    };

    let description = buildDescription(`Replace text in tab ${googleDocTabLabel(tab)}.`)
      .verbatim("Old", oldMarkdown, "markdown");
    if (newMarkdown !== renderedNewMarkdown) {
      description.verbatim("Requested New", newMarkdown, "markdown");
    }
    description.verbatim("New", renderedNewMarkdown, "markdown");
    await stageAction(this.#pendingActions, this.#approvalQueue, action, {
      title: "Edit Google Doc",
      ...description.finish(),
      implementsRevert: false,
      // Group all document edits under one tag
      actionKind: EDIT_DOCUMENT_ACTION,
      autoApprovable: true,
    });
    this.#simulationCache.current = undefined;
  }

  async appendText(markdown: string, tabId?: string): Promise<void> {
    assertGoogleDocActionMarkdownSize(markdown);
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "appendText");
      requireGoogleDocAppendIndex(selected.appendIndex);
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#approvalQueue.authorizeObservation({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;
    let renderedMarkdown = canonicalizeMarkdownForWrite(markdown);

    let action: GoogleDocAction = {
      type: "appendText",
      tabId: tab.tabId,
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      markdown,
    };

    let description =
      buildDescription(`Append content to the end of tab ${googleDocTabLabel(tab)}.`);
    if (markdown === renderedMarkdown) {
      description.verbatim("Content", renderedMarkdown, "markdown");
    } else {
      description
        .verbatim("Requested", markdown, "markdown")
        .verbatim("Resulting", renderedMarkdown, "markdown");
    }
    await stageAction(this.#pendingActions, this.#approvalQueue, action, {
      title: "Append to Google Doc",
      ...description.finish(),
      implementsRevert: false,
      // Same "editDocument" tag as replaceText
      actionKind: EDIT_DOCUMENT_ACTION,
      autoApprovable: true,
    });
    this.#simulationCache.current = undefined;
  }
}

