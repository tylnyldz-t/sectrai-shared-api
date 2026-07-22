import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from './errors.js'
import type { MarketReviewDecision, MarketReviewLedger } from './market-review-ledger.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export type { MarketReviewDecision, MarketReviewLedger, MarketReviewLedgerEntry } from './market-review-ledger.js'

export const MARKET_CONNECTOR_ID = 'market'
export const MARKET_LIVE_STATUS = 'MARKET_LIVE_DISABLED'

const MARKET_SCOPES = ['market:discover', 'market:capacity:quote', 'market:review'] as const
const REVIEW_PACKET_VERSION = 'synthetic-market-review-packet-v1'
const ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

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
  /** This adapter is available only when this is literally false. */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
  maxCapacityUnits?: number
}

export type MarketPlanBinding = {
  product: string
  workspaceId: string
  requestedBy: string
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
}

export type MarketExecution = {
  state: 'NOT_AUTHORIZED'
  externalNetwork: false
  reservation: false
  booking: false
  publication: false
}

export type MarketReviewPacket = {
  version: typeof REVIEW_PACKET_VERSION
  reviewId: string
  planDigest: string
  bindingDigest: string
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  automaticAction: false
  execution: MarketExecution
  integrity: { algorithm: 'sha256'; digest: string }
}

export type SyntheticMarketPlan = {
  id: string
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'OWNER_REVIEW_REQUIRED'
  binding: MarketPlanBinding
  integrity: { algorithm: 'sha256'; digest: string }
  request: SyntheticMarketInput
  quote: { state: 'NOT_QUOTED'; reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' } | null
  sideEffects: MarketExecution
  ownerReview: {
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
    requiredScope: 'market:review'
    makerCanReview: false
    decisionAuthorizesExecution: false
  }
  reviewPacket: MarketReviewPacket
}

export type MarketReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'scopes' | 'now'>

export type ReviewedSyntheticMarketPlan = {
  planId: string
  reviewId: string
  reviewPacketIntegrityDigest: string
  decision: MarketReviewDecision
  reviewedBy: string
  reviewedAt: string
  mode: 'SYNTHETIC'
  execution: MarketExecution
  auditHash: string
}

type MarketLimits = Required<Omit<SyntheticMarketConnectorConfig, 'liveEnabled'>>
type ReviewContext = { product: string; workspaceId: string; scopes: readonly string[]; now: () => Date }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function exactObject(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ConnectorInputError(error)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key)) || fields.some((key) => !keys.includes(key))) {
    throw new ConnectorInputError(error)
  }
  return record
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function id(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null
}

function actor(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && ACTOR_PATTERN.test(value) ? value : null
}

function execution(): MarketExecution {
  return { state: 'NOT_AUTHORIZED', externalNetwork: false, reservation: false, booking: false, publication: false }
}

function normalizedScopes(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((scope) => typeof scope !== 'string' || !MARKET_SCOPES.includes(scope as typeof MARKET_SCOPES[number]))) {
    throw new ScopeError(error)
  }
  return [...new Set(value)].sort()
}

function configured(config: SyntheticMarketConnectorConfig, context: ConnectorRunContext): MarketLimits {
  const maxCostCapCents = positiveInteger(config.maxCostCapCents)
  const maxItems = positiveInteger(config.maxItems)
  const maxCapacityUnits = positiveInteger(config.maxCapacityUnits)
  if (!maxCostCapCents || !maxItems || !maxCapacityUnits) throw new ConnectorUnavailableError('MARKET_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  if (config.liveEnabled !== false) throw new ConnectorUnavailableError(MARKET_LIVE_STATUS)
  if (!positiveInteger(context.costCapCents)) throw new CostCapError('MARKET_COST_CAP_REQUIRED')
  if (!positiveInteger(context.requestedItems)) throw new CostCapError('MARKET_REQUESTED_ITEMS_REQUIRED')
  if (context.costCapCents > maxCostCapCents) throw new CostCapError()
  if (context.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  return { maxCostCapCents, maxItems, maxCapacityUnits }
}

function request(input: unknown, limits: MarketLimits): SyntheticMarketInput {
  const candidate = exactObject(input, ['operation', 'transportMode', 'originCountry', 'destinationCountry', 'requestedListings', ...(isCapacityQuote(input) ? ['requestedCapacityUnits'] : [])], 'INVALID_MARKET_REQUEST')
  if (candidate.operation !== 'freight-discovery' && candidate.operation !== 'capacity-discovery' && candidate.operation !== 'capacity-quote') {
    throw new ConnectorInputError('INVALID_MARKET_OPERATION')
  }
  if (candidate.transportMode !== 'road' && candidate.transportMode !== 'sea' && candidate.transportMode !== 'rail' && candidate.transportMode !== 'air') {
    throw new ConnectorInputError('INVALID_MARKET_TRANSPORT_MODE')
  }
  if (typeof candidate.originCountry !== 'string' || typeof candidate.destinationCountry !== 'string' || !/^[a-zA-Z]{2}$/.test(candidate.originCountry) || !/^[a-zA-Z]{2}$/.test(candidate.destinationCountry)) {
    throw new ConnectorInputError('INVALID_MARKET_COUNTRY')
  }
  const requestedListings = positiveInteger(candidate.requestedListings)
  if (!requestedListings || requestedListings > limits.maxItems) throw new ConnectorInputError('INVALID_MARKET_REQUESTED_LISTINGS')
  const base: MarketRequestFields = {
    operation: candidate.operation,
    transportMode: candidate.transportMode,
    originCountry: candidate.originCountry.toUpperCase(),
    destinationCountry: candidate.destinationCountry.toUpperCase(),
    requestedListings,
  }
  if (candidate.operation !== 'capacity-quote') return { ...base, operation: candidate.operation }
  const requestedCapacityUnits = positiveInteger(candidate.requestedCapacityUnits)
  if (!requestedCapacityUnits || requestedCapacityUnits > limits.maxCapacityUnits) throw new ConnectorInputError('INVALID_MARKET_CAPACITY_UNITS')
  return { ...base, operation: 'capacity-quote', requestedCapacityUnits }
}

function isCapacityQuote(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).operation === 'capacity-quote')
}

