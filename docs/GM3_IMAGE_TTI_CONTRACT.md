# GM3 — Synthetic Text-to-Image Connector

`image-tti` is a GCL `media-generation` connector with only the
`image:generate` scope. It follows the *shape* of the Jarvis Creative Worker
image adapter: `creative-job-v1`, `local-comfyui`, `image`, `sdxl`, and the
ComfyUI node sequence `CheckpointLoaderSimple → CLIPTextEncode →
EmptyLatentImage → KSampler → VAEDecode → SaveImage`.

This implementation is deliberately synthetic. It produces local SVG
owner-review candidates plus a redacted structural plan. It has no credential,
provider URL, HTTP/fetch client, Docker client, loopback client, executable
Comfy graph, checkpoint resolution, or dispatch path. `LIVE_DISABLED` is the
only accepted mode.

## Gates and result lifecycle

1. `GovernedConnectorRunner` requires `ownerApproved`, bounded identity and
   correlation ID, an allowed scope, positive cost cap, and positive requested
   item count. Its public run request is an exact own-data envelope with only
   `connectorId`, `input`, `product`, `workspaceId`, `actor`, `correlationId`,
   `ownerApproved`, `scopes`, `costCapCents`, and `requestedItems`. Scope
   arrays must be dense, unique, bounded identifiers; extra fields (including
   non-enumerable own fields), accessors, a truthy non-boolean owner flag, or
   a caller-supplied clock are rejected before connector lookup, audit, or
   quota activity. The runner copies and validates its injected clock; it
   never takes audit time from a request.
2. `SyntheticImageTtiConnector` requires `GCL_IMAGE_LIVE_MODE=LIVE_DISABLED`,
   `GCL_IMAGE_MAX_COST_CENTS`, `GCL_IMAGE_MAX_ITEMS`, and
   `GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS`; missing or malformed limits reject the
   request. The review TTL is bounded from 60 seconds through 24 hours.
3. The included synchronous baseline family-safety filter always runs first in
   preflight before audit or quota reservation. An optional local
   `FamilySafetyFilter` runs only after that baseline accepts, and can only
   narrow the result; it cannot replace or override the baseline. The baseline
   is deliberately conservative and is not a production moderation policy.
4. The runner resolves connector, audit, and quota operations only from
   data-method descriptors, then appends request/success/failure events with a
   correlation ID to the per-workspace SHA-256 chain and reserves daily usage through
   `PrismaDailyConnectorQuota`. For `image-tti`, the success event contains
   only `syntheticCandidateSetDigest`: a SHA-256 fingerprint of candidate IDs
   and their redacted full-shape fingerprints. It contains no prompt, preview
   bytes, endpoint, checkpoint, or credential. Any failure after the request
   reservation writes only `CONNECTOR_RUN_FAILED`, never arbitrary adapter
   error text. A connector result is also a closed result/provenance envelope:
   its connector ID, canonical retrieval time, `data-only` content treatment,
   and finite `0..1` confidence are rechecked before a success audit or result
   response is produced.
5. The trusted host must then call
   `issueSyntheticImageCandidates(governedResult, candidateLedger, context)`.
   It accepts only a successful governed result with its success audit hash,
   recomputes the exact candidate-set digest from that result, and then stores
   one redacted, `publication: blocked` fingerprint-and-deadline receipt per candidate
   through `PrismaImageCandidateLedger`. A structurally valid candidate from a
   different run cannot borrow the success audit hash. Direct connector output
   is deliberately not issuable. An issuance at or after the candidate's
   canonical `reviewExpiresAt`, or one timestamped before the bound successful
   run, is rejected. This is an issuance/provenance and bounded-lifetime guard,
   not actor authentication; the host still
   authenticates the caller that records it.
6. Each candidate is `owner-only`, `pending`, and `publication: blocked`.
   It records its maker and originating product/workspace/correlation scope.
   Only a different owner checker may call
   `ownerLikeSyntheticImage(..., true, checker, reviewLedger, candidateLedger, context)`;
   self approval is denied. The candidate must have an exact, durable issuance
   receipt. The resulting artifact is still blocked from publication.
7. An independent checker may instead call
   `ownerRejectSyntheticImage(..., true, checker, reason, reviewLedger, candidateLedger, context)`.
   `reason` is a closed code (`NOT_SUITABLE`, `SAFETY_CONCERN`, or
   `NEEDS_REVISION`), so free-form owner text never enters the audit chain.
   A rejection returns a terminal review receipt, not an artifact URI or image
   preview, and remains `publication: blocked`. The supplied review ledger
   accepts exactly one terminal decision per product/workspace/correlation/
   candidate tuple. A terminal decision at or after `reviewExpiresAt` is
   rejected before the issuance proof or review-audit append. The terminal
   receipt also carries the exact redacted candidate fingerprint and durable
   deadline, so a direct ledger call cannot swap either field. A decision whose
   event time predates its durable issuance is also rejected.
