import { useEffect, useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Warning } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ComposioToolkitInfo } from '@gadgets/workshop-shared/gatekeeper'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { WorkshopInputArea } from '../../components/WorkshopControls'
import { rpcFailureDescription } from '../../rpcErrors'

type AdminComposioPanelProps = {
  admin: RpcStub<AdminApi>
  /** The saved lists, as the server last reported them. */
  excludedToolkits: string[]
  autoApplyToolkits: string[]
  /** Apply a list the server took, so the panel and the page agree on what is saved. */
  onSaved: (which: 'excluded' | 'autoApply', slugs: string[]) => void
}

// One slug per line; the same trim/dedupe the server's normalization applies, so what is shown
// as saved matches what the server kept.
const parseSlugs = (text: string): string[] => [
  ...new Set(text.split('\n').map((line) => line.trim()).filter((line) => line !== '')),
]

type Validation = 'unavailable' | Map<string, ComposioToolkitInfo>

/**
 * One editable list of Composio toolkit slugs: a textarea of one-slug-per-line drafts, live
 * validation of each slug against the vendor's catalog, and the save button for its AdminApi
 * setter. Shared by the excluded and auto-apply lists, which edit the same kind of value.
 */
const ComposioToolkitList = ({
  title,
  description,
  saved,
  draft,
  onDraftChange,
  infoBySlug,
  infoPending,
  hiddenSlugs,
  onSave,
  saving,
}: {
  title: string
  description: string
  saved: string[]
  /** The list's edited text (one slug per line); owned by the parent, which validates it live. */
  draft: string
  onDraftChange: (draft: string) => void
  infoBySlug: Validation
  infoPending: boolean
  onSave: (slugs: string[]) => void
  /** Slugs also on the hidden list, whose precedence makes this listing inert. */
  hiddenSlugs?: ReadonlySet<string>
  saving: boolean
}) => {
  const slugs = parseSlugs(draft)

  return (
    <div>
      <h3 className="text-sm font-semibold text-kumo-default">{title}</h3>
      <p className="text-xs text-kumo-subtle mt-1 mb-2">{description}</p>
      <WorkshopInputArea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        spellCheck={false}
        aria-label={title}
        placeholder="one toolkit slug per line, e.g. gmail"
        className="w-full font-mono"
      />
      {slugs.length > 0 && (
        <ul className="mt-2 space-y-1" aria-live="polite">
          {slugs.map((slug) => {
            const info = infoBySlug instanceof Map ? infoBySlug.get(slug) : undefined
            return (
              <li key={slug} className="flex items-baseline gap-2 text-xs text-kumo-subtle">
                <span className="font-mono text-kumo-default">{slug}</span>
                {infoBySlug === 'unavailable' ? (
                  <span>cannot be checked — the Composio connector isn&rsquo;t installed</span>
                ) : !info ? (
                  <span>{infoPending ? 'checking…' : ''}</span>
                ) : !info.exists ? (
                  <span className="inline-flex items-center gap-1 text-kumo-warning">
                    <Warning size={12} weight="fill" aria-hidden />
                    matches no toolkit in Composio&rsquo;s catalog
                  </span>
                ) : (
                  <span>
                    {info.eligibleToolCount} tool{info.eligibleToolCount === 1 ? '' : 's'} eligible
                    for auto-apply, {info.destructiveToolCount} destructive
                  </span>
                )}
                {hiddenSlugs?.has(slug) && (
                  <span className="inline-flex items-center gap-1 text-kumo-warning">
                    <Warning size={12} weight="fill" aria-hidden />
                    also hidden — hiding wins, so this listing has no effect
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="mt-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={saving}
          disabled={draft === saved.join('\n')}
          onClick={() => onSave(slugs)}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

/** The Composio section of the admin Gatekeepers tab: the two toolkit policy lists. */
export const AdminComposioPanel = ({
  admin,
  excludedToolkits,
  autoApplyToolkits,
  onSaved,
}: AdminComposioPanelProps) => {
  const toasts = useKumoToastManager()
  const [saving, setSaving] = useState<'excluded' | 'autoApply' | null>(null)
  // The two lists' draft texts, owned here so the debounced catalog check below reads what is
  // being typed. Seeded once at mount (the admin page mounts this panel only after its settings
  // read) and re-canonicalized in save() when the server takes a list.
  const [excludedDraft, setExcludedDraft] = useState(excludedToolkits.join('\n'))
  const [autoApplyDraft, setAutoApplyDraft] = useState(autoApplyToolkits.join('\n'))
  // Live catalog answers for the union of both lists' drafts: null while the first check is out,
  // 'unavailable' when the connector isn't bound so slugs cannot be validated.
  const [info, setInfo] = useState<Validation | null>(null)
  // Hiding wins over auto-apply, so a slug on both drafts renders its auto-apply listing inert.
  const crossListed = new Set(
    parseSlugs(excludedDraft).filter((slug) => parseSlugs(autoApplyDraft).includes(slug)),
  )

  useEffect(() => {
    const slugs = [...new Set([...parseSlugs(excludedDraft), ...parseSlugs(autoApplyDraft)])]
    if (slugs.length === 0) {
      setInfo(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      admin.getComposioToolkitInfo(slugs).then(
        (result) => { if (!cancelled) setInfo(result ? new Map(result.map((i) => [i.slug, i])) : 'unavailable') },
        (err) => {
          if (cancelled) return
          setInfo('unavailable')
          toasts.add({ title: rpcFailureDescription(err) ?? 'Failed to check Composio toolkits.', variant: 'error' })
        },
      )
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [admin, excludedDraft, autoApplyDraft, toasts])

  const save = async (which: 'excluded' | 'autoApply', slugs: string[]) => {
    setSaving(which)
    try {
      const setter = which === 'excluded'
        ? admin.setComposioExcludedToolkits
        : admin.setComposioAutoApplyToolkits
      await setter(slugs)
      // Canonicalize the draft to what the server kept, matching the seed above.
      if (which === 'excluded') setExcludedDraft(slugs.join('\n'))
      else setAutoApplyDraft(slugs.join('\n'))
      onSaved(which, slugs)
    } catch (err) {
      toasts.add({ title: rpcFailureDescription(err) ?? 'Update failed', variant: 'error' })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-6">
      <ComposioToolkitList
        title="Hidden toolkits"
        description="Composio toolkits this deployment hides from every surface: connecting, the agent catalog, and toolkit facets. Slugs must match Composio's exactly. Hiding wins: a toolkit on both lists is treated as hidden everywhere."
        saved={excludedToolkits}
        draft={excludedDraft}
        onDraftChange={setExcludedDraft}
        infoBySlug={info ?? new Map()}
        infoPending={info === null}
        onSave={(slugs) => void save('excluded', slugs)}
        saving={saving === 'excluded'}
      />
      <ComposioToolkitList
        title="Auto-apply-eligible toolkits"
        description="Toolkits whose create/update-tagged write tools users may arm for auto-apply on the connections page. Listing a toolkit vouches for all current and future eligible write tools in it. Hiding a toolkit is enforced everywhere immediately; unlisting affects only new bindings — a facet already armed keeps auto-applying new writes until its binding is re-minted."
        hiddenSlugs={crossListed}
        saved={autoApplyToolkits}
        draft={autoApplyDraft}
        onDraftChange={setAutoApplyDraft}
        infoBySlug={info ?? new Map()}
        infoPending={info === null}
        onSave={(slugs) => void save('autoApply', slugs)}
        saving={saving === 'autoApply'}
      />
    </div>
  )
}
