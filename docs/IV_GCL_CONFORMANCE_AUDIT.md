# IV GCL connector conformance audit

Audit date: 2026-07-22.  This is a source and fixture audit only.  It used
local Git object archives and deterministic in-process fixtures.  No real
credential was loaded, no live provider was enabled, and no network, prod, or
`main` write was made.

## Required envelope

For a governed connector, the following are required:

1. a denied owner approval must reach neither quota nor adapter;
2. an accepted run must reserve quota and append a `requested` then
   `succeeded` hash-chain audit event;
3. a quota rejection after `requested` must append a linked `failed` audit
   event; and
4. this IV scope must be synthetic and fail closed with `LIVE_DISABLED`.

Preflight rejections intentionally occur before quota and audit reservation.

## Fixture evidence

Audited source revisions: GM1 `77b4bed`, GM2 `c30a84c`, GM3 `cac892f`, GM4
`ca75503`, GM5 `2adc8fc`, GM6 `54ebdf8`, ARGlass `5e8c2dd`, and GCL L0
`1dbf1af`.

The existing branch-local unit fixtures ran successfully: GM1 voice (4), GM2
vision (7), GM3 image (7), GM4 video (5), GM5 3D (6), GM6 game engine (4),
and ARGlass (4): 37 passing tests.

An additional local-only Apify fixture constructed the connector without
`liveEnabled`, token, or actor id, injected a fetch counter, and verified
`APIFY_CONNECTOR_NOT_CONFIGURED` with zero requests.

A synthetic connector plus a rejecting in-memory quota was then run through
each governed runner.  Its audit sequence was:

| Connector | Owner gate | Accepted-run quota/audit | Quota-rejection audit | Strict `LIVE_DISABLED` | Result |
| --- | --- | --- | --- | --- | --- |
| GM1 voice STT/TTS | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM2 vision/OCR | Pass | Pass | `requested`, `failed` | Pass | Conformant |
| GM3 image TTI | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM4 video | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM5 text/image-to-3D | Pass | Pass | `requested` only | Pass | Nonconformant |
| GM6 game engine | Pass | Pass | `requested` only | Pass | Nonconformant |
| ARGlass device session | Local input gate only | No GCL quota | `NOT_PERSISTED` | Pass | Nonconformant as a GCL connector |
| GCL Apify pilot | Pass | Pass | `requested` only | Default only; a live opt-in code path exists | Nonconformant |

The live-disabled fixture does **not** exercise Apify's live opt-in path.  The
source audit records that path as a strict-mode violation even though the
default environment setting is fail closed.

## Blocking remediation

Do not certify the listed nonconformant connectors for IV GCL until all of the
following are complete in their owning branches:

1. Move quota reservation inside `GovernedConnectorRunner`'s `try` block (or
   otherwise append `connector.run.failed` on quota rejection) for GM1,
   GM3–GM6, and Apify.  Preserve the original `requestedAuditHash` link.
2. Add a rejecting-quota fixture to every affected connector and require the
   exact `requested`, `failed` chain order.
3. Either route ARGlass through the common owner/quota/hash-audit envelope, or
   classify it as a non-GCL local contract and stop presenting it as a GCL
   connector.
4. For this synthetic IV scope, remove or hard-deny Apify's live opt-in path;
   an unset default is insufficient for the required permanent
   `LIVE_DISABLED` boundary.

## Scope boundary

This audit intentionally did not alter production configuration, credentials,
providers, databases, or any `main`/prod target.  It establishes the current
conformance state and the exact blockers; it is not live-provider approval.

## D1 — next connector package

This follow-up audited the local, immutable Git snapshots for the next
package: RA voice `80a1cc6`, RA OCR `f6f28d7`, RA image `4d0806b`, RA
3D/game `7e5b947`, RA market `1b53141`, RFID `7b14d54`, translation
`43541af`, language education `2635230`, and camera `0c166df`.

The audit fixture is deliberately source-only.  It reads each connector and
runner with local `git show <pinned-commit>:<path>`, then verifies its Git blob
hash; it never reads the mutable sibling worktree file.  It does not import a
connector, read an `.env` file, contact a provider, or open a network socket.
Run it with:

```bash
npm run test:conformance
```

It is fail-closed: if an audited local repository, commit, source object, or
recorded blob is absent or mismatched, the fixture fails rather than treating
the source as conformant.  A sibling worktree can therefore legitimately move
on to other work without changing this archived D1 evidence.  The target
packages' own synthetic unit suites were also run with Node's `tsx` loader;
their database integration tests were intentionally not run because they
require `DATABASE_URL` and are outside this source-only audit.

