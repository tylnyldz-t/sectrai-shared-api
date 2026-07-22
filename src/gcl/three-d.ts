import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { ContractOnlyJncPilotMapper, JNC_MAXIMUM_GPU_RUNTIME_SECONDS, type GpuResourceRequest, type JncBlenderPilotHandoff, type JncGpuResourceCard } from './jnc-pilot.js'
import { frozenCanonicalJsonCopy, syntheticPlanSha256 } from './plan-integrity.js'
import { validatedSyntheticConnectorResult } from './result-boundary.js'
import { capturedSyntheticContextTimestamp, validatedConnectorRunContext } from './run-context.js'
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

const CONFIG_KEYS = ['liveMode', 'maxCostCapCents', 'maxItems']

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function connectorConfig(value: SyntheticThreeDConnectorConfig): SyntheticThreeDConnectorConfig {
  try {
    const config = frozenCanonicalJsonCopy<Record<string, unknown>>(value)
    if (Object.keys(config).some((key) => !CONFIG_KEYS.includes(key))) throw new Error()
    return Object.freeze({
      ...(config.liveMode === LIVE_DISABLED ? { liveMode: LIVE_DISABLED } : {}),
      ...(typeof config.maxCostCapCents === 'number' ? { maxCostCapCents: config.maxCostCapCents } : {}),
      ...(typeof config.maxItems === 'number' ? { maxItems: config.maxItems } : {}),
    })
  } catch {
    throw new ConnectorUnavailableError('THREED_INVALID_SYNTHETIC_CONFIG')
  }
}

function inputRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ConnectorInputError('UNEXPECTED_THREED_INPUT_FIELD')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, maximumLength: number, error: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) throw new ConnectorInputError(error)
  return value.trim()
}

function gpuResourceRequest(value: unknown): GpuResourceRequest | undefined {
  if (value === undefined) return undefined
  const request = inputRecord(value, ['computeTier', 'estimatedVramMiB', 'maximumRuntimeSeconds', 'budgetEnvelopeRef'])
  const estimatedVramMiB = request.estimatedVramMiB === 'UNKNOWN' ? 'UNKNOWN' : positiveInteger(request.estimatedVramMiB)
  const maximumRuntimeSeconds = positiveInteger(request.maximumRuntimeSeconds)
  if ((request.computeTier !== 'economy' && request.computeTier !== 'premium') || !estimatedVramMiB || !maximumRuntimeSeconds ||
    maximumRuntimeSeconds > JNC_MAXIMUM_GPU_RUNTIME_SECONDS) throw new ConnectorInputError('INVALID_GPU_RESOURCE_REQUEST')
  return {
    computeTier: request.computeTier,
    estimatedVramMiB,
    maximumRuntimeSeconds,
    budgetEnvelopeRef: text(request.budgetEnvelopeRef, 160, 'INVALID_GPU_BUDGET_REFERENCE'),
  }
}

function textInput(value: unknown): ValidatedTextInput {
  const input = inputRecord(value, ['prompt', 'style', 'outputFormat', 'gpuResourceRequest'])
  const requestedGpu = gpuResourceRequest(input.gpuResourceRequest)
  if (input.outputFormat !== undefined && input.outputFormat !== 'glb' && input.outputFormat !== 'obj') throw new ConnectorInputError('INVALID_THREED_OUTPUT_FORMAT')
  return {
    prompt: text(input.prompt, 4_000, 'INVALID_THREED_PROMPT'),
    outputFormat: input.outputFormat ?? 'glb',
    ...(input.style === undefined ? {} : { style: text(input.style, 160, 'INVALID_THREED_STYLE') }),
    ...(requestedGpu === undefined ? {} : { gpuResourceRequest: requestedGpu }),
  }
}

function imageTextInput(value: unknown): ValidatedTextInput & { image: ImageAssetReference } {
  const input = inputRecord(value, ['prompt', 'image', 'style', 'outputFormat', 'gpuResourceRequest'])
  const image = inputRecord(input.image, ['assetId', 'sha256', 'mediaType'])
  const sha256 = text(image.sha256, 64, 'INVALID_THREED_IMAGE_HASH').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256) || image.mediaType !== 'image/jpeg' && image.mediaType !== 'image/png' && image.mediaType !== 'image/webp') {
    throw new ConnectorInputError('INVALID_THREED_IMAGE_REFERENCE')
  }
  return {
    ...textInput({ prompt: input.prompt, style: input.style, outputFormat: input.outputFormat, gpuResourceRequest: input.gpuResourceRequest }),
    image: { assetId: text(image.assetId, 160, 'INVALID_THREED_IMAGE_ASSET'), sha256, mediaType: image.mediaType },
  }
}

function submittedInput<TInput>(value: unknown): TInput {
  try {
    return frozenCanonicalJsonCopy<TInput>(value)
  } catch {
    throw new ConnectorInputError()
  }
}

