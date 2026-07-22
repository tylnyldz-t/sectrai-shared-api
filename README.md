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

D2 additionally limits a custom safety policy to a closed local `{ id, assess
}` capsule, gives it a frozen data-only input snapshot without a policy-object
receiver, and returns frozen synthetic review snapshots. Those snapshots still
carry only local SVG/plan metadata and remain `LIVE_DISABLED` and publication
blocked; copying one does not bypass issuance or review fingerprint checks.

D3 keeps the conservative local baseline family gate non-bypassable: it runs
before any optional custom policy, so a permissive custom policy cannot admit a
baseline-rejected prompt or even receive it. The optional policy can only add a
stricter denial; it remains local, synchronous, `LIVE_DISABLED`, and never
authorizes a provider, network, dispatch, or publication path.

D4 binds each candidate's canonical review deadline and redacted fingerprint
into durable issuance and terminal-review receipts. Direct ledger calls
independently reject copied candidate-set digests, changed fingerprint/deadline
data, and issuance or decision at the exact expiry instant; all output remains
synthetic, owner-only, and publication-blocked.

D5 seals all candidate-issuance and terminal-review ledger inputs into private
data snapshots before an asynchronous persistence or audit seam can yield.
The direct receipt lookup validates and snapshots the candidate too, so a
mutable caller object or accessor cannot switch scope, fingerprint, deadline,
or terminal decision after validation. This is integrity hardening only:
`LIVE_DISABLED`, local SVG output, owner-only review, and publication blocking
remain unchanged.

D6 extends that sealing through the public terminal owner-decision helpers:
they copy and freeze the complete candidate before any candidate- or
review-ledger await, then return frozen liked-artifact or rejection snapshots.
Changing a caller-owned candidate while a ledger write is pending therefore
cannot turn a local SVG artifact into a provider URI, extend its review
deadline, or alter a terminal output. It remains synthetic, `LIVE_DISABLED`,
owner-only, and publication-blocked.

D7 additionally seals the validated candidate-issuance proof and freezes the
terminal review event before it reaches a review ledger. A retained mutable
proof cannot swap lineage hashes or deadlines while an append is pending, and
the ledger cannot change `publication: blocked` before its append/receipt
re-read. This remains local synthetic integrity hardening only: no provider,
network, dispatch, credential, migration, send, or publication capability is
added.

D8 likewise freezes the complete redacted candidate-issuance event before it
reaches a candidate ledger. A caller-owned result or custom ledger cannot
rewrite its source-run binding, candidate set, deadline, or blocked publication
state across an awaited append. It remains local SVG-only,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D9 rejects declared async, generator, and async-generator optional
family-safety callables while connector configuration is closed. Such a policy
is never invoked during preflight and cannot be accepted as an asynchronous
policy adapter; all output remains synthetic,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D10 rejects proxy-backed configuration, policy objects, policy callables, and
policy assessments before reflection can execute a proxy trap. This prevents a
policy seam from disguising behavior as ordinary data; rejection still occurs
before audit or quota reservation, and output remains local SVG-only,
`LIVE_DISABLED`, owner-only, and publication-blocked.

D11 extends that proxy-free boundary through direct candidate issuance,
terminal-review, ledger-method, test-audit, and stored-audit-record seams. A
proxy cannot run descriptor or method traps while a receipt or SHA-256 lineage
is being checked; it is rejected before a new audit event or receipt is
written. The module remains synthetic-only, `LIVE_DISABLED`, and publication
blocked.

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
