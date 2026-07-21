import assert from 'node:assert/strict'
import test from 'node:test'
import { GCL_AUDIT_MODULE_ID, InMemoryHashChainAuditLog, PrismaHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { LIVE_DISABLED, SyntheticImageTtiConnector, issueSyntheticImageCandidates, ownerLikeSyntheticImage, ownerRejectSyntheticImage, syntheticImageTtiConnectorFromEnvironment } from '../src/gcl/image.js'
import { GCL_IMAGE_CANDIDATE_MODULE_ID, InMemoryImageCandidateLedger, PrismaImageCandidateLedger } from '../src/gcl/image-candidate-ledger.js'
import { GCL_IMAGE_OWNER_REVIEW_MODULE_ID, InMemoryImageOwnerReviewLedger, PrismaImageOwnerReviewLedger } from '../src/gcl/image-review-ledger.js'
import type { GclPersistence, GclRecordTransaction } from '../src/gcl/persistence.js'
import { imageDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { TextToImageData } from '../src/gcl/image.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gm3-test', workspaceId: 'image-workspace', actor: 'maker@example.test', correlationId: 'gm3-image-test-001', ownerApproved: true,
  scopes: ['image:generate'], costCapCents: 20, requestedItems: 2, now,
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

class TestGclPersistence implements GclPersistence {
  private nextId = 0
  readonly records: Array<{ id: string; product: string; workspaceId: string; moduleId: string; values: unknown; createdAt: Date }> = []

  async $transaction<T>(operation: (transaction: GclRecordTransaction) => Promise<T>): Promise<T> {
    const snapshot = this.records.map((record) => ({ ...record, values: structuredClone(record.values), createdAt: new Date(record.createdAt) }))
    const nextId = this.nextId
    const transaction: GclRecordTransaction = {
      $executeRaw: async () => undefined,
      record: {
        findFirst: async ({ where }) => {
          const records = this.records.filter((record) => record.product === where.product && record.workspaceId === where.workspaceId && record.moduleId === where.moduleId)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
          return records[0] ?? null
        },
        findMany: async ({ where }) => this.records
          .filter((record) => record.product === where.product && record.workspaceId === where.workspaceId && record.moduleId === where.moduleId && (!where.createdAt || record.createdAt >= where.createdAt.gte))
          .map((record) => ({ values: record.values })),
        create: async ({ data }) => {
          this.nextId += 1
          this.records.push({ id: `test-${this.nextId}`, product: data.product, workspaceId: data.workspaceId, moduleId: data.moduleId, values: structuredClone(data.values), createdAt: now() })
        },
      },
    }
    try { return await operation(transaction) } catch (error) {
      this.records.splice(0, this.records.length, ...snapshot)
      this.nextId = nextId
      throw error
    }
  }
}

function configuredConnector(): SyntheticImageTtiConnector {
  return new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2 })
}

async function governedIssuedRun(audit: InMemoryHashChainAuditLog, input: { prompt: string; negativePrompt?: string } = { prompt: 'A child-friendly solar system poster' }) {
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run({ connectorId: 'image-tti', input, ...context }) as ConnectorResult<TextToImageData>
  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  return { candidate, candidates, result }
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

test('family-safety tokenization catches Turkish terms, avoids substring false positives, and rejects invisible controls', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'Çocuklara yönelik şiddet sahnesi' }, ...context }), FamilySafetyError)
  await assert.rejects(() => configuredConnector().run({ prompt: 'A friendly robot\u200B reading a book' }, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_PROMPT')
  const safe = await configuredConnector().run({ prompt: 'A child-friendly gunmetal blue robot poster' }, context)
  assert.equal(safe.data.candidates.length, 2)
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

test('malformed safety hooks and free-form policy reasons fail closed without leaking text into audit', async () => {
  const privateText = 'PRIVATE-OWNER-PROMPT-ONLY'
  const invalidFilter = new SyntheticImageTtiConnector({
    liveMode: LIVE_DISABLED,
    maxCostCapCents: 20,
    maxItems: 2,
    familySafetyFilter: { id: privateText, assess: () => ({ allowed: true }) },
  })
  await assert.rejects(() => invalidFilter.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_FAMILY_SAFETY_FILTER_INVALID')

  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const unsafeReason = new SyntheticImageTtiConnector({
    liveMode: LIVE_DISABLED,
    maxCostCapCents: 20,
    maxItems: 2,
    familySafetyFilter: { id: 'test-policy', assess: () => ({ allowed: false, reason: `DENIED:${privateText}` }) },
  })
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([unsafeReason]), audit, quota, now)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: privateText }, ...context }), (error: unknown) => error instanceof FamilySafetyError && error.message === 'FAMILY_SAFETY_FILTER_REJECTED')
  assert.equal(JSON.stringify(audit.entries).includes(privateText), false)
  assert.equal(quota.requests.length, 0)
})

