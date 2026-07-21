# GM2 — Synthetic Vision / Document Field Extraction Contract

This module adapts the **shape** of Xontainer MagicScan (`camera → document fields → user form decision`) without importing Xontainer code, calling its API, reading a camera image, or creating a cross-product runtime dependency.

Its only connector is `vision-document-field-extraction`, with scope `vision:document-field-extraction`. It is deliberately a proposal generator, not OCR:

- `LIVE_DISABLED` is the sole accepted mode. `LIVE_ENABLED`, a missing cost/item limit, malformed quota limits, missing owner approval, missing/expired consent, invalid scope, or a non-synthetic input all fail closed.
- There is no provider endpoint, SDK, credential field, `fetch` client, camera client, Base64 image field, or live sending path.
- Input accepts only `source: "synthetic-fixture"` evidence metadata, an SHA-256 evidence reference, purpose-bound consent, and bounded synthetic field fixtures. Every accepted record is plain own enumerable data; every accepted field collection is a dense `Array.prototype` array of own enumerable data elements. Inherited, hidden, symbol-keyed, sparse, extra, and accessor-backed fields or array entries are rejected before their values are read. Raw bytes, camera sources, and unrecognised fields are rejected.
- The output explicitly says `SYNTHETIC_PROPOSAL_ONLY_NOT_OCR`, sets `confidence: 0`, stores no raw image, and never automatically applies or publishes a result.

## Xontainer schema adaptation

The synthetic fixture field allowlist mirrors the document fields used by Xontainer's `extractFields()` surface: `containerId`, references/import-export orders, load type/amount/weight, dates, sender/recipient, loading/delivery addresses and countries, gross weight, and package count. `identityNumber` is additionally present only to exercise the sensitive-document policy.

`note`, party names, addresses, and `identityNumber` are KVKK-masked in output. Their raw fixture values are omitted; only a value digest and `KVKK_MASKED:<digest-prefix>` appear. The evidence/Masa handoff is reference-only and carries no raw document content.

## Required governance sequence

`GovernedConnectorRunner` enforces owner approval, typed scope, positive cost/item limits, pure preflight, SHA-256 audit reservation, daily quota reservation, then adapter execution. The synthetic adapter accepts only one evidence item per run.

Every proposal remains `owner-only`, `pending`, `automaticApply: false`, and `automaticPublication: false`. `independentlyReviewSyntheticDocumentProposal()` enforces maker–checker separation: the actor who prepared the proposal cannot review it. Even an `approved` review only appends a hash-chain audit event; its Masa handoff remains `sent: false` and requires a separate owner-controlled action outside this module.

## D1 — review-packet integrity boundary

The original proposal shape introduced `synthetic-document-review-packet-v1`. Before it appends a review audit event, the module validates all of the following again:

- the product/workspace-derived proposal ID and synthetic URI, so a proposal cannot be reviewed in another scope;
- evidence metadata only (no raw bytes or `rawContentStored: true`);
- sorted, unique allowlisted fields; standard-value digests; sensitive-field masks; and `confidence: 0`;
- the still-pending, owner-only, no-auto-apply/no-auto-publication state;
- the review packet's scope digests and integrity digest; and
- a non-blank independent reviewer plus only `approved` or `rejected` as a decision.

Any malformed, cross-scope, altered, raw-sensitive, or non-pending proposal fails before the review audit append. The integrity digest is deliberately **unkeyed**: it detects accidental or in-process mutation, but is not a signature, credential, capability, or proof of authorization. A future durable host must resolve a proposal through its own scoped persistence/audit records before it can treat a review as actionable. That host, durable review state, any send/apply action, and any provider integration are outside this module.

## D2 — consent-bound, time-valid review

The v2 packet introduced a consent binding with the fixed document-extraction purpose, the SHA-256 digest of the policy version, and the canonical consent expiry. Neither a consent token nor the policy text is put in the proposal or review audit.

At review time, the module uses the caller-supplied review clock once, rejects an invalid clock, and rejects expiry at the exact boundary (`expiresAt <= review time`) before writing an audit event. It rejects missing/extra consent-binding fields, invalid consent purpose/digest/timestamps, and a consent-binding alteration whose packet checksum no longer matches. Older packets deliberately remain non-reviewable as newer review-time evidence is added: deny is safer than grandfathering.

