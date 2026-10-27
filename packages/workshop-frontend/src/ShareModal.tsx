import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, CollaboratorRole,
  GadgetMetadata, ObserverBindingNeed, Overseer, ShareLinkInfo,
} from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './components/WorkshopControls'
import MembersSection, { PeopleSection, type InviteBatch, type StagedRecipient } from './features/share/MembersSection'
import InviteLinkSection, { ShareLinksSection } from './features/share/InviteLinkSection'
import VisibilitySection, { RecipientVerificationSummary } from './features/share/VisibilitySection'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * The share dialog: a thin owner of the shared data (membership, share links, verification
 * requirements), the cross-dialog-session composer state, and the landed-row flash, composing
 * the sections in features/share/ — each of which owns its own flow's state and resets it by
 * unmounting when the dialog closes. Visibility of the offer affordances follows the server's
 * rules: `ownerInvitesOnly` hides share links from everyone and direct invites from everyone
 * but the owner.
 */
export default function ShareModal({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) {
  const toasts = useKumoToastManager()
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membershipStatus, setMembershipStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[]>([])
  const [requirements, setRequirements] =
    useState<Record<CollaboratorRole, ObserverBindingNeed[]> | null>(null)
  const [requirementsFailed, setRequirementsFailed] = useState(false)
  // The roles the two composers grant, kept here because the verification summary covers both.
  const [addRole, setAddRole] = useState<CollaboratorRole>('use')
  const [newLinkRole, setNewLinkRole] = useState<CollaboratorRole>('use')
  // Composer state that outlives a close/reopen: chips for an invite in flight or a failure
  // awaiting correction are the only record of that outcome. Everything else lives in the
  // sections, which the closed dialog unmounts.
  const [staged, setStaged] = useState<StagedRecipient[]>([])
  const [adding, setAdding] = useState(false)
  // Whether a share link is being offered right now (composer open or fresh link showing), and
  // the fresh link's id — revoking it from the list must drop the composer's card.
  const [linkOffered, setLinkOffered] = useState(false)
  const [freshLinkId, setFreshLinkId] = useState<string | null>(null)
  const [freshLinkRevoked, setFreshLinkRevoked] = useState(0)
  // The landed-row flash both lists share; one timer, so a new flash clears the previous.
  const [landedPersonIds, setLandedPersonIds] = useState<ReadonlySet<string>>(NO_IDS)
  const [landedShareLinkId, setLandedShareLinkId] = useState<string | null>(null)
  const landedTimerRef = useRef<number | null>(null)
  // The dialog body locks its scroll while the directory popover is open; the composer reports it.
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  const [directoryPortalContainer, setDirectoryPortalContainer] =
    useState<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const wasOpenRef = useRef(false)
  const addingRef = useRef(false)
  // Freshly-minted share URLs, kept only in memory for the life of this modal session so repeat
  // Copy clicks on the same link re-use the URL. Shared by the composer (which mints) and the
  // list (which re-copies); cleared on a fresh open.
  const copiedUrlsRef = useRef<Map<string, string>>(new Map())

  const isOwner = !metadata.owner
  const ownerInvitesOnly = metadata.ownerInvitesOnly === true
  const canInvite = !ownerInvitesOnly || isOwner
  const canUseShareLinks = !ownerInvitesOnly
  const membershipSettled = open && wasOpenRef.current && membershipStatus !== 'loading'
  const membershipReady = membershipSettled && membershipStatus === 'ready'

  useEffect(() => {
    return () => {
      if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '1100'
    document.body.appendChild(element)
    setMenuContainer(element)
    return () => {
      setMenuContainer(null)
      element.remove()
    }
  }, [])

  const loadData = useCallback(async () => {
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareLinks(),
      ])
      setCollaborators(collabs)
      setShareLinks(keys)
      setMembershipStatus('ready')
      return { collaborators: collabs, shareLinks: keys }
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: 'Failed to load sharing info', variant: 'error' })
      setMembershipStatus(current => current === 'ready' ? current : 'failed')
      return null
    }
  }, [overseer])

  // Refresh on focus as well as open: bindings cannot change in this modal, but they can change in
  // another tab while it remains open. A failed refresh is informational and never blocks sharing.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let requestId = 0
    setRequirements(null)
    const refresh = () => {
      const thisRequest = ++requestId
      setRequirementsFailed(false)
      Promise.all([
        overseer.listObserverRequirements('use'),
        overseer.listObserverRequirements('build'),
      ])
        .then(([use, build]) => {
          if (!cancelled && thisRequest === requestId) setRequirements({ use, build })
        })
        .catch(err => {
          console.error('Failed to load observer requirements:', err)
          if (!cancelled && thisRequest === requestId) setRequirementsFailed(true)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [open, overseer])

  useEffect(() => {
    if (open) {
      setMembershipStatus('loading')
      loadData()
      if (!wasOpenRef.current) {
        // A fresh open starts the composers over — the sections' own state already reset by
        // unmounting — except for people whose invite is still in flight or has failed: their
        // chip is the only record of the outcome. A fresh open also never resurfaces a link's
        // secret or an offered-link summary.
        const inFlight = addingRef.current
        setStaged(current => inFlight ? current : current.filter(recipient => recipient.error))
        copiedUrlsRef.current.clear()
        setLinkOffered(false)
        setFreshLinkId(null)
      }
    } else {
      setMembershipStatus('loading')
    }
    wasOpenRef.current = open
  }, [open, loadData])

  const showLandedRow = (kind: 'person' | 'shareLink', ids: string[]) => {
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    setLandedPersonIds(kind === 'person' ? new Set(ids) : NO_IDS)
    setLandedShareLinkId(kind === 'shareLink' ? ids[0] ?? null : null)
    landedTimerRef.current = window.setTimeout(() => {
      setLandedPersonIds(NO_IDS)
      setLandedShareLinkId(null)
      landedTimerRef.current = null
    }, 2200)
  }

  const inviteBatch: InviteBatch = {
    staged,
    setStaged,
    adding,
    setAdding,
    addingRef,
    reload: loadData,
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 !outline-none"
        size="lg"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Share “{metadata.title}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {canUseShareLinks
                ? 'Invite people or share a link.'
                : canInvite ? 'Invite people.' : 'Manage access.'}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={18} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div
          className={`chat-panel min-h-0 flex-1 overscroll-contain px-4 pb-6 sm:px-6 ${directoryOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          <VisibilitySection metadata={metadata} ownerInvitesOnly={ownerInvitesOnly} />
          {canInvite && (
            <div className={`sticky top-0 z-10 bg-kumo-base pb-3 transition-shadow duration-200 ${scrolled ? 'themed-bottom-shadow border-b border-kumo-line/60' : ''}`}>
              <MembersSection
                overseer={overseer}
                authenticatedApi={authenticatedApi}
                metadata={metadata}
                currentUser={currentUser}
                collaborators={collaborators}
                membershipSettled={membershipSettled}
                membershipReady={membershipReady}
                addRole={addRole}
                onAddRoleChange={setAddRole}
                batch={inviteBatch}
                menuContainer={menuContainer}
                directoryPortalContainer={directoryPortalContainer}
                onPeopleLanded={(ids) => showLandedRow('person', ids)}
                onDirectoryOpenChange={setDirectoryOpen}
              />
              {canUseShareLinks && (
                <InviteLinkSection
                  overseer={overseer}
                  metadata={metadata}
                  newLinkRole={newLinkRole}
                  onNewLinkRoleChange={setNewLinkRole}
                  onOfferedChange={(offered, linkId) => {
                    setLinkOffered(offered)
                    setFreshLinkId(offered ? linkId ?? null : null)
                  }}
                  reload={loadData}
                  menuContainer={menuContainer}
                  copiedUrlsRef={copiedUrlsRef}
                  onLinkLanded={(ids) => showLandedRow('shareLink', ids)}
                  resetSignal={freshLinkRevoked}
                />
              )}
            </div>
          )}
          <RecipientVerificationSummary
            canInvite={canInvite}
            requirements={requirements}
            requirementsFailed={requirementsFailed}
            addRole={addRole}
            newLinkRole={newLinkRole}
            linkOffered={canUseShareLinks && linkOffered}
          />
          <PeopleSection
            overseer={overseer}
            authenticatedApi={authenticatedApi}
            metadata={metadata}
            currentUser={currentUser}
            collaborators={collaborators}
            shareLinks={shareLinks}
            landedPersonIds={landedPersonIds}
            reload={loadData}
          />
          {shareLinks.length > 0 && (
            <ShareLinksSection
              overseer={overseer}
              metadata={metadata}
              shareLinks={shareLinks}
              canUseShareLinks={canUseShareLinks}
              copiedUrlsRef={copiedUrlsRef}
              landedShareLinkId={landedShareLinkId}
              onLinkLanded={(ids) => showLandedRow('shareLink', ids)}
              freshLinkId={freshLinkId}
              onFreshLinkRevoked={() => {
                setFreshLinkId(null)
                setLinkOffered(false)
                setFreshLinkRevoked(count => count + 1)
              }}
              reload={loadData}
            />
          )}
        </div>
        <div ref={setDirectoryPortalContainer} className="pointer-events-none absolute inset-0 z-30" />
      </Dialog>
    </Dialog.Root>
  )
}
