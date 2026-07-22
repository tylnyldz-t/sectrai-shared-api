import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app.js'
import { hashAuditEvent, InMemoryHashChainAuditLog, PrismaHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorUnavailableError } from '../src/gcl/errors.js'
import type { RunConnectorRequest } from '../src/gcl/registry.js'
import { InMemoryTranslationArtifactStore, PrismaTranslationArtifactStore, translationArtifactReviewDigest } from '../src/gcl/translation-artifacts.js'
import type { ConnectorAuditEvent, ConnectorResult } from '../src/gcl/types.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const product = 'sectrai-translation-http-test'
const workspaceId = 'ws-translation-http'
const ownerToken = 'synthetic-owner-token'
const productKey = 'synthetic-product-key'

function runResult(): ConnectorResult {
  return {
    data: { type: 'text-translation', mode: 'SYNTHETIC', translatedText: 'must never be stored' },
    artifact: {
      kind: 'translated-text',
      contentHash: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      source: 'synthetic-text-translation',
      synthetic: true,
      approvalState: 'pending-checker-approval',
      autoPublish: false,
      reviewPolicyVersion: 'gcl-translation-synthetic-v1',
      reviewExpiresAt: '2026-07-22T12:05:00.000Z',
    },
    provenance: {
      connectorId: 'translation-text-synthetic',
      source: 'synthetic-text-translation-fixture',
      retrievedAt: now().toISOString(),
      auditHash: 'b'.repeat(64),
      untrustedContent: {
        source: 'owner-supplied-synthetic-text-translation',
        value: { contentHash: `sha256:${'a'.repeat(64)}` },
        handling: 'data-only',
        instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
      },
    },
    confidence: 0,
  }
}

async function running(): Promise<{ server: Server; base: string; audit: InMemoryHashChainAuditLog; runnerCalls: () => number } | null> {
  const audit = new InMemoryHashChainAuditLog()
  const artifacts = new InMemoryTranslationArtifactStore(audit)
  let calls = 0
  const runner = {
    async run(request: RunConnectorRequest): Promise<ConnectorResult> {
      calls += 1
      const requested = await audit.append({
        type: 'connector.run.requested', connectorId: request.connectorId, product: request.product, workspaceId: request.workspaceId, actor: request.actor,
        scopes: request.scopes, costCapCents: request.costCapCents, requestedItems: request.requestedItems, occurredAt: now().toISOString(), detail: {},
      })
      const result = runResult()
      const succeeded = await audit.append({
        type: 'connector.run.succeeded', connectorId: request.connectorId, product: request.product, workspaceId: request.workspaceId, actor: request.actor,
        scopes: request.scopes, costCapCents: request.costCapCents, requestedItems: request.requestedItems, occurredAt: now().toISOString(),
        detail: { requestedAuditHash: requested.hash, artifact: result.artifact! },
      })
      return { ...result, provenance: { ...result.provenance, auditHash: succeeded.hash } }
    },
  }
  const app = createApp({
    prisma: {} as PrismaClient,
    now,
    gclRunner: runner,
    gclOwnerToken: ownerToken,
    gclAuditLog: audit,
    translationArtifactStore: artifacts,
  })
  let server: ReturnType<typeof app.listen>
  try {
    server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const value = app.listen(0, () => {
        value.off('error', reject)
        resolve(value)
      })
      value.once('error', reject)
    })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'EPERM') return null
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') return null
  return { server, audit, runnerCalls: () => calls, base: `http://127.0.0.1:${address.port}/api/products/${product}/workspaces/${workspaceId}/gcl` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('approval HTTP route rejects missing or mismatched review bindings before a decision and permits the exact checker-bound decision', async (context) => {
  const oldProductKey = process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
  process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = productKey
  const service = await running()
  if (!service) {
    if (oldProductKey === undefined) delete process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
    else process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = oldProductKey
    return context.skip('sandbox disallows loopback listeners')
  }
  const headers = {
    'content-type': 'application/json',
    'x-sectrai-product-key': productKey,
    'x-sectrai-owner-token': ownerToken,
    'x-sectrai-owner-actor': 'maker@example.test',
  }
  try {
    const run = await fetch(`${service.base}/connectors/translation-text-synthetic/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: { synthetic: true },
        scopes: ['translation:text'],
        costCapCents: 25,
        requestedItems: 1,
      }),
    })
    assert.equal(run.status, 200)
    const created = await run.json() as { artifact: { id: string; reviewDigest: string } }

    const missing = await fetch(`${service.base}/translation-artifacts/${created.artifact.id}/approval`, {
      method: 'POST', headers: { ...headers, 'x-sectrai-owner-actor': 'checker@example.test' }, body: JSON.stringify({ decision: 'approved' }),
    })
    assert.equal(missing.status, 422)

    const mismatched = await fetch(`${service.base}/translation-artifacts/${created.artifact.id}/approval`, {
      method: 'POST', headers: { ...headers, 'x-sectrai-owner-actor': 'checker@example.test' }, body: JSON.stringify({ decision: 'approved', reviewDigest: `sha256:${'0'.repeat(64)}` }),
    })
    assert.equal(mismatched.status, 409)
    assert.equal((await mismatched.json() as { code: string }).code, 'translation_artifact_review_binding_required')

    const approved = await fetch(`${service.base}/translation-artifacts/${created.artifact.id}/approval`, {
      method: 'POST', headers: { ...headers, 'x-sectrai-owner-actor': 'checker@example.test' }, body: JSON.stringify({ decision: 'approved', reviewDigest: created.artifact.reviewDigest }),
    })
    assert.equal(approved.status, 200)
    assert.equal((await approved.json() as { artifact: { approvalState: string } }).artifact.approvalState, 'approved')
    assert.equal(service.audit.entries.length, 4)
    assert.equal(JSON.stringify(service.audit.entries).includes('must never be stored'), false)
  } finally {
    await close(service.server)
    if (oldProductKey === undefined) delete process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
    else process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = oldProductKey
  }
})

test('HTTP connector route rejects a blank owner actor before the runner, artifact, or audit can run', async (context) => {
  const oldProductKey = process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
  process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = productKey
  const service = await running()
  if (!service) {
    if (oldProductKey === undefined) delete process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
    else process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = oldProductKey
    return context.skip('sandbox disallows loopback listeners')
  }
  try {
    const response = await fetch(`${service.base}/connectors/translation-text-synthetic/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sectrai-product-key': productKey,
        'x-sectrai-owner-token': ownerToken,
        'x-sectrai-owner-actor': '   ',
      },
      body: JSON.stringify({ input: { synthetic: true }, scopes: ['translation:text'], costCapCents: 25, requestedItems: 1 }),
    })
    assert.equal(response.status, 422)
    assert.equal((await response.json() as { error: string }).error, 'INVALID_OWNER_ACTOR')
    assert.equal(service.runnerCalls(), 0)
    assert.equal(service.audit.entries.length, 0)
  } finally {
    await close(service.server)
    if (oldProductKey === undefined) delete process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
    else process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = oldProductKey
  }
})

