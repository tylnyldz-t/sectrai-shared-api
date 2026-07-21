import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorUnavailableError, CostCapError, OwnerGateError, QuotaError } from '../src/gcl/errors.js'
import { ownerTokenMatches } from '../src/gcl/owner.js'
import { visionDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { SyntheticVisionConnector, visionConnectorFromEnvironment } from '../src/gcl/vision.js'
import type { VisionScanResult } from '../src/gcl/vision.js'

const now = () => new Date('2026-07-21T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gcl-test', workspaceId: 'ws-vision', actor: 'owner@example.test', ownerApproved: true,
  scopes: ['vision:scan'], costCapCents: 25, requestedItems: 1, now,
}
const identityInput = { synthetic: true, documentType: 'identity', fixtureId: 'synthetic-identity-001' }

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

class RejectingQuota implements ConnectorQuota {
  async consume(): Promise<void> { throw new QuotaError() }
}

function enabledConnector(overrides: ConstructorParameters<typeof SyntheticVisionConnector>[0] = {}): SyntheticVisionConnector {
  return new SyntheticVisionConnector({ syntheticEnabled: true, maxCostCapCents: 25, maxItems: 1, ...overrides })
}

test('vision connector fails closed by default and cannot be switched to a live provider', async () => {
  await assert.rejects(() => new SyntheticVisionConnector().run(identityInput, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'SYNTHETIC_VISION_CONNECTOR_NOT_CONFIGURED')
  const liveAttempt = visionConnectorFromEnvironment({
    GCL_VISION_SYNTHETIC_ENABLED: 'true', GCL_VISION_LIVE_ENABLED: 'true', GCL_VISION_MAX_COST_CENTS: '25', GCL_VISION_MAX_ITEMS: '1',
  })
  await assert.rejects(() => liveAttempt.run(identityInput, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_LIVE_DISABLED')
  assert.equal(liveAttempt.liveStatus, 'LIVE_DISABLED')
})

test('vision connector rejects raw-image shaped input before it can be scanned or persisted', async () => {
  const connector = enabledConnector()
  await assert.rejects(
    () => connector.run({ ...identityInput, image: 'data:image/png;base64,not-accepted' }, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'SYNTHETIC_VISION_INPUT_REQUIRED',
  )
})

test('document, receipt, and identity fixture contracts produce structured synthetic fields', async () => {
  const connector = enabledConnector()
  const scans = await Promise.all([
    connector.run({ synthetic: true, documentType: 'document', fixtureId: 'synthetic-document-001' }, context),
    connector.run({ synthetic: true, documentType: 'receipt', fixtureId: 'synthetic-receipt-001' }, context),
    connector.run(identityInput, context),
  ])
  assert.deepEqual(scans.map((scan) => scan.data.documentType), ['document', 'receipt', 'identity'])
  assert.equal(scans.every((scan) => scan.data.fields.length > 0 && scan.data.review.state === 'OWNER_REVIEW_REQUIRED'), true)
})

test('governed identity fixture scan masks KVKK fields, reserves quota, and appends an audit chain', async () => {
  const connector = enabledConnector()
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)

  const result = await runner.run({ connectorId: 'vision-ocr', input: identityInput, ...context }) as ConnectorResult<VisionScanResult>
  const nationalId = result.data.fields.find((field) => field.key === 'nationalId')
  const birthDate = result.data.fields.find((field) => field.key === 'birthDate')
  const address = result.data.fields.find((field) => field.key === 'address')
  const serialized = JSON.stringify(result)

  assert.equal(result.data.mode, 'SYNTHETIC')
  assert.equal(result.data.liveStatus, 'LIVE_DISABLED')
  assert.equal(result.data.rawImageAccepted, false)
  assert.deepEqual(nationalId, { key: 'nationalId', value: '*******8901', sensitivity: 'identifier', masked: true })
  assert.deepEqual(birthDate, { key: 'birthDate', value: '1990-**-**', sensitivity: 'date-of-birth', masked: true })
  assert.deepEqual(address, { key: 'address', value: '[MASKED_ADDRESS]', sensitivity: 'address', masked: true })
  assert.equal(serialized.includes('12345678901'), false)
  assert.equal(serialized.includes('Synthetic Ada Yilmaz'), false)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(quota.requests.length, 1)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
})

test('owner, configured cost cap, and daily quota configuration all fail closed before a scan', async () => {
  const connector = enabledConnector({ maxCostCapCents: 10 })
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: 'vision-ocr', input: identityInput, ...context, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ connectorId: 'vision-ocr', input: identityInput, ...context }), (error: unknown) => error instanceof CostCapError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
  assert.deepEqual(visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '2', GCL_VISION_DAILY_SCAN_QUOTA: '4' }), { dailyRuns: 2, dailyItems: 4 })
  assert.throws(() => visionDailyQuotaFromEnvironment({ GCL_VISION_DAILY_RUN_QUOTA: '2' }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VISION_QUOTA_NOT_CONFIGURED')
})

test('a quota rejection is also recorded as a failed hash-chain audit event', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([enabledConnector()]), audit, new RejectingQuota(), now)
  await assert.rejects(() => runner.run({ connectorId: 'vision-ocr', input: identityInput, ...context }), (error: unknown) => error instanceof QuotaError)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
})

test('owner token comparison fails closed for missing or mismatched values', () => {
  assert.equal(ownerTokenMatches(undefined, undefined), false)
  assert.equal(ownerTokenMatches('owner-test-token', undefined), false)
  assert.equal(ownerTokenMatches('owner-test-token', 'owner-test-tokex'), false)
  assert.equal(ownerTokenMatches('owner-test-token', 'owner-test-token'), true)
})