8. A terminal action is not considered complete merely because
   `appendDecision` returned a hash. Both like and rejection re-read an exact
   `gcl-image-owner-review-v1` receipt through `assertRecorded`. That receipt
   must bind the terminal audit event to the same issued candidate, issuance
   audit hash, governed-run success hash, maker, scope, and ordered audit
   chain. Direct calls to the durable review ledger with an invented or orphan
   issuance hash fail before either a review receipt or audit event is written.

Before either terminal decision, the module fail-closes unless the candidate
has the exact local SVG preview, synthetic URI, non-executable plan shape,
digest linkage, bounded candidate index, pending owner-review state, and
matching source scope that the synthetic adapter emits. The candidate ID binds
those redacted fields, preventing an accidental scope/actor/preview mix-up;
it is an integrity check, not an authentication signature. Its full redacted
shape must additionally match a prior candidate receipt tied to the governed
run success audit hash and its candidate-set digest. Cross-workspace or
correlation review, altered preview, URI, safety metadata, or plan, an
unissued or expired candidate, a changed `reviewExpiresAt`, extra candidate
fields (including a raw prompt), malformed audit log, and attempted self
approval are rejected before a decision audit append.
`PrismaImageCandidateLedger` and `PrismaImageOwnerReviewLedger` reuse existing
Records; each writes with its audit event under the existing
per-workspace audit lock. A duplicate or opposite decision is rejected before
either write. The host is still
responsible for authenticating its actors before it grants owner approval,
records issuance, or calls a decision function. This module has no image HTTP
route, database migration, or publishing path; generic product CRUD returns
`404` for all reserved `gcl-*` system modules.

Candidate receipts are strict `gcl-image-candidate-v1` records. A receipt that
predates this package and therefore lacks `issuanceOccurredAt` or
`reviewExpiresAt` is deliberately unusable; the module does not backfill or
migrate it. This is a fail-closed integrity decision, not a production
migration path.

The candidate's `creativeWorkerPlan` is intentionally **not** an executable
Creative Worker manifest: it has no raw prompt or negative prompt, no actual
checkpoint ID, and `dispatch.performed` is permanently `false`. It uses only
prompt digests and declares `UNRESOLVED_SYNTHETIC_ONLY`; it cannot be submitted
to Jarvis Creative Worker or ComfyUI.

A host may compose the governed path with `SyntheticImageTtiConnector`,
`ConnectorRegistry`, `GovernedConnectorRunner`, `PrismaHashChainAuditLog`, and
`new PrismaDailyConnectorQuota(prisma, imageDailyQuotaFromEnvironment())`.
After the runner succeeds, it must call `issueSyntheticImageCandidates` with
`new PrismaImageCandidateLedger(prisma)` before it offers either terminal
owner decision. Terminal decisions additionally require
`new PrismaImageOwnerReviewLedger(prisma)`, not a bare audit log. The host
must authenticate the maker, issuance caller, and independent owner checker
before it can set `ownerApproved: true`, record issuance, or call an
owner-decision function. The in-memory ledgers are test seams only. This
module does not expose an HTTP route or manage credentials.

## Synthetic-only environment contract

```dotenv
GCL_IMAGE_LIVE_MODE=LIVE_DISABLED
GCL_IMAGE_MAX_COST_CENTS=25
GCL_IMAGE_MAX_ITEMS=2
GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS=900
GCL_IMAGE_DAILY_RUN_QUOTA=10
GCL_IMAGE_DAILY_ITEM_QUOTA=20
```

No image-provider key, credential, endpoint, SDK, Docker setting, ComfyUI
setting, or live flag is accepted. Supplying any `GCL_IMAGE_LIVE_MODE` value
other than `LIVE_DISABLED` closes the connector. Prompt data is never returned
in the candidate, plan, provenance, or audit detail: only SHA-256 digests are
kept and all owner-supplied text is declared `data-only`, never instructions.
The review TTL is required and bounded to 60–86,400 seconds. The generated
canonical expiry timestamp is part of the candidate's ID and redacted
fingerprint, so neither a caller nor a stored receipt can extend it without
breaking issuance proof. A single run is also capped at 32 candidates, exactly
the maximum receipt set the issuance ledger accepts; valid governed output is
therefore always issuable.