test('durable audit append fails closed when an existing tenant/workspace chain is malformed', async () => {
  const event: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const validHash = hashAuditEvent(event, null)
  let createCalls = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [{ values: { event, previousHash: null, hash: `f${validHash.slice(1)}` } }],
        create: async () => { createCalls += 1; return {} },
      },
    }),
  }
  const audit = new PrismaHashChainAuditLog(prisma as never)
  await assert.rejects(() => audit.append(event), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(createCalls, 0)
})

test('durable audit rejects a hash-valid prior row that adds raw fixture fields outside the metadata schema', async () => {
  const event: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const forged = { ...event, detail: { sourceText: 'must never become an audit field' } }
  let createCalls = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [{ values: { event: forged, previousHash: null, hash: hashAuditEvent(forged, null) } }],
        create: async () => { createCalls += 1; return {} },
      },
    }),
  }
  const audit = new PrismaHashChainAuditLog(prisma as never)
  await assert.rejects(() => audit.append(event), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(createCalls, 0)
})

test('audit binds every run and artifact creation to its connector scope and exactly one artifact', async () => {
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const artifact = runResult().artifact!
  const runAuditHash = 'b'.repeat(64)
  const pending = { connectorId: 'translation-text-synthetic', ...artifact, runAuditHash }
  const reviewDigest = translationArtifactReviewDigest(pending)
  const artifactDetail = (approvalState: 'pending-checker-approval' | 'approved' | 'rejected') => ({
    artifactId: 'translation-artifact-scope-binding',
    kind: artifact.kind,
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType,
    source: artifact.source,
    synthetic: true,
    approvalState,
    reviewPolicyVersion: artifact.reviewPolicyVersion,
    reviewDigest,
    reviewExpiresAt: artifact.reviewExpiresAt,
    runAuditHash,
    autoPublish: false,
  })
  const runEvents: ConnectorAuditEvent[] = [
    requested,
    {
      type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
      scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: { requestedAuditHash: 'a'.repeat(64), artifact },
    },
    {
      type: 'connector.run.failed', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
      scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: { requestedAuditHash: 'a'.repeat(64), error: 'connector_quota_exceeded' },
    },
    {
      type: 'translation.artifact.created', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
      scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: artifactDetail('pending-checker-approval'),
    },
  ]
  const decisionEvents: ConnectorAuditEvent[] = [
    {
      type: 'translation.artifact.approved', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'checker@example.test',
      scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString(), detail: artifactDetail('approved'),
    },
    {
      type: 'translation.artifact.rejected', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'checker@example.test',
      scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString(), detail: artifactDetail('rejected'),
    },
  ]
  const semanticForgeries: ConnectorAuditEvent[] = [
    ...runEvents.flatMap((event) => [
      { ...event, scopes: ['translation:speech'] },
      { ...event, requestedItems: 2 },
    ]),
    ...decisionEvents.map((event) => ({ ...event, scopes: ['translation:text'] })),
  ]

  for (const forged of semanticForgeries) {
    const inMemory = new InMemoryHashChainAuditLog()
    await assert.rejects(() => inMemory.append(forged), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
    assert.equal(inMemory.entries.length, 0)

    let createCalls = 0
    const prisma = {
      $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
        $executeRaw: async () => 1,
        record: {
          findMany: async () => [{ values: { event: forged, previousHash: null, hash: hashAuditEvent(forged, null) } }],
          create: async () => { createCalls += 1; return {} },
        },
      }),
    }
    const durable = new PrismaHashChainAuditLog(prisma as never)
    await assert.rejects(() => durable.append(requested), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
    assert.equal(createCalls, 0)
  }
})

