# Synthetic market — governed connector contract

The `market` connector generalizes three existing designs without connecting
to any of their runtimes:

- GCL Apify supplies the owner gate, declared scope, cost ceiling, daily quota,
  SHA-256 audit chain, and untrusted-content-as-data boundary.
- Hub Connect supplies the distinction between a connector catalog and an
  enabled, consented, on-demand integration. Here both sources are only
  `NOT_CONTACTED`; there is no catalog credential, scheduler, or sync.
- Capacity Market supplies read-only discovery/quote intent and the separation
  between a quote and a human-initiated reservation. Here no offer is looked
  up, so a capacity quote remains `NOT_QUOTED`.

## Route and gates

~~~
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/market/runs
~~~

The standard product key, `X-Sectrai-Owner-Token`, and
`X-Sectrai-Owner-Actor` gates apply. The generic GCL runner writes the
requested/succeeded or requested/failed SHA-256 audit events and reserves the
`market` daily quota before a proposal is returned.

There is intentionally no HTTP endpoint for accepting a quote, reserving
capacity, booking, publishing, sending a handoff, or storing an owner
decision as mutable workflow state. This package adds only an in-process,
audit-backed review receipt for a plan that the caller already holds; it is
not an execution endpoint or a durable approval workflow.

## Request forms

Discovery requests accept exactly:

~~~json
{
  "input": {
    "operation": "freight-discovery",
    "transportMode": "road",
    "originCountry": "TR",
    "destinationCountry": "DE",
    "requestedListings": 1
  },
  "scopes": ["market:discover"],
  "costCapCents": 50,
  "requestedItems": 1
}
~~~

`capacity-discovery` has the same shape. A capacity quote proposal requires
`market:capacity:quote` and exactly one extra field:

~~~json
{
  "input": {
    "operation": "capacity-quote",
    "transportMode": "road",
    "originCountry": "TR",
    "destinationCountry": "DE",
    "requestedListings": 1,
    "requestedCapacityUnits": 1
  },
  "scopes": ["market:capacity:quote"],
  "costCapCents": 50,
  "requestedItems": 1
}
~~~

`requestedListings` must equal `requestedItems`, so a request cannot
understate its quota use. Country values are normalized two-letter codes.

`market:review` is a separate scope. It cannot run discovery or quote by
itself, and it cannot authorize any market action.

## Independent review receipt

The returned plan contains its maker, product/workspace binding, normalized
run scopes and limits, plus a deterministic SHA-256 digest. This lets the
local review helper reject an accidentally changed or cross-workspace plan
before it appends a `connector.market.owner_reviewed` audit event.

A review requires all of the following:

- the existing owner gate is true;
- the reviewer has `market:review`;
- the reviewer is not the plan maker;
- the decision is exactly `acknowledged` or `rejected`; and
- the plan still matches its deterministic binding.

The receipt is deliberately limited to `NOT_AUTHORIZED`. Both decisions keep
external network, reservation, booking and publication at `false`. In
particular, `acknowledged` is not “approved”, is not a consent to execute,
and cannot create an offer or reservation. The digest is a deterministic
binding check, not a signature, durable approval record, or authorization
token. Because this synthetic package owns no review storage, a future
durable, owner-designed workflow must handle mutable review state, idempotency
and final-decision rules separately.

## Synthetic-only boundary

There is no URL, `fetch`, SDK, credential field, provider configuration,
queue worker, scheduler, automatic sync, database reservation, booking, or
publication code. A successful run returns only an owner-review plan:

~~~json
{
  "mode": "SYNTHETIC",
  "liveStatus": "LIVE_DISABLED",
  "state": "OWNER_REVIEW_REQUIRED",
  "ownerReview": {
    "state": "PENDING_INDEPENDENT_OWNER_REVIEW",
    "requiredScope": "market:review",
    "makerCanReview": false,
    "automaticAction": false,
    "decisionAuthorizesExecution": false
  },
  "sources": [
    { "id": "internal-capacity-market", "state": "NOT_QUERIED" },
    { "id": "hub-connect", "state": "NOT_CONTACTED" }
  ],
  "sideEffects": {
    "externalNetwork": false,
    "reservation": false,
    "booking": false,
    "publication": false
  }
}
~~~

For `capacity-quote`, the response says `NOT_QUOTED`; it never fabricates
an offer or price. Request values remain
`UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`. `GCL_MARKET_LIVE_ENABLED=true`
is not an opt-in: it fails closed with `MARKET_LIVE_DISABLED`. The only value
that permits the synthetic adapter is the exact lowercase string `false`;
missing, uppercase, or any other value also closes it.

## Required configuration

No credential is accepted or read. Every limit and the exact disabled flag are
required; a missing or malformed value fails closed:

~~~dotenv
GCL_MARKET_LIVE_ENABLED=false
GCL_MARKET_MAX_COST_CENTS=50
GCL_MARKET_MAX_ITEMS=10
GCL_MARKET_MAX_CAPACITY_UNITS=10
GCL_MARKET_DAILY_RUN_QUOTA=10
GCL_MARKET_DAILY_ITEM_QUOTA=20
~~~
