import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog, verifyAuditChain } from '../src/gcl/audit.js'
import { cameraConnectorFromEnvironment } from '../src/gcl/camera.js'
import { ConnectorUnavailableError, FamilySafetyError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { LIVE_DISABLED, SyntheticImageTtiConnector, issueSyntheticImageCandidates, ownerLikeSyntheticImage, ownerRejectSyntheticImage, syntheticImageTtiConnectorFromEnvironment } from '../src/gcl/image.js'
import type { TextToImageData } from '../src/gcl/image.js'
import { InMemoryImageCandidateLedger } from '../src/gcl/image-candidate-ledger.js'
import { InMemoryImageOwnerReviewLedger } from '../src/gcl/image-review-ledger.js'
import { imageDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { RunConnectorRequest } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ImageConnectorRunContext } from '../src/gcl/types.js'
import { isInternalGclModuleId } from '../src/validation.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ImageConnectorRunContext = {
  product: 'sectrai-gm3-test', workspaceId: 'image-workspace', actor: 'maker@example.test', correlationId: 'gm3-image-test-001',
  ownerApproved: true, scopes: ['image:generate'], costCapCents: 20, requestedItems: 2, now,
}
class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}
function connector(): SyntheticImageTtiConnector {
  return new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 300 })
}
function request(input: unknown, overrides: Partial<RunConnectorRequest> = {}): RunConnectorRequest {
  const { now: _, ...runContext } = context
  return { connectorId: 'image-tti', input, ...runContext, ...overrides }
}
async function runIssued(input = { prompt: 'A child-friendly solar system poster' }) {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector()]), audit, quota, now)
  const result = await runner.run(request(input)) as ConnectorResult<TextToImageData>
  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  return { audit, quota, result, candidates }
}

test('synthetic connector accepts only LIVE_DISABLED with bounded governance limits', async () => {
  await assert.rejects(() => new SyntheticImageTtiConnector().run({ prompt: 'A friendly robot' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  await assert.rejects(() => new SyntheticImageTtiConnector({ liveMode: 'LIVE', maxCostCapCents: 20, maxItems: 1, ownerReviewTtlSeconds: 300 }).run({ prompt: 'A friendly robot' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_LIVE_DISABLED')
  const fromEnvironment = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: LIVE_DISABLED, GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2', GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS: '300' })
  assert.equal((await fromEnvironment.run({ prompt: 'A friendly robot' }, context)).data.mode, LIVE_DISABLED)
})

test('owner gate, scope, and family-safety checks happen before audit and quota', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector()]), audit, quota, now)
  await assert.rejects(() => runner.run(request({ prompt: 'A friendly robot' }, { ownerApproved: false })), OwnerGateError)
  await assert.rejects(() => runner.run(request({ prompt: 'A friendly robot' }, { scopes: ['records:read'] })), ScopeError)
  await assert.rejects(() => runner.run(request({ prompt: 'An explicit adult scene' })), FamilySafetyError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('governed run creates redacted synthetic review candidates and an audit chain', async () => {
  const { audit, quota, result } = await runIssued()
  assert.equal(result.data.mode, LIVE_DISABLED)
  assert.equal(result.data.automaticPublication, false)
  assert.equal(result.data.candidates.length, 2)
  assert.equal(result.data.candidates.every((candidate) => candidate.syntheticUri.startsWith('synthetic://gcl/image-tti/')), true)
  assert.equal(result.data.candidates.every((candidate) => candidate.ownerReview.publication === 'blocked'), true)
  assert.equal(JSON.stringify(audit.entries).includes('solar system'), false)
  assert.equal(quota.requests.length, 1)
  assert.equal(verifyAuditChain(audit.entries).length, 3)
})

test('image lineage stays isolated from another connector in the same tenant', async () => {
  const audit = new InMemoryHashChainAuditLog()
  await audit.append({
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product: context.product, workspaceId: context.workspaceId,
    actor: 'translator@example.test', scopes: ['translation:text'], costCapCents: 5, requestedItems: 1,
    occurredAt: now().toISOString(), detail: {},
  })
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector()]), audit, new TestQuota(), now)
  const result = await runner.run(request({ prompt: 'A friendly ocean poster' })) as ConnectorResult<TextToImageData>
  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  assert.equal(audit.entries.length, 4)
  assert.equal(audit.imageEntries.length, 3)
  assert.equal(verifyAuditChain(audit.imageEntries).length, 3)
})

test('governed image run snapshots its injected clock once', async () => {
  let calls = 0
  const unstableNow = () => new Date(calls++ === 0 ? '2026-07-22T12:00:00.000Z' : '2026-07-23T12:00:00.000Z')
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector()]), audit, new TestQuota(), unstableNow)
  const result = await runner.run(request({ prompt: 'A friendly clock poster' })) as ConnectorResult<TextToImageData>
  assert.equal(calls, 1)
  assert.equal(result.provenance.retrievedAt, '2026-07-22T12:00:00.000Z')
  assert.equal(audit.imageEntries.every((entry) => entry.event.occurredAt === '2026-07-22T12:00:00.000Z'), true)
})

