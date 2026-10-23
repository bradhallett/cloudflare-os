import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import type { FileChange } from '@gadgets/workshop-shared/code-change'

// The listener and preview maps of the code view are keyed by file: the workpiece id and the
// path joined by a NUL (a character neither can contain).
export function fileKey(gadgetId: WorkpieceId, path: string): string {
  return `${gadgetId}\u0000${path}`
}

/**
 * The per-file remote-delta listener registry behind an EditSession's subscribeRemote(): the
 * OT client pushes per-file changes here as its drain applies rows (see
 * ChatOtClientDelegate.onRemoteChange), and every editor bound to that file patches its
 * document from them.
 *
 * Subscriptions are generation-tagged because a wholesale editor reload (a coarse client
 * reset, a drifted local edit, an unpinned workpiece's accepted commit moving) re-keys the
 * EditSession as a React re-render -- which lands *after* the client's drain may have already
 * delivered further deltas, to the very sessions the reload is tearing down. Patching a doomed
 * session can throw on mismatched offsets (surfacing as a client-fatal) or silently mis-patch
 * a document no one will see again. retire() -- called synchronously where the reload is
 * decided, before the re-render -- and the generation check in dispatch() close that window:
 * deltas racing the reload are dropped (the rebuilt editor loads the client's post-drain
 * content wholesale), while subscriptions taken after the reload, at the new generation,
 * receive everything from there on.
 */
export class RemoteFileListeners {
  #generation = 0
  #listeners = new Map<string, Set<{ generation: number; apply: (change: FileChange) => void }>>()

  /** Listen to one file's remote deltas; the returned function unsubscribes. */
  subscribe(gadgetId: WorkpieceId, path: string, apply: (change: FileChange) => void): () => void {
    let listeners = this.#listeners.get(fileKey(gadgetId, path))
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(fileKey(gadgetId, path), listeners)
    }
    const subscription = { generation: this.#generation, apply }
    listeners.add(subscription)
    return () => {
      listeners.delete(subscription)
      if (listeners.size === 0) this.#listeners.delete(fileKey(gadgetId, path))
    }
  }

  /** Deliver one remote delta to the file's current-generation listeners. */
  dispatch(gadgetId: WorkpieceId, path: string, change: FileChange): void {
    const generation = this.#generation
    this.#listeners.get(fileKey(gadgetId, path))
      ?.forEach(({ generation: subscribed, apply }) => {
        if (subscribed === generation) apply(change)
      })
  }

  /**
   * Retire every subscription taken so far. Must be called synchronously with the reload
   * decision (never from an effect that runs after editors have re-subscribed), so that
   * dispatches before the re-render reach no doomed session and dispatches after it reach the
   * fresh subscriptions.
   */
  retire(): void {
    this.#generation += 1
  }
}
