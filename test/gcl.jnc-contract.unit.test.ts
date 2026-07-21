import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog, verifiedAuditChainHead } from '../src/gcl/audit.js'
import { AuditChainError, ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, ScopeError, SyntheticResultIntegrityError, SyntheticReviewIntegrityError } from '../src/gcl/errors.js'
import { gameEngineConnectorFromEnvironment, SyntheticGameEngineConnector, type GameEngineBuildInput, type GameEngineBuildPlan } from '../src/gcl/game-engine.js'
import { ownerGateError } from '../src/gcl/owner-gate.js'
import { assertSyntheticPlanIntegrity, createSyntheticPlanIntegrity, deepFreeze, isCanonicalJsonData, syntheticPlanSha256, verifiesSyntheticPlanIntegrity } from '../src/gcl/plan-integrity.js'
import { InMemoryDailyConnectorQuota } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import { createSyntheticReviewReceipt, verifiesSyntheticReviewReceipt } from '../src/gcl/review-receipt.js'
import { assertSyntheticReviewSnapshot, createSyntheticReviewSnapshot, verifiesSyntheticReviewSnapshot } from '../src/gcl/review-snapshot.js'
import { LIVE_DISABLED } from '../src/gcl/safety.js'
import { syntheticThreeDConnectorsFromEnvironment, SyntheticImageTextToThreeDConnector, SyntheticTextToThreeDConnector, type SyntheticThreeDConnectorConfig, type SyntheticThreeDResult } from '../src/gcl/three-d.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'

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

function directContext(overrides: Partial<ConnectorRunContext> = {}): ConnectorRunContext {
  return {
    product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace', actor: 'synthetic-owner', ownerApproved: true,
    scopes: ['3d:generate'], costCapCents: 50, requestedItems: 1, now: fixedNow, ...overrides,
  }
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
  assert.equal(result.data.integrity.contract, 'gcl.synthetic-plan-integrity.v1')
  assert.match(result.data.integrity.payloadSha256, /^[a-f0-9]{64}$/)
  assert.equal(result.data.integrity.mutation, 'DEEP_FROZEN')
  assert.equal(verifiesSyntheticReviewReceipt(result.data.reviewReceipt), true)
  assert.equal(verifiesSyntheticReviewSnapshot(result.data.reviewSnapshot), true)
  assert.equal(result.data.reviewSnapshot.integrity, result.data.integrity)
  assert.equal(result.data.reviewSnapshot.reviewReceipt, result.data.reviewReceipt)
  assert.equal(result.data.reviewReceipt.scope.workspaceId, 'gm-workspace')
  assert.equal(result.data.reviewReceipt.execution, 'NOT_EXECUTED')
  assert.equal(result.data.reviewReceipt.externalEffects.network, 'DISABLED_NO_TRANSPORT')
  assert.equal(Object.isFrozen(result.data), true)
  assert.equal(Object.isFrozen(result.data.artifact), true)
  assert.equal(Object.isFrozen(result.data.reviewReceipt.externalEffects), true)
  assert.equal(Object.isFrozen(result.data.reviewSnapshot), true)
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

test('GM5 proposal ids are scope-bound, canonical across input key order, and immutable', async () => {
  const first = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb', style: 'educational' },
  })) as ConnectorResult<SyntheticThreeDResult>
  const reordered = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({
    input: { style: 'educational', outputFormat: 'glb', prompt: 'Low-poly learning globe' },
  })) as ConnectorResult<SyntheticThreeDResult>
  const otherScope = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({
    workspaceId: 'another-gm-workspace',
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb', style: 'educational' },
  })) as ConnectorResult<SyntheticThreeDResult>

  assert.equal(first.data.artifact.artifactId, reordered.data.artifact.artifactId)
  assert.equal(first.data.integrity.payloadSha256, reordered.data.integrity.payloadSha256)
  assert.notEqual(first.data.artifact.artifactId, otherScope.data.artifact.artifactId)
  assert.notEqual(first.data.integrity.payloadSha256, otherScope.data.integrity.payloadSha256)
  assert.throws(() => { (first.data.artifact as { publicationState: string }).publicationState = 'PUBLISHED' }, TypeError)
  assert.equal(first.data.artifact.publicationState, 'NOT_PUBLISHED')
})

