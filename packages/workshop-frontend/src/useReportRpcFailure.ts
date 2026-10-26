import { useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { rpcFailureDescription } from './rpcErrors'

/**
 * The one error-toast idiom for a failed RPC action: log the failure loudly, then toast with a
 * title that names the action and the server's sanitized own account (`rpcFailureDescription`)
 * as the description, so transport and runtime strings never reach the user. Cancellation and
 * transient-classification stay the caller's business; this always reports.
 */
export function useReportRpcFailure(): (title: string, err: unknown) => void {
  const toasts = useKumoToastManager()
  return useCallback((title: string, err: unknown) => {
    console.error(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }, [toasts])
}
