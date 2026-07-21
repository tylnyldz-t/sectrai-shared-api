# GM4 Video — governed synthetic connector contract

GM4 adds two GCL media-generation contracts:

```text
video-text-to-video        scope: video:text-to-video
video-image-text-to-video  scope: video:image-text-to-video
```

Both use the existing owner-token route:

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/:connectorId/runs
GET  /api/products/:product/workspaces/:workspaceId/gcl/video/jobs
```

Every request still requires the product key, `X-Sectrai-Owner-Token`, and a
valid `X-Sectrai-Owner-Actor`. The generic GCL runner applies the owner gate,
declared scope, required positive cost ceiling, shared daily video quota, and
SHA-256 audit chain before a job is accepted. `video-text-to-video` and
`video-image-text-to-video` share the `video` quota group, so changing modes
cannot evade the daily budget.

## Input contracts

Text-to-video accepts exactly:

```json
{
  "input": {
    "prompt": "15 second product introduction",
    "durationSeconds": 15,
    "aspectRatio": "16:9",
    "variants": 1
  },
  "scopes": ["video:text-to-video"],
  "costCapCents": 50,
  "requestedItems": 1
}
```

Image-plus-text-to-video accepts the same fields plus an already-owned asset
reference. It intentionally accepts `asset://…` only: this connector never
downloads a URL, reads a file, or sends image bytes anywhere.

```json
{
  "input": {
    "prompt": "Animate the supplied concept art with a slow camera move",
    "durationSeconds": 15,
    "aspectRatio": "16:9",
    "variants": 1,
    "imageAssetRef": "asset://concepts/scene-01"
  },
  "scopes": ["video:image-text-to-video"],
  "costCapCents": 50,
  "requestedItems": 1
}
```

`requestedItems` must equal `input.variants`; that prevents a quota request
from understating the requested number of outputs. Aspect ratios are limited
to `16:9`, `9:16`, and `1:1`.

## Synthetic-only boundary

The adapters do not contain a provider URL, fetch client, SDK, API key, or
credential field. A successful request creates only a durable queued record:

```json
{
  "state": "queued",
  "mode": "SYNTHETIC",
  "liveStatus": "LIVE_DISABLED",
  "publication": "OWNER_APPROVAL_REQUIRED",
  "artifact": { "kind": "video", "state": "NOT_GENERATED", "autoPublish": false }
}
```

No video bytes or publishable URL can be returned. Prompt and asset-reference
content remain `data-only` under the standard untrusted-content policy; they
are never interpreted as instructions. `GCL_VIDEO_LIVE_ENABLED=true` is not
an opt-in: it returns `VIDEO_LIVE_DISABLED` and makes no call. A real provider
would require a separately owner-approved connector and contract.

## Queue and configuration

Queued jobs are stored under the reserved `gcl-video-queue` module. Normal
record CRUD cannot alter it. Per product/workspace queue capacity is guarded
by a PostgreSQL advisory transaction lock; a full queue returns
`429 connector_queue_full`. Because this is a synthetic-only phase, there is
no worker and no automatic completion, publication, or external dispatch.

All limits are required at run time and missing values fail closed:

```dotenv
GCL_VIDEO_LIVE_ENABLED=false
GCL_VIDEO_MAX_COST_CENTS=50
GCL_VIDEO_MAX_ITEMS=2
GCL_VIDEO_MAX_DURATION_SECONDS=30
GCL_VIDEO_MAX_PROMPT_CHARACTERS=2000
GCL_VIDEO_DAILY_RUN_QUOTA=10
GCL_VIDEO_DAILY_ITEM_QUOTA=20
GCL_VIDEO_QUEUE_MAX_QUEUED_JOBS=25
```

The request cost cap must not exceed `GCL_VIDEO_MAX_COST_CENTS`; requested
variants must not exceed `GCL_VIDEO_MAX_ITEMS`; and the shared daily run/item
budget is reserved conservatively before enqueue. As with all GCL runs, a
post-reservation failure still keeps the quota reservation and receives a
failed audit event.
