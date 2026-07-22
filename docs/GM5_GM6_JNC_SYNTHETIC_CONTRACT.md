# GM5/GM6 JNC Synthetic Contract

This module maps the JARVIS Node Controller (JNC) Blender and Unreal pilot
patterns into GM5/GM6 connector results as data only. It is not a JNC client,
does not resolve executables, and cannot start an engine or a GPU job.

The implementation follows ADOS responsibility-boundary rule 10 by recording
the relevant project contract here without importing ADOS documents at runtime.
Its asset-state fields retain the staged, owner-review model required by the
ADOS DCC asset-safety protocol.

## Hard boundary

- `LIVE_DISABLED` is the only accepted connector mode. Any other or missing
  value fails before audit or quota reservation.
- The adapter has no provider/JNC endpoint, HTTP client, process launcher,
  executable path, credential, API-key, or publishing action.
- `JncGpuResourceCard` has `mode: CONTRACT_ONLY`, `transport: NONE`,
  `autostart: false`, `dispatchState: NOT_DISPATCHED`, and
  `leaseState: NOT_ACQUIRED`.
- A returned artifact is a `synthetic://` proposal, not a 3D file. It has
  confidence `0`, requires owner review, and is never published.
- Audit and quota persistence are governance records in the existing shared
  API only. They do not contact a model provider, JNC, Blender, or Unreal.

## Review snapshot integrity

Every GM5/GM6 `data` result is a recursively frozen review snapshot. It carries
`gcl.synthetic-plan-integrity.v1`, whose `payloadSha256` is calculated from
canonical JSON data only. The digest is a review-correlation value, not a
credential, signature, or execution authorisation.

Each result also carries a deterministic
`gcl.synthetic-review-receipt.v1`. The receipt binds the connector, exact
product/workspace scope, and plan digest to four immutable negative controls:
no transport, no process launcher, no artifact-file write, and no publication.
Every result additionally carries a recursively frozen `reviewSnapshot`:
`{ payload, integrity, reviewReceipt }`. Review consumers must use
`verifiesSyntheticReviewSnapshot` (or its asserting form) before displaying
plan fields. It recomputes the digest from the exact plan payload and checks
that its connector and product/workspace scope match the receipt, so a valid
receipt cannot be grafted onto a different plan or workspace. The individual
`verifiesSyntheticPlanIntegrity` and `verifiesSyntheticReviewReceipt` helpers
remain useful component checks; only the snapshot verifier checks their full
binding. Its asserting form fails closed with `503
synthetic_review_integrity_invalid` when any value is malformed or altered.
A receipt is still not a signature, a message to JNC, or an approval to execute
anything.

Plan hashing accepts only strict, data-only canonical JSON: finite primitive
values, dense arrays, and plain enumerable data objects. Sparse arrays,
accessors, symbols, non-enumerable fields, `Date`/class instances, cycles, and
other JavaScript-only values are rejected rather than being silently collapsed
to a potentially colliding digest. Verifier predicates return `false` for such
data; asserting variants fail closed.

`Proxy` values are also rejected before any property, prototype, key, or
descriptor reflection. A Proxy is executable JavaScript behaviour because its
traps can run while an object is inspected; a target that merely *looks* like
JSON does not make it review data. This applies recursively to a plan payload
and to the exported deep-freeze helper, so neither helper runs a caller-owned
trap while producing synthetic evidence.

### D1 review-evidence data lock

Plan-integrity metadata, review-receipt creation and verification, and
review-snapshot creation and verification each first take an exact canonical
JSON copy of their caller-supplied object. They inspect that frozen copy only;
they do not invoke accessors or retain caller-owned receipt, scope, integrity,
or plan-payload references. Inherited fields, symbols, hidden properties,
class instances, cycles, sparse arrays, and getters/setters fail closed as
review-integrity errors (or `false` from a predicate).

Proxy-backed wrappers and nested values are rejected before reflection as
well. They are not unwrapped, cloned, hashed, or frozen; no trap result can
supply a connector ID, scope, digest, or review payload field.

Creating a snapshot therefore does not freeze or later observe the caller's
payload object: the displayed snapshot remains an independent, recursively
frozen review record. This is an in-memory data-boundary control only. It does
not sign a receipt, authorize execution, send to JNC, start Blender/Unreal/
Godot, read a credential, write an artifact, or publish anything.

