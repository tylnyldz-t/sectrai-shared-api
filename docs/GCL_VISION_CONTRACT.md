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

The v4 integrity material adds `evidenceBinding.capturedAt` and `evidenceBinding.expiresAt`. The capture time must exactly match the metadata-only evidence reference; no raw bytes, policy text, token, or credential is added. `reviewBy` is the earliest of the bounded review interval, consent expiry, and evidence expiry. At review time, expiry at the exact evidence boundary is denied before audit. The validator also rejects missing or extra binding fields, non-canonical/zero/negative/over-one-day windows, capture-time mismatch, a review deadline beyond evidence freshness, integrity changes, and all v1/v2/v3 packets; D5 through D14 supersede v4 for newly issued packets.

D4 limits only the in-process lifetime of synthetic evidence metadata. It is not revocation lookup, a signature, durable one-time decision state, a retention store, a send/apply authorization, or an OCR/provider capability. A future durable, scoped host must still resolve the proposal and enforce revocation and replay semantics before any separate action.

## D5 — causally coherent review timeline

The v5 packet required a coherent metadata-only timeline: the evidence capture cannot occur after the packet issue time, and `reviewBy` cannot exceed either the consent expiry or the evidence-freshness expiry. Equality at a deadline is not accepted for a review because expiry checks remain inclusive (`expiresAt <= review time` and `reviewBy <= review time`).

The checks run before a review audit append, including for accidentally altered in-process packets whose integrity digest no longer matches. D5 intentionally does not turn the unkeyed digest into a signature or durable replay control; D6 through D14 supersede it for newly issued packets and a future scoped host must still resolve state, revocation, and one-time decisions before any separate action.

## D6 — governance-derived expiry and deadline

D6 introduced `synthetic-document-review-packet-v6`. Its integrity material adds a metadata-only `governanceBinding` with the exact positive, one-day-capped `maxReviewAgeSeconds` and `maxEvidenceAgeSeconds` used when the synthetic packet was issued. The validator now re-derives both `evidenceBinding.expiresAt` (`capturedAt + maxEvidenceAgeSeconds`) and `reviewWindow.reviewBy` (the earliest of `issuedAt + maxReviewAgeSeconds`, consent expiry, and evidence expiry). A packet with a shortened, extended, missing, extra, malformed, or non-derived timestamp is rejected before the review audit append.

The binding contains neither a credential nor an ability to enable OCR; it merely makes an issued synthetic packet's bounded timings independently checkable in-process. Like the rest of the packet, it is deliberately unkeyed and is not a signature, configuration attestation, replay control, durable review state, send/apply authorization, or a provider capability. D7 through D14 supersede v6, and a future durable scoped host must resolve the real policy, state, revocation, and one-time decision semantics before any separate action.

## D7 — plain-own-data review boundary

D7 introduced `synthetic-document-review-packet-v7`. Its integrity material adds `dataBoundaryBinding`, fixed to `evidenceSource: "synthetic-fixture"`, `inputShape: "plain-own-data-only"`, and `rawDocumentContentAccepted: false`. The binding is a metadata statement of the enforced boundary; it neither accepts image bytes nor confers an OCR, provider, apply, send, or approval capability.

For proposal intake, the proposal envelope, the review packet, and its fixed binding records, D7 accepts only records with `Object.prototype` (or a null prototype) and own, enumerable data properties. Inherited values, non-enumerable “hidden” fields, symbol keys, getters, and setters are rejected before their values are read. This prevents a runtime object from smuggling unreviewed values through a prototype chain or executing an accessor during validation. A missing required value still reaches the existing field-specific fail-closed validator; an inherited or accessor replacement is rejected at the structural boundary. D12 extends this descriptor-before-value rule to every individual proposal-field record; D13 rejects a Node-detected Proxy before any reflective check. Packets v1 through v6 are deliberately non-reviewable, and D7 still provides no signature, durable replay control, persistence, send/apply action, or live-provider capability. D8 through D14 supersede v7 for newly issued packets.

## D8 — canonical maker–checker identity

