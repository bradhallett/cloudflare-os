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