GM5 synthetic artifact IDs and integrity hashes include the product/workspace
scope, owner actor, approved scopes, cost cap, and requested-item reservation
units. The same governed input therefore produces a stable proposal only inside
one identical review context; it cannot be correlated through the same
synthetic artifact ID across workspaces, owners, or reservation envelopes.
Reordered JSON keys normalise to the same result. Neither the digest nor
freezing creates an asset, starts a process, or permits a plan to be changed
into a publication instruction.

The durable audit append path takes the workspace lock and verifies every prior
SHA-256 link before writing its next link. A malformed, reordered, or hash-
mismatched audit record returns `503 gcl_audit_chain_corrupt`; it never starts a
new chain root. This is a fail-closed consistency control, not a signed
tamper-proof ledger: a separately designed signing/attestation system would be
required to defend against a privileged database writer who can recompute
hashes.

Audit verification also accepts only the exact stored record and event fields.
Every `succeeded` or `failed` event must link once to a preceding compatible
`requested` event in the same chain; dangling, cross-context, duplicate, or
extra-field terminal events are corrupt. An interrupted request may remain
unresolved, but it cannot be replaced with a new root. Failure events record a
stable GCL error code (or `connector_run_failed`), never an arbitrary adapter
error message or untrusted input.

### D1 audit-time lock

Each governed run captures one exact, valid built-in `Date` before preflight.
That immutable instant is used for the request audit event, quota reservation,
terminal audit event, and the synthetic result's provenance timestamp. The
adapter receives only a local clock that returns a fresh copy of this same
instant; it cannot make the audit and displayed result disagree by observing a
later clock value. A missing, invalid, subclassed, or throwing clock returns
`503 connector_unavailable` / `CONNECTOR_CLOCK_UNAVAILABLE` before preflight,
audit, quota, or adapter execution.

Audit-chain verification requires each terminal event to be at or after its
linked request. A re-hashed terminal event that predates its request is a
corrupt governance chain (`503 gcl_audit_chain_corrupt`), never a reason to
create a new root or continue the connector. The prospective event is checked
against the complete chain inside the append transaction before it is written,
so invalid terminal evidence cannot be stored and only fail on a later append.
The chain deliberately does not impose a global wall-clock order across
independent records: concurrent synthetic runs may interleave while their own
request/terminal pair remains valid. Equal timestamps within one run are
intentional: they describe one local review transaction, not engine execution
time.

### D1 audit-record data lock

Audit append and historic-chain verification accept only the exact documented
own, enumerable data fields. Every event, detail object, scope array, prior
hash, and stored record wrapper is copied as strict canonical JSON before it
participates in a SHA-256 link. Inherited fields, getters/setters, symbols,
hidden properties, class instances, cycles, sparse arrays, and non-finite
values and Proxy wrappers fail closed as `503 gcl_audit_chain_corrupt`; getters
and Proxy traps are not invoked.

This applies before the durable log chooses its workspace lock or opens its
transaction, and before the in-memory test seam mutates its entries. A
malformed direct/internal `AuditLog.append` call therefore cannot create a
record, alter a hash, or cause a later audit event to trust JavaScript object
behaviour. Accepted events retain the same data-only record contract; this is
not a migration, a signature system, an engine/provider call, or a new
execution or publication capability.

## Connector mapping

| GM connector | Synthetic result | JNC pilot pattern represented | Execution state |
| --- | --- | --- | --- |
| GM5 `text-to-3d` / `image-text-to-3d` | synthetic 3D proposal + optional GPU resource card | Blender neutral-asset hand-off: per-job executable pin, argv-only, pilot allowlist, required `.blend`/`.glb`/manifest/validation artifacts | `SYNTHETIC_HANDOFF_ONLY_NOT_SENT` |
| GM6 premium `blender` | synthetic build plan + GPU card | Blender pilot remains CPU-only; it does not select a GPU or accept an exclusive GPU lease | `SYNTHETIC_HANDOFF_ONLY_NOT_SENT` |
| GM6 premium `unreal` | synthetic build plan + GPU card | Unreal CLI pilot: required project, editor-Python only, argv-only, NullRHI/no render, bounded timeout, staging/incoming destination | `SYNTHETIC_HANDOFF_ONLY_NOT_SENT` |

The GPU card is intentionally separate from the Blender pilot hand-off. The
known Blender pilot advertises CPU-only behavior and rejects exclusive-GPU
jobs; a card only records a future, separately approved heavy-job request. It
does not change the Blender pilot into a GPU executor.

