import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog, verifiedAuditChainHead } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, QuotaError, SyntheticResultIntegrityError } from '../src/gcl/errors.js'
import { gameEngineConnectorFromEnvironment, SyntheticGameEngineConnector, type GameEngineBuildPlan } from '../src/gcl/game-engine.js'
import { ContractOnlyJncPilotMapper } from '../src/gcl/jnc-pilot.js'
import { InMemoryDailyConnectorQuota } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import { validatedSyntheticConnectorResult } from '../src/gcl/result-boundary.js'
import { LIVE_DISABLED } from '../src/gcl/safety.js'
import { syntheticThreeDConnectorsFromEnvironment, SyntheticImageTextToThreeDConnector, SyntheticTextToThreeDConnector, type SyntheticThreeDResult } from '../src/gcl/three-d.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'

const fixedNow = () => new Date('2026-07-22T10:00:00.000Z')

function request(overrides: Partial<RunConnectorRequest> = {}): RunConnectorRequest {
  return {
    connectorId: 'text-to-3d', input: { prompt: 'Low-poly learning globe', outputFormat: 'glb' },
    product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace', actor: 'synthetic-owner', ownerApproved: true,
    scopes: ['3d:generate'], costCapCents: 50, requestedItems: 1, ...overrides,
  }
}

function threeDConfig() {
  return { liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxItems: 1 }
}

function gameConfig() {
  return { liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 60 }
}

function runner(connector: Connector, quota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })) {
  const audit = new InMemoryHashChainAuditLog()
  return { audit, quota, run: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, fixedNow) }
}

function directContext(scopes: readonly string[]): ConnectorRunContext {
  return {
    product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace', actor: 'synthetic-owner', ownerApproved: true,
    scopes, costCapCents: 50, requestedItems: 1, now: fixedNow,
  }
}

test('3D connector returns a frozen, disabled proposal with no dispatched transport', async () => {
  const { audit, quota, run } = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  const result = await run.run(request({
    input: {
      prompt: 'A low-poly solar system model for a classroom', style: 'educational',
      gpuResourceRequest: { computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: 900, budgetEnvelopeRef: 'budget:gm5' },
    },
  })) as ConnectorResult<SyntheticThreeDResult>

  assert.equal(result.confidence, 0)
  assert.equal(result.data.liveMode, LIVE_DISABLED)
  assert.equal(result.data.artifact.generation, 'SYNTHETIC_PROPOSAL_ONLY')
  assert.equal(result.data.artifact.lifecycle, 'GENERATED_CANDIDATE_NOT_A_FILE')
  assert.equal(result.data.artifact.publicationState, 'NOT_PUBLISHED')
  assert.equal(result.data.gpuResourceCard.transport, 'NONE')
  assert.equal(result.data.gpuResourceCard.dispatch, 'NOT_DISPATCHED')
  assert.equal(result.data.gpuResourceCard.request?.budgetEnvelopeRef, 'budget:gm5')
  assert.equal(result.data.blenderPilotHandoff.state, 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT')
  assert.equal(result.data.blenderPilotHandoff.ownerApproval, 'REQUIRED')
  assert.equal(Object.isFrozen(result.data), true)
  assert.equal(Object.isFrozen(result.data.artifact), true)
  assert.equal(audit.entries.length, 2)
  assert.equal(verifiedAuditChainHead(audit.entries), audit.entries[1]?.hash)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(quota.reservations.length, 1)
})

test('3D image input accepts a local immutable reference and rejects extra transport-shaped data before audit', async () => {
  const accepted = await new SyntheticImageTextToThreeDConnector(threeDConfig()).run({
    prompt: 'Turn this into a low-poly scene', image: {
      assetId: 'asset_123', sha256: 'a'.repeat(64), mediaType: 'image/png',
    },
  }, directContext(['3d:generate']))
  assert.equal(accepted.data.artifact.outputFormat, 'glb')

  const governed = runner(new SyntheticImageTextToThreeDConnector(threeDConfig()))
  await assert.rejects(governed.run.run(request({
    connectorId: 'image-text-to-3d', input: {
      prompt: 'Turn this into a low-poly scene', image: { assetId: 'asset_123', sha256: 'a'.repeat(64), mediaType: 'image/png' },
      url: 'https://provider.example/generate',
    },
  })), ConnectorInputError)
  assert.equal(governed.audit.entries.length, 0)
  assert.equal(governed.quota.reservations.length, 0)
})

test('game connector keeps Godot and premium Unreal as non-executed review plans', async () => {
  const economic = await runner(new SyntheticGameEngineConnector(gameConfig())).run.run(request({
    connectorId: 'game-engine', scopes: ['game:project:build'], input: {
      tier: 'economic', engine: 'godot', projectId: 'demo', brief: 'Small educational scene', target: 'web',
    },
  })) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(economic.data.execution, 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED')
  assert.deepEqual(economic.data.pipeline.map((stage) => stage.id), ['godot-project-plan', 'owner-build-review'])
  assert.equal(economic.data.gpuResourceCard, undefined)
  assert.equal(economic.data.publication, 'NOT_PUBLISHED')

  const premium = await runner(new SyntheticGameEngineConnector(gameConfig())).run.run(request({
    connectorId: 'game-engine', scopes: ['game:project:build'], requestedItems: 30, input: {
      tier: 'premium', engine: 'unreal', projectId: 'demo', brief: 'Small educational scene', target: 'desktop', gpuMinutes: 30,
    },
  })) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(premium.data.gpuResourceCard?.transport, 'NONE')
  assert.equal(premium.data.gpuResourceCard?.dispatch, 'NOT_DISPATCHED')
  assert.equal(premium.data.jncPilotHandoff?.contract, 'jarvis-node-controller.unreal-cli-pilot.v1')
  assert.equal(premium.data.jncPilotHandoff?.state, 'SYNTHETIC_HANDOFF_ONLY_NOT_SENT')
  assert.equal(premium.data.ownerReview, 'REQUIRED')
})

test('owner gate, disabled mode, caps, quota, and audit remain runner-owned governance', async () => {
  const denied = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  await assert.rejects(denied.run.run(request({ ownerApproved: false })), OwnerGateError)
  assert.equal(denied.audit.entries.length, 0)

  const disabled = runner(new SyntheticTextToThreeDConnector({ maxCostCapCents: 100, maxItems: 1 }))
  await assert.rejects(disabled.run.run(request()), ConnectorUnavailableError)
  assert.equal(disabled.audit.entries.length, 0)

  const capped = runner(new SyntheticTextToThreeDConnector({ ...threeDConfig(), maxCostCapCents: 40 }))
  await assert.rejects(capped.run.run(request()), CostCapError)
  assert.equal(capped.audit.entries.length, 0)

  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 1, dailyItems: 1 })
  const limited = runner(new SyntheticTextToThreeDConnector(threeDConfig()), quota)
  await limited.run.run(request())
  await assert.rejects(limited.run.run(request()), QuotaError)
  assert.equal(quota.reservations.length, 1)
  assert.equal(limited.audit.entries.length, 3)
})

