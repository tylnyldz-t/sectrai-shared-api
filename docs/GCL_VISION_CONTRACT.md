# GM2 — Synthetic Vision / Document Field Extraction Contract

This module adapts the **shape** of Xontainer MagicScan (`camera → document fields → user form decision`) without importing Xontainer code, calling its API, reading a camera image, or creating a cross-product runtime dependency.

Its only connector is `vision-document-field-extraction`, with scope `vision:document-field-extraction`. It is deliberately a proposal generator, not OCR:

- `LIVE_DISABLED` is the sole accepted mode. `LIVE_ENABLED`, a missing cost/item limit, malformed quota limits, missing owner approval, missing/expired consent, invalid scope, or a non-synthetic input all fail closed.
- There is no provider endpoint, SDK, credential field, `fetch` client, camera client, Base64 image field, or live sending path.
- Input accepts only `source: "synthetic-fixture"` evidence metadata, an SHA-256 evidence reference, purpose-bound consent, and bounded synthetic field fixtures. Raw bytes, camera sources, and unrecognised fields are rejected.
- The output explicitly says `SYNTHETIC_PROPOSAL_ONLY_NOT_OCR`, sets `confidence: 0`, stores no raw image, and never automatically applies or publishes a result.

## Xontainer schema adaptation

The synthetic fixture field allowlist mirrors the document fields used by Xontainer's `extractFields()` surface: `containerId`, references/import-export orders, load type/amount/weight, dates, sender/recipient, loading/delivery addresses and countries, gross weight, and package count. `identityNumber` is additionally present only to exercise the sensitive-document policy.

`note`, party names, addresses, and `identityNumber` are KVKK-masked in output. Their raw fixture values are omitted; only a value digest and `KVKK_MASKED:<digest-prefix>` appear. The evidence/Masa handoff is reference-only and carries no raw document content.

## Required governance sequence

`GovernedConnectorRunner` enforces owner approval, typed scope, positive cost/item limits, pure preflight, SHA-256 audit reservation, daily quota reservation, then adapter execution. The synthetic adapter accepts only one evidence item per run.

Every proposal remains `owner-only`, `pending`, `automaticApply: false`, and `automaticPublication: false`. `independentlyReviewSyntheticDocumentProposal()` enforces maker–checker separation: the actor who prepared the proposal cannot review it. Even an `approved` review only appends a hash-chain audit event; its Masa handoff remains `sent: false` and requires a separate owner-controlled action outside this module.

## Safe configuration

These values configure a synthetic proposal limit only; they cannot enable a provider or a live execution path:

```dotenv
GCL_VISION_LIVE_MODE=LIVE_DISABLED
GCL_VISION_MAX_COST_CENTS=20
GCL_VISION_MAX_ITEMS=1
GCL_VISION_DAILY_RUN_QUOTA=5
GCL_VISION_DAILY_ITEM_QUOTA=5
```

No migration is added. Durable audit (`gcl-audit`) and usage (`gcl-vision-usage`) records use the existing `Record` table when a future product-owned wiring layer deliberately constructs `PrismaHashChainAuditLog` and `PrismaDailyConnectorQuota`.

## ADOS controls

The contract keeps product data/runtime isolated, default-denies missing policy inputs, uses evidence references rather than raw content, requires owner authority plus independent checker review, produces a scoped hash-chain audit, makes AI/OCR suggestion-only, and treats any future launch/live adapter as a separate owner decision. It makes no migration, promotion, publication, or provider request.
