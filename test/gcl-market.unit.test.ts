import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { ADOS_10_MARKET_CONTROLS, MARKET_CONNECTOR_ID, MARKET_LIVE_STATUS, MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION, MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION, MARKET_REVIEW_AUDIT_WITNESS_VERSION, MARKET_REVIEW_RECEIPT_VERSION, SyntheticMarketConnector, createSyntheticMarketReviewAuditTrailReceipt, independentlyReviewSyntheticMarketPlan, syntheticMarketConnectorFromEnvironment, validateSyntheticMarketPlanForReview, validateSyntheticMarketReviewAuditTrailReceipt, validateSyntheticMarketReviewAuditTrailWitness, validateSyntheticMarketReviewAuditWitness, validateSyntheticMarketReviewReceipt, type MarketCapacityQuoteInput, type MarketReviewContext, type SyntheticMarketConnectorConfig, type SyntheticMarketPlan } from '../src/gcl/market.js'
import { InMemorySyntheticMarketReviewLedger } from '../src/gcl/market-review-ledger.js'
import { dailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const limits: SyntheticMarketConnectorConfig = {
  liveEnabled: false,
  maxCostCapCents: 50,
  maxItems: 3,
  maxCapacityUnits: 10,
}
const capacityQuote: MarketCapacityQuoteInput = {
  operation: 'capacity-quote',
  transportMode: 'road',
  originCountry: 'tr',
  destinationCountry: 'de',
  requestedListings: 1,
  requestedCapacityUnits: 2,
}
const context: ConnectorRunContext = {
  product: 'sectrai-gcl-market-test',
  workspaceId: 'ws-market',
  actor: 'owner@example.test',
  ownerApproved: true,
  scopes: ['market:capacity:quote'],
  costCapCents: 50,
  requestedItems: 1,
  now,
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; quotaGroup?: string; requestedItems: number }> = []

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    this.requests.push({ connectorId: request.connectorId, quotaGroup: request.quotaGroup, requestedItems: request.requestedItems })
  }
}

function marketRunner(config = limits) {
  const connector = new SyntheticMarketConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const reviews = new InMemorySyntheticMarketReviewLedger(audit)
  const quota = new TestQuota()
  return { connector, audit, reviews, quota, runner: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now) }
}