D8 introduced `synthetic-document-review-packet-v8`. Its integrity material adds a fixed `makerCheckerBinding`: `actorIdentity: "ascii-case-insensitive-trimmed"` and `independentReviewerRequired: true`. Proposal creation preserves the validated, trimmed maker display value for audit readability, but independent-review comparison uses its ASCII case-insensitive identity. Thus `maker@example.test`, `MAKER@example.test`, and leading/trailing-whitespace variants are the same maker and cannot approve or reject their own proposal.

The validator rejects missing, extra, inherited, hidden, accessor-backed, or altered maker–checker bindings before the review audit append; v1 through v7 packets are deliberately non-reviewable. The comparison is deliberately conservative: where two accepted ASCII IDs differ only by case, the module denies self-review rather than treating them as independent. D8 adds neither a credential nor authentication claim, durable replay state, send/apply authority, provider integration, or a live mode. D9 through D14 supersede v8 for newly issued packets.

## D9 — dense own-data collection boundary

D9 introduced `synthetic-document-review-packet-v9`. Its integrity material adds a fixed `collectionBoundaryBinding`: `collectionShape: "array-prototype-dense-own-data-only"`, `sparseOrInheritedElementsAccepted: false`, and `accessorElementsAccepted: false`.

Before input or proposal-field elements are read, the module inspects their array descriptors. A field collection must be a bounded dense array with exactly its own numbered, enumerable data elements and the normal `Array.prototype`; holes, inherited elements, extra string or symbol properties, a substituted prototype, hidden indexes, and getters or setters are rejected. The same rule is re-run at review time before audit append. Missing, extra, inherited, hidden, accessor-backed, or altered collection bindings are also rejected; v1 through v8 packets are deliberately non-reviewable. D9 remains metadata-only and does not add a credential, OCR/provider client, persistence, replay state, approval authority, apply/send path, or live mode. D10 through D14 supersede v9 for newly issued packets.

## D10 — well-formed Unicode string boundary

D10 introduced `synthetic-document-review-packet-v10`. Its integrity material adds a fixed `stringBoundaryBinding`: `valueEncoding: "well-formed-unicode-utf8"`, `controlCharactersAccepted: false`, and `unpairedSurrogateCodeUnitsAccepted: false`.

JavaScript strings can contain lone UTF-16 surrogate code units even though they have no unambiguous UTF-8 byte representation. The adapter rejects a lone high or low surrogate in every bounded fixture/proposal string before a value digest, fields digest, proposal ID, or review audit can depend on it. Valid surrogate pairs remain accepted. Review revalidation performs the same check before comparing field digests, and rejects missing, extra, inherited, hidden, accessor-backed, or altered string bindings; v1 through v9 packets are deliberately non-reviewable.

D10 does not normalize, reinterpret, repair, or retain raw document text. It adds no credential, OCR/provider client, signature, persistence, replay control, approval authority, apply/send path, or live mode; it only denies an encoding-ambiguous synthetic value before it can enter the in-process integrity material. D11 through D14 supersede v10 for newly issued packets.

## D11 — exact clock-object boundary

D11 introduced `synthetic-document-review-packet-v11`. Its integrity material adds a fixed `timeBoundaryBinding`: `clockValue: "utc-epoch-milliseconds"`, `clockObject: "exact-date-prototype-no-own-properties"`, and `issuedAtSource: "validated-run-context-clock"`.

The governed runner samples its configured clock exactly once before preflight. It accepts only a valid built-in `Date` with the exact `Date.prototype` and no own properties, extracts the epoch with the intrinsic `Date.prototype.getTime`, and copies that value into fresh built-in dates for preflight, proposal issue time, quota, provenance, and audit events. A subclass, proxy, invalid date, or a date carrying an overridden/accessor `getTime` or `toISOString` is denied without reading that property. Direct connector and review entry points enforce the same exact-clock rule before a synthetic packet deadline or review audit can be evaluated.

Review revalidation requires the exact, integrity-bound time-binding fields. Missing, extra, inherited, hidden, accessor-backed, or altered bindings are rejected before audit append; v1 through v10 packets are deliberately non-reviewable. D11 is not clock attestation, a signature, credential, replay mechanism, durable review state, apply/send authorization, provider integration, or live mode. It only denies an object-injected or unstable in-process clock before it can affect synthetic timing. D12 through D14 supersede v11 for newly issued packets.

