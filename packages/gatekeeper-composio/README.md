# gatekeeper-composio

The long-tail connector: one gatekeeper giving every user of a deployment access to Composio's
app catalog — connect any app through a Composio Connect Link, let agents discover and call tools
with writes queued for approval — without writing a per-app gatekeeper for any of it.
`plans/composio-gatekeeper.md` is the binding design record; this README summarizes what shipped.

The deployment's head apps keep their native gatekeepers (tokens inside the deployment). Composio
is deliberately the connector for everything else, at the cost of upstream tokens and tool traffic
transiting Composio — a trade the user makes per toolkit, kept visible in the app UI rather than
hidden behind a generic card.

## Surfaces

- **Ambient singleton** (`autoProvisionsAccount`, mode *optional* by default): every account
  provides a `ComposioSession` (see `src/types.d.ts`) folded into chats as the named binding
  `composio` — `listToolkits()`, `listTools(toolkit)`, `callTool(tool, args, account?)`, plus the
  `input_required` continuation methods below. Every read is an observation; every `callTool`
  write is a queued action.
- **Per-toolkit facets**: `getGatekeeperClassFor("composio://toolkit/<slug>")` mints a facet bound
  to one toolkit's tools under the same read/write split. `getSupportedResources()` is
  user-independent: exactly one grantable pattern, `composio://toolkit/*`.
- **Management app** at `/gatekeepers/composio` (owner-authenticated frame): catalog browser with
  search, connect/disconnect, key mode, sharing consent, quotas, disclosures.
- **Admin editor hooks**: the vendor implements `ComposioVendorAdmin.getToolkitInfo(slugs)` — live
  slug validation plus per-toolkit eligible/destructive tool counts under the auto-apply rule.

## Keys and key-mode fencing

Two key modes. The deployment installs with `COMPOSIO_API_KEY` (wizard blocks install without
it); a user may additionally paste their **own** project key through the app UI (the frame's
owner-authenticated hosting session is the fence; the key is validated live before it is
committed and is never returned on any client or agent surface — only `composio-api.ts` reads
it). Own-key sessions run against that user's project; clearing the key returns the account to
the deployment key.

Key-mode switches are fenced, not racy: the account DO refuses a switch while queued actions are
pending, bumps its connection generation, deletes the old Composio session and creates a new one
under the new project, and invalidates the cached catalog. An action staged under an old
generation is declined **pre-dispatch** (never outcome-unknown). Facets cannot be re-addressed
across facet spaces, so each facet pushes its pending count to the account at every transition
(stage, settle, reject, expire), and the fence sums those counters.

## Catalog, classification, settlement

The catalog is assembled from Composio's REST surface (`backend.composio.dev/api/v3.1`,
`GET /toolkits` + `GET /tools`, cursor-paginated at 500, `Retry-After` honored) and cached in the
account DO — mcp-shared's MCP listing is capped far below Composio's catalog and is not used.
Execution is REST too: `POST /tool_router/session/{id}/execute` with the key on `x-api-key`
(no MCP transport is used; the session MCP endpoint is unused).

