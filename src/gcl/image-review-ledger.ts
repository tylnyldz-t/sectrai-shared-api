import { appendAuditEvent, GCL_AUDIT_MODULE_ID, verifyAuditChain } from './audit.js'
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

/**
 * Durable, redacted evidence for one terminal decision. A liked synthetic
 * artifact is not returned until this exact receipt is re-read from the
 * ledger and bound to its audit, issuance, and governed-run lineage.
 */
export type ImageOwnerReviewDecisionProof = {
  auditHash: string
  issuanceAuditHash: string
  runAuditHash: string
}

export interface ImageOwnerReviewLedger {
  /** Atomically records exactly one terminal decision for a candidate. */
  appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }>
  /** Re-reads the terminal receipt and proves its complete governed lineage. */
  assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof>
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
  const actual = Object.getOwnPropertyNames(value)
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

/** Resolve the test audit append capability without invoking an accessor. */
function dataMethod(value: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
    let target: object | null = value
    const visited = new Set<object>()
    while (target && target !== Object.prototype && target !== Function.prototype && !visited.has(target)) {
      visited.add(target)
      const descriptor = Object.getOwnPropertyDescriptor(target, name)
      if (descriptor) return !descriptor.get && !descriptor.set && typeof descriptor.value === 'function' ? descriptor.value as (...args: unknown[]) => unknown : null
      target = Object.getPrototypeOf(target)
    }
    return null
  } catch { return null }
}

/** The in-memory seam exposes test entries as an own data property only. */
function auditEntries(value: unknown): readonly unknown[] | null {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, 'entries')
    return descriptor && !descriptor.get && !descriptor.set && Array.isArray(descriptor.value) ? descriptor.value : null
  } catch { return null }
}

/** A malformed test-seam response is unavailable; never evaluate a hash getter. */
function returnedAuditHash(value: unknown): string | null {
  const audit = plainRecord(value)
  return audit && exactKeys(audit, ['hash']) && typeof audit.hash === 'string' && HASH_PATTERN.test(audit.hash) ? audit.hash : null
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

type IssuanceLineage = {
  actor: string
  occurredAt: number
  candidateSetDigest: string
  candidateCount: number
  candidateIds: ReadonlySet<string>
  runAuditHash: string
}

function safeHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }

/**
 * The candidate ledger owns issuance writes, but a terminal-review ledger
 * must independently re-check that a supplied issuance hash is real before
 * accepting a direct append. Otherwise an arbitrary caller could create an
 * orphan terminal record through this public persistence seam.
 */
function issuanceLineage(value: unknown, event: ImageOwnerReviewDecisionEvent): IssuanceLineage | null {
  const issuance = plainRecord(value)
  if (!issuance || !exactKeys(issuance, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) return null
  if (issuance.type !== 'connector.artifact.candidates_issued' || issuance.connectorId !== 'image-tti' || issuance.product !== event.product || issuance.workspaceId !== event.workspaceId || issuance.correlationId !== event.correlationId || !safeIdentifier(issuance.actor) || !imageScope(issuance.scopes) || issuance.costCapCents !== 0 || typeof issuance.requestedItems !== 'number' || !Number.isSafeInteger(issuance.requestedItems) || issuance.requestedItems < 1 || !canonicalTimestamp(issuance.occurredAt)) return null

  const detail = plainRecord(issuance.detail)
  const entries = detail ? plainArray(detail.candidates) : null
  if (!detail || !exactKeys(detail, ['candidateSetDigest', 'candidateCount', 'candidates', 'publication', 'runAuditHash']) || !safeHash(detail.candidateSetDigest) || typeof detail.candidateCount !== 'number' || !Number.isSafeInteger(detail.candidateCount) || detail.candidateCount < 1 || detail.publication !== 'blocked' || !safeHash(detail.runAuditHash) || !entries || entries.length !== detail.candidateCount || entries.length !== issuance.requestedItems) return null
  const candidateIds: string[] = []
  for (const entry of entries) {
    const candidate = plainRecord(entry)
    if (!candidate || !exactKeys(candidate, ['candidateId', 'fingerprint']) || typeof candidate.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidate.candidateId) || !safeHash(candidate.fingerprint)) return null
    candidateIds.push(candidate.candidateId)
  }
  if (new Set(candidateIds).size !== candidateIds.length) return null
  return {
    actor: issuance.actor,
    occurredAt: new Date(issuance.occurredAt).getTime(),
    candidateSetDigest: detail.candidateSetDigest,
    candidateCount: detail.candidateCount,
    candidateIds: new Set(candidateIds),
    runAuditHash: detail.runAuditHash,
  }
}

function isBoundSourceRun(value: unknown, hash: string, event: ImageOwnerReviewDecisionEvent, issuance: IssuanceLineage): boolean {
  const source = plainRecord(value)
  if (!source || source.type !== 'connector.run.succeeded' || source.connectorId !== 'image-tti' || source.product !== event.product || source.workspaceId !== event.workspaceId || source.actor !== issuance.actor || source.correlationId !== event.correlationId || !imageScope(source.scopes) || typeof source.costCapCents !== 'number' || !Number.isSafeInteger(source.costCapCents) || source.costCapCents < 1 || source.requestedItems !== issuance.candidateCount || !canonicalTimestamp(source.occurredAt)) return false
  const detail = plainRecord(source.detail)
  return hash === issuance.runAuditHash && Boolean(detail && detail.syntheticCandidateSetDigest === issuance.candidateSetDigest)
}

