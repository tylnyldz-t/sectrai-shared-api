import { SyntheticReviewIntegrityError } from './errors.js'
import { createSyntheticPlanIntegrity, deepFreeze, isCanonicalJsonData, verifiesSyntheticPlanIntegrity, type SyntheticPlanIntegrity } from './plan-integrity.js'
import { createSyntheticReviewReceipt, verifiesSyntheticReviewReceipt, type SyntheticReviewReceipt } from './review-receipt.js'

export type SyntheticReviewSnapshot = {
  payload: Record<string, unknown>
  integrity: SyntheticPlanIntegrity
  reviewReceipt: SyntheticReviewReceipt
}

type ReviewScope = { product: string; workspaceId: string }
type CreateSyntheticReviewSnapshotInput = {
  connectorId: string
  scope: ReviewScope
  payload: Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key))
}

function scopeMatches(value: unknown, scope: ReviewScope): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return exactKeys(candidate, ['product', 'workspaceId']) && candidate.product === scope.product && candidate.workspaceId === scope.workspaceId
}

/**
 * A snapshot payload must embed exactly the connector and scope that its
 * receipt claims. This makes a receipt from another connector or workspace
 * unusable when grafted onto otherwise valid plan data.
 */
function payloadMatchesReceipt(payload: unknown, receipt: SyntheticReviewReceipt): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isCanonicalJsonData(payload)) return false
  const candidate = payload as Record<string, unknown>
  return candidate.connectorId === receipt.connectorId && scopeMatches(candidate.scope, receipt.scope)
}

/**
 * Creates the one review-boundary envelope for a synthetic plan. It is pure
 * data and deliberately contains no execution, transport, file, or publish
 * capability.
 */
export function createSyntheticReviewSnapshot(input: CreateSyntheticReviewSnapshotInput): SyntheticReviewSnapshot {
  const integrity = createSyntheticPlanIntegrity(input.payload)
  const reviewReceipt = createSyntheticReviewReceipt({ connectorId: input.connectorId, scope: input.scope, planIntegrity: integrity })
  const snapshot = { payload: input.payload, integrity, reviewReceipt }
  if (!verifiesSyntheticReviewSnapshot(snapshot)) throw new SyntheticReviewIntegrityError('SYNTHETIC_REVIEW_SNAPSHOT_INVALID')
  return deepFreeze(snapshot)
}

/**
 * Verifies the plan data, its digest, and the receipt binding together. Review
 * consumers should use this rather than treating a receipt alone as proof of
 * the displayed payload.
 */
export function verifiesSyntheticReviewSnapshot(value: unknown): value is SyntheticReviewSnapshot {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    if (!exactKeys(candidate, ['payload', 'integrity', 'reviewReceipt'])) return false
    if (!verifiesSyntheticReviewReceipt(candidate.reviewReceipt)) return false
    const receipt = candidate.reviewReceipt
    if (!payloadMatchesReceipt(candidate.payload, receipt)) return false
    const integrity = candidate.integrity
    if (!verifiesSyntheticPlanIntegrity(integrity, candidate.payload)) return false
    return receipt.planPayloadSha256 === integrity.payloadSha256
  } catch {
    return false
  }
}

/** Reject malformed, mismatched, or execution-capable review data at display time. */
export function assertSyntheticReviewSnapshot(value: unknown): asserts value is SyntheticReviewSnapshot {
  if (!verifiesSyntheticReviewSnapshot(value)) throw new SyntheticReviewIntegrityError('SYNTHETIC_REVIEW_SNAPSHOT_INVALID')
}
