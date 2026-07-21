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

## Audit and storage boundary

The existing shared `gcl-audit` and `gcl-usage` records use the product/workspace scoped SHA-256 chain and quota reservation. Audit detail includes IDs/digests and decision state only—never raw request input, media, stream/device values, or consent receipt content. The regular records API excludes both reserved modules. D1/D2/D3/D4/D5/D6/D7/D8 add no migration and no new persistence model.

## ADOS 10-rule conformance

1. Product/workspace digest binding keeps each run and review packet scoped to one data plane.
2. Only minimized built-in synthetic fixture metadata is accepted.
3. The front door default-denies absent configuration; `LIVE_DISABLED` is permanent.
4. Unknown, hidden, symbol, Proxy, and accessor-shaped input, evidence, and D8 caller-context fields—plus media, device identifiers, personal identity, and biometric inference—are excluded.
5. Purpose-bound synthetic KVKK consent must match the fixture.
6. Owner approval plus maker–checker separation are required; D1 rejects the original maker as reviewer and D2 minimizes that review evidence.
7. The code has no device SDK, transport, network client, credential, or provider interface.
8. Preflight, quota reservation, and the scoped hash-chain audit enforce bounded governance without a new database schema; D5 can only read-check a caller-supplied three-event segment, D6/D7 only minimize and recheck evidence derived from it, and D8 rejects shaped caller context before review append.
9. Owner review, its D2 receipt, and D4/D5/D6/D7 witnesses record no handoff, command, notification, publication, or automatic action; D3/D4/D5/D6/D7 validate evidence and D8 validates context without executing accessors or adding a write path.
10. This branch contains no live launch, production migration, main/prod write, or camera hardware path.

## Explicit non-goals

There is no real credential/API key, live or provider call, sending, camera/media/device connection, production migration, auto-start worker, live launch, or write to `main`/production in this package.
