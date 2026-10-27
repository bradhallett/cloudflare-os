import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { AccountDescription } from '@gadgets/workshop-shared/gatekeeper'
import { openConnectWindow } from './connectHandoff'
import { AuthPopupCancelledError } from './features/native-app/authPopup'
import { useReportRpcFailure } from './useReportRpcFailure'

/** What the actions call on the authenticated API; a plain structural pick so both the interface and its RpcStub fit. */
export type ConnectAccountApi = Pick<AuthenticatedApi,
  'connectAccount' | 'ensureAccountResources' | 'reconnectAccount' |
  'provisionAmbientAccount' | 'completeConnectHandoff'>

/** How a connect-style flow ended; `undefined` means it failed or the user cancelled the pop-up. */
export type ConnectOutcome =
  | 'opened' // the OAuth pop-up is open; completion arrives through subscribeConnectedAccounts()
  | 'connected' // redeemed in-app (native); the account is live
  | 'provisioned' // an ambient gatekeeper minted the account directly, no OAuth
  | 'already-granted' // the gatekeeper confirmed the access without an OAuth flow

/** Per-call adjustments to a connect / grant / reconnect action. */
export type ConnectActionOptions = {
  /** Overrides the standard failure-toast title for this call (e.g. to name the vendor). */
  errorTitle?: string
  /** Replaces the default failure log + toast; the call site then owns the error surface entirely. */
  onError?: (err: unknown) => void
  /** Aborts the pop-up wait (native connect cancellation). */
  signal?: AbortSignal
  /** Holds the busy flag for this long after the flow settles, for UI that catches up via a subscription. */
  busyHoldMs?: number
  /**
   * Leaves the busy flag set after the pop-up opens (the accounts subscription reports the real
   * outcome later); a failure or cancellation still releases it. Clear it with
   * `clearReconnecting`.
   */
  holdBusy?: boolean
}

const CONNECT_FAILED = 'Could not complete connection flow'
const GRANT_FAILED = 'Failed to request additional access'
const RECONNECT_FAILED = 'Could not complete reconnect flow'

/**
 * The connect / grant-resources / reconnect flow every account surface shares: set the busy flag,
 * run the flow as a disowned pop-up, swallow user cancellation quietly, and toast any other
 * failure. Busy state is per action, so a pending connect does not disable unrelated buttons.
 */
export function useConnectAccountActions(api: ConnectAccountApi | null | undefined): {
  /** The vendor a connect flow is starting for, if any. */
  connectingVendor: string | null
  /** The account a resource grant is being requested for, if any. */
  grantingAccountId: number | null
  /** The account being re-authenticated, if any. */
  reconnectingAccountId: number | null
  /** Starts an OAuth connect flow for `vendorId`, optionally pre-requesting resource patterns. */
  connect: (vendorId: string, resourceUrlPatterns?: string[], options?: ConnectActionOptions) => Promise<ConnectOutcome | undefined>
  /** Adds an ambient gatekeeper's account directly (no OAuth redirect). */
  connectAmbient: (vendorId: string, options?: ConnectActionOptions) => Promise<ConnectOutcome | undefined>
  /** Requests grants covering `resourceUrlPatterns` on a connected account. */
  grant: (accountId: number, resourceUrlPatterns: string[], options?: ConnectActionOptions) => Promise<ConnectOutcome | undefined>
  /** Restarts authentication for an account whose credentials expired. */
  reconnect: (accountId: number, options?: ConnectActionOptions) => Promise<ConnectOutcome | undefined>
  /** Releases a held reconnect flag when the accounts subscription reports `accountId` back. */
  clearReconnecting: (accountId: number) => void
} {
  const reportFailure = useReportRpcFailure()
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [grantingAccountId, setGrantingAccountId] = useState<number | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)
  // Busy-hold timers still pending, cleared on unmount so a late release can't touch dead state.
  const heldTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    const timers = heldTimers.current
    return () => { for (const timer of timers) clearTimeout(timer) }
  }, [])

  const run = useCallback(async <T>(
    setBusy: (target: T | null) => void,
    target: T,
    failedTitle: string,
    options: ConnectActionOptions | undefined,
    flow: (api: ConnectAccountApi) => Promise<ConnectOutcome>,
  ): Promise<ConnectOutcome | undefined> => {
    if (!api) return undefined
    setBusy(target)
    try {
      const outcome = await flow(api)
      if (options?.holdBusy) return outcome
      const hold = options?.busyHoldMs ?? 0
      if (hold <= 0) {
        setBusy(null)
      } else {
        const timer = setTimeout(() => {
          heldTimers.current.delete(timer)
          setBusy(null)
        }, hold)
        heldTimers.current.add(timer)
      }
      return outcome
    } catch (err) {
      // Cancellation and failure both release the busy flag; only the held case waits for the
      // subscription, and that contract is about success, not errors.
      setBusy(null)
      if (err instanceof AuthPopupCancelledError) return undefined
      if (options?.onError) options.onError(err)
      else reportFailure(options?.errorTitle ?? failedTitle, err)
      return undefined
    }
  }, [reportFailure])

  const connect = useCallback((
    vendorId: string, resourceUrlPatterns?: string[], options?: ConnectActionOptions,
  ) => run(setConnectingVendor, vendorId, CONNECT_FAILED, options, async (live) =>
    openConnectWindow(await live.connectAccount(vendorId, resourceUrlPatterns), live, options?.signal)),
  [run])

  const connectAmbient = useCallback((vendorId: string, options?: ConnectActionOptions) =>
    run(setConnectingVendor, vendorId, CONNECT_FAILED, options, async (live) => {
      await live.provisionAmbientAccount(vendorId)
      return 'provisioned'
    }),
  [run])

  const grant = useCallback((
    accountId: number, resourceUrlPatterns: string[], options?: ConnectActionOptions,
  ) => run(setGrantingAccountId, accountId, GRANT_FAILED, options, async (live) => {
    const flow = await live.ensureAccountResources(accountId, resourceUrlPatterns)
    if (!flow) return 'already-granted'
    return openConnectWindow(flow, live, options?.signal)
  }),
  [run])

  const reconnect = useCallback((accountId: number, options?: ConnectActionOptions) =>
    run(setReconnectingAccountId, accountId, RECONNECT_FAILED, options, async (live) =>
      openConnectWindow(await live.reconnectAccount(accountId), live, options?.signal)),
  [run])

  const clearReconnecting = useCallback((accountId: number) => {
    setReconnectingAccountId(prev => prev === accountId ? null : prev)
  }, [])

  // `api` flows through `run`, which guards it; the callbacks close over `run` only.
  return {
    connectingVendor,
    grantingAccountId,
    reconnectingAccountId,
    connect,
    connectAmbient,
    grant,
    reconnect,
    clearReconnecting,
  }
}

/**
 * The optimistic patch for a grant that needed no OAuth flow: merges `patterns` into the
 * description's granted set so the UI reflects the access the gatekeeper just confirmed.
 */
export function mergeGrantedPatterns(
  description: AccountDescription, patterns: string[],
): AccountDescription {
  return {
    ...description,
    grantedResourceUrlPatterns: [
      ...new Set([...(description.grantedResourceUrlPatterns ?? []), ...patterns]),
    ],
  }
}