test('synthetic review receipts are scope-bound, verify their plan digest, and fail closed on corruption', () => {
  const payload = { connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, artifact: 'synthetic-only' }
  const integrity = createSyntheticPlanIntegrity(payload)
  const receipt = createSyntheticReviewReceipt({ connectorId: 'text-to-3d', scope: payload.scope, planIntegrity: integrity })

  assert.equal(verifiesSyntheticPlanIntegrity(integrity, payload), true)
  assert.equal(verifiesSyntheticPlanIntegrity(integrity, { ...payload, artifact: 'not-synthetic' }), false)
  assert.throws(() => assertSyntheticPlanIntegrity(integrity, { ...payload, artifact: 'not-synthetic' }), SyntheticReviewIntegrityError)
  assert.equal(verifiesSyntheticReviewReceipt(receipt), true)
  assert.equal(receipt.execution, 'NOT_EXECUTED')
  assert.equal(receipt.externalEffects.network, 'DISABLED_NO_TRANSPORT')
  assert.equal(receipt.externalEffects.process, 'DISABLED_NO_LAUNCHER')
  assert.equal(receipt.externalEffects.artifactWrite, 'DISABLED_NO_FILE')
  assert.equal(receipt.externalEffects.publication, 'DISABLED_NOT_PUBLISHED')
  assert.equal(verifiesSyntheticReviewReceipt({ ...receipt, scope: { ...receipt.scope, workspaceId: 'other-workspace' } }), false)
  assert.equal(verifiesSyntheticReviewReceipt({ ...receipt, externalEffects: { ...receipt.externalEffects, network: 'SENT' } }), false)
  assert.equal(verifiesSyntheticReviewReceipt({ ...receipt, extra: 'not-allowed' }), false)
})

test('review snapshots bind the exact canonical plan payload to its receipt and fail closed when grafted or altered', () => {
  const payload = {
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    artifact: { id: 'synthetic-only', state: 'NOT_PUBLISHED' },
  }
  const snapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d',
    scope: payload.scope,
    payload,
  })
  assert.equal(verifiesSyntheticReviewSnapshot(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.payload), true)
  assert.equal(verifiesSyntheticReviewSnapshot({
    ...snapshot,
    payload: { ...snapshot.payload, artifact: { id: 'synthetic-only', state: 'PUBLISHED' } },
  }), false)
  const otherScopeReceipt = createSyntheticReviewReceipt({
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'other-workspace' },
    planIntegrity: snapshot.integrity,
  })
  assert.equal(verifiesSyntheticReviewSnapshot({ ...snapshot, reviewReceipt: otherScopeReceipt }), false)
  assert.throws(() => assertSyntheticReviewSnapshot({ ...snapshot, reviewReceipt: otherScopeReceipt }), SyntheticReviewIntegrityError)
})

