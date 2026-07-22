import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, FamilySafetyError, OwnerGateError } from './errors.js'
import type { ImageCandidateIssuanceEvent, ImageCandidateIssuanceProof, ImageCandidateLedger } from './image-candidate-ledger.js'
import type { ImageOwnerReviewDecisionEvent, ImageOwnerReviewDecisionProof, ImageOwnerReviewLedger } from './image-review-ledger.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const IMAGE_TTI_CONNECTOR_ID = 'image-tti'
/** GM3 deliberately has no live-provider code path. Any other value is rejected. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const
/** Redacted candidate-set hash field carried only in a governed success audit. */
export const IMAGE_CANDIDATE_SET_AUDIT_FIELD = 'syntheticCandidateSetDigest'

const IMAGE_SCOPE = 'image:generate'
const MAX_PROMPT_LENGTH = 1000
const MIN_OWNER_REVIEW_TTL_SECONDS = 60
const MAX_OWNER_REVIEW_TTL_SECONDS = 86_400
/** Matches the issuance ledger's bounded receipt set; a run must be issuable. */
export const MAX_SYNTHETIC_IMAGE_CANDIDATES = 32
const OWNER_ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const FILTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const CANDIDATE_ID_PATTERN = /^synthetic-image-[a-f0-9]{20}$/
const COMFY_SDXL_GRAPH_SHAPE = Object.freeze([
  'CheckpointLoaderSimple',
  'CLIPTextEncode:positive',
  'CLIPTextEncode:negative',
  'EmptyLatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
] as const)
const IMAGE_RUN_CONTEXT_KEYS = ['product', 'workspaceId', 'actor', 'correlationId', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems', 'now'] as const
const IMAGE_ISSUANCE_CONTEXT_KEYS = ['product', 'workspaceId', 'actor', 'correlationId', 'now'] as const
const IMAGE_REVIEW_CONTEXT_KEYS = ['product', 'workspaceId', 'correlationId', 'now'] as const
const IMAGE_TTI_CONFIG_KEYS = ['liveMode', 'maxCostCapCents', 'maxItems', 'ownerReviewTtlSeconds', 'familySafetyFilter'] as const
const IMAGE_TTI_ENVIRONMENT_OVERRIDE_KEYS = ['familySafetyFilter'] as const
const FAMILY_SAFETY_FILTER_KEYS = ['id', 'assess'] as const

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
  /** Canonical UTC deadline; no issuance or terminal decision survives it. */
  reviewExpiresAt: string
}

export type ImageRejectionReason = 'NOT_SUITABLE' | 'SAFETY_CONCERN' | 'NEEDS_REVISION'

export type ImageCandidateScope = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId'>
export type ImageOwnerReviewContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'correlationId' | 'now'>
export type ImageCandidateIssuanceContext = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'actor' | 'correlationId' | 'now'>

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
  /** Zero-based position in the bounded synthetic result set. */
  candidateIndex: number
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
  issuanceAuditHash: string
  runAuditHash: string
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
  /** Bounded policy TTL for the independent owner review. */
  ownerReviewTtlSeconds?: number
  familySafetyFilter?: FamilySafetyFilter
}

/**
 * The public config is a host boundary, not a capability bag. This copied
 * form prevents a caller from retaining a mutable reference to live-mode or
 * governance limits after construction.
 */
type ClosedSyntheticImageTtiConnectorConfig = {
  liveMode?: string
  maxCostCapCents?: number
  maxItems?: number
  ownerReviewTtlSeconds?: number
  familySafetyFilter?: ClosedFamilySafetyFilter
}

type ClosedFamilySafetyFilter = {
  id: string
  assess: (...args: unknown[]) => unknown
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function ownerReviewTtlSeconds(value: unknown): number | null {
  const seconds = positiveInteger(value)
  return seconds && seconds >= MIN_OWNER_REVIEW_TTL_SECONDS && seconds <= MAX_OWNER_REVIEW_TTL_SECONDS ? seconds : null
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isImageSize(value: unknown): value is ImageSize { return value === 512 || value === 1024 }

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(Date.prototype.getTime.call(parsed)) && Date.prototype.toISOString.call(parsed) === value
}

/** Accept and copy only an ordinary built-in Date from an injected host clock. */
function currentDate(now: () => Date, error: string): Date {
  try {
    const value = now()
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Date.prototype) throw new ConnectorInputError(error)
    const timestamp = Date.prototype.getTime.call(value)
    if (!Number.isFinite(timestamp)) throw new ConnectorInputError(error)
    return new Date(timestamp)
  } catch (errorValue) {
    if (errorValue instanceof ConnectorInputError) throw errorValue
    throw new ConnectorInputError(error)
  }
}

function reviewExpiresAt(issuedAt: Date, ttlSeconds: number, error: string): string {
  const expiresAt = new Date(Date.prototype.getTime.call(issuedAt) + ttlSeconds * 1_000)
  if (Number.isNaN(Date.prototype.getTime.call(expiresAt))) throw new ConnectorInputError(error)
  return Date.prototype.toISOString.call(expiresAt)
}

function hasControlCharacter(value: string): boolean {
  return /\p{C}/u.test(value)
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

/**
 * Copy only a dense, ordinary array made entirely of own data properties.
 * Candidate sets and graph shapes arrive from an untrusted host boundary, so
 * indexing them directly would execute an accessor before validation.
 */
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

/** Like plainRecord, but permits a sealed policy instance with own data fields. */
function ownDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

/** Return an own data value without falling through to a prototype accessor. */
function ownDataValue(value: Record<string, unknown>, name: string): { present: boolean; value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor && !descriptor.get && !descriptor.set
      ? { present: true, value: descriptor.value }
      : { present: false, value: undefined }
  } catch { return { present: false, value: undefined } }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try { return Object.getOwnPropertyNames(value).every((key) => keys.includes(key)) } catch { return false }
}

/**
 * A custom family-safety capsule is deliberately a same-turn local seam.
 * Reject declared async/generator callables while the configuration is still
 * being closed, rather than invoking one during preflight and discovering a
 * Promise only after it has had an opportunity to start asynchronous work.
 */