| Connector | Snapshot safety boundary | Owner/preflight | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D1 result |
| --- | --- | --- | --- | --- | --- |
| RA voice | synthetic descriptors only; no client or provider URL | Pass | `requested` only | Pass | Nonconformant |
| RA OCR | masked synthetic evidence only; no raw image/client | Pass | `requested` only | Pass | Nonconformant |
| RA image | synthetic review candidate; no Comfy dispatch | Pass | `requested` only | Pass | Nonconformant |
| RA 3D/game | contract-only JNC hand-off; no transport/process launch | Pass | `requested` only | Pass | Nonconformant |
| RA market | proposal-only; a true live flag is hard-denied | Pass | `requested` only | Pass | Nonconformant |
| RFID | PSMS-TAG-SIM only; no reader, tag, or network input | Pass | `requested` only | Pass | Nonconformant |
| Translation | synthetic text/audio references only | Pass | `requested` only | Pass | Nonconformant |
| Language education | family-safe synthetic references; no audio or learner profile | Pass | `requested` only | Pass | Nonconformant |
| Camera | consent-bound fixtures; no media/device/identity path | Pass, including maker–checker denial | `requested`, `failed` | Pass; a true live flag is hard-denied | Conformant |

### D1 negative and edge evidence

- The fixture follows the local `src/gcl` import closure of each connector
  and runner.  It asserts `LIVE_DISABLED`, no HTTP/egress primitive or provider
  endpoint, no credential-like environment name, no subprocess/worker-launch
  primitive, and no automatic-publication flag.  The SVG XML namespace is
  explicitly excluded from the endpoint check because it is data syntax, not
  a network target.
- The only two `*_LIVE_ENABLED` environment surfaces (market and camera)
  immediately reject a true value.  All other snapshots expose no such
  environment surface.
- The owner-denial edge is checked before preflight, requested-audit
  reservation, and quota reservation in every pinned runner.  This confirms
  a rejected owner cannot reach an adapter or consume quota; it does not infer
  an owner decision from a fixture.
- The quota-rejection edge is intentionally tested as an audit classification:
  a runner is conformant only when `await quota.consume(...)` is inside the
  `try` whose `catch` appends a `connector.run.failed` event linked by
  `requestedAuditHash`, after the `requested` event.  The first eight D1
  runners put quota consumption before that `try`; camera puts it inside.
  This prevents the report from claiming a failed event that the source
  cannot append.
- Existing package tests cover their local input/preflight boundaries.  In
  particular, camera's unit suite covers revoked/mismatched consent,
  maker–checker self-approval, an unknown connector, a true live flag, and a
  quota rejection.  No test used a credential, real provider, real device,
  migration, production database, or send/publish operation.

### D1 remediation and ADOS boundary

The first eight packages must move quota reservation into the protected
`try` (or append an equivalent linked `connector.run.failed` event) and add a
behavioural rejecting-quota fixture before GCL certification.  The original
Apify L0 live opt-in remains a separate blocker from the first package.

This D1 work keeps the ten ADOS rules intact: product data planes are not
joined; missing gates deny by default; only source pointers/blob hashes cross
the audit boundary; no owner decision is inferred; camera alone proves the
maker–checker edge; audit-chain gaps are reported rather than hidden; no
migration is introduced; all outputs remain proposal-only; no JARVIS job is
started; and synthetic testing is not a launch decision.

## D2 — next committed connector package

This follow-up is again a source-only audit.  It pins the next committed
connector package, rather than observing a sibling worktree: RA OCR
`b8d9505`, RA image `ee498bf`, RA 3D/game `e896365`, RA market `e20e176`,
RFID `14f069a`, translation `eff19c3`, and camera `9a3841a`.  Voice and
language-education had no subsequent committed connector/runner package, so
they remain D1 evidence; a language-education cleanup-only commit is not
treated as a new connector audit.

The fixture reads each named Git object with `git show`, checks the connector
and runner blob IDs, and follows only its local `src/gcl` import closure.  It
does not read mutable target source, import a connector, load an environment
file, start a worker, open a socket, or contact a provider.  Missing local
repositories, commits, paths, or blob mismatches fail the audit.  Run the
complete D1/D2 fixture with:

```bash
npm run test:conformance
```

