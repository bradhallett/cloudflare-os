import { useState } from 'react'
import { Button, Textarea, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { AdminApi, BannerColor, BANNER_COLORS, MAX_ANNOUNCEMENT_LENGTH } from '@gadgets/workshop-shared/api'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

// Swatch background per banner color, matching AnnouncementBanner's accent styles.
const BANNER_SWATCH: Record<BannerColor, string> = {
  neutral: 'var(--color-kumo-tint)',
  info: 'var(--color-kumo-info)',
  success: 'var(--color-kumo-success)',
  warning: 'var(--color-kumo-warning)',
  danger: 'var(--color-kumo-danger)',
  brand: 'var(--color-accent-100)',
}

/** The General tab's banner card: the text and color of the full-width top banner. */
export function BannerPanel({ admin, banner, onSaved }: {
  admin: RpcStub<AdminApi>
  banner: { text: string; color: BannerColor }
  onSaved: (banner: { text: string; color: BannerColor }) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [textDraft, setTextDraft] = useState(banner.text)
  const [colorDraft, setColorDraft] = useState<BannerColor>(banner.color)
  const [saving, setSaving] = useState(false)
  const dirty = textDraft !== banner.text || colorDraft !== banner.color
  const tooLong = textDraft.length > MAX_ANNOUNCEMENT_LENGTH

  const save = async () => {
    setSaving(true)
    try {
      await admin.setBanner(textDraft, colorDraft)
      onSaved({ text: textDraft, color: colorDraft })
      toasts.add({ title: 'Banner saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the banner', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Banner"
      description="A dismissible bar across the very top of the app (logged in or not). Markdown is supported, so you can include links. Leave empty to hide it. Applies on each user’s next connection."
    >
      <Textarea
        className="w-full"
        value={textDraft}
        onValueChange={setTextDraft}
        rows={1}
        placeholder={'e.g. \uD83C\uDF89 New: blueprints now support imports \u2014 [learn more](https://example.com).'}
        maxLength={MAX_ANNOUNCEMENT_LENGTH}
        error={tooLong ? `Too long by ${textDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters` : undefined}
      />

      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-kumo-subtle mb-2">Type</p>
          <div className="flex flex-wrap items-center gap-2">
            {BANNER_COLORS.map((c) => {
              const selected = colorDraft === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColorDraft(c)}
                  className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    selected
                      ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                      : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full border border-kumo-line"
                    style={{ background: BANNER_SWATCH[c] }}
                  />
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTextDraft(banner.text)
                setColorDraft(banner.color)
              }}
              disabled={saving}
            >
              Reset
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty || tooLong}>
            Save
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
