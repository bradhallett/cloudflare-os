import { describe, expect, it, vi } from 'vitest'
import type { FileChange } from '@gadgets/workshop-shared/code-change'
import { RemoteFileListeners } from './remoteFileListeners'

describe('RemoteFileListeners', () => {
  it('delivers a dispatched delta to the file\'s listeners only', () => {
    const listeners = new RemoteFileListeners()
    const onA = vi.fn()
    const onA2 = vi.fn()
    const onB = vi.fn()
    listeners.subscribe(1, 'a.txt', onA)
    listeners.subscribe(1, 'a.txt', onA2)
    listeners.subscribe(1, 'b.txt', onB)

    const change: FileChange = { set: 'x' }
    listeners.dispatch(1, 'a.txt', change)

    expect(onA).toHaveBeenCalledWith(change)
    expect(onA2).toHaveBeenCalledWith(change)
    expect(onB).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe', () => {
    const listeners = new RemoteFileListeners()
    const onA = vi.fn()
    const unsubscribe = listeners.subscribe(1, 'a.txt', onA)
    unsubscribe()

    listeners.dispatch(1, 'a.txt', { set: 'x' })

    expect(onA).not.toHaveBeenCalled()
  })

  it('drops deltas racing a reload instead of patching the retired session', () => {
    const listeners = new RemoteFileListeners()
    const doomed = vi.fn()
    listeners.subscribe(1, 'a.txt', doomed)

    // The reload decision: retire, then the re-render resubscribes (below). A delta the OT
    // client drains in between must not reach the session being torn down.
    listeners.retire()
    listeners.dispatch(1, 'a.txt', { edit: [3, [0, '!']] })
    expect(doomed).not.toHaveBeenCalled()

    const fresh = vi.fn()
    listeners.subscribe(1, 'a.txt', fresh)
    listeners.dispatch(1, 'a.txt', { set: 'rebuilt' })
    expect(fresh).toHaveBeenCalledWith({ set: 'rebuilt' })
    expect(doomed).not.toHaveBeenCalled()
  })

  it('retires listeners of every file at once, as the session re-key does', () => {
    const listeners = new RemoteFileListeners()
    const onA = vi.fn()
    const onOtherFile = vi.fn()
    const onOtherGadget = vi.fn()
    listeners.subscribe(1, 'a.txt', onA)
    listeners.subscribe(1, 'b.txt', onOtherFile)
    listeners.subscribe(2, 'a.txt', onOtherGadget)

    listeners.retire()
    listeners.dispatch(1, 'a.txt', { set: 'x' })
    listeners.dispatch(1, 'b.txt', { set: 'x' })
    listeners.dispatch(2, 'a.txt', { set: 'x' })

    expect(onA).not.toHaveBeenCalled()
    expect(onOtherFile).not.toHaveBeenCalled()
    expect(onOtherGadget).not.toHaveBeenCalled()
  })
})
