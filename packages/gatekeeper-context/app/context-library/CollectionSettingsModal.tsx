/** Modal for editing a collection's details or deleting it. */

import { Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { DEFAULT_GIT_BRANCH } from "../../src/context-types";
import type { ContextCollectionMetadata } from "../../src/context-types";
import { useContextApi, usePresentWhileOpen } from "../bridge";
import { DEFAULT_COLLECTION_ICON } from "../components/CollectionIconPicker";
import { CollectionDescriptionField, CollectionNameField, DeletePermanentlyDescription, FieldLabel, ModalHeader, WorkshopButton, WorkshopInput } from "./ui";

export function CollectionSettingsModal({
  open,
  // Which step to open on. "delete" lands on the type-to-confirm step, not immediate deletion.
  initialMode,
  metadata,
  supportsGitCollections,
  collectionId,
  onClose,
  onUpdated,
  onDeleted,
}: {
  open: boolean;
  initialMode: "edit" | "delete";
  metadata: ContextCollectionMetadata;
  supportsGitCollections: boolean;
  collectionId: string;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  const [mode, setMode] = useState<"edit" | "delete">(initialMode);
  const [title, setTitle] = useState(metadata.title);
  const [description, setDescription] = useState(metadata.description);
  const [icon, setIcon] = useState(metadata.icon ?? DEFAULT_COLLECTION_ICON);
  const [branch, setBranch] = useState(metadata.content.source === "git" ? metadata.content.branch : DEFAULT_GIT_BRANCH);
  const [confirmText, setConfirmText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset state each time the modal opens, syncing to the latest metadata.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setTitle(metadata.title);
      setDescription(metadata.description);
      setIcon(metadata.icon ?? DEFAULT_COLLECTION_ICON);
      setBranch(metadata.content.source === "git" ? metadata.content.branch : DEFAULT_GIT_BRANCH);
      setConfirmText("");
      setSaving(false);
      setDeleting(false);
    }
  }, [open, initialMode, metadata.title, metadata.description, metadata.icon, metadata.content]);

  const busy = saving || deleting;

  // Save is only meaningful once something actually differs from the saved collection.
  const hasChanges =
    title.trim() !== metadata.title ||
    description.trim() !== metadata.description ||
    icon !== (metadata.icon ?? DEFAULT_COLLECTION_ICON) ||
    (metadata.content.source === "git" && supportsGitCollections &&
      branch.trim() !== metadata.content.branch);

  const handleSave = async () => {
    const updates: {
      title?: string;
      description?: string;
      icon?: string;
      branch?: string;
    } = {};
    if (title.trim() !== metadata.title) updates.title = title.trim();
    if (description.trim() !== metadata.description)
      updates.description = description.trim();
    if (icon !== (metadata.icon ?? DEFAULT_COLLECTION_ICON))
      updates.icon = icon;
    if (metadata.content.source === "git" && supportsGitCollections &&
        branch.trim() !== metadata.content.branch)
      updates.branch = branch.trim();
    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }
    if (!title.trim()) {
      toasts.add({ title: "Name can't be empty", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await context.updateContextCollection(collectionId, updates);
      toasts.add({ title: "Collection updated", variant: "success" });
      onUpdated();
      onClose();
    } catch {
      toasts.add({ title: "Failed to update collection", variant: "error" });
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await context.deleteContextCollection(collectionId);
      toasts.add({ title: "Collection deleted", variant: "success" });
      onDeleted();
    } catch {
      toasts.add({ title: "Failed to delete collection", variant: "error" });
      setDeleting(false);
    }
  };

  const canDelete = confirmText.trim() === metadata.title.trim() && !deleting;

  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! w-[min(480px,calc(100vw-32px))]! overflow-visible bg-kumo-base p-0 top-[14%]! translate-y-0!"
        size="sm"
      >
        {mode === "edit" ? (
          <>
            <ModalHeader title="Edit collection" />

            <div className="space-y-5 px-4 py-5 sm:px-6">
              <div>
                <CollectionNameField
                  icon={icon}
                  onIconChange={setIcon}
                  value={title}
                  onChange={setTitle}
                  onEnter={handleSave}
                  autoFocus
                />
              </div>
              <div>
                <CollectionDescriptionField value={description} onChange={setDescription} />
              </div>
              {metadata.content.source === "git" && supportsGitCollections && (
                <div>
                  <FieldLabel>Git branch</FieldLabel>
                  <WorkshopInput
                    value={branch}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter" && hasChanges && title.trim()) void handleSave();
                    }}
                    placeholder={DEFAULT_GIT_BRANCH}
                    className="w-full"
                  />
                  <p className="mt-1 text-[12px] leading-4 text-kumo-subtle">
                    This branch to pull from when refreshing the collection.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
              <WorkshopButton tone="secondary" className="!h-9" disabled={saving} onClick={onClose}>
                Cancel
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleSave}
                loading={saving}
                disabled={!hasChanges || !title.trim()}
              >
                Save
              </WorkshopButton>
            </div>
          </>
        ) : (
          <>
            <ModalHeader
              title="Delete collection"
              description={
                <DeletePermanentlyDescription
                  name={metadata.title}
                  documents={metadata.documentCount}
                />
              }
            />

            <div className="px-4 py-5 sm:px-6">
              <FieldLabel>
                Type{" "}
                <span className="font-mono text-kumo-default">
                  {metadata.title}
                </span>{" "}
                to confirm
              </FieldLabel>
              <WorkshopInput
                value={confirmText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setConfirmText(e.target.value)
                }
                placeholder={metadata.title}
                disabled={deleting}
                autoFocus
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
              <WorkshopButton
                tone="danger"
                className="!h-9"
                onClick={handleDelete}
                disabled={!canDelete}
                loading={deleting}
              >
                Delete collection
              </WorkshopButton>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
