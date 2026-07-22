import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, ConsentError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { visionDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { LIVE_DISABLED, SyntheticVisionDocumentFieldExtractionConnector, VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, independentlyReviewSyntheticDocumentProposal, syntheticVisionDocumentFieldExtractionConnectorFromEnvironment, type DocumentFieldExtractionData, type SyntheticDocumentScanInput } from '../src/gcl/vision.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gm2-test', workspaceId: 'vision-workspace', actor: 'maker@example.test', ownerApproved: true,
  scopes: ['vision:document-field-extraction'], costCapCents: 20, requestedItems: 1, now,
}
const input: SyntheticDocumentScanInput = {
  evidence: {
    source: 'synthetic-fixture', evidenceId: 'synthetic-evidence-bill-of-lading-01',
    sha256: 'a'.repeat(64), mediaType: 'image/jpeg', byteLength: 2048, capturedAt: '2026-07-22T11:59:00.000Z',
  },
  consent: { purpose: 'document-field-extraction', status: 'granted', policyVersion: 'kvkk-v1', expiresAt: '2026-07-23T12:00:00.000Z' },
  syntheticFields: [
    { field: 'containerId', value: 'MSCU-1234567' },
    { field: 'referenceNumber', value: 'REF-2026-001' },
    { field: 'senderName', value: 'Synthetic Sender Ltd.' },
    { field: 'senderAddress', value: 'Synthetic Address 1, Istanbul' },
    { field: 'identityNumber', value: '11111111111' },
  ],
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

function configuredConnector(maxReviewAgeSeconds = 60, maxEvidenceAgeSeconds = 300): SyntheticVisionDocumentFieldExtractionConnector {
  return new SyntheticVisionDocumentFieldExtractionConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 1, maxReviewAgeSeconds, maxEvidenceAgeSeconds })
}

