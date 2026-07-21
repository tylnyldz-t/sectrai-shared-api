import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { CameraConsentError, ConnectorInputError, ConnectorUnavailableError, MakerCheckerError, OwnerGateError, QuotaError } from '../src/gcl/errors.js'
import { ownerTokenMatches } from '../src/gcl/owner.js'
import { cameraDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { CAMERA_CONNECTOR_ID, CAMERA_LIVE_STATUS, SyntheticCameraConnector, cameraConnectorFromEnvironment, type CameraObservationResult, type SyntheticCameraConnectorConfig } from '../src/gcl/camera.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gcl-camera-test', workspaceId: 'ws-camera', requestedBy: 'maker@example.test', checkedBy: 'checker@example.test',
  correlationId: 'synthetic-camera-correlation-001', ownerApproved: true, scopes: ['camera:observe'], costCapCents: 25, requestedItems: 1, now,
}
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
})

test('admitted synthetic observation contains no media, device identifier, identity, action, notification, or publication path', async () => {
  const connector = enabledConnector()
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...context }) as ConnectorResult<CameraObservationResult>

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
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(JSON.stringify(result).includes('not-accepted'), false)
  assert.equal(quota.requests.length, 1)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
})

test('missing, revoked, mismatched, or fixture-unbound consent is denied and audit-recorded before quota reservation', async () => {
  const setup = runnerFor()
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: { ...loadingDockInput, consent: { ...loadingDockInput.consent, state: 'revoked' } }, ...context }),
    (error: unknown) => error instanceof CameraConsentError && error.message === 'CAMERA_CONSENT_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: { ...loadingDockInput, purpose: 'site-security' }, ...context }),
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
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...context, ownerApproved: false }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...context, checkedBy: context.requestedBy }),
    (error: unknown) => error instanceof MakerCheckerError,
  )
  assert.equal((setup.quota as TestQuota).requests.length, 0)
  assert.deepEqual(setup.audit.entries.map((entry) => entry.event.type), ['connector.run.denied', 'connector.run.denied'])
  assert.deepEqual(setup.audit.entries.map((entry) => entry.event.detail.errorCode), ['owner_approval_required', 'maker_checker_separation_required'])
})

test('an unregistered connector is denied and audit-recorded without consuming quota', async () => {
  const setup = runnerFor()
  await assert.rejects(
    () => setup.runner.run({ connectorId: 'not-registered', input: loadingDockInput, ...context }),
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
    () => setup.runner.run({ connectorId: CAMERA_CONNECTOR_ID, input: loadingDockInput, ...context }),
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
