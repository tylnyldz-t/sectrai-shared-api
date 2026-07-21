import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ArtifactReviewBindingError, ArtifactReviewExpiredError, ArtifactStateError, ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, QuotaError } from '../src/gcl/errors.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import { InMemoryTranslationArtifactStore, PrismaTranslationArtifactStore, translationArtifactReviewDigest } from '../src/gcl/translation-artifacts.js'
import { LIVE_DISABLED, SPEECH_TRANSLATION_CONNECTOR_ID, SYNTHETIC_TRANSLATION_ONLY, SyntheticSpeechTranslationConnector, SyntheticTextTranslationConnector, TEXT_TRANSLATION_CONNECTOR_ID, translationConnectorsFromEnvironment, type SpeechTranslationData, type SpeechTranslationInput, type TextTranslationData, type TextTranslationInput, type TranslationConnectorConfig } from '../src/gcl/translation.js'
import type { Connector, ConnectorAuditEvent, ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'

const now = () => new Date('2026-07-22T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-translation-test', workspaceId: 'ws-translation', actor: 'maker@example.test', ownerApproved: true,
  scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, now,
}
const config: TranslationConnectorConfig = {
  syntheticEnabled: true,
  liveState: LIVE_DISABLED,
  maxCostCapCents: 25,
  maxInputCharacters: 240,
  maxAudioDurationMs: 5_000,
  reviewTtlMs: 60_000,
}

function textInput(): TextTranslationInput {
  return {
    synthetic: true,
    sourceText: 'Bekleyen onaylar var.',
    translatedText: 'There are pending approvals.',
    sourceLocale: 'tr-TR',
    targetLocale: 'en-US',
  }
}

function speechInput(): SpeechTranslationInput {
  return {
    synthetic: true,
    sourceAudio: {
      synthetic: true,
      sourceRef: 'synthetic://translation/audio/fixture-1',
      contentHash: `sha256:${'a'.repeat(64)}`,
      mimeType: 'audio/wav',
      durationMs: 1_200,
    },
    sourceTranscript: 'Bekleyen onaylar var.',
    translatedText: 'There are pending approvals.',
    sourceLocale: 'tr-TR',
    targetLocale: 'en-US',
    targetVoice: 'synthetic-en-neutral',
  }
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

test('text translation remains synthetic-only and fails closed before any artifact when explicit gates are absent', async () => {
  const connector = new SyntheticTextTranslationConnector()
  assert.equal(connector.liveState, LIVE_DISABLED)
  assert.equal(SYNTHETIC_TRANSLATION_ONLY, true)
  await assert.rejects(() => connector.run(textInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_SYNTHETIC_CONNECTOR_NOT_CONFIGURED')

  const missingLiveDisabled = new SyntheticTextTranslationConnector({ ...config, liveState: undefined })
  await assert.rejects(() => missingLiveDisabled.run(textInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError)

  const missingReviewTtl = new SyntheticTextTranslationConnector({ ...config, reviewTtlMs: undefined })
  await assert.rejects(() => missingReviewTtl.run(textInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_GOVERNANCE_LIMITS_NOT_CONFIGURED')
})

test('a present live-enable environment key is a configuration poison pill, even when false', async () => {
  const environment: NodeJS.ProcessEnv = {
    GCL_TRANSLATION_SYNTHETIC_ENABLED: 'true',
    GCL_TRANSLATION_LIVE_DISABLED: 'true',
    GCL_TRANSLATION_MAX_COST_CENTS: '25',
    GCL_TRANSLATION_MAX_INPUT_CHARACTERS: '240',
    GCL_TRANSLATION_MAX_AUDIO_DURATION_MS: '5000',
    GCL_TRANSLATION_REVIEW_TTL_MS: '60000',
  }
  const configured = translationConnectorsFromEnvironment(environment)
  await assert.doesNotReject(() => configured[0]!.run(textInput(), context))

  for (const attemptedValue of ['true', 'false', '']) {
    const poisoned = translationConnectorsFromEnvironment({ ...environment, GCL_TRANSLATION_LIVE_ENABLED: attemptedValue })
    await assert.rejects(() => poisoned[0]!.run(textInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_LIVE_EXECUTION_FORBIDDEN')
  }
})

test('governed text translation returns only the owner-supplied fixture, reserves quota, and chains audit hashes without raw text', async () => {
  const connector = new SyntheticTextTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }) as ConnectorResult<TextTranslationData>

  assert.equal(result.data.type, 'text-translation')
  assert.equal(result.data.translatedText, 'There are pending approvals.')
  assert.equal(result.data.translationSource, 'owner-supplied-synthetic-fixture')
  assert.equal(result.data.review.publication, 'BLOCKED')
  assert.equal(result.artifact?.approvalState, 'pending-checker-approval')
  assert.equal(result.artifact?.autoPublish, false)
  assert.equal(result.artifact?.reviewPolicyVersion, 'gcl-translation-synthetic-v1')
  assert.equal(result.artifact?.reviewExpiresAt, '2026-07-22T12:01:00.000Z')
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.deepEqual(audit.entries[1]?.event.detail, { requestedAuditHash: audit.entries[0]?.hash, artifact: result.artifact })
  assert.deepEqual(quota.requests, [{ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, requestedItems: 1 }])
  assert.equal(JSON.stringify(audit.entries).includes('Bekleyen onaylar var.'), false)
  assert.equal(JSON.stringify(audit.entries).includes('There are pending approvals.'), false)
})

test('owner, cost, item, personal-data, locale, and synthetic-descriptor failures stop translation before quota or artifact creation', async () => {
  const connector = new SyntheticSpeechTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const request = { connectorId: SPEECH_TRANSLATION_CONNECTOR_ID, input: speechInput(), ...context, scopes: ['translation:speech'] }

  await assert.rejects(() => runner.run({ ...request, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ ...request, actor: '   ' }), (error: unknown) => error instanceof OwnerGateError && error.message === 'OWNER_ACTOR_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, costCapCents: 26 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ ...request, requestedItems: 2 }), (error: unknown) => error instanceof CostCapError && error.message === 'TRANSLATION_SINGLE_ARTIFACT_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceAudio: { ...speechInput().sourceAudio, sourceRef: 'https://provider.example/audio.wav' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_TRANSLATION_AUDIO_DESCRIPTOR')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceTranscript: 'TC 12345678901' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_PERSONAL_DATA_NOT_ALLOWED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), targetLocale: 'tr-TR' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_DISTINCT_LOCALES_REQUIRED')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('a connector failure records only a stable error code, never raw fixture content, in the audit chain', async () => {
  const failing: Connector = {
    id: TEXT_TRANSLATION_CONNECTOR_ID,
    kind: 'text-translation',
    authKind: 'owner-token',
    scopes: ['translation:text'],
    async run(): Promise<ConnectorResult> { throw new Error('There are pending approvals. This raw fixture must not be stored.') },
  }
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([failing]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), /raw fixture/)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.event.type, 'connector.run.failed')
  assert.deepEqual(audit.entries[1]?.event.detail, { requestedAuditHash: audit.entries[0]?.hash, error: 'connector_run_failed' })
  assert.equal(JSON.stringify(audit.entries).includes('There are pending approvals.'), false)
})

test('a quota rejection has a terminal audit outcome and never invokes the adapter', async () => {
  let adapterCalls = 0
  const adapter: Connector = {
    id: TEXT_TRANSLATION_CONNECTOR_ID,
    kind: 'text-translation',
    authKind: 'owner-token',
    scopes: ['translation:text'],
    async run(): Promise<ConnectorResult> { adapterCalls += 1; return { data: {}, provenance: {} as ConnectorResult['provenance'], confidence: 0 } },
  }
  const quota: ConnectorQuota = {
    async consume(): Promise<void> { throw new QuotaError('raw fixture detail must not reach the audit log') },
  }
  const audit = new InMemoryHashChainAuditLog()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([adapter]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), (error: unknown) => error instanceof QuotaError && error.message === 'raw fixture detail must not reach the audit log')
  assert.equal(adapterCalls, 0)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.event.type, 'connector.run.failed')
  assert.deepEqual(audit.entries[1]?.event.detail, { requestedAuditHash: audit.entries[0]?.hash, error: 'connector_quota_exceeded' })
  assert.equal(JSON.stringify(audit.entries).includes('raw fixture detail'), false)
})

test('speech translation returns only a synthetic audio reference and a distinct checker controls the one-way artifact decision', async () => {
  const connector = new SyntheticSpeechTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({
    connectorId: SPEECH_TRANSLATION_CONNECTOR_ID,
    input: speechInput(),
    ...context,
    scopes: ['translation:speech'],
  }) as ConnectorResult<SpeechTranslationData>

  assert.equal(result.data.type, 'speech-translation')
  assert.match(result.data.syntheticAudio.sourceRef, /^synthetic:\/\/translation\/speech\//)
  assert.equal('audioBytes' in result.data.syntheticAudio, false)
  assert.equal(result.artifact?.mediaType, 'audio/wav')

  const artifacts = new InMemoryTranslationArtifactStore()
  const proposed = await artifacts.propose({
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    connectorId: connector.id,
    proposal: result.artifact!,
    runAuditHash: result.provenance.auditHash!,
  })
  assert.equal(JSON.stringify(proposed).includes('There are pending approvals.'), false)
  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, decision: 'approved', reviewDigest: proposed.reviewDigest, now: now() }), (error: unknown) => error instanceof MakerCheckerError)
  const approved = await artifacts.decide({ ...context, id: proposed.id, actor: 'checker@example.test', decision: 'approved', reviewDigest: proposed.reviewDigest, now: now() })
  assert.equal(approved?.approvalState, 'approved')
  assert.equal(approved?.decidedBy, 'checker@example.test')
  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, actor: 'second-checker@example.test', decision: 'rejected', reviewDigest: proposed.reviewDigest, now: now() }), (error: unknown) => error instanceof ArtifactStateError)
})

test('artifact storage rejects forged connector bindings, hashes, and content-bearing fields, then fails closed on malformed stored decisions', async () => {
  const connector = new SyntheticTextTranslationConnector(config)
  const result = await connector.run(textInput(), context)
  const proposal = result.artifact!
  const artifacts = new InMemoryTranslationArtifactStore()
  const runAuditHash = 'b'.repeat(64)
  const input = { product: context.product, workspaceId: context.workspaceId, actor: context.actor, connectorId: TEXT_TRANSLATION_CONNECTOR_ID, proposal, runAuditHash }

  await assert.rejects(() => artifacts.propose({ ...input, connectorId: SPEECH_TRANSLATION_CONNECTOR_ID }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
  await assert.rejects(() => artifacts.propose({ ...input, proposal: { ...proposal, contentHash: `sha256:${'A'.repeat(64)}` } }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
  await assert.rejects(() => artifacts.propose({ ...input, proposal: { ...proposal, translatedText: 'must never persist' } as unknown as typeof proposal }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
  await assert.rejects(() => artifacts.propose({ ...input, proposal: { ...proposal, connectorId: SPEECH_TRANSLATION_CONNECTOR_ID } as unknown as typeof proposal }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
  await assert.rejects(() => artifacts.propose({ ...input, runAuditHash: 'not-a-hash' }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
  assert.equal(artifacts.entries.length, 0)

  const proposed = await artifacts.propose(input)
  artifacts.entries[0] = { ...proposed, approvalState: 'approved' }
  await assert.rejects(() => artifacts.get(context.product, context.workspaceId, proposed.id), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_ARTIFACT_STORAGE_INVALID')
})

test('checker must echo an unexpired review digest, and failed checks preserve the pending artifact', async () => {
  const connector = new SyntheticTextTranslationConnector({ ...config, reviewTtlMs: 100 })
  const result = await connector.run(textInput(), context)
  const artifacts = new InMemoryTranslationArtifactStore()
  const proposed = await artifacts.propose({
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    connectorId: connector.id,
    proposal: result.artifact!,
    runAuditHash: 'e'.repeat(64),
  })

  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, actor: 'checker@example.test', decision: 'approved', reviewDigest: `sha256:${'0'.repeat(64)}`, now: now() }), (error: unknown) => error instanceof ArtifactReviewBindingError)
  assert.equal((await artifacts.get(context.product, context.workspaceId, proposed.id))?.approvalState, 'pending-checker-approval')
  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, actor: 'checker@example.test', decision: 'approved', reviewDigest: proposed.reviewDigest, now: new Date('2026-07-22T12:00:00.100Z') }), (error: unknown) => error instanceof ArtifactReviewExpiredError)
  assert.equal((await artifacts.get(context.product, context.workspaceId, proposed.id))?.approvalState, 'pending-checker-approval')
})

test('durable artifact decisions use compare-and-set with an audit row so simultaneous checkers cannot overwrite one another', async () => {
  let status = 'pending-checker-approval'
  const proposal = {
    kind: 'translated-text',
    contentHash: `sha256:${'c'.repeat(64)}`,
    mediaType: 'text/plain',
    source: 'synthetic-text-translation',
    synthetic: true,
    approvalState: 'pending-checker-approval',
    autoPublish: false,
    reviewPolicyVersion: 'gcl-translation-synthetic-v1',
    reviewExpiresAt: '2026-07-22T12:01:00.000Z',
  }
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  const requestedHash = hashAuditEvent(requested, null)
  const succeeded: ConnectorAuditEvent = {
    type: 'connector.run.succeeded', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(), detail: { requestedAuditHash: requestedHash, artifact: proposal },
  }
  const succeededHash = hashAuditEvent(succeeded, requestedHash)
  let values: Record<string, unknown> = { connectorId: TEXT_TRANSLATION_CONNECTOR_ID, ...proposal, runAuditHash: succeededHash }
  values.reviewDigest = translationArtifactReviewDigest(values as Parameters<typeof translationArtifactReviewDigest>[0])
  const record = {
    id: 'translation-artifact-race', product: context.product, workspaceId: context.workspaceId,
    moduleId: 'gcl-translation-artifacts', createdAt: now(), createdBy: context.actor,
  }
  const created: ConnectorAuditEvent = {
    type: 'translation.artifact.created', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: {
      artifactId: record.id,
      kind: proposal.kind,
      contentHash: proposal.contentHash,
      mediaType: proposal.mediaType,
      source: proposal.source,
      synthetic: true,
      approvalState: 'pending-checker-approval',
      reviewPolicyVersion: proposal.reviewPolicyVersion,
      reviewDigest: values.reviewDigest as string,
      reviewExpiresAt: proposal.reviewExpiresAt,
      runAuditHash: succeededHash,
      autoPublish: false,
    },
  }
  const createdHash = hashAuditEvent(created, succeededHash)
  const auditRows: Array<{ values: unknown }> = [
    { values: { event: requested, previousHash: null, hash: requestedHash } },
    { values: { event: succeeded, previousHash: requestedHash, hash: succeededHash } },
    { values: { event: created, previousHash: succeededHash, hash: createdHash } },
  ]
  const recordStore = {
    findFirst: async () => ({ ...record, values: { ...values }, status }),
    findMany: async () => auditRows.map((row) => ({ ...row })),
    updateMany: async (argument: { where: { status?: string }; data: { status: string; values: Record<string, unknown> } }) => {
      await Promise.resolve()
      if (argument.where.status !== status) return { count: 0 }
      status = argument.data.status
      values = { ...argument.data.values }
      return { count: 1 }
    },
    create: async (argument: { data: { values: unknown } }) => {
      auditRows.push({ values: argument.data.values })
      return {}
    },
  }
  const durablePrisma = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: recordStore,
    }),
    record: recordStore,
  }
  const artifacts = new PrismaTranslationArtifactStore(durablePrisma as never)
  assert.equal('propose' in PrismaTranslationArtifactStore.prototype, false)
  assert.equal('decide' in PrismaTranslationArtifactStore.prototype, false)
  const audit = { scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString() }
  const decisions = await Promise.allSettled([
    artifacts.decideAndAudit({ product: context.product, workspaceId: context.workspaceId, id: record.id, actor: 'checker-one@example.test', decision: 'approved', reviewDigest: values.reviewDigest as string, now: now(), audit }),
    artifacts.decideAndAudit({ product: context.product, workspaceId: context.workspaceId, id: record.id, actor: 'checker-two@example.test', decision: 'rejected', reviewDigest: values.reviewDigest as string, now: now(), audit }),
  ])

  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1)
  assert.equal(decisions.filter((decision) => decision.status === 'rejected').length, 1)
  const rejected = decisions.find((decision) => decision.status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  if (rejected?.status === 'rejected') assert.equal(rejected.reason instanceof ArtifactStateError, true)
  const final = await artifacts.get(context.product, context.workspaceId, record.id)
  assert.ok(final)
  assert.equal(final.approvalState === 'approved' || final.approvalState === 'rejected', true)
  assert.equal(final.decidedBy === 'checker-one@example.test' || final.decidedBy === 'checker-two@example.test', true)
  assert.equal(auditRows.length, 4)
  const decisionEvent = (auditRows[3]!.values as { event: ConnectorAuditEvent }).event
  assert.equal(final.decidedAt, decisionEvent.occurredAt)
})