## D1 — closed configuration and policy boundary

`SyntheticImageTtiConnector` snapshots its configuration at construction into a
runtime-private, immutable copy. Only these own data fields are accepted:
`liveMode`, `maxCostCapCents`, `maxItems`, `ownerReviewTtlSeconds`, and the
optional `familySafetyFilter`. Any extra field—including a non-enumerable
provider credential or endpoint—symbol, accessor, non-data value, or malformed
policy causes `IMAGE_TTI_CONFIGURATION_INVALID` before preflight, audit, quota,
SVG creation, or review work. Later changes to the caller's configuration object
cannot alter a constructed connector's live mode or governance limits.

The optional policy is an explicitly local, synchronous host seam. Its `id` and
`assess` callable must be own data properties; inherited getters and inherited
assessment methods are not consulted. A policy result must have its own boolean
`allowed` field and may have only an own string `reason`; inherited approval or
extra result fields fail as `IMAGE_FAMILY_SAFETY_FILTER_INVALID`. Environment
construction does not spread caller overrides, so an accessor-bearing override
is also closed without being read. This is structural hardening, not a new
provider or moderation service.

## D2 — immutable policy input and review output

The policy object itself is an exact two-field capsule: only own data `id` and
`assess` are accepted. A nested credential, endpoint, extra hidden field,
symbol, accessor, inherited member, or receiver-backed policy object makes the
connector configuration invalid before preflight, audit, quota, or candidate
creation. The copied `assess` callable is invoked without the caller's policy
object as `this` and receives a newly-created frozen prompt/dimension snapshot.
It cannot rewrite the normalized input that will form digests and candidate IDs;
an attempted mutation closes preflight as
`IMAGE_FAMILY_SAFETY_FILTER_UNAVAILABLE`.

Successful synthetic output is an immutable review snapshot: the result, data,
candidate array, each candidate, scope, safety record, owner-review record,
Creative Worker graph shape/dispatch plan, and provenance data are frozen before
they leave the adapter. The connector's only scope array is frozen as well.
This prevents accidental post-run mutation such as adding a raw prompt, changing
a synthetic URI to a network URI, or changing a graph node into dispatch. A host
may still copy an output, but issuance and terminal review revalidate that copy
and bind its complete redacted fingerprint to the governed success audit event.

This contract does not authorize a real provider, a local GPU worker, a model
installation, a migration, or public publishing. Each remains a separate owner
decision and must be implemented behind its own bounded approval path.

## D3 — non-bypassable baseline family gate

The local baseline family gate is mandatory even when a host supplies the
optional closed policy capsule. The baseline evaluates the frozen normalized
input first; a baseline-rejected prompt stops before the custom callable,
audit reservation, quota reservation, candidate creation, or review work. A
custom policy therefore only adds a stricter deny decision and cannot make an
adult, graphic, weapon-focused, or other baseline-rejected prompt eligible.

For an accepted candidate, `safety.filterId` is the custom policy ID when a
custom policy additionally accepted the input, otherwise the baseline ID. In
either case, the baseline gate is implicit and mandatory. This field is
redacted local policy metadata only; it is not a moderation-provider handle,
credential, endpoint, or dispatch authorization.

## D4 — durable deadline and candidate-fingerprint lineage

Each issuance entry now stores the canonical `reviewExpiresAt` alongside the
candidate ID and its redacted SHA-256 fingerprint. The pre-existing governed
success digest remains exactly the digest of candidate IDs and fingerprints;
deadline data is additional lifecycle metadata and cannot retroactively alter
the successful run audit. Candidate receipts re-read all three values.

Both ledger seams enforce the deadline independently of the public helper:
candidate issuance at or after an entry's deadline is rejected, and a terminal
review event must carry the exact issued fingerprint and deadline and occur
strictly before that deadline. The review ledger also recomputes the issuance
candidate-set digest before it trusts a direct terminal call. Thus a copied
success digest, changed candidate ID/fingerprint, extended deadline, or an
exact-deadline direct ledger decision cannot create a terminal receipt. These
are redacted integrity checks only—no provider, network, GPU, or publication
capability is added.

## D5 — sealed ledger write and lookup snapshots

Candidate issuance and terminal-review events are copied into private,
data-only snapshots immediately after their strict validation. Both durable
and test-only ledger implementations use only that copy through their later
async transaction/audit append and receipt write. Therefore, changing the
caller-owned event object while an audit append or database transaction is
pending cannot substitute a candidate fingerprint, deadline, scope, artifact
identifier, decision, or any other audited field after lineage has passed.

