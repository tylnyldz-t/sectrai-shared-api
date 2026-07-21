# GM3 — Synthetic Text-to-Image Connector

`image-tti` is a GCL `media-generation` connector with only the
`image:generate` scope. This implementation is intentionally synthetic: it
creates local SVG owner-review candidates and cannot contact an image provider.
It has no credential, provider URL, fetch client, or live-provider mode.

## Gates and result lifecycle

1. `GovernedConnectorRunner` requires `ownerApproved`, a valid scope, positive
   cost cap, and positive requested item count.
2. `SyntheticImageTtiConnector` requires `GCL_IMAGE_LIVE_MODE=LIVE_DISABLED`,
   `GCL_IMAGE_MAX_COST_CENTS`, and `GCL_IMAGE_MAX_ITEMS`; malformed or missing
   values reject the request.
3. The synchronous `FamilySafetyFilter` hook runs in preflight before audit or
   quota reservation. The included baseline filter is deliberately conservative
   and must be replaced by an owner-approved policy before any future provider
   work is considered.
4. The runner appends request/success/failure events to the hash-chain audit
   log and reserves daily usage through `PrismaDailyConnectorQuota`.
5. Every candidate starts `owner-only`, `pending`, and `publication: blocked`.
   Only `ownerLikeSyntheticImage(..., true, actor, auditLog, context)` creates
   a liked artifact and appends the owner decision to the same audit chain. It
   remains blocked from publication. Publishing is outside GM3 scope.

A host composes the governed path with
`SyntheticImageTtiConnector`, `ConnectorRegistry`, `GovernedConnectorRunner`,
`PrismaHashChainAuditLog`, and
`new PrismaDailyConnectorQuota(prisma, imageDailyQuotaFromEnvironment())`.
The host must authenticate the owner before it supplies `ownerApproved: true`
or invokes the owner-like function; this module does not create an HTTP auth
route or store a secret.

## Synthetic-only environment contract

```dotenv
GCL_IMAGE_LIVE_MODE=LIVE_DISABLED
GCL_IMAGE_MAX_COST_CENTS=25
GCL_IMAGE_MAX_ITEMS=2
GCL_IMAGE_DAILY_RUN_QUOTA=10
GCL_IMAGE_DAILY_ITEM_QUOTA=20
```

No image-provider key, credential, endpoint, SDK, or live flag is accepted.
Supplying any `GCL_IMAGE_LIVE_MODE` value other than `LIVE_DISABLED` closes the
connector. The output provenance stores only a SHA-256 prompt digest and marks
the supplied prompt as `data-only`; it never treats prompt content as internal
instructions.
