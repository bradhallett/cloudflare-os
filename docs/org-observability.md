# Org observability: the org dimension and per-org rollups

Organizations are the Workshop's tenant dimension (`docs/tenancy.md`), so usage questions that
matter per tenant — how many seats an org is using, what its workspaces spend on models, how much
its gatekeepers are exercised — need an org dimension on the observability surfaces. This note
records the convention and the checked-in rollup queries; the underlying dataset and how to run
SQL against it are in [`packages/observability`](../packages/observability/README.md).

## The org field convention

Org context is surfaced as one field, `orgId`, and it exists only where an org is actually in the
picture — never on user-only surfaces:

- **Org admin operations** (`OrgDurableObject`, `workshop.org` component): the org's logger is
  `logger.with({orgId})`, derived once from the org's own record, so every `org.*` event
  (`org.created`, `org.member.invited`, ...) names its org without each call saying so. Before a
  DO's org is initialized there is no id yet, and events carry none.
- **Org-owned workspaces** (the Overseer of a workspace whose owner subject is an org): the
  workspace's logger folds the owning org in the same way, from the moment of `transferToOrg`
  (one-way), and the workspace's product activity events record the org (below). A user-owned
  workspace records no org anywhere.

## The org dimension on activity events

Product activity events (`activity/v1` in the `gadgets_metrics_v1` dataset) name the org a
workspace belongs to in two coordinated places (`metrics-schema.ts` is the single source of column
truth; the read side resolves names from it, never a raw `blobN`):

- **The `orgId` column** (`blob10`): `org_<orgId>` on events from org-owned workspaces, `""`
  otherwise.
- **The `org` index copy**: an event that names an org is written once more under
  `activity|org|org_<orgId>`, so per-org queries read the org's own index — the same shape as the
  owner and workspace copies. Counting events there never double-counts: each event has exactly
  one org point.

The write path is `OverseerCore.recordGadgetAnalytics`, which stamps the org on every gadget
event an org-owned workspace records. `transferToOrg` adopts the org first, so even the transfer
completing is logged with it.

## Per-org rollup queries

`@gadgets/observability/metrics-queries` carries one checked-in query per org dimension for
dashboards (paste into a dashboard widget's SQL editor, or POST to the Analytics Engine SQL API —
see the observability README):

| Dimension | Query | What it counts |
|---|---|---|
| Seats | `orgActiveSeatsByDay(orgId, days)` | Distinct users with at least one event in the org's workspaces, per UTC day. Approximate wherever Cloudflare sampled the index (a distinct count has no sample-weighted form). |
| Gatekeeper usage | `orgGatekeeperUsageByDay(orgId, days)` | Gatekeeper connections created and removed in the org's workspaces, per UTC day. |
| Model usage | `orgModelUsageByDay(orgId, days)` | Model-driven activity — chat interactions (each message drives at least one model call) plus model connection changes — per UTC day. |

All three read the org's own index copy, so their counts are exact under sampling (via
`sum(_sample_interval)`) except the distinct-seat count noted above.

**Model usage is event-count grade today.** Token and cost accounting for models arrives with the
SaaS usage stream (metered overage), which records per-turn usage and carries the same org
dimension; until then the model rollup counts the usage events the activity dataset has. The
billing dashboard reads the same queries for its per-org usage panels.