## D12 — proposal-field record descriptor boundary

`synthetic-document-review-packet-v12` added a fixed `fieldRecordBoundaryBinding`: `fieldRecordShape: "plain-own-enumerable-data-only"`, `fieldDescriptorsValidatedBeforeValues: true`, and `accessorFieldPropertiesAccepted: false`.

At review time, every dense array element is first checked as a plain own record with only the known proposal-field keys before the validator reads `field`, `status`, `privacy`, `valueDigest`, `value`, `maskedValue`, or `confidence`. The privacy-specific exact key set is then checked before its optional value is read. Thus an inherited, hidden, symbol-keyed, extra, getter-backed, or setter-backed field property cannot run code or influence field ordering, sensitivity handling, a digest check, or an audit decision. The binding itself receives the same plain-own descriptor validation and is included in the unkeyed integrity material. Packets v1 through v11 are deliberately non-reviewable.

D12 neither authenticates a field record nor makes the unkeyed packet a signature, capability, durable replay control, apply/send authorization, persistence action, provider client, or live OCR path. It only fails closed before an in-process proposal-field value can influence a review audit.

## D13 — proxy-free synthetic object graph

D13 introduced `synthetic-document-review-packet-v13`. Its integrity material adds a fixed `proxyBoundaryBinding`: `proxyDetection: "node-util-types-isProxy"`, `proxyObjectsAccepted: false`, and `proxyArraysAccepted: false`.

Before calling `Object.getPrototypeOf`, `Reflect.ownKeys`, `Object.getOwnPropertyDescriptor`, or reading a value, the Node runtime checks every record and field array at the synthetic input and review boundaries with `node:util` `types.isProxy`. A proxy can otherwise run arbitrary traps during structural validation; D13 rejects proxy-wrapped proposal envelopes, evidence/binding records, field records, arrays, and even revoked array proxies before those traps run. The fixed binding is descriptor-validated and included in the unkeyed integrity material. Packets v1 through v12 are deliberately non-reviewable.

D13 is a local Node runtime boundary, not a cross-runtime proof, a signature, credential, provider capability, replay control, durable state change, apply/send authorization, or OCR path. It introduces no network client or raw document handling. D14 supersedes v13 for newly issued packets.

## D14 — checked date-arithmetic boundary

D14 introduced `synthetic-document-review-packet-v14`. Its integrity material adds a fixed `dateArithmeticBoundaryBinding`: `arithmetic: "checked-utc-epoch-milliseconds"`, `overflowAccepted: false`, and `invalidDateAccepted: false`.

Even a canonical ISO timestamp can sit close enough to the ECMAScript `Date` limit that adding a one-day-capped synthetic evidence or review interval would produce an invalid date. Before generating or re-deriving `evidenceBinding.expiresAt` and `reviewWindow.reviewBy`, D14 checks the epoch-millisecond addition against the ECMAScript time-value limit. Overflow, an unsafe result, or an invalid result is rejected with a controlled input error before audit or quota reservation; it never leaks a `RangeError`, serializes an invalid date, or lets `NaN` affect a deadline comparison. Review revalidation applies the same checks before it compares integrity material or appends an audit event.

The fixed binding is plain-own descriptor-validated and integrity-bound. Missing, extra, inherited, hidden, accessor-backed, or altered bindings are rejected; v1 through v13 packets are deliberately non-reviewable. D14 is not timestamp attestation, a signature, credential, provider capability, durable replay control, persistence action, apply/send authorization, or a live OCR path. It introduces no network client, raw-document handling, or migration. D15 supersedes v14 for newly issued packets.

## D15 — canonical integrity-encoding boundary

New proposals use `synthetic-document-review-packet-v15`. Its integrity material adds a fixed `integrityEncodingBoundaryBinding`: `encoding: "canonical-json-utf8"`, `objectKeyOrder: "utf16-code-unit-ascending"`, `toJsonHooksAccepted: false`, and `inheritedSerializationAccepted: false`.