test('GM2 vision adapter is synthetic-only and has no provider client or default governance limits', async () => {
  const connector = new SyntheticVisionDocumentFieldExtractionConnector()
  await assert.rejects(() => connector.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  assert.equal('fetch' in connector, false)
})

test('GM2 rejects every mode other than LIVE_DISABLED before it can create an extraction proposal', async () => {
  const connector = new SyntheticVisionDocumentFieldExtractionConnector({ liveMode: 'LIVE_ENABLED', maxCostCapCents: 20, maxItems: 1 })
  await assert.rejects(() => connector.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_FIELD_EXTRACTION_LIVE_DISABLED')
})

test('raw document content, missing consent, and malformed fixture data fail before audit or quota reservation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, evidence: { ...input.evidence, source: 'camera' } }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'RAW_DOCUMENT_CONTENT_NOT_ACCEPTED')
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, consent: { ...input.consent, status: 'pending' } }, ...context }), ConsentError)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, syntheticFields: [{ field: 'containerId', value: 'ok', base64: 'forbidden' }] }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_SYNTHETIC_DOCUMENT_FIELD')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('GM2 rejects stale or boundary evidence, expired consent, duplicate fields, control characters, and blank makers before reservation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const request = { connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, ...context }
  await assert.rejects(() => runner.run({ ...request, input: { ...input, evidence: { ...input.evidence, byteLength: 0 } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_EVIDENCE_SIZE')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, evidence: { ...input.evidence, capturedAt: '2026-07-22T12:00:00.001Z' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_CAPTURE_TIME')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, evidence: { ...input.evidence, capturedAt: '2026-07-22T11:55:00.000Z' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_EVIDENCE_STALE')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, consent: { ...input.consent, expiresAt: '2026-07-22T12:00:00.000Z' } } }), (error: unknown) => error instanceof ConsentError && error.message === 'DOCUMENT_CONSENT_EXPIRED')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, syntheticFields: [...input.syntheticFields, { field: 'containerId', value: 'duplicate' }] } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_FIELD')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, syntheticFields: [{ field: 'containerId', value: 'unsafe\u0000value' }] } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_VALUE')
  await assert.rejects(() => runner.run({ ...request, actor: '   ', input }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_CONTEXT')
  await assert.rejects(() => runner.run({ ...request, product: 1 as never, input }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_CONTEXT')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('GM2 run requires owner gate, scope, cost cap, quota, consent, and creates only a masked pending proposal', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context, ownerApproved: false }), OwnerGateError)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context, scopes: ['vision:read'] }), ScopeError)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context, costCapCents: 21 }), CostCapError)
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context, requestedItems: 2 }), CostCapError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const proposal = result.data.proposal
  assert.equal(result.data.mode, LIVE_DISABLED)
  assert.equal(proposal.extraction, 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR')
  assert.equal(proposal.evidence.rawContentStored, false)
  assert.equal(proposal.ownerReview.status, 'pending')
  assert.equal(proposal.ownerReview.automaticApply, false)
  assert.equal(proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.match(proposal.reviewPacket.integrityDigest, /^[a-f0-9]{64}$/)
  assert.equal(proposal.reviewPacket.scopeBinding.productDigest.length, 64)
  assert.equal(proposal.reviewPacket.consentBinding.purpose, 'document-field-extraction')
  assert.match(proposal.reviewPacket.consentBinding.policyVersionDigest, /^[a-f0-9]{64}$/)
  assert.equal(proposal.reviewPacket.consentBinding.expiresAt, input.consent.expiresAt)
  assert.equal(JSON.stringify(proposal.reviewPacket).includes('kvkk-v1'), false)
  assert.deepEqual(proposal.reviewPacket.governanceBinding, { maxReviewAgeSeconds: 60, maxEvidenceAgeSeconds: 300 })
  assert.deepEqual(proposal.reviewPacket.dataBoundaryBinding, { evidenceSource: 'synthetic-fixture', inputShape: 'plain-own-data-only', rawDocumentContentAccepted: false })
  assert.deepEqual(proposal.reviewPacket.makerCheckerBinding, { actorIdentity: 'ascii-case-insensitive-trimmed', independentReviewerRequired: true })
  assert.deepEqual(proposal.reviewPacket.collectionBoundaryBinding, { collectionShape: 'array-prototype-dense-own-data-only', sparseOrInheritedElementsAccepted: false, accessorElementsAccepted: false })
  assert.deepEqual(proposal.reviewPacket.stringBoundaryBinding, { valueEncoding: 'well-formed-unicode-utf8', controlCharactersAccepted: false, unpairedSurrogateCodeUnitsAccepted: false })
  assert.deepEqual(proposal.reviewPacket.timeBoundaryBinding, { clockValue: 'utc-epoch-milliseconds', clockObject: 'exact-date-prototype-no-own-properties', issuedAtSource: 'validated-run-context-clock' })
  assert.deepEqual(proposal.reviewPacket.fieldRecordBoundaryBinding, { fieldRecordShape: 'plain-own-enumerable-data-only', fieldDescriptorsValidatedBeforeValues: true, accessorFieldPropertiesAccepted: false })
  assert.deepEqual(proposal.reviewPacket.proxyBoundaryBinding, { proxyDetection: 'node-util-types-isProxy', proxyObjectsAccepted: false, proxyArraysAccepted: false })
  assert.equal(proposal.reviewPacket.evidenceBinding.capturedAt, input.evidence.capturedAt)
  assert.equal(proposal.reviewPacket.evidenceBinding.expiresAt, '2026-07-22T12:04:00.000Z')
  assert.equal(proposal.reviewPacket.reviewWindow.issuedAt, now().toISOString())
  assert.equal(proposal.reviewPacket.reviewWindow.reviewBy, '2026-07-22T12:01:00.000Z')
  assert.equal(proposal.reviewPacket.rawDocumentContentIncluded, false)
  assert.equal(proposal.mesaEvidenceHandoff.sent, false)
  assert.equal(proposal.mesaEvidenceHandoff.referenceOnly, true)
  assert.equal(proposal.fields.find((field) => field.field === 'containerId')?.value, 'MSCU-1234567')
  const sensitive = proposal.fields.find((field) => field.field === 'senderAddress')
  assert.equal(sensitive?.privacy, 'kvkk-masked')
  assert.equal(sensitive?.value, undefined)
  assert.match(sensitive?.maskedValue ?? '', /^KVKK_MASKED:[a-f0-9]{16}$/)
  assert.equal(proposal.fields.find((field) => field.field === 'identityNumber')?.value, undefined)
  assert.equal(result.confidence, 0)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(quota.requests.length, 1)
  assert.deepEqual(quota.requests[0], { connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, requestedItems: 1 })
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
})

test('a separate checker can record a decision, but neither decision sends or applies the evidence', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(result.data.proposal, 'approved', true, context.actor, audit, context), (error: unknown) => error instanceof MakerCheckerError && error.message === 'DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(result.data.proposal, 'approved', false, 'checker@example.test', audit, context), OwnerGateError)
  const reviewed = await independentlyReviewSyntheticDocumentProposal(result.data.proposal, 'approved', true, 'checker@example.test', audit, context)
  assert.equal(reviewed.ownerReview.status, 'approved')
  assert.equal(reviewed.ownerReview.reviewer, 'checker@example.test')
  assert.equal(reviewed.mesaEvidenceHandoff.sent, false)
  assert.equal(reviewed.mesaEvidenceHandoff.rawContentIncluded, false)
  assert.equal(reviewed.mesaEvidenceHandoff.state, 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED')
  assert.equal(reviewed.auditHash, audit.entries[2]?.hash)
  assert.equal(audit.entries[2]?.previousHash, audit.entries[1]?.hash)
  assert.equal(audit.entries[2]?.event.type, 'connector.document.owner_reviewed')
  assert.equal(reviewed.reviewPacketIntegrityDigest, result.data.proposal.reviewPacket.integrityDigest)
  assert.equal(audit.entries[2]?.event.detail.reviewPacketIntegrityDigest, result.data.proposal.reviewPacket.integrityDigest)
})

test('D1 rejects altered, cross-scope, non-pending, malformed-decision, and raw-sensitive review packets before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const proposal = result.data.proposal
  const clone = () => JSON.parse(JSON.stringify(proposal)) as typeof proposal

  const alteredValue = clone()
  alteredValue.fields.find((field) => field.field === 'containerId')!.value = 'altered-after-review'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(alteredValue, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_PROPOSAL_FIELD_DIGEST_MISMATCH')

  const rawSensitiveValue = clone()
  rawSensitiveValue.fields.find((field) => field.field === 'senderName')!.value = 'must-not-be-reintroduced'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(rawSensitiveValue, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, { ...context, workspaceId: 'another-workspace' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_PROPOSAL_SCOPE_MISMATCH')

  const nonPending = clone()
  nonPending.ownerReview.status = 'approved'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(nonPending, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_PROPOSAL_NOT_PENDING_OWNER_REVIEW')

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'send' as never, true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_DECISION')
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, '   ', audit, context), (error: unknown) => error instanceof OwnerGateError && error.message === 'OWNER_REVIEWER_REQUIRED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D2 consent binding remains enforced under D3 packets and rejects legacy or altered packets before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const consentExpiringSoon = { ...input, consent: { ...input.consent, expiresAt: '2026-07-22T12:01:00.000Z' } }
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: consentExpiringSoon, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  const expiredReviewContext = { ...context, now: () => new Date('2026-07-22T12:01:00.000Z') }

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, expiredReviewContext), (error: unknown) => error instanceof ConsentError && error.message === 'DOCUMENT_REVIEW_CONSENT_EXPIRED')

  const alteredExpiry = clone()
  alteredExpiry.reviewPacket.consentBinding.expiresAt = '2026-07-23T12:00:00.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(alteredExpiry, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_INTEGRITY_MISMATCH')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { consentBinding?: unknown }).consentBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_CONSENT_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.consentBinding as { untrusted?: unknown }).untrusted = true
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_CONSENT_BINDING_FIELD')

  const malformedBindingExpiry = clone()
  malformedBindingExpiry.reviewPacket.consentBinding.expiresAt = 'not-a-timestamp'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(malformedBindingExpiry, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_CONSENT_EXPIRY')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v3' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, { ...context, now: (() => new Date('invalid')) as typeof context.now }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_TIME')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D3 bounds review time and rejects an expired, pre-issued, malformed, oversized, or altered review window before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60)]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  const reviewAt = (value: string) => ({ ...context, now: () => new Date(value) })

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, reviewAt('2026-07-22T12:01:00.000Z')), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_WINDOW_EXPIRED')
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, reviewAt('2026-07-22T11:59:59.999Z')), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_TIME_BEFORE_ISSUED')

  const missingWindow = clone()
  delete (missingWindow.reviewPacket as { reviewWindow?: unknown }).reviewWindow
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingWindow, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_WINDOW')

  const extraWindowField = clone()
  ;(extraWindowField.reviewPacket.reviewWindow as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraWindowField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_WINDOW_FIELD')

  const oversizedWindow = clone()
  oversizedWindow.reviewPacket.reviewWindow.reviewBy = '2026-07-23T12:00:00.001Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(oversizedWindow, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_WINDOW')

  const alteredWindow = clone()
  alteredWindow.reviewPacket.reviewWindow.reviewBy = '2026-07-22T12:00:30.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(alteredWindow, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_WINDOW_DERIVATION_MISMATCH')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D4 binds reviewability to fresh evidence and rejects stale, legacy, malformed, or extended evidence windows before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(300, 60)]), audit, quota, now)
  const freshInput = { ...input, evidence: { ...input.evidence, capturedAt: '2026-07-22T11:59:30.000Z' } }
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: freshInput, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal

  assert.equal(result.data.proposal.reviewPacket.evidenceBinding.capturedAt, freshInput.evidence.capturedAt)
  assert.equal(result.data.proposal.reviewPacket.evidenceBinding.expiresAt, '2026-07-22T12:00:30.000Z')
  assert.equal(result.data.proposal.reviewPacket.reviewWindow.reviewBy, '2026-07-22T12:00:30.000Z')

  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, { ...context, now: () => new Date('2026-07-22T12:00:30.000Z') }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_EVIDENCE_EXPIRED')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { evidenceBinding?: unknown }).evidenceBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_EVIDENCE_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.evidenceBinding as { untrusted?: unknown }).untrusted = true
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_EVIDENCE_BINDING_FIELD')

  const captureMismatch = clone()
  captureMismatch.reviewPacket.evidenceBinding.capturedAt = '2026-07-22T11:59:31.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(captureMismatch, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_EVIDENCE_CAPTURE_MISMATCH')

  const extendedEvidence = clone()
  extendedEvidence.reviewPacket.evidenceBinding.expiresAt = '2026-07-22T12:00:45.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extendedEvidence, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_EVIDENCE_EXPIRY_MISMATCH')

  const reviewBeyondEvidence = clone()
  reviewBeyondEvidence.reviewPacket.reviewWindow.reviewBy = '2026-07-22T12:00:31.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(reviewBeyondEvidence, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_WINDOW_EXCEEDS_EVIDENCE_FRESHNESS')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v4' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D5 requires a causally coherent review timeline and refuses review deadlines beyond consent before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)
  const consentBoundInput = { ...input, consent: { ...input.consent, expiresAt: '2026-07-22T12:00:20.000Z' } }
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: consentBoundInput, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal

  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.equal(result.data.proposal.reviewPacket.reviewWindow.reviewBy, consentBoundInput.consent.expiresAt)

  const deadlineBeyondConsent = clone()
  deadlineBeyondConsent.reviewPacket.reviewWindow.reviewBy = '2026-07-22T12:00:21.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(deadlineBeyondConsent, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_WINDOW_EXCEEDS_CONSENT')

  const capturedAfterIssuance = clone()
  capturedAfterIssuance.evidence.capturedAt = '2026-07-22T12:00:00.001Z'
  capturedAfterIssuance.reviewPacket.evidenceBinding.capturedAt = '2026-07-22T12:00:00.001Z'
  capturedAfterIssuance.reviewPacket.evidenceBinding.expiresAt = '2026-07-22T12:05:00.001Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(capturedAfterIssuance, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_EVIDENCE_CAPTURE_AFTER_ISSUANCE')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v4' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D6 derives exact review and evidence deadlines from integrity-bound synthetic governance limits before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal

  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.governanceBinding, { maxReviewAgeSeconds: 60, maxEvidenceAgeSeconds: 300 })

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { governanceBinding?: unknown }).governanceBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_GOVERNANCE_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.governanceBinding as { untrusted?: unknown }).untrusted = true
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_GOVERNANCE_BINDING_FIELD')

  const invalidReviewLimit = clone()
  invalidReviewLimit.reviewPacket.governanceBinding.maxReviewAgeSeconds = 0
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(invalidReviewLimit, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_GOVERNANCE_BINDING')

  const shortenedEvidenceWindow = clone()
  shortenedEvidenceWindow.reviewPacket.evidenceBinding.expiresAt = '2026-07-22T12:03:59.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(shortenedEvidenceWindow, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_EVIDENCE_EXPIRY_MISMATCH')

  const shortenedReviewWindow = clone()
  shortenedReviewWindow.reviewPacket.reviewWindow.reviewBy = '2026-07-22T12:00:59.000Z'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(shortenedReviewWindow, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_WINDOW_DERIVATION_MISMATCH')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v5' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D7 rejects inherited, hidden, or accessor-backed data and validates its plain-own-data packet binding before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)

  const inheritedInput = Object.assign(Object.create({ evidence: input.evidence }), { consent: input.consent, syntheticFields: input.syntheticFields })
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: inheritedInput, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_VISION_DOCUMENT_REQUEST')

  const hiddenInput = { ...input } as Record<string, unknown>
  Object.defineProperty(hiddenInput, 'hiddenTrace', { enumerable: false, value: 'forbidden' })
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: hiddenInput, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_VISION_DOCUMENT_FIELD')

  const accessorInput = { ...input } as Record<string, unknown>
  let accessorRead = false
  Object.defineProperty(accessorInput, 'evidence', {
    enumerable: true,
    get: () => {
      accessorRead = true
      throw new Error('ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: accessorInput, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_VISION_DOCUMENT_FIELD')
  assert.equal(accessorRead, false)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.dataBoundaryBinding, { evidenceSource: 'synthetic-fixture', inputShape: 'plain-own-data-only', rawDocumentContentAccepted: false })

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { dataBoundaryBinding?: unknown }).dataBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.dataBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.dataBoundaryBinding.inputShape = 'inherited-properties-allowed' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING')

  const inheritedBinding = clone()
  inheritedBinding.reviewPacket.dataBoundaryBinding = Object.create(inheritedBinding.reviewPacket.dataBoundaryBinding) as typeof inheritedBinding.reviewPacket.dataBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(inheritedBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING')

  const accessorPacket = clone()
  let packetAccessorRead = false
  Object.defineProperty(accessorPacket.reviewPacket, 'integrityDigest', {
    enumerable: true,
    get: () => {
      packetAccessorRead = true
      throw new Error('ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(accessorPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_FIELD')
  assert.equal(packetAccessorRead, false)

  const hiddenPacket = clone()
  Object.defineProperty(hiddenPacket.reviewPacket, 'hiddenTrace', { enumerable: false, value: 'forbidden' })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(hiddenPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_FIELD')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v7' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D8 canonical maker-checker identity remains enforced under D13 packets', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal

  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.makerCheckerBinding, { actorIdentity: 'ascii-case-insensitive-trimmed', independentReviewerRequired: true })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'MAKER@example.test', audit, context), (error: unknown) => error instanceof MakerCheckerError && error.message === 'DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, ' maker@example.test ', audit, context), (error: unknown) => error instanceof MakerCheckerError && error.message === 'DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { makerCheckerBinding?: unknown }).makerCheckerBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.makerCheckerBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.makerCheckerBinding.actorIdentity = 'case-sensitive' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v8' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)

  const trimmedMakerAudit = new InMemoryHashChainAuditLog()
  const trimmedMakerQuota = new TestQuota()
  const trimmedMakerRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), trimmedMakerAudit, trimmedMakerQuota, now)
  const trimmedMakerResult = await trimmedMakerRunner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context, actor: ' maker@example.test ' }) as ConnectorResult<DocumentFieldExtractionData>
  assert.equal(trimmedMakerResult.data.proposal.preparedBy, 'maker@example.test')
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(trimmedMakerResult.data.proposal, 'approved', true, 'MAKER@example.test', trimmedMakerAudit, context), (error: unknown) => error instanceof MakerCheckerError && error.message === 'DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  assert.equal(trimmedMakerAudit.entries.length, 2)
  assert.equal(trimmedMakerQuota.requests.length, 1)
})

