import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, OwnerGateError, QueueError } from '../src/gcl/errors.js'
import { dailyQuotaFromEnvironment } from '../src/gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import { IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID, SyntheticImageTextToVideoConnector, SyntheticTextToVideoConnector, TEXT_TO_VIDEO_CONNECTOR_ID, type ImageTextToVideoInput, type SyntheticVideoConnectorConfig, type TextToVideoInput } from '../src/gcl/video.js'
import { InMemoryVideoJobQueue, VIDEO_LIVE_STATUS, type SyntheticVideoJob } from '../src/gcl/video-queue.js'
import type { ConnectorQuota, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-21T12:00:00.000Z')
const limits: SyntheticVideoConnectorConfig = {
  liveEnabled: false,
  maxCostCapCents: 50,
  maxItems: 2,
  maxDurationSeconds: 30,
  maxPromptCharacters: 2000,
}
const textInput: TextToVideoInput = { prompt: 'A synthetic product introduction', durationSeconds: 15, aspectRatio: '16:9', variants: 1 }
const imageInput: ImageTextToVideoInput = { prompt: 'A synthetic motion treatment', durationSeconds: 15, aspectRatio: '9:16', variants: 1, imageAssetRef: 'asset://concepts/scene-01' }
const baseContext: ConnectorRunContext = {
  product: 'sectrai-gcl-video-test',
  workspaceId: 'ws-video',
  actor: 'owner@example.test',
  ownerApproved: true,
  scopes: ['video:text-to-video'],
  costCapCents: 50,
  requestedItems: 1,
  now,
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; quotaGroup?: string; requestedItems: number }> = []

  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> {
    this.requests.push({ connectorId: request.connectorId, quotaGroup: request.quotaGroup, requestedItems: request.requestedItems })
  }
}

function videoRunner(queue: InMemoryVideoJobQueue, quota = new TestQuota()) {
  const text = new SyntheticTextToVideoConnector(queue, limits)
  const image = new SyntheticImageTextToVideoConnector(queue, limits)
  const audit = new InMemoryHashChainAuditLog()
  return { audit, quota, queue, runner: new GovernedConnectorRunner(new ConnectorRegistry([text, image]), audit, quota, now) }
}

test('GM4 video adapters are synthetic-only and close when a live flag is attempted', async () => {
  const queue = new InMemoryVideoJobQueue({ maxQueuedJobs: 2 })
  const connector = new SyntheticTextToVideoConnector(queue, { ...limits, liveEnabled: true })
  await assert.rejects(
    () => connector.run(textInput, baseContext),
    (error: unknown) => error instanceof ConnectorUnavailableError && error.message === VIDEO_LIVE_STATUS,
  )
  assert.equal(queue.jobs.length, 0)
})

test('GM4 text-to-video and image-plus-text-to-video queue only synthetic, owner-review jobs with shared governance', async () => {
  const setup = videoRunner(new InMemoryVideoJobQueue({ maxQueuedJobs: 3 }))
  const textResult = await setup.runner.run({ connectorId: TEXT_TO_VIDEO_CONNECTOR_ID, input: textInput, ...baseContext })
  const textJob = textResult.data as SyntheticVideoJob
  assert.equal(textJob.mode, 'SYNTHETIC')
  assert.equal(textJob.liveStatus, VIDEO_LIVE_STATUS)
  assert.equal(textJob.publication, 'OWNER_APPROVAL_REQUIRED')
  assert.deepEqual(textJob.artifact, { kind: 'video', state: 'NOT_GENERATED', autoPublish: false })
  assert.equal(textResult.confidence, 0)
  assert.equal(textResult.provenance.untrustedContent.handling, 'data-only')
  assert.equal(textResult.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')

  const imageResult = await setup.runner.run({
    connectorId: IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID,
    input: imageInput,
    ...baseContext,
    scopes: ['video:image-text-to-video'],
  })
  const imageJob = imageResult.data as SyntheticVideoJob
  assert.equal(imageJob.request.mode, 'image-text-to-video')
  if (imageJob.request.mode !== 'image-text-to-video') assert.fail('image connector must retain an image-plus-text request')
  assert.equal(imageJob.request.imageAssetRef, 'asset://concepts/scene-01')
  assert.equal(setup.queue.jobs.length, 2)
  assert.deepEqual(setup.quota.requests.map((request) => request.quotaGroup), ['video', 'video'])
  assert.equal(setup.audit.entries.length, 4)
  assert.equal(setup.audit.entries[3]?.previousHash, setup.audit.entries[2]?.hash)
  assert.equal(textResult.provenance.auditHash, setup.audit.entries[1]?.hash)
  assert.equal(imageResult.provenance.auditHash, setup.audit.entries[3]?.hash)
})

test('GM4 rejects an external image URL and a mismatched quota declaration before enqueue', async () => {
  const setup = videoRunner(new InMemoryVideoJobQueue({ maxQueuedJobs: 2 }))
  await assert.rejects(
    () => setup.runner.run({
      connectorId: IMAGE_TEXT_TO_VIDEO_CONNECTOR_ID,
      input: { ...imageInput, imageAssetRef: 'https://example.test/image.png' },
      ...baseContext,
      scopes: ['video:image-text-to-video'],
    }),
    (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_VIDEO_IMAGE_ASSET_REF',
  )
  await assert.rejects(
    () => setup.runner.run({ connectorId: TEXT_TO_VIDEO_CONNECTOR_ID, input: textInput, ...baseContext, requestedItems: 2 }),
    (error: unknown) => error instanceof Error && error.message === 'VIDEO_VARIANTS_MUST_MATCH_REQUESTED_ITEMS',
  )
  assert.equal(setup.queue.jobs.length, 0)
  assert.equal(setup.quota.requests.length, 0)
  assert.equal(setup.audit.entries.length, 0)
})

test('GM4 owner gate and bounded queue reject work before a second item can be reserved', async () => {
  const setup = videoRunner(new InMemoryVideoJobQueue({ maxQueuedJobs: 1 }))
  await assert.rejects(
    () => setup.runner.run({ connectorId: TEXT_TO_VIDEO_CONNECTOR_ID, input: textInput, ...baseContext, ownerApproved: false }),
    (error: unknown) => error instanceof OwnerGateError,
  )
  await setup.runner.run({ connectorId: TEXT_TO_VIDEO_CONNECTOR_ID, input: textInput, ...baseContext })
  await assert.rejects(
    () => setup.runner.run({ connectorId: TEXT_TO_VIDEO_CONNECTOR_ID, input: textInput, ...baseContext }),
    (error: unknown) => error instanceof QueueError && error.message === 'VIDEO_QUEUE_FULL',
  )
  assert.equal(setup.queue.jobs.length, 1)
  assert.equal(setup.quota.requests.length, 1)
  assert.equal(setup.audit.entries.length, 2)
})

test('GM4 video daily quota requires a distinct shared video configuration', () => {
  assert.deepEqual(dailyQuotaFromEnvironment({ GCL_VIDEO_DAILY_RUN_QUOTA: '3', GCL_VIDEO_DAILY_ITEM_QUOTA: '6' }, 'video'), { dailyRuns: 3, dailyItems: 6 })
  assert.throws(() => dailyQuotaFromEnvironment({}, 'video'), (error: unknown) => error instanceof ConnectorUnavailableError)
})
