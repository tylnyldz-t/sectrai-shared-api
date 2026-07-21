import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from './errors.js'
import type { AuditLog, Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const MARKET_CONNECTOR_ID = 'market'
export const MARKET_LIVE_STATUS = 'MARKET_LIVE_DISABLED'

export type MarketOperation = 'freight-discovery' | 'capacity-discovery' | 'capacity-quote'
export type MarketTransportMode = 'road' | 'sea' | 'rail' | 'air'

type MarketRequestFields = {
  operation: MarketOperation
  transportMode: MarketTransportMode
  originCountry: string
  destinationCountry: string
  requestedListings: number
}

export type MarketDiscoveryInput = MarketRequestFields & {
  operation: 'freight-discovery' | 'capacity-discovery'
}

export type MarketCapacityQuoteInput = MarketRequestFields & {
  operation: 'capacity-quote'
  requestedCapacityUnits: number
}

export type SyntheticMarketInput = MarketDiscoveryInput | MarketCapacityQuoteInput

export type SyntheticMarketConnectorConfig = {
  /**
   * There is no real-provider implementation in this connector. A true value
   * is deliberately a failure, rather than an opt-in.
   */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
  maxCapacityUnits?: number
}

type ConfiguredMarketLimits = Required<Omit<SyntheticMarketConnectorConfig, 'liveEnabled'>>

export type MarketPlanBinding = {
  product: string
  workspaceId: string
  requestedBy: string
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
}

export type MarketOwnerReview = {
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  requiredScope: 'market:review'
  makerCanReview: false
  automaticAction: false
  decisionAuthorizesExecution: false
}

export type SyntheticMarketPlan = {
  id: string
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'OWNER_REVIEW_REQUIRED'
  binding: MarketPlanBinding
  integrity: {
    algorithm: 'sha256'
    /** Deterministic binding only; this is not a signature or a live authorization. */
    digest: string
  }
  request: SyntheticMarketInput
  sources: readonly {
    id: 'internal-capacity-market' | 'hub-connect'
    state: 'NOT_QUERIED' | 'NOT_CONTACTED'
    autoSync: false
    credentialsAccepted: false
  }[]
  quote: { state: 'NOT_QUOTED'; reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' } | null
  sideEffects: {
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
  ownerReview: MarketOwnerReview
}

export type MarketReviewDecision = 'acknowledged' | 'rejected'

export type ReviewedSyntheticMarketPlan = {
  planId: string
  decision: MarketReviewDecision
  reviewedBy: string
  reviewedAt: string
  mode: 'SYNTHETIC'
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
  auditHash: string
}

export type MarketReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'scopes' | 'now'>

const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function exactObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  const object = input as Record<string, unknown>
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  return object
}

function marketOperation(value: unknown): MarketOperation {
  if (value !== 'freight-discovery' && value !== 'capacity-discovery' && value !== 'capacity-quote') throw new ConnectorInputError('INVALID_MARKET_OPERATION')
  return value
}

function transportMode(value: unknown): MarketTransportMode {
  if (value !== 'road' && value !== 'sea' && value !== 'rail' && value !== 'air') throw new ConnectorInputError('INVALID_MARKET_TRANSPORT_MODE')
  return value
}

function country(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z]{2}$/.test(value)) throw new ConnectorInputError('INVALID_MARKET_COUNTRY')
  return value.toUpperCase()
}

function requestedListings(value: unknown, maxItems: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > maxItems) throw new ConnectorInputError('INVALID_MARKET_REQUESTED_LISTINGS')
  return parsed
}

function requestedCapacityUnits(value: unknown, maxCapacityUnits: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > maxCapacityUnits) throw new ConnectorInputError('INVALID_MARKET_CAPACITY_UNITS')
  return parsed
}

