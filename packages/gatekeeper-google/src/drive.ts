// Google Drive gatekeeper: user-authenticated reads of Drive entries and native files, grouped
// under one account binding or scoped to a folder or file.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  ApprovalQueue, Cursor, Gatekeeper, GatekeeperUserVerifier, ObservationDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { DocMetadata } from "./docs-types";
import { GoogleDocsApi } from "./docs-api";
import { GoogleSheetsApi } from "./sheets-api";
import { GoogleSlidesApi } from "./slides-api";
import { GooglePresentationReadSessionImpl } from "./slides";
import { GoogleSpreadsheetReadSessionImpl } from "./sheets";
import type { GooglePresentationReadSession } from "./slides-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
import { DriveApi, lacksFileContentAccess } from "./drive-api";
import { CONVERSION_FAILED, pdfToText, type PdfConverter } from "./drive-pdf";
import type { AiFetcher } from "./workers-ai-markdown";
import { driveObserverTracker, type DriveObservation } from "./drive-observers";
import { outsideScope, readFolderRoot, type FolderLocation } from "./drive-folder-scope";
import {
  DriveFolderSessionCore, DriveSessionCore, driveModifiedTime,
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE, PDF_MIME_TYPE,
  requireDriveBindingScope, type DriveBindingScope, type DriveCore, type NativeObservation,
  type NativeRead,
} from "./drive-session";
import type {
  DriveEntry, DriveListOptions, DrivePdfText, DriveSessionSearchQuery, GoogleDriveFolderSession,
  GoogleDriveReadSession, GoogleDriveSession,
} from "./drive-types";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { GOOGLE_DRIVE_RESOURCE } from "./resources";
import { type ObserverCheck, ObserverTracker } from "./observers";
import {
  DOC_SNAPSHOT_TTL_MS, googleDocRevisionUnchanged, googleDocSnapshot, googleDocTabLabel,
  googleDocTabMetadata, resolveGoogleDocTab,
  type GoogleDocSnapshot, type GoogleDocTabSnapshot,
} from "./docs";
import type { GoogleDocReadSession, GoogleDocTab } from "./docs-types";
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import SHEETS_READ_TYPES_CODE from "./sheets-read-types.txt";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import DRIVE_TYPES_CODE from "./drive-types.txt";
import { DRIVE_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import type { Pager } from "./cursor";

type Env = Cloudflare.Env;

let driveAgentTypesCode: string | undefined;
let googleDriveTypesCode: string | undefined;

export function getDriveAgentTypesCode(): string {
  return driveAgentTypesCode ??= stripTypeModulePrefix(
    DRIVE_TYPES_CODE, DRIVE_TYPES_MODULE_PREFIX,
  );
}

function getGoogleDriveTypesCode(): string {
  return googleDriveTypesCode ??= [
    DOCS_READ_TYPES_CODE, SHEETS_READ_TYPES_CODE, SLIDES_READ_TYPES_CODE, getDriveAgentTypesCode(),
  ].join("\n");
}

@validateRpc()
class RpcCursor<Entry> extends RpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;
  #owned: Disposable | undefined;

  /**
   * `owned` is disposed with this cursor. A cursor authorizes every page it discloses, so it needs
   * an approval-queue stub that lives as long as it does rather than its session's, which the
   * cursor's owner may dispose first.
   *
   * Optional because a Gmail cursor has nothing to outlive: that session never disposes its own
   * stub (see the TODO on GmailSessionImpl).
   */
  constructor(pager: Pager<Entry>, owned?: Disposable) {
    super();
    this.#pager = pager;
    this.#owned = owned;
  }

  [Symbol.dispose](): void {
    this.#owned?.[Symbol.dispose]();
  }

  // `next()` takes no arguments, so there is no argument surface to validate.
  @skipRpcValidation()
  next(): Promise<Entry[] | null> {
    return this.#pager.next();
  }
}

// =======================================================================================
// Google Drive Gatekeeper
// =======================================================================================

export type GoogleDriveGatekeeperImplProps = {
  userObjectId: string;
  scope: DriveBindingScope;
};

