# IV GCL connector conformance audit

Audit date: 2026-07-22.  This is a source and fixture audit only.  It used
local Git object archives and deterministic in-process fixtures.  No real
credential was loaded, no live provider was enabled, and no network, prod, or
`main` write was made.

## Required envelope

For a governed connector, the following are required:

1. a denied owner approval must reach neither quota nor adapter;
2. an accepted run must reserve quota and append a `requested` then
   `succeeded` hash-chain audit event;
3. a quota rejection after `requested` must append a linked `failed` audit
   event; and
4. this IV scope must be synthetic and fail closed with `LIVE_DISABLED`.

Preflight rejections intentionally occur before quota and audit reservation.

## Fixture evidence

Audited source revisions: GM1 `77b4bed`, GM2 `c30a84c`, GM3 `cac892f`, GM4
`ca75503`, GM5 `2adc8fc`, GM6 `54ebdf8`, ARGlass `5e8c2dd`, and GCL L0
`1dbf1af`.

The existing branch-local unit fixtures ran successfully: GM1 voice (4), GM2
vision (7), GM3 image (7), GM4 video (5), GM5 3D (6), GM6 game engine (4),
and ARGlass (4): 37 passing tests.

An additional local-only Apify fixture constructed the connector without
`liveEnabled`, token, or actor id, injected a fetch counter, and verified
`APIFY_CONNECTOR_NOT_CONFIGURED` with zero requests.

A synthetic connector plus a rejecting in-memory quota was then run through
each governed runner.  Its audit sequence was:

| Connector | Owner gate | Accepted-run quota/audit | Quota-rejection audit | Strict `LIVE_DISABLED` | Result |
| --- | --- | --- | --- | --- | --- |
| GM1 voice STT/TTS | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM2 vision/OCR | Pass | Pass | `requested`, `failed` | Pass | Conformant |
| GM3 image TTI | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM4 video | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM5 text/image-to-3D | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM6 game engine | Pass | Pass | `requested` only | Pass | Nonconformant |
| ARGlass device session | Local input gate only | No GCL quota | `NOT_PERSISTED` | Pass | Nonconformant as a GCL connector |
| GCL Apify pilot | Pass | Pass | `requested` only | Default only; a live opt-in code path exists | Nonconformant |

The live-disabled fixture does **not** exercise Apify's live opt-in path.  The
source audit records that path as a strict-mode violation even though the
default environment setting is fail closed.

## Blocking remediation

Do not certify the listed nonconformant connectors for IV GCL until all of the
following are complete in their owning branches:

1. Move quota reservation inside `GovernedConnectorRunner`'s `try` block (or
   otherwise append `connector.run.failed` on quota rejection) for GM1,
   GM3–GM6, and Apify.  Preserve the original `requestedAuditHash` link.
2. Add a rejecting-quota fixture to every affected connector and require the
   exact `requested`, `failed` chain order.
3. Either route ARGlass through the common owner/quota/hash-audit envelope, or
   classify it as a non-GCL local contract and stop presenting it as a GCL
   connector.
4. For this synthetic IV scope, remove or hard-deny Apify's live opt-in path;
   an unset default is insufficient for the required permanent
   `LIVE_DISABLED` boundary.

## Scope boundary

This audit intentionally did not alter production configuration, credentials,
providers, databases, or any `main`/prod target.  It establishes the current
conformance state and the exact blockers; it is not live-provider approval.

## D1 — next connector package

This follow-up audited the local, immutable Git snapshots for the next
package: RA voice `80a1cc6`, RA OCR `f6f28d7`, RA image `4d0806b`, RA
3D/game `7e5b947`, RA market `1b53141`, RFID `7b14d54`, translation
`43541af`, language education `2635230`, and camera `0c166df`.

The audit fixture is deliberately source-only.  It reads each connector and
runner with local `git show <pinned-commit>:<path>`, then verifies its Git blob
hash; it never reads the mutable sibling worktree file.  It does not import a
connector, read an `.env` file, contact a provider, or open a network socket.
Run it with:

```bash
npm run test:conformance
```

It is fail-closed: if an audited local repository, commit, source object, or
recorded blob is absent or mismatched, the fixture fails rather than treating
the source as conformant.  A sibling worktree can therefore legitimately move
on to other work without changing this archived D1 evidence.  The target
packages' own synthetic unit suites were also run with Node's `tsx` loader;
their database integration tests were intentionally not run because they
require `DATABASE_URL` and are outside this source-only audit.