test('synthetic market returns only an owner-review plan and never a quote, booking, reservation, publication, or provider contact', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan

  assert.equal(plan.mode, 'SYNTHETIC')
  assert.equal(plan.liveStatus, 'LIVE_DISABLED')
  assert.equal(plan.state, 'OWNER_REVIEW_REQUIRED')
  assert.deepEqual(plan.binding, {
    product: context.product,
    workspaceId: context.workspaceId,
    requestedBy: context.actor,
    scopes: ['market:capacity:quote'],
    costCapCents: 50,
    requestedItems: 1,
  })
  assert.match(plan.integrity.digest, /^[a-f0-9]{64}$/)
  assert.equal(plan.ownerReview.state, 'PENDING_INDEPENDENT_OWNER_REVIEW')
  assert.equal(plan.ownerReview.makerCanReview, false)
  assert.equal(plan.ownerReview.decisionAuthorizesExecution, false)
  assert.equal(plan.reviewPacket.version, 'synthetic-market-review-packet-v1')
  assert.equal(plan.reviewPacket.state, 'PENDING_INDEPENDENT_OWNER_REVIEW')
  assert.equal(plan.reviewPacket.planDigest, plan.integrity.digest)
  assert.match(plan.reviewPacket.reviewId, /^synthetic-market-review-[a-f0-9]{24}$/)
  assert.match(plan.reviewPacket.bindingDigest, /^[a-f0-9]{64}$/)
  assert.match(plan.reviewPacket.integrity.digest, /^[a-f0-9]{64}$/)
  assert.deepEqual(plan.reviewPacket.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(plan.request.originCountry, 'TR')
  assert.deepEqual(plan.quote, { state: 'NOT_QUOTED', reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' })
  assert.deepEqual(plan.sources, [
    { id: 'internal-capacity-market', state: 'NOT_QUERIED', autoSync: false, credentialsAccepted: false },
    { id: 'hub-connect', state: 'NOT_CONTACTED', autoSync: false, credentialsAccepted: false },
  ])
  assert.deepEqual(plan.sideEffects, { externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(result.confidence, 0)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(setup.quota.requests[0]?.connectorId, MARKET_CONNECTOR_ID)
  assert.equal(setup.quota.requests[0]?.quotaGroup, 'market')
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(result.provenance.auditHash, setup.audit.entries[1]?.hash)
})

test('synthetic market closes when a live flag is attempted', async () => {
  const setup = marketRunner({ ...limits, liveEnabled: true })
  await assert.rejects(
    () => setup.connector.run(capacityQuote, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === MARKET_LIVE_STATUS,
  )
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('synthetic market environment factory rejects missing limits and a true live flag', async () => {
  const missing = syntheticMarketConnectorFromEnvironment({ GCL_MARKET_LIVE_ENABLED: 'false' })
  await assert.rejects(
    () => missing.run(capacityQuote, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED',
  )
  const liveAttempt = syntheticMarketConnectorFromEnvironment({
    GCL_MARKET_LIVE_ENABLED: 'true',
    GCL_MARKET_MAX_COST_CENTS: '50',
    GCL_MARKET_MAX_ITEMS: '3',
    GCL_MARKET_MAX_CAPACITY_UNITS: '10',
  })
  await assert.rejects(
    () => liveAttempt.run(capacityQuote, context),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === MARKET_LIVE_STATUS,
  )
})

test('synthetic market environment factory fails closed unless its live flag is exactly false', async () => {
  const configured = {
    GCL_MARKET_MAX_COST_CENTS: '50',
    GCL_MARKET_MAX_ITEMS: '3',
    GCL_MARKET_MAX_CAPACITY_UNITS: '10',
  }
  for (const liveFlag of [undefined, 'true', 'TRUE', 'unexpected']) {
    const connector = syntheticMarketConnectorFromEnvironment({ ...configured, ...(liveFlag === undefined ? {} : { GCL_MARKET_LIVE_ENABLED: liveFlag }) })
    await assert.rejects(
      () => connector.run(capacityQuote, context),
      (error: unknown) => error instanceof ConnectorUnavailableError && error.message === MARKET_LIVE_STATUS,
    )
  }
  const permitted = syntheticMarketConnectorFromEnvironment({ ...configured, GCL_MARKET_LIVE_ENABLED: 'false' })
  assert.equal((await permitted.run(capacityQuote, context)).data.liveStatus, 'LIVE_DISABLED')
})

test('synthetic market rejects missing operation scope and mismatched listing quota before audit or quota reservation', async () => {
  const setup = marketRunner()
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, scopes: ['market:discover'] }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_OPERATION_SCOPE_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, requestedItems: 2 }),
    (error: unknown) => error instanceof Error && error.message === 'MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, workspaceId: 'invalid/workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_CONTEXT',
  )
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('synthetic market owner gate rejects before proposal creation', async () => {
  const setup = marketRunner()
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, ownerApproved: false }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('synthetic market also rejects invalid direct-run governance values instead of trusting only the runner', async () => {
  const connector = new SyntheticMarketConnector(limits)
  await assert.rejects(
    () => connector.run(capacityQuote, { ...context, costCapCents: 0 }),
    (error: unknown) => error instanceof CostCapError && error.message === 'MARKET_COST_CAP_REQUIRED',
  )
  await assert.rejects(
    () => connector.run(capacityQuote, { ...context, requestedItems: 0 }),
    (error: unknown) => error instanceof CostCapError && error.message === 'MARKET_REQUESTED_ITEMS_REQUIRED',
  )
  await assert.rejects(
    () => connector.run(capacityQuote, { ...context, product: 'invalid/product' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_CONTEXT',
  )
  await assert.rejects(
    () => connector.run(capacityQuote, { ...context, scopes: ['market:capacity:quote', 'market:provider:write'] }),
    (error: unknown) => error instanceof ScopeError && error.message === 'MARKET_SCOPE_DENIED',
  )
  await assert.rejects(
    () => connector.run(Object.create(capacityQuote), context),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REQUEST',
  )
})

test('a distinct owner can audit a market review, but neither decision can authorize an execution', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }

  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', false, 'checker@example.test', setup.reviews, reviewContext),
    OwnerGateError,
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, context.actor, setup.reviews, reviewContext),
    (error: unknown) => error instanceof MakerCheckerError && error.message === 'MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, { ...reviewContext, scopes: ['market:discover'] }),
    (error: unknown) => error instanceof ScopeError && error.message === 'MARKET_REVIEW_SCOPE_REQUIRED',
  )
  const tampered = { ...plan, request: { ...plan.request, originCountry: 'FR' } }
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(tampered, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'approved' as never, true, 'checker@example.test', setup.reviews, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_DECISION',
  )
  assert.equal(setup.audit.entries.length, 2)

  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
  assert.equal(reviewed.decision, 'acknowledged')
  assert.equal(reviewed.reviewedBy, 'checker@example.test')
  assert.equal(reviewed.mode, 'SYNTHETIC')
  assert.equal(reviewed.reviewId, plan.reviewPacket.reviewId)
  assert.equal(reviewed.reviewPacketIntegrityDigest, plan.reviewPacket.integrity.digest)
  assert.deepEqual(reviewed.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(reviewed.auditHash, setup.audit.entries[2]?.hash)
  assert.equal(reviewed.reviewReceipt.version, MARKET_REVIEW_RECEIPT_VERSION)
  assert.equal(reviewed.reviewReceipt.planId, plan.id)
  assert.equal(reviewed.reviewReceipt.reviewId, plan.reviewPacket.reviewId)
  assert.equal(reviewed.reviewReceipt.planDigest, plan.integrity.digest)
  assert.equal(reviewed.reviewReceipt.reviewPacketIntegrityDigest, plan.reviewPacket.integrity.digest)
  assert.match(reviewed.reviewReceipt.receiptId, /^synthetic-market-review-receipt-[a-f0-9]{24}$/)
  assert.match(reviewed.reviewReceipt.reviewerDigest, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(reviewed.reviewReceipt).includes('checker@example.test'), false)
  assert.deepEqual(validateSyntheticMarketReviewReceipt(plan, reviewed, reviewContext), reviewed)
  assert.equal(setup.audit.entries[2]?.previousHash, setup.audit.entries[1]?.hash)
  assert.equal(setup.audit.entries[2]?.event.type, 'connector.market.owner_reviewed')
  assert.equal(setup.audit.entries[2]?.event.detail.maker, undefined)
  assert.equal(setup.audit.entries[2]?.event.detail.reviewPacketIntegrityDigest, plan.reviewPacket.integrity.digest)
  assert.equal(setup.quota.requests.length, 1)
})

test('D3 receipt validation is local-only and rejects receipt, plan, scope, sparse-array, and prototype drift without another write', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
  const clone = () => structuredClone(reviewed)
  const mustReject = (candidate: unknown, errorMessage: string) => assert.throws(
    () => validateSyntheticMarketReviewReceipt(plan, candidate, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === errorMessage,
  )

  const executionDrift = clone()
  executionDrift.reviewReceipt.execution.booking = true as never
  mustReject(executionDrift, 'INVALID_MARKET_REVIEW_RECEIPT_EXECUTION')

  const injected = clone() as typeof reviewed & { providerCredential?: string }
  injected.providerCredential = 'synthetic-not-accepted'
  mustReject(injected, 'UNEXPECTED_MARKET_REVIEW_RECEIPT_FIELD')

  const hiddenReceiptField = clone()
  Object.defineProperty(hiddenReceiptField.reviewReceipt, 'providerEndpoint', { value: 'synthetic-not-accepted' })
  mustReject(hiddenReceiptField, 'UNEXPECTED_MARKET_REVIEW_RECEIPT_FIELD')

  const prototypeReceipt = clone()
  Object.setPrototypeOf(prototypeReceipt.reviewReceipt, { providerAddress: 'synthetic-not-accepted' })
  mustReject(prototypeReceipt, 'UNEXPECTED_MARKET_REVIEW_RECEIPT_FIELD')

  const integrityDrift = clone()
  integrityDrift.reviewReceipt.integrity.digest = 'a'.repeat(64)
  mustReject(integrityDrift, 'MARKET_REVIEW_RECEIPT_INTEGRITY_INVALID')

  const prototypePlan = structuredClone(plan)
  Object.setPrototypeOf(prototypePlan, { providerAddress: 'synthetic-not-accepted' })
  assert.throws(
    () => validateSyntheticMarketReviewReceipt(prototypePlan, reviewed, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )

  const sparsePlan = structuredClone(plan)
  const sparseScopes = ['market:capacity:quote']
  delete sparseScopes[0]
  sparsePlan.binding.scopes = sparseScopes
  assert.throws(
    () => validateSyntheticMarketReviewReceipt(sparsePlan, reviewed, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  assert.throws(
    () => validateSyntheticMarketReviewReceipt(plan, reviewed, { ...reviewContext, scopes: ['market:discover'] }),
    (error: unknown) => error instanceof ScopeError && error.message === 'MARKET_REVIEW_SCOPE_REQUIRED',
  )
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D4 audit-witness validation is local-only and rejects event, chain-link, context, and credential-shaped drift', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
  const auditEntry = setup.audit.entries[2]
  assert.ok(auditEntry)
  const witness = {
    version: MARKET_REVIEW_AUDIT_WITNESS_VERSION,
    event: structuredClone(auditEntry.event),
    previousHash: auditEntry.previousHash,
    hash: auditEntry.hash,
  }
  assert.deepEqual(validateSyntheticMarketReviewAuditWitness(plan, reviewed, witness, reviewContext), witness)

  const mustReject = (candidate: unknown, message: string) => assert.throws(
    () => validateSyntheticMarketReviewAuditWitness(plan, reviewed, candidate, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === message,
  )

  const injected = structuredClone(witness) as typeof witness & { providerCredential?: string }
  injected.providerCredential = 'synthetic-not-accepted'
  mustReject(injected, 'UNEXPECTED_MARKET_REVIEW_AUDIT_WITNESS_FIELD')

  const hiddenField = structuredClone(witness)
  Object.defineProperty(hiddenField, 'providerEndpoint', { value: 'synthetic-not-accepted' })
  mustReject(hiddenField, 'UNEXPECTED_MARKET_REVIEW_AUDIT_WITNESS_FIELD')

  const prototypeEvent = structuredClone(witness)
  Object.setPrototypeOf(prototypeEvent.event, { providerAddress: 'synthetic-not-accepted' })
  mustReject(prototypeEvent, 'INVALID_MARKET_REVIEW_AUDIT_WITNESS')

  const actionDrift = structuredClone(witness)
  actionDrift.event.detail.booking = true
  mustReject(actionDrift, 'MARKET_REVIEW_AUDIT_WITNESS_EVENT_INVALID')

  const injectedDetail = structuredClone(witness)
  injectedDetail.event.detail.providerCredential = 'synthetic-not-accepted'
  mustReject(injectedDetail, 'MARKET_REVIEW_AUDIT_WITNESS_EVENT_INVALID')

  const priorHashDrift = structuredClone(witness)
  priorHashDrift.previousHash = 'a'.repeat(64)
  mustReject(priorHashDrift, 'MARKET_REVIEW_AUDIT_WITNESS_HASH_INVALID')

  const hashDrift = structuredClone(witness)
  hashDrift.hash = 'a'.repeat(64)
  mustReject(hashDrift, 'MARKET_REVIEW_AUDIT_WITNESS_HASH_INVALID')

  assert.throws(
    () => validateSyntheticMarketReviewAuditWitness(plan, reviewed, witness, Object.create(reviewContext)),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_CONTEXT',
  )
  assert.throws(
    () => validateSyntheticMarketReviewAuditWitness(plan, reviewed, witness, { ...reviewContext, providerCredential: 'synthetic-not-accepted' } as never),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_CONTEXT',
  )
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D5 audit-trail witness verifies one caller-held requested/succeeded/review segment and rejects discontinuity, semantic, time, accessor, and proxy drift without writes', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
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

  const witness = validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, trail(), reviewContext)
  assert.equal(witness.version, MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION)
  assert.equal(witness.planId, plan.id)
  assert.equal(witness.reviewId, reviewed.reviewId)
  assert.equal(witness.requestedAuditHash, requestedEntry.hash)
  assert.equal(witness.succeededAuditHash, succeededEntry.hash)
  assert.equal(witness.reviewAuditHash, reviewed.auditHash)
  assert.equal(witness.predecessorHash, null)
  assert.equal(witness.mode, 'SYNTHETIC')
  assert.equal(witness.liveStatus, 'LIVE_DISABLED')
  assert.equal(witness.state, 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION')
  assert.deepEqual(witness.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })

  const discontinuous = trail()
  discontinuous.succeededRun.previousHash = '0'.repeat(64)
  discontinuous.succeededRun.hash = hashAuditEvent(discontinuous.succeededRun.event, discontinuous.succeededRun.previousHash)
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, discontinuous, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_AUDIT_TRAIL_CHAIN_MISMATCH',
  )

  const semanticMismatch = trail()
  semanticMismatch.succeededRun.event.actor = 'another-owner@example.test'
  semanticMismatch.succeededRun.hash = hashAuditEvent(semanticMismatch.succeededRun.event, semanticMismatch.succeededRun.previousHash)
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, semanticMismatch, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_AUDIT_TRAIL_EVENT_MISMATCH',
  )

  const timeInversion = trail()
  timeInversion.requestedRun.event.occurredAt = '2026-07-22T12:00:01.000Z'
  timeInversion.requestedRun.hash = hashAuditEvent(timeInversion.requestedRun.event, timeInversion.requestedRun.previousHash)
  timeInversion.succeededRun.previousHash = timeInversion.requestedRun.hash
  timeInversion.succeededRun.event.detail.requestedAuditHash = timeInversion.requestedRun.hash
  timeInversion.succeededRun.hash = hashAuditEvent(timeInversion.succeededRun.event, timeInversion.succeededRun.previousHash)
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, timeInversion, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_AUDIT_TRAIL_TIME_INVALID',
  )

  const hiddenProvider = trail() as ReturnType<typeof trail> & { requestedRun: { event: { detail: Record<string, unknown> } } }
  Object.defineProperty(hiddenProvider.requestedRun.event.detail, 'providerCredential', { value: 'synthetic-not-accepted', enumerable: false })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, hiddenProvider, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_REQUESTED_DETAIL_FIELD',
  )

  const accessorTrail = trail()
  let accessorRead = false
  Object.defineProperty(accessorTrail.succeededRun, 'hash', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, accessorTrail, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_ENTRY_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyTrail = new Proxy(trail(), { get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') } })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailWitness(plan, reviewed, proxyTrail, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_FIELD',
  )
  assert.equal(proxyTrapRead, false)
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D6 audit-trail receipt is minimized, context-bound, and rejects mutated or shaped evidence without writes', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
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
  const receipt = () => createSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), reviewContext)

  const created = receipt()
  assert.equal(created.version, MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION)
  assert.match(created.receiptId, /^synthetic-market-review-audit-trail-receipt-[a-f0-9]{24}$/)
  assert.equal(created.planId, plan.id)
  assert.equal(created.reviewId, reviewed.reviewId)
  assert.equal(created.requestedAuditHash, requestedEntry.hash)
  assert.equal(created.succeededAuditHash, succeededEntry.hash)
  assert.equal(created.reviewAuditHash, reviewed.auditHash)
  assert.equal(created.predecessorHash, null)
  assert.equal(created.mode, 'SYNTHETIC')
  assert.equal(created.liveStatus, 'LIVE_DISABLED')
  assert.equal(created.state, 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION')
  assert.deepEqual(created.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.match(created.scopeBinding.productDigest, /^[a-f0-9]{64}$/)
  assert.match(created.scopeBinding.workspaceDigest, /^[a-f0-9]{64}$/)
  assert.match(created.integrity.digest, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(created).includes(context.actor), false)
  assert.equal(JSON.stringify(created).includes('checker@example.test'), false)
  assert.equal(JSON.stringify(created).includes('acknowledged'), false)
  assert.equal(JSON.stringify(created).includes('capacity-quote'), false)
  assert.deepEqual(validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), structuredClone(created), reviewContext), created)

  const alteredHash = structuredClone(created)
  alteredHash.reviewAuditHash = '0'.repeat(64)
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), alteredHash, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_AUDIT_TRAIL_RECEIPT_INTEGRITY_INVALID',
  )

  const alteredReceiptId = structuredClone(created)
  alteredReceiptId.receiptId = 'synthetic-market-review-audit-trail-receipt-000000000000000000000000'
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), alteredReceiptId, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_AUDIT_TRAIL_RECEIPT_INTEGRITY_INVALID',
  )

  const credentialShaped = structuredClone(created) as typeof created & { providerCredential?: string }
  credentialShaped.providerCredential = 'synthetic-not-accepted'
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), credentialShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const hiddenProvider = structuredClone(created)
  Object.defineProperty(hiddenProvider, 'providerEndpoint', { value: 'synthetic-not-accepted', enumerable: false })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), hiddenProvider, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const symbolShaped = structuredClone(created)
  Object.defineProperty(symbolShaped, Symbol('provider-token'), { value: 'synthetic-not-accepted', enumerable: true })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), symbolShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD',
  )

  const prototypeScope = structuredClone(created)
  Object.setPrototypeOf(prototypeScope.scopeBinding, { providerAddress: 'synthetic-not-accepted' })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), prototypeScope, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_AUDIT_TRAIL_RECEIPT_SCOPE',
  )

  const accessorShaped = structuredClone(created)
  let accessorRead = false
  Object.defineProperty(accessorShaped, 'integrity', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), accessorShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyShaped = new Proxy(structuredClone(created), { get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') } })
  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), proxyShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD',
  )
  assert.equal(proxyTrapRead, false)

  assert.throws(
    () => validateSyntheticMarketReviewAuditTrailReceipt(plan, reviewed, trail(), structuredClone(created), { ...reviewContext, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D1 review packet reconstruction rejects injection, source/quote/action drift, scope drift, and whitespace identity bypasses before audit append', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const clone = (): SyntheticMarketPlan => structuredClone(plan)
  const mustReject = (candidate: unknown) => assert.throws(
    () => validateSyntheticMarketPlanForReview(candidate, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )

  const injected = clone() as SyntheticMarketPlan & { providerCredential?: string }
  injected.providerCredential = 'not-accepted'
  mustReject(injected)

  const hiddenInjection = clone()
  Object.defineProperty(hiddenInjection, 'hiddenProviderCredential', { value: 'not-accepted' })
  mustReject(hiddenInjection)

  const sourcePlan = clone()
  const sourceDrift = { ...sourcePlan, sources: [{ ...sourcePlan.sources[0]!, state: 'NOT_CONTACTED' }, ...sourcePlan.sources.slice(1)] }
  mustReject(sourceDrift)

  const quoteDrift = clone()
  quoteDrift.quote = { state: 'NOT_QUOTED', reason: 'INVENTED_REASON' } as never
  mustReject(quoteDrift)

  const actionDrift = clone()
  actionDrift.reviewPacket.execution.booking = true as never
  mustReject(actionDrift)

  assert.throws(
    () => validateSyntheticMarketPlanForReview(clone(), { ...reviewContext, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(clone(), 'acknowledged', true, ` ${context.actor}`, setup.reviews, reviewContext),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'MARKET_REVIEWER_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, actor: ` ${context.actor}` }),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'MARKET_REQUESTER_REQUIRED',
  )
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('D2 process-local terminal review ledger rejects sequential and concurrent replays without creating a market action', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }

  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', {} as never, reviewContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_LEDGER_REQUIRED',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, { ...reviewContext, now: (() => new Date('invalid')) as typeof now }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_TIME',
  )
  assert.equal(setup.audit.entries.length, 2)

  const decisions = await Promise.allSettled([
    independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext),
    independentlyReviewSyntheticMarketPlan(plan, 'rejected', true, 'checker-two@example.test', setup.reviews, reviewContext),
  ])
  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1)
  assert.equal(decisions.filter((decision) => decision.status === 'rejected').length, 1)
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.audit.entries[2]?.event.detail.execution, 'NOT_AUTHORIZED')
  assert.equal(setup.audit.entries[2]?.event.detail.reservation, false)
  assert.equal(setup.audit.entries[2]?.event.detail.booking, false)
  assert.equal(setup.audit.entries[2]?.event.detail.publication, false)

  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker-three@example.test', setup.reviews, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_ALREADY_DECIDED',
  )
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D2 ledger does not create a terminal receipt when its audit append is malformed', async () => {
  const ledger = new InMemorySyntheticMarketReviewLedger({ append: async () => ({ hash: 'not-a-sha256-digest' }) })
  const entry = {
    product: context.product,
    workspaceId: context.workspaceId,
    planId: `synthetic-market-${'a'.repeat(24)}`,
    planDigest: 'a'.repeat(64),
    reviewId: `synthetic-market-review-${'a'.repeat(24)}`,
    reviewPacketIntegrityDigest: 'b'.repeat(64),
    decision: 'acknowledged' as const,
    reviewedBy: 'checker@example.test',
    reviewedAt: now().toISOString(),
  }
  await assert.rejects(
    () => ledger.recordTerminalReview({ ...entry, providerCredential: 'synthetic-not-accepted' } as never),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_LEDGER_ENTRY',
  )
  assert.equal(ledger.entries.length, 0)
  await assert.rejects(
    () => ledger.recordTerminalReview(entry),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(ledger.entries.length, 0)
})

