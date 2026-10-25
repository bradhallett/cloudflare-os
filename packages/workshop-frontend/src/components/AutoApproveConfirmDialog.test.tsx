// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutoApproveConfirmDialog from './AutoApproveConfirmDialog'

beforeEach(() => { vi.useFakeTimers() })

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function renderDialog(onConfirm: () => PromiseLike<boolean> | boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <AutoApproveConfirmDialog
      open
      actionLabel="Append to Google Doc"
      resourceTitle="My Doc"
      onOpenChange={() => {}}
      onConfirm={onConfirm}
    />,
  ))
}

function confirmButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.includes('Always approve') || b.textContent?.includes('Enabling'))
  if (!(button instanceof HTMLButtonElement)) throw new Error('No confirm button rendered')
  return button
}

describe('AutoApproveConfirmDialog confirm feedback', () => {
  it('marks the confirm button busy while enabling, then releases it', async () => {
    const enabling = Promise.withResolvers<boolean>()
    await renderDialog(() => enabling.promise)
    const button = confirmButton()
    expect(button.getAttribute('aria-busy')).toBeNull()

    await act(async () => button.click())
    await advance(150)
    expect(button.textContent).toContain('Enabling')
    expect(button.getAttribute('aria-busy')).toBe('true')

    // Success closes the dialog in real callers, so no success label follows the busy state.
    enabling.resolve(true)
    await advance(600)
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(button.textContent).not.toContain('Enabled')
  })

  it('reports a failed enable as Failed', async () => {
    await renderDialog(() => Promise.resolve(false))
    const button = confirmButton()
    await act(async () => button.click())
    await advance(600)
    expect(button.textContent).toBe('Failed')
    expect(button.getAttribute('aria-busy')).toBeNull()
  })
})
