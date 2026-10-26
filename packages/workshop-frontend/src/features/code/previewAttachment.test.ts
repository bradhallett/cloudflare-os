import { describe, expect, it } from 'vitest'
import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import type { FileChange, TextChange } from '@gadgets/workshop-shared/code-change'
import type { EditPreviewEvent } from '../chat/liveCodeStreams'
import type { RemoteFileEvent } from './otClient'
import { PreviewAttachment, type PreviewAttachmentHost } from './previewAttachment'

const SEP = String.fromCharCode(0)  // the remoteFileListeners fileKey separator

// A recording host: content is whatever the test puts in `clientText` / `baseText`, and every
// dispatch and retry-affecting call is captured for assertions.
class FakeHost implements PreviewAttachmentHost {
  clientText = new Map<string, string>()      // "gadgetId<SEP>path" -> text
  clientRemoved = new Set<string>()
  baseText = new Map<string, string | null>() // path -> text (null: binary/unreadable)
  ready = true
  dispatched: Array<[WorkpieceId, string, FileChange]> = []
  contentChanges = 0
  baseRequests = new Map<string, (loaded: boolean) => void>()

  clientReady(): boolean { return this.ready }

  clientFileText(gadgetId: WorkpieceId, path: string) {
    const key = gadgetId + SEP + path
    if (this.clientText.has(key)) return this.clientText.get(key)!
    return this.clientRemoved.has(key) ? null : undefined
  }

  baseFileText(_gadgetId: WorkpieceId, path: string): string | null | undefined {
    return this.baseText.has(path) ? this.baseText.get(path)! : undefined
  }

  requestBaseText(
    _gadgetId: WorkpieceId, path: string, onSettled: (loaded: boolean) => void): void {
    this.baseRequests.set(path, onSettled)
  }

  dispatchFileChange(gadgetId: WorkpieceId, path: string, change: FileChange): void {
    this.dispatched.push([gadgetId, path, change])
  }

  onContentChanged(): void { this.contentChanges++ }

  /** Test helper: settle a requested base read; a successful one installs a visible base. */
  settleBase(path: string, loaded: boolean): void {
    const cb = this.baseRequests.get(path)
    this.baseRequests.delete(path)
    if (loaded) this.baseText.set(path, 'base:' + path)
    cb?.(loaded)
  }
}

const GADGET = 7 as WorkpieceId

function ck(path: string): string { return GADGET + SEP + path }

/** Apply one synthetic compact-JSON text change (the shape dispatchFileChange carries). */
function applyTextChange(doc: string, change: TextChange): string {
  let out = ''
  let pos = 0
  for (const op of change) {
    if (typeof op === 'number') {
      out += doc.slice(pos, pos + op)
      pos += op
    } else {
      const [deleted, ...lines] = op
      pos += deleted
      out += lines.join('\n')
    }
  }
  return out + doc.slice(pos)
}

/** Fold every dispatched change for one file over a starting document. */
function foldChanges(host: FakeHost, path: string, initial: string): string {
  let doc = initial
  for (const [gadgetId, filePath, change] of host.dispatched) {
    if (gadgetId !== GADGET || filePath !== path) continue
    if ('set' in change) return change.set
    if ('remove' in change) return ''
    if (!('edit' in change)) return ''  // setBytes: not produced by previews; fold as empty
    doc = applyTextChange(doc, change.edit)
  }
  return doc
}

function start(toolCallId: string, path: string, textToReplace?: string): EditPreviewEvent {
  return {
    kind: 'start', toolCallId, workpieceId: GADGET, filename: path,
    ...(textToReplace !== undefined ? { textToReplace } : {}),
  }
}

function delta(toolCallId: string, text: string): EditPreviewEvent {
  return { kind: 'delta', toolCallId, delta: text }
}

function clear(toolCallId: string): EditPreviewEvent {
  return { kind: 'clear', toolCallId }
}

function row(gadgetId: WorkpieceId, path: string, change: FileChange): RemoteFileEvent {
  return { gadgetId, path, change } as RemoteFileEvent
}

