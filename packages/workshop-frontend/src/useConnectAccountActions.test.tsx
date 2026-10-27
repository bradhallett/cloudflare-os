// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AuthenticatedApi, ConnectFlowStart } from '@gadgets/workshop-shared/api'
import type { AccountDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastAdd = vi.fn<(toast: unknown) => string>()

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: toastAdd }),
}))

import {
  mergeGrantedPatterns,
  useConnectAccountActions,
} from './useConnectAccountActions'
import { AuthPopupCancelledError } from './features/native-app/authPopup'

// The flow a connect / ensure-resources fake starts: the URL to open and the nonce the popup carries.
const FLOW: ConnectFlowStart = { url: 'https://accounts.google.test/oauth', nonce: 'a'.repeat(64) }

type Probe = ReturnType<typeof useConnectAccountActions>

let root: Root | null = null
let container: HTMLElement | null = null
let probe: Probe | null = null
let consoleError: Mock<(...args: unknown[]) => void>

function ProbeComponent({ api }: { api: AuthenticatedApi | null }) {
  probe = useConnectAccountActions(api)
  return null as unknown as ReactNode
}

function renderProbe(api: AuthenticatedApi | null) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<ProbeComponent api={api} />) })
}

// The popup openConnectWindow gets back: opened blank, given the nonce, then navigated to the URL.
function mockConnectPopup() {
  const popup = {
    close() {},
    opener: window as Window | null,
    sessionStorage: { setItem: vi.fn<(k: string, v: string) => void>(), removeItem: vi.fn<(k: string) => void>() },
    location: { replace: vi.fn<(url: string) => void>() },
  }
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window)
  return popup
}

function fakeApi(overrides: Partial<Record<'connectAccount' | 'ensureAccountResources' | 'reconnectAccount' | 'provisionAmbientAccount', Mock>>): AuthenticatedApi {
  return {
    connectAccount: overrides.connectAccount ?? vi.fn<() => Promise<typeof FLOW>>(async () => FLOW),
    ensureAccountResources: overrides.ensureAccountResources ?? vi.fn<() => Promise<typeof FLOW>>(async () => FLOW),
    reconnectAccount: overrides.reconnectAccount ?? vi.fn<() => Promise<typeof FLOW>>(async () => FLOW),
    provisionAmbientAccount: overrides.provisionAmbientAccount ?? vi.fn<() => Promise<void>>(async () => {}),
  } as unknown as AuthenticatedApi
}

