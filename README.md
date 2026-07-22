# Sectrai Shared API

Shared, product-scoped persistence API for Sectrai synthetic demo products. It uses one Neon Postgres database and one Render web service. It never connects to Sektral, Xontainer, Yapıborsası, or any other database.

GM3 adds a synthetic-only text-to-image GCL contract. It emits local SVG
owner-review candidates and a redacted Jarvis Creative Worker ComfyUI/SDXL
plan shape only: `LIVE_DISABLED` is mandatory, no provider credential, graph
execution, Docker/loopback client, or network adapter exists, and a separate
owner checker plus a replay-protected terminal review ledger is required before
a still-unpublished liked artifact or a non-publishable rejection receipt can
exist. Terminal decisions are re-read as exact durable receipts and must bind
back to the same issued candidate and governed-run audit lineage before a
still-blocked artifact can be returned. Candidates have a bounded, digest-bound review deadline: expiry blocks
both issuance and any terminal decision, and the durable lineage cannot be
backdated; every chain event also has a canonical, monotonic UTC timestamp. A
successful governed run must first receive a durable, redacted
candidate-issuance receipt whose candidate-set digest is bound to the success
audit event; generic CRUD never exposes the reserved `gcl-*`
system records. The runner accepts only a closed owner-approved request
envelope (including no hidden own fields), validates its synthetic
result/provenance and an ordinary copied injected clock, and records only a
fixed failure code after reservation—never an adapter error message. The
connector snapshots only its documented configuration fields at construction:
hidden credential/endpoint fields, accessors, malformed policy seams, and
post-construction caller-object changes fail closed before preflight, audit, or
quota. The ledgers reuse existing Records and add no migration. See
[the GM3 contract](docs/GM3_IMAGE_TTI_CONTRACT.md).

D2 additionally limits a custom safety policy to a closed local `{ id, assess
}` capsule, gives it a frozen data-only input snapshot without a policy-object
receiver, and returns frozen synthetic review snapshots. Those snapshots still
carry only local SVG/plan metadata and remain `LIVE_DISABLED` and publication
blocked; copying one does not bypass issuance or review fingerprint checks.

D3 keeps the conservative local baseline family gate non-bypassable: it runs
before any optional custom policy, so a permissive custom policy cannot admit a
baseline-rejected prompt or even receive it. The optional policy can only add a
stricter denial; it remains local, synchronous, `LIVE_DISABLED`, and never
authorizes a provider, network, dispatch, or publication path.

D4 binds each candidate's canonical review deadline and redacted fingerprint
into durable issuance and terminal-review receipts. Direct ledger calls
independently reject copied candidate-set digests, changed fingerprint/deadline
data, and issuance or decision at the exact expiry instant; all output remains
synthetic, owner-only, and publication-blocked.

D5 seals all candidate-issuance and terminal-review ledger inputs into private
data snapshots before an asynchronous persistence or audit seam can yield.
The direct receipt lookup validates and snapshots the candidate too, so a
mutable caller object or accessor cannot switch scope, fingerprint, deadline,
or terminal decision after validation. This is integrity hardening only:
`LIVE_DISABLED`, local SVG output, owner-only review, and publication blocking
remain unchanged.

D6 extends that sealing through the public terminal owner-decision helpers:
they copy and freeze the complete candidate before any candidate- or
review-ledger await, then return frozen liked-artifact or rejection snapshots.
Changing a caller-owned candidate while a ledger write is pending therefore
cannot turn a local SVG artifact into a provider URI, extend its review
deadline, or alter a terminal output. It remains synthetic, `LIVE_DISABLED`,
owner-only, and publication-blocked.

D7 additionally seals the validated candidate-issuance proof and freezes the
terminal review event before it reaches a review ledger. A retained mutable
proof cannot swap lineage hashes or deadlines while an append is pending, and
the ledger cannot change `publication: blocked` before its append/receipt
re-read. This remains local synthetic integrity hardening only: no provider,
network, dispatch, credential, migration, send, or publication capability is
added.

