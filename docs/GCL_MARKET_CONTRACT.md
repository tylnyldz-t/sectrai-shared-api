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

## D1 — canonical independent review packet

The returned plan now contains `synthetic-market-review-packet-v1`. It binds
the plan digest, a product/workspace/maker/scopes/cost/item binding digest,
and an independently derived packet digest to a deterministic review ID. Its
only execution state is permanently `NOT_AUTHORIZED`, with external network,
reservation, booking, and publication all `false`.

`validateSyntheticMarketPlanForReview()` reconstructs the complete canonical
plan before the local review helper appends a
`connector.market.owner_reviewed` event. It does not merely compare the
top-level plan digest. The reconstructed result must also have the exact
synthetic source states, `NOT_QUOTED` shape, side-effect flags, owner-review
flags, packet fields, normalized scope ordering, and packet integrity digest.
An added field (including a credential/provider-shaped field), changed source
state, invented quote, action flag, malformed packet, changed maker, or
cross-product/workspace packet is rejected before the review audit append.

Maker and reviewer identifiers are canonical at this boundary: valid values
cannot have leading or trailing whitespace. That prevents a whitespace variant
of the maker from bypassing the independent-review check. Identity
canonicalization beyond this bounded string rule remains the responsibility of
the authenticated product host.

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
binding check, not a signature or authorization token. D1 has no state
transition: a receipt can never make a market action available.

## D2 — process-local terminal review ledger

`InMemorySyntheticMarketReviewLedger` is the next, deliberately narrow
package. `independentlyReviewSyntheticMarketPlan()` now requires an injected
ledger and lets it append exactly one terminal receipt for the canonical
`product/workspace/planId/reviewPacketIntegrityDigest` tuple. It serializes
same-plan calls, so concurrent opposite decisions yield one receipt and one
rejected replay; an additional sequential decision also fails closed with
`MARKET_REVIEW_ALREADY_DECIDED`.

The ledger validates its already-canonical entry and only marks the tuple
decided after its `connector.market.owner_reviewed` audit append returns a
SHA-256-shaped hash. A missing ledger, invalid review clock, malformed ledger
entry, or malformed audit result fails before it creates a local terminal
receipt. The review context likewise default-denies malformed product,
workspace, scope, and clock values; direct connector calls cannot create a
plan with an unknown market scope or malformed product/workspace identifier.

This is intentionally an **in-memory, process-local** guard. It adds no
database table, migration, Prisma adapter, HTTP route, background worker, or
cross-process state; its entries disappear on restart. It is consequently not
a durable review workflow, signature, global replay-prevention mechanism, or
authorization record. A future durable owner-controlled host must still
supply its own atomic scoped state, retention, idempotency/replay, final
decision, legal/ToS, and execution rules—and must fail closed until it does.
D2 never turns a receipt into an offer, quote, reservation, booking,
publication, handoff, notification, provider call, or sending action.

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
  "reviewPacket": {
    "version": "synthetic-market-review-packet-v1",
    "state": "PENDING_INDEPENDENT_OWNER_REVIEW",
    "automaticAction": false,
    "execution": {
      "state": "NOT_AUTHORIZED",
      "externalNetwork": false,
      "reservation": false,
      "booking": false,
      "publication": false
    }
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

## D1/D2 test evidence and ADOS 10-rule conformance

`test/gcl-market.unit.test.ts` covers the normal synthetic packet, D1 packet
integrity, and D2 terminal-ledger paths. Negative tests reject injected
provider-shaped fields, source-state drift, invented quote data, action-flag
drift, cross-workspace use, whitespace-based maker/reviewer bypass attempts,
missing ledger, invalid review clock, malformed audit result, malformed direct
run context, and sequential/concurrent replay attempts before another review
event or quota item can be created.

1. Every plan and packet is bound to exactly one product/workspace data plane.
2. Only the bounded synthetic request is accepted; no provider response is
   ingested.
3. Configuration default-denies; only exact `LIVE_ENABLED=false` permits this
   synthetic adapter.
4. Full canonical reconstruction rejects changed, malformed, and unknown
   packet fields; D2 permits one process-local terminal receipt only after a
   valid audit append.
5. Request content is explicitly data-only, never an instruction.
6. Owner gate, `market:review`, and maker–checker separation are mandatory.
7. The module has no network client, provider URL, credential/API-key field,
   scheduler, or automatic sync.
8. Preflight, cost caps, independent grouped quotas, and the scoped SHA-256
   audit chain bound every run.
9. A review cannot quote, reserve, book, publish, hand off, notify, send, or
   trigger an automatic action.
10. This package has no production migration, `main`/production write, live
    launch, or market-provider integration.

## Explicit non-goals

There is no real credential/API key, live/provider call, sending, capacity
lookup, quote, reservation, booking, publication, handoff, background worker,
durable review store, production migration, live launch, or write to
`main`/production in D1/D2.
