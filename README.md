# Sectrai Shared API

Shared, product-scoped persistence API for Sectrai synthetic demo products. It uses one Neon Postgres database and one Render web service. It never connects to Sektral, Xontainer, Yapıborsası, or any other database.

GM3 adds a synthetic-only text-to-image GCL contract. It emits local SVG
owner-review candidates and a redacted Jarvis Creative Worker ComfyUI/SDXL
plan shape only: `LIVE_DISABLED` is mandatory, no provider credential, graph
execution, Docker/loopback client, or network adapter exists, and a separate
owner checker plus a replay-protected terminal review ledger is required before
a still-unpublished liked artifact or a non-publishable rejection receipt can
exist. Terminal decisions are re-read as exact durable receipts and must bind
back to the same issued candidate and governed-run audit lineage before a
still-blocked artifact can be returned. Candidates have a bounded, digest-bound review deadline: expiry blocks
both issuance and any terminal decision, and the durable lineage cannot be
backdated; every chain event also has a canonical, monotonic UTC timestamp. A
successful governed run must first receive a durable, redacted
candidate-issuance receipt whose candidate-set digest is bound to the success
audit event; generic CRUD never exposes the reserved `gcl-*`
system records. The runner accepts only a closed owner-approved request
envelope (including no hidden own fields), validates its synthetic
result/provenance and an ordinary copied injected clock, and records only a
fixed failure code after reservation—never an adapter error message. The
connector snapshots only its documented configuration fields at construction:
hidden credential/endpoint fields, accessors, malformed policy seams, and
post-construction caller-object changes fail closed before preflight, audit, or
quota. The ledgers reuse existing Records and add no migration. See
[the GM3 contract](docs/GM3_IMAGE_TTI_CONTRACT.md).

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

## Run and migrate

```bash
npm install
DATABASE_URL='your Neon URL' npm run db:migrate
DATABASE_URL='your Neon URL' SHARED_API_KEY_HEALTH='...' npm start
```

`npm test` is a real Neon integration test. It creates records only under the temporary `sectrai-integration-test` product, verifies create → list → edit → a new Prisma connection → delete, and cleans those records up.

## Product adaptation guide

1. Add a strong `SHARED_API_KEY_<PRODUCT_SUFFIX>` value to Render. Example: `sectrai-health` → `SHARED_API_KEY_HEALTH`.
2. Add the same key to that product’s Vercel build environment as `VITE_SHARED_API_KEY_<PRODUCT_SUFFIX>` only for these owner-gated synthetic demos.
3. Map the product’s existing local object into `values`; retain its product-specific status in `status`. Use a stable workspace/module pair, for example `health-demo` / `operation-groups`.
4. Replace local `list/create/update/delete` calls with the generic routes above, preserving the product’s own response adapter shape.
5. Keep the local JSON server as a development fallback only if needed. The production client must fail visibly when the shared API is unreachable; never silently write in-memory data.
6. Verify live create → reload/list → edit → delete with the product’s key before enabling the next product.

## Safety boundary

The service stores only product-owned synthetic demo records. It does not make AI calls, execute product actions, or interpret `values`. Product-level Vercel admin gates remain the outer authentication layer; this API key is a second product boundary, not a replacement for user authentication.
