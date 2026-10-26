import type { RefObject } from 'react'
import { Link } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import {
  ShareNetwork, Pencil, Check, X, Hexagon, Blueprint, Trash, DotsThree, GitBranch,
} from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, GadgetClient, GadgetMetadata, NotificationMute, Overseer,
  WorkpieceId, WorkpieceSummary,
} from '@gadgets/workshop-shared/api'
import UserMenu from './components/UserMenu'
import SiteLogo from './components/SiteLogo'
import { GadgetPresence } from './components/GadgetPresence'
import ActivityNotifications from './ActivityNotifications'
import TopBarNotice from './TopBarNotice'
import GadgetExportMenu from './GadgetExportMenu'
import ReconnectingChip from './components/ReconnectingChip'
import { WorkspaceNotificationsMenu } from './features/notifications/WorkspaceNotificationsMenu'
import { WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './components/menuStyles'
import { isImeComposing } from './keyboardEvent'
import { FormatGlyph } from './components/format/FormatVisuals'
import type { ActivityView } from './Activity'

/** The header's running-cost figure, rounded down below a cent like the backend's own display. */
export function formatHeaderCost(cost: number) {
  if (cost === 0) return '$0'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

/** How a workpiece is drawn in tabs and labels: a gadget by its format, a worktree as a branch. */
export function WorkpieceGlyph({ summary, className }: { summary: WorkpieceSummary; className?: string }) {
  if (summary.type === 'worktree') {
    return <GitBranch size={11} className={className} weight="regular" />
  }
  return <FormatGlyph output={summary.output} size="sm" className={className} weight="regular" />
}

/** The menu item that opens the "Update from blueprint" dialog, in the desktop and mobile menus. */
export const UpdateFromBlueprintLabel = ({ updateAvailable }: { updateAvailable: boolean }) => (
  <>
    <span className="min-w-0 flex-1">Update from blueprint…</span>
    {updateAvailable && (
      <span className="ml-3 flex-shrink-0 text-[11px] leading-4 font-medium text-kumo-brand">
        Update available
      </span>
    )}
  </>
)

interface TopbarProps {
  height: number
  metadata: GadgetMetadata
  overseerStub: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  workspaceId: string
  currentUserId: string | null
  isEditingTitle: boolean
  titleInput: string
  onTitleInputChange: (value: string) => void
  onSaveTitle: () => void
  onCancelTitleEdit: () => void
  onStartTitleEdit: () => void
  showReconnecting: boolean
  onOpenActivity: (view: ActivityView) => void
  onShare: () => void
  onPublishBlueprint: () => void
  onUpdateFromBlueprint: () => void
  blueprintUpdateAvailable: boolean
  builtFromScratch: boolean
  canUpdateFromBlueprint: boolean
  selectedGadgetStub: RpcStub<GadgetClient> | null
  selectedGadgetTitle: string
  previewChatId: number | undefined
  onDeleteWorkspace: () => void
}

/**
 * The shared top bar: identity (logo / editable title), presence and cost, workspace actions
 * (share, blueprints, delete), and the user menu. Purely presentational over the editor's state.
 */
export function GadgetEditorTopbar({
  height, metadata, overseerStub, authenticatedApi, workspaceId, currentUserId,
  isEditingTitle, titleInput, onTitleInputChange, onSaveTitle, onCancelTitleEdit, onStartTitleEdit,
  showReconnecting, onOpenActivity, onShare, onPublishBlueprint, onUpdateFromBlueprint,
  blueprintUpdateAvailable, builtFromScratch, canUpdateFromBlueprint,
  selectedGadgetStub, selectedGadgetTitle, previewChatId, onDeleteWorkspace,
}: TopbarProps) {
  return (
    <div
      className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
      style={{ height, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
    >
      <TopBarNotice />
      {/* Left: logo / title */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link
          to="/"
          aria-label="Home"
          className="flex-shrink-0 hover:opacity-80 transition-opacity"
        >
          <SiteLogo size={22}>
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </SiteLogo>
        </Link>

        <span className="text-kumo-inactive flex-shrink-0">/</span>

        {isEditingTitle ? (
          <div className="flex min-w-0 items-center gap-1">
            <WorkshopInput
              type="text"
              value={titleInput}
              onChange={e => onTitleInputChange(e.target.value)}
              onKeyDown={e => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter') onSaveTitle()
                if (e.key === 'Escape') onCancelTitleEdit()
              }}
              autoFocus
              className="!h-9 w-[min(14rem,45vw)] bg-kumo-tint text-[16px] leading-5 font-medium md:!h-7 md:text-[14px]"
            />
            <WorkshopIconButton
              onClick={onSaveTitle}
              disabled={!titleInput.trim()}
              className="!h-9 !w-9 hover:text-kumo-brand disabled:opacity-30 md:!h-7 md:!w-7"
              aria-label="Save workspace title"
            >
              <Check size={14} />
            </WorkshopIconButton>
            <WorkshopIconButton
              onClick={onCancelTitleEdit}
              className="!h-9 !w-9 md:!h-7 md:!w-7"
              aria-label="Cancel title edit"
            >
              <X size={14} />
            </WorkshopIconButton>
          </div>
        ) : (
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
              {metadata.title}
            </span>
            <span className="hidden md:inline-flex">
              <WorkshopIconButton
                onClick={onStartTitleEdit}
                className="!h-7 !w-7 flex-shrink-0"
                title="Rename workspace"
                aria-label="Rename workspace"
              >
                <Pencil size={16} />
              </WorkshopIconButton>
            </span>
          </div>
        )}

        {metadata.owner && (
          <span className="hidden text-xs text-kumo-inactive sm:inline">
            by {metadata.owner.name}
          </span>
        )}
      </div>

      {/* Right: presence, cost, workspace, share, blueprints */}
      <div className="hidden flex-shrink-0 items-center gap-1 md:flex">
        <GadgetPresence
          overseer={overseerStub}
          authenticatedApi={authenticatedApi}
          currentUserId={currentUserId}
        />

        {metadata.totalCost != null && (
          <span className="ml-3 mr-2 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {formatHeaderCost(metadata.totalCost)}
          </span>
        )}

        <ActivityNotifications
          overseer={overseerStub}
          workspaceId={workspaceId}
          onViewActivity={onOpenActivity}
          restricted={metadata?.containsRestrictedData === true}
        />

        {showReconnecting && <ReconnectingChip />}

        <WorkshopIconButton
          onClick={onShare}
          title="Share workspace"
          aria-label="Share workspace"
        >
          <ShareNetwork size={15} />
        </WorkshopIconButton>

        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <WorkshopIconButton
                disabled={!selectedGadgetStub}
                title={blueprintUpdateAvailable ? 'Blueprints (update available)' : 'Blueprints'}
                aria-label={blueprintUpdateAvailable ? 'Blueprints (update available)' : 'Blueprints'}
                className="relative"
              >
                <Blueprint size={16} />
                {blueprintUpdateAvailable && (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-kumo-brand"
                  />
                )}
              </WorkshopIconButton>
            }
          />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
            <DropdownMenu.Item onClick={onPublishBlueprint} className={MENU_ITEM}>
              Publish as blueprint…
            </DropdownMenu.Item>
            {!builtFromScratch && (
              <DropdownMenu.Item
                disabled={!canUpdateFromBlueprint}
                onClick={onUpdateFromBlueprint}
                className={MENU_ITEM}
              >
                <UpdateFromBlueprintLabel updateAvailable={blueprintUpdateAvailable} />
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>

        {!metadata.owner && (
          <WorkshopIconButton
            danger
            onClick={onDeleteWorkspace}
            title="Delete workspace"
            aria-label="Delete workspace"
          >
            <Trash size={16} />
          </WorkshopIconButton>
        )}

      </div>
      <div className="ml-1 flex shrink-0 items-center gap-2">
        <span className="md:hidden">{showReconnecting && <ReconnectingChip />}</span>
        {/* Desktop reaches Export from the gadget pane's tab bar, which is hidden on phones. */}
        <span className="md:hidden">
          <GadgetExportMenu
            gadget={selectedGadgetStub}
            gadgetTitle={selectedGadgetTitle}
            chatId={previewChatId}
          />
        </span>
        <UserMenu />
      </div>
    </div>
  )
}

interface TabbarProps {
  chatActive: boolean
  onShowChat: () => void
  onOpenMobilePane: (tab: 'app' | 'code' | 'connections') => void
  mobilePrimaryTab: 'app' | 'code'
  mobilePrimaryActive: boolean
  mobilePreviewActive: boolean
  mobileMoreActive: boolean
  paneShowsActivity: boolean
  pendingActionCount: number
  onOpenActivity: (view: ActivityView) => void
  mobileMenuButtonRef: RefObject<HTMLButtonElement | null>
  blueprintUpdateAvailable: boolean
  visibleWorkpieces: WorkpieceSummary[]
  selectedWorkpieceId: WorkpieceId | null
  onSelectWorkpiece: (id: WorkpieceId) => void
  onStartTitleEdit: () => void
  onShare: () => void
  workspaceId: string
  workspaceMute: { workspaceId: string; mute?: NotificationMute } | undefined
  onMuteChange: (mute: NotificationMute | undefined) => void
  selectedWorkpieceIsWorktree: boolean
  hasSelectedGadgetStub: boolean
  hasSelectedWorkpiece: boolean
  builtFromScratch: boolean
  canUpdateFromBlueprint: boolean
  onPublishBlueprint: () => void
  onUpdateFromBlueprint: () => void
  onEnterFullscreen: () => void
  workspaceOwned: boolean
  onDeleteWorkspace: () => void
}

/**
 * The phone layout's bottom tab bar: Chat / primary pane / Activity, plus a "more" menu holding
 * the secondary views (code, connections, workpiece switcher) and workspace actions.
 */
export function GadgetEditorMobileTabbar({
  chatActive, onShowChat, onOpenMobilePane, mobilePrimaryTab, mobilePrimaryActive,
  mobilePreviewActive, mobileMoreActive, paneShowsActivity, pendingActionCount, onOpenActivity,
  mobileMenuButtonRef, blueprintUpdateAvailable, visibleWorkpieces, selectedWorkpieceId,
  onSelectWorkpiece, onStartTitleEdit, onShare, workspaceId, workspaceMute, onMuteChange,
  selectedWorkpieceIsWorktree, hasSelectedGadgetStub, hasSelectedWorkpiece, builtFromScratch,
  canUpdateFromBlueprint, onPublishBlueprint, onUpdateFromBlueprint, onEnterFullscreen,
  workspaceOwned, onDeleteWorkspace,
}: TabbarProps) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base px-2 md:hidden">
      <button
        type="button"
        onClick={onShowChat}
        aria-current={chatActive ? 'page' : undefined}
        className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg px-3 text-[14px] font-medium ${
          chatActive ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle'
        }`}
      >
        Chat
      </button>
      <button
        type="button"
        onClick={() => onOpenMobilePane(mobilePrimaryTab)}
        disabled={mobilePrimaryTab === 'app' ? !hasSelectedGadgetStub : !hasSelectedWorkpiece}
        aria-current={mobilePrimaryActive ? 'page' : undefined}
        className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg px-3 text-[14px] font-medium disabled:opacity-40 ${
          mobilePrimaryActive ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle'
        }`}
      >
        {mobilePrimaryTab === 'app' ? 'Preview' : 'Code'}
      </button>
      <button
        type="button"
        onClick={() => onOpenActivity(pendingActionCount > 0 ? 'review' : 'history')}
        aria-current={paneShowsActivity ? 'page' : undefined}
        className={`relative flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg px-3 text-[14px] font-medium ${
          paneShowsActivity ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle'
        }`}
      >
        Activity
        {pendingActionCount > 0 && (
          <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-kumo-brand" />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              ref={mobileMenuButtonRef}
              aria-label="More workspace views and actions"
              className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
                mobileMoreActive ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle'
              }`}
            >
              <DotsThree size={20} weight="bold" />
              {blueprintUpdateAvailable && (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-kumo-brand"
                />
              )}
            </button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
          {mobilePrimaryTab !== 'code' && (
            <DropdownMenu.Item
              disabled={!hasSelectedWorkpiece}
              onClick={() => onOpenMobilePane('code')}
              className={MENU_ITEM}
            >
              Code
            </DropdownMenu.Item>
          )}
          {!selectedWorkpieceIsWorktree && (
            <DropdownMenu.Item
              disabled={!hasSelectedGadgetStub}
              onClick={() => onOpenMobilePane('connections')}
              className={MENU_ITEM}
            >
              Connections
            </DropdownMenu.Item>
          )}
          {visibleWorkpieces.length > 1 && <DropdownMenu.Separator />}
          {visibleWorkpieces.length > 1 && visibleWorkpieces.map(workpiece => (
            <DropdownMenu.Item
              key={workpiece.id}
              onClick={() => onSelectWorkpiece(workpiece.id)}
              aria-current={workpiece.id === selectedWorkpieceId ? 'true' : undefined}
              className={`${MENU_ITEM} ${workpiece.id === selectedWorkpieceId ? 'font-medium' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <WorkpieceGlyph summary={workpiece} className="flex-shrink-0 text-kumo-subtle" />
                <span className="truncate">{workpiece.title}</span>
              </span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onClick={onStartTitleEdit} className={MENU_ITEM}>
            Rename workspace
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={onShare} className={MENU_ITEM}>
            Share workspace
          </DropdownMenu.Item>
          {workspaceMute && workspaceMute.workspaceId === workspaceId && (
            <WorkspaceNotificationsMenu
              workspaceId={workspaceMute.workspaceId}
              mute={workspaceMute.mute}
              onMuteChange={onMuteChange}
            />
          )}
          {/* App-only actions are left out for a worktree rather than shown disabled, as the
              desktop header leaves out its full-screen button. */}
          {!selectedWorkpieceIsWorktree && (
            <>
              <DropdownMenu.Item
                disabled={!hasSelectedGadgetStub}
                onClick={onPublishBlueprint}
                className={MENU_ITEM}
              >
                Publish as blueprint…
              </DropdownMenu.Item>
              {!builtFromScratch && (
                <DropdownMenu.Item
                  disabled={!hasSelectedGadgetStub || !canUpdateFromBlueprint}
                  onClick={onUpdateFromBlueprint}
                  className={MENU_ITEM}
                >
                  <UpdateFromBlueprintLabel updateAvailable={blueprintUpdateAvailable} />
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                disabled={!mobilePreviewActive}
                onClick={onEnterFullscreen}
                className={MENU_ITEM}
              >
                Full-screen preview
              </DropdownMenu.Item>
            </>
          )}
          {!workspaceOwned && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                variant="danger"
                onClick={onDeleteWorkspace}
                className={MENU_ITEM_DANGER}
              >
                Delete workspace
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}