test('D3 refuses an injected ledger result whose audit hash is malformed before it can return a receipt', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', { recordTerminalReview: async () => ({ hash: 'malformed-audit-hash' }) }, reviewContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('ADOS 10 controls are complete and explicitly prohibit egress and production launch', () => {
  assert.equal(ADOS_10_MARKET_CONTROLS.length, 10)
  assert.deepEqual(ADOS_10_MARKET_CONTROLS.map((control) => control.id), [
    'ADOS-01', 'ADOS-02', 'ADOS-03', 'ADOS-04', 'ADOS-05', 'ADOS-06', 'ADOS-07', 'ADOS-08', 'ADOS-09', 'ADOS-10',
  ])
  assert.match(ADOS_10_MARKET_CONTROLS[6]?.enforcement ?? '', /No network client, provider URL, credential, API key/i)
  assert.match(ADOS_10_MARKET_CONTROLS[9]?.enforcement ?? '', /No production migration, main\/prod write, live launch/i)
})

test('market quota configuration is separately fail-closed and cannot share Apify limits by accident', () => {
  assert.deepEqual(
    dailyQuotaFromEnvironment({ GCL_MARKET_DAILY_RUN_QUOTA: '3', GCL_MARKET_DAILY_ITEM_QUOTA: '6' }, MARKET_CONNECTOR_ID),
    { dailyRuns: 3, dailyItems: 6 },
  )
  assert.throws(
    () => dailyQuotaFromEnvironment({ GCL_APIFY_DAILY_RUN_QUOTA: '3', GCL_APIFY_DAILY_ITEM_QUOTA: '6' }, MARKET_CONNECTOR_ID),
    (error: unknown) => error instanceof ConnectorUnavailableError,
  )
})