function artifactId(connectorKind: SyntheticThreeDResult['connectorKind'], input: unknown, context: ConnectorRunContext): string {
  const digest = syntheticPlanSha256({
    connectorKind, input, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: [...context.scopes].sort(), costCapCents: context.costCapCents, requestedItems: context.requestedItems,
  })
  return `synthetic-3d-${connectorKind}-${digest.slice(0, 24)}`
}

abstract class SyntheticThreeDConnector<TInput> implements Connector<TInput, SyntheticThreeDResult> {
  abstract readonly id: SyntheticThreeDResult['connectorKind']
  abstract readonly connectorKind: SyntheticThreeDResult['connectorKind']
  readonly kind = 'media-3d' as const
  readonly authKind = 'owner-approval' as const
  readonly scopes = Object.freeze(['3d:generate'] as const)
  private readonly mapper = new ContractOnlyJncPilotMapper()
  private readonly config: SyntheticThreeDConnectorConfig

  constructor(config: SyntheticThreeDConnectorConfig = {}) { this.config = connectorConfig(config) }

  protected abstract validate(input: TInput): ValidatedTextInput

  private configured(context: ConnectorRunContext): void {
    if (this.config.liveMode !== LIVE_DISABLED) throw new ConnectorUnavailableError('THREED_LIVE_DISABLED_REQUIRED')
    const maxCostCapCents = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCostCapCents || !maxItems) throw new ConnectorUnavailableError('THREED_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (context.costCapCents > maxCostCapCents) throw new CostCapError()
    if (context.requestedItems > maxItems || context.requestedItems !== 1) throw new CostCapError('THREED_SINGLE_ARTIFACT_ONLY')
  }

  preflight(input: TInput, context: ConnectorRunContext): void {
    const safeContext = validatedConnectorRunContext(context, this.scopes)
    this.validate(submittedInput<TInput>(input))
    this.configured(safeContext)
  }

  async run(input: TInput, context: ConnectorRunContext): Promise<ConnectorResult<SyntheticThreeDResult>> {
    const safeContext = validatedConnectorRunContext(context, this.scopes)
    const rawInput = submittedInput<TInput>(input)
    const plan = this.validate(rawInput)
    this.configured(safeContext)
    const id = artifactId(this.connectorKind, plan, safeContext)
    const source = `synthetic-3d:${this.connectorKind}`
    const artifact: SyntheticThreeDArtifact = {
      artifactId: id, syntheticUri: `synthetic://gcl-3d/${this.connectorKind}/${id}`, generation: 'SYNTHETIC_PROPOSAL_ONLY',
      outputFormat: plan.outputFormat, lifecycle: 'GENERATED_CANDIDATE_NOT_A_FILE', reviewState: 'OWNER_REVIEW_REQUIRED', publicationState: 'NOT_PUBLISHED',
    }
    return validatedSyntheticConnectorResult<SyntheticThreeDResult>({
      data: {
        connectorKind: this.connectorKind, liveMode: LIVE_DISABLED, artifact,
        gpuResourceCard: this.mapper.createGpuResourceCard(plan.gpuResourceRequest), blenderPilotHandoff: this.mapper.createBlenderHandoff(),
      },
      provenance: {
        connectorId: this.id, source, retrievedAt: capturedSyntheticContextTimestamp(safeContext),
        untrustedContent: { source, value: plan, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' } satisfies IsolatedContent,
      },
      confidence: 0,
    }, this.id)
  }
}

export class SyntheticTextToThreeDConnector extends SyntheticThreeDConnector<TextToThreeDInput> {
  readonly id = 'text-to-3d' as const
  readonly connectorKind = 'text-to-3d' as const
  constructor(config: SyntheticThreeDConnectorConfig = {}) { super(config); Object.freeze(this) }
  protected validate(input: TextToThreeDInput): ValidatedTextInput { return textInput(input) }
}

export class SyntheticImageTextToThreeDConnector extends SyntheticThreeDConnector<ImageTextToThreeDInput> {
  readonly id = 'image-text-to-3d' as const
  readonly connectorKind = 'image-text-to-3d' as const
  constructor(config: SyntheticThreeDConnectorConfig = {}) { super(config); Object.freeze(this) }
  protected validate(input: ImageTextToThreeDInput): ValidatedTextInput { return imageTextInput(input) }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  return value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

export function syntheticThreeDConnectorsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  const maxCostCapCents = environmentPositiveInteger(environment.GCL_3D_MAX_COST_CENTS)
  const maxItems = environmentPositiveInteger(environment.GCL_3D_MAX_ITEMS)
  const config = {
    ...(environment.GCL_3D_LIVE_MODE === LIVE_DISABLED ? { liveMode: LIVE_DISABLED } : {}),
    ...(maxCostCapCents === undefined ? {} : { maxCostCapCents }),
    ...(maxItems === undefined ? {} : { maxItems }),
  }
  return [new SyntheticTextToThreeDConnector(config), new SyntheticImageTextToThreeDConnector(config)]
}
