import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Tabs, Loader } from '@cloudflare/kumo'
import { PendingSwitch } from '@gadgets/ui'
import '@gadgets/ui/pending-switch.css'
import { ShieldWarning } from '@phosphor-icons/react'
import { useAuthenticatedApi } from './AuthContext'
import { AdminApi, AdminFormat, AdminResourceVendor, AdminSettingsView, AmbientGatekeeperMode, BannerColor, DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { useDocumentTitle } from './useDocumentTitle'
import AdminFormatsPanel from './components/format/AdminFormatsPanel'
import { AdminModelsPanel } from './features/ai-models/AdminModelsPanel'
import { AdminComposioPanel } from './features/composio/AdminComposioPanel'
import { AdminUpdatesPanel } from './features/deployment-updates/AdminUpdatesPanel'
import { DeploymentBotsPanel } from './features/bots/DeploymentBotsPanel'
import { latestReads } from './features/deployment-updates/latestReads'
import { probeRouterTag } from './features/deployment-updates/probeRouterTag'
import { isAdminTab, resolveAdminTab } from './adminTab'
import { logRpcFailure } from './rpcErrors'
import { useReportRpcFailure } from './useReportRpcFailure'
import { SiteNamePanel } from './features/admin-settings/SiteNamePanel'
import { SiteLogoPanel } from './features/admin-settings/SiteLogoPanel'
import { ThemePanel } from './features/admin-settings/ThemePanel'
import { BannerPanel } from './features/admin-settings/BannerPanel'
import { AnnouncementPanel } from './features/admin-settings/AnnouncementPanel'
import { InstructionsPanel } from './features/admin-settings/InstructionsPanel'
import { AccessPanel } from './features/admin-settings/AccessPanel'

// The General- and Access-tab settings, as the server last reported them. Their drafts live in
// the panels, which report every value the server takes back through here.
type GeneralSettings = {
  siteName: string
  siteLogoUrl: string | null
  accentColor: string
  banner: { text: string; color: BannerColor }
  announcement: string
  instructions: string
  signupsEnabled: boolean
  userSearchEnabled: boolean
}

export default function AdminPage() {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const reportRpcFailure = useReportRpcFailure()
  useDocumentTitle('Admin')

  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [general, setGeneral] = useState<GeneralSettings | null>(null)

  // Gatekeeper vendor/resource state, as the server last reported it (see the Gatekeepers tab).
  const [resourceVendors, setResourceVendors] = useState<AdminResourceVendor[]>([])
  const [resourceBusy, setResourceBusy] = useState<Set<string>>(new Set())

  // Composio's per-toolkit policy, offered only where the connector is installed.
  const [composioExcluded, setComposioExcluded] = useState<string[]>([])
  const [composioAutoApply, setComposioAutoApply] = useState<string[]>([])

  // The update status of a deployment the deploy flow installed, null for any other deployment.
  // Loaded beside the settings but never holding them up, so it may still be pending.
  const [updateStatus, setUpdateStatus] = useState<DeploymentUpdateStatus | null | 'pending'>('pending')
  // Only the latest re-read applies, and a setting whose re-read a later one replaced is shown as
  // saved only once that later one has applied.
  const [reloadUpdateStatus] = useState(() => latestReads<DeploymentUpdateStatus | null>(setUpdateStatus))

  // The tab lives in the URL so the notice can link to one; changing it replaces the history entry
  // on the same route, which keeps this component and its drafts.
  const navigate = useNavigate()
  const activeTab = resolveAdminTab(useSearch({ from: '/admin' }).tab, {
    updatesAvailable: updateStatus === 'pending' ? 'pending' : updateStatus !== null,
  })
  const handleTabChange = (tab: string) => {
    if (isAdminTab(tab)) void navigate({ to: '/admin', search: { tab }, replace: true })
  }

  // Promoted output formats, in menu order (see AdminFormatsPanel).
  const [formats, setFormats] = useState<AdminFormat[]>([])

  // The models the deployment provides through AI Gateway; absent outside AI Gateway mode (see
  // AdminModelsPanel).
  const [gatewayModels, setGatewayModels] = useState<AdminSettingsView['gatewayModels']>(undefined)
  // Re-reads can overlap, since leaving the Models tab drops the panel's in-flight state, and an
  // earlier one answering last must not replace what a later one showed.
  const gatewayModelsRead = useRef(0)

  const resourceKey = (vendorId: string, urlPattern: string) => `${vendorId}\u0000${urlPattern}`

  // Populate all editor state from a freshly-fetched settings view.
  const applySettings = (view: Awaited<ReturnType<RpcStub<AdminApi>['getSettings']>>) => {
    setGeneral({
      siteName: view.siteName,
      siteLogoUrl: view.siteLogo?.url ?? null,
      accentColor: view.accentColor,
      banner: view.banner,
      announcement: view.announcement,
      instructions: view.instanceInstructions,
      signupsEnabled: view.signupsEnabled,
      userSearchEnabled: view.userSearchEnabled,
    })
    setResourceVendors(view.resourceVendors)
    setComposioExcluded(view.vendorAdminPolicy.composio?.excludedToolkits ?? [])
    setComposioAutoApply(view.vendorAdminPolicy.composio?.autoApplyToolkits ?? [])
    setFormats(view.formats)
    setGatewayModels(view.gatewayModels)
  }

  // Mint the admin capability once (the access check happens server-side) and load settings.
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        // A backend older than the update check rejects this as an unknown method mid-rollout; any
        // failure means no Updates tab rather than a page that fails to load.
        probeRouterTag().then(() => api.getUpdateStatus()).then(
          (status) => { if (!cancelled) setUpdateStatus(status) },
          (err) => {
            if (cancelled) return
            logRpcFailure('Failed to read the deployment update status:', err)
            setUpdateStatus(null)
          },
        )
        applySettings(await api.getSettings())
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load admin settings:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi])

  // Re-fetch just the gatekeeper/resource state (used to revert an optimistic toggle on error).
  // Leaves the General-tab drafts untouched.
  const reloadResources = async () => {
    if (!admin) return
    const view = await admin.api.getSettings()
    setResourceVendors(view.resourceVendors)
  }

  // The gatekeeper/resource toggles commit only once their write goes through: the PendingSwitch
  // shows the new value optimistically while the write is in flight and falls back to the state
  // here, which stays what the server last reported. `resourceBusy` still guards the row-header
  // and mode-button paths, which have no switch of their own.
  const handleResourceToggle = async (vendorId: string, urlPattern: string, enabled: boolean) => {
    if (!admin) return
    const key = resourceKey(vendorId, urlPattern)
    setResourceBusy((prev) => new Set(prev).add(key))
    try {
      await admin.api.setResourceEnabled(vendorId, urlPattern, enabled)
      setResourceVendors((prev) =>
        prev.map((v) =>
          v.vendorId !== vendorId || v.autoProvisions
            ? v
            : { ...v, resources: v.resources.map((r) => (r.urlPattern === urlPattern ? { ...r, enabled } : r)) }
        )
      )
    } catch (err) {
      reportRpcFailure('Failed to update the gatekeeper resource', err)
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperToggle = async (vendorId: string, enabled: boolean) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    try {
      await admin.api.setGatekeeperMode(vendorId, enabled ? 'enabled' : 'disabled')
      setResourceVendors((prev) =>
        prev.map((v) => (v.vendorId === vendorId && !v.autoProvisions ? { ...v, enabled } : v))
      )
    } catch (err) {
      reportRpcFailure('Failed to update the gatekeeper', err)
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperMode = async (vendorId: string, mode: AmbientGatekeeperMode) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    setResourceVendors((prev) =>
      prev.map((v) => (v.vendorId === vendorId && v.autoProvisions ? { ...v, ambientMode: mode } : v))
    )
    try {
      await admin.api.setGatekeeperMode(vendorId, mode)
    } catch (err) {
      reportRpcFailure('Failed to update the gatekeeper', err)
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">You don't have access to this page.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading admin settings...</p>
      </div>
    )
  }

  if (loadError || !admin || !general) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">Something went wrong loading admin settings.</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">Admin</h1>
        <p className="text-sm text-kumo-subtle mt-1">
          Deployment-wide settings. Changes apply to all users on their next connection.
        </p>
      </div>

      <Tabs
        variant="underline"
        value={activeTab}
        onValueChange={handleTabChange}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'gatekeepers', label: 'Gatekeepers' },
          { value: 'formats', label: 'Formats' },
          { value: 'models', label: 'Models' },
          { value: 'bots', label: 'Bots' },
          { value: 'access', label: 'Access' },
          // Also listed while a requested Updates tab waits for the status, so it shows as selected.
          ...(activeTab === 'updates' || (updateStatus !== null && updateStatus !== 'pending')
            ? [{ value: 'updates', label: 'Updates' }]
            : []),
        ]}
      />

      {/* Deploy-flow updates */}
      {activeTab === 'updates' && (
        updateStatus === 'pending' || updateStatus === null
          ? (
            <div className="flex justify-center py-16">
              <Loader size="lg" />
            </div>
          )
          : (
            <AdminUpdatesPanel
              admin={admin.api}
              status={updateStatus}
              onChanged={() => reloadUpdateStatus(() => admin.api.getUpdateStatus())}
            />
          )
      )}

      {/* Standard output formats */}
      {activeTab === 'formats' && (
        <AdminFormatsPanel
          admin={admin.api}
          formats={formats}
          onChanged={async () => { setFormats((await admin.api.getSettings()).formats) }}
        />
      )}
      {/* Deployment-wide bots */}
      {activeTab === 'bots' && <DeploymentBotsPanel admin={admin.api} />}

      {/* AI Gateway models */}
      {activeTab === 'models' && (
        <AdminModelsPanel
          admin={admin.api}
          gatewayModels={gatewayModels}
          onChanged={async () => {
            const read = ++gatewayModelsRead.current
            const view = await admin.api.getSettings()
            if (read === gatewayModelsRead.current) setGatewayModels(view.gatewayModels)
          }}
        />
      )}

      {/* Sign-ups and user search */}
      {activeTab === 'access' && (
        <AccessPanel
          admin={admin.api}
          signupsEnabled={general.signupsEnabled}
          userSearchEnabled={general.userSearchEnabled}
          onChanged={(which, enabled) =>
            setGeneral((prev) => prev && { ...prev, [which === 'signups' ? 'signupsEnabled' : 'userSearchEnabled']: enabled })}
        />
      )}

      {/* General tab: one card per deployment-wide setting. */}
      {activeTab === 'general' && (
        <>
          <SiteNamePanel
            admin={admin.api}
            siteName={general.siteName}
            onSaved={(siteName) => setGeneral((prev) => prev && { ...prev, siteName })}
          />
          <SiteLogoPanel
            admin={admin.api}
            siteLogoUrl={general.siteLogoUrl}
            onSaved={(siteLogoUrl) => setGeneral((prev) => prev && { ...prev, siteLogoUrl })}
          />
          <ThemePanel
            admin={admin.api}
            accentColor={general.accentColor}
            onSaved={(accentColor) => setGeneral((prev) => prev && { ...prev, accentColor })}
          />
          <BannerPanel
            admin={admin.api}
            banner={general.banner}
            onSaved={(banner) => setGeneral((prev) => prev && { ...prev, banner })}
          />
          <AnnouncementPanel
            admin={admin.api}
            announcement={general.announcement}
            onSaved={(announcement) => setGeneral((prev) => prev && { ...prev, announcement })}
          />
          <InstructionsPanel
            admin={admin.api}
            instructions={general.instructions}
            onSaved={(instructions) => setGeneral((prev) => prev && { ...prev, instructions })}
          />
        </>
      )}

      {/* Gatekeeper resources */}
      {activeTab === 'gatekeepers' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Gatekeepers</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Turn connectors and resource types on or off for each service. Auto-provisioned
            gatekeepers (like the Context Library) have three modes &mdash; disabled, optional, or
            enabled for everyone. Changes are soft: they don&rsquo;t revoke access a gadget already
            holds.
          </p>

          {resourceVendors.length === 0 && (
            <p className="text-sm text-kumo-subtle">
              No configurable gatekeepers are installed on this deployment.
            </p>
          )}

          <div className="space-y-6">
            {resourceVendors.map((vendor) => {
              const gkKey = `gk\u0000${vendor.vendorId}`

              // Auto-provisioned ("ambient") gatekeepers use a three-state mode and have no resources.
              if (vendor.autoProvisions) {
                const mode = vendor.ambientMode ?? 'optional'
                const options: { value: AmbientGatekeeperMode; label: string; hint: string }[] = [
                  { value: 'disabled', label: 'Disabled', hint: 'Off for everyone' },
                  { value: 'optional', label: 'Optional', hint: 'Users can add it themselves' },
                  { value: 'enabled', label: 'Enabled', hint: 'On for everyone automatically' },
                ]
                return (
                  <div key={vendor.vendorId}>
                    <div className="flex items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50">
                      {vendor.logo && (
                        <img
                          src={vendor.logo.url}
                          alt=""
                          className={`w-5 h-5 object-contain transition-[filter,opacity] ${mode === 'disabled' ? 'grayscale opacity-40' : ''}`}
                        />
                      )}
                      <h3 className={`flex-1 text-sm font-semibold ${mode === 'disabled' ? 'text-kumo-subtle' : 'text-kumo-default'}`}>
                        {vendor.displayName}
                      </h3>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        auto-provisioned
                      </span>
                    </div>
                    <div className="flex gap-2 px-3 py-1">
                      {options.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={resourceBusy.has(gkKey)}
                          onClick={() => handleGatekeeperMode(vendor.vendorId, opt.value)}
                          className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                            mode === opt.value
                              ? 'border-kumo-brand bg-kumo-brand/10'
                              : 'border-kumo-line hover:bg-kumo-tint'
                          }`}
                        >
                          <span className="block text-sm font-medium text-kumo-default">{opt.label}</span>
                          <span className="block text-xs text-kumo-subtle mt-0.5">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }

              return (
              <div key={vendor.vendorId}>
                {/* The whole header row is a toggle target; the Switch stops propagation so it
                    doesn't double-fire. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !resourceBusy.has(gkKey) && handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)}
                  onKeyDown={(e) => {
                    if (e.currentTarget !== e.target) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (!resourceBusy.has(gkKey)) handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)
                    }
                  }}
                  className="flex cursor-pointer items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50 hover:bg-kumo-tint transition-colors"
                >
                  {vendor.logo && (
                    <img
                      src={vendor.logo.url}
                      alt=""
                      className={`w-5 h-5 object-contain transition-[filter,opacity] ${vendor.enabled ? '' : 'grayscale opacity-40'}`}
                    />
                  )}
                  <h3 className={`flex-1 text-sm font-semibold ${vendor.enabled ? 'text-kumo-default' : 'text-kumo-subtle'}`}>
                    {vendor.displayName}
                    {!vendor.enabled && (
                      <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        disabled
                      </span>
                    )}
                  </h3>
                  <span className="text-xs text-kumo-subtle">
                    {vendor.enabled ? 'Enabled' : 'Off'}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <PendingSwitch
                      checked={vendor.enabled}
                      onChange={(enabled) => handleGatekeeperToggle(vendor.vendorId, enabled)}
                    />
                  </span>
                </div>
                {/* Resources are hidden while the gatekeeper is disabled — they can't be used
                    until it's re-enabled. */}
                {vendor.enabled ? (
                  <div className="space-y-1">
                    {vendor.resources.map((resource) => {
                      const key = resourceKey(vendor.vendorId, resource.urlPattern)
                      return (
                        <div
                          key={resource.urlPattern}
                          role="button"
                          tabIndex={0}
                          onClick={() => !resourceBusy.has(key) && handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)}
                          onKeyDown={(e) => {
                            if (e.currentTarget !== e.target) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              if (!resourceBusy.has(key)) handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)
                            }
                          }}
                          className="flex cursor-pointer items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {resource.title}
                            </p>
                            <p className="text-xs text-kumo-subtle mt-0.5">{resource.description}</p>
                          </div>
                          <span onClick={(e) => e.stopPropagation()}>
                            <PendingSwitch
                              checked={resource.enabled}
                              onChange={(enabled) =>
                                handleResourceToggle(vendor.vendorId, resource.urlPattern, enabled)
                              }
                            />
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-kumo-subtle px-3 py-1">
                    {vendor.resources.length} resource{vendor.resources.length === 1 ? '' : 's'} hidden while disabled.
                  </p>
                )}
              </div>
            )})}
          </div>
        </div>
      )}

      {/* Composio's per-toolkit policy, offered only where the connector is installed. */}
      {activeTab === 'gatekeepers' && resourceVendors.some((v) => v.vendorId === 'composio') && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">Composio toolkits</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            Choose which of Composio&rsquo;s toolkits this deployment offers. Slugs must match
            Composio&rsquo;s exactly; entries are checked against its live catalog below.
          </p>
          <AdminComposioPanel
            admin={admin.api}
            excludedToolkits={composioExcluded}
            autoApplyToolkits={composioAutoApply}
            onSaved={(which, slugs) =>
              which === 'excluded' ? setComposioExcluded(slugs) : setComposioAutoApply(slugs)}
          />
        </div>
      )}
    </div>
  )
}
