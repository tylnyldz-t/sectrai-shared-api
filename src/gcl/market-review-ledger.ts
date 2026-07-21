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

function normalizedEntry(value: MarketReviewLedgerEntry): MarketReviewLedgerEntry {
  if (
    !value || typeof value !== 'object' ||
    Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).some((field) => !ENTRY_FIELDS.includes(field)) ||
    !SCOPE_ID_PATTERN.test(value.product) || !SCOPE_ID_PATTERN.test(value.workspaceId) ||
    !PLAN_ID_PATTERN.test(value.planId) || !REVIEW_ID_PATTERN.test(value.reviewId) ||
    !DIGEST_PATTERN.test(value.planDigest) || !DIGEST_PATTERN.test(value.reviewPacketIntegrityDigest) ||
    (value.decision !== 'acknowledged' && value.decision !== 'rejected') ||
    !ACTOR_PATTERN.test(value.reviewedBy) || value.reviewedBy !== value.reviewedBy.trim()
  ) throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  const reviewedAt = canonicalTimestamp(value.reviewedAt)
  if (!reviewedAt) throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  const digestPrefix = value.planDigest.slice(0, 24)
  if (value.planId !== `synthetic-market-${digestPrefix}` || value.reviewId !== `synthetic-market-review-${digestPrefix}`) {
    throw new ConnectorInputError('INVALID_MARKET_REVIEW_LEDGER_ENTRY')
  }
  return { ...value, reviewedAt }
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
      const audit = await this.auditLog.append(auditEvent(normalized))
      if (!audit || typeof audit.hash !== 'string' || !DIGEST_PATTERN.test(audit.hash)) {
        throw new ConnectorUnavailableError('MARKET_REVIEW_AUDIT_APPEND_INVALID')
      }
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
