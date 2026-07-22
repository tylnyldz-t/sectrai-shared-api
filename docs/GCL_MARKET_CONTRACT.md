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

## D3 — local receipt reconstruction and mutation check

Once D2 has returned its single terminal decision,
`independentlyReviewSyntheticMarketPlan()` also returns a deterministic
`synthetic-market-review-receipt-v1`. It binds digests of the original
product/workspace, plan, packet, reviewer, terminal decision, canonical review
time, and audit hash. Its only execution object remains exactly
`NOT_AUTHORIZED`, with all egress, reservation, booking, and publication flags
set to `false`.

`validateSyntheticMarketReviewReceipt(sourcePlan, reviewResult, context)` is a
library-only, read-only revalidation seam. It first reconstructs the original
plan, requires `market:review`, reconstructs the expected receipt from the D2
result, and compares the complete canonical form. It does **not** query the
in-memory ledger or audit chain, append an event, consume quota, contact a
provider, send a handoff, or authorize a market action. It is a mutation check
for caller-held evidence, not audit-chain verification, a signature,
authentication credential, durable approval, or an execution token.

The verifier default-denies unknown or hidden fields, non-plain/prototype-shaped
objects, symbol fields, sparse arrays, altered execution flags, malformed
timestamps or digest shapes, cross-scope inputs, maker-as-checker evidence, and
any receipt/plan/integrity drift. The request parser applies the same
plain-object and exact-field boundary, so inherited or hidden request fields
cannot become synthetic market input.

## D4 — caller-held review audit-witness link check

`validateSyntheticMarketReviewAuditWitness(sourcePlan, reviewResult, witness,
context)` is a library-only, read-only check for a caller-held audit record of
the shape below:

```ts
{
  version: 'synthetic-market-review-audit-witness-v1',
  event: ConnectorAuditEvent,
  previousHash: string | null,
  hash: string,
}
```

It first runs the D3 receipt reconstruction, then reconstructs the one allowed
`connector.market.owner_reviewed` event from that result. That event has the
exact `market:review` scope, zero cost, one requested item, canonical reviewer
and time, the plan/packet digests, and all market-action flags set to `false`.
Finally it recomputes `hashAuditEvent(event, previousHash)` and requires the
result to equal both the witness hash and the receipt audit hash.

D4 default-denies unknown, hidden, inherited, prototype-shaped, or
credential-shaped witness fields; any event, action flag, predecessor hash,
receipt, product/workspace, reviewer, scope, or hash drift is rejected. Its
review context is now also an exact plain object, so inherited or injected
context properties cannot be used at this boundary.

This is a **single caller-held link check**, not audit-store lookup or chain
verification. A syntactically valid witness does not prove that a durable audit
store retained the event, that a preceding event really exists, or that a full
chain is intact. D4 reads no audit/ledger storage, writes no event, consumes no
quota, and remains neither a signature, credential, authorization, workflow,
nor execution token.

## D5 — caller-held three-event audit-trail continuity check

`validateSyntheticMarketReviewAuditTrailWitness(sourcePlan, reviewResult,
trail, context)` is a library-only, read-only check of exactly these
caller-supplied entries:

1. `connector.run.requested`
2. `connector.run.succeeded`
3. `connector.market.owner_reviewed`

Each entry must be a strict plain-data object with only allowlisted own
enumerable data fields, a canonical SHA-256-shaped hash, a canonical timestamp,
and no symbols, hidden fields, accessors, inherited values, or Proxy shape.
The requested and succeeded events must match the plan's product, workspace,
maker, normalized scopes, cost cap, and item count. D5 recomputes their hashes,
requires the requested hash to be both the succeeded predecessor and
`requestedAuditHash`, then requires the succeeded hash to be the D4 review
entry predecessor. Event times must be non-decreasing.

On success D5 returns only a fixed-no-action
`synthetic-market-review-audit-trail-witness-v1` with the three hashes, plan
and review IDs, and the caller-supplied first predecessor. It does not return
request content, actor identities, offers, prices, provider data, or a
capability.

D5 verifies continuity only inside this supplied three-event segment. It does
**not** read a database, prove any event was stored, prove the first predecessor
exists, append an event, consume quota, create a route, contact a provider,
send a handoff, reserve/book/publish, or authorize execution. It is an unkeyed
mutation check, not a signature, credential, durable replay guard, or
authorization token.

## D6 — minimized audit-trail receipt

`createSyntheticMarketReviewAuditTrailReceipt(sourcePlan, reviewResult, trail,
context)` first repeats D5's strict reconstruction of the caller-supplied
three-event segment. It then returns only a fixed-no-action receipt containing
product/workspace digests, plan/review IDs, the three event hashes, the first
predecessor hash, and an unkeyed SHA-256 integrity digest. It omits the market
request, actor identities, review decision, offer/price/provider data, and any
credential or action capability.

