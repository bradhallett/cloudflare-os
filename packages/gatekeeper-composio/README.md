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
Session MCP is for execution only (POST-only, `x-api-key` via PR 1's auth-scheme option).

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
settlement paths, or continuations. Arming is refused while observer sharing is on.

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

The gatekeeper cannot read `AdminConfig`; the Workshop passes
`ComposioToolkitPolicy { excludedToolkits, autoApplyToolkits }` into every
`getGatekeeperClassFor` mint, and the connector resolves it at one `toolkitPolicy(slug)`
chokepoint (**excluded always wins**), consulted at facet mint (unknown/excluded slug → no
class), catalog filter, session scope, and the auto-apply classification site. Nothing is baked
into account state, so admin exclusions reach new facets and sessions immediately.

## Quotas

Every call is counted per user per UTC day against `COMPOSIO_DAILY_CALL_LIMIT` (default 500)
using a reserve-then-settle pattern across all the user's bindings; not-dispatched calls release
their reservation. Own-key calls spend the user's project, counted in a separate counter, never
refused at the deployment-funded limit and never rolled into the deployment total. Quota
exhaustion degrades to a clear refusal, never a silent failure.

## What PR 4 adds (placeholders in this PR)

Triggers (`createTrigger`/bindHook on the scheduler's contract), the webhook route with
Standard-Webhooks signature verification keyed by key mode, the delivery queue with envelope
dedupe, and the reconciliation alarm. `WEBHOOK_ORIGIN` is already declared in the worker's env
surface; the Connect Link `callbackUrl` resolves from `BASE_URL` when set and otherwise points
at the reserved callback path, which PR 4's webhook route completes.

## Development

`pnpm --filter gatekeeper-composio test:run` runs both suites: the Node project (classification,
settlement map, policy chokepoint, quotas, slug registry) and the workerd project (facet mint
policy, key-mode fencing, continuation lifecycle, observer consent) — the latter drives the real
Durable Objects through a `TestHooks` DO, with Composio's REST surface faked through the
worker's `setComposioFetchForTests()` seam. `wrangler.jsonc` is generated: edit
`cloudflare.config.ts` and run `pnpm configs:generate`.
