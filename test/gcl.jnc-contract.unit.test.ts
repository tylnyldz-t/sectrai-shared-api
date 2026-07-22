import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog, verifiedAuditChainHead } from '../src/gcl/audit.js'
import { AuditChainError, ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, ScopeError, SyntheticResultIntegrityError, SyntheticReviewIntegrityError } from '../src/gcl/errors.js'
import { gameEngineConnectorFromEnvironment, SyntheticGameEngineConnector, type GameEngineBuildInput, type GameEngineBuildPlan } from '../src/gcl/game-engine.js'
import { MAX_GOVERNANCE_SCOPE_COUNT } from '../src/gcl/governance-limits.js'
import { ContractOnlyJncPilotMapper, JNC_MAXIMUM_GPU_RUNTIME_MINUTES, JNC_MAXIMUM_GPU_RUNTIME_SECONDS } from '../src/gcl/jnc-pilot.js'
import { ownerGateError } from '../src/gcl/owner-gate.js'
import { assertSyntheticPlanIntegrity, createSyntheticPlanIntegrity, deepFreeze, isCanonicalJsonData, isSyntheticPlanIntegrity, syntheticPlanSha256, verifiesSyntheticPlanIntegrity } from '../src/gcl/plan-integrity.js'
import { InMemoryDailyConnectorQuota } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import { syntheticResultReviewBinding } from '../src/gcl/result-boundary.js'
import { createSyntheticReviewReceipt, verifiesSyntheticReviewReceipt } from '../src/gcl/review-receipt.js'
import { assertSyntheticReviewSnapshot, createSyntheticReviewSnapshot, verifiesSyntheticReviewSnapshot } from '../src/gcl/review-snapshot.js'
import { LIVE_DISABLED } from '../src/gcl/safety.js'
import { syntheticThreeDConnectorsFromEnvironment, SyntheticImageTextToThreeDConnector, SyntheticTextToThreeDConnector, type SyntheticThreeDConnectorConfig, type SyntheticThreeDResult } from '../src/gcl/three-d.js'
import type { Connector, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { connectorRunFrom } from '../src/validation.js'

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

function trapCountingProxy<T extends object>(value: T, counter: { count: number }): T {
  const trap = () => { counter.count += 1 }
  return new Proxy(value, {
    get(target, property, receiver) { trap(); return Reflect.get(target, property, receiver) },
    getPrototypeOf(target) { trap(); return Reflect.getPrototypeOf(target) },
    getOwnPropertyDescriptor(target, property) { trap(); return Reflect.getOwnPropertyDescriptor(target, property) },
    ownKeys(target) { trap(); return Reflect.ownKeys(target) },
  })
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
  const plannedInput = result.data.reviewSnapshot.payload.input as { gpuResourceRequest?: unknown }
  assert.deepEqual(result.data.gpuResourceCard.request, plannedInput.gpuResourceRequest)
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

test('GM5 proposal ids are governed-context-bound, canonical across input key order, and immutable', async () => {
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
  const otherOwner = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({
    actor: 'another-synthetic-owner',
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb', style: 'educational' },
  })) as ConnectorResult<SyntheticThreeDResult>
  const otherReservation = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({
    costCapCents: 75,
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb', style: 'educational' },
  })) as ConnectorResult<SyntheticThreeDResult>

  assert.equal(first.data.artifact.artifactId, reordered.data.artifact.artifactId)
  assert.equal(first.data.integrity.payloadSha256, reordered.data.integrity.payloadSha256)
  assert.notEqual(first.data.artifact.artifactId, otherScope.data.artifact.artifactId)
  assert.notEqual(first.data.integrity.payloadSha256, otherScope.data.integrity.payloadSha256)
  assert.notEqual(first.data.artifact.artifactId, otherOwner.data.artifact.artifactId)
  assert.notEqual(first.data.artifact.artifactId, otherReservation.data.artifact.artifactId)
  assert.throws(() => { (first.data.artifact as { publicationState: string }).publicationState = 'PUBLISHED' }, TypeError)
  assert.equal(first.data.artifact.publicationState, 'NOT_PUBLISHED')
})

