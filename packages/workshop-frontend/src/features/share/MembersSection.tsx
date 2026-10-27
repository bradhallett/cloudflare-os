import {
  useEffect, useLayoutEffect, useCallback, useId, useMemo, useRef,
  useState, type KeyboardEvent, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, Trash, UserPlus, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AffectedCollaborator, AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo,
  CollaboratorRole, GadgetMetadata, Overseer, ShareLinkInfo,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import { PersonAvatar } from '../../components/PersonAvatar'
import { copyToClipboard } from '../../clipboard'
import { isImeComposing } from '../../keyboardEvent'
import { rpcFailureDescription } from '../../rpcErrors'
import { useServerConfig } from '../../ServerConfigContext'
import { useUserDirectorySearch } from '../user-directory/useUserDirectorySearch'
import { DependentKeepList, InlineConfirm, RoleBadge, RoleMenu } from './ShareDialogControls'

/** A person queued in the composer but not yet invited. `error` is set when their invite failed
 * so the chip stays for correction while everyone else's goes through. */
export type StagedRecipient = { id: string; name: string; error?: string }

const NAME_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

function withRecipient(list: StagedRecipient[], recipient: StagedRecipient): StagedRecipient[] {
  return list.some(entry => entry.id === recipient.id) ? list : [...list, recipient]
}

// "Name (id)" when they differ, so two accounts with one display name stay tellable apart.
function recipientLabel({ id, name }: StagedRecipient): string {
  return name === id ? name : `${name} (${id})`
}

// The remove flow's in-place confirmation state: which collaborator, the preview of who else
// loses access, and which of them the user chose to keep.
type RemoveTarget = {
  kind: 'remove'
  profileId: string
  dependents: AffectedCollaborator[]
  previewing: boolean
  keepSet: Set<string>
}

/** State the composer shares with the modal across dialog sessions: the chips (an invite in
 * flight, or a failure awaiting correction, outlives a close/reopen), the batch flag, and the
 * membership reload every mutation ends with. */
export interface InviteBatch {
  staged: StagedRecipient[]
  setStaged: React.Dispatch<React.SetStateAction<StagedRecipient[]>>
  adding: boolean
  setAdding: (adding: boolean) => void
  addingRef: RefObject<boolean>
  reload: () => Promise<unknown>
}

/**
 * The direct-invite composer: chips, directory search, the role to grant, and the post-invite
 * link card. Renders only while the user may invite. All of its own state resets when the
 * dialog closes; the chip state lives in `batch` and survives per its own comment.
 */
export default function MembersSection({
  overseer,
  authenticatedApi,
  metadata,
  currentUser,
  collaborators,
  membershipSettled,
  membershipReady,
  addRole,
  onAddRoleChange,
  batch,
  menuContainer,
  directoryPortalContainer,
  onPeopleLanded,
  onDirectoryOpenChange,
}: {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  collaborators: CollaboratorInfo[]
  membershipSettled: boolean
  membershipReady: boolean
  addRole: CollaboratorRole
  onAddRoleChange: (role: CollaboratorRole) => void
  batch: InviteBatch
  menuContainer: HTMLDivElement | null
  directoryPortalContainer: HTMLDivElement | null
  onPeopleLanded: (profileIds: string[]) => void
  onDirectoryOpenChange: (open: boolean) => void
}) {
  const toasts = useKumoToastManager()
  const { staged, setStaged, adding, setAdding, addingRef, reload } = batch
  const [addUsername, setAddUsername] = useState('')
  const [composerNotice, setComposerNotice] = useState('')
  const [activeDirectoryIndex, setActiveDirectoryIndex] = useState(0)
  // The result popover is dismissed when focus leaves the combobox or on Escape; typing or
  // refocusing brings it back. The query and its search survive a dismissal.
  const [directoryDismissed, setDirectoryDismissed] = useState(true)
  const [invitedNames, setInvitedNames] = useState<string[]>([])
  const [invitedLinkCopied, setInvitedLinkCopied] = useState(false)
  const directoryListboxId = useId()
  const activeDirectoryOptionRef = useRef<HTMLButtonElement>(null)
  const directoryListboxRef = useRef<HTMLDivElement>(null)
  const directoryAnchorRef = useRef<HTMLDivElement>(null)
  const peopleInputRef = useRef<HTMLInputElement>(null)
  const userSearchEnabled = useServerConfig()?.userSearchEnabled ?? false

  const directoryQuery = addUsername.trim()
  // Everyone already on the workspace: the caller, the owner (absent from listCollaborators()
  // when the caller is a collaborator), and every collaborator -- plus everyone already staged.
  const directoryExcludeIds = useMemo(() => [
    ...(currentUser ? [currentUser.id] : []),
    ...(metadata.owner ? [metadata.owner.id] : []),
    ...collaborators.map(({ profile }) => profile.id),
    ...staged.map(recipient => recipient.id),
  ], [collaborators, currentUser, metadata.owner, staged])
  const directorySearching = userSearchEnabled && membershipReady && directoryQuery !== ''
  const searchDirectory = useCallback((query: string) =>
    authenticatedApi.searchUsers(query, directoryExcludeIds), [authenticatedApi, directoryExcludeIds])
  const directory = useUserDirectorySearch({
    query: directoryQuery,
    enabled: directorySearching,
    search: searchDirectory,
  })
  // The caller renders this section only while inviting is possible; a live metadata update
  // that revokes it unmounts the search field, and with it this popover's scroll lock.
  const directoryOpen = directorySearching && directory.current && !directoryDismissed

  // The dialog body locks its own scroll while the result popover is open; the modal owns that
  // body, so report the popover's visibility up — including a final false when this section
  // unmounts (a live metadata update can revoke invite rights with results open).
  useEffect(() => {
    onDirectoryOpenChange(directoryOpen)
    return () => onDirectoryOpenChange(false)
  }, [directoryOpen, onDirectoryOpenChange])

  const directorySettled = directory.settled
  const showDirectDirectoryOption = directory.status === 'ready' && directory.results.length > 0
  const directoryOptionCount = directory.results.length + (showDirectDirectoryOption ? 1 : 0)
  const activeDirectoryOptionId = directoryOpen && activeDirectoryIndex < directoryOptionCount
    ? `${directoryListboxId}-option-${activeDirectoryIndex}`
    : undefined
  // Once the search has settled, the typed text can always be staged as a canonical id: the
  // directory is a lazily backfilled convenience, so a valid id may be missing from it (or
  // shadowed by unrelated substring matches), and a directory outage must not block invites.
  // A membership-load failure also falls back to the authoritative direct-invite path.
  const canStage = directoryQuery !== '' && (!userSearchEnabled ||
    (membershipSettled && (!membershipReady || directorySettled)))
  // What the composer holds besides the chips: the highlighted result, else the typed text once
  // it can be staged.
  const highlightedUser = directoryOpen ? directory.results[activeDirectoryIndex] : undefined
  const typedRecipient: StagedRecipient | null = highlightedUser
    ? { id: highlightedUser.id, name: highlightedUser.name }
    : canStage ? { id: directoryQuery, name: directoryQuery } : null
  // Exactly what Invite would send, so the label never counts a typed id that is already a chip.
  const pendingRecipients = typedRecipient ? withRecipient(staged, typedRecipient) : staged
  const inviteCount = pendingRecipients.length
  // Nothing is sent while the field holds text that cannot be staged yet (its search is still
  // pending), so the button waits too: Enter already does, and a click would silently drop the name.
  const canSubmitInvite = inviteCount > 0 && (directoryQuery === '' || typedRecipient !== null)

  useEffect(() => {
    if (directorySearching) setActiveDirectoryIndex(0)
  }, [directorySearching, directoryQuery, searchDirectory])

  // Keep the listbox inside the dialog's accessibility tree, but outside its scrolling body so
  // opening results cannot make the dialog itself scroll. The anchor grows and shrinks as chips
  // wrap (or a batch settles mid-search), so it is observed as well as the viewport.
  useLayoutEffect(() => {
    if (!directoryOpen) return
    const anchor = directoryAnchorRef.current
    if (!anchor) return
    const position = () => {
      const listbox = directoryListboxRef.current
      const dialog = listbox?.parentElement
      if (!listbox || !dialog) return
      const anchorRect = anchor.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      listbox.style.left = `${anchorRect.left - dialogRect.left}px`
      listbox.style.top = `${anchorRect.bottom - dialogRect.top + 8}px`
      listbox.style.width = `${anchorRect.width}px`
      listbox.style.maxHeight = `${Math.max(0, Math.min(
        205,
        dialogRect.bottom - anchorRect.bottom - 20,
      ))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    const viewport = window.visualViewport
    window.addEventListener('resize', position)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
    }
  }, [directoryOpen])

  useLayoutEffect(() => {
    if (!directoryOpen) return

    const listbox = directoryListboxRef.current
    const option = activeDirectoryOptionRef.current
    if (!listbox || !option) return

    // scrollIntoView() also scrolls the modal's ancestor scroller. Adjust only the result list so
    // keyboard navigation cannot move the modal underneath its sticky search field.
    const listboxRect = listbox.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < listboxRect.top) {
      listbox.scrollTop -= listboxRect.top - optionRect.top
    } else if (optionRect.bottom > listboxRect.bottom) {
      listbox.scrollTop += optionRect.bottom - listboxRect.bottom
    }
  }, [activeDirectoryIndex, directoryOpen, directory.results])

  // Where an invited collaborator opens the workspace. Adding them already granted access, so this
  // carries no secret and is safe to show and re-show — unlike a share link, whose URL embeds a key.
  const workspaceUrl = `${window.location.origin}/workspace/${metadata.id}`

  // Queue a person in the composer and clear the field for the next name. Focus stays in the
  // input so a run of names can be entered without reaching for the mouse.
  const stageRecipient = (recipient: StagedRecipient) => {
    const label = recipientLabel(recipient)
    setComposerNotice(staged.some(entry => entry.id === recipient.id)
      ? `${label} is already listed.`
      : `Added ${label}.`)
    setStaged(current => withRecipient(current, recipient))
    setAddUsername('')
    peopleInputRef.current?.focus({ preventScroll: true })
    setDirectoryDismissed(true)
  }

  const removeStaged = (recipient: StagedRecipient) => {
    setComposerNotice(`Removed ${recipientLabel(recipient)}.`)
    setStaged(current => current.filter(entry => entry.id !== recipient.id))
    peopleInputRef.current?.focus({ preventScroll: true })
  }

  // Invite everyone staged, plus whatever the composer still holds. Each addCollaborator() call is
  // independently atomic and idempotent on the server, so they are all issued up front (pipelined
  // over the one connection) and the membership list is refetched once. Failures are not toasted:
  // the person's chip stays in the composer carrying the reason, so it can be fixed and resent.
  // The composer stays live meanwhile: more people can be staged (they wait for the next batch)
  // but none removed, since a call already issued cannot be cancelled.
  const handleInvite = async (extra: StagedRecipient | null = null) => {
    const recipients = extra ? withRecipient(staged, extra) : staged
    if (recipients.length === 0 || addingRef.current) return
    if (extra) stageRecipient(extra)

    addingRef.current = true
    setAdding(true)
    try {
      const settled = await Promise.allSettled(
        recipients.map(recipient => overseer.addCollaborator(recipient.id, addRole, undefined)))
      const added: AiChatAuthorInfo[] = []
      const failed: StagedRecipient[] = []
      settled.forEach((outcome, index) => {
        const recipient = recipients[index]
        if (outcome.status === 'rejected') {
          const { reason } = outcome
          failed.push({
            ...recipient,
            error: rpcFailureDescription(reason) ?? 'Failed to add collaborator.',
          })
        } else if (outcome.value === null) {
          failed.push({ ...recipient, error: 'No account found for that username or email.' })
        } else {
          added.push(outcome.value.profile)
        }
      })
      // Touch only the chips this batch sent: drop the added, keep the failed with their reason,
      // and leave anything staged since the batch started where it is.
      const batchIds = new Set(recipients.map(recipient => recipient.id))
      const failure = new Map(failed.map(recipient => [recipient.id, recipient]))
      setStaged(current => current.flatMap(recipient => {
        if (!batchIds.has(recipient.id)) return [recipient]
        const outcome = failure.get(recipient.id)
        return outcome ? [outcome] : []
      }))
      if (added.length > 0) {
        const names = added.map(profile => profile.name)
        setInvitedNames(names)
        setInvitedLinkCopied(false)
        await reload()
        onPeopleLanded(added.map(profile => profile.id))
        toasts.add({
          title: `Added ${NAME_LIST.format(names)} as ${names.length === 1 ? 'a collaborator' : 'collaborators'}.`,
          variant: 'success',
        })
      }
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleDirectoryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (typedRecipient) stageRecipient(typedRecipient)
      else if (directoryQuery === '' && staged.length > 0) void handleInvite()
      return
    }
    if (event.key === 'Backspace' && addUsername === '' && staged.length > 0 && !adding) {
      event.preventDefault()
      removeStaged(staged[staged.length - 1])
      return
    }
    if (!directorySearching) return
    if (event.key === 'Escape' && directoryOpen) {
      // Closes only the popover; the dialog would otherwise take the same keypress.
      event.preventDefault()
      event.stopPropagation()
      setDirectoryDismissed(true)
      return
    }
    if (directoryOptionCount > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!directoryOpen) {
        setDirectoryDismissed(false)
        return
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveDirectoryIndex(current =>
        (current + direction + directoryOptionCount) % directoryOptionCount)
    }
  }

  const copyWorkspaceUrl = async () => {
    if (await copyToClipboard(workspaceUrl)) {
      setInvitedLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
    }
  }

  return (
    <>
      <div
        ref={directoryAnchorRef}
        data-testid="people-composer"
        className="themed-compact-shadow grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill sm:flex"
        data-keeper-ignore="true"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
      >
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
          <UserPlus size={15} weight="duotone" />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {staged.map(recipient => (
            <span
              key={recipient.id}
              title={recipient.error ?? (recipient.name !== recipient.id ? recipient.id : undefined)}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border py-[3px] pl-2.5 pr-1 text-[11px] leading-4 font-medium tracking-[-0.1px] ${
                recipient.error
                  ? 'border-kumo-danger bg-kumo-danger-tint/40 text-kumo-danger'
                  : 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
              }`}
            >
              <span className="truncate">{recipient.name}</span>
              {recipient.name !== recipient.id && (
                <span className="truncate font-mono text-[10px] text-kumo-subtle">{recipient.id}</span>
              )}
              <button
                type="button"
                aria-label={`Remove ${recipientLabel(recipient)}`}
                onClick={() => removeStaged(recipient)}
                disabled={adding}
                className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed"
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
          <input
            ref={peopleInputRef}
            type="search"
            role={userSearchEnabled ? 'combobox' : undefined}
            placeholder={userSearchEnabled ? 'Search by name or email' : 'Username or email'}
            aria-label={userSearchEnabled ? 'Search people' : 'Username or email'}
            aria-autocomplete={userSearchEnabled ? 'list' : undefined}
            aria-expanded={userSearchEnabled ? directoryOpen : undefined}
            aria-controls={directoryOpen ? directoryListboxId : undefined}
            aria-activedescendant={activeDirectoryOptionId}
            value={addUsername}
            onChange={(event) => {
              setAddUsername(event.target.value)
              setDirectoryDismissed(false)
            }}
            onFocus={() => setDirectoryDismissed(false)}
            onBlur={() => setDirectoryDismissed(true)}
            onKeyDown={handleDirectoryKeyDown}
            name="gadget-share-people-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            className="h-9 min-w-0 grow basis-32 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <RoleMenu
          ariaLabel="Access to grant"
          value={addRole}
          onValueChange={onAddRoleChange}
          container={menuContainer}
        />
        <WorkshopButton
          tone="primary"
          className="col-span-3 w-full !rounded-xl sm:col-span-1 sm:w-auto sm:min-w-[68px]"
          onMouseDown={(event) => {
            // Keep the visible result highlighted until the click handler chooses it.
            if (directoryOpen) event.preventDefault()
          }}
          onClick={() => void handleInvite(typedRecipient)}
          disabled={!canSubmitInvite || adding}
        >
          {adding ? 'Inviting…' : inviteCount > 1 ? `Invite ${inviteCount} people` : 'Invite'}
        </WorkshopButton>
        {directoryOpen && directoryPortalContainer && createPortal(
          <div
            ref={directoryListboxRef}
            id={directoryListboxId}
            role="listbox"
            aria-label="Matching people"
            aria-busy={directory.status === 'loading'}
            // Pressing anywhere in the popover (an option, its padding, the scrollbar) must not
            // blur the combobox, which would dismiss the popover before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            className="chat-panel themed-floating-shadow-lg pointer-events-auto absolute overscroll-contain overflow-y-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-2"
          >
            {directory.status === 'loading' ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">Searching…</p>
            ) : directory.status === 'failed' ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-danger">
                User search is temporarily unavailable.
              </p>
            ) : directory.results.length === 0 ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">No users found.</p>
            ) : (
              <>
                {directory.results.map((user, index) => (
                  <button
                    key={user.id}
                    ref={index === activeDirectoryIndex ? activeDirectoryOptionRef : undefined}
                    id={`${directoryListboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeDirectoryIndex}
                    onMouseEnter={() => setActiveDirectoryIndex(index)}
                    onClick={() => stageRecipient({ id: user.id, name: user.name })}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                      index === activeDirectoryIndex ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'
                    }`}
                  >
                    <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-kumo-default">
                        {user.name}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-kumo-subtle">
                        {user.id}
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  ref={activeDirectoryIndex === directory.results.length
                    ? activeDirectoryOptionRef
                    : undefined}
                  id={`${directoryListboxId}-option-${directory.results.length}`}
                  type="button"
                  role="option"
                  aria-selected={activeDirectoryIndex === directory.results.length}
                  onMouseEnter={() => setActiveDirectoryIndex(directory.results.length)}
                  onClick={() => stageRecipient({ id: directoryQuery, name: directoryQuery })}
                  className={`mt-1 flex w-full items-center gap-3 rounded-xl border-t border-kumo-line/60 px-3 py-2 text-left ${
                    activeDirectoryIndex === directory.results.length
                      ? 'bg-kumo-tint'
                      : 'hover:bg-kumo-tint/70'
                  }`}
                >
                  <UserPlus size={15} className="shrink-0 text-kumo-subtle" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-kumo-default">
                      Add &ldquo;{directoryQuery}&rdquo; exactly
                    </span>
                    <span className="block text-[11px] text-kumo-subtle">
                      Use the text as a username or email
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>,
          directoryPortalContainer,
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{composerNotice}</p>
      {staged.some(recipient => recipient.error) && (
        <p role="alert" className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-danger">
          {staged.filter(recipient => recipient.error).map(recipient => (
            <span key={recipient.id} className="block break-words">
              {recipientLabel(recipient)}: {recipient.error}
            </span>
          ))}
        </p>
      )}

      {invitedNames.length > 0 && (
        <div className="themed-compact-shadow mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
            {invitedLinkCopied ? <Check size={15} weight="bold" /> : <UserPlus size={15} weight="duotone" />}
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="flex items-baseline gap-1.5">
              <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                Added {NAME_LIST.format(invitedNames)}
              </p>
              <span className="text-[11px] leading-4 text-kumo-inactive">
                {invitedLinkCopied ? 'Link copied to your clipboard' : 'Send them this link to open it'}
              </span>
            </div>
            <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{workspaceUrl}</p>
          </div>
          <WorkshopButton tone="primary" onClick={copyWorkspaceUrl} className="gap-1.5 !rounded-xl">
            {invitedLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
            {invitedLinkCopied ? 'Copied' : 'Copy link'}
          </WorkshopButton>
          <WorkshopIconButton
            aria-label="Dismiss added collaborator"
            onClick={() => { setInvitedNames([]); setInvitedLinkCopied(false) }}
          >
            <X size={14} />
          </WorkshopIconButton>
        </div>
      )}
    </>
  )
}

/**
 * The "People with access" list: each collaborator's access source, their role, and the inline
 * remove confirmation with its keep-dependents checklist. Shares nothing with the composer
 * except the data, reload, and landed-row flash it is handed.
 */
export function PeopleSection({
  overseer,
  authenticatedApi,
  metadata,
  currentUser,
  collaborators,
  shareLinks,
  landedPersonIds,
  reload,
}: {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  collaborators: CollaboratorInfo[]
  shareLinks: ShareLinkInfo[]
  landedPersonIds: ReadonlySet<string>
  reload: () => Promise<unknown>
}) {
  const toasts = useKumoToastManager()
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)

  const handleStartRemoveCollaborator = async (profileId: string) => {
    setRemoveTarget({ kind: 'remove', profileId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId)
      setRemoveTarget(current => current?.kind === 'remove' && current.profileId === profileId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setRemoveTarget(current => current?.kind === 'remove' && current.profileId === profileId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview collaborator removal.', variant: 'error' })
    }
  }

  const handleConfirmRemoveCollaborator = async () => {
    if (!removeTarget || removeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      const removed = await overseer.removeCollaborator(removeTarget.profileId, [...removeTarget.keepSet])
      setRemoveTarget(null)
      toasts.add({
        title: removed.length > 0
          ? 'Collaborator removed.'
          : 'Your direct grant was removed. This collaborator still has access through another source.',
        variant: 'success',
      })
      await reload()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  const describeAccess = (info: CollaboratorInfo): string => {
    if (info.addedBy.length > 1) return `Access from ${info.addedBy.length} sources`
    const edge = info.addedBy[0]
    if (!edge) return 'Collaborator'
    if (edge.type === 'user') return `Added directly by ${edge.sharer}`
    const key = shareLinks.find(item => item.linkId === edge.keyId)
    return key?.note ? `Joined through “${key.note}”` : 'Joined through a share link'
  }

  const isOwner = !metadata.owner
  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)
  type CollaboratorRow =
    | { kind: 'owner'; profile: AiChatAuthorInfo }
    | { kind: 'collaborator'; info: CollaboratorInfo }
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]

  return (
    <section aria-labelledby="people-heading" className="mt-4">
      <div className="mb-2 px-1">
        <h3 id="people-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          People with access
        </h3>
      </div>
      <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
        {collaboratorRows.map((row, index) => {
          const profile = row.kind === 'owner' ? row.profile : row.info.profile
          const key = row.kind === 'owner' ? '__owner__' : row.info.profile.id
          const isRemoving = row.kind === 'collaborator' && removeTarget?.profileId === row.info.profile.id
          const downstreamDependents = isRemoving && removeTarget
            ? removeTarget.dependents.filter(dep => dep.profile.id !== profile.id)
            : []
          return (
            <div key={key} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedPersonIds.has(profile.id) ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
              <div className="flex items-center gap-3">
                <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
                    {profile.name}{profile.id === currentUser?.id ? ' (you)' : ''}
                  </p>
                  <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
                    {row.kind === 'owner' ? profile.id : describeAccess(row.info)}
                  </p>
                </div>
                {row.kind === 'owner' ? (
                  <span className="px-2 text-[12px] text-kumo-subtle">Owner</span>
                ) : isRemoving ? (
                  <InlineConfirm
                    label="Remove"
                    busy={removeTarget.previewing || confirmationBusy}
                    busyLabel={removeTarget.previewing ? 'Checking…' : undefined}
                    onConfirm={handleConfirmRemoveCollaborator}
                    onCancel={() => setRemoveTarget(null)}
                  />
                ) : (
                  <>
                    <RoleBadge role={row.info.role} />
                    <WorkshopIconButton
                      danger
                      className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => handleStartRemoveCollaborator(row.info.profile.id)}
                      aria-label={`Remove ${profile.name}`}
                      disabled={confirmationBusy}
                    >
                      <Trash size={13} />
                    </WorkshopIconButton>
                  </>
                )}
              </div>
              {isRemoving && downstreamDependents.length > 0 && (
                <div className="mt-2.5 share-expand-in">
                  <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                    {downstreamDependents.length} other {downstreamDependents.length === 1 ? 'person loses' : 'people lose'} access through {profile.name}. Keep anyone?
                  </p>
                  <DependentKeepList
                    dependents={downstreamDependents}
                    keepSet={removeTarget.keepSet}
                    onKeepSetChange={(keepSet) => setRemoveTarget(current =>
                      current?.kind === 'remove' && current.profileId === removeTarget.profileId
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