D8 likewise freezes the complete redacted candidate-issuance event before it
reaches a candidate ledger. A caller-owned result or custom ledger cannot
rewrite its source-run binding, candidate set, deadline, or blocked publication
state across an awaited append. It remains local SVG-only,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D9 rejects declared async, generator, and async-generator optional
family-safety callables while connector configuration is closed. Such a policy
is never invoked during preflight and cannot be accepted as an asynchronous
policy adapter; all output remains synthetic,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D10 rejects proxy-backed configuration, policy objects, policy callables, and
policy assessments before reflection can execute a proxy trap. This prevents a
policy seam from disguising behavior as ordinary data; rejection still occurs
before audit or quota reservation, and output remains local SVG-only,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D11 extends that proxy-free boundary through direct candidate issuance,
terminal-review, ledger-method, test-audit, and stored-audit-record seams. A
proxy cannot run descriptor or method traps while a receipt or SHA-256 lineage
is being checked; it is rejected before a new audit event or receipt is
written. The module remains synthetic-only, `LIVE_DISABLED`, and publication
blocked.

## GM5/GM6 synthetic connectors

The optional GCL routes return only frozen, LIVE_DISABLED GM5 3D proposals
and GM6 game plans. JNC cards and Blender/Unreal handoffs are contract data
with no transport or dispatch capability. Owner approval, scope/cap checks,
daily quota, and isolated fail-closed audit chains remain runner-owned. See
[the GM5/GM6 contract](docs/GM5_GM6_JNC_SYNTHETIC_CONTRACT.md).

## Record contract

Every record is scoped by `product`, `workspaceId`, and `moduleId`:

```ts
{ id, product, workspaceId, moduleId, values, status, createdAt, updatedAt, createdBy }
```

`values` is a bounded JSON object (48 KB maximum). The API rejects unknown request fields, malformed scope identifiers, and requests whose product key is absent or wrong.

## API

All product routes require `X-Sectrai-Product-Key`. A product `sectrai-health` maps to the server environment variable `SHARED_API_KEY_HEALTH`. Missing key configuration is intentionally a `401` fail-closed response.

```text
GET    /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records
POST   /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records
PATCH  /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records/:recordId
DELETE /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records/:recordId
```

- `GET` returns `{ records }`.
- `POST` accepts `{ values, status?, createdBy? }` and returns `201 { record }`.
- `PATCH` accepts `{ values, status? }` and returns `{ record }`.
- `DELETE` returns `204` only when the record exists in the exact product/workspace/module scope.

## GM2 camera observation connector

`POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/camera-observation/runs` is a consent-gated, fixture-only camera observation contract. It requires a product key plus a separately authenticated owner checker and a distinct request maker:

- `X-Sectrai-Owner-Token` — configured local governance secret; missing or mismatched values fail closed.
- `X-Sectrai-Owner-Actor` — checker identity.
- `X-Sectrai-Request-Actor` — maker identity; it must differ from the checker.

The body is bounded to a synthetic fixture, declared purpose, synthetic consent assertion, cost/item limits, and correlation ID:

```json
{
  "input": {
    "synthetic": true,
    "cameraFixtureId": "synthetic-loading-dock-001",
    "purpose": "operational-safety",
    "consent": {
      "state": "granted",
      "receiptRef": "synthetic-consent-safety-001",
      "policyVersion": "kvkk-synthetic-v1",
      "sourceRights": "synthetic-fixture"
    }
  },
  "scopes": ["camera:observe"],
  "costCapCents": 25,
  "requestedItems": 1,
  "correlationId": "synthetic-camera-correlation-001"
}
```

The adapter accepts no snapshot, video bytes, stream URL, device address, serial number, credential, or provider configuration. It resolves only the built-in `synthetic-*` fixtures and permanently reports `mode: "SYNTHETIC"` and `liveStatus: "LIVE_DISABLED"`; a live flag is an explicit rejection, never an opt-in. It never performs biometric or identity inference, does not retain a device identifier or media, and returns `OWNER_REVIEW_REQUIRED`, `NOT_EXECUTED`, `NOT_SENT`, and `NOT_PUBLISHED` outcomes.