Before a fields digest or review-packet integrity digest is hashed, D15 builds canonical JSON from own enumerable data descriptors. Record keys are sorted by UTF-16 code-unit order; array position is retained. Only scalar values use the JSON encoder captured when this module loads, so an own or inherited `toJSON` hook and a later replacement of `JSON.stringify` cannot alter the bytes under review. This rule runs when a synthetic proposal is issued and again before a review audit append. Missing, extra, inherited, hidden, accessor-backed, or altered boundary fields deny review; v1 through v14 packets are deliberately non-reviewable.

D15 is a deterministic in-process encoding boundary, not a signature, credential, external authenticity proof, durable replay control, provider client, apply/send authorization, or live OCR path. It accepts no raw document content, makes no network request, and introduces no migration. D16 supersedes v15 for newly issued packets.

## D16 — module-captured intrinsic boundary

New proposals use `synthetic-document-review-packet-v16`. Its integrity material adds a fixed `intrinsicBoundaryBinding`: `runtimeIntrinsics: "module-captured-ecmascript-structural-temporal-and-encoding-intrinsics"`, `latePatchedGlobalsAccepted: false`, and `prototypeMethodHooksAccepted: false`.

At module initialization, the adapter captures the structural, temporal, and encoding operations which validate or encode untrusted synthetic data: own-property and prototype reflection, own-key enumeration, array classification/collection helpers, Date construction and epoch/ISO operations, numeric and deadline arithmetic checks, Set membership, bounded string normalization/inspection, and scalar JSON encoding. Proposal issue and review then use those captured operations rather than mutable global or prototype lookups. A late replacement of these selected globals or prototype methods therefore cannot alter field ordering, descriptor checks, temporal derivation, actor normalization, or packet-integrity bytes. The same boundary is revalidated before a review audit append; missing, extra, inherited, hidden, accessor-backed, altered, or v1–v15 packets are denied.

D16 is not a JavaScript sandbox and does not attest to a clean realm before this module loads. It is also not a signature, credential, external authenticity proof, durable replay control, provider capability, persistence action, or apply/send authorization. It accepts no raw document content, makes no network request, and adds no migration. D17 supersedes v16 for newly issued packets.

## D17 — module-captured hash-operation boundary

New proposals use `synthetic-document-review-packet-v17`. Its integrity material adds a fixed `hashBoundaryBinding`: `algorithm: "sha256"`, `digestEncoding: "hex-lowercase"`, `implementation: "module-captured-node-crypto-hash-methods"`, and `latePatchedHashMethodsAccepted: false`.

At module initialization, the adapter captures Node's `createHash` function and the `Hash.prototype.update` and `Hash.prototype.digest` operations. All field, scope, proposal-ID, consent-policy, and review-packet digests then use those captured operations. A later mutation of the public `Hash` prototype therefore cannot substitute a digest, throw while a proposal is issued, or alter the integrity comparison before a review audit append. The fixed binding is descriptor-validated and integrity-bound; missing, extra, inherited, hidden, accessor-backed, altered, or v1–v16 packets are denied.

D17 is not a signature, credential, clean-realm attestation, external authenticity proof, durable replay control, provider capability, persistence action, or apply/send authorization. It accepts no raw document content, makes no network request, and adds no migration. D18 supersedes v17 for newly issued packets.

## D18 — module-captured regex-validation boundary

New proposals use `synthetic-document-review-packet-v18`. Its integrity material adds a fixed `patternBoundaryBinding`: `validation: "module-captured-regexp-exec"`, `latePatchedRegExpMethodsAccepted: false`, and `patternMatcherHooksAccepted: false`.

At module initialization, the adapter captures `RegExp.prototype.exec`. Evidence IDs, SHA-256 digests, policy versions, actor IDs, proposal IDs, scope IDs, and numeric environment limits are then checked by calling that captured intrinsic directly against the adapter's private anchored patterns. A later replacement of public `RegExp.prototype.test` or `RegExp.prototype.exec` therefore cannot turn an invalid value into an accepted one, or interrupt proposal issue and review validation. The fixed binding is descriptor-validated and integrity-bound; missing, extra, inherited, hidden, accessor-backed, altered, or v1–v17 packets are denied.

