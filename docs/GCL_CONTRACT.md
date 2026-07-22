# Governed Connector Layer (GCL) — synthetic L0 contract

GCL is the governed HTTP boundary for product-scoped synthetic adapters. It
does not import another product’s runtime, access another product’s database,
or make a provider call. Each product uses this versioned HTTP contract from
its own adapter.

## Connector contract

~~~ts
interface Connector<TInput, TData> {
  id: string
  kind: 'external-data' | 'market'
  authKind: 'owner-token' | 'oauth'
  quotaGroup?: string
  scopes: readonly string[]
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<TInput | void> | TInput | void
  run(input: TInput, ctx: ConnectorRunContext): Promise<{
    data: TData
    provenance: ConnectorProvenance
    confidence: number
  }>
}
~~~

Every registered connector is governed by these rules:

- Owner gate: the product key is supplemented by
  `X-Sectrai-Owner-Token`. An unset `GCL_OWNER_TOKEN` returns
  `503 connector_unavailable`; a wrong token returns
  `403 owner_approval_required`.
- Scope minimum: `scopes` must be non-empty and a subset of the connector’s
  declared scopes. The synthetic market connector additionally checks that
  its operation has its specific scope.
- Cost and quota: each call needs a positive `costCapCents` and
  `requestedItems`. The connector’s ceiling and grouped daily run/item quota
  are required. Missing or exceeded values reject the request before the
  proposal is accepted.
- Untrusted-content isolation: input-derived content returns in
  `provenance.untrustedContent` with `handling: 'data-only'` and
  `UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`. It is never an instruction,
  tool call, or system message.
- Audit: accepted runs receive requested/succeeded or requested/failed
  SHA-256 linked audit events. Each product/workspace chain is serialized by a
  PostgreSQL advisory transaction lock. A synthetic market plan may also
  receive a canonically reconstructed, independent owner-review packet in the
  same chain; D2's explicitly injected process-local review ledger permits at
  most one terminal decision for its exact plan/packet tuple. D3 can only
  canonically reconstruct the caller-held receipt for that decision; D4 can
  locally compare that receipt with one caller-held audit hash link; D5 can
  read-check only the caller-held requested/succeeded/review segment; D6 can
  only minimize and recheck that same segment; D7 can bind independently
  rebuilt D3 and D6 evidence into a still-smaller no-action manifest. D8
  hardens D2's injected terminal-ledger and audit-append ingress to exact
  own-data values only; a failed append remains undecided and retryable. D9
  snapshots caller-held plan material and validates host-ledger descriptors.
  D10 snapshots the review context's bounded scope data and invokes its one
  allowed clock seam only after descriptor validation, copying the returned
  intrinsic `Date`. D11 requires literal boolean owner approval at the runner,
  direct market, and independent-review boundaries before later seams are
  reached. D12 snapshots the complete governed-run envelope and its scope
  array through descriptors before connector preflight, audit, or quota can
  read it. D13 lets `market` return a canonical preflight snapshot, which the
  runner carries across its later asynchronous seams instead of the
  caller-held input. D14 copies market's exact scalar configuration at
  construction, so a caller cannot mutate its live gate or limits after
  preflight. D15 fixes the runner's audit/quota data-function members at
  construction, validates each audit hash result, and copies one verified
  clock instant before preflight, audit, or quota. None reads audit storage,
  writes, or approves execution. D16 snapshots direct market preflight/run
  context as exact own data and copies its one clock value before plan
  construction, so bypassing the runner cannot admit shaped context data or
  alter a synthetic plan. D17 fixes the selected synthetic connector instance,
  its private configuration reference, own run/preflight functions, and market
  scope tuple before the runner's asynchronous seams. D18 freezes every
  emitted synthetic market-plan branch before it crosses the caller boundary;
  a changed copy still requires canonical no-action review. D19 freezes the
  canonical review result and D3–D7 evidence branches before they cross their
  caller boundary; any changed copy remains fail-closed and no-action. D20
  freezes direct preflight plus direct/governed result and provenance egress,
  including the final audit-enriched result wrapper; any changed copy remains
  fail-closed and no-action.
  All resulting evidence remains `NOT_AUTHORIZED`.
- Fail closed: an unregistered connector, missing owner gate, invalid actor,
  missing limit/quota, wrong scope, or invalid input produces an explicit
  error. There is no local fallback, provider fallback, queue worker, or
  automatic activation.

`confidence` is not a correctness claim. The synthetic market connector has
no market source and returns `0`.

## HTTP contract

All GCL endpoints first apply the existing `X-Sectrai-Product-Key` product
boundary.

~~~text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/:connectorId/runs
GET  /api/products/:product/workspaces/:workspaceId/gcl/extensions
POST /api/products/:product/workspaces/:workspaceId/gcl/extensions
PATCH /api/products/:product/workspaces/:workspaceId/gcl/extensions/:recordId
DELETE /api/products/:product/workspaces/:workspaceId/gcl/extensions/:recordId
POST /api/products/:product/workspaces/:workspaceId/gcl/extensions/suggestions
~~~