Consent must be granted, have the KVKK synthetic policy version and source-rights assertion, and match the selected fixture purpose and synthetic receipt. Missing, revoked, malformed, or mismatched consent is denied before quota reservation. Owner-gate, maker–checker, scope, cost, consent, and execution decisions are appended to a product/workspace SHA-256 audit chain with the correlation ID; raw input and media are never placed in audit details. The normal record API cannot read or mutate the reserved `gcl-audit` and `gcl-usage` modules.

The D1 review-packet package adds an unkeyed SHA-256 mutation check around the fixed synthetic result. `independentlyReviewCameraObservation()` is a library-only, explicit owner-review seam: it revalidates scope, fixture observation, privacy flags, no-handoff state, and packet integrity before appending a review audit event. The original request maker cannot review it. D2 adds a minimized, library-only review receipt and `validateCameraReviewReceipt()`, which rechecks the receipt against the original packet without storage access, quota use, audit append, HTTP route, or durable state. D3 requires every input and review-evidence object to have only allowlisted own enumerable data fields; hidden, symbol, Proxy, accessor/getter, inherited, and raw-media/device-shaped fields fail closed without evaluating an accessor or Proxy trap. D4 adds `validateCameraReviewAuditWitness()`: it read-checks one caller-supplied review audit entry against D1/D2. D5 adds `validateCameraReviewAuditTrailWitness()`: it read-checks only a caller-supplied `requested → succeeded → owner_reviewed` segment, including its internal hashes and fixed no-action fields. D6 adds `createCameraReviewAuditTrailReceipt()` and `validateCameraReviewAuditTrailReceipt()`: they derive and recheck a minimized, context-bound rendering of that same supplied D5 segment. D7 adds `createCameraReviewEvidenceManifest()` and `validateCameraReviewEvidenceManifest()`: they bind independently rebuilt D2/D6 evidence through two integrity digests, omitting the fixture, finding, reviewer, decision text, and audit hashes. D8 applies the same strict own-data boundary to caller review context, so hidden, symbol, Proxy, accessor, inherited, or media/device-shaped context is rejected before any review audit append. D9 permits the sole callable review-context field only as a non-Proxy local clock that returns a finite native `Date`; forged, invalid, or Proxy-shaped clock values fail before review audit append. D10 applies that strict own-data boundary to direct synthetic adapter execution and derives its provenance timestamp only from the same safe local-clock rule; shaped context or clock values fail before a fixture result, and an invalid clock is rejected in preflight before quota reservation. D11 makes the governed runner take one validated native-`Date` snapshot and pass only clean copies of it to preflight, quota, result provenance, and its scoped audit events; a thrown, invalid, or Proxy-shaped runner clock fails before any audit or quota operation. D12 validates the full direct governed-run request envelope before it touches that clock, the registry, audit, quota, or adapter; unknown, hidden, symbol, inherited, accessor, Proxy, sparse-array, or media/device-shaped request fields fail closed without evaluating a getter or Proxy trap. D13 validates an adapter's direct result/provenance control plane before a success audit or return: a Proxy, accessor, hidden/symbol/unknown field, injected audit hash, invalid synthetic/live status, connector mismatch, malformed source, stale timestamp, or invalid confidence fails as `connector.run.failed`; generic data remains opaque and adapter-owned. D14 validates every audit append receipt's exact own-data shape; malformed, extra, hidden, symbol, inherited, accessor, Proxy, or non-lowercase-SHA-256 values fail closed. D15 seals each audit event as an immutable, deep own-data snapshot before the audit collaborator receives it, so shaped, cyclic, hidden, symbol, accessor, or Proxy event data fails before append and the collaborator cannot add media-shaped fields or alter a scope/detail. D16 validates the existing durable audit head before a successor can bind to it: its exact record shape and self-contained SHA-256 chain link must verify, otherwise the append fails closed without a new record. D17 makes each `{ hash, previousHash }` append receipt re-hash the sealed event and pins the runner's `succeeded`/`failed` receipt to its accepted `requested` hash. D18 captures Node SHA-256 operations at module initialization so later public `Hash`-prototype hooks cannot alter fixture/review/audit integrity checks. D19 then makes `camera-observation` reconstruct both its fixture result and the isolated observation before a success audit; raw/device-shaped, accessor, hidden, or mismatched data fails as `connector.run.failed`, and only new fixed no-media copies are returned. D4–D19 add no storage lookup route, provider or time-service call, or capability grant; D16 only validates the immediate record the existing append already reads, D17 does not prove persistence, and D18 does not attest to a clean realm before module initialization. None proves a durable audit read or authorizes a handoff. Every digest remains an unkeyed mutation check, never authorization or delivery capability. An approved or rejected review never sends a handoff, command, notification, or publication. See [the camera contract](docs/GCL_CAMERA_CONTRACT.md).

