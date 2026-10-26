/** The document editor: toolbar, body renderer (image/markdown/text), and rename/delete flows. */

import { useKumoToastManager } from "@cloudflare/kumo";
import { Code, Eye, PencilSimple, Trash, UploadSimple } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { contentTypeFromPath, isImageContentType, isMarkdownContentType, isTextContentType } from "../../src/context-types";
import { extractDescription } from "../../src/description-extractors";
import { useContextApi } from "../bridge";
import { fileToBase64 } from "../uploadFiles";
import { MarkdownPreview } from "./MarkdownPreview";
import { SourceEditor } from "./SourceEditor";
import { baseName, dataUri, dirName, joinPath } from "./paths";
import { WorkshopButton } from "./ui";

type DocumentBodyRenderProps = {
  body: string;
  collectionId: string;
  contentType: string;
  filename: string;
  isImage: boolean;
  isMarkdown: boolean;
  isText: boolean;
  mode: "read" | "edit";
  path: string;
  readOnly: boolean;
  onBodyChange: (value: string) => void;
};

function renderDocumentBody({
  body,
  collectionId,
  contentType,
  filename,
  isImage,
  isMarkdown,
  isText,
  mode,
  path,
  readOnly,
  onBodyChange,
}: DocumentBodyRenderProps): ReactNode {
  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img
          src={dataUri(contentType, body)}
          alt={filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (!isText) {
    return (
      <div className="p-4 text-[13px] text-kumo-subtle">
        Binary document ({contentType}, {Math.round((body.length * 3) / 4 / 1024)} KB). Use Replace to
        update it.
      </div>
    );
  }

  if (isMarkdown && mode === "read") {
    return (
      <MarkdownPreview
        body={body}
        collectionId={collectionId}
        documentPath={path}
      />
    );
  }

  return (
    <SourceEditor
      value={body}
      path={path}
      readOnly={readOnly || mode === "read"}
      onChange={onBodyChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Document Editor (right pane)
// ---------------------------------------------------------------------------

export function DocumentEditor({
  collectionId,
  path,
  readOnly,
  initialMode = "read",
  onChanged,
  onRenamed,
  onRequestDelete,
  onDirtyChange,
}: {
  collectionId: string;
  path: string;
  /** Hide mutating controls and lock editors when true. */
  readOnly: boolean;
  initialMode?: "read" | "edit";
  onChanged: () => void;
  /** Parent re-selects + reloads after rename. */
  onRenamed: (newPath: string) => void;
  onRequestDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  // File name is the title; editing it renames the document.
  const [filename, setFilename] = useState(baseName(path));
  const [renaming, setRenaming] = useState(false);
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [skillName, setSkillName] = useState<string | null>(null);
  // The stored type determines whether the body is literal text or base64; the path is only a
  // fallback while the document loads.
  const [contentType, setContentType] = useState(() => contentTypeFromPath(path));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedDocumentRef = useRef<{ description: string; body: string } | null>(null);
  // Documents open in View unless the caller requests Edit. For markdown, View is the rendered
  // preview and Edit the source; for other text, View is read-only source; for images/binaries,
  // Edit unlocks the description and Replace (the body itself is swapped, not edited inline).
  const [mode, setMode] = useState<"read" | "edit">(
    readOnly || initialMode !== "edit" ? "read" : "edit",
  );

  function documentIsDirty(nextDescription: string, nextBody: string): boolean {
    const saved = savedDocumentRef.current;
    if (!saved) return false;
    if (nextBody !== saved.body) return true;
    return (
      extractDescription(contentType, nextBody) === null &&
      nextDescription.trim() !== saved.description
    );
  }

  // Report dirty state for navigation guards.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    context.getContextDocument(collectionId, path).then((d) => {
      if (cancelled) return;
      if (d) {
        // Self-describing files use extractedDescription below instead.
        savedDocumentRef.current = { description: d.description, body: d.body };
        setDescription(d.description);
        setBody(d.body);
        setContentType(d.contentType);
        setSkillName(d.skillName ?? null);
        setDirty(false);
        setMode(readOnly || initialMode !== "edit" ? "read" : "edit");
      }
      // Also clears loading for not-found.
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setLoading(false);
      toasts.add({
        title: `Failed to load document: ${(err as Error).message}`,
        variant: "error",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [context, collectionId, path]);

  const isText = isTextContentType(contentType);
  const isImage = isImageContentType(contentType);
  const isMarkdown = isMarkdownContentType(contentType);
  // Some formats own their description (frontmatter/YAML/JSON); otherwise the author provides it.
  const extractedDescription = useMemo(
    () => extractDescription(contentType, body),
    [contentType, body],
  );
  const effectiveDescription = extractedDescription ?? description;

  const save = async (overrides?: { body?: string; contentType?: string }) => {
    setSaving(true);
    try {
      const savedBody = overrides?.body ?? body;
      const savedDescription = effectiveDescription.trim();
      await context.putContextDocument(collectionId, path, {
        description: savedDescription,
        body: savedBody,
        contentType: overrides?.contentType ?? contentType,
      });
      let saved = await context.getContextDocument(collectionId, path);
      savedDocumentRef.current = {
        description: saved?.description ?? savedDescription,
        body: saved?.body ?? savedBody,
      };
      setContentType(saved?.contentType ?? overrides?.contentType ?? contentType);
      setSkillName(saved?.skillName ?? null);
      setDirty(false);
      toasts.add({ title: "Saved", variant: "success" });
      onChanged();
    } catch {
      toasts.add({ title: "Failed to save", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Rename within the same directory; save dirty text first.
  const commitRename = async () => {
    const trimmed = filename.trim();
    if (!trimmed || trimmed === baseName(path)) {
      setFilename(baseName(path));
      return;
    }
    if (trimmed.includes("/")) {
      toasts.add({ title: "File name can't contain '/'", variant: "error" });
      setFilename(baseName(path));
      return;
    }
    const newPath = joinPath(dirName(path), trimmed);
    setRenaming(true);
    try {
      if (isText && dirty) await save();
      await context.moveContextDocument(collectionId, path, newPath);
      onRenamed(newPath);
    } catch (err) {
      toasts.add({ title: `Rename failed: ${(err as Error).message}`, variant: "error" });
      setFilename(baseName(path));
    } finally {
      setRenaming(false);
    }
  };

  const replaceFile = async (file: File) => {
    const newBody = await fileToBase64(file);
    setBody(newBody);
    await save({ body: newBody });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
        Loading…
      </div>
    );
  }

  // Editable files get a View/Edit toggle; read-only markdown gets rendered/source. Read-only
  // non-markdown (plain text, images, binaries) has nothing to toggle.
  const showModeToggle = !readOnly || isMarkdown;
  const descriptionIsEditable = !readOnly && extractedDescription === null && mode === "edit";

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-line px-6 sm:px-10">
        <div className="min-w-0 flex-1">
          <input
            value={filename}
            readOnly={readOnly || renaming}
            onChange={(e) => setFilename(e.target.value)}
            onBlur={() => { if (!readOnly) commitRename(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              else if (e.key === "Escape") { setFilename(baseName(path)); e.currentTarget.blur(); }
            }}
            className="w-full bg-transparent text-[18px] font-semibold leading-6 tracking-[-0.4px] text-kumo-default focus:outline-none"
            placeholder="file-name.md"
            title="File name — edit to rename (the extension sets the type)"
          />

        </div>
        {/* Contextual actions sit left of the toggle so the always-present toggle/delete cluster
            stays right-anchored — toggling View/Edit never shifts the toggle. */}
        {!readOnly && dirty && (
          // Disabled overrides keep the inactive state grey rather than faded orange.
          <WorkshopButton
            tone="primary"
            className="!h-8 !bg-kumo-contrast !text-kumo-inverse enabled:hover:!bg-kumo-strong disabled:!bg-kumo-fill disabled:!text-kumo-inactive disabled:!opacity-100"
            onClick={() => save()}
            loading={saving}
            disabled={!dirty}
          >
            Save
          </WorkshopButton>
        )}
        {!readOnly && !isText && mode === "edit" && (
          <label className="press flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-kumo-line px-2.5 text-[12px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <UploadSimple size={14} /> Replace
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replaceFile(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
        {showModeToggle && (
          <div className="inline-flex h-8 shrink-0 items-center rounded-lg border border-kumo-line bg-kumo-fill p-0.5">
            {[
              { m: "read" as const, Icon: Eye, label: "View" },
              { m: "edit" as const, Icon: readOnly ? Code : PencilSimple, label: readOnly ? "Source" : "Edit" },
            ].map(({ m, Icon, label }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={label}
                aria-label={label}
                aria-pressed={mode === m}
                className={`press inline-flex h-full items-center justify-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  mode === m
                    ? "bg-kumo-base text-kumo-default shadow-sm ring-1 ring-kumo-line"
                    : "text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        )}
        {!readOnly && (
          <>
          {/* Separate the destructive action from Save so it can't be fat-fingered. */}
          <span className="mx-0.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden="true" />
          <button
            onClick={onRequestDelete}
            title="Delete document"
            className="press flex h-8 w-8 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-danger"
          >
            <Trash size={16} />
          </button>
          </>
        )}
      </div>

      {/* "When to use this" — the agent-facing purpose (used for retrieval & search). Files that
          declare their own description show it read-only; otherwise the author writes it. */}
      <div className="border-b border-kumo-line px-6 py-3.5 sm:px-10">
        <label className="mb-1.5 block text-[12px] font-medium tracking-[-0.15px] text-kumo-subtle">
          When to use this
          {skillName && (
            <span className="ml-1 font-mono text-kumo-brand">· /{skillName}</span>
          )}
          {extractedDescription !== null && (
            <span
              className="ml-1 text-kumo-inactive"
              title="Defined in this file; edit it in the document below."
            >
              · from file
            </span>
          )}
        </label>
        {extractedDescription !== null ? (
          <p className="max-w-3xl text-[14px] leading-5 tracking-[-0.2px] text-kumo-default">
            {effectiveDescription || (
              <span className="italic text-kumo-inactive">No description in this file yet.</span>
            )}
          </p>
        ) : descriptionIsEditable ? (
          <input
            value={description}
            onChange={(e) => {
              const nextDescription = e.target.value;
              setDescription(nextDescription);
              setDirty(documentIsDirty(nextDescription, body));
            }}
            placeholder="Describe what this document contains and when an agent should use it…"
            className="w-full bg-transparent text-[14px] leading-5 tracking-[-0.2px] text-kumo-default placeholder:text-kumo-inactive focus:outline-none"
          />
        ) : (
          <p className="max-w-3xl text-[14px] leading-5 tracking-[-0.2px] text-kumo-default">
            {description || (
              <span className="italic text-kumo-inactive">No description yet.</span>
            )}
          </p>
        )}
      </div>

      {/* Body — renders directly on the recessed panel (one cohesive surface, not a card in a card). */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {renderDocumentBody({
          body,
          collectionId,
          contentType,
          filename,
          isImage,
          isMarkdown,
          isText,
          mode,
          path,
          readOnly,
          onBodyChange: (v) => {
            setBody(v);
            setDirty(documentIsDirty(description, v));
          },
        })}
      </div>

    </div>
  );
}