test('GM3 run requires owner gate, cost cap, scope, safe identity, quota, audit chain, and a separate owner checker', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const candidates = new InMemoryImageCandidateLedger(audit)
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, costCapCents: 21 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, scopes: ['image:read'] }), (error: unknown) => error instanceof ScopeError)
  await assert.rejects(() => runner.run({ connectorId: 'image-tti', input: { prompt: 'A friendly blue robot reading a book' }, ...context, correlationId: 'unsafe/correlation-id' }), (error: unknown) => error instanceof ConnectorInputError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const privatePrompt = 'PRIVATE-OWNER-PROMPT-ONLY: friendly blue robot reading a book'
  const privateNegativePrompt = 'PRIVATE-NEGATIVE-PROMPT-ONLY: blurry composition'
  const result = await runner.run({ connectorId: 'image-tti', input: { prompt: privatePrompt, negativePrompt: privateNegativePrompt, width: 512, height: 1024 }, ...context }) as ConnectorResult<TextToImageData>
  assert.equal(result.data.mode, LIVE_DISABLED)
  assert.equal(result.data.candidates.length, 2)
  assert.equal(result.data.candidates[0]?.ownerReview.status, 'pending')
  assert.equal(result.data.candidates[0]?.candidateIndex, 0)
  assert.deepEqual(result.data.candidates[0]?.scope, { product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId })
  assert.equal(result.data.candidates[0]?.ownerReview.visibility, 'owner-only')
  assert.equal(result.data.candidates[0]?.ownerReview.publication, 'blocked')
  assert.equal(result.data.candidates[0]?.previewDataUri.startsWith('data:image/svg+xml;base64,'), true)
  assert.equal(result.data.automaticPublication, false)
  assert.equal(result.data.nextAction, 'INDEPENDENT_OWNER_LIKE_REQUIRED')
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(JSON.stringify(result).includes(privatePrompt), false)
  assert.equal(JSON.stringify(result).includes(privateNegativePrompt), false)
  assert.equal(quota.requests.length, 1)
  assert.equal(quota.requests[0]?.requestedItems, 2)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(audit.entries[0]?.event.correlationId, context.correlationId)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  const issuance = await issueSyntheticImageCandidates(result, candidates, context)
  assert.equal(issuance.issuanceAuditHash, audit.entries[2]?.hash)
  assert.equal(audit.entries[2]?.event.type, 'connector.artifact.candidates_issued')
  assert.equal(JSON.stringify(audit.entries[2]).includes(privatePrompt), false)
  assert.equal(JSON.stringify(audit.entries[2]).includes(privateNegativePrompt), false)

  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, false, 'checker@example.test', reviews, candidates, context), OwnerGateError)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, context.actor, reviews, candidates, context), (error: unknown) => error instanceof OwnerGateError && error.message === 'MAKER_CHECKER_SEPARATION_REQUIRED')
  const artifact = await ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context)
  assert.equal(artifact.ownerReview.status, 'liked')
  assert.equal(artifact.publication, 'blocked')
  assert.equal(artifact.auditHash, audit.entries[3]?.hash)
  assert.equal(artifact.issuanceAuditHash, issuance.issuanceAuditHash)
  assert.equal(artifact.runAuditHash, result.provenance.auditHash)
  assert.equal(audit.entries[3]?.previousHash, audit.entries[2]?.hash)
  assert.equal(audit.entries[3]?.event.type, 'connector.artifact.owner_liked')
  assert.equal(audit.entries[3]?.event.correlationId, context.correlationId)
})

test('owner rejection is terminal, scope-bound, auditable, and never returns a media artifact', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, context.actor, 'NOT_SUITABLE', reviews, candidates, context), (error: unknown) => error instanceof OwnerGateError && error.message === 'MAKER_CHECKER_SEPARATION_REQUIRED')
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'FREE_TEXT' as never, reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REJECTION_REASON')
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'SAFETY_CONCERN', reviews, candidates, { ...context, workspaceId: 'other-workspace' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_REVIEW_SCOPE_MISMATCH')
  assert.equal(audit.entries.length, 3)

  const rejected = await ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'NEEDS_REVISION', reviews, candidates, context)
  assert.equal(rejected.reviewId, `owner-rejected-${candidate.candidateId}`)
  assert.equal(rejected.ownerReview.status, 'rejected')
  assert.equal(rejected.ownerReview.reason, 'NEEDS_REVISION')
  assert.equal(rejected.publication, 'blocked')
  assert.equal('previewDataUri' in rejected, false)
  assert.equal('syntheticUri' in rejected, false)
  assert.equal(audit.entries.length, 4)
  assert.equal(audit.entries[3]?.event.type, 'connector.artifact.owner_rejected')
  assert.equal(JSON.stringify(audit.entries).includes('child-friendly solar system poster'), false)
})