function requiredScope(input: SyntheticMarketInput): 'market:discover' | 'market:capacity:quote' {
  return input.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
}

function validateRun(config: SyntheticMarketConnectorConfig, input: unknown, context: ConnectorRunContext): { input: SyntheticMarketInput; binding: MarketPlanBinding } {
  if (context.ownerApproved !== true) throw new OwnerGateError()
  const limits = configured(config, context)
  const product = id(context.product)
  const workspaceId = id(context.workspaceId)
  const requestedBy = actor(context.actor)
  if (!product || !workspaceId) throw new ConnectorInputError('INVALID_MARKET_CONTEXT')
  if (!requestedBy) throw new OwnerGateError('MARKET_REQUESTER_REQUIRED')
  const scopes = normalizedScopes(context.scopes, 'MARKET_SCOPE_DENIED')
  const parsed = request(input, limits)
  if (parsed.requestedListings !== context.requestedItems) throw new CostCapError('MARKET_LISTINGS_MUST_MATCH_REQUESTED_ITEMS')
  if (!scopes.includes(requiredScope(parsed))) throw new ConnectorInputError('MARKET_OPERATION_SCOPE_REQUIRED')
  return { input: parsed, binding: { product, workspaceId, requestedBy, scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems } }
}

function buildPlan(binding: MarketPlanBinding, input: SyntheticMarketInput): SyntheticMarketPlan {
  const planDigest = sha256(canonicalJson({ binding, request: input }))
  const reviewId = `synthetic-market-review-${planDigest.slice(0, 24)}`
  const packet: Omit<MarketReviewPacket, 'integrity'> = {
    version: REVIEW_PACKET_VERSION,
    reviewId,
    planDigest,
    bindingDigest: sha256(canonicalJson(binding)),
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW' as const,
    automaticAction: false as const,
    execution: execution(),
  }
  return {
    id: `synthetic-market-${planDigest.slice(0, 24)}`,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'OWNER_REVIEW_REQUIRED',
    binding,
    integrity: { algorithm: 'sha256', digest: planDigest },
    request: input,
    quote: input.operation === 'capacity-quote' ? { state: 'NOT_QUOTED', reason: 'SYNTHETIC_MARKET_HAS_NO_CAPACITY_OFFERS' } : null,
    sideEffects: execution(),
    ownerReview: { state: 'PENDING_INDEPENDENT_OWNER_REVIEW', requiredScope: 'market:review', makerCanReview: false, decisionAuthorizesExecution: false },
    reviewPacket: { ...packet, integrity: { algorithm: 'sha256', digest: sha256(canonicalJson(packet)) } },
  }
}

function freezePlan(plan: SyntheticMarketPlan): SyntheticMarketPlan {
  Object.freeze(plan.binding.scopes)
  Object.freeze(plan.binding)
  Object.freeze(plan.integrity)
  Object.freeze(plan.request)
  if (plan.quote) Object.freeze(plan.quote)
  Object.freeze(plan.sideEffects)
  Object.freeze(plan.ownerReview)
  Object.freeze(plan.reviewPacket.execution)
  Object.freeze(plan.reviewPacket.integrity)
  Object.freeze(plan.reviewPacket)
  return Object.freeze(plan)
}

