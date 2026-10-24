// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/' }))

vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('./CommandPalette', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="command-palette" /> : null),
}))
vi.mock('./Sidebar', () => ({
  default: () => <aside data-testid="sidebar" />,
}))

import AppShell from './AppShell'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppShell', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('gives the percentage-height desktop sidebar a definite-height container', () => {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<AppShell><div /></AppShell>))

    const sidebarContainer = container.querySelector('[data-testid="sidebar"]')?.parentElement
    expect(sidebarContainer?.classList.contains('h-full')).toBe(true)
  })

  it('opens the command palette on ⌘K on Apple platforms and Ctrl+K elsewhere', () => {
    const keyDown = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', init)
      Object.defineProperty(event, 'code', { value: 'KeyK' })
      return act(() => {
        document.dispatchEvent(event)
      })
    }

    vi.stubGlobal('navigator', Object.assign(new Object(), navigator, { platform: 'MacIntel' }))
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<AppShell><div /></AppShell>))

    // ⌘K opens the palette; Ctrl+K does not on an Apple platform.
    keyDown({ key: 'k', metaKey: true })
    expect(container.querySelector('[data-testid="command-palette"]')).not.toBeNull()
    keyDown({ key: 'k', metaKey: true }) // ⌘K again toggles it closed.
    expect(container.querySelector('[data-testid="command-palette"]')).toBeNull()
    keyDown({ key: 'k', ctrlKey: true })
    expect(container.querySelector('[data-testid="command-palette"]')).toBeNull()

    // On Windows/Linux, Ctrl+K is the palette hotkey and ⌘K is not.
    vi.stubGlobal('navigator', Object.assign(new Object(), navigator, { platform: 'Win32' }))
    keyDown({ key: 'k', ctrlKey: true })
    expect(container.querySelector('[data-testid="command-palette"]')).not.toBeNull()
    keyDown({ key: 'k', ctrlKey: true })
    expect(container.querySelector('[data-testid="command-palette"]')).toBeNull()
    keyDown({ key: 'k', metaKey: true })
    expect(container.querySelector('[data-testid="command-palette"]')).toBeNull()

    vi.unstubAllGlobals()
  })
})
