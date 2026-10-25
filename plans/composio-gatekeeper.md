# Plan: Composio gatekeeper — the long tail of apps through one brokered connector

**Status: planned** (not implemented). Scope decisions confirmed by the deployment owner on
2026-10-26; build is deferred; this record fixes the design so the build can start from it.
Composio facts are from docs.composio.dev and the Composio v3.1 REST surface as retrieved
2026-10-26 — the fact base was audited line-by-line against live docs by a dedicated reviewer,
and the whole design was stress-tested by eight parallel reviewers (contract, mcp-shared reuse,
trust/approval, triggers, tenancy/keys, admin/frontend, live API facts, build runway) whose
findings are integrated here. A second round (three designers + one adversary, IRC-coordinated)
then re-examined the non-goals round one produced: toolkit auto-apply and the `input_required`
continuation are lifted into locked designs, and the observer posture is redesigned around a
consent surface. The few assumptions still unproven are under
[Verification](#verification). The broker pattern — a key-holding worker minting per-user
Composio sessions and proxying execution — is proven in production elsewhere; this design
adopts it on our side of the wire.

## Goal

Ship `packages/gatekeeper-composio`: one gatekeeper that gives every user of a deployment access
to Composio's app catalog (1,600+ toolkits per current docs — counts are not hardcoded in UI
copy) — connect any app through a Composio Connect Link, let agents discover and call tools with
writes queued for approval, and let app-event triggers (a Gmail arriving, a Slack message) start
workspace runs — without writing a per-app gatekeeper for any of it.

The deployment's head apps already have native gatekeepers that keep their tokens inside the
deployment. Composio is deliberately the **long-tail** connector: one more integration to cover
everything else, at the cost of upstream tokens and tool traffic transiting Composio. That trade
is the user's to make per toolkit, and the design keeps the choice visible rather than hiding it
behind a generic card.

## Locked decisions

### Identity and tenancy

- **Package, ids, routes.** Package `gatekeeper-composio`, vendor id `composio`, display name
  "Composio", routes under `/gatekeeper/composio/*`. The worker binds as `GATEKEEPER_COMPOSIO`
  (the Workshop and router discover gatekeepers by scanning `GATEKEEPER_*` env keys — a bare
  `COMPOSIO` binding name would never be found). The agent API speaks Composio's current
  vocabulary — toolkits, tools, connected accounts, sessions — never the v1/v2 terms ("apps",
  "actions", "entity", "toolset").

