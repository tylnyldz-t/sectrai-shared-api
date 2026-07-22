# Sectrai Shared API

Shared, product-scoped persistence API for Sectrai synthetic demo products. It uses one Neon Postgres database and one Render web service. It never connects to Sektral, Xontainer, Yapıborsası, or any other database.

It also contains the L0 Governed Connector Layer (GCL) foundation. GCL starts disabled and is fail-closed until its owner gate, quotas, and a connector’s deployment configuration exist. See [the GCL contract](docs/GCL_CONTRACT.md) and [the synthetic market contract](docs/GCL_MARKET_CONTRACT.md).

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

`npm test` includes offline GCL contract tests. When `DATABASE_URL` is set, it additionally runs the real Neon integration test: it creates records only under the temporary `sectrai-integration-test` product, verifies create → list → edit → a new Prisma connection → delete, and cleans those records up.

## Product adaptation guide

1. Add a strong `SHARED_API_KEY_<PRODUCT_SUFFIX>` value to Render. Example: `sectrai-health` → `SHARED_API_KEY_HEALTH`.
2. Add the same key to that product’s Vercel build environment as `VITE_SHARED_API_KEY_<PRODUCT_SUFFIX>` only for these owner-gated synthetic demos.
3. Map the product’s existing local object into `values`; retain its product-specific status in `status`. Use a stable workspace/module pair, for example `health-demo` / `operation-groups`.
4. Replace local `list/create/update/delete` calls with the generic routes above, preserving the product’s own response adapter shape.
5. Keep the local JSON server as a development fallback only if needed. The production client must fail visibly when the shared API is unreachable; never silently write in-memory data.
6. Verify live create → reload/list → edit → delete with the product’s key before enabling the next product.

## Safety boundary

The service stores only product-owned synthetic demo records. It does not make AI calls, execute product actions, or interpret `values`. Product-level Vercel admin gates remain the outer authentication layer; this API key is a second product boundary, not a replacement for user authentication.

The GCL `market` connector is proposal-only. It accepts no provider
credentials, does not query Hub Connect or any capacity market, and cannot
reserve capacity, book a load, publish a listing, or start a background sync.
It remains `LIVE_DISABLED`; only the exact `GCL_MARKET_LIVE_ENABLED=false`
configuration permits the synthetic proposal path. D1 returns a
digest-bound, canonically validated independent-review packet; its receipt is
always `NOT_AUTHORIZED` and cannot authorize any action. D2 can place exactly
one such receipt in an injected process-local synthetic ledger; it is neither
durable nor an HTTP workflow, and it cannot authorize an action after a
restart or in another process. D3 canonically reconstructs a caller-held D2
receipt against its original plan without reading storage or writing audit,
quota, or ledger state; it is only a local mutation check, never a signature,
credential, approval workflow, or execution path. D4 can additionally compare
that receipt with one caller-held audit event and predecessor hash by
recomputing its single SHA-256 chain link. It performs no storage lookup or
write, does not prove durable audit retention or complete-chain integrity, and
cannot authorize any action. D5 can only read-check a caller-held
`requested → succeeded → owner_reviewed` segment, including its two internal
links and canonical run semantics. It returns fixed `NOT_AUTHORIZED` evidence
only, does not prove durable storage or a predecessor, and cannot authorize any
action. D6 can derive and recheck only a minimized, digest-bound rendering of
that same caller-held D5 segment. It performs no storage lookup or write and
remains unkeyed mutation evidence, never a signature, credential, authorization,
or execution capability. D7 can bind independently rebuilt D3 and D6 evidence
into an even smaller, digest-only no-action manifest; it omits request, actor,
decision, and audit-hash data, reads and writes no storage, and remains neither
a signature, credential, authorization, nor execution capability. D8 accepts
only exact own-data records/results at the injected D2 terminal-ledger seam;
accessor-, Proxy-, inherited-, hidden-, and symbol-shaped values fail closed.
A malformed audit append leaves that process-local tuple undecided for a later
retry, never creating an action or durable approval. D9 snapshots every
caller-held review-plan branch into bounded own data before semantic review and
checks host-ledger members/results by descriptor before a receipt can be built;
shaped plans and ledger results remain fail-closed and cannot authorize any
action. D10 applies the same descriptor-based boundary to the review context:
its scope array is copied as bounded own data and its clock is a one-call host
seam whose intrinsic `Date` value is copied. Shaped context/clock values fail
closed and cannot change the already-snapshotted review scope or authorize an
action. D11 requires the primitive boolean `true` at the governed runner,
direct market-run, and independent-review owner gates; truthy lookalikes fail
before context, clock, ledger, audit, or quota seams and cannot authorize an
action. D12 snapshots the governed-run request envelope and scope strings as
exact own data before connector preflight, audit, or quota; accessor-, Proxy-,
inherited-, hidden-, symbol-, sparse-, and extra credential-shaped fields fail
closed. The market input itself remains bounded synthetic data for its own
parser, never a credential or live action. D13 preserves that parser's
canonical preflight copy across the runner's asynchronous audit, quota, and
run seams, so a caller cannot mutate the original input into a different
proposal or provider-shaped request after ingress. D14 also copies the
connector's exact scalar configuration at construction, so a caller cannot
flip its live gate, limit, or inject a credential-shaped field after
preflight; malformed configuration remains unavailable before audit or quota.
D15 fixes the governed runner's audit/quota data-function members at
construction, requires exact SHA-256 audit results, and copies one verified
clock instant before market preflight, audit, or quota; malformed host seams
fail closed and cannot create a successful market result. D16 applies an
exact own-data snapshot to direct `market.preflight`/`market.run` contexts and
copies their sole clock result before plan construction; shaped contexts and
invalid times fail closed and cannot alter a synthetic plan. D17 fixes the
selected synthetic connector instance: its private configuration, own
preflight/run functions, and market scope tuple cannot be replaced while
governed audit or quota work is pending. D18 freezes every branch of the
emitted synthetic plan—including its request, binding, sources, quote,
side-effect, owner-review, and review-packet objects—before it crosses the
caller boundary. A caller must make a separate copy to propose a change, and
the canonical review validator rejects action or credential-shaped drift in
that copy; neither form can authorize an action. D19 applies the same
immutable egress boundary to canonical review results and all D3–D7 evidence:
the review receipt, audit witness/event, audit-trail witness/receipt, and
evidence manifest can neither acquire action/provider fields in place nor
authorize an action. Any simulated change needs a separate fail-closed copy.
D20 seals the direct preflight output and direct/governed connector result and
provenance branches after audit enrichment, so in-place provider, instruction,
confidence, or result replacement cannot change their data-only, no-action
meaning. A changed copy still must pass the bounded parser and canonical
review, and cannot authorize an action. D21 rejects a shaped, forged, or
credential/provider-shaped connector result before its succeeded audit,
snapshots exact result/provenance metadata before that asynchronous seam, and
freezes the copied final egress. The connector cannot supply the audit hash or
relabel the returned market result while the local success audit is pending;
data and request values remain synthetic, data-only, and `LIVE_DISABLED`. D22
freezes the bounded registry-visible connector control plane (ID, auth/quota
metadata, scopes, and preflight/run references) at construction. Shaped or
credential/provider-shaped registration fails before any audit, quota, or
connector seam; later mutation cannot retarget a synthetic, `LIVE_DISABLED`
run or authorize an action.
