import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { ContractOnlyJncPilotMapper, JNC_MAXIMUM_GPU_RUNTIME_MINUTES, type JncBlenderPilotHandoff, type JncGpuResourceCard, type JncUnrealPilotHandoff } from './jnc-pilot.js'
import { frozenCanonicalJsonCopy, syntheticPlanSha256 } from './plan-integrity.js'
import { validatedSyntheticConnectorResult } from './result-boundary.js'
import { capturedSyntheticContextTimestamp, validatedConnectorRunContext } from './run-context.js'
import { LIVE_DISABLED, type LiveDisabled } from './safety.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export type GameEngineTier = 'economic' | 'premium'
export type GameEngineName = 'godot' | 'unreal' | 'blender'
export type GameTarget = 'desktop' | 'mobile' | 'web'

export type GameEngineBuildInput = {
  tier: GameEngineTier
  engine: GameEngineName
  projectId: string
  brief: string
  target: GameTarget
  gpuMinutes?: number
}

export type SyntheticPipelineStage = {
  id: string
  state: 'PLANNED_NOT_EXECUTED'
}

export type GameEngineBuildPlan = {
  adapter: 'SYNTHETIC'
  liveMode: LiveDisabled
  execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED'
  buildId: string
  tier: GameEngineTier
  engine: GameEngineName
  target: GameTarget
  pipeline: readonly SyntheticPipelineStage[]
  ownerReview: 'REQUIRED'
  publication: 'NOT_PUBLISHED'
  gpuResourceCard?: JncGpuResourceCard
  jncPilotHandoff?: JncBlenderPilotHandoff | JncUnrealPilotHandoff
}

export type GameEngineConnectorConfig = {
  liveMode?: LiveDisabled
  maxCostCapCents?: number
  maxGpuMinutes?: number
}

const CONFIG_KEYS = ['liveMode', 'maxCostCapCents', 'maxGpuMinutes']

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function connectorConfig(value: GameEngineConnectorConfig): GameEngineConnectorConfig {
  try {
    const config = frozenCanonicalJsonCopy<Record<string, unknown>>(value)
    if (Object.keys(config).some((key) => !CONFIG_KEYS.includes(key))) throw new Error()
    return Object.freeze({
      ...(config.liveMode === LIVE_DISABLED ? { liveMode: LIVE_DISABLED } : {}),
      ...(typeof config.maxCostCapCents === 'number' ? { maxCostCapCents: config.maxCostCapCents } : {}),
      ...(typeof config.maxGpuMinutes === 'number' ? { maxGpuMinutes: config.maxGpuMinutes } : {}),
    })
  } catch {
    throw new ConnectorUnavailableError('GAME_ENGINE_INVALID_SYNTHETIC_CONFIG')
  }
}

function inputFrom(value: unknown): GameEngineBuildInput {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const input = value as Record<string, unknown>
    const allowed = ['tier', 'engine', 'projectId', 'brief', 'target', 'gpuMinutes']
    if (Object.keys(input).some((key) => !allowed.includes(key)) ||
      input.tier !== 'economic' && input.tier !== 'premium' || input.engine !== 'godot' && input.engine !== 'unreal' && input.engine !== 'blender' ||
      typeof input.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.projectId) || typeof input.brief !== 'string' || !input.brief.trim() ||
      input.brief.trim().length > 4_000 || input.target !== 'desktop' && input.target !== 'mobile' && input.target !== 'web') throw new Error()
    if (input.tier === 'economic' && (input.engine !== 'godot' || input.gpuMinutes !== undefined) ||
      input.tier === 'premium' && (input.engine === 'godot' || !positiveInteger(input.gpuMinutes))) throw new Error()
    return {
      tier: input.tier, engine: input.engine, projectId: input.projectId, brief: input.brief.trim(), target: input.target,
      ...(input.tier === 'premium' ? { gpuMinutes: input.gpuMinutes as number } : {}),
    }
  } catch {
    throw new ConnectorInputError('GAME_ENGINE_INVALID_INPUT')
  }
}

function submittedInput(value: unknown): GameEngineBuildInput {
  try {
    return frozenCanonicalJsonCopy<GameEngineBuildInput>(value)
  } catch {
    throw new ConnectorInputError('GAME_ENGINE_INVALID_INPUT')
  }
}

function buildId(input: GameEngineBuildInput, context: ConnectorRunContext): string {
  const digest = syntheticPlanSha256({
    input, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: [...context.scopes].sort(), costCapCents: context.costCapCents, requestedItems: context.requestedItems,
  })
  return `synthetic-game-${digest.slice(0, 20)}`
}