test('plan digests reject JavaScript-only values and verifier predicates do not throw on malformed review data', () => {
  const sparse = ['safe'] as string[]
  sparse.length = 2
  const accessorPayload: Record<string, unknown> = { connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' } }
  Object.defineProperty(accessorPayload, 'artifact', { enumerable: true, get() { return 'synthetic-only' } })
  const nonPlainPayload = { connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, generatedAt: new Date() }
  const sparsePayload = { connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, items: sparse }

  assert.equal(isCanonicalJsonData(nonPlainPayload), false)
  assert.equal(isCanonicalJsonData(accessorPayload), false)
  assert.equal(isCanonicalJsonData(sparsePayload), false)
  assert.throws(() => syntheticPlanSha256(sparsePayload), /SYNTHETIC_PLAN_SPARSE_ARRAY/)
  assert.throws(() => createSyntheticReviewSnapshot({ connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: nonPlainPayload }), /SYNTHETIC_PLAN_NON_PLAIN_OBJECT/)
  const integrity = createSyntheticPlanIntegrity({ connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' } })
  assert.equal(verifiesSyntheticPlanIntegrity(integrity, accessorPayload), false)
  assert.equal(verifiesSyntheticReviewSnapshot({ payload: sparsePayload, integrity, reviewReceipt: {} }), false)
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
  assert.equal(unreal.data.integrity.mutation, 'DEEP_FROZEN')
  assert.equal(verifiesSyntheticReviewReceipt(unreal.data.reviewReceipt), true)
  assert.equal(verifiesSyntheticReviewSnapshot(unreal.data.reviewSnapshot), true)
  assert.equal(unreal.data.reviewReceipt.execution, 'NOT_EXECUTED')
  assert.equal(unreal.data.reviewReceipt.externalEffects.publication, 'DISABLED_NOT_PUBLISHED')
  assert.equal(Object.isFrozen(unreal.data.pipeline), true)
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

test('GM6 keeps the economic Godot template as a non-executed, non-GPU plan', async () => {
  const connector = new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 200, maxGpuMinutes: 30 })
  const result = await runner(connector).run.run(gameRequest({
    tier: 'economic', engine: 'godot', projectId: 'classroom-puzzle', brief: 'A small classroom puzzle prototype.', target: 'web',
  }, 1)) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(result.data.execution, 'SYNTHETIC_PLAN_ONLY_NOT_EXECUTED')
  assert.equal(result.data.pipeline[1]?.id, 'godot-headless-import')
  assert.deepEqual(result.data.pipeline[1]?.commandTemplate, ['godot', '--headless', '--path', '<project-dir>', '--editor', '--quit'])
  assert.equal(result.data.pipeline[2]?.id, 'godot-headless-export')
  assert.equal('gpuResourceCard' in result.data, false)
  assert.equal('jncPilotHandoff' in result.data, false)
  assert.equal(result.data.publication.state, 'DISABLED_NOT_IMPLEMENTED')
  assert.equal(result.provenance.source, 'synthetic-game-engine-plan')
  assert.equal(result.provenance.untrustedContent.source, 'game-engine-input')
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

  const directGameContext = directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 })
  await assert.rejects(
    new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run({ ...premiumUnreal, publish: true } as unknown as GameEngineBuildInput, directGameContext),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'GAME_ENGINE_INVALID_INPUT',
  )
})

test('direct adapter calls revalidate own governance data and reject mapper injection', async () => {
  const threeD = new SyntheticTextToThreeDConnector(threeDConfig())
  const input = { prompt: 'A local synthetic 3D proposal' }
  await assert.rejects(threeD.run(input, directContext({ ownerApproved: false })), OwnerGateError)
  await assert.rejects(threeD.run(input, directContext({ scopes: ['game:project:build'] })), ScopeError)
  const sparseScopes = ['3d:generate'] as string[]
  sparseScopes.length = 2
  await assert.rejects(threeD.run(input, directContext({ scopes: sparseScopes })), ScopeError)

  const accessorContext = directContext()
  let accessorReads = 0
  Object.defineProperty(accessorContext, 'product', {
    enumerable: true,
    get() { accessorReads += 1; return 'sectrai-gm-contract-test' },
  })
  await assert.rejects(threeD.run(input, accessorContext), (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT')
  assert.equal(accessorReads, 0)

  const inheritedContext = Object.create(directContext()) as ConnectorRunContext
  await assert.rejects(threeD.run(input, inheritedContext), (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT')

  const game = new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 })
  await assert.rejects(game.run(premiumUnreal, directContext({ ownerApproved: false, scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 })), OwnerGateError)

  const fakeMapper = {
    createGpuResourceCard() { throw new Error('CUSTOM_MAPPER_MUST_NEVER_RUN') },
    createBlenderHandoff() { throw new Error('CUSTOM_MAPPER_MUST_NEVER_RUN') },
    createUnrealHandoff() { throw new Error('CUSTOM_MAPPER_MUST_NEVER_RUN') },
  }
  assert.throws(
    () => new SyntheticTextToThreeDConnector({ ...threeDConfig(), jncPilotMapper: fakeMapper } as unknown as SyntheticThreeDConnectorConfig),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_INVALID_SYNTHETIC_CONFIG',
  )
  assert.throws(
    () => new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30, jncPilotMapper: fakeMapper } as unknown as import('../src/gcl/game-engine.js').GameEngineConnectorConfig),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GAME_ENGINE_INVALID_SYNTHETIC_CONFIG',
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

test('corrupt audit links are rejected instead of silently becoming a new chain root', () => {
  const firstEvent = {
    type: 'connector.run.requested' as const, connectorId: 'text-to-3d', product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace',
    actor: 'synthetic-owner', scopes: ['3d:generate'], costCapCents: 50, requestedItems: 1,
    occurredAt: fixedNow().toISOString(), detail: {},
  }
  const firstHash = hashAuditEvent(firstEvent, null)
  const secondEvent = { ...firstEvent, type: 'connector.run.succeeded' as const, detail: { requestedAuditHash: firstHash } }
  const secondHash = hashAuditEvent(secondEvent, firstHash)
  assert.equal(verifiedAuditChainHead([
    { event: firstEvent, previousHash: null, hash: firstHash },
    { event: secondEvent, previousHash: firstHash, hash: secondHash },
  ]), secondHash)
  assert.throws(() => verifiedAuditChainHead([
    { event: firstEvent, previousHash: null, hash: firstHash },
    { event: secondEvent, previousHash: null, hash: secondHash },
  ]), AuditChainError)
  assert.throws(() => verifiedAuditChainHead([{ event: firstEvent, previousHash: null, hash: '0'.repeat(64) }]), AuditChainError)
  assert.throws(() => verifiedAuditChainHead([{ event: {}, previousHash: null, hash: firstHash }]), AuditChainError)
  assert.throws(() => verifiedAuditChainHead([{ event: firstEvent, previousHash: null, hash: firstHash, ignored: true }]), AuditChainError)
  const unlinkedTerminal = { ...secondEvent, detail: { requestedAuditHash: 'f'.repeat(64) } }
  assert.throws(() => verifiedAuditChainHead([
    { event: firstEvent, previousHash: null, hash: firstHash },
    { event: unlinkedTerminal, previousHash: firstHash, hash: hashAuditEvent(unlinkedTerminal, firstHash) },
  ]), AuditChainError)
  const duplicateTerminal = { ...secondEvent, type: 'connector.run.failed' as const, detail: { requestedAuditHash: firstHash, error: 'SYNTHETIC_FAILURE' } }
  const duplicateTerminalHash = hashAuditEvent(duplicateTerminal, secondHash)
  assert.throws(() => verifiedAuditChainHead([
    { event: firstEvent, previousHash: null, hash: firstHash },
    { event: secondEvent, previousHash: firstHash, hash: secondHash },
    { event: duplicateTerminal, previousHash: secondHash, hash: duplicateTerminalHash },
  ]), AuditChainError)
})

test('direct runner calls reject malformed governance context before audit or quota reservation', async () => {
  const governed = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  await assert.rejects(governed.run.run(request({ product: 'outside-product' })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT')
  await assert.rejects(governed.run.run(request({ actor: 'invalid/owner' })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT')
  await assert.rejects(governed.run.run(request({ ownerApproved: 'true' as unknown as boolean })), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(governed.run.run(request({ scopes: ['3d:generate', '3d:generate'] })), (error: unknown) => error instanceof ScopeError)
  assert.equal(governed.audit.entries.length, 0)
  assert.equal(governed.quota.reservations.length, 0)
})

test('GM5/GM6 inputs and direct runner governance read only own data descriptors', async () => {
  const threeD = new SyntheticTextToThreeDConnector(threeDConfig())
  const inheritedThreeDInput = Object.create({ prompt: 'Inherited synthetic proposal must not be accepted' })
  await assert.rejects(threeD.run(inheritedThreeDInput, directContext()), ConnectorInputError)

  let threeDGetterReads = 0
  const accessorThreeDInput: Record<string, unknown> = {}
  Object.defineProperty(accessorThreeDInput, 'prompt', {
    enumerable: true,
    get() { threeDGetterReads += 1; return 'Accessor-backed synthetic proposal must not be accepted' },
  })
  await assert.rejects(threeD.run(accessorThreeDInput as unknown as import('../src/gcl/three-d.js').TextToThreeDInput, directContext()), ConnectorInputError)
  assert.equal(threeDGetterReads, 0)

  const hiddenThreeDInput: Record<string, unknown> = {}
  Object.defineProperty(hiddenThreeDInput, 'prompt', { enumerable: false, value: 'Hidden synthetic proposal must not be accepted' })
  await assert.rejects(threeD.run(hiddenThreeDInput as unknown as import('../src/gcl/three-d.js').TextToThreeDInput, directContext()), ConnectorInputError)

  const inheritedImageReference = Object.create({ assetId: 'local-only', sha256: 'a'.repeat(64), mediaType: 'image/png' })
  await assert.rejects(
    new SyntheticImageTextToThreeDConnector(threeDConfig()).run({ prompt: 'A local-only reference', image: inheritedImageReference } as unknown as import('../src/gcl/three-d.js').ImageTextToThreeDInput, directContext()),
    ConnectorInputError,
  )

  const game = new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 })
  const gameContext = directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 })
  await assert.rejects(game.run(Object.create(premiumUnreal) as GameEngineBuildInput, gameContext), (error: unknown) => error instanceof ConnectorInputError && error.message === 'GAME_ENGINE_INVALID_INPUT')

  let gameGetterReads = 0
  const accessorGameInput = { ...premiumUnreal } as Record<string, unknown>
  Object.defineProperty(accessorGameInput, 'brief', {
    enumerable: true,
    get() { gameGetterReads += 1; return premiumUnreal.brief },
  })
  await assert.rejects(game.run(accessorGameInput as GameEngineBuildInput, gameContext), (error: unknown) => error instanceof ConnectorInputError && error.message === 'GAME_ENGINE_INVALID_INPUT')
  assert.equal(gameGetterReads, 0)

  const governed = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  let governanceGetterReads = 0
  const accessorRequest = request() as unknown as Record<string, unknown>
  Object.defineProperty(accessorRequest, 'costCapCents', {
    enumerable: true,
    get() { governanceGetterReads += 1; return 50 },
  })
  await assert.rejects(governed.run.run(accessorRequest as unknown as RunConnectorRequest), (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT')
  assert.equal(governanceGetterReads, 0)
  const sparseScopes = ['3d:generate'] as string[]
  sparseScopes.length = 2
  await assert.rejects(governed.run.run(request({ scopes: sparseScopes })), ScopeError)
  assert.equal(governed.audit.entries.length, 0)
  assert.equal(governed.quota.reservations.length, 0)
})

test('direct GM5/GM6 calls cross the immutable synthetic egress boundary and reject an invalid clock value', async () => {
  const threeD = new SyntheticTextToThreeDConnector(threeDConfig())
  const threeDResult = await threeD.run({ prompt: 'A local synthetic 3D proposal' }, directContext())
  assert.equal(Object.isFrozen(threeDResult), true)
  assert.equal(Object.isFrozen(threeDResult.provenance), true)
  assert.throws(() => { threeDResult.provenance.source = 'synthetic:relabelled' }, TypeError)
  assert.equal(threeDResult.provenance.source, 'synthetic-3d:text-to-3d')

  const game = new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 })
  const gameResult = await game.run(premiumUnreal, directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 }))
  assert.equal(Object.isFrozen(gameResult), true)
  assert.equal(Object.isFrozen(gameResult.provenance.untrustedContent), true)
  assert.throws(() => { gameResult.provenance.runId = 'synthetic-game-relabelled' }, TypeError)

  let invalidClockReads = 0
  const invalidClock = () => {
    invalidClockReads += 1
    return { toISOString: () => 'not-an-iso-timestamp' } as unknown as Date
  }
  await assert.rejects(
    threeD.run({ prompt: 'A local synthetic 3D proposal' }, directContext({ now: invalidClock })),
    SyntheticResultIntegrityError,
  )
  assert.equal(invalidClockReads, 1)
})

test('failed adapter messages are never copied into the durable audit chain', async () => {
  const untrustedMessage = `untrusted-adapter-message-${'x'.repeat(600)}`
  const connector: Connector = {
    id: 'failure-redaction-proposal', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { throw new Error(untrustedMessage) },
  }
  const { audit, run } = runner(connector)
  await assert.rejects(run.run(request({ connectorId: connector.id })), (error: unknown) => error instanceof Error && error.message === untrustedMessage)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.event.detail.error, 'connector_run_failed')
  assert.equal(JSON.stringify(audit.entries).includes(untrustedMessage), false)
  assert.equal(verifiedAuditChainHead(audit.entries), audit.entries[1]?.hash)
})

test('audit persistence unavailability prevents adapter execution and quota reservation', async () => {
  let adapterRuns = 0
  const connector: Connector = {
    id: 'audit-gated-proposal', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { adapterRuns += 1; throw new Error('ADAPTER_MUST_NOT_RUN') },
  }
  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 1, dailyItems: 1 })
  const audit = { async append(): Promise<{ hash: string }> { throw new Error('AUDIT_STORE_UNAVAILABLE') } }
  const governed = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, fixedNow)
  await assert.rejects(governed.run(request({ connectorId: connector.id })), /AUDIT_STORE_UNAVAILABLE/)
  assert.equal(adapterRuns, 0)
  assert.equal(quota.reservations.length, 0)
})