test('D9 rejects sparse, accessor-backed, or extended field arrays before their elements are read or an audit is appended', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)

  const sparseFields: unknown[] = []
  sparseFields.length = input.syntheticFields.length
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, syntheticFields: sparseFields as typeof input.syntheticFields }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_FIELDS')

  const accessorFields = [...input.syntheticFields] as unknown as Record<string, unknown>
  let accessorRead = false
  Object.defineProperty(accessorFields, '0', {
    enumerable: true,
    get: () => {
      accessorRead = true
      throw new Error('ARRAY_ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, syntheticFields: accessorFields as unknown as typeof input.syntheticFields }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_FIELDS')
  assert.equal(accessorRead, false)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.collectionBoundaryBinding, { collectionShape: 'array-prototype-dense-own-data-only', sparseOrInheritedElementsAccepted: false, accessorElementsAccepted: false })

  const accessorProposal = clone()
  let proposalAccessorRead = false
  Object.defineProperty(accessorProposal.fields, '0', {
    enumerable: true,
    get: () => {
      proposalAccessorRead = true
      throw new Error('ARRAY_ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(accessorProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_PROPOSAL_FIELDS')
  assert.equal(proposalAccessorRead, false)

  const extraArrayProperty = clone()
  ;(extraArrayProperty.fields as unknown as Record<string, unknown>).untrusted = true
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraArrayProperty, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_PROPOSAL_FIELDS')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { collectionBoundaryBinding?: unknown }).collectionBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.collectionBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.collectionBoundaryBinding.accessorElementsAccepted = true as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v8' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D10 binds well-formed UTF-8 text handling and rejects ambiguous surrogate values before reservation or review audit', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)

  await assert.rejects(() => runner.run({
    connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID,
    input: { ...input, syntheticFields: [{ field: 'containerId', value: 'MSCU-\ud800' }] },
    ...context,
  }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_VALUE')
  await assert.rejects(() => runner.run({
    connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID,
    input: { ...input, syntheticFields: [{ field: 'senderName', value: 'Synthetic-\udc00' }] },
    ...context,
  }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_VALUE')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const pairedSurrogateAudit = new InMemoryHashChainAuditLog()
  const pairedSurrogateQuota = new TestQuota()
  const pairedSurrogateRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), pairedSurrogateAudit, pairedSurrogateQuota, now)
  const pairedSurrogateResult = await pairedSurrogateRunner.run({
    connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID,
    input: { ...input, syntheticFields: [{ field: 'containerId', value: 'MSCU-\u{1f600}' }] },
    ...context,
  }) as ConnectorResult<DocumentFieldExtractionData>
  assert.equal(pairedSurrogateResult.data.proposal.fields[0]?.value, 'MSCU-\u{1f600}')
  assert.equal(pairedSurrogateAudit.entries.length, 2)
  assert.equal(pairedSurrogateQuota.requests.length, 1)

  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.stringBoundaryBinding, { valueEncoding: 'well-formed-unicode-utf8', controlCharactersAccepted: false, unpairedSurrogateCodeUnitsAccepted: false })

  const malformedReviewValue = clone()
  malformedReviewValue.fields.find((field) => field.field === 'containerId')!.value = 'MSCU-\ud800'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(malformedReviewValue, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_VALUE')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { stringBoundaryBinding?: unknown }).stringBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.stringBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.stringBoundaryBinding.unpairedSurrogateCodeUnitsAccepted = true as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v9' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D11 freezes an exact built-in clock and binds that boundary before any reservation or review audit', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const injectedClock = new Date('2026-07-22T12:00:00.000Z')
  let injectedClockAccessorRead = false
  Object.defineProperty(injectedClock, 'getTime', {
    enumerable: false,
    get: () => {
      injectedClockAccessorRead = true
      throw new Error('CLOCK_ACCESSOR_MUST_NOT_RUN')
    },
  })
  const injectedClockRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, () => injectedClock)
  await assert.rejects(() => injectedClockRunner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_TIME')
  assert.equal(injectedClockAccessorRead, false)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  class SubclassedClock extends Date {}
  const subclassedClockRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, () => new SubclassedClock('2026-07-22T12:00:00.000Z'))
  await assert.rejects(() => subclassedClockRunner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_TIME')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  let proxiedClockTrapRead = false
  const proxiedClockRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, () => new Proxy(new Date('2026-07-22T12:00:00.000Z'), {
    getPrototypeOf: () => {
      proxiedClockTrapRead = true
      throw new Error('PROXY_TRAP_MUST_NOT_RUN')
    },
    ownKeys: () => {
      proxiedClockTrapRead = true
      throw new Error('PROXY_TRAP_MUST_NOT_RUN')
    },
  }))
  await assert.rejects(() => proxiedClockRunner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_TIME')
  assert.equal(proxiedClockTrapRead, false)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  let clockCalls = 0
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, () => {
    clockCalls += 1
    return now()
  })
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  assert.equal(clockCalls, 1)
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.timeBoundaryBinding, { clockValue: 'utc-epoch-milliseconds', clockObject: 'exact-date-prototype-no-own-properties', issuedAtSource: 'validated-run-context-clock' })

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { timeBoundaryBinding?: unknown }).timeBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.timeBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.timeBoundaryBinding.clockObject = 'subclassed-date-allowed' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING')

  const reviewClock = new Date('2026-07-22T12:00:00.000Z')
  let reviewClockAccessorRead = false
  Object.defineProperty(reviewClock, 'toISOString', {
    enumerable: true,
    get: () => {
      reviewClockAccessorRead = true
      throw new Error('CLOCK_ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(clone(), 'approved', true, 'checker@example.test', audit, { ...context, now: () => reviewClock }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_TIME')
  assert.equal(reviewClockAccessorRead, false)
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D12 rejects inherited, hidden, or accessor-backed proposal-field records before their values are read or a review audit is appended', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)
  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.fieldRecordBoundaryBinding, { fieldRecordShape: 'plain-own-enumerable-data-only', fieldDescriptorsValidatedBeforeValues: true, accessorFieldPropertiesAccepted: false })

  const fieldAccessorProposal = clone()
  let fieldAccessorRead = false
  Object.defineProperty(fieldAccessorProposal.fields[0] as unknown as Record<string, unknown>, 'field', {
    enumerable: true,
    get: () => {
      fieldAccessorRead = true
      throw new Error('FIELD_ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(fieldAccessorProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
  assert.equal(fieldAccessorRead, false)

  const privacyAccessorProposal = clone()
  let privacyAccessorRead = false
  Object.defineProperty(privacyAccessorProposal.fields[0] as unknown as Record<string, unknown>, 'privacy', {
    enumerable: true,
    get: () => {
      privacyAccessorRead = true
      throw new Error('PRIVACY_ACCESSOR_MUST_NOT_RUN')
    },
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(privacyAccessorProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
  assert.equal(privacyAccessorRead, false)

  const hiddenFieldProposal = clone()
  Object.defineProperty(hiddenFieldProposal.fields[0] as unknown as Record<string, unknown>, 'field', { enumerable: false, value: hiddenFieldProposal.fields[0]!.field })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(hiddenFieldProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')

  const inheritedFieldProposal = clone()
  const inheritedFieldRecord = inheritedFieldProposal.fields[0] as unknown as Record<string, unknown>
  const inheritedFieldValue = inheritedFieldRecord.field
  delete inheritedFieldRecord.field
  Object.setPrototypeOf(inheritedFieldRecord, { field: inheritedFieldValue })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(inheritedFieldProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_PROPOSAL_FIELD')

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { fieldRecordBoundaryBinding?: unknown }).fieldRecordBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.fieldRecordBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.fieldRecordBoundaryBinding.accessorFieldPropertiesAccepted = true as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v11' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('D13 rejects Proxy-wrapped synthetic input and review-graph members before any trap, reservation, or review audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector(60, 300)]), audit, quota, now)
  const trapProxy = <T extends object>(target: T, trap: () => void): T => new Proxy(target, {
    get() { trap(); throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
    getPrototypeOf() { trap(); throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
    getOwnPropertyDescriptor() { trap(); throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
    has() { trap(); throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
    ownKeys() { trap(); throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })

  let inputTraps = 0
  const proxiedInput = trapProxy(input, () => {
    inputTraps += 1
    throw new Error('PROXY_TRAP_MUST_NOT_RUN')
  })
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: proxiedInput, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_VISION_DOCUMENT_REQUEST')
  assert.equal(inputTraps, 0)

  const revokedFields = Proxy.revocable([...input.syntheticFields], {})
  revokedFields.revoke()
  await assert.rejects(() => runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input: { ...input, syntheticFields: revokedFields.proxy as never }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_FIELDS')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const result = await runner.run({ connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, input, ...context }) as ConnectorResult<DocumentFieldExtractionData>
  const clone = () => JSON.parse(JSON.stringify(result.data.proposal)) as typeof result.data.proposal
  assert.equal(result.data.proposal.reviewPacket.version, 'synthetic-document-review-packet-v13')
  assert.deepEqual(result.data.proposal.reviewPacket.proxyBoundaryBinding, { proxyDetection: 'node-util-types-isProxy', proxyObjectsAccepted: false, proxyArraysAccepted: false })

  let proposalTraps = 0
  const proxiedProposal = trapProxy(clone(), () => {
    proposalTraps += 1
    throw new Error('PROPOSAL_PROXY_TRAP_MUST_NOT_RUN')
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(proxiedProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_PROPOSAL')
  assert.equal(proposalTraps, 0)

  const proxiedFieldsProposal = clone()
  let arrayTraps = 0
  proxiedFieldsProposal.fields = trapProxy(proxiedFieldsProposal.fields, () => {
    arrayTraps += 1
    throw new Error('FIELD_ARRAY_PROXY_TRAP_MUST_NOT_RUN')
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(proxiedFieldsProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_PROPOSAL_FIELDS')
  assert.equal(arrayTraps, 0)

  const proxiedBindingProposal = clone()
  let bindingTraps = 0
  proxiedBindingProposal.reviewPacket.proxyBoundaryBinding = trapProxy(proxiedBindingProposal.reviewPacket.proxyBoundaryBinding, () => {
    bindingTraps += 1
    throw new Error('BINDING_PROXY_TRAP_MUST_NOT_RUN')
  })
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(proxiedBindingProposal, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING')
  assert.equal(bindingTraps, 0)

  const missingBinding = clone()
  delete (missingBinding.reviewPacket as { proxyBoundaryBinding?: unknown }).proxyBoundaryBinding
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(missingBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING')

  const extraBindingField = clone()
  ;(extraBindingField.reviewPacket.proxyBoundaryBinding as { extension?: unknown }).extension = 'forbidden'
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(extraBindingField, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING_FIELD')

  const wrongBinding = clone()
  wrongBinding.reviewPacket.proxyBoundaryBinding.proxyObjectsAccepted = true as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(wrongBinding, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING')

  const legacyPacket = clone()
  legacyPacket.reviewPacket.version = 'synthetic-document-review-packet-v12' as never
  await assert.rejects(() => independentlyReviewSyntheticDocumentProposal(legacyPacket, 'approved', true, 'checker@example.test', audit, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('environment construction has no credential input and accepts only explicit synthetic mode', async () => {
  const configured = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: LIVE_DISABLED, GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1', GCL_VISION_MAX_REVIEW_AGE_SECONDS: '60', GCL_VISION_MAX_EVIDENCE_AGE_SECONDS: '300' })
  const result = await configured.run(input, context)
  assert.equal(result.data.mode, LIVE_DISABLED)
  const invalid = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: 'LIVE_ENABLED', GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1', GCL_VISION_MAX_REVIEW_AGE_SECONDS: '60', GCL_VISION_MAX_EVIDENCE_AGE_SECONDS: '300' })
  await assert.rejects(() => invalid.run(input, context), ConnectorUnavailableError)
  const noReviewDeadline = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: LIVE_DISABLED, GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1', GCL_VISION_MAX_EVIDENCE_AGE_SECONDS: '300' })
  await assert.rejects(() => noReviewDeadline.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_REVIEW_WINDOW_NOT_CONFIGURED')
  const noEvidenceFreshness = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: LIVE_DISABLED, GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1', GCL_VISION_MAX_REVIEW_AGE_SECONDS: '60' })
  await assert.rejects(() => noEvidenceFreshness.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_EVIDENCE_FRESHNESS_NOT_CONFIGURED')
  const oversizedReviewDeadline = new SyntheticVisionDocumentFieldExtractionConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 1, maxReviewAgeSeconds: 86401, maxEvidenceAgeSeconds: 300 })
  await assert.rejects(() => oversizedReviewDeadline.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_REVIEW_WINDOW_NOT_CONFIGURED')
  const oversizedEvidenceFreshness = new SyntheticVisionDocumentFieldExtractionConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 1, maxReviewAgeSeconds: 60, maxEvidenceAgeSeconds: 86401 })
  await assert.rejects(() => oversizedEvidenceFreshness.run(input, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_DOCUMENT_EVIDENCE_FRESHNESS_NOT_CONFIGURED')
})

test('daily GM2 quota configuration is positive-integer-only and fail-closed', () => {
  assert.deepEqual(visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '5', GCL_VISION_DAILY_ITEM_QUOTA: '5' }), { dailyRuns: 5, dailyItems: 5 })
  assert.throws(() => visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '0', GCL_VISION_DAILY_ITEM_QUOTA: 'many' }), ConnectorUnavailableError)
})