## GCL route and governance

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/:connectorId/runs
```

Every request requires the existing product key plus a configured owner gate,
owner actor, exact input fields, scope, per-run cost ceiling, and requested
item count. The runner performs all validation and `LIVE_DISABLED` preflight
checks before it appends the workspace SHA-256 audit event or reserves daily
quota. Reserved module IDs are not exposed through ordinary record CRUD.

The runner independently validates its direct-call boundary too: product,
workspace, owner actor, exact `true` owner approval, and a non-empty unique
scope set must all be valid. Thus a malformed internal call fails before any
audit append or quota reservation. If audit persistence itself is unavailable,
the connector adapter is not run and no quota reservation is made. Once a
quota reservation exists, it remains accounted for even when a later plan
construction fails; this intentionally prevents retry-based quota bypass.

The GM5 and GM6 adapters repeat that boundary check when their public `run`
or `preflight` method is called directly. They accept only an exact, own-data
context (no inherited fields, accessors, symbols, sparse scopes, duplicate
scopes, or non-`true` approval), copy it into a frozen value, and fail closed
before a plan is returned. This is deliberately redundant with the runner:
the runner protects audit/quota persistence, while the adapter prevents a
synthetic plan from becoming available through an internal bypass.

Adapter configuration likewise accepts only the documented mode and governance
limit fields. A custom JNC mapper, transport, endpoint, executable, or other
unknown configuration field is rejected at construction. The adapters always
instantiate the local contract-only mapper; ADOS rule 10 remains a
responsibility boundary, not a runtime import or a pluggable execution seam.

### D2 policy lock: governance and media input are own data only

Before preflight, audit, quota, or adapter execution, the governed runner
copies only the exact documented request fields from own, enumerable data
descriptors. Inherited fields, symbols, hidden properties, sparse scope arrays,
and getters are rejected. Consequently an accessor cannot manufacture owner
approval, change a scope, or change cost/item values while validation is in
progress; rejection happens before an audit record or quota reservation.

GM5 and GM6 repeat the same rule at their direct adapter boundary for every
accepted 3D/game input and nested image reference. They read only own,
enumerable data descriptors from plain (or null-prototype) objects and build a
fresh normalized value for the review snapshot. Inherited prompt, project,
GPU, asset hash, or media-type values; accessors; symbols; and non-enumerable
fields fail closed as input errors. This is a local data-shape control, not a
transport, file, process, provider, or engine capability.

The HTTP parser remains an earlier request-shape boundary. D2 deliberately
also covers direct TypeScript/internal calls so those calls cannot bypass the
same synthetic-only input semantics. It does not add a credential, live mode,
provider endpoint, executable path, filesystem write, JNC dispatch, or
publication route.

## Synthetic result egress boundary

After an adapter returns, the governed runner performs one final, local-only
egress check before it writes a `succeeded` audit event or serializes a result.
It accepts only the GM5 and GM6 result shapes documented in this module. The
entire `data` tree must be canonical JSON and recursively frozen; its review
snapshot must verify; and every displayed artifact, GPU card, JNC hand-off,
pipeline, build output, publication, and build ID must match the corresponding
field inside that snapshot. GM6 tier, engine, and target must likewise match
the snapshot input. A separately valid receipt cannot therefore be used to
decorate a changed outer result.

The result envelope and provenance also admit only own enumerable data fields.
Getters, inherited values, symbols, hidden fields, nonzero confidence, URL-like
sources, malformed timestamps, unexpected output fields, and untrusted-content
markers other than `data-only` / `UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`
are rejected. The runner copies an accepted envelope into a fresh frozen value
and only then attaches its durable success-audit hash.

An egress failure is `503 synthetic_result_integrity_invalid`. It occurs after
the requested audit record and quota reservation, so the runner appends a
stable `failed` audit event and deliberately does not refund quota. No malformed
result reaches the HTTP response, and no result validation performs network,
process, file, or publication work.

### D1 policy lock: a digest cannot authorize a capability

The final boundary also applies a fixed synthetic-output policy after snapshot
verification. This closes the distinction between a plan that is internally
consistent and one that is safe to egress: a caller cannot build a new,
otherwise-valid snapshot whose artifact says `PUBLISHED`, whose game plan has a
non-disabled publication state, whose GPU card is dispatched, or whose JNC
handoff has an execution-capable field. GM5 artifacts must retain the exact
proposal-only, owner-review, not-published state and their matching
`synthetic://` URI. GM6 must retain the documented non-executed pipeline,
owner-evidence state, disabled publication, and the exact contract-only
GPU/JNC forms.

