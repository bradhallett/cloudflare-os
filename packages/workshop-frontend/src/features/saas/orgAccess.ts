import type { OrgSummary } from '@gadgets/workshop-shared/api';

/**
 * Whether a membership may administer its org: an active membership (not a pending
 * invitation) held by an owner or admin. Admin-gated org actions (billing, settings)
 * re-check the role on the server; this is the shared client-side predicate for deciding
 * what to offer, taking any membership shape that carries `role` and `status`.
 */
export const canAdministerOrg = (org: Pick<OrgSummary, 'role' | 'status'>): boolean =>
  org.status === 'active' && (org.role === 'owner' || org.role === 'admin')
