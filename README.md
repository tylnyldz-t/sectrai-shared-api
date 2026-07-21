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

## GM2 Vision / OCR connector

`POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/vision-ocr/runs` is an owner-gated, synthetic-only document/receipt/identity scan contract. It requires the product key plus `X-Sectrai-Owner-Token` and `X-Sectrai-Owner-Actor`; the request body is bounded to:

```json
{
  "input": { "synthetic": true, "documentType": "identity", "fixtureId": "synthetic-identity-001" },
  "scopes": ["vision:scan"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

The adapter has no HTTP client, provider credential, or raw-image input. It resolves only built-in synthetic fixture IDs, returns structured **masked** fields, and always reports `mode: "SYNTHETIC"` and `liveStatus: "LIVE_DISABLED"`. Any live opt-in, absent owner gate, missing cost/quota configuration, unknown fixture, or raw-image-shaped input fails closed. Identity numbers, names, birth dates, addresses, signatures, and document identifiers are masked before the result or audit provenance is constructed.

Every admitted run must be within the per-run cost ceiling and daily run/scan quota. It creates requested/succeeded/failed entries in a per-product/workspace SHA-256 audit chain. The normal record API cannot read or mutate the reserved `gcl-audit` and `gcl-usage` modules. A scan result is `OWNER_REVIEW_REQUIRED`, `NOT_PERSISTED`, and `NOT_PUBLISHED`; callers must create any evidence record through their own separately approved workflow.

## Run and migrate

```bash
npm install
DATABASE_URL='your Neon URL' npm run db:migrate
DATABASE_URL='your Neon URL' SHARED_API_KEY_HEALTH='...' npm start
```

With `DATABASE_URL` set, `npm test` also runs the real Neon integration test: it creates records only under the temporary `sectrai-integration-test` product, verifies create → list → edit → a new Prisma connection → delete, and cleans those records up. It is skipped when no database is configured.

The GM2 unit suite runs without a database or network: `node --import tsx test/gcl.vision.unit.test.ts`.

## Product adaptation guide

1. Add a strong `SHARED_API_KEY_<PRODUCT_SUFFIX>` value to Render. Example: `sectrai-health` → `SHARED_API_KEY_HEALTH`.
2. Add the same key to that product’s Vercel build environment as `VITE_SHARED_API_KEY_<PRODUCT_SUFFIX>` only for these owner-gated synthetic demos.
3. Map the product’s existing local object into `values`; retain its product-specific status in `status`. Use a stable workspace/module pair, for example `health-demo` / `operation-groups`.
4. Replace local `list/create/update/delete` calls with the generic routes above, preserving the product’s own response adapter shape.
5. Keep the local JSON server as a development fallback only if needed. The production client must fail visibly when the shared API is unreachable; never silently write in-memory data.
6. Verify live create → reload/list → edit → delete with the product’s key before enabling the next product.

## Safety boundary

The service stores only product-owned synthetic demo records. It does not make AI calls, execute product actions, or interpret `values`. Product-level Vercel admin gates remain the outer authentication layer; this API key is a second product boundary, not a replacement for user authentication.