test('GM5 final egress binds the optional GPU contract card to the submitted plan input', async () => {
  const input = {
    prompt: 'A synthetic GPU-bound 3D proposal',
    gpuResourceRequest: { computeTier: 'premium' as const, estimatedVramMiB: 'UNKNOWN' as const, maximumRuntimeSeconds: 900, budgetEnvelopeRef: 'budget:owner-approved-gm5' },
  }
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(input, directContext())
  const mapper = new ContractOnlyJncPilotMapper()
  const substitutedCard = mapper.createGpuResourceCard({ ...input.gpuResourceRequest, budgetEnvelopeRef: 'budget:another-synthetic-plan' })
  const substitutedPayload = { ...genuine.data.reviewSnapshot.payload, gpuResourceCard: substitutedCard }
  const substitutedSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: substitutedPayload,
  })
  const substitutedData = deepFreeze({
    ...genuine.data,
    gpuResourceCard: substitutedCard,
    integrity: substitutedSnapshot.integrity,
    reviewReceipt: substitutedSnapshot.reviewReceipt,
    reviewSnapshot: substitutedSnapshot,
  }) as unknown as SyntheticThreeDResult
  const substitutedConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: substitutedData, provenance: genuine.provenance, confidence: 0 } },
  }
  const substitutedRun = runner(substitutedConnector)
  await assert.rejects(substitutedRun.run.run(request({ input })), SyntheticResultIntegrityError)
  assert.equal(substitutedRun.quota.reservations.length, 1)
  assert.equal(substitutedRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const withoutGpu = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A synthetic proposal without a GPU request' }, directContext(),
  )
  const unexpectedCard = mapper.createGpuResourceCard(input.gpuResourceRequest)
  const unexpectedPayload = { ...withoutGpu.data.reviewSnapshot.payload, gpuResourceCard: unexpectedCard }
  const unexpectedSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: unexpectedPayload,
  })
  const unexpectedData = deepFreeze({
    ...withoutGpu.data,
    gpuResourceCard: unexpectedCard,
    integrity: unexpectedSnapshot.integrity,
    reviewReceipt: unexpectedSnapshot.reviewReceipt,
    reviewSnapshot: unexpectedSnapshot,
  }) as unknown as SyntheticThreeDResult
  const unexpectedConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: unexpectedData, provenance: withoutGpu.provenance, confidence: 0 } },
  }
  const unexpectedRun = runner(unexpectedConnector)
  await assert.rejects(unexpectedRun.run.run(request({ input: { prompt: 'A synthetic proposal without a GPU request' } })), SyntheticResultIntegrityError)
  assert.equal(unexpectedRun.quota.reservations.length, 1)
  assert.equal(unexpectedRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('GM5 final egress binds the synthetic artifact output format to the submitted plan', async () => {
  const input = { prompt: 'A local GLB-only synthetic proposal', outputFormat: 'glb' as const }
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(input, directContext())
  const matchingObjPlan = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A local OBJ-only synthetic proposal', outputFormat: 'obj' }, directContext(),
  )
  assert.equal(matchingObjPlan.data.artifact.outputFormat, 'obj')
  assert.equal((matchingObjPlan.data.reviewSnapshot.payload.input as { outputFormat: string }).outputFormat, 'obj')
  const substitutedArtifact = { ...genuine.data.artifact, outputFormat: 'obj' as const }
  const substitutedPayload = { ...genuine.data.reviewSnapshot.payload, artifact: substitutedArtifact }
  const substitutedSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: substitutedPayload,
  })
  const substitutedData = deepFreeze({
    ...genuine.data,
    artifact: substitutedArtifact,
    integrity: substitutedSnapshot.integrity,
    reviewReceipt: substitutedSnapshot.reviewReceipt,
    reviewSnapshot: substitutedSnapshot,
  }) as unknown as SyntheticThreeDResult
  const substitutedConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: substitutedData, provenance: genuine.provenance, confidence: 0 } },
  }
  const substitutedRun = runner(substitutedConnector)

  await assert.rejects(substitutedRun.run.run(request({ input })), SyntheticResultIntegrityError)
  assert.equal(substitutedRun.quota.reservations.length, 1)
  assert.equal(substitutedRun.audit.entries.length, 2)
  assert.equal(substitutedRun.audit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(substitutedRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
  assert.equal(verifiedAuditChainHead(substitutedRun.audit.entries), substitutedRun.audit.entries[1]?.hash)
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
  assert.throws(
    () => createSyntheticReviewSnapshot({ connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: nonPlainPayload }),
    SyntheticReviewIntegrityError,
  )
  const integrity = createSyntheticPlanIntegrity({ connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' } })
  assert.equal(verifiesSyntheticPlanIntegrity(integrity, accessorPayload), false)
  assert.equal(verifiesSyntheticReviewSnapshot({ payload: sparsePayload, integrity, reviewReceipt: {} }), false)
})

test('synthetic review data rejects Proxy values before any caller-controlled trap can run', () => {
  const traps = { count: 0 }
  const proxyPayload = trapCountingProxy({
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    artifact: 'synthetic-only',
  }, traps)

  assert.equal(isCanonicalJsonData(proxyPayload), false)
  assert.throws(() => syntheticPlanSha256(proxyPayload), /SYNTHETIC_PLAN_PROXY_VALUE/)
  assert.throws(() => deepFreeze(proxyPayload), /SYNTHETIC_PLAN_PROXY_VALUE/)
  assert.throws(
    () => createSyntheticReviewSnapshot({
      connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: proxyPayload,
    }),
    SyntheticReviewIntegrityError,
  )
  assert.equal(traps.count, 0)
})

test('review evidence helpers copy own canonical data and never invoke hostile fields', () => {
  const payload = {
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    input: { prompt: 'A local review-only proposal' },
  }
  const integrity = createSyntheticPlanIntegrity(payload)
  const receipt = createSyntheticReviewReceipt({
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    planIntegrity: integrity,
  })
  const snapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    payload,
  })
  assert.equal(Object.isFrozen(integrity), true)
  assert.equal(Object.isFrozen(receipt), true)
  assert.equal(Object.isFrozen(receipt.externalEffects), true)
  assert.equal(snapshot.payload === payload, false)
  payload.scope.workspaceId = 'changed-after-snapshot'
  assert.equal((snapshot.payload.scope as unknown as { workspaceId: string }).workspaceId, 'gm-workspace')

  let integrityGetterReads = 0
  const accessorIntegrity: Record<string, unknown> = { contract: integrity.contract, content: integrity.content, mutation: integrity.mutation }
  Object.defineProperty(accessorIntegrity, 'payloadSha256', {
    enumerable: true,
    get() { integrityGetterReads += 1; return integrity.payloadSha256 },
  })
  assert.equal(isSyntheticPlanIntegrity(accessorIntegrity), false)
  assert.equal(verifiesSyntheticPlanIntegrity(accessorIntegrity, payload), false)
  assert.equal(integrityGetterReads, 0)

  let receiptGetterReads = 0
  const accessorReceipt = { ...receipt } as Record<string, unknown>
  Object.defineProperty(accessorReceipt, 'contract', {
    enumerable: true,
    get() { receiptGetterReads += 1; return receipt.contract },
  })
  assert.equal(verifiesSyntheticReviewReceipt(accessorReceipt), false)
  assert.equal(receiptGetterReads, 0)

  let snapshotGetterReads = 0
  const accessorSnapshot = { integrity: snapshot.integrity, reviewReceipt: snapshot.reviewReceipt } as Record<string, unknown>
  Object.defineProperty(accessorSnapshot, 'payload', {
    enumerable: true,
    get() { snapshotGetterReads += 1; return snapshot.payload },
  })
  assert.equal(verifiesSyntheticReviewSnapshot(accessorSnapshot), false)
  assert.equal(snapshotGetterReads, 0)

  let creationGetterReads = 0
  const accessorReceiptInput = {
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
    planIntegrity: integrity,
  } as Record<string, unknown>
  Object.defineProperty(accessorReceiptInput, 'connectorId', {
    enumerable: true,
    get() { creationGetterReads += 1; return 'text-to-3d' },
  })
  assert.throws(() => createSyntheticReviewReceipt(accessorReceiptInput as unknown as Parameters<typeof createSyntheticReviewReceipt>[0]), SyntheticReviewIntegrityError)
  assert.equal(creationGetterReads, 0)

  let snapshotCreationGetterReads = 0
  const accessorSnapshotInput = {
    connectorId: 'text-to-3d',
    scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' },
  } as Record<string, unknown>
  Object.defineProperty(accessorSnapshotInput, 'payload', {
    enumerable: true,
    get() { snapshotCreationGetterReads += 1; return payload },
  })
  assert.throws(() => createSyntheticReviewSnapshot(accessorSnapshotInput as unknown as Parameters<typeof createSyntheticReviewSnapshot>[0]), SyntheticReviewIntegrityError)
  assert.equal(snapshotCreationGetterReads, 0)
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
  assert.equal(unreal.data.reviewSnapshot.payload.retrievedAt, unreal.provenance.retrievedAt)
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
  assert.equal(blender.data.reviewSnapshot.payload.retrievedAt, blender.provenance.retrievedAt)
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

test('JNC contract-card runtime envelope is immutable and GM6 rejects impossible GPU plans before reservations', async () => {
  assert.equal(JNC_MAXIMUM_GPU_RUNTIME_SECONDS, 5_400)
  assert.equal(JNC_MAXIMUM_GPU_RUNTIME_MINUTES, 90)
  const mapper = new ContractOnlyJncPilotMapper()
  const card = mapper.createGpuResourceCard({
    computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: JNC_MAXIMUM_GPU_RUNTIME_SECONDS, budgetEnvelopeRef: 'budget:bounded-synthetic',
  })
  assert.equal(Object.isFrozen(card), true)
  assert.equal(Object.isFrozen(card.request), true)
  assert.equal(card.request?.maximumRuntimeSeconds, JNC_MAXIMUM_GPU_RUNTIME_SECONDS)
  assert.throws(
    () => mapper.createGpuResourceCard({ ...card.request!, maximumRuntimeSeconds: JNC_MAXIMUM_GPU_RUNTIME_SECONDS + 1 }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_JNC_GPU_RESOURCE_REQUEST',
  )
  let getterReads = 0
  const accessorRequest: Record<string, unknown> = {
    computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: 60, budgetEnvelopeRef: 'budget:accessor-rejected',
  }
  Object.defineProperty(accessorRequest, 'maximumRuntimeSeconds', {
    enumerable: true,
    get() { getterReads += 1; return 60 },
  })
  assert.throws(
    () => mapper.createGpuResourceCard(accessorRequest as unknown as import('../src/gcl/jnc-pilot.js').GpuResourceRequest),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_JNC_GPU_RESOURCE_REQUEST',
  )
  assert.equal(getterReads, 0)

  const invalidConfig = runner(new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES + 1 }))
  await assert.rejects(
    invalidConfig.run.run(gameRequest({ ...premiumUnreal, gpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES + 1 })),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GAME_ENGINE_JNC_RUNTIME_ENVELOPE_INVALID',
  )
  assert.equal(invalidConfig.audit.entries.length, 0)
  assert.equal(invalidConfig.quota.reservations.length, 0)

  const overLimit = runner(new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES }))
  await assert.rejects(
    overLimit.run.run(gameRequest({ ...premiumUnreal, gpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES + 1 })),
    (error: unknown) => error instanceof CostCapError && error.message === 'GPU_RUNTIME_LIMIT_EXCEEDED',
  )
  assert.equal(overLimit.audit.entries.length, 0)
  assert.equal(overLimit.quota.reservations.length, 0)

  const atLimit = runner(
    new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES }),
    new InMemoryDailyConnectorQuota({ dailyRuns: 1, dailyItems: JNC_MAXIMUM_GPU_RUNTIME_MINUTES }),
  )
  const accepted = await atLimit.run.run(gameRequest({ ...premiumUnreal, gpuMinutes: JNC_MAXIMUM_GPU_RUNTIME_MINUTES })) as ConnectorResult<GameEngineBuildPlan>
  assert.equal(accepted.data.gpuResourceCard?.request?.maximumRuntimeSeconds, JNC_MAXIMUM_GPU_RUNTIME_SECONDS)
  assert.equal(atLimit.audit.entries[1]?.event.type, 'connector.run.succeeded')
  assert.equal(atLimit.quota.reservations.length, 1)
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

  const predatingTerminal = { ...secondEvent, occurredAt: '2026-07-22T09:59:59.999Z' }
  const predatingTerminalHash = hashAuditEvent(predatingTerminal, firstHash)
  assert.throws(() => verifiedAuditChainHead([
    { event: firstEvent, previousHash: null, hash: firstHash },
    { event: predatingTerminal, previousHash: firstHash, hash: predatingTerminalHash },
  ]), AuditChainError)

})

