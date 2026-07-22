# GM2 Camera Observation Contract

Status: `SYNTHETIC_ONLY` · `LIVE_DISABLED` · `FIXTURE_ONLY` · `NO_CAMERA_SDK` · `NO_NETWORK_EGRESS` · `NO_BIOMETRICS`.

`camera-observation` is a GCL adapter for bounded, built-in safety fixtures. It is not a camera connection, video pipeline, OCR service, device registry, surveillance system, biometric processor, or notification/action service. It has no credential field, provider configuration, HTTP client, stream URL, device address, serial number, snapshot, video byte, or media upload input.

## Run contract

The route remains the existing owner-gated GCL endpoint:

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/camera-observation/runs
```

The request contains exactly a synthetic fixture ID, fixture purpose, granted synthetic KVKK consent assertion, scope, positive cost/item values, and an opaque correlation ID. The adapter resolves only these server-bundled fixtures:

| Fixture | Purpose | Synthetic finding |
| --- | --- | --- |
| `synthetic-loading-dock-001` | `operational-safety` | `PPE_DRILL_INDICATOR` |
| `synthetic-perimeter-001` | `site-security` | `ACCESS_POINT_DRILL_INDICATOR` |
| `synthetic-fire-drill-001` | `operational-safety` | `FIRE_DRILL_INDICATOR` |

The request must have `synthetic: true`, `camera:observe`, a granted `kvkk-synthetic-v1`/`synthetic-fixture` consent record, a separately authenticated owner token, and different maker/checker actors. Missing synthetic enablement or limits fails closed. `GCL_CAMERA_LIVE_ENABLED=true` produces `CAMERA_LIVE_DISABLED`; it cannot opt into a live device.

Preflight (configuration, cap/item, strict input, consent, fixture/purpose binding) happens before the audit `requested` event and quota reservation. A successful run has `confidence: 0`, `mode: SYNTHETIC`, and `LIVE_DISABLED`; it reports raw media, stream connection, retained device identifier, biometric inference, and identity resolution as unavailable/not performed. Results always remain `OWNER_REVIEW_REQUIRED`, `NOT_EXECUTED`, `NOT_SENT`, and `NOT_PUBLISHED`.

## D1 — independent review packet

Each fixture result contains `synthetic-camera-review-packet-v1`, comprising:

- a product/workspace digest binding;
- a fixture-observation digest and deterministic review ID;
- an integrity digest over the fixed observation, privacy, review, and scope fields; and
- permanent `rawMediaIncluded: false`, `automaticAction: false`, `notification: NOT_SENT`, and `publication: NOT_PUBLISHED` flags.

`independentlyReviewCameraObservation()` is intentionally a library seam, not a public HTTP endpoint or a state transition. Before it writes its sole `connector.camera.owner_reviewed` audit event, it reconstructs and verifies the packet. Extra/raw-media-shaped fields, changed fixture findings, changed privacy/review flags, stale/non-pending packet flags, malformed digests, cross-product/workspace use, owner-gate failure, malformed reviewer, or review by the original maker all fail before that append.

The digest is deliberately unkeyed: it is an in-process mutation/tamper check, not a signature, credential, authorization proof, or permission to transfer data. A later product-owned host would need its own scoped persistence lookup and explicit owner decision to make a review actionable. That host is not implemented here.

An `approved` or `rejected` return value only records the decision in the existing scoped SHA-256 audit chain. It does not mutate the camera result; it leaves handoff, action, notification, and publication at `NOT_SENT`/`NOT_EXECUTED`. It neither consumes another quota item nor persists media or review state.

## D2 — minimized review receipt

The D1 library result now carries `synthetic-camera-review-receipt-v1`. It is a
strict, minimized evidence envelope containing only the review/packet IDs,
fixture-observation and packet digests, product/workspace digests, a digest of
the normalized reviewer identity, decision/time, existing audit hash, and fixed
`SYNTHETIC`/`LIVE_DISABLED`/no-action flags. The raw reviewer string, consent
receipt, camera fixture ID, media, device information, and observations are not
copied into the receipt.

`validateCameraReviewReceipt(sourceResult, reviewedResult, context)` is also a
library-only seam. It rebuilds D1's fixture packet and then verifies the D2
receipt's exact shape, canonical timestamp, source packet link, data-plane
binding, reviewer digest, fixed no-action fields, and deterministic integrity
digest. Unknown/raw-media-shaped fields, a changed audit hash or decision,
cross-workspace use, malformed digests, inherited/prototype-shaped inputs, and
any changed receipt field fail closed. Validation is read-only: it consumes no
quota, appends no audit event, opens no route, and creates no durable state.

The D2 receipt digest is deliberately unkeyed. It detects accidental or
in-process mutation only; it does not prove an audit-chain lookup, authenticate
a reviewer, grant a capability, transfer data, send a notification, authorize a
handoff, or permit an action. A future product-owned host would need its own
scoped durable lookup and a separate explicit owner decision. That host is not
implemented here.

## D3 — strict JSON-data boundary

All camera input and D1/D2 review evidence objects now pass through one strict
data-boundary parser. It accepts only an ordinary or null-prototype record with
allowlisted **own, enumerable data properties**. Non-enumerable fields, symbol
keys, accessor/getter/setter properties, Proxy values, inherited/prototype-shaped
records, and every unrecognised field are rejected before a value is read.
Accepted properties are copied into a null-prototype record before validation
proceeds.

This closes the gap where an otherwise hidden snapshot, device/stream value, or
an accessor-shaped value could evade an `Object.keys()`-based field check. A
rejecting getter or Proxy trap is not evaluated. D3 covers initial camera input,
consent, the source result, D1 packet, D2 receipt, review details, handoff, and
their scope bindings. It adds no route, quota use, audit append, persistence,
media handling, device connection, credential surface, or external call.

## D4 — read-only audit witness match

`validateCameraReviewAuditWitness(sourceResult, reviewedResult, auditEntry,
context)` is a library-only, read-only cross-check for a caller-supplied
`connector.camera.owner_reviewed` hash-chain entry. It first repeats the D1/D2
checks, then requires the entry's exact data-only shape, canonical timestamp,
product/workspace/correlation binding, maker/reviewer binding, sole
`camera:observe` scope, fixed no-media/no-action detail, and SHA-256 entry
hash. The supplied entry hash must equal the D2 review receipt's audit hash.
On success it returns only a minimized, fixed no-action witness; it does not
return the audit event, raw media, consent, device data, or reviewer identity.

D4 does **not** query storage, create a lookup route, append an audit event,
consume quota, verify a predecessor exists, authenticate an actor, or prove a
durable audit-chain read. Its SHA-256 check is deliberately unkeyed and only
detects accidental or in-process mutation of the caller-supplied entry. It is
not a signature, credential, authorization, handoff, publication, or action
capability. A scoped durable audit lookup remains a separate, future
product-owned owner decision and is not implemented here.

## D5 — read-only three-event audit-trail witness

`validateCameraReviewAuditTrailWitness(sourceResult, reviewedResult, trail,
context)` is a library-only check of exactly three caller-supplied events:
`connector.run.requested`, `connector.run.succeeded`, and
`connector.camera.owner_reviewed`. Every entry must have the strict D3
data-only shape and a valid SHA-256 hash. D5 requires the requested hash to be
the succeeded event's predecessor and `requestedAuditHash`, then requires the
succeeded hash to be the owner-review event's predecessor. It additionally
binds both run events to the product/workspace, maker/checker, correlation ID,
sole `camera:observe` scope, cost/item bounds, canonical event ordering, and
the existing D1/D2/D4 review result.

The only successful return is a minimized fixed-no-action witness carrying the
three hashes, review ID, and the first entry's supplied predecessor hash. It
does not return observations, consent, fixture IDs, raw media, device data, or
actor identities. Hidden/symbol/Proxy/accessor/inherited fields, media/device
shapes, duplicate/missing events, non-canonical timestamps, changed hashes,
chain discontinuity, or cross-scope/actor/cost semantics fail closed before a
result is returned.

D5 verifies continuity only inside that caller-supplied segment. It does
**not** query a database, establish that the supplied events were ever stored,
prove that the segment's first predecessor exists, append an event, consume
quota, create a route, authenticate a person, send a handoff, or authorize an
action. Like D1–D4, every digest is unkeyed mutation evidence—not a signature,
credential, delivery instruction, or capability. A durable audit lookup and
any product action remain separate future owner decisions and are not
implemented here.

## D6 — minimized audit-trail receipt

`createCameraReviewAuditTrailReceipt(sourceResult, reviewedResult, trail,
context)` first repeats D5's strict reconstruction of the caller-supplied
three-event segment, then returns only a fixed-no-action receipt: product and
workspace digests, review ID, the three event hashes, the supplied first
predecessor hash, and an integrity digest. It omits the observation, fixture
ID, consent, raw media, device information, actor identities, and review
decision text.

`validateCameraReviewAuditTrailReceipt(sourceResult, reviewedResult, trail,
receipt, context)` requires an exact D3-style own-data receipt and rebuilds
the expected D5 witness before comparing the canonical receipt ID and digest.
Unknown, hidden, symbol, Proxy, accessor, inherited, raw-media/device-shaped,
cross-workspace, malformed, or mutated input fails closed without evaluating
an accessor or Proxy trap.

D6 is a library-only, read-only rendering and check. It neither reads nor
writes storage, consumes quota, adds a route, authenticates an actor, sends a
handoff, publishes anything, or authorizes an action. Its SHA-256 digest is
deliberately unkeyed mutation evidence, not a signature, credential, durable
audit proof, or replayable capability. It verifies only the supplied D5
segment; no future product action is implemented here.

## D7 — minimized review-evidence manifest

`createCameraReviewEvidenceManifest(sourceResult, reviewedResult, trail,
context)` first independently rebuilds D6's supplied three-event segment and
D2's review receipt. It then emits only a compact link between those two
integrity digests: product/workspace digests, review ID, the D2 receipt
integrity digest, the D6 audit-trail receipt integrity digest, and fixed
no-action flags. It intentionally omits the fixture, finding, consent, raw
media, device information, reviewer identity, decision text, and audit hashes.

`validateCameraReviewEvidenceManifest(sourceResult, reviewedResult, trail,
manifest, context)` accepts only an exact D3-style own-data manifest and
reconstructs both D2 and D6 before checking its canonical ID and digest.
Unknown, hidden, symbol, Proxy, accessor, inherited, raw-media/device-shaped,
cross-workspace, malformed, or mutated input fails closed without evaluating an
accessor or Proxy trap.

D7 is a library-only, read-only minimization seam. It does not query or write
storage, consume quota, create a route, authenticate a person, disclose an
audit event, send a handoff, publish, notify, or authorize an action. Its
digest is deliberately unkeyed mutation evidence—not a signature, credential,
durable proof, delivery instruction, or replayable capability. It verifies
only caller-supplied D1–D6 evidence; durable lookup and every product action
remain separate future owner decisions and are not implemented here.

## D8 — strict caller review-context boundary

All D1–D7 library seams now parse their caller-supplied review context through
the same own-data boundary as evidence. The permitted context names are only
the documented product/workspace, maker/checker, correlation, owner, scope,
cost/item, and local `now` clock fields; each present field must be an own,
enumerable data property. The documented small context subsets remain valid,
as does the full runner context.

An extra raw-media/device-shaped field, hidden field, symbol, accessor,
Proxy, inherited/prototype-shaped record, malformed scope/actor/correlation,
non-positive cap/item value, or non-function clock fails closed. The parser
copies data before use, so it neither evaluates a getter nor a Proxy trap. D8
does not add a context API, route, storage read/write, quota use, audit append,
credential, or capability. In particular, an invalid context is rejected
before `independentlyReviewCameraObservation()` can append its review event.

## D9 — strict local review-clock boundary

`independentlyReviewCameraObservation()` has one documented callable
caller-context value: the local `now` clock. D9 rejects a Proxy clock function
before it is invoked. Its return value must be a non-Proxy native `Date` with a
finite timestamp. The timestamp is rendered with `Date`'s own methods, not a
caller-provided `toISOString` override. A thrown clock, invalid `Date`, forged
date-shaped object, or Proxy-wrapped `Date` therefore fails closed before the
owner-review audit append.

D9 does not add a time service, route, storage read/write, quota use,
credential, delivery, handoff, notification, publication, action, or durable
state. It only prevents malformed caller clock values from reaching the
existing synthetic review audit record. The clock is not an authorization or a
capability; all D1–D9 digests remain unkeyed mutation checks.

## D10 — strict execution context and provenance-clock boundary

`SyntheticCameraConnector.preflight()` and `.run()` now apply the same exact
own-data rule to their complete execution context, even when an adapter is
called directly as a library. The only accepted fields are the documented
product/workspace, maker/checker, correlation, owner, scope, cost/item, and
local `now` fields. Hidden, symbol, inherited, accessor, Proxy, or
media/device-shaped context is rejected before the fixture input is read.
The context must retain the one `camera:observe` scope, positive bounded
request values, separate valid actors, and an explicit owner-approved state.

The result’s `provenance.retrievedAt` is produced only by a non-Proxy local
clock that returns a finite native `Date`. It uses native `Date` methods, so a
forged `toISOString`, invalid date, date-shaped object, thrown clock, or
Proxy-wrapped clock value fails closed. `preflight()` validates that same clock
before quota reservation; a bad clock therefore produces the existing governed
denial path with no quota item consumed. The timestamp is descriptive synthetic
provenance only, never an authorization, credential, delivery instruction, or
capability.

D10 adds no route, storage read/write, migration, external time service,
camera/device/media connection, credential, handoff, notification,
publication, action, or durable state. It only protects construction of the
existing fixed `SYNTHETIC` / `LIVE_DISABLED` fixture result.

## D11 — governed-run local-time snapshot

`GovernedConnectorRunner` takes exactly one native, finite local `Date` from
its injected process-local clock at the start of an admitted run. It rejects a thrown,
invalid, forged, or Proxy-shaped clock/date without invoking a Proxy trap. The
trusted instant is copied for adapter preflight/provenance, quota reservation,
and every audit event in that one run, closing a multi-call time-of-check/
time-of-use gap. Native `Date` methods are used directly, so an overridden
`toISOString` cannot control the audit timestamp.

If the runner cannot obtain that initial safe timestamp, it fails closed before
connector lookup, audit append, fixture resolution, or quota reservation. No
audit event is possible in that case because a canonical audit timestamp cannot
be constructed. A valid run shares one descriptive synthetic timestamp across
its `requested`/`succeeded` (or `failed`) records; this is not an external time
attestation, signature, credential, or authorization.

D11 adds no time-service, route, storage read/write, migration, camera/device
or media connection, credential, handoff, notification, publication, action,
or durable state. It accepts no caller time value at the HTTP boundary.

## D12 — governed-run request-envelope boundary

Before the runner consults its D11 clock, registry, audit log, quota, or
adapter, it requires a direct library `RunConnectorRequest` to have exactly
the documented own, enumerable data fields. The envelope has bounded primitive
scope/actor/correlation values and a dense ordinary scope-string array; its
generic `input` remains opaque until the selected adapter applies its own
strict input contract. This preserves the camera adapter's D3 input boundary
without accidentally treating an arbitrary future connector input as camera
data.

Unknown, hidden, symbol, inherited, accessor/getter, Proxy, sparse-array, or
malformed envelope fields fail closed without evaluating a getter or Proxy
trap. A malformed envelope therefore produces no clock read, connector lookup,
audit append, quota reservation, fixture resolution, or adapter call. The
normal HTTP route is already shape-validated; D12 protects the separately
callable in-process runner seam as well.

D12 adds no HTTP route, storage read/write, migration, provider or time-service
call, camera/device/media connection, credential, handoff, notification,
publication, action, or durable state. It is not an authorization capability
and does not inspect, send, or retain input data.

## D13 — governed-run result and provenance boundary

After an adapter returns but before `connector.run.succeeded` is appended or a
result is returned, `GovernedConnectorRunner` requires the result, provenance,
and untrusted-content wrappers to be exact own, enumerable data records. A
Proxy, accessor, inherited or hidden field, symbol, unexpected field, injected
`auditHash`, non-finite/out-of-range confidence, non-synthetic status, wrong
connector ID, malformed source name, or timestamp that differs from the D11
snapshot fails closed. The runner reconstructs the accepted wrapper and is the
sole writer of the succeeding audit hash.

The generic `data` and untrusted `value` fields remain adapter-owned opaque
data: D13 neither interprets nor sends them. It rejects Proxy-shaped values but
does not turn the runner into a media parser; the camera adapter's D3/D10
boundary remains responsible for its fixed fixture result. An invalid result is
recorded only as the existing `connector.run.failed` execution outcome after
the pre-existing quota reservation; it never produces a success audit or a
return value.

D13 adds no route, storage read/write, migration, provider or time-service
call, camera/device/media connection, credential, handoff, notification,
publication, action, durable state, or capability. It validates an in-process
synthetic result envelope only; it is not a signature, authorization, or
delivery instruction.

## D14 — audit-append receipt boundary

Every governed-run and independent-review audit append must return exactly one
ordinary own-data receipt. Its fixed D14/D17 shape is `{ hash, previousHash }`:
`hash` is a lower-case 64-character SHA-256 hex value and `previousHash` is the
same form or `null`. The receipt is copied before either value can become an
event predecessor link, `requestedAuditHash`, review evidence, or returned
result provenance. Missing, extra, hidden, symbol, inherited, accessor, Proxy,
non-string, upper-case, or malformed hash values fail closed without evaluating
an accessor or Proxy trap.

An invalid receipt for the initial `requested` audit append stops before quota
reservation or adapter execution. An invalid `succeeded` or owner-review
receipt returns no camera result or review decision and emits no synthetic
follow-up transition: the preceding append may have partially persisted, but
its identity cannot be safely bound. This is deliberately a fail-closed local
collaborator boundary, not a database read, durable-chain proof, signature,
credential, delivery instruction, or authorization capability.

D14 adds no route, storage read/write, migration, provider or time-service
call, camera/device/media connection, credential, handoff, notification,
publication, action, or durable state. It only constrains use of the existing
in-process audit append return value.

## D15 — immutable audit-event boundary

Before a governed run or independent review calls its existing audit-log
collaborator, D15 reconstructs the entire `ConnectorAuditEvent` as an exact
own, enumerable data record. Its named control fields, canonical timestamp,
bounded scope array, and positive limits are checked; the generic `detail`
object remains opaque but is recursively copied only from bounded ordinary
data. Hidden or symbol fields, accessors, inherited/prototype-shaped values,
Proxy values, cycles, sparse arrays, non-finite numbers, and excessive nesting
fail closed before the collaborator is called.

The reconstructed event, its scope array, and its detail tree are frozen. An
in-process audit collaborator therefore cannot append a snapshot/device/media
field, amend a scope or actor, or replace another hash-chain input through a
mutable alias. This is a local mutation boundary only: it does not prove the
collaborator durably stored the event, verify a predecessor, authenticate an
actor, or turn the event/hash into a signature, credential, handoff, or action
capability. D15 does not parse or send generic detail data; camera-specific
no-media detail rules remain in the camera contract.

If the initial `requested` event is invalid, quota reservation and adapter
execution do not start. If an event becomes invalid at a later append seam, no
success/review result or synthetic follow-up transition is manufactured. D15
adds no route, storage read/write, migration, provider or time-service call,
camera/device/media connection, credential, handoff, notification,
publication, action, or durable state.

## D16 — immediate durable audit-head boundary

The existing Prisma append already reads the latest product/workspace audit
record to obtain its predecessor hash. Before D16 permits that hash to bind a
successor, it requires the existing head to be an exact own-data
`{ event, previousHash, hash }` record. Its event is rebuilt through D15, both
hash values must be lower-case SHA-256 hex (or `previousHash: null`), and the
stored hash must equal the canonical hash of that event plus its predecessor.
Malformed, hidden, symbol, accessor, Proxy, extra-field, media/device-shaped,
or hash-mismatched head data stops the append with
`INVALID_AUDIT_CHAIN_HEAD`. The current append transaction then creates no new
audit record; a governed run cannot reserve quota or call the adapter when its
initial `requested` append is blocked this way.

D16 verifies only the one head that the existing append already reads. It does
not scan history, prove earlier predecessor existence, add a lookup API,
authenticate anyone, or make the unkeyed SHA-256 chain a signature,
credential, authorization, handoff, notification, publication, or action
capability. It adds no schema, migration, route, provider/time-service call,
camera/device/media connection, credential interface, or production write.

## D17 — audit-append link witness

After D14 has parsed the exact receipt and D15 has sealed the event, D17
requires `hash` to equal the canonical SHA-256 hash of that sealed event plus
the receipt's `previousHash`. It returns a frozen local copy only after that
comparison. A receipt with a valid-looking hash from another event, a changed
predecessor, or a self-inconsistent link fails with
`INVALID_AUDIT_APPEND_RECEIPT`.

The governed runner already knows the accepted `requested` receipt when it
appends its `succeeded` or `failed` event. D17 pins each of those later receipt
predecessors to that exact requested hash, so a collaborator cannot bind the
completion to another chain segment while leaving a matching
`requestedAuditHash` in event detail. A bad initial receipt stops before quota
reservation and adapter execution; a bad later receipt returns no result and
creates no synthetic follow-up transition.

D17 does not read storage, prove an append was durable, prove an unknown
predecessor exists, scan history, authenticate an actor, or turn an unkeyed
digest into a signature, credential, authorization, handoff, notification,
publication, or action capability. D16 remains the separate check for the one
durable Prisma head that the existing append already reads. D17 adds no schema,
migration, route, provider/time-service call, camera/media/device connection,
credential interface, or production write.

## D18 — module-captured SHA-256 operations

At module initialization, both the synthetic-camera packet/receipt code and
the shared audit-chain code capture Node's `createHash`, `Hash.prototype.update`,
and `Hash.prototype.digest` operations, together with the invocation primitive
used to call them. Fixture, review-packet, receipt, evidence-manifest, audit
event, audit-head, and D17 append-link digests then use those captured
operations. A later mutation of the public `Hash` prototype therefore cannot
substitute a digest, throw during a synthetic run/review, or alter a D16/D17
comparison before it reaches the no-action audit boundary.

D18 is deliberately a local in-process integrity hardening only. It does not
attest that the JavaScript realm was clean before these modules loaded; it does
not turn unkeyed SHA-256 into a signature, credential, durable audit proof,
authorization, handoff, notification, publication, or action capability. It
adds no schema, migration, route, storage lookup, provider/time-service call,
camera/media/device connection, credential interface, or production write.

## D19 — connector-owned camera result data plane

D13 deliberately treats an adapter's `data` and isolated-content `value` as
opaque so the generic runner does not become a media parser. Before a
`camera-observation` success audit, D19 closes that remaining connector-local
gap: the camera connector reconstructs the complete fixture result through the
existing strict review-result parser and separately reconstructs the isolated
value as the one fixed observation shape. It requires confidence `0`, the
fixture-derived synthetic source, the fixed isolated-content source, and an
exact equality between the rebuilt isolated observation and the rebuilt result
observation.

An extra, hidden, symbol, inherited, accessor, Proxy, raw-media, device, or
changed finding field in either location fails as
`INVALID_GOVERNED_CONNECTOR_RESULT` after the existing requested audit and
quota reservation, but before `connector.run.succeeded` or a result return.
The verifier returns fresh bounded copies; it does not expose an adapter-owned
data alias under a valid generic D13 wrapper.

D19 is an in-process, synthetic camera boundary only. It adds no route,
storage lookup/write, migration, provider or time-service call,
camera/media/device connection, credential, handoff, notification,
publication, action, durable state, or capability. It is not a signature,
authorization, delivery instruction, or permission to use a camera.

## D20 — immutable governed run context

After D12 has admitted the direct library envelope and D11 has captured its
single local timestamp, the governed runner creates one immutable own-data
context for its preflight, adapter, camera-result verification, quota request,
and scoped audit events. Its primitive product/workspace/actor/correlation,
owner, and limit fields cannot be retargeted; its one scope array is frozen;
and its local clock can return only fresh copies of the D11 timestamp. A
connector therefore cannot change a later audit, quota, or camera verification
from the context the runner originally admitted.

An uncaught write attempt fails during preflight before `requested` audit or
quota reservation. A caught write attempt cannot alter the frozen context, so
the ensuing quota/audit/result checks retain their originally admitted values.
D20 is an in-process isolation boundary, not a claim that a connector is
trusted or that attempted writes are externally observable.

D20 adds no route, storage lookup/write, migration, provider or time-service
call, camera/media/device connection, credential, handoff, notification,
publication, action, durable state, or capability. It is not a signature,
authorization, delivery instruction, or permission to use a camera.

## D21 — immutable governed connector input

Before it reads its local clock, resolves a connector, appends an audit event,
reserves quota, or invokes an adapter, the governed runner now recursively
admits connector input as a bounded JSON-data snapshot. It accepts only finite
primitive values plus ordinary/null-prototype own-data objects and dense
ordinary arrays, then deep-copies and freezes that value. The generic runner
still does not interpret camera semantics: `camera-observation` remains solely
responsible for its fixture, consent, purpose, and media/device rejection
contract.

The copied input has an eight-level, 48-key/array-item, and 4096-character
per-string limit. Hidden, symbol, inherited, accessor, Proxy, sparse-array,
cyclic, exotic, over-deep, non-finite, and function-shaped values fail closed
without evaluating a getter or Proxy trap. A caller that changes its own object
after starting an async run, or a preflight hook that catches a failed write,
cannot change the input passed to the later adapter run. An uncaught preflight
write is denied before the `requested` audit event and quota reservation.

D21 is an in-process immutability and no-aliasing boundary only. It adds no
route, storage lookup/write, migration, provider or time-service call,
camera/media/device connection, credential, handoff, notification,
publication, action, durable state, or capability. It is not a signature,
authorization, delivery instruction, or permission to use a camera.

## D22 — sealed synthetic connector registration

When the local registry is constructed, it now accepts only a dense,
non-Proxy list of at most twelve connector instances. The connector's `id`,
`kind`, `authKind`, and non-empty unique scope list must be own enumerable data
properties. `preflight`, `run`, and optional `validateResult` callbacks are
found through data descriptors only (within a bounded local prototype walk) and
captured with their original receiver. Getters, setters, Proxy values, sparse
scope arrays, duplicate scopes, malformed metadata, and missing/invalid `run`
fail closed as `INVALID_CONNECTOR_REGISTRATION` without evaluating a trap.

The registry exposes only a frozen record of the admitted connector ID, fixed
`synthetic-camera`/`owner-token` control metadata, frozen scopes, and captured
callback references. Replacing a connector's public ID, scope array, preflight,
run, or validator after registration cannot retarget the audit identity, quota
identity, scope check, or selected callback path of a later governed run.

D22 is an in-process control-plane snapshot, not a plug-in sandbox or a claim
that arbitrary connector implementation code is safe. It does not inspect or
authorize private connector state, create a connector-loading route, perform a
storage lookup/write, add a migration, use a credential, contact a provider or
camera/device, send a handoff/notification, publish, or take an action. The
only admitted connector in this module remains the existing fixture-only,
`LIVE_DISABLED` synthetic camera connector.

## D23 — sealed governed-run collaborators

When `GovernedConnectorRunner` is constructed, its `ConnectorRegistry`, audit
log, quota collaborator, and local clock are admitted before any run begins.
The registry's `get`, audit log's `append`, and quota's `consume` method must
be bounded-prototype, descriptor-backed data functions with a non-Proxy
receiver and non-Proxy callback. The runner captures those functions with
their original receivers and a module-initialized apply intrinsic. The local
clock must likewise already be a non-Proxy function; D11 continues to validate
its returned native `Date` at run time.

The registry's admitted connector map is now an ECMAScript private field. A
later replacement of public `get`, `append`, `consume`, runner legacy fields,
or the caller's clock binding therefore cannot retarget the selected connector,
audit append, quota reservation, or fixed synthetic timestamp path. A Proxy
collaborator, accessor method, missing method, Proxy callback, or Proxy clock
fails closed as `INVALID_GOVERNED_RUNNER_COLLABORATOR` during construction,
without evaluating a getter or Proxy trap and without an audit append, quota
reservation, adapter run, fixture lookup, or clock call.

D23 is a narrow in-process control-plane snapshot, not a collaborator sandbox
or a claim that an admitted method's own private mutable state is trustworthy.
It adds no route, storage lookup/write, migration, credential, provider/time
service, camera/device/media connection, handoff, notification, publication,
action, durable state, or capability. It preserves the existing fixture-only
`SYNTHETIC` / `LIVE_DISABLED` connector and no-send outcome.

## D24 — module-captured own-data and timestamp intrinsics

At module initialization, the governed runner captures the descriptor,
prototype, own-key, array, numeric, Proxy, freeze, and invocation helpers used
to admit synthetic connectors and runner collaborators. The synthetic runner,
audit seal, and camera/review code also capture the native `Date` constructor
plus its `getTime` and `toISOString` methods for governed, audit, provenance,
review, and supplied-trail timestamp checks.

Consequently, a hook installed later on the public `Object` inspection helpers,
`Array.isArray`, `Number.isSafeInteger`, or `Date.prototype` cannot retarget an
already-loaded connector/runner admission check or turn a known-safe local
timestamp into a caller-controlled string. D24 continues to use the existing
one local time snapshot; it does not add a clock service or accept an external
time value. The negative tests cover hostile late own-data-inspection hooks at
connector/runner construction and hostile late `Date` prototype hooks across a
full synthetic run and independent review.

D24 is a narrow in-process hardening. It does not attest that the realm was
clean before these modules loaded, sandbox admitted code, or validate every
host-language helper outside the documented local boundary. It adds no route,
storage lookup/write, migration, provider/time-service call, camera/device or
media connection, credential, handoff, notification, publication, action,
durable state, or capability. The connector remains fixture-only,
`SYNTHETIC`, `LIVE_DISABLED`, and no-send.

## D25 — module-captured data-boundary and canonicalization intrinsics

D25 completes D24's post-load hook boundary across the governed runner, shared
audit sealer/canonicalizer, and synthetic camera/review parser. At module
initialization they capture the own-data inspection, create/freeze, array
identity/map/sort, numeric, Set cycle/uniqueness, canonical `JSON.stringify`,
and audit-key ordering operations they use. The recursive input and audit
snapshots use captured Set `has`/`add`/`delete` operations; they never depend
on a subsequently replaced global Set or its iterator.

A later replacement of public `Object`, `Array`, `Number`, `Set`,
`String.prototype.localeCompare`, or `JSON.stringify` helpers therefore cannot
retarget a governed input/result boundary, alter audit canonicalization, turn a
review digest into a constant, or make a changed fixture finding pass review.
The negative test installs hostile late hooks across a full synthetic run,
tampered review rejection, and independent no-action review; no hook is called,
the tampered finding is rejected before a review audit append, and the valid
review still has no handoff, notification, publication, or action.

D25 is a narrow in-process hardening only. It does not attest that the realm
was clean before module initialization, sandbox admitted code, provide a
signature or durable audit proof, authenticate a reviewer, or authorize a
camera, handoff, notification, publication, or action. It adds no route,
storage lookup/write, migration, provider/time-service call, camera/device or
media connection, credential interface, durable state, or production write.

## Audit and storage boundary

The existing shared `gcl-audit` and `gcl-usage` records use the product/workspace scoped SHA-256 chain and quota reservation. Audit detail includes IDs/digests and decision state only—never raw request input, media, stream/device values, or consent receipt content. The regular records API excludes both reserved modules. D1–D25 add no migration and no new persistence model.

## ADOS 10-rule conformance

1. Product/workspace digest binding keeps each run and review packet scoped to one data plane.
2. Only minimized built-in synthetic fixture metadata is accepted.
3. The front door default-denies absent configuration; `LIVE_DISABLED` is permanent.
4. Unknown, hidden, symbol, Proxy, accessor, sparse, cyclic, and over-deep input/evidence shapes, D8 review context, D10 execution context/provenance-clock values, the D11 runner clock, the D12 governed-run request envelope, the D13 result/provenance control plane, D14/D17 audit append receipts and link witnesses, D15 audit events, D16 durable audit heads, D18 late SHA-256 prototype hooks, D19 camera result/isolated-content values, D20 mutable governed context values, D21 mutable/aliased governed input values, D22 shaped or retargetable registry control-plane values, D23 shaped or retargetable runner collaborator control-plane values, D24 late own-data/time-intrinsic hooks, and D25 late data-boundary/canonical-JSON hooks—plus media, device identifiers, personal identity, and biometric inference—are excluded.
5. Purpose-bound synthetic KVKK consent must match the fixture.
6. Owner approval plus maker–checker separation are required; D1 rejects the original maker as reviewer and D2 minimizes that review evidence.
7. The code has no device SDK, transport, network client, credential, or provider interface.
8. Preflight, quota reservation, and the scoped hash-chain audit enforce bounded governance without a new database schema; D5 can only read-check a caller-supplied three-event segment, D6/D7 only minimize and recheck evidence derived from it, D8/D9 protect review context and its local clock, D10 rejects shaped execution context or an invalid provenance clock before a fixture result, D11 freezes one safe runner timestamp, D12 seals direct run envelopes before any collaborator is used, D13 seals the adapter result/provenance control plane before a success audit, D14 seals the exact append receipt shape, D15 seals every event before the audit collaborator can mutate it, D16 verifies the existing durable head before a successor can bind to it, D17 re-hashes each sealed append event while pinning the runner-known requested predecessor, D18 captures the SHA-256 operations used by all those integrity checks, D19 rebuilds the camera result and isolated observation before success, D20 freezes the admitted run context before any connector can observe it, D21 copies and freezes generic input before any runner collaborator is used, D22 seals the connector identity, scopes, and callback references at local registry construction, D23 seals the runner's registry/audit/quota methods and local clock at construction, D24 captures the local own-data and native timestamp operations before later hooks can retarget them, and D25 captures the data-boundary/canonical-JSON operations used by governed, audit, fixture, and review integrity.
9. Owner review, its D2 receipt, and D4/D5/D6/D7 witnesses record no handoff, command, notification, publication, or automatic action; D3/D4/D5/D6/D7 validate evidence, D8/D9 validate review context and its local clock, D10 validates only synthetic provenance, D11 validates only the local runner timestamp, D12 validates only the request envelope, D13 validates only the fixed synthetic/no-egress result control plane, D14/D17 validate and bind the audit receipt, D15 freezes the review event without evaluating accessors or Proxy traps, D16 rejects a malformed durable head without creating a follow-up transition, D18 keeps late SHA-256 hooks outside review and audit integrity, D19 permits only the rebuilt fixed no-media observation in the returned camera data plane, D20 keeps connector-visible governance values immutable, D21 keeps camera input immutable across preflight and run, D22 keeps later callback/metadata replacement outside the selected synthetic connector path, D23 keeps later runner collaborator replacement outside that path, D24 keeps late Date-prototype hooks outside synthetic run/review timestamps, and D25 keeps late canonicalization hooks outside fixture/review integrity; action, notification, publication, and handoff remain not sent.
10. This branch contains no live launch, production migration, main/prod write, or camera hardware path.

## Explicit non-goals

There is no real credential/API key, live or provider call, sending, camera/media/device connection, production migration, auto-start worker, live launch, or write to `main`/production in this package.