`validateSyntheticMarketReviewAuditTrailReceipt(sourcePlan, reviewResult,
trail, receipt, context)` accepts only an exact own-data receipt, rebuilds the
D5 segment and expected receipt, and compares its canonical receipt ID and
integrity. Unknown, hidden, symbol, accessor, inherited, Proxy, credential-
shaped, malformed, cross-workspace, or mutated values fail closed before a
result is returned; getters and Proxy traps are not evaluated.

D6 is a library-only, read-only rendering and check. It does not read or write
storage, consume quota, append audit, add a route, contact a provider, send a
handoff, reserve/book/publish, or authorize execution. It proves neither
durable retention nor the first predecessor. Its digest is mutation evidence,
not a signature, credential, durable audit proof, replay guard, or execution
token.

## D7 — compact review-evidence manifest

`createSyntheticMarketReviewEvidenceManifest(sourcePlan, reviewResult, trail,
context)` independently rebuilds D3's review receipt and D6's audit-trail
receipt, then produces the compact
`synthetic-market-review-evidence-manifest-v1`. It contains only digests of
the product/workspace, plan/review IDs, the two reconstructed evidence
integrity digests, and fixed synthetic/no-action state. It deliberately omits
the market request, origin/destination, transport mode, capacity units, maker
and reviewer identities, decision, individual audit hashes, provider details,
offer/price data, credentials, and every action capability.

`validateSyntheticMarketReviewEvidenceManifest(sourcePlan, reviewResult,
trail, manifest, context)` accepts only an exact own-data manifest, rebuilds
the same D3/D6 evidence, recomputes the manifest ID and SHA-256 integrity, and
compares the whole canonical form. Unknown, hidden, symbol, accessor,
inherited, Proxy, credential-shaped, cross-workspace, or mutated values are
rejected without evaluating getters or Proxy traps.

D7 is a library-only, read-only minimization seam. It does not read or write
storage, consume quota, append audit, add a route, contact a provider, send a
handoff, reserve/book/publish, or authorize execution. Its unkeyed digest is
mutation evidence only—not a signature, credential, durable audit proof,
replay guard, authorization, or execution token.

## D8 — strict terminal-ledger ingress and retry boundary

D8 hardens the injected, process-local D2 terminal ledger without broadening
its authority. Before a decision can enter the ledger, the entry must be an
exact plain own-data record with all and only the documented fields. Inherited
values, null/prototype-shaped objects, hidden fields, symbol fields, accessors,
and Proxies are rejected before any field is read or audit append is attempted.
This keeps the maker, reviewer, decision, plan binding, and review time as
bounded data rather than executable object behavior.

The injected audit append result is likewise accepted only as an exact plain
own-data `{ hash }` object with a lowercase SHA-256 digest. Getter- or
Proxy-shaped results, extra fields, and malformed hashes fail closed as
`MARKET_REVIEW_AUDIT_APPEND_INVALID`; none creates a terminal entry. A failed
append does not decide the tuple, so a later retry may succeed, but the first
valid terminal append still consumes the sole process-local decision. This is
not persistence, cross-process replay prevention, authorization, or an action
capability.

D8 remains entirely in-process: it adds no route, migration, database table,
worker, queue, provider configuration, credential, network call, quote,
reservation, booking, publication, handoff, or sending path. Its successful
result remains fixed at `NOT_AUTHORIZED` through the existing D2 receipt.

## D9 — deep review-plan and host-ledger result boundary

D9 snapshots the complete caller-held review plan into a bounded JSON-like
own-data tree before the validator reads its binding, request, sources,
side-effect flags, or review packet. Every object must have the normal
`Object.prototype`; every collection must be a bounded dense
`Array.prototype` array with only own numbered data elements. Non-enumerable
fields, symbols, accessors, Proxies, prototype-shaped values, cyclic aliases,
non-finite numbers, and unsupported values fail closed as
`MARKET_REVIEW_PLAN_INTEGRITY_INVALID` before a semantic field is read. The
existing full-plan reconstruction still rejects unknown-but-plain fields after
that snapshot.

The injected D2 ledger remains a host-owned executable seam, so D9 does not
claim to sandbox its implementation. It obtains `recordTerminalReview` only
from a data-property descriptor; a getter- or Proxy-shaped ledger member is
rejected without evaluation. Its returned value must then be an exact plain
own-data `{ hash }` record carrying a lowercase SHA-256 digest. Accessor,
Proxy, inherited, hidden, symbol, extra, and malformed results fail closed as
`MARKET_REVIEW_AUDIT_APPEND_INVALID` and cannot create a D2/D3 receipt.

