// The SaaS build's upgrade prompt, shown at every plan-enforcement point: the chat's `usage_limit`
// error surface (where it replaces the OSS build's OutOfCreditsModal) and the refusal codes the
// backend attaches to model / connector / workspace-cap refusals. Only reachable in VITE_SAAS
// builds — commerceGate.ts folds this module out of OSS bundles entirely.

import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Dialog, Button, Loader } from '@cloudflare/kumo'
import { Lightning } from '@phosphor-icons/react'
import { PLAN_REFUSAL_CODES, type PlanRefusalCode } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { SAAS_ROUTE_BASE } from './saasRoute'

export type UpgradePromptReason = 'usage_limit' | PlanRefusalCode

interface UpgradePromptModalProps {
  open: boolean
  onClose: () => void
  /** What triggered the prompt; picks the headline copy. */
  reason: UpgradePromptReason
}

const HEADLINES: Record<UpgradePromptReason, string> = {
  usage_limit: "You've reached your plan's usage limit",
  [PLAN_REFUSAL_CODES.modelNotOnPlan]: "That model isn't available on your plan",
  [PLAN_REFUSAL_CODES.connectorNotOnPlan]: "That connector isn't available on your plan",
  [PLAN_REFUSAL_CODES.workspaceCapReached]: "You've reached your plan's workspace limit",
}

const BODIES: Record<UpgradePromptReason, string> = {
  usage_limit: "Usage past this point needs a paid plan. Upgrade to keep building — your workspaces and chats carry over.",
  [PLAN_REFUSAL_CODES.modelNotOnPlan]: "Paid plans unlock the larger models. Upgrade to use it in this chat.",
  [PLAN_REFUSAL_CODES.connectorNotOnPlan]: "Paid plans unlock more connectors. Upgrade to connect it.",
  [PLAN_REFUSAL_CODES.workspaceCapReached]: "Paid plans raise the workspace limit. Upgrade to create more.",
}

/**
 * Offers a plan upgrade at an enforcement point. The primary action goes wherever the user can
 * actually upgrade: the org settings' billing section once they administer an org, or the signup
 * funnel (which creates the org and starts checkout) when they don't have one yet.
 */
export default function UpgradePromptModal({ open, onClose, reason }: UpgradePromptModalProps) {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  const [adminOrg, setAdminOrg] = useState<string | null | undefined>(undefined)

  // Which org (if any) the user can take to checkout: memberships are the display snapshot, so
  // the org's own record re-checks the role when it matters (getOrgBilling / startOrgCheckout).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    authenticatedApi.whoami()
      .then((info) => {
        if (cancelled) return
        const adminnable = info.orgs.find(
          (org) => org.status === 'active' && (org.role === 'owner' || org.role === 'admin'))
        setAdminOrg(adminnable?.orgId ?? null)
      })
      .catch(() => { if (!cancelled) setAdminOrg(null) })
    return () => { cancelled = true }
  }, [open, authenticatedApi])

  const upgrade = () => {
    if (adminOrg) navigate({ to: '/profile', search: { org: adminOrg } })
    else window.location.assign(SAAS_ROUTE_BASE + '/start')
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6 sm:w-[480px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Lightning size={22} weight="bold" className="text-kumo-warning" />
          {HEADLINES[reason]}
        </Dialog.Title>
        <div data-testid="saas-upgrade-prompt" className="space-y-4">
          <p className="text-sm text-kumo-subtle">{BODIES[reason]}</p>
          {adminOrg === undefined ? (
            <div className="flex justify-center py-4"><Loader size="base" /></div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>Not now</Button>
              <Button variant="primary" onClick={upgrade}>Upgrade plan</Button>
            </div>
          )}
          <p className="text-[12px] text-kumo-inactive">
            Signed in as {currentUser?.name ?? '…'} — plan changes apply to your organization.
          </p>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
