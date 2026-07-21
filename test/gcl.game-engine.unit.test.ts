import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError } from '../src/gcl/errors.js'
import { LIVE_DISABLED, SyntheticGameEngineConnector, type GameEngineBuildInput, type GameEngineBuildPlan } from '../src/gcl/game-engine.js'
import { ownerGateError } from '../src/gcl/owner-gate.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-21T12:00:00.000Z')
const godotInput: GameEngineBuildInput = {
  tier: 'economic', engine: 'godot', projectId: 'forest-puzzle', brief: 'Three-level low-poly forest puzzle.', target: 'mobile',
}
const premiumInput: GameEngineBuildInput = {
  tier: 'premium', engine: 'unreal', projectId: 'forest-cinematic', brief: 'Cinematic forest level preview.', target: 'desktop', gpuMinutes: 12,
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

function request(input: GameEngineBuildInput, requestedItems: number): RunConnectorRequest {
  return {
    connectorId: 'game-engine', input, product: 'sectrai-gm6-test', workspaceId: 'ws-game', actor: 'owner@example.test',
    ownerApproved: true, scopes: ['game:project:build'], costCapCents: 100, requestedItems,
  }
}

function context(input: GameEngineBuildInput, requestedItems: number): ConnectorRunContext {
  const run = request(input, requestedItems)
  return {
    product: run.product,
    workspaceId: run.workspaceId,
    actor: run.actor,
    ownerApproved: run.ownerApproved,
    scopes: run.scopes,
    costCapCents: run.costCapCents,
    requestedItems: run.requestedItems,
    now,
  }
}

function runner(connector: SyntheticGameEngineConnector, audit = new InMemoryHashChainAuditLog(), quota = new TestQuota()): { runner: GovernedConnectorRunner; audit: InMemoryHashChainAuditLog; quota: TestQuota } {
  return { runner: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now), audit, quota }
}

test('economic Godot run returns only a synthetic, unpublished headless CLI plan with audit and quota evidence', async () => {
  const quota = new TestQuota()
  const audit = new InMemoryHashChainAuditLog()
  const { runner: governed } = runner(new SyntheticGameEngineConnector({ maxCostCapCents: 100, maxGpuMinutes: 30 }), audit, quota)
  const result = await governed.run(request(godotInput, 1))
  const plan = result.data as GameEngineBuildPlan

  assert.equal(LIVE_DISABLED, true)
  assert.equal(plan.adapter, 'SYNTHETIC')
  assert.equal(plan.execution, 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED')
  assert.deepEqual(plan.pipeline[1]?.commandTemplate, ['godot', '--headless', '--path', '<project-dir>', '--editor', '--quit'])
  assert.equal(plan.buildOutput.state, 'OWNER_APPROVAL_REQUIRED')
  assert.equal(plan.publication.automatic, false)
  assert.equal(plan.publication.state, 'DISABLED_NOT_IMPLEMENTED')
  assert.equal(plan.gpuArbitration, undefined)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(quota.requests.length, 1)
  assert.equal(quota.requests[0]?.requestedItems, 1)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
})

test('premium Unreal plan requires matching GPU-minute quota and keeps the jarvis hook unsent and autostart-off', async () => {
  const { runner: governed } = runner(new SyntheticGameEngineConnector({ maxCostCapCents: 100, maxGpuMinutes: 30 }))
  const result = await governed.run(request(premiumInput, 12))
  const plan = result.data as GameEngineBuildPlan

  assert.equal(plan.gpuArbitration?.provider, 'jarvis-node-controller')
  assert.equal(plan.gpuArbitration?.state, 'SYNTHETIC_HOOK_ONLY_NOT_SENT')
  assert.equal(plan.gpuArbitration?.autoStart, false)
  assert.equal(plan.gpuArbitration?.requestedGpuMinutes, 12)

  await assert.rejects(() => governed.run(request(premiumInput, 11)), (error: unknown) => error instanceof CostCapError && error.message === 'GPU_QUOTA_UNIT_MISMATCH')
})

test('owner, live-mode, cost-cap, and publication-input attempts fail closed before a plan exists', async () => {
  const connector = new SyntheticGameEngineConnector({ maxCostCapCents: 100, maxGpuMinutes: 30 })
  const { runner: governed, audit, quota } = runner(connector)

  await assert.rejects(() => governed.run({ ...request(godotInput, 1), ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => governed.run({ ...request(godotInput, 1), costCapCents: 101 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => connector.run({ ...godotInput, publish: true } as unknown as GameEngineBuildInput, context(godotInput, 1)), (error: unknown) => error instanceof ConnectorInputError)
  await assert.rejects(() => new SyntheticGameEngineConnector({ liveEnabled: true, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(godotInput, context(godotInput, 1)), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GAME_ENGINE_LIVE_DISABLED')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('owner gate is fail-closed when unconfigured or wrong, and opens only for the exact owner token', () => {
  const unavailable = ownerGateError(undefined, 'owner-token')
  const denied = ownerGateError('owner-token', 'wrong-token')
  assert.equal(unavailable instanceof ConnectorUnavailableError, true)
  assert.equal(unavailable?.message, 'GCL_OWNER_GATE_NOT_CONFIGURED')
  assert.equal(denied instanceof OwnerGateError, true)
  assert.equal(ownerGateError('owner-token', 'owner-token'), null)
})