beforeEach(() => {
  toastAdd.mockClear()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  mockConnectPopup()
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  probe = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useConnectAccountActions', () => {
  it('marks the vendor busy while a connect flow runs, then releases it', async () => {
    let release: ((flow: ConnectFlowStart) => void) | null = null
    const connectAccount = vi.fn<() => Promise<ConnectFlowStart>>(() => new Promise<ConnectFlowStart>(resolve => { release = resolve }))
    renderProbe(fakeApi({ connectAccount }))
    let pending: Promise<'opened' | 'connected' | 'provisioned' | 'already-granted' | undefined> | null = null
    await act(async () => { pending = probe!.connect('google') })
    expect(probe!.connectingVendor).toBe('google')
    await act(async () => { release!(FLOW) })
    expect(await pending).toBe('opened')
    expect(probe!.connectingVendor).toBeNull()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('toasts the standard idiom on failure: title names the action, description is sanitized', async () => {
    const connectAccount = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw new Error('Vendor refused the request') })
    renderProbe(fakeApi({ connectAccount }))
    let outcome: unknown
    await act(async () => { outcome = await probe!.connect('google') })
    expect(outcome).toBeUndefined()
    expect(probe!.connectingVendor).toBeNull()
    expect(consoleError).toHaveBeenCalledWith('Could not complete connection flow:', expect.any(Error))
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Could not complete connection flow',
      description: 'Vendor refused the request',
      variant: 'error',
    })
  })

  it('hides transport strings from the toast description', async () => {
    // A capnweb transport failure carries no flags, so its message must not surface.
    const connectAccount = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw new Error('Peer closed WebSocket') })
    renderProbe(fakeApi({ connectAccount }))
    await act(async () => { await probe!.connect('google') })
    expect(toastAdd).toHaveBeenCalledWith({
      title: 'Could not complete connection flow',
      description: undefined,
      variant: 'error',
    })
  })

  it('stays quiet when the user cancels the pop-up', async () => {
    const connectAccount = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw new AuthPopupCancelledError() })
    renderProbe(fakeApi({ connectAccount }))
    let outcome: unknown
    await act(async () => { outcome = await probe!.connect('google') })
    expect(outcome).toBeUndefined()
    expect(probe!.connectingVendor).toBeNull()
    expect(toastAdd).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('hands failures to onError instead of toasting (plan-refusal surfaces)', async () => {
    const refusal = new Error('Plan limit reached')
    const connectAccount = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw refusal })
    const onError = vi.fn<(err: unknown) => void>()
    renderProbe(fakeApi({ connectAccount }))
    await act(async () => { await probe!.connect('google', undefined, { onError }) })
    expect(onError).toHaveBeenCalledWith(refusal)
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('provisions ambient accounts without a pop-up', async () => {
    const provisionAmbientAccount = vi.fn<() => Promise<void>>(async () => {})
    renderProbe(fakeApi({ provisionAmbientAccount }))
    let outcome: unknown
    await act(async () => { outcome = await probe!.connectAmbient('google') })
    expect(outcome).toBe('provisioned')
    expect(provisionAmbientAccount).toHaveBeenCalledWith('google')
    expect(window.open).not.toHaveBeenCalled()
    expect(probe!.connectingVendor).toBeNull()
  })

  it('reports already-granted access without opening a pop-up', async () => {
    const ensureAccountResources = vi.fn<() => Promise<ConnectFlowStart | null>>(async () => null)
    renderProbe(fakeApi({ ensureAccountResources }))
    let outcome: unknown
    await act(async () => { outcome = await probe!.grant(7, ['https://mail.google.com/*']) })
    expect(outcome).toBe('already-granted')
    expect(ensureAccountResources).toHaveBeenCalledWith(7, ['https://mail.google.com/*'])
    expect(window.open).not.toHaveBeenCalled()
    expect(probe!.grantingAccountId).toBeNull()
  })

  it('holds reconnect busy until the subscription reports the account back', async () => {
    renderProbe(fakeApi({}))
    await act(async () => { await probe!.reconnect(9, { holdBusy: true }) })
    expect(probe!.reconnectingAccountId).toBe(9)
    act(() => { probe!.clearReconnecting(9) })
    expect(probe!.reconnectingAccountId).toBeNull()
  })

  it('releases a held reconnect on failure', async () => {
    const reconnectAccount = vi.fn<() => Promise<ConnectFlowStart>>(async () => { throw new Error('expired session') })
    renderProbe(fakeApi({ reconnectAccount }))
    await act(async () => { await probe!.reconnect(9, { holdBusy: true }) })
    expect(probe!.reconnectingAccountId).toBeNull()
    expect(toastAdd).toHaveBeenCalled()
  })

  it('keeps busy for busyHoldMs so subscription-driven UI can catch up', async () => {
    vi.useFakeTimers()
    renderProbe(fakeApi({}))
    await act(async () => { await probe!.connect('google', undefined, { busyHoldMs: 2000 }) })
    expect(probe!.connectingVendor).toBe('google')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(probe!.connectingVendor).toBeNull()
  })

  it('does nothing without an authenticated api', async () => {
    renderProbe(null)
    let outcome: unknown
    await act(async () => { outcome = await probe!.connect('google') })
    expect(outcome).toBeUndefined()
    expect(window.open).not.toHaveBeenCalled()
  })
})

describe('mergeGrantedPatterns', () => {
  it('merges new patterns into the granted set without duplicates', () => {
    const description = {
      displayName: 'me',
      grantedResourceUrlPatterns: ['https://mail.google.com/*'],
    } as AccountDescription
    expect(mergeGrantedPatterns(description, [
      'https://mail.google.com/*',
      'https://calendar.google.com/*',
    ])).toEqual({
      ...description,
      grantedResourceUrlPatterns: ['https://mail.google.com/*', 'https://calendar.google.com/*'],
    })
  })

  it('starts the granted set when the description had none', () => {
    const description = { displayName: 'me' } as AccountDescription
    expect(mergeGrantedPatterns(description, ['https://calendar.google.com/*']))
      .toMatchObject({ grantedResourceUrlPatterns: ['https://calendar.google.com/*'] })
  })
})
