import { appendAuditEvent, GCL_AUDIT_MODULE_ID, verifyAuditChain } from './audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import { IMAGE_CANDIDATE_SET_AUDIT_FIELD, MAX_SYNTHETIC_IMAGE_CANDIDATES, assertSyntheticImageCandidate, imageCandidateFingerprint } from './image.js'
import type { SyntheticImageCandidate } from './image.js'
import type { GclPersistence } from './persistence.js'
import type { ConnectorAuditEvent } from './types.js'

/** Existing Record storage is reused; no image-candidate migration is introduced. */
export const GCL_IMAGE_CANDIDATE_MODULE_ID = 'gcl-image-candidate'

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const IMAGE_SCOPE = 'image:generate'

export type ImageCandidateIssuanceEntry = {
  candidateId: string
  fingerprint: string
  /** Canonical owner-review deadline; never prompt or media data. */
  reviewExpiresAt: string
}

export type ImageCandidateIssuanceEvent = ConnectorAuditEvent & {
  type: 'connector.artifact.candidates_issued'
  detail: {
    candidateSetDigest: string
    candidateCount: number
    candidates: readonly ImageCandidateIssuanceEntry[]
    publication: 'blocked'
    runAuditHash: string
  }
}

export type ImageCandidateIssuanceProof = {
  issuanceAuditHash: string
  runAuditHash: string
  /** Canonical event time; terminal reviews cannot predate durable issuance. */
  issuanceOccurredAt: string
  /** Re-read from the durable receipt; terminal review must remain before it. */
  reviewExpiresAt: string
  /** Exact redacted candidate shape bound to this issuance receipt. */
  candidateFingerprint: string
}

/**
 * A candidate must be durably issued from a governed run before an owner can
 * make a terminal decision. This is not an authentication mechanism; the host
 * still authenticates the caller that records an issuance.
 */
export interface ImageCandidateLedger {
  appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }>
  assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof>
}

type StoredCandidateReceipt = {
  schema: 'gcl-image-candidate-v1'
  candidateId: string
  correlationId: string
  fingerprint: string
  publication: 'blocked'
  runAuditHash: string
  issuanceAuditHash: string
  issuanceOccurredAt: string
  reviewExpiresAt: string
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
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

/** Reject sparse, accessor-bearing, or extended arrays before entry inspection. */
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

/** Resolve a callable audit capability without evaluating an accessor. */
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

/** The in-memory audit seam must expose its mutable test entries as own data. */
function auditEntries(value: unknown): readonly unknown[] | null {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, 'entries')
    return descriptor && !descriptor.get && !descriptor.set && Array.isArray(descriptor.value) ? descriptor.value : null
  } catch { return null }
}

function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) }
function safeHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }
/** Do not read an accessor-backed hash returned by a host-provided test seam. */
function returnedAuditHash(value: unknown): string | null {
  const audit = plainRecord(value)
  return audit && exactKeys(audit, ['hash']) && safeHash(audit.hash) ? audit.hash : null
}
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** The clone contains only validated plain data, so it can be frozen safely. */
function freezeData<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeData(child)
  return Object.freeze(value)
}

/**
 * Seal an accepted write envelope before an async transaction or test seam
 * can yield. The original caller object remains mutable, so retaining it
 * would allow a valid event to become a different receipt or audit event
 * after its first validation. All accepted event shapes are data-only.
 */
function sealedIssuanceEvent(value: unknown): ImageCandidateIssuanceEvent {
  assertImageCandidateIssuanceEvent(value)
  try {
    const event = structuredClone(value)
    assertImageCandidateIssuanceEvent(event)
    return freezeData(event)
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  }
}

/**
 * Receipt lookup is also an async persistence boundary. Copy the exact,
 * locally valid synthetic candidate before using its scope after a query;
 * this prevents a caller from changing the lookup target while it is pending.
 */
function sealedCandidate(value: unknown): SyntheticImageCandidate {
  try {
    assertSyntheticImageCandidate(value)
    const candidate = structuredClone(value)
    assertSyntheticImageCandidate(candidate)
    return freezeData(candidate)
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  }
}

function canonicalEntries(entries: readonly ImageCandidateIssuanceEntry[]): ImageCandidateIssuanceEntry[] {
  return [...entries].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
}