D18 is not a regex sandbox, signature, credential, clean-realm attestation, external authenticity proof, durable replay control, provider capability, persistence action, or apply/send authorization. It accepts no raw document content, makes no network request, and adds no migration. D19 supersedes v18 for newly issued packets.

## D19 — module-captured Proxy-inspection boundary

New proposals use `synthetic-document-review-packet-v19`. Its integrity material adds a fixed `proxyInspectionBoundaryBinding`: `inspection: "module-captured-node-util-types-isProxy"`, `latePatchedInspectorAccepted: false`, and `inspectionFailureAccepted: false`.

At module initialization, the adapter captures Node's `node:util` `types.isProxy` operation. Every record and array therefore continues to be checked with that captured inspector before a structural reflection or a value read, even if another module later replaces the publicly reachable `types.isProxy` property. An unexpected inspector failure is converted into a controlled input denial; it never falls back to reflective inspection or accepts an uninspected object. The fixed binding is descriptor-validated and integrity-bound; missing, extra, inherited, hidden, accessor-backed, altered, or v1–v18 packets are denied before a review audit append.

D19 is not a proxy sandbox or a clean-realm attestation: a hostile change made before this module loads remains outside its scope. It is also not a signature, credential, external authenticity proof, durable replay control, provider capability, persistence action, or apply/send authorization. It accepts no raw document content, makes no network request, and adds no migration. D20 supersedes v19 for newly issued packets.

## D20 — strict audit-receipt boundary

New proposals use `synthetic-document-review-packet-v20`. Its integrity material adds a fixed `auditReceiptBoundaryBinding`: `receiptShape: "plain-own-enumerable-sha256-hash-only"`, `malformedReceiptAccepted: false`, and `reviewResultRequiresValidatedAuditHash: true`.

After the independent-review event is appended, the adapter treats the audit result as untrusted boundary data. It returns a `ReviewedDocumentProposal` only when that result is a non-Proxy, plain-own, enumerable `{ hash }` record with no extra, inherited, hidden, symbol-keyed, or accessor-backed fields, and its hash is exactly a lowercase SHA-256 value. A missing, malformed, upper-case, shortened, extended, accessor-backed, or Proxy receipt is a controlled denial; no successful review result or audit hash is reported to the caller. The audit sink itself remains responsible for its own atomic/durable append semantics: D20 cannot roll back an already-completed host append, and does not claim to create durable one-time review state.

The fixed binding is descriptor-validated and integrity-bound; missing, extra, inherited, hidden, accessor-backed, altered, or v1–v19 packets are denied before a review audit append. D20 is not a signature, credential, audit-chain verifier, external authenticity proof, persistence action, replay control, provider capability, apply/send authorization, or live OCR path. It accepts no raw document content, makes no network request, and adds no migration. D21 supersedes v20 for newly issued packets.

## D21 — fail-closed audit-append invocation boundary

New proposals use `synthetic-document-review-packet-v21`. Its integrity material adds a fixed `auditAppendBoundaryBinding`: `auditLog: "non-proxy-data-method-only"`, `appendResult: "native-promise-only"`, `accessorOrProxyAuditTargetsAccepted: false`, and `rejectedOrThenableAuditResultsAccepted: false`.

Before it appends the independent-review event, the adapter resolves `append` through own/prototype **data descriptors** without reading an accessor. The audit target and the resolved method are inspected with the module-captured Node Proxy inspector before a method call; an accessor, missing/non-function method, Proxy target, or Proxy method is denied without executing a trap. The method is called through a module-captured function-call intrinsic and must immediately return an exact native `Promise` (no thenable or Promise subclass). A synchronous throw or asynchronous rejection is converted to the controlled `DOCUMENT_REVIEW_AUDIT_APPEND_FAILED` denial. Only a fulfilled result continues to D20's strict receipt validation.

D21 prevents a malformed audit integration from being reported as an independent-review success; it does not make the audit sink durable, atomic, cryptographically authentic, or rollback-capable. It is not a signature, credential, provider capability, replay control, persistence action, apply/send authorization, or live OCR path. It accepts no raw document content, makes no network request, and adds no migration. Missing, extra, inherited, hidden, accessor-backed, altered, or v1–v20 packets are denied before a review audit append.

