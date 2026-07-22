import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
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
export const MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION = 'synthetic-market-review-audit-trail-witness-v1'
export const MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION = 'synthetic-market-review-audit-trail-receipt-v1'
export const MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION = 'synthetic-market-review-evidence-manifest-v1'
const MARKET_SCOPES = ['market:discover', 'market:capacity:quote', 'market:review'] as const
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const PLAN_ID_PATTERN = /^synthetic-market-[a-f0-9]{24}$/
const REVIEW_ID_PATTERN = /^synthetic-market-review-[a-f0-9]{24}$/
const REVIEW_RECEIPT_ID_PATTERN = /^synthetic-market-review-receipt-[a-f0-9]{24}$/
const REVIEW_AUDIT_TRAIL_RECEIPT_ID_PATTERN = /^synthetic-market-review-audit-trail-receipt-[a-f0-9]{24}$/
const REVIEW_EVIDENCE_MANIFEST_ID_PATTERN = /^synthetic-market-review-evidence-manifest-[a-f0-9]{24}$/

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
  { id: 'ADOS-04', control: 'STRICT_PACKET_INTEGRITY', enforcement: 'Review reconstructs the complete canonical plan; D2 rejects unknown, changed, malformed, or replayed packets, D8/D9 harden local ingress, D10 snapshots context and its clock boundary, D11 requires literal owner approval, D12 snapshots the governed-run envelope, D13 snapshots canonical market input across the runner seam, and D3/D4/D5/D6/D7 recheck evidence without a write.' },
  { id: 'ADOS-05', control: 'UNTRUSTED_CONTENT_IS_DATA', enforcement: 'Request values are labelled data-only and cannot become connector instructions.' },
  { id: 'ADOS-06', control: 'OWNER_AND_MAKER_CHECKER', enforcement: 'Only the primitive boolean true passes every market owner gate; a separate canonical owner actor with market:review is required and the plan maker cannot self-review.' },
  { id: 'ADOS-07', control: 'NO_EGRESS_OR_CREDENTIALS', enforcement: 'No network client, provider URL, credential, API key, scheduler, or automatic sync exists in this connector.' },
  { id: 'ADOS-08', control: 'BOUNDED_GOVERNANCE', enforcement: 'Preflight, independent cost and quota limits, and the scoped SHA-256 audit chain remain mandatory; D5 reconstructs one caller-supplied segment, D6/D7 only minimize and recheck derived evidence, D8 leaves a malformed append undecided, D9 rejects shaped host results, D10 bounds review context and clock values, D11 rejects non-boolean approval values, D12 snapshots the runner envelope, and D13 retains the market preflight snapshot before audit, quota, or run seams.' },
  { id: 'ADOS-09', control: 'NO_MARKET_ACTION', enforcement: 'The packet, review receipt, and D4/D5/D6/D7/D8/D9/D10/D11/D12/D13 evidence permanently report no quote, reservation, booking, publication, handoff, or automatic action.' },
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

/**
 * A minimized D5 result for one caller-supplied run/review audit segment. It
 * demonstrates internal continuity only; it is neither durable evidence nor a
 * credential, authorization, execution, or market-action token.
 */
export type SyntheticMarketReviewAuditTrailWitness = {
  version: typeof MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION
  planId: string
  reviewId: string
  requestedAuditHash: string
  succeededAuditHash: string
  reviewAuditHash: string
  predecessorHash: string | null
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION'
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
}

/**
 * A D6 portable, minimized rendering of a reconstructed D5 segment. It is
 * derived evidence only: never a signature, durable audit record, credential,
 * authorization, or market-action capability.
 */
export type SyntheticMarketReviewAuditTrailReceipt = {
  version: typeof MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION
  receiptId: string
  scopeBinding: {
    productDigest: string
    workspaceDigest: string
  }
  planId: string
  reviewId: string
  requestedAuditHash: string
  succeededAuditHash: string
  reviewAuditHash: string
  predecessorHash: string | null
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION'
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
  integrity: {
    algorithm: 'sha256'
    digest: string
  }
}

/**
 * A D7 compact binding of independently reconstructed D3 and D6 evidence.
 * It deliberately omits the request, actor identities, decision, audit
 * hashes, provider details, and every market-action capability.
 */
