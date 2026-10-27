import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import type { FileChange, FileContent, TextChange } from '@gadgets/workshop-shared/code-change'
import type { EditPreviewEvent } from '../chat/liveCodeStreams'
import type { RemoteFileEvent } from './otClient'
import { fileKey } from './remoteFileListeners'

// ---- streaming edit previews (see ChatLiveEditPreviews) ---------------------------------------
//
// The agent's writeFile/editFile calls, overlaid on the displayed content as their text streams
// in. Display-only: none of it ever enters the OT client. Because tool calls execute only after
// the whole model response has streamed, previews outlive their streaming: each finished
// preview's final text stays displayed as a *pending* entry until the call's durable change row
// arrives (rows land in call order; see the interception in handleRow) or an editPreviewClear
// withdraws it. Same-file previews stack: a later call's span is located in the text of the
// finished preview beneath it, mirroring how the agent computes each edit against content that
// includes its earlier edits. A preview targets a file whose text may not be loaded yet (content
// is read lazily): attachment then waits for the read, deltas accumulating meanwhile, and a
// preview that finishes streaming before the read lands is *deferred* and joins its file's
// pending chain once it does -- never dropped.

/** What PreviewAttachment needs from its host view: content reads and display dispatch. */
export interface PreviewAttachmentHost {
  /** True once the OT client has folded its first durable snapshot. */
  clientReady(): boolean
  /**
   * The OT client's current content for a file: its FileContent when the client holds the path
   * (binary content reads as known-but-not-text), null when the chat's content removed it,
   * undefined when the client holds nothing for the path (the preview then falls back to the
   * content base).
   */
  clientFileText(gadgetId: WorkpieceId, path: string): FileContent | null | undefined
  /**
   * The file's text at the selected gadget's content base: string for text files, null for a
   * binary/unreadable one or a pending gadget (nothing but the overlay), undefined while the
   * store is still fetching it (attachment then waits -- `text` is cumulative, so attaching late
   * loses nothing). Never called for a gadget other than the selected one.
   */
  baseFileText(gadgetId: WorkpieceId, path: string): string | null | undefined
  /** Fetch a base text that `baseFileText` reported as still loading; `onSettled(true)` fires
   * only when the read succeeded (a failed one must not trigger an endless read/retry cycle),
   * `onSettled(false)` when it failed. */
  requestBaseText(
    gadgetId: WorkpieceId, path: string, onSettled: (loaded: boolean) => void): void
  /** Forward a display-only text change to the file's open editors. */
  dispatchFileChange(gadgetId: WorkpieceId, path: string, change: FileChange): void
  /** Note that displayed content changed (the host re-derives the file list and statuses). */
  onContentChanged(): void
}

// The call whose content is currently streaming, attached to the display or not (attachment
// waits for the target's content to load; `text` is cumulative, so attaching can happen late).
// Also the shape of a deferred preview (see deferredPreviews).
type StreamingPreview = {
  toolCallId: string
  gadgetId: WorkpieceId
  path: string
  // editFile's replaced text; absent for writeFile (the streamed text replaces the whole file).
  textToReplace?: string
  // The streamed text received so far.
  text: string
}

// Where a preview's streamed text goes in `fileText`: the whole file for writeFile, editFile's
// uniquely matched span otherwise. Null when there is no unique match -- the tool call itself
// will fail the same test (or our copy has diverged, and anchoring the preview would show it in
// the wrong place), so no preview is shown.
function locatePreviewSpan(
  preview: StreamingPreview, fileText: string | undefined,
): { from: number; to: number } | null {
  if (preview.textToReplace === undefined) return { from: 0, to: fileText?.length ?? 0 }
  const matchPos = fileText !== undefined ? fileText.indexOf(preview.textToReplace) : -1
  if (matchPos < 0 || fileText!.indexOf(preview.textToReplace, matchPos + 1) >= 0) return null
  return { from: matchPos, to: matchPos + preview.textToReplace.length }
}

// The streaming preview's rendering: the streamed `text` replaces [from, to) of `base` -- the
// file's displayed text when the preview attached ('' for a file being created); the whole file
// for writeFile, editFile's matched span otherwise. `text` mirrors the StreamingPreview's (all
// of it is dispatched into open editors as it arrives).
type PreviewOverlay = {
  toolCallId: string
  gadgetId: WorkpieceId
  path: string
  base: string
  from: number
  to: number
  text: string
}