The public candidate-receipt lookup is an async boundary as well. It first
validates the complete synthetic candidate and then uses an isolated copy for
the persistence query and receipt comparison. An accessor-bearing candidate is
rejected without evaluating its accessor; a mutable candidate cannot switch
workspace, correlation, deadline, or fingerprint during a pending lookup.
These snapshots contain the same redacted local metadata as before and add no
provider, network, GPU, dispatch, credential, migration, send, or publication
capability.

## Negative and edge-case guarantees

- Prompt fields accept only the documented four keys. Empty text, a value over
  1,000 characters, ASCII/Unicode control or formatting characters, hidden
  non-enumerable own fields, and every size other than `512` or `1024` fail
  closed.
- The governed-run boundary accepts only its documented own-data fields and a
  dense, unique scope array. Request accessors, unknown fields, sparse scope
  arrays, non-boolean owner approval, accessor-backed connector/audit/quota
  methods, malformed audit hash responses, malformed clocks, and
  accessor-shaped connector results fail before they can authorize a success.
  A post-reservation adapter failure remains auditable with the fixed
  `CONNECTOR_RUN_FAILED` code, but its raw message—including any prompt-like
  text—never enters the chain.
- The baseline local family filter tokenizes Unicode text, including Turkish
  terms such as `şiddet`, while avoiding substring false positives such as
  `gunmetal`. It always runs before an injected filter; a permissive injected
  policy is never able to override a baseline rejection and is not called for
  that rejected input. An injected filter must have own data `id`/`assess`
  properties, a bounded identifier, and may return only an own boolean
  `allowed` plus a bounded uppercase reason code; inherited approval and
  untrusted free-form reasons are rejected or replaced with
  `FAMILY_SAFETY_FILTER_REJECTED`.
- Connector configuration is an exact, runtime-private snapshot. Hidden
  credential/endpoint fields, symbols, accessors, inherited policy methods,
  nested policy capability fields, malformed environment overrides, and
  post-construction mutation attempts cannot reach preflight, audit, quota,
  candidate creation, or a provider path.
- A custom policy receives only a frozen normalized input snapshot and no policy
  receiver. It cannot mutate the candidate's future prompt/dimensions or retain
  a hidden endpoint/credential field in the accepted policy shape. The emitted
  result is frozen through every review-relevant nested value; adding a raw
  prompt, provider URI, or executable graph node to that instance fails.
- The review audit records only candidate IDs, maker/checker identities,
  controlled decision fields, blocked publication state, and SHA-256 lineage
  hashes. It never records the prompt, negative prompt, preview bytes,
  provider endpoint, or a credential.
- Candidate issuance accepts only the governed result carrying a success audit
  hash and matching redacted candidate-set digest, stores candidate IDs plus
  fingerprints/hashes plus canonical deadlines only, and rejects direct
  connector output, a changed redacted candidate field, a candidate set from
  another run, duplicate issuance, concurrent issuance replay, or an expired
  candidate. The durable candidate ledger independently rejects a direct
  issuance at the exact deadline. Owner like and rejection checks use the same
  strict deadline and reject the exact expiry instant before a receipt or audit
  event can be added; the terminal ledger independently rechecks the issued
  candidate fingerprint, candidate-set digest, and deadline for direct calls.
- Issuance events must be timestamped at or after their bound successful run,
  and terminal decisions must be timestamped at or after durable issuance.
  The receipt preserves the canonical issuance event time and rechecks it
  against the audit chain before it is used. Malformed, extra, or backdated
  candidate-ledger proof data fails closed before a decision audit append.
- Every record in the source audit chain must have the exact closed GCL event
  envelope, a canonical UTC `occurredAt`, and a timestamp no earlier than its
  predecessor. A self-consistent hash is insufficient when an event is
  malformed or regresses time: it cannot support candidate issuance or an
  owner review, and a newly appended earlier event is rejected.
- The durable candidate and review ledgers serialize on the audit lock. A
  replay, concurrent opposite decision, malformed receipt, malformed audit
  record, a self-consistent audit hash with a broken predecessor, or unissued
  candidate fails closed and cannot add another decision event. Before every
  append and before a candidate proof is used, the whole ordered workspace
  chain is rechecked; an issuance receipt must still match both its issuance
  event and the bound source success event.
- A terminal owner-review output additionally requires an exact, re-read
  `gcl-image-owner-review-v1` receipt. The review ledger independently proves
  the candidate was included in its governed issuance and that the issuance
  binds to the matching successful run before it writes or re-reads a decision.
  An orphan direct `appendDecision`, altered terminal receipt, mismatched
  maker, candidate, scope, issuance hash, or run hash fails closed; no liked
  artifact is returned from an unproven terminal decision.
