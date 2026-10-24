// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, makeTestRoot } from '../action-test-harness'
import { ResolveButton } from './ResolveButton'

const testRoot = makeTestRoot()

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  testRoot.cleanup()
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function approveButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!(button instanceof HTMLButtonElement)) throw new Error('No Approve button rendered')
  return button
}

// jsdom has no PointerEvent, and React derives enter/leave from over/out: a plain event with the
// fields the handlers read stands in for a mouse moving onto or off the button.
function mousePointer(type: 'pointerover' | 'pointerout') {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  return event
}

describe('ResolveButton async feedback', () => {
  it('delays the spinner, then shows the success state and resets', async () => {
    const decision = deferred<void>()
    await testRoot.render(
      <ResolveButton tone="approve" disabled={false} onClick={() => decision.promise} />,
    )
    const button = approveButton()
    expect(button.dataset.feedback).toBe('idle')

    await act(async () => button.click())
    // A fast RPC shows nothing: the spinner only appears after the delay window.
    expect(button.dataset.feedback).toBe('idle')
    expect(document.querySelector('.animate-spin')).toBeNull()

    await advance(150)
    expect(button.dataset.feedback).toBe('loading')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('.animate-spin')).not.toBeNull()

    await decision.resolve(undefined)
    // The spinner holds for its minimum time before the outcome lands.
    await advance(400)
    expect(button.dataset.feedback).toBe('success')
    expect(button.textContent).toBe('Approved')
    expect(button.getAttribute('aria-busy')).toBeNull()

    await advance(2000)
    expect(button.dataset.feedback).toBe('idle')
    expect(button.textContent).toBe('Approve')
  })

  it('skips the spinner entirely for a call that settles within the delay', async () => {
    await testRoot.render(
      <ResolveButton tone="deny" disabled={false} onClick={() => Promise.resolve()} />,
    )
    const deny = [...document.querySelectorAll('button')].find(b => b.textContent === 'Deny')!
    await act(async () => deny.click())
    await advance(10)
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(deny.dataset.feedback).toBe('success')
    expect(deny.textContent).toBe('Denied')
  })

  it('reports a false outcome as the error state', async () => {
    await testRoot.render(
      <ResolveButton tone="approve" disabled={false} onClick={() => Promise.resolve(false)} />,
    )
    const button = approveButton()
    await act(async () => button.click())
    await advance(10)
    expect(button.dataset.feedback).toBe('error')
    expect(button.textContent).toBe('Approve failed')
  })

  it('holds the error state while hovered, then resets after the pointer leaves', async () => {
    const decision = deferred<void>()
    await testRoot.render(
      <ResolveButton tone="approve" disabled={false} onClick={() => decision.promise} />,
    )
    const button = approveButton()
    await act(async () => button.click())
    await advance(150)
    expect(button.dataset.feedback).toBe('loading')

    await decision.reject(new Error('refused'))
    await advance(400)
    expect(button.dataset.feedback).toBe('error')

    await act(async () => button.dispatchEvent(mousePointer('pointerover')))
    await advance(4000)
    expect(button.dataset.feedback).toBe('error')

    await act(async () => button.dispatchEvent(mousePointer('pointerout')))
    await advance(600)
    expect(button.dataset.feedback).toBe('idle')
    expect(button.textContent).toBe('Approve')
  })
})
