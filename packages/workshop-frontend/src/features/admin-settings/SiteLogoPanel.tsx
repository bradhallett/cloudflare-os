import { useRef, useState, type ChangeEvent } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Hexagon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import { AdminApi } from '@gadgets/workshop-shared/api'
import { cacheBustSiteLogoUrl, prepareSiteLogo } from '../../siteLogoUtils'
import SiteLogo from '../../components/SiteLogo'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

/** The General tab's logo card: upload or remove the deployment's logo image. */
export function SiteLogoPanel({ admin, siteLogoUrl, onSaved }: {
  admin: RpcStub<AdminApi>
  siteLogoUrl: string | null
  onSaved: (url: string | null) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setSaving(true)
    try {
      const data = await prepareSiteLogo(file)
      const logo = await admin.setSiteLogo(data)
      onSaved(logo ? cacheBustSiteLogoUrl(logo.url) : null)
      toasts.add({ title: 'Logo saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the logo', err)
    } finally {
      setSaving(false)
    }
  }

  const removeLogo = async () => {
    setSaving(true)
    try {
      await admin.setSiteLogo(null)
      onSaved(null)
      toasts.add({ title: 'Default logo restored', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to remove the logo', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Logo"
      description="Shown in the app chrome, sign-in screens, and browser tab. Images are scaled without cropping and converted to a static PNG. Square images work best. Applies on each user’s next connection."
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-kumo-line bg-kumo-base p-2">
          <SiteLogo size={40} srcOverride={siteLogoUrl}>
            <Hexagon size={32} weight="bold" className="text-kumo-brand" />
          </SiteLogo>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          disabled={saving}
          onChange={handleFileChange}
        />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            loading={saving}
            disabled={saving}
          >
            {siteLogoUrl ? 'Change logo' : 'Upload logo'}
          </Button>
          {siteLogoUrl && (
            <Button variant="ghost" size="sm" onClick={removeLogo} disabled={saving}>
              Restore default
            </Button>
          )}
        </div>
      </div>
    </SettingsCard>
  )
}
