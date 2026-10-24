# Org boundary threat model

Who can reach what across organization boundaries, per surface. This is the adversarial pass
over the tenancy model (docs/tenancy.md) that issue #19 called for: each section names a
surface, the authority that answers on it, and the residual risks accepted. Share mechanics
live in docs/sharing.md; bearer-capability handling for connects in docs/connect-handoff.md.

## Identity and user Durable Objects

One person is one `UserDurableObject`, keyed by canonical user id, however many orgs they join —
membership, not identity, is the tenant dimension. There is no org state in the user DO to bleed:
its `orgMemberships` collection is a discovery index (which orgs to ask), its `gadgets` index names
workspaces by owner flag, and every org answer is produced inside the `OrgDurableObject` after an
actor-checked read. A same-email user in two orgs holds two memberships and one identity; the
boundary is enforced at each org read (`describeForMember` answers null for a stale or lost
index entry), never by trusting the user DO's copy.

## Org membership authority

The org's `members` collection is the sole authority. Roles are ranked (`owner` / `admin` /
`member`); nobody grants or acts above their own role, and last-owner protection refuses any
operation that would leave an org ownerless — including the sole owner leaving. Mirrors into user
DOs are best-effort and re-checked on read, so a lost mirror costs staleness, never authority
(docs/tenancy.md, "Authority and the user's index").

## Directory and the gatekeeper user picker

`searchUsers` and the picker are scoped to the caller's **directory scope** — active members of
their orgs plus owners of workspaces shared with them — computed live from each org's own
actor-checked listing, failing closed when an org cannot be read. No query enumerates outside the
scope; the directory DO itself accepts an explicit scope only. A picker ticket records the orgs
that justified the pick, and redemption re-checks them live; a ticket justified by a share
relationship requires that relationship to still stand. A removed member's pending picks die at
redemption, and a share justified only by a stale index entry finds no live membership to rest on.

## Share links and `open()` on org-owned workspaces