test('audit append and verification accept only own canonical data without invoking hostile fields', async () => {
  const validEvent = {
    type: 'connector.run.requested' as const, connectorId: 'text-to-3d', product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace',
    actor: 'synthetic-owner', scopes: ['3d:generate'], costCapCents: 50, requestedItems: 1,
    occurredAt: fixedNow().toISOString(), detail: {},
  }
  const audit = new InMemoryHashChainAuditLog()
  await audit.append(validEvent)
  assert.equal(Object.isFrozen(audit.entries[0]?.event), true)
  assert.equal(Object.isFrozen(audit.entries[0]?.event.detail ?? {}), true)

  const inheritedEvent = Object.create(validEvent)
  await assert.rejects(audit.append(inheritedEvent), AuditChainError)
  assert.throws(() => verifiedAuditChainHead([
    { event: inheritedEvent, previousHash: null, hash: audit.entries[0]?.hash },
  ]), AuditChainError)

  let eventGetterReads = 0
  const accessorEvent = { ...validEvent } as Record<string, unknown>
  Object.defineProperty(accessorEvent, 'product', {
    enumerable: true,
    get() { eventGetterReads += 1; return validEvent.product },
  })
  await assert.rejects(audit.append(accessorEvent as unknown as import('../src/gcl/types.js').ConnectorAuditEvent), AuditChainError)
  assert.throws(() => hashAuditEvent(accessorEvent as unknown as import('../src/gcl/types.js').ConnectorAuditEvent, null), AuditChainError)
  assert.equal(eventGetterReads, 0)

  let detailGetterReads = 0
  const accessorDetail: Record<string, unknown> = {}
  Object.defineProperty(accessorDetail, 'requestedAuditHash', {
    enumerable: true,
    get() { detailGetterReads += 1; return 'a'.repeat(64) },
  })
  await assert.rejects(audit.append({
    ...validEvent,
    type: 'connector.run.succeeded',
    detail: accessorDetail,
  }), AuditChainError)
  assert.equal(detailGetterReads, 0)

  const sparseScopes = ['3d:generate'] as string[]
  sparseScopes.length = 2
  await assert.rejects(audit.append({ ...validEvent, scopes: sparseScopes }), AuditChainError)
  assert.equal(audit.entries.length, 1)
})

