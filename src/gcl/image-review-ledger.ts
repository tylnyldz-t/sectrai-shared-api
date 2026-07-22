import { appendAuditEvent, GCL_AUDIT_MODULE_ID, verifyAuditChain } from './image-audit.js'
import { ConnectorInputError, ConnectorUnavailableError } from './errors.js'
import { IMAGE_CANDIDATE_SET_AUDIT_FIELD, IMAGE_TTI_CONNECTOR_ID } from './image.js'
import type { GclPersistence } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_IMAGE_OWNER_REVIEW_MODULE_ID = 'gcl-image-owner-review'

const IMAGE_SCOPE = 'image:generate'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
export type ImageOwnerReviewDecisionEvent = ConnectorAuditEvent & { type: 'connector.artifact.owner_liked' | 'connector.artifact.owner_rejected'; actor: string; correlationId: string }
export type ImageOwnerReviewDecisionProof = { auditHash: string; issuanceAuditHash: string; runAuditHash: string; reviewExpiresAt: string; candidateFingerprint: string }
export interface ImageOwnerReviewLedger {
  appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }>
  assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof>
}
type StoredReviewReceipt = ImageOwnerReviewDecisionProof & {
  schema: 'gcl-image-owner-review-v1'
  candidateId: string
  correlationId: string
  decision: 'liked' | 'rejected'
  publication: 'blocked'
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function isHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9:_@. -]{1,160}$/.test(value) }
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}
function detail(event: ImageOwnerReviewDecisionEvent): Record<string, unknown> { return event.detail }
function assertDecisionEvent(event: unknown): asserts event is ImageOwnerReviewDecisionEvent {
  if (!isRecord(event) || (event.type !== 'connector.artifact.owner_liked' && event.type !== 'connector.artifact.owner_rejected') || event.connectorId !== IMAGE_TTI_CONNECTOR_ID || !isIdentifier(event.product) || !isIdentifier(event.workspaceId) || !isIdentifier(event.actor) || !isIdentifier(event.correlationId) || !Array.isArray(event.scopes) || event.scopes.length !== 1 || event.scopes[0] !== IMAGE_SCOPE || event.costCapCents !== 0 || event.requestedItems !== 1 || !isTimestamp(event.occurredAt) || !isRecord(event.detail)) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
  const value = event.detail
  if (!CANDIDATE_ID_PATTERN.test(String(value.candidateId)) || !isHash(value.candidateFingerprint) || !isTimestamp(value.reviewExpiresAt) || !isIdentifier(value.maker) || value.publication !== 'blocked' || !isHash(value.issuanceAuditHash) || !isHash(value.runAuditHash) || (event.type === 'connector.artifact.owner_liked' && (typeof value.artifactId !== 'string' || value.ownerReview !== 'liked')) || (event.type === 'connector.artifact.owner_rejected' && (typeof value.reviewId !== 'string' || value.ownerReview !== 'rejected' || !['NOT_SUITABLE', 'SAFETY_CONCERN', 'NEEDS_REVISION'].includes(String(value.reason))))) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_EVENT')
}
function receiptFor(event: ImageOwnerReviewDecisionEvent, auditHash: string): StoredReviewReceipt {
  const value = detail(event)
  return { schema: 'gcl-image-owner-review-v1', candidateId: value.candidateId as string, correlationId: event.correlationId, decision: event.type === 'connector.artifact.owner_liked' ? 'liked' : 'rejected', publication: 'blocked', auditHash, issuanceAuditHash: value.issuanceAuditHash as string, runAuditHash: value.runAuditHash as string, reviewExpiresAt: value.reviewExpiresAt as string, candidateFingerprint: value.candidateFingerprint as string }
}
function receiptFrom(value: unknown): StoredReviewReceipt | null {
  if (!isRecord(value) || value.schema !== 'gcl-image-owner-review-v1' || !CANDIDATE_ID_PATTERN.test(String(value.candidateId)) || !isIdentifier(value.correlationId) || (value.decision !== 'liked' && value.decision !== 'rejected') || value.publication !== 'blocked' || !isHash(value.auditHash) || !isHash(value.issuanceAuditHash) || !isHash(value.runAuditHash) || !isTimestamp(value.reviewExpiresAt) || !isHash(value.candidateFingerprint)) return null
  return value as unknown as StoredReviewReceipt
}
function sourceAndIssuance(records: readonly unknown[], event: ImageOwnerReviewDecisionEvent): void {
  const chain = verifyAuditChain(records)
  const value = detail(event)
  const issuance = chain.find((record) => record.hash === value.issuanceAuditHash)?.event
  if (!issuance || issuance.type !== 'connector.artifact.candidates_issued' || issuance.connectorId !== IMAGE_TTI_CONNECTOR_ID || issuance.product !== event.product || issuance.workspaceId !== event.workspaceId || issuance.correlationId !== event.correlationId || issuance.actor !== value.maker || !isRecord(issuance.detail)) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
  const issuanceDetail = issuance.detail
  if (!Array.isArray(issuanceDetail.candidates) || issuanceDetail.publication !== 'blocked' || issuanceDetail.runAuditHash !== value.runAuditHash || typeof issuanceDetail.candidateSetDigest !== 'string') throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
  const candidate = issuanceDetail.candidates.find((entry) => isRecord(entry) && entry.candidateId === value.candidateId)
  if (!isRecord(candidate) || candidate.fingerprint !== value.candidateFingerprint || candidate.reviewExpiresAt !== value.reviewExpiresAt || new Date(event.occurredAt).getTime() < new Date(issuance.occurredAt).getTime() || new Date(event.occurredAt).getTime() >= new Date(String(candidate.reviewExpiresAt)).getTime()) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
  const source = chain.find((record) => record.hash === value.runAuditHash)?.event
  if (!source || source.type !== 'connector.run.succeeded' || source.connectorId !== IMAGE_TTI_CONNECTOR_ID || source.product !== event.product || source.workspaceId !== event.workspaceId || source.correlationId !== event.correlationId || source.actor !== value.maker || source.requestedItems !== issuance.requestedItems || !isRecord(source.detail) || source.detail[IMAGE_CANDIDATE_SET_AUDIT_FIELD] !== issuanceDetail.candidateSetDigest) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_DECISION_LINEAGE_INVALID')
}
function decisionKey(event: ImageOwnerReviewDecisionEvent): string { return `${event.product}:${event.workspaceId}:${event.correlationId}:${detail(event).candidateId}` }
function proofFor(receipt: StoredReviewReceipt): ImageOwnerReviewDecisionProof {
  return { auditHash: receipt.auditHash, issuanceAuditHash: receipt.issuanceAuditHash, runAuditHash: receipt.runAuditHash, reviewExpiresAt: receipt.reviewExpiresAt, candidateFingerprint: receipt.candidateFingerprint }
}
function receiptForEvent(receipt: StoredReviewReceipt, event: ImageOwnerReviewDecisionEvent): boolean {
  const expected = receiptFor(event, receipt.auditHash)
  return receipt.candidateId === expected.candidateId && receipt.correlationId === expected.correlationId && receipt.decision === expected.decision && receipt.publication === expected.publication && receipt.issuanceAuditHash === expected.issuanceAuditHash && receipt.runAuditHash === expected.runAuditHash && receipt.reviewExpiresAt === expected.reviewExpiresAt && receipt.candidateFingerprint === expected.candidateFingerprint
}
function assertReceipt(records: readonly unknown[], receipt: StoredReviewReceipt, event: ImageOwnerReviewDecisionEvent): ImageOwnerReviewDecisionProof {
  if (!receiptForEvent(receipt, event)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  const recorded = verifyAuditChain(records).find((record) => record.hash === receipt.auditHash)?.event
  try {
    assertDecisionEvent(recorded)
    if (JSON.stringify(recorded) !== JSON.stringify(event)) throw new Error()
    sourceAndIssuance(records, recorded)
  } catch { throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID') }
  return proofFor(receipt)
}

export class PrismaImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  constructor(private readonly prisma: GclPersistence) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    assertDecisionEvent(event)
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const [reviews, audits] = await Promise.all([
        transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID }, select: { values: true } }),
        transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { values: true } }),
      ])
      sourceAndIssuance(audits.map((record) => record.values), event)
      const receipts = reviews.map((record) => receiptFrom(record.values))
      if (receipts.some((receipt) => !receipt)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
      if (receipts.some((receipt) => receipt && decisionKey(event) === `${event.product}:${event.workspaceId}:${receipt.correlationId}:${receipt.candidateId}`)) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
      const audit = await appendAuditEvent(transaction, event)
      await transaction.record.create({ data: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID, values: receiptFor(event, audit.hash), status: 'terminal', createdBy: 'gcl-image-review' } })
      return audit
    })
  }

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    assertDecisionEvent(event)
    const { reviews, audits } = await this.prisma.$transaction(async (transaction) => ({
      reviews: await transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_IMAGE_OWNER_REVIEW_MODULE_ID }, select: { values: true } }),
      audits: await transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { values: true } }),
    }))
    const receipt = reviews.map((record) => receiptFrom(record.values)).find((item) => item && decisionKey(event) === `${event.product}:${event.workspaceId}:${item.correlationId}:${item.candidateId}`)
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertReceipt(audits.map((record) => record.values), receipt, event)
  }
}

