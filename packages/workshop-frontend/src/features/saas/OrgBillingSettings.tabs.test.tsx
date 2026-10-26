// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The org billing switcher against a real TanStack router (a memory history), through the real
// /profile route: switching the ?org= search parameter — what an org button, the org switcher,
// and the upgrade prompt all do — must switch the panel to that org. A search-only navigation
// re-renders without remounting the route, which is exactly the condition that once left the
// panel stuck on the first org: selection is derived from the live search, never seeded at
// mount.

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OrgSummary } from '@gadgets/workshop-shared/api'
import { Route as ProfileRouteImport } from '../../routes/profile'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's scroll restoration calls it on navigation.
window.scrollTo = () => {}

// Kumo is mocked to plain pass-throughs (the repo's dialog-test convention): no portal, so the
// surfaces render straight into the container.
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

// The heavyweight settings page is not under test; the profile route still runs, forwarding
// its org search parameter to the section that is. OrgBillingSettings must load inside the
// factory: vi.mock hoists above static imports, so a static import here would be undefined.
vi.mock('../../SettingsPage', async () => {
  const { default: OrgBillingSettings } = await import('./OrgBillingSettings')
  return {
    default: ({ org }: { org?: string }) => <OrgBillingSettings org={org} />,
  }
})

const authState = vi.hoisted(() => ({
  api: null as unknown as RpcStub<AuthenticatedApi>,
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: authState.api,
    logout: vi.fn<() => void>(),
    currentUser: { id: 'user-1', name: 'owner', type: 'user' },
    isCurrentUserConfirmed: true,
    isAdmin: false,
  }),
}))

import { ServerConfigContext } from '../../ServerConfigContext'

const org = (id: string, name: string): OrgSummary =>
  ({ id, name, role: 'owner', status: 'active', invitePolicy: 'member' }) as OrgSummary

async function until(assert: () => void, ms = 2000) {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await act(async () => { await Promise.resolve() })
      assert()
      return
    } catch (err) {
      last = err
    }
  }
  throw last
}

describe('the org billing tabs follow the ?org= search parameter', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  async function renderAt(entry: string): Promise<HTMLDivElement> {
    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const profileRoute = ProfileRouteImport.update({
      id: '/profile',
      path: '/profile',
      getParentRoute: () => rootRoute,
    } as never)
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [entry] }),
      routeTree: rootRoute.addChildren([profileRoute]),
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={{ saasEnabled: true } as never}>
        <RouterProvider router={router} />
      </ServerConfigContext.Provider>,
    ))
    return container
  }

  beforeEach(() => {
    // A two-org owner: each org's billing overview differs, so the panel's fetch proves which
    // org is selected.
    const getOrgBilling = vi.fn<(orgId: string) => Promise<Record<string, unknown>>>()
      .mockImplementation(async (orgId) => ({
        plan: orgId === 'org-1' ? 'pro' : 'team', seats: 3, assignedSeats: 1,
        subscriptionStatus: 'active', monthlySpendCapUsd: 100, overageAllowed: false,
        usage: null,
      }))
    authState.api = {
      listMyOrgs: vi.fn<() => Promise<OrgSummary[]>>()
        .mockResolvedValue([org('org-1', 'Acme'), org('org-2', 'Globex')]),
      getOrgBilling,
      getOrgMembers: vi.fn<(orgId: string) => Promise<unknown[]>>().mockResolvedValue([]),
    } as unknown as RpcStub<AuthenticatedApi>
  })

  it('clicking the second org fetches and shows that org', async () => {
    const page = await renderAt('/profile')
    await until(() => expect(page.textContent).toContain('Pro plan'))

    const orgButton = (name: string) =>
      [...page.querySelectorAll('button')].find((b) => b.textContent === name)!
    expect(orgButton('Acme')).toBeDefined()
    expect(orgButton('Globex')).toBeDefined()

    await act(async () => orgButton('Globex').click())

    // The panel follows the search parameter: org-2's billing is fetched and shown.
    await until(() => expect(page.textContent).toContain('Team plan'))
    expect(authState.api.getOrgBilling).toHaveBeenLastCalledWith('org-2')
  })

  it('a deep link with ?org= opens straight on that org', async () => {
    const page = await renderAt('/profile?org=org-2')
    await until(() => expect(page.textContent).toContain('Team plan'))
    expect(authState.api.getOrgBilling).toHaveBeenCalledWith('org-2')
    expect([...page.querySelectorAll('button')].filter((b) => b.textContent === 'Globex')).toHaveLength(1)
  })

  it('an upgrade opened on one org does not bill that org after switching tabs', async () => {
    // org-1 is on the free plan, so its panel offers the Upgrade button; org-2 is paid.
    const getOrgBilling = vi.fn<(orgId: string) => Promise<Record<string, unknown>>>()
      .mockImplementation(async (orgId) => ({
        plan: orgId === 'org-1' ? 'free' : 'team', seats: 3, assignedSeats: 1,
        subscriptionStatus: orgId === 'org-1' ? null : 'active', monthlySpendCapUsd: 100,
        overageAllowed: false, usage: null,
      }))
    authState.api = {
      listMyOrgs: vi.fn<() => Promise<OrgSummary[]>>()
        .mockResolvedValue([org('org-1', 'Acme'), org('org-2', 'Globex')]),
      getOrgBilling,
      getOrgMembers: vi.fn<(orgId: string) => Promise<unknown[]>>().mockResolvedValue([]),
      listCommercePlans: vi.fn<() => Promise<unknown[]>>()
        .mockResolvedValue([{ id: 'pro-plan', name: 'Pro' }]),
    } as unknown as RpcStub<AuthenticatedApi>

    const page = await renderAt('/profile')
    await until(() => expect(page.textContent).toContain('Free plan'))

    const upgrade = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Upgrade')!
    await act(async () => upgrade.click())
    await until(() => expect(page.textContent).toContain('Upgrade Acme'))

    // Switching tabs must hide the upgrade block entirely: it belongs to the org it
    // upgrades, so it can never offer org-1's checkout under org-2's name.
    const globex = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Globex')!
    await act(async () => globex.click())
    await until(() => expect(page.textContent).toContain('Team plan'))
    expect(page.textContent).not.toContain('Upgrade Acme')
    expect(page.textContent).not.toContain('Upgrade Globex')
  })
})
