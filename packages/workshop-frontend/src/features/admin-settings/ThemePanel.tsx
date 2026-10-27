import { useEffect, useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { AdminApi } from '@gadgets/workshop-shared/api'
import { applyAccentColor, DEFAULT_ACCENT_COLOR } from '../../theme'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

// Preset accent colors offered in the card ('' = default brand).
const ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#16a34a' },
  { label: 'Purple', value: '#7c3aed' },
  { label: 'Pink', value: '#db2777' },
  { label: 'Teal', value: '#0d9488' },
]

/**
 * The General tab's theme card: a draft accent color, previewed live across the app while the
 * card is mounted and reverted on leave so an unsaved preview doesn't stick.
 */
export function ThemePanel({ admin, accentColor, onSaved }: {
  admin: RpcStub<AdminApi>
  accentColor: string
  onSaved: (accentColor: string) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [draft, setDraft] = useState(accentColor)
  const [saving, setSaving] = useState(false)
  const dirty = draft !== accentColor

  useEffect(() => {
    applyAccentColor(draft)
    return () => { applyAccentColor(accentColor) }
  }, [draft, accentColor])

  const save = async () => {
    setSaving(true)
    try {
      await admin.setAccentColor(draft)
      onSaved(draft)
      toasts.add({ title: 'Accent color saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the accent color', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Theme"
      description="Accent color used for buttons, links, and highlights. Changes preview live here; click Save to apply for everyone (on their next connection). Backgrounds keep the default warm theme."
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {ACCENT_PRESETS.map((preset) => {
          const selected = draft === preset.value
          const swatch = preset.value || DEFAULT_ACCENT_COLOR
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => setDraft(preset.value)}
              className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                selected
                  ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                  : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
              }`}
            >
              <span
                className="w-4 h-4 rounded-full border border-kumo-line"
                style={{ background: swatch }}
              />
              {preset.label}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
          <input
            type="color"
            value={draft || DEFAULT_ACCENT_COLOR}
            onChange={(e) => setDraft(e.target.value)}
            className="w-9 h-9 rounded-md border border-kumo-line bg-transparent cursor-pointer p-0.5"
          />
          Custom
        </label>
        <span className="text-xs font-mono text-kumo-subtle">
          {draft || `${DEFAULT_ACCENT_COLOR} (default)`}
        </span>
        <div className="flex-1" />
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(accentColor)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty}>
          Save
        </Button>
      </div>
    </SettingsCard>
  )
}
