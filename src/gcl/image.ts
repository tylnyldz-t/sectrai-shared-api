import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError } from './errors.js'
import type { AuditLog, Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const IMAGE_TTI_CONNECTOR_ID = 'image-tti'
/** GM3 deliberately has no live-provider code path. Any other value is rejected. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const

const IMAGE_SCOPE = 'image:generate'
const MAX_PROMPT_LENGTH = 1000
const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

export type ImageSize = 512 | 1024

export type TextToImageInput = {
  prompt: string
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

export type SyntheticImageCandidate = {
  candidateId: string
  promptDigest: string
  width: ImageSize
  height: ImageSize
  mediaType: 'image/svg+xml'
  /** A local synthetic preview, not a provider-hosted image. */
  previewDataUri: string
  /** Opaque non-network identifier for an owner-review candidate. */
  syntheticUri: string
  safety: { filterId: string; classification: 'family-safe' }
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

export type TextToImageData = {
  mode: typeof LIVE_DISABLED
  candidates: SyntheticImageCandidate[]
  nextAction: 'OWNER_LIKE_REQUIRED'
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
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
}

function imageInput(value: unknown): Required<TextToImageInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError('INVALID_IMAGE_TTI_INPUT')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => key !== 'prompt' && key !== 'width' && key !== 'height')) throw new ConnectorInputError('UNEXPECTED_IMAGE_TTI_FIELD')
  if (typeof candidate.prompt !== 'string') throw new ConnectorInputError('INVALID_IMAGE_TTI_PROMPT')
  const prompt = candidate.prompt.trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH || hasControlCharacter(prompt)) throw new ConnectorInputError('INVALID_IMAGE_TTI_PROMPT')
  const width = candidate.width === undefined ? 1024 : candidate.width
  const height = candidate.height === undefined ? 1024 : candidate.height
  if (!isImageSize(width) || !isImageSize(height)) throw new ConnectorInputError('INVALID_IMAGE_TTI_DIMENSIONS')
  return { prompt, width, height }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function previewDataUri(candidateId: string, width: ImageSize, height: ImageSize): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Synthetic image candidate"><rect width="100%" height="100%" fill="#172554"/><rect x="48" y="48" width="${width - 96}" height="${height - 96}" rx="24" fill="#1e3a8a" stroke="#93c5fd" stroke-width="4"/><text x="50%" y="47%" text-anchor="middle" fill="#dbeafe" font-family="system-ui, sans-serif" font-size="28">SYNTHETIC · OWNER REVIEW</text><text x="50%" y="54%" text-anchor="middle" fill="#bfdbfe" font-family="monospace" font-size="16">${candidateId}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function safetyAssessment(filter: FamilySafetyFilter, input: Readonly<TextToImageInput>): void {
  let assessment: FamilySafetyAssessment
  try { assessment = filter.assess(input) } catch { throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_UNAVAILABLE') }
  if (!assessment || typeof assessment !== 'object' || typeof assessment.allowed !== 'boolean') throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  if (!assessment.allowed) throw new FamilySafetyError(assessment.reason ?? 'FAMILY_SAFETY_FILTER_REJECTED')
}

/**
 * Minimal local hook used only by the synthetic adapter. It rejects obviously
 * adult, explicit, graphic, or weapon-focused prompts, but is not a substitute
 * for an owner-approved production moderation policy.
 */
export class BaselineFamilySafetyFilter implements FamilySafetyFilter {
  readonly id = 'baseline-family-safe-v1'
  private readonly blocked = /\b(?:adult|explicit|nude|naked|porn|sexual|gore|dismember|blood|weapon|gun|silah|çıplak|cinsel|pornografi|şiddet|vahşet)\b/iu

  assess(input: Readonly<TextToImageInput>): FamilySafetyAssessment {
    return this.blocked.test(input.prompt.toLocaleLowerCase('tr-TR'))
      ? { allowed: false, reason: 'FAMILY_SAFETY_FILTER_REJECTED' }
      : { allowed: true }
  }
}

const defaultFamilySafetyFilter = new BaselineFamilySafetyFilter()

/**
 * A deterministic, synthetic-only text-to-image adapter. It never accepts a
 * provider key, never owns a fetch client, and only creates local SVG review
 * candidates. A real provider is intentionally outside GM3 scope.
 */
export class SyntheticImageTtiConnector implements Connector<TextToImageInput, TextToImageData> {
  readonly id = IMAGE_TTI_CONNECTOR_ID
  readonly kind = 'media-generation' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [IMAGE_SCOPE] as const

  constructor(private readonly config: SyntheticImageTtiConnectorConfig = {}) {}

  private configured(ctx: ConnectorRunContext): { filter: FamilySafetyFilter } {
    if ((this.config.liveMode ?? LIVE_DISABLED) !== LIVE_DISABLED) throw new ConnectorUnavailableError('IMAGE_TTI_LIVE_DISABLED')
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
    const candidates = Array.from({ length: ctx.requestedItems }, (_, index): SyntheticImageCandidate => {
      const candidateId = `synthetic-image-${digest(`${ctx.product}:${ctx.workspaceId}:${promptDigest}:${index}`).slice(0, 20)}`
      return {
        candidateId,
        promptDigest,
        width: normalized.width,
        height: normalized.height,
        mediaType: 'image/svg+xml',
        previewDataUri: previewDataUri(candidateId, normalized.width, normalized.height),
        syntheticUri: `synthetic://gcl/${this.id}/${candidateId}`,
        safety: { filterId: filter.id, classification: 'family-safe' },
        ownerReview: { status: 'pending', visibility: 'owner-only', publication: 'blocked', required: true },
      }
    })
    return {
      data: { mode: LIVE_DISABLED, candidates, nextAction: 'OWNER_LIKE_REQUIRED', automaticPublication: false },
      provenance: {
        connectorId: this.id,
        source: 'synthetic-image-tti',
        retrievedAt: generatedAt,
        untrustedContent: {
          source: 'owner-supplied-tti-prompt',
          value: { promptDigest },
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

/**
 * Converts only a pending owner-review candidate into an owner-liked artifact
 * and appends the decision to the same per-workspace audit chain. The artifact
 * remains blocked from publication; publication is deliberately outside GM3.
 */
export async function ownerLikeSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, auditLog: AuditLog, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'now'>): Promise<OwnerLikedImageArtifact> {
  if (!ownerApproved) throw new OwnerGateError()
  if (!OWNER_ACTOR_PATTERN.test(actor)) throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
  if (candidate.ownerReview.status !== 'pending') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_PENDING_OWNER_REVIEW')
  const occurredAt = context.now()
  const artifactId = `owner-liked-${candidate.candidateId}`
  const audit = await auditLog.append({
    type: 'connector.artifact.owner_liked',
    connectorId: IMAGE_TTI_CONNECTOR_ID,
    product: context.product,
    workspaceId: context.workspaceId,
    actor,
    scopes: [IMAGE_SCOPE],
    costCapCents: 0,
    requestedItems: 1,
    occurredAt: occurredAt.toISOString(),
    detail: { candidateId: candidate.candidateId, artifactId, ownerReview: 'liked', publication: 'blocked' },
  })
  return {
    artifactId,
    candidateId: candidate.candidateId,
    mediaType: candidate.mediaType,
    previewDataUri: candidate.previewDataUri,
    syntheticUri: candidate.syntheticUri,
    ownerReview: { status: 'liked', visibility: 'owner-only', publication: 'blocked', required: true, actor, occurredAt: occurredAt.toISOString() },
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
