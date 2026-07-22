import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from '../src/gcl/errors.js'
import { ADOS_10_MARKET_CONTROLS, MARKET_CONNECTOR_ID, MARKET_LIVE_STATUS, MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION, MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION, MARKET_REVIEW_AUDIT_WITNESS_VERSION, MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION, MARKET_REVIEW_RECEIPT_VERSION, SyntheticMarketConnector, createSyntheticMarketReviewAuditTrailReceipt, createSyntheticMarketReviewEvidenceManifest, independentlyReviewSyntheticMarketPlan, syntheticMarketConnectorFromEnvironment, validateSyntheticMarketPlanForReview, validateSyntheticMarketReviewAuditTrailReceipt, validateSyntheticMarketReviewAuditTrailWitness, validateSyntheticMarketReviewAuditWitness, validateSyntheticMarketReviewEvidenceManifest, validateSyntheticMarketReviewReceipt, type MarketCapacityQuoteInput, type MarketReviewContext, type SyntheticMarketConnectorConfig, type SyntheticMarketPlan } from '../src/gcl/market.js'
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
const runContext = {
  product: context.product,
  workspaceId: context.workspaceId,
  actor: context.actor,
  ownerApproved: context.ownerApproved,
  scopes: context.scopes,
  costCapCents: context.costCapCents,
  requestedItems: context.requestedItems,
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
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, scopes: ['market:discover'] }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_OPERATION_SCOPE_REQUIRED',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, requestedItems: 2 }),
    (error: unknown) => error instanceof Error && error.message === 'MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, workspaceId: 'invalid/workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_CONTEXT',
  )
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('synthetic market owner gate rejects before proposal creation', async () => {
  const setup = marketRunner()
  await assert.rejects(
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, ownerApproved: false }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  assert.equal(setup.audit.entries.length, 0)
  assert.equal(setup.quota.requests.length, 0)
})

