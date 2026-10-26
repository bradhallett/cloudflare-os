# Org-grant UI wiring for the Context Library SPA (branch bradhallett/context-org-ui)

Wires PR #51's org-grant API (`shareContextCollectionWithOrg`, `createContextCollection(..., ownerOrgId)`,
`subject: "org"` sharing rows) into the gatekeeper-context management SPA, using the membership snapshots
PR #63's producers (`AppUiContext.orgMemberships` → `syncOrgMemberships`) record. All changes are inside
`packages/gatekeeper-context`; no kernel/workshop-shared changes were needed.

## API addition (gatekeeper-context only)

- `ContextApi.getViewerInfo()` now returns `orgs: ContextViewerOrg[]` — the viewer's recorded org
  memberships (`UserLibraryDurableObject.listOrgMemberships`), i.e. exactly the orgs the backend's
  `#assertActorInOrg` and create-for-org gate accept. The SPA's org picker and owner choice therefore
  can only offer orgs the API would actually let the viewer spend.
- New exported type `ContextViewerOrg = { orgId: string; role: "owner" | "admin" | "member" }` in
  `src/context-types.ts`. It mirrors `GatekeeperOrgMembership` structurally rather than importing it:
  the app's DOM TypeScript program cannot resolve the Workers types that module pulls in (same reason
  `app/bridge.ts` mirrors picker types).

No other read/list API was missing: `getContextCollectionSharing` already returns org grant rows
(`subject: "org"`, `memberId` = org id), and `setContextCollectionMemberRole` /
`removeContextCollectionMember` already route by subject.

## SPA changes

- **Share dialog** (`app/skills/ShareCollectionDialog.tsx`)
  - Loads `getViewerInfo()` alongside sharing/permissions; an "Add organization" menu offers the
    viewer's recorded orgs that don't already hold a grant (granted orgs are member rows, not add
    targets). Choosing one calls `shareContextCollectionWithOrg(collectionId, orgId, role)` with the
    role already selected in the "Add users with role" control; backend refusals surface in the
    dialog's error banner. Hidden entirely when the viewer has no addable orgs.
  - Org grants render as member rows (`Organization {orgId}`, Buildings avatar) with the same
    role/remove controls as accounts; role changes go through `setContextCollectionMemberRole`, and
    the last-owner guard applies across both grant stores exactly as the backend enforces it.
  - Org display is the opaque org id only: the Workshop contract carries no org name to gatekeepers
    (`getSharing` documents the same limitation). No invented names.
- **Create dialog** (`app/skills/CreateCollectionDialog.tsx`): an "Owner" radio group ("Just me" /
  one entry per org the viewer owns or administers) appears for private collections when such orgs
  exist, passing `ownerOrgId` to `createContextCollection`. Member-role orgs are never offered; a
  hidden choice (public visibility) is never spent. Owner semantics per `collection-access.ts`:
  the org holds the owner grant, its owners/admins govern, members can edit and share.
- **Data hook** (`app/skills/useSkillsNavigatorData.ts`): threads `viewerInfo.orgs` through with a
  fail-closed `orgs: []` fallback.

## Tests

- `app/skills/ShareCollectionDialog.test.tsx`: org share at the chosen role; already-granted orgs are
  rows, not menu items; backend refusal message surfaced; org-row role change routes by org id.
- `app/skills/CollectionDialogs.test.tsx`: org-owned creation passes `ownerOrgId`; only owner/admin
  orgs offered; personal default passes `undefined`.
- `__tests__/org-grants.test.ts` (workerd): `getViewerInfo().orgs` reports recorded memberships and
  follows resyncs.

Runs (all exit 0): `pnpm --filter @gadgets/gatekeeper-context test:run` → **104** (workerd, 7 files) +
**92** (node, 15 files) passed; `pnpm exec vp run -F gatekeeper-context test` → 3/3 tasks successful;
`pnpm --filter @gadgets/gatekeeper-context build` (typecheck:app + build:app + worker tsc) clean;
root `pnpm lint` → 88/88 successful.

## App bundle note (deviation from task letter)

`src/generated/app.txt` was rebuilt via the package's own path (`build:app` → `build-app.ts` → vite
`vite.app.config.ts`, 2321 KiB, byte-stable across rebuilds). It is **not committed**: commit a40dabdd
deliberately untracked it and `.gitignore` (line 10, `packages/gatekeeper-*/src/generated/app.txt`)
excludes it — `pnpm build` / CI regenerate it. Force-adding a ~2.3 MB generated blob would reverse that
repo decision; flagging here in case the coordinator wants it committed anyway (`git add -f`).

## Not changed

- The everyoneCanView row ("Anyone in organization") keeps its existing copy and behavior — it is the
  domain-wide read toggle, distinct from org grants, and relabeling it was out of scope.
- The `subject: "account"` default keeps older callers reading plain member ids (PR #51 contract).
