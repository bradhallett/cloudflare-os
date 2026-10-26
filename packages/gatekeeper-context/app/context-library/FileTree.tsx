/** The document file tree: model, folder/file rows, and inline create/rename inputs. */

import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, CaretRight, DotsThree, FilePlus, FileText, FolderPlus, PencilSimple, Trash, Image as ImageIcon } from "@phosphor-icons/react";
import { isImageContentType } from "../../src/context-types";
import type { ContextDocumentSummary } from "../../src/context-types";
import { baseName, dirName } from "./paths";
import { KebabMenu, MENU_ITEM, MENU_ITEM_DANGER, WorkshopIconButton } from "./ui";

export type TreeFolder = {
  name: string;
  path: string; // full path of this folder ("" = root)
  folders: Map<string, TreeFolder>;
  files: ContextDocumentSummary[];
};

/** A folder is a skill when one of its files has a parsed skill name. */
export function isSkillFolder(folder: TreeFolder): boolean {
  return folder.files.some((file) => file.skillName !== undefined);
}

export function buildTree(
  docs: ContextDocumentSummary[],
  extraFolders: string[],
): TreeFolder {
  const root: TreeFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  const ensureFolder = (dir: string): TreeFolder => {
    if (!dir) return root;
    let node = root;
    let acc = "";
    for (const seg of dir.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.folders.has(seg)) {
        node.folders.set(seg, {
          name: seg,
          path: acc,
          folders: new Map(),
          files: [],
        });
      }
      node = node.folders.get(seg)!;
    }
    return node;
  };
  for (const f of extraFolders) ensureFolder(f);
  for (const doc of docs) ensureFolder(dirName(doc.path)).files.push(doc);
  return root;
}

/** Shared state for the recursive tree renderer. */
export type TreeCtx = {
  /** Hides row actions and drag-to-move when false. */
  canWrite: boolean;
  selectedPath: string | null;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  creating: { dir: string; kind: "file" | "folder" } | null;
  creatingName: string;
  setCreatingName: (v: string) => void;
  startCreate: (dir: string, kind: "file" | "folder") => void;
  commitCreate: () => void;
  cancelCreate: () => void;
  renaming: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  startRename: (path: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  deletePath: (path: string, isDir: boolean) => void;
  dragPath: string | null;
  setDragPath: (p: string | null) => void;
  dragOverDir: string | null;
  setDragOverDir: (d: string | null) => void;
  moveTo: (from: string, targetDir: string) => void;
};

// Depth-based indent: 16px per level, files nudged a further 16px to sit under the parent's caret.
const TREE_INDENT = 16;
const treePad = (depth: number, isFile: boolean) =>
  depth * TREE_INDENT + 8 + (isFile ? TREE_INDENT : 0);

/** Hover-kebab trigger styling for tree rows: hidden until row hover / menu open. */
export const TREE_ROW_TRIGGER =
  "!h-5 !w-5 shrink-0 text-kumo-inactive opacity-0 hover:bg-kumo-tint hover:text-kumo-default group-hover:opacity-100 data-[popup-open]:opacity-100";

// Inline text field for the tree's create and rename rows: auto-focus, Enter-commit/Escape-cancel,
// and a blur guard that skips commit when focus moves to an action button. Rename rows pass
// `stopClickPropagation` so a click in the field doesn't select the row behind it.
function TreeInlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  className = "",
  stopClickPropagation = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
  stopClickPropagation?: boolean;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof HTMLButtonElement)) onCommit();
      }}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className={`min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-default outline-none placeholder:text-kumo-inactive ${className}`}
    />
  );
}