test('the final result boundary rejects a frozen outer-plan graft after quota and records a stable failure', async () => {
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A local synthetic 3D proposal' }, directContext(),
  )
  const graftedData = deepFreeze({
    ...genuine.data,
    artifact: { ...genuine.data.artifact, publicationState: 'PUBLISHED' },
  })
  const connector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: graftedData, provenance: genuine.provenance, confidence: 0 } },
  }
  const governed = runner(connector)
  await assert.rejects(governed.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(governed.quota.reservations.length, 1)
  assert.equal(governed.audit.entries.length, 2)
  assert.equal(governed.audit.entries[0]?.event.type, 'connector.run.requested')
  assert.equal(governed.audit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(governed.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
  assert.equal(verifiedAuditChainHead(governed.audit.entries), governed.audit.entries[1]?.hash)
})

test('the final result boundary does not invoke accessor-backed result fields or accept nonzero confidence', async () => {
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A local synthetic 3D proposal' }, directContext(),
  )
  let accessorReads = 0
  const accessorResult: Record<string, unknown> = { provenance: genuine.provenance, confidence: 0 }
  Object.defineProperty(accessorResult, 'data', {
    enumerable: true,
    get() { accessorReads += 1; return genuine.data },
  })
  const accessorConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return accessorResult as unknown as ConnectorResult },
  }
  const accessorRun = runner(accessorConnector)
  await assert.rejects(accessorRun.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(accessorReads, 0)
  assert.equal(accessorRun.quota.reservations.length, 1)
  assert.equal(accessorRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const confidenceConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: genuine.data, provenance: genuine.provenance, confidence: 1 } },
  }
  const confidenceRun = runner(confidenceConnector)
  await assert.rejects(confidenceRun.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(confidenceRun.quota.reservations.length, 1)
  assert.equal(confidenceRun.audit.entries[1]?.event.type, 'connector.run.failed')
})