@validateRpc()
export class GoogleDriveGatekeeperImpl
    extends DurableObject<Env, GoogleDriveGatekeeperImplProps>
    implements Gatekeeper<GoogleDriveSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let scope = this.#scope;
    if (scope.kind === "account") {
      return {
        url: GOOGLE_DRIVE_RESOURCE.urlPattern,
        title: "Google Drive Account",
        snippet: GOOGLE_DRIVE_RESOURCE.description,
        suggestedBindingName: "GOOGLE_DRIVE",
        tsType: "GoogleDriveSession",
      };
    }
    let api = new DriveApi(opts => this.#getAccessToken(opts));
    if (scope.kind === "folder") {
      // Validated here too, so a hand-built resource URL fails at connect rather than minting a
      // presentable binding whose every call then refuses.
      let folder = await readFolderRoot(scope.folderId, id => api.getFile(id));
      return {
        // The natural browser URL, not the internal `_resource` selector the grant is keyed on.
        url: `https://drive.google.com/drive/folders/${encodeURIComponent(scope.folderId)}`,
        title: folder.name,
        snippet: `List and search direct children, navigate child folders, read native Google Docs, Sheets and Slides, and read PDFs' text with readPdf() in Drive folder "${folder.name}"`,
        suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
        tsType: "GoogleDriveFolderSession",
      };
    }
    let file = await api.getFile(scope.fileId);
    return {
      url: `https://drive.google.com/file/d/${encodeURIComponent(scope.fileId)}/view`,
      title: file.name,
      snippet: `Read metadata and, when native, Google Doc, Sheet or Slides content, or with readPdf() a PDF's text, from Drive file "${file.name}"`,
      suggestedBindingName: "GOOGLE_DRIVE_FILE",
      tsType: "GoogleDriveReadSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDriveTypesCode();
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleDriveSession> {
    let observerTracker = this.#observerTracker();
    let getDriveAccessToken = (opts?: AccessTokenRequest) => this.#getAccessToken(opts);
    // `pnpm dev-server` drops the AI binding unless started with --use-workers-ai-binding.
    // `Ai` declares no `fetch`, but the binding has one; conversion goes through it so it can stream.
    let ai = this.env.AI as unknown as AiFetcher | undefined;
    let gatewayId = this.env.CF_AI_GATEWAY;
    let convertPdf: PdfConverter | undefined = ai && (pdf => pdfToText(ai, gatewayId, pdf));
    return new GoogleDriveSessionImpl(
      new DriveApi(getDriveAccessToken),
      new GoogleDocsApi(getDriveAccessToken),
      new GoogleSheetsApi(getDriveAccessToken),
      new GoogleSlidesApi(getDriveAccessToken),
      convertPdf,
      this.#scope,
      approvalQueue.dup(),
      observations => observerTracker.prepareObservation(observations),
      () => observerTracker.prepareWithheld(),
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {}
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> {
    throw new Error("Google Drive gatekeeper has no writable actions to revert");
  }

  #observerTracker(): ObserverTracker<DriveObservation, Fetcher<GoogleVerifierApi>> {
    return driveObserverTracker<Fetcher<GoogleVerifierApi>>(
      this.ctx.storage.kv, this.#scope,
      (verifier, observations) => verifier.verifyDriveObservations([...observations]));
  }

  get #scope(): DriveBindingScope {
    return requireDriveBindingScope(this.ctx.props.scope);
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observerTracker().addObserver(id, user as unknown as Fetcher<GoogleVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observerTracker().removeObserver(id);
  }
}

@validateRpc()
class GoogleDocReadSessionImpl extends RpcTarget implements GoogleDocReadSession {
  #docsApi: GoogleDocsApi;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  /** A fetch still in flight, so reads issued together observe one revision. */
  #inFlight?: Promise<GoogleDocSnapshot>;
  /** The last revision a completed scope check approved, the only one a later read may reuse. */
  #approved?: GoogleDocSnapshot;
  #read: NativeRead;

  constructor(
    docsApi: GoogleDocsApi,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getMetadata(): Promise<DocMetadata> {
    return this.#read(async () => {
      let file = await this.#driveApi.getFile(this.#documentId);
      return { title: file.name, lastModified: driveModifiedTime(file) };
    }, () => ({
      title: "Read Google Doc metadata",
      description: "Read the current title and modification time of the Drive document.",
    }));
  }

  /**
   * Reads one snapshot under the binding's scope guard.
   *
   * Only a revision a whole guard cycle approved becomes reusable. The scope check straddles the
   * fetch, so a revision fetched while the document was outside must never reach a later read --
   * and rolling it back after the refusal is too late, since a read that chained onto it meanwhile
   * already holds it. Reads issued together still share one fetch: each brackets that fetch with
   * its own checks, exactly as a lone read does.
   */
  async #readSnapshot<T>(
    use: (snapshot: GoogleDocSnapshot) => T,
    observe: (value: T) => NativeObservation,
  ): Promise<T> {
    let snapshot: GoogleDocSnapshot | undefined;
    let value = await this.#read(async () => {
      snapshot = await (this.#inFlight ??= this.#nextSnapshot()
        .finally(() => { this.#inFlight = undefined; }));
      return use(snapshot);
    }, observe);
    // A slow guard must not republish its older revision over a newer one already approved.
    if (snapshot && snapshot.fetchedAt >= (this.#approved?.fetchedAt ?? 0)) {
      this.#approved = snapshot;
    }
    return value;
  }

  /** Reuse one revision for the TTL, then confirm it is still current before reusing it again. */
  async #nextSnapshot(): Promise<GoogleDocSnapshot> {
    let cached = this.#approved;
    if (cached) {
      if (Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) return cached;
      if (await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)) {
        cached.fetchedAt = Date.now();
        return cached;
      }
    }
    return googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    return this.#readSnapshot(
      snapshot => snapshot.tabs.map(googleDocTabMetadata),
      () => ({
        title: "List Google Doc tabs",
        description: "Read the document's tab names and hierarchy.",
      }));
  }

  async getContent(tabId?: string): Promise<string> {
    // The selector error says whether a tab exists, so a failed attempt discloses something too
    // and has to be authorized. It rides back as a value so one guarded read covers both outcomes.
    let selection = await this.#readSnapshot(
      (snapshot): { tab: GoogleDocTabSnapshot } | { error: unknown } => {
        try {
          return { tab: resolveGoogleDocTab(snapshot, tabId, "getContent") };
        } catch (error) {
          return { error };
        }
      },
      result => ({
        title: "Read Google Doc content",
        description: "tab" in result
          ? `Read the current content of tab ${googleDocTabLabel(result.tab)} as Markdown.`
          : "Read the content of one tab of the document.",
      }));
    if (!("tab" in selection)) throw selection.error;
    return selection.tab.markdown;
  }
}