GM5 additionally binds the displayed artifact's `outputFormat` to the frozen,
normalized submitted input. A self-consistent, re-hashed review snapshot cannot
therefore turn a requested `glb` proposal into an `obj` proposal (or the
reverse). This is an egress consistency check only: it does not create a file,
convert an asset, invoke Blender, contact JNC, or authorize a hand-off.

The policy also binds provenance to the snapshot input: GM5 must use its own
`synthetic-3d:<connector>` source and no run ID; GM6 must use
`synthetic-game-engine-plan`, `game-engine-input`, and the plan's build ID.
This prevents a synthetic result from being relabelled as a different adapter
or input source. These comparisons are local canonical-data checks only; they
do not dereference a URI, start an engine, resolve an executable, or contact a
provider. A newly calculated digest proves only that the altered data is
self-consistent, never that it crosses this policy boundary.

Premium GM6 reserves GPU-minute units: `requestedItems` must exactly equal
`input.gpuMinutes`. GM5 reserves exactly one proposal item. Both outputs mark
untrusted input as `UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`.

### D1 runtime-envelope lock: bounded cards before reservation

The JNC contract-card mapper has one shared runtime ceiling of 5,400 seconds
(90 whole GPU minutes). When a GPU request is supplied, it accepts only an
exact, own-data request with a non-empty bounded budget reference, then
returns a recursively frozen
contract-only card. Accessors, inherited or hidden fields, symbols, malformed
VRAM values, and a duration outside that range fail closed as
`INVALID_JNC_GPU_RESOURCE_REQUEST`; the mapper still has no transport or
execution path.

GM5 uses the same 5,400-second ceiling for its optional resource-request
input. GM6 validates both its configured `maxGpuMinutes` and premium plan
before requested-audit append or quota reservation: configuration above 90
minutes is unavailable, and a requested plan above 90 minutes is rejected as
`GPU_RUNTIME_LIMIT_EXCEEDED`. Exactly 90 minutes remains a valid synthetic
boundary value. The final egress validator repeats the seconds ceiling as a
backstop. These checks do not reserve a GPU, modify quota on rejection, start
an engine, contact JNC, read a credential, or publish anything.

### D1 direct-call egress parity

The public `run` methods for GM5 and GM6 also pass their locally constructed
result through the same final synthetic-result validator used by the governed
runner. A direct/internal call therefore receives a fresh recursively frozen
envelope, frozen provenance, and the same snapshot, provenance, confidence,
and negative-capability policy checks as an HTTP-routed call. It cannot use a
mutable direct result to relabel a plan after return.

The final boundary and its governed review-binding helper additionally reject
Proxy-backed context, result, provenance, and nested plan data before any
field reflection. A Proxy result cannot make a trap-derived value appear as a
frozen plan after quota; it produces `503 synthetic_result_integrity_invalid`
and the terminal audit keeps only that stable code. A Proxy request is rejected
before preflight, requested-audit append, and quota reservation.

The supplied clock is still a test/internal timestamp seam, not a scheduler or
transport. Its result must yield an exact native ISO instant; an invalid clock
value fails closed with `503 connector_unavailable` /
`CONNECTOR_CLOCK_UNAVAILABLE` before a direct caller receives a plan. This
parity check performs no network call, process launch, artifact write, provider
lookup, JNC dispatch, credential read, or publication action.

### D1 clock-seam capture

The runner and direct GM5/GM6 adapters accept a clock only as a local
test/internal seam. Before preflight in the runner, and before any direct plan
fields are constructed in an adapter, a clock must be a non-Proxy function
that yields an exact built-in `Date`. A Proxy clock is rejected without calling
its `apply` trap; a Proxy date is rejected before any property or prototype
reflection. Both paths fail closed as `503 connector_unavailable` /
`CONNECTOR_CLOCK_UNAVAILABLE` and do not create audit, quota, plan, artifact,
or publication state.

The accepted instant is copied through `Date.prototype.getTime` and a fresh
native `Date` before it is formatted. Thus a caller-owned `Date` with a
shadowed `toISOString` cannot relabel synthetic provenance time. This is only
timestamp hygiene for local review evidence; it is not a scheduler, signature,
transport, engine call, filesystem write, credential read, or execution
authorization.

### D1 submission snapshot and registry seal

Before preflight, the governed runner makes a recursively frozen canonical-JSON
copy of the submitted input. The identical copy is given to both `preflight`
and `run`; it has no retained caller-owned references. The run context and its
scope list are frozen as well. A preflight hook therefore cannot alter the
approved cost, scope, input, or item count between validation and quota
reservation. An attempt to mutate the frozen values fails before reservation
when it occurs in preflight; a later failure remains conservatively accounted
for by the existing audit/quota rule.