test('the final result boundary rejects re-hashed publication escalation and provenance relabelling', async () => {
  const genuineThreeD = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A local synthetic 3D proposal' }, directContext(),
  )
  const escalatedArtifact = { ...genuineThreeD.data.artifact, publicationState: 'PUBLISHED' }
  const escalatedThreeDPayload = { ...genuineThreeD.data.reviewSnapshot.payload, artifact: escalatedArtifact }
  const escalatedThreeDSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: escalatedThreeDPayload,
  })
  const escalatedThreeDData = deepFreeze({
    ...genuineThreeD.data,
    artifact: escalatedArtifact,
    integrity: escalatedThreeDSnapshot.integrity,
    reviewReceipt: escalatedThreeDSnapshot.reviewReceipt,
    reviewSnapshot: escalatedThreeDSnapshot,
  }) as unknown as SyntheticThreeDResult
  const escalatedThreeDConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: escalatedThreeDData, provenance: genuineThreeD.provenance, confidence: 0 } },
  }
  const escalatedThreeDRun = runner(escalatedThreeDConnector)
  await assert.rejects(escalatedThreeDRun.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(escalatedThreeDRun.quota.reservations.length, 1)
  assert.equal(escalatedThreeDRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const relabelledConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: genuineThreeD.data, provenance: { ...genuineThreeD.provenance, source: 'synthetic:relabeled' }, confidence: 0 } },
  }
  const relabelledRun = runner(relabelledConnector)
  await assert.rejects(relabelledRun.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(relabelledRun.quota.reservations.length, 1)
  assert.equal(relabelledRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const gameContext = directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 })
  const genuineGame = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(premiumUnreal, gameContext)
  const escalatedPublication = { automatic: false, state: 'PUBLISHED' }
  const escalatedGamePayload = { ...genuineGame.data.reviewSnapshot.payload, publication: escalatedPublication }
  const escalatedGameSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'game-engine', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: escalatedGamePayload,
  })
  const escalatedGameData = deepFreeze({
    ...genuineGame.data,
    publication: escalatedPublication,
    integrity: escalatedGameSnapshot.integrity,
    reviewReceipt: escalatedGameSnapshot.reviewReceipt,
    reviewSnapshot: escalatedGameSnapshot,
  }) as unknown as GameEngineBuildPlan
  const escalatedGameConnector: Connector = {
    id: 'game-engine', kind: 'game-engine', authKind: 'owner-approval', scopes: ['game:project:build'],
    async run() { return { data: escalatedGameData, provenance: genuineGame.provenance, confidence: 0 } },
  }
  const escalatedGameRun = runner(escalatedGameConnector)
  await assert.rejects(escalatedGameRun.run.run(gameRequest(premiumUnreal)), SyntheticResultIntegrityError)
  assert.equal(escalatedGameRun.quota.reservations.length, 1)
  assert.equal(escalatedGameRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})