| Connector | D2 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D2 result |
| --- | --- | --- | --- | --- |
| RA OCR | Synthetic document review packet and independent-review validation | `requested` only | Pass | Nonconformant |
| RA image | Synthetic image-review ledger closure | `requested` only | Pass | Nonconformant |
| RA 3D/game | JNC contract test/documentation package | `requested` only | Pass | Nonconformant |
| RA market | Literal `false` is now required; absent, malformed, and true live settings deny | `requested` only | Pass | Nonconformant |
| RFID | `quota.consume` is inside the protected lifecycle; failure detail forwards `requestedAudit.hash` | `requested`, `failed` | Pass | Conformant |
| Translation | Latest committed artifact-contract package (connector blob is unchanged) | `requested` only | Pass | Nonconformant |
| Camera | ADOS control evidence and synthetic review hardening | `requested`, `failed` | Pass | Conformant |

`Conformant` in this table means only that the immutable source meets this IV
synthetic GCL envelope.  It is neither live-provider approval nor permission
to connect a device, run a JARVIS/JNC job, write production data, publish, or
send an output.

### D2 negative and edge evidence

- The closure check now permits only local GCL files and the non-transport
  `node:crypto` module.  A static import of a runtime/transport module fails.
- Dynamic `import(...)`, CommonJS `require(...)`/`module.require(...)`, and
  `createRequire(...)` fail.  This closes a dependency-loading bypass that a
  direct egress-call scan alone would miss.
- Direct egress primitives remain denied; `globalThis['fetch']` (and the
  equivalent XMLHttpRequest/WebSocket client lookup) is now also an explicit
  negative probe.  Bracket-style credential reads such as
  `process.env['SYNTHETIC_API_KEY']` likewise fail.
- The source classifier recognizes both direct failure links and a local
  helper that receives `requestedAudit.hash` and emits `requestedAuditHash`.
  This records RFID's protected quota failure accurately without claiming the
  same behaviour for runners that reserve quota before `try`.
- Owner denial is still required before preflight, requested-audit append, or
  quota reservation.  The static check accepts the equivalent strict form
  `ownerApproved !== true`; it does not infer an approval from fixtures.

### D2 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still need their quota
reservation inside the protected `try` (or an equivalent linked failed-audit
path) plus behavioural rejecting-quota tests before GCL certification.  The
D1 Apify live-opt-in blocker is unchanged and remains outside this D2 package.