test('durable audit refuses an orphan successful run before metadata storage', async () => {
  const succeeded: ConnectorAuditEvent = {
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: { requestedAuditHash: 'a'.repeat(64) },
  }
  const succeededHash = hashAuditEvent(succeeded, null)
  let artifactCreates = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [{ values: { event: succeeded, previousHash: null, hash: succeededHash } }],
        create: async () => { artifactCreates += 1; return {} },
      },
    }),
  }
  const artifacts = new PrismaTranslationArtifactStore(prisma as never)
  await assert.rejects(() => artifacts.proposeAndAudit({
    product,
    workspaceId,
    actor: 'maker@example.test',
    connectorId: 'translation-text-synthetic',
    proposal: runResult().artifact!,
    runAuditHash: succeededHash,
    audit: { scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString() },
  }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(artifactCreates, 0)
})

test('audit rejects a second run outcome and a checker decision without its matching creation', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedAudit = await audit.append(requested)
  const proposal = runResult().artifact!
  const succeededAudit = await audit.append({
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedAudit.hash, artifact: proposal },
  })
  const pending = { connectorId: 'translation-text-synthetic', ...proposal, runAuditHash: succeededAudit.hash }
  const reviewDigest = translationArtifactReviewDigest(pending)
  const unlinkedDecision: ConnectorAuditEvent = {
    type: 'translation.artifact.approved', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'checker@example.test',
    scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString(),
    detail: {
      artifactId: 'translation-artifact-unlinked-decision',
      kind: proposal.kind,
      contentHash: proposal.contentHash,
      mediaType: proposal.mediaType,
      source: proposal.source,
      synthetic: true,
      approvalState: 'approved',
      reviewPolicyVersion: proposal.reviewPolicyVersion,
      reviewDigest,
      reviewExpiresAt: proposal.reviewExpiresAt,
      runAuditHash: succeededAudit.hash,
      autoPublish: false,
    },
  }

  await assert.rejects(() => audit.append({
    type: 'connector.run.failed', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedAudit.hash, error: 'connector_quota_exceeded' },
  }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  await assert.rejects(() => audit.append(unlinkedDecision), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(audit.entries.length, 2)
})

