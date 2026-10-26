import { useState } from 'react'
import { Button, Textarea, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { AdminApi, MAX_ANNOUNCEMENT_LENGTH } from '@gadgets/workshop-shared/api'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

/** The General tab's notice card: the single-line markdown notice in the top navigation bar. */
export function AnnouncementPanel({ admin, announcement, onSaved }: {
  admin: RpcStub<AdminApi>
  announcement: string
  onSaved: (announcement: string) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [draft, setDraft] = useState(announcement)
  const [saving, setSaving] = useState(false)
  const tooLong = draft.length > MAX_ANNOUNCEMENT_LENGTH

  const save = async () => {
    setSaving(true)
    try {
      await admin.setAnnouncement(draft)
      onSaved(draft)
      toasts.add({ title: 'Announcement saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the announcement', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Top-bar notice"
      description="Shown centered in the top navigation bar. Markdown is supported, so you can include links. Keep it short — it renders on a single line. Leave empty to show nothing. Applies on each user’s next connection."
    >
      <Textarea
        className="w-full"
        value={draft}
        onValueChange={setDraft}
        rows={1}
        placeholder={'e.g. Heads up: scheduled maintenance Saturday \u2014 see [status](https://status.example.com).'}
        maxLength={MAX_ANNOUNCEMENT_LENGTH}
        error={tooLong ? `Too long by ${draft.length - MAX_ANNOUNCEMENT_LENGTH} characters` : undefined}
      />

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-kumo-subtle">
          {draft.length.toLocaleString()} / {MAX_ANNOUNCEMENT_LENGTH.toLocaleString()} characters
        </span>
        <div className="flex items-center gap-2">
          {draft !== announcement && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(announcement)} disabled={saving}>
              Reset
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={draft === announcement || tooLong}
          >
            Save
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
