import { appendAuditEvent, GCL_AUDIT_MODULE_ID } from './audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import type { GclPersistence } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

/** Existing Record storage is reused; no image-review migration is introduced. */
export const GCL_IMAGE_OWNER_REVIEW_MODULE_ID = 'gcl-image-owner-review'

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const IMAGE_SCOPE = 'image:generate'

export type ImageOwnerReviewDecisionEvent = ConnectorAuditEvent & {
  type: 'connector.artifact.owner_liked' | 'connector.artifact.owner_rejected'
}

export interface ImageOwnerReviewLedger {
  /** Atomically records exactly one terminal decision for a candidate. */
  appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }>
}

type StoredReviewReceipt = {
  schema: 'gcl-image-owner-review-v1'
  candidateId: string
  correlationId: string
  decision: 'liked' | 'rejected'
  publication: 'blocked'
  issuanceAuditHash: string
  runAuditHash: string
  auditHash: string
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** Reject accessors, symbols, arrays, and non-plain objects before reading values. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

/** Reject sparse, accessor-bearing, or extended scope arrays before reading a scope. */
function plainArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || Object.keys(descriptors).length !== length + 1) return null
    const items: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || descriptor.get || descriptor.set) return null
      items.push(descriptor.value)
    }
    return items
  } catch { return null }
}

function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) }
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function imageScope(value: unknown): boolean {
  const scopes = plainArray(value)
  return Boolean(scopes && scopes.length === 1 && scopes[0] === IMAGE_SCOPE)
}

function storedReceipt(value: unknown): StoredReviewReceipt | null {
  const receipt = plainRecord(value)
  if (!receipt || !exactKeys(receipt, ['schema', 'candidateId', 'correlationId', 'decision', 'publication', 'issuanceAuditHash', 'runAuditHash', 'auditHash'])) return null
  if (receipt.schema !== 'gcl-image-owner-review-v1' || typeof receipt.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(receipt.candidateId) || !safeIdentifier(receipt.correlationId) || (receipt.decision !== 'liked' && receipt.decision !== 'rejected') || receipt.publication !== 'blocked' || typeof receipt.issuanceAuditHash !== 'string' || !HASH_PATTERN.test(receipt.issuanceAuditHash) || typeof receipt.runAuditHash !== 'string' || !HASH_PATTERN.test(receipt.runAuditHash) || typeof receipt.auditHash !== 'string' || !HASH_PATTERN.test(receipt.auditHash)) return null
  return receipt as StoredReviewReceipt
}

function eventDecision(event: ImageOwnerReviewDecisionEvent): 'liked' | 'rejected' {
  return event.type === 'connector.artifact.owner_liked' ? 'liked' : 'rejected'
}

function assertImageOwnerReviewEvent(event: unknown): asserts event is ImageOwnerReviewDecisionEvent {
  const value = plainRecord(event)
  if (!value || !exactKeys(value, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
  if ((value.type !== 'connector.artifact.owner_liked' && value.type !== 'connector.artifact.owner_rejected') || value.connectorId !== 'image-tti' || !safeIdentifier(value.product) || !safeIdentifier(value.workspaceId) || !safeIdentifier(value.actor) || !safeIdentifier(value.correlationId) || !imageScope(value.scopes) || value.costCapCents !== 0 || value.requestedItems !== 1 || !canonicalTimestamp(value.occurredAt)) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')

  const detail = plainRecord(value.detail)
  const liked = value.type === 'connector.artifact.owner_liked'
  const keys = liked
    ? ['candidateId', 'maker', 'publication', 'issuanceAuditHash', 'runAuditHash', 'artifactId', 'ownerReview']
    : ['candidateId', 'maker', 'publication', 'issuanceAuditHash', 'runAuditHash', 'reviewId', 'ownerReview', 'reason']
  if (!detail || !exactKeys(detail, keys) || typeof detail.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(detail.candidateId) || !safeIdentifier(detail.maker) || detail.publication !== 'blocked' || typeof detail.issuanceAuditHash !== 'string' || !HASH_PATTERN.test(detail.issuanceAuditHash) || typeof detail.runAuditHash !== 'string' || !HASH_PATTERN.test(detail.runAuditHash) || detail.ownerReview !== (liked ? 'liked' : 'rejected')) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
  if (liked && detail.artifactId !== `owner-liked-${detail.candidateId}`) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
  if (!liked && (detail.reviewId !== `owner-rejected-${detail.candidateId}` || (detail.reason !== 'NOT_SUITABLE' && detail.reason !== 'SAFETY_CONCERN' && detail.reason !== 'NEEDS_REVISION'))) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
}

function decisionKey(event: ImageOwnerReviewDecisionEvent): string {
  return JSON.stringify([event.product, event.workspaceId, event.correlationId, event.detail.candidateId])
}

function receiptFor(event: ImageOwnerReviewDecisionEvent, auditHash: string): StoredReviewReceipt {
  return {
    schema: 'gcl-image-owner-review-v1',
    candidateId: event.detail.candidateId as string,
    correlationId: event.correlationId,
    decision: eventDecision(event),
    publication: 'blocked',
    issuanceAuditHash: event.detail.issuanceAuditHash as string,
    runAuditHash: event.detail.runAuditHash as string,
    auditHash,
  }
}

/**
 * Durable terminal-decision store. It serializes on the same audit-chain lock,
 * so a successful decision has exactly one matching audit event and receipt.
 * It stores IDs, closed decision codes, and hashes only—never prompt or media.
 */
export class PrismaImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  constructor(private readonly prisma: GclPersistence) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    assertImageOwnerReviewEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID },
        select: { values: true },
      })
      for (const record of records) {
        const receipt = storedReceipt(record.values)
        if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
        if (receipt.candidateId === event.detail.candidateId && receipt.correlationId === event.correlationId) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
      }
      const audit = await appendAuditEvent(transaction, event)
      await transaction.record.create({
        data: {
          product: event.product,
          workspaceId: event.workspaceId,
          moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID,
          values: receiptFor(event, audit.hash),
          status: 'terminal',
          createdBy: 'gcl-image-review',
        },
      })
      return audit
    })
  }
}

/** Test-only seam; deployed hosts must use the durable Record-backed ledger. */
export class InMemoryImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  private readonly decisions = new Map<string, 'in-flight' | 'final'>()

  constructor(private readonly auditLog: AuditLog) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    assertImageOwnerReviewEvent(event)
    if (!this.auditLog || typeof this.auditLog.append !== 'function') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    const key = decisionKey(event)
    const state = this.decisions.get(key)
    if (state === 'final') throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
    if (state === 'in-flight') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_IN_FLIGHT')
    this.decisions.set(key, 'in-flight')
    try {
      const audit = await this.auditLog.append(event)
      if (!audit || typeof audit.hash !== 'string' || !HASH_PATTERN.test(audit.hash)) {
        this.decisions.set(key, 'final')
        throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
      }
      this.decisions.set(key, 'final')
      return audit
    } catch (error) {
      if (this.decisions.get(key) === 'in-flight') this.decisions.delete(key)
      throw error
    }
  }
}
