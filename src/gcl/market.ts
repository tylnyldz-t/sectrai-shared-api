import { createHash } from 'node:crypto'
import { hashAuditEvent } from './audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, ScopeError } from './errors.js'
import type { MarketReviewDecision, MarketReviewLedger } from './market-review-ledger.js'
import type { Connector, ConnectorAuditEvent, ConnectorResult, ConnectorRunContext } from './types.js'

export type { MarketReviewDecision, MarketReviewLedger, MarketReviewLedgerEntry } from './market-review-ledger.js'

export const MARKET_CONNECTOR_ID = 'market'
export const MARKET_LIVE_STATUS = 'MARKET_LIVE_DISABLED'
const MARKET_REVIEW_PACKET_VERSION = 'synthetic-market-review-packet-v1'
export const MARKET_REVIEW_RECEIPT_VERSION = 'synthetic-market-review-receipt-v1'
export const MARKET_REVIEW_AUDIT_WITNESS_VERSION = 'synthetic-market-review-audit-witness-v1'
const MARKET_SCOPES = ['market:discover', 'market:capacity:quote', 'market:review'] as const
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const PLAN_ID_PATTERN = /^synthetic-market-[a-f0-9]{24}$/
const REVIEW_ID_PATTERN = /^synthetic-market-review-[a-f0-9]{24}$/
const REVIEW_RECEIPT_ID_PATTERN = /^synthetic-market-review-receipt-[a-f0-9]{24}$/

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
  { id: 'ADOS-04', control: 'STRICT_PACKET_INTEGRITY', enforcement: 'Review reconstructs the complete canonical plan; D2 rejects unknown, changed, malformed, or replayed packets, while D3/D4 recheck caller-held receipt and audit-link evidence without a write.' },
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
  reviewReceipt: SyntheticMarketReviewReceipt
}

/**
 * A local, deterministic D3 evidence object for an already-recorded D2
 * decision. It deliberately has no authority beyond detecting mutation of the
 * plan/receipt tuple that the caller already holds.
 */
export type SyntheticMarketReviewReceipt = {
  version: typeof MARKET_REVIEW_RECEIPT_VERSION
  receiptId: string
  scopeBinding: {
    productDigest: string
    workspaceDigest: string
  }
  planId: string
  planDigest: string
  reviewId: string
  reviewPacketIntegrityDigest: string
  reviewerDigest: string
  decision: MarketReviewDecision
  reviewedAt: string
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
  auditHash: string
  integrity: {
    algorithm: 'sha256'
    digest: string
  }
}

/**
 * A caller-held, local D4 audit-link witness. It can prove only that the
 * supplied review result and the supplied hash-chain event agree. It cannot
 * prove that an audit store retained the event, and is never an authorization.
 */
export type SyntheticMarketReviewAuditWitness = {
  version: typeof MARKET_REVIEW_AUDIT_WITNESS_VERSION
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

export type MarketReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'scopes' | 'now'>

const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function exactObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length > 0) {
    throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  }
  const object = input as Record<string, unknown>
  const fields = Object.getOwnPropertyNames(object)
  if (fields.length !== allowed.length || fields.some((field) => !allowed.includes(field)) || allowed.some((field) => !fields.includes(field))) {
    throw new ConnectorInputError('INVALID_MARKET_REQUEST')
  }
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

function canonicalScopeId(value: unknown): string | null {
  return typeof value === 'string' && SCOPE_ID_PATTERN.test(value) ? value : null
}

function reviewContext(context: unknown): { product: string; workspaceId: string; scopes: readonly string[] } {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  const candidate = exactMarketObject(
    context,
    Object.hasOwn(context, 'now') ? ['product', 'workspaceId', 'scopes', 'now'] : ['product', 'workspaceId', 'scopes'],
    'INVALID_MARKET_REVIEW_CONTEXT',
  )
  const product = canonicalScopeId(candidate.product)
  const workspaceId = canonicalScopeId(candidate.workspaceId)
  if (!product || !workspaceId || (Object.hasOwn(candidate, 'now') && typeof candidate.now !== 'function') || !Array.isArray(candidate.scopes) || candidate.scopes.some((scope) => typeof scope !== 'string' || !MARKET_SCOPES.includes(scope as typeof MARKET_SCOPES[number]))) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  }
  return { product, workspaceId, scopes: candidate.scopes }
}