## D22 — audit-method provenance boundary

New proposals use `synthetic-document-review-packet-v22`. Its integrity material adds a fixed `auditMethodBoundaryBinding`: `appendMethod: "own-or-direct-prototype-data-method-only"`, `inheritedFromObjectPrototypeAccepted: false`, and `inheritedBeyondDirectPrototypeAccepted: false`.

Before invoking the audit append method, the adapter inspects only the audit target's own `append` data descriptor or, when absent, the target's direct non-`Object.prototype` prototype descriptor. It does not walk a longer prototype chain and never obtains `append` through `Object.prototype`. This prevents a polluted global prototype or an indirect inherited method from silently becoming a review audit sink. The descriptor, target, direct prototype, and method remain subject to D21's accessor/Proxy/native-Promise boundary. A valid own method or a normal direct class-prototype method remains supported.

D22 is a local fail-closed integration boundary, not a clean-realm guarantee, audit durability proof, signature, credential, provider capability, replay control, persistence action, apply/send authorization, or live OCR path. It accepts no raw document content, makes no network request, and adds no migration. Missing, extra, inherited, hidden, accessor-backed, altered, or v1–v21 packets are denied before a review audit append.

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

No migration is added. Durable audit (`gcl-audit`) and usage (`gcl-vision-usage`) records use the existing `Record` table when a future product-owned wiring layer deliberately constructs `PrismaHashChainAuditLog` and `PrismaDailyConnectorQuota`. D1–D22 add no persistence, durable review-state mutation, migration, credential, or network client.

## ADOS controls

The contract keeps product data/runtime isolated, default-denies missing policy inputs, uses evidence references rather than raw content, requires owner authority plus independent checker review, produces a scoped hash-chain audit, makes AI/OCR suggestion-only, and treats any future launch/live adapter as a separate owner decision. D1 additionally rejects review-packet tampering and cross-scope review before audit; D2 default-denies stale consent evidence; D3 default-denies a packet outside its bounded review window; D4 default-denies stale synthetic evidence references; D5 default-denies a causally inconsistent packet or a review deadline beyond consent; D6 default-denies timing values that cannot be exactly re-derived from the issued synthetic governance limits; D7 default-denies inherited, hidden, symbol-keyed, or accessor-backed records before their values can influence a proposal or review audit; D8 default-denies case or whitespace aliases of the proposal maker before a review decision can be audited; D9 default-denies sparse, inherited, extra, symbol-keyed, or accessor-backed field-array elements before they can influence a proposal or review audit; D10 default-denies lone UTF-16 surrogate code units before a fixture or proposal value can affect its digest, identifier, or review audit; D11 default-denies subclassed, proxied, invalid, or own-property-bearing clock objects before they influence preflight, a proposal deadline, quota, provenance, or review audit; D12 default-denies inherited, hidden, extra, symbol-keyed, or accessor-backed properties on each proposal-field record before any field value can influence ordering, privacy handling, integrity, or a review audit; D13 default-denies Node-detected Proxy objects and arrays before reflection or a value read can invoke an untrusted trap; D14 default-denies overflowing, unsafe, or invalid ECMAScript date arithmetic before it can affect an expiry, deadline, quota, provenance, or review audit; D15 default-denies serialization hooks and non-canonical packet encodings before they influence a field digest, integrity comparison, or review audit; D16 default-denies late-patched structural, temporal, collection, string, numeric, or encoding intrinsics before they can alter a synthetic proposal or review audit; D17 default-denies late-patched Node hash operations before they can alter a field, scope, proposal-ID, policy, or review-packet digest; D18 default-denies late-patched regex methods before they can weaken evidence, digest, policy, actor, proposal, scope, or numeric-limit validation; D19 default-denies a late-patched public Proxy inspector or an unexpected captured-inspector failure before it can permit reflective validation; D20 default-denies malformed audit acknowledgements before it returns an independent-review result; D21 default-denies accessor/Proxy audit targets, thenables, audit throws, and audit rejections before a review success is reported; D22 default-denies `append` inherited from `Object.prototype` or any indirect prototype before an audit method can be invoked. It makes no migration, promotion, publication, or provider request.
