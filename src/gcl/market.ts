import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from './errors.js'
import type { AuditLog, Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const MARKET_CONNECTOR_ID = 'market'
export const MARKET_LIVE_STATUS = 'MARKET_LIVE_DISABLED'
const MARKET_REVIEW_PACKET_VERSION = 'synthetic-market-review-packet-v1'
const MARKET_SCOPES = ['market:discover', 'market:capacity:quote', 'market:review'] as const

export type AdosMarketControl = {
  id: `ADOS-${string}`
  control: string
  enforcement: string
}

/**
 * The review packet remains an in-process, synthetic boundary. These controls
 * are exported so its safety claims stay testable instead of documentation-only.
 */
export const ADOS_10_MARKET_CONTROLS: readonly AdosMarketControl[] = Object.freeze([
  { id: 'ADOS-01', control: 'PRODUCT_WORKSPACE_ISOLATION', enforcement: 'Every plan and review packet is digest-bound to one product and workspace.' },
  { id: 'ADOS-02', control: 'SYNTHETIC_DATA_ONLY', enforcement: 'Only the bounded market request shape is accepted; no market response or provider payload is ingested.' },
  { id: 'ADOS-03', control: 'FAIL_CLOSED_CONFIGURATION', enforcement: 'Only literal GCL_MARKET_LIVE_ENABLED=false permits the synthetic adapter; absent, malformed, and true values deny.' },
  { id: 'ADOS-04', control: 'STRICT_PACKET_INTEGRITY', enforcement: 'Review reconstructs the complete canonical plan and rejects unknown, changed, or malformed fields.' },
  { id: 'ADOS-05', control: 'UNTRUSTED_CONTENT_IS_DATA', enforcement: 'Request values are labelled data-only and cannot become connector instructions.' },
  { id: 'ADOS-06', control: 'OWNER_AND_MAKER_CHECKER', enforcement: 'A separate canonical owner actor with market:review is required; the plan maker cannot self-review.' },
  { id: 'ADOS-07', control: 'NO_EGRESS_OR_CREDENTIALS', enforcement: 'No network client, provider URL, credential, API key, scheduler, or automatic sync exists in this connector.' },
  { id: 'ADOS-08', control: 'BOUNDED_GOVERNANCE', enforcement: 'Preflight, independent cost and quota limits, and the scoped SHA-256 audit chain remain mandatory.' },
  { id: 'ADOS-09', control: 'NO_MARKET_ACTION', enforcement: 'The packet and review receipt permanently report no quote, reservation, booking, publication, handoff, or automatic action.' },
  { id: 'ADOS-10', control: 'NO_LAUNCH_OR_PRODUCTION_WRITE', enforcement: 'No production migration, main/prod write, live launch, or market-provider integration is part of this connector.' },
])

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

export type MarketReviewPacket = {
  version: typeof MARKET_REVIEW_PACKET_VERSION
  reviewId: string
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  planDigest: string
  bindingDigest: string
  integrity: {
    algorithm: 'sha256'
    digest: string
  }
  automaticAction: false
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
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
  reviewPacket: MarketReviewPacket
}

export type MarketReviewDecision = 'acknowledged' | 'rejected'

export type ReviewedSyntheticMarketPlan = {
  planId: string
  reviewId: string
  reviewPacketIntegrityDigest: string
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

function canonicalActor(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && OWNER_ACTOR_PATTERN.test(value) ? value : null
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Object.getOwnPropertySymbols(record).length > 0) return '{"$unsupportedSymbolFields":true}'
    return `{${Object.getOwnPropertyNames(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicallyEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function planBinding(ctx: ConnectorRunContext): MarketPlanBinding {
  const requestedBy = canonicalActor(ctx.actor)
  if (!requestedBy) throw new OwnerGateError('MARKET_REQUESTER_REQUIRED')
  return {
    product: ctx.product,
    workspaceId: ctx.workspaceId,
    requestedBy,
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

function marketBindingDigest(binding: MarketPlanBinding): string {
  return createHash('sha256').update(canonicalJson(binding)).digest('hex')
}

function planId(binding: MarketPlanBinding, request: SyntheticMarketInput): string {
  return 'synthetic-market-' + marketPlanDigest(binding, request).slice(0, 24)
}

function reviewId(binding: MarketPlanBinding, request: SyntheticMarketInput): string {
  return 'synthetic-market-review-' + marketPlanDigest(binding, request).slice(0, 24)
}

function reviewExecution(): MarketReviewPacket['execution'] {
  return { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false }
}

function reviewPacketMaterial(packet: Omit<MarketReviewPacket, 'integrity'>): string {
  return canonicalJson(packet)
}

function reviewPacket(binding: MarketPlanBinding, request: SyntheticMarketInput): MarketReviewPacket {
  const planDigest = marketPlanDigest(binding, request)
  const packet: Omit<MarketReviewPacket, 'integrity'> = {
    version: MARKET_REVIEW_PACKET_VERSION,
    reviewId: reviewId(binding, request),
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    planDigest,
    bindingDigest: marketBindingDigest(binding),
    automaticAction: false,
    execution: reviewExecution(),
  }
  return {
    ...packet,
    integrity: { algorithm: 'sha256', digest: createHash('sha256').update(reviewPacketMaterial(packet)).digest('hex') },
  }
}

function requiredScope(request: SyntheticMarketInput): 'market:discover' | 'market:capacity:quote' {
  return request.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
}

function validatedRequest(config: SyntheticMarketConnectorConfig, input: unknown, ctx: ConnectorRunContext): SyntheticMarketInput {
  const limits = configured(config, ctx)
  if (!canonicalActor(ctx.actor)) throw new OwnerGateError('MARKET_REQUESTER_REQUIRED')
  const request = parse(input, limits)
  if (request.requestedListings !== ctx.requestedItems) throw new CostCapError('MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
  if (!ctx.scopes.includes(requiredScope(request))) throw new ConnectorInputError('MARKET_OPERATION_SCOPE_REQUIRED')
  return request
}

function syntheticMarketPlan(binding: MarketPlanBinding, request: SyntheticMarketInput): SyntheticMarketPlan {
  const digest = marketPlanDigest(binding, request)
  return {
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
    reviewPacket: reviewPacket(binding, request),
  }
}

/**
 * Reconstructs the entire reviewable plan instead of trusting a caller-held
 * object. This is deliberately stricter than checking the plan digest alone:
 * source, quote, side-effect, and review-packet fields are all canonical.
 */
export function validateSyntheticMarketPlanForReview(plan: unknown, context: MarketReviewContext): SyntheticMarketPlan {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const candidate = plan as Record<string, unknown>
  const bindingValue = candidate.binding
  if (!bindingValue || typeof bindingValue !== 'object' || Array.isArray(bindingValue)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const bindingCandidate = bindingValue as Record<string, unknown>
  const requestedBy = canonicalActor(bindingCandidate.requestedBy)
  const costCapCents = positiveInteger(bindingCandidate.costCapCents)
  const requestedItems = positiveInteger(bindingCandidate.requestedItems)
  if (
    bindingCandidate.product !== context.product || bindingCandidate.workspaceId !== context.workspaceId || !requestedBy ||
    !Array.isArray(bindingCandidate.scopes) || bindingCandidate.scopes.length === 0 || bindingCandidate.scopes.some((scope) => typeof scope !== 'string' || !MARKET_SCOPES.includes(scope as typeof MARKET_SCOPES[number])) ||
    canonicalJson(bindingCandidate.scopes) !== canonicalJson(normalizedScopes(bindingCandidate.scopes as string[])) ||
    !costCapCents || !requestedItems
  ) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')

  let request: SyntheticMarketInput
  try {
    request = parse(candidate.request, { maxCostCapCents: Number.MAX_SAFE_INTEGER, maxItems: Number.MAX_SAFE_INTEGER, maxCapacityUnits: Number.MAX_SAFE_INTEGER })
  } catch {
    throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  }
  const binding: MarketPlanBinding = {
    product: bindingCandidate.product,
    workspaceId: bindingCandidate.workspaceId,
    requestedBy,
    scopes: bindingCandidate.scopes as string[],
    costCapCents,
    requestedItems,
  }
  if (request.requestedListings !== binding.requestedItems || !binding.scopes.includes(requiredScope(request))) {
    throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  }
  const expected = syntheticMarketPlan(binding, request)
  if (!canonicallyEqual(candidate, expected)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  return expected
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
  readonly scopes = MARKET_SCOPES

  constructor(private readonly config: SyntheticMarketConnectorConfig = {}) {}

  preflight(input: SyntheticMarketInput, ctx: ConnectorRunContext): void {
    validatedRequest(this.config, input, ctx)
  }

  async run(input: SyntheticMarketInput, ctx: ConnectorRunContext): Promise<ConnectorResult<SyntheticMarketPlan>> {
    const request = validatedRequest(this.config, input, ctx)
    const binding = planBinding(ctx)
    const plan = syntheticMarketPlan(binding, request)
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
  const canonicalReviewer = canonicalActor(reviewer)
  if (!canonicalReviewer) throw new OwnerGateError('MARKET_REVIEWER_REQUIRED')
  if (!context.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  if (decision !== 'acknowledged' && decision !== 'rejected') throw new ConnectorInputError('INVALID_MARKET_REVIEW_DECISION')
  const validatedPlan = validateSyntheticMarketPlanForReview(plan, context)
  if (canonicalReviewer === validatedPlan.binding.requestedBy) throw new MakerCheckerError('MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER')

  const reviewedAt = context.now().toISOString()
  const audit = await auditLog.append({
    type: 'connector.market.owner_reviewed',
    connectorId: MARKET_CONNECTOR_ID,
    product: context.product,
    workspaceId: context.workspaceId,
    actor: canonicalReviewer,
    scopes: ['market:review'],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: reviewedAt,
    detail: {
      planId: validatedPlan.id,
      planDigest: validatedPlan.integrity.digest,
      reviewId: validatedPlan.reviewPacket.reviewId,
      reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
      decision,
      execution: 'NOT_AUTHORIZED',
      externalNetwork: false,
      reservation: false,
      booking: false,
      publication: false,
    },
  })
  return {
    planId: validatedPlan.id,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy: canonicalReviewer,
    reviewedAt,
    mode: 'SYNTHETIC',
    execution: reviewExecution(),
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