test('synthetic market also rejects invalid direct-run governance values instead of trusting only the runner', async () => {
  const connector = new SyntheticMarketConnector(limits)
  await assert.rejects(
    () => connector.run(capacityQuote, { ...context, ownerApproved: false }),
    OwnerGateError,
  )
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

test('D11 requires literal boolean owner approval across runner, direct run, and independent review before later seams', async () => {
  const approvalLookalikes: unknown[] = [false, 0, 1, '', 'true', new Boolean(false), new Boolean(true), {}, null, undefined]
  const direct = new SyntheticMarketConnector(limits)
  const directSetup = marketRunner()

  for (const ownerApproved of approvalLookalikes) {
    await assert.rejects(
      () => direct.run(capacityQuote, { ...context, ownerApproved: ownerApproved as never }),
      OwnerGateError,
    )
    await assert.rejects(
      () => directSetup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, ownerApproved: ownerApproved as never }),
      OwnerGateError,
    )
  }
  assert.equal(directSetup.audit.entries.length, 0)
  assert.equal(directSetup.quota.requests.length, 0)

  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  const plan = result.data as SyntheticMarketPlan
  let clockCalls = 0
  let ledgerCalls = 0
  const guardedContext: MarketReviewContext = {
    product: context.product,
    workspaceId: context.workspaceId,
    scopes: ['market:review'],
    now: () => { clockCalls += 1; return now() },
  }
  const ledger = {
    recordTerminalReview: async () => {
      ledgerCalls += 1
      return { hash: 'a'.repeat(64) }
    },
  }
  for (const ownerApproved of approvalLookalikes) {
    await assert.rejects(
      () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', ownerApproved as never, 'checker@example.test', ledger, guardedContext),
      OwnerGateError,
    )
  }

  let contextTrapRead = false
  const shapedContext = new Proxy({}, {
    get() { contextTrapRead = true; throw new Error('CONTEXT_MUST_NOT_BE_READ') },
  })
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', 'true' as never, 'checker@example.test', ledger, shapedContext as never),
    OwnerGateError,
  )
  assert.equal(contextTrapRead, false)
  assert.equal(clockCalls, 0)
  assert.equal(ledgerCalls, 0)
  assert.equal(setup.reviews.entries.length, 0)
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('D12 snapshots the exact governed-run envelope before preflight, audit, or quota and never evaluates shaped fields', async () => {
  const setup = marketRunner()
  const request = () => ({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  const mustReject = async (candidate: unknown) => {
    await assert.rejects(
      () => setup.runner.run(candidate as never),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_CONNECTOR_RUN_REQUEST',
    )
    assert.equal(setup.audit.entries.length, 0)
    assert.equal(setup.quota.requests.length, 0)
  }

  await mustReject({ ...request(), providerCredential: 'synthetic-not-accepted' })

  const hiddenCredential = request()
  Object.defineProperty(hiddenCredential, 'providerCredential', { value: 'synthetic-not-accepted' })
  await mustReject(hiddenCredential)

  let accessorRead = false
  const accessorApproval = request()
  Object.defineProperty(accessorApproval, 'ownerApproved', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('APPROVAL_ACCESSOR_MUST_NOT_RUN') },
  })
  await mustReject(accessorApproval)
  assert.equal(accessorRead, false)

  let proxyRead = false
  const proxyEnvelope = new Proxy(request(), {
    get() { proxyRead = true; throw new Error('RUN_REQUEST_PROXY_MUST_NOT_RUN') },
  })
  await mustReject(proxyEnvelope)
  assert.equal(proxyRead, false)

  let inheritedRead = false
  const inheritedPrototype = {}
  Object.defineProperty(inheritedPrototype, 'ownerApproved', {
    get() { inheritedRead = true; throw new Error('INHERITED_APPROVAL_MUST_NOT_RUN') },
  })
  await mustReject(Object.create(inheritedPrototype))
  assert.equal(inheritedRead, false)

  let scopeAccessorRead = false
  const accessorScopes = ['market:capacity:quote']
  Object.defineProperty(accessorScopes, '0', {
    enumerable: true,
    get() { scopeAccessorRead = true; throw new Error('SCOPE_ACCESSOR_MUST_NOT_RUN') },
  })
  await mustReject({ ...request(), scopes: accessorScopes })
  assert.equal(scopeAccessorRead, false)

  let scopeProxyRead = false
  const proxyScopes = new Proxy(['market:capacity:quote'], {
    get() { scopeProxyRead = true; throw new Error('SCOPE_PROXY_MUST_NOT_RUN') },
  })
  await mustReject({ ...request(), scopes: proxyScopes })
  assert.equal(scopeProxyRead, false)

  const callerOwned = { ...request(), scopes: ['market:capacity:quote'] }
  const run = setup.runner.run(callerOwned)
  callerOwned.scopes[0] = 'market:discover'
  const result = await run
  assert.deepEqual((result.data as SyntheticMarketPlan).binding.scopes, ['market:capacity:quote'])
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('D13 retains the canonical market preflight input across async runner seams when the caller mutates its original object', async () => {
  const setup = marketRunner()
  const mutableInput = { ...capacityQuote }
  const run = setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: mutableInput, ...runContext })

  // `preflight` has already copied this bounded market request before the
  // runner yields to its audit/quota seams. These changes must not turn the
  // accepted synthetic request into a different request or a credential path.
  mutableInput.originCountry = 'fr'
  mutableInput.requestedListings = 2
  mutableInput.requestedCapacityUnits = 9
  Object.defineProperty(mutableInput, 'providerCredential', { value: 'must-not-cross-preflight' })

  const result = await run
  const plan = result.data as SyntheticMarketPlan
  assert.deepEqual(plan.request, {
    operation: 'capacity-quote',
    transportMode: 'road',
    originCountry: 'TR',
    destinationCountry: 'DE',
    requestedListings: 1,
    requestedCapacityUnits: 2,
  })
  assert.equal(plan.liveStatus, 'LIVE_DISABLED')
  assert.deepEqual(plan.sideEffects, { externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.audit.entries[0]?.event.type, 'connector.run.requested')
  assert.equal(setup.audit.entries[1]?.event.type, 'connector.run.succeeded')
  assert.equal(setup.quota.requests.length, 1)
})

test('D14 snapshots connector configuration before preflight and rejects shaped or credential-like configuration before audit or quota', async () => {
  const mutableConfig = { ...limits }
  const setup = marketRunner(mutableConfig)
  const run = setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })

  // Preflight has already used the construction-time scalar copy. A caller
  // cannot flip the live gate or lower a limit during audit/quota awaits.
  mutableConfig.liveEnabled = true
  mutableConfig.maxItems = 0
  mutableConfig.maxCapacityUnits = 1

  const result = await run
  assert.equal((result.data as SyntheticMarketPlan).liveStatus, 'LIVE_DISABLED')
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.audit.entries[0]?.event.type, 'connector.run.requested')
  assert.equal(setup.audit.entries[1]?.event.type, 'connector.run.succeeded')
  assert.equal(setup.quota.requests.length, 1)

  const hiddenCredential = { ...limits }
  Object.defineProperty(hiddenCredential, 'providerCredential', { value: 'synthetic-not-accepted' })
  let accessorRead = false
  const accessorLimit = { ...limits }
  Object.defineProperty(accessorLimit, 'maxItems', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('CONFIG_ACCESSOR_MUST_NOT_RUN') },
  })
  let proxyRead = false
  const proxyConfig = new Proxy({ ...limits }, {
    get() { proxyRead = true; throw new Error('CONFIG_PROXY_MUST_NOT_RUN') },
  })
  const invalidConfigs: unknown[] = [
    { ...limits, providerCredential: 'synthetic-not-accepted' },
    hiddenCredential,
    accessorLimit,
    proxyConfig,
    Object.create(limits),
  ]
  for (const config of invalidConfigs) {
    const rejected = marketRunner(config as SyntheticMarketConnectorConfig)
    await assert.rejects(
      () => rejected.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext }),
      (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED',
    )
    assert.equal(rejected.audit.entries.length, 0)
    assert.equal(rejected.quota.requests.length, 0)
  }
  assert.equal(accessorRead, false)
  assert.equal(proxyRead, false)
})

