# Synthetic interpreter — governed translation connector contract

This module is a **synthetic contract**, not a translation service. It does not
call a language, speech, TTS, STT, cloud, or third-party provider. There is no
credential field, provider URL, HTTP client, or live-enable configuration.
`LIVE_DISABLED` is the permanent runtime state.

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

`GCL_TRANSLATION_REVIEW_TTL_MS` is required and must be a positive integer.
The connector derives `reviewExpiresAt` from its synthetic run clock; it is not
caller-controlled. A checker has to resubmit a newly generated synthetic
fixture after expiry. Before adding an audit entry, the durable audit writer
revalidates the whole product/workspace SHA-256 chain. A malformed prior entry
returns `GCL_AUDIT_CHAIN_INVALID` and no new entry is appended. In the durable
Prisma store, artifact creation and a successful compare-and-set decision each
share one database transaction with their audit row; an audit failure rolls back
that metadata mutation.

## ADOS boundary checklist

- Product/workspace scope is retained; this module makes no cross-product DB
  query, runtime import, shared state, or outbound request.
- Default deny applies to absent synthetic gates, owner token, actor, scope,
  quota, cost cap, and malformed fixture metadata.
- Artifacts/audit hold reference hashes and provenance, not raw content.
- Maker and checker are separated; the exact metadata digest and TTL bind a
  decision; terminal artifact decisions are compare-and-set; audit is a
  fail-closed, per-product/workspace SHA-256 chain; no migration is introduced
  by this module.
- `LIVE_DISABLED` synthetic tests and contracts do not authorize production,
  real-data ingestion, real translation, sending, publishing, or launch.