D2 is not revocation lookup, replay protection, or durable approval state. The binding is still unkeyed and only protects the in-process packet from accidental change. A future durable, scoped host must enforce consent revocation and one-time decision semantics before it can make a review actionable; this module still only records a synthetic review audit event and never sends or applies evidence.

## D3 — bounded review-time window

The v3 packet added integrity-bound `issuedAt` and `reviewBy` metadata. A controlled synthetic configuration must explicitly set `GCL_VISION_MAX_REVIEW_AGE_SECONDS`; it must be a positive integer no greater than one day. The actual deadline is the earlier of that interval and the consent expiry, so a proposal can never outlive its consent.

At review time the module denies a reviewer clock before issuance and denies the exact deadline boundary (`reviewBy <= review time`) before appending audit. It also rejects absent or extended review windows, non-canonical timestamps, zero/negative windows, windows longer than one day, extra window fields, and integrity changes.

D3 does not turn the packet into a signed token, durable review state, replay control, a retention store, or an apply/send authorization. It only limits the lifetime of an in-process synthetic review proposal; a future durable scoped host must independently enforce any one-time decision and retention policy.

## D4 — evidence-freshness-bound review

The v4 packet introduced `GCL_VISION_MAX_EVIDENCE_AGE_SECONDS`: a controlled synthetic configuration must explicitly set it to a positive integer no greater than one day. At proposal time, a synthetic evidence reference is rejected when its exact expiry boundary has already passed (`capturedAt + maximum age <= proposal time`).

The v4 integrity material adds `evidenceBinding.capturedAt` and `evidenceBinding.expiresAt`. The capture time must exactly match the metadata-only evidence reference; no raw bytes, policy text, token, or credential is added. `reviewBy` is the earliest of the bounded review interval, consent expiry, and evidence expiry. At review time, expiry at the exact evidence boundary is denied before audit. The validator also rejects missing or extra binding fields, non-canonical/zero/negative/over-one-day windows, capture-time mismatch, a review deadline beyond evidence freshness, integrity changes, and all v1/v2/v3 packets; D5 through D9 supersede v4 for newly issued packets.

D4 limits only the in-process lifetime of synthetic evidence metadata. It is not revocation lookup, a signature, durable one-time decision state, a retention store, a send/apply authorization, or an OCR/provider capability. A future durable, scoped host must still resolve the proposal and enforce revocation and replay semantics before any separate action.

## D5 — causally coherent review timeline

The v5 packet required a coherent metadata-only timeline: the evidence capture cannot occur after the packet issue time, and `reviewBy` cannot exceed either the consent expiry or the evidence-freshness expiry. Equality at a deadline is not accepted for a review because expiry checks remain inclusive (`expiresAt <= review time` and `reviewBy <= review time`).

The checks run before a review audit append, including for accidentally altered in-process packets whose integrity digest no longer matches. D5 intentionally does not turn the unkeyed digest into a signature or durable replay control; D6 through D9 supersede it for newly issued packets and a future scoped host must still resolve state, revocation, and one-time decisions before any separate action.

## D6 — governance-derived expiry and deadline

D6 introduced `synthetic-document-review-packet-v6`. Its integrity material adds a metadata-only `governanceBinding` with the exact positive, one-day-capped `maxReviewAgeSeconds` and `maxEvidenceAgeSeconds` used when the synthetic packet was issued. The validator now re-derives both `evidenceBinding.expiresAt` (`capturedAt + maxEvidenceAgeSeconds`) and `reviewWindow.reviewBy` (the earliest of `issuedAt + maxReviewAgeSeconds`, consent expiry, and evidence expiry). A packet with a shortened, extended, missing, extra, malformed, or non-derived timestamp is rejected before the review audit append.

The binding contains neither a credential nor an ability to enable OCR; it merely makes an issued synthetic packet's bounded timings independently checkable in-process. Like the rest of the packet, it is deliberately unkeyed and is not a signature, configuration attestation, replay control, durable review state, send/apply authorization, or a provider capability. D7 through D9 supersede v6, and a future durable scoped host must resolve the real policy, state, revocation, and one-time decision semantics before any separate action.

## D7 — plain-own-data review boundary

D7 introduced `synthetic-document-review-packet-v7`. Its integrity material adds `dataBoundaryBinding`, fixed to `evidenceSource: "synthetic-fixture"`, `inputShape: "plain-own-data-only"`, and `rawDocumentContentAccepted: false`. The binding is a metadata statement of the enforced boundary; it neither accepts image bytes nor confers an OCR, provider, apply, send, or approval capability.

