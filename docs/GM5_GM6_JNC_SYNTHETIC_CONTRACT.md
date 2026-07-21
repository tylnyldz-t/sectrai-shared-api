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

GM5 synthetic artifact IDs and integrity hashes include the product and
workspace scope. The same validated input therefore produces a stable proposal
inside one scope but cannot be correlated through the same synthetic artifact
ID across workspaces. Reordered JSON keys normalise to the same result. Neither
the digest nor freezing creates an asset, starts a process, or permits a plan
to be changed into a publication instruction.

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

Premium GM6 reserves GPU-minute units: `requestedItems` must exactly equal
`input.gpuMinutes`. GM5 reserves exactly one proposal item. Both outputs mark
untrusted input as `UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`.

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
