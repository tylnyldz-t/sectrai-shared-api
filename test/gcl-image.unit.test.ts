import assert from 'node:assert/strict'
import test from 'node:test'
import { GCL_AUDIT_MODULE_ID, hashAuditEvent, InMemoryHashChainAuditLog, PrismaHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { LIVE_DISABLED, SyntheticImageTtiConnector, imageCandidateFingerprint, imageCandidateSetDigest, issueSyntheticImageCandidates, ownerLikeSyntheticImage, ownerRejectSyntheticImage, syntheticImageTtiConnectorFromEnvironment } from '../src/gcl/image.js'
import { GCL_IMAGE_CANDIDATE_MODULE_ID, InMemoryImageCandidateLedger, PrismaImageCandidateLedger } from '../src/gcl/image-candidate-ledger.js'
import { GCL_IMAGE_OWNER_REVIEW_MODULE_ID, InMemoryImageOwnerReviewLedger, PrismaImageOwnerReviewLedger } from '../src/gcl/image-review-ledger.js'
import type { GclPersistence, GclRecordTransaction } from '../src/gcl/persistence.js'
import { imageDailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { RunConnectorRequest } from '../src/gcl/registry.js'
import type { TextToImageData } from '../src/gcl/image.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { isInternalGclModuleId } from '../src/validation.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-gm3-test', workspaceId: 'image-workspace', actor: 'maker@example.test', correlationId: 'gm3-image-test-001', ownerApproved: true,
  scopes: ['image:generate'], costCapCents: 20, requestedItems: 2, now,
}

function governedRunRequest(input: unknown, overrides: Partial<RunConnectorRequest> = {}): RunConnectorRequest {
  const { now: _, ...requestContext } = context
  return { connectorId: 'image-tti', input, ...requestContext, ...overrides }
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
        findMany: async ({ where, orderBy }) => {
          const records = this.records
            .filter((record) => record.product === where.product && record.workspaceId === where.workspaceId && record.moduleId === where.moduleId && (!where.createdAt || record.createdAt >= where.createdAt.gte))
          if (orderBy) {
            records.sort((left, right) => {
              for (const order of orderBy) {
                if ('createdAt' in order) {
                  const comparison = left.createdAt.getTime() - right.createdAt.getTime()
                  if (comparison !== 0) return order.createdAt === 'asc' ? comparison : -comparison
                } else {
                  const comparison = left.id.localeCompare(right.id)
                  if (comparison !== 0) return order.id === 'asc' ? comparison : -comparison
                }
              }
              return 0
            })
          }
          return records.map((record) => ({ values: record.values }))
        },
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
  return new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 300 })
}

async function governedIssuedRun(audit: InMemoryHashChainAuditLog, input: { prompt: string; negativePrompt?: string } = { prompt: 'A child-friendly solar system poster' }) {
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest(input)) as ConnectorResult<TextToImageData>
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
  const connector = new SyntheticImageTtiConnector({ liveMode: 'true', maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 300 })
  await assert.rejects(() => connector.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_LIVE_DISABLED')
})

test('GM3 image adapter fails closed without a bounded owner-review TTL', async () => {
  const missing = new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2 })
  await assert.rejects(() => missing.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_TTL_NOT_CONFIGURED')
  const overlong = new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 86_401 })
  await assert.rejects(() => overlong.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_TTL_NOT_CONFIGURED')
})

test('GM3 refuses a configured run size that the bounded issuance ledger cannot represent', async () => {
  const unissuable = new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 33, ownerReviewTtlSeconds: 300 })
  await assert.rejects(() => unissuable.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
})

test('family-unsafe image requests are rejected in preflight without audit or quota reservation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'An explicit adult scene' })), (error: unknown) => error instanceof FamilySafetyError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('family-safety tokenization catches Turkish terms, avoids substring false positives, and rejects invisible controls', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'Çocuklara yönelik şiddet sahnesi' })), FamilySafetyError)
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
    ownerReviewTtlSeconds: 300,
    familySafetyFilter: {
      id: 'owner-family-policy-test',
      assess: () => { policyCalls += 1; return { allowed: false, reason: 'OWNER_POLICY_DENIED' } },
    },
  })
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A friendly blue robot reading a book' })), (error: unknown) => error instanceof FamilySafetyError && error.message === 'OWNER_POLICY_DENIED')
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
    ownerReviewTtlSeconds: 300,
    familySafetyFilter: { id: privateText, assess: () => ({ allowed: true }) },
  })
  await assert.rejects(() => invalidFilter.run({ prompt: 'A friendly blue robot reading a book' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_FAMILY_SAFETY_FILTER_INVALID')

  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const unsafeReason = new SyntheticImageTtiConnector({
    liveMode: LIVE_DISABLED,
    maxCostCapCents: 20,
    maxItems: 2,
    ownerReviewTtlSeconds: 300,
    familySafetyFilter: { id: 'test-policy', assess: () => ({ allowed: false, reason: `DENIED:${privateText}` }) },
  })
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([unsafeReason]), audit, quota, now)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: privateText })), (error: unknown) => error instanceof FamilySafetyError && error.message === 'FAMILY_SAFETY_FILTER_REJECTED')
  assert.equal(JSON.stringify(audit.entries).includes(privateText), false)
  assert.equal(quota.requests.length, 0)
})

