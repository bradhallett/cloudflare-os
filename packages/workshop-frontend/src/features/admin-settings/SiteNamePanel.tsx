import { useState } from 'react'
import { Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { AdminApi, DEFAULT_SITE_NAME, MAX_SITE_NAME_LENGTH } from '@gadgets/workshop-shared/api'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

/** The General tab's site-name card: a draft of the deployment's display name. */
export function SiteNamePanel({ admin, siteName, onSaved }: {
  admin: RpcStub<AdminApi>
  siteName: string
  onSaved: (siteName: string) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [draft, setDraft] = useState(siteName)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await admin.setSiteName(draft)
      onSaved(draft)
      toasts.add({ title: 'Site name saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the site name', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Site name"
      description={`Shown next to the logo in the top bar. Leave empty to use the default (“${DEFAULT_SITE_NAME}”). Applies on each user’s next connection.`}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={DEFAULT_SITE_NAME}
        maxLength={MAX_SITE_NAME_LENGTH}
      />

      <div className="flex items-center justify-end mt-4 gap-2">
        {draft !== siteName && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(siteName)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={draft === siteName}>
          Save
        </Button>
      </div>
    </SettingsCard>
  )
}
