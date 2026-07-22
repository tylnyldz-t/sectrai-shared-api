import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { ContractOnlyJncPilotMapper, JNC_MAXIMUM_GPU_RUNTIME_SECONDS, type GpuResourceRequest, type JncBlenderPilotHandoff, type JncGpuResourceCard } from './jnc-pilot.js'
import { deepFreeze, frozenCanonicalJsonCopy, syntheticPlanSha256, type SyntheticPlanIntegrity } from './plan-integrity.js'
import { syntheticResultReviewBinding, validatedSyntheticConnectorResult } from './result-boundary.js'
import { createSyntheticReviewSnapshot, type SyntheticReviewSnapshot } from './review-snapshot.js'
import type { SyntheticReviewReceipt } from './review-receipt.js'
import { validatedConnectorRunContext } from './run-context.js'
import { LIVE_DISABLED, type LiveDisabled } from './safety.js'
import type { Connector, ConnectorResult, ConnectorRunContext, IsolatedContent } from './types.js'

export type ThreeDOutputFormat = 'glb' | 'obj'

export type TextToThreeDInput = {
  prompt: string
  style?: string
  outputFormat?: ThreeDOutputFormat
  gpuResourceRequest?: GpuResourceRequest
}

export type ImageAssetReference = {
  assetId: string
  sha256: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export type ImageTextToThreeDInput = TextToThreeDInput & { image: ImageAssetReference }

export type SyntheticThreeDArtifact = {
  artifactId: string
  syntheticUri: string
  generation: 'SYNTHETIC_PROPOSAL_ONLY'
  outputFormat: ThreeDOutputFormat
  lifecycle: 'GENERATED_CANDIDATE_NOT_A_FILE'
  reviewState: 'OWNER_REVIEW_REQUIRED'
  publicationState: 'NOT_PUBLISHED'
}

export type SyntheticThreeDResult = {
  connectorKind: 'text-to-3d' | 'image-text-to-3d'
  liveMode: LiveDisabled
  integrity: SyntheticPlanIntegrity
  reviewReceipt: SyntheticReviewReceipt
  reviewSnapshot: SyntheticReviewSnapshot
  artifact: SyntheticThreeDArtifact
  gpuResourceCard: JncGpuResourceCard
  blenderPilotHandoff: JncBlenderPilotHandoff
}

export type SyntheticThreeDConnectorConfig = {
  liveMode?: LiveDisabled
  maxCostCapCents?: number
  maxItems?: number
}

type ValidatedTextInput = {
  prompt: string
  style?: string
  outputFormat: ThreeDOutputFormat
  gpuResourceRequest?: GpuResourceRequest
}

function positiveInteger(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null }

/** Accept configuration data only; a mapper or transport cannot be injected. */
function connectorConfig(value: SyntheticThreeDConnectorConfig): SyntheticThreeDConnectorConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
      throw new ConnectorUnavailableError('THREED_INVALID_SYNTHETIC_CONFIG')
    }
    const names = Object.getOwnPropertyNames(value)
    const allowed = ['liveMode', 'maxCostCapCents', 'maxItems']
    if (names.some((name) => !allowed.includes(name))) throw new ConnectorUnavailableError('THREED_INVALID_SYNTHETIC_CONFIG')
    const output: SyntheticThreeDConnectorConfig = {}
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorUnavailableError('THREED_INVALID_SYNTHETIC_CONFIG')
      if (name === 'liveMode' && descriptor.value === LIVE_DISABLED) output.liveMode = LIVE_DISABLED
      if (name === 'maxCostCapCents' && typeof descriptor.value === 'number') output.maxCostCapCents = descriptor.value
      if (name === 'maxItems' && typeof descriptor.value === 'number') output.maxItems = descriptor.value
    }
    return Object.freeze(output)
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('THREED_INVALID_SYNTHETIC_CONFIG')
  }
}

function inputRecord(value: unknown, permittedKeys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) throw new ConnectorInputError()
    const names = Object.getOwnPropertyNames(value)
    if (names.some((name) => !permittedKeys.includes(name))) throw new ConnectorInputError('UNEXPECTED_THREED_INPUT_FIELD')
    const record = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorInputError()
      record[name] = descriptor.value
    }
    return record
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError()
  }
}

function boundedString(value: unknown, maximumLength: number, error: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) throw new ConnectorInputError(error)
  return value.trim()
}

function optionalBoundedString(value: unknown, maximumLength: number, error: string): string | undefined {
  if (value === undefined) return undefined
  return boundedString(value, maximumLength, error)
}

function outputFormat(value: unknown): ThreeDOutputFormat {
  if (value === undefined) return 'glb'
  if (value === 'glb' || value === 'obj') return value
  throw new ConnectorInputError('INVALID_THREED_OUTPUT_FORMAT')
}