// A finished preview awaiting its durable row: the full file text that row should produce.
type PendingPreview = {
  toolCallId: string
  text: string
}

function splitFileKey(key: string): [WorkpieceId, string] {
  const sep = key.indexOf('\u0000')
  return [Number(key.slice(0, sep)), key.slice(sep + 1)]
}

// The previewed file's full display text: the base with the streamed text in place of the span.
function previewedText(overlay: PreviewOverlay): string {
  return overlay.base.slice(0, overlay.from) + overlay.text + overlay.base.slice(overlay.to)
}

// Build the compact-JSON text change replacing [from, to) of a document of length `docLen` with
// `insert`. Only ever consumed by the editors' remote-change converters (see CodeEditor's
// specFromTextChange) -- these synthetic changes never reach the OT client or the server.
function replaceSpanTextChange(
  docLen: number, from: number, to: number, insert: string,
): TextChange {
  const change: TextChange = []
  if (from > 0) change.push(from)
  change.push(insert === '' ? [to - from] : [to - from, ...insert.split('\n')])
  if (docLen > to) change.push(docLen - to)
  return change
}

/**
 * The streaming edit-preview state machine (see the module comment): the call whose content is
 * streaming, its display overlay once attached, finished previews awaiting their durable rows
 * (per file, in call order), finished previews that could not attach because their file's base
 * text was still loading (they join the pending chains once it lands -- see attachDeferred), and
 * the call whose preview could not attach (no unique textToReplace match) and stays skipped.
 * One instance spans the host view's OT clients and preview subscriptions; `reset` drops its
 * state when either is torn down.
 */
export class PreviewAttachment {
  private streamingPreview: StreamingPreview | null = null
  private activeOverlay: PreviewOverlay | null = null
  // Preview maps are keyed like the remote-delta listener map (see remoteFileListeners.ts, whose
  // fileKey is the one definition of the scheme).
  private readonly pendingPreviews = new Map<string, PendingPreview[]>()
  private readonly deferredPreviews: StreamingPreview[] = []
  private skippedPreview: string | null = null
  // Dedupes the base reads attachment kicks off, keyed like the previews.
  private readonly baseReads = new Set<string>()

  constructor(private readonly host: PreviewAttachmentHost) {}

  /** Drop everything: a coarse client change is about to rebuild the display from the client. */
  handleCoarseReset(): void {
    this.streamingPreview = null
    this.activeOverlay = null
    this.pendingPreviews.clear()
    this.deferredPreviews.length = 0
  }

  /**
   * Intercept one remote change row, resolving finished previews it completes. Rows land in call
   * order, so a row for a file with pending previews should be that call's completion, making
   * the client's new content exactly the preview's final text; anything else re-anchors or
   * resets the display around the client's authoritative content.
   */
  handleRow(event: RemoteFileEvent): void {
    const key = fileKey(event.gadgetId, event.path)
    const chain = this.pendingPreviews.get(key)
    if (chain !== undefined && chain.length > 0) {
      // The oldest finished preview of this file resolves: rows arrive in call order, so this
      // row should be that call's completion, making the client's new content exactly the
      // preview's final text. The doc -- showing that text, or a later preview stacked on it --
      // is then already consistent, so forward nothing.
      const confirmed = chain.shift()!
      if (chain.length === 0) this.pendingPreviews.delete(key)
      const clientText = this.host.clientFileText(event.gadgetId, event.path)
      if (clientText === confirmed.text) return
      // Divergence (a call this preview stack didn't cover, or our span anchoring drifted):
      // drop the file's whole stack, reset its editors from the client, and re-anchor the
      // streaming preview on the fresh content.
      this.pendingPreviews.delete(key)
      const overlay = this.activeOverlay
      if (overlay !== null && overlay.gadgetId === event.gadgetId &&
          overlay.path === event.path) {
        this.activeOverlay = null
      }
      this.host.dispatchFileChange(event.gadgetId, event.path,
        typeof clientText === 'string' ? { set: clientText } : { remove: true })
      this.retryAttach()
      return
    }
    // A finished preview still waiting for its base text is resolved by its row the same way --
    // except that nothing was ever displayed for it, so the row applies as an ordinary change.
    // Left in place, it would attach later against the post-row text and show the edit twice
    // (or fail to match and be skipped).
    const deferred = this.deferredPreviews
    const deferredIndex = deferred.findIndex(preview =>
      preview.gadgetId === event.gadgetId && preview.path === event.path)
    if (deferredIndex >= 0) {
      deferred.splice(deferredIndex, 1)
      this.host.dispatchFileChange(event.gadgetId, event.path, event.change)
      return
    }
    const overlay = this.activeOverlay
    const streaming = this.streamingPreview
    if (overlay === null && streaming !== null && streaming.gadgetId === event.gadgetId &&
        streaming.path === event.path) {
      // The streaming call completed before its preview could attach (its base text was still
      // loading): its row is the whole of its effect.
      this.streamingPreview = null
      this.host.dispatchFileChange(event.gadgetId, event.path, event.change)
      return
    }
    if (overlay !== null && overlay.gadgetId === event.gadgetId &&
        overlay.path === event.path) {
      this.activeOverlay = null
      const text = this.host.clientFileText(event.gadgetId, event.path)
      if (text === previewedText(overlay)) {
        // The streaming call's own completion (the ordinary end for the response's last edit,
        // whose preview no later start finalizes): the doc already shows exactly this content,
        // so the preview simply resolves.
        this.streamingPreview = null
        return
      }
      // Otherwise a row landed *under* the still-streaming preview (a call of this response
      // that streamed no preview, or another producer). Reset the doc from the client -- the
      // incremental change's offsets are against the client's pre-row content, not the
      // previewed document -- and re-anchor the preview on top.
      this.host.dispatchFileChange(event.gadgetId, event.path,
        typeof text === 'string' ? { set: text } : { remove: true })
      this.retryAttach()
      return
    }
    this.host.dispatchFileChange(event.gadgetId, event.path, event.change)
  }

