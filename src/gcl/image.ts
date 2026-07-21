import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError } from './errors.js'
import type { AuditLog, Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const IMAGE_TTI_CONNECTOR_ID = 'image-tti'
/** GM3 deliberately has no live-provider code path. Any other value is rejected. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const

const IMAGE_SCOPE = 'image:generate'
const MAX_PROMPT_LENGTH = 1000
const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const FILTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const COMFY_SDXL_GRAPH_SHAPE = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode:positive',
  'CLIPTextEncode:negative',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
] as const

export type ImageSize = 512 | 1024

export type TextToImageInput = {
  prompt: string
  negativePrompt?: string
  width?: ImageSize
  height?: ImageSize
}

export type FamilySafetyAssessment = {
  allowed: boolean
  reason?: string
}

/**
 * Policy seam for a product-specific family-safety service. It is synchronous
 * and deterministic by contract: this GM3 synthetic adapter must not make a
 * network call while evaluating a prompt.
 */
export interface FamilySafetyFilter {
  readonly id: string
  assess(input: Readonly<TextToImageInput>): FamilySafetyAssessment
}

export type OwnerReview = {
  status: 'pending' | 'liked' | 'rejected'
  visibility: 'owner-only'
  publication: 'blocked'
  required: true
}

export type ImageRejectionReason = 'NOT_SUITABLE' | 'SAFETY_CONCERN' | 'NEEDS_REVISION'

export type ImageCandidateScope = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId'>
export type ImageOwnerReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId' | 'now'>

/**
 * A redacted structural mirror of jarvis-creative-worker's image/SDXL graph.
 * It contains neither an executable graph nor raw prompt/checkpoint data and
 * therefore cannot be submitted to ComfyUI.
 */
export type SyntheticComfySdxlPlan = {
  schema: 'creative-job-v1'
  provider: 'local-comfyui'
  type: 'image'
  modelFamily: 'sdxl'
  checkpoint: 'UNRESOLVED_SYNTHETIC_ONLY'
  graphShape: readonly (typeof COMFY_SDXL_GRAPH_SHAPE)[number][]
  promptDigest: string
  negativePromptDigest?: string
  dispatch: {
    performed: false
    gate: typeof LIVE_DISABLED
    network: 'not-attempted'
  }
}

export type SyntheticImageCandidate = {
  candidateId: string
  promptDigest: string
  negativePromptDigest?: string
  requestedBy: string
  /** The originating GCL scope; a review cannot cross this boundary. */
  scope: ImageCandidateScope
  width: ImageSize
  height: ImageSize
  mediaType: 'image/svg+xml'
  /** A local synthetic preview, not a provider-hosted image. */
  previewDataUri: string
  /** Opaque non-network identifier for an owner-review candidate. */
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
}

/** A terminal owner decision, deliberately not a publishable media artifact. */
export type OwnerRejectedImageReview = {
  reviewId: string
  candidateId: string
  ownerReview: Omit<OwnerReview, 'status'> & {
    status: 'rejected'
    actor: string
    occurredAt: string
    reason: ImageRejectionReason
  }
  publication: 'blocked'
  auditHash: string
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
  familySafetyFilter?: FamilySafetyFilter
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isImageSize(value: unknown): value is ImageSize { return value === 512 || value === 1024 }

function hasControlCharacter(value: string): boolean {
  return /\p{C}/u.test(value)
}

function text(value: unknown, error: string): string {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_PROMPT_LENGTH || hasControlCharacter(normalized)) throw new ConnectorInputError(error)
  return normalized
}

function imageInput(value: unknown): Required<TextToImageInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError('INVALID_IMAGE_TTI_INPUT')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => key !== 'prompt' && key !== 'negativePrompt' && key !== 'width' && key !== 'height')) throw new ConnectorInputError('UNEXPECTED_IMAGE_TTI_FIELD')
  if (!Object.hasOwn(candidate, 'prompt')) throw new ConnectorInputError('INVALID_IMAGE_TTI_PROMPT')
  const prompt = text(candidate.prompt, 'INVALID_IMAGE_TTI_PROMPT')
  const negativePrompt = !Object.hasOwn(candidate, 'negativePrompt') || candidate.negativePrompt === undefined ? '' : text(candidate.negativePrompt, 'INVALID_IMAGE_TTI_NEGATIVE_PROMPT')
  const width = !Object.hasOwn(candidate, 'width') || candidate.width === undefined ? 1024 : candidate.width
  const height = !Object.hasOwn(candidate, 'height') || candidate.height === undefined ? 1024 : candidate.height
  if (!isImageSize(width) || !isImageSize(height)) throw new ConnectorInputError('INVALID_IMAGE_TTI_DIMENSIONS')
  return { prompt, negativePrompt, width, height }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function previewDataUri(candidateId: string, width: ImageSize, height: ImageSize): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Synthetic image candidate"><rect width="100%" height="100%" fill="#172554"/><rect x="48" y="48" width="${width - 96}" height="${height - 96}" rx="24" fill="#1e3a8a" stroke="#93c5fd" stroke-width="4"/><text x="50%" y="44%" text-anchor="middle" fill="#dbeafe" font-family="system-ui, sans-serif" font-size="28">SYNTHETIC · SDXL PLAN</text><text x="50%" y="51%" text-anchor="middle" fill="#bfdbfe" font-family="system-ui, sans-serif" font-size="18">OWNER REVIEW · DISPATCH DISABLED</text><text x="50%" y="58%" text-anchor="middle" fill="#bfdbfe" font-family="monospace" font-size="16">${candidateId}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function policyRejectionReason(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(value) ? value : 'FAMILY_SAFETY_FILTER_REJECTED'
}