function candidateSetDigest(entries: readonly ImageCandidateIssuanceEntry[]): string {
  // The governed success audit predates the issuance ledger and binds only
  // candidate IDs plus their redacted fingerprints. Deadline data is carried
  // in issuance receipts for lifecycle enforcement, but cannot change that
  // already-bound success digest.
  return imageCandidateFingerprint(canonicalEntries(entries).map(({ candidateId, fingerprint }) => ({ candidateId, fingerprint })))
}

function issuanceEntries(value: unknown): ImageCandidateIssuanceEntry[] | null {
  const values = plainArray(value)
  if (!values || values.length < 1 || values.length > MAX_SYNTHETIC_IMAGE_CANDIDATES || values.some((entry) => !plainRecord(entry))) return null
  const entries = values.map((entry) => entry as Record<string, unknown>)
  if (entries.some((entry) => !exactKeys(entry, ['candidateId', 'fingerprint', 'reviewExpiresAt']) || typeof entry.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(entry.candidateId) || !safeHash(entry.fingerprint) || !canonicalTimestamp(entry.reviewExpiresAt))) return null
  const candidateIds = entries.map((entry) => entry.candidateId as string)
  if (new Set(candidateIds).size !== candidateIds.length) return null
  return entries.map((entry) => ({ candidateId: entry.candidateId as string, fingerprint: entry.fingerprint as string, reviewExpiresAt: entry.reviewExpiresAt as string }))
}

function imageScope(value: unknown): boolean {
  const scopes = plainArray(value)
  return Boolean(scopes && scopes.length === 1 && scopes[0] === IMAGE_SCOPE)
}