The copied submission has a SHA-256 correlation value embedded in the
integrity-bound review snapshot. At the final egress boundary the runner
recomputes the same value from the frozen submission and requires an exact
match. The final boundary independently rebuilds the one permitted normalized
GM5/GM6 plan input from that frozen submission (including documented trim,
default, image-reference, GPU-card, and game-plan rules) and compares it to
`reviewSnapshot.payload.input`. A connector therefore cannot retain the
original submission digest while substituting a different, otherwise valid and
re-hashed plan. This digest identifies only data submitted to this synthetic
connector; it is not a secret, an approval, a credential, or an execution
authorization. Normalized prompt/default fields remain separately bound in the
review snapshot and provenance checks described above.

Connector registration also captures immutable own-data metadata and method
references, freezes the registered connector and its scope list, and rejects
accessor-backed `run`/`preflight` members. Audit, quota, and egress therefore
keep the connector identity established at registration even if an internal
caller retains an object reference. These are local object-boundary controls
only; Proxy-backed connector metadata, configuration, GPU card requests, and
direct contexts are rejected before reflection. They add no network client, provider, filesystem write, process launcher,
JNC dispatch, credential read, live mode, or publication path.

### D1 review scope and reservation binding

The review payload also records the exact governed `scope` and `governance`
data that produced it: product, workspace, sorted approved scopes, cost-cap
cents, and requested-item reservation units. At final egress, these data-only
values must exactly equal the current governed request. GM6 additionally
recomputes its synthetic build ID from that input, scope, and governance
binding. Thus a well-formed frozen plan from another workspace or from a
different cost/item reservation cannot be replayed under a new request; it
fails closed as `503 synthetic_result_integrity_invalid` after the normal
requested audit and quota reservation accounting.

This is a local review-correlation and accounting-consistency check. It does
not grant a GPU lease, contact JNC, run Blender/Unreal/Godot, resolve a path,
read a credential, write an artifact, send a message, or publish an output.

### D1 owner-actor binding

The snapshot payload also records the exact owner actor that submitted the
governed request. Final egress requires that actor to equal the current
owner-approved request actor, in addition to the scope and reservation data.
Consequently, a frozen plan cannot be replayed under a different owner inside
the same product/workspace with otherwise identical scopes, cost cap, and item
count. GM6 also includes that actor in its synthetic build-ID digest, keeping
its review correlation distinct across owner identities. A failed replay is
accounted for by the existing requested/failed audit pair and is never returned
as a result.

This is an in-memory identity-correlation control only. It does not create an
authentication system, read a credential, contact a provider or JNC, launch an
engine, write an artifact, send a message, or publish an output.

### D1 GM5 proposal and GPU-request binding

GM5 now derives its synthetic artifact ID from the normalized proposal input
and the same owner/scope/reservation binding already checked at final egress.
An otherwise identical proposal under another actor, cost cap, item count, or
approved scope therefore receives a different review handle. This is not a
file name, content address, or execution token; it is only a stricter
in-memory review-correlation value.

When GM5 contains an optional GPU resource request, final egress additionally
requires the contract card's `request` to equal the frozen normalized
`input.gpuResourceRequest` exactly. If no GPU request was submitted, the card
must contain `request: null`. A newly re-hashed snapshot cannot substitute a
different budget-envelope reference, compute tier, VRAM estimate, or runtime
value, and it cannot add a card to a plan that had none. Such a result fails as
`synthetic_result_integrity_invalid` after the normal requested audit and
quota reservation; it is never returned.

The bounded budget-envelope reference remains opaque synthetic review data.
This package does not resolve it against a ledger, reserve GPU capacity,
contact JNC, read a credential, or grant later execution authority.

## Non-secret configuration

`.env.example` shows only placeholders and governance limits. The owner-gate
value is deployment-owned and is never a provider, engine, GPU, cloud, or API
credential. This scope adds no migration, deployment setting, or live
integration.

```dotenv
GCL_3D_LIVE_MODE="LIVE_DISABLED"
GCL_GAME_ENGINE_LIVE_MODE="LIVE_DISABLED"
```

Any later live executor, real GPU allocation, production import, or asset
promotion is outside this scope and requires separate owner approval and a new
design.

## Synthetic verification

Run `npm run test:synthetic` for the GM5/GM6 contract suite. It uses only
in-memory audit and quota seams and must not receive a database URL, provider
credential, engine path, or network target. The repository's separately scoped
Neon integration test is not part of this connector verification.