D20 freezes the admitted governed context, including its sole scope array, before preflight or adapter execution. A connector cannot retarget later quota, audit, or camera-result verification; an uncaught write is denied before quota. It adds no storage lookup, provider/time-service call, credential, camera connection, handoff, publication, action, or capability.

D21 deep-snapshots and freezes generic governed input before the runner touches its clock, registry, audit, quota, or adapter. Hidden, symbol, inherited, accessor, Proxy, sparse, cyclic, exotic, over-deep, non-finite, and function-shaped values fail closed; a caller or preflight hook cannot retarget the later camera run by mutating a shared input alias. It adds no storage lookup, provider/time-service call, credential, camera connection, handoff, publication, action, or capability.

D22 snapshots the selected synthetic connector control plane at registry construction: immutable ID/scopes plus captured descriptor-only callbacks. Shaped collections/metadata/callbacks fail closed, and later connector property replacement cannot retarget audit, quota, scope, or the selected callback path. D23 snapshots the runner's registry/audit/quota method references and local clock at construction; Proxy, accessor, or Proxy-method collaborators fail closed, and later public-property replacement cannot retarget the existing synthetic path. It is not a plug-in/collaborator sandbox and adds no route, credential, provider/device call, handoff, publication, action, or capability.

D24 captures the native `Date` constructor/methods used by governed, audit, fixture, and review timestamps, together with the runner registration/collaborator own-data inspection helpers. Hooks installed after module initialization cannot retarget those existing checks. It is not a clean-realm attestation and adds no time service, route, storage operation, credential, provider/device call, handoff, publication, action, or capability.

D25 completes that local post-load hook boundary for the governed input/result parser, audit sealer/canonicalizer, and synthetic camera review code: own-data inspection/copy/freeze, array identity/membership/map/sort, numeric checks, Set cycle/uniqueness helpers, canonical `JSON.stringify`, and audit-key ordering use module-captured operations. These paths do not use a replaceable global collection iterator. Late replacements cannot turn a result/review integrity comparison into a constant, bypass a tampered fixture finding, or retarget the fixed no-media audit path. This is only in-process hardening—not a clean-realm or durable-proof claim—and adds no route, storage operation, credential, provider/device call, handoff, publication, action, or capability.

No migration, camera connection, notification, action, or publication is part of this connector.

## Run and migrate

```bash
npm install
DATABASE_URL='your Neon URL' npm run db:migrate
DATABASE_URL='your Neon URL' SHARED_API_KEY_HEALTH='...' npm start
```

`npm test` runs the offline camera/GCL unit suite without a database or network. The existing Neon CRUD integration test is skipped unless `DATABASE_URL` is explicitly supplied; it creates records only under the temporary `sectrai-integration-test` product, verifies create → list → edit → a new Prisma connection → delete, and cleans those records up.

## Product adaptation guide

1. Add a strong `SHARED_API_KEY_<PRODUCT_SUFFIX>` value to Render. Example: `sectrai-health` → `SHARED_API_KEY_HEALTH`.
2. Add the same key to that product’s Vercel build environment as `VITE_SHARED_API_KEY_<PRODUCT_SUFFIX>` only for these owner-gated synthetic demos.
3. Map the product’s existing local object into `values`; retain its product-specific status in `status`. Use a stable workspace/module pair, for example `health-demo` / `operation-groups`.
4. Replace local `list/create/update/delete` calls with the generic routes above, preserving the product’s own response adapter shape.
5. Keep the local JSON server as a development fallback only if needed. The production client must fail visibly when the shared API is unreachable; never silently write in-memory data.
6. Verify live create → reload/list → edit → delete with the product’s key before enabling the next product.

