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

## Interpreter GCL (synthetic-only)

The interpreter module is a fail-closed contract for owner-supplied synthetic
translation fixtures. It has no translation provider, HTTP client, credential,
or `*_LIVE_ENABLED` setting.

- `translation-text-synthetic` returns only the explicitly supplied synthetic text-translation fixture.
- `translation-speech-synthetic` accepts a synthetic audio descriptor plus an explicitly supplied fixture and returns only a deterministic `synthetic://` audio reference—never audio bytes.
- Both require the product key, owner token, owner actor, matching scope, positive cost cap, daily quota, and `GCL_TRANSLATION_LIVE_DISABLED=true`.
- `GCL_TRANSLATION_LIVE_ENABLED` is intentionally unsupported: if it exists at all, the connector is unavailable. A quota rejection after a request audit is recorded as a stable failure code; neither path reaches a provider or adapter fallback.
- Successful runs create metadata-only proposals, bound to the successful run's maker, quota context, and safe hash-only envelope. The maker cannot approve or reject their own proposal; a distinct checker must echo the returned review digest before its configured review TTL expires. Approval never permits publication.
- Durable proposal creation and checker decisions are each one transaction with their audit append; no audit-less production artifact mutation API exists. Blank actors and malformed status/maker storage envelopes fail closed.
- Durable artifact reads and decisions also require a complete, ordered run → creation → optional single-decision audit lifecycle; metadata-shaped rows without that proof are unavailable.
- Terminal decisions are bound to a distinct checker and one canonical timestamp shared by the artifact row and its audit event; malformed decision-audit context fails before any durable mutation.
- Hash-valid durable lifecycles must also be temporally consistent and within the review TTL; backdated or post-expiry audit decisions fail closed.

See [the interpreter contract](docs/GCL_TRANSLATION_CONTRACT.md) for the exact shapes and safety boundary.