function safetyAssessment(filter: FamilySafetyFilter, input: Readonly<TextToImageInput>): void {
  if (!FILTER_ID_PATTERN.test(filter.id) || typeof filter.assess !== 'function') throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  let assessment: FamilySafetyAssessment
  try { assessment = filter.assess(input) } catch { throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_UNAVAILABLE') }
  if (!assessment || typeof assessment !== 'object' || typeof assessment.allowed !== 'boolean') throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  if (!assessment.allowed) throw new FamilySafetyError(policyRejectionReason(assessment.reason))
}

/**
 * Minimal local hook used only by the synthetic adapter. It rejects obviously
 * adult, explicit, graphic, or weapon-focused prompts, but is not a substitute
 * for an owner-approved production moderation policy.
 */
export class BaselineFamilySafetyFilter implements FamilySafetyFilter {
  readonly id = 'baseline-family-safe-v1'
  private readonly blockedTerms = new Set(['adult', 'explicit', 'nude', 'naked', 'porn', 'sexual', 'gore', 'dismember', 'blood', 'weapon', 'gun', 'silah', 'çıplak', 'cinsel', 'pornografi', 'şiddet', 'vahşet'])

  assess(input: Readonly<TextToImageInput>): FamilySafetyAssessment {
    const words = `${input.prompt} ${input.negativePrompt ?? ''}`.normalize('NFKC').toLocaleLowerCase('tr-TR').match(/[\p{L}\p{N}]+/gu) ?? []
    return words.some((word) => this.blockedTerms.has(word))
      ? { allowed: false, reason: 'FAMILY_SAFETY_FILTER_REJECTED' }
      : { allowed: true }
  }
}

const defaultFamilySafetyFilter = new BaselineFamilySafetyFilter()

function creativeWorkerPlan(input: Required<TextToImageInput>, promptDigest: string): SyntheticComfySdxlPlan {
  return {
    schema: 'creative-job-v1',
    provider: 'local-comfyui',
    type: 'image',
    modelFamily: 'sdxl',
    checkpoint: 'UNRESOLVED_SYNTHETIC_ONLY',
    graphShape: COMFY_SDXL_GRAPH_SHAPE,
    promptDigest,
    ...(input.negativePrompt ? { negativePromptDigest: digest(input.negativePrompt) } : {}),
    dispatch: { performed: false, gate: LIVE_DISABLED, network: 'not-attempted' },
  }
}

function candidateId(context: ConnectorRunContext, promptDigest: string, negativePromptDigest: string | undefined, width: ImageSize, height: ImageSize, index: number): string {
  return `synthetic-image-${digest(JSON.stringify({ connectorId: IMAGE_TTI_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId, actor: context.actor, promptDigest, negativePromptDigest, width, height, index })).slice(0, 20)}`
}

/**
 * A deterministic, synthetic-only text-to-image adapter. It never accepts a
 * provider key, never owns a fetch/Docker client, and only creates local SVG
 * review candidates plus a redacted ComfyUI/SDXL plan. A real provider or
 * jarvis-creative-worker dispatch is deliberately outside GM3 scope.
 */
export class SyntheticImageTtiConnector implements Connector<TextToImageInput, TextToImageData> {
  readonly id = IMAGE_TTI_CONNECTOR_ID
  readonly kind = 'media-generation' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [IMAGE_SCOPE] as const

  constructor(private readonly config: SyntheticImageTtiConnectorConfig = {}) {}

  private configured(ctx: ConnectorRunContext): { filter: FamilySafetyFilter } {
    if ((this.config.liveMode ?? LIVE_DISABLED) !== LIVE_DISABLED) throw new ConnectorUnavailableError('IMAGE_TTI_LIVE_DISABLED')
    if (!isSafeIdentifier(ctx.product) || !isSafeIdentifier(ctx.workspaceId) || !isSafeIdentifier(ctx.actor) || !isSafeIdentifier(ctx.correlationId) || typeof ctx.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_TTI_CONTEXT')
    const maxCostCapCents = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCostCapCents || !maxItems) throw new ConnectorUnavailableError('IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (!positiveInteger(ctx.costCapCents) || !positiveInteger(ctx.requestedItems)) throw new CostCapError('INVALID_IMAGE_TTI_GOVERNANCE_REQUEST')
    if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
    if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    return { filter: this.config.familySafetyFilter ?? defaultFamilySafetyFilter }
  }

  preflight(input: TextToImageInput, ctx: ConnectorRunContext): void {
    const { filter } = this.configured(ctx)
    safetyAssessment(filter, imageInput(input))
  }

  async run(input: TextToImageInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TextToImageData>> {
    const { filter } = this.configured(ctx)
    const normalized = imageInput(input)
    safetyAssessment(filter, normalized)
    const generatedAt = ctx.now().toISOString()
    const promptDigest = digest(normalized.prompt)
    const plan = creativeWorkerPlan(normalized, promptDigest)
    const candidates = Array.from({ length: ctx.requestedItems }, (_, index): SyntheticImageCandidate => {
      const id = candidateId(ctx, promptDigest, plan.negativePromptDigest, normalized.width, normalized.height, index)
      return {
        candidateId: id,
        promptDigest,
        ...(plan.negativePromptDigest ? { negativePromptDigest: plan.negativePromptDigest } : {}),
        requestedBy: ctx.actor,
        scope: { product: ctx.product, workspaceId: ctx.workspaceId, correlationId: ctx.correlationId },
        width: normalized.width,
        height: normalized.height,
        mediaType: 'image/svg+xml',
        previewDataUri: previewDataUri(id, normalized.width, normalized.height),
        syntheticUri: `synthetic://gcl/${this.id}/${id}`,
        safety: { filterId: filter.id, classification: 'family-safe' },
        creativeWorkerPlan: plan,
        ownerReview: { status: 'pending', visibility: 'owner-only', publication: 'blocked', required: true },
      }
    })
    return {
      data: { mode: LIVE_DISABLED, candidates, nextAction: 'INDEPENDENT_OWNER_LIKE_REQUIRED', automaticPublication: false },
      provenance: {
        connectorId: this.id,
        source: 'synthetic-image-tti',
        retrievedAt: generatedAt,
        untrustedContent: {
          source: 'owner-supplied-tti-prompt',
          value: { promptDigest, ...(plan.negativePromptDigest ? { negativePromptDigest: plan.negativePromptDigest } : {}) },
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isSafeIdentifier(value: unknown): value is string { return typeof value === 'string' && OWNER_ACTOR_PATTERN.test(value) }

function assertCandidateScope(value: unknown, error: string): asserts value is ImageCandidateScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError(error)
  const scope = value as Record<string, unknown>
  if (!hasExactKeys(scope, ['product', 'workspaceId', 'correlationId']) || !isSafeIdentifier(scope.product) || !isSafeIdentifier(scope.workspaceId) || !isSafeIdentifier(scope.correlationId)) throw new ConnectorInputError(error)
}

function assertSyntheticCandidate(candidate: unknown): asserts candidate is SyntheticImageCandidate {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const value = candidate as Record<string, unknown>
  const candidateKeys = value.negativePromptDigest === undefined
    ? ['candidateId', 'promptDigest', 'requestedBy', 'scope', 'width', 'height', 'mediaType', 'previewDataUri', 'syntheticUri', 'safety', 'creativeWorkerPlan', 'ownerReview']
    : ['candidateId', 'promptDigest', 'negativePromptDigest', 'requestedBy', 'scope', 'width', 'height', 'mediaType', 'previewDataUri', 'syntheticUri', 'safety', 'creativeWorkerPlan', 'ownerReview']
  if (!hasExactKeys(value, candidateKeys)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (typeof value.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(value.candidateId) || typeof value.promptDigest !== 'string' || !DIGEST_PATTERN.test(value.promptDigest) || (value.negativePromptDigest !== undefined && (typeof value.negativePromptDigest !== 'string' || !DIGEST_PATTERN.test(value.negativePromptDigest))) || !isSafeIdentifier(value.requestedBy)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  assertCandidateScope(value.scope, 'INVALID_IMAGE_REVIEW_CANDIDATE')
  if (!isImageSize(value.width) || !isImageSize(value.height) || value.mediaType !== 'image/svg+xml' || value.syntheticUri !== `synthetic://gcl/${IMAGE_TTI_CONNECTOR_ID}/${value.candidateId}` || value.previewDataUri !== previewDataUri(value.candidateId, value.width, value.height)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  if (!value.safety || typeof value.safety !== 'object' || Array.isArray(value.safety) || !hasExactKeys(value.safety as Record<string, unknown>, ['filterId', 'classification'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const safety = value.safety as Record<string, unknown>
  if (typeof safety.filterId !== 'string' || !FILTER_ID_PATTERN.test(safety.filterId) || safety.classification !== 'family-safe') throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  if (!value.creativeWorkerPlan || typeof value.creativeWorkerPlan !== 'object' || Array.isArray(value.creativeWorkerPlan)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const plan = value.creativeWorkerPlan as Record<string, unknown>
  const planKeys = value.negativePromptDigest === undefined
    ? ['schema', 'provider', 'type', 'modelFamily', 'checkpoint', 'graphShape', 'promptDigest', 'dispatch']
    : ['schema', 'provider', 'type', 'modelFamily', 'checkpoint', 'graphShape', 'promptDigest', 'negativePromptDigest', 'dispatch']
  if (!hasExactKeys(plan, planKeys) || plan.schema !== 'creative-job-v1' || plan.provider !== 'local-comfyui' || plan.type !== 'image' || plan.modelFamily !== 'sdxl' || plan.checkpoint !== 'UNRESOLVED_SYNTHETIC_ONLY' || plan.promptDigest !== value.promptDigest || plan.negativePromptDigest !== value.negativePromptDigest || !Array.isArray(plan.graphShape) || plan.graphShape.length !== COMFY_SDXL_GRAPH_SHAPE.length || plan.graphShape.some((node, index) => node !== COMFY_SDXL_GRAPH_SHAPE[index])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (!plan.dispatch || typeof plan.dispatch !== 'object' || Array.isArray(plan.dispatch) || !hasExactKeys(plan.dispatch as Record<string, unknown>, ['performed', 'gate', 'network'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const dispatch = plan.dispatch as Record<string, unknown>
  if (dispatch.performed !== false || dispatch.gate !== LIVE_DISABLED || dispatch.network !== 'not-attempted') throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  if (!value.ownerReview || typeof value.ownerReview !== 'object' || Array.isArray(value.ownerReview) || !hasExactKeys(value.ownerReview as Record<string, unknown>, ['status', 'visibility', 'publication', 'required'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const review = value.ownerReview as Record<string, unknown>
  if (review.status !== 'pending') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_PENDING_OWNER_REVIEW')
  if (review.visibility !== 'owner-only' || review.publication !== 'blocked' || review.required !== true) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
}

function assertOwnerReviewContext(candidate: SyntheticImageCandidate, context: ImageOwnerReviewContext): Date {
  if (!context || typeof context !== 'object' || !isSafeIdentifier(context.product) || !isSafeIdentifier(context.workspaceId) || !isSafeIdentifier(context.correlationId) || typeof context.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  if (candidate.scope.product !== context.product || candidate.scope.workspaceId !== context.workspaceId || candidate.scope.correlationId !== context.correlationId) throw new ConnectorInputError('IMAGE_REVIEW_SCOPE_MISMATCH')
  const occurredAt = context.now()
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  return occurredAt
}

function assertOwnerReviewRequest(candidate: unknown, ownerApproved: boolean, actor: unknown, auditLog: unknown, context: ImageOwnerReviewContext): { candidate: SyntheticImageCandidate; actor: string; occurredAt: Date } {
  if (!ownerApproved) throw new OwnerGateError()
  if (!isSafeIdentifier(actor)) throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
  assertSyntheticCandidate(candidate)
  if (actor === candidate.requestedBy) throw new OwnerGateError('MAKER_CHECKER_SEPARATION_REQUIRED')
  if (!auditLog || typeof auditLog !== 'object' || typeof (auditLog as AuditLog).append !== 'function') throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_AUDIT_UNAVAILABLE')
  return { candidate, actor, occurredAt: assertOwnerReviewContext(candidate, context) }
}

function reviewAuditEvent(type: 'connector.artifact.owner_liked' | 'connector.artifact.owner_rejected', candidate: SyntheticImageCandidate, actor: string, occurredAt: Date, context: ImageOwnerReviewContext, detail: Record<string, unknown>) {
  return {
    type,
    connectorId: IMAGE_TTI_CONNECTOR_ID,
    product: context.product,
    workspaceId: context.workspaceId,
    actor,
    correlationId: context.correlationId,
    scopes: [IMAGE_SCOPE],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: occurredAt.toISOString(),
    detail: { candidateId: candidate.candidateId, maker: candidate.requestedBy, publication: 'blocked', ...detail },
  } as const
}

/**
 * Converts only a pending owner-review candidate into an owner-liked artifact
 * and appends the decision to the same per-workspace audit chain. The maker
 * cannot self-approve. The artifact remains blocked from publication.
 */
export async function ownerLikeSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, auditLog: AuditLog, context: ImageOwnerReviewContext): Promise<OwnerLikedImageArtifact> {
  const request = assertOwnerReviewRequest(candidate, ownerApproved, actor, auditLog, context)
  const artifactId = `owner-liked-${candidate.candidateId}`
  const audit = await auditLog.append(reviewAuditEvent('connector.artifact.owner_liked', request.candidate, request.actor, request.occurredAt, context, { artifactId, ownerReview: 'liked' }))
  return {
    artifactId,
    candidateId: request.candidate.candidateId,
    mediaType: request.candidate.mediaType,
    previewDataUri: request.candidate.previewDataUri,
    syntheticUri: request.candidate.syntheticUri,
    ownerReview: { status: 'liked', visibility: 'owner-only', publication: 'blocked', required: true, actor: request.actor, occurredAt: request.occurredAt.toISOString() },
    publication: 'blocked',
    auditHash: audit.hash,
  }
}

/**
 * Records a terminal rejection without returning an artifact URI or preview.
 * Rejection reasons are a closed enum so owner-supplied text cannot enter the
 * audit chain. Persisting/replay-protecting this terminal receipt remains the
 * authenticated host's responsibility; this connector never exposes a route.
 */
export async function ownerRejectSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reason: ImageRejectionReason, auditLog: AuditLog, context: ImageOwnerReviewContext): Promise<OwnerRejectedImageReview> {
  const request = assertOwnerReviewRequest(candidate, ownerApproved, actor, auditLog, context)
  if (reason !== 'NOT_SUITABLE' && reason !== 'SAFETY_CONCERN' && reason !== 'NEEDS_REVISION') throw new ConnectorInputError('INVALID_IMAGE_REJECTION_REASON')
  const reviewId = `owner-rejected-${request.candidate.candidateId}`
  const audit = await auditLog.append(reviewAuditEvent('connector.artifact.owner_rejected', request.candidate, request.actor, request.occurredAt, context, { reviewId, ownerReview: 'rejected', reason }))
  return {
    reviewId,
    candidateId: request.candidate.candidateId,
    ownerReview: { status: 'rejected', visibility: 'owner-only', publication: 'blocked', required: true, actor: request.actor, occurredAt: request.occurredAt.toISOString(), reason },
    publication: 'blocked',
    auditHash: audit.hash,
  }
}

export function syntheticImageTtiConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env, overrides: Pick<SyntheticImageTtiConnectorConfig, 'familySafetyFilter'> = {}): SyntheticImageTtiConnector {
  return new SyntheticImageTtiConnector({
    liveMode: environment.GCL_IMAGE_LIVE_MODE,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_IMAGE_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_IMAGE_MAX_ITEMS),
    ...overrides,
  })
}
