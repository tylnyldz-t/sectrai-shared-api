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
- positive cost, text-size, audio-duration, daily-run, and daily-item limits;
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

An approval body is exactly `{ "decision": "approved" }` or
`{ "decision": "rejected" }`. The maker of the proposal is rejected with
`maker_checker_separation_required`; only a distinct checker can decide it. A
non-pending proposal returns a conflict. No decision can publish content.

## ADOS boundary checklist

- Product/workspace scope is retained; this module makes no cross-product DB
  query, runtime import, shared state, or outbound request.
- Default deny applies to absent synthetic gates, owner token, actor, scope,
  quota, cost cap, and malformed fixture metadata.
- Artifacts/audit hold reference hashes and provenance, not raw content.
- Maker and checker are separated; audit is a per-product/workspace SHA-256
  chain; no migration is introduced by this module.
- `LIVE_DISABLED` synthetic tests and contracts do not authorize production,
  real-data ingestion, real translation, sending, publishing, or launch.