test('runner captures one valid clock instant for audit, quota, and synthetic provenance', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })
  const capturedAt = '2026-07-22T10:15:00.000Z'
  let clockCalls = 0
  const governed = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticTextToThreeDConnector(threeDConfig())]),
    audit,
    quota,
    () => {
      clockCalls += 1
      return clockCalls === 1 ? new Date(capturedAt) : new Date('2026-07-22T10:16:00.000Z')
    },
  )

  const result = await governed.run(request()) as ConnectorResult<SyntheticThreeDResult>
  assert.equal(clockCalls, 1)
  assert.deepEqual(audit.entries.map((entry) => entry.event.occurredAt), [capturedAt, capturedAt])
  assert.equal(quota.reservations[0]?.occurredAt.toISOString(), capturedAt)
  assert.equal(result.provenance.retrievedAt, capturedAt)
  assert.equal(result.data.reviewSnapshot.payload.retrievedAt, capturedAt)
})

test('final egress seals the provenance instant into the review snapshot and rejects a relabelled stale plan', async () => {
  const staleAt = '2026-07-22T10:14:59.999Z'
  const governedAt = '2026-07-22T10:15:00.000Z'
  const staleResult = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A provenance-time-bound synthetic proposal' },
    directContext({ now: () => new Date(staleAt) }),
  )
  assert.equal(staleResult.data.reviewSnapshot.payload.retrievedAt, staleAt)
  const staleConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() {
      return {
        data: staleResult.data,
        provenance: { ...staleResult.provenance, retrievedAt: governedAt },
        confidence: 0,
      }
    },
  }
  const audit = new InMemoryHashChainAuditLog()
  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })
  const governed = new GovernedConnectorRunner(
    new ConnectorRegistry([staleConnector]), audit, quota, () => new Date(governedAt),
  )

  await assert.rejects(governed.run(request({ input: { prompt: 'A provenance-time-bound synthetic proposal' } })), SyntheticResultIntegrityError)
  assert.equal(quota.reservations.length, 1)
  assert.equal(quota.reservations[0]?.occurredAt.toISOString(), governedAt)
  assert.deepEqual(audit.entries.map((entry) => entry.event.occurredAt), [governedAt, governedAt])
  assert.equal(audit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('a prospective terminal event that predates its request is rejected before audit storage', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested = {
    type: 'connector.run.requested' as const, connectorId: 'text-to-3d', product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace',
    actor: 'synthetic-owner', scopes: ['3d:generate'], costCapCents: 50, requestedItems: 1,
    occurredAt: '2026-07-22T10:15:00.000Z', detail: {},
  }
  const { hash } = await audit.append(requested)
  await assert.rejects(audit.append({
    ...requested,
    type: 'connector.run.failed',
    occurredAt: '2026-07-22T10:14:59.999Z',
    detail: { requestedAuditHash: hash, error: 'synthetic_result_integrity_invalid' },
  }), AuditChainError)
  assert.equal(audit.entries.length, 1)
})