function configured(config: SyntheticMarketConnectorConfig, ctx: ConnectorRunContext): ConfiguredMarketLimits {
  const maxCostCapCents = positiveInteger(config.maxCostCapCents)
  const maxItems = positiveInteger(config.maxItems)
  const maxCapacityUnits = positiveInteger(config.maxCapacityUnits)
  if (!maxCostCapCents || !maxItems || !maxCapacityUnits) throw new ConnectorUnavailableError('MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  // The only deployment value that permits the synthetic adapter is literal
  // false. Missing, malformed, and true values all close the connector.
  if (config.liveEnabled !== false) throw new ConnectorUnavailableError(MARKET_LIVE_STATUS)
  if (!positiveInteger(ctx.costCapCents)) throw new CostCapError('MARKET_COST_CAP_REQUIRED')
  if (!positiveInteger(ctx.requestedItems)) throw new CostCapError('MARKET_REQUESTED_ITEMS_REQUIRED')
  if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
  if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  return { maxCostCapCents, maxItems, maxCapacityUnits }
}

function parse(input: unknown, limits: ConfiguredMarketLimits): SyntheticMarketInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  const candidate = input as Record<string, unknown>
  const operation = marketOperation(candidate.operation)
  const object = exactObject(input, operation === 'capacity-quote'
    ? ['operation', 'transportMode', 'originCountry', 'destinationCountry', 'requestedListings', 'requestedCapacityUnits']
    : ['operation', 'transportMode', 'originCountry', 'destinationCountry', 'requestedListings'])
  const base: MarketRequestFields = {
    operation,
    transportMode: transportMode(object.transportMode),
    originCountry: country(object.originCountry),
    destinationCountry: country(object.destinationCountry),
    requestedListings: requestedListings(object.requestedListings, limits.maxItems),
  }
  if (operation === 'capacity-quote') {
    return { ...base, operation, requestedCapacityUnits: requestedCapacityUnits(object.requestedCapacityUnits, limits.maxCapacityUnits) }
  }
  return { ...base, operation }
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort()
}

function planBinding(ctx: ConnectorRunContext): MarketPlanBinding {
  return {
    product: ctx.product,
    workspaceId: ctx.workspaceId,
    requestedBy: ctx.actor,
    scopes: normalizedScopes(ctx.scopes),
    costCapCents: ctx.costCapCents,
    requestedItems: ctx.requestedItems,
  }
}

function marketPlanMaterial(binding: MarketPlanBinding, request: SyntheticMarketInput): string {
  return JSON.stringify({ binding, request })
}

function marketPlanDigest(binding: MarketPlanBinding, request: SyntheticMarketInput): string {
  return createHash('sha256').update(marketPlanMaterial(binding, request)).digest('hex')
}

function planId(binding: MarketPlanBinding, request: SyntheticMarketInput): string {
  return 'synthetic-market-' + marketPlanDigest(binding, request).slice(0, 24)
}

function requiredScope(request: SyntheticMarketInput): 'market:discover' | 'market:capacity:quote' {
  return request.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
}

