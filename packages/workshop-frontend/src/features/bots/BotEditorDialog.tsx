// The shared editor for a bot's declaration: name, description, instructions, model, and the
// skills it may activate. User bots (/bots) and deployment bots (/admin) both edit through it;
// only who saves differs, so the dialog hands back a BotDefinition and nothing else.

import { useRef, useState } from 'react'
import { Checkbox, Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import { useInvalidShake } from '@gadgets/ui'
import { X } from '@phosphor-icons/react'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import {
  MAX_BOT_DESCRIPTION_LENGTH,
  MAX_BOT_INSTRUCTIONS_LENGTH,
  MAX_BOT_NAME_LENGTH,
  MAX_BOT_SKILLS,
  type BotDefinition,
  type BotSkillChoice,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton, WorkshopInput, WorkshopInputArea } from '../../components/WorkshopControls'

/** One selected skill: the choice the user picked, or a ref an existing bot declared that the
 * current workspace no longer offers — kept so saving an untouched bot doesn't drop it. */
type SelectedSkill = { vendorId: string; commandId: string; name: string }

const skillKey = (vendorId: string, commandId: string) => `${vendorId}\u0000${commandId}`

export const BotEditorDialog = ({
  models,
  skills,
  initial,
  title,
  description,
  busy = false,
  saveLabel = 'Save',
  onSave,
  onClose,
}: {
  /** The models the saving scope can run (the user's list, or the deployment's). */
  models: AiChatAuthorInfo[]
  /** The skills the saving scope can offer (see AuthenticatedApi.listBotSkills). */
  skills: BotSkillChoice[]
  /** The declaration to start from; absent for a new bot. */
  initial?: BotDefinition
  title: string
  /** The dialog's explanatory line under the title. */
  description?: string
  /** Disables every control while a save runs; the save button shows its busy label. */
  busy?: boolean
  saveLabel?: string
  /** Receives the edited declaration. Trimming and empty-to-undefined are the dialog's. */
  onSave: (def: BotDefinition) => Promise<void> | void
  onClose: () => void
}) => {
  const toasts = useKumoToastManager()
  const [name, setName] = useState(initial?.name ?? '')
  const [botDescription, setBotDescription] = useState(initial?.description ?? '')
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  const [modelId, setModelId] = useState(initial?.modelId ?? models[0]?.id ?? null)
  // The selected skills by vendorId+commandId. Refs in `initial` the current skill list doesn't
  // offer stay selected under their declared name, so an unedited bot round-trips.
  const [selected, setSelected] = useState(() => {
    const byKey = new Map<string, SelectedSkill>()
    for (const ref of initial?.skills ?? []) {
      byKey.set(skillKey(ref.vendorId, ref.commandId), ref)
    }
    return byKey
  })

  // A model the list no longer offers (the provider was disconnected, the bot edited elsewhere)
  // stays the bot's: the select shows it by id rather than silently re-pointing the bot.
  const labelOf = (id: string): string =>
    models.find((model) => model.id === id)?.name ?? id

  const toggleSkill = (choice: BotSkillChoice, checked: boolean) => {
    setSelected((previous) => {
      const key = skillKey(choice.vendorId, choice.commandId)
      if (checked) {
        // The cap is part of a bot's declaration, so the excess pick is refused where it's made.
        if (!previous.has(key) && previous.size >= MAX_BOT_SKILLS) {
          toasts.add({
            title: `A bot can declare at most ${MAX_BOT_SKILLS} skills`,
            variant: 'error',
          })
          return previous
        }
        const next = new Map(previous)
        next.set(key, { vendorId: choice.vendorId, commandId: choice.commandId, name: choice.name })
        return next
      }
      const next = new Map(previous)
      next.delete(key)
      return next
    })
  }

  // Enter in Name or Description submits — these are single-line inputs inside the form, and
  // Enter-as-save is the native affordance, deliberate here. Enter in the Instructions textarea
  // keeps its newline, and Escape closes through Dialog.Root's own handling.

  // Field errors stay out of sight until a Save is attempted, so an untouched form isn't red
  // (the same convention as AddGatewayModelForm).
  const [errorsShown, setErrorsShown] = useState(false)
  const nameError = name.trim() === '' ? 'Give the bot a name.' : undefined
  const modelError = modelId === null ? 'Pick a model for the bot to run.' : undefined
  const shownNameError = errorsShown ? nameError : undefined
  const shownModelError = errorsShown ? modelError : undefined

  const [saving, setSaving] = useState(false)
  const controlsDisabled = busy || saving
  const nameInputRef = useRef<HTMLInputElement>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  // Shakes the name field after a Save attempt finds it invalid (aria-invalid), never while
  // typing; the form below is what the hook listens for attempts on. The model select renders a
  // button trigger the hook cannot watch, so it gets focus and the announced error instead.
  useInvalidShake(nameInputRef)
  const submit = async () => {
    if (controlsDisabled) return
    if (nameError !== undefined || modelError !== undefined) {
      setErrorsShown(true)
      if (nameError !== undefined) nameInputRef.current?.focus()
      else modelTriggerRef.current?.focus()
      return
    }
    const def: BotDefinition = {
      name: name.trim(),
      description: botDescription.trim() === '' ? undefined : botDescription.trim(),
      instructions,
      modelId,
      skills: [...selected.values()],
    }
    setSaving(true)
    try {
      await onSave(def)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !controlsDisabled) onClose()
      }}
    >
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(560px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[15%] !-translate-y-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                {description}
              </Dialog.Description>
            )}
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} className="!h-7 !w-7" disabled={controlsDisabled} aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>
        {/* A form so Save submits and useInvalidShake sees submit attempts; validation is the
            dialog's own (noValidate), and a submit runs the same path as the Save button. */}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <div className="grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-kumo-default">Name</span>
              <WorkshopInput
                ref={nameInputRef}
                value={name}
                maxLength={MAX_BOT_NAME_LENGTH}
                disabled={controlsDisabled}
                onChange={(event) => setName(event.target.value)}
                placeholder="Research assistant"
                aria-invalid={shownNameError !== undefined}
                aria-describedby={shownNameError !== undefined ? 'bot-editor-name-error' : undefined}
                autoFocus
              />
              {shownNameError !== undefined && (
                <span id="bot-editor-name-error" role="alert" className="text-[11px] leading-4 text-kumo-danger">
                  {shownNameError}
                </span>
              )}
            </label>

            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-kumo-default">Description</span>
              <WorkshopInput
                value={botDescription}
                maxLength={MAX_BOT_DESCRIPTION_LENGTH}
                disabled={controlsDisabled}
                onChange={(event) => setBotDescription(event.target.value)}
                placeholder="What this bot is for, in one line"
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-kumo-default">Instructions</span>
              <WorkshopInputArea
                value={instructions}
                rows={8}
                maxLength={MAX_BOT_INSTRUCTIONS_LENGTH}
                disabled={controlsDisabled}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="How this bot should behave: voice, approach, constraints, when to use its skills."
              />
              <span className="text-[11px] leading-4 text-kumo-inactive">
                Sent as the bot's own instructions on every turn it runs.
              </span>
            </label>

            <Select<string | null>
              label="Model"
              className="w-full"
              disabled={controlsDisabled}
              value={modelId}
              onValueChange={(value) => {
                if (value !== null) setModelId(value)
              }}
              renderValue={(value) => (value === null ? 'No model' : labelOf(value))}
              render={(triggerProps) => (
                <button
                  {...triggerProps}
                  ref={modelTriggerRef}
                  aria-invalid={shownModelError !== undefined}
                  aria-describedby={shownModelError !== undefined ? 'bot-editor-model-error' : undefined}
                />
              )}
            >
              {models.map((model) => (
                <Select.Option key={model.id} value={model.id}>
                  {model.name}
                </Select.Option>
              ))}
              {/* A kept model the list no longer offers stays selectable as itself. */}
              {modelId !== null && !models.some((model) => model.id === modelId) && (
                <Select.Option value={modelId}>{modelId}</Select.Option>
              )}
            </Select>
            {shownModelError !== undefined && (
              <span id="bot-editor-model-error" role="alert" className="text-[11px] leading-4 text-kumo-danger">
                {shownModelError}
              </span>
            )}

            <fieldset className="grid gap-2" disabled={controlsDisabled}>
              <legend className="text-[13px] font-medium text-kumo-default">Skills</legend>
              <span className="text-[11px] leading-4 text-kumo-inactive">
                Listed in the bot's prompt; it activates one on demand with the activateSkill
                tool. {selected.size}/{MAX_BOT_SKILLS} selected.
              </span>
              {skills.length === 0 ? (
                <p className="text-[12px] leading-4 text-kumo-subtle">
                  No skills are available to declare yet. Connect a provider that offers them
                  (for example the Context library) and they will appear here.
                </p>
              ) : (
                <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-2">
                  {skills.map((choice) => {
                    const key = skillKey(choice.vendorId, choice.commandId)
                    const checked = selected.has(key)
                    return (
                      <Checkbox
                        key={key}
                        label={`${choice.name} · ${choice.providerLabel}`}
                        checked={checked}
                        disabled={controlsDisabled || (!checked && selected.size >= MAX_BOT_SKILLS)}
                        onCheckedChange={(state) => toggleSkill(choice, state === true)}
                      />
                    )
                  })}
                  {/* Refs this bot declared that the current list doesn't offer stay visible. */}
                  {[...selected.entries()]
                    .filter(([key]) => !skills.some((choice) => skillKey(choice.vendorId, choice.commandId) === key))
                    .map(([key, ref]) => (
                      <Checkbox
                        key={`stale-${key}`}
                        label={`${ref.name} — no longer offered in this workspace`}
                        checked
                        disabled={controlsDisabled}
                        onCheckedChange={(state) => {
                          if (state !== true) {
                            setSelected((previous) => {
                              const next = new Map(previous)
                              next.delete(key)
                              return next
                            })
                          }
                        }}
                      />
                    ))}
                </div>
              )}
            </fieldset>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} type="button" className="!h-9" disabled={controlsDisabled}>
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="primary"
            type="submit"
            disabled={controlsDisabled}
            className="!h-9 min-w-[72px]"
          >
            {saving ? 'Saving…' : saveLabel}
          </WorkshopButton>
        </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