test('explicit image requests do not fall through to a configured camera lane', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const registry = new ConnectorRegistry([cameraConnectorFromEnvironment(), connector()])
  const runner = new GovernedConnectorRunner(registry, audit, new TestQuota(), now)
  const result = await runner.run(request({ prompt: 'A friendly mixed-lane poster' })) as ConnectorResult<TextToImageData>
  assert.equal(result.provenance.connectorId, 'image-tti')
})

test('issuance binds a governed run and only an independent owner can like once', async () => {
  const { audit, result, candidates } = await runIssued()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, context.actor, reviews, candidates, context), OwnerGateError)
  const artifact = await ownerLikeSyntheticImage(candidate, true, 'owner@example.test', reviews, candidates, context)
  assert.equal(artifact.publication, 'blocked')
  assert.equal(artifact.ownerReview.status, 'liked')
  assert.equal(artifact.issuanceAuditHash.length, 64)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'second-owner@example.test', reviews, candidates, context))
  assert.equal(verifyAuditChain(audit.entries).at(-1)?.event.type, 'connector.artifact.owner_liked')
})

test('liked output is built from the reviewed snapshot when the caller mutates during an await', async () => {
  const { audit, result, candidates } = await runIssued()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const originalPreview = candidate.previewDataUri
  const mutatingCandidates = {
    appendIssuance: candidates.appendIssuance.bind(candidates),
    assertIssued: async (reviewedCandidate: typeof candidate) => {
      candidate.previewDataUri = 'data:image/svg+xml;base64,bXV0YXRlZA=='
      return candidates.assertIssued(reviewedCandidate)
    },
  }
  const artifact = await ownerLikeSyntheticImage(candidate, true, 'owner@example.test', reviews, mutatingCandidates, context)
  assert.equal(artifact.previewDataUri, originalPreview)
})

test('rejection stays non-publishable and expired candidates cannot be reviewed', async () => {
  const { audit, result, candidates } = await runIssued({ prompt: 'A friendly city park poster' })
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const rejection = await ownerRejectSyntheticImage(candidate, true, 'owner@example.test', 'NEEDS_REVISION', reviews, candidates, context)
  assert.equal(rejection.publication, 'blocked')
  assert.equal('previewDataUri' in rejection, false)

  const next = await runIssued({ prompt: 'A friendly library poster' })
  const expiredCandidate = next.result.data.candidates[0]
  assert.ok(expiredCandidate)
  const afterExpiry = { ...context, now: () => new Date('2026-07-22T12:05:00.000Z') }
  await assert.rejects(() => ownerLikeSyntheticImage(expiredCandidate, true, 'owner@example.test', new InMemoryImageOwnerReviewLedger(next.audit), next.candidates, afterExpiry))
})

test('audit tampering, private record modules, and quota configuration fail closed', async () => {
  const { audit } = await runIssued()
  audit.entries[0]!.hash = '0'.repeat(64)
  assert.throws(() => verifyAuditChain(audit.entries))
  assert.equal(isInternalGclModuleId('gcl-audit'), true)
  assert.equal(isInternalGclModuleId('product-records'), false)
  assert.deepEqual(imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '10', GCL_IMAGE_DAILY_ITEM_QUOTA: '20' }), { dailyRuns: 10, dailyItems: 20 })
  assert.throws(() => imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '0', GCL_IMAGE_DAILY_ITEM_QUOTA: '20' }))
})