export type SyntheticMarketReviewEvidenceManifest = {
  version: typeof MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION
  manifestId: string
  scopeBinding: {
    productDigest: string
    workspaceDigest: string
  }
  planId: string
  reviewId: string
  reviewReceiptIntegrityDigest: string
  auditTrailReceiptIntegrityDigest: string
  mode: 'SYNTHETIC'
  liveStatus: 'LIVE_DISABLED'
  state: 'SYNTHETIC_MARKET_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION'
  execution: {
    state: 'NOT_AUTHORIZED'
    externalNetwork: false
    reservation: false
    booking: false
    publication: false
  }
  integrity: {
    algorithm: 'sha256'
    digest: string
  }
}

export type MarketReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'scopes' | 'now'>

/**
 * Internal D10 snapshot. The public context keeps its existing shape, but no
 * later review step reads caller-owned context data after this bounded copy.
 * `now` is necessarily an executable host seam; it is retained only as a
 * verified own data-function and its returned Date is copied before use.
 */
type ReviewedMarketContext = {
  product: string
  workspaceId: string
  scopes: readonly (typeof MARKET_SCOPES[number])[]
  now: () => Date
}

const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const MAX_MARKET_REVIEW_DATA_DEPTH = 16
const MAX_MARKET_REVIEW_DATA_NODES = 256
const MAX_MARKET_REVIEW_OBJECT_FIELDS = 32
const MAX_MARKET_REVIEW_ARRAY_ITEMS = 32

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function ownDataObject(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError(error)
  }
  const fields = Object.getOwnPropertyNames(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const object = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
    object[field] = descriptor.value
  }
  return object
}

function exactObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = ownDataObject(input, 'INVALID_MARKET_REQUEST')
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
  const candidate = ownDataObject(input, 'INVALID_MARKET_REQUEST')
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

function reviewScopes(value: unknown): readonly (typeof MARKET_SCOPES[number])[] {
  if (
    !Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 || !Number.isSafeInteger(value.length) || value.length > MARKET_SCOPES.length
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const scopes: (typeof MARKET_SCOPES[number])[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || !MARKET_SCOPES.includes(descriptor.value as typeof MARKET_SCOPES[number])) {
      throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
    }
    scopes.push(descriptor.value as typeof MARKET_SCOPES[number])
  }
  return scopes
}

/**
 * D10 snapshots review context through descriptors before any semantic read.
 * It never invokes a context getter, an array accessor, or a Proxy trap.
 */
function reviewContext(context: unknown): ReviewedMarketContext {
  const candidate = exactMarketObject(context, ['product', 'workspaceId', 'scopes', 'now'], 'INVALID_MARKET_REVIEW_CONTEXT')
  const product = canonicalScopeId(candidate.product)
  const workspaceId = canonicalScopeId(candidate.workspaceId)
  if (!product || !workspaceId || typeof candidate.now !== 'function' || nodeTypes.isProxy(candidate.now)) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_CONTEXT')
  }
  return { product, workspaceId, scopes: reviewScopes(candidate.scopes), now: candidate.now as () => Date }
}