## Safety boundary

The service stores only product-owned synthetic demo records. It does not make AI calls, execute product actions, or interpret `values`. Product-level Vercel admin gates remain the outer authentication layer; this API key is a second product boundary, not a replacement for user authentication.

## Interpreter GCL (synthetic-only)

The interpreter module is a fail-closed contract for owner-supplied synthetic
translation fixtures. It has no translation provider, HTTP client, credential,
or `*_LIVE_ENABLED` setting.

- `translation-text-synthetic` returns only the explicitly supplied synthetic text-translation fixture.
- `translation-speech-synthetic` accepts a synthetic audio descriptor plus an explicitly supplied fixture and returns only a deterministic `synthetic://` audio reference—never audio bytes.
- Both require the product key, owner token, owner actor, matching scope, positive cost cap, daily quota, and `GCL_TRANSLATION_LIVE_DISABLED=true`.
- `GCL_TRANSLATION_LIVE_ENABLED` is intentionally unsupported: if it exists at all, the connector is unavailable. A quota rejection after a request audit is recorded as a stable failure code; neither path reaches a provider or adapter fallback.
- Every governed run snapshots one valid native clock before preflight. Its request/outcome audit timestamps, quota context, synthetic provenance, and review-expiry calculation share that snapshot; audit replay rejects even hash-valid terminal timestamps that diverge from the linked request, and an invalid clock fails closed before audit or quota reservation.
- Scope envelopes are duplicate-free and canonical before the clock starts, including at the HTTP boundary where padded JSON scope strings are rejected rather than rewritten; a review TTL that cannot form a real UTC expiry also fails closed before audit or quota reservation.
- Product/workspace tenant envelopes are canonical at every GCL entry point, including direct programmatic calls; malformed or cross-contract tenant IDs fail before preflight, audit, quota, or adapter execution. Owner actors are never trimmed by GCL code, even though HTTP parsers normalize grammar-level header whitespace before the application receives it. An explicit programmatic `liveOptInRequested: false` surface disables the connector, and a successful artifact run must have a review expiry strictly after its canonical run instant.
- Synthetic fixture privacy checks reject TCKN-, Turkish mobile-, Turkish IBAN-, and email-shaped values even when Unicode decimal digits, spaces, punctuation, or Unicode format characters obscure them; the same rule covers synthetic audio references and voices before descriptor parsing, audit, quota, or artifact persistence.
- Successful runs create metadata-only proposals, bound to the successful run's maker, quota context, and safe hash-only envelope. The maker cannot approve or reject their own proposal; a distinct checker must echo the returned review digest before its configured review TTL expires. Approval never permits publication.
- Durable proposal creation and checker decisions are each one transaction with their audit append; no audit-less production artifact mutation API exists. Blank actors and malformed status/maker storage envelopes fail closed.
- Durable artifact reads and decisions also require a complete, ordered run → creation → optional single-decision audit lifecycle; metadata-shaped rows without that proof are unavailable.
- Artifact creation uses the same one-clock rule: the row's `createdAt` and its creation audit event share one canonical instant; a mismatch fails closed before write and during later lifecycle replay.
- The HTTP artifact creation and decision boundaries each take their own valid native-clock snapshot. A throwing, non-Date, or invalid clock returns `TRANSLATION_ARTIFACT_CLOCK_INVALID` before metadata mutation or lifecycle audit append; no review authority is broadened.
- Terminal decisions are bound to a distinct checker and one canonical timestamp shared by the artifact row and its audit event; malformed decision-audit context fails before any durable mutation.
- Hash-valid durable lifecycles must also be temporally consistent and within the review TTL; backdated or post-expiry audit decisions fail closed.
- Audit records bind each connector to its one canonical scope and exactly one requested artifact; a hash-valid scope or item-count forgery invalidates the chain.
- Audit history is transition-verified: each request has one exact terminal outcome, creation binds to that success, and only one linked, distinct-checker decision can follow.
- Audit events are copied once from a bounded ordinary data envelope before validation, hashing, or persistence. Accessors, hidden/symbol fields, custom prototypes, non-finite values, and throwing proxies fail closed; a stateful proxy cannot alter the captured event or inject raw fixture content after validation.
- Only explicit request-validation and GCL errors are exposed by HTTP. Unexpected adapter, storage, or runtime exceptions return stable `INTERNAL_ERROR`, never raw synthetic fixture content, credentials, or provider detail.
- Connector governance configuration is captured once from a canonical, allowlisted data-only envelope. Later caller mutation, getters/Proxies, hidden or inherited fields, and undeclared provider-like settings fail closed or cannot alter a governed run.
- A translation connector's immutable, canonical preflight fixture is the exact object the governed runner later gives its adapter; mutating the caller's retained input while audit/quota awaits cannot swap reviewed synthetic content.

