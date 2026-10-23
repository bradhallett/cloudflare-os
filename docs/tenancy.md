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
Library org grants, SCIM-provisioned members) holds its grant and **re-checks** the org —
`OrgDurableObject.getMember(userId)` is the authority read — when access matters. A removed
member's access therefore ends at the next check, without cascading deletes across resource
owners, and a later re-add restores it seamlessly.

## Observability

Org events are logged under the `workshop.org` component (`org.created`, `org.member.invited`,
`org.member.joined`, `org.member.role_changed`, `org.member.removed`, `org.member.left`,
`org.settings.updated`) carrying `orgId` and, where one was granted or changed, `orgRole`. Member
user ids never enter org logs.