test('invalid governance clocks fail closed before preflight, audit, quota, or adapter execution', async () => {
  let preflightCalls = 0
  let runCalls = 0
  const connector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    preflight() { preflightCalls += 1 },
    async run() { runCalls += 1; throw new Error('ADAPTER_MUST_NOT_RUN') },
  }
  const invalidClock = () => new Date('invalid')
  const audit = new InMemoryHashChainAuditLog()
  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })
  const governed = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, invalidClock)

  await assert.rejects(
    governed.run(request()),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )
  assert.equal(preflightCalls, 0)
  assert.equal(runCalls, 0)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.reservations.length, 0)

  class SubclassedClock extends Date {}
  const subclassed = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticTextToThreeDConnector(threeDConfig())]),
    new InMemoryHashChainAuditLog(),
    new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 }),
    () => new SubclassedClock(fixedNow().getTime()),
  )
  await assert.rejects(
    subclassed.run(request()),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )

  const throwing = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticTextToThreeDConnector(threeDConfig())]),
    new InMemoryHashChainAuditLog(),
    new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 }),
    () => { throw new Error('CLOCK_SEAM_MUST_NOT_ESCAPE') },
  )
  await assert.rejects(
    throwing.run(request()),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )

  const proxyClockTraps = { count: 0 }
  const proxyClock = new Proxy(() => fixedNow(), {
    apply() { proxyClockTraps.count += 1; return fixedNow() },
  })
  const proxyClockAudit = new InMemoryHashChainAuditLog()
  const proxyClockQuota = new InMemoryDailyConnectorQuota({ dailyRuns: 6, dailyItems: 60 })
  const proxyClockRunner = new GovernedConnectorRunner(
    new ConnectorRegistry([connector]), proxyClockAudit, proxyClockQuota, proxyClock,
  )
  await assert.rejects(
    proxyClockRunner.run(request()),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )
  assert.equal(proxyClockTraps.count, 0)
  assert.equal(proxyClockAudit.entries.length, 0)
  assert.equal(proxyClockQuota.reservations.length, 0)
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

test('GM5/GM6 proxy-backed boundaries fail closed before reflection, reservation, or egress acceptance', async () => {
  const configTraps = { count: 0 }
  const proxyConfig = trapCountingProxy(threeDConfig(), configTraps)
  assert.throws(
    () => new SyntheticTextToThreeDConnector(proxyConfig),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_INVALID_SYNTHETIC_CONFIG',
  )
  assert.equal(configTraps.count, 0)

  const gpuTraps = { count: 0 }
  const proxyGpuRequest = trapCountingProxy({
    computeTier: 'premium' as const, estimatedVramMiB: 'UNKNOWN' as const, maximumRuntimeSeconds: 60, budgetEnvelopeRef: 'synthetic-budget',
  }, gpuTraps)
  const mapper = new ContractOnlyJncPilotMapper()
  assert.throws(
    () => mapper.createGpuResourceCard(proxyGpuRequest),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_JNC_GPU_RESOURCE_REQUEST',
  )
  assert.equal(gpuTraps.count, 0)

  const inputTraps = { count: 0 }
  const proxyInput = trapCountingProxy({ prompt: 'A proxy must not become a synthetic plan' }, inputTraps)
  await assert.rejects(
    new SyntheticTextToThreeDConnector(threeDConfig()).run(proxyInput, directContext()),
    ConnectorInputError,
  )
  assert.equal(inputTraps.count, 0)

  const bindingTraps = { count: 0 }
  const proxyContext = trapCountingProxy(directContext(), bindingTraps)
  assert.throws(() => syntheticResultReviewBinding(proxyContext, fixedNow().toISOString()), SyntheticResultIntegrityError)
  assert.equal(bindingTraps.count, 0)

  assert.throws(
    () => syntheticResultReviewBinding(directContext(), 'not-an-iso-instant'),
    (error: unknown) => error instanceof SyntheticResultIntegrityError && error.message === 'SYNTHETIC_RESULT_REVIEW_BINDING_INVALID',
  )

  const requestTraps = { count: 0 }
  const proxyRequest = trapCountingProxy(request(), requestTraps)
  const preflightRejected = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  await assert.rejects(
    preflightRejected.run.run(proxyRequest),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT',
  )
  assert.equal(requestTraps.count, 0)
  assert.equal(preflightRejected.audit.entries.length, 0)
  assert.equal(preflightRejected.quota.reservations.length, 0)

  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A genuine local synthetic plan' }, directContext(),
  )
  const resultTraps = { count: 0 }
  // Native Promise resolution is required to read `then` once to distinguish
  // a thenable. Count every data-reflection trap after that protocol probe.
  const proxyResult = new Proxy({ data: genuine.data, provenance: genuine.provenance, confidence: 0 }, {
    get(target, property, receiver) {
      if (property !== 'then') resultTraps.count += 1
      return Reflect.get(target, property, receiver)
    },
    getPrototypeOf(target) { resultTraps.count += 1; return Reflect.getPrototypeOf(target) },
    getOwnPropertyDescriptor(target, property) { resultTraps.count += 1; return Reflect.getOwnPropertyDescriptor(target, property) },
    ownKeys(target) { resultTraps.count += 1; return Reflect.ownKeys(target) },
  })
  const resultConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return proxyResult as unknown as ConnectorResult },
  }
  const egressRejected = runner(resultConnector)
  await assert.rejects(egressRejected.run.run(request()), SyntheticResultIntegrityError)
  assert.equal(resultTraps.count, 0)
  assert.equal(egressRejected.quota.reservations.length, 1)
  assert.equal(egressRejected.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('direct GM5/GM6 calls cross the immutable synthetic egress boundary and capture only a native non-proxy clock instant', async () => {
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
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )
  assert.equal(invalidClockReads, 1)

  const proxyClockTraps = { count: 0 }
  const proxyClock = new Proxy(fixedNow, {
    apply() { proxyClockTraps.count += 1; return fixedNow() },
  })
  await assert.rejects(
    threeD.run({ prompt: 'A local synthetic 3D proposal' }, directContext({ now: proxyClock })),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'CONNECTOR_INVALID_CONTEXT',
  )
  assert.equal(proxyClockTraps.count, 0)

  const dateProxyTraps = { count: 0 }
  const proxyDate = new Proxy(new Date('2026-07-22T10:17:00.000Z'), {
    get(target, property, receiver) { dateProxyTraps.count += 1; return Reflect.get(target, property, receiver) },
    getPrototypeOf(target) { dateProxyTraps.count += 1; return Reflect.getPrototypeOf(target) },
  }) as unknown as Date
  await assert.rejects(
    game.run(premiumUnreal, directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12, now: () => proxyDate })),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_CLOCK_UNAVAILABLE',
  )
  assert.equal(dateProxyTraps.count, 0)

  const shadowedDate = new Date('2026-07-22T10:18:00.000Z')
  Object.defineProperty(shadowedDate, 'toISOString', { value: () => '2026-01-01T00:00:00.000Z' })
  const canonicalTimestampResult = await threeD.run(
    { prompt: 'A local synthetic 3D proposal' }, directContext({ now: () => shadowedDate }),
  )
  assert.equal(canonicalTimestampResult.provenance.retrievedAt, '2026-07-22T10:18:00.000Z')
})

