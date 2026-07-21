import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError } from '../src/gcl/errors.js'
import { gameEngineConnectorFromEnvironment, SyntheticGameEngineConnector, type GameEngineBuildInput, type GameEngineBuildPlan } from '../src/gcl/game-engine.js'
import { ownerGateError } from '../src/gcl/owner-gate.js'
import { InMemoryDailyConnectorQuota } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import { LIVE_DISABLED } from '../src/gcl/safety.js'
import { syntheticThreeDConnectorsFromEnvironment, SyntheticImageTextToThreeDConnector, SyntheticTextToThreeDConnector, type SyntheticThreeDConnectorConfig, type SyntheticThreeDResult } from '../src/gcl/three-d.js'
import type { Connector, ConnectorResult } from '../src/gcl/types.js'

const fixedNow = () => new Date('2026-07-22T10:00:00.000Z')

function request(overrides: Partial<RunConnectorRequest> = {}): RunConnectorRequest {
  return {
    connectorId: 'text-to-3d',
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb' },
    product: 'sectrai-gm-contract-test',
    workspaceId: 'gm-workspace',
    actor: 'synthetic-owner',
    ownerApproved: true,
    scopes: ['3d:generate'],
    costCapCents: 50,
    requestedItems: 1,
    ...overrides,
  }
}

function threeDConfig(overrides: Partial<SyntheticThreeDConnectorConfig> = {}): SyntheticThreeDConnectorConfig {
  return { liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxItems: 1, ...overrides }
}

function runner(connector: Connector, quota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })) {
  const audit = new InMemoryHashChainAuditLog()
  return { audit, quota, run: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, fixedNow) }
}

