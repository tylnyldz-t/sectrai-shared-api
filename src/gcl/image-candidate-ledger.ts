import { appendAuditEvent, GCL_AUDIT_MODULE_ID, verifyAuditChain } from './image-audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import { IMAGE_CANDIDATE_SET_AUDIT_FIELD, IMAGE_TTI_CONNECTOR_ID, MAX_SYNTHETIC_IMAGE_CANDIDATES, assertSyntheticImageCandidate, imageCandidateFingerprint } from './image.js'
import type { SyntheticImageCandidate } from './image.js'
import type { GclPersistence } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_IMAGE_CANDIDATE_MODULE_ID = 'gcl-image-candidate'

const IMAGE_SCOPE = 'image:generate'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/

export type ImageCandidateIssuanceEntry = { candidateId: string; fingerprint: string; reviewExpiresAt: string }
export type ImageCandidateIssuanceEvent = ConnectorAuditEvent & {
  type: 'connector.artifact.candidates_issued'
  actor: string
  correlationId: string
  detail: { candidateSetDigest: string; candidateCount: number; candidates: readonly ImageCandidateIssuanceEntry[]; publication: 'blocked'; runAuditHash: string }
}
export type ImageCandidateIssuanceProof = {
  issuanceAuditHash: string
  runAuditHash: string
  issuanceOccurredAt: string
  reviewExpiresAt: string
  candidateFingerprint: string
}
export interface ImageCandidateLedger {
  appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }>
  assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof>
}
type StoredCandidateReceipt = ImageCandidateIssuanceProof & {
  schema: 'gcl-image-candidate-v1'
  candidateId: string
  correlationId: string
  publication: 'blocked'
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function isHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9:_@. -]{1,160}$/.test(value) }
function candidateSetDigest(entries: readonly ImageCandidateIssuanceEntry[]): string {
  return imageCandidateFingerprint([...entries].map(({ candidateId, fingerprint }) => ({ candidateId, fingerprint })).sort((left, right) => left.candidateId.localeCompare(right.candidateId)))
}
function assertIssuanceEvent(event: unknown): asserts event is ImageCandidateIssuanceEvent {
  if (!isRecord(event) || event.type !== 'connector.artifact.candidates_issued' || event.connectorId !== IMAGE_TTI_CONNECTOR_ID || !isIdentifier(event.product) || !isIdentifier(event.workspaceId) || !isIdentifier(event.actor) || !isIdentifier(event.correlationId) || !Array.isArray(event.scopes) || event.scopes.length !== 1 || event.scopes[0] !== IMAGE_SCOPE || event.costCapCents !== 0 || !Number.isSafeInteger(event.requestedItems) || !isTimestamp(event.occurredAt) || !isRecord(event.detail)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  const detail = event.detail
  if (!isHash(detail.candidateSetDigest) || !Number.isSafeInteger(detail.candidateCount) || detail.publication !== 'blocked' || !isHash(detail.runAuditHash) || !Array.isArray(detail.candidates) || detail.candidates.length < 1 || detail.candidates.length > MAX_SYNTHETIC_IMAGE_CANDIDATES || detail.candidateCount !== detail.candidates.length || event.requestedItems !== detail.candidates.length) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
  for (const entry of detail.candidates) {
    if (!isRecord(entry) || !CANDIDATE_ID_PATTERN.test(String(entry.candidateId)) || !isHash(entry.fingerprint) || !isTimestamp(entry.reviewExpiresAt) || new Date(event.occurredAt).getTime() >= new Date(entry.reviewExpiresAt).getTime()) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_EXPIRED')
  }
  if (new Set(detail.candidates.map((entry) => entry.candidateId)).size !== detail.candidates.length || detail.candidateSetDigest !== candidateSetDigest(detail.candidates)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_EVENT')
}
function receiptFrom(value: unknown): StoredCandidateReceipt | null {
  if (!isRecord(value) || value.schema !== 'gcl-image-candidate-v1' || !CANDIDATE_ID_PATTERN.test(String(value.candidateId)) || !isIdentifier(value.correlationId) || value.publication !== 'blocked' || !isHash(value.issuanceAuditHash) || !isHash(value.runAuditHash) || !isTimestamp(value.issuanceOccurredAt) || !isTimestamp(value.reviewExpiresAt) || !isHash(value.candidateFingerprint)) return null
  return value as unknown as StoredCandidateReceipt
}
function receiptFor(event: ImageCandidateIssuanceEvent, entry: ImageCandidateIssuanceEntry, issuanceAuditHash: string): StoredCandidateReceipt {
  return { schema: 'gcl-image-candidate-v1', candidateId: entry.candidateId, correlationId: event.correlationId, publication: 'blocked', issuanceAuditHash, runAuditHash: event.detail.runAuditHash, issuanceOccurredAt: event.occurredAt, reviewExpiresAt: entry.reviewExpiresAt, candidateFingerprint: entry.fingerprint }
}
function sourceRun(records: readonly unknown[], event: ImageCandidateIssuanceEvent): void {
  const source = verifyAuditChain(records).find((record) => record.hash === event.detail.runAuditHash)?.event
  if (!source || source.type !== 'connector.run.succeeded' || source.connectorId !== IMAGE_TTI_CONNECTOR_ID || source.product !== event.product || source.workspaceId !== event.workspaceId || source.actor !== event.actor || source.correlationId !== event.correlationId || source.requestedItems !== event.requestedItems || !Array.isArray(source.scopes) || source.scopes.length !== 1 || source.scopes[0] !== IMAGE_SCOPE || !isRecord(source.detail) || source.detail[IMAGE_CANDIDATE_SET_AUDIT_FIELD] !== event.detail.candidateSetDigest) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_LINEAGE_INVALID')
}
function receiptAudit(records: readonly unknown[], receipt: StoredCandidateReceipt): void {
  const issuance = verifyAuditChain(records).find((record) => record.hash === receipt.issuanceAuditHash)?.event
  try {
    assertIssuanceEvent(issuance)
    const entry = issuance.detail.candidates.find((candidate) => candidate.candidateId === receipt.candidateId)
    if (!entry || issuance.correlationId !== receipt.correlationId || issuance.detail.runAuditHash !== receipt.runAuditHash || issuance.occurredAt !== receipt.issuanceOccurredAt || entry.fingerprint !== receipt.candidateFingerprint || entry.reviewExpiresAt !== receipt.reviewExpiresAt) throw new Error()
    sourceRun(records, issuance)
  } catch { throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID') }
}
function proofFor(receipt: StoredCandidateReceipt): ImageCandidateIssuanceProof {
  return { issuanceAuditHash: receipt.issuanceAuditHash, runAuditHash: receipt.runAuditHash, issuanceOccurredAt: receipt.issuanceOccurredAt, reviewExpiresAt: receipt.reviewExpiresAt, candidateFingerprint: receipt.candidateFingerprint }
}
function candidateReceipt(candidate: SyntheticImageCandidate, receipts: readonly StoredCandidateReceipt[]): StoredCandidateReceipt {
  assertSyntheticImageCandidate(candidate)
  const receipt = receipts.find((item) => item.candidateId === candidate.candidateId && item.correlationId === candidate.scope.correlationId)
  if (!receipt || receipt.candidateFingerprint !== imageCandidateFingerprint(candidate) || receipt.reviewExpiresAt !== candidate.ownerReview.reviewExpiresAt) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
  return receipt
}

export class PrismaImageCandidateLedger implements ImageCandidateLedger {
  constructor(private readonly prisma: GclPersistence) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    assertIssuanceEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const [auditRecords, candidateRecords] = await Promise.all([
        transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { values: true } }),
        transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID }, select: { values: true } }),
      ])
      sourceRun(auditRecords.map((record) => record.values), event)
      const existing = candidateRecords.map((record) => receiptFrom(record.values))
      if (existing.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
      if (existing.some((receipt) => receipt && receipt.correlationId === event.correlationId && event.detail.candidates.some((candidate) => candidate.candidateId === receipt.candidateId))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
      const audit = await appendAuditEvent(transaction, event)
      for (const entry of event.detail.candidates) {
        await transaction.record.create({ data: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID, values: receiptFor(event, entry, audit.hash), status: 'issued', createdBy: 'gcl-image-candidate' } })
      }
      return audit
    })
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    assertSyntheticImageCandidate(candidate)
    const { receipts, audits } = await this.prisma.$transaction(async (transaction) => ({
      receipts: await transaction.record.findMany({ where: { product: candidate.scope.product, workspaceId: candidate.scope.workspaceId, moduleId: GCL_IMAGE_CANDIDATE_MODULE_ID }, select: { values: true } }),
      audits: await transaction.record.findMany({ where: { product: candidate.scope.product, workspaceId: candidate.scope.workspaceId, moduleId: GCL_AUDIT_MODULE_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { values: true } }),
    }))
    const stored = receipts.map((record) => receiptFrom(record.values))
    if (stored.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
    const receipt = candidateReceipt(candidate, stored.filter((item): item is StoredCandidateReceipt => Boolean(item)))
    receiptAudit(audits.map((record) => record.values), receipt)
    return proofFor(receipt)
  }
}

