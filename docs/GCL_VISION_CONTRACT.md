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

## D1 — review-packet integrity boundary

The proposal contains a `synthetic-document-review-packet-v1`. Before it appends a review audit event, the module validates all of the following again:

- the product/workspace-derived proposal ID and synthetic URI, so a proposal cannot be reviewed in another scope;
- evidence metadata only (no raw bytes or `rawContentStored: true`);
- sorted, unique allowlisted fields; standard-value digests; sensitive-field masks; and `confidence: 0`;
- the still-pending, owner-only, no-auto-apply/no-auto-publication state;
- the review packet's scope digests and integrity digest; and
- a non-blank independent reviewer plus only `approved` or `rejected` as a decision.

Any malformed, cross-scope, altered, raw-sensitive, or non-pending proposal fails before the review audit append. The integrity digest is deliberately **unkeyed**: it detects accidental or in-process mutation, but is not a signature, credential, capability, or proof of authorization. A future durable host must resolve a proposal through its own scoped persistence/audit records before it can treat a review as actionable. That host, durable review state, any send/apply action, and any provider integration are outside this module.

## Safe configuration

These values configure a synthetic proposal limit only; they cannot enable a provider or a live execution path:

```dotenv
GCL_VISION_LIVE_MODE=LIVE_DISABLED
GCL_VISION_MAX_COST_CENTS=20
GCL_VISION_MAX_ITEMS=1
GCL_VISION_DAILY_RUN_QUOTA=5
GCL_VISION_DAILY_ITEM_QUOTA=5
```

No migration is added. Durable audit (`gcl-audit`) and usage (`gcl-vision-usage`) records use the existing `Record` table when a future product-owned wiring layer deliberately constructs `PrismaHashChainAuditLog` and `PrismaDailyConnectorQuota`. D1 adds no persistence, review-state mutation, migration, credential, or network client.

## ADOS controls

The contract keeps product data/runtime isolated, default-denies missing policy inputs, uses evidence references rather than raw content, requires owner authority plus independent checker review, produces a scoped hash-chain audit, makes AI/OCR suggestion-only, and treats any future launch/live adapter as a separate owner decision. D1 additionally rejects review-packet tampering and cross-scope review before audit. It makes no migration, promotion, publication, or provider request.
