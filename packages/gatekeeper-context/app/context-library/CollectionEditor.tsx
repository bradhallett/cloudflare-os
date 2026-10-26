/** The collection editor: file tree, upload/create flows, and the document or overview detail pane. */

import { Dialog, DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import { BookOpen, CaretLeft, FilePlus, Folder, FolderPlus, Plus, UploadSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contentTypeFromPath } from "../../src/context-types";
import type { ContextCollectionMetadata, ContextCollectionPermissions, ContextCollectionSharing, ContextDocumentSummary } from "../../src/context-types";
import { extractDescription } from "../../src/description-extractors";
import { useContextApi, usePresentWhileOpen } from "../bridge";
import { ShareCollectionDialog } from "../skills/ShareCollectionDialog";
import { readUploadFile } from "../uploadFiles";
import { CollectionOptionsMenu, CollectionOverview } from "./CollectionOverview";
import { CollectionSettingsModal } from "./CollectionSettingsModal";
import { DocumentEditor } from "./DocumentEditor";
import { buildTree, FolderView } from "./FileTree";
import type { TreeCtx } from "./FileTree";
import { GitTokenManagementModal } from "./GitTokenManagementModal";
import { baseName, dirName, joinPath, pluralize, replacePathPrefix, runWithConcurrency } from "./paths";
import { CollectionIconTile, DeletePermanentlyDescription, KebabMenu, MENU_ITEM, ModalHeader, WorkshopButton, WorkshopIconButton } from "./ui";

// Read-only until permissions load, so edit controls never flash to viewers.
const NO_PERMISSIONS: ContextCollectionPermissions = {
  canEdit: false,
  canShare: false,
  canManageOwners: false,
  canDelete: false,
};

export function CollectionEditor({
  collectionId,
  selectedPath,
  onSelectPath,
  onBack,
}: {
  collectionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onBack: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [docs, setDocs] = useState<ContextDocumentSummary[]>([]);
  const [metadata, setMetadata] = useState<ContextCollectionMetadata | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<"edit" | "delete">("edit");
  const [gitTokensOpen, setGitTokensOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const openSettings = (m: "edit" | "delete") => {
    setSettingsMode(m);
    setSettingsOpen(true);
  };
  const [permissions, setPermissions] = useState(NO_PERMISSIONS);
  const [sharing, setSharing] = useState<ContextCollectionSharing | null>(null);
  const [supportsGitCollections, setSupportsGitCollections] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);

  // Tree ⋮ deletes route through the same in-app confirmation dialog the document toolbar uses,
  // rather than a native confirm() that breaks out of the app chrome.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    isDir: boolean;
    count: number;
  } | null>(null);
  const [deletingPath, setDeletingPath] = useState(false);
  const deletePresentation = usePresentWhileOpen(!!pendingDelete);
  // Deferred until the delete dialog's close animation finishes (run from onOpenChangeComplete),
  // else swapping the pane flickers behind the exiting backdrop.
  const afterDeleteExitRef = useRef<(() => void) | null>(null);

  // Parent owns selection; alias keeps local handlers small.
  const setSelectedPath = onSelectPath;
  const [editOnOpenPath, setEditOnOpenPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingFolders, setPendingFolders] = useState<Set<string>>(new Set());

  const [creating, setCreating] = useState<{
    dir: string;
    kind: "file" | "folder";
  } | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Guard tab close/reload; in-iframe navigation is handled by the caller.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const canEditDocuments = permissions.canEdit && metadata?.content.source !== "git";

  const loadDocs = useCallback(async () => {
    try {
      const [meta, list, loadedPermissions, viewer, loadedSharing] = await Promise.all([
        context.getContextCollectionMetadata(collectionId),
        context.listContextDocuments(collectionId),
        context.getContextCollectionPermissions(collectionId),
        context.getViewerInfo(),
        // Only private collections have sharing state; it labels the overview and is not needed
        // for anything else.
        context.getContextCollectionSharing(collectionId).catch(() => null),
      ]);
      setMetadata(meta);
      setDocs(list);
      setPermissions(loadedPermissions);
      setSharing(meta?.visibility === "private" ? loadedSharing : null);
      setSupportsGitCollections(viewer.supportsGitCollections);
    } catch (err) {
      setPermissions(NO_PERMISSIONS);
      setSharing(null);
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }, [context, collectionId]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const handleRefreshArtifactSource = async () => {
    setRefreshingSource(true);
    try {
      await context.syncContextCollectionArtifactSource(collectionId);
      await loadDocs();
      toasts.add({ title: "Collection refreshed", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to refresh: ${(err as Error).message}`, variant: "error" });
    } finally {
      setRefreshingSource(false);
    }
  };

  useEffect(() => {
    if (!selectedPath) return;
    const segs = selectedPath.split("/");
    if (segs.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = "";
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i];
        next.add(acc);
      }
      return next;
    });
  }, [selectedPath]);

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (dir: string, kind: "file" | "folder") => {
    if (dir) setExpanded((p) => new Set(p).add(dir));
    setCreating({ dir, kind });
    setCreatingName("");
  };
  const cancelCreate = () => {
    setCreating(null);
    setCreatingName("");
  };

  const commitCreate = async () => {
    if (!creating) return;
    const name = creatingName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    const path = joinPath(creating.dir, name);
    if (creating.kind === "folder") {
      setPendingFolders((p) => new Set(p).add(path));
      setExpanded((p) => new Set(p).add(path));
      cancelCreate();
      return;
    }
    // Files start empty; content type comes from the path.
    try {
      const filePath = /\.[^/]+$/.test(path) ? path : `${path}.md`;
      await context.putContextDocument(collectionId, filePath, {
        description: "",
        body: "",
        contentType: contentTypeFromPath(filePath),
      });
      cancelCreate();
      await loadDocs();
      setEditOnOpenPath(filePath);
      setSelectedPath(filePath);
    } catch {
      toasts.add({ title: "Failed to create file", variant: "error" });
    }
  };

  const startRename = (path: string) => {
    setRenaming(path);
    setRenameValue(baseName(path));
  };
  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
  };
  // Move a file or folder from -> dest, following the selection into the moved subtree. Throws on
  // RPC failure so callers can surface the right message.
  const relocate = async (from: string, dest: string) => {
    if (pendingFolders.has(from)) {
      setPendingFolders((p) => {
        const next = new Set(p);
        next.delete(from);
        next.add(dest);
        return next;
      });
    } else {
      await context.moveContextDocument(collectionId, from, dest);
    }
    if (selectedPath === from || selectedPath?.startsWith(from + "/")) {
      setSelectedPath(replacePathPrefix(selectedPath, from, dest));
    }
    await loadDocs();
  };

  const commitRename = async () => {
    if (!renaming) return;
    const newName = renameValue.trim();
    const oldName = baseName(renaming);
    if (!newName || newName === oldName) {
      cancelRename();
      return;
    }
    const dest = joinPath(dirName(renaming), newName);
    try {
      await relocate(renaming, dest);
    } catch (err) {
      toasts.add({
        title: `Failed to rename: ${(err as Error).message}`,
        variant: "error",
      });
    } finally {
      cancelRename();
    }
  };

  const moveTo = async (from: string, targetDir: string) => {
    // Reject self/descendant moves; same-dir moves are no-ops.
    if (targetDir === from || targetDir.startsWith(from + "/")) return;
    if (dirName(from) === targetDir) return;
    const dest = joinPath(targetDir, baseName(from));
    try {
      await relocate(from, dest);
    } catch (err) {
      toasts.add({
        title: `Failed to move: ${(err as Error).message}`,
        variant: "error",
      });
    }
  };

  // Open the confirmation dialog. Locally-created empty folders are state-only, so remove them
  // instantly without a prompt.
  const deletePath = (path: string, isDir: boolean) => {
    if (isDir && pendingFolders.has(path)) {
      setPendingFolders((p) => {
        const n = new Set(p);
        n.delete(path);
        return n;
      });
      return;
    }
    const count = isDir
      ? docs.filter((d) => d.path === path || d.path.startsWith(path + "/")).length
      : 0;
    setPendingDelete({ path, isDir, count });
  };

  const performDeletePath = async () => {
    if (!pendingDelete) return;
    const { path, isDir } = pendingDelete;
    setDeletingPath(true);
    try {
      if (isDir) {
        const inDir = docs.filter(
          (d) => d.path === path || d.path.startsWith(path + "/"),
        );
        await runWithConcurrency(inDir, 6, (d) =>
          context.deleteContextDocument(collectionId, d.path),
        );
      } else {
        await context.deleteContextDocument(collectionId, path);
      }

      afterDeleteExitRef.current = () => {
        if (isDir) {
          if (selectedPath === path || selectedPath?.startsWith(path + "/"))
            setSelectedPath(null);
        } else if (selectedPath === path) {
          setSelectedPath(null);
        }
        void loadDocs();
      };
      setPendingDelete(null);
    } catch {
      toasts.add({
        title: isDir ? "Failed to delete folder" : "Failed to delete document",
        variant: "error",
      });
    } finally {
      setDeletingPath(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    let ok = 0,
      failed = 0;
    await runWithConcurrency(Array.from(files), 6, async (file) => {
      try {
        const uploaded = await readUploadFile(file);
        await context.putContextDocument(collectionId, uploaded.path, {
          // Self-describing files supply their own description; others start blank.
          description: extractDescription(uploaded.contentType, uploaded.body) ?? "",
          body: uploaded.body,
          contentType: uploaded.contentType,
        });
        ok++;
      } catch {
        failed++;
      }
    });
    toasts.add({
      title: `Uploaded ${pluralize(ok, "file")}${failed ? `, ${failed} failed` : ""}`,
      variant: failed ? "error" : "success",
    });
    await loadDocs();
  };

  const extraFolders = useMemo(() => [...pendingFolders], [pendingFolders]);
  const tree = useMemo(
    () => buildTree(docs, extraFolders),
    [docs, extraFolders],
  );

  const ctx: TreeCtx = {
    canWrite: canEditDocuments,
    selectedPath,
    expanded,
    toggleFolder,
    selectFile: (path) => {
      setEditOnOpenPath(null);
      setSelectedPath(path);
    },
    creating,
    creatingName,
    setCreatingName,
    startCreate,
    commitCreate,
    cancelCreate,
    renaming,
    renameValue,
    setRenameValue,
    startRename,
    commitRename,
    cancelRename,
    deletePath,
    dragPath,
    setDragPath,
    dragOverDir,
    setDragOverDir,
    moveTo,
  };

  // The collection is gone (deleted by an admin) or no longer accessible.
  if (!loading && !metadata) {
    return (
      <div className="h-full bg-kumo-base px-5 py-4 sm:px-8">
        <div className="mx-auto max-w-[520px]">
          <button
            onClick={onBack}
            className="press -ml-1 mb-4 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            <CaretLeft size={14} />
            Context &amp; Skills
          </button>
          <div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-10 text-center shadow-[0_1px_2px_rgba(20,17,16,0.03)]">
            <BookOpen size={32} className="mx-auto mb-3 text-kumo-subtle" />
            <p className="m-0 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
              This collection is no longer available
            </p>
            <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              It may have been deleted.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ctx-rise flex h-full w-full min-w-0 overflow-hidden bg-kumo-base">
      {metadata && (
        <CollectionSettingsModal
          open={settingsOpen}
          initialMode={settingsMode}
          metadata={metadata}
          supportsGitCollections={supportsGitCollections}
          collectionId={collectionId}
          onClose={() => setSettingsOpen(false)}
          onUpdated={loadDocs}
          onDeleted={onBack}
        />
      )}

      {metadata?.content.source === "git" && supportsGitCollections && (
        <GitTokenManagementModal
          open={gitTokensOpen}
          collectionId={collectionId}
          branch={metadata.content.branch}
          onClose={() => setGitTokensOpen(false)}
        />
      )}

      {shareOpen && metadata && (
        <ShareCollectionDialog
          collection={{ id: collectionId, title: metadata.title }}
          onChanged={() => void loadDocs()}
          onLeft={onBack}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* In-app confirmation for tree ⋮ deletes (files and folders). */}
      <Dialog.Root
        open={!!pendingDelete && deletePresentation.presenting}
        onOpenChange={(next: boolean) => {
          if (!deletingPath && !next) setPendingDelete(null);
        }}
        onOpenChangeComplete={(next: boolean) => {
          deletePresentation.onOpenChangeComplete(next);
          if (!next) {
            afterDeleteExitRef.current?.();
            afterDeleteExitRef.current = null;
          }
        }}
      >
        <Dialog
          className="z-[1000]! w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <ModalHeader
            title={pendingDelete?.isDir ? "Delete folder" : "Delete document"}
            description={
              <DeletePermanentlyDescription
                name={pendingDelete ? baseName(pendingDelete.path) : ""}
                documents={
                  pendingDelete?.isDir && pendingDelete.count > 0
                    ? pendingDelete.count
                    : undefined
                }
              />
            }
          />
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
            <WorkshopButton
              tone="secondary"
              className="!h-9"
              disabled={deletingPath}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </WorkshopButton>
            <WorkshopButton
              tone="danger"
              className="!h-9"
              onClick={performDeletePath}
              loading={deletingPath}
            >
              {pendingDelete?.isDir ? "Delete folder" : "Delete document"}
            </WorkshopButton>
          </div>
        </Dialog>
      </Dialog.Root>

      {/*
        Fresh split workspace: persistent contents on the left, selected reading/editing surface on
        the right. It intentionally fills the iframe edge-to-edge like the app chrome and the skill
        manager references: one vertical rule, no nested cards, no dead header band.
      */}
      <aside
        className={`${selectedPath ? "hidden sm:flex" : "flex"} min-h-0 w-full flex-col overflow-x-hidden border-r border-kumo-line bg-kumo-base sm:w-[320px] sm:shrink-0`}
      >
        <div className="flex h-14 shrink-0 items-center px-5">
          <button
            onClick={onBack}
            className="press -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            <CaretLeft size={14} />
            Context &amp; Skills
          </button>
        </div>
          {metadata && (
            <div className="px-3 py-2.5">
              {/* The collection root doubles as a nav target back to the overview, and sits active
                  when nothing is selected. */}
              <div
                className={`flex items-center rounded-lg ${selectedPath ? "hover:bg-kumo-tint" : "bg-kumo-recessed"}`}
              >
                <button
                  onClick={() => setSelectedPath(null)}
                  title="Collection overview"
                  aria-current={selectedPath ? undefined : "page"}
                  className="flex min-w-0 flex-1 transform-none items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring/30 active:scale-100"
                >
                  <CollectionIconTile icon={metadata.icon} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 tracking-[-0.25px] text-kumo-default">
                    {metadata.title}
                  </span>
                </button>
                <div className="pr-1 sm:hidden">
                  <CollectionOptionsMenu
                    permissions={permissions}
                    isSynced={metadata.content.source === "git"}
                    supportsGitCollections={supportsGitCollections}
                    onEditDetails={() => openSettings("edit")}
                    onManageGitTokens={() => setGitTokensOpen(true)}
                    onShare={() => setShareOpen(true)}
                    onDelete={() => openSettings("delete")}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-5">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
              Files
            </span>
            {canEditDocuments && (
              <>
            <KebabMenu
              trigger={
                <WorkshopIconButton
                  aria-label="Add"
                  title="Add file or folder"
                  className="!h-6 !w-6 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
                >
                  <Plus size={14} weight="bold" />
                </WorkshopIconButton>
              }
            >
              <DropdownMenu.Item
                icon={<FilePlus size={13} className="mr-2" />}
                onClick={() => startCreate("", "file")}
                className={MENU_ITEM}
              >
                New file
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<FolderPlus size={13} className="mr-2" />}
                onClick={() => startCreate("", "folder")}
                className={MENU_ITEM}
              >
                New folder
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={<UploadSimple size={13} className="mr-2" />}
                onClick={() => fileInputRef.current?.click()}
                className={MENU_ITEM}
              >
                Upload files
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<Folder size={13} className="mr-2" />}
                onClick={() => dirInputRef.current?.click()}
                className={MENU_ITEM}
              >
                Upload folder
              </DropdownMenu.Item>
            </KebabMenu>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={dirInputRef}
              type="file"
              multiple
              // @ts-expect-error non-standard directory upload attribute
              webkitdirectory=""
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
              </>
            )}
          </div>
          <div className="ctx-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-6 pt-0.5">
            {loading ? (
              <p className="px-2 py-2 text-[13px] text-kumo-subtle">Loading…</p>
            ) : docs.length === 0 && pendingFolders.size === 0 && !creating ? (
              <p className="px-2 py-2 text-[12px] leading-5 text-kumo-inactive">
                {metadata?.content.source === "git"
                  ? supportsGitCollections
                    ? "No files yet. Mirror content from git, then refresh."
                    : "No Git content was cached before synchronization became unavailable."
                  : permissions.canEdit ? "No files yet. Use + to create or upload skills or files." : "No files yet."}
              </p>
            ) : (
              <FolderView folder={tree} depth={0} ctx={ctx} />
            )}
          </div>
      </aside>

      {/* Detail: the selected document, or the collection overview when nothing is selected. */}
      <section className={`${selectedPath ? "flex" : "hidden sm:flex"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-kumo-base`}>
          {selectedPath ? (
            <>
              {/* Mobile-only: return to the file index (desktop shows both panes already). */}
              <button
                onClick={() => setSelectedPath(null)}
                className="flex sm:hidden flex-shrink-0 items-center gap-1 border-b border-kumo-line px-4 py-2.5 text-[13px] text-kumo-subtle transition-colors hover:text-kumo-default"
              >
                <CaretLeft size={14} />
                Files
              </button>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <DocumentEditor
                  key={selectedPath}
                  collectionId={collectionId}
                  path={selectedPath}
                  readOnly={!canEditDocuments}
                  initialMode={editOnOpenPath === selectedPath ? "edit" : "read"}
                  onDirtyChange={setDirty}
                  onChanged={loadDocs}
                  onRenamed={(newPath) => {
                    setDirty(false);
                    setSelectedPath(newPath);
                    loadDocs();
                  }}
                  onRequestDelete={() => deletePath(selectedPath, false)}
                />
              </div>
            </>
          ) : metadata ? (
            <CollectionOverview
              metadata={metadata}
              permissions={permissions}
              sharing={sharing}
              supportsGitCollections={supportsGitCollections}
              refreshingSource={refreshingSource}
              onRefreshSource={handleRefreshArtifactSource}
              onEditDetails={() => openSettings("edit")}
              onManageGitTokens={() => setGitTokensOpen(true)}
              onShare={() => setShareOpen(true)}
              onDelete={() => openSettings("delete")}
            />
          ) : null}
      </section>
    </div>
  );
}