function CreateRow({ depth, ctx }: { depth: number; ctx: TreeCtx }) {
  const isFolder = ctx.creating!.kind === "folder";
  return (
    <div
      className="mb-[2px] flex h-7 items-center gap-2 rounded-md bg-kumo-base pr-1.5 ring-1 ring-kumo-ring/40"
      style={{ paddingLeft: `${treePad(depth, !isFolder)}px` }}
    >
      {isFolder ? (
        <CaretRight size={12} className="shrink-0 text-kumo-inactive" />
      ) : (
        <FileText size={14} className="shrink-0 text-kumo-subtle" />
      )}
      <TreeInlineInput
        value={ctx.creatingName}
        onChange={ctx.setCreatingName}
        onCommit={ctx.commitCreate}
        onCancel={ctx.cancelCreate}
        placeholder={isFolder ? "folder-name" : "file-name.md"}
      />
    </div>
  );
}

export function FolderView({
  folder,
  depth,
  ctx,
}: {
  folder: TreeFolder;
  depth: number;
  ctx: TreeCtx;
}) {
  const sortedFolders = [...folder.folders.values()].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedFiles = [...folder.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const isRoot = folder.path === "";
  const open = isRoot || ctx.expanded.has(folder.path);
  const isDragOver = ctx.dragOverDir === folder.path;
  const isSkill = isSkillFolder(folder);

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (ctx.dragPath) {
        e.preventDefault();
        // dragover fires continuously; only update state when the target dir actually changes,
        // otherwise every tick re-renders the whole tree.
        if (ctx.dragOverDir !== folder.path) ctx.setDragOverDir(folder.path);
      }
    },
    onDragLeave: () => {
      if (ctx.dragOverDir === folder.path) ctx.setDragOverDir(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (ctx.dragPath) ctx.moveTo(ctx.dragPath, folder.path);
      ctx.setDragOverDir(null);
      ctx.setDragPath(null);
    },
  };

  return (
    <div>
      {!isRoot && (
        <div
          draggable={ctx.canWrite && ctx.renaming !== folder.path}
          onDragStart={() => ctx.setDragPath(folder.path)}
          onDragEnd={() => {
            ctx.setDragPath(null);
            ctx.setDragOverDir(null);
          }}
          {...(ctx.canWrite ? dropHandlers : {})}
          className={[
            "group relative mb-[2px] flex h-7 items-center gap-1 rounded-md pr-1.5 transition-colors duration-150 ease-out",
            ctx.renaming === folder.path
              ? "bg-kumo-base ring-1 ring-kumo-ring/40"
              : isDragOver
                ? "bg-kumo-brand/10 ring-1 ring-kumo-brand/40"
                : "hover:bg-kumo-tint",
          ].join(" ")}
          style={{ paddingLeft: `${treePad(depth, false)}px` }}
        >
          <button
            onClick={() => ctx.toggleFolder(folder.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {open ? (
              <CaretDown size={12} className="shrink-0 text-kumo-inactive" />
            ) : (
              <CaretRight size={12} className="shrink-0 text-kumo-inactive" />
            )}
            {ctx.renaming === folder.path ? (
              <TreeInlineInput
                value={ctx.renameValue}
                onChange={ctx.setRenameValue}
                onCommit={ctx.commitRename}
                onCancel={ctx.cancelRename}
                stopClickPropagation
                className="font-medium"
              />
            ) : (
              <>
                <span className="min-w-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.2px] text-kumo-default">
                  {folder.name}
                </span>
                {isSkill && (
                  <span
                    title="Contains a valid Agent Skill"
                    className="shrink-0 text-[10px] font-medium uppercase leading-none tracking-[0.4px] text-kumo-inactive"
                  >
                    skill
                  </span>
                )}
              </>
            )}
          </button>
          {ctx.canWrite && ctx.renaming !== folder.path && (
            <KebabMenu
              stopPropagation
              trigger={
                <WorkshopIconButton
                  aria-label={`Actions for ${folder.name}`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  className={TREE_ROW_TRIGGER}
                >
                  <DotsThree size={14} weight="bold" />
                </WorkshopIconButton>
              }
            >
              <DropdownMenu.Item
                icon={<FilePlus size={12} className="mr-2" />}
                onClick={() => ctx.startCreate(folder.path, "file")}
                className={MENU_ITEM}
              >
                New file
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<FolderPlus size={12} className="mr-2" />}
                onClick={() => ctx.startCreate(folder.path, "folder")}
                className={MENU_ITEM}
              >
                New folder
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<PencilSimple size={12} className="mr-2" />}
                onClick={() => ctx.startRename(folder.path)}
                className={MENU_ITEM}
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={<Trash size={12} className="mr-2" />}
                variant="danger"
                onClick={() => ctx.deletePath(folder.path, true)}
                className={MENU_ITEM_DANGER}
              >
                Delete
              </DropdownMenu.Item>
            </KebabMenu>
          )}
        </div>
      )}

      {open && (
        <div
          {...(isRoot ? dropHandlers : {})}
          className={
            isRoot && isDragOver ? "rounded-md ring-1 ring-kumo-brand/40" : ""
          }
        >
          {ctx.creating && ctx.creating.dir === folder.path && (
            <CreateRow depth={depth} ctx={ctx} />
          )}
          {sortedFolders.map((child) => (
            <FolderView
              key={child.path}
              folder={child}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
          {sortedFiles.map((doc) => (
            <FileView
              key={doc.path}
              doc={doc}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileView({
  doc,
  depth,
  ctx,
}: {
  doc: ContextDocumentSummary;
  depth: number;
  ctx: TreeCtx;
}) {
  const Icon = isImageContentType(doc.contentType) ? ImageIcon : FileText;
  const selected = ctx.selectedPath === doc.path;
  const isRenaming = ctx.renaming === doc.path;
  return (
    <div
      draggable={ctx.canWrite && !isRenaming}
      onDragStart={() => ctx.setDragPath(doc.path)}
      onDragEnd={() => {
        ctx.setDragPath(null);
        ctx.setDragOverDir(null);
      }}
      className={[
        "group relative mb-[2px] flex h-7 items-center gap-2 rounded-md pr-1.5 text-[13px] leading-[18px] tracking-[-0.2px] transition-colors duration-150 ease-out",
        isRenaming
          ? "bg-kumo-base ring-1 ring-kumo-ring/40"
          : selected
            ? "cursor-pointer bg-kumo-recessed text-kumo-default"
            : "cursor-pointer text-kumo-default hover:bg-kumo-tint",
      ].join(" ")}
      style={{ paddingLeft: `${treePad(depth, true)}px` }}
      onClick={isRenaming ? undefined : () => ctx.selectFile(doc.path)}
      title={doc.description || undefined}
    >
      <Icon size={14} className={`shrink-0 ${selected ? "text-kumo-default" : "text-kumo-subtle"}`} />
      {isRenaming ? (
        <TreeInlineInput
          value={ctx.renameValue}
          onChange={ctx.setRenameValue}
          onCommit={ctx.commitRename}
          onCancel={ctx.cancelRename}
          stopClickPropagation
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>
          {baseName(doc.path)}
        </span>
      )}
      {ctx.canWrite && !isRenaming && (
        <KebabMenu
          stopPropagation
          trigger={
            <WorkshopIconButton
              aria-label={`Actions for ${baseName(doc.path)}`}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className={TREE_ROW_TRIGGER}
            >
              <DotsThree size={14} weight="bold" />
            </WorkshopIconButton>
          }
        >
          <DropdownMenu.Item
            icon={<PencilSimple size={12} className="mr-2" />}
            onClick={() => ctx.startRename(doc.path)}
            className={MENU_ITEM}
          >
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<Trash size={12} className="mr-2" />}
            variant="danger"
            onClick={() => ctx.deletePath(doc.path, false)}
            className={MENU_ITEM_DANGER}
          >
            Delete
          </DropdownMenu.Item>
        </KebabMenu>
      )}
    </div>
  );
}
