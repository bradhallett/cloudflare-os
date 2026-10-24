// The SaaS build's outermost shell: chrome that SaaS-only surfaces (org admin, billing, …) will
// mount inside. Loaded as its own chunk via ./saasRoute so it ships only in `VITE_SAAS` builds.
// Mechanism only — the shell is empty until those surfaces exist.

/**
 * The empty SaaS shell: a full-height main region awaiting the SaaS-only surfaces. Never imported
 * by OSS builds — `saasRoute.tsx`'s gate keeps this module (and its chunk) out of them entirely.
 * Default export because `React.lazy()` (in saasRoute.tsx) resolves the chunk's `default`.
 */
export default function SaasShell() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <main data-testid="saas-shell" className="min-h-0 flex-1 overflow-y-auto" />
    </div>
  )
}
