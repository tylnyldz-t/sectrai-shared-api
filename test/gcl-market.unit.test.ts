import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { MARKET_CONNECTOR_ID, MARKET_LIVE_STATUS, SyntheticMarketConnector, independentlyReviewSyntheticMarketPlan, syntheticMarketConnectorFromEnvironment, type MarketCapacityQuoteInput, type MarketReviewContext, type SyntheticMarketConnectorConfig, type SyntheticMarketPlan } from '../src/gcl/market.js'
import { InMemorySyntheticMarketReviewLedger } from '../src/gcl/market-review-ledger.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const limits: SyntheticMarketConnectorConfig = { liveEnabled: false, maxCostCapCents: 50, maxItems: 3, maxCapacityUnits: 10 }
const quote: MarketCapacityQuoteInput = {
  operation: 'capacity-quote', transportMode: 'road', originCountry: 'tr', destinationCountry: 'de', requestedListings: 1, requestedCapacityUnits: 2,
}
const context: ConnectorRunContext = {
  product: 'sectrai-gcl-market-test', workspaceId: 'ws-market', actor: 'owner@example.test', ownerApproved: true,
  scopes: ['market:capacity:quote'], costCapCents: 50, requestedItems: 1, now,
}
const runContext = {
  product: context.product, workspaceId: context.workspaceId, actor: context.actor, ownerApproved: context.ownerApproved,
  scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
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
  return {
    connector,
    audit,
    quota,
    reviews: new InMemorySyntheticMarketReviewLedger(audit),
    runner: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now),
  }
}

test('capacity-market produces an auditable, no-action review plan and consumes its shared quota', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: quote, ...runContext })
  const plan = result.data as SyntheticMarketPlan

  assert.equal(plan.mode, 'SYNTHETIC')
  assert.equal(plan.liveStatus, 'LIVE_DISABLED')
  assert.equal(plan.request.originCountry, 'TR')
  assert.deepEqual(plan.quote, { state: 'NOT_QUOTED', reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' })
  assert.deepEqual(plan.sideEffects, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(plan.ownerReview.decisionAuthorizesExecution, false)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.auditHash, setup.audit.entries[1]?.hash)
  assert.deepEqual(setup.quota.requests, [{ connectorId: MARKET_CONNECTOR_ID, quotaGroup: 'market', requestedItems: 1 }])
})

test('market remains fail-closed without explicit LIVE_DISABLED configuration', async () => {
  const invalid = new SyntheticMarketConnector({ ...limits, liveEnabled: true })
  await assert.rejects(() => invalid.run(quote, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === MARKET_LIVE_STATUS)

  const configured = { GCL_MARKET_MAX_COST_CENTS: '50', GCL_MARKET_MAX_ITEMS: '3', GCL_MARKET_MAX_CAPACITY_UNITS: '10' }
  for (const liveFlag of [undefined, 'true', 'TRUE']) {
    const connector = syntheticMarketConnectorFromEnvironment({ ...configured, ...(liveFlag === undefined ? {} : { GCL_MARKET_LIVE_ENABLED: liveFlag }) })
    await assert.rejects(() => connector.run(quote, context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === MARKET_LIVE_STATUS)
  }
  const enabled = syntheticMarketConnectorFromEnvironment({ ...configured, GCL_MARKET_LIVE_ENABLED: 'false' })
  assert.equal((await enabled.run(quote, context)).data.liveStatus, 'LIVE_DISABLED')
})

test('owner, scope, and cost gates close before the governed runner audits or consumes quota', async () => {
  const setup = marketRunner()
  await assert.rejects(() => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: quote, ...runContext, ownerApproved: false }), OwnerGateError)
  await assert.rejects(() => setup.connector.run(quote, { ...context, scopes: ['market:discover'] }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_OPERATION_SCOPE_REQUIRED')
  await assert.rejects(() => setup.connector.run(quote, { ...context, requestedItems: 2 }), (error: unknown) => error instanceof CostCapError && error.message === 'MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
  await assert.rejects(() => setup.connector.run(quote, { ...context, costCapCents: 51 }), CostCapError)
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('an independent owner review is audited, replay-safe, and never authorizes execution', async () => {
  const setup = marketRunner()
  const plan = (await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: quote, ...runContext })).data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }

  await assert.rejects(() => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', false, 'checker@example.test', setup.reviews, reviewContext), OwnerGateError)
  await assert.rejects(() => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, context.actor, setup.reviews, reviewContext), MakerCheckerError)
  await assert.rejects(() => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, { ...reviewContext, scopes: ['market:discover'] }), ScopeError)
  const changed = structuredClone(plan)
  changed.request.originCountry = 'FR'
  await assert.rejects(() => independentlyReviewSyntheticMarketPlan(changed, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext), ConnectorInputError)

  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext)
  assert.equal(reviewed.auditHash, setup.audit.entries[2]?.hash)
  assert.deepEqual(reviewed.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(setup.audit.entries[2]?.event.type, 'connector.market.owner_reviewed')
  await assert.rejects(() => independentlyReviewSyntheticMarketPlan(plan, 'rejected', true, 'checker@example.test', setup.reviews, reviewContext), /MARKET_REVIEW_ALREADY_DECIDED/)
})
