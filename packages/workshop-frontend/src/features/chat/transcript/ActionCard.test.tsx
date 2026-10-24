// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  return {
    ...actual,
    Tooltip: Pass,
    useKumoToastManager: () => ({ add: addToast }),
  }
})

import { deferred, entry, makeTestRoot } from '../../../action-test-harness'
import { useResolveAction } from '../../../useResolveAction'
import { ActionCard } from './ActionCard'
import type { ActionChatMessage } from './messageTypes'

const testRoot = makeTestRoot()

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  testRoot.cleanup()
  addToast.mockClear()
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const message = { type: 'action', actionId: 1, actionLog: entry(1) } as ActionChatMessage

function Harness({ overseer, onResolved }: {
  overseer: RpcStub<Overseer>
  onResolved: (actionId: number, state: 'approved' | 'rejected') => void
}) {
  const [processing, setProcessing] = useState(new Set<number>())
  const { resolveAction } = useResolveAction(overseer, setProcessing, onResolved)
  return (
    <ActionCard
      msg={message}
      restricted={false}
      open={false}
      isProcessing={processing.has(1)}
      onToggleExpansion={() => {}}
      onResolve={resolveAction}
      onAlwaysApprove={() => {}}
      isTagAutoApproved={() => false}
      onToggleHook={() => {}}
    />
  )
}

function decisionButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No ${label} button rendered`)
  return button
}

// Renders the card through the real useResolveAction flow with the given resolve RPCs parked.
async function renderCard(rpcs: { approveAction?: unknown; rejectAction?: unknown }) {
  await testRoot.render(
    <Harness
      overseer={rpcs as unknown as RpcStub<Overseer>}
      onResolved={() => {}}
    />,
  )
}

describe('ActionCard decision feedback through useResolveAction', () => {
  it('tracks a slow approve to its success state and blocks the sibling controls meanwhile', async () => {
    const decision = deferred<void>()
    const approveAction = vi.fn<() => Promise<void>>(() => decision.promise)
    await renderCard({ approveAction })
    const approve = decisionButton('Approve')
    const deny = decisionButton('Deny')

    await act(async () => approve.click())
    expect(approveAction).toHaveBeenCalledWith(1, undefined)
    await advance(150)
    expect(approve.dataset.feedback).toBe('loading')
    expect(approve.getAttribute('aria-busy')).toBe('true')
    // The processing set still gates the card's other decision controls.
    expect(deny.disabled).toBe(true)

    await decision.resolve(undefined)
    await advance(400)
    expect(approve.dataset.feedback).toBe('success')
    expect(approve.textContent).toBe('Approved')
    expect(deny.disabled).toBe(false)
  })

  it('tracks a deny to its success state', async () => {
    const decision = deferred<void>()
    const rejectAction = vi.fn<() => Promise<void>>(() => decision.promise)
    await renderCard({ rejectAction })
    const deny = decisionButton('Deny')

    await act(async () => deny.click())
    expect(rejectAction).toHaveBeenCalledWith(1)
    await decision.resolve(undefined)
    await advance(10)
    expect(deny.dataset.feedback).toBe('success')
    expect(deny.textContent).toBe('Denied')
  })

  it('reports a failed approve on the button and keeps the existing error toast', async () => {
    const decision = deferred<void>()
    await renderCard({ approveAction: () => decision.promise })
    const approve = decisionButton('Approve')

    await act(async () => approve.click())
    await decision.reject(new Error('refused'))
    await advance(10)

    expect(approve.dataset.feedback).toBe('error')
    expect(approve.textContent).toBe('Approve failed')
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }))
    // Not held: the error clears after its reset window.
    await advance(4000)
    expect(approve.dataset.feedback).toBe('idle')
  })
})
