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
