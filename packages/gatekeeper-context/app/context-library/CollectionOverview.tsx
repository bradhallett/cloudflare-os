/** The collection overview — identity, description, and metadata for the detail pane. */

import { DropdownMenu } from "@cloudflare/kumo";
import { Buildings, DotsThree, FileText, Key, PencilSimple, ShareNetwork, Trash, User, Users } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ContextCollectionMetadata, ContextCollectionPermissions, ContextCollectionSharing } from "../../src/context-types";
import { COLLECTION_ROLE_LABELS } from "../skills/collectionRole";
import { CollectionIconTile, KebabMenu, MENU_ITEM, MENU_ITEM_DANGER, WorkshopButton, WorkshopIconButton } from "./ui";

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function MetaField({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col gap-1 ${align === "right" ? "items-end text-right" : ""}`}>
      <span className="text-[11px] leading-none font-medium tracking-[-0.1px] text-kumo-inactive">
        {label}
      </span>
      <span className="text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-default">
        {children}
      </span>
    </div>
  );
}

/**
 * The collection overview — identity, description, and metadata shown in the detail pane when no
 * file is selected. Collection-level actions (edit/share/delete) live on the index's ⋮ menu.
 */
export function CollectionOverview({
  metadata,
  permissions,
  sharing,
  supportsGitCollections,
  refreshingSource,
  onRefreshSource,
  onEditDetails,
  onManageGitTokens,
  onShare,
  onDelete,
}: {
  metadata: ContextCollectionMetadata;
  permissions: ContextCollectionPermissions;
  /** Private collections only; null while loading or when it could not be read. */
  sharing: ContextCollectionSharing | null;
  supportsGitCollections: boolean;
  refreshingSource: boolean;
  onRefreshSource: () => void;
  onEditDetails: () => void;
  onManageGitTokens: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const isPublic = metadata.visibility === "public";
  const isSynced = metadata.content.source === "git";
  const viewerRole = sharing?.members.find((member) => member.isViewer)?.role;
  const sharedRole = viewerRole === "owner" ? undefined : viewerRole;
  const othersCanRead = Boolean(sharing && (sharing.everyoneCanView || sharing.members.length > 1));
  return (
    <div className="ctx-scroll @container min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[850px] px-8 py-10 sm:px-11 sm:py-12">
        <header>
          <div className="flex items-center justify-between gap-6">
            <div className="flex min-w-0 items-start gap-4">
              <CollectionIconTile icon={metadata.icon} size="lg" />
              <div className="min-w-0 pt-0.5">
                <h1 className="truncate text-2xl font-semibold leading-8 tracking-tight text-kumo-default">
                  {metadata.title}
                </h1>
                <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
                  Context collection
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {permissions.canEdit && isSynced && supportsGitCollections && (
                <WorkshopButton
                  tone="secondary"
                  className="h-9!"
                  onClick={onRefreshSource}
                  loading={refreshingSource}
                >
                  Refresh
                </WorkshopButton>
              )}
              <CollectionOptionsMenu
                permissions={permissions}
                isSynced={isSynced}
                supportsGitCollections={supportsGitCollections}
                onEditDetails={onEditDetails}
                onManageGitTokens={onManageGitTokens}
                onShare={onShare}
                onDelete={onDelete}
              />
            </div>
          </div>

          <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-5 @xl:grid-cols-4">
            <MetaField label="Source">
              <span className="inline-flex items-center gap-1.5">
                {isPublic
                  ? <Buildings size={12} className="shrink-0" />
                  : sharedRole || othersCanRead
                  ? <Users size={12} className="shrink-0" />
                  : <User size={12} className="shrink-0" />}
                {isPublic
                  ? "Your organization"
                  : sharing && !sharing.hasOwner
                  ? "No active owner"
                  : sharedRole
                  ? `Shared with you · ${COLLECTION_ROLE_LABELS[sharedRole]}`
                  : "You"}
              </span>
            </MetaField>
            <MetaField label="Access">
              {isPublic
                ? "Everyone (required)"
                : sharing?.everyoneCanView
                ? "Anyone in your organization"
                : sharing && sharing.members.length > 1
                ? `${sharing.members.length} people`
                : "Private to you"}
            </MetaField>
            <MetaField label="Documents">{metadata.documentCount}</MetaField>
            <MetaField label={isSynced ? "Refreshed" : "Updated"} align="right">
              {metadata.content.source === "git"
                ? formatRelativeTime(metadata.content.lastRefreshedAt)
                : formatRelativeTime(metadata.lastUpdated)}
            </MetaField>
          </div>
        </header>

        {isSynced && !supportsGitCollections && (
          <section className="mt-8 rounded-xl border border-kumo-line bg-kumo-elevated/60 px-5 py-4">
            <p className="text-[13px] font-medium tracking-[-0.2px] text-kumo-default">
              Git synchronization unavailable
            </p>
            <p className="mt-1 text-[13px] leading-5 tracking-[-0.2px] text-kumo-subtle">
              Git content is read-only and shows its most recently cached version.
            </p>
          </section>
        )}

        <section className="mt-9 border-t border-kumo-line pt-8">
          <p className="mb-3 text-[13px] font-medium leading-none tracking-[-0.2px] text-kumo-subtle">
            Description
          </p>
          {metadata.description ? (
            <p className="max-w-3xl text-[15px] leading-7 tracking-[-0.2px] text-kumo-default">
              {metadata.description}
            </p>
          ) : (
            <p className="text-[13px] italic leading-5 text-kumo-inactive">
              No description yet.
            </p>
          )}
        </section>

        {metadata.documentCount === 0 && (
          <section className="mt-10 rounded-xl border border-kumo-line bg-kumo-elevated/60 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
                <FileText size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium tracking-[-0.2px] text-kumo-default">
                  No files in this collection
                </p>
                <p className="mt-1 max-w-xl text-[13px] leading-5 tracking-[-0.2px] text-kumo-subtle">
                  {isSynced
                    ? supportsGitCollections
                      ? "This git mirror is empty. Mirror content from git, then refresh."
                      : "No Git content was cached before synchronization became unavailable."
                    : permissions.canEdit
                    ? "Use the + in the Files panel to create or upload skills or files. Agents use the names and descriptions to decide what to read."
                    : "This collection is empty."}
                </p>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Renders nothing when the viewer may only read the collection. */
export function CollectionOptionsMenu({
  permissions,
  isSynced,
  supportsGitCollections,
  onEditDetails,
  onManageGitTokens,
  onShare,
  onDelete,
}: {
  permissions: ContextCollectionPermissions;
  isSynced: boolean;
  supportsGitCollections: boolean;
  onEditDetails: () => void;
  onManageGitTokens: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { canEdit, canShare, canDelete } = permissions;
  if (!canEdit && !canShare && !canDelete) return null;
  return (
    <KebabMenu
      trigger={
        <WorkshopIconButton
          aria-label="Collection options"
          title="Options"
          className="!h-9 !w-9 data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
        >
          <DotsThree size={18} weight="bold" />
        </WorkshopIconButton>
      }
    >
      {canEdit && (
        <DropdownMenu.Item
          icon={<PencilSimple size={13} className="mr-2" />}
          onClick={onEditDetails}
          className={MENU_ITEM}
        >
          Edit details
        </DropdownMenu.Item>
      )}
      {canEdit && isSynced && supportsGitCollections && (
        <DropdownMenu.Item
          icon={<Key size={13} className="mr-2" />}
          onClick={onManageGitTokens}
          className={MENU_ITEM}
        >
          Manage git tokens
        </DropdownMenu.Item>
      )}
      {canShare && (
        <DropdownMenu.Item
          icon={<ShareNetwork size={13} className="mr-2" />}
          onClick={onShare}
          className={MENU_ITEM}
        >
          Share
        </DropdownMenu.Item>
      )}
      {canDelete && (canEdit || canShare) && <DropdownMenu.Separator />}
      {canDelete && (
        <DropdownMenu.Item
          icon={<Trash size={13} className="mr-2" />}
          onClick={onDelete}
          className={`${MENU_ITEM_DANGER} text-kumo-danger`}
        >
          Delete collection
        </DropdownMenu.Item>
      )}
    </KebabMenu>
  );
}