- **Composio user id = the account id; no kernel identity change.** `createAccount()` carries no
  Workshop identity and the gatekeeper contract has no channel to hand one over, so the account
  DO mints a random UUID (the `gatekeeper-context` precedent) and the Composio **user id is
  `workshop-{accountId}`** — stable for the life of the *account*, not "per Workshop user"
  verbatim. Sessions, connected accounts, and webhook events all key on it, which gives inbound
  webhooks a direct reverse map: `metadata.user_id` → strip prefix → `idFromName(accountId)` →
  the account DO; no user↔account registry exists or is needed. Re-provisioning (disconnect and
  re-add) mints a new account and orphans the old Composio user — Composio has no user-delete
  API — so [revoke semantics](#connect-links-and-connected-accounts) delete everything reachable
  and the app UI discloses the residue. A kernel change threading userId into provisioning was
  considered and rejected: it would touch `workshop-shared`'s provisioning contract for one
  vendor's routing convenience.

- **Composio Platform sessions, not Composio Connect.** The shared MCP endpoint
  (`connect.composio.dev/mcp`) binds every connection to the consumer-key holder; it cannot
  carry per-user tenancy. The gatekeeper uses the Platform REST surface
  (`backend.composio.dev/api/v3.1`): one reusable **session** per account, created lazily and
  persisted by session id, `DELETE /tool_router/session/{id}` on teardown. **Multi-account mode
  is on** (`multi_account: {enable, max_accounts_per_toolkit: 5, require_explicit_selection}`) —
  connecting a second Gmail never silently becomes the default; `execute` takes
  `account: <connected-account id | alias>` and omitting it with multiple connected accounts is
  an upstream error listing them, which the connector surfaces to the agent as a re-select
  prompt. Account labels are Composio **aliases** (`alias` at link time, mutable later via
  `PATCH /connected_accounts/{id}` — so UI and facet identity key connected-account ids, never
  aliases; a duplicate-alias 4xx is surfaced in the connect UI).

### Keys

- **Both key modes, deployment key first.** The connector installs via the deploy wizard with
  `deploy-inputs.json: [{"name":"COMPOSIO_API_KEY","kind":"secret","label":"Composio project API
  key"}]` — wizard-installable, **not preinstallable** (a declared secret input forbids
  preinstall), and the release manifest registers it in `manifest-lib.ts`'s SINGLETON list so a
  second install cannot hand every user a duplicate ambient capsule. A user may additionally
  supply their **own** project key; the account switches `keyMode: "deployment" → "own"` and
  runs sessions against that user's project, and clearing the key returns the account to the
  deployment key.

- **The scoped key needs six areas, fixed at creation.** Composio scoped-key permissions are
  fixed when the key is made and tool execution is a *separate* area from session management.
  The BYO-key UX tells the user up front to create a key with: **Session management RW, Session
  tool execution W, Toolkits R, Connected accounts RW, Triggers RW, Webhooks RW**. The three-area
  list an earlier draft assumed would cover triggers does not — that was verified against the
  live permissions page, not assumed.

- **BYO key is accepted through the gatekeeper's own app UI — a declared exception, not the
  kit's escrow.** The kit's `credential-stage` is a one-shot ~10-minute escrow whose live commit
  (`reconnectComplete` → `commitReconnect`) rides a connect callback that auto-provisioned
  vendors never receive; there is no contract path that redeems a staged key for an ambient
  account, so "the same escrow path reconnects use" was wrong and is withdrawn. Instead: the
  user pastes the key into the gatekeeper app (`/gatekeepers/composio`, hosted by the Workshop's
  owner-authenticated session — that session hosting the frame is the fence), the frame's `ui`
  RpcTarget method validates the key live (a `GET /toolkits` call against it must succeed) and
  commits it to the account DO. The key lives in DO storage under a named key
  (`ownApiKey`, plaintext parity with how OAuth gatekeepers store tokens), **only
  `composio-api.ts` ever reads it**, it is never returned on any client or agent surface, and
  the clear path revokes upstream state before disposal (see
  [revoke semantics](#connect-links-and-connected-accounts)).

- **Key-mode switches are fenced, not racy.** An in-flight queued action must never apply
  against a different project than the one it was approved under. On any keyMode switch the
  account DO: refuses the switch while queued actions are pending (drain first); bumps its
  connection generation (the mcp-shared `assertConnectionCurrent` fence then declines anything
  staged under the old generation **pre-dispatch** — never outcome-unknown); `DELETE`s the old
  Composio session and creates a new one under the new project; invalidates the cached catalog;
  and disables + recreates trigger instances (and the webhook subscription — a different project
  is a different subscription). Stranded own-key actions after a key *clear* are declined the
  same way, before dispatch.

### Surface

- **Per-app surface = one grantable pattern plus per-toolkit resource URLs; browsing lives in
  the gatekeeper app.** `getSupportedResources()` is **user-independent** (the contract's filter
  path calls it with no options, and user-dependent answers are unimplementable): exactly one
  SupportedResource whose `urlPattern` is `composio://toolkit/*`, matching `composio://toolkit/<slug>`
  per-toolkit instances created when the agent scopes a gadget
  (`setGadgetBinding` + `ensureResources("composio://toolkit/<slug>")`). The searchable
  **catalog browser** is a page in the gatekeeper app UI, fed by a named search RPC over
  Composio's `GET /toolkits` (cursor-paginated) with the account's connected state joined in —
  not by `getSupportedResources` (no search input) and not by `GET /tools?query=` (that
  searches *tool* text; toolkits without matching tool words would never surface). One
  top-level gatekeeper card per app is rejected: a card means a deployed Worker with its own
  secrets, and faking vendor entries would break `#assertResourceEnabled`, admin toggles and
  entitlements, which all key on real vendors.

- **The agent surface is a meta-tool session plus per-toolkit facets.** The ambient singleton's
  `AccountDescription.singleton.tsType` names a generated `ComposioSession` interface
  (`listToolkits()`, `listTools(toolkit)`, `callTool(tool, args, account?)`) exported through
  `getTypeScriptTypes()`; every read is an observation and every `callTool` write is a queued
  action. `getGatekeeperClassFor("composio://toolkit/<slug>")` mints a per-toolkit facet
  (an RpcTarget with props `{accountObjectId, toolkitSlug}`) exposing that toolkit's tools under
  the same read/write split, its type subset per the contract. The `mcp-portal` `#server=`
  scope seam does **not** transfer (its scope grammar cannot express a composio URL, and its
  first-underscore membership split can never match slugs like `google_calendar`): membership is
  connector-side, an exact-slug match over the REST-assembled catalog below. Agent types ship
  as the repo's standard `types.txt` symlink → `types.d.ts` text module; `versionTag()` is
  implemented (the Workshop calls it on every vendor).

- **The catalog comes from REST, not from the session's MCP listing.** mcp-shared's client caps
  a catalog at 200 tools / 96 KiB and its search scans *throw* past 5,000 tools — useless
  against a 1,600-toolkit catalog — and Composio's own docs advise keeping session toolsets
  narrow. The account DO therefore assembles and caches the catalog from REST
  (`GET /toolkits` + `GET /tools`, cursor-paginated at the documented `limit=500`), filtering
  per facet by exact toolkit slug. The session MCP endpoint is used for **execution only**.
  `preload: {tools:"all"}` is not used — it is unsupported when multi-account mode is enabled.

- **Session MCP needs `x-api-key`, so mcp-shared gains an auth-scheme option.** Composio's
  session MCP (`mcp: true` at session create/use; headers returned verbatim as
  `session.mcp.headers`, carrying `x-api-key` — never Bearer; transport is streamable-HTTP
  **POST-only**) does not fit mcp-shared's Bearer-only `AuthorizationProvider`. This is a
  definite PR-1 change to `packages/mcp-shared`, not a conditional one: an auth-scheme /
  extra-headers option on `McpClient` + `withClient` + the connection shape, plus extending the
  client's cross-origin redirect hygiene (which today strips only `Authorization` and
  `Mcp-Session-Id`) to also strip the configured auth header — otherwise a redirect would
  forward the project key to a third-party host.

### Execution, approval, settlement

- **Execution reuses mcp-shared's machinery at trust tier `byo`.** Composio's tool annotations
  and tags are third-party metadata: `byo`, so `classifyTool` gives `readOnlyHint` tools
  observation mode and **every write queues** — the unconditional default; the only widening
  is the two-key auto-apply design below, which never relaxes classification itself. The
  approval dialog shows the resolved tool name and input schema (kit `buildDescription`,
  untrusted text quoted). Session creation disables every meta-tool knob that exists
  (verified live): `workbench: {enable:false}`, `manage_connections: {enable:false}`,
  `search: {enable:false}`, `execute: {enable_multi_execute:false}` — and the connector
  additionally refuses the meta-tool slugs at execute from one shared constant registry
  (`COMPOSIO_REMOTE_BASH_TOOL` — *not* `COMPOSIO_REMOTE_BASH` — `COMPOSIO_REMOTE_WORKBENCH`,
  `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_SEARCH_TOOLS`, `MULTI_EXECUTE_TOOL`): arbitrary code
  execution on Composio infra is outside this platform's sandbox premise, no admin setting
  re-enables it, and the refusal list, catalog filter, and UI copy all read the same constant.
  As defense-in-depth the session is also configured with Composio's server-side
  `tags.require_approval` filter for non-read tools — server-side enforcement is a second
  fence, never the authority (tags are third-party, same provenance as annotations).

- **Admin-enabled auto-apply for chosen toolkits — a two-key design.** Round one rejected this
  knob because no enforcement seam existed; the props pass-through and the connector-owned REST
  catalog now provide both, so it returns as real auto-apply with **zero mcp-shared lines**
  (the `autoApprovable` verdict is contract-assigned to the gatekeeper author per action, and
  the connector authors it after `classifyTool` — mcp-shared passes the value through without
  re-deriving trust; the curated-kind precedent is github/gmail/sheets/google). **Key 1, admin
  eligibility:** `AdminConfig.composioAutoApplyToolkits`, default `[]`, riding the excluded-list
  path verbatim (same normalization, same live `GET /toolkits` exact-slug validation, same
  per-mint props). **Key 2, user arming:** the connections page's existing
  `getAutoApprovableActions()` toggles — nothing new is built; agents and "use" collaborators
  can never arm. The connector emits one toolkit-level kind
  `{tag: "composio:<slug>:write"}` (label: "all current and future write tools in this
  toolkit") and marks a write `autoApprovable` iff **`adminListed && mode === "action" && the
  tool's tags affirmatively include `createHint` or `updateHint` and do not include
  `destructiveHint`**. Two strict positive claims: Composio's silence never enables anything
  (untagged tools queue normally), and the *absence* of a destructive tag alone never suffices —
  the tool must affirmatively carry a create/update-family tag. This downgrade was triggered by
  verification (below): Composio infers tags for MCP tools from the MCP server's own hints
  (docs.composio.dev/docs/tool-tags), so third parties can influence tag values; requiring the
  affirmative pair means an injected or mislabeled `destructiveHint: false` alone cannot arm a
  write. Auto-apply never covers meta-tool slugs, outcome-unknown/blocked settlement paths, or
  continuations (below); a failed/blocked auto-apply parks the queue behind a human — the
  settlement map is never weakened. The admin editor states the forever-vouch semantics with
  live per-toolkit counts of eligible tools under this stricter rule; unlisting does not
  de-escalate actions already pending (disclosed — identical to trust-tier withdrawal semantics
  today). Arming is refused while observer sharing is on (see the ambient-singleton decision).

- **The execute envelope has four states and the settlement map is explicit.**
  `POST /tool_router/session/{id}/execute` returns `result_type ∈ completed | failed | blocked`
  plus an `input_required` continuation (`input_responses` + `request_state`; declining returns
  `failed`), with `error` and `log_id` on every branch. The connector's apply handler maps:
  `completed` → applied; `failed` → declined; `input_required` → the continuation flow (next
  bullet; `log_id` recorded); `blocked` without `log_id` → terminal known-absent
  (`ActionApplyError` — the call
  never ran); `blocked` **with** `log_id` → the tool *ran* but its response was blocked —
  terminal `ActionApplyError` with `log_id` recorded for reconciliation; network failure
  mid-execute → `ActionOutcomeUnknownError` with `log_id` surfaced to the user, resolvable
  against `GET /logs/tool_execution/{id}`. No auto-retry of executes — they are not idempotent,
  and the kit's `ActionOutcomeUnknownError` is terminal by contract. mcp-shared's store settles
  any *returned* result as applied, so the envelope inspection above lives in the connector's
  apply override, which throws to fail.

- **`input_required` continues through the agent loop, each round a fresh queued action.** A
  human-fillable approval form was rejected: the approval surface is a verdict over shown
  content — `applyAction` carries no input channel and `ActionDescription.fields` is
  display-only — and a schema form would churn four packages for a flow the agent cannot use.
  Instead, on `input_required` the apply handler upserts a continuation row in the facet's
  SQLite keyed by the failed action id (`toolSlug`, `arguments`, `account`, `request_state`
  ≤16 KiB, bounded `input_requests`, generation, `chainDepth`, 1 h expiry) and throws the
  not-dispatched error class with the continuation id. The session gains `getInputRequest(id)`
  (one whole-binding observation; question text flattened one-line) and
  `continueTool(id, responses)`, which validates TTL/single-use/generation/`chainDepth ≤ 3` and
  stages a **new queued action** — the load-bearing property: no round ever re-dispatches under
  a stale approval, and an agent answering its own tool question stays human-gated. The
  continuation description re-renders the **full original arguments** plus every third-party
  question and every supplied answer as literal fields (`descriptionIsComplete` only under the
  same completeness condition as the original), carries `autoApprovable: false` always, under a
  distinct never-armable kind (`composio-continue`) so no armed toolkit rule can answer a
  tool's question. Expiry or user rejection fires a best-effort upstream decline
  (`{action: "decline"}` — upstream settles `failed`, nothing ran); rows cap at ~20 per facet;
  every re-execute is quota-counted and generation-fenced. Elicitation text is untrusted:
  field values only, 2 KiB per question, ≤5 questions, request ids never rendered. Declined
  and known-absent settlement branches throw the not-dispatched error class, never a plain
  `Error` — a plain error is failsafe-classified as may-have-landed (outcome-unknown,
  non-retryable), which would misreport calls that provably never ran.

### Connect links and connected accounts

- **Connect Links are capabilities, minted only on the owner surface, confirmed by the
  attempt's account id.** Connecting a toolkit calls
  `POST /tool_router/session/{id}/link {toolkit, alias?, callback_url}` (returns `redirect_url`
  and a `connected_account_id` immediately); the user completes OAuth at `connect.composio.dev`
  (Composio hosts the managed apps; BYO auth configs are the admin's Composio-side concern —
  Composio has no managed X credentials, the same finding our native X gatekeeper's policy
  notes make). Link minting is exposed **only** on the app UI's owner-authenticated `ui`
  RpcTarget — never as an agent-callable session method, because a link surfaced in a shared
  chat lets any holder attach their chosen upstream identity. Completion is confirmed by
  polling `GET /connected_accounts/{id}` for *that attempt's* connected-account id (polling by
  user+toolkit is ambiguous under multi-account) — never by trusting a redirect URL. Upstream
  provider tokens never enter the Workshop: the capability this gatekeeper holds is the Composio
  project key (or the user's own), nothing more.

- **Revoke is ordered and explicit.** `account.revoke()` (Workshop disconnect): cursor-page
  `GET /connected_accounts` and `DELETE` each (`/revoke` where the state calls for it), delete
  trigger instances, `DELETE` the session — all *before* `deleteAll` destroys an own key that
  is the only credential reaching that project. The Composio user object itself is not
  deletable (no API) — disclosed in the app UI. Per-toolkit disconnect uses
  `DELETE /connected_accounts/{id}` alone.

- **Expired connections surface through `describe()`.** The callback-based
  `credentialsExpired()` channel does not exist for ambient vendors; the account DO instead
  flags expiry at `describe()` refresh time (connected-account states from
  `GET /connected_accounts`, plus `composio.connected_account.expired` webhook events updating
  a cached flag — they arrive on the same subscription URL as trigger events and are routed
  accordingly), and the app UI shows per-toolkit reconnect actions.

### Admin config

- **Two admin knobs — `composioExcludedToolkits` (deny) and `composioAutoApplyToolkits`
  (auto-apply eligibility) — both reached through vendor props.** The gatekeeper cannot read
  `AdminConfig`: its KV mirror is the backend's private `BLUEPRINTS` namespace, and a gatekeeper
  KV binding would be a freshly-provisioned namespace, not the mirror. So `workshop-backend`
  reads its own `AdminConfig` and passes both lists into the composio vendor's props **at every
  `getGatekeeperClassFor` mint** — config read at each point of use, nothing baked into account
  state — and the connector resolves them at one `toolkitPolicy(slug)` chokepoint (excluded
  always wins), consulted at: facet mint (unknown/excluded slug → no class), catalog
  filter, the session's toolkit scope, and the auto-apply classification site. Defaults `[]`
  per the owner's decision (the admin
  decides what to hide; Composio never silently shadows a native gatekeeper). Slugs are
  **exact-match** and validated live against `GET /toolkits` in the admin editor, which also
  warns on entries matching no real toolkit — the suggested pre-seed list contains only real
  slugs (`github`, `gitlab`, `slack`, `linear`, `notion`, `gmail`, `googlecalendar`,
  `googledrive`, `twitter`, … — Composio has no `x` and no `google` toolkit; the native-vendor
  names do not transfer). A dead slug never matches anything and is surfaced as a warning, not
  silently kept.

### Cost and quotas

- **Cost is metered per user, per key mode, per deployment.** Every deployment-key call spends
  the deployment project's quota (Hobby: 100k tool calls + 50k trigger **events** per month,
  metered separately; Pro is $29/mo but its included call volume was cut ~75% to 50k/mo in
  Aug 2026, and Composio-managed calls on the free tier are capped separately around 20k —
  these are the numbers the defaults are justified against, and they move; treat them as
  sizing input, not contract). The account DO counts calls per user per UTC day against
  `COMPOSIO_DAILY_CALL_LIMIT` (default 500 — ~15k/user-month, an order of magnitude under the
  Hobby pool so a handful of active users cannot drain it) using the X gatekeeper's
  reserve-then-settle pattern across all the user's bindings. **Own-key calls spend the user's
  project, not the deployment's**: they are counted in a separate counter, never refused at the
  deployment-funded limit, and never rolled into the deployment total. Deployment totals are
  emitted as usage metrics through `@gadgets/observability/metrics` (the admin panel reads the
  metrics side, per-user numbers live in the app UI). Quota exhaustion degrades to a clear
  refusal, never a silent failure.

### Triggers

- **Triggers ship, on the scheduler's contract — not as queued actions.** An earlier draft made
  trigger CRUD a queued action; that was refuted against the hook contract (apply handlers
  receive no hook capability). The shape is the `gatekeeper-scheduler` one: the session gains
  `createTrigger(config, callback)` → `approvalQueue.bindHook(controller, callback)`; the
  `ComposioTriggerHookController`'s **enable** stores the `HookInitiator` and upserts the
  upstream instance (`POST /trigger_instances/{slug}/upsert`), **disable** deletes it upstream
  (`DELETE /trigger_instances/manage/{triggerId}`) and disposes the initiator, and a config
  change is disable-plus-re-enable. The worker's compat flags include
  `allow_irrevocable_stub_storage` (persisted hook stubs, the scheduler precedent). The
  `HookDescription` shown at the enable gate states event type, filters, and destination — the
  callback destination is agent-chosen, so that dialog is the user's one look at what runs
  where. Every delivered event passes `authorizeObservation` before the callback fires, and
  event payloads are fenced as untrusted data end to end.

- **Trigger and delivery state live in the account DO.** Rows `{triggerId → workspaceId,
  initiator, delivery}` alongside the hook delivery queue, routed by `metadata.user_id`
  (= `workshop-{accountId}`) → the account DO → per-trigger workspace fan-out. Upstream
  delivery is **at-least-once** (same `webhook-id` redelivered — live-confirmed), so ingest
  dedupes on the envelope id and passes it as the delivery's idempotency key; the guarantee is
  at-least-once-into-the-queue, deduped-once. Backoff and expiry are the kit queue's numbers
  (1 min → 1 h exponential, 8 attempts ≈ 3 h, then drop; 24 h dedupe retention keyed on the
  envelope id) — the earlier "7-day expiry" was incompatible with the reused queue and is
  withdrawn.

- **The webhook subscription is a project-level singleton the connector owns, keyed by
  keyMode.** `POST /webhook_subscriptions` creates it (409 if one exists → `PATCH` to update
  the URL or event list), the signing secret is retrievable and rotatable, and
  `composio.connected_account.expired` arrives on the same URL. BYO mode means a second
  project and therefore a second subscription and secret: the account DO stores
  `{keyMode → subscription secret}` and verification picks by the mode of the account the
  event routes to. Signature verification is Standard Webhooks (`webhook-signature` /
  `webhook-id` / `webhook-timestamp`, HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`,
  300 s tolerance). The subscription URL is the worker's public origin: `BASE_URL` in
  production (manifest-templated to `$PUBLIC_BASE_URL/gatekeeper/composio`) with a
  `WEBHOOK_ORIGIN` dev override (the github precedent), both registered for the dev server.

- **Reconciliation is an account-DO alarm.** While any trigger is enabled, a 15-minute alarm
  walks `GET /trigger_instances/active` (cursor-paged, client-filtered — it has no per-user
  filter) against the DO's rows and repairs drift in both directions, ordered after any
  in-flight trigger mutation. Event quota: 500/workspace/day, counted in the account DO, UTC
  reset, over-limit events dropped and counted visibly in the app UI.

### Ambient singleton

- **Ambient singleton with small, named kernel touches.** `autoProvisionsAccount` (mode
  *optional* by default, per `provisioning-policy.ts`), `AccountDescription.singleton` with the
  `ComposioSession` types, folded into chats as the named binding `composio`
  (`suggestedBindingName`), read through `getSession()`/`getAgentCatalog()` in `executeCode`
  with each read an observation. `getAgentCatalog()` returns bounded toolkit entries (connected
  first, then top-of-catalog) with `catalogChange` on connect/disconnect. "Zero backend
  changes" was false and is withdrawn — the kernel touches are exactly: the mcp-shared
  auth-scheme option, the backend props pass-through for both toolkit lists, the two
  `AdminConfig` fields, the SINGLETON manifest registration, and the dev-server var
  registrations. **Observers: owner-consented sharing, default off.** The round-one text
  understated what refusal means: the ambient capsule sits in every build collaborator's
  verification scope (fail-closed), so refusing observers does not merely withhold an
  observation stream — it makes the owner's shared workspaces **unopenable by collaborators**,
  including peers who connect their own Composio account, and PR 4's trigger hooks widen the
  wall to "use" collaborators. Sharing is therefore a consent surface, not a posture: the app
  UI gains an owner toggle (the same owner-authenticated fence as the BYO key) backed by an
  account-DO consent flag and admission log; `addObserver` asks the account DO (fail-closed on
  RPC failure), `removeObserver` is a no-op, and the overseer's re-run on every open makes
  revocation effective at the peer's next open (lazy revocation inside a live session is the
  documented residual). Every read is described as `baseline` — the honest description of
  all-or-nothing consent, and the kit refuses scoped reads under admission-only verification.
  The toggle copy grants in full: collaborators observe everything this account reads, can
  approve and continue its queued actions, and their chats can read through it — in every
  shared workspace, every toolkit, both key modes. Arming auto-apply is refused while sharing
  is on. **This consent grounding reverses a standing precedent** — gmail refuses observers
  unconditionally for exactly this data shape — and the deployment owner signed off on the
  consent model on 2026-10-25: the toggle ships in PR 3, default off. The wizard blocks
  install on an unfilled `COMPOSIO_API_KEY`, so a
  deployment-mode install always has its key; if one is later removed, the vendor fails closed
  at `getGatekeeperClassFor` with a clear error.

## Architecture

```
chat agent ──composio binding──▶ gatekeeper-composio
                                   ├─ vendor (auto-provision, wizard-deployed key)
                                   ├─ account DO   per account: composio user_id, session id,
                                   │               keyMode + generation, catalog cache,
                                   │               action queue, triggers + hook queue, quotas
                                   ├─ facets       per granted toolkit (props: account, slug)
                                   ├─ app UI       catalog browser, connect, key mode, quotas
                                   ▼
                 Composio Platform (backend.composio.dev, v3.1 — REST for catalog/session/
                 triggers, session MCP (POST-only, x-api-key) for execution)
                                   ▼
                     upstream apps (tokens stay at Composio)
```

File layout mirrors `gatekeeper-websearch` for the vendor/account skeleton and `gatekeeper-mcp`
for client/action reuse: `src/worker.ts` (vendor + routes incl. the webhook handler),
`src/account.ts` (the DO; implements mcp-shared's `ConnectionAccount` structurally — it does
not extend `McpAccountBase`), `src/facet.ts` (per-toolkit RpcTargets subclassing
`McpFacetBase` where it fits, connector-custom catalog/scope), `src/session.ts`,
`src/catalog.ts` (REST assembly + cache), `src/triggers.ts`, `src/composio-api.ts` (the only
module talking HTTP to Composio; response validation, no blind casts — the
`gatekeeper-cloudflare` layering rule; the only reader of `ownApiKey`; redacts provider-echoed
secrets from thrown errors), `src/config.ts`, `app/` (the management UI, the
`gatekeeper-context` app pattern), `types.txt → types.d.ts`. **No `src/configurator/`**: the
one SupportedResource is a plain URL pattern with no user inputs, and connect flows live in
the app UI.

Worker registration is part of the design, not an afterthought: `cloudflare.config.ts` via
`defineGadgetsWorker` + `DEFAULT_GATEKEEPER_WRANGLER` with a `migrations` export tagging
`ComposioAccountDurableObject` as `new_sqlite_classes`; the committed `wrangler.jsonc` is
generated (`pnpm configs:generate`) and `worker-configuration.d.ts` via `pnpm types:generate`.
The compat flags include `allow_irrevocable_stub_storage` (hook initiators) and
`global_fetch_strictly_public` — the latter is **required**, not hygiene: `session.mcp.url` is
third-party response data that never passes user-pasted validation, and mcp-shared's own
hostname list is explicitly not the SSRF boundary. Dev-server vars register under
`PASSTHROUGH_GATEKEEPER_VARS`: `COMPOSIO_API_KEY`, `COMPOSIO_DAILY_CALL_LIMIT` (core),
`WEBHOOK_ORIGIN` (triggers PR). Tests are two vitest projects (node: classification, scoping,
settlement map, quotas, slug registry; workerd via the `TestHooks` DO pattern for facets,
props, account DO, webhook signature/routing), with `test dependsOn build:configurator`
dropped — there is no configurator.

Observability follows the package logger rules (`component: "gatekeeper.composio"`,
`vendorId: "composio"`): concrete events for connect/disconnect, classify-decisions,
quota thresholds, trigger reconciliation. Never logged — per the repo rule and this design's
capability surface: API keys, auth headers, session ids, Connect Link `redirect_url`s, tool
args, prompts, response bodies; provider error messages may quote caller data, so only numeric
codes and bounded fields are logged.

## Commit sequence

Kernel lines stay minimal and land apart from the connector, per the review bar:

1. **PR 1 — mcp-shared auth scheme** (`packages/mcp-shared` only): auth-scheme/extra-headers
   option on `McpClient`/`withClient`/the connection shape, cross-origin redirect hygiene
   extended to the configured header. Both vitest suites; no behavior change for Bearer
   connectors.
2. **PR 2 — kernel wiring** (`workshop-backend`/`workshop-shared`/`scripts`, small):
   `AdminConfig.composioExcludedToolkits` + `composioAutoApplyToolkits` (defaults `[]`,
   exact-slug normalization, `DEFAULT_ADMIN_CONFIG` + `AdminSettingsView` fields + `AdminApi`
   setters + admin editor with live slug validation and per-toolkit tool/destructive counts),
   the backend props pass-through at mint,
   `manifest-lib.ts` SINGLETON += `gatekeeper-composio`, the package's `deploy-inputs.json`,
   and the `PASSTHROUGH_GATEKEEPER_VARS` registrations. Manifest golden regen.
3. **PR 3 — the connector** (`gatekeeper-composio`, no kernel): worker + vendor + account DO +
   session + REST catalog + facets + action queue + settlement map + `input_required`
   continuation + Connect Links + BYO key + quota counters + the auto-apply chokepoint and
   toolkit kind + the observer consent toggle + the app UI + config/tests/README. Regression
   surfaces: slug registry, envelope settlement (incl. not-dispatched error classes), keyMode
   fencing, `toolkitPolicy` chokepoints, continuation lifecycle.
4. **PR 4 — triggers + webhooks**: `createTrigger`/bindHook controller, webhook route +
   keyMode-keyed subscription lifecycle + signature verification, delivery queue with envelope
   dedupe, reconciliation alarm, event quotas, `WEBHOOK_ORIGIN`.

## Non-goals

- No per-app native gatekeepers generated from the catalog (rejected: unmaintainable, forfeits
  managed auth; native gatekeepers remain preferred for head apps).
- No Composio remote sandbox tools, ever (`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL`).
- No `MULTI_EXECUTE_TOOL` (disabled at session create and refused at execute); one action per
  call.
- No approval-surface input forms, ever (the approval surface stays a verdict over shown
  content; continuations go through fresh queued actions instead).
- No auto-answering of elicitation: continuation actions are never auto-approvable under any
  admin or arming configuration.
- No observer admission without the owner's explicit consent (grounding owner-signed-off —
  see the ambient-singleton decision); no per-workspace consent (the contract carries no
  workspace context to key it on).
- No token custody: upstream OAuth tokens live at Composio, by design and disclosure.
- No mcp-shared changes beyond PR 1's auth-scheme option and redirect hygiene.

## Verification — settled 2026-10-25 (research wave, omp-reviewed; reports archived)

Findings below are docs-verified against live docs.composio.dev plus unauthenticated probes
(401-gated endpoints verified by error envelope only). Load-bearing citations re-checked by the
coordinator; reports at `/tmp/composio-research-{a,b}.md` (session artifacts).

- **Rate limits — settled.** No per-key limits: one organization-wide shared budget over a 60 s
  window across all authenticated endpoints (REST and session MCP draw from it; Starter/Hobby
  2,000/min, Growth 10,000/min). 429 body `{"message":"Rate limit exceeded. Limit: …"}` with
  `Retry-After` and `X-RateLimit-*` headers. The account DO honors `Retry-After` and backs off
  REST catalog assembly. Source: docs.composio.dev/reference/rate-limits.
- **Retention — settled.** Tool-execution payloads (arguments + responses) retained **up to one
  year by default**; project-scoped ZDR stops storing payloads for *new covered calls* (metadata
  remains) but does not erase prior logs and excludes triggers, and managed apps are
  Enterprise-only. The app UI transit disclosure now states the one-year default and the ZDR
  carve-outs; restricted-data workspaces should require ZDR and know triggers stay outside it.
  Sources: docs/security/data-retention, zero-data-retention, token-custody.
- **Tag authorship — settled, downgrade applied.** Composio tags tools best-effort from
  description and behavior, and **for MCP tools infers tags from the MCP server's hints** —
  third-party influence on tag values is real (docs.composio.dev/docs/tool-tags). The auto-apply
  eligibility rule above now requires an affirmative `createHint`/`updateHint` pair. Residual:
  whether toolkit vendors can directly set tags on non-MCP Composio toolkits is undocumented —
  the stricter rule covers that case too.
- **`input_required` — mostly settled.** Composio's changelog states that on the input-required
  path "Nothing was executed and the call is not retried" — supports the continuation's not-run
  claim on the documented path. Residuals: no public `request_state` TTL (local 1 h row expiry
  stands regardless); the guarantee is documented for the elicitation path, not sworn universal.
- **`tags.require_approval` — settled.** Per-toolkit override exists
  (`tools.<toolkit>.tags` replaces the session-wide approval list), so listed auto-apply
  toolkits can be exempted from server-held approval; it still never queues read-classified
  tools. Sources: docs.composio.dev/docs/approvals, tool-tags.
- **`GET /logs/tool_execution/{id}` — settled (docs).** Detail response = list shape plus
  `timings`, `context` (`session_id`/`trace_id`/`request_id`), `source`, and `data` (full
  request payload and response body) — sufficient as the outcome-unknown reconciliation handle;
  endpoint is auth-gated (401 envelope verified live).
- **`execute_meta` — settled: not a general fallback.** It executes `COMPOSIO_*` meta tools
  within a session only, gated by Session tool execution: Write. Session-MCP execution remains
  the only ordinary route; this item closes.

## Relationship to prior art

- `gatekeeper-mcp-portal` — the `byo`-tier posture inherited wholesale; the `#server=` scope
  seam deliberately *not* inherited (cannot express composio URLs).
- `gatekeeper-scheduler` — the bindHook/HookController trigger contract this design adopts
  verbatim, including the compat flag and the enable-in-Connections gate.
- `gatekeeper-x` — reserve-then-settle daily caps over a pay-per-call provider; terminal
  outcome-unknown handling with provider-side reconciliation ids.
- `gatekeeper-context` — the single-file app UI pattern (`app/`, bundled into `src/generated/`)
  and the dynamic `getAgentCatalog` + `catalogChange` lifecycle.
- `gatekeeper-websearch` — the auto-provisioned vendor skeleton and the `PASSTHROUGH`
  dev-var precedent.
- `gatekeeper-cloudflare` — the layering rule (`composio-api.ts` is the only HTTP module, every
  response validated) and the numeric-codes-only error logging.
- Composio Platform documentation — sessions, tool router, triggers, scoped keys, and webhooks;
  the fact base this design rests on was checked against live docs on 2026-10-26, and the
  residue is listed under Verification.