function synchronousPolicyAssess(value: unknown): ((...args: unknown[]) => unknown) | null {
  try {
    return typeof value === 'function' && Object.getPrototypeOf(value) === Function.prototype
      ? value as (...args: unknown[]) => unknown
      : null
  } catch { return null }
}

/**
 * A custom policy remains a local, synchronous host seam, but its identity
 * and callable must be its entire own-data shape. A nested endpoint,
 * credential, inherited getter, or mutable receiver is never retained as
 * connector configuration.
 */
function closedFamilySafetyFilter(value: unknown): ClosedFamilySafetyFilter | null {
  const candidate = ownDataRecord(value)
  if (!candidate || !hasExactKeys(candidate, FAMILY_SAFETY_FILTER_KEYS)) return null
  const id = ownDataValue(candidate, 'id')
  const assess = ownDataValue(candidate, 'assess')
  const synchronousAssess = assess.present ? synchronousPolicyAssess(assess.value) : null
  if (!id.present || !synchronousAssess || typeof id.value !== 'string') return null
  return Object.freeze({ id: id.value, assess: synchronousAssess })
}

/**
 * Copy a closed config before it can affect a run. Unknown, hidden, symbol,
 * accessor, inherited-policy, or non-data configuration fails closed rather
 * than becoming an accidental credential/endpoint carrier.
 */
function closedImageTtiConfig(value: unknown): Readonly<ClosedSyntheticImageTtiConnectorConfig> | null {
  const config = plainRecord(value)
  if (!config || !hasOnlyKeys(config, IMAGE_TTI_CONFIG_KEYS)) return null
  const liveMode = ownDataValue(config, 'liveMode')
  const maxCostCapCents = ownDataValue(config, 'maxCostCapCents')
  const maxItems = ownDataValue(config, 'maxItems')
  const ownerReviewTtlSeconds = ownDataValue(config, 'ownerReviewTtlSeconds')
  const familySafetyFilter = ownDataValue(config, 'familySafetyFilter')
  const sealedFilter = familySafetyFilter.present && familySafetyFilter.value !== undefined
    ? closedFamilySafetyFilter(familySafetyFilter.value)
    : undefined
  if ((liveMode.present && liveMode.value !== undefined && typeof liveMode.value !== 'string')
    || (maxCostCapCents.present && maxCostCapCents.value !== undefined && typeof maxCostCapCents.value !== 'number')
    || (maxItems.present && maxItems.value !== undefined && typeof maxItems.value !== 'number')
    || (ownerReviewTtlSeconds.present && ownerReviewTtlSeconds.value !== undefined && typeof ownerReviewTtlSeconds.value !== 'number')
    || (familySafetyFilter.present && familySafetyFilter.value !== undefined && !sealedFilter)) return null
  return Object.freeze({
    ...(liveMode.present ? { liveMode: liveMode.value as string | undefined } : {}),
    ...(maxCostCapCents.present ? { maxCostCapCents: maxCostCapCents.value as number | undefined } : {}),
    ...(maxItems.present ? { maxItems: maxItems.value as number | undefined } : {}),
    ...(ownerReviewTtlSeconds.present ? { ownerReviewTtlSeconds: ownerReviewTtlSeconds.value as number | undefined } : {}),
    ...(sealedFilter ? { familySafetyFilter: sealedFilter } : {}),
  })
}

/**
 * Resolves a callable capability without evaluating an own or prototype
 * accessor. Ledger implementations may use class methods, so own-data-only
 * object validation is intentionally too strict here.
 */
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

function text(value: unknown, error: string): string {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_PROMPT_LENGTH || hasControlCharacter(normalized)) throw new ConnectorInputError(error)
  return normalized
}

