# Tenancy: organizations

The Workshop's tenant primitive is the **organization**: a group of accounts that will later own
gadgets, context collections, and other resources together. This note records the model the
`OrgDurableObject` implements (`packages/workshop-backend/src/org.ts`); the org-scoped surfaces
built on it are separate changes.

## Identity vs membership

Identity is unchanged: one global `UserDurableObject` per person, keyed by their canonical user id
(email for Access / sign-in accounts, username for password accounts). **Membership is the tenant
dimension** — one person in two orgs is one user object and two memberships, the Slack model.
Deployment admins (the `ADMINS` env list) are operators, not tenants, and stay as they are.

## One Durable Object per org

Each org is one `OrgDurableObject`, named by the org's random id (`randomOrgId()`), created on
`AuthenticatedApi.createOrg()`. It owns the org's record, settings, members, and invitations
(`storage-schema/org-storage.ts`), and every permission check happens inside it, never in a
caller. `org-access.ts` is the one policy module that interprets an org's records, mirroring the
Context Library's `collection-access.ts`:

- **Roles** are `owner` / `admin` / `member`, ranked; nobody acts above or grants a role above
  their own. Owners manage roles and settings; admins manage members; members belong.
- **Last-owner protection**: an operation that would leave the org with no owner — demoting,
  removing, or the sole owner leaving — is refused, exactly as removing a collection's last owner
  is.
- **Invitations** are keyed by invitee (who need not have signed in yet), last seven days, and are
  swept lazily rather than by alarm: an expired one is unacceptable the moment it expires
  (`acceptInvitation` re-checks), and the sweep deletes it with the `invited` member record
  shadowing it. Re-inviting refreshes the pending invitation.

## Authority and the user's index

The org's `members` collection is the **sole authority** on membership. Each membership change is
mirrored into the member's user DO (`syncOrgMembership`), whose `orgMemberships` collection is a
**discovery index**: it lets `listMyOrgs()` find the orgs in one read of the user's own object,
and nothing more. Every org read re-checks membership live — `describeForMember` answers null for
a stale index entry — so a lost or late mirror costs staleness, never authority.

## Lazy revocation

Removing a membership revokes nothing downstream. Org-derived access (org-owned gadgets, Context
Library org grants, SCIM-provisioned members) holds its grant and **re-checks** the org when
access matters. A removed member's access therefore ends at the next check, without cascading
deletes across resource owners, and a later re-add restores it seamlessly. The authority read
differs by surface: per-user surfaces ask `getMember(userId)` (Context Library grants,
SCIM-provisioned members), while an org-owned *workspace* snapshots the org's whole active
membership (`activeMembers()`) into its sharing graph's baselines at every `open()`
(docs/sharing.md) — and the org additionally fans every membership removal, leave, or demotion
out through its `ownedGadgets` index, so those workspaces' live sessions are severed at once
rather than at each user's next open.

## Org-scoped user directory

`AuthenticatedApi.searchUsers` and the gatekeeper user picker are scoped to the caller's
**directory scope**: the active members of the orgs the user belongs to, plus the owners of
workspaces shared with them (`UserDurableObject.getDirectoryScope()`). The user's membership
index names the orgs, but each org's own member listing — an actor-checked read — names the
people, so the scope is computed live and fails closed: an org that cannot be read (membership
ended, mirror lost, read failed) contributes nothing, and a deployment without orgs falls back to
share partners alone. No query can enumerate users outside the scope; the directory DO itself
accepts an explicit scope only (`searchUsers(query, excludeIds, includeIds)`).

A picker ticket (`createGatekeeperUserSelection`) records the orgs that justified the pick
(`orgIds`), and redemption re-checks them live — the same lazy-revocation contract as above, so a
removed member's pending picks die at redemption. A ticket justified by a share relationship
(empty `orgIds`) instead requires that relationship to still stand.

## Observability

Org events are logged under the `workshop.org` component (`org.created`, `org.member.invited`,
`org.member.joined`, `org.member.role_changed`, `org.member.removed`, `org.member.left`,
`org.settings.updated`) carrying `orgId` and, where one was granted or changed, `orgRole`. Member
user ids never enter org logs.