test('GM3 run requires owner gate, cost cap, scope, safe identity, quota, audit chain, and a separate owner checker', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const candidates = new InMemoryImageCandidateLedger(audit)
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)

  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A friendly blue robot reading a book' }, { ownerApproved: false })), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A friendly blue robot reading a book' }, { costCapCents: 21 })), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A friendly blue robot reading a book' }, { scopes: ['image:read'] })), (error: unknown) => error instanceof ScopeError)
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A friendly blue robot reading a book' }, { correlationId: 'unsafe/correlation-id' })), (error: unknown) => error instanceof ConnectorInputError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const privatePrompt = 'PRIVATE-OWNER-PROMPT-ONLY: friendly blue robot reading a book'
  const privateNegativePrompt = 'PRIVATE-NEGATIVE-PROMPT-ONLY: blurry composition'
  const result = await runner.run(governedRunRequest({ prompt: privatePrompt, negativePrompt: privateNegativePrompt, width: 512, height: 1024 })) as ConnectorResult<TextToImageData>
  assert.equal(result.data.mode, LIVE_DISABLED)
  assert.equal(result.data.candidates.length, 2)
  assert.equal(result.data.candidates[0]?.ownerReview.status, 'pending')
  assert.equal(result.data.candidates[0]?.candidateIndex, 0)
  assert.deepEqual(result.data.candidates[0]?.scope, { product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId })
  assert.equal(result.data.candidates[0]?.ownerReview.visibility, 'owner-only')
  assert.equal(result.data.candidates[0]?.ownerReview.publication, 'blocked')
  assert.equal(result.data.candidates[0]?.ownerReview.reviewExpiresAt, '2026-07-22T12:05:00.000Z')
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
  assert.equal(audit.entries[1]?.event.detail.syntheticCandidateSetDigest, imageCandidateSetDigest(result.data.candidates))
  assert.equal(JSON.stringify(audit.entries[1]).includes(privatePrompt), false)
  assert.equal(JSON.stringify(audit.entries[1]).includes(privateNegativePrompt), false)
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

