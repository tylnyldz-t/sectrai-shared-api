import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { ADOS_10_MARKET_CONTROLS, MARKET_CONNECTOR_ID, MARKET_LIVE_STATUS, SyntheticMarketConnector, independentlyReviewSyntheticMarketPlan, syntheticMarketConnectorFromEnvironment, validateSyntheticMarketPlanForReview, type MarketCapacityQuoteInput, type MarketReviewContext, type SyntheticMarketConnectorConfig, type SyntheticMarketPlan } from '../src/gcl/market.js'
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
  const quota = new TestQuota()
  return { connector, audit, quota, runner: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now) }
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
})

test('a distinct owner can audit a market review, but neither decision can authorize an execution', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }

  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', false, 'checker@example.test', setup.audit, reviewContext),
    OwnerGateError,
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, context.actor, setup.audit, reviewContext),
    (error: unknown) => error instanceof MakerCheckerError && error.message === 'MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.audit, { ...reviewContext, scopes: ['market:discover'] }),
    (error: unknown) => error instanceof ScopeError && error.message === 'MARKET_REVIEW_SCOPE_REQUIRED',
  )
  const tampered = { ...plan, request: { ...plan.request, originCountry: 'FR' } }
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(tampered, 'acknowledged', true, 'checker@example.test', setup.audit, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'approved' as never, true, 'checker@example.test', setup.audit, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_DECISION',
  )
  assert.equal(setup.audit.entries.length, 2)

  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.audit, reviewContext)
  assert.equal(reviewed.decision, 'acknowledged')
  assert.equal(reviewed.reviewedBy, 'checker@example.test')
  assert.equal(reviewed.mode, 'SYNTHETIC')
  assert.equal(reviewed.reviewId, plan.reviewPacket.reviewId)
  assert.equal(reviewed.reviewPacketIntegrityDigest, plan.reviewPacket.integrity.digest)
  assert.deepEqual(reviewed.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(reviewed.auditHash, setup.audit.entries[2]?.hash)
  assert.equal(setup.audit.entries[2]?.previousHash, setup.audit.entries[1]?.hash)
  assert.equal(setup.audit.entries[2]?.event.type, 'connector.market.owner_reviewed')
  assert.equal(setup.audit.entries[2]?.event.detail.maker, undefined)
  assert.equal(setup.audit.entries[2]?.event.detail.reviewPacketIntegrityDigest, plan.reviewPacket.integrity.digest)
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
    () => independentlyReviewSyntheticMarketPlan(clone(), 'acknowledged', true, ` ${context.actor}`, setup.audit, reviewContext),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'MARKET_REVIEWER_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...context, actor: ` ${context.actor}` }),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'MARKET_REQUESTER_REQUIRED',
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
