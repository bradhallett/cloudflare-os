// The org billing section of the settings page: plan card, seats management (invite claims a
// seat immediately), customer-portal link, and the current cycle's usage. Only mounted in
// VITE_SAAS builds (commerceGate.ts folds it out of OSS bundles); within those, it hides itself
// until the server says SaaS mode is on, mirroring UsageSettings' hide-when-off contract.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Button, useKumoToastManager,
} from '@cloudflare/kumo'
import { ArrowSquareOut, UserPlus, X } from '@phosphor-icons/react'
import {
  CommercePlan, OrgBillingOverview, OrgMember, OrgSummary,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useSaasEnabled } from '../../ServerConfigContext'

const INPUT =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] text-kumo-default placeholder:text-kumo-inactive transition-colors focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'

/**
 * One org's billing panel. The `org` entry carries the caller's own role and status — the admin
 * affordances (invite, remove, portal, upgrade) show only for an active owner or admin; the org
 * re-checks that authority live on every billing RPC, so a stale entry can only cost the caller
 * an error toast, never authority.
 */
function OrgBillingPanel({ org, onCheckoutStart }: {
  org: OrgSummary
  onCheckoutStart: (orgId: string) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [billing, setBilling] = useState<OrgBillingOverview | null>(null)
  const [members, setMembers] = useState<OrgMember[] | null>(null)
  const [inviteId, setInviteId] = useState('')
  const [busy, setBusy] = useState(false)
  const refreshVersion = useRef(0)

  const isAdmin = org.status === 'active' && (org.role === 'owner' || org.role === 'admin')

  // Billing is admin-only on the server (getOrgBilling re-checks live), so a member is never
  // asked for it — a refusal would otherwise render as the misleading "free plan" fallback.
  const refresh = useCallback(() => {
    const version = ++refreshVersion.current
    if (isAdmin) {
      authenticatedApi.getOrgBilling(org.id)
        .then((b) => { if (version === refreshVersion.current) setBilling(b) })
        .catch(() => { if (version === refreshVersion.current) setBilling(null) })
    }
    authenticatedApi.getOrgMembers(org.id)
      .then((m) => { if (version === refreshVersion.current) setMembers(m) })
      .catch(() => { if (version === refreshVersion.current) setMembers(null) })
  }, [authenticatedApi, org.id, isAdmin])

  useEffect(refresh, [refresh])

  const invite = async () => {
    const userId = inviteId.trim()
    if (!userId || busy) return
    setBusy(true)
    try {
      await authenticatedApi.inviteOrgMember(org.id, userId)
      toasts.add({ title: `Invited ${userId}.`, variant: 'success' })
      setInviteId('')
      refresh()
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not invite.', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (userId: string) => {
    if (busy) return
    setBusy(true)
    try {
      await authenticatedApi.removeOrgMember(org.id, userId)
      toasts.add({ title: 'Removed.', variant: 'success' })
      refresh()
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not remove.', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const openPortal = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { url } = await authenticatedApi.openOrgBillingPortal(org.id)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not open the billing portal.', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
      {/* Plan card: admins see the plan and its controls; a member sees that billing is managed
          elsewhere, never a made-up "Free plan" for the overview the RPC refuses them. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {isAdmin ? (
          <div>
            <p className="text-[15px] font-medium text-kumo-default">
              {(billing?.plan ?? 'free').replace(/^./, (c) => c.toUpperCase())} plan
            </p>
            <p className="mt-0.5 text-[13px] text-kumo-subtle">
              {billing
                ? billing.plan === 'free'
                  ? 'No subscription yet.'
                  : `${billing.subscriptionStatus} · $${billing.monthlySpendCapUsd}/mo cap${billing.overageAllowed ? ' · overage allowed' : ''}`
                : '…'}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-[15px] font-medium text-kumo-default">Billing</p>
            <p className="mt-0.5 text-[13px] text-kumo-subtle">
              Managed by this organization's owners and admins.
            </p>
          </div>
        )}
        {isAdmin && billing?.plan === 'free' && (
          <Button variant="primary" size="sm" onClick={() => onCheckoutStart(org.id)}>
            Upgrade
          </Button>
        )}
        {isAdmin && billing && billing.plan !== 'free' && (
          <Button variant="secondary" size="sm" onClick={openPortal}>
            <ArrowSquareOut size={14} /> Billing portal
          </Button>
        )}
      </div>

      {/* Seats */}
      <div>
        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">Seats</p>
        {isAdmin && (
          <p className="mt-1 text-[13px] text-kumo-subtle">
            {billing ? `${billing.assignedSeats} of ${billing.seats} licensed seats claimed (invitations claim immediately).` : '…'}
          </p>
        )}
        <ul className="mt-2 divide-y divide-kumo-line">
          {(members ?? []).map((member) => (
            <li key={member.userId} className="flex items-center gap-2 py-2 text-[14px]">
              <span className="min-w-0 flex-1 truncate text-kumo-default">{member.userId}</span>
              <span className="text-[12px] text-kumo-subtle">
                {member.role.replace(/^./, (c) => c.toUpperCase())}{member.status === 'invited' ? ' · invited' : ''}
              </span>
              {isAdmin && (
                <button
                  type="button"
                  aria-label={`Remove ${member.userId}`}
                  onClick={() => remove(member.userId)}
                  disabled={busy}
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <div className="mt-2 flex gap-2">
            <input
              className={INPUT}
              placeholder="Email or username to invite"
              value={inviteId}
              onChange={(e) => setInviteId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') invite() }}
            />
            <Button variant="secondary" size="sm" onClick={invite} disabled={busy || !inviteId.trim()}>
              <UserPlus size={14} /> Invite
            </Button>
          </div>
        )}
        {!isAdmin && <p className="mt-2 text-[12px] text-kumo-inactive">Only owners and admins can manage seats and billing.</p>}
      </div>

      {/* Usage: the admin's overview of the current cycle. */}
      {isAdmin && (
        <div>
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">Usage this cycle</p>
          {billing?.usage ? (
            <p className="mt-1 text-[13px] text-kumo-subtle">
              {billing.usage.inputTokens.toLocaleString()} in · {billing.usage.cacheReadTokens.toLocaleString()} cached ·{' '}
              {billing.usage.outputTokens.toLocaleString()} out tokens
              {billing.usage.estimatedCostUsd !== null && <> · ~${billing.usage.estimatedCostUsd.toFixed(2)} metered</>}
            </p>
          ) : (
            <p className="mt-1 text-[13px] text-kumo-subtle">No metered usage yet this cycle.</p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The org billing section: one tab per org (a person may be in many), with the `?org=` search
 * parameter picking the selected tab — live, not just at mount: the org switcher and the upgrade
 * prompt navigate with it, and a search-only navigation re-renders this component, so the
 * parameter arrives as a prop and the panel follows it. Renders nothing unless the server runs
 * SaaS mode and the caller is in at least one org.
 */
export default function OrgBillingSettings({ org: requestedOrg }: { org?: string }) {
  const saasEnabled = useSaasEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null)
  const [plans, setPlans] = useState<CommercePlan[] | null>(null)
  const [upgradingOrg, setUpgradingOrg] = useState<string | null>(null)
  const [seats, setSeats] = useState(1)
  const [busy, setBusy] = useState(false)
  const refreshVersion = useRef(0)

  useEffect(() => {
    if (!saasEnabled) return
    const version = ++refreshVersion.current
    authenticatedApi.listMyOrgs()
      .then((list) => {
        if (version !== refreshVersion.current) return
        setOrgs(list)
      })
      .catch(() => { if (version === refreshVersion.current) setOrgs([]) })
  }, [saasEnabled, authenticatedApi])

  useEffect(() => {
    if (!saasEnabled || upgradingOrg === null) return
    authenticatedApi.listCommercePlans()
      .then((list) => setPlans(list.filter((plan) => plan.id !== 'free')))
      .catch(() => setPlans([]))
  }, [saasEnabled, authenticatedApi, upgradingOrg])

  // A member's seat count is the sensible floor for an upgrade; the picker starts there.
  useEffect(() => {
    if (upgradingOrg === null) return
    authenticatedApi.getOrgBilling(upgradingOrg)
      .then((billing) => setSeats(Math.max(1, billing.assignedSeats)))
      .catch(() => setSeats(1))
  }, [authenticatedApi, upgradingOrg])

  if (!saasEnabled || orgs === null || orgs.length === 0) return null

  // Which org's panel shows: the ?org= parameter when it names a membership, else the first org.
  // Derived, never stored — a stale tab is exactly what seeding it once at mount produced.
  const org = orgs.find((entry) => entry.id === requestedOrg) ?? orgs[0]

  const startCheckout = async (planId: string) => {
    if (upgradingOrg === null || busy) return
    setBusy(true)
    try {
      const { url } = await authenticatedApi.startOrgCheckout(upgradingOrg, planId, seats)
      window.location.assign(url)
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not start checkout.', variant: 'error' })
      setBusy(false)
    }
  }

  return (
    <section data-testid="saas-org-settings" className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        Organization billing
      </h2>

      {orgs.length > 1 && (
        <div role="tablist" className="flex gap-1 px-1">
          {orgs.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              type="button"
              aria-selected={entry.id === org.id}
              onClick={() => navigate({ to: '/profile', search: { org: entry.id } })}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                entry.id === org.id
                  ? 'bg-kumo-tint text-kumo-default'
                  : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
              }`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}

      <OrgBillingPanel key={org.id} org={org} onCheckoutStart={(orgId) => setUpgradingOrg(orgId)} />

      {upgradingOrg !== null && (
        <div className="flex flex-col gap-3 rounded-xl border border-kumo-line bg-kumo-base p-5">
          <p className="text-[15px] font-medium text-kumo-default">Upgrade {org.name}</p>
          <label className="flex items-center gap-2 text-[13px] text-kumo-subtle">
            Seats
            <input
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
              className="h-9 w-24 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] text-kumo-default"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(plans ?? []).map((plan) => (
              <Button key={plan.id} variant="primary" size="sm" onClick={() => startCheckout(plan.id)} disabled={busy}>
                {plan.name}
              </Button>
            ))}
            {plans !== null && plans.length === 0 && (
              <p className="text-[13px] text-kumo-subtle">No plans are available on this deployment.</p>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setUpgradingOrg(null)}>Cancel</Button>
        </div>
      )}
    </section>
  )
}
