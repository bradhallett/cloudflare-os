// The Bots page: a user's own declared bots (create, edit, delete) and the deployment's
// (read-only — an administrator declares those on the Admin page). A bot is a named agent with
// preset instructions, a model, and skills; chats pick one at intake instead of a model.

import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { DotsThreeVertical, PencilSimple, Plus, Robot, Trash } from '@phosphor-icons/react'
import type { AiChatAuthorInfo, BotDefinition, BotInfo, BotSkillChoice } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useDocumentTitle } from '../../useDocumentTitle'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { BotEditorDialog } from '../../features/bots/BotEditorDialog'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER } from '../../components/menuStyles'
import { rpcFailureDescription } from '../../rpcErrors'

const CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated p-6'

/** What the editor dialog is open for: a new bot, or an existing one being edited. */
type EditorSession = { mode: 'add' } | { mode: 'edit'; bot: BotInfo }

/**
 * One declared bot as a row: name, description, model, and skill count, with a kebab for edit and
 * delete. Deployment bots render through the same shape without actions.
 */
const BotRow = ({ bot, modelLabel, onEdit, onDelete }: {
  bot: BotInfo
  /** The bot's model by name when it resolves, else its raw id. */
  modelLabel: string
  onEdit?: () => void
  onDelete?: () => void
}) => (
  <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint">
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
      <Robot size={16} weight="regular" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
          {bot.name}
        </span>
        <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
          {bot.selection.scope === 'user' ? 'yours' : 'deployment'}
        </span>
        {!bot.available && (
          <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-warning">
            unavailable
          </span>
        )}
      </div>
      <span className="mt-0.5 block truncate text-[12px] leading-4 text-kumo-inactive">
        {bot.available
          ? [bot.description, modelLabel].filter(Boolean).join(' · ')
          : bot.unavailableReason ?? modelLabel}
      </span>
    </div>
    {(onEdit || onDelete) && (
      <div>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                aria-label="Bot actions"
                className="cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <DotsThreeVertical size={16} />
              </button>
            }
          />
          <DropdownMenu.Content className={MENU_CONTENT}>
            {onEdit && (
              <DropdownMenu.Item onClick={onEdit} className={MENU_ITEM}>
                <PencilSimple size={13} className="mr-2" />
                Edit bot
              </DropdownMenu.Item>
            )}
            {onDelete && (
              <DropdownMenu.Item variant="danger" onClick={onDelete} className={MENU_ITEM_DANGER}>
                <Trash size={13} className="mr-2" />
                Delete bot
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    )}
  </div>
)

export function BotsPage() {
  useDocumentTitle('Bots')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [bots, setBots] = useState<BotInfo[]>([])
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [skills, setSkills] = useState<BotSkillChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // The editor dialog's session; mounting it is opening it.
  const [editor, setEditor] = useState<EditorSession | null>(null)
  const [deleting, setDeleting] = useState<BotInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    setLoadError(false)
    try {
      // Bots reference a model and skills by id, so all three land together for one coherent page.
      const [botList, modelList, skillList] = await Promise.all([
        authenticatedApi.listBots(),
        authenticatedApi.listModels(),
        authenticatedApi.listBotSkills(),
      ])
      setBots(botList)
      setModels(modelList)
      setSkills(skillList)
    } catch (err) {
      console.error('Failed to load bots:', err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [authenticatedApi])

  // An open editor loads its subject's declaration (BotInfo is the merged public view; the full
  // BotDefinition is the user's own and fetched on edit, like a provider's configuration).
  const [editDef, setEditDef] = useState<BotDefinition | null>(null)
  const editRequest = useRef(0)
  useEffect(() => {
    if (editor?.mode !== 'edit') {
      setEditDef(null)
      return
    }
    const request = ++editRequest.current
    authenticatedApi.getBot(editor.bot.selection.id)
      .then((def) => {
        if (request === editRequest.current) setEditDef(def)
      })
      .catch((err) => {
        if (request !== editRequest.current) return
        console.error('Failed to load bot:', err)
        toasts.add({ title: 'Failed to load bot', variant: 'error' })
        setEditor(null)
      })
  }, [editor, authenticatedApi, toasts])

  const reportFailure = (title: string, err: unknown) => {
    console.error(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  const saveEditor = async (def: BotDefinition) => {
    if (!editor) return
    setBusy(true)
    try {
      if (editor.mode === 'add') await authenticatedApi.createBot(def)
      else await authenticatedApi.updateBot(editor.bot.selection.id, def)
      setEditor(null)
      await reload().catch((err) => reportFailure('Saved, but couldn’t reload bots', err))
    } catch (err) {
      reportFailure(editor.mode === 'add' ? 'Couldn’t create bot' : 'Couldn’t update bot', err)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await authenticatedApi.deleteBot(deleting.selection.id)
      toasts.add({ title: 'Bot deleted', variant: 'success' })
      setDeleting(null)
      await reload().catch((err) => reportFailure('Deleted, but couldn’t reload bots', err))
    } catch (err) {
      reportFailure(`Couldn’t delete ${deleting.name}`, err)
    } finally {
      setBusy(false)
    }
  }

  const userBots = bots.filter((bot) => bot.selection.scope === 'user')
  const deploymentBots = bots.filter((bot) => bot.selection.scope === 'deployment')
  const modelLabel = (bot: BotInfo): string => bot.modelName ?? bot.modelId

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[880px] px-4 py-16 text-center text-sm text-kumo-subtle sm:px-8">
        Loading bots…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-[880px] px-4 py-16 text-center sm:px-8">
        <p className="text-sm text-kumo-danger">Something went wrong loading bots.</p>
        <button
          onClick={() => { setLoading(true); void reload() }}
          className="text-kumo-brand mt-2 cursor-pointer text-sm underline"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-6 px-4 py-8 sm:px-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-kumo-default">Bots</h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            Named agents with their own instructions, model, and skills. Pick one instead of a
            model when you start a chat.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditor({ mode: 'add' })}
          className="press inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover"
        >
          <Plus size={14} weight="bold" />
          New bot
        </button>
      </div>

      <section className={CARD}>
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Your bots</h2>
        <p className="mb-4 text-sm text-kumo-subtle">
          Yours alone; each is offered in your own chat intake.
        </p>
        {userBots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">
            No bots yet. Create one to give it instructions, a model, and skills.
          </p>
        ) : (
          <div className="grid gap-0.5">
            {userBots.map((bot) => (
              <BotRow
                key={`user:${bot.selection.id}`}
                bot={bot}
                modelLabel={modelLabel(bot)}
                onEdit={() => setEditor({ mode: 'edit', bot })}
                onDelete={() => setDeleting(bot)}
              />
            ))}
          </div>
        )}
      </section>

      <section className={CARD}>
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Deployment bots</h2>
        <p className="mb-4 text-sm text-kumo-subtle">
          Declared for everyone on this deployment.
          {deploymentBots.length > 0 && ' An administrator manages them on the Admin page.'}
        </p>
        {deploymentBots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">
            This deployment declares no bots.
          </p>
        ) : (
          <div className="grid gap-0.5">
            {deploymentBots.map((bot) => (
              <BotRow key={`deployment:${bot.selection.id}`} bot={bot} modelLabel={modelLabel(bot)} />
            ))}
          </div>
        )}
        <p className="mt-4 text-[12px] leading-4 text-kumo-inactive">
          Need one changed? <Link to="/admin" className="text-kumo-brand hover:underline">Ask an administrator</Link> —
          deployment bots are edited under Admin → Bots.
        </p>
      </section>

      {editor && (editor.mode === 'add' || editDef !== null) && (
        <BotEditorDialog
          key={editor.mode === 'edit' ? `edit:${editor.bot.selection.id}` : 'add'}
          models={models}
          skills={skills}
          initial={editor.mode === 'edit' ? editDef ?? undefined : undefined}
          title={editor.mode === 'add' ? 'New bot' : `Edit ${editor.bot.name}`}
          description="A named agent: instructions, a model, and the skills it may activate."
          busy={busy}
          saveLabel={editor.mode === 'add' ? 'Create bot' : 'Save'}
          onSave={saveEditor}
          onClose={() => { if (!busy) setEditor(null) }}
        />
      )}

      <DeleteConfirmationDialog
        open={deleting !== null}
        title="Delete bot"
        description={deleting
          ? `Delete "${deleting.name}"? Existing chats with it keep their transcript but run as plain model chats.`
          : ''}
        isDeleting={busy}
        onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
