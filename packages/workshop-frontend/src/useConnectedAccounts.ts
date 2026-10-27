import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, type AccountEvent } from './accountsSubscriber'
import { logRpcFailure } from './rpcErrors'

/** What a mounted accounts subscription currently knows. */
export interface ConnectedAccounts {
  /**
   * Every account the subscription has reported, keyed by id. Replays upsert (see
   * AccountsSubscriberAdapter), so an update keeps its place in arrival order.
   */
  accounts: ReadonlyMap<number, AccountEvent>
  /**
   * True once the subscription replayed its current accounts and called `ready()` — the
   * earliest moment the list is known complete. Resets while a fresh subscription runs.
   */
  ready: boolean
  /** True when subscribing itself failed; nothing more will arrive through this subscription. */
  failed: boolean
}

/** Adjustments to the accounts subscription a surface starts. */
export interface ConnectedAccountsOptions {
  /** Also reports accounts that were force-auto-provisioned (see subscribeConnectedAccounts). */
  includeForcedAutoProvisionedAccounts?: boolean
  /**
   * Seeds the first render from the session's last snapshot for this API, so a surface that
   * remounts often (the resource picker, on each typed URL) renders complete immediately
   * instead of growing a row at a time. Off by default for modals and pages: a seed can show
   * an account disconnected elsewhere, and replay has no remove event to correct it.
   */
  seedFromSession?: boolean
}

// Last snapshot per API stub, so `seedFromSession` consumers reopen complete.
const sessionSnapshots = new WeakMap<RpcStub<AuthenticatedApi>, ConnectedAccounts>()

const EMPTY: ConnectedAccounts = { accounts: new Map(), ready: false, failed: false }

/**
 * The one subscription to the user's connected accounts (the query-side counterpart to
 * useConnectAccountActions): every surface that needs to know which accounts exist reads
 * this hook instead of registering its own AccountsSubscriberAdapter. Failures are logged
 * here; react to `failed` for a surface-specific error toast or state.
 */
export function useConnectedAccounts(
  api: RpcStub<AuthenticatedApi> | null,
  { includeForcedAutoProvisionedAccounts = false, seedFromSession = false }: ConnectedAccountsOptions = {},
): ConnectedAccounts {
  const [state, setState] = useState<ConnectedAccounts>(
    // Re-seed only while the API stub is stable: an api change re-subscribes below.
    () => (seedFromSession && api ? sessionSnapshots.get(api) : undefined) ?? EMPTY)

  useEffect(() => {
    if (!api) {
      setState(EMPTY)
      return
    }
    const baseline = (seedFromSession ? sessionSnapshots.get(api) : undefined) ?? EMPTY
    setState(baseline)

    const accounts = new Map<number, AccountEvent>(baseline.accounts)
    let ready = baseline.ready
    const publish = (failed: boolean) => {
      const next: ConnectedAccounts = { accounts: new Map(accounts), ready, failed }
      if (ready) sessionSnapshots.set(api, next)
      setState(next)
    }

    const subscriber = new AccountsSubscriberAdapter({
      add(event) {
        accounts.set(event.id, event)
        publish(false)
      },
      remove(id) {
        if (!accounts.delete(id)) return
        publish(false)
      },
      ready() {
        ready = true
        publish(false)
      },
    })

    const subscription = api.subscribeConnectedAccounts(subscriber,
      includeForcedAutoProvisionedAccounts ? { includeForcedAutoProvisionedAccounts: true } : undefined)
    subscription.catch(err => {
      logRpcFailure('Failed to subscribe to connected accounts:', err)
      // Nothing more is coming, so publish what the subscription last knew.
      publish(true)
    })

    return () => {
      subscription[Symbol.dispose]()
    }
  }, [api, includeForcedAutoProvisionedAccounts, seedFromSession])

  return state
}