/** D10 invokes the verified clock once and copies its intrinsic Date value. */
function reviewNow(context: ReviewedMarketContext): Date {
  let value: unknown
  try {
    value = context.now()
  } catch {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  }
  if (!nodeTypes.isDate(value) || nodeTypes.isProxy(value)) throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  const timestamp = Date.prototype.getTime.call(value)
  if (!Number.isFinite(timestamp)) throw new ConnectorInputError('INVALID_MARKET_REVIEW_TIME')
  return new Date(timestamp)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    if (
      nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0 ||
      !Number.isSafeInteger(value.length) || value.length > 1_000 ||
      Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
    ) return '["$unsupportedArrayShape"]'
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return '["$unsupportedSparseArray"]'
      items.push(canonicalJson(descriptor.value))
    }
    return `[${items.join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (nodeTypes.isProxy(record) || Object.getPrototypeOf(record) !== Object.prototype || Object.getOwnPropertySymbols(record).length > 0) return '{"$unsupportedObjectShape":true}'
    const descriptors = Object.getOwnPropertyDescriptors(record)
    const keys = Object.getOwnPropertyNames(record).sort()
    if (keys.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable
    })) return '{"$unsupportedObjectShape":true}'
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(descriptors[key]!.value)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? '"$unsupportedScalar"'
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
  const object = ownDataObject(value, error)
  const names = Object.getOwnPropertyNames(object)
  if (names.length !== fields.length || names.some((field) => !fields.includes(field)) || fields.some((field) => !names.includes(field))) {
    throw new ConnectorInputError(error)
  }
  return object
}

/**
 * D9 snapshots caller-held plan material before any semantic review reads it.
 * It intentionally accepts only a bounded JSON-like own-data tree. This keeps
 * getters, Proxy traps, inherited values, hidden fields, symbol fields, sparse
 * arrays, cyclic aliases, and non-finite values outside canonical review.
 */
function strictMarketReviewData(value: unknown, error: string): unknown {
  const visited = new WeakSet<object>()
  let nodes = 0

  const copy = (candidate: unknown, depth: number): unknown => {
    if (depth > MAX_MARKET_REVIEW_DATA_DEPTH || nodes >= MAX_MARKET_REVIEW_DATA_NODES) throw new ConnectorInputError(error)
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ConnectorInputError(error)
      return candidate
    }
    if (!candidate || typeof candidate !== 'object' || nodeTypes.isProxy(candidate) || visited.has(candidate)) {
      throw new ConnectorInputError(error)
    }
    visited.add(candidate)
    nodes += 1

    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype || Object.getOwnPropertySymbols(candidate).length > 0 || candidate.length > MAX_MARKET_REVIEW_ARRAY_ITEMS) {
        throw new ConnectorInputError(error)
      }
      const names = Object.getOwnPropertyNames(candidate)
      if (names.length !== candidate.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
        throw new ConnectorInputError(error)
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const result: unknown[] = []
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
        result.push(copy(descriptor.value, depth + 1))
      }
      return result
    }

    if (Object.getPrototypeOf(candidate) !== Object.prototype || Object.getOwnPropertySymbols(candidate).length > 0) {
      throw new ConnectorInputError(error)
    }
    const names = Object.getOwnPropertyNames(candidate)
    if (names.length > MAX_MARKET_REVIEW_OBJECT_FIELDS) throw new ConnectorInputError(error)
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    const result = Object.create(Object.prototype) as Record<string, unknown>
    for (const name of names) {
      const descriptor = descriptors[name]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
      Object.defineProperty(result, name, { enumerable: true, value: copy(descriptor.value, depth + 1) })
    }
    return result
  }

  try {
    return copy(value, 0)
  } catch (cause) {
    if (cause instanceof ConnectorInputError) throw cause
    throw new ConnectorInputError(error)
  }
}

function strictMarketReviewPlan(value: unknown): Record<string, unknown> {
  const plan = strictMarketReviewData(value, 'MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new ConnectorInputError('MARKET_REVIEW_PLAN_INTEGRITY_INVALID')
  return plan as Record<string, unknown>
}

/** The host-owned ledger is executable by design, but its member must be a
 * data function, not a getter or Proxy-shaped property. The result is checked
 * separately as exact own data before any review receipt is built. */
function terminalReviewRecorder(value: unknown): (entry: Parameters<MarketReviewLedger['recordTerminalReview']>[0]) => Promise<unknown> {
  try {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
    let current: object | null = value
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (nodeTypes.isProxy(current)) throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
      const descriptor = Object.getOwnPropertyDescriptor(current, 'recordTerminalReview')
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
          throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
        }
        return async (entry) => Reflect.apply(descriptor.value, value, [entry]) as unknown
      }
      current = Object.getPrototypeOf(current)
    }
  } catch (cause) {
    if (cause instanceof ConnectorUnavailableError) throw cause
  }
  throw new ConnectorUnavailableError('MARKET_REVIEW_LEDGER_REQUIRED')
}

function terminalReviewAuditHash(value: unknown): string {
  let audit: Record<string, unknown>
  try {
    audit = exactMarketObject(value, ['hash'], 'MARKET_REVIEW_AUDIT_APPEND_INVALID')
  } catch {
    throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
  }
  if (typeof audit.hash !== 'string' || !DIGEST_PATTERN.test(audit.hash)) {
    throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
  }
  return audit.hash
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
  // Keep direct connector invocation as fail-closed as the governed runner.
  if (ctx.ownerApproved !== true) throw new OwnerGateError()
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
function validateSyntheticMarketPlanForReviewedContext(plan: unknown, reviewedContext: ReviewedMarketContext): SyntheticMarketPlan {
  const candidate = strictMarketReviewPlan(plan)
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

export function validateSyntheticMarketPlanForReview(plan: unknown, context: MarketReviewContext): SyntheticMarketPlan {
  return validateSyntheticMarketPlanForReviewedContext(plan, reviewContext(context))
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
  const plan = validateSyntheticMarketPlanForReview(sourcePlan, context)
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
    !candidate.event || typeof candidate.event !== 'object' || Array.isArray(candidate.event) || nodeTypes.isProxy(candidate.event) ||
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
  const plan = validateSyntheticMarketPlanForReview(sourcePlan, context)
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

type MarketGovernedRunAuditEntry = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function canonicalStringArray(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MARKET_SCOPES.length || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError(error)
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    throw new ConnectorInputError(error)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string') throw new ConnectorInputError(error)
    scopes.push(descriptor.value)
  }
  return scopes
}

function marketGovernedRunAuditEntry(value: unknown, expectedType: 'connector.run.requested' | 'connector.run.succeeded'): MarketGovernedRunAuditEntry {
  const entry = exactMarketObject(value, ['event', 'previousHash', 'hash'], 'UNEXPECTED_MARKET_AUDIT_TRAIL_ENTRY_FIELD')
  const event = exactMarketObject(entry.event, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'], 'UNEXPECTED_MARKET_AUDIT_TRAIL_EVENT_FIELD')
  const detail = exactMarketObject(event.detail, expectedType === 'connector.run.requested' ? [] : ['requestedAuditHash'], expectedType === 'connector.run.requested'
    ? 'UNEXPECTED_MARKET_AUDIT_TRAIL_REQUESTED_DETAIL_FIELD'
    : 'UNEXPECTED_MARKET_AUDIT_TRAIL_SUCCEEDED_DETAIL_FIELD')
  const product = canonicalScopeId(event.product)
  const workspaceId = canonicalScopeId(event.workspaceId)
  const actor = canonicalActor(event.actor)
  const scopes = canonicalStringArray(event.scopes, 'INVALID_MARKET_AUDIT_TRAIL_SCOPES')
  const costCapCents = positiveInteger(event.costCapCents)
  const requestedItems = positiveInteger(event.requestedItems)
  const occurredAt = canonicalTimestamp(event.occurredAt)
  const previousHash = entry.previousHash
  const hash = entry.hash
  const requestedAuditHash = detail.requestedAuditHash
  if (
    event.type !== expectedType || event.connectorId !== MARKET_CONNECTOR_ID || !product || !workspaceId || !actor ||
    !costCapCents || !requestedItems || !occurredAt ||
    (previousHash !== null && (typeof previousHash !== 'string' || !DIGEST_PATTERN.test(previousHash))) ||
    typeof hash !== 'string' || !DIGEST_PATTERN.test(hash) ||
    (expectedType === 'connector.run.succeeded' && (typeof requestedAuditHash !== 'string' || !DIGEST_PATTERN.test(requestedAuditHash)))
  ) throw new ConnectorInputError('INVALID_MARKET_AUDIT_TRAIL')
  return {
    event: {
      type: expectedType,
      connectorId: MARKET_CONNECTOR_ID,
      product,
      workspaceId,
      actor,
      scopes,
      costCapCents,
      requestedItems,
      occurredAt,
      detail: expectedType === 'connector.run.requested' ? {} : { requestedAuditHash },
    },
    previousHash,
    hash,
  }
}

function governedRunMatchesPlan(entry: MarketGovernedRunAuditEntry, plan: SyntheticMarketPlan): boolean {
  return entry.event.product === plan.binding.product &&
    entry.event.workspaceId === plan.binding.workspaceId &&
    entry.event.actor === plan.binding.requestedBy &&
    canonicallyEqual(entry.event.scopes, plan.binding.scopes) &&
    entry.event.costCapCents === plan.binding.costCapCents &&
    entry.event.requestedItems === plan.binding.requestedItems
}

/**
 * D5 read-checks exactly one caller-held requested → succeeded → owner-review
 * audit segment. It verifies only internal continuity: no audit lookup/write,
 * quota use, egress, provider contact, handoff, authorization, or action is
 * performed, and the first predecessor remains unproven caller input.
 */
export function validateSyntheticMarketReviewAuditTrailWitness(sourcePlan: unknown, value: unknown, auditTrail: unknown, context: MarketReviewContext): SyntheticMarketReviewAuditTrailWitness {
  const trail = exactMarketObject(auditTrail, ['requestedRun', 'succeededRun', 'ownerReview'], 'UNEXPECTED_MARKET_AUDIT_TRAIL_FIELD')
  const requested = marketGovernedRunAuditEntry(trail.requestedRun, 'connector.run.requested')
  const succeeded = marketGovernedRunAuditEntry(trail.succeededRun, 'connector.run.succeeded')
  const ownerReview = exactMarketObject(trail.ownerReview, ['event', 'previousHash', 'hash'], 'UNEXPECTED_MARKET_AUDIT_TRAIL_REVIEW_ENTRY_FIELD')
  const plan = validateSyntheticMarketPlanForReview(sourcePlan, context)

  if (requested.hash !== hashAuditEvent(requested.event, requested.previousHash) || succeeded.hash !== hashAuditEvent(succeeded.event, succeeded.previousHash)) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_HASH_INVALID')
  }
  if (!governedRunMatchesPlan(requested, plan) || !governedRunMatchesPlan(succeeded, plan)) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_EVENT_MISMATCH')
  }
  if (succeeded.event.detail.requestedAuditHash !== requested.hash || succeeded.previousHash !== requested.hash) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_CHAIN_MISMATCH')
  }
  if (new Date(requested.event.occurredAt).getTime() > new Date(succeeded.event.occurredAt).getTime()) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_TIME_INVALID')
  }

  const reviewWitness = validateSyntheticMarketReviewAuditWitness(plan, value, {
    version: MARKET_REVIEW_AUDIT_WITNESS_VERSION,
    event: ownerReview.event,
    previousHash: ownerReview.previousHash,
    hash: ownerReview.hash,
  }, context)
  if (reviewWitness.previousHash !== succeeded.hash) throw new ConnectorInputError('MARKET_AUDIT_TRAIL_CHAIN_MISMATCH')
  if (new Date(succeeded.event.occurredAt).getTime() > new Date(reviewWitness.event.occurredAt).getTime()) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_TIME_INVALID')
  }
  return {
    version: MARKET_REVIEW_AUDIT_TRAIL_WITNESS_VERSION,
    planId: plan.id,
    reviewId: plan.reviewPacket.reviewId,
    requestedAuditHash: requested.hash,
    succeededAuditHash: succeeded.hash,
    reviewAuditHash: reviewWitness.hash,
    predecessorHash: requested.previousHash,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION',
    execution: reviewExecution(),
  }
}

function reviewAuditTrailReceiptMaterial(receipt: Omit<SyntheticMarketReviewAuditTrailReceipt, 'receiptId' | 'integrity'>): string {
  return canonicalJson(receipt)
}

function reviewAuditTrailReceiptFor(witness: SyntheticMarketReviewAuditTrailWitness, context: MarketReviewContext): SyntheticMarketReviewAuditTrailReceipt {
  const scope = reviewContext(context)
  const material: Omit<SyntheticMarketReviewAuditTrailReceipt, 'receiptId' | 'integrity'> = {
    version: MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION,
    scopeBinding: {
      productDigest: sha256(scope.product),
      workspaceDigest: sha256(scope.workspaceId),
    },
    planId: witness.planId,
    reviewId: witness.reviewId,
    requestedAuditHash: witness.requestedAuditHash,
    succeededAuditHash: witness.succeededAuditHash,
    reviewAuditHash: witness.reviewAuditHash,
    predecessorHash: witness.predecessorHash,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION',
    execution: reviewExecution(),
  }
  const integrityDigest = sha256(reviewAuditTrailReceiptMaterial(material))
  return {
    ...material,
    receiptId: `synthetic-market-review-audit-trail-receipt-${sha256(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

function marketReviewAuditTrailReceiptForValidation(value: unknown): SyntheticMarketReviewAuditTrailReceipt {
  const receipt = exactMarketObject(value, ['version', 'receiptId', 'scopeBinding', 'planId', 'reviewId', 'requestedAuditHash', 'succeededAuditHash', 'reviewAuditHash', 'predecessorHash', 'mode', 'liveStatus', 'state', 'execution', 'integrity'], 'UNEXPECTED_MARKET_AUDIT_TRAIL_RECEIPT_FIELD')
  const scopeBinding = exactMarketObject(receipt.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_MARKET_AUDIT_TRAIL_RECEIPT_SCOPE')
  const integrity = exactMarketObject(receipt.integrity, ['algorithm', 'digest'], 'INVALID_MARKET_AUDIT_TRAIL_RECEIPT_INTEGRITY')
  const receiptId = receipt.receiptId
  const planId = receipt.planId
  const reviewId = receipt.reviewId
  const requestedAuditHash = receipt.requestedAuditHash
  const succeededAuditHash = receipt.succeededAuditHash
  const reviewAuditHash = receipt.reviewAuditHash
  const predecessorHash = receipt.predecessorHash
  const productDigest = scopeBinding.productDigest
  const workspaceDigest = scopeBinding.workspaceDigest
  const integrityDigest = integrity.digest
  if (
    receipt.version !== MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION ||
    typeof receiptId !== 'string' || !REVIEW_AUDIT_TRAIL_RECEIPT_ID_PATTERN.test(receiptId) ||
    typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId) ||
    typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId) ||
    typeof requestedAuditHash !== 'string' || !DIGEST_PATTERN.test(requestedAuditHash) ||
    typeof succeededAuditHash !== 'string' || !DIGEST_PATTERN.test(succeededAuditHash) ||
    typeof reviewAuditHash !== 'string' || !DIGEST_PATTERN.test(reviewAuditHash) ||
    (predecessorHash !== null && (typeof predecessorHash !== 'string' || !DIGEST_PATTERN.test(predecessorHash))) ||
    typeof productDigest !== 'string' || !DIGEST_PATTERN.test(productDigest) ||
    typeof workspaceDigest !== 'string' || !DIGEST_PATTERN.test(workspaceDigest) ||
    receipt.mode !== 'SYNTHETIC' || receipt.liveStatus !== 'LIVE_DISABLED' ||
    receipt.state !== 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION' ||
    integrity.algorithm !== 'sha256' || typeof integrityDigest !== 'string' || !DIGEST_PATTERN.test(integrityDigest)
  ) throw new ConnectorInputError('INVALID_MARKET_AUDIT_TRAIL_RECEIPT')
  return {
    version: MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION,
    receiptId,
    scopeBinding: { productDigest, workspaceDigest },
    planId,
    reviewId,
    requestedAuditHash,
    succeededAuditHash,
    reviewAuditHash,
    predecessorHash,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'SYNTHETIC_MARKET_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION',
    execution: reviewExecutionForReceipt(receipt.execution),
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

/**
 * D6 derives a minimized receipt only after D5 reconstructs the caller-held
 * segment. This library-only helper reads and writes no storage, quota, audit,
 * route, provider, handoff, or market-action state.
 */
export function createSyntheticMarketReviewAuditTrailReceipt(sourcePlan: unknown, value: unknown, auditTrail: unknown, context: MarketReviewContext): SyntheticMarketReviewAuditTrailReceipt {
  return reviewAuditTrailReceiptFor(validateSyntheticMarketReviewAuditTrailWitness(sourcePlan, value, auditTrail, context), context)
}

/**
 * D6 rechecks a caller-held minimized receipt by rebuilding D5's fixed
 * witness. Its SHA-256 value detects mutation only; it is never a signature,
 * credential, durable audit proof, authorization, or execution token.
 */
export function validateSyntheticMarketReviewAuditTrailReceipt(sourcePlan: unknown, value: unknown, auditTrail: unknown, receiptValue: unknown, context: MarketReviewContext): SyntheticMarketReviewAuditTrailReceipt {
  const receipt = marketReviewAuditTrailReceiptForValidation(receiptValue)
  const expected = createSyntheticMarketReviewAuditTrailReceipt(sourcePlan, value, auditTrail, context)
  const material: Omit<SyntheticMarketReviewAuditTrailReceipt, 'receiptId' | 'integrity'> = {
    version: receipt.version,
    scopeBinding: receipt.scopeBinding,
    planId: receipt.planId,
    reviewId: receipt.reviewId,
    requestedAuditHash: receipt.requestedAuditHash,
    succeededAuditHash: receipt.succeededAuditHash,
    reviewAuditHash: receipt.reviewAuditHash,
    predecessorHash: receipt.predecessorHash,
    mode: receipt.mode,
    liveStatus: receipt.liveStatus,
    state: receipt.state,
    execution: receipt.execution,
  }
  if (receipt.integrity.digest !== sha256(reviewAuditTrailReceiptMaterial(material)) || !canonicallyEqual(receipt, expected)) {
    throw new ConnectorInputError('MARKET_AUDIT_TRAIL_RECEIPT_INTEGRITY_INVALID')
  }
  return expected
}

function reviewEvidenceManifestMaterial(manifest: Omit<SyntheticMarketReviewEvidenceManifest, 'manifestId' | 'integrity'>): string {
  return canonicalJson(manifest)
}

function reviewEvidenceManifestFor(reviewed: ReviewedSyntheticMarketPlan, auditTrailReceipt: SyntheticMarketReviewAuditTrailReceipt, context: MarketReviewContext): SyntheticMarketReviewEvidenceManifest {
  const scope = reviewContext(context)
  const material: Omit<SyntheticMarketReviewEvidenceManifest, 'manifestId' | 'integrity'> = {
    version: MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION,
    scopeBinding: {
      productDigest: sha256(scope.product),
      workspaceDigest: sha256(scope.workspaceId),
    },
    planId: reviewed.planId,
    reviewId: reviewed.reviewId,
    reviewReceiptIntegrityDigest: reviewed.reviewReceipt.integrity.digest,
    auditTrailReceiptIntegrityDigest: auditTrailReceipt.integrity.digest,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'SYNTHETIC_MARKET_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION',
    execution: reviewExecution(),
  }
  const integrityDigest = sha256(reviewEvidenceManifestMaterial(material))
  return {
    ...material,
    manifestId: `synthetic-market-review-evidence-manifest-${sha256(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

function marketReviewEvidenceManifestForValidation(value: unknown): SyntheticMarketReviewEvidenceManifest {
  const manifest = exactMarketObject(value, ['version', 'manifestId', 'scopeBinding', 'planId', 'reviewId', 'reviewReceiptIntegrityDigest', 'auditTrailReceiptIntegrityDigest', 'mode', 'liveStatus', 'state', 'execution', 'integrity'], 'UNEXPECTED_MARKET_REVIEW_EVIDENCE_MANIFEST_FIELD')
  const scopeBinding = exactMarketObject(manifest.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_MARKET_REVIEW_EVIDENCE_MANIFEST_SCOPE')
  const integrity = exactMarketObject(manifest.integrity, ['algorithm', 'digest'], 'INVALID_MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY')
  const manifestId = manifest.manifestId
  const planId = manifest.planId
  const reviewId = manifest.reviewId
  const reviewReceiptIntegrityDigest = manifest.reviewReceiptIntegrityDigest
  const auditTrailReceiptIntegrityDigest = manifest.auditTrailReceiptIntegrityDigest
  const productDigest = scopeBinding.productDigest
  const workspaceDigest = scopeBinding.workspaceDigest
  const integrityDigest = integrity.digest
  if (
    manifest.version !== MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION ||
    typeof manifestId !== 'string' || !REVIEW_EVIDENCE_MANIFEST_ID_PATTERN.test(manifestId) ||
    typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId) ||
    typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId) ||
    typeof reviewReceiptIntegrityDigest !== 'string' || !DIGEST_PATTERN.test(reviewReceiptIntegrityDigest) ||
    typeof auditTrailReceiptIntegrityDigest !== 'string' || !DIGEST_PATTERN.test(auditTrailReceiptIntegrityDigest) ||
    typeof productDigest !== 'string' || !DIGEST_PATTERN.test(productDigest) ||
    typeof workspaceDigest !== 'string' || !DIGEST_PATTERN.test(workspaceDigest) ||
    manifest.mode !== 'SYNTHETIC' || manifest.liveStatus !== 'LIVE_DISABLED' ||
    manifest.state !== 'SYNTHETIC_MARKET_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION' ||
    integrity.algorithm !== 'sha256' || typeof integrityDigest !== 'string' || !DIGEST_PATTERN.test(integrityDigest)
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_EVIDENCE_MANIFEST')
  return {
    version: MARKET_REVIEW_EVIDENCE_MANIFEST_VERSION,
    manifestId,
    scopeBinding: { productDigest, workspaceDigest },
    planId,
    reviewId,
    reviewReceiptIntegrityDigest,
    auditTrailReceiptIntegrityDigest,
    mode: 'SYNTHETIC',
    liveStatus: 'LIVE_DISABLED',
    state: 'SYNTHETIC_MARKET_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION',
    execution: reviewExecutionForReceipt(manifest.execution),
    integrity: { algorithm: 'sha256', digest: integrityDigest },
  }
}

/**
 * D7 derives a compact evidence manifest only after D3 and D6 independently
 * reconstruct the same caller-held review and audit segment. It is
 * library-only and read-only: no storage read/write, quota use, route,
 * provider contact, handoff, notification, or market action occurs.
 */
export function createSyntheticMarketReviewEvidenceManifest(sourcePlan: unknown, value: unknown, auditTrail: unknown, context: MarketReviewContext): SyntheticMarketReviewEvidenceManifest {
  const auditTrailReceipt = createSyntheticMarketReviewAuditTrailReceipt(sourcePlan, value, auditTrail, context)
  const reviewed = validateSyntheticMarketReviewReceipt(sourcePlan, value, context)
  return reviewEvidenceManifestFor(reviewed, auditTrailReceipt, context)
}

/**
 * D7 checks a caller-held manifest against freshly reconstructed D3 and D6
 * evidence. Its SHA-256 value is unkeyed mutation evidence, never a
 * signature, credential, durable proof, authorization, or execution token.
 */
export function validateSyntheticMarketReviewEvidenceManifest(sourcePlan: unknown, value: unknown, auditTrail: unknown, manifestValue: unknown, context: MarketReviewContext): SyntheticMarketReviewEvidenceManifest {
  const manifest = marketReviewEvidenceManifestForValidation(manifestValue)
  const expected = createSyntheticMarketReviewEvidenceManifest(sourcePlan, value, auditTrail, context)
  const material: Omit<SyntheticMarketReviewEvidenceManifest, 'manifestId' | 'integrity'> = {
    version: manifest.version,
    scopeBinding: manifest.scopeBinding,
    planId: manifest.planId,
    reviewId: manifest.reviewId,
    reviewReceiptIntegrityDigest: manifest.reviewReceiptIntegrityDigest,
    auditTrailReceiptIntegrityDigest: manifest.auditTrailReceiptIntegrityDigest,
    mode: manifest.mode,
    liveStatus: manifest.liveStatus,
    state: manifest.state,
    execution: manifest.execution,
  }
  if (manifest.integrity.digest !== sha256(reviewEvidenceManifestMaterial(material)) || !canonicallyEqual(manifest, expected)) {
    throw new ConnectorInputError('MARKET_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_INVALID')
  }
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

  /**
   * D13 returns the newly parsed scalar-only request rather than retaining a
   * caller-owned input object. The governed runner passes that snapshot to
   * `run` after its asynchronous audit and quota boundaries.
   */
  preflight(input: SyntheticMarketInput, ctx: ConnectorRunContext): SyntheticMarketInput {
    return validatedRequest(this.config, input, ctx)
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
  // D11: reject every truthy lookalike before reading caller-held context,
  // plan, ledger, or the narrow clock seam.
  if (ownerApproved !== true) throw new OwnerGateError()
  const reviewedContext = reviewContext(context)
  const canonicalReviewer = canonicalActor(reviewer)
  if (!canonicalReviewer) throw new OwnerGateError('MARKET_REVIEWER_REQUIRED')
  if (!reviewedContext.scopes.includes('market:review')) throw new ScopeError('MARKET_REVIEW_SCOPE_REQUIRED')
  if (decision !== 'acknowledged' && decision !== 'rejected') throw new ConnectorInputError('INVALID_MARKET_REVIEW_DECISION')
  const recordTerminalReview = terminalReviewRecorder(reviewLedger)
  const validatedPlan = validateSyntheticMarketPlanForReviewedContext(plan, reviewedContext)
  if (canonicalReviewer === validatedPlan.binding.requestedBy) throw new MakerCheckerError('MARKET_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  // Invoke the only executable context seam after every static review gate.
  // Its copied value cannot alter the already-snapshotted context or plan.
  const reviewedAt = reviewNow(reviewedContext)

  const auditHash = terminalReviewAuditHash(await recordTerminalReview({
    product: reviewedContext.product,
    workspaceId: reviewedContext.workspaceId,
    planId: validatedPlan.id,
    planDigest: validatedPlan.integrity.digest,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy: canonicalReviewer,
    reviewedAt: reviewedAt.toISOString(),
  }))
  const reviewed: ReviewedSyntheticMarketPlanDetails = {
    planId: validatedPlan.id,
    reviewId: validatedPlan.reviewPacket.reviewId,
    reviewPacketIntegrityDigest: validatedPlan.reviewPacket.integrity.digest,
    decision,
    reviewedBy: canonicalReviewer,
    reviewedAt: reviewedAt.toISOString(),
    mode: 'SYNTHETIC',
    execution: reviewExecution(),
    auditHash,
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
