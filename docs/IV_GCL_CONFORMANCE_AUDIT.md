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

The audit fixture is deliberately source-only.  It reads the nine local
worktree snapshots, pins each connector and runner to its Git blob hash, and
does not import a connector, read an `.env` file, contact a provider, or open
a network socket.  Run it with:

```bash
npm run test:conformance
```

It is fail-closed: if one of the audited local Git objects is absent, the
fixture fails rather than treating the source as conformant.  The target
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

- The fixture asserts that every connector source declares `LIVE_DISABLED`,
  contains no HTTP/egress client primitive, and that the only two
  `*_LIVE_ENABLED` environment surfaces (market and camera) immediately
  reject a true value.  All other snapshots expose no such environment
  surface.
- The quota-rejection edge is intentionally tested as an audit classification:
  a runner is conformant only when `await quota.consume(...)` is inside the
  `try` whose `catch` appends `connector.run.failed`, after the `requested`
  event.  The first eight D1 runners put quota consumption before that `try`;
  camera puts it inside.  This prevents the report from claiming a failed
  event that the source cannot append.
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