test('audit rejects invented checker bindings and rolls back a second artifact bound to one successful run', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedAudit = await audit.append(requested)
  const proposal = runResult().artifact!
  const succeededAudit = await audit.append({
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedAudit.hash, artifact: proposal },
  })
  const forgedCreation: ConnectorAuditEvent = {
    type: 'translation.artifact.created', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: {
      artifactId: 'translation-artifact-invented-digest',
      kind: proposal.kind,
      contentHash: proposal.contentHash,
      mediaType: proposal.mediaType,
      source: proposal.source,
      synthetic: true,
      approvalState: 'pending-checker-approval',
      reviewPolicyVersion: proposal.reviewPolicyVersion,
      reviewDigest: `sha256:${'0'.repeat(64)}`,
      reviewExpiresAt: proposal.reviewExpiresAt,
      runAuditHash: succeededAudit.hash,
      autoPublish: false,
    },
  }

  await assert.rejects(() => audit.append(forgedCreation), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(audit.entries.length, 2)

  const artifacts = new InMemoryTranslationArtifactStore(audit)
  const input = {
    product,
    workspaceId,
    actor: 'maker@example.test',
    connectorId: 'translation-text-synthetic',
    proposal,
    runAuditHash: succeededAudit.hash,
    audit: { scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString() },
  }
  await artifacts.proposeAndAudit(input)
  await assert.rejects(() => artifacts.proposeAndAudit(input), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(artifacts.entries.length, 1)
  assert.equal(audit.entries.length, 3)
})

test('durable audit fails closed on a hash-valid persisted artifact creation with an invented checker digest', async () => {
  const proposal = runResult().artifact!
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedHash = hashAuditEvent(requested, null)
  const succeeded: ConnectorAuditEvent = {
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedHash, artifact: proposal },
  }
  const succeededHash = hashAuditEvent(succeeded, requestedHash)
  const forgedCreated: ConnectorAuditEvent = {
    type: 'translation.artifact.created', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: {
      artifactId: 'translation-artifact-persisted-invented-digest',
      kind: proposal.kind,
      contentHash: proposal.contentHash,
      mediaType: proposal.mediaType,
      source: proposal.source,
      synthetic: true,
      approvalState: 'pending-checker-approval',
      reviewPolicyVersion: proposal.reviewPolicyVersion,
      reviewDigest: `sha256:${'0'.repeat(64)}`,
      reviewExpiresAt: proposal.reviewExpiresAt,
      runAuditHash: succeededHash,
      autoPublish: false,
    },
  }
  const forgedCreatedHash = hashAuditEvent(forgedCreated, succeededHash)
  let createCalls = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [
          { values: { event: requested, previousHash: null, hash: requestedHash } },
          { values: { event: succeeded, previousHash: requestedHash, hash: succeededHash } },
          { values: { event: forgedCreated, previousHash: succeededHash, hash: forgedCreatedHash } },
        ],
        create: async () => { createCalls += 1; return {} },
      },
    }),
  }

  const audit = new PrismaHashChainAuditLog(prisma as never)
  await assert.rejects(() => audit.append(requested), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(createCalls, 0)
})

test('durable proposals bind the maker, request limits, metadata envelope, and unexpired creation instant to the successful synthetic run', async () => {
  const proposal = runResult().artifact!
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedHash = hashAuditEvent(requested, null)
  const succeeded: ConnectorAuditEvent = {
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedHash, artifact: proposal },
  }
  const succeededHash = hashAuditEvent(succeeded, requestedHash)
  let artifactCreates = 0
  let auditCreates = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async (argument: { where?: { moduleId?: string } }) => argument.where?.moduleId === 'gcl-translation-artifacts' ? boundArtifacts : [
          { values: { event: requested, previousHash: null, hash: requestedHash } },
          { values: { event: succeeded, previousHash: requestedHash, hash: succeededHash } },
        ],
        create: async (argument: { data: { moduleId: string; product: string; workspaceId: string; values: unknown; createdBy: string } }) => {
          if (argument.data.moduleId !== 'gcl-translation-artifacts') {
            auditCreates += 1
            return {}
          }
          artifactCreates += 1
          boundArtifacts.push({ values: argument.data.values, status: 'pending-checker-approval', createdBy: argument.data.createdBy })
          return {
            id: 'translation-artifact-bound',
            product: argument.data.product,
            workspaceId: argument.data.workspaceId,
            values: argument.data.values,
            status: 'pending-checker-approval',
            createdAt: now(),
            createdBy: argument.data.createdBy,
          }
        },
      },
    }),
  }
  const artifacts = new PrismaTranslationArtifactStore(prisma as never)
  const boundArtifacts: Array<{ values: unknown; status: string; createdBy: string }> = []
  const input = {
    product,
    workspaceId,
    actor: 'maker@example.test',
    connectorId: 'translation-text-synthetic',
    proposal,
    runAuditHash: succeededHash,
    audit: { scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString() },
  }

  for (const forged of [
    { ...input, actor: 'other-maker@example.test' },
    { ...input, audit: { ...input.audit, costCapCents: 24 } },
    { ...input, audit: { ...input.audit, requestedItems: 2 } },
    { ...input, audit: { ...input.audit, occurredAt: proposal.reviewExpiresAt } },
    { ...input, proposal: { ...proposal, contentHash: `sha256:${'c'.repeat(64)}` } },
  ]) {
    await assert.rejects(() => artifacts.proposeAndAudit(forged), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_RUN_AUDIT_LINK_INVALID')
  }
  assert.equal(artifactCreates, 0)
  assert.equal(auditCreates, 0)

  const accepted = await artifacts.proposeAndAudit(input)
  assert.equal(accepted.artifact.id, 'translation-artifact-bound')
  assert.equal(accepted.artifact.contentHash, proposal.contentHash)
  assert.match(accepted.auditHash, /^[a-f0-9]{64}$/)
  assert.equal(artifactCreates, 1)
  assert.equal(auditCreates, 1)
  await assert.rejects(() => artifacts.proposeAndAudit(input), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_RUN_AUDIT_ALREADY_BOUND')
  assert.equal(artifactCreates, 1)
  assert.equal(auditCreates, 1)
})

