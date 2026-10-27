import { MagnifyingGlass, UserPlus } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import { AdminApi } from '@gadgets/workshop-shared/api'
import { PendingSwitch } from '@gadgets/ui'
import '@gadgets/ui/pending-switch.css'
import { useReportRpcFailure } from '../../useReportRpcFailure'

/** One access switch: icon, title, description, and the PendingSwitch for its setting. */
function AccessSwitch({ icon: Icon, title, description, checked, onChange }: {
  icon: typeof UserPlus
  title: string
  description: string
  checked: boolean
  onChange: (enabled: boolean) => Promise<void>
}) {
  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <div className="flex items-center gap-4">
        <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center bg-kumo-tint">
          <Icon size={18} className="text-kumo-subtle" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-kumo-strong">{title}</h2>
          <p className="text-sm text-kumo-subtle mt-0.5">{description}</p>
        </div>
        <PendingSwitch aria-label={title} checked={checked} onChange={onChange} />
      </div>
    </div>
  )
}

/**
 * The Access tab: whether new accounts may be created, and whether users may search for each
 * other. Both switches commit only once their write goes through.
 */
export function AccessPanel({ admin, signupsEnabled, userSearchEnabled, onChanged }: {
  admin: RpcStub<AdminApi>
  signupsEnabled: boolean
  userSearchEnabled: boolean
  onChanged: (which: 'signups' | 'userSearch', enabled: boolean) => void
}) {
  const reportRpcFailure = useReportRpcFailure()

  const toggle = async (which: 'signups' | 'userSearch', enabled: boolean) => {
    try {
      await (which === 'signups' ? admin.setSignupsEnabled(enabled) : admin.setUserSearchEnabled(enabled))
      onChanged(which, enabled)
    } catch (err) {
      reportRpcFailure('Failed to update the access setting', err)
    }
  }

  return (
    <>
      <AccessSwitch
        icon={UserPlus}
        title="Allow new sign-ups"
        description="When off, existing users can still log in but no new accounts can be created."
        checked={signupsEnabled}
        onChange={(enabled) => toggle('signups', enabled)}
      />
      <AccessSwitch
        icon={MagnifyingGlass}
        title="Allow user search"
        description={'Let users find other accounts by name or email when sharing a workspace. When off, people can only be invited by their exact username or email. Applies on each user\u2019s next connection.'}
        checked={userSearchEnabled}
        onChange={(enabled) => toggle('userSearch', enabled)}
      />
    </>
  )
}
