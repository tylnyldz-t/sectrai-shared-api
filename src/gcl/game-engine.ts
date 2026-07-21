import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import { ContractOnlyJncPilotMapper, type JncBlenderPilotHandoff, type JncGpuResourceCard, type JncUnrealPilotHandoff } from './jnc-pilot.js'
import { deepFreeze, syntheticPlanSha256, type SyntheticPlanIntegrity } from './plan-integrity.js'
import { createSyntheticReviewSnapshot, type SyntheticReviewSnapshot } from './review-snapshot.js'
import type { SyntheticReviewReceipt } from './review-receipt.js'
import { LIVE_DISABLED, type LiveDisabled } from './safety.js'
import type { Connector, ConnectorResult, ConnectorRunContext, IsolatedContent } from './types.js'

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
  commandTemplate?: readonly string[]
}

export type GameEngineBuildPlan = {
  adapter: 'SYNTHETIC'
  liveMode: LiveDisabled
  integrity: SyntheticPlanIntegrity
  reviewReceipt: SyntheticReviewReceipt
  reviewSnapshot: SyntheticReviewSnapshot
  execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED'
  buildId: string
  tier: GameEngineTier
  engine: GameEngineName
  target: GameTarget
  pipeline: readonly SyntheticPipelineStage[]
  buildOutput: { state: 'OWNER_APPROVAL_REQUIRED'; evidence: 'SYNTHETIC_BUILD_PLAN_ONLY' }
  publication: { automatic: false; state: 'DISABLED_NOT_IMPLEMENTED' }
  gpuResourceCard?: JncGpuResourceCard
  jncPilotHandoff?: JncBlenderPilotHandoff | JncUnrealPilotHandoff
}

export type GameEngineConnectorConfig = {
  liveMode?: LiveDisabled
  maxCostCapCents?: number
  maxGpuMinutes?: number
  jncPilotMapper?: ContractOnlyJncPilotMapper
}

function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function inputFrom(value: unknown): GameEngineBuildInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError('GAME_ENGINE_INVALID_INPUT')
  const input = value as Record<string, unknown>
  const allowed = new Set(['tier', 'engine', 'projectId', 'brief', 'target', 'gpuMinutes'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new ConnectorInputError('GAME_ENGINE_INVALID_INPUT')
  if (input.tier !== 'economic' && input.tier !== 'premium') throw new ConnectorInputError('GAME_ENGINE_INVALID_TIER')
  if (input.engine !== 'godot' && input.engine !== 'unreal' && input.engine !== 'blender') throw new ConnectorInputError('GAME_ENGINE_INVALID_ENGINE')
  if (typeof input.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.projectId)) throw new ConnectorInputError('GAME_ENGINE_INVALID_PROJECT_ID')
  if (typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 4_000) throw new ConnectorInputError('GAME_ENGINE_INVALID_BRIEF')
  if (input.target !== 'desktop' && input.target !== 'mobile' && input.target !== 'web') throw new ConnectorInputError('GAME_ENGINE_INVALID_TARGET')
  if (input.tier === 'economic' && (input.engine !== 'godot' || input.gpuMinutes !== undefined)) throw new ConnectorInputError('GODOT_ECONOMIC_PIPELINE_REQUIRED')
  if (input.tier === 'premium' && (input.engine === 'godot' || !positiveInteger(input.gpuMinutes))) throw new ConnectorInputError('PREMIUM_GPU_MINUTES_REQUIRED')
  const gpuMinutes = positiveInteger(input.gpuMinutes) ? input.gpuMinutes : undefined
  return {
    tier: input.tier, engine: input.engine, projectId: input.projectId, brief: input.brief.trim(), target: input.target,
    ...(gpuMinutes === undefined ? {} : { gpuMinutes }),
  }
}

function buildId(input: GameEngineBuildInput, context: ConnectorRunContext): string {
  const digest = syntheticPlanSha256({ input, product: context.product, workspaceId: context.workspaceId, scopes: [...context.scopes].sort(), costCapCents: context.costCapCents, requestedItems: context.requestedItems })
  return `synthetic-game-${digest.slice(0, 20)}`
}