  /** Feed one edit-preview stream event (start / delta / clear / reset). */
  handlePreviewEvent(event: EditPreviewEvent): void {
    switch (event.kind) {
      case 'start':
        this.finalizeStreaming()
        this.streamingPreview = {
          toolCallId: event.toolCallId,
          gadgetId: event.workpieceId,
          path: event.filename,
          ...(event.textToReplace !== undefined ? { textToReplace: event.textToReplace } : {}),
          text: '',
        }
        this.retryAttach()
        break

      case 'delta': {
        const streaming = this.streamingPreview
        if (streaming === null || streaming.toolCallId !== event.toolCallId ||
            event.delta === '') break
        streaming.text += event.delta
        const overlay = this.activeOverlay
        if (overlay !== null) {
          // Attached: dispatch just the new characters at the growing insertion point.
          const docLen = overlay.base.length - (overlay.to - overlay.from) + overlay.text.length
          const pos = overlay.from + overlay.text.length
          overlay.text = streaming.text
          this.host.dispatchFileChange(overlay.gadgetId, overlay.path,
            { edit: replaceSpanTextChange(docLen, pos, pos, event.delta) })
          this.host.onContentChanged()
        } else {
          this.retryAttach()
        }
        break
      }

      case 'clear': {
        // The named call will produce no row (it failed -- possibly surfacing only at execution,
        // after later calls' previews streamed -- or was a no-op).
        const streaming = this.streamingPreview
        if (streaming !== null && streaming.toolCallId === event.toolCallId) {
          this.streamingPreview = null
          const overlay = this.activeOverlay
          if (overlay !== null) {
            this.activeOverlay = null
            this.restoreFileDoc(overlay.gadgetId, overlay.path)
            this.host.onContentChanged()
          }
          break
        }
        // A finished preview still waiting for its base: nothing is displayed for it.
        const deferred = this.deferredPreviews
        const deferredIndex = deferred.findIndex(entry => entry.toolCallId === event.toolCallId)
        if (deferredIndex >= 0) {
          deferred.splice(deferredIndex, 1)
          break
        }
        // A finished preview: remove its pending entry. Only a tail removal changes the display;
        // a mid-chain removal leaves the later previews' stacked text visible, and the row
        // interception's mismatch check self-heals when their rows arrive.
        for (const [key, chain] of this.pendingPreviews) {
          const index = chain.findIndex(entry => entry.toolCallId === event.toolCallId)
          if (index < 0) continue
          const wasTail = index === chain.length - 1
          chain.splice(index, 1)
          if (chain.length === 0) this.pendingPreviews.delete(key)
          if (wasTail) {
            const [gadgetId, path] = splitFileKey(key)
            const overlay = this.activeOverlay
            if (overlay !== null && overlay.gadgetId === gadgetId && overlay.path === path) {
              // The streaming preview was stacked on the removed text; re-anchor it.
              this.activeOverlay = null
              this.restoreFileDoc(gadgetId, path)
              this.retryAttach()
            } else {
              this.restoreFileDoc(gadgetId, path)
            }
            this.host.onContentChanged()
          }
          break
        }
        break
      }

      case 'reset': {
        // Turn over / stream lost: drop everything and restore affected files' editors to the
        // real content.
        const affected = new Set<string>(this.pendingPreviews.keys())
        const overlay = this.activeOverlay
        if (overlay !== null) affected.add(fileKey(overlay.gadgetId, overlay.path))
        this.streamingPreview = null
        this.activeOverlay = null
        this.pendingPreviews.clear()
        this.deferredPreviews.length = 0
        if (affected.size > 0) {
          for (const key of affected) {
            const [gadgetId, path] = splitFileKey(key)
            const real = this.resolveRealText(gadgetId, path)
            if (real === undefined) continue
            this.host.dispatchFileChange(gadgetId, path,
              real.text !== undefined ? { set: real.text } : { remove: true })
          }
          this.host.onContentChanged()
        }
        break
      }
    }
  }

