import { useEffect, useRef, useState } from 'react'
import { RpcStub } from 'capnweb'
import { useKumoToastManager } from '@cloudflare/kumo'
import { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from './rpcErrors'

/** What a mounted vendor-catalog fetch currently knows. */
export interface VendorCatalog {
  /** Vendors that can be connected right now; unavailable ones are filtered out with a warning. */
  vendors: GatekeeperVendorInfo[]
  /** True while the first fetch for this API is in flight (a snapshot seed renders instantly). */
  loading: boolean
  /** True when the fetch failed; `vendors` holds whatever the session last knew. */
  failed: boolean
}

// Last catalog per API stub, so a remounting consumer (the resource picker) renders the
// previous catalog immediately while its refresh is in flight.
const sessionCatalogs = new WeakMap<RpcStub<AuthenticatedApi>, GatekeeperVendorInfo[]>()

/**
 * The gatekeeper vendor catalog for connect surfaces: fetches `listGatekeeperVendors`,
 * keeps unavailable vendors out of the connectable list, and raises the one "some services
 * are temporarily unavailable" warning toast (see GatekeeperVendorInfo.unavailable — UIs
 * must surface unavailable vendors, not offer them). Fetch failures are logged here; react
 * to `failed` for a surface-specific error state.
 */
export function useVendors(api: RpcStub<AuthenticatedApi> | null): VendorCatalog {
  // The manager can be a fresh object per render (tests mock it that way); the fetch effect
  // below must depend on `api` alone, so it reads the manager through a ref.
  const toastsRef = useRef(useKumoToastManager())
  const [catalog, setCatalog] = useState<VendorCatalog>(() => {
    const seeded = api ? sessionCatalogs.get(api) : undefined
    return seeded ? { vendors: seeded, loading: false, failed: false }
      : { vendors: [], loading: api !== null, failed: false }
  })

  useEffect(() => {
    if (!api) {
      setCatalog({ vendors: [], loading: false, failed: false })
      return
    }
    let cancelled = false
    api.listGatekeeperVendors()
      .then(list => {
        if (cancelled) return
        const unavailable = list.filter(vendor => vendor.unavailable)
        if (unavailable.length > 0) {
          toastsRef.current.add({
            title: `Some services are temporarily unavailable: ${unavailable.map(v => v.id).join(', ')}`,
            variant: 'warning',
          })
        }
        const vendors = list.filter(vendor => !vendor.unavailable)
        sessionCatalogs.set(api, vendors)
        setCatalog({ vendors, loading: false, failed: false })
      })
      .catch(err => {
        if (cancelled) return
        logRpcFailure('Failed to load available services:', err)
        setCatalog(prev => ({ ...prev, loading: false, failed: true }))
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return catalog
}
