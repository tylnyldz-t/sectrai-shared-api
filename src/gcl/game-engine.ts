import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from './types.js'

/** This constant is intentional: this adapter can create plans, never execute engines or contact GPU nodes. */
export const LIVE_DISABLED = true as const

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
  state: 'planned-not-executed'
  commandTemplate?: readonly string[]
}

export type GameEngineBuildPlan = {
  adapter: 'SYNTHETIC'
  liveDisabled: true
  execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED'
  buildId: string
  tier: GameEngineTier
  engine: GameEngineName
  target: GameTarget
  pipeline: readonly SyntheticPipelineStage[]
  buildOutput: {
    state: 'OWNER_APPROVAL_REQUIRED'
    evidence: 'synthetic-build-plan-only'
  }
  publication: {
    automatic: false
    state: 'DISABLED_NOT_IMPLEMENTED'
  }
  gpuArbitration?: {
    provider: 'jarvis-node-controller'
    contract: 'jarvis-node-controller.gpu-arbitration.v1'
    state: 'SYNTHETIC_HOOK_ONLY_NOT_SENT'
    autoStart: false
    requestedGpuMinutes: number
    costCapCents: number
  }
}

export type GameEngineConnectorConfig = {
  /** A true value is rejected; it can never turn on live execution. */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxGpuMinutes?: number
}

function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

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
  return { tier: input.tier, engine: input.engine, projectId: input.projectId, brief: input.brief.trim(), target: input.target, ...(gpuMinutes === undefined ? {} : { gpuMinutes }) }
}

function buildId(input: GameEngineBuildInput, ctx: ConnectorRunContext): string {
  const fingerprint = JSON.stringify({ input, product: ctx.product, workspaceId: ctx.workspaceId, costCapCents: ctx.costCapCents, requestedItems: ctx.requestedItems })
  return `synthetic-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 20)}`
}

function pipeline(input: GameEngineBuildInput): SyntheticPipelineStage[] {
  if (input.tier === 'economic') {
    return [
      { id: 'project-scaffold', state: 'planned-not-executed' },
      { id: 'godot-headless-import', state: 'planned-not-executed', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--editor', '--quit'] },
      { id: 'godot-headless-export', state: 'planned-not-executed', commandTemplate: ['godot', '--headless', '--path', '<project-dir>', '--export-release', '<preset>', '<output-path>'] },
      { id: 'owner-build-evidence-review', state: 'planned-not-executed' },
    ]
  }
  return [
    { id: 'jarvis-gpu-arbitration-request', state: 'planned-not-executed' },
    { id: `${input.engine}-project-pipeline`, state: 'planned-not-executed' },
    { id: 'owner-build-evidence-review', state: 'planned-not-executed' },
  ]
}

/**
 * A deterministic connector contract for GM6. It intentionally has no process,
 * network, credential, or provider client dependency. Its only output is a
 * data-only build plan that an owner may review; publication is not an action.
 */
export class SyntheticGameEngineConnector implements Connector<GameEngineBuildInput, GameEngineBuildPlan> {
  readonly id = 'game-engine'
  readonly kind = 'game-engine' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = ['game:project:build'] as const

  constructor(private readonly config: GameEngineConnectorConfig = {}) {}

  private configured(ctx: ConnectorRunContext, input: GameEngineBuildInput): void {
    if (!LIVE_DISABLED || this.config.liveEnabled === true) throw new ConnectorUnavailableError('GAME_ENGINE_LIVE_DISABLED')
    if (!positiveInteger(this.config.maxCostCapCents) || !positiveInteger(this.config.maxGpuMinutes)) throw new ConnectorUnavailableError('GAME_ENGINE_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (ctx.costCapCents > this.config.maxCostCapCents) throw new CostCapError()
    if (input.tier === 'economic' && ctx.requestedItems !== 1) throw new CostCapError('GODOT_BUILD_UNIT_REQUIRED')
    if (input.tier === 'premium') {
      if (ctx.requestedItems !== input.gpuMinutes) throw new CostCapError('GPU_QUOTA_UNIT_MISMATCH')
      if (input.gpuMinutes > this.config.maxGpuMinutes) throw new CostCapError('GPU_MINUTE_CAP_EXCEEDED')
    }
  }

  preflight(value: GameEngineBuildInput, ctx: ConnectorRunContext): void {
    this.configured(ctx, inputFrom(value))
  }

  async run(value: GameEngineBuildInput, ctx: ConnectorRunContext): Promise<ConnectorResult<GameEngineBuildPlan>> {
    const input = inputFrom(value)
    this.configured(ctx, input)
    const data: GameEngineBuildPlan = {
      adapter: 'SYNTHETIC',
      liveDisabled: LIVE_DISABLED,
      execution: 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED',
      buildId: buildId(input, ctx),
      tier: input.tier,
      engine: input.engine,
      target: input.target,
      pipeline: pipeline(input),
      buildOutput: { state: 'OWNER_APPROVAL_REQUIRED', evidence: 'synthetic-build-plan-only' },
      publication: { automatic: false, state: 'DISABLED_NOT_IMPLEMENTED' },
      ...(input.tier === 'premium' ? {
        gpuArbitration: {
          provider: 'jarvis-node-controller',
          contract: 'jarvis-node-controller.gpu-arbitration.v1',
          state: 'SYNTHETIC_HOOK_ONLY_NOT_SENT',
          autoStart: false,
          requestedGpuMinutes: input.gpuMinutes as number,
          costCapCents: ctx.costCapCents,
        },
      } : {}),
    }
    return {
      data,
      provenance: {
        connectorId: this.id,
        source: 'synthetic-game-engine-plan',
        retrievedAt: ctx.now().toISOString(),
        runId: data.buildId,
        untrustedContent: { source: 'game-engine-input', value: input, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
      confidence: 1,
    }
  }
}

export function gameEngineConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticGameEngineConnector {
  return new SyntheticGameEngineConnector({
    liveEnabled: environment.GCL_GAME_ENGINE_LIVE_ENABLED === 'true',
    maxCostCapCents: environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_COST_CENTS),
    maxGpuMinutes: environmentPositiveInteger(environment.GCL_GAME_ENGINE_MAX_GPU_MINUTES),
  })
}