| Connector | Snapshot safety boundary | Owner/preflight | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D1 result |
| --- | --- | --- | --- | --- | --- |
| RA voice | synthetic descriptors only; no client or provider URL | Pass | `requested` only | Pass | Nonconformant |
| RA OCR | masked synthetic evidence only; no raw image/client | Pass | `requested` only | Pass | Nonconformant |
| RA image | synthetic review candidate; no Comfy dispatch | Pass | `requested` only | Pass | Nonconformant |
| RA 3D/game | contract-only JNC hand-off; no transport/process launch | Pass | `requested` only | Pass | Nonconformant |
| RA market | proposal-only; a true live flag is hard-denied | Pass | `requested` only | Pass | Nonconformant |
| RFID | PSMS-TAG-SIM only; no reader, tag, or network input | Pass | `requested` only | Pass | Nonconformant |
| Translation | synthetic text/audio references only | Pass | `requested` only | Pass | Nonconformant |
| Language education | family-safe synthetic references; no audio or learner profile | Pass | `requested` only | Pass | Nonconformant |
| Camera | consent-bound fixtures; no media/device/identity path | Pass, including maker–checker denial | `requested`, `failed` | Pass; a true live flag is hard-denied | Conformant |

### D1 negative and edge evidence

- The fixture follows the local `src/gcl` import closure of each connector
  and runner.  It asserts `LIVE_DISABLED`, no HTTP/egress primitive or provider
  endpoint, no credential-like environment name, no subprocess/worker-launch
  primitive, and no automatic-publication flag.  The SVG XML namespace is
  explicitly excluded from the endpoint check because it is data syntax, not
  a network target.
- The only two `*_LIVE_ENABLED` environment surfaces (market and camera)
  immediately reject a true value.  All other snapshots expose no such
  environment surface.
- The owner-denial edge is checked before preflight, requested-audit
  reservation, and quota reservation in every pinned runner.  This confirms
  a rejected owner cannot reach an adapter or consume quota; it does not infer
  an owner decision from a fixture.
- The quota-rejection edge is intentionally tested as an audit classification:
  a runner is conformant only when `await quota.consume(...)` is inside the
  `try` whose `catch` appends a `connector.run.failed` event linked by
  `requestedAuditHash`, after the `requested` event.  The first eight D1
  runners put quota consumption before that `try`; camera puts it inside.
  This prevents the report from claiming a failed event that the source
  cannot append.
- Existing package tests cover their local input/preflight boundaries.  In
  particular, camera's unit suite covers revoked/mismatched consent,
  maker–checker self-approval, an unknown connector, a true live flag, and a
  quota rejection.  No test used a credential, real provider, real device,
  migration, production database, or send/publish operation.

### D1 remediation and ADOS boundary

The first eight packages must move quota reservation into the protected
`try` (or append an equivalent linked `connector.run.failed` event) and add a
behavioural rejecting-quota fixture before GCL certification.  The original
Apify L0 live opt-in remains a separate blocker from the first package.

This D1 work keeps the ten ADOS rules intact: product data planes are not
joined; missing gates deny by default; only source pointers/blob hashes cross
the audit boundary; no owner decision is inferred; camera alone proves the
maker–checker edge; audit-chain gaps are reported rather than hidden; no
migration is introduced; all outputs remain proposal-only; no JARVIS job is
started; and synthetic testing is not a launch decision.

## D2 — next committed connector package

This follow-up is again a source-only audit.  It pins the next committed
connector package, rather than observing a sibling worktree: RA OCR
`b8d9505`, RA image `ee498bf`, RA 3D/game `e896365`, RA market `e20e176`,
RFID `14f069a`, translation `eff19c3`, and camera `9a3841a`.  Voice and
language-education had no subsequent committed connector/runner package, so
they remain D1 evidence; a language-education cleanup-only commit is not
treated as a new connector audit.

The fixture reads each named Git object with `git show`, checks the connector
and runner blob IDs, and follows only its local `src/gcl` import closure.  It
does not read mutable target source, import a connector, load an environment
file, start a worker, open a socket, or contact a provider.  Missing local
repositories, commits, paths, or blob mismatches fail the audit.  Run the
complete D1/D2 fixture with:

```bash
npm run test:conformance
```

| Connector | D2 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D2 result |
| --- | --- | --- | --- | --- |
| RA OCR | Synthetic document review packet and independent-review validation | `requested` only | Pass | Nonconformant |
| RA image | Synthetic image-review ledger closure | `requested` only | Pass | Nonconformant |
| RA 3D/game | JNC contract test/documentation package | `requested` only | Pass | Nonconformant |
| RA market | Literal `false` is now required; absent, malformed, and true live settings deny | `requested` only | Pass | Nonconformant |
| RFID | `quota.consume` is inside the protected lifecycle; failure detail forwards `requestedAudit.hash` | `requested`, `failed` | Pass | Conformant |
| Translation | Latest committed artifact-contract package (connector blob is unchanged) | `requested` only | Pass | Nonconformant |
| Camera | ADOS control evidence and synthetic review hardening | `requested`, `failed` | Pass | Conformant |

`Conformant` in this table means only that the immutable source meets this IV
synthetic GCL envelope.  It is neither live-provider approval nor permission
to connect a device, run a JARVIS/JNC job, write production data, publish, or
send an output.

### D2 negative and edge evidence

- The closure check now permits only local GCL files and the non-transport
  `node:crypto` module.  A static import of a runtime/transport module fails.
- Dynamic `import(...)`, CommonJS `require(...)`/`module.require(...)`, and
  `createRequire(...)` fail.  This closes a dependency-loading bypass that a
  direct egress-call scan alone would miss.
