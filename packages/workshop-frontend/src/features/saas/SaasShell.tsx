// The SaaS build's outermost shell: routes the SaaS-only pages that mount at /saas. Loaded as
// its own chunk via ./saasRoute so it ships only in `VITE_SAAS` builds; every page it mounts is
// a plain import inside this chunk, so no SaaS code reaches an OSS bundle. Never imported by
// OSS builds — `saasRoute.tsx`'s gate keeps this module (and its chunk) out of them entirely.
// Default export because `React.lazy()` (in saasRoute.tsx) resolves the chunk's `default`.

import SaasStart from './SaasStart'
import CheckoutReturn from './CheckoutReturn'

/** The signup → org → checkout funnel. */
const START_PATH = '/saas/start'
/** Polar's success return target, which polls until the subscription is active. */
const RETURN_PREFIX = '/saas/checkout/return'

export default function SaasShell() {
  // The location is read from the browser, not the router: the shell mounts inside the router's
  // root route, but /saas pages never route client-side — every exit is a full navigation
  // (checkout and return are external round-trips), so the pathname at mount is the whole truth.
  const pathname = window.location.pathname

  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <main data-testid="saas-shell" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pathname.startsWith(START_PATH) && <SaasStart />}
        {pathname.startsWith(RETURN_PREFIX) && <CheckoutReturn />}
        {/* Unknown /saas paths render the empty shell; the router redirects stray URLs. */}
      </main>
    </div>
  )
}
