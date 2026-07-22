import { appendAuditEvent, GCL_AUDIT_MODULE_ID, verifyAuditChain } from './audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import { imageCandidateFingerprint } from './image.js'
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
  /** The immutable issuance deadline re-read with the terminal receipt. */
  reviewExpiresAt: string
  /** The exact redacted candidate shape accepted for the terminal receipt. */
  candidateFingerprint: string
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
  reviewExpiresAt: string
  candidateFingerprint: string
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

/**
 * Keep an accepted terminal decision private to the ledger before an async
 * transaction or audit seam yields. This closes the mutable-object gap between
 * validation, lineage checks, audit append, and receipt creation.
 */
function sealedDecisionEvent(value: unknown): ImageOwnerReviewDecisionEvent {
  assertImageOwnerReviewEvent(value)
  try {
    const event = structuredClone(value)
    assertImageOwnerReviewEvent(event)
    return event
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
  }
}

function imageScope(value: unknown): boolean {
  const scopes = plainArray(value)
  return Boolean(scopes && scopes.length === 1 && scopes[0] === IMAGE_SCOPE)
}

function storedReceipt(value: unknown): StoredReviewReceipt | null {
  const receipt = plainRecord(value)
  if (!receipt || !exactKeys(receipt, ['schema', 'candidateId', 'correlationId', 'decision', 'publication', 'issuanceAuditHash', 'runAuditHash', 'auditHash', 'reviewExpiresAt', 'candidateFingerprint'])) return null
  if (receipt.schema !== 'gcl-image-owner-review-v1' || typeof receipt.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(receipt.candidateId) || !safeIdentifier(receipt.correlationId) || (receipt.decision !== 'liked' && receipt.decision !== 'rejected') || receipt.publication !== 'blocked' || typeof receipt.issuanceAuditHash !== 'string' || !HASH_PATTERN.test(receipt.issuanceAuditHash) || typeof receipt.runAuditHash !== 'string' || !HASH_PATTERN.test(receipt.runAuditHash) || typeof receipt.auditHash !== 'string' || !HASH_PATTERN.test(receipt.auditHash) || !canonicalTimestamp(receipt.reviewExpiresAt) || typeof receipt.candidateFingerprint !== 'string' || !HASH_PATTERN.test(receipt.candidateFingerprint)) return null
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
    ? ['candidateId', 'candidateFingerprint', 'reviewExpiresAt', 'maker', 'publication', 'issuanceAuditHash', 'runAuditHash', 'artifactId', 'ownerReview']
    : ['candidateId', 'candidateFingerprint', 'reviewExpiresAt', 'maker', 'publication', 'issuanceAuditHash', 'runAuditHash', 'reviewId', 'ownerReview', 'reason']
  if (!detail || !exactKeys(detail, keys) || typeof detail.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(detail.candidateId) || typeof detail.candidateFingerprint !== 'string' || !HASH_PATTERN.test(detail.candidateFingerprint) || !canonicalTimestamp(detail.reviewExpiresAt) || !safeIdentifier(detail.maker) || detail.publication !== 'blocked' || typeof detail.issuanceAuditHash !== 'string' || !HASH_PATTERN.test(detail.issuanceAuditHash) || typeof detail.runAuditHash !== 'string' || !HASH_PATTERN.test(detail.runAuditHash) || detail.ownerReview !== (liked ? 'liked' : 'rejected')) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
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
    reviewExpiresAt: event.detail.reviewExpiresAt as string,
    candidateFingerprint: event.detail.candidateFingerprint as string,
  }
}

type IssuanceLineage = {
  actor: string
  occurredAt: number
  candidateSetDigest: string
  candidateCount: number
  candidates: ReadonlyMap<string, { fingerprint: string; reviewExpiresAt: number; reviewExpiresAtValue: string }>
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
  const candidates = new Map<string, { fingerprint: string; reviewExpiresAt: number; reviewExpiresAtValue: string }>()
  for (const entry of entries) {
    const candidate = plainRecord(entry)
    if (!candidate || !exactKeys(candidate, ['candidateId', 'fingerprint', 'reviewExpiresAt']) || typeof candidate.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidate.candidateId) || !safeHash(candidate.fingerprint) || !canonicalTimestamp(candidate.reviewExpiresAt)) return null
    const reviewExpiresAt = new Date(candidate.reviewExpiresAt).getTime()
    if (reviewExpiresAt <= new Date(issuance.occurredAt).getTime()) return null
    candidates.set(candidate.candidateId, { fingerprint: candidate.fingerprint, reviewExpiresAt, reviewExpiresAtValue: candidate.reviewExpiresAt })
  }
  if (candidates.size !== entries.length) return null
  const candidateSetDigest = imageCandidateFingerprint([...candidates.entries()]
    .map(([candidateId, candidate]) => ({ candidateId, fingerprint: candidate.fingerprint }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId)))
  if (candidateSetDigest !== detail.candidateSetDigest) return null
  return {
    actor: issuance.actor,
    occurredAt: new Date(issuance.occurredAt).getTime(),
    candidateSetDigest: detail.candidateSetDigest,
    candidateCount: detail.candidateCount,
    candidates,
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
  const candidate = issuance?.candidates.get(event.detail.candidateId as string)
  if (!issuance || !source || !candidate || event.detail.runAuditHash !== issuance.runAuditHash || event.detail.maker !== issuance.actor || event.detail.candidateFingerprint !== candidate.fingerprint || event.detail.reviewExpiresAt !== candidate.reviewExpiresAtValue || decisionTime >= candidate.reviewExpiresAt || source.event.occurredAt === undefined || issuance.occurredAt > decisionTime || new Date(source.event.occurredAt).getTime() > issuance.occurredAt) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
}

