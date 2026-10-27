import type { ReactNode } from 'react'
import { ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import type {
  CollaboratorRole,
  GadgetMetadata,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import { roleLabel } from './ShareDialogControls'

/** Requirement lists match when they name the same gatekeepers in the same order. */
function sameRequirements(
  left: ObserverBindingNeed[],
  right: ObserverBindingNeed[],
): boolean {
  return left.length === right.length &&
    left.every((requirement, index) => requirement.gatekeeperId === right[index].gatekeeperId)
}

// What a recipient is asked to do before the workspace will open for them. Recipients don't
// inherit the owner's connections: they must point their own account at each connection in scope
// for the selected access level, so sharers should know that cost before they invite anyone.
function RecipientVerification({
  requirements,
  failed,
  role,
  headingId,
  heading,
}: {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
  role?: CollaboratorRole
  headingId: string
  heading: string
}) {
  let body: ReactNode
  if (failed) {
    body = (
      <p className="px-1 text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
        Couldn’t check which connections recipients will be asked to verify.
      </p>
    )
  } else if (requirements === null || requirements.length === 0) {
    // Still loading: stay silent rather than reserving space for an answer we don't have yet.
    return null
  } else {
    body = (
      <div className="rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5">
        <p className="text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
          {role ? (
            <>People with <span className="font-medium text-kumo-default">{roleLabel(role)}</span> access must</>
          ) : 'Recipients must'} prove their own account can reach:
        </p>
        <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
          {requirements.map(requirement => (
            <li key={requirement.gatekeeperId} className="min-w-0">
              <p className="truncate text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-default">
                {requirement.resourceTitle}
              </p>
              {requirement.resourceUrl && (
                <p className="truncate font-mono text-[11px] leading-4 text-kumo-inactive">
                  {requirement.resourceUrl}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <ShieldCheck size={13} className="text-kumo-inactive" />
        <h3 id={headingId} className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          {heading}
        </h3>
      </div>
      {body}
    </section>
  )
}

/**
 * The access-visibility banner: what restricted data the workspace holds and (when the server
 * forbids share links) who is allowed to add people, so sharers understand the blast radius
 * before acting on either flow below.
 */
export default function VisibilitySection({
  metadata,
  ownerInvitesOnly,
}: {
  metadata: GadgetMetadata
  ownerInvitesOnly: boolean
}) {
  const containsRestrictedData = metadata.containsRestrictedData === true
  if (!containsRestrictedData && !ownerInvitesOnly) return null
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-2xl bg-kumo-warning-tint px-3 py-2.5">
      <div className="grid h-6 w-6 shrink-0 place-items-center text-kumo-warning">
        <ShieldWarning size={18} weight="duotone" />
      </div>
      {ownerInvitesOnly ? (
        <p className="text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-default">
          This workspace has read data from a connection that doesn’t allow share links, so
          only the owner can add people. People the owner invites are asked to verify their
          own access to the connections it uses at their access level — some may be unable to
          open it. Anything the workspace has already saved is visible to everyone who can.
        </p>
      ) : (
        <p className="text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-default">
          This workspace has read sensitive data. People you invite are asked to verify their
          own access to the connections it uses at their access level — some may be unable to
          open it. Anything the workspace has already saved is visible to everyone who can.
        </p>
      )}
    </div>
  )
}

/**
 * What recipients must verify before the workspace opens for them, for the access levels this
 * session is actually offering: the invite role always, the share-link role when a link is
 * being composed or was just minted. Identical requirement lists collapse into one block.
 */
export function RecipientVerificationSummary({
  canInvite,
  requirements,
  requirementsFailed,
  addRole,
  newLinkRole,
  linkOffered,
}: {
  canInvite: boolean
  requirements: Record<CollaboratorRole, ObserverBindingNeed[]> | null
  requirementsFailed: boolean
  addRole: CollaboratorRole
  newLinkRole: CollaboratorRole
  linkOffered: boolean
}) {
  if (!canInvite) {
    // Nothing this user can do here admits a recipient, so there is nothing to verify.
    return null
  }
  if (requirementsFailed) {
    return (
      <RecipientVerification
        requirements={null}
        failed
        headingId="recipient-verification-heading"
        heading="Recipient verification"
      />
    )
  }
  if (requirements === null) return null
  const inviteRequirements = requirements[addRole]
  if (!linkOffered) {
    return (
      <RecipientVerification
        requirements={inviteRequirements}
        failed={false}
        role={addRole}
        headingId="recipient-verification-heading"
        heading="Recipient verification"
      />
    )
  }
  const linkRequirements = requirements[newLinkRole]
  if (sameRequirements(inviteRequirements, linkRequirements)) {
    return (
      <RecipientVerification
        requirements={inviteRequirements}
        failed={false}
        role={addRole === newLinkRole ? addRole : undefined}
        headingId="recipient-verification-heading"
        heading="Recipient verification"
      />
    )
  }
  return (
    <>
      <RecipientVerification
        requirements={inviteRequirements}
        failed={false}
        role={addRole}
        headingId="invite-verification-heading"
        heading="Direct invite verification"
      />
      <RecipientVerification
        requirements={linkRequirements}
        failed={false}
        role={newLinkRole}
        headingId="link-verification-heading"
        heading="Share-link verification"
      />
    </>
  )
}
