import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { LIVE_DISABLED, SyntheticImageTtiConnector, ownerLikeSyntheticImage, syntheticImageTtiConnectorFromEnvironment } from '../src/gcl/image.js'
import { imageDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import type { TextToImageData } from '../src/gcl/image.js'

const now = () => new Date('2026-07-21T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gm3-test', workspaceId: 'image-workspace', actor: 'owner@example.test', ownerApproved: true,
  scopes: ['image:generate'], costCapCents: 20, requestedItems: 2, now,
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

function configuredConnector(): SyntheticImageTtiConnector {
  return new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2 })
}

test('GM3 image adapter is synthetic-only and fails closed until governance limits exist', async () => {
  const connector = new SyntheticImageTtiConnector()
  await assert.rejects(() => connector.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  assert.equal('fetch' in connector, false)
})

test('GM3 image adapter rejects every non-LIVE_DISABLED mode before it can generate a candidate', async () => {
  const connector = new SyntheticImageTtiConnector({ liveMode: 'true', maxCostCapCents: 20, maxItems: 2 })
  await assert.rejects(() => connector.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_LIVE_DISABLED')
})

test('family-unsafe image requests are rejected in preflight without audit or quota reservation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'An explicit adult scene' }, ...context }), (error: unknown) => error instanceof FamilySafetyError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('an injected family-safety hook is mandatory before audit or quota reservation', async () => {
  let policyCalls = 0
  const connector = new SyntheticImageTtiConnector({
    liveMode: LIVE_DISABLED,
    maxCostCapCents: 20,
    maxItems: 2,
    familySafetyFilter: {
      id: 'owner-family-policy-test',
      assess: () => { policyCalls += 1; return { allowed: false, reason: 'OWNER_POLICY_DENIED' } },
    },
  })
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context }), (error: unknown) => error instanceof FamilySafetyError && error.message === 'OWNER_POLICY_DENIED')
  assert.equal(policyCalls, 1)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('GM3 run requires owner gate, cost cap, quota, audit chain, family-safe hook, and owner-like before an artifact exists', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, costCapCents: 21 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, scopes: ['image:read'] }), (error: unknown) => error instanceof ScopeError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const result = await runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book', width: 512, height: 1024 }, ...context }) as ConnectorResult<TextToImageData>
  assert.equal(result.data.mode, LIVE_DISABLED)
  assert.equal(result.data.candidates.length, 2)
  assert.equal(result.data.candidates[0]?.ownerReview.status, 'pending')
  assert.equal(result.data.candidates[0]?.ownerReview.visibility, 'owner-only')
  assert.equal(result.data.candidates[0]?.ownerReview.publication, 'blocked')
  assert.equal(result.data.candidates[0]?.previewDataUri.startsWith('data:image/svg+xml;base64,'), true)
  assert.equal(result.data.automaticPublication, false)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(quota.requests.length, 1)
  assert.equal(quota.requests[0]?.requestedItems, 2)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)

  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, false, 'owner@example.test', audit, context), OwnerGateError)
  const artifact = await ownerLikeSyntheticImage(candidate, true, 'owner@example.test', audit, context)
  assert.equal(artifact.ownerReview.status, 'liked')
  assert.equal(artifact.publication, 'blocked')
  assert.equal(artifact.auditHash, audit.entries[2]?.hash)
  assert.equal(audit.entries[2]?.previousHash, audit.entries[1]?.hash)
  assert.equal(audit.entries[2]?.event.type, 'connector.artifact.owner_liked')
})

test('environment construction has no credential fields and accepts only explicit synthetic mode', async () => {
  const configured = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: LIVE_DISABLED, GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2' })
  const result = await configured.run({ prompt: 'A child-friendly solar system poster' }, context)
  assert.equal(result.data.mode, LIVE_DISABLED)

  const invalid = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: 'LIVE_ENABLED', GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2' })
  await assert.rejects(() => invalid.run({ prompt: 'A child-friendly solar system poster' }, context), ConnectorUnavailableError)
})

test('daily image quota configuration is positive-integer-only and fail-closed', () => {
  assert.deepEqual(imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '5', GCL_IMAGE_DAILY_ITEM_QUOTA: '10' }), { dailyRuns: 5, dailyItems: 10 })
  assert.throws(() => imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '0', GCL_IMAGE_DAILY_ITEM_QUOTA: 'ten' }), ConnectorUnavailableError)
})
