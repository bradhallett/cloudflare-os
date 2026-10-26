// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi } from '@gadgets/workshop-shared/api'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminComposioPanel } from './AdminComposioPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INERT = 'also hidden — hiding wins, so this listing has no effect'

describe('AdminComposioPanel cross-listed slugs', () => {
  let root: Root | null = null

  afterEach(() => {
    root?.unmount()
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  const render = async (excludedToolkits: string[], autoApplyToolkits: string[]) => {
    const getComposioToolkitInfo = vi.fn<AdminApi['getComposioToolkitInfo']>(
      async () => [{ slug: 'gmail', exists: true, eligibleToolCount: 3, destructiveToolCount: 1 }])
    const onSaved = vi.fn<(which: 'excluded' | 'autoApply', slugs: string[]) => void>()
    const admin = { getComposioToolkitInfo } as unknown as RpcStub<AdminApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AdminComposioPanel
        admin={admin}
        excludedToolkits={excludedToolkits}
        autoApplyToolkits={autoApplyToolkits}
        onSaved={onSaved}
      />))
    return { getComposioToolkitInfo }
  }

  it('warns that the auto-apply listing is inert for a slug on both lists', async () => {
    await render(['gmail'], ['gmail'])

    expect(document.body.textContent).toContain(INERT)
  })

  it('does not warn when the lists are disjoint', async () => {
    await render(['gmail'], ['slack'])

    expect(document.body.textContent).not.toContain(INERT)
  })
})

describe('AdminComposioPanel live slug validation', () => {
  let root: Root | null = null

  afterEach(() => {
    root?.unmount()
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const render = async (getComposioToolkitInfo: ReturnType<typeof vi.fn>) => {
    const admin = { getComposioToolkitInfo } as unknown as RpcStub<AdminApi>
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AdminComposioPanel
        admin={admin}
        excludedToolkits={[]}
        autoApplyToolkits={[]}
        onSaved={() => {}}
      />))
  }

  // Type like a user: bypass React's value tracker (which dedupes direct `.value` writes) with
  // the native setter, then let the bubbling input event reach the controlled textarea.
  const typeInto = (index: number, text: string) => {
    const area = document.querySelectorAll('textarea')[index]!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(area, text)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('checks a slug against the catalog as it is typed, before Save', async () => {
    vi.useFakeTimers()
    // The catalog knows gmail only; a typed unknown slug must be flagged without a save.
    const getComposioToolkitInfo = vi.fn<AdminApi['getComposioToolkitInfo']>(
      async (slugs) => slugs.map((slug) => ({
        slug, exists: slug === 'gmail', eligibleToolCount: 3, destructiveToolCount: 1,
      })))
    await render(getComposioToolkitInfo)
    expect(getComposioToolkitInfo).not.toHaveBeenCalled()

    typeInto(0, 'slack')
    expect(getComposioToolkitInfo).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(getComposioToolkitInfo).toHaveBeenCalledTimes(1)
    expect(getComposioToolkitInfo).toHaveBeenCalledWith(['slack'])
    expect(document.body.textContent).toContain('matches no toolkit in Composio’s catalog')
  })

  it('debounces keystrokes into one catalog check of the typed slugs', async () => {
    vi.useFakeTimers()
    const getComposioToolkitInfo = vi.fn<AdminApi['getComposioToolkitInfo']>(async () => [])
    await render(getComposioToolkitInfo)

    typeInto(0, 'gmail')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    typeInto(0, 'gmail\nnotion')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(getComposioToolkitInfo).toHaveBeenCalledTimes(1)
    expect(getComposioToolkitInfo).toHaveBeenCalledWith(['gmail', 'notion'])
  })
})
