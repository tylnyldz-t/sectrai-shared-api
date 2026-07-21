import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app.js'
import { hashAuditEvent, InMemoryHashChainAuditLog, PrismaHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorUnavailableError } from '../src/gcl/errors.js'
import type { RunConnectorRequest } from '../src/gcl/registry.js'
import { InMemoryTranslationArtifactStore } from '../src/gcl/translation-artifacts.js'
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

async function running(): Promise<{ server: Server; base: string; audit: InMemoryHashChainAuditLog }> {
  const audit = new InMemoryHashChainAuditLog()
  const artifacts = new InMemoryTranslationArtifactStore()
  const runner = { async run(_: RunConnectorRequest): Promise<ConnectorResult> { return runResult() } }
  const app = createApp({
    prisma: {} as PrismaClient,
    now,
    gclRunner: runner,
    gclOwnerToken: ownerToken,
    gclAuditLog: audit,
    translationArtifactStore: artifacts,
  })
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const value = app.listen(0, () => resolve(value)) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE')
  return { server, audit, base: `http://127.0.0.1:${address.port}/api/products/${product}/workspaces/${workspaceId}/gcl` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('approval HTTP route rejects missing or mismatched review bindings before a decision and permits the exact checker-bound decision', async () => {
  const oldProductKey = process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST
  process.env.SHARED_API_KEY_TRANSLATION_HTTP_TEST = productKey
  const service = await running()
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
    assert.equal(service.audit.entries.length, 2)
    assert.equal(JSON.stringify(service.audit.entries).includes('must never be stored'), false)
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