The connector run endpoint also requires a verifiable
`X-Sectrai-Owner-Actor`. Its input is data belonging to the selected product
contract; it must be owner-verified before any later real-provider design can
be considered.

## Extensions marketplace model

~~~ts
type Extension = {
  id: string
  name: string
  sector: string[]
  role: 'ai-support' | 'add-on-module'
  connectorId: string
  defaultScopes: string[]
  consentState: 'pending' | 'granted' | 'revoked'
}
~~~

Extensions use the existing Record backbone at `moduleId = gcl-extensions`;
no migration was added. Creating, changing, or deleting one requires the
owner token. Suggestions are pure and deterministic: only
`consentState: 'granted'` records may be suggested, every result carries
`requiresOwnerApproval: true`, and no suggestion activates anything.

`gcl-audit` and `gcl-usage` are also reserved Record modules, so normal
record CRUD cannot mutate the audit chain or quota reservation history.

## Synthetic operating boundary

~~~dotenv
# Never commit a real owner token.
GCL_OWNER_TOKEN="replace-with-owner-secret"

# Market is permanently synthetic. Only exact lowercase false is accepted;
# missing, true, uppercase, and malformed values fail closed.
GCL_MARKET_LIVE_ENABLED=false
GCL_MARKET_MAX_COST_CENTS=50
GCL_MARKET_MAX_ITEMS=10
GCL_MARKET_MAX_CAPACITY_UNITS=10
GCL_MARKET_DAILY_RUN_QUOTA=10
GCL_MARKET_DAILY_ITEM_QUOTA=20
~~~

This worktree contains no provider endpoint, SDK, API key, credential,
background sync, reservation, booking, publishing, or live execution path.
Setting any value other than `GCL_MARKET_LIVE_ENABLED=false` returns
`MARKET_LIVE_DISABLED`; it does not enable anything. A market review packet
is deliberately not an HTTP action endpoint, a persisted approval workflow,
or an authorization token. D2's local-only in-memory ledger prevents a
duplicate receipt only within the injected process; it is not durable,
cross-process replay prevention. D3's receipt revalidation reads neither that
ledger nor the audit chain and performs no write. D4 accepts one caller-held
audit event and predecessor hash only to recompute the receipt's single
hash-chain link. D5 checks only the internal continuity of one caller-held
requested/succeeded/review segment; it does not prove its first predecessor or
any durable retention. D6 can only render and recheck a minimized,
digest-bound form of that same supplied segment; it adds no storage lookup or
write. D7 can bind independently rebuilt D3 and D6 evidence into a smaller,
digest-only no-action manifest, also without storage access. D8 admits only
exact own-data records/results at D2's injected terminal-ledger seam; it is
still process-local, no-action, and retryable after a failed append.
D9 snapshots caller-held plan material and checks the injected ledger
descriptor/result boundary. D10 snapshots review-context data and copies one
verified intrinsic clock value; shaped context, scope, clock, and date values
fail closed. D11 rejects every non-boolean owner-approval lookalike before a
direct run or review can reach later seams. D12 additionally requires the
governed runner's exact own-data request envelope
`{ connectorId, input, product, workspaceId, actor, ownerApproved, scopes,
costCapCents, requestedItems }`; accessor-, Proxy-, inherited-, hidden-,
symbol-, sparse-scope-, and extra-field (including credential-shaped) values
fail closed as `INVALID_CONNECTOR_RUN_REQUEST` before preflight, audit, or
quota. It copies the envelope primitives and scope strings only; `input`
remains opaque data for the selected connector's own parser. D13 lets that
parser return a canonical market copy for the runner to use after its audit
and quota awaits, so a caller mutation cannot alter an already accepted market
request. D14 copies the connector's exact scalar configuration at construction
and rejects accessor-, Proxy-, inherited-, hidden-, symbol-, and extra
credential-shaped configuration before preflight, audit, or quota. D15 fixes
the injected runner audit/quota data-function members at construction, rejects
shaped or malformed audit results, and copies one verified clock value before
preflight, audit, or quota. D16 also snapshots direct market preflight/run
contexts as exact own data and copies their one clock result before plan
construction; credential-shaped or malformed contexts fail closed. D17 fixes
the selected synthetic connector binding and its scope tuple before the
runner's asynchronous seams. D18 freezes the emitted synthetic plan's known
data branches before it reaches a caller. D19 freezes the canonical review
result and every D3–D7 emitted evidence branch before they reach a caller.
D20 freezes direct preflight and direct/governed result/provenance branches
after audit enrichment. D3/D4/D5/D6/D7/D8/D9/D10/D11/D12/D13/D14/D15/D16/D17/D18/D19/D20 are local mutation checks or
boundary hardening, never signatures, credentials, approval workflows, or
execution paths. The specific market
inputs and output limits are in [the synthetic market contract](GCL_MARKET_CONTRACT.md).

## Privacy, KVKK, and content boundary

Market request fields can be sensitive business data. The product adapter is
responsible for data minimization, purpose limitation, appropriate notice and
consent, retention, and access requests. GCL keeps request-derived content
data-only. A real market integration, legal review, source terms review, and
any owner decision to handle real data are outside this scope.