A share link is a bearer capability, so the boundary is enforced at redemption and at every
`open()`, not at link creation. A `shareKey` edge grants at most the *creator's live effective
role*; an org-owned workspace roots its permission graph at the org's membership baselines, not at
stored edges. A link minted before a workspace transferred to an org therefore goes inert the
moment its creator loses their org role: whoever redeems it, however valid the key, is bounded by
a role that no longer exists (sharing.test.ts, "grants a cross-org outsider nothing for a
pre-transfer link they redeem"). Under `ownerInvitesOnly`, only edges authored by build-baseline
members count as owner grants, and members cannot out-share their own baseline.

## Context Library grants and account disambiguation

A private collection's own grants (`grants`, `orgGrants`) are authoritative; a library index entry
is discovery, never access. **Org grants resolve against membership snapshots the Workshop
pushes** — the org memberships delivered in `AppUiContext.orgMemberships` when a management UI
opens and with every redeemed picker selection — because the gatekeeper holds no service binding
to the org authority. Granting or **raising** an org's grant requires the actor's recorded
memberships to name that org (an org's name is not spendable by someone who merely learned the
id); lowering or dropping a grant stays open to any sharer, so a stale grant never strands.
Access checks, listings and observer verification all re-read the snapshot live, so a membership
that ends between pushes loses access at the next check; agent-only reads hold the last snapshot
until the next UI open — accepted staleness, bounded by that refresh. `getAccountId` resolves a
person's account ids from their own gatekeeper verifiers inside the sharing domain, never from
the browser, and shares to "everyone in these orgs" grant all of a person's accounts together.

## Blueprints

Blueprint records and R2 content are keyed by owner subject (user or org), scoped and live-checked
(`blueprint-access.ts`): an org-scoped record is invisible to public by-id reads and listed only
inside the org scope, and resolving one for a user re-checks their live org membership. Residual:
org-owned blueprints have no deletion path yet — an orphaned record fails closed (unreadable once
membership ends) and is recorded as a follow-up.

## Deployment admin controls

`ADMINS` is env-only and `#isAdmin` reads it per request; `getAdminApi()` mints the admin
capability only for admins, once, at ask time. Authentication/authorization config (sign-in
gatekeepers, password login) is deliberately **not** in `AdminConfig`, so a compromised admin
session cannot widen who may sign in; `AdminConfig` covers only soft customization and which
gatekeepers/resources are offered, and `#assertResourceEnabled` is the single chokepoint those
opt-outs are enforced at. Management-app UIs are reachable only through the user's own connected
accounts (`startAccountAppUi`), and `isAdmin` is supplied fresh per open.

## Deprovisioning across the boundary

`deprovision()` closes the account and severs everything that outlives a session: sessions and
staged handoffs, connected gatekeeper accounts, password, directory flag, collaborator edges on
workspaces shared *with* the user (each force-restarted so live chats die), and — the piece this
issue added — **every org membership and pending invitation**, ended through `memberLeave` so
directory scopes, picker justifications and org-owned baselines stop naming the user. Best-effort
per org; the accepted residual is a sole owner, whose leave the org refuses: the stale record
names a closed account that can no longer authenticate, and a later transfer or admin action
clears it (user-deprovision.test.ts).

## Probe vectors and outcomes

Every cross-org access attempt from the issue scope, its outcome, and the regression that pins it:

| Vector | Outcome | Regression |
| --- | --- | --- |
| Same email, two orgs: user-DO state crossing orgs | No org state in the user DO to leak; every org read is actor-checked in the org DO | org.test.ts (role gates), tenancy model |
| Cross-org pick: select someone sharing no org and no share | Refused at mint; justification live re-checked at redemption | gatekeeper-user-picker.test.ts |
| Removed member redeems a pending picker ticket | Refused ("no longer available") and spent | gatekeeper-user-picker.test.ts |
| Stale membership snapshot: org grants survive a membership loss | Reads resolve live against the pushed snapshot; access ends at next check | gatekeeper-context org-grants.test.ts |
| Context: non-member grants an org a collection role | Refused — actor's recorded memberships must name the org (this issue's fix) | org-grants.test.ts, "require the sharer to belong" |
| Context: departed member raises / drops an org grant | Raise refused; drop allowed so a stale grant never strands | org-grants.test.ts, "require the sharer to belong" |
| Cross-domain Context confusion (`getAccountId`) | Libraries and grants are namespaced by sharing domain; memberships resolve per domain | org-grants.test.ts, "resolve only within the sharing domain" |
| Outsider redeems a valid pre-transfer share link on an org-owned workspace | No effective role — the grant is bounded by the creator's (gone) live role | sharing.test.ts, "grants a cross-org outsider nothing" |
| Membership ends: live sessions on org-owned workspaces | Severed at once via the org's `ownedGadgets` fan-out (removal, leave, demotion, transfer) | org-gadgets.test.ts |
| Refused last-owner removal/leave as a sever bypass | Guards fire before any sever; nothing restarts, sessions live | org-gadgets.test.ts, "a refused sole-owner removal" |
| Deprovisioned member's org presence survives | Memberships and pending invitations ended; index dropped; sole-owner residual documented | user-deprovision.test.ts, "deprovision leaves the user's organizations" |
| Non-admin reaches admin controls | `getAdminApi()` returns null; `ADMINS` env-only, auth config not in `AdminConfig` | admin settings suites; audited server.ts |

## Accepted residuals

- Context membership snapshots refresh at UI open and share redemption; agent-only reads hold the
  last snapshot until the next refresh (bounded staleness, no service binding by design).
- Picker tickets justified by org membership may live up to their 30-minute TTL with a membership
  that ended; redemption's live re-check is the enforcement point.
- Pre-transfer share links stay stored but inert; their grants are bounded to nothing.
- A deprovisioned sole owner leaves a stale member record (last-owner protection); it names a
  closed account.
- Org-owned blueprints have no deletion path (fail-closed orphan; follow-up).