D9 is a local validation boundary only. It adds no credential, signature,
database/migration, route, worker, queue, provider configuration, network
call, quote, reservation, booking, publication, handoff, sending path,
durable approval, or authorization capability. Its successful review output
continues to be exactly `NOT_AUTHORIZED`.

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

## D1/D2/D3/D4/D5/D6/D7/D8/D9 test evidence and ADOS 10-rule conformance

`test/gcl-market.unit.test.ts` covers the normal synthetic packet, D1 packet
integrity, D2 terminal-ledger paths, D3 local receipt reconstruction, and D4
caller-held audit-witness link reconstruction, plus D5 caller-held
requested/succeeded/owner-review continuity reconstruction, D6's minimized,
context-bound rendering of that exact segment, and D7's compact binding of
independently rebuilt D3 and D6 evidence, plus D8's exact-data terminal-ledger
and audit-append boundary. D9 snapshots every caller-held review-plan branch
before semantic reads and validates the injected ledger's member/result
descriptors before any review receipt can be returned.
Negative tests reject inherited/prototype-shaped input, injected or hidden
provider-shaped fields, sparse arrays, source-state drift, invented quote data,
action-flag drift, cross-workspace use, whitespace-based maker/reviewer bypass
attempts, missing ledger, invalid review clock, malformed audit result,
malformed direct-run context, malformed receipt execution/integrity, malformed
or credential-shaped D4 witnesses, changed audit events/action flags,
predecessor/hash drift, sequential/concurrent replay attempts, and D5
discontinuous, semantically mismatched, time-inverted, hidden-field,
accessor-shaped, and Proxy-shaped trail evidence. D6 additionally rejects
mutated hashes/receipt IDs, credential-shaped, hidden, symbol, prototype,
accessor, and Proxy-shaped receipt evidence. D7 additionally rejects a
substituted D3/D6 integrity digest, scope-binding or manifest-ID drift, and
credential-shaped, hidden, symbol, accessor, and Proxy-shaped manifests.
D8 rejects inherited, hidden, symbol, accessor, and Proxy-shaped ledger
entries before audit append, rejects accessor- and Proxy-shaped append results
without marking a decision, and proves that a malformed append leaves the
tuple retryable. D9 additionally rejects root/nested plan accessors, hidden or
symbol-shaped nested values, sparse source arrays, plan Proxies, getter-shaped
ledger members, and accessor/Proxy-shaped injected ledger results without
evaluating those values. D3/D4/D5/D6/D7 rejection produces no extra review
event, quota item, or local terminal entry. A D9 plan or ledger-member failure
occurs before the ledger call; a host-owned ledger that is invoked and returns
invalid data remains unable to create a local receipt.

1. Every plan and packet is bound to exactly one product/workspace data plane.
2. Only the bounded synthetic request is accepted; no provider response is
   ingested.
3. Configuration default-denies; only exact `LIVE_ENABLED=false` permits this
   synthetic adapter.
4. Full canonical reconstruction rejects changed, malformed, unknown,
   prototype-shaped, and sparse packet fields; D2 permits one process-local
   terminal receipt only after a valid audit append, D3 rechecks its local
   receipt without a write, and D4 rechecks one caller-held audit hash link
   without reading or writing audit storage. D5 rechecks only a caller-held
   requested/succeeded/review segment without a write or storage lookup; D6
   can only minimize and recheck that same segment; D7 can only bind the
   rebuilt D3/D6 evidence into a still-smaller no-action manifest; D8 admits
   only exact own-data ledger/audit ingress and leaves a malformed append
   undecided; D9 snapshots all caller-held plan material and rejects shaped
   host-ledger results before a receipt can be formed.
5. Request content is explicitly data-only, never an instruction.
6. Owner gate, `market:review`, and maker–checker separation are mandatory.
7. The module has no network client, provider URL, credential/API-key field,
   scheduler, or automatic sync.
8. Preflight, cost caps, independent grouped quotas, and the scoped SHA-256
   audit chain bound every run; D5/D6/D7 only check a caller-held three-event
   segment, a minimized rendering, and a further compact binding of it; D8
   only hardens D2's in-process append seam and D9 only validates in-process
   review inputs/results.
9. A review and its D3/D4/D5/D6/D7/D8/D9 evidence cannot quote, reserve, book,
   publish, hand off, notify, send, or trigger an automatic action.
10. This package has no production migration, `main`/production write, live
    launch, or market-provider integration.

## Explicit non-goals

There is no real credential/API key, live/provider call, sending, capacity
lookup, quote, reservation, booking, publication, handoff, background worker,
durable review store, production migration, live launch, or write to
`main`/production in D1/D2/D3/D4/D5/D6/D7/D8/D9.