All ten ADOS rules remain in force: no product data-plane join; default-deny
gates (including RA market's strict-false setting); source/blob pointers only
across the audit boundary; no inferred owner decision; maker–checker retained
for camera; audit gaps reported; no migration; proposal-only output; no JARVIS
or JNC launch; and a synthetic source test is not a deployment decision.

## D3 — next committed connector package

D3 pins the next committed package after D2: RA OCR `27e4828`, RA image
`6c13d06`, RA 3D/game `55df54f`, RA market `3f4aae8`, RFID `275cef6`,
translation `32cf3d0`, language education `3492a3b`, and camera `dd36dfe`.
Voice has no new committed connector package and remains D1 evidence.  As in
the prior batches, this is a local Git-object audit only: the fixture reads
`git show <pinned-commit>:<path>`, verifies both connector and runner blob
hashes, and follows only the local `src/gcl` import closure.  It neither
imports target runtime code nor reads an environment file, opens a socket,
starts a process, loads a credential, sends output, runs a migration, or writes
to `main` or production.

Run the full immutable D1/D2/D3 source audit with:

```bash
npm run test:conformance
```

| Connector | D3 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D3 result |
| --- | --- | --- | --- | --- |
| RA OCR | Integrity-bound, maximum one-day independent-review window | `requested` only | Pass | Nonconformant |
| RA image | Plain-data input validation and canonical candidate-issuance ledger | `requested` only | Pass | Nonconformant |
| RA 3D/game | Immutable synthetic review snapshot bound to the JNC contract plan | `requested` only | Pass | Nonconformant |
| RA market | Append-only synthetic market-review ledger; literal-false live setting remains required | `requested` only | Pass | Nonconformant |
| RFID | Documentation and rejecting-quota fixture refresh; D2 connector/runner blobs remain unchanged | `requested`, `failed` | Pass | Conformant |
| Translation | Bounded, hash-bound synthetic translation artifact contract and safety checks | `requested` only | Pass | Nonconformant |
| Language education | Protected quota reservation and linked, stable failure audit code | `requested`, `failed` | Pass | Conformant |
| Camera | Plain-record input/consent hardening; synthetic review remains maker–checker bound | `requested`, `failed` | Pass | Conformant |

`Conformant` remains narrowly scoped to the IV synthetic governance envelope.
It does not authorize a provider, device, audio/media capture, JNC/JARVIS
launch, publication, handoff, production write, or real-world send.

### D3 negative and edge evidence

- The source-only negative probes now reject optional-chain and reflective
  egress lookups (`globalThis?.fetch` and `Reflect.get(globalThis, 'fetch')`),
  as well as the original bracketed client lookup.  This prevents a direct-call
  scanner from overlooking a stored transport capability.
- Dynamic module/evaluation bypasses now fail for commented dynamic import,
  `module?.require(...)`, and `Function(...)`, in addition to ordinary
  `import(...)` and `require(...)`.  A non-local static import remains denied
  unless it is the explicitly non-transport `node:crypto` module.
- Credential-like environment reads fail for both `process.env['…TOKEN']` and
  `process['env']?.['…TOKEN']`.  The fixture also proves a relative import that
  leaves `src/gcl` is an audit error rather than a permitted local dependency.
- The quota classification remains intentionally conservative.  RA OCR, image,
  3D/game, market, and translation reserve quota before the protected `try`,
  so their source cannot prove a linked failed event for a quota denial.  RFID,
  language education, and camera reserve quota within that protected lifecycle
  and link `requestedAuditHash` to `connector.run.failed`.

### D3 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still require protected quota
reservation (or an equivalent linked failed-audit path) and a behavioural
rejecting-quota fixture before certification.  The historical D1 Apify live
opt-in blocker also remains unresolved and outside the D3 package.

All ten ADOS rules remain intact: no product data-plane join; default-deny
configuration; immutable source/blob pointers only; no inferred owner decision;
camera maker–checker retained; audit gaps reported instead of filled in; no
migration; proposal-only outputs; no JARVIS/JNC launch; and synthetic test
evidence is never a deployment or live-enable decision.

## D4 — next committed connector package

D4 pins the next committed package after D3: RA OCR `1a16536`, RA image
`3e4c5cf`, RA 3D/game `e850715`, RA market `6ab0345`, RFID `ee3627a`,
translation `18a6188`, language education `5a16014`, and camera `1102d32`.
Voice has no later committed connector package and remains D1 evidence. This
is again an immutable local Git-object audit: the fixture resolves each
commit, checks its connector and governance-runner blob hashes, then reads the
connector/runner local `src/gcl` import closure through `git show`. It never
imports a target connector or reads a mutable target worktree. In particular,
the RFID worktree has later uncommitted changes; D4 is fixed to `ee3627a` and
is unaffected by them.

The only permitted non-local closure modules are `node:crypto` and
`node:util`. The latter occurs in the D4 camera source only for in-process
proxy rejection; it is not a transport, device, or provider capability. A
missing repository, revision, blob, import-closure object, or any hash
mismatch fails the audit. Run the complete immutable audit with:

```bash
npm run test:conformance
```

| Connector | D4 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D4 result |
| --- | --- | --- | --- | --- |
| RA OCR | Review packet v4 binds synthetic evidence capture/expiry; preflight and review reject stale, inconsistent, or overlong evidence windows | `requested` only | Pass | Nonconformant |
| RA image | Candidate issuance now requires the matching governed `connector.run.succeeded` audit hash and retains redacted issuance lineage before independent review | `requested` only | Pass | Nonconformant |
| RA 3D/game | Optional style/GPU fields are omitted rather than serialized as `undefined` in the immutable synthetic-plan shape | `requested` only | Pass | Nonconformant |
| RA market | A hash-bound, scope-bound independent-review receipt revalidates `NOT_AUTHORIZED` execution controls; literal-false live setting remains required | `requested` only | Pass | Nonconformant |
| RFID | Adds PSMS-SIM fixed anonymous aggregate-count fixtures and rejects accessor-shaped record/array fields; no reader, clock, sensor, identity, or individual event input exists | `requested`, `failed` | Pass | Conformant |
| Translation | Audit rows are schema-gated; artifact storage requires a same-scope requested→succeeded run link and failure audit keeps only a stable error code | `requested` only | Pass | Nonconformant |
| Language education | Adds a grammar-review fixture-reference connector and rejects symbol, accessor, inherited, and hidden input fields | `requested`, `failed` | Pass | Conformant |
| Camera | Rejects proxy, accessor, non-enumerable, symbol, and hidden input fields before consent/review parsing | `requested`, `failed` | Pass | Conformant |

`Conformant` remains deliberately narrow: it means the pinned source satisfies
the IV synthetic governance envelope only. It is not approval to configure a
provider, use an API key, capture a camera/RFID input, connect a device, launch
JARVIS/JNC, reserve/book/publish, write production data, or send an output.

### D4 negative and edge evidence

- Runtime-escape scanning now strips comments before inspection, then rejects
  every `globalThis`/`global`/`window` access and every retained direct egress
  identifier (`fetch`, `XMLHttpRequest`, `WebSocket`, `axios`, `undici`, and
  `node-fetch`). This also denies aliases such as `const request = fetch` or a
  computed global property such as `globalThis['fe' + 'tch']`.
- The fixture rejects computed environment access (`process['env']`, optional
  forms, and arbitrary computed names), direct or bracketed credential-like
  names, plus `Reflect.get`/bracketed `Reflect['get']` and
  `Object.getOwnPropertyDescriptor` attempts to recover a global or environment
  capability. The normal explicit synthetic limit settings remain allowed.
- Existing D3 checks remain: dynamic import/require/evaluation, non-local
  imports other than the two explicit in-process modules, endpoint literals,
  subprocess/worker primitives, automatic publication, and a relative import
  that escapes `src/gcl` all fail closed.
- Owner rejection remains statically required before connector preflight,
  requested-audit reservation, or quota consumption. The audit keeps the
  quota classification conservative: OCR, image, 3D/game, market, and
  translation consume quota before their protected `try`; RFID, language
  education, and camera consume it inside the lifecycle that appends a linked
  `connector.run.failed` event.
- The selected immutable D4 connector unit suites passed from temporary Git
  archives: OCR, image, 3D/game, both market suites, RFID, translation,
  language education, and camera (nine test files). Database integration,
  migration, and external-provider tests were not run.

### D4 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still need protected quota
reservation (or an equivalent linked failed-audit path) and a behavioural
rejecting-quota fixture before certification. The D1 Apify live-opt-in blocker
is unchanged and outside D4.

All ten ADOS rules remain enforced: product data planes are not joined;
inputs/outputs stay minimized and synthetic; missing configuration denies by
default; exact record validation blocks hidden data paths; owner and
maker–checker gates are retained; audit-chain gaps are reported rather than
invented; no migration is introduced; every artifact remains proposal-only;
no JARVIS/JNC job is launched; and source/test evidence is never a live-enable
or deployment decision. D4 loaded no credential, contacted no provider or
network endpoint, sent nothing, and made no `main`/prod write.

## D5 — next committed connector package

D5 pins the next immutable package after D4: RA OCR `1540e2e`, RA image
`e0bbd31`, RA 3D/game `1e3edc2`, RA market `d9a7677`, RFID `146539a`,
translation `cc63f92`, language education `f1dff88`, and camera `9228cd5`.
Voice has no later committed connector package and remains D1 evidence. The
fixture resolves each commit and validates the SHA-1 blob IDs of both the
connector and its governance runner before it reads their local `src/gcl`
closure with `git show`. It neither imports target runtime code nor consults a
mutable target worktree; uncommitted files in those worktrees cannot affect
this result.

D5 still permits only `node:crypto` and `node:util` as non-local **runtime**
modules. The image and market closures also contain `@prisma/client` solely as
erased TypeScript type imports in their local persistence/audit seams. The
fixture proves each such import is type-only and has a negative probe that
rejects a value import from the same package; it is not a database client
allowance or a transport exception. Missing worktree/object/closure files,
revision or blob mismatches, a non-local runtime import, egress primitive,
credential-like configuration read, subprocess, endpoint, publish flag, or
closure escape fails the audit.

Run the full immutable audit with:

```bash
npm run test:conformance
```

| Connector | D5 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D5 result |
| --- | --- | --- | --- | --- |
| RA OCR | v5 document-review packets reject causally inconsistent evidence-capture, issuance, consent-expiry, and evidence-expiry timelines before review audit | `requested` only | Pass | Nonconformant |
| RA image | Success audit binds the redacted candidate-set digest; issuance and later proof revalidate the complete ordered audit chain | `requested` only | Pass | Nonconformant |
| RA 3D/game | Exact frozen run contexts and a post-adapter synthetic result boundary reject altered result/provenance/snapshot fields before success audit serialization | `requested` only | Pass | Nonconformant |
| RA market | The local, no-action market receipt/witness path rechecks exact caller-held audit-event/hash bindings without storage lookup or execution | `requested` only | Pass | Nonconformant |
| RFID | Adds fixed anonymous coarse class-mix fixtures while rejecting real timing, speed, sensor, identifier, raw-count, and individual-event fields | `requested`, `failed` | Pass | Conformant |
| Translation | Exact-schema audit rows and a maker/envelope-bound requested→succeeded artifact link reject legacy, malformed, replayed, or cross-scope metadata | `requested` only | Pass | Nonconformant |
| Language education | Adds writing/listening fixture-reference proposals with no draft text, feedback, transcript, audio, score, or learner profile; any live-enable variable poisons the factory closed | `requested`, `failed` | Pass | Conformant |
| Camera | A caller-held review-audit witness is exact-shape/hash checked and minimized to a fixed no-action result | `requested`, `failed` | Pass | Conformant |

`Conformant` remains deliberately narrow: the pinned source meets this IV
synthetic governance envelope only. It does not authorize a provider, API key,
database operation, camera/RFID device, media input, JARVIS/JNC launch,
reservation, booking, publication, handoff, production write, or send.

### D5 negative and edge evidence

- The fail-closed scanner now rejects optional reflective capability recovery
  (`Reflect?.get` and `Reflect?.['get']`) as well as optional/bracketed
  `Object.getOwnPropertyDescriptor(s)` access to a global or environment
  object. A stored `fetch` capability cannot evade the global/egress rule by
  changing only the reflective syntax.
- Computed `process.env` reads, including optional-chain and concatenated key
  forms such as `process.env?.['SYNTHETIC_' + 'TOKEN']`, are rejected. Ordinary
  direct synthetic limit settings remain supported; the test fixes that
  distinction with an allowed configuration probe rather than weakening the
  credential boundary.
- The D5 type-only exception is itself fail closed: a type import from
  `@prisma/client` may be scanned as part of the local source closure, while a
  runtime/value import from it fails. This keeps the audit's runtime boundary
  closed without hiding local persistence type definitions from source review.
- The immutable source audit and the selected connector unit suites passed from
  temporary Git archives at the exact D5 commits: OCR, image, 3D/game, both
  market suites, RFID, both translation suites, language education, and camera
  (ten test files). No integration/database test, migration, external-provider
  test, credential, network call, device access, or send was run.

### D5 remediation and ADOS boundary

RA OCR, image, 3D/game, market, and translation still consume quota before the
protected lifecycle that appends `connector.run.failed`; they require protected
quota reservation (or an equivalent linked failure-audit path) plus a
behavioural rejecting-quota fixture before certification. The historical D1
Apify live-opt-in blocker remains unchanged and outside this source package.

All ten ADOS rules remain enforced: no product data-plane join; synthetic,
minimized inputs and proposal-only outputs; default-deny configuration;
owner/maker–checker checks where applicable; audit gaps reported rather than
invented; no migration; no publication, reservation, booking, handoff, or
action; no JARVIS/JNC launch; and no test result is a deployment or live-enable
decision. D5 performed only local immutable Git-object reads and unit tests;
it loaded no credential, contacted no provider or network endpoint, sent
nothing, and made no `main`/production write.

## D6 — next committed connector package

D6 pins the next immutable package after D5: RA OCR `4b2f349`, RA image
`23de86d`, RA 3D/game `ee6a69b`, RA market `619c34c`, RFID `9ea5603`,
translation `00ab942`, language education `4b6170b`, and camera `295dc3e`.
Voice has no later committed connector package and remains D1 evidence. This
remains a source-only audit: every target file is read as
`git show <pinned-commit>:<path>` and its Git blob is re-derived locally.
The fixture neither imports target runtime code nor reads environment files or
mutable sibling worktree content. This matters for D6 because OCR's sibling
documentation and camera's source/test worktree have later uncommitted edits;
they cannot affect the recorded result.

The fixture pins the connector and `src/gcl/registry.ts` blob for every D6
entry. RA 3D/game's public connector and runner blobs are deliberately
unchanged from D5, but its audited local closure changed; D6 additionally
pins `src/gcl/result-boundary.ts` (`85c33bd53000820ba7399457dd22af0b4d509c75`)
and fails if it is not actually reachable in that closure. This prevents a
changed policy boundary from being presented as unchanged merely because its
entrypoint did not move.

Run the complete immutable audit with:

```bash
npm run test:conformance
```

| Connector | D6 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D6 result |
| --- | --- | --- | --- | --- |
| RA OCR | Review packet v7 binds a metadata-only, plain-own-data boundary; inherited, hidden, symbol, and accessor-backed packet data fail before review audit | `requested` only | Pass | Nonconformant |
| RA image | Candidate IDs and terminal owner decisions bind a bounded canonical review-expiry timestamp; issuance and decision at or after the deadline deny | `requested` only | Pass | Nonconformant |
| RA 3D/game | The closure-level final-result boundary now revalidates frozen synthetic artifact, GPU-card, JNC handoff, publication, pipeline, and provenance shapes against the review snapshot | `requested` only | Pass | Nonconformant |
| RA market | Caller-held three-event review trails exact-shape the owner-review audit entry before revalidating the no-action witness | `requested` only | Pass | Nonconformant |
| RFID | Adds a fixed anonymous data-boundary review: evidence input/ledger write, retention, secondary use, legal attestation, deployment, reader, clock, and network are all absent or denied | `requested`, `failed` | Pass | Conformant |
| Translation | A present live-enable key is a poison pill even when `false`; quota reservation moved inside the terminal audit lifecycle | `requested`, `failed` | Pass | Conformant |
| Language education | Adds speaking-practice fixture references only; audio, transcript, utterance, learner profile, assessment, and score inputs/outputs remain denied | `requested`, `failed` | Pass | Conformant |
| Camera | Produces an integrity-bound, minimized audit-trail receipt only after rechecking the caller-held requested/succeeded/review segment; it is no action capability | `requested`, `failed` | Pass | Conformant |

`Conformant` continues to mean only that the immutable source satisfies this
synthetic IV governance envelope. It is not approval to configure a provider,
use an API key, access a camera or RFID reader, process media, execute JNC or
JARVIS, reserve/book/publish/handoff, write production data, or send anything.

### D6 negative and edge evidence

- The source scanner now rejects Node's `process.getBuiltinModule`,
  `module.constructor._load`, and `require?.call` recovery paths. It also
  rejects browser-side `self`, `navigator.sendBeacon`, `EventSource`, and
  `WebTransport`, so the no-egress boundary does not depend on catching only
  `fetch` or `WebSocket`.
- Translation's classification changed only because the pinned runner places
  `quota.consume` inside the same protected `try` that emits the linked
  `connector.run.failed` event. This is a source classification, not an
  inferred successful quota-rejection fixture.
- D6 preserves the owner-denial ordering check: a false/non-true owner gate
  must precede preflight, the requested audit, and quota reservation. It also
  preserves fail-closed import closure rules, credential-like environment
  read rejection, no endpoint/subprocess/publish surface, and literal
  `LIVE_DISABLED` evidence.
- The exact D6 package unit suites were run only from temporary Git archives:
  OCR, image, 3D/game, both market suites, RFID, both translation suites,
  language education, and camera. No integration/database test, migration,
  credential, provider/network/device call, or send/publish operation was run.

### D6 remediation and ADOS boundary

RA OCR, image, 3D/game, and market still reserve quota before the protected
lifecycle that appends `connector.run.failed`; they require protected quota
reservation (or an equivalent linked failure path) plus behavioural
rejecting-quota tests before GCL certification. The historical D1 Apify
live-opt-in blocker remains separate and unresolved.

All ten ADOS rules remain intact: no product data-plane join; default-deny
configuration; immutable source/blob pointers only across the audit boundary;
no inferred owner decision; maker–checker where applicable; audit gaps
reported rather than invented; no migration; proposal-only outputs; no
JARVIS/JNC launch; and synthetic test evidence is never a deployment or
live-enable decision. D6 performs local immutable Git-object reads and
in-process tests only: no credential load, provider/network/device access,
send, `main` write, or production write.

## D7 — next committed connector package

D7 pins the next committed package after D6: RA OCR `62ed9eb`, RA 3D/game
`b7e68b9`, RA market `ee6209a`, RFID `a3ab022`, translation `c5ce740`, and
camera `f0a524c`. RA image and language education have no later committed
connector package, so their D6 evidence remains current; RA voice remains at
its D1 snapshot. This is still a local immutable Git-object audit: every
target source file is read with `git show <pinned-commit>:<path>` and checked
against its re-derived Git blob ID. Mutable sibling-worktree contents, local
environment files, credentials, sockets, providers, processes, migrations,
and production targets are not audit inputs.

D7 expands the package boundary when a public connector does not itself move.
RA 3D/game additionally roots `src/gcl/game-engine.ts`
(`2fcb35bda06524eb9c1f1c31f1c080eab1b59461`) in the audited local GCL
closure. Translation likewise roots its changed hash-chain audit module
(`5ed64f5eb137e69c614fab7632d3d5c80b43f6bb`) and artifact-storage module
(`57c9e99c98a932d0ae1c4efde03e2762126322e4`). These companion roots receive
the same import-closure, no-egress, no-credential, no-launch, and no-publish
checks as the connector and governed runner; they are not treated as an
execution path.

Run the complete D1–D7 immutable source audit with:

```bash
npm run test:conformance
```

| Connector | D7 source-only change/evidence | Quota-rejection lifecycle | Strict `LIVE_DISABLED` | D7 result |
| --- | --- | --- | --- | --- |
| RA OCR | v8 review packets bind ASCII-case-insensitive actor identity and reject a maker whose differently cased or trimmed identifier attempts independent review | `requested` only | Pass | Nonconformant |
| RA 3D/game | Both GM5/GM6 input boundaries and the governed runner copy only exact own-data fields; the game-engine companion and result boundary remain contract-only | `requested` only | Pass | Nonconformant |
| RA market | The no-action market review evidence is hardened without adding a quote, reservation, booking, publication, transport, or live opt-in | `requested` only | Pass | Nonconformant |
| RFID | Fixed non-simulation boundary fixtures reject private-site/owner claims, person or asset linkage, lawful-basis/signage/VERBIS assertions, legal input, pilot enablement, reader, and observed data | `requested`, `failed` | Pass | Conformant |
| Translation | Durable artifact reads and decisions replay the exact same-scope requested → succeeded → artifact → terminal-review audit lifecycle before returning or mutating metadata | `requested`, `failed` | Pass | Conformant |
| Camera | A compact D7 review-evidence manifest rechecks the D2 review receipt and D6 audit-trail receipt while omitting media, device, identity, decision text, and audit hashes | `requested`, `failed` | Pass | Conformant |

`Conformant` is limited to this immutable, synthetic IV GCL envelope. It does
not authorize a provider, credential, real OCR/media/RFID/camera input,
database integration, JNC/JARVIS launch, market operation, send, publication,
handoff, production write, or live enablement.

### D7 negative and edge evidence

- The owner-denial classifier now recognizes the D7 runner's copied
  `safeRequest.ownerApproved !== true` gate and still requires it before
  preflight, requested audit, and quota reservation. The copy is important:
  an accessor or inherited field cannot manufacture approval after validation.
- The fail-closed source scanner now rejects `process.binding`, `process.dlopen`,
  and `process.mainModule`, `import.meta`, and any Bun or Deno global. D7
  negative probes cover optional `process.binding`, import-meta resolution,
  `Bun.connect`, `Deno.connect`, and `Deno.serve`. Direct synthetic limit
  settings remain allowed, so the new rule does not weaken normal disabled-mode
  configuration.
- The scanner still rejects dynamic/evaluated module loading, built-in-module
  recovery, globals and reflection, browser egress capabilities, credential-like
  configuration reads, endpoints, subprocesses, auto-publication, non-local
  runtime imports, and imports escaping `src/gcl`.
- Quota classification remains deliberately conservative. RA OCR, 3D/game,
  and market reserve quota before the protected `try` that appends
  `connector.run.failed`; their source cannot prove a linked quota-denial audit.
  RFID, translation, and camera reserve inside the protected lifecycle.

### D7 test evidence and ADOS boundary

`npm run test:conformance` passes all D1–D7 pin, closure, disabled-mode,
owner-denial, quota-classification, and negative-source probes. Exact D7
commits were also archived to a temporary local directory before their selected
synthetic unit suites ran: OCR, 3D/game, both market suites, RFID, both
translation suites, and camera. Translation's HTTP safety suite uses its own
in-memory seams plus a temporary no-op `PrismaClient` module stub solely to
satisfy its erased/runtime type boundary; it receives neither a database URL
nor a real Prisma operation. No test used a credential, external provider,
device, migration, production database, send, publish, or `main`/production
write.

RA OCR, 3D/game, and market still require protected quota reservation (or an
equivalent linked failed-audit path) and behavioural rejecting-quota tests
before GCL certification. The historical D1 Apify live-opt-in blocker remains
separate and unresolved.

All ten ADOS rules remain enforced: no product data-plane join; default-deny
and `LIVE_DISABLED` configuration; immutable source/blob pointers only; no
inferred owner decision; maker–checker where applicable; no hidden audit gap;
no migration; proposal-only/no-action output; no JARVIS/JNC start; and no
synthetic test result is a deployment or live-enable decision. D7 makes only
local Git-object reads and synthetic test executions; it adds no provider,
credential, real-world input, device connection, delivery, or production mutation.
