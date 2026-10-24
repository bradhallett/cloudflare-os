// The compile-time gate between OSS and SaaS frontend builds, and the shell it mounts. Vite
// replaces `import.meta.env.VITE_SAAS` with a literal in every build, so `SAAS_MODE` folds to a
// constant and everything it gates folds with it: in an OSS build the lazy `import()` below is
// dropped, the shell's chunk is never emitted, and no SaaS code or strings reach the bundle.
// Runtime, server-resolved SaaS mode is a separate channel — see `useSaasEnabled()`.

import { lazy, Suspense } from 'react'

/** Whether this bundle was built with SaaS surfaces (`VITE_SAAS=true` at build time). */
export const SAAS_MODE = import.meta.env.VITE_SAAS === 'true'

/** URL prefix under which SaaS-only surfaces mount. */
export const SAAS_ROUTE_BASE = '/saas'

// The shell loads as its own chunk, so SaaS-only code ships only in builds that render it. The
// ternary — rather than a bare `lazy()` call — keeps the call, and the `import()` inside it,
// inside the foldable gate.
const SaasShell = SAAS_MODE ? lazy(() => import('./SaasShell')) : null

/** Whether `pathname` addresses a SaaS-only surface. Always false in an OSS build. */
export const isSaasRoute = (pathname: string): boolean =>
  SAAS_MODE && pathname.startsWith(SAAS_ROUTE_BASE)

/** Renders the SaaS shell for the current location; renders nothing in an OSS build. */
export const SaasSurface = () => {
  if (!SaasShell) return null
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-kumo-base">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
        </div>
      }
    >
      <SaasShell />
    </Suspense>
  )
}
