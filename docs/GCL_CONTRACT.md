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
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<void> | void
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
  canonically reconstruct the caller-held receipt for that decision; it does
  not write or approve execution. Both records remain `NOT_AUTHORIZED`.
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
ledger nor the audit chain and performs no write; it is only a caller-held
mutation check. The specific market inputs and output limits are in [the
synthetic market contract](GCL_MARKET_CONTRACT.md).

## Privacy, KVKK, and content boundary

Market request fields can be sensitive business data. The product adapter is
responsible for data minimization, purpose limitation, appropriate notice and
consent, retention, and access requests. GCL keeps request-derived content
data-only. A real market integration, legal review, source terms review, and
any owner decision to handle real data are outside this scope.
