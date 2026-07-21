# GM6 Game Engine Connector Contract

`game-engine` is a GCL connector with a deliberately synthetic boundary. It
creates deterministic build plans only. It never starts Godot, Unreal, Blender,
or a shell process; it never contacts `jarvis-node-controller`; it never reads
engine/GPU/provider credentials; and it contains no publishing action.

`LIVE_DISABLED` is a hard-coded `true` value in the adapter. An attempted
`GCL_GAME_ENGINE_LIVE_ENABLED=true` configuration fails closed with
`GAME_ENGINE_LIVE_DISABLED`; it cannot enable a live path.

## Owner-gated HTTP run

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/game-engine/runs
```

The request requires the normal `X-Sectrai-Product-Key` plus
`X-Sectrai-Owner-Token` and `X-Sectrai-Owner-Actor`. If the server has no
`GCL_OWNER_TOKEN`, the route returns `503`; an absent or wrong owner token
returns `403`. The run is appended to a per-workspace SHA-256 audit chain and
a daily reservation before the synthetic plan is returned.

The generic GCL request body is intentionally exact:

```json
{
  "input": {
    "tier": "economic",
    "engine": "godot",
    "projectId": "forest-puzzle",
    "brief": "Three-level low-poly forest puzzle with mobile controls.",
    "target": "mobile"
  },
  "scopes": ["game:project:build"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

Economic requests must use `tier: economic`, `engine: godot`, and exactly one
build unit. The response has only planned-not-executed pipeline stages,
including command templates for `godot --headless`; templates are not passed to
a shell or a process runner.

Premium requests use `tier: premium` with `engine: unreal` or `blender`:

```json
{
  "input": {
    "tier": "premium",
    "engine": "unreal",
    "projectId": "forest-puzzle-cinematic",
    "brief": "Cinematic forest level preview.",
    "target": "desktop",
    "gpuMinutes": 20
  },
  "scopes": ["game:project:build"],
  "costCapCents": 180,
  "requestedItems": 20
}
```

For premium, `requestedItems` must exactly equal `gpuMinutes`; that is the
daily GPU-minute reservation. The plan exposes an unsent,
`autoStart: false` jarvis-node-controller contract hook and includes the
owner-provided cost ceiling. Per-run cost and GPU-minute ceilings are checked
before audit/quota reservation. Daily runs and GPU-minute reservations are
persisted conservatively, so even a failed post-reservation run consumes quota.

Every result marks the input as
`UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`. The returned `buildOutput` stays
`OWNER_APPROVAL_REQUIRED`; `publication` is always
`DISABLED_NOT_IMPLEMENTED` and `automatic: false`.

## Deploy-time governance configuration

The deployment owner keeps `GCL_OWNER_TOKEN` secret and configures the
non-secret governance limits. Missing or invalid values close the connector
route; no local, in-memory, or live fallback exists.

```dotenv
GCL_OWNER_TOKEN="owner-secret-held-only-by-deployment-owner"
GCL_GAME_ENGINE_LIVE_ENABLED=false
GCL_GAME_ENGINE_MAX_COST_CENTS=250
GCL_GAME_ENGINE_MAX_GPU_MINUTES=30
GCL_GAME_ENGINE_DAILY_RUN_QUOTA=10
GCL_GAME_ENGINE_DAILY_GPU_MINUTE_QUOTA=120
```

No engine, GPU, cloud, provider, or API credential belongs in this service or
in this contract. A future live executor requires a separate owner-approved
design and is outside GM6.