See [the interpreter contract](docs/GCL_TRANSLATION_CONTRACT.md) for the exact shapes and safety boundary.

## GM2 synthetic vision adapter

`src/gcl/vision.ts` provides a non-wired, synthetic-only document-field proposal adapter based on the MagicScan form-field pattern. It accepts no raw image, camera input, credential, provider client, or live mode; it returns masked, owner-review-only proposals with `confidence: 0`. Its D1–D26 review packet revalidates scope, integrity, unexpired consent, bounded review time, bounded synthetic-evidence freshness, a causally coherent review deadline, exact governance-derived expiry/deadline math, plain own-data records, case-insensitive maker–checker identity, dense own-data field arrays, well-formed UTF-8-bound text, an exact built-in clock boundary, descriptor-checked proposal-field records, Node-detected Proxy-free data graphs, checked ECMAScript date arithmetic, canonical hook-free packet integrity encoding, module-captured structural/temporal/encoding intrinsics, module-captured SHA-256 operations, module-captured regex validation, a module-captured Proxy inspector, a strict lowercase-SHA-256 audit receipt, a descriptor-checked non-Proxy audit append/native-Promise boundary, audit-method provenance that excludes `Object.prototype` and indirect prototype chains, a single-read validated-scope/frozen audit-event handoff, own-descriptor-bound review scope/clock members, a literal-`true` owner-approval gate, and an exact closed-set review decision before reviewer, clock, or audit work. It does not authorize or perform apply/send. See [the GM2 contract](docs/GCL_VISION_CONTRACT.md).

## Synthetic market connector