function reviewContext(context: MarketReviewContext): ReviewContext {
  const product = id(context.product)
  const workspaceId = id(context.workspaceId)
  if (!product || !workspaceId || typeof context.now !== 'function') throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  const scopes = normalizedScopes(context.scopes, 'MARKET_REVIEW_SCOPE_REQUIRED')
  if (!scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  return { product, workspaceId, scopes, now: context.now }
}

function reviewTime(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  return value.toISOString()
}

export function validateSyntheticMarketPlanForReview(plan: unknown, context: MarketReviewContext): SyntheticMarketPlan {
  const reviewedContext = reviewContext(context)
  const candidate = exactObject(plan, ['id', 'mode', 'liveStatus', 'state', 'binding', 'integrity', 'request', 'quote', 'sideEffects', 'ownerReview', 'reviewPacket'], 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const binding = exactObject(candidate.binding, ['product', 'workspaceId', 'requestedBy', 'scopes', 'costCapCents', 'requestedItems'], 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const product = id(binding.product)
  const workspaceId = id(binding.workspaceId)
  const requestedBy = actor(binding.requestedBy)
  const costCapCents = positiveInteger(binding.costCapCents)
  const requestedItems = positiveInteger(binding.requestedItems)
  if (!product || !workspaceId || !requestedBy || !costCapCents || !requestedItems || product !== reviewedContext.product || workspaceId !== reviewedContext.workspaceId) {
    throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  }
  const scopes = normalizedScopes(binding.scopes, 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  let parsed: SyntheticMarketInput
  try {
    parsed = request(candidate.request, { maxCostCapCents: Number.MAX_SAFE_INTEGER, maxItems: Number.MAX_SAFE_INTEGER, maxCapacityUnits: Number.MAX_SAFE_INTEGER })
  } catch {
    throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  }
  if (requestedItems !== parsed.requestedListings || !scopes.includes(requiredScope(parsed))) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const expected = buildPlan({ product, workspaceId, requestedBy, scopes, costCapCents, requestedItems }, parsed)
  if (canonicalJson(candidate) !== canonicalJson(expected)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  return freezePlan(expected)
}

function auditHash(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('hash' in value) || typeof (value as { hash: unknown }).hash !== 'string' || !DIGEST_PATTERN.test((value as { hash: string }).hash)) {
    throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
  }
  return (value as { hash: string }).hash
}

export class SyntheticMarketConnector implements Connector<SyntheticMarketInput, SyntheticMarketPlan> {
  readonly id = MARKET_CONNECTOR_ID
  readonly kind = 'market' as const
  readonly authKind = 'owner-token' as const
  readonly quotaGroup = 'market'
  readonly scopes = Object.freeze([...MARKET_SCOPES])
  readonly #config: SyntheticMarketConnectorConfig

  constructor(config: SyntheticMarketConnectorConfig = {}) {
    this.#config = Object.freeze({
      liveEnabled: config.liveEnabled,
      maxCostCapCents: config.maxCostCapCents,
      maxItems: config.maxItems,
      maxCapacityUnits: config.maxCapacityUnits,
    })
    Object.freeze(this)
  }

  readonly preflight = (input: SyntheticMarketInput, context: ConnectorRunContext): SyntheticMarketInput => {
    return Object.freeze(validateRun(this.#config, input, context).input)
  }

  readonly run = async (input: SyntheticMarketInput, context: ConnectorRunContext): Promise<ConnectorResult<SyntheticMarketPlan>> => {
    const validated = validateRun(this.#config, input, context)
    const occurredAt = context.now()
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) throw new ConnectorInputError('INVALID_MARKET_RUN_TIME')
    const plan = freezePlan(buildPlan(validated.binding, validated.input))
    return Object.freeze({
      data: plan,
      provenance: Object.freeze({
        connectorId: this.id,
        source: 'synthetic-market-proposal',
        retrievedAt: occurredAt.toISOString(),
        runId: plan.id,
        untrustedContent: Object.freeze({
          source: 'synthetic-market-request',
          value: validated.input,
          handling: 'data-only' as const,
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' as const,
        }),
      }),
      confidence: 0,
    })
  }
}

/** Records a terminal, independent review; it never authorizes execution. */
export async function independentlyReviewSyntheticMarketPlan(plan: SyntheticMarketPlan, decision: MarketReviewDecision, ownerApproved: boolean, reviewer: string, reviewLedger: MarketReviewLedger, context: MarketReviewContext): Promise<ReviewedSyntheticMarketPlan> {
  if (ownerApproved !== true) throw new OwnerGateError()
  if (decision !== 'acknowledged' && decision !== 'rejected') throw new ConnectorInputError('INVALID_MARKET_REVIEW_DECISION')
  const reviewedContext = reviewContext(context)
  const reviewedBy = actor(reviewer)
  if (!reviewedBy) throw new OwnerGateError('MARKET_REVIEWER_REQUIRED')
  const validatedPlan = validateSyntheticMarketPlanForReview(plan, context)
  if (reviewedBy === validatedPlan.binding.requestedBy) throw new MakerCheckerError('MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  if (!reviewLedger || typeof reviewLedger.recordTerminalReview !== 'function') throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
  const reviewedAt = reviewTime(reviewedContext.now)
  const hash = auditHash(await reviewLedger.recordTerminalReview({
    product: reviewedContext.product,
    workspaceId: reviewedContext.workspaceId,
    planId: validatedPlan.id,
    planDigest: validatedPlan.integrity.digest,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy,
    reviewedAt,
  }))
  return Object.freeze({
    planId: validatedPlan.id,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy,
    reviewedAt,
    mode: 'SYNTHETIC',
    execution: Object.freeze(execution()),
    auditHash: hash,
  })
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