test('runner isolates submitted input and context across preflight/run, then binds the result to that exact submission', async () => {
  const submitted = { prompt: 'The owner submitted this exact synthetic proposal' }
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(submitted, directContext())
  const originalPrompt = submitted.prompt
  let preflightInput: unknown
  let runInput: unknown
  const isolatedConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    preflight(input, context) {
      preflightInput = input
      assert.notEqual(input, submitted)
      assert.equal(Object.isFrozen(input as object), true)
      assert.equal(Object.isFrozen(context), true)
      assert.equal(Object.isFrozen(context.scopes), true)
      submitted.prompt = 'Caller-side mutation after the snapshot must not reach run'
      assert.equal(Reflect.set(input as object, 'prompt', 'preflight mutation'), false)
      assert.equal(Reflect.set(context as object, 'costCapCents', 1), false)
    },
    async run(input) {
      runInput = input
      assert.equal(input, preflightInput)
      assert.equal((input as { prompt: string }).prompt, originalPrompt)
      return genuine
    },
  }
  const isolatedRun = runner(isolatedConnector)
  const accepted = await isolatedRun.run.run(request({ input: submitted })) as ConnectorResult<SyntheticThreeDResult>
  assert.equal(runInput, preflightInput)
  assert.equal(accepted.data.artifact.reviewState, 'OWNER_REVIEW_REQUIRED')
  assert.equal(isolatedRun.audit.entries[1]?.event.type, 'connector.run.succeeded')
  assert.equal(isolatedRun.quota.reservations.length, 1)

  const differentPlan = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A different but internally valid synthetic proposal' }, directContext(),
  )
  const mismatchedConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return differentPlan },
  }
  const mismatchedRun = runner(mismatchedConnector)
  await assert.rejects(mismatchedRun.run.run(request({ input: { prompt: originalPrompt } })), SyntheticResultIntegrityError)
  assert.equal(mismatchedRun.quota.reservations.length, 1)
  assert.equal(mismatchedRun.audit.entries[1]?.event.type, 'connector.run.failed')
  assert.equal(mismatchedRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const requestedGame = premiumUnreal
  const differentGame = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(
    { ...requestedGame, brief: 'A different but internally valid premium game plan.' },
    directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 }),
  )
  const mismatchedGameConnector: Connector = {
    id: 'game-engine', kind: 'game-engine', authKind: 'owner-approval', scopes: ['game:project:build'],
    async run() { return differentGame },
  }
  const mismatchedGameRun = runner(mismatchedGameConnector)
  await assert.rejects(mismatchedGameRun.run.run(gameRequest(requestedGame)), SyntheticResultIntegrityError)
  assert.equal(mismatchedGameRun.quota.reservations.length, 1)
  assert.equal(mismatchedGameRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('final egress binds normalized GM5/GM6 plan input to the original submission, not only its claimed digest', async () => {
  const requestedThreeDInput = { prompt: '  The owner requested this 3D proposal.  ', style: '  educational  ' }
  const acceptedThreeD = await runner(new SyntheticTextToThreeDConnector(threeDConfig())).run.run(request({ input: requestedThreeDInput })) as ConnectorResult<SyntheticThreeDResult>
  const normalizedThreeDInput = acceptedThreeD.data.reviewSnapshot.payload.input as { prompt: unknown; style: unknown }
  assert.equal(normalizedThreeDInput.prompt, 'The owner requested this 3D proposal.')
  assert.equal(normalizedThreeDInput.style, 'educational')

  const alternateThreeD = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A different but valid 3D proposal.', style: 'educational' }, directContext(),
  )
  const forgedThreeDPayload = {
    ...alternateThreeD.data.reviewSnapshot.payload,
    submittedInputSha256: syntheticPlanSha256(requestedThreeDInput),
  }
  const forgedThreeDSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'text-to-3d', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: forgedThreeDPayload,
  })
  const forgedThreeDData = deepFreeze({
    ...alternateThreeD.data,
    integrity: forgedThreeDSnapshot.integrity,
    reviewReceipt: forgedThreeDSnapshot.reviewReceipt,
    reviewSnapshot: forgedThreeDSnapshot,
  }) as unknown as SyntheticThreeDResult
  const forgedThreeDConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return { data: forgedThreeDData, provenance: alternateThreeD.provenance, confidence: 0 } },
  }
  const forgedThreeDRun = runner(forgedThreeDConnector)
  await assert.rejects(forgedThreeDRun.run.run(request({ input: requestedThreeDInput })), SyntheticResultIntegrityError)
  assert.equal(forgedThreeDRun.quota.reservations.length, 1)
  assert.equal(forgedThreeDRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const requestedGameInput = { ...premiumUnreal, brief: '  The owner requested this premium game plan.  ' }
  const alternateGame = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(
    { ...premiumUnreal, brief: 'A different but valid premium game plan.' },
    directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 }),
  )
  const forgedGamePayload = {
    ...alternateGame.data.reviewSnapshot.payload,
    submittedInputSha256: syntheticPlanSha256(requestedGameInput),
  }
  const forgedGameSnapshot = createSyntheticReviewSnapshot({
    connectorId: 'game-engine', scope: { product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace' }, payload: forgedGamePayload,
  })
  const forgedGameData = deepFreeze({
    ...alternateGame.data,
    integrity: forgedGameSnapshot.integrity,
    reviewReceipt: forgedGameSnapshot.reviewReceipt,
    reviewSnapshot: forgedGameSnapshot,
  }) as unknown as GameEngineBuildPlan
  const forgedGameConnector: Connector = {
    id: 'game-engine', kind: 'game-engine', authKind: 'owner-approval', scopes: ['game:project:build'],
    async run() { return { data: forgedGameData, provenance: alternateGame.provenance, confidence: 0 } },
  }
  const forgedGameRun = runner(forgedGameConnector)
  await assert.rejects(forgedGameRun.run.run(gameRequest(requestedGameInput)), SyntheticResultIntegrityError)
  assert.equal(forgedGameRun.quota.reservations.length, 1)
  assert.equal(forgedGameRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('final egress binds GM5/GM6 review scope, owner actor, and reservation governance to the governed request', async () => {
  const threeDInput = { prompt: 'A scope-bound synthetic 3D proposal', outputFormat: 'glb' as const }
  const scopeReplay = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    threeDInput,
    directContext({ workspaceId: 'other-workspace' }),
  )
  const scopeReplayConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return scopeReplay },
  }
  const scopeReplayRun = runner(scopeReplayConnector)
  await assert.rejects(scopeReplayRun.run.run(request({ input: threeDInput })), SyntheticResultIntegrityError)
  assert.equal(scopeReplayRun.quota.reservations.length, 1)
  assert.equal(scopeReplayRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const actorReplay = await new SyntheticTextToThreeDConnector(threeDConfig()).run(threeDInput, directContext())
  const actorReplayConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return actorReplay },
  }
  const actorReplayRun = runner(actorReplayConnector)
  await assert.rejects(actorReplayRun.run.run(request({ input: threeDInput, actor: 'other-owner' })), SyntheticResultIntegrityError)
  assert.equal(actorReplayRun.quota.reservations.length, 1)
  assert.equal(actorReplayRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const governanceReplay = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    threeDInput,
    directContext({ costCapCents: 75 }),
  )
  const governanceReplayConnector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { return governanceReplay },
  }
  const governanceReplayRun = runner(governanceReplayConnector)
  await assert.rejects(governanceReplayRun.run.run(request({ input: threeDInput })), SyntheticResultIntegrityError)
  assert.equal(governanceReplayRun.quota.reservations.length, 1)
  assert.equal(governanceReplayRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const gameReplay = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(
    premiumUnreal,
    directContext({ workspaceId: 'other-workspace', scopes: ['game:project:build'], costCapCents: 75, requestedItems: 12 }),
  )
  const gameReplayConnector: Connector = {
    id: 'game-engine', kind: 'game-engine', authKind: 'owner-approval', scopes: ['game:project:build'],
    async run() { return gameReplay },
  }
  const gameReplayRun = runner(gameReplayConnector)
  await assert.rejects(gameReplayRun.run.run(gameRequest(premiumUnreal)), SyntheticResultIntegrityError)
  assert.equal(gameReplayRun.quota.reservations.length, 1)
  assert.equal(gameReplayRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')

  const gameActorReplay = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(
    premiumUnreal,
    directContext({ scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 }),
  )
  const gameOtherActor = await new SyntheticGameEngineConnector({ liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxGpuMinutes: 30 }).run(
    premiumUnreal,
    directContext({ actor: 'other-owner', scopes: ['game:project:build'], costCapCents: 100, requestedItems: 12 }),
  )
  assert.notEqual(gameActorReplay.data.buildId, gameOtherActor.data.buildId)
  const gameActorReplayConnector: Connector = {
    id: 'game-engine', kind: 'game-engine', authKind: 'owner-approval', scopes: ['game:project:build'],
    async run() { return gameActorReplay },
  }
  const gameActorReplayRun = runner(gameActorReplayConnector)
  await assert.rejects(gameActorReplayRun.run.run({ ...gameRequest(premiumUnreal), actor: 'other-owner' }), SyntheticResultIntegrityError)
  assert.equal(gameActorReplayRun.quota.reservations.length, 1)
  assert.equal(gameActorReplayRun.audit.entries[1]?.event.detail.error, 'synthetic_result_integrity_invalid')
})