test('governed image runs accept only a closed request envelope without reading accessors', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, quota, now)
  const privateValue = 'PRIVATE-UNTRUSTED-RUN-FIELD'

  const accessorRequest = governedRunRequest({ prompt: 'A child-friendly solar system poster' }) as Record<string, unknown>
  let getterRead = false
  Object.defineProperty(accessorRequest, 'input', { enumerable: true, get: () => { getterRead = true; return { prompt: privateValue } } })
  await assert.rejects(() => runner.run(accessorRequest as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST')
  assert.equal(getterRead, false)

  await assert.rejects(() => runner.run({ ...governedRunRequest({ prompt: 'A child-friendly solar system poster' }), unexpected: privateValue } as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST')
  const hiddenRequest = governedRunRequest({ prompt: 'A child-friendly solar system poster' }) as Record<string, unknown>
  Object.defineProperty(hiddenRequest, 'providerCredential', { enumerable: false, value: privateValue })
  await assert.rejects(() => runner.run(hiddenRequest as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST')
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' }, { ownerApproved: 'true' as never })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST')
  const sparseScopes: string[] = []
  sparseScopes[1] = 'image:generate'
  await assert.rejects(() => runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' }, { scopes: sparseScopes })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
  assert.equal(JSON.stringify(audit.entries).includes(privateValue), false)
})

test('governed image runs reject accessor capabilities and malformed clocks before reservation', async () => {
  const request = governedRunRequest({ prompt: 'A child-friendly solar system poster' })
  let auditGetterRead = false
  const accessorAudit = {}
  Object.defineProperty(accessorAudit, 'append', { enumerable: true, get: () => { auditGetterRead = true; return async () => ({ hash: 'a'.repeat(64) }) } })
  const quota = new TestQuota()
  const auditRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), accessorAudit as never, quota, now)
  await assert.rejects(() => auditRunner.run(request), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_LOG_UNAVAILABLE')
  assert.equal(auditGetterRead, false)
  assert.equal(quota.requests.length, 0)

  const audit = new InMemoryHashChainAuditLog()
  let quotaGetterRead = false
  const accessorQuota = {}
  Object.defineProperty(accessorQuota, 'consume', { enumerable: true, get: () => { quotaGetterRead = true; return async () => undefined } })
  const quotaRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, accessorQuota as never, now)
  await assert.rejects(() => quotaRunner.run(request), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_QUOTA_UNAVAILABLE')
  assert.equal(quotaGetterRead, false)
  assert.equal(audit.entries.length, 0)

  const invalidClockAudit = new InMemoryHashChainAuditLog()
  const invalidClockQuota = new TestQuota()
  const clockRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), invalidClockAudit, invalidClockQuota, () => new Date('invalid'))
  await assert.rejects(() => clockRunner.run(request), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_INVALID')
  assert.equal(invalidClockAudit.entries.length, 0)
  assert.equal(invalidClockQuota.requests.length, 0)
})

test('post-reservation runner failures redact error text and reject accessor-shaped results', async () => {
  const privateError = 'PRIVATE-CONNECTOR-FAILURE-DO-NOT-AUDIT'
  const failingConnector = {
    id: 'synthetic-image-failure', kind: 'media-generation' as const, authKind: 'owner-token' as const, scopes: ['image:generate'],
    run: async () => { throw new Error(privateError) },
  }
  const failureAudit = new InMemoryHashChainAuditLog()
  const failureQuota = new TestQuota()
  const failureRunner = new GovernedConnectorRunner(new ConnectorRegistry([failingConnector]), failureAudit, failureQuota, now)
  await assert.rejects(() => failureRunner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' }, { connectorId: failingConnector.id })), (error: unknown) => error instanceof Error && error.message === privateError)
  assert.equal(failureQuota.requests.length, 1)
  assert.equal(failureAudit.entries.length, 2)
  assert.equal(failureAudit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(failureAudit.entries[1]?.event.detail.error, 'CONNECTOR_RUN_FAILED')
  assert.equal(JSON.stringify(failureAudit.entries).includes(privateError), false)

  const hiddenProvenanceConnector = {
    id: 'synthetic-image-hidden-provenance', kind: 'media-generation' as const, authKind: 'owner-token' as const, scopes: ['image:generate'],
    run: async () => {
      const provenance = {
        connectorId: 'synthetic-image-hidden-provenance', source: 'synthetic-image-tti', retrievedAt: now().toISOString(),
        untrustedContent: { source: 'owner-supplied-tti-prompt', value: {}, handling: 'data-only' as const, instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' as const },
      }
      Object.defineProperty(provenance, 'providerEndpoint', { enumerable: false, value: privateError })
      return { data: {}, provenance, confidence: 0 }
    },
  }
  const hiddenProvenanceAudit = new InMemoryHashChainAuditLog()
  const hiddenProvenanceRunner = new GovernedConnectorRunner(new ConnectorRegistry([hiddenProvenanceConnector]), hiddenProvenanceAudit, new TestQuota(), now)
  await assert.rejects(() => hiddenProvenanceRunner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' }, { connectorId: hiddenProvenanceConnector.id })), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'INVALID_CONNECTOR_RESULT')
  assert.equal(hiddenProvenanceAudit.entries.length, 2)
  assert.equal(JSON.stringify(hiddenProvenanceAudit.entries).includes(privateError), false)

  let provenanceGetterRead = false
  const malformedConnector = {
    id: 'synthetic-image-malformed-result', kind: 'media-generation' as const, authKind: 'owner-token' as const, scopes: ['image:generate'],
    run: async () => {
      const result = { data: {}, confidence: 0 }
      Object.defineProperty(result, 'provenance', { enumerable: true, get: () => { provenanceGetterRead = true; return {} } })
      return result as never
    },
  }
  const malformedAudit = new InMemoryHashChainAuditLog()
  const malformedRunner = new GovernedConnectorRunner(new ConnectorRegistry([malformedConnector]), malformedAudit, new TestQuota(), now)
  await assert.rejects(() => malformedRunner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' }, { connectorId: malformedConnector.id })), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'INVALID_CONNECTOR_RESULT')
  assert.equal(provenanceGetterRead, false)
  assert.equal(malformedAudit.entries.length, 2)
  assert.equal(malformedAudit.entries[1]?.event.detail.error, 'CONNECTOR_RUN_FAILED')
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

test('terminal review refuses an orphan direct ledger append before it writes an audit or receipt', async () => {
  const persistence = new TestGclPersistence()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), new PrismaHashChainAuditLog(persistence), new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const ledger = new PrismaImageOwnerReviewLedger(persistence)
  const orphan = {
    type: 'connector.artifact.owner_liked' as const,
    connectorId: 'image-tti', product: context.product, workspaceId: context.workspaceId, actor: 'checker@example.test', correlationId: context.correlationId,
    scopes: ['image:generate'], costCapCents: 0, requestedItems: 1, occurredAt: now().toISOString(),
    detail: {
      candidateId: candidate.candidateId, maker: context.actor, publication: 'blocked' as const,
      issuanceAuditHash: 'a'.repeat(64), runAuditHash: result.provenance.auditHash, artifactId: `owner-liked-${candidate.candidateId}`, ownerReview: 'liked' as const,
    },
  }
  await assert.rejects(() => ledger.appendDecision(orphan), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 2)
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_IMAGE_OWNER_REVIEW_MODULE_ID).length, 0)
})

test('a returned liked artifact requires an exact terminal receipt proof', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const { candidate, candidates } = await governedIssuedRun(audit)
  let appended = 0
  let checked = 0
  const missingReceiptLedger = {
    appendDecision: async () => { appended += 1; return { hash: 'f'.repeat(64) } },
    assertRecorded: async () => { checked += 1; return { auditHash: 'f'.repeat(64), issuanceAuditHash: 'a'.repeat(64), runAuditHash: 'b'.repeat(64) } },
  }
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', missingReceiptLedger as never, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  assert.equal(appended, 1)
  assert.equal(checked, 1)
  assert.equal(audit.entries.length, 3)
})

test('owner review rejects malformed, cross-scope, or already-decided candidates before audit append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  const malformedUri = structuredClone(candidate)
  malformedUri.syntheticUri = 'https://provider.example/image.png'
  await assert.rejects(() => ownerLikeSyntheticImage(malformedUri, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  const movedScope = structuredClone(candidate)
  movedScope.scope.workspaceId = 'other-workspace'
  await assert.rejects(() => ownerLikeSyntheticImage(movedScope, true, 'checker@example.test', reviews, candidates, { ...context, workspaceId: 'other-workspace' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  const decided = structuredClone(candidate)
  decided.ownerReview.status = 'liked'
  await assert.rejects(() => ownerLikeSyntheticImage(decided, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_NOT_PENDING_OWNER_REVIEW')
  const extendedExpiry = structuredClone(candidate)
  extendedExpiry.ownerReview.reviewExpiresAt = '2026-07-22T13:00:00.000Z'
  await assert.rejects(() => ownerLikeSyntheticImage(extendedExpiry, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  const extraData = structuredClone(candidate) as Record<string, unknown>
  extraData.prompt = 'PRIVATE-OWNER-PROMPT-ONLY'
  await assert.rejects(() => ownerLikeSyntheticImage(extraData as never, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  assert.equal(audit.entries.length, 3)
})

test('expired candidates cannot be issued or terminally reviewed, including at the exact deadline', async () => {
  const issuedAt = () => new Date('2026-07-22T12:00:00.000Z')
  const deadline = () => new Date('2026-07-22T12:01:00.000Z')
  const connector = new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 60 })
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, new TestQuota(), issuedAt)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  assert.equal(candidate.ownerReview.reviewExpiresAt, '2026-07-22T12:01:00.000Z')

  const unissued = new InMemoryImageCandidateLedger(audit)
  await assert.rejects(() => issueSyntheticImageCandidates(result, unissued, { ...context, now: deadline }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_EXPIRED')
  assert.equal(audit.entries.length, 2)

  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, { ...context, now: issuedAt })
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, { ...context, now: deadline }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_EXPIRED')
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'NEEDS_REVISION', reviews, candidates, { ...context, now: deadline }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_EXPIRED')
  assert.equal(audit.entries.length, 3)
})

test('candidate issuance and terminal review cannot be backdated across the governed lineage', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const earlier = () => new Date('2026-07-22T11:59:59.999Z')
  const candidates = new InMemoryImageCandidateLedger(audit)
  await assert.rejects(() => issueSyntheticImageCandidates(result, candidates, { ...context, now: earlier }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_ISSUANCE_BEFORE_RUN_SUCCESS')
  assert.equal(audit.entries.length, 2)

  await issueSyntheticImageCandidates(result, candidates, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, { ...context, now: earlier }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_BEFORE_CANDIDATE_ISSUANCE')
  assert.equal(audit.entries.length, 3)
})

test('candidate issuance rejects direct output, binds the full redacted candidate, and is replay-safe', async () => {
  const directLedger = new InMemoryImageCandidateLedger(new InMemoryHashChainAuditLog())
  const direct = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  await assert.rejects(() => issueSyntheticImageCandidates(direct, directLedger, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_RESULT')

  const audit = new InMemoryHashChainAuditLog()
  const { candidate, candidates, result } = await governedIssuedRun(audit)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), new InMemoryImageCandidateLedger(audit), context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_NOT_ISSUED')
  const alteredSafety = structuredClone(candidate)
  alteredSafety.safety.filterId = 'another-safe-policy'
  await assert.rejects(() => ownerLikeSyntheticImage(alteredSafety, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_NOT_ISSUED')
  await assert.rejects(() => issueSyntheticImageCandidates(result, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_ALREADY_ISSUED')
  assert.equal(audit.entries.length, 3)

  const concurrentAudit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), concurrentAudit, new TestQuota(), now)
  const concurrentResult = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const forgedResult = structuredClone(concurrentResult)
  forgedResult.provenance.auditHash = 'f'.repeat(64)
  await assert.rejects(() => issueSyntheticImageCandidates(forgedResult, new InMemoryImageCandidateLedger(concurrentAudit), context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_RUN_AUDIT_NOT_FOUND')
  const unrelatedDirectResult = await configuredConnector().run({ prompt: 'A different child-friendly synthetic scene' }, context)
  unrelatedDirectResult.provenance.auditHash = concurrentResult.provenance.auditHash
  await assert.rejects(() => issueSyntheticImageCandidates(unrelatedDirectResult, new InMemoryImageCandidateLedger(concurrentAudit), context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_CANDIDATE_RUN_AUDIT_NOT_FOUND')
  const concurrentLedger = new InMemoryImageCandidateLedger(concurrentAudit)
  const issuances = await Promise.allSettled([
    issueSyntheticImageCandidates(concurrentResult, concurrentLedger, context),
    issueSyntheticImageCandidates(concurrentResult, concurrentLedger, context),
  ])
  assert.equal(issuances.filter((issuance) => issuance.status === 'fulfilled').length, 1)
  assert.equal(concurrentAudit.entries.length, 3)
})

test('accessor-shaped input and family-safety hooks fail closed without executing getters', async () => {
  let inputGetterRead = false
  const input = {}
  Object.defineProperty(input, 'prompt', { enumerable: true, get: () => { inputGetterRead = true; return 'should-not-be-read' } })
  await assert.rejects(() => configuredConnector().run(input as never, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_INPUT')
  assert.equal(inputGetterRead, false)

  let filterGetterRead = false
  const filter = { assess: () => ({ allowed: true }) }
  Object.defineProperty(filter, 'id', { enumerable: true, get: () => { filterGetterRead = true; return 'should-not-be-read' } })
  const connector = new SyntheticImageTtiConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 20, maxItems: 2, ownerReviewTtlSeconds: 300, familySafetyFilter: filter as never })
  await assert.rejects(() => connector.run({ prompt: 'A child-friendly solar system poster' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  assert.equal(filterGetterRead, false)
})

test('direct image contexts and ledger capability boundaries reject accessors without invoking them', async () => {
  let runContextGetterRead = false
  const runContext = {}
  Object.defineProperty(runContext, 'product', { enumerable: true, get: () => { runContextGetterRead = true; return context.product } })
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, runContext as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_CONTEXT')
  assert.equal(runContextGetterRead, false)

  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  let issuanceContextGetterRead = false
  const issuanceContext = {}
  Object.defineProperty(issuanceContext, 'product', { enumerable: true, get: () => { issuanceContextGetterRead = true; return context.product } })
  await assert.rejects(() => issueSyntheticImageCandidates(result, new InMemoryImageCandidateLedger(audit), issuanceContext as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  assert.equal(issuanceContextGetterRead, false)
  assert.equal(audit.entries.length, 2)

  let issuanceLedgerGetterRead = false
  const issuanceLedger = {}
  Object.defineProperty(issuanceLedger, 'appendIssuance', { enumerable: true, get: () => { issuanceLedgerGetterRead = true; return async () => ({ hash: '0'.repeat(64) }) } })
  await assert.rejects(() => issueSyntheticImageCandidates(result, issuanceLedger as never, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
  assert.equal(issuanceLedgerGetterRead, false)
  assert.equal(audit.entries.length, 2)

  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  let reviewContextGetterRead = false
  const reviewContext = {}
  Object.defineProperty(reviewContext, 'product', { enumerable: true, get: () => { reviewContextGetterRead = true; return context.product } })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), candidates, reviewContext as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  assert.equal(reviewContextGetterRead, false)

  let reviewLedgerGetterRead = false
  const reviewLedger = {}
  Object.defineProperty(reviewLedger, 'appendDecision', { enumerable: true, get: () => { reviewLedgerGetterRead = true; return async () => ({ hash: '0'.repeat(64) }) } })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviewLedger as never, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_LEDGER_UNAVAILABLE')
  assert.equal(reviewLedgerGetterRead, false)

  let candidateLedgerGetterRead = false
  const candidateLedger = {}
  Object.defineProperty(candidateLedger, 'assertIssued', { enumerable: true, get: () => { candidateLedgerGetterRead = true; return async () => ({ issuanceAuditHash: '0'.repeat(64), runAuditHash: '0'.repeat(64), issuanceOccurredAt: now().toISOString() }) } })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), candidateLedger as never, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
  assert.equal(candidateLedgerGetterRead, false)
  assert.equal(audit.entries.length, 3)
})

test('test-only image ledgers fail closed on accessor-backed audit seams and responses', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>

  const inheritedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'appendIssuance')
  let inheritedAppendCalled = false
  Object.defineProperty(Object.prototype, 'appendIssuance', { configurable: true, value: async () => { inheritedAppendCalled = true; return { hash: '0'.repeat(64) } } })
  try {
    await assert.rejects(() => issueSyntheticImageCandidates(result, {} as never, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
  } finally {
    if (inheritedDescriptor) Object.defineProperty(Object.prototype, 'appendIssuance', inheritedDescriptor)
    else delete (Object.prototype as { appendIssuance?: unknown }).appendIssuance
  }
  assert.equal(inheritedAppendCalled, false)

  let entriesGetterRead = false
  let candidateAppendCalled = false
  const entriesAccessorAudit = {
    append: async () => { candidateAppendCalled = true; return { hash: '0'.repeat(64) } },
  }
  Object.defineProperty(entriesAccessorAudit, 'entries', { enumerable: true, get: () => { entriesGetterRead = true; return audit.entries } })
  await assert.rejects(() => issueSyntheticImageCandidates(result, new InMemoryImageCandidateLedger(entriesAccessorAudit as never), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
  assert.equal(entriesGetterRead, false)
  assert.equal(candidateAppendCalled, false)

  let appendGetterRead = false
  const appendAccessorAudit = { entries: audit.entries }
  Object.defineProperty(appendAccessorAudit, 'append', { enumerable: true, get: () => { appendGetterRead = true; return async () => ({ hash: '0'.repeat(64) }) } })
  await assert.rejects(() => issueSyntheticImageCandidates(result, new InMemoryImageCandidateLedger(appendAccessorAudit as never), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
  assert.equal(appendGetterRead, false)

  let hashGetterRead = false
  const hashAccessorAudit = {
    entries: audit.entries,
    append: async () => {
      const response = {}
      Object.defineProperty(response, 'hash', { enumerable: true, get: () => { hashGetterRead = true; return '0'.repeat(64) } })
      return response
    },
  }
  await assert.rejects(() => issueSyntheticImageCandidates(result, new InMemoryImageCandidateLedger(hashAccessorAudit as never), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
  assert.equal(hashGetterRead, false)
  assert.equal(audit.entries.length, 2)

  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  let reviewAppendGetterRead = false
  const reviewAudit = {}
  Object.defineProperty(reviewAudit, 'append', { enumerable: true, get: () => { reviewAppendGetterRead = true; return async () => ({ hash: '0'.repeat(64) }) } })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(reviewAudit as never), candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
  assert.equal(reviewAppendGetterRead, false)
  assert.equal(audit.entries.length, 3)
})

test('image ledger event scopes reject accessor arrays before reading a scope value', async () => {
  let candidateScopeGetterRead = false
  const candidateScopes: unknown[] = []
  Object.defineProperty(candidateScopes, '0', { enumerable: true, get: () => { candidateScopeGetterRead = true; return 'image:generate' } })
  candidateScopes.length = 1
  const candidateId = 'synthetic-image-00000000000000000000'
  const entry = { candidateId, fingerprint: '0'.repeat(64) }
  const candidateEvent = {
    type: 'connector.artifact.candidates_issued' as const,
    connectorId: 'image-tti', product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
    scopes: candidateScopes, costCapCents: 0, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { candidateSetDigest: imageCandidateFingerprint([entry]), candidateCount: 1, candidates: [entry], publication: 'blocked' as const, runAuditHash: '1'.repeat(64) },
  }
  await assert.rejects(() => new InMemoryImageCandidateLedger(new InMemoryHashChainAuditLog()).appendIssuance(candidateEvent as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  assert.equal(candidateScopeGetterRead, false)

  let reviewScopeGetterRead = false
  const reviewScopes: unknown[] = []
  Object.defineProperty(reviewScopes, '0', { enumerable: true, get: () => { reviewScopeGetterRead = true; return 'image:generate' } })
  reviewScopes.length = 1
  const reviewEvent = {
    type: 'connector.artifact.owner_liked' as const,
    connectorId: 'image-tti', product: context.product, workspaceId: context.workspaceId, actor: 'checker@example.test', correlationId: context.correlationId,
    scopes: reviewScopes, costCapCents: 0, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { candidateId, maker: context.actor, publication: 'blocked' as const, issuanceAuditHash: '2'.repeat(64), runAuditHash: '3'.repeat(64), artifactId: `owner-liked-${candidateId}`, ownerReview: 'liked' as const },
  }
  await assert.rejects(() => new InMemoryImageOwnerReviewLedger(new InMemoryHashChainAuditLog()).appendDecision(reviewEvent as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_OWNER_REVIEW_EVENT')
  assert.equal(reviewScopeGetterRead, false)
})

test('candidate issuance rejects accessor-shaped candidate sets before it reads an untrusted array item', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  let getterRead = false
  const candidates: unknown[] = []
  Object.defineProperty(candidates, '0', { enumerable: true, get: () => { getterRead = true; return result.data.candidates[0] } })
  const forged = structuredClone(result)
  forged.data.candidates = candidates as never
  await assert.rejects(() => issueSyntheticImageCandidates(forged, new InMemoryImageCandidateLedger(audit), context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_RESULT')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 2)
})

test('hidden own fields cannot bypass image, candidate, review, or audit envelopes', async () => {
  const privateValue = 'PRIVATE-HIDDEN-OWN-FIELD'
  const hiddenInput = { prompt: 'A child-friendly solar system poster' }
  Object.defineProperty(hiddenInput, 'providerCredential', { enumerable: false, value: privateValue })
  await assert.rejects(() => configuredConnector().run(hiddenInput as never, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_IMAGE_TTI_FIELD')

  const audit = new InMemoryHashChainAuditLog()
  const { candidate, candidates } = await governedIssuedRun(audit)
  const hiddenCandidate = structuredClone(candidate) as Record<string, unknown>
  Object.defineProperty(hiddenCandidate, 'rawPrompt', { enumerable: false, value: privateValue })
  await assert.rejects(() => ownerLikeSyntheticImage(hiddenCandidate as never, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')

  const issuance = audit.entries[2]
  assert.ok(issuance)
  assert.equal(issuance.event.type, 'connector.artifact.candidates_issued')
  const hiddenIssuance = structuredClone(issuance.event)
  Object.defineProperty(hiddenIssuance, 'providerEndpoint', { enumerable: false, value: privateValue })
  await assert.rejects(() => new InMemoryImageCandidateLedger(audit).appendIssuance(hiddenIssuance as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')

  const hiddenDecision = {
    type: 'connector.artifact.owner_liked' as const,
    connectorId: 'image-tti', product: context.product, workspaceId: context.workspaceId, actor: 'checker@example.test', correlationId: context.correlationId,
    scopes: ['image:generate'], costCapCents: 0, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { candidateId: candidate.candidateId, maker: context.actor, publication: 'blocked' as const, issuanceAuditHash: issuance.hash, runAuditHash: issuance.event.detail.runAuditHash, artifactId: `owner-liked-${candidate.candidateId}`, ownerReview: 'liked' as const },
  }
  Object.defineProperty(hiddenDecision.detail, 'rawPrompt', { enumerable: false, value: privateValue })
  await assert.rejects(() => new InMemoryImageOwnerReviewLedger(audit).appendDecision(hiddenDecision as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_OWNER_REVIEW_EVENT')
  assert.equal(audit.entries.length, 3)
  assert.equal(JSON.stringify(audit.entries).includes(privateValue), false)
})

test('injected image clocks reject Date subclasses without evaluating overridden methods', async () => {
  class PoisonedDate extends Date {}
  let getterRead = false
  Object.defineProperty(PoisonedDate.prototype, 'getTime', { get: () => { getterRead = true; throw new Error('clock getter must not run') } })
  const poisonedNow = () => new PoisonedDate('2026-07-22T12:00:00.000Z')

  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, { ...context, now: poisonedNow }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_CONTEXT')
  assert.equal(getterRead, false)

  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  await assert.rejects(() => issueSyntheticImageCandidates(result, new InMemoryImageCandidateLedger(audit), { ...context, now: poisonedNow }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 2)

  const candidates = new InMemoryImageCandidateLedger(audit)
  await issueSyntheticImageCandidates(result, candidates, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), candidates, { ...context, now: poisonedNow }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 3)
})

test('the candidate ledger rejects accessor-shaped issuance entries before it reads an entry', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), audit, new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  let getterRead = false
  const entries: unknown[] = []
  Object.defineProperty(entries, '0', { enumerable: true, get: () => { getterRead = true; return { candidateId: 'synthetic-image-00000000000000000000', fingerprint: '0'.repeat(64) } } })
  entries.length = context.requestedItems
  const event = {
    type: 'connector.artifact.candidates_issued' as const,
    connectorId: 'image-tti', product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
    scopes: ['image:generate'], costCapCents: 0, requestedItems: context.requestedItems, occurredAt: now().toISOString(),
    detail: { candidateSetDigest: imageCandidateSetDigest(result.data.candidates), candidateCount: context.requestedItems, candidates: entries, publication: 'blocked' as const, runAuditHash: result.provenance.auditHash },
  }
  await assert.rejects(() => new InMemoryImageCandidateLedger(audit).appendIssuance(event as never), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 2)
})

test('owner review rejects an accessor-shaped Creative Worker graph without reading it', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  const forged = structuredClone(candidate)
  let getterRead = false
  const graphShape: unknown[] = []
  Object.defineProperty(graphShape, '0', { enumerable: true, get: () => { getterRead = true; return 'PRIVATE-OWNER-PROMPT-ONLY' } })
  forged.creativeWorkerPlan.graphShape = graphShape as never
  await assert.rejects(() => ownerLikeSyntheticImage(forged, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_REVIEW_CANDIDATE')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 3)
})

test('owner review rejects a malformed candidate-ledger proof before adding its audit event', async () => {
  const result = await configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, context)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  const audit = new InMemoryHashChainAuditLog()
  const malformedProofLedger = {
    assertIssued: async () => ({ issuanceAuditHash: 'a'.repeat(64), runAuditHash: 'b'.repeat(64), issuanceOccurredAt: now().toISOString(), extra: true }),
  }
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new InMemoryImageOwnerReviewLedger(audit), malformedProofLedger as never, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_LEDGER_INVALID')
  assert.equal(audit.entries.length, 0)
})

test('terminal owner-review ledger permits one decision only, including a concurrent opposite decision', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)

  const decisions = await Promise.allSettled([
    ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context),
    ownerRejectSyntheticImage(candidate, true, 'checker-two@example.test', 'NEEDS_REVISION', reviews, candidates, context),
  ])
  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1)
  assert.equal(audit.entries.length, 4)
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker@example.test', 'SAFETY_CONCERN', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
  assert.equal(audit.entries.length, 4)
})

test('a corrupt audit tail fail-closes a terminal review before another decision append', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  audit.entries.push({ event: {} as never, previousHash: null, hash: '0'.repeat(64) } as never)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(audit.entries.length, 4)
})

test('candidate proof rejects a self-consistent audit entry whose predecessor breaks the chain', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  const succeeded = audit.entries[1]
  assert.ok(succeeded)
  const forgedSuccess = { ...succeeded, previousHash: null }
  forgedSuccess.hash = hashAuditEvent(forgedSuccess.event, forgedSuccess.previousHash)
  audit.entries[1] = forgedSuccess
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(audit.entries.length, 3)
})

test('a self-consistent audit timestamp regression cannot authorize an image owner review', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  const succeeded = audit.entries[1]
  const issuance = audit.entries[2]
  assert.ok(succeeded)
  assert.ok(issuance)
  succeeded.event.occurredAt = '2026-07-22T11:59:59.999Z'
  succeeded.hash = hashAuditEvent(succeeded.event, succeeded.previousHash)
  issuance.previousHash = succeeded.hash
  issuance.hash = hashAuditEvent(issuance.event, issuance.previousHash)

  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_TIME_REGRESSION')
  assert.equal(audit.entries.length, 3)
})

test('the audit log rejects a newly appended event whose canonical timestamp predates its tail', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested = {
    type: 'connector.run.requested' as const,
    connectorId: 'image-tti',
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    scopes: ['image:generate'],
    costCapCents: 20,
    requestedItems: 1,
    occurredAt: '2026-07-22T12:00:00.000Z',
    detail: {},
  }
  await audit.append(requested)
  await assert.rejects(() => audit.append({ ...requested, occurredAt: '2026-07-22T11:59:59.999Z' }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_TIME_REGRESSION')
  assert.equal(audit.entries.length, 1)
})

test('the closed audit envelope rejects nested accessor detail without reading it', async () => {
  const audit = new InMemoryHashChainAuditLog()
  let getterRead = false
  const candidates: unknown[] = []
  Object.defineProperty(candidates, '0', { enumerable: true, get: () => { getterRead = true; return 'PRIVATE-OWNER-PROMPT-ONLY' } })
  const event = {
    type: 'connector.run.requested' as const,
    connectorId: 'image-tti',
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    scopes: ['image:generate'],
    costCapCents: 20,
    requestedItems: 1,
    occurredAt: '2026-07-22T12:00:00.000Z',
    detail: { candidates },
  }
  await assert.rejects(() => audit.append(event), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 0)
})

test('accessor-shaped stored audit records fail closed without executing their getters', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  let getterRead = false
  const malformed = {}
  Object.defineProperty(malformed, 'event', { enumerable: true, get: () => { getterRead = true; return {} } })
  audit.entries.push(malformed as never)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 4)
})

test('an accessor-shaped stored audit record array fails closed without reading its item', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemoryImageOwnerReviewLedger(audit)
  const { candidate, candidates } = await governedIssuedRun(audit)
  const first = audit.entries[0]
  assert.ok(first)
  let getterRead = false
  delete audit.entries[0]
  Object.defineProperty(audit.entries, '0', { enumerable: true, get: () => { getterRead = true; return first } })
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(getterRead, false)
  assert.equal(audit.entries.length, 3)
})

test('durable owner-review ledger commits one redacted receipt with its audit event and rolls back invalid state', async () => {
  const persistence = new TestGclPersistence()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), new PrismaHashChainAuditLog(persistence), new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const candidates = new PrismaImageCandidateLedger(persistence)
  await issueSyntheticImageCandidates(result, candidates, context)
  const reviews = new PrismaImageOwnerReviewLedger(persistence)
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await ownerLikeSyntheticImage(candidate, true, 'checker@example.test', reviews, candidates, context)
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 4)
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_IMAGE_CANDIDATE_MODULE_ID).length, 2)
  const receipts = persistence.records.filter((record) => record.moduleId === GCL_IMAGE_OWNER_REVIEW_MODULE_ID)
  assert.equal(receipts.length, 1)
  assert.equal(JSON.stringify(receipts[0]?.values).includes('child-friendly solar system poster'), false)
  await assert.rejects(() => ownerRejectSyntheticImage(candidate, true, 'checker-two@example.test', 'NEEDS_REVISION', reviews, candidates, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 4)

  const corrupt = new TestGclPersistence()
  const corruptRunner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), new PrismaHashChainAuditLog(corrupt), new TestQuota(), now)
  const corruptResult = await corruptRunner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const corruptCandidates = new PrismaImageCandidateLedger(corrupt)
  await issueSyntheticImageCandidates(corruptResult, corruptCandidates, context)
  corrupt.records.push({ id: 'bad-receipt', product: context.product, workspaceId: context.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID, values: { unexpected: true }, createdAt: now() })
  const corruptCandidate = corruptResult.data.candidates[0]
  assert.ok(corruptCandidate)
  await assert.rejects(() => ownerLikeSyntheticImage(corruptCandidate, true, 'checker@example.test', new PrismaImageOwnerReviewLedger(corrupt), corruptCandidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  assert.equal(corrupt.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 3)
})

test('durable candidate receipts fail closed when their issuance timestamp no longer matches the audit event', async () => {
  const persistence = new TestGclPersistence()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([configuredConnector()]), new PrismaHashChainAuditLog(persistence), new TestQuota(), now)
  const result = await runner.run(governedRunRequest({ prompt: 'A child-friendly solar system poster' })) as ConnectorResult<TextToImageData>
  const candidates = new PrismaImageCandidateLedger(persistence)
  await issueSyntheticImageCandidates(result, candidates, context)
  const stored = persistence.records.find((record) => record.moduleId === GCL_IMAGE_CANDIDATE_MODULE_ID)
  assert.ok(stored)
  ;(stored.values as { issuanceOccurredAt: string }).issuanceOccurredAt = '2026-07-22T11:59:59.999Z'
  const candidate = result.data.candidates[0]
  assert.ok(candidate)
  await assert.rejects(() => ownerLikeSyntheticImage(candidate, true, 'checker@example.test', new PrismaImageOwnerReviewLedger(persistence), candidates, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_CANDIDATE_LEDGER_INVALID')
  assert.equal(persistence.records.filter((record) => record.moduleId === GCL_AUDIT_MODULE_ID).length, 3)
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
  const configured = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: LIVE_DISABLED, GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2', GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS: '300' })
  const result = await configured.run({ prompt: 'A child-friendly solar system poster' }, context)
  assert.equal(result.data.mode, LIVE_DISABLED)

  const invalid = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: 'LIVE_ENABLED', GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2', GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS: '300' })
  await assert.rejects(() => invalid.run({ prompt: 'A child-friendly solar system poster' }, context), ConnectorUnavailableError)

  const invalidTtl = syntheticImageTtiConnectorFromEnvironment({ GCL_IMAGE_LIVE_MODE: LIVE_DISABLED, GCL_IMAGE_MAX_COST_CENTS: '20', GCL_IMAGE_MAX_ITEMS: '2', GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS: '59' })
  await assert.rejects(() => invalidTtl.run({ prompt: 'A child-friendly solar system poster' }, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'IMAGE_OWNER_REVIEW_TTL_NOT_CONFIGURED')
})

test('direct connector use also rejects malformed context and unexpected input fields', async () => {
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster', providerKey: 'not-accepted' } as never, context), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_IMAGE_TTI_FIELD')
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, { ...context, correlationId: 'unsafe/correlation-id' }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_CONTEXT')
  await assert.rejects(() => configuredConnector().run({ prompt: 'A child-friendly solar system poster' }, { ...context, now: () => new Date('not-a-date') }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_IMAGE_TTI_CONTEXT')
})

test('GCL audit, quota, review, and candidate records stay outside generic product CRUD', () => {
  assert.equal(isInternalGclModuleId(GCL_AUDIT_MODULE_ID), true)
  assert.equal(isInternalGclModuleId(GCL_IMAGE_CANDIDATE_MODULE_ID), true)
  assert.equal(isInternalGclModuleId(GCL_IMAGE_OWNER_REVIEW_MODULE_ID), true)
  assert.equal(isInternalGclModuleId('image-owner-review'), false)
  assert.equal(isInternalGclModuleId('gcl'), false)
})

test('daily image quota configuration is positive-integer-only and fail-closed', () => {
  assert.deepEqual(imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '5', GCL_IMAGE_DAILY_ITEM_QUOTA: '10' }), { dailyRuns: 5, dailyItems: 10 })
  assert.throws(() => imageDailyQuotaFromEnvironment({ GCL_IMAGE_DAILY_RUN_QUOTA: '0', GCL_IMAGE_DAILY_ITEM_QUOTA: 'ten' }), ConnectorUnavailableError)
})