function pipeline(input: GameEngineBuildInput): SyntheticPipelineStage[] {
  const ids = input.tier === 'economic'
    ? ['godot-project-plan', 'owner-build-review']
    : ['gpu-contract', `${input.engine}-handoff`, 'owner-build-review']
  return ids.map((id) => ({ id, state: 'PLANNED_NOT_EXECUTED' }))
}

/** Produces review data only; it never launches an engine, shell, or controller. */
export class SyntheticGameEngineConnector implements Connector<GameEngineBuildInput, GameEngineBuildPlan> {
  readonly id = 'game-engine'
  readonly kind = 'game-engine' as const
  readonly authKind = 'owner-approval' as const
  readonly scopes = Object.freeze(['game:project:build'] as const)
  private readonly mapper = new ContractOnlyJncPilotMapper()
  private readonly config: GameEngineConnectorConfig

  constructor(config: GameEngineConnectorConfig = {}) { this.config = connectorConfig(config); Object.freeze(this) }

  private configured(context: ConnectorRunContext, input: GameEngineBuildInput): void {
    const maxGpuMinutes = this.config.maxGpuMinutes
    if (this.config.liveMode !== LIVE_DISABLED) throw new ConnectorUnavailableError('GAME_ENGINE_LIVE_DISABLED_REQUIRED')
    if (!positiveInteger(this.config.maxCostCapCents) || !positiveInteger(maxGpuMinutes) || maxGpuMinutes > JNC_MAXIMUM_GPU_RUNTIME_MINUTES) {
      throw new ConnectorUnavailableError('GAME_ENGINE_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    }
    if (context.costCapCents > this.config.maxCostCapCents) throw new CostCapError()
    if (input.tier === 'economic' && context.requestedItems !== 1) throw new CostCapError('GODOT_BUILD_UNIT_REQUIRED')
    if (input.tier === 'premium' && (context.requestedItems !== input.gpuMinutes || input.gpuMinutes > maxGpuMinutes || input.gpuMinutes > JNC_MAXIMUM_GPU_RUNTIME_MINUTES)) {
      throw new CostCapError('GPU_QUOTA_UNIT_MISMATCH')
    }
  }

  preflight(value: GameEngineBuildInput, context: ConnectorRunContext): void {
    const safeContext = validatedConnectorRunContext(context, this.scopes)
    this.configured(safeContext, inputFrom(submittedInput(value)))
  }

  async run(value: GameEngineBuildInput, context: ConnectorRunContext): Promise<ConnectorResult<GameEngineBuildPlan>> {
    const safeContext = validatedConnectorRunContext(context, this.scopes)
    const input = inputFrom(submittedInput(value))
    this.configured(safeContext, input)
    const id = buildId(input, safeContext)
    const premium = input.tier === 'premium'
    const handoff = input.engine === 'unreal' ? this.mapper.createUnrealHandoff() : input.engine === 'blender' ? this.mapper.createBlenderHandoff() : undefined
    return validatedSyntheticConnectorResult<GameEngineBuildPlan>({
      data: {
        adapter: 'SYNTHETIC', liveMode: LIVE_DISABLED, execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED', buildId: id,
        tier: input.tier, engine: input.engine, target: input.target, pipeline: pipeline(input), ownerReview: 'REQUIRED', publication: 'NOT_PUBLISHED',
        ...(premium ? {
          gpuResourceCard: this.mapper.createGpuResourceCard({
            computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: input.gpuMinutes as number * 60,
            budgetEnvelopeRef: `gcl-game-engine:${id}`,
          }),
          ...(handoff ? { jncPilotHandoff: handoff } : {}),
        } : {}),
      },
      provenance: {
        connectorId: this.id, source: 'synthetic-game-engine-plan', retrievedAt: capturedSyntheticContextTimestamp(safeContext), runId: id,
        untrustedContent: { source: 'game-engine-input', value: input, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
      confidence: 0,
    }, this.id)
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  return value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

export function gameEngineConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticGameEngineConnector {
  const maxCostCapCents = environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_COST_CENTS)
  const maxGpuMinutes = environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_GPU_MINUTES)
  return new SyntheticGameEngineConnector({
    ...(environment.GCL_GAME_ENGINE_LIVE_MODE === LIVE_DISABLED ? { liveMode: LIVE_DISABLED } : {}),
    ...(maxCostCapCents === undefined ? {} : { maxCostCapCents }),
    ...(maxGpuMinutes === undefined ? {} : { maxGpuMinutes }),
  })
}
