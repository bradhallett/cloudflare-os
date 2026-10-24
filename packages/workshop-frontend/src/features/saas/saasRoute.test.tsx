// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The compile-time SaaS gate: the OSS cases use the module as this suite imports it (VITE_SAAS
// unset, the value baked into every OSS build); the SaaS cases re-import it under a stubbed env,
// which is what a VITE_SAAS=true build bakes instead. The bundle-level contract (OSS builds emit
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SAAS_MODE, isSaasRoute, SaasSurface } from './saasRoute'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  return container
}

describe('SaaS gate in an OSS build (VITE_SAAS unset)', () => {
  it('bakes the flag off', () => {
    expect(SAAS_MODE).toBe(false)
  })

  it('matches no pathname, including the SaaS prefix itself', () => {
    expect(isSaasRoute('/saas')).toBe(false)
    expect(isSaasRoute('/saas/billing')).toBe(false)
    expect(isSaasRoute('/')).toBe(false)
  })

  it('renders nothing for the SaaS surface', async () => {
    const page = await render(<SaasSurface />)
    expect(page.querySelector('[data-testid="saas-shell"]')).toBeNull()
    expect(page.childElementCount).toBe(0)
  })
})

describe('SaaS gate in a SaaS build (VITE_SAAS=true)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SAAS', 'true')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('bakes the flag on and matches only the /saas prefix', async () => {
    const { SAAS_MODE, isSaasRoute } = await import('./saasRoute')
    expect(SAAS_MODE).toBe(true)
    expect(isSaasRoute('/saas')).toBe(true)
    expect(isSaasRoute('/saas/orgs')).toBe(true)
    expect(isSaasRoute('/')).toBe(false)
    expect(isSaasRoute('/workspaces')).toBe(false)
    expect(isSaasRoute('/signup')).toBe(false)
  })

  it('lazily renders the (empty) SaaS shell', async () => {
    const { SaasSurface } = await import('./saasRoute')
    const page = await render(<SaasSurface />)

    // The shell's chunk resolves on the module runner's schedule, after the first render — tick
    // inside act until Suspense swaps the fallback for the shell (bounded; it takes ~one tick).
    for (let i = 0; i < 100 && !page.querySelector('[data-testid="saas-shell"]'); i++) {
      await act(async () => {
        const timer = Promise.withResolvers<void>()
        setTimeout(timer.resolve, 10)
        await timer.promise
      })
    }
    // Mechanism only: the shell stays empty until SaaS-only surfaces exist.
    expect(page.querySelector('[data-testid="saas-shell"]')!.childElementCount).toBe(0)
  })
})
