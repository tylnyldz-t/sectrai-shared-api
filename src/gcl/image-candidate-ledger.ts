import { appendAuditEvent, GCL_AUDIT_MODULE_ID } from './audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import { imageCandidateFingerprint } from './image.js'
import type { SyntheticImageCandidate } from './image.js'
import type { GclPersistence } from './persistence.js'
import type { ConnectorAuditEvent } from './types.js'

/** Existing Record storage is reused; no image-candidate migration is introduced. */
export const GCL_IMAGE_CANDIDATE_MODULE_ID = 'gcl-image-candidate'

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const IMAGE_SCOPE = 'image:generate'
const MAX_ISSUED_CANDIDATES = 32

export type ImageCandidateIssuanceEntry = {
  candidateId: string
  fingerprint: string
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
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

function safeIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) }
function safeHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function canonicalEntries(entries: readonly ImageCandidateIssuanceEntry[]): ImageCandidateIssuanceEntry[] {
  return [...entries].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
}

function candidateSetDigest(entries: readonly ImageCandidateIssuanceEntry[]): string {
  return imageCandidateFingerprint(canonicalEntries(entries))
}

function issuanceEntries(value: unknown): ImageCandidateIssuanceEntry[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ISSUED_CANDIDATES || value.some((entry) => !plainRecord(entry))) return null
  const entries = value.map((entry) => entry as Record<string, unknown>)
  if (entries.some((entry) => !exactKeys(entry, ['candidateId', 'fingerprint']) || typeof entry.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(entry.candidateId) || !safeHash(entry.fingerprint))) return null
  const candidateIds = entries.map((entry) => entry.candidateId as string)
  if (new Set(candidateIds).size !== candidateIds.length) return null
  return entries.map((entry) => ({ candidateId: entry.candidateId as string, fingerprint: entry.fingerprint as string }))
}

function assertImageCandidateIssuanceEvent(event: unknown): asserts event is ImageCandidateIssuanceEvent {
  const value = plainRecord(event)
  if (!value || !exactKeys(value, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  if (value.type !== 'connector.artifact.candidates_issued' || value.connectorId !== 'image-tti' || !safeIdentifier(value.product) || !safeIdentifier(value.workspaceId) || !safeIdentifier(value.actor) || !safeIdentifier(value.correlationId) || !Array.isArray(value.scopes) || value.scopes.length !== 1 || value.scopes[0] !== IMAGE_SCOPE || value.costCapCents !== 0 || !Number.isSafeInteger(value.requestedItems) || value.requestedItems < 1 || !canonicalTimestamp(value.occurredAt)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')

  const detail = plainRecord(value.detail)
  if (!detail || !exactKeys(detail, ['candidateSetDigest', 'candidateCount', 'candidates', 'publication', 'runAuditHash']) || !safeHash(detail.candidateSetDigest) || !Number.isSafeInteger(detail.candidateCount) || detail.publication !== 'blocked' || !safeHash(detail.runAuditHash)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  const entries = issuanceEntries(detail.candidates)
  if (!entries || detail.candidateCount !== entries.length || value.requestedItems !== entries.length || detail.candidateSetDigest !== candidateSetDigest(entries)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
}

function storedReceipt(value: unknown): StoredCandidateReceipt | null {
  const receipt = plainRecord(value)
  if (!receipt || !exactKeys(receipt, ['schema', 'candidateId', 'correlationId', 'fingerprint', 'publication', 'runAuditHash', 'issuanceAuditHash'])) return null
  if (receipt.schema !== 'gcl-image-candidate-v1' || typeof receipt.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(receipt.candidateId) || !safeIdentifier(receipt.correlationId) || !safeHash(receipt.fingerprint) || receipt.publication !== 'blocked' || !safeHash(receipt.runAuditHash) || !safeHash(receipt.issuanceAuditHash)) return null
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
  }
}

function receiptForCandidate(candidate: SyntheticImageCandidate): Pick<StoredCandidateReceipt, 'candidateId' | 'correlationId' | 'fingerprint'> {
  return { candidateId: candidate.candidateId, correlationId: candidate.scope.correlationId, fingerprint: imageCandidateFingerprint(candidate) }
}

function proofFor(receipt: StoredCandidateReceipt): ImageCandidateIssuanceProof {
  return { issuanceAuditHash: receipt.issuanceAuditHash, runAuditHash: receipt.runAuditHash }
}

/** Durable, redacted candidate-issuance store. It is always publication-blocked. */
export class PrismaImageCandidateLedger implements ImageCandidateLedger {
  constructor(private readonly prisma: GclPersistence) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    assertImageCandidateIssuanceEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID },
        select: { values: true },
      })
      const prior = records.map((record) => storedReceipt(record.values))
      if (prior.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
      const candidateIds = new Set(event.detail.candidates.map((entry) => entry.candidateId))
      if (prior.some((receipt) => receipt && receipt.correlationId === event.correlationId && candidateIds.has(receipt.candidateId))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
      const audit = await appendAuditEvent(transaction, event)
      for (const entry of event.detail.candidates) {
        await transaction.record.create({
          data: {
            product: event.product,
            workspaceId: event.workspaceId,
            moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID,
            values: receiptFor(event, entry, audit.hash),
            status: 'issued',
            createdBy: 'gcl-image-candidate',
          },
        })
      }
      return audit
    })
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    const expected = receiptForCandidate(candidate)
    const records = await this.prisma.$transaction((transaction) => transaction.record.findMany({
      where: { product: candidate.scope.product, workspaceId: candidate.scope.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID },
      select: { values: true },
    }))
    const receipts = records.map((record) => storedReceipt(record.values))
    if (receipts.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
    const receipt = receipts.find((item) => item && item.candidateId === expected.candidateId && item.correlationId === expected.correlationId)
    if (!receipt || receipt.fingerprint !== expected.fingerprint || receipt.publication !== 'blocked') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_ISSUED')
    return proofFor(receipt)
  }
}

/** Test-only seam; deployed hosts must use the durable Record-backed ledger. */
export class InMemoryImageCandidateLedger implements ImageCandidateLedger {
  private readonly receipts = new Map<string, StoredCandidateReceipt>()

  constructor(private readonly auditLog: { append(event: ConnectorAuditEvent): Promise<{ hash: string }> }) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    assertImageCandidateIssuanceEvent(event)
    if (!this.auditLog || typeof this.auditLog.append !== 'function') throw new ConnectorUnavailableError('IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
    const keys = event.detail.candidates.map((entry) => JSON.stringify([event.product, event.workspaceId, event.correlationId, entry.candidateId]))
    if (keys.some((key) => this.receipts.has(key))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
    const audit = await this.auditLog.append(event)
    if (!audit || !safeHash(audit.hash)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_AUDIT_UNAVAILABLE')
    for (const entry of event.detail.candidates) {
      const key = JSON.stringify([event.product, event.workspaceId, event.correlationId, entry.candidateId])
      this.receipts.set(key, receiptFor(event, entry, audit.hash))
    }
    return audit
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    const expected = receiptForCandidate(candidate)
    const key = JSON.stringify([candidate.scope.product, candidate.scope.workspaceId, expected.correlationId, expected.candidateId])
    const receipt = this.receipts.get(key)
    if (!receipt || receipt.fingerprint !== expected.fingerprint || receipt.publication !== 'blocked') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_ISSUED')
    return proofFor(receipt)
  }
}
