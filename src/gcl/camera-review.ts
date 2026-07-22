import { appendVerifiedAuditEvent } from './audit.js'
import { ConnectorInputError, MakerCheckerError, OwnerGateError } from './errors.js'
import { intrinsicJsonStringify } from './intrinsics.js'
import type { AuditLog, ConnectorRunContext } from './types.js'
import {
  CAMERA_CONNECTOR_ID, CAMERA_LIVE_STATUS, CAMERA_REVIEW_RECEIPT_VERSION, CAMERA_SCOPE,
  type CameraObservationResult, type ReviewedCameraObservation, type SyntheticCameraReviewReceipt,
} from './camera-contract.js'
import {
  CAMERA_REVIEW_ID_PATTERN, SHA256_PATTERN, cameraReviewContext, canonicalIsoInstant, digest, exactObject,
  independentCameraReviewContext, localCameraOccurredAt, normalizedActor, requiredString, reviewActor,
  validateCameraObservationForReview,
} from './camera-boundary.js'

const CAMERA_REVIEW_RECEIPT_ID_PATTERN = /^synthetic-camera-review-receipt-[a-f0-9]{24}$/
type ReviewedDetails = Omit<ReviewedCameraObservation, 'reviewReceipt'>

function reviewState(decision: 'approved' | 'rejected'): ReviewedCameraObservation['ownerReview']['state'] {
  return decision === 'approved' ? 'APPROVED_FOR_SYNTHETIC_OBSERVATION_ONLY' : 'REJECTED_FOR_SYNTHETIC_OBSERVATION_ONLY'
}
function handoff(value: unknown): ReviewedCameraObservation['handoff'] {
  const candidate = exactObject(value, ['state', 'rawMediaIncluded', 'sent', 'automaticAction', 'notification', 'publication'], 'INVALID_CAMERA_REVIEW_RECEIPT_HANDOFF')
  if (candidate.state !== 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED' || candidate.rawMediaIncluded !== false || candidate.sent !== false || candidate.automaticAction !== false || candidate.notification !== 'NOT_SENT' || candidate.publication !== 'NOT_PUBLISHED') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT_HANDOFF')
  return { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', rawMediaIncluded: false, sent: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
}
function receiptMaterial(receipt: Omit<SyntheticCameraReviewReceipt, 'receiptId' | 'integrityDigest'>): Record<string, unknown> {
  return {
    version: receipt.version, scopeBinding: receipt.scopeBinding, reviewId: receipt.reviewId, observationDigest: receipt.observationDigest,
    reviewPacketIntegrityDigest: receipt.reviewPacketIntegrityDigest, reviewerDigest: receipt.reviewerDigest, decision: receipt.decision,
    occurredAt: receipt.occurredAt, mode: receipt.mode, liveStatus: receipt.liveStatus, disposition: receipt.disposition,
    rawMediaIncluded: receipt.rawMediaIncluded, automaticAction: receipt.automaticAction, notification: receipt.notification,
    publication: receipt.publication, auditHash: receipt.auditHash,
  }
}
function receiptFor(result: CameraObservationResult, reviewed: ReviewedDetails, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): SyntheticCameraReviewReceipt {
  const scope = cameraReviewContext(context)
  const material: Omit<SyntheticCameraReviewReceipt, 'receiptId' | 'integrityDigest'> = {
    version: CAMERA_REVIEW_RECEIPT_VERSION,
    scopeBinding: { productDigest: digest(scope.product), workspaceDigest: digest(scope.workspaceId) },
    reviewId: reviewed.reviewId,
    observationDigest: result.reviewPacket.observationDigest,
    reviewPacketIntegrityDigest: reviewed.reviewPacketIntegrityDigest,
    reviewerDigest: digest(reviewed.ownerReview.reviewer),
    decision: reviewed.decision,
    occurredAt: reviewed.ownerReview.occurredAt,
    mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION',
    rawMediaIncluded: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED', auditHash: reviewed.auditHash,
  }
  const integrityDigest = digest(intrinsicJsonStringify(receiptMaterial(material)))
  return { ...material, receiptId: `synthetic-camera-review-receipt-${digest(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`, integrityDigest }
}
function reviewedForReceipt(value: unknown): { reviewed: ReviewedDetails; receipt: unknown } {
  const candidate = exactObject(value, ['reviewId', 'decision', 'reviewPacketIntegrityDigest', 'ownerReview', 'handoff', 'auditHash', 'reviewReceipt'], 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD')
  const reviewId = requiredString(candidate.reviewId, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewPacketIntegrityDigest = requiredString(candidate.reviewPacketIntegrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const auditHash = requiredString(candidate.auditHash, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  if (!CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(reviewPacketIntegrityDigest) || !SHA256_PATTERN.test(auditHash) || (candidate.decision !== 'approved' && candidate.decision !== 'rejected')) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  const ownerReview = exactObject(candidate.ownerReview, ['state', 'reviewer', 'occurredAt'], 'INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  const reviewer = normalizedActor(ownerReview.reviewer)
  const occurredAt = canonicalIsoInstant(ownerReview.occurredAt, 'INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  if (!reviewer || reviewer !== ownerReview.reviewer || ownerReview.state !== reviewState(candidate.decision)) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  return {
    reviewed: { reviewId, decision: candidate.decision, reviewPacketIntegrityDigest, ownerReview: { state: reviewState(candidate.decision), reviewer, occurredAt }, handoff: handoff(candidate.handoff), auditHash },
    receipt: candidate.reviewReceipt,
  }
}
function reviewReceipt(value: unknown): SyntheticCameraReviewReceipt {
  const receipt = exactObject(value, ['version', 'receiptId', 'scopeBinding', 'reviewId', 'observationDigest', 'reviewPacketIntegrityDigest', 'reviewerDigest', 'decision', 'occurredAt', 'mode', 'liveStatus', 'disposition', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication', 'auditHash', 'integrityDigest'], 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD')
  const scope = exactObject(receipt.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE')
  const productDigest = requiredString(scope.productDigest, 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE', 64)
  const workspaceDigest = requiredString(scope.workspaceDigest, 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE', 64)
  const receiptId = requiredString(receipt.receiptId, 'INVALID_CAMERA_REVIEW_RECEIPT', 72)
  const reviewId = requiredString(receipt.reviewId, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const observationDigest = requiredString(receipt.observationDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewPacketIntegrityDigest = requiredString(receipt.reviewPacketIntegrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewerDigest = requiredString(receipt.reviewerDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const auditHash = requiredString(receipt.auditHash, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const integrityDigest = requiredString(receipt.integrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const occurredAt = canonicalIsoInstant(receipt.occurredAt, 'INVALID_CAMERA_REVIEW_RECEIPT')
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !CAMERA_REVIEW_RECEIPT_ID_PATTERN.test(receiptId) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(observationDigest) || !SHA256_PATTERN.test(reviewPacketIntegrityDigest) || !SHA256_PATTERN.test(reviewerDigest) || !SHA256_PATTERN.test(auditHash) || !SHA256_PATTERN.test(integrityDigest) || receipt.version !== CAMERA_REVIEW_RECEIPT_VERSION || (receipt.decision !== 'approved' && receipt.decision !== 'rejected') || receipt.mode !== 'SYNTHETIC' || receipt.liveStatus !== CAMERA_LIVE_STATUS || receipt.disposition !== 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION' || receipt.rawMediaIncluded !== false || receipt.automaticAction !== false || receipt.notification !== 'NOT_SENT' || receipt.publication !== 'NOT_PUBLISHED') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  return { version: CAMERA_REVIEW_RECEIPT_VERSION, receiptId, scopeBinding: { productDigest, workspaceDigest }, reviewId, observationDigest, reviewPacketIntegrityDigest, reviewerDigest, decision: receipt.decision, occurredAt, mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION', rawMediaIncluded: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED', auditHash, integrityDigest }
}

export function validateCameraReviewReceipt(sourceResult: unknown, value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): ReviewedCameraObservation {
  const source = validateCameraObservationForReview(sourceResult, context)
  const candidate = reviewedForReceipt(value)
  const receipt = reviewReceipt(candidate.receipt)
  const expected = receiptFor(source, candidate.reviewed, context)
  if (candidate.reviewed.reviewId !== source.reviewPacket.reviewId || candidate.reviewed.reviewPacketIntegrityDigest !== source.reviewPacket.integrityDigest) throw new ConnectorInputError('CAMERA_REVIEW_RECEIPT_PACKET_MISMATCH')
  if (receipt.integrityDigest !== digest(intrinsicJsonStringify(receiptMaterial(receipt))) || receipt.receiptId !== expected.receiptId || receipt.integrityDigest !== expected.integrityDigest) throw new ConnectorInputError('CAMERA_REVIEW_RECEIPT_INTEGRITY_MISMATCH')
  return { ...candidate.reviewed, reviewReceipt: expected }
}

export async function independentlyReviewCameraObservation(result: CameraObservationResult, decision: 'approved' | 'rejected', ownerApproved: boolean, reviewer: string, auditLog: AuditLog, context: ConnectorRunContext): Promise<ReviewedCameraObservation> {
  if (!ownerApproved) throw new OwnerGateError()
  if (decision !== 'approved' && decision !== 'rejected') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_DECISION')
  const reviewContext = independentCameraReviewContext(context)
  const normalizedReviewer = reviewActor(reviewer)
  if (normalizedReviewer === reviewContext.requestedBy) throw new MakerCheckerError('CAMERA_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  const source = validateCameraObservationForReview(result, reviewContext)
  const occurredAt = localCameraOccurredAt(reviewContext.now, 'INVALID_CAMERA_REVIEW_CLOCK')
  const audit = await appendVerifiedAuditEvent(auditLog, {
    type: 'connector.camera.owner_reviewed', connectorId: CAMERA_CONNECTOR_ID,
    product: reviewContext.product, workspaceId: reviewContext.workspaceId, requestedBy: reviewContext.requestedBy, checkedBy: normalizedReviewer,
    correlationId: reviewContext.correlationId, scopes: [CAMERA_SCOPE], costCapCents: reviewContext.costCapCents, requestedItems: reviewContext.requestedItems, occurredAt,
    detail: { reviewId: source.reviewPacket.reviewId, decision, observationDigest: source.reviewPacket.observationDigest, reviewPacketIntegrityDigest: source.reviewPacket.integrityDigest, rawMediaIncluded: false, action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED', handoff: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED' },
  })
  const reviewed: ReviewedDetails = {
    reviewId: source.reviewPacket.reviewId, decision, reviewPacketIntegrityDigest: source.reviewPacket.integrityDigest,
    ownerReview: { state: reviewState(decision), reviewer: normalizedReviewer, occurredAt },
    handoff: { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', rawMediaIncluded: false, sent: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' },
    auditHash: audit.hash,
  }
  return { ...reviewed, reviewReceipt: receiptFor(source, reviewed, reviewContext) }
}