test('GM5 returns only a synthetic proposal, an unleased GPU contract card, and a CPU-only Blender pilot hand-off', async () => {
  const { audit, quota, run } = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  const result = await run.run(request({
    input: {
      prompt: 'A low-poly solar system model for a classroom',
      style: 'educational',
      gpuResourceRequest: { computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: 900, budgetEnvelopeRef: 'budget:gm5-synthetic' },
    },
  })) as ConnectorResult<SyntheticThreeDResult>

  assert.equal(result.data.liveMode, LIVE_DISABLED)
  assert.equal(result.data.artifact.generation, 'SYNTHETIC_PROPOSAL_ONLY')
  assert.equal(result.data.artifact.lifecycle, 'GENERATED_CANDIDATE_NOT_A_FILE')
  assert.equal(result.data.artifact.publicationState, 'NOT_PUBLISHED')
  assert.match(result.data.artifact.syntheticUri, /^synthetic:\/\/gcl-3d\/text-to-3d\//)
  assert.equal(result.data.gpuResourceCard.mode, 'CONTRACT_ONLY')
  assert.equal(result.data.gpuResourceCard.transport, 'NONE')
  assert.equal(result.data.gpuResourceCard.autostart, false)
  assert.equal(result.data.gpuResourceCard.dispatchState, 'NOT_DISPATCHED')
  assert.equal(result.data.gpuResourceCard.executionAuthorization, 'NOT_AUTHORIZED')
  assert.equal(result.data.gpuResourceCard.leaseState, 'NOT_ACQUIRED')
  assert.equal(result.data.blenderPilotHandoff.state, 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT')
  assert.equal(result.data.blenderPilotHandoff.gpu.compute, 'CPU_ONLY_PILOT')
  assert.equal(result.data.blenderPilotHandoff.gpu.exclusiveGpu, false)
  assert.equal(result.data.blenderPilotHandoff.destination, 'BATCH_SCOPED_STAGING_ONLY')
  assert.equal(result.data.blenderPilotHandoff.publication, 'OWNER_REVIEW_REQUIRED_NOT_PUBLISHED')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(quota.reservations.length, 1)
})

test('GM5 image-plus-text accepts only an immutable local reference and closes before audit for a URL', async () => {
  const invalid = runner(new SyntheticImageTextToThreeDConnector(threeDConfig()))
  await assert.rejects(invalid.run.run(request({
    connectorId: 'image-text-to-3d',
    input: { prompt: 'Turn this drawing into an educational model', imageUrl: 'https://provider.invalid/example.png' },
  })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_THREED_INPUT_FIELD')
  assert.equal(invalid.audit.entries.length, 0)
  assert.equal(invalid.quota.reservations.length, 0)

  const valid = runner(new SyntheticImageTextToThreeDConnector(threeDConfig()))
  const result = await valid.run.run(request({
    connectorId: 'image-text-to-3d',
    input: {
      prompt: 'Turn this drawing into an educational model',
      image: { assetId: 'local-asset-leaf', sha256: 'a'.repeat(64), mediaType: 'image/png' },
      outputFormat: 'obj',
    },
  })) as ConnectorResult<SyntheticThreeDResult>
  assert.equal(result.data.artifact.outputFormat, 'obj')
})

const premiumUnreal: GameEngineBuildInput = {
  tier: 'premium', engine: 'unreal', projectId: 'forest-cinematic', brief: 'Cinematic forest level preview.', target: 'desktop', gpuMinutes: 12,
}

function gameRequest(input: GameEngineBuildInput, requestedItems = input.gpuMinutes ?? 1): RunConnectorRequest {
  return {
    connectorId: 'game-engine', input, product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace', actor: 'synthetic-owner',
    ownerApproved: true, scopes: ['game:project:build'], costCapCents: 100, requestedItems,
  }
}

test('GM6 maps premium Unreal and Blender plans to JNC pilot contracts without sending either one', async () => {
  const connector = new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 200, maxGpuMinutes: 30 })
  const governed = runner(connector)
  const unreal = await governed.run.run(gameRequest(premiumUnreal)) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(unreal.data.execution, 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED')
  assert.equal(unreal.data.gpuResourceCard?.mode, 'CONTRACT_ONLY')
  assert.equal(unreal.data.gpuResourceCard?.transport, 'NONE')
  assert.equal(unreal.data.jncPilotHandoff?.contract, 'jarvis-node-controller.unreal-cli-pilot.v1')
  assert.equal(unreal.data.jncPilotHandoff?.state, 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT')
  assert.equal(unreal.data.jncPilotHandoff?.project, 'REQUIRED')
  assert.equal(unreal.data.jncPilotHandoff?.renderer, 'NULL_RHI_NO_RENDER')
  assert.equal(unreal.data.jncPilotHandoff?.productionPromotion, 'DISABLED_OWNER_APPROVAL_REQUIRED')
  assert.equal(unreal.data.publication.automatic, false)
  assert.equal(unreal.data.publication.state, 'DISABLED_NOT_IMPLEMENTED')

  const blender = await governed.run.run(gameRequest({ ...premiumUnreal, engine: 'blender', projectId: 'forest-assets' })) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(blender.data.jncPilotHandoff?.contract, 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1')
  assert.equal(blender.data.jncPilotHandoff?.state, 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT')
  assert.equal('gpu' in (blender.data.jncPilotHandoff ?? {}), true)
  if (blender.data.jncPilotHandoff?.contract === 'jarvis-node-controller.windows-blender-neutral-asset-pilot.v1') {
    assert.equal(blender.data.jncPilotHandoff.gpu.deviceSelection, 'NOT_SUPPORTED')
  }
})

test('missing LIVE_DISABLED, owner approval, cost mismatches, and publication input fail closed before reservations', async () => {
  const disabled = runner(new SyntheticTextToThreeDConnector(threeDConfig({ liveMode: undefined })))
  await assert.rejects(disabled.run.run(request()), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_LIVE_DISABLED_REQUIRED')
  assert.equal(disabled.audit.entries.length, 0)
  assert.equal(disabled.quota.reservations.length, 0)

  const game = runner(new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }))
  await assert.rejects(game.run.run(gameRequest(premiumUnreal, 11)), (error: unknown) => error instanceof CostCapError && error.message === 'GPU_QUOTA_UNIT_MISMATCH')
  await assert.rejects(game.run.run({ ...gameRequest(premiumUnreal), ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  assert.equal(game.audit.entries.length, 0)
  assert.equal(game.quota.reservations.length, 0)

  const directContext = { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace', actor: 'synthetic-owner', ownerApproved: true, scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12, now: fixedNow }
  await assert.rejects(
    new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run({ ...premiumUnreal, publish: true } as unknown as GameEngineBuildInput, directContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'GAME_ENGINE_INVALID_INPUT',
  )
})

test('environment wiring accepts exactly LIVE_DISABLED and owner gates are unconfigured or deny by default', async () => {
  const [closedThreeD] = syntheticThreeDConnectorsFromEnvironment({
    GCL_3D_LIVE_MODE: 'LIVE_ENABLED', GCL_3D_MAX_COST_CENTS: '100', GCL_3D_MAX_ITEMS: '1',
  })
  if (!closedThreeD) throw new Error('MISSING_THREED_CONNECTOR')
  await assert.rejects(runner(closedThreeD).run.run(request()), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_LIVE_DISABLED_REQUIRED')

  const closedGame = gameEngineConnectorFromEnvironment({
    GCL_GAME_ENGINE_LIVE_MODE: 'LIVE_ENABLED', GCL_GAME_ENGINE_MAX_COST_CENTS: '100', GCL_GAME_ENGINE_MAX_GPU_MINUTES: '30',
  })
  await assert.rejects(runner(closedGame).run.run(gameRequest(premiumUnreal)), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GAME_ENGINE_LIVE_DISABLED_REQUIRED')

  assert.equal(ownerGateError(undefined, 'synthetic-test-token')?.message, 'GCL_OWNER_GATE_NOT_CONFIGURED')
  assert.equal(ownerGateError('synthetic-test-token', 'wrong') instanceof OwnerGateError, true)
  assert.equal(ownerGateError('synthetic-test-token', 'synthetic-test-token'), null)
})