test('D15 fixes governed host method seams at construction and never evaluates getter or Proxy-shaped members', async () => {
  const registry = new ConnectorRegistry([new SyntheticMarketConnector(limits)])
  let auditGetterRead = false
  const accessorAudit = {}
  Object.defineProperty(accessorAudit, 'append', {
    get() { auditGetterRead = true; throw new Error('AUDIT_MEMBER_GETTER_MUST_NOT_RUN') },
  })
  assert.throws(
    () => new GovernedConnectorRunner(registry, accessorAudit as never, new TestQuota(), now),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_AUDIT_LOG_UNAVAILABLE',
  )
  assert.equal(auditGetterRead, false)

  let quotaGetterRead = false
  const accessorQuota = {}
  Object.defineProperty(accessorQuota, 'consume', {
    get() { quotaGetterRead = true; throw new Error('QUOTA_MEMBER_GETTER_MUST_NOT_RUN') },
  })
  assert.throws(
    () => new GovernedConnectorRunner(registry, new InMemoryHashChainAuditLog(), accessorQuota as never, now),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_QUOTA_UNAVAILABLE',
  )
  assert.equal(quotaGetterRead, false)

  let proxyRead = false
  const proxyAudit = new Proxy({}, {
    get() { proxyRead = true; throw new Error('AUDIT_PROXY_MUST_NOT_RUN') },
  })
  assert.throws(
    () => new GovernedConnectorRunner(registry, proxyAudit as never, new TestQuota(), now),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_AUDIT_LOG_UNAVAILABLE',
  )
  assert.equal(proxyRead, false)

  const hostAudit = { calls: 0, async append() { this.calls += 1; return { hash: 'a'.repeat(64) } } }
  const hostQuota = { calls: 0, async consume() { this.calls += 1 } }
  const runner = new GovernedConnectorRunner(registry, hostAudit, hostQuota, now)
  hostAudit.append = async () => { throw new Error('MUTATED_AUDIT_MEMBER_MUST_NOT_RUN') }
  hostQuota.consume = async () => { throw new Error('MUTATED_QUOTA_MEMBER_MUST_NOT_RUN') }

  const result = await runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  assert.equal((result.data as SyntheticMarketPlan).liveStatus, 'LIVE_DISABLED')
  assert.equal(hostAudit.calls, 2)
  assert.equal(hostQuota.calls, 1)
})