function reviewNow(context: unknown): Date {
  const candidate = exactMarketObject(context, ['product', 'workspaceId', 'scopes', 'now'], 'INVALID_MARKET_REVIEW_TIME')
  if (typeof candidate.now !== 'function') throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  const value = candidate.now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0 ||
      !Number.isSafeInteger(value.length) || value.length > 1_000 ||
      Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
    ) return '["$unsupportedArrayShape"]'
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return '["$unsupportedSparseArray"]'
      items.push(canonicalJson(value[index]))
    }
    return `[${items.join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Object.getPrototypeOf(record) !== Object.prototype || Object.getOwnPropertySymbols(record).length > 0) return '{"$unsupportedObjectShape":true}'
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
  const product = canonicalScopeId(ctx.product)
  const workspaceId = canonicalScopeId(ctx.workspaceId)
  if (!product || !workspaceId) throw new ConnectorInputError('INVALID_MARKET_CONTEXT')
  const requestedBy = canonicalActor(ctx.actor)
  if (!requestedBy) throw new OwnerGateError('MARKET_REQUESTER_REQUIRED')
  return {
    product,
    workspaceId,
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null
}

function exactMarketObject(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError(error)
  }
  const object = value as Record<string, unknown>
  const names = Object.getOwnPropertyNames(object)
  if (names.length !== fields.length || names.some((field) => !fields.includes(field)) || fields.some((field) => !names.includes(field))) {
    throw new ConnectorInputError(error)
  }
  return object
}

function reviewExecutionForReceipt(value: unknown): SyntheticMarketReviewReceipt['execution'] {
  const execution = exactMarketObject(value, ['state', 'externalNetwork', 'reservation', 'booking', 'publication'], 'INVALID_MARKET_REVIEW_RECEIPT_EXECUTION')
  if (execution.state !== 'NOT_AUTHORIZED' || execution.externalNetwork !== false || execution.reservation !== false || execution.booking !== false || execution.publication !== false) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_RECEIPT_EXECUTION')
  }
  return reviewExecution()
}

function reviewReceiptMaterial(receipt: Omit<SyntheticMarketReviewReceipt, 'receiptId' | 'integrity'>): string {
  return canonicalJson(receipt)
}

type ReviewedSyntheticMarketPlanDetails = Omit<ReviewedSyntheticMarketPlan, 'reviewReceipt'>

function reviewReceiptFor(plan: SyntheticMarketPlan, reviewed: ReviewedSyntheticMarketPlanDetails): SyntheticMarketReviewReceipt {
  const material: Omit<SyntheticMarketReviewReceipt, 'receiptId' | 'integrity'> = {
    version: MARKET_REVIEW_RECEIPT_VERSION,
    scopeBinding: {
      productDigest: sha256(plan.binding.product),
      workspaceDigest: sha256(plan.binding.workspaceId),
    },
    planId: plan.id,
    planDigest: plan.integrity.digest,
    reviewId: reviewed.reviewId,
    reviewPacketIntegrityDigest: reviewed.reviewPacketIntegrityDigest,
    reviewerDigest: sha256(reviewed.reviewedBy),
    decision: reviewed.decision,
    reviewedAt: reviewed.reviewedAt,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    execution: reviewExecution(),
    auditHash: reviewed.auditHash,
  }
  const integrityDigest = sha256(reviewReceiptMaterial(material))
  return {
    ...material,
    receiptId: `synthetic-market-review-receipt-${sha256(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

function requiredScope(request: SyntheticMarketInput): 'market:discover' | 'market:capacity:quote' {
  return request.operation === 'capacity-quote' ? 'market:capacity:quote' : 'market:discover'
}

function validatedRequest(config: SyntheticMarketConnectorConfig, input: unknown, ctx: ConnectorRunContext): SyntheticMarketInput {
  const limits = configured(config, ctx)
  if (!canonicalScopeId(ctx.product) || !canonicalScopeId(ctx.workspaceId)) throw new ConnectorInputError('INVALID_MARKET_CONTEXT')
  if (!Array.isArray(ctx.scopes) || ctx.scopes.length === 0 || ctx.scopes.some((scope) => typeof scope !== 'string' || !MARKET_SCOPES.includes(scope as typeof MARKET_SCOPES[number]))) {
    throw new ScopeError('MARKET_SCOPE_DENIED')
  }
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
  const reviewedContext = reviewContext(context)
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const candidate = plan as Record<string, unknown>
  const bindingValue = candidate.binding
  if (!bindingValue || typeof bindingValue !== 'object' || Array.isArray(bindingValue)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  const bindingCandidate = bindingValue as Record<string, unknown>
  const requestedBy = canonicalActor(bindingCandidate.requestedBy)
  const costCapCents = positiveInteger(bindingCandidate.costCapCents)
  const requestedItems = positiveInteger(bindingCandidate.requestedItems)
  if (
    bindingCandidate.product !== reviewedContext.product || bindingCandidate.workspaceId !== reviewedContext.workspaceId || !requestedBy ||
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

function reviewedMarketPlanForReceipt(value: unknown): { reviewed: ReviewedSyntheticMarketPlanDetails; receipt: unknown } {
  const candidate = exactMarketObject(value, ['planId', 'reviewId', 'reviewPacketIntegrityDigest', 'decision', 'reviewedBy', 'reviewedAt', 'mode', 'execution', 'auditHash', 'reviewReceipt'], 'UNEXPECTED_MARKET_REVIEW_RECEIPT_FIELD')
  const planId = candidate.planId
  const reviewId = candidate.reviewId
  const reviewPacketIntegrityDigest = candidate.reviewPacketIntegrityDigest
  const auditHash = candidate.auditHash
  const reviewedBy = canonicalActor(candidate.reviewedBy)
  const reviewedAt = canonicalTimestamp(candidate.reviewedAt)
  if (
    typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId) ||
    typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId) ||
    typeof reviewPacketIntegrityDigest !== 'string' || !DIGEST_PATTERN.test(reviewPacketIntegrityDigest) ||
    typeof auditHash !== 'string' || !DIGEST_PATTERN.test(auditHash) ||
    !reviewedBy || !reviewedAt || candidate.mode !== 'SYNTHETIC' ||
    (candidate.decision !== 'acknowledged' && candidate.decision !== 'rejected')
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_RECEIPT')
  return {
    reviewed: {
      planId,
      reviewId,
      reviewPacketIntegrityDigest,
      decision: candidate.decision,
      reviewedBy,
      reviewedAt,
      mode: 'SYNTHETIC',
      execution: reviewExecutionForReceipt(candidate.execution),
      auditHash,
    },
    receipt: candidate.reviewReceipt,
  }
}

function marketReviewReceiptForValidation(value: unknown): SyntheticMarketReviewReceipt {
  const candidate = exactMarketObject(value, ['version', 'receiptId', 'scopeBinding', 'planId', 'planDigest', 'reviewId', 'reviewPacketIntegrityDigest', 'reviewerDigest', 'decision', 'reviewedAt', 'mode', 'liveStatus', 'execution', 'auditHash', 'integrity'], 'UNEXPECTED_MARKET_REVIEW_RECEIPT_FIELD')
  const scopeBinding = exactMarketObject(candidate.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_MARKET_REVIEW_RECEIPT_SCOPE')
  const integrity = exactMarketObject(candidate.integrity, ['algorithm', 'digest'], 'INVALID_MARKET_REVIEW_RECEIPT_INTEGRITY')
  const receiptId = candidate.receiptId
  const planId = candidate.planId
  const planDigest = candidate.planDigest
  const reviewId = candidate.reviewId
  const reviewPacketIntegrityDigest = candidate.reviewPacketIntegrityDigest
  const reviewerDigest = candidate.reviewerDigest
  const reviewedAt = canonicalTimestamp(candidate.reviewedAt)
  const auditHash = candidate.auditHash
  const productDigest = scopeBinding.productDigest
  const workspaceDigest = scopeBinding.workspaceDigest
  const integrityDigest = integrity.digest
  if (
    candidate.version !== MARKET_REVIEW_RECEIPT_VERSION ||
    typeof receiptId !== 'string' || !REVIEW_RECEIPT_ID_PATTERN.test(receiptId) ||
    typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId) ||
    typeof planDigest !== 'string' || !DIGEST_PATTERN.test(planDigest) ||
    typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId) ||
    typeof reviewPacketIntegrityDigest !== 'string' || !DIGEST_PATTERN.test(reviewPacketIntegrityDigest) ||
    typeof reviewerDigest !== 'string' || !DIGEST_PATTERN.test(reviewerDigest) ||
    typeof productDigest !== 'string' || !DIGEST_PATTERN.test(productDigest) ||
    typeof workspaceDigest !== 'string' || !DIGEST_PATTERN.test(workspaceDigest) ||
    !reviewedAt || candidate.mode !== 'SYNTHETIC' || candidate.liveStatus !== 'LIVE_DISABLED' ||
    (candidate.decision !== 'acknowledged' && candidate.decision !== 'rejected') ||
    typeof auditHash !== 'string' || !DIGEST_PATTERN.test(auditHash) ||
    integrity.algorithm !== 'sha256' || typeof integrityDigest !== 'string' || !DIGEST_PATTERN.test(integrityDigest)
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_RECEIPT')
  return {
    version: MARKET_REVIEW_RECEIPT_VERSION,
    receiptId,
    scopeBinding: { productDigest, workspaceDigest },
    planId,
    planDigest,
    reviewId,
    reviewPacketIntegrityDigest,
    reviewerDigest,
    decision: candidate.decision,
    reviewedAt,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    execution: reviewExecutionForReceipt(candidate.execution),
    auditHash,
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

/**
 * D3 is a pure, local mutation check for an existing D2 result. It does not
 * read the ledger or audit chain, append an event, consume quota, send a
 * handoff, or authorize a market operation.
 */
export function validateSyntheticMarketReviewReceipt(sourcePlan: unknown, value: unknown, context: MarketReviewContext): ReviewedSyntheticMarketPlan {
  const reviewedContext = reviewContext(context)
  if (!reviewedContext.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  const plan = validateSyntheticMarketPlanForReview(sourcePlan, reviewedContext as MarketReviewContext)
  const candidate = reviewedMarketPlanForReceipt(value)
  const receipt = marketReviewReceiptForValidation(candidate.receipt)
  if (
    candidate.reviewed.planId !== plan.id || candidate.reviewed.reviewId !== plan.reviewPacket.reviewId ||
    candidate.reviewed.reviewPacketIntegrityDigest !== plan.reviewPacket.integrity.digest ||
    candidate.reviewed.reviewedBy === plan.binding.requestedBy
  ) throw new ConnectorInputError('MARKET_REVIEW_RECEIPT_PACKET_MISMATCH')
  const expected = reviewReceiptFor(plan, candidate.reviewed)
  if (!canonicallyEqual(receipt, expected)) throw new ConnectorInputError('MARKET_REVIEW_RECEIPT_INTEGRITY_INVALID')
  return { ...candidate.reviewed, reviewReceipt: expected }
}

function reviewAuditEvent(plan: SyntheticMarketPlan, reviewed: ReviewedSyntheticMarketPlan): ConnectorAuditEvent {
  return {
    type: 'connector.market.owner_reviewed',
    connectorId: MARKET_CONNECTOR_ID,
    product: plan.binding.product,
    workspaceId: plan.binding.workspaceId,
    actor: reviewed.reviewedBy,
    scopes: ['market:review'],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: reviewed.reviewedAt,
    detail: {
      planId: plan.id,
      planDigest: plan.integrity.digest,
      reviewId: plan.reviewPacket.reviewId,
      reviewPacketIntegrityDigest: plan.reviewPacket.integrity.digest,
      decision: reviewed.decision,
      execution: 'NOT_AUTHORIZED',
      externalNetwork: false,
      reservation: false,
      booking: false,
      publication: false,
    },
  }
}

function marketReviewAuditWitnessForValidation(value: unknown): SyntheticMarketReviewAuditWitness {
  const candidate = exactMarketObject(value, ['version', 'event', 'previousHash', 'hash'], 'UNEXPECTED_MARKET_REVIEW_AUDIT_WITNESS_FIELD')
  const previousHash = candidate.previousHash
  const hash = candidate.hash
  if (
    candidate.version !== MARKET_REVIEW_AUDIT_WITNESS_VERSION ||
    (previousHash !== null && (typeof previousHash !== 'string' || !DIGEST_PATTERN.test(previousHash))) ||
    typeof hash !== 'string' || !DIGEST_PATTERN.test(hash) ||
    !candidate.event || typeof candidate.event !== 'object' || Array.isArray(candidate.event) ||
    Object.getPrototypeOf(candidate.event) !== Object.prototype || Object.getOwnPropertySymbols(candidate.event).length > 0
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_AUDIT_WITNESS')
  return {
    version: MARKET_REVIEW_AUDIT_WITNESS_VERSION,
    event: candidate.event as ConnectorAuditEvent,
    previousHash,
    hash,
  }
}

/**
 * D4 verifies a caller-held review audit witness without reading an audit
 * store. It reconstructs the D3 receipt and expected owner-review event, then
 * recomputes the one hash-chain link. It does not prove audit persistence or
 * chain history, append an event, consume quota, contact a provider, send a
 * handoff, or authorize a market operation.
 */
export function validateSyntheticMarketReviewAuditWitness(sourcePlan: unknown, value: unknown, witnessValue: unknown, context: MarketReviewContext): SyntheticMarketReviewAuditWitness {
  const reviewedContext = reviewContext(context)
  if (!reviewedContext.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  const plan = validateSyntheticMarketPlanForReview(sourcePlan, reviewedContext as MarketReviewContext)
  const reviewed = validateSyntheticMarketReviewReceipt(plan, value, context)
  const witness = marketReviewAuditWitnessForValidation(witnessValue)
  const expectedEvent = reviewAuditEvent(plan, reviewed)
  if (!canonicallyEqual(witness.event, expectedEvent)) throw new ConnectorInputError('MARKET_REVIEW_AUDIT_WITNESS_EVENT_INVALID')
  const expectedHash = hashAuditEvent(expectedEvent, witness.previousHash)
  if (witness.hash !== expectedHash || reviewed.auditHash !== expectedHash) {
    throw new ConnectorInputError('MARKET_REVIEW_AUDIT_WITNESS_HASH_INVALID')
  }
  return {
    version: MARKET_REVIEW_AUDIT_WITNESS_VERSION,
    event: expectedEvent,
    previousHash: witness.previousHash,
    hash: expectedHash,
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
 * Records one maker/checker-separated terminal decision through an injected
 * process-local synthetic ledger. Neither decision authorizes a reservation,
 * booking, publication, provider call, handoff, or any other execution. This
 * function deliberately has no HTTP route or durable review-state layer.
 */
export async function independentlyReviewSyntheticMarketPlan(plan: SyntheticMarketPlan, decision: MarketReviewDecision, ownerApproved: boolean, reviewer: string, reviewLedger: MarketReviewLedger, context: MarketReviewContext): Promise<ReviewedSyntheticMarketPlan> {
  const reviewedContext = reviewContext(context)
  const reviewedAt = reviewNow(context)
  if (!ownerApproved) throw new OwnerGateError()
  const canonicalReviewer = canonicalActor(reviewer)
  if (!canonicalReviewer) throw new OwnerGateError('MARKET_REVIEWER_REQUIRED')
  if (!reviewedContext.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  if (decision !== 'acknowledged' && decision !== 'rejected') throw new ConnectorInputError('INVALID_MARKET_REVIEW_DECISION')
  if (!reviewLedger || typeof reviewLedger.recordTerminalReview !== 'function') throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
  const validatedPlan = validateSyntheticMarketPlanForReview(plan, reviewedContext as MarketReviewContext)
  if (canonicalReviewer === validatedPlan.binding.requestedBy) throw new MakerCheckerError('MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER')

  const audit = await reviewLedger.recordTerminalReview({
    product: reviewedContext.product,
    workspaceId: reviewedContext.workspaceId,
    planId: validatedPlan.id,
    planDigest: validatedPlan.integrity.digest,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy: canonicalReviewer,
    reviewedAt: reviewedAt.toISOString(),
  })
  if (!audit || typeof audit.hash !== 'string' || !DIGEST_PATTERN.test(audit.hash)) {
    throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
  }
  const reviewed: ReviewedSyntheticMarketPlanDetails = {
    planId: validatedPlan.id,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy: canonicalReviewer,
    reviewedAt: reviewedAt.toISOString(),
    mode: 'SYNTHETIC',
    execution: reviewExecution(),
    auditHash: audit.hash,
  }
  return { ...reviewed, reviewReceipt: reviewReceiptFor(validatedPlan, reviewed) }
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