function assertImageCandidateIssuanceEvent(event: unknown): asserts event is ImageCandidateIssuanceEvent {
  const value = plainRecord(event)
  if (!value || !exactKeys(value, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  const requestedItems = value.requestedItems
  if (value.type !== 'connector.artifact.candidates_issued' || value.connectorId !== 'image-tti' || !safeIdentifier(value.product) || !safeIdentifier(value.workspaceId) || !safeIdentifier(value.actor) || !safeIdentifier(value.correlationId) || !imageScope(value.scopes) || value.costCapCents !== 0 || typeof requestedItems !== 'number' || !Number.isSafeInteger(requestedItems) || requestedItems < 1 || !canonicalTimestamp(value.occurredAt)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')

  const detail = plainRecord(value.detail)
  if (!detail || !exactKeys(detail, ['candidateSetDigest', 'candidateCount', 'candidates', 'publication', 'runAuditHash']) || !safeHash(detail.candidateSetDigest) || !Number.isSafeInteger(detail.candidateCount) || detail.publication !== 'blocked' || !safeHash(detail.runAuditHash)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  const entries = issuanceEntries(detail.candidates)
  if (!entries || detail.candidateCount !== entries.length || requestedItems !== entries.length || detail.candidateSetDigest !== candidateSetDigest(entries)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  const issuanceTime = new Date(value.occurredAt).getTime()
  if (entries.some((entry) => issuanceTime >= new Date(entry.reviewExpiresAt).getTime())) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_EXPIRED')
}

function storedReceipt(value: unknown): StoredCandidateReceipt | null {
  const receipt = plainRecord(value)
  if (!receipt || !exactKeys(receipt, ['schema', 'candidateId', 'correlationId', 'fingerprint', 'publication', 'runAuditHash', 'issuanceAuditHash', 'issuanceOccurredAt', 'reviewExpiresAt'])) return null
  if (receipt.schema !== 'gcl-image-candidate-v1' || typeof receipt.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(receipt.candidateId) || !safeIdentifier(receipt.correlationId) || !safeHash(receipt.fingerprint) || receipt.publication !== 'blocked' || !safeHash(receipt.runAuditHash) || !safeHash(receipt.issuanceAuditHash) || !canonicalTimestamp(receipt.issuanceOccurredAt) || !canonicalTimestamp(receipt.reviewExpiresAt)) return null
  return receipt as StoredCandidateReceipt
}

function receiptFor(event: ImageCandidateIssuanceEvent, entry: ImageCandidateIssuanceEntry, issuanceAuditHash: string): StoredCandidateReceipt {
  return {
    schema: 'gcl-image-candidate-v1',
    candidateId: entry.candidateId,
    correlationId: event.correlationId,
    fingerprint: entry.fingerprint,
    publication: 'blocked',
    runAuditHash: event.detail.runAuditHash,
    issuanceAuditHash,
    issuanceOccurredAt: event.occurredAt,
    reviewExpiresAt: entry.reviewExpiresAt,
  }
}

function receiptForCandidate(candidate: SyntheticImageCandidate): Pick<StoredCandidateReceipt, 'candidateId' | 'correlationId' | 'fingerprint' | 'reviewExpiresAt'> {
  return { candidateId: candidate.candidateId, correlationId: candidate.scope.correlationId, fingerprint: imageCandidateFingerprint(candidate), reviewExpiresAt: candidate.ownerReview.reviewExpiresAt }
}

function proofFor(receipt: StoredCandidateReceipt): ImageCandidateIssuanceProof {
  return {
    issuanceAuditHash: receipt.issuanceAuditHash,
    runAuditHash: receipt.runAuditHash,
    issuanceOccurredAt: receipt.issuanceOccurredAt,
    reviewExpiresAt: receipt.reviewExpiresAt,
    candidateFingerprint: receipt.fingerprint,
  }
}

function isSourceRunSuccess(record: { event: ConnectorAuditEvent; hash: string }, event: ImageCandidateIssuanceEvent): boolean {
  const detail = plainRecord(record.event.detail)
  return record.hash === event.detail.runAuditHash
    && record.event.type === 'connector.run.succeeded'
    && record.event.connectorId === event.connectorId
    && record.event.product === event.product
    && record.event.workspaceId === event.workspaceId
    && record.event.actor === event.actor
    && record.event.correlationId === event.correlationId
    && imageScope(record.event.scopes)
    && typeof record.event.costCapCents === 'number'
    && Number.isSafeInteger(record.event.costCapCents)
    && record.event.costCapCents > 0
    && record.event.requestedItems === event.detail.candidateCount
    && canonicalTimestamp(record.event.occurredAt)
    && detail?.[IMAGE_CANDIDATE_SET_AUDIT_FIELD] === event.detail.candidateSetDigest
}

function assertSourceRunAudit(records: readonly unknown[], event: ImageCandidateIssuanceEvent): void {
  const auditRecords = verifyAuditChain(records)
  const source = auditRecords.find((record) => isSourceRunSuccess(record, event))
  if (!source) throw new ConnectorInputError('IMAGE_CANDIDATE_RUN_AUDIT_NOT_FOUND')
  if (new Date(event.occurredAt).getTime() < new Date(source.event.occurredAt).getTime()) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_BEFORE_RUN_SUCCESS')
}

/** A receipt is usable only if its matching issuance event and source run remain in the verified chain. */
function assertReceiptAudit(records: readonly unknown[], receipt: StoredCandidateReceipt): void {
  const auditRecords = verifyAuditChain(records)
  const issuance = auditRecords.find((record) => record.hash === receipt.issuanceAuditHash)
  if (!issuance) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
  try { assertImageCandidateIssuanceEvent(issuance.event) } catch { throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID') }
  const event = issuance.event as ImageCandidateIssuanceEvent
  const entry = event.detail.candidates.find((item) => item.candidateId === receipt.candidateId && item.fingerprint === receipt.fingerprint && item.reviewExpiresAt === receipt.reviewExpiresAt)
  const source = auditRecords.find((record) => isSourceRunSuccess(record, event))
  if (!entry || event.correlationId !== receipt.correlationId || event.detail.runAuditHash !== receipt.runAuditHash || receipt.issuanceOccurredAt !== event.occurredAt || new Date(receipt.issuanceOccurredAt).getTime() >= new Date(receipt.reviewExpiresAt).getTime() || !source || new Date(receipt.issuanceOccurredAt).getTime() < new Date(source.event.occurredAt).getTime()) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
}

/** Durable, redacted candidate-issuance store. It is always publication-blocked. */
export class PrismaImageCandidateLedger implements ImageCandidateLedger {
  constructor(private readonly prisma: GclPersistence) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    const sealedEvent = sealedIssuanceEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${sealedEvent.product}:${sealedEvent.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID },
        select: { values: true },
      })
      const auditRecords = await transaction.record.findMany({
        where: { product: sealedEvent.product, workspaceId: sealedEvent.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      })
      assertSourceRunAudit(auditRecords.map((record) => record.values), sealedEvent)
      const prior = records.map((record) => storedReceipt(record.values))
      if (prior.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
      const candidateIds = new Set(sealedEvent.detail.candidates.map((entry) => entry.candidateId))
      if (prior.some((receipt) => receipt && receipt.correlationId === sealedEvent.correlationId && candidateIds.has(receipt.candidateId))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
      const audit = await appendAuditEvent(transaction, sealedEvent)
      for (const entry of sealedEvent.detail.candidates) {
        await transaction.record.create({
          data: {
            product: sealedEvent.product,
            workspaceId: sealedEvent.workspaceId,
            moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID,
            values: receiptFor(sealedEvent, entry, audit.hash),
            status: 'issued',
            createdBy: 'gcl-image-candidate',
          },
        })
      }
      return audit
    })
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    const sealed = sealedCandidate(candidate)
    const expected = receiptForCandidate(sealed)
    const { records, auditRecords } = await this.prisma.$transaction(async (transaction) => ({
      records: await transaction.record.findMany({
        where: { product: sealed.scope.product, workspaceId: sealed.scope.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID },
        select: { values: true },
      }),
      auditRecords: await transaction.record.findMany({
        where: { product: sealed.scope.product, workspaceId: sealed.scope.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      }),
    }))
    const receipts = records.map((record) => storedReceipt(record.values))
    if (receipts.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
    const receipt = receipts.find((item) => item && item.candidateId === expected.candidateId && item.correlationId === expected.correlationId)
    if (!receipt || receipt.fingerprint !== expected.fingerprint || receipt.reviewExpiresAt !== expected.reviewExpiresAt || receipt.publication !== 'blocked') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_ISSUED')
    assertReceiptAudit(auditRecords.map((record) => record.values), receipt)
    return proofFor(receipt)
  }
}

/** Test-only seam; deployed hosts must use the durable Record-backed ledger. */
export class InMemoryImageCandidateLedger implements ImageCandidateLedger {
  private readonly receipts = new Map<string, StoredCandidateReceipt>()
  private readonly issuanceStates = new Map<string, 'in-flight' | 'final'>()

  constructor(private readonly auditLog: { append(event: ConnectorAuditEvent): Promise<{ hash: string }>; entries?: readonly unknown[] }) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    const sealedEvent = sealedIssuanceEvent(event)
    const append = dataMethod(this.auditLog, 'append')
    const entries = auditEntries(this.auditLog)
    if (!append || !entries) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
    assertSourceRunAudit(entries, sealedEvent)
    const keys = sealedEvent.detail.candidates.map((entry) => JSON.stringify([sealedEvent.product, sealedEvent.workspaceId, sealedEvent.correlationId, entry.candidateId]))
    if (keys.some((key) => this.issuanceStates.get(key) === 'final' || this.receipts.has(key))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
    if (keys.some((key) => this.issuanceStates.get(key) === 'in-flight')) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_ISSUANCE_IN_FLIGHT')
    for (const key of keys) this.issuanceStates.set(key, 'in-flight')
    try {
      const auditHash = returnedAuditHash(await append.call(this.auditLog, sealedEvent))
      if (!auditHash) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
      for (const entry of sealedEvent.detail.candidates) {
        const key = JSON.stringify([sealedEvent.product, sealedEvent.workspaceId, sealedEvent.correlationId, entry.candidateId])
        this.receipts.set(key, receiptFor(sealedEvent, entry, auditHash))
        this.issuanceStates.set(key, 'final')
      }
      return { hash: auditHash }
    } catch (error) {
      for (const key of keys) {
        if (this.issuanceStates.get(key) === 'in-flight') this.issuanceStates.delete(key)
      }
      throw error
    }
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    const sealed = sealedCandidate(candidate)
    const expected = receiptForCandidate(sealed)
    const key = JSON.stringify([sealed.scope.product, sealed.scope.workspaceId, expected.correlationId, expected.candidateId])
    const receipt = this.receipts.get(key)
    if (!receipt || receipt.fingerprint !== expected.fingerprint || receipt.reviewExpiresAt !== expected.reviewExpiresAt || receipt.publication !== 'blocked') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_ISSUED')
    const entries = auditEntries(this.auditLog)
    if (!entries) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
    assertReceiptAudit(entries, receipt)
    return proofFor(receipt)
  }
}
