import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { VIDEO_LIVE_STATUS, type VideoJobQueue } from './video-queue.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const TEXT_TO_VIDEO_CONNECTOR_ID = 'video-text-to-video'
export const IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID = 'video-image-text-to-video'

export type VideoAspectRatio = '16:9' | '9:16' | '1:1'
type VideoRequestFields = {
  prompt: string
  durationSeconds: number
  aspectRatio: VideoAspectRatio
  variants: number
}
export type TextToVideoRequest = VideoRequestFields & { mode: 'text-to-video' }
export type ImageTextToVideoRequest = VideoRequestFields & {
  mode: 'image-text-to-video'
  imageAssetRef: string
}
export type SyntheticVideoRequest = TextToVideoRequest | ImageTextToVideoRequest
export type TextToVideoInput = VideoRequestFields
export type ImageTextToVideoInput = VideoRequestFields & { imageAssetRef: string }

export type SyntheticVideoConnectorConfig = {
  /** This is deliberately unsupported: true closes the route rather than enabling a provider. */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
  maxDurationSeconds?: number
  maxPromptCharacters?: number
}

type ConfiguredVideoLimits = Required<Omit<SyntheticVideoConnectorConfig, 'liveEnabled'>>

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function prompt(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new ConnectorInputError('INVALID_VIDEO_PROMPT')
  return value.trim()
}

function duration(value: unknown, max: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > max) throw new ConnectorInputError('INVALID_VIDEO_DURATION')
  return parsed
}

function variants(value: unknown, max: number): number {
  const parsed = positiveInteger(value)
  if (!parsed || parsed > max) throw new ConnectorInputError('INVALID_VIDEO_VARIANTS')
  return parsed
}

function aspectRatio(value: unknown): VideoAspectRatio {
  if (value !== '16:9' && value !== '9:16' && value !== '1:1') throw new ConnectorInputError('INVALID_VIDEO_ASPECT_RATIO')
  return value
}

function imageAssetRef(value: unknown): string {
  if (typeof value !== 'string' || !/^asset:\/\/[a-zA-Z0-9:_/-]{1,240}$/.test(value)) throw new ConnectorInputError('INVALID_VIDEO_IMAGE_ASSET_REF')
  return value
}

function exactObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectorInputError('INVALID_VIDEO_REQUEST')
  const object = input as Record<string, unknown>
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new ConnectorInputError('INVALID_VIDEO_REQUEST')
  return object
}

function configured(config: SyntheticVideoConnectorConfig, ctx: ConnectorRunContext): ConfiguredVideoLimits {
  if (config.liveEnabled) throw new ConnectorUnavailableError(VIDEO_LIVE_STATUS)
  const maxCostCapCents = positiveInteger(config.maxCostCapCents)
  const maxItems = positiveInteger(config.maxItems)
  const maxDurationSeconds = positiveInteger(config.maxDurationSeconds)
  const maxPromptCharacters = positiveInteger(config.maxPromptCharacters)
  if (!maxCostCapCents || !maxItems || !maxDurationSeconds || !maxPromptCharacters) throw new ConnectorUnavailableError('VIDEO_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
  if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  return { maxCostCapCents, maxItems, maxDurationSeconds, maxPromptCharacters }
}

abstract class SyntheticVideoConnector<TInput, TRequest extends SyntheticVideoRequest> implements Connector<TInput, unknown> {
  abstract readonly id: typeof TEXT_TO_VIDEO_CONNECTOR_ID | typeof IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID
  readonly kind = 'media-generation' as const
  readonly authKind = 'owner-token' as const
  readonly quotaGroup = 'video'
  abstract readonly scopes: readonly string[]

  constructor(private readonly queue: VideoJobQueue, private readonly config: SyntheticVideoConnectorConfig) {}

  protected abstract parse(input: unknown, limits: ConfiguredVideoLimits): TRequest

  async preflight(input: TInput, ctx: ConnectorRunContext): Promise<void> {
    const limits = configured(this.config, ctx)
    const normalized = this.parse(input, limits)
    if (normalized.variants !== ctx.requestedItems) throw new CostCapError('VIDEO_VARIANTS_MUST_MATCH_REQUESTED_ITEMS')
    await this.queue.preflight(ctx)
  }

  async run(input: TInput, ctx: ConnectorRunContext): Promise<ConnectorResult<unknown>> {
    const limits = configured(this.config, ctx)
    const normalized = this.parse(input, limits)
    if (normalized.variants !== ctx.requestedItems) throw new CostCapError('VIDEO_VARIANTS_MUST_MATCH_REQUESTED_ITEMS')
    const job = await this.queue.enqueue({ connectorId: this.id, input: normalized, ...ctx })
    return {
      data: job,
      provenance: {
        connectorId: this.id,
        source: 'synthetic-video-queue',
        retrievedAt: ctx.now().toISOString(),
        runId: job.id,
        untrustedContent: job.untrustedContent,
      },
      confidence: 0,
    }
  }
}

export class SyntheticTextToVideoConnector extends SyntheticVideoConnector<TextToVideoInput, TextToVideoRequest> {
  readonly id = TEXT_TO_VIDEO_CONNECTOR_ID
  readonly scopes = ['video:text-to-video'] as const

  protected parse(input: unknown, limits: ConfiguredVideoLimits): TextToVideoRequest {
    const object = exactObject(input, ['prompt', 'durationSeconds', 'aspectRatio', 'variants'])
    return {
      mode: 'text-to-video',
      prompt: prompt(object.prompt, limits.maxPromptCharacters),
      durationSeconds: duration(object.durationSeconds, limits.maxDurationSeconds),
      aspectRatio: aspectRatio(object.aspectRatio),
      variants: variants(object.variants, limits.maxItems),
    }
  }
}

export class SyntheticImageTextToVideoConnector extends SyntheticVideoConnector<ImageTextToVideoInput, ImageTextToVideoRequest> {
  readonly id = IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID
  readonly scopes = ['video:image-text-to-video'] as const

  protected parse(input: unknown, limits: ConfiguredVideoLimits): ImageTextToVideoRequest {
    const object = exactObject(input, ['prompt', 'durationSeconds', 'aspectRatio', 'variants', 'imageAssetRef'])
    return {
      mode: 'image-text-to-video',
      prompt: prompt(object.prompt, limits.maxPromptCharacters),
      durationSeconds: duration(object.durationSeconds, limits.maxDurationSeconds),
      aspectRatio: aspectRatio(object.aspectRatio),
      variants: variants(object.variants, limits.maxItems),
      imageAssetRef: imageAssetRef(object.imageAssetRef),
    }
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Both connectors are permanently synthetic. A true live flag is an explicit
 * fail-closed error, never an opt-in to a real provider.
 */
export function syntheticVideoConnectorsFromEnvironment(queue: VideoJobQueue, environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  const config: SyntheticVideoConnectorConfig = {
    liveEnabled: environment.GCL_VIDEO_LIVE_ENABLED === 'true',
    maxCostCapCents: environmentPositiveInteger(environment.GCL_VIDEO_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_VIDEO_MAX_ITEMS),
    maxDurationSeconds: environmentPositiveInteger(environment.GCL_VIDEO_MAX_DURATION_SECONDS),
    maxPromptCharacters: environmentPositiveInteger(environment.GCL_VIDEO_MAX_PROMPT_CHARACTERS),
  }
  return [new SyntheticTextToVideoConnector(queue, config), new SyntheticImageTextToVideoConnector(queue, config)]
}
