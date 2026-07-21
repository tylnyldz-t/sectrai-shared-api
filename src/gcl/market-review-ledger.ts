import { types as nodeTypes } from 'node:util'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export type MarketReviewDecision = 'acknowledged' | 'rejected'

/**
 * The terminal receipt is intentionally a narrow audit record. It is not a
 * signature, authorization, reservation, booking, publication, or handoff.
 */
export type MarketReviewLedgerEntry = {
  product: string
  workspaceId: string
  planId: string
  planDigest: string
  reviewId: string
  reviewPacketIntegrityDigest: string
  decision: MarketReviewDecision
  reviewedBy: string
  reviewedAt: string
}

export interface MarketReviewLedger {
  recordTerminalReview(entry: MarketReviewLedgerEntry): Promise<{ hash: string }>
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const PLAN_ID_PATTERN = /^synthetic-market-[a-f0-9]{24}$/
const REVIEW_ID_PATTERN = /^synthetic-market-review-[a-f0-9]{24}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const ENTRY_FIELDS = ['product', 'workspaceId', 'planId', 'planDigest', 'reviewId', 'reviewPacketIntegrityDigest', 'decision', 'reviewedBy', 'reviewedAt']

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null
}

/**
 * Ledger ingress is an untrusted in-process seam: injected ledgers and audit
 * logs can be implemented outside this module. Accepting inherited, hidden,
 * accessor, or Proxy-shaped objects here would make the terminal decision
 * depend on behavior rather than the bounded data record we intend to audit.
 */
function ownDataObject(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0
  ) throw new ConnectorInputError(error)
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== fields.length || names.some((field) => !fields.includes(field)) || fields.some((field) => !names.includes(field))) {
    throw new ConnectorInputError(error)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const data = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    const descriptor = descriptors[field]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorInputError(error)
    data[field] = descriptor.value
  }
  return data
}

function normalizedEntry(value: unknown): MarketReviewLedgerEntry {
  const candidate = ownDataObject(value, ENTRY_FIELDS, 'INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  const product = candidate.product
  const workspaceId = candidate.workspaceId
  const planId = candidate.planId
  const planDigest = candidate.planDigest
  const reviewId = candidate.reviewId
  const reviewPacketIntegrityDigest = candidate.reviewPacketIntegrityDigest
  const decision = candidate.decision
  const reviewedBy = candidate.reviewedBy
  if (
    typeof product !== 'string' || typeof workspaceId !== 'string' || typeof planId !== 'string' ||
    typeof planDigest !== 'string' || typeof reviewId !== 'string' ||
    typeof reviewPacketIntegrityDigest !== 'string' || typeof reviewedBy !== 'string' ||
    !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId) ||
    !PLAN_ID_PATTERN.test(planId) || !REVIEW_ID_PATTERN.test(reviewId) ||
    !DIGEST_PATTERN.test(planDigest) || !DIGEST_PATTERN.test(reviewPacketIntegrityDigest) ||
    (decision !== 'acknowledged' && decision !== 'rejected') ||
    !ACTOR_PATTERN.test(reviewedBy) || reviewedBy !== reviewedBy.trim()
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  const reviewedAt = canonicalTimestamp(candidate.reviewedAt)
  if (!reviewedAt) throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  const digestPrefix = planDigest.slice(0, 24)
  if (planId !== `synthetic-market-${digestPrefix}` || reviewId !== `synthetic-market-review-${digestPrefix}`) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  }
  return { product, workspaceId, planId, planDigest, reviewId, reviewPacketIntegrityDigest, decision, reviewedBy, reviewedAt }
}

function auditAppendResult(value: unknown): { hash: string } {
  const candidate = ownDataObject(value, ['hash'], 'MARKET_REVIEW_AUDIT_APPEND_INVALID')
  if (typeof candidate.hash !== 'string' || !DIGEST_PATTERN.test(candidate.hash)) {
    throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
  }
  return { hash: candidate.hash }
}

function ledgerKey(entry: MarketReviewLedgerEntry): string {
  return `${entry.product}:${entry.workspaceId}:${entry.planId}:${entry.reviewPacketIntegrityDigest}`
}

function auditEvent(entry: MarketReviewLedgerEntry): ConnectorAuditEvent {
  return {
    type: 'connector.market.owner_reviewed',
    connectorId: 'market',
    product: entry.product,
    workspaceId: entry.workspaceId,
    actor: entry.reviewedBy,
    scopes: ['market:review'],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: entry.reviewedAt,
    detail: {
      planId: entry.planId,
      planDigest: entry.planDigest,
      reviewId: entry.reviewId,
      reviewPacketIntegrityDigest: entry.reviewPacketIntegrityDigest,
      decision: entry.decision,
      execution: 'NOT_AUTHORIZED',
      externalNetwork: false,
      reservation: false,
      booking: false,
      publication: false,
    },
  }
}

/**
 * Process-local D2 replay guard for the synthetic review seam. It is not
 * durable state and must never be treated as a cross-process approval ledger.
 * A failed or malformed audit append leaves the key undecided so the caller
 * gets a fail-closed error rather than a phantom terminal receipt.
 */
export class InMemorySyntheticMarketReviewLedger implements MarketReviewLedger {
  readonly entries: MarketReviewLedgerEntry[] = []
  private readonly decisions = new Map<string, MarketReviewLedgerEntry>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly auditLog: AuditLog) {}

  async recordTerminalReview(entry: MarketReviewLedgerEntry): Promise<{ hash: string }> {
    const normalized = normalizedEntry(entry)
    const key = ledgerKey(normalized)
    return this.exclusively(key, async () => {
      if (this.decisions.has(key)) throw new ConnectorInputError('MARKET_REVIEW_ALREADY_DECIDED')
      const audit = auditAppendResult(await this.auditLog.append(auditEvent(normalized)))
      this.decisions.set(key, normalized)
      this.entries.push(normalized)
      return audit
    })
  }

  private async exclusively<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