function imageInput(value: unknown): Required<TextToImageInput> {
  const candidate = plainRecord(value)
  if (!candidate) throw new ConnectorInputError('INVALID_IMAGE_TTI_INPUT')
  if (Object.getOwnPropertyNames(candidate).some((key) => key !== 'prompt' && key !== 'negativePrompt' && key !== 'width' && key !== 'height')) throw new ConnectorInputError('UNEXPECTED_IMAGE_TTI_FIELD')
  if (!Object.hasOwn(candidate, 'prompt')) throw new ConnectorInputError('INVALID_IMAGE_TTI_PROMPT')
  const prompt = text(candidate.prompt, 'INVALID_IMAGE_TTI_PROMPT')
  const negativePrompt = !Object.hasOwn(candidate, 'negativePrompt') || candidate.negativePrompt === undefined ? '' : text(candidate.negativePrompt, 'INVALID_IMAGE_TTI_NEGATIVE_PROMPT')
  const width = !Object.hasOwn(candidate, 'width') || candidate.width === undefined ? 1024 : candidate.width
  const height = !Object.hasOwn(candidate, 'height') || candidate.height === undefined ? 1024 : candidate.height
  if (!isImageSize(width) || !isImageSize(height)) throw new ConnectorInputError('INVALID_IMAGE_TTI_DIMENSIONS')
  return { prompt, negativePrompt, width, height }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = plainArray(value)
    if (!items) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
    return `[${items.map(canonicalJson).join(',')}]`
  }
  const record = plainRecord(value)
  if (!record) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  return `{${Object.getOwnPropertyNames(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Used only for redacted candidate/issuance shapes; ledger callers never persist raw prompt text. */
export function imageCandidateFingerprint(value: unknown): string { return digest(canonicalJson(value)) }

/**
 * Binds the exact redacted candidate set to its governed success audit event.
 * The hash contains candidate IDs and their full redacted fingerprints only;
 * it never contains the prompt, preview bytes, credential, or endpoint.
 */
export function imageCandidateSetDigest(candidates: readonly SyntheticImageCandidate[]): string {
  const candidateValues = plainArray(candidates)
  if (!candidateValues) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const entries = candidateValues.map((candidate) => {
    const value = plainRecord(candidate)
    if (!value || typeof value.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(value.candidateId)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
    return { candidateId: value.candidateId, fingerprint: imageCandidateFingerprint(candidate) }
  })
  return imageCandidateFingerprint(entries.sort((left, right) => left.candidateId.localeCompare(right.candidateId)))
}

function previewDataUri(candidateId: string, width: ImageSize, height: ImageSize): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Synthetic image candidate"><rect width="100%" height="100%" fill="#172554"/><rect x="48" y="48" width="${width - 96}" height="${height - 96}" rx="24" fill="#1e3a8a" stroke="#93c5fd" stroke-width="4"/><text x="50%" y="44%" text-anchor="middle" fill="#dbeafe" font-family="system-ui, sans-serif" font-size="28">SYNTHETIC · SDXL PLAN</text><text x="50%" y="51%" text-anchor="middle" fill="#bfdbfe" font-family="system-ui, sans-serif" font-size="18">OWNER REVIEW · DISPATCH DISABLED</text><text x="50%" y="58%" text-anchor="middle" fill="#bfdbfe" font-family="monospace" font-size="16">${candidateId}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function policyRejectionReason(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(value) ? value : 'FAMILY_SAFETY_FILTER_REJECTED'
}

function safetyAssessment(filter: ClosedFamilySafetyFilter, input: Readonly<TextToImageInput>): void {
  if (!FILTER_ID_PATTERN.test(filter.id)) throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  // The policy receives a new immutable data snapshot. It cannot rewrite the
  // normalized prompt or dimensions that will later form candidate digests.
  const policyInput = Object.freeze({
    prompt: input.prompt,
    ...(input.negativePrompt === undefined ? {} : { negativePrompt: input.negativePrompt }),
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  })
  let assessment: FamilySafetyAssessment
  // Do not retain or supply the caller's policy object as `this`; the copied
  // callable is a synchronous data-only seam, not a capability receiver.
  const assess = filter.assess
  try { assessment = assess(policyInput) as FamilySafetyAssessment } catch { throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_UNAVAILABLE') }
  const result = plainRecord(assessment)
  if (!result || !hasOnlyKeys(result, ['allowed', 'reason'])) throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  const allowed = ownDataValue(result, 'allowed')
  const reason = ownDataValue(result, 'reason')
  if (!allowed.present || typeof allowed.value !== 'boolean' || (reason.present && reason.value !== undefined && typeof reason.value !== 'string')) throw new ConnectorUnavailableError('IMAGE_FAMILY_SAFETY_FILTER_INVALID')
  if (!allowed.value) throw new FamilySafetyError(policyRejectionReason(reason.value))
}

/**
 * The local baseline is an irreducible synthetic safety gate. A host policy
 * may only narrow that decision; it must never replace the baseline and
 * approve input that the baseline already rejected. Running the baseline
 * first also avoids handing a known-unsafe prompt to an optional host seam.
 */
function familySafetyAssessment(policy: ClosedFamilySafetyFilter | undefined, input: Readonly<TextToImageInput>): string {
  safetyAssessment(closedDefaultFamilySafetyFilter, input)
  if (!policy) return closedDefaultFamilySafetyFilter.id
  safetyAssessment(policy, input)
  return policy.id
}

/**
 * Minimal local hook used only by the synthetic adapter. It rejects obviously
 * adult, explicit, graphic, or weapon-focused prompts, but is not a substitute
 * for an owner-approved production moderation policy.
 */
export class BaselineFamilySafetyFilter implements FamilySafetyFilter {
  readonly id = 'baseline-family-safe-v1'
  // Private fields are not part of the public policy object shape, so the
  // baseline policy is subject to the same exact `{ id, assess }` capsule.
  readonly #blockedTerms = new Set(['adult', 'explicit', 'nude', 'naked', 'porn', 'sexual', 'gore', 'dismember', 'blood', 'weapon', 'gun', 'silah', 'çıplak', 'cinsel', 'pornografi', 'şiddet', 'vahşet'])

  readonly assess = (input: Readonly<TextToImageInput>): FamilySafetyAssessment => {
    const words = `${input.prompt} ${input.negativePrompt ?? ''}`.normalize('NFKC').toLocaleLowerCase('tr-TR').match(/[\p{L}\p{N}]+/gu) ?? []
    return words.some((word) => this.#blockedTerms.has(word))
      ? { allowed: false, reason: 'FAMILY_SAFETY_FILTER_REJECTED' }
      : { allowed: true }
  }
}

const defaultFamilySafetyFilter = new BaselineFamilySafetyFilter()
const closedDefaultFamilySafetyFilter = (() => {
  const filter = closedFamilySafetyFilter(defaultFamilySafetyFilter)
  if (!filter) throw new Error('IMAGE_DEFAULT_FAMILY_SAFETY_FILTER_INVALID')
  return filter
})()

function creativeWorkerPlan(input: Required<TextToImageInput>, promptDigest: string): SyntheticComfySdxlPlan {
  const plan: SyntheticComfySdxlPlan = {
    schema: 'creative-job-v1',
    provider: 'local-comfyui',
    type: 'image',
    modelFamily: 'sdxl',
    checkpoint: 'UNRESOLVED_SYNTHETIC_ONLY',
    graphShape: Object.freeze([...COMFY_SDXL_GRAPH_SHAPE]),
    promptDigest,
    ...(input.negativePrompt ? { negativePromptDigest: digest(input.negativePrompt) } : {}),
    dispatch: Object.freeze({ performed: false, gate: LIVE_DISABLED, network: 'not-attempted' }),
  }
  return Object.freeze(plan)
}

function candidateId(scope: ImageCandidateScope, actor: string, promptDigest: string, negativePromptDigest: string | undefined, width: ImageSize, height: ImageSize, reviewExpiresAtValue: string, index: number): string {
  return `synthetic-image-${digest(JSON.stringify({ connectorId: IMAGE_TTI_CONNECTOR_ID, product: scope.product, workspaceId: scope.workspaceId, correlationId: scope.correlationId, actor, promptDigest, negativePromptDigest, width, height, reviewExpiresAt: reviewExpiresAtValue, index })).slice(0, 20)}`
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
  readonly scopes = Object.freeze([IMAGE_SCOPE] as const)

  readonly #config: Readonly<ClosedSyntheticImageTtiConnectorConfig> | null

  constructor(config: SyntheticImageTtiConnectorConfig = {}) {
    this.#config = closedImageTtiConfig(config)
  }

  private configured(ctx: ConnectorRunContext): { policy: ClosedFamilySafetyFilter | undefined; ownerReviewTtlSeconds: number } {
    const config = this.#config
    if (!config) throw new ConnectorUnavailableError('IMAGE_TTI_CONFIGURATION_INVALID')
    if ((config.liveMode ?? LIVE_DISABLED) !== LIVE_DISABLED) throw new ConnectorUnavailableError('IMAGE_TTI_LIVE_DISABLED')
    const maxCostCapCents = positiveInteger(config.maxCostCapCents)
    const maxItems = positiveInteger(config.maxItems)
    const reviewTtl = ownerReviewTtlSeconds(config.ownerReviewTtlSeconds)
    if (!maxCostCapCents || !maxItems || maxItems > MAX_SYNTHETIC_IMAGE_CANDIDATES) throw new ConnectorUnavailableError('IMAGE_TTI_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (!reviewTtl) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_TTL_NOT_CONFIGURED')
    if (!positiveInteger(ctx.costCapCents) || !positiveInteger(ctx.requestedItems)) throw new CostCapError('INVALID_IMAGE_TTI_GOVERNANCE_REQUEST')
    if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
    if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    return { policy: config.familySafetyFilter, ownerReviewTtlSeconds: reviewTtl }
  }

  preflight(input: TextToImageInput, ctx: ConnectorRunContext): void {
    const context = imageRunContext(ctx)
    const { policy } = this.configured(context)
    currentDate(context.now, 'INVALID_IMAGE_TTI_CONTEXT')
    familySafetyAssessment(policy, imageInput(input))
  }

  async run(input: TextToImageInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TextToImageData>> {
    const context = imageRunContext(ctx)
    const { policy, ownerReviewTtlSeconds: reviewTtl } = this.configured(context)
    const normalized = imageInput(input)
    const filterId = familySafetyAssessment(policy, normalized)
    const generatedDate = currentDate(context.now, 'INVALID_IMAGE_TTI_CONTEXT')
    const generatedAt = generatedDate.toISOString()
    const expiresAt = reviewExpiresAt(generatedDate, reviewTtl, 'INVALID_IMAGE_TTI_CONTEXT')
    const promptDigest = digest(normalized.prompt)
    const plan = creativeWorkerPlan(normalized, promptDigest)
    const candidates: SyntheticImageCandidate[] = Array.from({ length: context.requestedItems }, (_, index): SyntheticImageCandidate => {
      const scope = Object.freeze({ product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId })
      const id = candidateId(scope, context.actor, promptDigest, plan.negativePromptDigest, normalized.width, normalized.height, expiresAt, index)
      return Object.freeze({
        candidateId: id,
        candidateIndex: index,
        promptDigest,
        ...(plan.negativePromptDigest ? { negativePromptDigest: plan.negativePromptDigest } : {}),
        requestedBy: context.actor,
        scope,
        width: normalized.width,
        height: normalized.height,
        mediaType: 'image/svg+xml',
        previewDataUri: previewDataUri(id, normalized.width, normalized.height),
        syntheticUri: `synthetic://gcl/${this.id}/${id}`,
        safety: Object.freeze({ filterId, classification: 'family-safe' }),
        creativeWorkerPlan: plan,
        ownerReview: Object.freeze({ status: 'pending', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: expiresAt }),
      })
    })
    Object.freeze(candidates)
    const data: TextToImageData = Object.freeze({ mode: LIVE_DISABLED, candidates, nextAction: 'INDEPENDENT_OWNER_LIKE_REQUIRED', automaticPublication: false })
    const provenance = Object.freeze({
        connectorId: this.id,
        source: 'synthetic-image-tti',
        retrievedAt: generatedAt,
        untrustedContent: Object.freeze({
          source: 'owner-supplied-tti-prompt',
          value: Object.freeze({ promptDigest, ...(plan.negativePromptDigest ? { negativePromptDigest: plan.negativePromptDigest } : {}) }),
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        }),
      })
    return Object.freeze({
      data,
      provenance,
      confidence: 0,
    })
  }

  successAuditDetail(result: ConnectorResult<TextToImageData>): { [IMAGE_CANDIDATE_SET_AUDIT_FIELD]: string } {
    return { [IMAGE_CANDIDATE_SET_AUDIT_FIELD]: imageCandidateSetDigest(result.data.candidates) }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.getOwnPropertyNames(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isSafeIdentifier(value: unknown): value is string { return typeof value === 'string' && OWNER_ACTOR_PATTERN.test(value) }

/**
 * A public owner-decision candidate is untrusted even after its first shape
 * check. Seal the accepted data before any ledger call can yield so the
 * terminal artifact cannot be assembled from a subsequently changed copy.
 */
function freezeData<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeData(child)
  return Object.freeze(value)
}

function sealedSyntheticImageCandidate(value: unknown): SyntheticImageCandidate {
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

/**
 * Validate the complete shared run envelope before a direct path consumes it.
 * A runner has already enforced these fields, but exported direct entry points
 * must not turn a partial or owner-unapproved context into a bypass.
 */
function completeImageRunContext(value: unknown, error: string): ConnectorRunContext {
  const context = plainRecord(value)
  const scopes = context ? plainArray(context.scopes) : null
  const costCapCents = context ? positiveInteger(context.costCapCents) : null
  const requestedItems = context ? positiveInteger(context.requestedItems) : null
  if (!context || !hasExactKeys(context, IMAGE_RUN_CONTEXT_KEYS) || !isSafeIdentifier(context.product) || !isSafeIdentifier(context.workspaceId) || !isSafeIdentifier(context.actor) || !isSafeIdentifier(context.correlationId) || context.ownerApproved !== true || !scopes || scopes.length !== 1 || scopes[0] !== IMAGE_SCOPE || !costCapCents || !requestedItems || typeof context.now !== 'function') throw new ConnectorInputError(error)
  return {
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    ownerApproved: true,
    scopes: [IMAGE_SCOPE],
    costCapCents,
    requestedItems,
    now: context.now as () => Date,
  }
}

/** Copy a closed ConnectorRunContext before direct adapter use reads its data. */
function imageRunContext(value: unknown): ConnectorRunContext {
  return completeImageRunContext(value, 'INVALID_IMAGE_TTI_CONTEXT')
}

/** Copy the small issuance context before its identity or clock is used. */
function imageIssuanceContext(value: unknown): ImageCandidateIssuanceContext {
  const context = plainRecord(value)
  if (!context) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  if (hasExactKeys(context, IMAGE_RUN_CONTEXT_KEYS)) {
    const runContext = completeImageRunContext(context, 'INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
    return { product: runContext.product, workspaceId: runContext.workspaceId, actor: runContext.actor, correlationId: runContext.correlationId, now: runContext.now }
  }
  if (!hasExactKeys(context, IMAGE_ISSUANCE_CONTEXT_KEYS) || !isSafeIdentifier(context.product) || !isSafeIdentifier(context.workspaceId) || !isSafeIdentifier(context.actor) || !isSafeIdentifier(context.correlationId) || typeof context.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  return { product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, now: context.now as () => Date }
}

/** Copy the small review context before scope or clock checks run. */
function imageReviewContext(value: unknown): ImageOwnerReviewContext {
  const context = plainRecord(value)
  if (!context) throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  if (hasExactKeys(context, IMAGE_RUN_CONTEXT_KEYS)) {
    const runContext = completeImageRunContext(context, 'INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
    return { product: runContext.product, workspaceId: runContext.workspaceId, correlationId: runContext.correlationId, now: runContext.now }
  }
  if (hasExactKeys(context, IMAGE_ISSUANCE_CONTEXT_KEYS)) {
    if (!isSafeIdentifier(context.product) || !isSafeIdentifier(context.workspaceId) || !isSafeIdentifier(context.actor) || !isSafeIdentifier(context.correlationId) || typeof context.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
    return { product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId, now: context.now as () => Date }
  }
  if (!hasExactKeys(context, IMAGE_REVIEW_CONTEXT_KEYS) || !isSafeIdentifier(context.product) || !isSafeIdentifier(context.workspaceId) || !isSafeIdentifier(context.correlationId) || typeof context.now !== 'function') throw new ConnectorInputError('INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  return { product: context.product, workspaceId: context.workspaceId, correlationId: context.correlationId, now: context.now as () => Date }
}

function returnedAuditHash(value: unknown, error: string): string {
  const audit = plainRecord(value)
  if (!audit || !hasExactKeys(audit, ['hash']) || typeof audit.hash !== 'string' || !DIGEST_PATTERN.test(audit.hash)) throw new ConnectorUnavailableError(error)
  return audit.hash
}

function assertCandidateScope(value: unknown, error: string): asserts value is ImageCandidateScope {
  const scope = plainRecord(value)
  if (!scope) throw new ConnectorInputError(error)
  if (!hasExactKeys(scope, ['product', 'workspaceId', 'correlationId']) || !isSafeIdentifier(scope.product) || !isSafeIdentifier(scope.workspaceId) || !isSafeIdentifier(scope.correlationId)) throw new ConnectorInputError(error)
}

/**
 * Validate the complete redacted candidate snapshot before any issuance or
 * terminal-review path consumes it. Candidate ledgers use this exported guard
 * too: their public assertion seam must not trust TypeScript-only typing or
 * read a caller-owned accessor while locating a durable receipt.
 */
export function assertSyntheticImageCandidate(candidate: unknown): asserts candidate is SyntheticImageCandidate {
  const value = plainRecord(candidate)
  if (!value) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const candidateKeys = value.negativePromptDigest === undefined
    ? ['candidateId', 'candidateIndex', 'promptDigest', 'requestedBy', 'scope', 'width', 'height', 'mediaType', 'previewDataUri', 'syntheticUri', 'safety', 'creativeWorkerPlan', 'ownerReview']
    : ['candidateId', 'candidateIndex', 'promptDigest', 'negativePromptDigest', 'requestedBy', 'scope', 'width', 'height', 'mediaType', 'previewDataUri', 'syntheticUri', 'safety', 'creativeWorkerPlan', 'ownerReview']
  if (!hasExactKeys(value, candidateKeys)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (typeof value.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(value.candidateId) || typeof value.candidateIndex !== 'number' || !Number.isSafeInteger(value.candidateIndex) || value.candidateIndex < 0 || typeof value.promptDigest !== 'string' || !DIGEST_PATTERN.test(value.promptDigest) || (value.negativePromptDigest !== undefined && (typeof value.negativePromptDigest !== 'string' || !DIGEST_PATTERN.test(value.negativePromptDigest))) || !isSafeIdentifier(value.requestedBy)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  assertCandidateScope(value.scope, 'INVALID_IMAGE_REVIEW_CANDIDATE')
  if (!isImageSize(value.width) || !isImageSize(value.height) || value.mediaType !== 'image/svg+xml' || value.syntheticUri !== `synthetic://gcl/${IMAGE_TTI_CONNECTOR_ID}/${value.candidateId}` || value.previewDataUri !== previewDataUri(value.candidateId, value.width, value.height)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  const safety = plainRecord(value.safety)
  if (!safety || !hasExactKeys(safety, ['filterId', 'classification'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (typeof safety.filterId !== 'string' || !FILTER_ID_PATTERN.test(safety.filterId) || safety.classification !== 'family-safe') throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  const plan = plainRecord(value.creativeWorkerPlan)
  if (!plan) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const planKeys = value.negativePromptDigest === undefined
    ? ['schema', 'provider', 'type', 'modelFamily', 'checkpoint', 'graphShape', 'promptDigest', 'dispatch']
    : ['schema', 'provider', 'type', 'modelFamily', 'checkpoint', 'graphShape', 'promptDigest', 'negativePromptDigest', 'dispatch']
  const graphShape = plainArray(plan.graphShape)
  if (!hasExactKeys(plan, planKeys) || plan.schema !== 'creative-job-v1' || plan.provider !== 'local-comfyui' || plan.type !== 'image' || plan.modelFamily !== 'sdxl' || plan.checkpoint !== 'UNRESOLVED_SYNTHETIC_ONLY' || plan.promptDigest !== value.promptDigest || plan.negativePromptDigest !== value.negativePromptDigest || !graphShape || graphShape.length !== COMFY_SDXL_GRAPH_SHAPE.length || graphShape.some((node, index) => node !== COMFY_SDXL_GRAPH_SHAPE[index])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  const dispatch = plainRecord(plan.dispatch)
  if (!dispatch || !hasExactKeys(dispatch, ['performed', 'gate', 'network'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (dispatch.performed !== false || dispatch.gate !== LIVE_DISABLED || dispatch.network !== 'not-attempted') throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')

  const review = plainRecord(value.ownerReview)
  if (!review || !hasExactKeys(review, ['status', 'visibility', 'publication', 'required', 'reviewExpiresAt'])) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (review.status !== 'pending') throw new ConnectorInputError('IMAGE_CANDIDATE_NOT_PENDING_OWNER_REVIEW')
  if (review.visibility !== 'owner-only' || review.publication !== 'blocked' || review.required !== true || !canonicalTimestamp(review.reviewExpiresAt)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
  if (value.candidateId !== candidateId(value.scope, value.requestedBy, value.promptDigest, value.negativePromptDigest, value.width, value.height, review.reviewExpiresAt, value.candidateIndex)) throw new ConnectorInputError('INVALID_IMAGE_REVIEW_CANDIDATE')
}

function assertReviewNotExpired(candidate: SyntheticImageCandidate, occurredAt: Date): void {
  const expiresAt = new Date(candidate.ownerReview.reviewExpiresAt)
  if (occurredAt.getTime() >= expiresAt.getTime()) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_EXPIRED')
}

/**
 * Records exactly the redacted candidate fingerprints from a completed
 * governed run. The returned run provenance must carry the runner's success
 * audit hash; direct connector output intentionally cannot be issued.
 */
export async function issueSyntheticImageCandidates(runResult: ConnectorResult<TextToImageData>, candidateLedger: ImageCandidateLedger, context: ImageCandidateIssuanceContext): Promise<{ issuanceAuditHash: string }> {
  const result = plainRecord(runResult)
  const data = result ? plainRecord(result.data) : null
  const provenance = result ? plainRecord(result.provenance) : null
  const candidateValues = data ? plainArray(data.candidates) : null
  if (!data || data.mode !== LIVE_DISABLED || data.nextAction !== 'INDEPENDENT_OWNER_LIKE_REQUIRED' || data.automaticPublication !== false || !candidateValues || !provenance || provenance.connectorId !== IMAGE_TTI_CONNECTOR_ID || provenance.source !== 'synthetic-image-tti' || typeof provenance.auditHash !== 'string' || !DIGEST_PATTERN.test(provenance.auditHash)) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_RESULT')
  const appendIssuance = dataMethod(candidateLedger, 'appendIssuance')
  if (!appendIssuance) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
  const issuanceContext = imageIssuanceContext(context)
  const occurredAt = currentDate(issuanceContext.now, 'INVALID_IMAGE_CANDIDATE_ISSUANCE_CONTEXT')
  if (candidateValues.length < 1 || candidateValues.length > 32) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_RESULT')

  const candidates: SyntheticImageCandidate[] = []
  for (let index = 0; index < candidateValues.length; index += 1) {
    const candidate = candidateValues[index]
    assertSyntheticImageCandidate(candidate)
    assertReviewNotExpired(candidate, occurredAt)
    if (candidate.candidateIndex !== index || candidate.requestedBy !== issuanceContext.actor || candidate.scope.product !== issuanceContext.product || candidate.scope.workspaceId !== issuanceContext.workspaceId || candidate.scope.correlationId !== issuanceContext.correlationId) throw new ConnectorInputError('INVALID_IMAGE_CANDIDATE_ISSUANCE_RESULT')
    candidates.push(candidate)
  }
  const entries = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    fingerprint: imageCandidateFingerprint(candidate),
    reviewExpiresAt: candidate.ownerReview.reviewExpiresAt,
  }))
  // This public helper is itself an async host boundary. The event is made
  // only from copied/derived redacted values, then frozen before a custom
  // candidate ledger can retain it across its awaited persistence work.
  const event: ImageCandidateIssuanceEvent = freezeData({
    type: 'connector.artifact.candidates_issued',
    connectorId: IMAGE_TTI_CONNECTOR_ID,
    product: issuanceContext.product,
    workspaceId: issuanceContext.workspaceId,
    actor: issuanceContext.actor,
    correlationId: issuanceContext.correlationId,
    scopes: [IMAGE_SCOPE],
    costCapCents: 0,
    requestedItems: entries.length,
    occurredAt: occurredAt.toISOString(),
    detail: {
      candidateSetDigest: imageCandidateSetDigest(candidates),
      candidateCount: entries.length,
      candidates: entries,
      publication: 'blocked',
      runAuditHash: provenance.auditHash,
    },
  })
  const audit = await appendIssuance.call(candidateLedger, event)
  return { issuanceAuditHash: returnedAuditHash(audit, 'IMAGE_CANDIDATE_LEDGER_UNAVAILABLE') }
}

function assertOwnerReviewContext(candidate: SyntheticImageCandidate, context: unknown): { context: ImageOwnerReviewContext; occurredAt: Date } {
  const reviewContext = imageReviewContext(context)
  if (candidate.scope.product !== reviewContext.product || candidate.scope.workspaceId !== reviewContext.workspaceId || candidate.scope.correlationId !== reviewContext.correlationId) throw new ConnectorInputError('IMAGE_REVIEW_SCOPE_MISMATCH')
  const occurredAt = currentDate(reviewContext.now, 'INVALID_IMAGE_OWNER_REVIEW_CONTEXT')
  assertReviewNotExpired(candidate, occurredAt)
  return { context: reviewContext, occurredAt }
}

function assertOwnerReviewRequest(candidate: unknown, ownerApproved: boolean, actor: unknown, reviewLedger: unknown, context: ImageOwnerReviewContext): { candidate: SyntheticImageCandidate; actor: string; context: ImageOwnerReviewContext; occurredAt: Date; appendDecision: (...args: unknown[]) => unknown; assertRecorded: (...args: unknown[]) => unknown } {
  if (ownerApproved !== true) throw new OwnerGateError()
  if (!isSafeIdentifier(actor)) throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
  const sealedCandidate = sealedSyntheticImageCandidate(candidate)
  if (actor === sealedCandidate.requestedBy) throw new OwnerGateError('MAKER_CHECKER_SEPARATION_REQUIRED')
  const appendDecision = dataMethod(reviewLedger, 'appendDecision')
  const assertRecorded = dataMethod(reviewLedger, 'assertRecorded')
  if (!appendDecision || !assertRecorded) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_UNAVAILABLE')
  const review = assertOwnerReviewContext(sealedCandidate, context)
  return { candidate: sealedCandidate, actor, appendDecision, assertRecorded, ...review }
}

function candidateLedgerAssertion(candidateLedger: unknown): (...args: unknown[]) => unknown {
  const assertIssued = dataMethod(candidateLedger, 'assertIssued')
  if (!assertIssued) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_UNAVAILABLE')
  return assertIssued
}

/** Treat a malformed ledger proof as unavailable rather than trusting caller-supplied lineage. */
function assertIssuanceProof(value: unknown): asserts value is ImageCandidateIssuanceProof {
  const proof = plainRecord(value)
  if (!proof || !hasExactKeys(proof, ['issuanceAuditHash', 'runAuditHash', 'issuanceOccurredAt', 'reviewExpiresAt', 'candidateFingerprint']) || typeof proof.issuanceAuditHash !== 'string' || !DIGEST_PATTERN.test(proof.issuanceAuditHash) || typeof proof.runAuditHash !== 'string' || !DIGEST_PATTERN.test(proof.runAuditHash) || !canonicalTimestamp(proof.issuanceOccurredAt) || !canonicalTimestamp(proof.reviewExpiresAt) || typeof proof.candidateFingerprint !== 'string' || !DIGEST_PATTERN.test(proof.candidateFingerprint)) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
}

/**
 * A ledger proof is untrusted at the public helper boundary just like a
 * candidate. Keep a private, immutable lineage snapshot across the later
 * review-ledger await so a retained caller reference cannot invalidate an
 * already-recorded terminal decision or change its returned provenance.
 */
function sealedIssuanceProof(value: unknown): ImageCandidateIssuanceProof {
  try {
    assertIssuanceProof(value)
    const proof = structuredClone(value)
    assertIssuanceProof(proof)
    return freezeData(proof)
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
  }
}

function assertReviewNotBeforeIssuance(occurredAt: Date, issuance: { issuanceOccurredAt: string }): void {
  if (occurredAt.getTime() < new Date(issuance.issuanceOccurredAt).getTime()) throw new ConnectorInputError('IMAGE_OWNER_REVIEW_BEFORE_CANDIDATE_ISSUANCE')
}

/** A terminal helper must bind the presented snapshot to the durable deadline and fingerprint. */
function assertCandidateMatchesIssuance(candidate: SyntheticImageCandidate, issuance: ImageCandidateIssuanceProof): void {
  if (candidate.ownerReview.reviewExpiresAt !== issuance.reviewExpiresAt || imageCandidateFingerprint(candidate) !== issuance.candidateFingerprint) throw new ConnectorUnavailableError('IMAGE_CANDIDATE_LEDGER_INVALID')
}

/** A terminal result is usable only after the review ledger re-reads its own receipt. */
function assertDecisionProof(value: unknown, auditHash: string, issuance: ImageCandidateIssuanceProof): asserts value is ImageOwnerReviewDecisionProof {
  const proof = plainRecord(value)
  if (!proof || !hasExactKeys(proof, ['auditHash', 'issuanceAuditHash', 'runAuditHash', 'reviewExpiresAt', 'candidateFingerprint']) || typeof proof.auditHash !== 'string' || !DIGEST_PATTERN.test(proof.auditHash) || typeof proof.issuanceAuditHash !== 'string' || !DIGEST_PATTERN.test(proof.issuanceAuditHash) || typeof proof.runAuditHash !== 'string' || !DIGEST_PATTERN.test(proof.runAuditHash) || !canonicalTimestamp(proof.reviewExpiresAt) || typeof proof.candidateFingerprint !== 'string' || !DIGEST_PATTERN.test(proof.candidateFingerprint) || proof.auditHash !== auditHash || proof.issuanceAuditHash !== issuance.issuanceAuditHash || proof.runAuditHash !== issuance.runAuditHash || proof.reviewExpiresAt !== issuance.reviewExpiresAt || proof.candidateFingerprint !== issuance.candidateFingerprint) throw new ConnectorUnavailableError('IMAGE_OWNER_REVIEW_LEDGER_INVALID')
}

function reviewAuditEvent(type: 'connector.artifact.owner_liked' | 'connector.artifact.owner_rejected', candidate: SyntheticImageCandidate, actor: string, occurredAt: Date, context: ImageOwnerReviewContext, issuance: ImageCandidateIssuanceProof, detail: Record<string, unknown>): ImageOwnerReviewDecisionEvent {
  return freezeData({
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
    detail: {
      candidateId: candidate.candidateId,
      candidateFingerprint: issuance.candidateFingerprint,
      reviewExpiresAt: issuance.reviewExpiresAt,
      maker: candidate.requestedBy,
      publication: 'blocked',
      issuanceAuditHash: issuance.issuanceAuditHash,
      runAuditHash: issuance.runAuditHash,
      ...detail,
    },
  } as const)
}

/**
 * Converts only a pending owner-review candidate into an owner-liked artifact
 * and atomically persists one terminal receipt with the same audit event. The
 * maker cannot self-approve. The artifact remains blocked from publication.
 */
export async function ownerLikeSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reviewLedger: ImageOwnerReviewLedger, candidateLedger: ImageCandidateLedger, context: ImageOwnerReviewContext): Promise<OwnerLikedImageArtifact> {
  const request = assertOwnerReviewRequest(candidate, ownerApproved, actor, reviewLedger, context)
  const assertIssued = candidateLedgerAssertion(candidateLedger)
  const issuance = sealedIssuanceProof(await assertIssued.call(candidateLedger, request.candidate))
  assertCandidateMatchesIssuance(request.candidate, issuance)
  assertReviewNotBeforeIssuance(request.occurredAt, issuance)
  const artifactId = `owner-liked-${request.candidate.candidateId}`
  const event = reviewAuditEvent('connector.artifact.owner_liked', request.candidate, request.actor, request.occurredAt, request.context, issuance, { artifactId, ownerReview: 'liked' })
  const audit = await request.appendDecision.call(reviewLedger, event)
  const auditHash = returnedAuditHash(audit, 'IMAGE_OWNER_REVIEW_LEDGER_UNAVAILABLE')
  const proof = await request.assertRecorded.call(reviewLedger, event)
  assertDecisionProof(proof, auditHash, issuance)
  return freezeData({
    artifactId,
    candidateId: request.candidate.candidateId,
    mediaType: request.candidate.mediaType,
    previewDataUri: request.candidate.previewDataUri,
    syntheticUri: request.candidate.syntheticUri,
    ownerReview: { status: 'liked', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: request.candidate.ownerReview.reviewExpiresAt, actor: request.actor, occurredAt: request.occurredAt.toISOString() },
    publication: 'blocked',
    auditHash,
    issuanceAuditHash: issuance.issuanceAuditHash,
    runAuditHash: issuance.runAuditHash,
  })
}

/**
 * Records a terminal rejection without returning an artifact URI or preview.
 * Rejection reasons are a closed enum so owner-supplied text cannot enter the
 * audit chain and a replay-protected terminal receipt. This connector never
 * exposes a route, authenticates an actor, or offers a publication path.
 */
export async function ownerRejectSyntheticImage(candidate: SyntheticImageCandidate, ownerApproved: boolean, actor: string, reason: ImageRejectionReason, reviewLedger: ImageOwnerReviewLedger, candidateLedger: ImageCandidateLedger, context: ImageOwnerReviewContext): Promise<OwnerRejectedImageReview> {
  const request = assertOwnerReviewRequest(candidate, ownerApproved, actor, reviewLedger, context)
  const assertIssued = candidateLedgerAssertion(candidateLedger)
  if (reason !== 'NOT_SUITABLE' && reason !== 'SAFETY_CONCERN' && reason !== 'NEEDS_REVISION') throw new ConnectorInputError('INVALID_IMAGE_REJECTION_REASON')
  const issuance = sealedIssuanceProof(await assertIssued.call(candidateLedger, request.candidate))
  assertCandidateMatchesIssuance(request.candidate, issuance)
  assertReviewNotBeforeIssuance(request.occurredAt, issuance)
  const reviewId = `owner-rejected-${request.candidate.candidateId}`
  const event = reviewAuditEvent('connector.artifact.owner_rejected', request.candidate, request.actor, request.occurredAt, request.context, issuance, { reviewId, ownerReview: 'rejected', reason })
  const audit = await request.appendDecision.call(reviewLedger, event)
  const auditHash = returnedAuditHash(audit, 'IMAGE_OWNER_REVIEW_LEDGER_UNAVAILABLE')
  const proof = await request.assertRecorded.call(reviewLedger, event)
  assertDecisionProof(proof, auditHash, issuance)
  return freezeData({
    reviewId,
    candidateId: request.candidate.candidateId,
    ownerReview: { status: 'rejected', visibility: 'owner-only', publication: 'blocked', required: true, reviewExpiresAt: request.candidate.ownerReview.reviewExpiresAt, actor: request.actor, occurredAt: request.occurredAt.toISOString(), reason },
    publication: 'blocked',
    auditHash,
    issuanceAuditHash: issuance.issuanceAuditHash,
    runAuditHash: issuance.runAuditHash,
  })
}

function imageTtiEnvironmentOverrides(value: unknown): { familySafetyFilter?: FamilySafetyFilter } | null {
  const overrides = plainRecord(value)
  if (!overrides || !hasOnlyKeys(overrides, IMAGE_TTI_ENVIRONMENT_OVERRIDE_KEYS)) return null
  const familySafetyFilter = ownDataValue(overrides, 'familySafetyFilter')
  return familySafetyFilter.present ? { familySafetyFilter: familySafetyFilter.value as FamilySafetyFilter } : {}
}

export function syntheticImageTtiConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env, overrides: Pick<SyntheticImageTtiConnectorConfig, 'familySafetyFilter'> = {}): SyntheticImageTtiConnector {
  const safeOverrides = imageTtiEnvironmentOverrides(overrides)
  // Do not spread a caller-owned override: a hidden credential field or an
  // accessor must not be read while composing the synthetic configuration.
  if (!safeOverrides) return new SyntheticImageTtiConnector(null as never)
  return new SyntheticImageTtiConnector({
    liveMode: environment.GCL_IMAGE_LIVE_MODE,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_IMAGE_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_IMAGE_MAX_ITEMS),
    ownerReviewTtlSeconds: environmentPositiveInteger(environment.GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS),
    ...(Object.hasOwn(safeOverrides, 'familySafetyFilter') ? { familySafetyFilter: safeOverrides.familySafetyFilter } : {}),
  })
}
