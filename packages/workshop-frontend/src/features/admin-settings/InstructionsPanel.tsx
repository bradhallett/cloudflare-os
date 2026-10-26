import { useState } from 'react'
import { Button, Textarea, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import { AdminApi, MAX_INSTANCE_INSTRUCTIONS_LENGTH } from '@gadgets/workshop-shared/api'
import { useReportRpcFailure } from '../../useReportRpcFailure'
import { SettingsCard } from './SettingsCard'

/** The General tab's instructions card: extra text added to every agent's system prompt. */
export function InstructionsPanel({ admin, instructions, onSaved }: {
  admin: RpcStub<AdminApi>
  instructions: string
  onSaved: (instructions: string) => void
}) {
  const toasts = useKumoToastManager()
  const reportRpcFailure = useReportRpcFailure()
  const [draft, setDraft] = useState(instructions)
  const [saving, setSaving] = useState(false)
  const tooLong = draft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH

  const save = async () => {
    setSaving(true)
    try {
      await admin.setInstanceInstructions(draft)
      onSaved(draft)
      toasts.add({ title: 'System prompt instructions saved', variant: 'success' })
    } catch (err) {
      reportRpcFailure('Failed to save the agent instructions', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Agent instructions"
      description="Extra instructions added to every agent’s system prompt on this deployment. Use this for instance-specific context, conventions, or guardrails."
    >
      <Textarea
        className="w-full"
        value={draft}
        onValueChange={setDraft}
        rows={6}
        placeholder={'e.g. ACME Corp is a logistics company that helps small businesses ship\ninternationally. Our team builds internal tools and dashboards to track shipments.'}
        maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
        error={tooLong ? `Too long by ${draft.length - MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters` : undefined}
      />

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-kumo-subtle">
          {draft.length.toLocaleString()} / {MAX_INSTANCE_INSTRUCTIONS_LENGTH.toLocaleString()} characters
        </span>
        <div className="flex items-center gap-2">
          {draft !== instructions && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(instructions)} disabled={saving}>
              Reset
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            loading={saving}
            disabled={draft === instructions || tooLong}
          >
            Save
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
