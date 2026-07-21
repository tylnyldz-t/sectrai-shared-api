# GM1 Voice — governed synthetic connector contract

GM1 is an interactive STT/TTS contract for the owning product's UI. It does not
deliver a notification, send a message, publish audio, connect to another
product at runtime, or call a live speech provider. This preserves the F19
boundary: product-specific interactive voice stays in the product adapter.

## Permanent safety state

`src/gcl/voice.ts` exports `LIVE_DISABLED = 'LIVE_DISABLED'` and
`SYNTHETIC_VOICE_ONLY = true`. There is no `fetch`, provider URL, credential,
or `*_LIVE_ENABLED` configuration in GM1. A connector remains unavailable
unless all of these owner-controlled synthetic gates are true/configured:

- `GCL_VOICE_SYNTHETIC_ENABLED=true`
- `GCL_VOICE_LIVE_DISABLED=true`
- positive max cost, input-size, duration, daily run, and daily item limits
- the request has the product key, owner token, owner actor, minimum scope,
  positive cost cap, and exactly one requested item

Missing or invalid configuration is a visible `503`; invalid input, scope,
cost, quota, or owner gate fails before the adapter runs. There is no fallback.

## Connectors

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/voice-stt-synthetic/runs
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/voice-tts-synthetic/runs
```

Both endpoints require:

```text
X-Sectrai-Product-Key: product boundary key
X-Sectrai-Owner-Token: configured owner gate
X-Sectrai-Owner-Actor: auditable owner identity
```

STT has only a synthetic fixture form. It does not accept a file, base64 audio,
or HTTP URL:

```json
{
  "input": {
    "audio": {
      "synthetic": true,
      "sourceRef": "synthetic://voice/fixture/command-1",
      "contentHash": "sha256:<64 lowercase hex chars>",
      "mimeType": "audio/wav",
      "durationMs": 1200
    },
    "transcript": "Bugünkü bekleyen onayları göster.",
    "locale": "tr-TR"
  },
  "scopes": ["voice:transcribe"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

TTS returns only a deterministic synthetic reference, not speech bytes:

```json
{
  "input": {
    "synthetic": true,
    "text": "Üç onay bekliyor.",
    "locale": "tr-TR",
    "voice": "synthetic-tr-neutral"
  },
  "scopes": ["voice:synthesize"],
  "costCapCents": 25,
  "requestedItems": 1
}
```

All fixture/output content is explicitly marked `data-only` with
`UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS`. It is not a command to the
product, model, or any tool. Basic TCKN/phone/email-shaped input is refused;
real voice or personal-data handling needs a separate owner-approved phase.

## Artifact owner approval and audit

Every successful voice run creates an artifact proposal with:

```text
approvalState = pending-owner-approval
autoPublish = false
synthetic = true
```

The API stores only product/workspace-scoped metadata: connector, artifact kind,
content hash, media type, source, approval state, creator, and the connector-run
audit hash. It stores neither transcript text nor audio bytes. General record
CRUD cannot access `gcl-audit`, `gcl-usage`, or `gcl-voice-artifacts`.

```text
GET  /api/products/:product/workspaces/:workspaceId/gcl/voice-artifacts/:recordId
POST /api/products/:product/workspaces/:workspaceId/gcl/voice-artifacts/:recordId/approval
```

The approval request body is exactly one of:

```json
{ "decision": "approved" }
```

```json
{ "decision": "rejected" }
```

It needs the same owner headers. A decision is one-way; a non-pending artifact
returns `409 voice_artifact_state_conflict` rather than changing silently.

The per-product/workspace SHA-256 chain receives the run requested/succeeded or
failed events plus `voice.artifact.created` and either
`voice.artifact.approved` or `voice.artifact.rejected`. Audit detail uses
artifact/content hashes only—never transcript text or audio payloads.

## ADOS boundary checklist

- Synthetic fixture/metadata only; real people, children/citizens, audio, and
  credentials do not enter this layer.
- Product/workspace remains scoped by the existing product boundary; there is
  no cross-product DB access, runtime import, or direct product DB operation.
- The adapter is in-process and network-inert. It creates no real data and has
  no live launch path.
- Owner approval is required once to run and again before an artifact becomes
  approved; approval never implies automatic publication.
- The stored audit chain is evidence of lifecycle transitions, not a claim that
  a real provider transcribed or synthesized speech.
