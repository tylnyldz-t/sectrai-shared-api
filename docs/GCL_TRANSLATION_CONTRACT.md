# Synthetic interpreter — governed translation connector contract

This module is a **synthetic contract**, not a translation service. It does not
call a language, speech, TTS, STT, cloud, or third-party provider. There is no
credential field, provider URL, HTTP client, or live-enable configuration.
`LIVE_DISABLED` is the permanent runtime state.

There is deliberately no `GCL_TRANSLATION_LIVE_ENABLED` setting. If that
environment key is present at all (including with the value `false`), the
connector is unavailable with `TRANSLATION_LIVE_EXECUTION_FORBIDDEN`. This is
a configuration poison pill, not a future live-mode compatibility switch.

## Fail-closed gates

Each route is unavailable until all synthetic-only gates are configured:

- a valid product key and `X-Sectrai-Owner-Token`;
- a valid `X-Sectrai-Owner-Actor`;
- `GCL_TRANSLATION_SYNTHETIC_ENABLED=true`;
- `GCL_TRANSLATION_LIVE_DISABLED=true`;
- positive cost, text-size, audio-duration, review-TTL, daily-run, and daily-item limits;
- matching scope, a positive cost cap, and exactly one requested item.

Missing or invalid configuration returns a visible `503`; owner, input, scope,
cost, and quota failures happen before the adapter runs. There is no fallback.
Once a valid request has its `requested` audit entry, a quota reservation
rejection is also terminally recorded as `connector.run.failed` with only the
stable `connector_quota_exceeded` code. The adapter is not invoked and no raw
input is placed in that audit record. Preflight failures remain before the
first audit entry and quota reservation.