The GCL `market` connector is proposal-only. It accepts no provider
credentials, does not query Hub Connect or any capacity market, and cannot
reserve capacity, book a load, publish a listing, or start a background sync.
It remains `LIVE_DISABLED`; only the exact `GCL_MARKET_LIVE_ENABLED=false`
configuration permits the synthetic proposal path. D1 returns a
digest-bound, canonically validated independent-review packet; its receipt is
always `NOT_AUTHORIZED` and cannot authorize any action. D2 can place exactly
one such receipt in an injected process-local synthetic ledger; it is neither
durable nor an HTTP workflow, and it cannot authorize an action after a
restart or in another process. D3 canonically reconstructs a caller-held D2
receipt against its original plan without reading storage or writing audit,
quota, or ledger state; it is only a local mutation check, never a signature,
credential, approval workflow, or execution path. D4 can additionally compare
that receipt with one caller-held audit event and predecessor hash by
recomputing its single SHA-256 chain link. It performs no storage lookup or
write, does not prove durable audit retention or complete-chain integrity, and
cannot authorize any action. D5 can only read-check a caller-held
`requested → succeeded → owner_reviewed` segment, including its two internal
links and canonical run semantics. It returns fixed `NOT_AUTHORIZED` evidence
only, does not prove durable storage or a predecessor, and cannot authorize any
action. D6 can derive and recheck only a minimized, digest-bound rendering of
that same caller-held D5 segment. It performs no storage lookup or write and
remains unkeyed mutation evidence, never a signature, credential, authorization,
or execution capability. D7 can bind independently rebuilt D3 and D6 evidence
into an even smaller, digest-only no-action manifest; it omits request, actor,
decision, and audit-hash data, reads and writes no storage, and remains neither
a signature, credential, authorization, nor execution capability. D8 accepts
only exact own-data records/results at the injected D2 terminal-ledger seam;
accessor-, Proxy-, inherited-, hidden-, and symbol-shaped values fail closed.
A malformed audit append leaves that process-local tuple undecided for a later
retry, never creating an action or durable approval. D9 snapshots every
caller-held review-plan branch into bounded own data before semantic review and
checks host-ledger members/results by descriptor before a receipt can be built;
shaped plans and ledger results remain fail-closed and cannot authorize any
action. D10 applies the same descriptor-based boundary to the review context:
its scope array is copied as bounded own data and its clock is a one-call host
seam whose intrinsic `Date` value is copied. Shaped context/clock values fail
closed and cannot change the already-snapshotted review scope or authorize an
action. D11 requires the primitive boolean `true` at the governed runner,
direct market-run, and independent-review owner gates; truthy lookalikes fail
before context, clock, ledger, audit, or quota seams and cannot authorize an
action. D12 snapshots the governed-run request envelope and scope strings as
exact own data before connector preflight, audit, or quota; accessor-, Proxy-,
inherited-, hidden-, symbol-, sparse-, and extra credential-shaped fields fail
closed. The market input itself remains bounded synthetic data for its own
parser, never a credential or live action. D13 preserves that parser's
canonical preflight copy across the runner's asynchronous audit, quota, and
run seams, so a caller cannot mutate the original input into a different
proposal or provider-shaped request after ingress. D14 also copies the
connector's exact scalar configuration at construction, so a caller cannot
flip its live gate, limit, or inject a credential-shaped field after
preflight; malformed configuration remains unavailable before audit or quota.
D15 fixes the governed runner's audit/quota data-function members at
construction, requires exact SHA-256 audit results, and copies one verified
clock instant before market preflight, audit, or quota; malformed host seams
fail closed and cannot create a successful market result. D16 applies an
exact own-data snapshot to direct `market.preflight`/`market.run` contexts and
copies their sole clock result before plan construction; shaped contexts and
invalid times fail closed and cannot alter a synthetic plan. D17 fixes the
selected synthetic connector instance: its private configuration, own
preflight/run functions, and market scope tuple cannot be replaced while
governed audit or quota work is pending. D18 freezes every branch of the
emitted synthetic plan—including its request, binding, sources, quote,
side-effect, owner-review, and review-packet objects—before it crosses the
caller boundary. A caller must make a separate copy to propose a change, and
the canonical review validator rejects action or credential-shaped drift in
that copy; neither form can authorize an action. D19 applies the same
immutable egress boundary to canonical review results and all D3–D7 evidence:
the review receipt, audit witness/event, audit-trail witness/receipt, and
evidence manifest can neither acquire action/provider fields in place nor
authorize an action. Any simulated change needs a separate fail-closed copy.
D20 seals the direct preflight output and direct/governed connector result and
provenance branches after audit enrichment, so in-place provider, instruction,
confidence, or result replacement cannot change their data-only, no-action
meaning. A changed copy still must pass the bounded parser and canonical
review, and cannot authorize an action. D21 rejects a shaped, forged, or
credential/provider-shaped connector result before its succeeded audit,
snapshots exact result/provenance metadata before that asynchronous seam, and
freezes the copied final egress. The connector cannot supply the audit hash or
relabel the returned market result while the local success audit is pending;
data and request values remain synthetic, data-only, and `LIVE_DISABLED`. D22
freezes the bounded registry-visible connector control plane (ID, auth/quota
metadata, scopes, and preflight/run references) at construction. Shaped or
credential/provider-shaped registration fails before any audit, quota, or
connector seam; later mutation cannot retarget a synthetic, `LIVE_DISABLED`
run or authorize an action. D23 captures the runner's registry resolver,
audit/quota callbacks, and local clock behind a native private field. Proxy,
accessor, missing-method, and Proxy-clock collaborators fail closed before any
clock call, audit append, quota reservation, or connector run; later public
collaborator or legacy-runner-field replacement cannot retarget the synthetic,
no-action path. D24 treats a connector rejection as opaque data: a failed-run
audit uses only the fixed `CONNECTOR_RUN_FAILED` code, without evaluating an
error accessor/Proxy or retaining provider/credential-shaped fault text. The
rejection and any failed audit append remain fail-closed and cannot authorize
an action.