export class InMemoryImageOwnerReviewLedger implements ImageOwnerReviewLedger {
  private readonly receipts = new Map<string, StoredReviewReceipt>()
  constructor(private readonly auditLog: AuditLog & { entries?: readonly unknown[]; imageEntries?: readonly unknown[] }) {}

  async appendDecision(event: ImageOwnerReviewDecisionEvent): Promise<{ hash: string }> {
    assertDecisionEvent(event)
    const entries = this.auditLog.imageEntries ?? this.auditLog.entries
    if (!entries || typeof this.auditLog.append !== 'function') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    sourceAndIssuance(entries, event)
    const key = decisionKey(event)
    if (this.receipts.has(key)) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_ALREADY_DECIDED')
    const result = await this.auditLog.append(event)
    if (!isRecord(result) || !isHash(result.hash)) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    this.receipts.set(key, receiptFor(event, result.hash))
    return { hash: result.hash }
  }

  async assertRecorded(event: ImageOwnerReviewDecisionEvent): Promise<ImageOwnerReviewDecisionProof> {
    assertDecisionEvent(event)
    const entries = this.auditLog.imageEntries ?? this.auditLog.entries
    if (!entries) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
    const receipt = this.receipts.get(decisionKey(event))
    if (!receipt) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
    return assertReceipt(entries, receipt, event)
  }
}