  /**
   * Attach the streaming preview's overlay, if its base content is available. Idempotent and
   * late-callable (`text` is cumulative): retried on every delta, on readiness changes (the
   * client's first snapshot, a base text arriving), and by the row interception's re-anchoring.
   */
  retryAttach(): void {
    this.attachDeferred()
    const streaming = this.streamingPreview
    if (streaming === null || this.activeOverlay !== null) return
    if (this.skippedPreview === streaming.toolCallId) return
    const streamingBase = this.previewBaseText(streaming.gadgetId, streaming.path)
    if (streamingBase === undefined) return // still loading; retried per the note above
    const fileText = streamingBase.text
    const span = locatePreviewSpan(streaming, fileText)
    if (span === null) {
      this.skippedPreview = streaming.toolCallId
      return
    }
    const { from, to } = span
    const base = fileText ?? ''
    this.activeOverlay = {
      toolCallId: streaming.toolCallId,
      gadgetId: streaming.gadgetId,
      path: streaming.path,
      base, from, to,
      text: streaming.text,
    }
    // Bring open editors to the previewed state in one dispatch: the span replaced by the text
    // streamed so far. (A file being created has no open editor yet -- the overlay makes it
    // appear in the file list, and an editor opened on it builds from getText().)
    if (from !== to || streaming.text !== '') {
      this.host.dispatchFileChange(streaming.gadgetId, streaming.path,
        { edit: replaceSpanTextChange(base.length, from, to, streaming.text) })
    }
    this.host.onContentChanged()
  }

  /**
   * The preview state's display overrides for a gadget: each previewed file shows its preview
   * text -- the streaming overlay's, or its newest finished (pending) preview's.
   */
  previewOverridesFor(gadgetId: WorkpieceId): Map<string, string> {
    const overrides = new Map<string, string>()
    for (const [key, chain] of this.pendingPreviews) {
      if (chain.length === 0) continue
      const [ownerId, path] = splitFileKey(key)
      if (ownerId === gadgetId) overrides.set(path, chain[chain.length - 1].text)
    }
    const overlay = this.activeOverlay
    if (overlay !== null && overlay.gadgetId === gadgetId) {
      overrides.set(overlay.path, previewedText(overlay))
    }
    return overrides
  }

  /**
   * The previewed text a freshly (re)built editor should start from for a file previews cover:
   * the streaming overlay's (subsequent deltas continue from it), else the newest finished
   * preview's (still displayed while awaiting its row). Undefined when no preview covers it.
   */
  previewedFileText(gadgetId: WorkpieceId, path: string): string | undefined {
    const overlay = this.activeOverlay
    if (overlay !== null && overlay.gadgetId === gadgetId && overlay.path === path) {
      return previewedText(overlay)
    }
    const chain = this.pendingPreviews.get(fileKey(gadgetId, path))
    if (chain !== undefined && chain.length > 0) {
      return chain[chain.length - 1].text
    }
    return undefined
  }

  /**
   * Drop all state: the host is tearing down the editor sessions these overlays were dispatched
   * into (a chat/client switch), so there is nothing to restore into.
   */
  reset(): void {
    this.handleCoarseReset()
    this.baseReads.clear()
  }

