import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext, IsolatedContent } from './types.js'

/**
 * This is the only accepted live-mode value. There is intentionally no
 * LIVE_ENABLED value and no provider client in this module.
 */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const

export type ThreeDOutputFormat = 'glb' | 'obj'
export type ThreeDComputeTier = 'economy' | 'premium'
export type Unknown = 'UNKNOWN'

export type GpuResourceRequest = {
  computeTier: ThreeDComputeTier
  estimatedVramMiB: number | Unknown
  maximumRuntimeSeconds: number
  budgetEnvelopeRef: string
}

export type JarvisGpuResourceCard = {
  contract: 'jarvis-node-controller.gpu-resource-card.v1'
  controller: 'jarvis-node-controller'
  mode: 'CONTRACT_ONLY'
  autostart: false
  dispatchState: 'NOT_DISPATCHED'
  executionAuthorization: 'NOT_AUTHORIZED'
  leaseState: 'NOT_ACQUIRED'
  resourceClass: 'GPU_HEAVY'
  separateOwnerApproval: 'REQUIRED'
  request: GpuResourceRequest | null
  stopConditions: readonly ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'SEPARATE_OWNER_APPROVAL_REQUIRED']
}

/**
 * Contract-only boundary: it creates a resource card and cannot probe, start,
 * schedule, lease, or otherwise contact jarvis-node-controller.
 */
export interface JarvisGpuArbiterHook {
  readonly autostart: false
  createResourceCard(request: GpuResourceRequest | undefined): JarvisGpuResourceCard
}

export class ContractOnlyJarvisGpuArbiterHook implements JarvisGpuArbiterHook {
  readonly autostart = false as const

  createResourceCard(request: GpuResourceRequest | undefined): JarvisGpuResourceCard {
    return {
      contract: 'jarvis-node-controller.gpu-resource-card.v1',
      controller: 'jarvis-node-controller',
      mode: 'CONTRACT_ONLY',
      autostart: false,
      dispatchState: 'NOT_DISPATCHED',
      executionAuthorization: 'NOT_AUTHORIZED',
      leaseState: 'NOT_ACQUIRED',
      resourceClass: 'GPU_HEAVY',
      separateOwnerApproval: 'REQUIRED',
      request: request ?? null,
      stopConditions: ['LIVE_DISABLED', 'AUTOSTART_DISABLED', 'SEPARATE_OWNER_APPROVAL_REQUIRED'],
    }
  }
}

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

export type ImageTextToThreeDInput = TextToThreeDInput & {
  image: ImageAssetReference
}

export type SyntheticThreeDArtifact = {
  artifactId: string
  syntheticUri: string
  generation: 'SYNTHETIC_PROPOSAL_ONLY'
  outputFormat: ThreeDOutputFormat
  reviewState: 'OWNER_REVIEW_REQUIRED'
  publicationState: 'NOT_PUBLISHED'
}

export type SyntheticThreeDResult = {
  connectorKind: 'text-to-3d' | 'image-text-to-3d'
  liveMode: typeof LIVE_DISABLED
  artifact: SyntheticThreeDArtifact
  gpuResourceCard: JarvisGpuResourceCard
}

export type SyntheticThreeDConnectorConfig = {
  liveMode?: typeof LIVE_DISABLED
  maxCostCapCents?: number
  maxItems?: number
  gpuArbiter?: JarvisGpuArbiterHook
}

type ValidatedTextInput = {
  prompt: string
  style: string | undefined
  outputFormat: ThreeDOutputFormat
  gpuResourceRequest: GpuResourceRequest | undefined
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function inputRecord(value: unknown, permittedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !permittedKeys.includes(key))) throw new ConnectorInputError('UNEXPECTED_THREED_INPUT_FIELD')
  return record
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
  if (!maximumRuntimeSeconds || maximumRuntimeSeconds > 5_400) throw new ConnectorInputError('INVALID_GPU_RUNTIME_LIMIT')
  return {
    computeTier: record.computeTier,
    estimatedVramMiB,
    maximumRuntimeSeconds,
    budgetEnvelopeRef: boundedString(record.budgetEnvelopeRef, 160, 'INVALID_GPU_BUDGET_REFERENCE'),
  }
}

function textInput(value: unknown): ValidatedTextInput {
  const record = inputRecord(value, ['prompt', 'style', 'outputFormat', 'gpuResourceRequest'])
  return {
    prompt: boundedString(record.prompt, 4_000, 'INVALID_THREED_PROMPT'),
    style: optionalBoundedString(record.style, 160, 'INVALID_THREED_STYLE'),
    outputFormat: outputFormat(record.outputFormat),
    gpuResourceRequest: gpuResourceRequest(record.gpuResourceRequest),
  }
}

