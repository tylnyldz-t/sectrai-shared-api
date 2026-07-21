# GM3 — Synthetic Text-to-Image Connector

`image-tti` is a GCL `media-generation` connector with only the
`image:generate` scope. It follows the *shape* of the Jarvis Creative Worker
image adapter: `creative-job-v1`, `local-comfyui`, `image`, `sdxl`, and the
ComfyUI node sequence `CheckpointLoaderSimple → CLIPTextEncode →
EmptyLatentImage → KSampler → VAEDecode → SaveImage`.

This implementation is deliberately synthetic. It produces local SVG
owner-review candidates plus a redacted structural plan. It has no credential,
provider URL, HTTP/fetch client, Docker client, loopback client, executable
Comfy graph, checkpoint resolution, or dispatch path. `LIVE_DISABLED` is the
only accepted mode.

## Gates and result lifecycle

1. `GovernedConnectorRunner` requires `ownerApproved`, bounded identity and
   correlation ID, an allowed scope, positive cost cap, and positive requested
   item count.
2. `SyntheticImageTtiConnector` requires `GCL_IMAGE_LIVE_MODE=LIVE_DISABLED`,
   `GCL_IMAGE_MAX_COST_CENTS`, and `GCL_IMAGE_MAX_ITEMS`; missing or malformed
   limits reject the request.
3. The synchronous `FamilySafetyFilter` hook runs in preflight before audit or
   quota reservation. The included baseline filter is deliberately conservative
   and is not a production moderation policy.
4. The runner appends request/success/failure events, with a correlation ID,
   to the per-workspace SHA-256 chain and reserves daily usage through
   `PrismaDailyConnectorQuota`.
5. Each candidate is `owner-only`, `pending`, and `publication: blocked`.
   The candidate records its maker. Only a different owner checker may call
   `ownerLikeSyntheticImage(..., true, checker, auditLog, context)`; self
   approval is denied. The resulting artifact is still blocked from
   publication.

The candidate's `creativeWorkerPlan` is intentionally **not** an executable
Creative Worker manifest: it has no raw prompt or negative prompt, no actual
checkpoint ID, and `dispatch.performed` is permanently `false`. It uses only
prompt digests and declares `UNRESOLVED_SYNTHETIC_ONLY`; it cannot be submitted
to Jarvis Creative Worker or ComfyUI.

A host may compose the governed path with `SyntheticImageTtiConnector`,
`ConnectorRegistry`, `GovernedConnectorRunner`, `PrismaHashChainAuditLog`, and
`new PrismaDailyConnectorQuota(prisma, imageDailyQuotaFromEnvironment())`.
The host must authenticate both maker and independent owner checker before it
can set `ownerApproved: true` or call the owner-like function. This module does
not expose an HTTP route or manage credentials.

## Synthetic-only environment contract

```dotenv
GCL_IMAGE_LIVE_MODE=LIVE_DISABLED
GCL_IMAGE_MAX_COST_CENTS=25
GCL_IMAGE_MAX_ITEMS=2
GCL_IMAGE_DAILY_RUN_QUOTA=10
GCL_IMAGE_DAILY_ITEM_QUOTA=20
```

No image-provider key, credential, endpoint, SDK, Docker setting, ComfyUI
setting, or live flag is accepted. Supplying any `GCL_IMAGE_LIVE_MODE` value
other than `LIVE_DISABLED` closes the connector. Prompt data is never returned
in the candidate, plan, provenance, or audit detail: only SHA-256 digests are
kept and all owner-supplied text is declared `data-only`, never instructions.

This contract does not authorize a real provider, a local GPU worker, a model
installation, a migration, or public publishing. Each remains a separate owner
decision and must be implemented behind its own bounded approval path.