Tool annotations and tags are third-party metadata: tools classify at trust tier `byo`
(`readOnlyHint` tools observe, **every write queues**). The meta-tool slugs
(`COMPOSIO_REMOTE_BASH_TOOL`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_MANAGE_CONNECTIONS`,
`COMPOSIO_SEARCH_TOOLS`, `MULTI_EXECUTE_TOOL`) are refused at execute and filtered from the
catalog from one shared registry (`src/config.ts`) — no admin setting re-enables them. The
session also carries Composio's server-side `tags.require_approval` filter as defense in depth,
never as the authority.

The execute envelope settles explicitly (`src/settlement.ts`):

| Envelope / failure | Settlement |
| --- | --- |
| `completed` | applied |
| `failed` (incl. declined input) | declined — not-dispatched class, retryable failure |
| `input_required` | continuation flow (below); not-dispatched |
| `blocked` without `log_id` | terminal known-absent — not-dispatched class |
| `blocked` with `log_id` | terminal, `log_id` recorded for reconciliation |
| network failure mid-execute | outcome-unknown, terminal, `log_id` surfaced |

Declined and known-absent branches throw not-dispatched error classes (extending mcp-shared's
`McpCallNotDispatchedError`), never a plain `Error` — a plain error is failsafe-classified as
may-have-landed, which would misreport calls that provably never ran.

## `input_required` continuations

When a tool asks for input, the apply handler records a continuation row in the facet's SQLite
(tool, original arguments, account, `request_state` ≤16 KiB, bounded questions, generation,
chain depth, 1 h expiry) and throws the not-dispatched error naming the continuation id. The
session exposes `getInputRequest(id)` (one whole-binding observation; question text flattened
one-line) and `continueTool(id, responses)`, which validates TTL/single-use/generation and stages
a **fresh queued action** — no round ever re-dispatches under a stale approval, and an agent
answering its own tool question stays human-gated. Continuation actions carry the distinct,
never-armable kind `composio-continue` and `autoApprovable: false` under any admin or arming
configuration. Chains cap at three answering rounds; expiry or rejection fires a best-effort
upstream decline (`{action: "decline"}` — nothing ran).

## Auto-apply (two-key design)

Admin eligibility (`AdminConfig.composioAutoApplyToolkits`) plus user arming (the connections
page's existing toggles) yield one toolkit-level kind `composio:<slug>:write`. A write is
`autoApprovable` iff the toolkit is admin-listed **and** the tool's tags affirmatively include
`createHint` or `updateHint` and do not include `destructiveHint` — Composio's silence never
enables anything, and the absence of a destructive tag alone never suffices (tags are
third-party-influenced). Auto-apply never covers meta-tool slugs, outcome-unknown/blocked
settlement paths, or continuations. Arming is refused while observer sharing is on. The listing
is consulted **live** at every classification and `getAutoApprovableActions()` call — nothing is
frozen at mint — so unlisting a toolkit disarms its already-minted bindings immediately.

## Observer consent

The ambient capsule sits in every collaborator's verification scope, so refusing observers would
make the owner's shared workspaces unopenable. Sharing is therefore a consent surface: the app
UI's owner toggle (default off) backs an account-DO consent flag and admission log; `addObserver`
asks the account DO fail-closed, `removeObserver` is a no-op, and the overseer's re-run on every
open makes revocation effective at the peer's next open. Every read is described as `baseline` —
the honest description of all-or-nothing consent. The toggle's copy grants in full: collaborators
observe everything this account reads, can approve and continue its queued actions, and their
chats can read through it — in every shared workspace, every toolkit, both key modes.

## Admin policy chokepoint

The gatekeeper cannot read `AdminConfig`; the Workshop pushes
`ComposioToolkitPolicy { excludedToolkits, autoApplyToolkits }` to the account out-of-band
(`ComposioUserPolicy.updateToolkitPolicy`, ahead of any mint), and the connector resolves the
stored copy at one chokepoint (**excluded always wins**), consulted at facet mint
(unknown/excluded slug → no class), catalog filter, session scope, and the auto-apply
classification site. Facets freeze only the key-mode generation; exclusions and unlistings
reach already-minted facets and sessions immediately, because every use re-reads the stored
policy.

## Quotas

Every call is counted per user per UTC day against `COMPOSIO_DAILY_CALL_LIMIT` (default 500)
using a reserve-then-settle pattern across all the user's bindings; not-dispatched calls release
their reservation. Own-key calls spend the user's project, counted in a separate counter, never
refused at the deployment-funded limit and never rolled into the deployment total. Quota
exhaustion degrades to a clear refusal, never a silent failure.

## Triggers and webhooks

Agents arm triggers through the ambient session (`createTrigger(config, callback)`), which rides
the Scheduled Tasks hook contract — `bindHook` parks the controller at the approval gate, and only
the user's approval calls `enable`, which records the initiator in the account DO and upserts the
upstream instance (`POST /trigger_instances/{slug}/upsert`). A denial or unbind calls `disable`:
upstream instance deleted, initiator disposed, rows dropped. A config change is a disable plus a
fresh `createTrigger`; controller props are immutable. Every delivered event passes
`authorizeObservation` (title, description, capped payload preview) before the callback fires, and
payloads stay fenced as untrusted data end to end.

Composio delivers events to `POST /webhook` on this worker (under the gatekeeper base path when
`BASE_URL` names a subpath). The route uses unverified envelope contents only to pick the account
Durable Object (`metadata.user_id`, `workshop-{accountId}`); the account verifies the Standard
Webhooks signature (HMAC-SHA256 over `id.timestamp.body`, 300s tolerance, multi-candidate
`webhook-signature` so rotation overlaps) before acting on anything. Upstream is at-least-once, so
ingest dedupes on the envelope id for 24h and uses it as the delivery idempotency key. Deliveries
queue with the kit's backoff (1min→1h exponential, 8 attempts ≈3h, then drop) and are capped at
96 KiB each. `composio.connected_account_expired` events on the same URL record an expiry notice
the app panel shows (reconnect is the remedy; nothing here can renew OAuth).

The webhook subscription itself is a project-level singleton the connector owns per key mode:
created on first trigger enable (`409` → patch the existing one), signing secret stored in the
account DO and rotatable from the app UI (`rotateWebhookSecret`). A failed verification retries
once against the upstream secret — Composio can rotate under us — and only then refuses. The
subscription URL is `BASE_URL` (manifest-templated to the router's public origin) with
`WEBHOOK_ORIGIN` as the dev-tunnel override; without an https origin there is no webhook route
worth registering, so trigger enablement refuses instead. Key switches rebuild their mode's
subscription and re-upsert every trigger under the new key; `revoke()` deletes trigger instances
and (in own-key mode) the mode's subscription, then drops all state.

While any trigger is armed, the account DO's alarm runs every 15 minutes and reconciles both
directions against `GET /trigger_instances/active` (cursor-paged, client-filtered to this
account's composio user): upstream instances with no row are deleted; rows with a missing or
disabled upstream instance are re-upserted under their stored id. Events are counted per workspace
per UTC day (`EVENTS_PER_WORKSPACE_PER_DAY`, default 500); over-limit deliveries are dropped and
the drop is visible in the app panel's usage section.

## Development

`pnpm --filter gatekeeper-composio test:run` runs both suites: the Node project (classification,
settlement map, policy chokepoint, quotas, slug registry, webhook signatures and envelopes) and
the workerd project (facet mint policy, key-mode fencing, continuation lifecycle, observer
consent, triggers) — the latter drives the real
Durable Objects through a `TestHooks` DO, with Composio's REST surface faked through the
worker's `setComposioFetchForTests()` seam. `wrangler.jsonc` is generated: edit
`cloudflare.config.ts` and run `pnpm configs:generate`.