  // The file's real (non-previewed) text: the chat's content when it holds the path (or shows
  // it removed), else the path's text at the selected gadget's content base. `undefined` while
  // still loading -- a base text not yet in the store is fetched, and attachment retried when it
  // lands (`text` is cumulative, so attaching late loses nothing). Only the selected gadget's
  // base is known; another gadget's preview attaches once selected.
  private resolveRealText(gadgetId: WorkpieceId, path: string): { text?: string } | undefined {
    if (!this.host.clientReady()) return undefined
    const held = this.host.clientFileText(gadgetId, path)
    if (held !== undefined) return typeof held === 'string' ? { text: held } : {}
    const base = this.host.baseFileText(gadgetId, path)
    if (base === undefined) {
      const readKey = fileKey(gadgetId, path)
      if (!this.baseReads.has(readKey)) {
        this.baseReads.add(readKey)
        this.host.requestBaseText(gadgetId, path, loaded => {
          this.baseReads.delete(readKey)
          if (loaded) this.retryAttach()
        })
      }
      return undefined
    }
    return base !== null ? { text: base } : {}
  }

  // Restore one file's open editors to what the display shows without the streaming overlay:
  // its newest pending preview, else the real content (skipped while that is still loading --
  // rare, and the next row or reset settles it).
  private restoreFileDoc(gadgetId: WorkpieceId, path: string): void {
    const chain = this.pendingPreviews.get(fileKey(gadgetId, path))
    let text: string | undefined
    if (chain !== undefined && chain.length > 0) {
      text = chain[chain.length - 1].text
    } else {
      const real = this.resolveRealText(gadgetId, path)
      if (real === undefined) return
      text = real.text
    }
    this.host.dispatchFileChange(gadgetId, path, text !== undefined ? { set: text } : { remove: true })
  }

  // The text a preview of `path` stacks on: the newest finished preview of the file (the agent
  // computed its edit against content that includes that call's edit, whose row hasn't landed
  // yet), else the real text. Undefined while the real text is still loading.
  private previewBaseText(gadgetId: WorkpieceId, path: string): { text?: string } | undefined {
    const chain = this.pendingPreviews.get(fileKey(gadgetId, path))
    if (chain !== undefined && chain.length > 0) return { text: chain[chain.length - 1].text }
    return this.resolveRealText(gadgetId, path)
  }

  // Move finished previews whose base text has since arrived onto their files' pending chains,
  // in call order, dispatching each file's resulting text to its open editors. A preview whose
  // base is still loading blocks only the later previews of its own file (they stack on it);
  // other files' previews proceed.
  private attachDeferred(): void {
    const deferred = this.deferredPreviews
    const blocked = new Set<string>()
    for (let i = 0; i < deferred.length;) {
      const preview = deferred[i]
      const key = fileKey(preview.gadgetId, preview.path)
      const base = blocked.has(key) ? undefined : this.previewBaseText(preview.gadgetId, preview.path)
      if (base === undefined) {
        blocked.add(key)
        i++
        continue
      }
      deferred.splice(i, 1)
      const span = locatePreviewSpan(preview, base.text)
      if (span === null) continue  // no unique match: nothing to show (see locatePreviewSpan)
      const fileText = base.text ?? ''
      const text = fileText.slice(0, span.from) + preview.text + fileText.slice(span.to)
      let chain = this.pendingPreviews.get(key)
      if (chain === undefined) {
        chain = []
        this.pendingPreviews.set(key, chain)
      }
      chain.push({ toolCallId: preview.toolCallId, text })
      this.host.dispatchFileChange(preview.gadgetId, preview.path, { set: text })
      this.host.onContentChanged()
    }
  }

  // End the streaming preview's delta stream, keeping its final text displayed as a pending
  // entry until its durable row (or a clear) resolves it -- restoring the file here would make
  // each edit vanish until the calls execute, which happens only after the whole model response
  // has streamed. One that never attached because its base text is still loading is deferred
  // rather than dropped: with content read lazily, a short edit followed by the next call
  // routinely finishes inside that read's round trip.
  private finalizeStreaming(): void {
    const streaming = this.streamingPreview
    this.streamingPreview = null
    const overlay = this.activeOverlay
    if (overlay === null) {
      if (streaming !== null && this.skippedPreview !== streaming.toolCallId) {
        this.deferredPreviews.push(streaming)
      }
      return
    }
    this.activeOverlay = null
    const key = fileKey(overlay.gadgetId, overlay.path)
    let chain = this.pendingPreviews.get(key)
    if (chain === undefined) {
      chain = []
      this.pendingPreviews.set(key, chain)
    }
    chain.push({ toolCallId: overlay.toolCallId, text: previewedText(overlay) })
  }
}
