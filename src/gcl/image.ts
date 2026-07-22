import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError } from './errors.js'
import type { ImageCandidateIssuanceEvent, ImageCandidateIssuanceProof, ImageCandidateLedger } from './image-candidate-ledger.js'
import type { ImageOwnerReviewDecisionEvent, ImageOwnerReviewDecisionProof, ImageOwnerReviewLedger } from './image-review-ledger.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const IMAGE_TTI_CONNECTOR_ID = 'image-tti'
export const LIVE_DISABLED = 'LIVE_DISABLED' as const
export const IMAGE_CANDIDATE_SET_AUDIT_FIELD = 'syntheticCandidateSetDigest'
export const MAX_SYNTHETIC_IMAGE_CANDIDATES = 32

const IMAGE_SCOPE = 'image:generate'
const ID_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const FILTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const MAX_PROMPT_LENGTH = 1_000
const MIN_REVIEW_TTL_SECONDS = 60
const MAX_REVIEW_TTL_SECONDS = 86_400
const GRAPH_SHAPE = ['CheckpointLoaderSimple', 'CLIPTextEncode:positive', 'CLIPTextEncode:negative', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'] as const

export type ImageSize = 512 | 1024
export type TextToImageInput = { prompt: string; negativePrompt?: string; width?: ImageSize; height?: ImageSize }
export type FamilySafetyAssessment = { allowed: boolean; reason?: string }
export interface FamilySafetyFilter {
  readonly id: string
  assess(input: Readonly<TextToImageInput>): FamilySafetyAssessment
}

export type OwnerReview = {
  status: 'pending' | 'liked' | 'rejected'
  visibility: 'owner-only'
  publication: 'blocked'
  required: true
  reviewExpiresAt: string
}
export type ImageRejectionReason = 'NOT_SUITABLE' | 'SAFETY_CONCERN' | 'NEEDS_REVISION'
export type ImageCandidateScope = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId'>
export type ImageOwnerReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId' | 'now'>
export type ImageCandidateIssuanceContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'actor' | 'correlationId' | 'now'>

export type SyntheticComfySdxlPlan = {
  schema: 'creative-job-v1'
  provider: 'local-comfyui'
  type: 'image'
  modelFamily: 'sdxl'
  checkpoint: 'UNRESOLVED_SYNTHETIC_ONLY'
  graphShape: readonly (typeof GRAPH_SHAPE)[number][]
  promptDigest: string
  negativePromptDigest?: string
  dispatch: { performed: false; gate: typeof LIVE_DISABLED; network: 'not-attempted' }
}
export type SyntheticImageCandidate = {
  candidateId: string
  candidateIndex: number
  promptDigest: string
  negativePromptDigest?: string
  requestedBy: string
  scope: ImageCandidateScope
  width: ImageSize
  height: ImageSize
  mediaType: 'image/svg+xml'
  previewDataUri: string
  syntheticUri: string
  safety: { filterId: string; classification: 'family-safe' }
  creativeWorkerPlan: SyntheticComfySdxlPlan
  ownerReview: OwnerReview
}
export type OwnerLikedImageArtifact = {
  artifactId: string
  candidateId: string
  mediaType: 'image/svg+xml'
  previewDataUri: string
  syntheticUri: string
  ownerReview: Omit<OwnerReview, 'status'> & { status: 'liked'; actor: string; occurredAt: string }
  publication: 'blocked'
  auditHash: string
  issuanceAuditHash: string
  runAuditHash: string
}
export type OwnerRejectedImageReview = {
  reviewId: string
  candidateId: string
  ownerReview: Omit<OwnerReview, 'status'> & { status: 'rejected'; actor: string; occurredAt: string; reason: ImageRejectionReason }
  publication: 'blocked'
  auditHash: string
  issuanceAuditHash: string
  runAuditHash: string
}
export type TextToImageData = {
  mode: typeof LIVE_DISABLED
  candidates: SyntheticImageCandidate[]
  nextAction: 'INDEPENDENT_OWNER_LIKE_REQUIRED'
  automaticPublication: false
}
export type SyntheticImageTtiConnectorConfig = {
  liveMode?: string
  maxCostCapCents?: number
  maxItems?: number
  ownerReviewTtlSeconds?: number
  familySafetyFilter?: FamilySafetyFilter
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && ID_PATTERN.test(value) }
function isHash(value: unknown): value is string { return typeof value === 'string' && HASH_PATTERN.test(value) }
function isImageSize(value: unknown): value is ImageSize { return value === 512 || value === 1024 }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}
function currentDate(now: unknown, error: string): Date {
  if (typeof now !== 'function') throw new ConnectorInputError(error)
  const value = now()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new ConnectorInputError(error)
  return new Date(value.getTime())
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
}
function normalizedText(value: unknown, error: string): string {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const text = value.trim()
  if (!text || text.length > MAX_PROMPT_LENGTH || /\p{C}/u.test(text)) throw new ConnectorInputError(error)
  return text
}
function imageInput(value: unknown): Required<TextToImageInput> {
  if (!isRecord(value) || Object.keys(value).some((key) => !['prompt', 'negativePrompt', 'width', 'height'].includes(key))) throw new ConnectorInputError('INVALID_IMAGE_TTI_INPUT')
  const prompt = normalizedText(value.prompt, 'INVALID_IMAGE_TTI_PROMPT')
  const negativePrompt = value.negativePrompt === undefined ? '' : normalizedText(value.negativePrompt, 'INVALID_IMAGE_TTI_NEGATIVE_PROMPT')
  const width = value.width === undefined ? 1024 : value.width
  const height = value.height === undefined ? 1024 : value.height
  if (!isImageSize(width) || !isImageSize(height)) throw new ConnectorInputError('INVALID_IMAGE_TTI_DIMENSIONS')
  return { prompt, negativePrompt, width, height }
}
function sameGraphShape(value: unknown): boolean {
  return Array.isArray(value) && value.length === GRAPH_SHAPE.length && value.every((node, index) => node === GRAPH_SHAPE[index])
}
function requireContext(value: unknown, error: string): ConnectorRunContext {
  if (!isRecord(value) || !isIdentifier(value.product) || !isIdentifier(value.workspaceId) || !isIdentifier(value.actor) || !isIdentifier(value.correlationId) || value.ownerApproved !== true || !Array.isArray(value.scopes) || !value.scopes.includes(IMAGE_SCOPE) || !isPositiveInteger(value.costCapCents) || !isPositiveInteger(value.requestedItems) || typeof value.now !== 'function') throw new ConnectorInputError(error)
  return value as unknown as ConnectorRunContext
}
function requireIssuanceContext(value: unknown): ImageCandidateIssuanceContext {
  if (!isRecord(value) || !isIdentifier(value.product) || !isIdentifier(value.workspaceId) || !isIdentifier(value.actor) || !isIdentifier(value.correlationId) || typeof value.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  return value as unknown as ImageCandidateIssuanceContext
}
function requireReviewContext(value: unknown): ImageOwnerReviewContext {
  if (!isRecord(value) || !isIdentifier(value.product) || !isIdentifier(value.workspaceId) || !isIdentifier(value.correlationId) || typeof value.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  return value as unknown as ImageOwnerReviewContext
}

export function imageCandidateFingerprint(value: unknown): string { return digest(canonicalJson(value)) }

export function assertSyntheticImageCandidate(candidate: unknown): asserts candidate is SyntheticImageCandidate {
  if (!isRecord(candidate) || !CANDIDATE_ID_PATTERN.test(String(candidate.candidateId)) || !Number.isSafeInteger(candidate.candidateIndex) || (candidate.candidateIndex as number) < 0 || (candidate.candidateIndex as number) >= MAX_SYNTHETIC_IMAGE_CANDIDATES || !isHash(candidate.promptDigest) || (candidate.negativePromptDigest !== undefined && !isHash(candidate.negativePromptDigest)) || !isIdentifier(candidate.requestedBy) || !isRecord(candidate.scope) || !isIdentifier(candidate.scope.product) || !isIdentifier(candidate.scope.workspaceId) || !isIdentifier(candidate.scope.correlationId) || !isImageSize(candidate.width) || !isImageSize(candidate.height) || candidate.mediaType !== 'image/svg+xml' || typeof candidate.previewDataUri !== 'string' || !candidate.previewDataUri.startsWith('data:image/svg+xml;base64,') || candidate.syntheticUri !== `synthetic://gcl/${IMAGE_TTI_CONNECTOR_ID}/${candidate.candidateId}` || !isRecord(candidate.safety) || !FILTER_ID_PATTERN.test(String(candidate.safety.filterId)) || candidate.safety.classification !== 'family-safe' || !isRecord(candidate.creativeWorkerPlan) || candidate.creativeWorkerPlan.schema !== 'creative-job-v1' || candidate.creativeWorkerPlan.provider !== 'local-comfyui' || candidate.creativeWorkerPlan.type !== 'image' || candidate.creativeWorkerPlan.modelFamily !== 'sdxl' || candidate.creativeWorkerPlan.checkpoint !== 'UNRESOLVED_SYNTHETIC_ONLY' || !sameGraphShape(candidate.creativeWorkerPlan.graphShape) || candidate.creativeWorkerPlan.promptDigest !== candidate.promptDigest || (candidate.creativeWorkerPlan.negativePromptDigest !== undefined && candidate.creativeWorkerPlan.negativePromptDigest !== candidate.negativePromptDigest) || !isRecord(candidate.creativeWorkerPlan.dispatch) || candidate.creativeWorkerPlan.dispatch.performed !== false || candidate.creativeWorkerPlan.dispatch.gate !== LIVE_DISABLED || candidate.creativeWorkerPlan.dispatch.network !== 'not-attempted' || !isRecord(candidate.ownerReview) || candidate.ownerReview.status !== 'pending' || candidate.ownerReview.visibility !== 'owner-only' || candidate.ownerReview.publication !== 'blocked' || candidate.ownerReview.required !== true || !isTimestamp(candidate.ownerReview.reviewExpiresAt)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
}

export function imageCandidateSetDigest(candidates: readonly SyntheticImageCandidate[]): string {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_SYNTHETIC_IMAGE_CANDIDATES) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const entries = candidates.map((candidate) => {
    assertSyntheticImageCandidate(candidate)
    return { candidateId: candidate.candidateId, fingerprint: imageCandidateFingerprint(candidate) }
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  if (new Set(entries.map((entry) => entry.candidateId)).size !== entries.length) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  return imageCandidateFingerprint(entries)
}

export class BaselineFamilySafetyFilter implements FamilySafetyFilter {
  readonly id = 'baseline-family-safe-v1'
  readonly assess = (input: Readonly<TextToImageInput>): FamilySafetyAssessment => {
    const blocked = new Set(['adult', 'explicit', 'nude', 'naked', 'porn', 'sexual', 'gore', 'dismember', 'blood', 'weapon', 'gun', 'silah', 'çıplak', 'cinsel', 'pornografi', 'şiddet', 'vahşet'])
    const words = `${input.prompt} ${input.negativePrompt ?? ''}`.normalize('NFKC').toLocaleLowerCase('tr-TR').match(/[\p{L}\p{N}]+/gu) ?? []
    return words.some((word) => blocked.has(word)) ? { allowed: false, reason: 'FAMILY_SAFETY_FILTER_REJECTED' } : { allowed: true }
  }
}
const baselineFilter = new BaselineFamilySafetyFilter()

function familySafetyAssessment(policy: FamilySafetyFilter | undefined, input: Required<TextToImageInput>): string {
  const filters = [baselineFilter, ...(policy ? [policy] : [])]
  for (const filter of filters) {
    if (!FILTER_ID_PATTERN.test(filter.id) || typeof filter.assess !== 'function') throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
    let result: FamilySafetyAssessment
    try { result = filter.assess(Object.freeze({ ...input })) } catch { throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_UNAVAILABLE') }
    if (!isRecord(result) || typeof result.allowed !== 'boolean' || (result.reason !== undefined && typeof result.reason !== 'string')) throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
    if (!result.allowed) throw new FamilySafetyError(typeof result.reason === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(result.reason) ? result.reason : 'FAMILY_SAFETY_FILTER_REJECTED')
  }
  return policy?.id ?? baselineFilter.id
}
function previewDataUri(candidateId: string, width: ImageSize, height: ImageSize): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Synthetic image candidate"><rect width="100%" height="100%" fill="#172554"/><text x="50%" y="50%" text-anchor="middle" fill="#dbeafe" font-family="system-ui" font-size="24">SYNTHETIC · ${candidateId}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export class SyntheticImageTtiConnector implements Connector<TextToImageInput, TextToImageData> {
  readonly id = IMAGE_TTI_CONNECTOR_ID
  readonly kind = 'media-generation' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [IMAGE_SCOPE] as const
  readonly #config: SyntheticImageTtiConnectorConfig

  constructor(config: SyntheticImageTtiConnectorConfig = {}) { this.#config = { ...config } }

  private configured(context: ConnectorRunContext): { reviewTtl: number; policy?: FamilySafetyFilter } {
    const { liveMode = LIVE_DISABLED, maxCostCapCents, maxItems, ownerReviewTtlSeconds, familySafetyFilter } = this.#config
    if (liveMode !== LIVE_DISABLED) throw new ConnectorUnavailableError('IMAGE_TTI_LIVE_DISABLED')
    if (!isPositiveInteger(maxCostCapCents) || !isPositiveInteger(maxItems) || maxItems > MAX_SYNTHETIC_IMAGE_CANDIDATES) throw new ConnectorUnavailableError('IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (!isPositiveInteger(ownerReviewTtlSeconds) || ownerReviewTtlSeconds < MIN_REVIEW_TTL_SECONDS || ownerReviewTtlSeconds > MAX_REVIEW_TTL_SECONDS) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_TTL_NOT_CONFIGURED')
    if (context.costCapCents > maxCostCapCents) throw new CostCapError()
    if (context.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    return { reviewTtl: ownerReviewTtlSeconds, policy: familySafetyFilter }
  }

  preflight(input: TextToImageInput, context: ConnectorRunContext): void {
    const runContext = requireContext(context, 'INVALID_IMAGE_TTI_CONTEXT')
    const { policy } = this.configured(runContext)
    currentDate(runContext.now, 'INVALID_IMAGE_TTI_CONTEXT')
    familySafetyAssessment(policy, imageInput(input))
  }

  async run(input: TextToImageInput, context: ConnectorRunContext): Promise<ConnectorResult<TextToImageData>> {
    const runContext = requireContext(context, 'INVALID_IMAGE_TTI_CONTEXT')
    const { reviewTtl, policy } = this.configured(runContext)
    const normalized = imageInput(input)
    const filterId = familySafetyAssessment(policy, normalized)
    const generatedAt = currentDate(runContext.now, 'INVALID_IMAGE_TTI_CONTEXT')
    const expiresAt = new Date(generatedAt.getTime() + reviewTtl * 1_000).toISOString()
    const promptDigest = digest(normalized.prompt)
    const negativePromptDigest = normalized.negativePrompt ? digest(normalized.negativePrompt) : undefined
    const scope = { product: runContext.product, workspaceId: runContext.workspaceId, correlationId: runContext.correlationId }
    const plan: SyntheticComfySdxlPlan = {
      schema: 'creative-job-v1', provider: 'local-comfyui', type: 'image', modelFamily: 'sdxl', checkpoint: 'UNRESOLVED_SYNTHETIC_ONLY', graphShape: [...GRAPH_SHAPE], promptDigest,
      ...(negativePromptDigest ? { negativePromptDigest } : {}), dispatch: { performed: false, gate: LIVE_DISABLED, network: 'not-attempted' },
    }
    const candidates = Array.from({ length: runContext.requestedItems }, (_, candidateIndex): SyntheticImageCandidate => {
      const candidateId = `synthetic-image-${digest(JSON.stringify({ scope, actor: runContext.actor, promptDigest, negativePromptDigest, width: normalized.width, height: normalized.height, expiresAt, candidateIndex })).slice(0, 20)}`
      return {
        candidateId, candidateIndex, promptDigest, ...(negativePromptDigest ? { negativePromptDigest } : {}), requestedBy: runContext.actor, scope, width: normalized.width, height: normalized.height,
        mediaType: 'image/svg+xml', previewDataUri: previewDataUri(candidateId, normalized.width, normalized.height), syntheticUri: `synthetic://gcl/${this.id}/${candidateId}`,
        safety: { filterId, classification: 'family-safe' }, creativeWorkerPlan: plan,
        ownerReview: { status: 'pending', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: expiresAt },
      }
    })
    return {
      data: { mode: LIVE_DISABLED, candidates, nextAction: 'INDEPENDENT_OWNER_LIKE_REQUIRED', automaticPublication: false },
      provenance: { connectorId: this.id, source: 'synthetic-image-tti', retrievedAt: generatedAt.toISOString(), untrustedContent: { source: 'owner-supplied-tti-prompt', value: { promptDigest, ...(negativePromptDigest ? { negativePromptDigest } : {}) }, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' } },
      confidence: 0,
    }
  }

  successAuditDetail(result: ConnectorResult<TextToImageData>): { [IMAGE_CANDIDATE_SET_AUDIT_FIELD]: string } {
    return { [IMAGE_CANDIDATE_SET_AUDIT_FIELD]: imageCandidateSetDigest(result.data.candidates) }
  }
}

function auditHash(value: unknown, error: string): string {
  if (!isRecord(value) || !isHash(value.hash)) throw new ConnectorUnavailableError(error)
  return value.hash
}
function issuanceProof(value: unknown): ImageCandidateIssuanceProof {
  if (!isRecord(value) || !isHash(value.issuanceAuditHash) || !isHash(value.runAuditHash) || !isTimestamp(value.issuanceOccurredAt) || !isTimestamp(value.reviewExpiresAt) || !isHash(value.candidateFingerprint)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
  return value as unknown as ImageCandidateIssuanceProof
}
function decisionProof(value: unknown, auditHashValue: string, issuance: ImageCandidateIssuanceProof): ImageOwnerReviewDecisionProof {
  if (!isRecord(value) || value.auditHash !== auditHashValue || value.issuanceAuditHash !== issuance.issuanceAuditHash || value.runAuditHash !== issuance.runAuditHash || value.reviewExpiresAt !== issuance.reviewExpiresAt || value.candidateFingerprint !== issuance.candidateFingerprint) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
  return value as unknown as ImageOwnerReviewDecisionProof
}
function candidateInContext(candidate: SyntheticImageCandidate, context: ImageOwnerReviewContext, occurredAt: Date): void {
  if (candidate.scope.product !== context.product || candidate.scope.workspaceId !== context.workspaceId || candidate.scope.correlationId !== context.correlationId) throw new ConnectorInputError('IMAGE_REVIEW_SCOPE_MISMATCH')
  if (occurredAt.getTime() >= new Date(candidate.ownerReview.reviewExpiresAt).getTime()) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_EXPIRED')
}

export async function issueSyntheticImageCandidates(result: ConnectorResult<TextToImageData>, candidateLedger: ImageCandidateLedger, context: ImageCandidateIssuanceContext): Promise<{ issuanceAuditHash: string }> {
  const issuanceContext = requireIssuanceContext(context)
  if (!isRecord(result) || !isRecord(result.data) || result.data.mode !== LIVE_DISABLED || !Array.isArray(result.data.candidates) || !isRecord(result.provenance) || !isHash(result.provenance.auditHash)) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_REQUIRES_GOVERNED_RESULT')
  const candidates = result.data.candidates as SyntheticImageCandidate[]
  const occurredAt = currentDate(issuanceContext.now, 'INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  const entries = candidates.map((candidate) => {
    assertSyntheticImageCandidate(candidate)
    if (candidate.requestedBy !== issuanceContext.actor || candidate.scope.product !== issuanceContext.product || candidate.scope.workspaceId !== issuanceContext.workspaceId || candidate.scope.correlationId !== issuanceContext.correlationId) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_SCOPE_MISMATCH')
    if (occurredAt.getTime() >= new Date(candidate.ownerReview.reviewExpiresAt).getTime()) throw new ConnectorInputError('IMAGE_CANDIDATE_ISSUANCE_EXPIRED')
    return { candidateId: candidate.candidateId, fingerprint: imageCandidateFingerprint(candidate), reviewExpiresAt: candidate.ownerReview.reviewExpiresAt }
  })
  const event: ImageCandidateIssuanceEvent = {
    type: 'connector.artifact.candidates_issued', connectorId: IMAGE_TTI_CONNECTOR_ID, product: issuanceContext.product, workspaceId: issuanceContext.workspaceId, actor: issuanceContext.actor, correlationId: issuanceContext.correlationId,
    scopes: [IMAGE_SCOPE], costCapCents: 0, requestedItems: entries.length, occurredAt: occurredAt.toISOString(),
    detail: { candidateSetDigest: imageCandidateSetDigest(candidates), candidateCount: entries.length, candidates: entries, publication: 'blocked', runAuditHash: result.provenance.auditHash },
  }
  return { issuanceAuditHash: auditHash(await candidateLedger.appendIssuance(event), 'IMAGE_CANDIDATE_LEDGER_UNAVAILABLE') }
}

async function ownerDecision(type: ImageOwnerReviewDecisionEvent['type'], candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reviewLedger: ImageOwnerReviewLedger, candidateLedger: ImageCandidateLedger, context: ImageOwnerReviewContext, detail: Record<string, unknown>): Promise<{ auditHash: string; issuance: ImageCandidateIssuanceProof; occurredAt: Date }> {
  if (ownerApproved !== true) throw new OwnerGateError()
  if (!isIdentifier(actor)) throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
  assertSyntheticImageCandidate(candidate)
  if (candidate.requestedBy === actor) throw new OwnerGateError('MAKER_CHECKER_SEPARATION_REQUIRED')
  const reviewContext = requireReviewContext(context)
  const occurredAt = currentDate(reviewContext.now, 'INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  candidateInContext(candidate, reviewContext, occurredAt)
  const issuance = issuanceProof(await candidateLedger.assertIssued(candidate))
  if (issuance.candidateFingerprint !== imageCandidateFingerprint(candidate) || issuance.reviewExpiresAt !== candidate.ownerReview.reviewExpiresAt || occurredAt.getTime() < new Date(issuance.issuanceOccurredAt).getTime()) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
  const event: ImageOwnerReviewDecisionEvent = {
    type, connectorId: IMAGE_TTI_CONNECTOR_ID, product: reviewContext.product, workspaceId: reviewContext.workspaceId, actor, correlationId: reviewContext.correlationId,
    scopes: [IMAGE_SCOPE], costCapCents: 0, requestedItems: 1, occurredAt: occurredAt.toISOString(),
    detail: { candidateId: candidate.candidateId, candidateFingerprint: issuance.candidateFingerprint, reviewExpiresAt: issuance.reviewExpiresAt, maker: candidate.requestedBy, publication: 'blocked', issuanceAuditHash: issuance.issuanceAuditHash, runAuditHash: issuance.runAuditHash, ...detail },
  }
  const hash = auditHash(await reviewLedger.appendDecision(event), 'IMAGE_OWNER_REVIEW_LEDGER_UNAVAILABLE')
  decisionProof(await reviewLedger.assertRecorded(event), hash, issuance)
  return { auditHash: hash, issuance, occurredAt }
}

export async function ownerLikeSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reviewLedger: ImageOwnerReviewLedger, candidateLedger: ImageCandidateLedger, context: ImageOwnerReviewContext): Promise<OwnerLikedImageArtifact> {
  const artifactId = `owner-liked-${candidate.candidateId}`
  const decision = await ownerDecision('connector.artifact.owner_liked', candidate, ownerApproved, actor, reviewLedger, candidateLedger, context, { artifactId, ownerReview: 'liked' })
  return { artifactId, candidateId: candidate.candidateId, mediaType: candidate.mediaType, previewDataUri: candidate.previewDataUri, syntheticUri: candidate.syntheticUri, ownerReview: { status: 'liked', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: candidate.ownerReview.reviewExpiresAt, actor, occurredAt: decision.occurredAt.toISOString() }, publication: 'blocked', auditHash: decision.auditHash, issuanceAuditHash: decision.issuance.issuanceAuditHash, runAuditHash: decision.issuance.runAuditHash }
}

export async function ownerRejectSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reason: ImageRejectionReason, reviewLedger: ImageOwnerReviewLedger, candidateLedger: ImageCandidateLedger, context: ImageOwnerReviewContext): Promise<OwnerRejectedImageReview> {
  if (!['NOT_SUITABLE', 'SAFETY_CONCERN', 'NEEDS_REVISION'].includes(reason)) throw new ConnectorInputError('INVALID_IMAGE_REJECTION_REASON')
  const reviewId = `owner-rejected-${candidate.candidateId}`
  const decision = await ownerDecision('connector.artifact.owner_rejected', candidate, ownerApproved, actor, reviewLedger, candidateLedger, context, { reviewId, ownerReview: 'rejected', reason })
  return { reviewId, candidateId: candidate.candidateId, ownerReview: { status: 'rejected', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: candidate.ownerReview.reviewExpiresAt, actor, occurredAt: decision.occurredAt.toISOString(), reason }, publication: 'blocked', auditHash: decision.auditHash, issuanceAuditHash: decision.issuance.issuanceAuditHash, runAuditHash: decision.issuance.runAuditHash }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  return value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}
export function syntheticImageTtiConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env, overrides: Pick<SyntheticImageTtiConnectorConfig, 'familySafetyFilter'> = {}): SyntheticImageTtiConnector {
  return new SyntheticImageTtiConnector({ liveMode: environment.GCL_IMAGE_LIVE_MODE, maxCostCapCents: environmentPositiveInteger(environment.GCL_IMAGE_MAX_COST_CENTS), maxItems: environmentPositiveInteger(environment.GCL_IMAGE_MAX_ITEMS), ownerReviewTtlSeconds: environmentPositiveInteger(environment.GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS), familySafetyFilter: overrides.familySafetyFilter })
}