test('durable artifact reads fail closed when the row status or maker envelope disagrees with valid metadata', async () => {
  const proposal = runResult().artifact!
  const pending = {
    connectorId: 'translation-text-synthetic',
    ...proposal,
    runAuditHash: 'd'.repeat(64),
  }
  const values = { ...pending, reviewDigest: translationArtifactReviewDigest(pending) }
  const baseRecord = {
    id: 'translation-artifact-envelope',
    product,
    workspaceId,
    values,
    createdAt: now(),
  }

  for (const mismatch of [
    { status: 'approved', createdBy: 'maker@example.test' },
    { status: 'pending-checker-approval', createdBy: '   ' },
  ]) {
    const record = { findFirst: async () => ({ ...baseRecord, ...mismatch }) }
    const prisma = { $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({ record }), record }
    const artifacts = new PrismaTranslationArtifactStore(prisma as never)
    await assert.rejects(() => artifacts.get(product, workspaceId, baseRecord.id), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_STORAGE_INVALID')
  }
})

test('durable artifact reads and decisions reject a metadata-valid row whose audit lifecycle is missing', async () => {
  const proposal = runResult().artifact!
  const pending = { connectorId: 'translation-text-synthetic', ...proposal, runAuditHash: 'd'.repeat(64) }
  const values = { ...pending, reviewDigest: translationArtifactReviewDigest(pending) }
  const record = {
    id: 'translation-artifact-without-lifecycle', product, workspaceId, values,
    status: 'pending-checker-approval', createdAt: now(), createdBy: 'maker@example.test',
  }
  let updateCalls = 0
  const recordStore = {
    findFirst: async () => record,
    findMany: async () => [],
    updateMany: async () => { updateCalls += 1; return { count: 1 } },
  }
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({ $executeRaw: async () => 1, record: recordStore }),
    record: recordStore,
  }
  const artifacts = new PrismaTranslationArtifactStore(prisma as never)
  await assert.rejects(() => artifacts.get(product, workspaceId, record.id), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  await assert.rejects(() => artifacts.decideAndAudit({
    product, workspaceId, id: record.id, actor: 'checker@example.test', decision: 'approved', reviewDigest: values.reviewDigest, now: now(),
    audit: { scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString() },
  }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  assert.equal(updateCalls, 0)
})

test('durable decisions reject an audit context that is not bound to the decision instant before opening a transaction', async () => {
  let transactionCalls = 0
  const artifacts = new PrismaTranslationArtifactStore({
    $transaction: async () => { transactionCalls += 1; return null },
  } as never)
  const input = {
    product, workspaceId, id: 'translation-artifact-decision-preflight', actor: 'checker@example.test', decision: 'approved' as const,
    reviewDigest: `sha256:${'a'.repeat(64)}`, now: now(),
    audit: { scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: '2026-07-22T12:00:01.000Z' },
  }

  for (const forged of [
    input,
    { ...input, audit: { ...input.audit, scopes: ['translation:text'] } },
    { ...input, actor: ' checker@example.test ' },
  ]) {
    await assert.rejects(() => artifacts.decideAndAudit(forged), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_DECISION_AUDIT_INVALID')
  }
  assert.equal(transactionCalls, 0)
})

test('durable terminal artifacts require a distinct checker, matching decision instant, and a pre-expiry chronology', async () => {
  const proposal = runResult().artifact!
  const artifactId = 'translation-artifact-terminal-lifecycle'
  const maker = 'maker@example.test'
  const checker = 'checker@example.test'
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: maker,
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedHash = hashAuditEvent(requested, null)
  const succeeded: ConnectorAuditEvent = {
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: maker,
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedHash, artifact: proposal },
  }
  const succeededHash = hashAuditEvent(succeeded, requestedHash)

  function lifecycle(decisionActor: string, decisionOccurredAt: string, storedDecidedAt = now().toISOString()): PrismaTranslationArtifactStore {
    const pending = { connectorId: 'translation-text-synthetic', ...proposal, runAuditHash: succeededHash }
    const reviewDigest = translationArtifactReviewDigest(pending)
    const values = {
      ...pending,
      approvalState: 'approved',
      reviewDigest,
      decidedAt: storedDecidedAt,
      decidedBy: decisionActor,
    }
    const detail = (approvalState: 'pending-checker-approval' | 'approved') => ({
      artifactId,
      kind: proposal.kind,
      contentHash: proposal.contentHash,
      mediaType: proposal.mediaType,
      source: proposal.source,
      synthetic: true,
      approvalState,
      reviewPolicyVersion: proposal.reviewPolicyVersion,
      reviewDigest,
      reviewExpiresAt: proposal.reviewExpiresAt,
      runAuditHash: succeededHash,
      autoPublish: false,
    })
    const created: ConnectorAuditEvent = {
      type: 'translation.artifact.created', connectorId: 'translation-text-synthetic', product, workspaceId, actor: maker,
      scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: detail('pending-checker-approval'),
    }
    const createdHash = hashAuditEvent(created, succeededHash)
    const approved: ConnectorAuditEvent = {
      type: 'translation.artifact.approved', connectorId: 'translation-text-synthetic', product, workspaceId, actor: decisionActor,
      scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: decisionOccurredAt, detail: detail('approved'),
    }
    const approvedHash = hashAuditEvent(approved, createdHash)
    const record = {
      id: artifactId, product, workspaceId, values, status: 'approved', createdAt: now(), createdBy: maker,
    }
    const recordStore = {
      findFirst: async () => record,
      findMany: async () => [
        { values: { event: requested, previousHash: null, hash: requestedHash } },
        { values: { event: succeeded, previousHash: requestedHash, hash: succeededHash } },
        { values: { event: created, previousHash: succeededHash, hash: createdHash } },
        { values: { event: approved, previousHash: createdHash, hash: approvedHash } },
      ],
    }
    return new PrismaTranslationArtifactStore({
      $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({ $executeRaw: async () => 1, record: recordStore }),
      record: recordStore,
    } as never)
  }

  await assert.doesNotReject(() => lifecycle(checker, now().toISOString()).get(product, workspaceId, artifactId))
  await assert.rejects(() => lifecycle(maker, now().toISOString()).get(product, workspaceId, artifactId), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  await assert.rejects(() => lifecycle(checker, '2026-07-22T12:00:01.000Z').get(product, workspaceId, artifactId), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  await assert.rejects(() => lifecycle(checker, proposal.reviewExpiresAt, proposal.reviewExpiresAt).get(product, workspaceId, artifactId), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  await assert.rejects(() => lifecycle(checker, '2026-07-22T11:59:59.999Z', '2026-07-22T11:59:59.999Z').get(product, workspaceId, artifactId), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
})

test('durable audit fails closed on a hash-valid success event whose bound result carries a raw fixture field', async () => {
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedHash = hashAuditEvent(requested, null)
  const forged = {
    type: 'connector.run.succeeded', connectorId: 'translation-text-synthetic', product, workspaceId, actor: 'maker@example.test',
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requestedHash, artifact: { ...runResult().artifact, translatedText: 'must never become audit metadata' } },
  } as unknown as ConnectorAuditEvent
  let createCalls = 0
  const prisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [
          { values: { event: requested, previousHash: null, hash: requestedHash } },
          { values: { event: forged, previousHash: requestedHash, hash: hashAuditEvent(forged, requestedHash) } },
        ],
        create: async () => { createCalls += 1; return {} },
      },
    }),
  }
  const audit = new PrismaHashChainAuditLog(prisma as never)
  await assert.rejects(() => audit.append(requested), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(createCalls, 0)
})
