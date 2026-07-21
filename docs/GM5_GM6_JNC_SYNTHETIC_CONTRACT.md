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
