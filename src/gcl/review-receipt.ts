import { frozenCanonicalJsonCopy, frozenCanonicalJsonRecord, isSyntheticPlanIntegrity, syntheticPlanSha256, type SyntheticPlanIntegrity } from './plan-integrity.js'
import { SyntheticReviewIntegrityError } from './errors.js'
import { LIVE_DISABLED, type LiveDisabled } from './safety.js'

export const SYNTHETIC_REVIEW_RECEIPT_CONTRACT = 'gcl.synthetic-review-receipt.v1' as const

type ReviewScope = { product: string; workspaceId: string }

export type SyntheticReviewReceipt = {
  contract: typeof SYNTHETIC_REVIEW_RECEIPT_CONTRACT
  receiptId: string
  connectorId: string
  scope: ReviewScope
  liveMode: LiveDisabled
  planPayloadSha256: string
  ownerReview: 'REQUIRED'
  execution: 'NOT_EXECUTED'
  externalEffects: {
    network: 'DISABLED_NO_TRANSPORT'
    process: 'DISABLED_NO_LAUNCHER'
    artifactWrite: 'DISABLED_NO_FILE'
    publication: 'DISABLED_NOT_PUBLISHED'
  }
}

type ReviewReceiptInput = {
  connectorId: string
  scope: ReviewScope
  planIntegrity: SyntheticPlanIntegrity
}

const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/
const PRODUCT_PATTERN = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function receiptPayload({ connectorId, scope, planIntegrity }: ReviewReceiptInput): Omit<SyntheticReviewReceipt, 'receiptId'> {
  return {
    contract: SYNTHETIC_REVIEW_RECEIPT_CONTRACT,
    connectorId,
    scope: { product: scope.product, workspaceId: scope.workspaceId },
    liveMode: LIVE_DISABLED,
    planPayloadSha256: planIntegrity.payloadSha256,
    ownerReview: 'REQUIRED',
    execution: 'NOT_EXECUTED',
    externalEffects: {
      network: 'DISABLED_NO_TRANSPORT',
      process: 'DISABLED_NO_LAUNCHER',
      artifactWrite: 'DISABLED_NO_FILE',
      publication: 'DISABLED_NOT_PUBLISHED',
    },
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key))
}

function reviewScope(value: unknown): ReviewScope | null {
  const scope = frozenCanonicalJsonRecord(value)
  return scope && exactKeys(scope, ['product', 'workspaceId']) && typeof scope.product === 'string' && PRODUCT_PATTERN.test(scope.product) &&
    typeof scope.workspaceId === 'string' && WORKSPACE_PATTERN.test(scope.workspaceId)
    ? { product: scope.product, workspaceId: scope.workspaceId }
    : null
}

function reviewReceiptInput(value: unknown): ReviewReceiptInput | null {
  const input = frozenCanonicalJsonRecord(value)
  if (!input || !exactKeys(input, ['connectorId', 'scope', 'planIntegrity']) ||
    typeof input.connectorId !== 'string' || !CONNECTOR_ID_PATTERN.test(input.connectorId)) return null
  const scope = reviewScope(input.scope)
  const planIntegrity = frozenCanonicalJsonRecord(input.planIntegrity)
  if (!scope || !planIntegrity || !isSyntheticPlanIntegrity(planIntegrity)) return null
  return {
    connectorId: input.connectorId,
    scope,
    planIntegrity,
  }
}

/**
 * A pure, scope-bound receipt for a synthetic review snapshot. It is data
 * only: it neither sends a hand-off nor authorises a later executor.
 */
export function createSyntheticReviewReceipt(input: ReviewReceiptInput): SyntheticReviewReceipt {
  const safeInput = reviewReceiptInput(input)
  if (!safeInput) throw new SyntheticReviewIntegrityError('SYNTHETIC_REVIEW_RECEIPT_INVALID')
  const payload = receiptPayload(safeInput)
  return frozenCanonicalJsonCopy<SyntheticReviewReceipt>({ ...payload, receiptId: `synthetic-review-${syntheticPlanSha256(payload).slice(0, 24)}` })
}

/** Validates every static non-execution control and the deterministic receipt id. */
export function verifiesSyntheticReviewReceipt(value: unknown): value is SyntheticReviewReceipt {
  const candidate = frozenCanonicalJsonRecord(value)
  if (!candidate) return false
  if (!exactKeys(candidate, ['contract', 'receiptId', 'connectorId', 'scope', 'liveMode', 'planPayloadSha256', 'ownerReview', 'execution', 'externalEffects'])) return false
  if (candidate.contract !== SYNTHETIC_REVIEW_RECEIPT_CONTRACT || typeof candidate.receiptId !== 'string' ||
    typeof candidate.connectorId !== 'string' || !CONNECTOR_ID_PATTERN.test(candidate.connectorId) ||
    candidate.liveMode !== LIVE_DISABLED || typeof candidate.planPayloadSha256 !== 'string' || !SHA256_PATTERN.test(candidate.planPayloadSha256) ||
    candidate.ownerReview !== 'REQUIRED' || candidate.execution !== 'NOT_EXECUTED') return false
  const scope = reviewScope(candidate.scope)
  if (!scope) return false
  const externalEffects = frozenCanonicalJsonRecord(candidate.externalEffects)
  if (!externalEffects) return false
  if (!exactKeys(externalEffects, ['network', 'process', 'artifactWrite', 'publication']) ||
    externalEffects.network !== 'DISABLED_NO_TRANSPORT' || externalEffects.process !== 'DISABLED_NO_LAUNCHER' ||
    externalEffects.artifactWrite !== 'DISABLED_NO_FILE' || externalEffects.publication !== 'DISABLED_NOT_PUBLISHED') return false
  const payload = receiptPayload({
    connectorId: candidate.connectorId,
    scope: { product: scope.product, workspaceId: scope.workspaceId },
    planIntegrity: { contract: 'gcl.synthetic-plan-integrity.v1', payloadSha256: candidate.planPayloadSha256, content: 'DATA_ONLY_CANONICAL_JSON', mutation: 'DEEP_FROZEN' },
  })
  return candidate.receiptId === `synthetic-review-${syntheticPlanSha256(payload).slice(0, 24)}`
}

/** Reject a corrupted or execution-capable receipt at the review boundary. */
export function assertSyntheticReviewReceipt(value: unknown): asserts value is SyntheticReviewReceipt {
  if (!verifiesSyntheticReviewReceipt(value)) throw new SyntheticReviewIntegrityError('SYNTHETIC_REVIEW_RECEIPT_INVALID')
}
