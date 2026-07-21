import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, QuotaError, ScopeError } from '../src/gcl/errors.js'
import { InMemoryDailyConnectorQuota } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from '../src/gcl/registry.js'
import { LIVE_DISABLED, SyntheticImageTextToThreeDConnector, SyntheticTextToThreeDConnector, syntheticThreeDConnectorsFromEnvironment, type SyntheticThreeDConnectorConfig, type SyntheticThreeDResult } from '../src/gcl/three-d.js'
import type { Connector, ConnectorResult } from '../src/gcl/types.js'

const fixedNow = () => new Date('2026-07-21T10:00:00.000Z')

function request(overrides: Partial<RunConnectorRequest> = {}): RunConnectorRequest {
  return {
    connectorId: 'text-to-3d',
    input: { prompt: 'Low-poly learning globe', outputFormat: 'glb' },
    product: 'sectrai-synthetic-test',
    workspaceId: 'gm5-workspace',
    actor: 'owner-1',
    ownerApproved: true,
    scopes: ['3d:generate'],
    costCapCents: 50,
    requestedItems: 1,
    ...overrides,
  }
}

function configured(overrides: Partial<SyntheticThreeDConnectorConfig> = {}): SyntheticThreeDConnectorConfig {
  return { liveMode: LIVE_DISABLED, maxCostCapCents: 100, maxItems: 1, ...overrides }
}

function runner(
  connector: Connector = new SyntheticTextToThreeDConnector(configured()),
  quota = new InMemoryDailyConnectorQuota({ dailyRuns: 4, dailyItems: 4 }),
): { audit: InMemoryHashChainAuditLog; quota: InMemoryDailyConnectorQuota; run: GovernedConnectorRunner } {
  const audit = new InMemoryHashChainAuditLog()
  return { audit, quota, run: new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, fixedNow) }
}

test('text-to-3d is a deterministic synthetic proposal with a non-dispatching JARVIS GPU resource card', async () => {
  const { audit, quota, run } = runner()
  const result = await run.run(request({
    input: {
      prompt: 'A low-poly solar system model for a classroom',
      style: 'educational',
      gpuResourceRequest: { computeTier: 'premium', estimatedVramMiB: 'UNKNOWN', maximumRuntimeSeconds: 900, budgetEnvelopeRef: 'budget:synthetic-gm5' },
    },
  })) as ConnectorResult<SyntheticThreeDResult>

  assert.equal(result.data.liveMode, LIVE_DISABLED)
  assert.equal(result.data.artifact.generation, 'SYNTHETIC_PROPOSAL_ONLY')
  assert.equal(result.data.artifact.reviewState, 'OWNER_REVIEW_REQUIRED')
  assert.equal(result.data.artifact.publicationState, 'NOT_PUBLISHED')
  assert.match(result.data.artifact.syntheticUri, /^synthetic:\/\/gcl-3d\/text-to-3d\//)
  assert.equal(result.data.gpuResourceCard.controller, 'jarvis-node-controller')
  assert.equal(result.data.gpuResourceCard.mode, 'CONTRACT_ONLY')
  assert.equal(result.data.gpuResourceCard.autostart, false)
  assert.equal(result.data.gpuResourceCard.dispatchState, 'NOT_DISPATCHED')
  assert.equal(result.data.gpuResourceCard.executionAuthorization, 'NOT_AUTHORIZED')
  assert.equal(result.data.gpuResourceCard.leaseState, 'NOT_ACQUIRED')
  assert.equal(result.data.gpuResourceCard.separateOwnerApproval, 'REQUIRED')
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[0]?.previousHash, null)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.equal(quota.reservations.length, 1)
})

test('missing LIVE_DISABLED, owner approval, and configured cost ceiling all close before usage reservation', async () => {
  const disabled = runner(new SyntheticTextToThreeDConnector(configured({ liveMode: undefined })))
  await assert.rejects(disabled.run.run(request()), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_LIVE_DISABLED_REQUIRED')
  assert.equal(disabled.audit.entries.length, 0)
  assert.equal(disabled.quota.reservations.length, 0)

  const governed = runner()
  await assert.rejects(governed.run.run(request({ ownerApproved: false })), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(governed.run.run(request({ scopes: ['3d:read'] })), (error: unknown) => error instanceof ScopeError)
  await assert.rejects(governed.run.run(request({ costCapCents: 101 })), (error: unknown) => error instanceof CostCapError)
  assert.equal(governed.audit.entries.length, 0)
  assert.equal(governed.quota.reservations.length, 0)
})

test('environment wiring accepts only the exact synthetic LIVE_DISABLED flag', async () => {
  const [syntheticConnector] = syntheticThreeDConnectorsFromEnvironment({
    GCL_3D_LIVE_MODE: LIVE_DISABLED,
    GCL_3D_MAX_COST_CENTS: '100',
    GCL_3D_MAX_ITEMS: '1',
  })
  if (!syntheticConnector) throw new Error('SYNTHETIC_CONNECTOR_MISSING')
  await runner(syntheticConnector).run.run(request())

  const [closedConnector] = syntheticThreeDConnectorsFromEnvironment({
    GCL_3D_LIVE_MODE: 'LIVE_ENABLED',
    GCL_3D_MAX_COST_CENTS: '100',
    GCL_3D_MAX_ITEMS: '1',
  })
  if (!closedConnector) throw new Error('CLOSED_CONNECTOR_MISSING')
  const closed = runner(closedConnector)
  await assert.rejects(closed.run.run(request()), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'THREED_LIVE_DISABLED_REQUIRED')
  assert.equal(closed.audit.entries.length, 0)
})

test('image-plus-text accepts only a local asset reference and rejects an arbitrary image URL before audit', async () => {
  const { audit, quota, run } = runner(new SyntheticImageTextToThreeDConnector(configured()))
  await assert.rejects(run.run(request({
    connectorId: 'image-text-to-3d',
    input: { prompt: 'Turn this drawing into a learning model', imageUrl: 'https://provider.example/asset.png' },
  })), (error: unknown) => error instanceof ConnectorInputError && error.message === 'UNEXPECTED_THREED_INPUT_FIELD')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.reservations.length, 0)
})

test('image-plus-text produces a synthetic proposal from an immutable local asset reference', async () => {
  const { run } = runner(new SyntheticImageTextToThreeDConnector(configured()))
  const result = await run.run(request({
    connectorId: 'image-text-to-3d',
    input: {
      prompt: 'Make this leaf into a simple educational 3D model',
      image: { assetId: 'asset-leaf-1', sha256: 'a'.repeat(64), mediaType: 'image/png' },
      outputFormat: 'obj',
    },
  })) as ConnectorResult<SyntheticThreeDResult>
  assert.equal(result.data.connectorKind, 'image-text-to-3d')
  assert.equal(result.data.artifact.outputFormat, 'obj')
  assert.equal(result.data.gpuResourceCard.request, null)
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
})

test('daily quota remains connector-specific and conservatively reserves attempted work', async () => {
  const quota = new InMemoryDailyConnectorQuota({ dailyRuns: 1, dailyItems: 1 })
  const { audit, run } = runner(undefined, quota)
  await run.run(request())
  await assert.rejects(run.run(request()), (error: unknown) => error instanceof QuotaError)
  assert.equal(quota.reservations.length, 1)
  assert.equal(audit.entries.length, 3)
  assert.equal(audit.entries[2]?.event.type, 'connector.run.requested')
})
