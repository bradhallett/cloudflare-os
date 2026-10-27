import { useEffect, useRef, useState, type RefObject } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, Link, PencilSimple, Trash, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AffectedCollaborator, CollaboratorRole, GadgetMetadata, Overseer, ShareLinkInfo,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { copyToClipboard } from '../../clipboard'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { isImeComposing } from '../../keyboardEvent'
import { DependentKeepList, InlineConfirm, RoleBadge, RoleMenu } from './ShareDialogControls'

// The revoke flow's in-place confirmation state: which link, the preview of who else loses
// access, and which of them the user chose to keep.
type RevokeTarget = {
  kind: 'revoke'
  linkId: string
  dependents: AffectedCollaborator[]
  previewing: boolean
  keepSet: Set<string>
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/**
 * The share-link composer: the "Create a share link" affordance, the name/role form, and the
 * freshly-minted link card. All of its state resets when the dialog closes: a link's URL embeds
 * its secret, so a fresh open never resurfaces one, and a create still pending when the dialog
 * closes is simply gone. `onOfferedChange` tells the modal whether a link is being offered right
 * now (`linkId` when a fresh one exists), so the recipient-verification summary can cover it and
 * the list can drop the card if that link is revoked. `resetSignal` ticks when exactly that
 * happens; the initial tick is ignored.
 */
export default function InviteLinkSection({
  overseer,
  metadata,
  newLinkRole,
  onNewLinkRoleChange,
  onOfferedChange,
  reload,
  menuContainer,
  copiedUrlsRef,
  onLinkLanded,
  resetSignal,
}: {
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  newLinkRole: CollaboratorRole
  onNewLinkRoleChange: (role: CollaboratorRole) => void
  onOfferedChange: (offered: boolean, linkId?: string) => void
  reload: () => Promise<unknown>
  menuContainer: HTMLDivElement | null
  copiedUrlsRef: RefObject<Map<string, string>>
  onLinkLanded: (linkIds: string[]) => void
  resetSignal: number
}) {
  const toasts = useKumoToastManager()
  const reportFailure = useReportRpcFailure()
  const [newLinkNote, setNewLinkNote] = useState('')
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [newShareLinkCopied, setNewShareLinkCopied] = useState(false)
  const [creatingLink, setCreatingLink] = useState(false)
  const [showLinkComposer, setShowLinkComposer] = useState(false)
  const creatingLinkRef = useRef(false)
  const linkNameRef = useRef<HTMLInputElement>(null)

  // Focus the link-name field when the composer opens, without scrolling the sticky region
  // (autoFocus would jump the scroll position and shift layout).
  useEffect(() => {
    if (showLinkComposer && !newShareLink) {
      linkNameRef.current?.focus({ preventScroll: true })
    }
  }, [showLinkComposer, newShareLink])

  const dismissNewLink = () => {
    setNewShareLink(null)
    setNewShareLinkCopied(false)
    setShowLinkComposer(false)
    onOfferedChange(false)
  }

  // The freshly-minted link was revoked from the list below; drop the card exactly as its own
  // Dismiss would. The first render's signal carries no event.
  useEffect(() => {
    if (resetSignal === 0) return
    dismissNewLink()
    // dismissNewLink only clears state and reports; nothing else may fire here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal])

  const handleCreateShareLink = async () => {
    if (creatingLinkRef.current) return
    creatingLinkRef.current = true
    setCreatingLink(true)
    try {
      const { key, linkId } = await overseer.createShareLink(
        newLinkRole, newLinkNote.trim() || undefined)
      const url = `${window.location.origin}/workspace/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setNewShareLinkCopied(false)
      setNewLinkNote('')
      copiedUrlsRef.current.set(linkId, url)
      onOfferedChange(true, linkId)
      await reload()
      onLinkLanded([linkId])
    } catch (err) {
      // Keep the composer and its values open so the user can retry without re-entering them.
      reportFailure('Failed to create share link.', err)
    } finally {
      creatingLinkRef.current = false
      setCreatingLink(false)
    }
  }

  const copyNewLink = async () => {
    if (!newShareLink) return
    const copied = await copyToClipboard(newShareLink)
    if (copied) {
      setNewShareLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy share link.', variant: 'error' })
    }
  }

  return (
    <div className="mt-2">
      {(showLinkComposer || newShareLink) ? (
        newShareLink ? (
          <div className="themed-compact-shadow flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
              {newShareLinkCopied ? <Check size={15} weight="bold" /> : <Link size={15} />}
            </div>
            <div className="min-w-[160px] flex-1">
              <div className="flex items-baseline gap-1.5">
                <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                  {newShareLinkCopied ? 'Link copied' : 'Link ready'}
                </p>
                <span className="text-[11px] leading-4 text-kumo-inactive">
                  You can copy it again anytime from Share links
                </span>
              </div>
              <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{newShareLink}</p>
            </div>
            <WorkshopButton tone="primary" onClick={copyNewLink} className="w-[78px] gap-1.5 !rounded-xl">
              {newShareLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
              {newShareLinkCopied ? 'Copied' : 'Copy'}
            </WorkshopButton>
            <WorkshopIconButton
              aria-label="Dismiss created link"
              onClick={dismissNewLink}
            >
              <X size={14} />
            </WorkshopIconButton>
          </div>
        ) : (
          <div className="themed-compact-shadow flex h-12 items-center gap-2 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill share-fade-in">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
              <Link size={15} />
            </div>
            <input
              ref={linkNameRef}
              value={newLinkNote}
              onChange={(e) => setNewLinkNote(e.target.value)}
              onKeyDown={(e) => { if (!isImeComposing(e) && e.key === 'Enter') handleCreateShareLink() }}
              placeholder="Name this link (optional)…"
              aria-label="Share link name (optional)"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
              disabled={creatingLink}
            />
            <RoleMenu
              ariaLabel="Access granted by link"
              value={newLinkRole}
              onValueChange={onNewLinkRoleChange}
              disabled={creatingLink}
              container={menuContainer}
            />
            <WorkshopButton tone="primary" className="shrink-0 !rounded-xl" onClick={handleCreateShareLink} disabled={creatingLink}>
              {creatingLink ? 'Creating…' : 'Create link'}
            </WorkshopButton>
            <WorkshopIconButton aria-label="Cancel creating link" onClick={() => { setShowLinkComposer(false); onOfferedChange(false) }}>
              <X size={14} />
            </WorkshopIconButton>
          </div>
        )
      ) : (
        <button
          type="button"
          onClick={() => { setShowLinkComposer(true); onOfferedChange(true) }}
          className="themed-compact-shadow flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-elevated/60 hover:text-kumo-default active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Link size={14} /> Create a share link
        </button>
      )}
    </div>
  )
}

/**
 * The "Share links" list: copy (minting a fresh secret — the old one is never stored), rename,
 * and the inline revoke confirmation with its keep-dependents checklist. Shares nothing with the
 * composer except the data, the session URL cache, and the landed-row flash it is handed;
 * `freshLinkId` / `onFreshLinkRevoked` drop the composer's card when that link is revoked here.
 */
export function ShareLinksSection({
  overseer,
  metadata,
  shareLinks,
  canUseShareLinks,
  copiedUrlsRef,
  landedShareLinkId,
  onLinkLanded,
  freshLinkId,
  onFreshLinkRevoked,
  reload,
}: {
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  shareLinks: ShareLinkInfo[]
  canUseShareLinks: boolean
  copiedUrlsRef: RefObject<Map<string, string>>
  landedShareLinkId: string | null
  onLinkLanded: (linkIds: string[]) => void
  freshLinkId: string | null
  onFreshLinkRevoked: () => void
  reload: () => Promise<unknown>
}) {
  const toasts = useKumoToastManager()
  const reportFailure = useReportRpcFailure()
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const [editingShareLinkId, setEditingShareLinkId] = useState<string | null>(null)
  const [editingShareLinkNote, setEditingShareLinkNote] = useState('')
  const [savingShareLinkNote, setSavingShareLinkNote] = useState(false)
  const [copyingLinkId, setCopyingLinkId] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const savingShareLinkNoteRef = useRef(false)
  const copyingLinkRef = useRef(false)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (editingShareLinkId) {
      renameInputRef.current?.focus({ preventScroll: true })
      renameInputRef.current?.select()
    }
  }, [editingShareLinkId])

  // Copy a share link again. Secrets are never stored, so the previously-shown URL can't be
  // re-displayed. We mint a new secret for the same logical link and copy that.
  const handleCopyShareLink = async (linkId: string) => {
    if (copyingLinkRef.current) return
    copyingLinkRef.current = true
    setCopyingLinkId(linkId)
    try {
      // Re-use a URL already minted for this link during this session.
      let url = copiedUrlsRef.current.get(linkId)
      if (!url) {
        const { key } = await overseer.newShareLinkKey(linkId)
        url = `${window.location.origin}/workspace/${metadata.id}#share=${key}`
        copiedUrlsRef.current.set(linkId, url)
      }
      const copied = await copyToClipboard(url)
      if (!copied) {
        toasts.add({ title: 'Could not copy share link.', variant: 'error' })
        return
      }
      setCopiedLinkId(linkId)
      onLinkLanded([linkId])
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedLinkId(current => (current === linkId ? null : current))
        copiedTimerRef.current = null
      }, 2000)
      toasts.add({ title: 'Link copied to clipboard.', variant: 'success' })
    } catch (err) {
      reportFailure('Failed to copy share link.', err)
    } finally {
      copyingLinkRef.current = false
      setCopyingLinkId(null)
    }
  }

  const startRenameShareLink = (link: ShareLinkInfo) => {
    // Renaming and the destructive confirm are mutually exclusive in-place editors on the same row.
    setRevokeTarget(null)
    setEditingShareLinkId(link.linkId)
    setEditingShareLinkNote(link.note ?? '')
  }

  const cancelRenameShareLink = () => {
    setEditingShareLinkId(null)
    setEditingShareLinkNote('')
  }

  const handleSaveShareLinkNote = async () => {
    if (!editingShareLinkId || savingShareLinkNoteRef.current) return
    const linkId = editingShareLinkId
    const note = editingShareLinkNote.trim()
    if (note === (shareLinks.find(link => link.linkId === linkId)?.note ?? '')) {
      cancelRenameShareLink()
      return
    }
    savingShareLinkNoteRef.current = true
    setSavingShareLinkNote(true)
    try {
      await overseer.updateShareLink(linkId, note || undefined)
      cancelRenameShareLink()
      await reload()
      onLinkLanded([linkId])
      toasts.add({ title: 'Share link renamed.', variant: 'success' })
    } catch (err) {
      reportFailure('Failed to rename share link.', err)
    } finally {
      savingShareLinkNoteRef.current = false
      setSavingShareLinkNote(false)
    }
  }

  const handleStartRevokeShareLink = async (linkId: string) => {
    cancelRenameShareLink()
    setRevokeTarget({ kind: 'revoke', linkId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRevokeShareLink(linkId)
      setRevokeTarget(current => current?.kind === 'revoke' && current.linkId === linkId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err) {
      setRevokeTarget(current => current?.kind === 'revoke' && current.linkId === linkId ? null : current)
      reportFailure('Failed to preview share-link revocation.', err)
    }
  }

  const handleConfirmRevokeShareLink = async () => {
    if (!revokeTarget || revokeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      await overseer.revokeShareLink(revokeTarget.linkId, [...revokeTarget.keepSet])
      const revokedFreshLink = revokeTarget.linkId === freshLinkId
      setRevokeTarget(null)
      if (revokedFreshLink) onFreshLinkRevoked()
      toasts.add({ title: 'Share link revoked.', variant: 'success' })
      await reload()
    } catch (err) {
      reportFailure('Failed to revoke share link.', err)
    } finally {
      setConfirmationBusy(false)
    }
  }

  const sortedShareLinks = [...shareLinks].toSorted((a, b) => b.created.getTime() - a.created.getTime())

  return (
    <section aria-labelledby="links-heading" className="mt-4">
      <div className="mb-2 px-1">
        <h3 id="links-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          Share links
        </h3>
      </div>

      <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
        {sortedShareLinks.map((sk, index) => {
          const isRevoking = revokeTarget?.linkId === sk.linkId
          const isRenaming = editingShareLinkId === sk.linkId
          return (
            <div key={sk.linkId} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedShareLinkId === sk.linkId ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
              <div className="flex items-center gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60">
                  <Link size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={editingShareLinkNote}
                      onChange={(e) => setEditingShareLinkNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (isImeComposing(e)) return
                        if (e.key === 'Enter') handleSaveShareLinkNote()
                        if (e.key === 'Escape') cancelRenameShareLink()
                      }}
                      placeholder="Name this link…"
                      aria-label="Share link name"
                      className="block w-full border-0 bg-transparent p-0 text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default outline-none shadow-[inset_0_-1px_0_0_var(--color-kumo-line)] transition-shadow placeholder:font-normal placeholder:text-kumo-inactive focus:shadow-[inset_0_-1px_0_0_var(--color-kumo-fill)]"
                      disabled={savingShareLinkNote}
                    />
                  ) : (
                    <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{sk.note || 'Untitled link'}</p>
                  )}
                  <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">Created by {sk.createdBy.name} · {formatRelativeTime(sk.created)}</p>
                </div>
                {isRenaming ? (
                  <InlineConfirm
                    label="Save"
                    tone="brand"
                    busy={savingShareLinkNote}
                    onConfirm={handleSaveShareLinkNote}
                    onCancel={cancelRenameShareLink}
                  />
                ) : isRevoking ? (
                  <InlineConfirm
                    label="Revoke"
                    busy={revokeTarget.previewing || confirmationBusy}
                    busyLabel={revokeTarget.previewing ? 'Checking…' : undefined}
                    onConfirm={handleConfirmRevokeShareLink}
                    onCancel={() => setRevokeTarget(null)}
                  />
                ) : (
                  <>
                    <RoleBadge role={sk.role} />
                    {canUseShareLinks && (
                      <WorkshopIconButton
                        className="!h-7 !w-7"
                        onClick={() => handleCopyShareLink(sk.linkId)}
                        aria-label={`Copy ${sk.note || 'share link'}`}
                        disabled={confirmationBusy || copyingLinkId === sk.linkId}
                      >
                        {copiedLinkId === sk.linkId ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                      </WorkshopIconButton>
                    )}
                    <WorkshopIconButton
                      className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => startRenameShareLink(sk)}
                      aria-label={`Rename ${sk.note || 'share link'}`}
                      disabled={confirmationBusy}
                    >
                      <PencilSimple size={13} />
                    </WorkshopIconButton>
                    <WorkshopIconButton
                      danger
                      className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => handleStartRevokeShareLink(sk.linkId)}
                      aria-label={`Revoke ${sk.note || 'share link'}`}
                      disabled={confirmationBusy}
                    >
                      <Trash size={13} />
                    </WorkshopIconButton>
                  </>
                )}
              </div>
              {isRevoking && revokeTarget.dependents.length > 0 && (
                <div className="mt-2.5 share-expand-in">
                  <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                    {revokeTarget.dependents.length} {revokeTarget.dependents.length === 1 ? 'person loses' : 'people lose'} access through this link. Keep anyone?
                  </p>
                  <DependentKeepList
                    dependents={revokeTarget.dependents}
                    keepSet={revokeTarget.keepSet}
                    onKeepSetChange={(keepSet) => setRevokeTarget(current =>
                      current?.kind === 'revoke' && current.linkId === revokeTarget.linkId
                        ? { ...current, keepSet }
                        : current
                    )}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