describe('PreviewAttachment', () => {
  it('attaches a writeFile preview and dispatches its streamed deltas', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'old')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'hello'))
    machine.handlePreviewEvent(delta('w1', ' world'))
    // Three dispatches: the attach (the span replaced by the empty text so far) and the deltas.
    expect(host.dispatched).toHaveLength(3)
    expect(foldChanges(host, 'a.txt', 'old')).toBe('hello world')
    expect(machine.previewedFileText(GADGET, 'a.txt')).toBe('hello world')
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('hello world')
  })

  it('keeps a finished preview displayed until its row resolves it', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'base')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'X'))
    machine.handlePreviewEvent(start('w2', 'b.txt'))  // finalizes w1 into pending
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('X')
    // The row makes the client text exactly the preview: nothing more is dispatched.
    host.clientText.set(ck('a.txt'), 'X')
    machine.handleRow(row(GADGET, 'a.txt', { set: 'X' }))
    expect(host.dispatched).toHaveLength(2)
    expect(foldChanges(host, 'a.txt', 'base')).toBe('X')
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBeUndefined()
  })

  it('resets the file from the client when a row diverges from the confirmed preview', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'base')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'X'))
    machine.handlePreviewEvent(start('w2', 'b.txt'))
    host.clientText.set(ck('a.txt'), 'someone else')
    machine.handleRow(row(GADGET, 'a.txt', { set: 'someone else' }))
    expect(host.dispatched).toContainEqual([GADGET, 'a.txt', { set: 'someone else' }])
    expect(machine.previewOverridesFor(GADGET).has('a.txt')).toBe(false)
  })

  it('attaches an editFile preview at its unique match and skips a non-unique one', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'one two one')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('e1', 'a.txt', 'two'))
    machine.handlePreviewEvent(delta('e1', 'TWO'))
    expect(host.dispatched).toHaveLength(2)
    expect(foldChanges(host, 'a.txt', 'one two one')).toBe('one TWO one')
    expect(machine.previewedFileText(GADGET, 'a.txt')).toBe('one TWO one')
    // Non-unique textToReplace: no overlay, no dispatch; a later unique call still attaches.
    machine.handlePreviewEvent(start('e2', 'a.txt', 'one'))
    machine.handlePreviewEvent(delta('e2', '1'))
    expect(host.dispatched).toHaveLength(2)
    machine.handlePreviewEvent(start('e3', 'a.txt', 'TWO'))
    machine.handlePreviewEvent(delta('e3', '2'))
    expect(host.dispatched).toHaveLength(4)
  })

  it('defers a preview whose base is loading, attaches it when the read lands', () => {
    const host = new FakeHost()
    // Neither the client nor the base holds the file yet.
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'late'))
    expect(host.dispatched).toEqual([])
    expect(host.baseRequests.has('a.txt')).toBe(true)
    // Finish streaming before the read lands: the preview is deferred, not dropped.
    machine.handlePreviewEvent(start('w2', 'b.txt'))
    host.clientText.set(ck('a.txt'), 'ignored')
    host.settleBase('a.txt', true)
    expect(host.dispatched).toEqual([[GADGET, 'a.txt', { set: 'late' }]])
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('late')
  })

  it('applies a deferred preview via its row when the row lands first', () => {
    const host = new FakeHost()
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'gone'))
    machine.handlePreviewEvent(start('w2', 'b.txt'))
    const change: FileChange = { set: 'gone' }
    machine.handleRow(row(GADGET, 'a.txt', change))
    // Nothing was displayed for the deferred preview, so its row applies as-is...
    expect(host.dispatched).toEqual([[GADGET, 'a.txt', change]])
    host.settleBase('a.txt', true)
    // ...and the settled read must not re-attach it (no second dispatch).
    expect(host.dispatched).toHaveLength(1)
  })

  it('stacks same-file previews in call order', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'abc')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('e1', 'a.txt', 'b'))
    machine.handlePreviewEvent(delta('e1', 'B'))
    machine.handlePreviewEvent(start('e2', 'a.txt', 'B'))
    machine.handlePreviewEvent(delta('e2', 'C'))
    // e2 streams on top of e1's final text: 'b'->'B', then 'B'->'C'.
    expect(machine.previewedFileText(GADGET, 'a.txt')).toBe('aCc')
    // e1 finished (pending), e2 still overlays: the override keeps showing the stacked text.
    machine.handlePreviewEvent(start('w3', 'other.txt'))
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('aCc')
  })

  it('withdraws a cleared streaming preview and restores the file doc', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'keep')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'nope'))
    machine.handlePreviewEvent(clear('w1'))
    expect(machine.previewOverridesFor(GADGET).has('a.txt')).toBe(false)
    expect(host.dispatched).toContainEqual([GADGET, 'a.txt', { set: 'keep' }])
  })

  it('removes a cleared mid-chain preview without changing the display', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'abc')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('e1', 'a.txt', 'b'))
    machine.handlePreviewEvent(delta('e1', 'B'))
    machine.handlePreviewEvent(start('e2', 'a.txt', 'B'))
    machine.handlePreviewEvent(delta('e2', 'C'))
    machine.handlePreviewEvent(start('w3', 'other.txt'))
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('aCc')
    machine.handlePreviewEvent(clear('e1'))
    // e1 was not the tail: the stacked text stays displayed.
    expect(machine.previewOverridesFor(GADGET).get('a.txt')).toBe('aCc')
    const before = host.dispatched.length
    // e2's row then confirms the visible text.
    host.clientText.set(ck('a.txt'), 'aCc')
    machine.handleRow(row(GADGET, 'a.txt', { set: 'aCc' }))
    expect(host.dispatched).toHaveLength(before)
    expect(machine.previewOverridesFor(GADGET).has('a.txt')).toBe(false)
  })

  it('drops everything on reset and restores affected files to real content', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'real')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'overlay'))
    machine.handlePreviewEvent({ kind: 'reset' })
    expect(machine.previewOverridesFor(GADGET).size).toBe(0)
    expect(host.dispatched).toContainEqual([GADGET, 'a.txt', { set: 'real' }])
    expect(machine.previewedFileText(GADGET, 'a.txt')).toBeUndefined()
  })

  it('drops state without restoring on teardown (reset method)', () => {
    const host = new FakeHost()
    host.clientText.set(ck('a.txt'), 'real')
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'overlay'))
    const before = host.dispatched.length
    machine.reset()
    expect(host.dispatched).toHaveLength(before)
    expect(machine.previewOverridesFor(GADGET).size).toBe(0)
  })

  it('does not retry endlessly when a base read fails', () => {
    const host = new FakeHost()
    const machine = new PreviewAttachment(host)
    machine.handlePreviewEvent(start('w1', 'a.txt'))
    machine.handlePreviewEvent(delta('w1', 'x'))
    expect(host.baseRequests.size).toBe(1)
    host.settleBase('a.txt', false)
    expect(host.baseRequests.size).toBe(0)
    expect(host.dispatched).toEqual([])
  })
})
