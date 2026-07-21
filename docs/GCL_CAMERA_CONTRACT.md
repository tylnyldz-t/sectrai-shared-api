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

## Audit and storage boundary

The existing shared `gcl-audit` and `gcl-usage` records use the product/workspace scoped SHA-256 chain and quota reservation. Audit detail includes IDs/digests and decision state only—never raw request input, media, stream/device values, or consent receipt content. The regular records API excludes both reserved modules. D1/D2 add no migration and no new persistence model.

## ADOS 10-rule conformance

1. Product/workspace digest binding keeps each run and review packet scoped to one data plane.
2. Only minimized built-in synthetic fixture metadata is accepted.
3. The front door default-denies absent configuration; `LIVE_DISABLED` is permanent.
4. Unknown fields, media, device identifiers, personal identity, and biometric inference are excluded.
5. Purpose-bound synthetic KVKK consent must match the fixture.
6. Owner approval plus maker–checker separation are required; D1 rejects the original maker as reviewer and D2 minimizes that review evidence.
7. The code has no device SDK, transport, network client, credential, or provider interface.
8. Preflight, quota reservation, and the scoped hash-chain audit enforce bounded governance without a new database schema.
9. Owner review and its D2 receipt record no handoff, command, notification, publication, or automatic action.
10. This branch contains no live launch, production migration, main/prod write, or camera hardware path.

## Explicit non-goals

There is no real credential/API key, live or provider call, sending, camera/media/device connection, production migration, auto-start worker, live launch, or write to `main`/production in this package.
