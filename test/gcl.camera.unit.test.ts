import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog, hashAuditEvent } from '../src/gcl/audit.js'
import { CameraConsentError, ConnectorInputError, ConnectorUnavailableError, MakerCheckerError, OwnerGateError, QuotaError } from '../src/gcl/errors.js'
import { ownerTokenMatches } from '../src/gcl/owner.js'
import { cameraDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { ADOS_10_CAMERA_CONTROLS, CAMERA_CONNECTOR_ID, CAMERA_LIVE_STATUS, CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION, CAMERA_REVIEW_AUDIT_TRAIL_WITNESS_VERSION, CAMERA_REVIEW_AUDIT_WITNESS_VERSION, CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION, CAMERA_REVIEW_RECEIPT_VERSION, SyntheticCameraConnector, cameraConnectorFromEnvironment, createCameraReviewAuditTrailReceipt, createCameraReviewEvidenceManifest, independentlyReviewCameraObservation, validateCameraObservationForReview, validateCameraReviewAuditTrailReceipt, validateCameraReviewAuditTrailWitness, validateCameraReviewAuditWitness, validateCameraReviewEvidenceManifest, validateCameraReviewReceipt, type CameraObservationResult, type SyntheticCameraConnectorConfig } from '../src/gcl/camera.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const runContext = {
  product: 'sectrai-gcl-camera-test', workspaceId: 'ws-camera', requestedBy: 'maker@example.test', checkedBy: 'checker@example.test',
  correlationId: 'synthetic-camera-correlation-001', ownerApproved: true, scopes: ['camera:observe'], costCapCents: 25, requestedItems: 1,
}
const context: ConnectorRunContext = { ...runContext, now }
const loadingDockInput = {
  synthetic: true,
  cameraFixtureId: 'synthetic-loading-dock-001',
  purpose: 'operational-safety',
  consent: { state: 'granted', receiptRef: 'synthetic-consent-safety-001', policyVersion: 'kvkk-synthetic-v1', sourceRights: 'synthetic-fixture' },
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

class RejectingQuota implements ConnectorQuota {
  async consume(): Promise<void> { throw new QuotaError() }
}

const limits: SyntheticCameraConnectorConfig = { syntheticEnabled: true, liveEnabled: false, maxCostCapCents: 25, maxItems: 1 }

function enabledConnector(overrides: SyntheticCameraConnectorConfig = {}): SyntheticCameraConnector {
  return new SyntheticCameraConnector({ ...limits, ...overrides })
}

function runnerFor(connector = enabledConnector(), quota: ConnectorQuota = new TestQuota()) {
  const audit = new InMemoryHashChainAuditLog()
  return { audit, quota, runner: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now) }
}