function validatedRequest(config: SyntheticMarketConnectorConfig, input: unknown, ctx: ConnectorRunContext): SyntheticMarketInput {
  const limits = configured(config, ctx)
  const request = parse(input, limits)
  if (request.requestedListings !== ctx.requestedItems) throw new CostCapError('MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
  if (!ctx.scopes.includes(requiredScope(request))) throw new ConnectorInputError('MARKET_OPERATION_SCOPE_REQUIRED')
  return request
}

function isReviewablePlan(plan: SyntheticMarketPlan, context: MarketReviewContext): boolean {
  if (!plan || typeof plan !== 'object' || !plan.binding || !plan.integrity || !plan.request) return false
  const { binding } = plan
  if (binding.product !== context.product || binding.workspaceId !== context.workspaceId || typeof binding.requestedBy !== 'string') return false
  if (!Array.isArray(binding.scopes) || binding.scopes.length === 0 || binding.scopes.some((scope) => typeof scope !== 'string')) return false
  if (JSON.stringify(binding.scopes) !== JSON.stringify(normalizedScopes(binding.scopes))) return false
  if (!positiveInteger(binding.costCapCents) || !positiveInteger(binding.requestedItems)) return false
  if (plan.mode !== 'SYNTHETIC' || plan.liveStatus !== 'LIVE_DISABLED' || plan.state !== 'OWNER_REVIEW_REQUIRED') return false
  if (plan.ownerReview?.state !== 'PENDING_INDEPENDENT_OWNER_REVIEW' || plan.ownerReview.requiredScope !== 'market:review' || plan.ownerReview.makerCanReview !== false || plan.ownerReview.automaticAction !== false || plan.ownerReview.decisionAuthorizesExecution !== false) return false
  if (plan.sideEffects?.externalNetwork !== false || plan.sideEffects.reservation !== false || plan.sideEffects.booking !== false || plan.sideEffects.publication !== false) return false
  try {
    const digest = marketPlanDigest(binding, plan.request)
    return plan.integrity.algorithm === 'sha256' && plan.integrity.digest === digest && plan.id === `synthetic-market-${digest.slice(0, 24)}`
  } catch {
    return false
  }
}

/**
 * A proposal-only market adapter. It deliberately has no provider address,
 * fetch client, credential field, scheduler, persistence side effect, booking,
 * reservation, or publishing path. Its Hub Connect and capacity-market
 * references are named states, never integrations.
 */
export class SyntheticMarketConnector implements Connector<SyntheticMarketInput, SyntheticMarketPlan> {
  readonly id = MARKET_CONNECTOR_ID
  readonly kind = 'market' as const
  readonly authKind = 'owner-token' as const
  readonly quotaGroup = 'market'
  readonly scopes = ['market:discover', 'market:capacity:quote', 'market:review'] as const

  constructor(private readonly config: SyntheticMarketConnectorConfig = {}) {}

  preflight(input: SyntheticMarketInput, ctx: ConnectorRunContext): void {
    validatedRequest(this.config, input, ctx)
  }

  async run(input: SyntheticMarketInput, ctx: ConnectorRunContext): Promise<ConnectorResult<SyntheticMarketPlan>> {
    const request = validatedRequest(this.config, input, ctx)
    const binding = planBinding(ctx)
    const digest = marketPlanDigest(binding, request)
    const plan: SyntheticMarketPlan = {
      id: planId(binding, request),
      mode: 'SYNTHETIC',
      liveStatus: 'LIVE_DISABLED',
      state: 'OWNER_REVIEW_REQUIRED',
      binding,
      integrity: { algorithm: 'sha256', digest },
      request,
      sources: [
        { id: 'internal-capacity-market', state: 'NOT_QUERIED', autoSync: false, credentialsAccepted: false },
        { id: 'hub-connect', state: 'NOT_CONTACTED', autoSync: false, credentialsAccepted: false },
      ],
      quote: request.operation === 'capacity-quote'
        ? { state: 'NOT_QUOTED', reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' }
        : null,
      sideEffects: { externalNetwork: false, reservation: false, booking: false, publication: false },
      ownerReview: { state: 'PENDING_INDEPENDENT_OWNER_REVIEW', requiredScope: 'market:review', makerCanReview: false, automaticAction: false, decisionAuthorizesExecution: false },
    }
    return {
      data: plan,
      provenance: {
        connectorId: this.id,
        source: 'synthetic-market-proposal',
        retrievedAt: ctx.now().toISOString(),
        runId: plan.id,
        untrustedContent: {
          source: 'synthetic-market-request',
          value: request,
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

/**
 * Records a maker/checker-separated review decision for an in-memory
 * synthetic proposal. Neither decision authorizes a reservation, booking,
 * publication, provider call, handoff, or any other execution. This function
 * deliberately has no HTTP route and no plan persistence layer.
 */
export async function independentlyReviewSyntheticMarketPlan(plan: SyntheticMarketPlan, decision: MarketReviewDecision, ownerApproved: boolean, reviewer: string, auditLog: AuditLog, context: MarketReviewContext): Promise<ReviewedSyntheticMarketPlan> {
  if (!ownerApproved) throw new OwnerGateError()
  if (!OWNER_ACTOR_PATTERN.test(reviewer)) throw new OwnerGateError('MARKET_REVIEWER_REQUIRED')
  if (!context.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  if (decision !== 'acknowledged' && decision !== 'rejected') throw new ConnectorInputError('INVALID_MARKET_REVIEW_DECISION')
  if (!isReviewablePlan(plan, context)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  if (reviewer === plan.binding.requestedBy) throw new MakerCheckerError('MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER')

  const reviewedAt = context.now().toISOString()
  const audit = await auditLog.append({
    type: 'connector.market.owner_reviewed',
    connectorId: MARKET_CONNECTOR_ID,
    product: context.product,
    workspaceId: context.workspaceId,
    actor: reviewer,
    scopes: ['market:review'],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: reviewedAt,
    detail: {
      planId: plan.id,
      planDigest: plan.integrity.digest,
      maker: plan.binding.requestedBy,
      decision,
      execution: 'NOT_AUTHORIZED',
      externalNetwork: false,
      reservation: false,
      booking: false,
      publication: false,
    },
  })
  return {
    planId: plan.id,
    decision,
    reviewedBy: reviewer,
    reviewedAt,
    mode: 'SYNTHETIC',
    execution: { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false },
    auditHash: audit.hash,
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Only literal false permits the synthetic adapter; every other value closes it. */
export function syntheticMarketConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticMarketConnector {
  return new SyntheticMarketConnector({
    liveEnabled: environment.GCL_MARKET_LIVE_ENABLED === 'false' ? false : true,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_MARKET_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_MARKET_MAX_ITEMS),
    maxCapacityUnits: environmentPositiveInteger(environment.GCL_MARKET_MAX_CAPACITY_UNITS),
  })
}
