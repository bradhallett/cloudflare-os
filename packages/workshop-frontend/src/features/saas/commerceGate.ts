// The compile-time gate for the SaaS commerce surfaces that mount inside otherwise-shared UI
// (the settings page's billing section, the user menu's org switcher, the upgrade prompt that
// replaces the out-of-credits modal). Same fold as saasRoute.tsx: Vite replaces
// `import.meta.env.VITE_SAAS` with a literal, so `SAAS_MODE` folds to a constant, every ternary
// below folds with it, and in an OSS build the lazy `import()`s are dropped — no SaaS code or
// strings reach the bundle. Shared components import from here rather than from the SaaS modules
// directly, which is what keeps that fold intact.
//
// `planRefusalPrompt` is the catch-site companion: it reads a plan-refusal code off an error in
// SaaS builds (and only there), so a caller can open the upgrade prompt instead of its generic
// error handling while OSS builds keep their existing behavior untouched.

import { lazy } from 'react'
import type { PlanRefusalCode } from '@gadgets/workshop-shared/api'
import { getPlanRefusalCode } from '@gadgets/workshop-shared/api'
import { SAAS_MODE } from './saasRoute'

/** The org billing section of the settings page; null in an OSS build. */
export const OrgBillingSection = SAAS_MODE ? lazy(() => import('./OrgBillingSettings')) : null

/** The user menu's org switcher; null in an OSS build. */
export const OrgSwitcherMenu = SAAS_MODE ? lazy(() => import('./OrgSwitcherMenu')) : null

/** The upgrade prompt shown at plan-enforcement points; null in an OSS build. */
export const SaasUpgradeModal = SAAS_MODE ? lazy(() => import('./UpgradePromptModal')) : null

/**
 * The refusal code on `error`, in SaaS builds only: a catch site that gets one opens the upgrade
 * prompt in place of its generic error handling; `undefined` (always, in an OSS build) means
 * handle the error as before.
 */
export function planRefusalPrompt(error: unknown): PlanRefusalCode | undefined {
  return SAAS_MODE ? getPlanRefusalCode(error) : undefined
}