test('D15 copies one verified runner clock and rejects malformed audit results before they can cross quota or fabricate success', async () => {
  let clockCalls = 0
  const setup = marketRunner()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([setup.connector]), setup.audit, setup.quota, () => {
    clockCalls += 1
    return new Date('2026-07-22T12:34:56.000Z')
  })
  const result = await runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  const plan = result.data as SyntheticMarketPlan
  assert.equal(clockCalls, 1)
  assert.equal(result.provenance.retrievedAt, '2026-07-22T12:34:56.000Z')
  assert.equal(setup.audit.entries[0]?.event.occurredAt, result.provenance.retrievedAt)
  assert.equal(setup.audit.entries[1]?.event.occurredAt, result.provenance.retrievedAt)
  assert.equal(plan.liveStatus, 'LIVE_DISABLED')

  const invalidClockAudit = new InMemoryHashChainAuditLog()
  const invalidClockQuota = new TestQuota()
  let invalidClockCalls = 0
  const invalidClockRunner = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticMarketConnector(limits)]), invalidClockAudit, invalidClockQuota, () => {
      invalidClockCalls += 1
      return new Date('not-a-real-time')
    },
  )
  await assert.rejects(
    () => invalidClockRunner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext }),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'INVALID_GOVERNED_RUN_TIME',
  )
  assert.equal(invalidClockCalls, 1)
  assert.equal(invalidClockAudit.entries.length, 0)
  assert.equal(invalidClockQuota.requests.length, 0)

  const malformedQuota = new TestQuota()
  let resultGetterRead = false
  const accessorResultAudit = {
    async append() {
      const result = {}
      Object.defineProperty(result, 'hash', {
        enumerable: true,
        get() { resultGetterRead = true; throw new Error('AUDIT_RESULT_GETTER_MUST_NOT_RUN') },
      })
      return result
    },
  }
  const malformedRunner = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticMarketConnector(limits)]), accessorResultAudit as never, malformedQuota, now,
  )
  await assert.rejects(
    () => malformedRunner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext }),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_AUDIT_APPEND_INVALID',
  )
  assert.equal(resultGetterRead, false)
  assert.equal(malformedQuota.requests.length, 0)

  const successQuota = new TestQuota()
  let appendCalls = 0
  const malformedSuccessAudit = {
    async append() {
      appendCalls += 1
      return appendCalls === 1 ? { hash: 'b'.repeat(64) } : { hash: 'not-a-sha256-digest' }
    },
  }
  const malformedSuccessRunner = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticMarketConnector(limits)]), malformedSuccessAudit, successQuota, now,
  )
  await assert.rejects(
    () => malformedSuccessRunner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext }),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_AUDIT_APPEND_INVALID',
  )
  assert.equal(appendCalls, 2)
  assert.equal(successQuota.requests.length, 1)
})

test('D16 snapshots direct market-run context and copies its one clock value before plan construction', async () => {
  const connector = new SyntheticMarketConnector(limits)
  let clockCalls = 0
  const directContext = {
    ...context,
    scopes: ['market:capacity:quote'],
    now: () => {
      clockCalls += 1
      // The connector has already copied all static governance fields. A
      // caller-owned clock cannot turn this into a different plan mid-run.
      directContext.product = 'other-product'
      directContext.actor = 'other-maker@example.test'
      directContext.scopes[0] = 'market:review'
      Object.defineProperty(directContext, 'providerCredential', { value: 'must-not-cross-direct-boundary' })
      return new Date('2026-07-22T12:34:56.000Z')
    },
  }

  const result = await connector.run(capacityQuote, directContext)
  const plan = result.data as SyntheticMarketPlan
  assert.equal(clockCalls, 1)
  assert.equal(result.provenance.retrievedAt, '2026-07-22T12:34:56.000Z')
  assert.equal(plan.binding.product, context.product)
  assert.equal(plan.binding.requestedBy, context.actor)
  assert.deepEqual(plan.binding.scopes, ['market:capacity:quote'])
  assert.equal(plan.liveStatus, 'LIVE_DISABLED')
  assert.deepEqual(plan.sideEffects, { externalNetwork: false, reservation: false, booking: false, publication: false })
})

