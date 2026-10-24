// The checkout return page at /saas/checkout/return: Polar's hosted checkout sends the browser
// here on success (the successUrl the backend mints for startOrgCheckout). The webhook that
// activates the subscription races the redirect, so this page polls the org's billing overview
// until the derived plan leaves "free", then lands the user on their org's billing tab. Only
// reachable in VITE_SAAS builds — SaasShell mounts this page, and saasRoute.tsx folds that shell
// out of OSS bundles entirely.

import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { Button } from '@cloudflare/kumo'
import { useRpcStub } from '../../RpcContext'

/** How often the activation poll runs. */
const POLL_MS = 2000
/** How long to keep waiting for the subscription to activate before surfacing the failure UI. */
const GIVE_UP_AFTER_POLLS = 60

export default function CheckoutReturn() {
  const publicApi = useRpcStub()
  const [status, setStatus] = useState<'waiting' | 'active' | 'failed'>('waiting')
  const orgId = useRef(new URLSearchParams(window.location.search).get('org'))
  const token = localStorage.getItem('authToken')

  useEffect(() => {
    if (orgId.current === null || token === null) {
      setStatus('failed')
      return
    }
    // Pipelined like useAuth: usable immediately, errors surface on first call.
    const authed: RpcStub<AuthenticatedApi> = publicApi.authenticate(token)
    let cancelled = false
    let polls = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      polls++
      authed.getOrgBilling(orgId.current!)
        .then((billing) => {
          if (cancelled) return
          if (billing.plan !== 'free') {
            setStatus('active')
            window.location.assign(`/profile?org=${encodeURIComponent(orgId.current!)}`)
          } else if (polls >= GIVE_UP_AFTER_POLLS) {
            setStatus('failed')
          } else {
            timer = setTimeout(poll, POLL_MS)
          }
        })
        .catch(() => {
          if (cancelled) return
          if (polls >= GIVE_UP_AFTER_POLLS) setStatus('failed')
          else timer = setTimeout(poll, POLL_MS)
        })
    }
    poll()
    // Unmounting stops the poll timer and releases the server-side stub (dispose is idempotent,
    // so a poll in flight when the cleanup runs settles into `cancelled` and drops it).
    return () => {
      cancelled = true
      clearTimeout(timer)
      authed[Symbol.dispose]()
    }
  }, [publicApi, token])

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-kumo-base p-6">
      <div
        data-testid="saas-checkout-return"
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-6"
      >
        <h1 className="text-lg font-semibold text-kumo-default">Checkout</h1>
        {status === 'waiting' && (
          <>
            <p className="text-[13px] text-kumo-subtle">Finishing up — activating your subscription…</p>
            <div className="h-1 w-full overflow-hidden rounded-full bg-kumo-tint">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-kumo-brand" />
            </div>
          </>
        )}
        {status === 'active' && (
          <p className="text-[13px] text-kumo-subtle">Subscription active — taking you to billing…</p>
        )}
        {status === 'failed' && (
          <>
            <p className="text-[13px] text-kumo-subtle">
              We couldn't confirm the subscription yet. It may still be activating — check your
              organization's billing in a moment.
            </p>
            <Button variant="secondary" onClick={() => window.location.assign('/')}>
              Back to the workshop
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
