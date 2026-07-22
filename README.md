# Sectrai Shared API

Shared, product-scoped persistence API for Sectrai synthetic demo products. It uses one Neon Postgres database and one Render web service. It never connects to Sektral, Xontainer, Yapıborsası, or any other database.

## Record contract

Every record is scoped by `product`, `workspaceId`, and `moduleId`:

```ts
{ id, product, workspaceId, moduleId, values, status, createdAt, updatedAt, createdBy }
```

`values` is a bounded JSON object (48 KB maximum). The API rejects unknown request fields, malformed scope identifiers, and requests whose product key is absent or wrong.

## API

All product routes require `X-Sectrai-Product-Key`. A product `sectrai-health` maps to the server environment variable `SHARED_API_KEY_HEALTH`. Missing key configuration is intentionally a `401` fail-closed response.

```text
GET    /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records
POST   /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records
PATCH  /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records/:recordId
DELETE /api/products/:product/workspaces/:workspaceId/modules/:moduleId/records/:recordId
```

- `GET` returns `{ records }`.
- `POST` accepts `{ values, status?, createdBy? }` and returns `201 { record }`.
- `PATCH` accepts `{ values, status? }` and returns `{ record }`.
- `DELETE` returns `204` only when the record exists in the exact product/workspace/module scope.

## GM2 camera observation connector

`POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/camera-observation/runs` is a consent-gated, fixture-only camera observation contract. It requires a product key plus a separately authenticated owner checker and a distinct request maker:

- `X-Sectrai-Owner-Token` — configured local governance secret; missing or mismatched values fail closed.
- `X-Sectrai-Owner-Actor` — checker identity.
- `X-Sectrai-Request-Actor` — maker identity; it must differ from the checker.

The body is bounded to a synthetic fixture, declared purpose, synthetic consent assertion, cost/item limits, and correlation ID:

```json
{
  "input": {
    "synthetic": true,
    "cameraFixtureId": "synthetic-loading-dock-001",
    "purpose": "operational-safety",
    "consent": {
      "state": "granted",
      "receiptRef": "synthetic-consent-safety-001",
      "policyVersion": "kvkk-synthetic-v1",
      "sourceRights": "synthetic-fixture"
    }
  },
  "scopes": ["camera:observe"],
  "costCapCents": 25,
  "requestedItems": 1,
  "correlationId": "synthetic-camera-correlation-001"
}
```

The adapter accepts no snapshot, video bytes, stream URL, device address, serial number, credential, or provider configuration. It resolves only the built-in `synthetic-*` fixtures and permanently reports `mode: "SYNTHETIC"` and `liveStatus: "LIVE_DISABLED"`; a live flag is an explicit rejection, never an opt-in. It never performs biometric or identity inference, does not retain a device identifier or media, and returns `OWNER_REVIEW_REQUIRED`, `NOT_EXECUTED`, `NOT_SENT`, and `NOT_PUBLISHED` outcomes.

Consent must be granted, have the KVKK synthetic policy version and source-rights assertion, and match the selected fixture purpose and synthetic receipt. Missing, revoked, malformed, or mismatched consent is denied before quota reservation. Owner-gate, maker–checker, scope, cost, consent, and execution decisions are appended to a product/workspace SHA-256 audit chain with the correlation ID; raw input and media are never placed in audit details. The normal record API cannot read or mutate the reserved `gcl-audit` and `gcl-usage` modules.

The D1 review-packet package adds an unkeyed SHA-256 mutation check around the fixed synthetic result. `independentlyReviewCameraObservation()` is a library-only, explicit owner-review seam: it revalidates scope, fixture observation, privacy flags, no-handoff state, and packet integrity before appending a review audit event. The original request maker cannot review it. D2 adds a minimized, library-only review receipt and `validateCameraReviewReceipt()`, which rechecks the receipt against the original packet without storage access, quota use, audit append, HTTP route, or durable state. D3 requires every input and review-evidence object to have only allowlisted own enumerable data fields; hidden, symbol, Proxy, accessor/getter, inherited, and raw-media/device-shaped fields fail closed without evaluating an accessor or Proxy trap. D4 adds `validateCameraReviewAuditWitness()`: it read-checks one caller-supplied review audit entry against D1/D2. D5 adds `validateCameraReviewAuditTrailWitness()`: it read-checks only a caller-supplied `requested → succeeded → owner_reviewed` segment, including its internal hashes and fixed no-action fields. D6 adds `createCameraReviewAuditTrailReceipt()` and `validateCameraReviewAuditTrailReceipt()`: they derive and recheck a minimized, context-bound rendering of that same supplied D5 segment. D7 adds `createCameraReviewEvidenceManifest()` and `validateCameraReviewEvidenceManifest()`: they bind independently rebuilt D2/D6 evidence through two integrity digests, omitting the fixture, finding, reviewer, decision text, and audit hashes. D8 applies the same strict own-data boundary to caller review context, so hidden, symbol, Proxy, accessor, inherited, or media/device-shaped context is rejected before any review audit append. D9 permits the sole callable context field only as a non-Proxy local clock that returns a finite native `Date`; forged, invalid, or Proxy-shaped clock values fail before review audit append. D4/D5/D6/D7/D8/D9 use no storage lookup/write, quota, route, or capability grant; none proves a durable audit read or authorizes a handoff. Every digest remains an unkeyed mutation check, never authorization or delivery capability. An approved or rejected review never sends a handoff, command, notification, or publication. See [the camera contract](docs/GCL_CAMERA_CONTRACT.md).

No migration, camera connection, notification, action, or publication is part of this connector.

## Run and migrate

```bash
npm install
DATABASE_URL='your Neon URL' npm run db:migrate
DATABASE_URL='your Neon URL' SHARED_API_KEY_HEALTH='...' npm start
```

`npm test` runs the offline camera/GCL unit suite without a database or network. The existing Neon CRUD integration test is skipped unless `DATABASE_URL` is explicitly supplied; it creates records only under the temporary `sectrai-integration-test` product, verifies create → list → edit → a new Prisma connection → delete, and cleans those records up.

## Product adaptation guide

1. Add a strong `SHARED_API_KEY_<PRODUCT_SUFFIX>` value to Render. Example: `sectrai-health` → `SHARED_API_KEY_HEALTH`.
2. Add the same key to that product’s Vercel build environment as `VITE_SHARED_API_KEY_<PRODUCT_SUFFIX>` only for these owner-gated synthetic demos.
3. Map the product’s existing local object into `values`; retain its product-specific status in `status`. Use a stable workspace/module pair, for example `health-demo` / `operation-groups`.
4. Replace local `list/create/update/delete` calls with the generic routes above, preserving the product’s own response adapter shape.
5. Keep the local JSON server as a development fallback only if needed. The production client must fail visibly when the shared API is unreachable; never silently write in-memory data.
6. Verify live create → reload/list → edit → delete with the product’s key before enabling the next product.

## Safety boundary

The service stores only product-owned synthetic demo records. It does not make AI calls, execute product actions, or interpret `values`. Product-level Vercel admin gates remain the outer authentication layer; this API key is a second product boundary, not a replacement for user authentication.