test('D16 rejects shaped direct market contexts and invalid clocks without evaluating caller traps', async () => {
  const connector = new SyntheticMarketConnector(limits)
  const directContext = () => ({ ...context, scopes: ['market:capacity:quote'], now })
  const mustReject = async (candidate: unknown) => {
    await assert.rejects(
      () => connector.run(capacityQuote, candidate as never),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_CONTEXT',
    )
  }

  await mustReject({ ...directContext(), providerCredential: 'synthetic-not-accepted' })
  const hiddenCredential = directContext()
  Object.defineProperty(hiddenCredential, 'providerCredential', { value: 'synthetic-not-accepted' })
  await mustReject(hiddenCredential)

  let actorGetterRead = false
  const accessorActor = directContext()
  Object.defineProperty(accessorActor, 'actor', {
    enumerable: true,
    get() { actorGetterRead = true; throw new Error('DIRECT_CONTEXT_ACTOR_GETTER_MUST_NOT_RUN') },
  })
  await mustReject(accessorActor)
  assert.equal(actorGetterRead, false)

  let rootProxyRead = false
  const proxyContext = new Proxy(directContext(), {
    get() { rootProxyRead = true; throw new Error('DIRECT_CONTEXT_PROXY_MUST_NOT_RUN') },
  })
  await mustReject(proxyContext)
  assert.equal(rootProxyRead, false)

  let scopeGetterRead = false
  const accessorScopes = ['market:capacity:quote']
  Object.defineProperty(accessorScopes, '0', {
    enumerable: true,
    get() { scopeGetterRead = true; throw new Error('DIRECT_SCOPE_GETTER_MUST_NOT_RUN') },
  })
  await mustReject({ ...directContext(), scopes: accessorScopes })
  await mustReject({ ...directContext(), scopes: new Array(1) })
  assert.equal(scopeGetterRead, false)

  assert.throws(
    () => connector.preflight(capacityQuote, Object.create(directContext()) as never),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_CONTEXT',
  )

  await assert.rejects(
    () => connector.run(capacityQuote, { ...directContext(), now: () => new Date('not-a-real-time') }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_RUN_TIME',
  )
  await assert.rejects(
    () => connector.run(capacityQuote, { ...directContext(), now: () => { throw new Error('DIRECT_CLOCK_MUST_FAIL_CLOSED') } }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_RUN_TIME',
  )
  await assert.rejects(
    () => connector.run(capacityQuote, {
      ...directContext(),
      now: () => new Proxy(new Date('2026-07-22T12:34:56.000Z'), {}),
    }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_RUN_TIME',
  )
})

test('a distinct owner can audit a market review, but neither decision can authorize an execution', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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

test('D7 evidence manifest binds independently rebuilt D3 and D6 evidence, omits market data, and rejects mutated or shaped evidence without writes', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  const manifest = () => createSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), reviewContext)

  const created = manifest()
  assert.equal(created.version, MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION)
  assert.match(created.manifestId, /^synthetic-market-review-evidence-manifest-[a-f0-9]{24}$/)
  assert.equal(created.planId, plan.id)
  assert.equal(created.reviewId, reviewed.reviewId)
  assert.equal(created.reviewReceiptIntegrityDigest, reviewed.reviewReceipt.integrity.digest)
  assert.match(created.auditTrailReceiptIntegrityDigest, /^[a-f0-9]{64}$/)
  assert.equal(created.mode, 'SYNTHETIC')
  assert.equal(created.liveStatus, 'LIVE_DISABLED')
  assert.equal(created.state, 'SYNTHETIC_MARKET_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION')
  assert.deepEqual(created.execution, { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false })
  assert.match(created.scopeBinding.productDigest, /^[a-f0-9]{64}$/)
  assert.match(created.scopeBinding.workspaceDigest, /^[a-f0-9]{64}$/)
  assert.match(created.integrity.digest, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(created).includes(context.actor), false)
  assert.equal(JSON.stringify(created).includes('checker@example.test'), false)
  assert.equal(JSON.stringify(created).includes('acknowledged'), false)
  assert.equal(JSON.stringify(created).includes('capacity-quote'), false)
  assert.equal(JSON.stringify(created).includes(reviewed.auditHash), false)
  assert.deepEqual(validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), structuredClone(created), reviewContext), created)

  const alteredReviewReceipt = structuredClone(created)
  alteredReviewReceipt.reviewReceiptIntegrityDigest = '0'.repeat(64)
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), alteredReviewReceipt, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_INVALID',
  )

  const alteredTrailReceipt = structuredClone(created)
  alteredTrailReceipt.auditTrailReceiptIntegrityDigest = '0'.repeat(64)
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), alteredTrailReceipt, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_INVALID',
  )

  const alteredScopeBinding = structuredClone(created)
  alteredScopeBinding.scopeBinding.workspaceDigest = '0'.repeat(64)
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), alteredScopeBinding, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_INVALID',
  )

  const alteredManifestId = structuredClone(created)
  alteredManifestId.manifestId = 'synthetic-market-review-evidence-manifest-000000000000000000000000'
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), alteredManifestId, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_INVALID',
  )

  const credentialShaped = structuredClone(created) as typeof created & { providerCredential?: string }
  credentialShaped.providerCredential = 'synthetic-not-accepted'
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), credentialShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const hiddenProvider = structuredClone(created)
  Object.defineProperty(hiddenProvider, 'providerEndpoint', { value: 'synthetic-not-accepted', enumerable: false })
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), hiddenProvider, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const symbolShaped = structuredClone(created)
  Object.defineProperty(symbolShaped, Symbol('provider-token'), { value: 'synthetic-not-accepted', enumerable: true })
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), symbolShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )

  const accessorShaped = structuredClone(created)
  let accessorRead = false
  Object.defineProperty(accessorShaped, 'integrity', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), accessorShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )
  assert.equal(accessorRead, false)

  let proxyTrapRead = false
  const proxyShaped = new Proxy(structuredClone(created), { get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') } })
  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), proxyShaped, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD',
  )
  assert.equal(proxyTrapRead, false)

  assert.throws(
    () => validateSyntheticMarketReviewEvidenceManifest(plan, reviewed, trail(), structuredClone(created), { ...reviewContext, workspaceId: 'another-workspace' }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  assert.equal(setup.reviews.entries.length, 1)
  assert.equal(setup.audit.entries.length, 3)
  assert.equal(setup.quota.requests.length, 1)
})

