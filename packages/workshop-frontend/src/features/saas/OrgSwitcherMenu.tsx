// The org switcher: the user menu's section that lists the signed-in user's organizations and
// jumps to each one's billing tab on the settings page — a person may be in many orgs, and this
// is how a multi-org user moves between them. Only mounted in VITE_SAAS builds (commerceGate.ts
// folds it out of OSS bundles); hides itself unless the server runs SaaS mode.

import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Buildings } from '@phosphor-icons/react'
import { OrgSummary } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useSaasEnabled } from '../../ServerConfigContext'
import { MENU_ITEM } from '../../components/menuStyles'

/**
 * The org list as dropdown items. Renders a fragment (not a wrapper) so the items sit directly
 * inside UserMenu's DropdownMenu.Content; empty — rendering nothing at all — when SaaS mode is
 * off or the user belongs to no orgs yet.
 */
export default function OrgSwitcherMenu() {
  const saasEnabled = useSaasEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null)

  useEffect(() => {
    if (!saasEnabled) return
    let cancelled = false
    // whoami() already carries the membership snapshot; listMyOrgs adds the names, which the
    // switcher is exactly for.
    authenticatedApi.listMyOrgs()
      .then((list) => { if (!cancelled) setOrgs(list) })
      .catch(() => { if (!cancelled) setOrgs([]) })
    return () => { cancelled = true }
  }, [saasEnabled, authenticatedApi])

  if (!saasEnabled || orgs === null || orgs.length === 0) return null

  return (
    <>
      {orgs.map((org) => (
        <DropdownItem
          key={org.id}
          org={org}
          onPick={(orgId) => navigate({ to: '/profile', search: { org: orgId } })}
        />
      ))}
    </>
  )
}

/** One org's dropdown item; separated only so the switcher's wrapper testid wraps the list. */
function DropdownItem({ org, onPick }: { org: OrgSummary; onPick: (orgId: string) => void }) {
  return (
    <button
      type="button"
      data-testid="saas-org-switcher"
      onClick={() => onPick(org.id)}
      className={MENU_ITEM}
    >
      <Buildings size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{org.name}</span>
      {org.status === 'invited' && <span className="text-[11px] text-kumo-inactive">invited</span>}
    </button>
  )
}