test('owner review rejects malformed, cross-scope, or already-decided candidates before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const malformedUri = structuredClone(candidate)
  malformedUri.syntheticUri = 'https://provider.example/image.png'
  await assert.rejects(() => ownerLikeSyntheticImage(malformedUri, true, 'checker@example.test', reviews, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  const movedScope = structuredClone(candidate)
  movedScope.scope.workspaceId = 'other-workspace'
  await assert.rejects(() => ownerLikeSyntheticImage(movedScope, true, 'checker@example.test', reviews, { ...context, workspaceId: 'other-workspace' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  const decided = structuredClone(candidate)
  decided.ownerReview.status = 'liked'
  await assert.rejects(() => ownerLikeSyntheticImage(decided, true, 'checker@example.test', reviews, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_NOT_PENDING_OWNER_REVIEW')
  const extraData = structuredClone(candidate) as Record<string, unknown>
  extraData.prompt = 'PRIVATE-OWNER-PROMPT-ONLY'
  await assert.rejects(() => ownerLikeSyntheticImage(extraData as never, true, 'checker@example.test', reviews, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  assert.equal(audit.entries.length, 0)
})

test('terminal owner-review ledger permits one decision only, including a concurrent opposite decision', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)

  const decisions = await Promise.allSettled([
    ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, context),
    ownerRejectSyntheticImage(candidate, true, 'checker-two@example.test', 'NEEDS_REVISION', reviews, context),
  ])
  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1)
  assert.equal(audit.entries.length, 1)
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'SAFETY_CONCERN', reviews, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
  assert.equal(audit.entries.length, 1)
})

test('a corrupt audit tail fail-closes a terminal review before another decision append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  audit.entries.push({ event: {} as never, previousHash: null, hash: '0'.repeat(64) } as never)
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(audit.entries.length, 1)
})

test('durable owner-review ledger commits one redacted receipt with its audit event and rolls back invalid state', async () => {
  const persistence = new TestGclPersistence()
  const reviews = new PrismaImageOwnerReviewLedger(persistence)
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, context)
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 1)
  const receipts = persistence.records.filter((record) => record.moduleId === GCL_IMAGE_OWNER_REVIEW_MODULE_ID)
  assert.equal(receipts.length, 1)
  assert.equal(JSON.stringify(receipts[0]?.values).includes('child-friendly solar system poster'), false)
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker-two@example.test', 'NEEDS_REVISION', reviews, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 1)

  const corrupt = new TestGclPersistence()
  corrupt.records.push({ id: 'bad-receipt', product: context.product, workspaceId: context.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID, values: { unexpected: true }, createdAt: now() })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new PrismaImageOwnerReviewLedger(corrupt), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  assert.equal(corrupt.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 0)
})

test('candidate carries a redacted jarvis-creative-worker ComfyUI/SDXL shape but no executable dispatch path', async () => {
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster', negativePrompt: 'unsafe material' }, context)
  const plan = result.data.candidates[0]?.creativeWorkerPlan
  assert.ok(plan)
  assert.equal(plan.schema, 'creative-job-v1')
  assert.equal(plan.provider, 'local-comfyui')
  assert.equal(plan.type, 'image')
  assert.equal(plan.modelFamily, 'sdxl')
  assert.equal(plan.checkpoint, 'UNRESOLVED_SYNTHETIC_ONLY')
  assert.deepEqual(plan.graphShape, ['CheckpointLoaderSimple', 'CLIPTextEncode:positive', 'CLIPTextEncode:negative', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'])
  assert.deepEqual(plan.dispatch, { performed: false, gate: LIVE_DISABLED, network: 'not-attempted' })
})

test('environment construction has no credential fields and accepts only explicit synthetic mode', async () => {
  const configured = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: LIVE_DISABLED, GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2' })
  const result = await configured.run({ prompt: 'A child-friendly solar system poster' }, context)
  assert.equal(result.data.mode, LIVE_DISABLED)

  const invalid = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: 'LIVE_ENABLED', GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2' })
  await assert.rejects(() => invalid.run({ prompt: 'A child-friendly solar system poster' }, context), ConnectorUnavailableError)
})

test('direct connector use also rejects malformed context and unexpected input fields', async () => {
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster', providerKey: 'not-accepted' } as never, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_IMAGE_TTI_FIELD')
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, { ...context, correlationId: 'unsafe/correlation-id' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_CONTEXT')
})

test('daily image quota configuration is positive-integer-only and fail-closed', () => {
  assert.deepEqual(imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '5', GCL_IMAGE_DAILY_ITEM_QUOTA: '10' }), { dailyRuns: 5, dailyItems: 10 })
  assert.throws(() => imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '0', GCL_IMAGE_DAILY_ITEM_QUOTA: 'ten' }), ConnectorUnavailableError)
})