## Connector routes

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/translation-text-synthetic/runs
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/translation-speech-synthetic/runs
```

Both routes need these headers:

```text
X-Sectrai-Product-Key: product boundary key
X-Sectrai-Owner-Token: owner gate
X-Sectrai-Owner-Actor: auditable maker identity
```

Text translation accepts only an explicitly supplied synthetic fixture. The
adapter does not infer or generate `translatedText`:

```json
{
  "input": {
    "synthetic": true,
    "sourceText": "Merhaba dünya.",
    "translatedText": "Hello world.",
    "sourceLocale": "tr-TR",
    "targetLocale": "en-US"
  },
  "scopes": ["translation:text"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

Speech translation accepts only a synthetic metadata descriptor and the same
explicit translation fixture. It neither accepts raw files/base64/HTTP URLs nor
returns sound bytes:

```json
{
  "input": {
    "synthetic": true,
    "sourceAudio": {
      "synthetic": true,
      "sourceRef": "synthetic://translation/audio/fixture-1",
      "contentHash": "sha256:<64 lowercase hex chars>",
      "mimeType": "audio/wav",
      "durationMs": 1200
    },
    "sourceTranscript": "Merhaba dünya.",
    "translatedText": "Hello world.",
    "sourceLocale": "tr-TR",
    "targetLocale": "en-US",
    "targetVoice": "synthetic-en-neutral"
  },
  "scopes": ["translation:speech"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

Both inputs reject basic TCKN, Turkish mobile-phone, and email-shaped data.
Their content is `data-only` under
`UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`; it is never a command, action,
message, notification, or publication.

## Metadata-only checker workflow

Successful runs create a proposal with:

```text
synthetic = true
approvalState = pending-checker-approval
autoPublish = false
reviewPolicyVersion = gcl-translation-synthetic-v1
reviewExpiresAt = canonical UTC timestamp
reviewDigest = sha256:<64 lowercase hex chars> (stored proposal response)
```

The service stores only connector/artifact metadata, hashes, run-audit hash,
maker/checker identity, and lifecycle state. It does not store source text,
translated text, transcript text, or audio bytes in the artifact or hash-chain
audit records. Normal record CRUD cannot access `gcl-audit`, `gcl-usage`, or
`gcl-translation-artifacts`.

```text
GET  /api/products/:product/workspaces/:workspaceId/gcl/translation-artifacts/:recordId
POST /api/products/:product/workspaces/:workspaceId/gcl/translation-artifacts/:recordId/approval
```

An approval body is exactly `{ "decision": "approved", "reviewDigest": "sha256:..." }` or
`{ "decision": "rejected", "reviewDigest": "sha256:..." }`. The digest is
computed from the immutable, metadata-only proposal binding (connector, artifact
binding, hashes, policy version, expiry, and linked run audit), not raw text or
audio. The maker of the proposal is rejected with
`maker_checker_separation_required`; only a distinct checker can decide it. A
non-pending proposal, a mismatched digest, or an expired review returns a
conflict. No decision can publish content.

## Artifact integrity and decision race boundary

Before metadata is stored, the registry accepts only one of these complete
bindings; fields cannot be mixed across rows:

| Connector | Artifact kind | Media type | Source |
| --- | --- | --- | --- |
| `translation-text-synthetic` | `translated-text` | `text/plain` | `synthetic-text-translation` |
| `translation-speech-synthetic` | `translated-speech` | `audio/wav` | `synthetic-speech-translation` |

`contentHash` is an explicitly prefixed, lowercase `sha256:<64 hex>` value;
the linked run-audit hash is the lowercase 64-hex chain value. The metadata
object is exact: additional fields (including source text, translated text,
transcripts, audio, URLs, provider details, or credentials) cause the proposal
to be rejected. A malformed stored artifact fails closed as unavailable rather
than being returned or decided.

Each approval is a conditional `pending-checker-approval` → `approved` or
`rejected` transition. If two distinct checkers race, one can win; the other
gets a conflict and cannot overwrite the first decision. A terminal decision
must retain a canonical UTC decision time and checker identity; a pending
artifact cannot carry either field. This is lifecycle integrity only: it never
creates a publish, send, provider, media-byte, or live execution path.

Every durable artifact read and decision replays the relevant verified audit
chain before returning or mutating metadata. It must prove the same maker's
requested → successful synthetic run, one matching `artifact.created` entry,
and, for a terminal row, exactly one matching checker decision after creation.
The creation event must retain the run's canonical scope and budget; a decision
must use only `translation:artifact:approve` with zero cost/items, a checker
different from the maker, and the same canonical UTC instant as the row's
`decidedAt`. The durable store rejects a missing, noncanonical, mismatched, or
out-of-scope decision audit context before it opens the decision transaction.
It also requires nondecreasing requested → succeeded → creation → decision
instants, with creation and any terminal decision strictly before
`reviewExpiresAt`; a hash-valid, backdated, or post-expiry lifecycle is not
readable. Proposal persistence checks the same requested → succeeded →
creation timing before it inserts metadata, so a stale proposal cannot create
an unreachable durable row. This temporal validation is a metadata-only
integrity check and does not extend the review window or create a live
execution path.
Metadata-shaped rows with missing, duplicate, out-of-order, cross-maker, or
mismatched lifecycle evidence is unavailable with
`TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID`. This check does not expose
fixture text or audio and does not add an execution or publication path.

`GCL_TRANSLATION_REVIEW_TTL_MS` is required and must be a positive integer.
The connector derives `reviewExpiresAt` from its synthetic run clock; it is not
caller-controlled. A checker has to resubmit a newly generated synthetic
fixture after expiry. Before adding an audit entry, the durable audit writer
revalidates the whole product/workspace SHA-256 chain and the exact,
metadata-only audit-event schema. A hash-valid row with unknown fields (for
example source text, translated text, transcript, audio, provider output, or a
raw exception) is still invalid: it returns `GCL_AUDIT_CHAIN_INVALID` and no
new entry is appended. Run failures retain only a stable error code, never an
exception message.

Audit provenance also binds the event's semantics, not merely its field
shapes: text runs and their creation event must have exactly
`["translation:text"]`; speech runs and their creation event must have exactly
`["translation:speech"]`; and checker decisions must have exactly
`["translation:artifact:approve"]` with zero cost/items. Every run and
creation event has exactly one requested item. A hash-valid persisted row that
uses another syntactically valid scope or a multi-item run is an invalid chain
(`GCL_AUDIT_CHAIN_INVALID`), so no new audit row, proposal, or decision can be
written from it.

The audit writer also replays transition semantics while it validates the
existing chain. A run outcome must reference its one earlier, otherwise
identical request and no second success/failure outcome may reuse that request.
An artifact creation must reference the exact successful run and proposal
envelope, carry the canonical metadata-only review digest, and be the only
creation that uses that successful-run hash. A checker decision must be the
first terminal event after the matching creation, from a different actor,
before the shared expiry. A hash-valid persisted row that breaks one of these
predecessor, digest, or single-binding links makes the whole chain unavailable
as `GCL_AUDIT_CHAIN_INVALID`; a newly submitted orphan, invented-digest,
duplicate outcome, duplicate artifact binding, or unlinked decision is
rejected before append as `GCL_AUDIT_EVENT_INVALID`. Neither path stores raw
fixture data or creates a publication, send, provider, or live-execution
capability.

For an artifact-producing success, the `succeeded` audit event contains the
complete metadata-only proposal envelope (binding, content hash, synthetic
marker, review policy, and expiry), never fixture content. A durable artifact
proposal must link to a matching prior `requested` → `succeeded` pair and must
match its product, workspace, connector, maker, canonical scopes, cost cap,
item count, and every proposal-envelope value. A successful run cannot be
reused by another actor, request budget, or content hash, and can authorize
only one stored artifact. Missing, legacy unbound, or mismatched success
metadata returns `TRANSLATION_RUN_AUDIT_LINK_INVALID`; a second use of the same
successful run returns `TRANSLATION_RUN_AUDIT_ALREADY_BOUND`, before metadata
storage. In the durable Prisma store, artifact creation and a successful
compare-and-set decision each share one database transaction with their audit
row; an audit failure rolls back that metadata mutation.

## Durable mutation boundary

The production artifact store exposes only `proposeAndAudit` and
`decideAndAudit`; there is no durable metadata-only `propose` or `decide`
write path that can bypass its corresponding audit event. The HTTP routes use
these atomic operations exclusively. The in-memory store retains direct helper
methods only as a test seam; when it is used through the application it also
requires an audit log and restores its prior in-memory state if audit append
fails.

An artifact row is valid only when its database `status` exactly matches the
metadata `approvalState`, and its maker identity is a nonblank canonical owner
actor. A blank owner actor is rejected before the connector runner, quota,
artifact, or audit can execute. A status/maker mismatch in durable storage is
treated as `TRANSLATION_ARTIFACT_STORAGE_INVALID`, never as a recoverable
artifact.

## ADOS boundary checklist (10 rules)

1. Product/workspace scope is retained; no cross-product DB query, runtime
   import, or shared in-process state is introduced.
2. The connector stays `LIVE_DISABLED`; it has no credential, provider URL,
   HTTP client, or outbound request capability.
3. Synthetic enablement, owner token, and canonical owner actor default to
   deny; a present live-enable flag is a poison pill.
4. Scope, positive cost cap, one-item limit, and daily quota are enforced
   before adapter execution.
5. Fixture input is untrusted data only, never instructions; basic personal
   data is rejected.
6. Artifacts and audit contain only metadata, hashes, and provenance—never
   translated text, transcripts, audio bytes, URLs, provider output, or secrets.
7. The review digest is recomputed from the exact metadata-only envelope in
   both artifact storage and audit validation.
8. One requested run has one terminal outcome, and one successful run can bind
   exactly one artifact; the SHA-256 audit chain replays these transitions.
9. Maker/checker separation, TTL, canonical timestamps, and compare-and-set
   terminal decisions prevent self-approval, stale review, and overwrite races.
10. Each durable mutation shares a transaction with its audit row; no migration,
    publication, send, provider invocation, real-data ingestion, or production
    enablement is authorized by this synthetic contract or its tests.