function gpuResourceRequest(value: unknown): GpuResourceRequest | undefined {
  if (value === undefined) return undefined
  const record = inputRecord(value, ['computeTier', 'estimatedVramMiB', 'maximumRuntimeSeconds', 'budgetEnvelopeRef'])
  if (record.computeTier !== 'economy' && record.computeTier !== 'premium') throw new ConnectorInputError('INVALID_GPU_COMPUTE_TIER')
  const estimatedVramMiB = record.estimatedVramMiB === 'UNKNOWN' ? 'UNKNOWN' : positiveInteger(record.estimatedVramMiB)
  if (estimatedVramMiB === null) throw new ConnectorInputError('INVALID_GPU_VRAM_ESTIMATE')
  const maximumRuntimeSeconds = positiveInteger(record.maximumRuntimeSeconds)
  if (!maximumRuntimeSeconds || maximumRuntimeSeconds > JNC_MAXIMUM_GPU_RUNTIME_SECONDS) throw new ConnectorInputError('INVALID_GPU_RUNTIME_LIMIT')
  return {
    computeTier: record.computeTier,
    estimatedVramMiB,
    maximumRuntimeSeconds,
    budgetEnvelopeRef: boundedString(record.budgetEnvelopeRef, 160, 'INVALID_GPU_BUDGET_REFERENCE'),
  }
}

function textInput(value: unknown): ValidatedTextInput {
  const record = inputRecord(value, ['prompt', 'style', 'outputFormat', 'gpuResourceRequest'])
  const style = optionalBoundedString(record.style, 160, 'INVALID_THREED_STYLE')
  const requestedGpu = gpuResourceRequest(record.gpuResourceRequest)
  return {
    prompt: boundedString(record.prompt, 4_000, 'INVALID_THREED_PROMPT'),
    outputFormat: outputFormat(record.outputFormat),
    ...(style === undefined ? {} : { style }),
    ...(requestedGpu === undefined ? {} : { gpuResourceRequest: requestedGpu }),
  }
}

function imageAsset(value: unknown): ImageAssetReference {
  const record = inputRecord(value, ['assetId', 'sha256', 'mediaType'])
  if (record.mediaType !== 'image/jpeg' && record.mediaType !== 'image/png' && record.mediaType !== 'image/webp') throw new ConnectorInputError('INVALID_THREED_IMAGE_MEDIA_TYPE')
  const sha256 = boundedString(record.sha256, 64, 'INVALID_THREED_IMAGE_HASH')
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new ConnectorInputError('INVALID_THREED_IMAGE_HASH')
  return { assetId: boundedString(record.assetId, 160, 'INVALID_THREED_IMAGE_ASSET'), sha256: sha256.toLowerCase(), mediaType: record.mediaType }
}

function imageTextInput(value: unknown): ValidatedTextInput & { image: ImageAssetReference } {
  const record = inputRecord(value, ['prompt', 'image', 'style', 'outputFormat', 'gpuResourceRequest'])
  return {
    ...textInput({ prompt: record.prompt, style: record.style, outputFormat: record.outputFormat, gpuResourceRequest: record.gpuResourceRequest }),
    image: imageAsset(record.image),
  }
}

/** Isolate direct caller data before it reaches validation or a review plan. */
function submittedInput<TInput>(value: unknown): TInput {
  try {
    return frozenCanonicalJsonCopy<TInput>(value)
  } catch {
    throw new ConnectorInputError()
  }
}

