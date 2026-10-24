/* eslint-disable react/react-in-jsx-scope */

// The SaaS gate's lazy path in a real browser: with the flag on, SaasSurface must dynamically
// import the shell chunk and render it. jsdom covers the gate logic (saasRoute.test.tsx); Chromium
// proves the chunk actually loads and renders in a real browser — the property OSS builds lose by
// folding it away. (The browser suite loads no Tailwind, so the shell's layout classes are inert
// here; the assertion is presence and emptiness, not visibility.)

import { act } from 'react'
import { RpcContext } from '../../RpcContext'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

describe('SaaS shell in a real browser', () => {
  let root: Root | undefined
  let container: HTMLElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('lazily loads and renders the empty shell when the flag is on', async () => {
    // The suite runs with VITE_SAAS unset (the OSS value); the module is re-imported under a
    // stubbed env so the gate is baked on for this render, exactly as a VITE_SAAS=true build does.
    vi.stubEnv('VITE_SAAS', 'true')
    vi.resetModules()
    const { SaasSurface } = await import('./saasRoute')

    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(<SaasSurface />)
    })

    // The shell's chunk resolves after the first render (the fallback shows meanwhile) — tick
    // inside act until Suspense swaps in the shell, as the jsdom suite does.
    for (let i = 0; i < 100 && !container.querySelector('[data-testid="saas-shell"]'); i++) {
      await act(async () => {
        const timer = Promise.withResolvers<void>()
        setTimeout(timer.resolve, 10)
        await timer.promise
      })
    }

    // Throws if the shell never mounted; it must be empty (mechanism only, no SaaS UI yet).
    const shell = page.getByTestId('saas-shell').element()
    expect(shell.childElementCount).toBe(0)
  })

  it('lazily loads and renders the signup funnel at /saas/start', async () => {
    // Same re-import-under-stubbed-env as above: the gate must be baked on for this render.
    vi.stubEnv('VITE_SAAS', 'true')
    vi.resetModules()
    const { SaasSurface } = await import('./saasRoute')

    window.history.replaceState(null, '', '/saas/start')
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <RpcContext.Provider value={{ stub: {} as never, connectionLost: false }}>
          <SaasSurface />
        </RpcContext.Provider>,
      )
    })

    // The shell chunk resolves, then mounts the funnel — which needs no RPC answer to show its
    // first step (the account form).
    for (let i = 0; i < 100 && !container.querySelector('[data-testid="saas-signup-funnel"]'); i++) {
      await act(async () => {
        const timer = Promise.withResolvers<void>()
        setTimeout(timer.resolve, 10)
        await timer.promise
      })
    }
    expect(page.getByTestId('saas-signup-funnel').element()).not.toBeNull()
  })
})