/** Fail closed unless the terminal event has an exact issued candidate and source run. */
function assertDecisionLineage(records: readonly unknown[], event: ImageOwnerReviewDecisionEvent): void {
  const auditRecords = verifyAuditChain(records)
  const issuanceRecord = auditRecords.find((record) => record.hash === event.detail.issuanceAuditHash)
  const issuance = issuanceRecord ? issuanceLineage(issuanceRecord.event, event) : null
  const source = issuance ? auditRecords.find((record) => isBoundSourceRun(record.event, record.hash, event, issuance)) : undefined
  const decisionTime = new Date(event.occurredAt).getTime()
  if (!issuance || !source || event.detail.runAuditHash !== issuance.runAuditHash || event.detail.maker !== issuance.actor || !issuance.candidateIds.has(event.detail.candidateId as string) || source.event.occurredAt === undefined || issuance.occurredAt > decisionTime || new Date(source.event.occurredAt).getTime() > issuance.occurredAt) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
}

function sameDecisionEvent(left: ImageOwnerReviewDecisionEvent, right: ImageOwnerReviewDecisionEvent): boolean {
  if (left.type !== right.type || left.connectorId !== right.connectorId || left.product !== right.product || left.workspaceId !== right.workspaceId || left.actor !== right.actor || left.correlationId !== right.correlationId || left.costCapCents !== right.costCapCents || left.requestedItems !== right.requestedItems || left.occurredAt !== right.occurredAt || !imageScope(left.scopes) || !imageScope(right.scopes)) return false
  const leftDetail = left.detail
  const rightDetail = right.detail
  if (leftDetail.candidateId !== rightDetail.candidateId || leftDetail.maker !== rightDetail.maker || leftDetail.publication !== rightDetail.publication || leftDetail.issuanceAuditHash !== rightDetail.issuanceAuditHash || leftDetail.runAuditHash !== rightDetail.runAuditHash || leftDetail.ownerReview !== rightDetail.ownerReview) return false
  return left.type === 'connector.artifact.owner_liked'
    ? leftDetail.artifactId === rightDetail.artifactId
    : leftDetail.reviewId === rightDetail.reviewId && leftDetail.reason === rightDetail.reason
}

function proofFor(receipt: StoredReviewReceipt): ImageOwnerReviewDecisionProof {
  return { auditHash: receipt.auditHash, issuanceAuditHash: receipt.issuanceAuditHash, runAuditHash: receipt.runAuditHash }
}

/** Rechecks receipt fields and the matching decision event in the full audit chain. */
function assertDecisionReceipt(records: readonly unknown[], receipt: StoredReviewReceipt, event: ImageOwnerReviewDecisionEvent): ImageOwnerReviewDecisionProof {
  const expected = receiptFor(event, receipt.auditHash)
  if (receipt.candidateId !== expected.candidateId || receipt.correlationId !== expected.correlationId || receipt.decision !== expected.decision || receipt.publication !== expected.publication || receipt.issuanceAuditHash !== expected.issuanceAuditHash || receipt.runAuditHash !== expected.runAuditHash) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  const auditRecords = verifyAuditChain(records)
  const decision = auditRecords.find((record) => record.hash === receipt.auditHash)
  if (!decision) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  try {
    assertImageOwnerReviewEvent(decision.event)
    if (!sameDecisionEvent(decision.event, event)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    assertDecisionLineage(records, decision.event)
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  }
  return proofFor(receipt)
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
      const auditRecords = await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      })
      assertDecisionLineage(auditRecords.map((record) => record.values), event)
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

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    assertImageOwnerReviewEvent(event)
    const { records, auditRecords } = await this.prisma.$transaction(async (transaction) => ({
      records: await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID },
        select: { values: true },
      }),
      auditRecords: await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      }),
    }))
    const receipts = records.map((record) => storedReceipt(record.values))
    if (receipts.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    const receipt = receipts.find((item) => item && item.candidateId === event.detail.candidateId && item.correlationId === event.correlationId)
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertDecisionReceipt(auditRecords.map((record) => record.values), receipt, event)
  }
}

/** Test-only seam; deployed hosts must use the durable Record-backed ledger. */
export class InMemoryImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  private readonly decisions = new Map<string, 'in-flight' | 'final'>()
  private readonly receipts = new Map<string, StoredReviewReceipt>()

  constructor(private readonly auditLog: AuditLog & { entries?: readonly unknown[] }) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    assertImageOwnerReviewEvent(event)
    const append = dataMethod(this.auditLog, 'append')
    const entries = auditEntries(this.auditLog)
    if (!append || !entries) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    assertDecisionLineage(entries, event)
    const key = decisionKey(event)
    const state = this.decisions.get(key)
    if (state === 'final') throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
    if (state === 'in-flight') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_IN_FLIGHT')
    this.decisions.set(key, 'in-flight')
    try {
      const auditHash = returnedAuditHash(await append.call(this.auditLog, event))
      if (!auditHash) {
        this.decisions.set(key, 'final')
        throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
      }
      this.decisions.set(key, 'final')
      this.receipts.set(key, receiptFor(event, auditHash))
      return { hash: auditHash }
    } catch (error) {
      if (this.decisions.get(key) === 'in-flight') this.decisions.delete(key)
      throw error
    }
  }

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    assertImageOwnerReviewEvent(event)
    const entries = auditEntries(this.auditLog)
    if (!entries) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    const receipt = this.receipts.get(decisionKey(event))
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertDecisionReceipt(entries, receipt, event)
  }
}
