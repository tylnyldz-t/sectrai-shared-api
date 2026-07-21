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

function configuredConnector(): SyntheticVisionDocumentFieldExtractionConnector {
  return new SyntheticVisionDocumentFieldExtractionConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 1 })
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

test('GM2 rejects boundary evidence, expired consent, duplicate fields, control characters, and blank makers before reservation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const request = { connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, ...context }
  await assert.rejects(() => runner.run({ ...request, input: { ...input, evidence: { ...input.evidence, byteLength: 0 } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_EVIDENCE_SIZE')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, evidence: { ...input.evidence, capturedAt: '2026-07-22T12:00:00.001Z' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_DOCUMENT_CAPTURE_TIME')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, consent: { ...input.consent, expiresAt: '2026-07-22T12:00:00.000Z' } } }), (error: unknown) => error instanceof ConsentError && error.message === 'DOCUMENT_CONSENT_EXPIRED')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, syntheticFields: [...input.syntheticFields, { field: 'containerId', value: 'duplicate' }] } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_FIELD')
  await assert.rejects(() => runner.run({ ...request, input: { ...input, syntheticFields: [{ field: 'containerId', value: 'unsafe\u0000value' }] } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_DOCUMENT_VALUE')
  await assert.rejects(() => runner.run({ ...request, actor: '   ', input }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_CONTEXT')
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
  assert.equal(proposal.reviewPacket.version, 'synthetic-document-review-packet-v1')
  assert.match(proposal.reviewPacket.integrityDigest, /^[a-f0-9]{64}$/)
  assert.equal(proposal.reviewPacket.scopeBinding.productDigest.length, 64)
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

test('environment construction has no credential input and accepts only explicit synthetic mode', async () => {
  const configured = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: LIVE_DISABLED, GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1' })
  const result = await configured.run(input, context)
  assert.equal(result.data.mode, LIVE_DISABLED)
  const invalid = syntheticVisionDocumentFieldExtractionConnectorFromEnvironment({ GCL_VISION_LIVE_MODE: 'LIVE_ENABLED', GCL_VISION_MAX_COST_CENTS: '20', GCL_VISION_MAX_ITEMS: '1' })
  await assert.rejects(() => invalid.run(input, context), ConnectorUnavailableError)
})

test('daily GM2 quota configuration is positive-integer-only and fail-closed', () => {
  assert.deepEqual(visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '5', GCL_VISION_DAILY_ITEM_QUOTA: '5' }), { dailyRuns: 5, dailyItems: 5 })
  assert.throws(() => visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '0', GCL_VISION_DAILY_ITEM_QUOTA: 'many' }), ConnectorUnavailableError)
})