function sameDecisionEvent(left: ImageOwnerReviewDecisionEvent, right: ImageOwnerReviewDecisionEvent): boolean {
  if (left.type !== right.type || left.connectorId !== right.connectorId || left.product !== right.product || left.workspaceId !== right.workspaceId || left.actor !== right.actor || left.correlationId !== right.correlationId || left.costCapCents !== right.costCapCents || left.requestedItems !== right.requestedItems || left.occurredAt !== right.occurredAt || !imageScope(left.scopes) || !imageScope(right.scopes)) return false
  const leftDetail = left.detail
  const rightDetail = right.detail
  if (leftDetail.candidateId !== rightDetail.candidateId || leftDetail.candidateFingerprint !== rightDetail.candidateFingerprint || leftDetail.reviewExpiresAt !== rightDetail.reviewExpiresAt || leftDetail.maker !== rightDetail.maker || leftDetail.publication !== rightDetail.publication || leftDetail.issuanceAuditHash !== rightDetail.issuanceAuditHash || leftDetail.runAuditHash !== rightDetail.runAuditHash || leftDetail.ownerReview !== rightDetail.ownerReview) return false
  return left.type === 'connector.artifact.owner_liked'
    ? leftDetail.artifactId === rightDetail.artifactId
    : leftDetail.reviewId === rightDetail.reviewId && leftDetail.reason === rightDetail.reason
}

function proofFor(receipt: StoredReviewReceipt): ImageOwnerReviewDecisionProof {
  return {
    auditHash: receipt.auditHash,
    issuanceAuditHash: receipt.issuanceAuditHash,
    runAuditHash: receipt.runAuditHash,
    reviewExpiresAt: receipt.reviewExpiresAt,
    candidateFingerprint: receipt.candidateFingerprint,
  }
}

/** Rechecks receipt fields and the matching decision event in the full audit chain. */
function assertDecisionReceipt(records: readonly unknown[], receipt: StoredReviewReceipt, event: ImageOwnerReviewDecisionEvent): ImageOwnerReviewDecisionProof {
  const expected = receiptFor(event, receipt.auditHash)
  if (receipt.candidateId !== expected.candidateId || receipt.correlationId !== expected.correlationId || receipt.decision !== expected.decision || receipt.publication !== expected.publication || receipt.issuanceAuditHash !== expected.issuanceAuditHash || receipt.runAuditHash !== expected.runAuditHash || receipt.reviewExpiresAt !== expected.reviewExpiresAt || receipt.candidateFingerprint !== expected.candidateFingerprint) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
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
    const sealedEvent = sealedDecisionEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${sealedEvent.product}:${sealedEvent.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID },
        select: { values: true },
      })
      const auditRecords = await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      })
      assertDecisionLineage(auditRecords.map((record) => record.values), sealedEvent)
      for (const record of records) {
        const receipt = storedReceipt(record.values)
        if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
        if (receipt.candidateId === sealedEvent.detail.candidateId && receipt.correlationId === sealedEvent.correlationId) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
      }
      const audit = await appendAuditEvent(transaction, sealedEvent)
      await transaction.record.create({
        data: {
          product: sealedEvent.product,
          workspaceId: sealedEvent.workspaceId,
          moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID,
          values: receiptFor(sealedEvent, audit.hash),
          status: 'terminal',
          createdBy: 'gcl-image-review',
        },
      })
      return audit
    })
  }

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    const sealedEvent = sealedDecisionEvent(event)
    const { records, auditRecords } = await this.prisma.$transaction(async (transaction) => ({
      records: await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID },
        select: { values: true },
      }),
      auditRecords: await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      }),
    }))
    const receipts = records.map((record) => storedReceipt(record.values))
    if (receipts.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    const receipt = receipts.find((item) => item && item.candidateId === sealedEvent.detail.candidateId && item.correlationId === sealedEvent.correlationId)
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertDecisionReceipt(auditRecords.map((record) => record.values), receipt, sealedEvent)
  }
}

/** Test-only seam; deployed hosts must use the durable Record-backed ledger. */
export class InMemoryImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  private readonly decisions = new Map<string, 'in-flight' | 'final'>()
  private readonly receipts = new Map<string, StoredReviewReceipt>()

  constructor(private readonly auditLog: AuditLog & { entries?: readonly unknown[] }) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    const sealedEvent = sealedDecisionEvent(event)
    const append = dataMethod(this.auditLog, 'append')
    const entries = auditEntries(this.auditLog)
    if (!append || !entries) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    assertDecisionLineage(entries, sealedEvent)
    const key = decisionKey(sealedEvent)
    const state = this.decisions.get(key)
    if (state === 'final') throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
    if (state === 'in-flight') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_IN_FLIGHT')
    this.decisions.set(key, 'in-flight')
    try {
      const auditHash = returnedAuditHash(await append.call(this.auditLog, sealedEvent))
      if (!auditHash) {
        this.decisions.set(key, 'final')
        throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
      }
      this.decisions.set(key, 'final')
      this.receipts.set(key, receiptFor(sealedEvent, auditHash))
      return { hash: auditHash }
    } catch (error) {
      if (this.decisions.get(key) === 'in-flight') this.decisions.delete(key)
      throw error
    }
  }

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    const sealedEvent = sealedDecisionEvent(event)
    const entries = auditEntries(this.auditLog)
    if (!entries) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    const receipt = this.receipts.get(decisionKey(sealedEvent))
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertDecisionReceipt(entries, receipt, sealedEvent)
  }
}