Both proposal intake and review-time revalidation accept only records with `Object.prototype` (or a null prototype) and own, enumerable data properties. Inherited values, non-enumerable “hidden” fields, symbol keys, getters, and setters are rejected before their values are read. This prevents a runtime object from smuggling unreviewed values through a prototype chain or executing an accessor during validation. A missing required value still reaches the existing field-specific fail-closed validator; an inherited or accessor replacement is rejected at the structural boundary. Packets v1 through v6 are deliberately non-reviewable, and D7 still provides no signature, durable replay control, persistence, send/apply action, or live-provider capability. D8 and D9 supersede v7 for newly issued packets.

## D8 — canonical maker–checker identity

D8 introduced `synthetic-document-review-packet-v8`. Its integrity material adds a fixed `makerCheckerBinding`: `actorIdentity: "ascii-case-insensitive-trimmed"` and `independentReviewerRequired: true`. Proposal creation preserves the validated, trimmed maker display value for audit readability, but independent-review comparison uses its ASCII case-insensitive identity. Thus `maker@example.test`, `MAKER@example.test`, and leading/trailing-whitespace variants are the same maker and cannot approve or reject their own proposal.

The validator rejects missing, extra, inherited, hidden, accessor-backed, or altered maker–checker bindings before the review audit append; v1 through v7 packets are deliberately non-reviewable. The comparison is deliberately conservative: where two accepted ASCII IDs differ only by case, the module denies self-review rather than treating them as independent. D8 adds neither a credential nor authentication claim, durable replay state, send/apply authority, provider integration, or a live mode. D9 supersedes v8 for newly issued packets.

## D9 — dense own-data collection boundary

New proposals use `synthetic-document-review-packet-v9`. Its integrity material adds a fixed `collectionBoundaryBinding`: `collectionShape: "array-prototype-dense-own-data-only"`, `sparseOrInheritedElementsAccepted: false`, and `accessorElementsAccepted: false`.

Before input or proposal-field elements are read, the module inspects their array descriptors. A field collection must be a bounded dense array with exactly its own numbered, enumerable data elements and the normal `Array.prototype`; holes, inherited elements, extra string or symbol properties, a substituted prototype, hidden indexes, and getters or setters are rejected. The same rule is re-run at review time before audit append. Missing, extra, inherited, hidden, accessor-backed, or altered collection bindings are also rejected; v1 through v8 packets are deliberately non-reviewable. D9 remains metadata-only and does not add a credential, OCR/provider client, persistence, replay state, approval authority, apply/send path, or live mode.

## Safe configuration

These values configure a synthetic proposal limit only; they cannot enable a provider or a live execution path:

```dotenv
GCL_VISION_LIVE_MODE=LIVE_DISABLED
GCL_VISION_MAX_COST_CENTS=20
GCL_VISION_MAX_ITEMS=1
GCL_VISION_MAX_REVIEW_AGE_SECONDS=3600
GCL_VISION_MAX_EVIDENCE_AGE_SECONDS=3600
GCL_VISION_DAILY_RUN_QUOTA=5
GCL_VISION_DAILY_ITEM_QUOTA=5
```

No migration is added. Durable audit (`gcl-audit`) and usage (`gcl-vision-usage`) records use the existing `Record` table when a future product-owned wiring layer deliberately constructs `PrismaHashChainAuditLog` and `PrismaDailyConnectorQuota`. D1–D9 add no persistence, review-state mutation, migration, credential, or network client.

## ADOS controls

The contract keeps product data/runtime isolated, default-denies missing policy inputs, uses evidence references rather than raw content, requires owner authority plus independent checker review, produces a scoped hash-chain audit, makes AI/OCR suggestion-only, and treats any future launch/live adapter as a separate owner decision. D1 additionally rejects review-packet tampering and cross-scope review before audit; D2 default-denies stale consent evidence; D3 default-denies a packet outside its bounded review window; D4 default-denies stale synthetic evidence references; D5 default-denies a causally inconsistent packet or a review deadline beyond consent; D6 default-denies timing values that cannot be exactly re-derived from the issued synthetic governance limits; D7 default-denies inherited, hidden, symbol-keyed, or accessor-backed records before their values can influence a proposal or review audit; D8 default-denies case or whitespace aliases of the proposal maker before a review decision can be audited; D9 default-denies sparse, inherited, extra, symbol-keyed, or accessor-backed field-array elements before they can influence a proposal or review audit. It makes no migration, promotion, publication, or provider request.