test('D1 review packet reconstruction rejects injection, source/quote/action drift, scope drift, and whitespace identity bypasses before audit append', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
    () => setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext, actor: ` ${context.actor}` }),
    (error: unknown) => error instanceof OwnerGateError && error.message === 'MARKET_REQUESTER_REQUIRED',
  )
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('D2 process-local terminal review ledger rejects sequential and concurrent replays without creating a market action', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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

test('D8 terminal ledger accepts only exact own data, never evaluates shaped ingress, and remains retryable after a failed audit append', async () => {
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
  let appendCalls = 0
  const ledger = new InMemorySyntheticMarketReviewLedger({
    append: async () => {
      appendCalls += 1
      return { hash: appendCalls === 1 ? 'not-a-sha256-digest' : 'c'.repeat(64) }
    },
  })
  const mustRejectIngress = async (candidate: unknown, read: () => boolean = () => false) => {
    await assert.rejects(
      () => ledger.recordTerminalReview(candidate as never),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_LEDGER_ENTRY',
    )
    assert.equal(read(), false)
  }

  await mustRejectIngress(Object.create(entry))

  const hiddenProvider = { ...entry }
  Object.defineProperty(hiddenProvider, 'providerCredential', { value: 'synthetic-not-accepted' })
  await mustRejectIngress(hiddenProvider)

  const symbolShaped = { ...entry }
  Object.defineProperty(symbolShaped, Symbol('provider-token'), { value: 'synthetic-not-accepted', enumerable: true })
  await mustRejectIngress(symbolShaped)

  const accessorShaped = { ...entry }
  let accessorRead = false
  Object.defineProperty(accessorShaped, 'reviewedBy', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  await mustRejectIngress(accessorShaped, () => accessorRead)

  let proxyTrapRead = false
  const proxyShaped = new Proxy({ ...entry }, { get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') } })
  await mustRejectIngress(proxyShaped, () => proxyTrapRead)

  assert.equal(appendCalls, 0)
  assert.equal(ledger.entries.length, 0)
  await assert.rejects(
    () => ledger.recordTerminalReview(entry),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(appendCalls, 1)
  assert.equal(ledger.entries.length, 0)

  assert.deepEqual(await ledger.recordTerminalReview(entry), { hash: 'c'.repeat(64) })
  assert.equal(appendCalls, 2)
  assert.equal(ledger.entries.length, 1)
})

test('D8 terminal ledger rejects accessor- and Proxy-shaped audit append results without marking a decision', async () => {
  const entry = {
    product: context.product,
    workspaceId: context.workspaceId,
    planId: `synthetic-market-${'d'.repeat(24)}`,
    planDigest: 'd'.repeat(64),
    reviewId: `synthetic-market-review-${'d'.repeat(24)}`,
    reviewPacketIntegrityDigest: 'e'.repeat(64),
    decision: 'rejected' as const,
    reviewedBy: 'checker@example.test',
    reviewedAt: now().toISOString(),
  }
  let accessorRead = false
  const accessorResult = {}
  Object.defineProperty(accessorResult, 'hash', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  const accessorLedger = new InMemorySyntheticMarketReviewLedger({ append: async () => accessorResult as never })
  await assert.rejects(
    () => accessorLedger.recordTerminalReview(entry),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(accessorRead, false)
  assert.equal(accessorLedger.entries.length, 0)

  let proxyTrapRead = false
  const proxyResult = new Proxy({ hash: 'f'.repeat(64) }, {
    // Promise resolution must probe `then`; no data property may be read by
    // the ledger after that unavoidable runtime check.
    get(target, property, receiver) {
      if (property === 'then') return undefined
      proxyTrapRead = true
      return Reflect.get(target, property, receiver)
    },
  })
  const proxyLedger = new InMemorySyntheticMarketReviewLedger({ append: async () => proxyResult as never })
  await assert.rejects(
    () => proxyLedger.recordTerminalReview(entry),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(proxyTrapRead, false)
  assert.equal(proxyLedger.entries.length, 0)
})

test('D9 snapshots every caller-held review-plan branch before semantic reads and blocks shaped host-ledger seams without a review audit', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  const plan = result.data as SyntheticMarketPlan
  const reviewContext: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const mustRejectPlan = (candidate: unknown, read: () => boolean = () => false) => {
    assert.throws(
      () => validateSyntheticMarketPlanForReview(candidate, reviewContext),
      (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
    )
    assert.equal(read(), false)
  }

  const accessorRoot = structuredClone(plan)
  let rootRead = false
  Object.defineProperty(accessorRoot, 'binding', {
    enumerable: true,
    get() { rootRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  mustRejectPlan(accessorRoot, () => rootRead)

  const accessorNested = structuredClone(plan)
  let nestedRead = false
  Object.defineProperty(accessorNested.sources[0]!, 'state', {
    enumerable: true,
    get() { nestedRead = true; throw new Error('ACCESSOR_MUST_NOT_RUN') },
  })
  mustRejectPlan(accessorNested, () => nestedRead)

  const hiddenNested = structuredClone(plan)
  Object.defineProperty(hiddenNested.reviewPacket, 'providerCredential', { value: 'synthetic-not-accepted' })
  mustRejectPlan(hiddenNested)

  const symbolArray = structuredClone(plan)
  Object.defineProperty(symbolArray.sources, Symbol('provider-token'), { value: 'synthetic-not-accepted', enumerable: true })
  mustRejectPlan(symbolArray)

  const sparseSources = structuredClone(plan)
  delete (sparseSources.sources as unknown[])[1]
  mustRejectPlan(sparseSources)

  let proxyTrapRead = false
  const proxyPlan = new Proxy(structuredClone(plan), { get() { proxyTrapRead = true; throw new Error('PROXY_TRAP_MUST_NOT_RUN') } })
  mustRejectPlan(proxyPlan, () => proxyTrapRead)

  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(accessorNested, 'acknowledged', true, 'checker@example.test', setup.reviews, reviewContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID',
  )
  assert.equal(setup.reviews.entries.length, 0)
  assert.equal(setup.audit.entries.length, 2)

  let ledgerMemberRead = false
  const getterLedger = {}
  Object.defineProperty(getterLedger, 'recordTerminalReview', {
    get() { ledgerMemberRead = true; throw new Error('LEDGER_GETTER_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', getterLedger as never, reviewContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_LEDGER_REQUIRED',
  )
  assert.equal(ledgerMemberRead, false)

  let resultAccessorRead = false
  const accessorResult = {}
  Object.defineProperty(accessorResult, 'hash', {
    enumerable: true,
    get() { resultAccessorRead = true; throw new Error('RESULT_ACCESSOR_MUST_NOT_RUN') },
  })
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', { recordTerminalReview: async () => accessorResult as never }, reviewContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(resultAccessorRead, false)

  let resultProxyRead = false
  const proxyResult = new Proxy({ hash: 'a'.repeat(64) }, {
    get(target, property, receiver) {
      if (property === 'then') return undefined
      resultProxyRead = true
      return Reflect.get(target, property, receiver)
    },
  })
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', { recordTerminalReview: async () => proxyResult as never }, reviewContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'MARKET_REVIEW_AUDIT_APPEND_INVALID',
  )
  assert.equal(resultProxyRead, false)
  assert.equal(setup.reviews.entries.length, 0)
  assert.equal(setup.audit.entries.length, 2)
  assert.equal(setup.quota.requests.length, 1)
})

test('D10 snapshots review context and treats its clock as a narrow fail-closed host seam', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
  const plan = result.data as SyntheticMarketPlan
  const base: MarketReviewContext = { product: context.product, workspaceId: context.workspaceId, scopes: ['market:review'], now }
  const mustRejectContext = (candidate: MarketReviewContext, expected = 'INVALID_MARKET_REVIEW_CONTEXT') => assert.throws(
    () => validateSyntheticMarketPlanForReview(plan, candidate),
    (error: unknown) => error instanceof ConnectorInputError && error.message === expected,
  )

  let scopeAccessorRead = false
  const accessorScopes = ['market:review']
  Object.defineProperty(accessorScopes, '0', {
    enumerable: true,
    get() { scopeAccessorRead = true; throw new Error('SCOPE_ACCESSOR_MUST_NOT_RUN') },
  })
  mustRejectContext({ ...base, scopes: accessorScopes })
  assert.equal(scopeAccessorRead, false)

  let scopeProxyRead = false
  const proxyScopes = new Proxy(['market:review'], {
    get(target, property, receiver) { scopeProxyRead = true; return Reflect.get(target, property, receiver) },
  })
  mustRejectContext({ ...base, scopes: proxyScopes })
  assert.equal(scopeProxyRead, false)

  const sparseScopes = ['market:review']
  delete sparseScopes[0]
  mustRejectContext({ ...base, scopes: sparseScopes })
  mustRejectContext({ ...base, scopes: ['market:review', 'market:discover', 'market:capacity:quote', 'market:review'] })

  let clockApplied = false
  const proxyClock = new Proxy(now, {
    apply() { clockApplied = true; return now() },
  })
  mustRejectContext({ ...base, now: proxyClock })
  assert.equal(clockApplied, false)

  let dateProxyRead = false
  const proxyDate = new Proxy(now(), {
    get(target, property, receiver) { dateProxyRead = true; return Reflect.get(target, property, receiver) },
  })
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, { ...base, now: () => proxyDate as never }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_TIME',
  )
  assert.equal(dateProxyRead, false)

  let deniedClockCalls = 0
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', false, 'checker@example.test', setup.reviews, {
      ...base,
      now: () => { deniedClockCalls += 1; return now() },
    }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  assert.equal(deniedClockCalls, 0)

  let malformedClockCalls = 0
  await assert.rejects(
    () => independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, {
      ...base,
      now: () => { malformedClockCalls += 1; throw new Error('CLOCK_MUST_FAIL_CLOSED') },
    }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_MARKET_REVIEW_TIME',
  )
  assert.equal(malformedClockCalls, 1)
  assert.equal(setup.reviews.entries.length, 0)
  assert.equal(setup.audit.entries.length, 2)

  const mutatingClockContext: MarketReviewContext = {
    product: context.product,
    workspaceId: context.workspaceId,
    scopes: ['market:review'],
    now: () => {
      mutatingClockContext.workspaceId = 'another-workspace'
      return now()
    },
  }
  const reviewed = await independentlyReviewSyntheticMarketPlan(plan, 'acknowledged', true, 'checker@example.test', setup.reviews, mutatingClockContext)
  assert.equal(reviewed.execution.state, 'NOT_AUTHORIZED')
  assert.equal(setup.reviews.entries[0]?.workspaceId, context.workspaceId)
  assert.equal(setup.audit.entries[2]?.event.workspaceId, context.workspaceId)
})

test('D3 refuses an injected ledger result whose audit hash is malformed before it can return a receipt', async () => {
  const setup = marketRunner()
  const result = await setup.runner.run({ connectorId: MARKET_CONNECTOR_ID, input: capacityQuote, ...runContext })
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
  assert.match(ADOS_10_MARKET_CONTROLS[7]?.enforcement ?? '', /D12 snapshots the runner envelope/i)
  assert.match(ADOS_10_MARKET_CONTROLS[7]?.enforcement ?? '', /D13 retains the market preflight snapshot/i)
  assert.match(ADOS_10_MARKET_CONTROLS[7]?.enforcement ?? '', /D14 fixes the connector configuration snapshot/i)
  assert.match(ADOS_10_MARKET_CONTROLS[7]?.enforcement ?? '', /D15 fixes governed host seams and time/i)
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