/** The refusal for an account connected before Drive bindings could read file content. */
const PDF_ACCESS_MISSING =
  "This Google account was connected before Drive bindings could read file content. Reconnect " +
  "it in Workshop to read PDFs.";

/** Drive RPC session implementation, exported for workerd contract coverage. */
@validateRpc()
export class GoogleDriveSessionImpl extends RpcTarget
    implements GoogleDriveReadSession, GoogleDriveFolderSession {
  #core: DriveCore;
  #driveApi: DriveApi;
  #docsApi: GoogleDocsApi;
  #sheetsApi: GoogleSheetsApi;
  #slidesApi: GoogleSlidesApi;
  /** Absent when the deployment has no Workers AI binding, so PDFs cannot be read. */
  #convertPdf: PdfConverter | undefined;
  #scope: DriveBindingScope;
  /** Set exactly when the scope is a folder, so no core has to be built to learn which it is. */
  #location?: FolderLocation;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #prepareObservation: (
    observations: DriveObservation[],
  ) => Promise<ObserverCheck<DriveObservation>>;
  #prepareWithheld: () => ObserverCheck<DriveObservation>;

  constructor(
    driveApi: DriveApi,
    docsApi: GoogleDocsApi,
    sheetsApi: GoogleSheetsApi,
    slidesApi: GoogleSlidesApi,
    convertPdf: PdfConverter | undefined,
    scope: DriveBindingScope,
    approvalQueue: RpcStub<ApprovalQueue>,
    prepareObservation: (
      observations: DriveObservation[],
    ) => Promise<ObserverCheck<DriveObservation>>,
    prepareWithheld: () => ObserverCheck<DriveObservation>,
    location?: FolderLocation,
  ) {
    super();
    this.#driveApi = driveApi;
    this.#docsApi = docsApi;
    this.#sheetsApi = sheetsApi;
    this.#slidesApi = slidesApi;
    this.#convertPdf = convertPdf;
    this.#scope = scope;
    this.#location = scope.kind === "folder"
      ? location ?? {folderIds: [scope.folderId]}
      : undefined;
    this.#approvalQueue = approvalQueue;
    this.#prepareObservation = prepareObservation;
    this.#prepareWithheld = prepareWithheld;
    this.#core = this.#coreFor(this.#approvalQueue);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  getScope() {
    return this.#core.getScope();
  }

  async list(options?: DriveListOptions): Promise<Cursor<DriveEntry>> {
    return this.#cursor(core => core.list(options));
  }

  async search(query: DriveSessionSearchQuery): Promise<Cursor<DriveEntry>> {
    return this.#cursor(core => core.search(query));
  }

  getEntry(fileId: string): Promise<DriveEntry> {
    return this.#core.getEntry(fileId);
  }

  async openFolder(folderId: string): Promise<GoogleDriveFolderSession> {
    if (this.#scope.kind !== "folder") outsideScope();
    return this.#withQueue(async (queue, core) => {
      let location = await (core as DriveFolderSessionCore).openFolder(folderId);
      return new GoogleDriveSessionImpl(
        this.#driveApi, this.#docsApi, this.#sheetsApi, this.#slidesApi, this.#convertPdf,
        this.#scope, queue, this.#prepareObservation, this.#prepareWithheld, location,
      );
    });
  }

  async openGoogleDoc(fileId: string): Promise<GoogleDocReadSession> {
    return this.#openNative(fileId, GOOGLE_DOC_MIME_TYPE, "Google Doc",
      (documentId, queue, read) =>
        new GoogleDocReadSessionImpl(this.#docsApi, this.#driveApi, documentId, queue, read));
  }

  async openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession> {
    return this.#openNative(fileId, GOOGLE_SHEET_MIME_TYPE, "Google Sheet",
      (spreadsheetId, queue, read) =>
        new GoogleSpreadsheetReadSessionImpl(this.#sheetsApi, spreadsheetId, queue, read));
  }

  async openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession> {
    return this.#openNative(fileId, GOOGLE_SLIDES_MIME_TYPE, "Google Slides presentation",
      (presentationId, queue, read) =>
        new GooglePresentationReadSessionImpl(this.#slidesApi, presentationId, queue, read));
  }

  async readPdf(fileId: string): Promise<DrivePdfText> {
    // The text stream needs no queue of its own, so this reads through the session's, as getEntry.
    let core = this.#core;
    let id = await core.openNativeFile(fileId, PDF_MIME_TYPE, "PDF");
    let convert = this.#convertPdf;
    if (!convert) throw new Error("PDF reading is not available on this deployment.");
    let converted: DrivePdfText | undefined;
    return core.nativeRead(id, PDF_MIME_TYPE)(async () => {
      let download = (await this.#driveApi.openDownload(id).catch((error: unknown) => {
        throw lacksFileContentAccess(error) ? new Error(PDF_ACCESS_MISSING) : error;
      })).getReader();
      // The checks after this fetch must cover everything the text is converted from, so a
      // conversion that answers before the download has ended is refused.
      let downloaded = false;
      converted = await convert(new ReadableStream<Uint8Array>({
        async pull(controller) {
          let chunk = await download.read();
          if (chunk.done) {
            downloaded = true;
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        },
        cancel: reason => download.cancel(reason),
      }, { highWaterMark: 0 }));
      if (!downloaded) {
        await download.cancel().catch(() => undefined);
        throw new Error(CONVERSION_FAILED);
      }
      return converted;
    }, () => ({
      title: "Read PDF from Google Drive",
      description: `Read the text of Drive file ${id}.`,
    })).catch(async (error: unknown) => {
      // Text refused after its conversion still holds the response open.
      await converted?.text.cancel().catch(() => undefined);
      throw error;
    });
  }

  #coreFor(queue: RpcStub<ApprovalQueue>): DriveCore {
    let common = {
      api: this.#driveApi,
      prepareObservation: this.#prepareObservation,
      prepareWithheld: this.#prepareWithheld,
      authorize: (description: ObservationDescription) => queue.authorizeObservation(description),
    };
    if (this.#scope.kind === "folder") {
      return new DriveFolderSessionCore({
        ...common, location: this.#location ?? {folderIds: [this.#scope.folderId]},
      });
    }
    return new DriveSessionCore({...common, scope: this.#scope});
  }

  /**
   * Runs `use` against a capability-owned approval queue, disposing it if `use` throws.
   *
   * A capability handed to the caller outlives this session, so it pages through a queue of its
   * own; the queue is this session's to release until ownership transfers on success.
   */
  async #withQueue<T>(use: (queue: RpcStub<ApprovalQueue>, core: DriveCore) => Promise<T>) {
    let queue = this.#approvalQueue.dup();
    try {
      return await use(queue, this.#coreFor(queue));
    } catch (error) {
      queue[Symbol.dispose]();
      throw error;
    }
  }

  async #cursor(open: (core: DriveCore) => Promise<Pager<DriveEntry>>): Promise<Cursor<DriveEntry>> {
    return this.#withQueue(async (queue, core) => new RpcCursor(await open(core), queue));
  }

  async #openNative<T>(
    fileId: string,
    mimeType: string,
    description: string,
    build: (id: string, queue: RpcStub<ApprovalQueue>, read: NativeRead) => T,
  ): Promise<T> {
    return this.#withQueue(async (queue, core) => {
      let id = await core.openNativeFile(fileId, mimeType, description);
      return build(id, queue, core.nativeRead(id, mimeType));
    });
  }
}