- Direct egress primitives remain denied; `globalThis['fetch']` (and the
  equivalent XMLHttpRequest/WebSocket client lookup) is now also an explicit
  negative probe.  Bracket-style credential reads such as
  `process.env['SYNTHETIC_API_KEY']` likewise fail.
- The source classifier recognizes both direct failure links and a local
  helper that receives `requestedAudit.hash` and emits `requestedAuditHash`.
  This records RFID's protected quota failure accurately without claiming the
  same behaviour for runners that reserve quota before `try`.
- Owner denial is still required before preflight, requested-audit append, or
  quota reservation.  The static check accepts the equivalent strict form
  `ownerApproved !== true`; it does not infer an approval from fixtures.

### D2 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still need their quota
reservation inside the protected `try` (or an equivalent linked failed-audit
path) plus behavioural rejecting-quota tests before GCL certification.  The
D1 Apify live-opt-in blocker is unchanged and remains outside this D2 package.

All ten ADOS rules remain in force: no product data-plane join; default-deny
gates (including RA market's strict-false setting); source/blob pointers only
across the audit boundary; no inferred owner decision; maker–checker retained
for camera; audit gaps reported; no migration; proposal-only output; no JARVIS
or JNC launch; and a synthetic source test is not a deployment decision.

## D3 — next committed connector package

D3 pins the next committed package after D2: RA OCR `27e4828`, RA image
`6c13d06`, RA 3D/game `55df54f`, RA market `3f4aae8`, RFID `275cef6`,
translation `32cf3d0`, language education `3492a3b`, and camera `dd36dfe`.
Voice has no new committed connector package and remains D1 evidence.  As in
the prior batches, this is a local Git-object audit only: the fixture reads
`git show <pinned-commit>:<path>`, verifies both connector and runner blob
hashes, and follows only the local `src/gcl` import closure.  It neither
imports target runtime code nor reads an environment file, opens a socket,
starts a process, loads a credential, sends output, runs a migration, or writes
to `main` or production.

Run the full immutable D1/D2/D3 source audit with:

```bash
npm run test:conformance
```

| Connector | D3 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D3 result |
| --- | --- | --- | --- | --- |
| RA OCR | Integrity-bound, maximum one-day independent-review window | `requested` only | Pass | Nonconformant |
| RA image | Plain-data input validation and canonical candidate-issuance ledger | `requested` only | Pass | Nonconformant |
| RA 3D/game | Immutable synthetic review snapshot bound to the JNC contract plan | `requested` only | Pass | Nonconformant |
| RA market | Append-only synthetic market-review ledger; literal-false live setting remains required | `requested` only | Pass | Nonconformant |
| RFID | Documentation and rejecting-quota fixture refresh; D2 connector/runner blobs remain unchanged | `requested`, `failed` | Pass | Conformant |
| Translation | Bounded, hash-bound synthetic translation artifact contract and safety checks | `requested` only | Pass | Nonconformant |
| Language education | Protected quota reservation and linked, stable failure audit code | `requested`, `failed` | Pass | Conformant |
| Camera | Plain-record input/consent hardening; synthetic review remains maker–checker bound | `requested`, `failed` | Pass | Conformant |

`Conformant` remains narrowly scoped to the IV synthetic governance envelope.
It does not authorize a provider, device, audio/media capture, JNC/JARVIS
launch, publication, handoff, production write, or real-world send.

### D3 negative and edge evidence

- The source-only negative probes now reject optional-chain and reflective
  egress lookups (`globalThis?.fetch` and `Reflect.get(globalThis, 'fetch')`),
  as well as the original bracketed client lookup.  This prevents a direct-call
  scanner from overlooking a stored transport capability.
- Dynamic module/evaluation bypasses now fail for commented dynamic import,
  `module?.require(...)`, and `Function(...)`, in addition to ordinary
  `import(...)` and `require(...)`.  A non-local static import remains denied
  unless it is the explicitly non-transport `node:crypto` module.
- Credential-like environment reads fail for both `process.env['…TOKEN']` and
  `process['env']?.['…TOKEN']`.  The fixture also proves a relative import that
  leaves `src/gcl` is an audit error rather than a permitted local dependency.
- The quota classification remains intentionally conservative.  RA OCR, image,
  3D/game, market, and translation reserve quota before the protected `try`,
  so their source cannot prove a linked failed event for a quota denial.  RFID,
  language education, and camera reserve quota within that protected lifecycle
  and link `requestedAuditHash` to `connector.run.failed`.

### D3 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still require protected quota
reservation (or an equivalent linked failed-audit path) and a behavioural
rejecting-quota fixture before certification.  The historical D1 Apify live
opt-in blocker also remains unresolved and outside the D3 package.

All ten ADOS rules remain intact: no product data-plane join; default-deny
configuration; immutable source/blob pointers only; no inferred owner decision;
camera maker–checker retained; audit gaps reported instead of filled in; no
migration; proposal-only outputs; no JARVIS/JNC launch; and synthetic test
evidence is never a deployment or live-enable decision.