function isolatedContent(source: string, value: unknown): IsolatedContent {
  return { source, value, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' }
}

/**
 * A synthetic URI is still a review handle, so it must not alias a proposal
 * made by another owner or under a different reservation envelope.  This is
 * correlation data only; it neither names a file nor authorises a hand-off.
 */
function artifactId(
  connectorKind: SyntheticThreeDResult['connectorKind'],
  input: unknown,
  context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'actor' | 'scopes' | 'costCapCents' | 'requestedItems'>,
): string {
  const digest = syntheticPlanSha256({
    connectorKind,
    input,
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    scopes: [...context.scopes].sort(),
    costCapCents: context.costCapCents,
    requestedItems: context.requestedItems,
  })
  return `synthetic-3d-${connectorKind}-${digest.slice(0, 24)}`
}

abstract class SyntheticThreeDConnector<TInput> implements Connector<TInput, SyntheticThreeDResult> {
  abstract readonly id: 'text-to-3d' | 'image-text-to-3d'
  abstract readonly connectorKind: SyntheticThreeDResult['connectorKind']
  readonly kind = 'media-3d' as const
  readonly authKind = 'owner-approval' as const
  readonly scopes = Object.freeze(['3d:generate'] as const)
  private readonly jncPilotMapper: ContractOnlyJncPilotMapper

  private readonly config: SyntheticThreeDConnectorConfig

  constructor(config: SyntheticThreeDConnectorConfig = {}) {
    this.config = connectorConfig(config)
    this.jncPilotMapper = new ContractOnlyJncPilotMapper()
  }

  protected abstract validate(input: TInput): ValidatedTextInput

  private configured(context: ConnectorRunContext): void {
    if (this.config.liveMode !== LIVE_DISABLED) throw new ConnectorUnavailableError('THREED_LIVE_DISABLED_REQUIRED')
    const maxCostCapCents = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCostCapCents || !maxItems) throw new ConnectorUnavailableError('THREED_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (context.costCapCents > maxCostCapCents) throw new CostCapError()
    if (context.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    if (context.requestedItems !== 1) throw new CostCapError('THREED_SINGLE_ARTIFACT_ONLY')
  }

  preflight(input: TInput, context: ConnectorRunContext): void {
    const validatedContext = validatedConnectorRunContext(context, this.scopes)
    this.validate(submittedInput<TInput>(input))
    this.configured(validatedContext)
  }

  async run(input: TInput, context: ConnectorRunContext): Promise<ConnectorResult<SyntheticThreeDResult>> {
    const validatedContext = validatedConnectorRunContext(context, this.scopes)
    const rawInput = submittedInput<TInput>(input)
    const submittedInputSha256 = syntheticPlanSha256(rawInput)
    const validated = this.validate(rawInput)
    this.configured(validatedContext)
    const id = artifactId(this.connectorKind, validated, validatedContext)
    const source = `synthetic-3d:${this.connectorKind}`
    const artifact: SyntheticThreeDArtifact = {
      artifactId: id,
      syntheticUri: `synthetic://gcl-3d/${this.connectorKind}/${id}`,
      generation: 'SYNTHETIC_PROPOSAL_ONLY',
      outputFormat: validated.outputFormat,
      lifecycle: 'GENERATED_CANDIDATE_NOT_A_FILE',
      reviewState: 'OWNER_REVIEW_REQUIRED',
      publicationState: 'NOT_PUBLISHED',
    }
    const gpuResourceCard = this.jncPilotMapper.createGpuResourceCard(validated.gpuResourceRequest)
    const blenderPilotHandoff = this.jncPilotMapper.createBlenderHandoff()
    const planPayload = {
      connectorId: this.id,
      scope: { product: validatedContext.product, workspaceId: validatedContext.workspaceId },
      actor: validatedContext.actor,
      governance: {
        scopes: [...validatedContext.scopes].sort(),
        costCapCents: validatedContext.costCapCents,
        requestedItems: validatedContext.requestedItems,
      },
      submittedInputSha256,
      input: validated,
      artifact,
      gpuResourceCard,
      blenderPilotHandoff,
    }
    const reviewSnapshot = createSyntheticReviewSnapshot({
      connectorId: this.id,
      scope: { product: validatedContext.product, workspaceId: validatedContext.workspaceId },
      payload: planPayload,
    })
    const data = deepFreeze<SyntheticThreeDResult>({
      connectorKind: this.connectorKind,
      liveMode: LIVE_DISABLED,
      integrity: reviewSnapshot.integrity,
      reviewReceipt: reviewSnapshot.reviewReceipt,
      reviewSnapshot,
      artifact,
      gpuResourceCard,
      blenderPilotHandoff,
    })
    return validatedSyntheticConnectorResult<SyntheticThreeDResult>({
      data,
      provenance: { connectorId: this.id, source, retrievedAt: validatedContext.now().toISOString(), untrustedContent: isolatedContent(source, validated) },
      confidence: 0,
    }, this.id, rawInput, syntheticResultReviewBinding(validatedContext))
  }
}

export class SyntheticTextToThreeDConnector extends SyntheticThreeDConnector<TextToThreeDInput> {
  readonly id = 'text-to-3d' as const
  readonly connectorKind = 'text-to-3d' as const
  constructor(config: SyntheticThreeDConnectorConfig = {}) {
    super(config)
    Object.freeze(this)
  }
  protected validate(input: TextToThreeDInput): ValidatedTextInput { return textInput(input) }
}

export class SyntheticImageTextToThreeDConnector extends SyntheticThreeDConnector<ImageTextToThreeDInput> {
  readonly id = 'image-text-to-3d' as const
  readonly connectorKind = 'image-text-to-3d' as const
  constructor(config: SyntheticThreeDConnectorConfig = {}) {
    super(config)
    Object.freeze(this)
  }
  protected validate(input: ImageTextToThreeDInput): ValidatedTextInput { return imageTextInput(input) }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Environment wiring accepts no provider or JNC transport settings. */
export function syntheticThreeDConnectorsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  const config: SyntheticThreeDConnectorConfig = {
    liveMode: environment.GCL_3D_LIVE_MODE === LIVE_DISABLED ? LIVE_DISABLED : undefined,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_3D_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_3D_MAX_ITEMS),
  }
  return [new SyntheticTextToThreeDConnector(config), new SyntheticImageTextToThreeDConnector(config)]
}