export class InMemoryImageCandidateLedger implements ImageCandidateLedger {
  private readonly receipts = new Map<string, StoredCandidateReceipt>()
  constructor(private readonly auditLog: AuditLog & { entries?: readonly unknown[]; imageEntries?: readonly unknown[] }) {}

  async appendIssuance(event: ImageCandidateIssuanceEvent): Promise<{ hash: string }> {
    assertIssuanceEvent(event)
    const entries = this.auditLog.imageEntries ?? this.auditLog.entries
    if (!entries || typeof this.auditLog.append !== 'function') throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
    sourceRun(entries, event)
    if (event.detail.candidates.some((candidate) => this.receipts.has(`${event.correlationId}:${candidate.candidateId}`))) throw new ConnectorInputError('IMAGE_CANDIDATE_ALREADY_ISSUED')
    const result = await this.auditLog.append(event)
    if (!isRecord(result) || !isHash(result.hash)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
    for (const entry of event.detail.candidates) this.receipts.set(`${event.correlationId}:${entry.candidateId}`, receiptFor(event, entry, result.hash))
    return { hash: result.hash }
  }

  async assertIssued(candidate: SyntheticImageCandidate): Promise<ImageCandidateIssuanceProof> {
    const receipt = candidateReceipt(candidate, [...this.receipts.values()])
    const entries = this.auditLog.imageEntries ?? this.auditLog.entries
    if (!entries) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
    receiptAudit(entries, receipt)
    return proofFor(receipt)
  }
}
