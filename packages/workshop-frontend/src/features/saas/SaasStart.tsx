// The SaaS signup funnel at /saas/start: create (or sign into) an account, create the
// organization, pick a plan and seat count, then redirect the browser to the checkout session
// the commerce service minted. Polar's hosted checkout takes it from there; on success it
// returns the browser to /saas/checkout/return (CheckoutReturn), which waits for the org's
// subscription to activate. Only reachable in VITE_SAAS builds — SaasShell mounts this page,
// and saasRoute.tsx folds that shell out of OSS bundles entirely.

import { useEffect, useMemo, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { AuthenticatedApi, CommercePlan } from '@gadgets/workshop-shared/api'
import { Button } from '@cloudflare/kumo'
import { useRpcStub } from '../../RpcContext'
import { hashPassword } from '../../passwordHash'
import { rpcFailureDescription } from '../../rpcErrors'
import { INPUT_LG } from '../../components/inputStyles'

/** One step of the funnel; the card keeps its height between steps so the page doesn't jump. */
function Step({ title, children, footer }: {
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div data-testid="saas-signup-funnel" className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-6">
      <h1 className="text-lg font-semibold text-kumo-default">{title}</h1>
      {children}
      {footer}
    </div>
  )
}

export default function SaasStart() {
  const publicApi = useRpcStub()
  const [step, setStep] = useState<'account' | 'org' | 'plan'>('account')
  const [mode, setMode] = useState<'create' | 'signin'>('create')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [orgName, setOrgName] = useState('')
  const [plans, setPlans] = useState<CommercePlan[] | null>(null)
  const [seats, setSeats] = useState(1)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The authenticated stub for a stored token, pipelined like useAuth does; replaced whenever
  // the account step mints a fresh token.
  const [token, setToken] = useState(() => localStorage.getItem('authToken'))
  const authed = useMemo<RpcStub<AuthenticatedApi> | null>(
    () => (token === null ? null : publicApi.authenticate(token)),
    [publicApi, token])

  // A fresh token replaces the stub above; release the old one's server-side resources when it
  // goes (dispose is idempotent, so the unmount path is safe even after a replacement).
  useEffect(() => () => { authed?.[Symbol.dispose]() }, [authed])

  // A stored session that still answers skips the account step; a stale one falls back to it.
  useEffect(() => {
    if (authed === null) return
    let cancelled = false
    authed.whoami()
      .then(() => { if (!cancelled) setStep('org') })
      .catch(() => { if (!cancelled) setToken(null) })
    return () => { cancelled = true }
  }, [authed])

  // The plan step needs the catalog; load it once the org exists.
  useEffect(() => {
    if (step !== 'plan' || authed === null || plans !== null) return
    authed.listCommercePlans()
      .then((list) => setPlans(list.filter((plan) => plan.id !== 'free')))
      .catch(() => setPlans([]))
  }, [step, authed, plans])

  const submitAccount = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const passwordHash = await hashPassword(username, password)
      const minted = mode === 'create'
        ? await publicApi.createAccount(username, username, passwordHash)
        : await publicApi.login(username, passwordHash)
      if (minted === null) {
        setError(mode === 'create'
          ? 'That username is taken — sign in instead.'
          : 'Wrong username or password.')
        return
      }
      localStorage.setItem('authToken', minted)
      setToken(minted)
      setStep('org')
    } catch (err) {
      setError(rpcFailureDescription(err) ?? 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const submitOrg = async () => {
    if (authed === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const org = await authed.createOrg(orgName)
      setOrgId(org.id)
      setSeats(1)
      setStep('plan')
    } catch (err) {
      setError(rpcFailureDescription(err) ?? 'Could not create the organization.')
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (planId: string) => {
    if (authed === null || orgId === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const { url } = await authed.startOrgCheckout(orgId, planId, seats)
      window.location.assign(url)
    } catch (err) {
      setError(rpcFailureDescription(err) ?? 'Could not start checkout.')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-kumo-base p-6">
      {step === 'account' && (
        <Step
          title={mode === 'create' ? 'Create your account' : 'Sign in'}
          footer={
            <button
              type="button"
              onClick={() => { setMode(mode === 'create' ? 'signin' : 'create'); setError(null) }}
              className="cursor-pointer text-[13px] text-kumo-subtle underline-offset-2 hover:text-kumo-default hover:underline"
            >
              {mode === 'create' ? 'Already have an account? Sign in' : 'Need an account? Create one'}
            </button>
          }
        >
          <input
            className={INPUT_LG}
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className={INPUT_LG}
            type="password"
            placeholder="Password (8+ characters)"
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitAccount() }}
          />
          {error && <p className="text-[13px] text-kumo-danger">{error}</p>}
          <Button
            variant="primary"
            onClick={submitAccount}
            disabled={busy || !username.trim() || password.length < 8}
          >
            {mode === 'create' ? 'Create account' : 'Sign in'}
          </Button>
        </Step>
      )}

      {step === 'org' && (
        <Step title="Name your organization">
          <p className="text-[13px] text-kumo-subtle">
            Your organization owns the subscription; everyone you invite works under it.
          </p>
          <input
            className={INPUT_LG}
            placeholder="Organization name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitOrg() }}
          />
          {error && <p className="text-[13px] text-kumo-danger">{error}</p>}
          <Button variant="primary" onClick={submitOrg} disabled={busy || !orgName.trim()}>
            Create organization
          </Button>
        </Step>
      )}

      {step === 'plan' && (
        <Step title="Pick a plan">
          <label className="flex items-center gap-2 text-[13px] text-kumo-subtle">
            Seats
            <input
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
              className="h-9 w-24 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] text-kumo-default"
            />
          </label>
          <div className="flex flex-col gap-2">
            {(plans ?? []).map((plan) => (
              <Button key={plan.id} variant="primary" onClick={() => checkout(plan.id)} disabled={busy}>
                {plan.name}
              </Button>
            ))}
            {plans !== null && plans.length === 0 && (
              <p className="text-[13px] text-kumo-subtle">No plans are available on this deployment.</p>
            )}
          </div>
          {error && <p className="text-[13px] text-kumo-danger">{error}</p>}
        </Step>
      )}
    </div>
  )
}
