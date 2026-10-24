// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The SaaS commerce surfaces in jsdom: the signup funnel, the checkout return, the org billing
// section, the org switcher, and the upgrade prompt. The suite runs with VITE_SAAS stubbed on
// (what a SaaS build bakes); every RPC surface is a fake stub in RpcContext / the mocked
// AuthContext, so the tests drive the flows the real backend serves. The bundle-level contract
// (OSS builds emit none of this) lives in saasBundle.test.ts; the lazy chunk-load in a real
// browser lives in saasRoute.browser.test.tsx.

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi, OrgSummary } from '@gadgets/workshop-shared/api'

// Kumo is mocked to plain pass-throughs (the repo's dialog-test convention, see
// ObserverConfigModal.test.tsx): no portal, so the surfaces render straight into the container.
vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  return {
    Dialog,
    Button: ({ children, ...props }: ComponentProps<'button'>) => (
      <button type="button" {...props}>{children}</button>
    ),
    Loader: () => <span>Loading</span>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

// The upgrade prompt and org switcher navigate via the router; outside a real router in these
// tests, the hook is a spy.
const navigate = vi.fn<({ to, search }: { to: string; search: Record<string, string> }) => void>()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// The argon2 hash is heavy WASM the funnel only needs in production; the account step just
// needs its output shape.
vi.mock('../../passwordHash', () => ({ hashPassword: async () => new Uint8Array([1]) }))

// The surfaces inside the app's auth read the authenticated API from AuthContext.
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

import { RpcContext } from '../../RpcContext'
import { ServerConfigContext } from '../../ServerConfigContext'
import SaasStart from './SaasStart'
import CheckoutReturn from './CheckoutReturn'
import OrgBillingSettings from './OrgBillingSettings'
import OrgSwitcherMenu from './OrgSwitcherMenu'
import UpgradePromptModal from './UpgradePromptModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

/** Types into a controlled React input the way a real keystroke does. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Ticks the lazy chunk / timers along, as the route suite does, until `predicate` holds.
async function until(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await act(async () => {
      const timer = Promise.withResolvers<void>()
      setTimeout(timer.resolve, 10)
      await timer.promise
    })
  }
}

describe('SaaS commerce surfaces', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const assign = vi.fn<(url: string) => void>()
  const open = vi.fn<(url?: string | URL, target?: string, features?: string) => Window | null>()

  const org = (over: Partial<OrgSummary> = {}): OrgSummary => ({
    id: 'org-1', name: 'Acme', invitePolicy: 'member',
    role: 'owner', status: 'active', ...over,
  })

  // A public stub whose authenticate() answers the funnel's pipelined calls.
  function publicStub(authed: Partial<Record<string, unknown>>): { stub: RpcStub<PublicApi>; api: typeof authed } {
    localStorage.setItem('authToken', 'token-1')
    return {
      api: authed,
      stub: {
        authenticate: vi.fn<() => unknown>().mockReturnValue(authed),
        createAccount: vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('token-1'),
        login: vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('token-1'),
      } as unknown as RpcStub<PublicApi>,
    }
  }

  async function mount(node: ReactNode, stub: RpcStub<PublicApi>, saasEnabled = true): Promise<HTMLDivElement> {
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub, connectionLost: false }}>
          <ServerConfigContext.Provider value={{ saasEnabled } as never}>
            {node}
          </ServerConfigContext.Provider>
        </RpcContext.Provider>,
      )
    })
    return container
  }

  const button = (page: HTMLElement, text: string) =>
    [...page.querySelectorAll('button')].find((b) => b.textContent === text)
      ?? [...page.querySelectorAll('button')].find((b) => b.textContent!.includes(text))

  beforeEach(() => {
    vi.stubEnv('VITE_SAAS', 'true')
    vi.resetModules()
    vi.spyOn(window, 'open').mockImplementation(open)
    // The repo's location-stub convention (gatekeepersRoute.test.tsx): assign is captured, and
    // tests that need a URL stub the whole location again with the parts their surface reads.
    vi.stubGlobal('location', {
      pathname: '/', search: '', hash: '',
      href: 'https://localhost/', origin: 'https://localhost',
      assign, replace: vi.fn<(url: string) => void>(),
    })
    localStorage.clear()
    navigate.mockReset()
    assign.mockReset()
    open.mockReset()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
    window.history.replaceState(null, '', '/')
  })

  describe('the signup funnel (SaasStart)', () => {
    it('walks a fresh visitor account → org → plan → checkout redirect', async () => {
      const authed = {
        whoami: vi.fn<() => Promise<unknown>>().mockResolvedValue({ type: 'user', id: 'user-1', orgs: [] }),
        createOrg: vi.fn<(name: string) => Promise<OrgSummary>>().mockResolvedValue(org()),
        listCommercePlans: vi.fn<() => Promise<{ id: string; name: string }[]>>().mockResolvedValue([
          { id: 'free', name: 'Free' }, { id: 'pro', name: 'Pro' },
        ]),
        startOrgCheckout: vi.fn<(orgId: string, planId: string, seats: number) => Promise<{ url: string }>>().mockResolvedValue({ url: 'https://polar.example/checkout' }),
      }
      const { stub } = publicStub(authed)
      localStorage.removeItem('authToken')  // a fresh visitor has no session
      const page = await mount(<SaasStart />, stub, false)

      // Account step: the visitor creates an account.
      expect(page.querySelector('[data-testid="saas-signup-funnel"]')).not.toBeNull()
      typeInto(page.querySelector('input[placeholder="Username"]') as HTMLInputElement, 'alice')
      typeInto(page.querySelector('input[type="password"]') as HTMLInputElement, 'password123')
      await act(async () => { button(page, 'Create account')!.click() })
      await until(() => page.textContent!.includes('Name your organization'))
      expect(stub.createAccount).toHaveBeenCalled()

      // Org step.
      typeInto(page.querySelector('input[placeholder="Organization name"]') as HTMLInputElement, 'Acme')
      await act(async () => { button(page, 'Create organization')!.click() })
      await until(() => page.textContent!.includes('Pick a plan'))
      expect(authed.createOrg).toHaveBeenCalledWith('Acme')

      // Plan step: the free plan is not offered; picking Pro starts checkout.
      await until(() => button(page, 'Pro') !== undefined)
      await act(async () => { button(page, 'Pro')!.click() })
      await until(() => assign.mock.calls.length > 0)
      expect(authed.startOrgCheckout).toHaveBeenCalledWith('org-1', 'pro', 1)
      expect(assign).toHaveBeenCalledWith('https://polar.example/checkout')
    })
  })

  describe('the checkout return (CheckoutReturn)', () => {
    it('polls until the plan is active, then lands on the org billing tab', async () => {
      vi.stubGlobal('location', {
        pathname: '/saas/checkout/return', search: '?org=org-1', hash: '',
        href: 'https://localhost/saas/checkout/return?org=org-1', origin: 'https://localhost',
        assign, replace: vi.fn<(url: string) => void>(),
      })
      const getOrgBilling = vi.fn<(orgId: string) => Promise<{ plan: string }>>()
        .mockResolvedValueOnce({ plan: 'free' })
        .mockResolvedValueOnce({ plan: 'pro' })
      const { stub } = publicStub({ getOrgBilling })
      const page = await mount(<CheckoutReturn />, stub)

      expect(page.querySelector('[data-testid="saas-checkout-return"]')).not.toBeNull()
      // The second poll fires after the component's 2s interval — keep ticking past it.
      await until(() => assign.mock.calls.length > 0, 300)
      expect(getOrgBilling).toHaveBeenCalledTimes(2)
      expect(assign).toHaveBeenCalledWith('/profile?org=org-1')
    })
  })

  describe('the org billing section (OrgBillingSettings)', () => {
    it('hides when SaaS mode is off or the user is in no org; shows plan, seats, and portal otherwise', async () => {
      const api = {
        listMyOrgs: vi.fn<() => Promise<OrgSummary[]>>().mockResolvedValue([org()]),
        getOrgBilling: vi.fn<(orgId: string) => Promise<Record<string, unknown>>>().mockResolvedValue({
          plan: 'pro', seats: 3, assignedSeats: 2, monthlySpendCapUsd: 100, overageAllowed: true,
          subscriptionStatus: 'active',
          usage: {
            cycleStart: new Date(0), inputTokens: 1000, cacheReadTokens: 50, cacheWriteTokens: 0,
            outputTokens: 200, estimatedCostUsd: 1.25,
          },
        }),
        getOrgMembers: vi.fn<(orgId: string) => Promise<{ userId: string; role: string; status: string }[]>>().mockResolvedValue([
          { userId: 'owner@example.com', role: 'owner', status: 'active' },
          { userId: 'dev@example.com', role: 'member', status: 'active' },
        ]),
        inviteOrgMember: vi.fn<(orgId: string, who: string) => Promise<Record<string, unknown>>>().mockResolvedValue({}),
        removeOrgMember: vi.fn<(orgId: string, userId: string) => Promise<undefined>>().mockResolvedValue(undefined),
        openOrgBillingPortal: vi.fn<(orgId: string) => Promise<{ url: string }>>().mockResolvedValue({ url: 'https://polar.example/portal' }),
        listCommercePlans: vi.fn<() => Promise<{ id: string; name: string }[]>>().mockResolvedValue([]),
        startOrgCheckout: vi.fn<(orgId: string, planId: string, seats: number) => void>(),
      }
      authState.api = api as unknown as RpcStub<AuthenticatedApi>
      const stub = {} as RpcStub<PublicApi>

      // Off: hidden entirely (the hide-when-off contract).
      let page = await mount(<OrgBillingSettings />, stub, false)
      await settle()
      expect(page.querySelector('[data-testid="saas-org-settings"]')).toBeNull()

      // On: the full section.
      page = await mount(<OrgBillingSettings />, stub)
      await until(() => page.textContent!.includes('Pro plan'))
      expect(page.querySelector('[data-testid="saas-org-settings"]')).not.toBeNull()
      expect(page.textContent!).toContain('2 of 3 licensed seats')
      expect(page.textContent!).toContain('dev@example.com')

      // Invite claims a seat immediately (the org membership push does; here, the RPC).
      typeInto(page.querySelector('input[placeholder="Email or username to invite"]') as HTMLInputElement, 'new@example.com')
      await act(async () => { button(page, 'Invite')!.click() })
      await settle()
      expect(api.inviteOrgMember).toHaveBeenCalledWith('org-1', 'new@example.com')

      // The portal opens in a new window.
      await act(async () => { button(page, 'Billing portal')!.click() })
      await settle()
      expect(api.openOrgBillingPortal).toHaveBeenCalledWith('org-1')
      expect(open).toHaveBeenCalledWith('https://polar.example/portal', '_blank', 'noopener')
    })
  })

  describe('the org switcher (OrgSwitcherMenu)', () => {
    it('lists orgs and navigates to the picked org billing tab', async () => {
      authState.api = {
        listMyOrgs: vi.fn<() => Promise<OrgSummary[]>>().mockResolvedValue([org(), org({ id: 'org-2', name: 'Globex' })]),
      } as unknown as RpcStub<AuthenticatedApi>
      const page = await mount(<OrgSwitcherMenu />, {} as RpcStub<PublicApi>)
      await until(() => page.querySelectorAll('[data-testid="saas-org-switcher"]').length === 2)
      await act(async () => {
        (page.querySelectorAll('[data-testid="saas-org-switcher"]')[1] as HTMLButtonElement).click()
      })
      expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { org: 'org-2' } })
    })
  })

  describe('the upgrade prompt (UpgradePromptModal)', () => {
    it('offers the upgrade and routes an org admin to their billing tab', async () => {
      authState.api = {
        whoami: vi.fn<() => Promise<unknown>>().mockResolvedValue({
          type: 'user', id: 'user-1', orgs: [{ orgId: 'org-1', role: 'owner', status: 'active' }],
        }),
      } as unknown as RpcStub<AuthenticatedApi>
      const page = await mount(
        <UpgradePromptModal open onClose={() => {}} reason="usage_limit" />, {} as RpcStub<PublicApi>)
      await until(() => button(page, 'Upgrade plan') !== undefined)
      expect(page.querySelector('[data-testid="saas-upgrade-prompt"]')).not.toBeNull()
      await act(async () => { button(page, 'Upgrade plan')!.click() })
      expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { org: 'org-1' } })
    })

    it('sends an org-less user to the signup funnel', async () => {
      authState.api = {
        whoami: vi.fn<() => Promise<unknown>>().mockResolvedValue({ type: 'user', id: 'user-1', orgs: [] }),
      } as unknown as RpcStub<AuthenticatedApi>
      const page = await mount(
        <UpgradePromptModal open onClose={() => {}} reason="MODEL_NOT_ON_PLAN" />, {} as RpcStub<PublicApi>)
      await until(() => page.textContent!.includes("isn't available on your plan"))
      await act(async () => { button(page, 'Upgrade plan')!.click() })
      expect(assign).toHaveBeenCalledWith('/saas/start')
    })
  })
})
