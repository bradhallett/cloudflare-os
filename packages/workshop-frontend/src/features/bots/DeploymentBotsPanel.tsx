// Admin panel for deployment-wide bots: declared once here, offered in every user's chat intake.
// CRUD through AdminApi; each write is followed by a re-read so the list is the server's.

import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AiChatAuthorInfo, BotDefinition, BotSkillChoice } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../../components/WorkshopControls'
import { BotEditorDialog } from './BotEditorDialog'
import { rpcFailureDescription } from '../../rpcErrors'

const CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated p-6'

// A deployment bot's id is its slug: lowercase letters, digits, and inner hyphens.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** What the editor is open for: a new bot (id chosen in the form) or an existing one. */
type EditorSession = { mode: 'add'; id: string } | { mode: 'edit'; id: string; def: BotDefinition }

/**
 * The Bots tab of the admin page. Owns its data: the deployment's bots (AdminApi) plus the models
 * and skills the declaring administrator can pick among (their own account's), since a bot's
 * declaration must name something its users can run.
 */
export const DeploymentBotsPanel = ({ admin }: { admin: RpcStub<AdminApi> }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [bots, setBots] = useState<(BotDefinition & { id: string })[]>([])
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [skills, setSkills] = useState<BotSkillChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // The add flow's chosen id, validated client-side; the server has the final word.
  const [newId, setNewId] = useState('')
  // Whether the add flow has moved past picking an id into the editor itself.
  const [configuring, setConfiguring] = useState(false)
  const [editor, setEditor] = useState<EditorSession | null>(null)
  const [removing, setRemoving] = useState<(BotDefinition & { id: string }) | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    setLoadError(false)
    try {
      setBots(await admin.listDeploymentBots())
    } catch (err) {
      console.error('Failed to load deployment bots:', err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // The pick lists are the declaring admin's own; a failure leaves the editor with none to pick.
    authenticatedApi.listModels()
      .then(setModels)
      .catch((err) => console.error('Failed to load models:', err))
    authenticatedApi.listBotSkills()
      .then(setSkills)
      .catch((err) => console.error('Failed to load bot skills:', err))
  }, [admin, authenticatedApi])

  const reportFailure = (title: string, err: unknown) => {
    console.error(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  const idTaken = (id: string): boolean => bots.some((bot) => bot.id === id)

  const slugError = (id: string): string | undefined => {
    if (id === '') return undefined
    if (!SLUG_PATTERN.test(id)) {
      return 'Lowercase letters, digits, and hyphens; must start and end with a letter or digit.'
    }
    return undefined
  }

  const closeEditor = () => {
    if (busy) return
    setEditor(null)
    setConfiguring(false)
  }

  const saveEditor = async (def: BotDefinition) => {
    if (!editor) return
    setBusy(true)
    try {
      if (editor.mode === 'add') await admin.addDeploymentBot(editor.id, def)
      else await admin.updateDeploymentBot(editor.id, def)
      closeEditor()
      await reload().catch((err) => reportFailure('Saved, but couldn’t reload the bots', err))
    } catch (err) {
      reportFailure(editor.mode === 'add' ? 'Couldn’t add the bot' : 'Couldn’t update the bot', err)
    } finally {
      setBusy(false)
    }
  }

  const confirmRemoval = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await admin.removeDeploymentBot(removing.id)
      setRemoving(null)
      await reload().catch((err) => reportFailure('Removed, but couldn’t reload the bots', err))
    } catch (err) {
      reportFailure(`Couldn’t remove ${removing.name}`, err)
    } finally {
      setBusy(false)
    }
  }

  const modelLabel = (def: BotDefinition): string =>
    models.find((model) => model.id === def.modelId)?.name ?? def.modelId

  // The editor is open for an existing bot, or for a new one once its id passes the client checks.
  const editorOpen = editor !== null
    && (editor.mode === 'edit'
      || (configuring && editor.id !== '' && slugError(editor.id) === undefined && !idTaken(editor.id)))

  return (
    <div className={CARD}>
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Bots</h2>
      <p className="mb-4 text-sm text-kumo-subtle">
        Deployment-wide bots: declared once here, offered in every user’s chat intake beside their
        own. A user’s bot and a deployment bot never collide — they are named by scope.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-kumo-subtle">Loading bots…</p>
      ) : loadError ? (
        <div className="py-6 text-center text-sm">
          <p className="text-kumo-danger">Something went wrong loading the deployment’s bots.</p>
          <button
            onClick={() => { setLoading(true); void reload() }}
            className="text-kumo-brand mt-2 cursor-pointer text-sm underline"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {bots.length === 0 ? (
            <p className="mb-4 rounded-lg border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">
              No deployment bots yet. Add one to offer it to every user.
            </p>
          ) : (
            <ul className="mb-4 grid gap-0.5">
              {bots.map((bot) => (
                <li
                  key={bot.id}
                  className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
                        {bot.name}
                      </span>
                      <span className="shrink-0 truncate font-mono text-[11px] text-kumo-inactive">
                        {bot.id}
                      </span>
                    </div>
                    <span className="mt-0.5 block truncate text-[12px] leading-4 text-kumo-inactive">
                      {[bot.description, modelLabel(bot), `${bot.skills.length} skills`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <WorkshopIconButton
                    aria-label={`Edit ${bot.name}`}
                    title={`Edit ${bot.name}`}
                    disabled={busy}
                    onClick={() => setEditor({ mode: 'edit', id: bot.id, def: bot })}
                    className="!h-8 !w-8 text-kumo-subtle hover:text-kumo-default sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <PencilSimple size={13} />
                  </WorkshopIconButton>
                  <WorkshopIconButton
                    aria-label={`Remove ${bot.name}`}
                    title={`Remove ${bot.name}`}
                    danger
                    disabled={busy}
                    onClick={() => setRemoving(bot)}
                    className="!h-8 !w-8 text-kumo-subtle sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <Trash size={13} />
                  </WorkshopIconButton>
                </li>
              ))}
            </ul>
          )}

          {editor?.mode === 'add' ? (
            <div className="grid gap-2 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
              <label className="grid gap-1.5">
                <span className="text-[13px] font-medium text-kumo-default">Bot id</span>
                <div className="flex items-center gap-2">
                  <WorkshopInput
                    value={newId}
                    disabled={busy || configuring}
                    onChange={(event) => {
                      const next = event.target.value.toLowerCase()
                      setNewId(next)
                      setEditor({ mode: 'add', id: next })
                    }}
                    placeholder="research-assistant"
                    aria-invalid={slugError(newId) !== undefined || idTaken(newId)}
                  />
                  <WorkshopButton
                    tone="primary"
                    className="!h-9 shrink-0"
                    disabled={busy || configuring || newId === '' || slugError(newId) !== undefined || idTaken(newId)}
                    onClick={() => setConfiguring(true)}
                  >
                    <Plus size={13} weight="bold" />
                    Configure
                  </WorkshopButton>
                </div>
                {slugError(newId) ? (
                  <span className="text-[11px] leading-4 text-kumo-danger">{slugError(newId)}</span>
                ) : idTaken(newId) ? (
                  <span className="text-[11px] leading-4 text-kumo-danger">
                    A deployment bot with this id already exists.
                  </span>
                ) : (
                  <span className="text-[11px] leading-4 text-kumo-inactive">
                    Users see the bot’s name; the id is its stable identifier.
                  </span>
                )}
              </label>
            </div>
          ) : (
            <WorkshopButton
              tone="primary"
              className="!h-9"
              disabled={busy}
              onClick={() => {
                setNewId('')
                setConfiguring(false)
                setEditor({ mode: 'add', id: '' })
              }}
            >
              <Plus size={13} weight="bold" />
              Add deployment bot
            </WorkshopButton>
          )}
        </>
      )}

      {editorOpen && editor !== null && (
        <BotEditorDialog
          key={editor.mode === 'edit' ? `edit:${editor.id}` : `add:${editor.id}`}
          models={models}
          skills={skills}
          initial={editor.mode === 'edit' ? editor.def : undefined}
          title={editor.mode === 'edit' ? `Edit ${editor.def.name}` : `New deployment bot “${editor.id}”`}
          description="Offered to every user of this deployment beside their own bots."
          busy={busy}
          saveLabel={editor.mode === 'edit' ? 'Save' : 'Add bot'}
          onSave={saveEditor}
          onClose={closeEditor}
        />
      )}

      <DeleteConfirmationDialog
        open={removing !== null}
        title="Remove deployment bot"
        description={removing
          ? `Remove “${removing.name}”? It disappears from every user’s intake. Existing chats with it keep their transcript but run as plain model chats.`
          : ''}
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isDeleting={busy}
        onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}
        onConfirm={() => void confirmRemoval()}
      />
    </div>
  )
}