test('environment wiring is fail-closed until every disabled-mode governance limit is configured', async () => {
  const [unconfigured] = syntheticThreeDConnectorsFromEnvironment({})
  await assert.rejects(unconfigured!.run({ prompt: 'A safe local proposal' }, directContext(['3d:generate'])), ConnectorUnavailableError)

  const [configured] = syntheticThreeDConnectorsFromEnvironment({
    GCL_3D_LIVE_MODE: LIVE_DISABLED, GCL_3D_MAX_COST_CENTS: '100', GCL_3D_MAX_ITEMS: '1',
  })
  const configuredPlan = await configured!.run({ prompt: 'A safe local proposal' }, directContext(['3d:generate'])) as ConnectorResult<SyntheticThreeDResult>
  assert.equal(configuredPlan.data.liveMode, LIVE_DISABLED)

  const game = gameEngineConnectorFromEnvironment({
    GCL_GAME_ENGINE_LIVE_MODE: LIVE_DISABLED, GCL_GAME_ENGINE_MAX_COST_CENTS: '100', GCL_GAME_ENGINE_MAX_GPU_MINUTES: '60',
  })
  assert.equal((await game.run({ tier: 'economic', engine: 'godot', projectId: 'demo', brief: 'Safe plan', target: 'web' }, directContext(['game:project:build']))).data.liveMode, LIVE_DISABLED)
})

test('the compact result and JNC boundaries reject live or malformed data', () => {
  assert.throws(() => validatedSyntheticConnectorResult({
    data: { liveMode: 'LIVE' }, confidence: 0,
    provenance: {
      connectorId: 'text-to-3d', source: 'synthetic-3d:text-to-3d', retrievedAt: fixedNow().toISOString(),
      untrustedContent: { source: 'synthetic-3d:text-to-3d', value: {}, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
    },
  }, 'text-to-3d'), SyntheticResultIntegrityError)

  assert.throws(() => new ContractOnlyJncPilotMapper().createGpuResourceCard({
    computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: 5_401, budgetEnvelopeRef: 'too-long-runtime',
  }), ConnectorInputError)
})