test('camera connector defaults closed and a live opt-in remains closed', async () => {
  await assert.rejects(
    () => new SyntheticCameraConnector().run(loadingDockInput, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'SYNTHETIC_CAMERA_CONNECTOR_NOT_CONFIGURED',
  )
  const liveAttempt = cameraConnectorFromEnvironment({
    GCL_CAMERA_SYNTHETIC_ENABLED: 'true', GCL_CAMERA_LIVE_ENABLED: 'true', GCL_CAMERA_MAX_COST_CENTS: '25', GCL_CAMERA_MAX_ITEMS: '1',
  })
  await assert.rejects(
    () => liveAttempt.run(loadingDockInput, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CAMERA_LIVE_DISABLED',
  )
  assert.equal(liveAttempt.liveStatus, CAMERA_LIVE_STATUS)
})

test('camera adapter rejects raw-media and device-shaped input before any fixture can be resolved', async () => {
  const connector = enabledConnector()
  await assert.rejects(
    () => connector.run({ ...loadingDockInput, snapshot: 'data:image/png;base64,not-accepted' }, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )
  await assert.rejects(
    () => connector.run({ ...loadingDockInput, cameraUrl: 'rtsp://not-accepted.example.test/stream' }, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )
  await assert.rejects(
    () => connector.run(Object.create(loadingDockInput), context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )
  await assert.rejects(
    () => connector.run({ ...loadingDockInput, consent: Object.create(loadingDockInput.consent) }, context),
    (error: unknown) => error instanceof CameraConsentError && error.message === 'CAMERA_CONSENT_REQUIRED',
  )
})

test('D3 strict data boundary rejects hidden, symbol, proxy, and accessor-shaped input without evaluating an accessor', async () => {
  const connector = enabledConnector()

  const hiddenMedia = structuredClone(loadingDockInput)
  Object.defineProperty(hiddenMedia, 'snapshot', { value: 'data:image/png;base64,not-accepted', enumerable: false })
  await assert.rejects(
    () => connector.run(hiddenMedia, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )

  const symbolShaped = structuredClone(loadingDockInput)
  Object.defineProperty(symbolShaped, Symbol('device-address'), { value: 'rtsp://not-accepted.example.test/stream', enumerable: true })
  await assert.rejects(
    () => connector.run(symbolShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )

  let proxyTrapRead = false
  const proxyShaped = new Proxy(structuredClone(loadingDockInput), {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(proxyShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )
  assert.equal(proxyTrapRead, false)

  const accessorShaped = structuredClone(loadingDockInput)
  let inputAccessorRead = false
  Object.defineProperty(accessorShaped, 'cameraFixtureId', {
    enumerable: true,
    get() { inputAccessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(accessorShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'SYNTHETIC_CAMERA_INPUT_REQUIRED',
  )
  assert.equal(inputAccessorRead, false)

  const accessorConsent = structuredClone(loadingDockInput)
  let consentAccessorRead = false
  Object.defineProperty(accessorConsent.consent, 'receiptRef', {
    enumerable: true,
    get() { consentAccessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(accessorConsent, context),
    (error: unknown) => error instanceof CameraConsentError && error.message === 'CAMERA_CONSENT_REQUIRED',
  )
  assert.equal(consentAccessorRead, false)
})

test('admitted synthetic observation contains no media, device identifier, identity, action, notification, or publication path', async () => {
  const connector = enabledConnector()
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>

  assert.equal(result.data.mode, 'SYNTHETIC')
  assert.equal(result.data.liveStatus, 'LIVE_DISABLED')
  assert.equal(result.data.privacy.rawMediaAccepted, false)
  assert.equal(result.data.privacy.streamConnectionAttempted, false)
  assert.equal(result.data.privacy.deviceIdentifierRetained, false)
  assert.equal(result.data.privacy.biometricInference, 'NOT_PERFORMED')
  assert.equal(result.data.privacy.identityResolution, 'NOT_PERFORMED')
  assert.equal(result.data.review.action, 'NOT_EXECUTED')
  assert.equal(result.data.review.notification, 'NOT_SENT')
  assert.equal(result.data.review.publication, 'NOT_PUBLISHED')
  assert.equal(result.confidence, 0)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(result.data.reviewPacket.rawMediaIncluded, false)
  assert.equal(result.data.reviewPacket.automaticAction, false)
  assert.equal(result.data.reviewPacket.notification, 'NOT_SENT')
  assert.equal(result.data.reviewPacket.publication, 'NOT_PUBLISHED')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(JSON.stringify(result).includes('not-accepted'), false)
  assert.equal(quota.requests.length, 1)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
})

test('D1 review packet permits only an independent owner decision and records no handoff or extra quota use', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)

  assert.equal(reviewed.ownerReview.state, 'APPROVED_FOR_SYNTHETIC_OBSERVATION_ONLY')
  assert.equal(reviewed.ownerReview.reviewer, 'reviewer@example.test')
  assert.equal(reviewed.reviewId, result.data.reviewPacket.reviewId)
  assert.equal(reviewed.reviewPacketIntegrityDigest, result.data.reviewPacket.integrityDigest)
  assert.equal(reviewed.handoff.state, 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED')
  assert.equal(reviewed.handoff.rawMediaIncluded, false)
  assert.equal(reviewed.handoff.sent, false)
  assert.equal(reviewed.handoff.automaticAction, false)
  assert.equal(reviewed.handoff.notification, 'NOT_SENT')
  assert.equal(reviewed.handoff.publication, 'NOT_PUBLISHED')
  assert.equal(reviewed.auditHash, setup.audit.entries[2]?.hash)
  assert.equal(reviewed.reviewReceipt.version, CAMERA_REVIEW_RECEIPT_VERSION)
  assert.equal(reviewed.reviewReceipt.reviewId, result.data.reviewPacket.reviewId)
  assert.equal(reviewed.reviewReceipt.observationDigest, result.data.reviewPacket.observationDigest)
  assert.equal(reviewed.reviewReceipt.reviewPacketIntegrityDigest, result.data.reviewPacket.integrityDigest)
  assert.equal(reviewed.reviewReceipt.disposition, 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION')
  assert.equal(reviewed.reviewReceipt.rawMediaIncluded, false)
  assert.equal(reviewed.reviewReceipt.automaticAction, false)
  assert.equal(reviewed.reviewReceipt.notification, 'NOT_SENT')
  assert.equal(reviewed.reviewReceipt.publication, 'NOT_PUBLISHED')
  assert.equal(JSON.stringify(reviewed.reviewReceipt).includes('reviewer@example.test'), false)
  assert.deepEqual(validateCameraReviewReceipt(result.data, reviewed, context), reviewed)
  assert.equal(setup.audit.entries[2]?.event.type, 'connector.camera.owner_reviewed')
  assert.equal(setup.audit.entries[2]?.event.detail.reviewPacketIntegrityDigest, result.data.reviewPacket.integrityDigest)
  assert.equal(JSON.stringify(setup.audit.entries[2]).includes('synthetic-loading-dock-001'), false)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries[2]?.previousHash, setup.audit.entries[1]?.hash)
})

test('D2 receipt validation rejects mutated, raw-shaped, cross-scope, and prototype-shaped review evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'rejected', true, 'reviewer@example.test', setup.audit, context)
  const clone = () => structuredClone(reviewed)

  const alteredDigest = clone()
  alteredDigest.reviewReceipt.reviewerDigest = '0'.repeat(64)
  assert.throws(
    () => validateCameraReviewReceipt(result.data, alteredDigest, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_RECEIPT_INTEGRITY_MISMATCH',
  )

  const alteredAudit = clone()
  alteredAudit.reviewReceipt.auditHash = '1'.repeat(64)
  assert.throws(
    () => validateCameraReviewReceipt(result.data, alteredAudit, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_RECEIPT_INTEGRITY_MISMATCH',
  )

  const rawShaped = clone() as typeof reviewed & { reviewReceipt: typeof reviewed.reviewReceipt & { snapshot?: string } }
  rawShaped.reviewReceipt.snapshot = 'data:image/png;base64,not-accepted'
  assert.throws(
    () => validateCameraReviewReceipt(result.data, rawShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD',
  )

  assert.throws(
    () => validateCameraReviewReceipt(result.data, clone(), { ...context, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_PACKET_SCOPE_MISMATCH',
  )

  const inheritedResult = Object.create(result.data) as CameraObservationResult
  assert.throws(
    () => validateCameraReviewReceipt(inheritedResult, clone(), context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RESULT_FIELD',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D3 strict data boundary rejects hidden, symbol, proxy, and accessor-shaped review evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const clone = () => structuredClone(reviewed)

  const hiddenSource = structuredClone(result.data)
  Object.defineProperty(hiddenSource, 'snapshot', { value: 'data:image/png;base64,not-accepted', enumerable: false })
  assert.throws(
    () => validateCameraReviewReceipt(hiddenSource, clone(), context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RESULT_FIELD',
  )

  const hiddenReceipt = clone()
  Object.defineProperty(hiddenReceipt.reviewReceipt, 'deviceAddress', { value: 'rtsp://not-accepted.example.test/stream', enumerable: false })
  assert.throws(
    () => validateCameraReviewReceipt(result.data, hiddenReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD',
  )

  const symbolReceipt = clone()
  Object.defineProperty(symbolReceipt.reviewReceipt, Symbol('raw-media'), { value: 'not-accepted', enumerable: true })
  assert.throws(
    () => validateCameraReviewReceipt(result.data, symbolReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD',
  )

  let receiptProxyTrapRead = false
  const proxyReceipt = new Proxy(clone(), {
    get() { receiptProxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewReceipt(result.data, proxyReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD',
  )
  assert.equal(receiptProxyTrapRead, false)

  const accessorReceipt = clone()
  let receiptAccessorRead = false
  Object.defineProperty(accessorReceipt.reviewReceipt, 'auditHash', {
    enumerable: true,
    get() { receiptAccessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewReceipt(result.data, accessorReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD',
  )
  assert.equal(receiptAccessorRead, false)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D4 audit witness matches only the supplied review event and rejects hash, semantic, and shaped evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const storedAuditEntry = setup.audit.entries[2]
  assert.ok(storedAuditEntry)
  const auditEntry = () => structuredClone(storedAuditEntry)

  const witness = validateCameraReviewAuditWitness(result.data, reviewed, auditEntry(), context)
  assert.equal(witness.version, CAMERA_REVIEW_AUDIT_WITNESS_VERSION)
  assert.equal(witness.reviewId, reviewed.reviewId)
  assert.equal(witness.auditHash, reviewed.auditHash)
  assert.equal(witness.previousAuditHash, setup.audit.entries[1]?.hash)
  assert.equal(witness.state, 'SYNTHETIC_REVIEW_AUDIT_ENTRY_VERIFIED_NO_ACTION')
  assert.equal(witness.rawMediaIncluded, false)
  assert.equal(witness.automaticAction, false)
  assert.equal(witness.notification, 'NOT_SENT')
  assert.equal(witness.publication, 'NOT_PUBLISHED')

  const alteredHash = auditEntry()
  alteredHash.hash = '0'.repeat(64)
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, alteredHash, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_AUDIT_HASH_MISMATCH',
  )

  const alteredDecision = auditEntry()
  alteredDecision.event.detail.decision = 'rejected'
  alteredDecision.hash = hashAuditEvent(alteredDecision.event, alteredDecision.previousHash)
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, alteredDecision, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_AUDIT_MISMATCH',
  )

  const crossWorkspace = auditEntry()
  crossWorkspace.event.workspaceId = 'another-workspace'
  crossWorkspace.hash = hashAuditEvent(crossWorkspace.event, crossWorkspace.previousHash)
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, crossWorkspace, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_AUDIT_MISMATCH',
  )

  const hiddenRawMedia = auditEntry() as typeof setup.audit.entries[number] & { event: typeof setup.audit.entries[number]['event'] & { detail: Record<string, unknown> } }
  Object.defineProperty(hiddenRawMedia.event.detail, 'snapshot', { value: 'data:image/png;base64,not-accepted', enumerable: false })
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, hiddenRawMedia, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_AUDIT_DETAIL_FIELD',
  )

  const symbolShaped = auditEntry()
  Object.defineProperty(symbolShaped.event, Symbol('device-address'), { value: 'rtsp://not-accepted.example.test/stream', enumerable: true })
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, symbolShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_AUDIT_EVENT_FIELD',
  )

  const accessorShaped = auditEntry()
  let accessorRead = false
  Object.defineProperty(accessorShaped.event, 'correlationId', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, accessorShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_AUDIT_EVENT_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyShaped = new Proxy(auditEntry(), {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditWitness(result.data, reviewed, proxyShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_AUDIT_FIELD',
  )
  assert.equal(proxyTrapRead, false)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D5 audit-trail witness matches the supplied requested/succeeded/review segment and rejects discontinuous or shaped evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const requestedEntry = setup.audit.entries[0]
  const succeededEntry = setup.audit.entries[1]
  const ownerReviewEntry = setup.audit.entries[2]
  assert.ok(requestedEntry)
  assert.ok(succeededEntry)
  assert.ok(ownerReviewEntry)
  const trail = () => ({
    requestedRun: structuredClone(requestedEntry),
    succeededRun: structuredClone(succeededEntry),
    ownerReview: structuredClone(ownerReviewEntry),
  })

  const witness = validateCameraReviewAuditTrailWitness(result.data, reviewed, trail(), context)
  assert.equal(witness.version, CAMERA_REVIEW_AUDIT_TRAIL_WITNESS_VERSION)
  assert.equal(witness.reviewId, reviewed.reviewId)
  assert.equal(witness.requestedAuditHash, setup.audit.entries[0]?.hash)
  assert.equal(witness.succeededAuditHash, setup.audit.entries[1]?.hash)
  assert.equal(witness.reviewAuditHash, reviewed.auditHash)
  assert.equal(witness.predecessorHash, null)
  assert.equal(witness.state, 'SYNTHETIC_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION')
  assert.equal(witness.rawMediaIncluded, false)
  assert.equal(witness.automaticAction, false)
  assert.equal(witness.notification, 'NOT_SENT')
  assert.equal(witness.publication, 'NOT_PUBLISHED')

  const discontinuous = trail()
  discontinuous.succeededRun.previousHash = '0'.repeat(64)
  discontinuous.succeededRun.hash = hashAuditEvent(discontinuous.succeededRun.event, discontinuous.succeededRun.previousHash)
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, discontinuous, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_CHAIN_MISMATCH',
  )

  const semanticMismatch = trail()
  semanticMismatch.succeededRun.event.checkedBy = 'other-checker@example.test'
  semanticMismatch.succeededRun.hash = hashAuditEvent(semanticMismatch.succeededRun.event, semanticMismatch.succeededRun.previousHash)
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, semanticMismatch, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_MISMATCH',
  )

  const reversedTime = trail()
  reversedTime.succeededRun.event.occurredAt = '2026-07-22T11:59:59.000Z'
  reversedTime.succeededRun.hash = hashAuditEvent(reversedTime.succeededRun.event, reversedTime.succeededRun.previousHash)
  reversedTime.ownerReview.previousHash = reversedTime.succeededRun.hash
  reversedTime.ownerReview.hash = hashAuditEvent(reversedTime.ownerReview.event, reversedTime.ownerReview.previousHash)
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, reversedTime, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_TIME_MISMATCH',
  )

  const hiddenMedia = trail() as ReturnType<typeof trail> & { requestedRun: typeof setup.audit.entries[number] & { event: typeof setup.audit.entries[number]['event'] & { detail: Record<string, unknown> } } }
  Object.defineProperty(hiddenMedia.requestedRun.event.detail, 'snapshot', { value: 'data:image/png;base64,not-accepted', enumerable: false })
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, hiddenMedia, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_REQUESTED_DETAIL_FIELD',
  )

  const accessorTrail = trail()
  let accessorRead = false
  Object.defineProperty(accessorTrail.succeededRun, 'hash', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, accessorTrail, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_ENTRY_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyTrail = new Proxy(trail(), {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditTrailWitness(result.data, reviewed, proxyTrail, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_FIELD',
  )
  assert.equal(proxyTrapRead, false)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D6 audit-trail receipt is minimized, context-bound, and rejects mutated or shaped evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const requestedEntry = setup.audit.entries[0]
  const succeededEntry = setup.audit.entries[1]
  const ownerReviewEntry = setup.audit.entries[2]
  assert.ok(requestedEntry)
  assert.ok(succeededEntry)
  assert.ok(ownerReviewEntry)
  const trail = () => ({
    requestedRun: structuredClone(requestedEntry),
    succeededRun: structuredClone(succeededEntry),
    ownerReview: structuredClone(ownerReviewEntry),
  })
  const receipt = () => createCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), context)

  const created = receipt()
  assert.equal(created.version, CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION)
  assert.equal(created.reviewId, reviewed.reviewId)
  assert.equal(created.requestedAuditHash, requestedEntry.hash)
  assert.equal(created.succeededAuditHash, succeededEntry.hash)
  assert.equal(created.reviewAuditHash, reviewed.auditHash)
  assert.equal(created.predecessorHash, null)
  assert.equal(created.state, 'SYNTHETIC_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION')
  assert.equal(created.rawMediaIncluded, false)
  assert.equal(created.automaticAction, false)
  assert.equal(created.notification, 'NOT_SENT')
  assert.equal(created.publication, 'NOT_PUBLISHED')
  assert.equal(JSON.stringify(created).includes('synthetic-loading-dock-001'), false)
  assert.equal(JSON.stringify(created).includes('reviewer@example.test'), false)
  assert.deepEqual(validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), structuredClone(created), context), created)

  const alteredHash = structuredClone(created)
  alteredHash.reviewAuditHash = '0'.repeat(64)
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), alteredHash, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_RECEIPT_INTEGRITY_MISMATCH',
  )

  const alteredReceiptId = structuredClone(created)
  alteredReceiptId.receiptId = 'synthetic-camera-review-audit-trail-receipt-000000000000000000000000'
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), alteredReceiptId, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_RECEIPT_INTEGRITY_MISMATCH',
  )

  const rawShaped = structuredClone(created) as typeof created & { snapshot?: string }
  rawShaped.snapshot = 'data:image/png;base64,not-accepted'
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), rawShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const hiddenDevice = structuredClone(created)
  Object.defineProperty(hiddenDevice, 'deviceAddress', { value: 'rtsp://not-accepted.example.test/stream', enumerable: false })
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), hiddenDevice, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const symbolShaped = structuredClone(created)
  Object.defineProperty(symbolShaped, Symbol('raw-media'), { value: 'not-accepted', enumerable: true })
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), symbolShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const accessorShaped = structuredClone(created)
  let accessorRead = false
  Object.defineProperty(accessorShaped, 'integrityDigest', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), accessorShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyShaped = new Proxy(structuredClone(created), {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), proxyShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD',
  )
  assert.equal(proxyTrapRead, false)

  assert.throws(
    () => validateCameraReviewAuditTrailReceipt(result.data, reviewed, trail(), structuredClone(created), { ...context, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_MISMATCH',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D7 evidence manifest binds independently rebuilt D2 and D6 evidence and rejects mutated or shaped evidence without writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const requestedEntry = setup.audit.entries[0]
  const succeededEntry = setup.audit.entries[1]
  const ownerReviewEntry = setup.audit.entries[2]
  assert.ok(requestedEntry)
  assert.ok(succeededEntry)
  assert.ok(ownerReviewEntry)
  const trail = () => ({
    requestedRun: structuredClone(requestedEntry),
    succeededRun: structuredClone(succeededEntry),
    ownerReview: structuredClone(ownerReviewEntry),
  })
  const manifest = () => createCameraReviewEvidenceManifest(result.data, reviewed, trail(), context)

  const created = manifest()
  assert.equal(created.version, CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION)
  assert.equal(created.reviewId, reviewed.reviewId)
  assert.equal(created.reviewReceiptIntegrityDigest, reviewed.reviewReceipt.integrityDigest)
  assert.equal(created.rawMediaIncluded, false)
  assert.equal(created.automaticAction, false)
  assert.equal(created.notification, 'NOT_SENT')
  assert.equal(created.publication, 'NOT_PUBLISHED')
  assert.equal(JSON.stringify(created).includes('synthetic-loading-dock-001'), false)
  assert.equal(JSON.stringify(created).includes('reviewer@example.test'), false)
  assert.equal(JSON.stringify(created).includes(reviewed.auditHash), false)
  assert.deepEqual(validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), structuredClone(created), context), created)

  const alteredReviewReceipt = structuredClone(created)
  alteredReviewReceipt.reviewReceiptIntegrityDigest = '0'.repeat(64)
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), alteredReviewReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_MISMATCH',
  )

  const alteredTrailReceipt = structuredClone(created)
  alteredTrailReceipt.auditTrailReceiptIntegrityDigest = '0'.repeat(64)
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), alteredTrailReceipt, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_MISMATCH',
  )

  const alteredManifestId = structuredClone(created)
  alteredManifestId.manifestId = 'synthetic-camera-review-evidence-manifest-000000000000000000000000'
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), alteredManifestId, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_MISMATCH',
  )

  const rawShaped = structuredClone(created) as typeof created & { snapshot?: string }
  rawShaped.snapshot = 'data:image/png;base64,not-accepted'
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), rawShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const hiddenDevice = structuredClone(created)
  Object.defineProperty(hiddenDevice, 'deviceAddress', { value: 'rtsp://not-accepted.example.test/stream', enumerable: false })
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), hiddenDevice, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const symbolShaped = structuredClone(created)
  Object.defineProperty(symbolShaped, Symbol('raw-media'), { value: 'not-accepted', enumerable: true })
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), symbolShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const accessorShaped = structuredClone(created)
  let accessorRead = false
  Object.defineProperty(accessorShaped, 'integrityDigest', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), accessorShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyShaped = new Proxy(structuredClone(created), {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), proxyShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )
  assert.equal(proxyTrapRead, false)

  assert.throws(
    () => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), structuredClone(created), { ...context, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_AUDIT_TRAIL_MISMATCH',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D8 caller review context rejects hidden, symbol, inherited, accessor, Proxy, and media-shaped values without reads or writes', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const reviewed = await independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, context)
  const requestedEntry = setup.audit.entries[0]
  const succeededEntry = setup.audit.entries[1]
  const ownerReviewEntry = setup.audit.entries[2]
  assert.ok(requestedEntry)
  assert.ok(succeededEntry)
  assert.ok(ownerReviewEntry)
  const trail = () => ({
    requestedRun: structuredClone(requestedEntry),
    succeededRun: structuredClone(succeededEntry),
    ownerReview: structuredClone(ownerReviewEntry),
  })
  const manifest = createCameraReviewEvidenceManifest(result.data, reviewed, trail(), context)
  const validate = (candidate: ConnectorRunContext) => validateCameraReviewEvidenceManifest(result.data, reviewed, trail(), structuredClone(manifest), candidate)

  const rawMediaContext = { ...context, snapshot: 'data:image/png;base64,not-accepted' } as ConnectorRunContext
  assert.throws(
    () => validate(rawMediaContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )

  const hiddenDeviceContext = { ...context }
  Object.defineProperty(hiddenDeviceContext, 'deviceAddress', { value: 'rtsp://not-accepted.example.test/stream', enumerable: false })
  assert.throws(
    () => validate(hiddenDeviceContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )

  const symbolContext = { ...context }
  Object.defineProperty(symbolContext, Symbol('raw-media'), { value: 'not-accepted', enumerable: true })
  assert.throws(
    () => validate(symbolContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )

  assert.throws(
    () => validate(Object.create(context) as ConnectorRunContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )

  const accessorContext = { ...context }
  let workspaceAccessorRead = false
  Object.defineProperty(accessorContext, 'workspaceId', {
    enumerable: true,
    get() { workspaceAccessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validate(accessorContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )
  assert.equal(workspaceAccessorRead, false)

  let proxyTrapRead = false
  const proxyContext = new Proxy({ ...context }, {
    get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validate(proxyContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )
  assert.equal(proxyTrapRead, false)

  const accessorNowContext = { ...context }
  let nowAccessorRead = false
  Object.defineProperty(accessorNowContext, 'now', {
    enumerable: true,
    get() { nowAccessorRead = true; throw new Error('NOW_ACCESSOR_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'another-reviewer@example.test', setup.audit, accessorNowContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD',
  )
  assert.equal(nowAccessorRead, false)

  const nonFunctionNowContext = { ...context, now: 'not-a-local-clock' } as unknown as ConnectorRunContext
  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'another-reviewer@example.test', setup.audit, nonFunctionNowContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CONTEXT',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 3)
})

test('D9 review clock accepts only a finite native Date and fails closed before audit append', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>

  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, { ...context, now: () => { throw new Error('CLOCK_MUST_FAIL_CLOSED') } }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CLOCK',
  )

  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, { ...context, now: () => new Date('not-a-date') }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CLOCK',
  )

  let forgedToISOStringRead = false
  const forgedClock = {
    toISOString() { forgedToISOStringRead = true; throw new Error('FORGED_CLOCK_MUST_NOT_RUN') },
  } as unknown as Date
  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, { ...context, now: () => forgedClock }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CLOCK',
  )
  assert.equal(forgedToISOStringRead, false)

  let returnedClockTrapRead = false
  const proxyClock = new Proxy(new Date('2026-07-22T12:00:00.000Z'), {
    get() { returnedClockTrapRead = true; throw new Error('CLOCK_PROXY_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, { ...context, now: () => proxyClock }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CLOCK',
  )
  assert.equal(returnedClockTrapRead, false)

  let clockFunctionApplied = false
  const proxyNow = new Proxy(now, {
    apply() { clockFunctionApplied = true; throw new Error('CLOCK_FUNCTION_PROXY_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => independentlyReviewCameraObservation(result.data, 'approved', true, 'reviewer@example.test', setup.audit, { ...context, now: proxyNow }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_CONTEXT',
  )
  assert.equal(clockFunctionApplied, false)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
  assert.equal(setup.audit.entries.length, 2)
})

test('D10 execution context and provenance clock fail closed before fixture result or quota use', async () => {
  const connector = enabledConnector()
  const accessorInput = structuredClone(loadingDockInput)
  let inputAccessorRead = false
  Object.defineProperty(accessorInput, 'cameraFixtureId', {
    enumerable: true,
    get() { inputAccessorRead = true; throw new Error('FIXTURE_ACCESSOR_MUST_NOT_RUN') },
  })

  await assert.rejects(
    () => connector.run(accessorInput, { ...context, snapshot: 'data:image/png;base64,not-accepted' } as ConnectorRunContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD',
  )
  assert.equal(inputAccessorRead, false)

  const hiddenContext = { ...context }
  Object.defineProperty(hiddenContext, 'deviceAddress', { value: 'rtsp://not-accepted.example.test/stream', enumerable: false })
  await assert.rejects(
    () => connector.run(loadingDockInput, hiddenContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD',
  )

  const symbolContext = { ...context }
  Object.defineProperty(symbolContext, Symbol('raw-media'), { value: 'not-accepted', enumerable: true })
  await assert.rejects(
    () => connector.run(loadingDockInput, symbolContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD',
  )

  const accessorContext = { ...context }
  let nowAccessorRead = false
  Object.defineProperty(accessorContext, 'now', {
    enumerable: true,
    get() { nowAccessorRead = true; throw new Error('NOW_ACCESSOR_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(loadingDockInput, accessorContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD',
  )
  assert.equal(nowAccessorRead, false)

  let contextProxyTrapRead = false
  const proxyContext = new Proxy({ ...context }, {
    get() { contextProxyTrapRead = true; throw new Error('CONTEXT_PROXY_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(loadingDockInput, proxyContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD',
  )
  assert.equal(contextProxyTrapRead, false)

  let clockFunctionApplied = false
  const proxyNow = new Proxy(now, {
    apply() { clockFunctionApplied = true; throw new Error('CLOCK_FUNCTION_PROXY_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(loadingDockInput, { ...context, now: proxyNow }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_EXECUTION_CONTEXT',
  )
  assert.equal(clockFunctionApplied, false)

  for (const clock of [
    () => { throw new Error('CLOCK_MUST_FAIL_CLOSED') },
    () => new Date('not-a-date'),
  ]) {
    await assert.rejects(
      () => connector.run(loadingDockInput, { ...context, now: clock }),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_PROVENANCE_CLOCK',
    )
  }

  let returnedClockTrapRead = false
  const proxyClock = new Proxy(new Date('2026-07-22T12:00:00.000Z'), {
    get() { returnedClockTrapRead = true; throw new Error('CLOCK_PROXY_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => connector.run(loadingDockInput, { ...context, now: () => proxyClock }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_PROVENANCE_CLOCK',
  )
  assert.equal(returnedClockTrapRead, false)

  let forgedToISOStringRead = false
  const nativeClock = new Date('2026-07-22T12:00:00.000Z')
  Object.defineProperty(nativeClock, 'toISOString', {
    value() { forgedToISOStringRead = true; throw new Error('FORGED_CLOCK_MUST_NOT_RUN') },
  })
  const accepted = await connector.run(loadingDockInput, { ...context, now: () => nativeClock })
  assert.equal(accepted.provenance.retrievedAt, '2026-07-22T12:00:00.000Z')
  assert.equal(forgedToISOStringRead, false)

})

test('D11 governed runner freezes one trusted local timestamp and rejects malformed clocks before audit or quota use', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  let clockCalls = 0
  let forgedToISOStringRead = false
  const clock = () => {
    clockCalls += 1
    const value = clockCalls === 1 ? new Date('2026-07-22T12:00:00.000Z') : new Date('not-a-date')
    Object.defineProperty(value, 'toISOString', {
      value() { forgedToISOStringRead = true; throw new Error('FORGED_CLOCK_MUST_NOT_RUN') },
    })
    return value
  }
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([enabledConnector()]), audit, quota, clock)
  const result = await runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>

  assert.equal(clockCalls, 1)
  assert.equal(forgedToISOStringRead, false)
  assert.equal(result.provenance.retrievedAt, '2026-07-22T12:00:00.000Z')
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[0]?.event.occurredAt, '2026-07-22T12:00:00.000Z')
  assert.equal(audit.entries[1]?.event.occurredAt, '2026-07-22T12:00:00.000Z')
  assert.equal(quota.requests.length, 1)

  for (const clockCandidate of [
    () => { throw new Error('CLOCK_MUST_FAIL_CLOSED') },
    () => new Date('not-a-date'),
  ]) {
    const rejectedAudit = new InMemoryHashChainAuditLog()
    const rejectedQuota = new TestQuota()
    const rejectedRunner = new GovernedConnectorRunner(new ConnectorRegistry([enabledConnector()]), rejectedAudit, rejectedQuota, clockCandidate)
    await assert.rejects(
      () => rejectedRunner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_GOVERNED_CONNECTOR_CLOCK',
    )
    assert.equal(rejectedAudit.entries.length, 0)
    assert.equal(rejectedQuota.requests.length, 0)
  }

  let proxyClockApplied = false
  const proxyClock = new Proxy(now, {
    apply() { proxyClockApplied = true; throw new Error('PROXY_CLOCK_MUST_NOT_RUN') },
  })
  const proxyAudit = new InMemoryHashChainAuditLog()
  const proxyQuota = new TestQuota()
  const proxyRunner = new GovernedConnectorRunner(new ConnectorRegistry([enabledConnector()]), proxyAudit, proxyQuota, proxyClock)
  await assert.rejects(
    () => proxyRunner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_GOVERNED_CONNECTOR_CLOCK',
  )
  assert.equal(proxyClockApplied, false)
  assert.equal(proxyAudit.entries.length, 0)
  assert.equal(proxyQuota.requests.length, 0)

  let proxyDateTrapRead = false
  const proxyDate = new Proxy(new Date('2026-07-22T12:00:00.000Z'), {
    get() { proxyDateTrapRead = true; throw new Error('PROXY_DATE_MUST_NOT_RUN') },
  })
  const proxyDateRunner = new GovernedConnectorRunner(new ConnectorRegistry([enabledConnector()]), new InMemoryHashChainAuditLog(), new TestQuota(), () => proxyDate)
  await assert.rejects(
    () => proxyDateRunner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_GOVERNED_CONNECTOR_CLOCK',
  )
  assert.equal(proxyDateTrapRead, false)
})

test('D1 fails closed before review audit append for tampered, cross-scope, raw-shaped, non-pending, and non-independent packets', async () => {
  const setup = runnerFor()
  const result = await setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }) as ConnectorResult<CameraObservationResult>
  const clone = (): CameraObservationResult => structuredClone(result.data)

  const alteredFinding = clone()
  alteredFinding.observation.findingCode = 'ALTERED_AFTER_RUN'
  assert.throws(
    () => validateCameraObservationForReview(alteredFinding, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_OBSERVATION_MISMATCH',
  )

  const rawMediaShaped = clone() as CameraObservationResult & { snapshot?: string }
  rawMediaShaped.snapshot = 'data:image/png;base64,still-not-accepted'
  assert.throws(
    () => validateCameraObservationForReview(rawMediaShaped, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_CAMERA_REVIEW_RESULT_FIELD',
  )

  const nonPending = clone()
  nonPending.reviewPacket.state = 'REVIEW_ALREADY_COMPLETED' as never
  nonPending.reviewPacket.automaticAction = true as never
  assert.throws(
    () => validateCameraObservationForReview(nonPending, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_PACKET',
  )

  assert.throws(
    () => validateCameraObservationForReview(clone(), { ...context, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CAMERA_REVIEW_PACKET_SCOPE_MISMATCH',
  )
  await assert.rejects(
    () => independentlyReviewCameraObservation(clone(), 'approved', true, context.requestedBy, setup.audit, context),
    (error: unknown) => error instanceof MakerCheckerError && error.message === 'CAMERA_REVIEW_REQUIRES_INDEPENDENT_CHECKER',
  )
  const spacedMakerContext = { ...context, requestedBy: ` ${context.requestedBy} ` }
  await assert.rejects(
    () => independentlyReviewCameraObservation(clone(), 'approved', true, context.requestedBy, setup.audit, spacedMakerContext),
    (error: unknown) => error instanceof MakerCheckerError && error.message === 'CAMERA_REVIEW_REQUIRES_INDEPENDENT_CHECKER',
  )
  await assert.rejects(
    () => independentlyReviewCameraObservation(clone(), 'approved', false, 'reviewer@example.test', setup.audit, context),
    (error: unknown) => error instanceof OwnerGateError,
  )
  await assert.rejects(
    () => independentlyReviewCameraObservation(clone(), 'send' as never, true, 'reviewer@example.test', setup.audit, context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CAMERA_REVIEW_DECISION',
  )
  await assert.rejects(
    () => independentlyReviewCameraObservation(clone(), 'approved', true, 'reviewer\n@example.test', setup.audit, context),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'CAMERA_REVIEWER_REQUIRED',
  )
  assert.equal(setup.audit.entries.length, 2)
  assert.equal((setup.quota as TestQuota).requests.length, 1)
})

test('ADOS 10 controls remain complete and explicitly prohibit egress and production launch', () => {
  assert.equal(ADOS_10_CAMERA_CONTROLS.length, 10)
  assert.deepEqual(ADOS_10_CAMERA_CONTROLS.map((control) => control.id), [
    'ADOS-01', 'ADOS-02', 'ADOS-03', 'ADOS-04', 'ADOS-05', 'ADOS-06', 'ADOS-07', 'ADOS-08', 'ADOS-09', 'ADOS-10',
  ])
  assert.match(ADOS_10_CAMERA_CONTROLS[6]?.enforcement ?? '', /no camera SDK, network client, stream URL, credential/i)
  assert.match(ADOS_10_CAMERA_CONTROLS[3]?.enforcement ?? '', /D8 caller-context fields, D10 execution-context\/provenance-clock values, and the D11 runner clock/i)
  assert.match(ADOS_10_CAMERA_CONTROLS[8]?.enforcement ?? '', /D4\/D5\/D6\/D7 witnesses.*D8\/D9.*D10.*D11/i)
  assert.match(ADOS_10_CAMERA_CONTROLS[9]?.enforcement ?? '', /No production migration, main\/prod write, live launch/i)
})

test('missing, revoked, mismatched, or fixture-unbound consent is denied and audit-recorded before quota reservation', async () => {
  const setup = runnerFor()
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: { ...loadingDockInput, consent: { ...loadingDockInput.consent, state: 'revoked' } }, ...runContext }),
    (error: unknown) => error instanceof CameraConsentError && error.message === 'CAMERA_CONSENT_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: { ...loadingDockInput, purpose: 'site-security' }, ...runContext }),
    (error: unknown) => error instanceof CameraConsentError && error.message === 'CAMERA_CONSENT_SCOPE_DENIED',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 0)
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.audit.entries.every((entry) => entry.event.type === 'connector.run.denied'), true)
  assert.equal(setup.audit.entries.every((entry) => entry.event.detail.errorCode === 'camera_consent_required'), true)
  assert.equal(setup.audit.entries[1]?.previousHash, setup.audit.entries[0]?.hash)
})

test('owner gate and maker-checker separation deny before quota reservation and leave auditable decisions', async () => {
  const setup = runnerFor()
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext, ownerApproved: false }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext, checkedBy: context.requestedBy }),
    (error: unknown) => error instanceof MakerCheckerError,
  )
  assert.equal((setup.quota as TestQuota).requests.length, 0)
  assert.deepEqual(setup.audit.entries.map((entry) => entry.event.type), ['connector.run.denied', 'connector.run.denied'])
  assert.deepEqual(setup.audit.entries.map((entry) => entry.event.detail.errorCode), ['owner_approval_required', 'maker_checker_separation_required'])
})

test('an unregistered connector is denied and audit-recorded without consuming quota', async () => {
  const setup = runnerFor()
  await assert.rejects(
    () => setup.runner.run({ connectorId: 'not-registered', input: loadingDockInput, ...runContext }),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_NOT_REGISTERED',
  )
  assert.equal((setup.quota as TestQuota).requests.length, 0)
  assert.equal(setup.audit.entries.length, 1)
  assert.equal(setup.audit.entries[0]?.event.type, 'connector.run.denied')
  assert.equal(setup.audit.entries[0]?.event.detail.errorCode, 'connector_unavailable')
})

test('quota rejection is recorded as a failed decision after a requested audit event', async () => {
  const setup = runnerFor(enabledConnector(), new RejectingQuota())
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...runContext }),
    (error: unknown) => error instanceof QuotaError,
  )
  assert.deepEqual(setup.audit.entries.map((entry) => entry.event.type), ['connector.run.requested', 'connector.run.failed'])
  assert.equal(setup.audit.entries[1]?.event.detail.errorCode, 'connector_quota_exceeded')
})

test('owner token and camera quota configuration fail closed when absent or invalid', () => {
  assert.equal(ownerTokenMatches(undefined, undefined), false)
  assert.equal(ownerTokenMatches('owner-test-token', undefined), false)
  assert.equal(ownerTokenMatches('owner-test-token', 'owner-test-tokex'), false)
  assert.equal(ownerTokenMatches('owner-test-token', 'owner-test-token'), true)
  assert.deepEqual(cameraDailyQuotaFromEnvironment({ GCL_CAMERA_DAILY_RUN_QUOTA: '2', GCL_CAMERA_DAILY_OBSERVATION_QUOTA: '4' }), { dailyRuns: 2, dailyItems: 4 })
  assert.throws(
    () => cameraDailyQuotaFromEnvironment({ GCL_CAMERA_DAILY_RUN_QUOTA: '2' }),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CAMERA_QUOTA_NOT_CONFIGURED',
  )
})