function pipeline(input: GameEngineBuildInput): SyntheticPipelineStage[] {
  if (input.tier === 'economic') {
    return [
      { id: 'project-scaffold', state: 'PLANNED_NOT_EXECUTED' },
      { id: 'godot-headless-import', state: 'PLANNED_NOT_EXECUTED', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--editor', '--quit'] },
      { id: 'godot-headless-export', state: 'PLANNED_NOT_EXECUTED', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--export-release', '<preset>', '<output-path>'] },
      { id: 'owner-build-evidence-review', state: 'PLANNED_NOT_EXECUTED' },
    ]
  }
  return [
    { id: 'jarvis-gpu-contract-card', state: 'PLANNED_NOT_EXECUTED' },
    { id: `${input.engine}-pilot-handoff`, state: 'PLANNED_NOT_EXECUTED' },
    { id: 'owner-build-evidence-review', state: 'PLANNED_NOT_EXECUTED' },
  ]
}

function isolatedContent(input: GameEngineBuildInput): IsolatedContent {
  return { source: 'game-engine-input', value: input, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' }
}

/**
 * Generates a reviewable plan only. No engine process, JNC message, shell,
 * credential, executable path, or project file is ever read by this adapter.
 */
export class SyntheticGameEngineConnector implements Connector<GameEngineBuildInput, GameEngineBuildPlan> {
  readonly id = 'game-engine'
  readonly kind = 'game-engine' as const
  readonly authKind = 'owner-approval' as const
  readonly scopes = ['game:project:build'] as const
  private readonly jncPilotMapper: ContractOnlyJncPilotMapper

  constructor(private readonly config: GameEngineConnectorConfig = {}) {
    this.jncPilotMapper = config.jncPilotMapper ?? new ContractOnlyJncPilotMapper()
  }

  private configured(context: ConnectorRunContext, input: GameEngineBuildInput): void {
    if (this.config.liveMode !== LIVE_DISABLED) throw new ConnectorUnavailableError('GAME_ENGINE_LIVE_DISABLED_REQUIRED')
    if (!positiveInteger(this.config.maxCostCapCents) || !positiveInteger(this.config.maxGpuMinutes)) throw new ConnectorUnavailableError('GAME_ENGINE_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (context.costCapCents > this.config.maxCostCapCents) throw new CostCapError()
    if (input.tier === 'economic' && context.requestedItems !== 1) throw new CostCapError('GODOT_BUILD_UNIT_REQUIRED')
    if (input.tier === 'premium') {
      if (context.requestedItems !== input.gpuMinutes) throw new CostCapError('GPU_QUOTA_UNIT_MISMATCH')
      if ((input.gpuMinutes ?? 0) > this.config.maxGpuMinutes) throw new CostCapError('GPU_MINUTE_CAP_EXCEEDED')
    }
  }

  preflight(value: GameEngineBuildInput, context: ConnectorRunContext): void {
    this.configured(context, inputFrom(value))
  }

  async run(value: GameEngineBuildInput, context: ConnectorRunContext): Promise<ConnectorResult<GameEngineBuildPlan>> {
    const input = inputFrom(value)
    this.configured(context, input)
    const id = buildId(input, context)
    const premiumPlan = input.tier === 'premium'
    const gpuResourceCard = premiumPlan ? this.jncPilotMapper.createGpuResourceCard({
      computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: input.gpuMinutes as number * 60,
      budgetEnvelopeRef: `gcl-game-engine:${id}`,
    }) : undefined
    const jncPilotHandoff = input.engine === 'unreal'
      ? this.jncPilotMapper.createUnrealHandoff()
      : input.engine === 'blender'
        ? this.jncPilotMapper.createBlenderHandoff()
        : undefined
    const planPipeline = pipeline(input)
    const buildOutput = { state: 'OWNER_APPROVAL_REQUIRED' as const, evidence: 'SYNTHETIC_BUILD_PLAN_ONLY' as const }
    const publication = { automatic: false as const, state: 'DISABLED_NOT_IMPLEMENTED' as const }
    const planPayload = {
      connectorId: this.id,
      scope: { product: context.product, workspaceId: context.workspaceId },
      input,
      buildId: id,
      pipeline: planPipeline,
      buildOutput,
      publication,
      ...(gpuResourceCard ? { gpuResourceCard } : {}),
      ...(jncPilotHandoff ? { jncPilotHandoff } : {}),
    }
    const reviewSnapshot = createSyntheticReviewSnapshot({
      connectorId: this.id,
      scope: { product: context.product, workspaceId: context.workspaceId },
      payload: planPayload,
    })
    const data = deepFreeze<GameEngineBuildPlan>({
      adapter: 'SYNTHETIC',
      liveMode: LIVE_DISABLED,
      integrity: reviewSnapshot.integrity,
      reviewReceipt: reviewSnapshot.reviewReceipt,
      reviewSnapshot,
      execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED',
      buildId: id,
      tier: input.tier,
      engine: input.engine,
      target: input.target,
      pipeline: planPipeline,
      buildOutput,
      publication,
      ...(gpuResourceCard ? { gpuResourceCard } : {}),
      ...(jncPilotHandoff ? { jncPilotHandoff } : {}),
    })
    return {
      data,
      provenance: { connectorId: this.id, source: 'synthetic-game-engine-plan', retrievedAt: context.now().toISOString(), runId: id, untrustedContent: isolatedContent(input) },
      confidence: 0,
    }
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Environment wiring admits governance limits only; no credentials or endpoint fields exist. */
export function gameEngineConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticGameEngineConnector {
  return new SyntheticGameEngineConnector({
    liveMode: environment.GCL_GAME_ENGINE_LIVE_MODE === LIVE_DISABLED ? LIVE_DISABLED : undefined,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_COST_CENTS),
    maxGpuMinutes: environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_GPU_MINUTES),
  })
}
