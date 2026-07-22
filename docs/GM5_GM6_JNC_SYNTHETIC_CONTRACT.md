# GM5/GM6 synthetic connector contract

GM5 3D and GM6 game-engine connectors return review data only. They are not
provider, JNC, GPU, Blender, Unreal, Godot, shell, credential, file-write, or
publication clients.

## Hard boundary

- `LIVE_DISABLED` is the sole accepted mode.
- Every result has `confidence: 0`, is frozen, and has no transport.
- A 3D artifact is a `synthetic://` proposal, requires owner review, and is
  never published.
- A GPU card is contract data with `transport: NONE` and
  `dispatch: NOT_DISPATCHED`; it does not reserve or start a GPU.
- Blender and Unreal handoffs are `SYNTHETIC_HANDOFF_ONLY_NOT_SENT`.
- A game-engine result is a non-executed plan. Godot has no GPU card; premium
  Blender/Unreal plans carry only the disabled card and handoff data.

## Governance

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/:connectorId/runs
```

The route requires the product key, configured owner token, owner actor, and
exact connector input. The governed runner then checks the approved scope,
cost cap, requested-item count, and each connector's `LIVE_DISABLED` limits
before writing an audit request or consuming daily quota. Successful and
failed adapter runs receive a terminal audit event; a quota reservation remains
counted after a failed run.

The direct adapter boundary repeats the owner, scope, cap, and disabled-mode
checks. It accepts data only and creates no execution capability.

## Configuration

Only the following GCL values are read:

```text
GCL_OWNER_TOKEN
GCL_3D_LIVE_MODE / GCL_3D_MAX_COST_CENTS / GCL_3D_MAX_ITEMS
GCL_3D_DAILY_RUN_QUOTA / GCL_3D_DAILY_ITEM_QUOTA
GCL_GAME_ENGINE_LIVE_MODE / GCL_GAME_ENGINE_MAX_COST_CENTS / GCL_GAME_ENGINE_MAX_GPU_MINUTES
GCL_GAME_ENGINE_DAILY_RUN_QUOTA / GCL_GAME_ENGINE_DAILY_GPU_MINUTE_QUOTA
```

No endpoint, executable path, provider credential, or live-mode setting is
supported.