test('registry admission seals connector metadata and rejects accessor-backed runner methods', () => {
  const connector: Connector = {
    id: 'registry-seal-proposal', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() { throw new Error('NOT_RUN') },
  }
  const registry = new ConnectorRegistry([connector])
  assert.equal(Object.isFrozen(connector), true)
  assert.equal(Object.isFrozen(connector.scopes), true)
  assert.equal(Reflect.set(connector as unknown as object, 'id', 'game-engine'), false)
  assert.equal(Reflect.set(connector.scopes as unknown as object, '0', 'game:project:build'), false)
  assert.equal(registry.get('registry-seal-proposal').id, 'registry-seal-proposal')

  let runGetterReads = 0
  const accessorConnector: Record<string, unknown> = {
    id: 'accessor-proposal', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
  }
  Object.defineProperty(accessorConnector, 'run', {
    enumerable: true,
    get() { runGetterReads += 1; return async () => { throw new Error('MUST_NOT_RUN') } },
  })
  assert.throws(
    () => new ConnectorRegistry([accessorConnector as unknown as Connector]),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_INVALID_REGISTRATION',
  )
  assert.equal(runGetterReads, 0)
})

test('governance scope cardinality is bounded consistently before registration, audit, or egress', async () => {
  const permittedScopes = Array.from({ length: MAX_GOVERNANCE_SCOPE_COUNT }, (_, index) => `synthetic:scope:${index}`)
  const tooManyScopes = [...permittedScopes, 'synthetic:scope:overflow']
  const httpRequest = { input: { prompt: 'Synthetic scope-bound request' }, scopes: permittedScopes, costCapCents: 50, requestedItems: 1 }
  assert.deepEqual(connectorRunFrom(httpRequest).scopes, permittedScopes)
  assert.throws(
    () => connectorRunFrom({ ...httpRequest, scopes: tooManyScopes }),
    (error: unknown) => error instanceof Error && error.message === 'INVALID_CONNECTOR_SCOPES',
  )

  const oversizedConnector: Connector = {
    id: 'oversized-scope-contract', kind: 'media-3d', authKind: 'owner-approval', scopes: tooManyScopes,
    async run() { throw new Error('MUST_NOT_RUN') },
  }
  assert.throws(
    () => new ConnectorRegistry([oversizedConnector]),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_INVALID_REGISTRATION',
  )

  const adapter = new SyntheticTextToThreeDConnector(threeDConfig())
  await assert.rejects(adapter.run({ prompt: 'Direct scope overflow' }, directContext({ scopes: tooManyScopes })), ScopeError)
  assert.throws(
    () => syntheticResultReviewBinding(directContext({ scopes: tooManyScopes }), fixedNow().toISOString()),
    SyntheticResultIntegrityError,
  )

  const overflowingEvent = {
    type: 'connector.run.requested' as const, connectorId: 'text-to-3d', product: 'sectrai-gm-contract-test', workspaceId: 'gm-workspace',
    actor: 'synthetic-owner', scopes: tooManyScopes, costCapCents: 50, requestedItems: 1,
    occurredAt: fixedNow().toISOString(), detail: {},
  }
  const audit = new InMemoryHashChainAuditLog()
  assert.throws(() => hashAuditEvent(overflowingEvent, null), AuditChainError)
  await assert.rejects(audit.append(overflowingEvent), AuditChainError)
  assert.equal(audit.entries.length, 0)

  const governed = runner(new SyntheticTextToThreeDConnector(threeDConfig()))
  await assert.rejects(governed.run.run(request({ scopes: tooManyScopes })), ScopeError)
  assert.equal(governed.audit.entries.length, 0)
  assert.equal(governed.quota.reservations.length, 0)
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

test('the final result boundary detaches canonical untrusted provenance before egress', async () => {
  const genuine = await new SyntheticTextToThreeDConnector(threeDConfig()).run(
    { prompt: 'A local synthetic 3D proposal' }, directContext(),
  )
  const adapterOwnedValue = { prompt: 'A local synthetic 3D proposal', outputFormat: 'glb' }
  const connector: Connector = {
    id: 'text-to-3d', kind: 'media-3d', authKind: 'owner-approval', scopes: ['3d:generate'],
    async run() {
      return {
        data: genuine.data,
        provenance: {
          ...genuine.provenance,
          untrustedContent: { ...genuine.provenance.untrustedContent, value: adapterOwnedValue },
        },
        confidence: 0,
      }
    },
  }
  const governed = runner(connector)
  const accepted = await governed.run.run(request({ input: { prompt: 'A local synthetic 3D proposal' } })) as ConnectorResult<SyntheticThreeDResult>
  const acceptedValue = accepted.provenance.untrustedContent.value as { prompt: string; outputFormat: string }

  assert.deepEqual(acceptedValue, adapterOwnedValue)
  assert.notEqual(acceptedValue, adapterOwnedValue)
  assert.equal(Object.isFrozen(acceptedValue), true)
  assert.equal(Object.isFrozen(adapterOwnedValue), false)
  adapterOwnedValue.prompt = 'A later adapter-side mutation must not reach egress'
  assert.equal(acceptedValue.prompt, 'A local synthetic 3D proposal')
  assert.equal(governed.audit.entries[1]?.event.type, 'connector.run.succeeded')
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