- Accessor-shaped input, policy objects, and candidate data are rejected
  before their getters can run, so untrusted runtime objects cannot smuggle
  prompt text or behavior through validation. The same fail-closed rule applies
  to stored audit records before they are hashed or inspected. Candidate-set
  arrays, Creative Worker graph-shape arrays, issuance-entry arrays, and the
  stored audit-record array must each be dense, ordinary own-data arrays with
  no symbols or extra properties. Sparse arrays and element accessors are
  rejected before an item is read; this prevents an untrusted host object from
  executing code or exposing prompt text during issuance, review, or chain
  verification.
- Direct adapter, issuance, and owner-review contexts are closed, copied
  data envelopes. Each accepts only its documented envelope or the complete
  shared `ConnectorRunContext`; arbitrary extra fields, accessor fields,
  hidden non-enumerable own fields, malformed scope arrays, or malformed
  clocks fail before identity, scope, or time values are read. A complete
  shared context must also remain owner-approved, have exactly the
  `image:generate` scope, and carry positive safe-integer cost/item values;
  it cannot be treated as a permissive subset by issuance or review helpers.
  Terminal approval is exactly boolean `true`—truthy values fail before a
  candidate-ledger or review-ledger call. An injected direct-path clock must
  return an ordinary built-in `Date`; subclasses and overridden date methods
  are rejected without calling those methods, and a validated clock value is
  copied before it can set a candidate, issuance, or review timestamp.
  Ledger operations are resolved only from data-method descriptors (including
  ordinary class methods, but never intrinsic `Object`/`Function` prototypes);
  accessor-backed `appendIssuance`, `assertIssued`, and `appendDecision`
  capabilities are never invoked. Ledger response hashes must likewise be a
  closed `{ hash }` envelope. This keeps host integration seams fail-closed
  without adding an HTTP route, credential, or dispatch capability.
- The in-memory audit log used by the ledger test seams follows the same rule:
  `append` must be a data-method, its mutable `entries` test array must be an
  own data property, and an append response must be a closed `{ hash }`
  envelope. Accessor-backed audit capabilities, entries, or hash responses are
  rejected without evaluating their getters; this test-only seam cannot become
  an alternate dispatch or persistence path.
- Candidate-issuance and terminal-review event objects are copied immediately
  after strict validation and before any awaited transaction or audit call.
  Receipt lookup performs the same validation-and-copy operation for its
  candidate. A caller therefore cannot mutate an already-validated event or
  candidate while a persistence seam yields; an accessor-shaped direct lookup
  candidate fails closed without its accessor being evaluated.
- `creativeWorkerPlan.dispatch` remains exactly
  `{ performed: false, gate: "LIVE_DISABLED", network: "not-attempted" }`.
  This package does not invoke Creative Worker, ComfyUI, Docker, loopback, a
  GPU, an HTTP client, or an external provider.

## ADOS boundary checklist (10 rules)

1. Product/workspace isolation is retained; no cross-product runtime import or
   cross-database query is introduced.
2. `LIVE_DISABLED` remains the only accepted mode; there is no provider key,
   endpoint, SDK, HTTP client, Docker client, loopback client, or outbound call.
3. Exact owner approval, bounded identity, a closed configuration/policy
   capsule, immutable review output, and a canonical owner checker default to
   deny.
4. The exact `image:generate` scope, positive cost cap/item count, connector
   limits, and daily quota gate execution before the adapter runs.
5. Prompt and policy input are untrusted data only, never instructions; the
   mandatory baseline gate runs before any optional frozen, receiverless policy
   input is exposed, while malformed/accessor/inherited shapes and
   family-unsafe content are rejected.
6. Candidates, receipts, and audit events retain only blocked metadata,
   digests, and provenance—never prompt text, preview bytes, provider output,
   endpoint, or credentials.
7. Candidate-set and candidate fingerprints are recomputed from the exact
   redacted shape before issuance or terminal review; canonical review
   deadlines are re-read from durable issuance and bound into terminal proofs.
8. A governed run has one bound issuance set, and each candidate has one
   replay-protected terminal outcome in the SHA-256 audit lineage.
9. Canonical monotonic timestamps, expiry, full scope binding, and
   maker-checker separation prevent stale, self-approved, cross-scope, or
   backdated decisions.
10. Durable issuance/review writes share an audit transaction; no migration,
    publication, dispatch, send, live provider, GPU activation, or production
    enablement is authorized by this synthetic contract or its tests.