function imageAsset(value: unknown): ImageAssetReference {
  const record = inputRecord(value, ['assetId', 'sha256', 'mediaType'])
  const mediaType = record.mediaType
  if (mediaType !== 'image/jpeg' && mediaType !== 'image/png' && mediaType !== 'image/webp') throw new ConnectorInputError('INVALID_THREED_IMAGE_MEDIA_TYPE')
  const sha256 = boundedString(record.sha256, 64, 'INVALID_THREED_IMAGE_HASH')
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new ConnectorInputError('INVALID_THREED_IMAGE_HASH')
  return { assetId: boundedString(record.assetId, 160, 'INVALID_THREED_IMAGE_ASSET'), sha256: sha256.toLowerCase(), mediaType }
}

function imageTextInput(value: unknown): ValidatedTextInput & { image: ImageAssetReference } {
  const record = inputRecord(value, ['prompt', 'image', 'style', 'outputFormat', 'gpuResourceRequest'])
  return { ...textInput({ prompt: record.prompt, style: record.style, outputFormat: record.outputFormat, gpuResourceRequest: record.gpuResourceRequest }), image: imageAsset(record.image) }
}

function isolatedContent(source: string, value: unknown): IsolatedContent {
  return { source, value, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' }
}

function artifactId(connectorKind: SyntheticThreeDResult['connectorKind'], input: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return `synthetic-3d-${connectorKind}-${digest.slice(0, 24)}`
}

abstract class SyntheticThreeDConnector<TInput> implements Connector<TInput, SyntheticThreeDResult> {
  abstract readonly id: 'text-to-3d' | 'image-text-to-3d'
  abstract readonly connectorKind: SyntheticThreeDResult['connectorKind']
  readonly kind = 'media-3d' as const
  readonly authKind = 'owner-approval' as const
  readonly scopes = ['3d:generate'] as const
  private readonly gpuArbiter: JarvisGpuArbiterHook

  constructor(private readonly config: SyntheticThreeDConnectorConfig = {}) {
    this.gpuArbiter = config.gpuArbiter ?? new ContractOnlyJarvisGpuArbiterHook()
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
    this.validate(input)
    this.configured(context)
  }

  async run(input: TInput, context: ConnectorRunContext): Promise<ConnectorResult<SyntheticThreeDResult>> {
    const validated = this.validate(input)
    this.configured(context)
    const id = artifactId(this.connectorKind, validated)
    const source = `synthetic-3d:${this.connectorKind}`
    return {
      data: {
        connectorKind: this.connectorKind,
        liveMode: LIVE_DISABLED,
        artifact: {
          artifactId: id,
          syntheticUri: `synthetic://gcl-3d/${this.connectorKind}/${id}`,
          generation: 'SYNTHETIC_PROPOSAL_ONLY',
          outputFormat: validated.outputFormat,
          reviewState: 'OWNER_REVIEW_REQUIRED',
          publicationState: 'NOT_PUBLISHED',
        },
        gpuResourceCard: this.gpuArbiter.createResourceCard(validated.gpuResourceRequest),
      },
      provenance: {
        connectorId: this.id,
        source,
        retrievedAt: context.now().toISOString(),
        untrustedContent: isolatedContent(source, validated),
      },
      // This is deterministic proposal plumbing, not a quality assertion about a real 3D model.
      confidence: 0,
    }
  }
}

export class SyntheticTextToThreeDConnector extends SyntheticThreeDConnector<TextToThreeDInput> {
  readonly id = 'text-to-3d' as const
  readonly connectorKind = 'text-to-3d' as const
  protected validate(input: TextToThreeDInput): ValidatedTextInput { return textInput(input) }
}

export class SyntheticImageTextToThreeDConnector extends SyntheticThreeDConnector<ImageTextToThreeDInput> {
  readonly id = 'image-text-to-3d' as const
  readonly connectorKind = 'image-text-to-3d' as const
  protected validate(input: ImageTextToThreeDInput): ValidatedTextInput { return imageTextInput(input) }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Environment wiring has no credential fields. Any missing/other live mode
 * makes both connectors unavailable before audit or quota reservation.
 */
export function syntheticThreeDConnectorsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  const config: SyntheticThreeDConnectorConfig = {
    liveMode: environment.GCL_3D_LIVE_MODE === LIVE_DISABLED ? LIVE_DISABLED : undefined,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_3D_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_3D_MAX_ITEMS),
  }
  return [new SyntheticTextToThreeDConnector(config), new SyntheticImageTextToThreeDConnector(config)]
}
