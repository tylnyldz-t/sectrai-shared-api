import assert from 'node:assert/strict'
import test from 'node:test'
import { hashAuditEvent, InMemoryHashChainAuditLog, PrismaHashChainAuditLog } from '../src/gcl/audit.js'
import { ArtifactReviewBindingError, ArtifactReviewExpiredError, ArtifactStateError, ConnectorContextError, ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError, QuotaError, ScopeError } from '../src/gcl/errors.js'
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

test('an explicit programmatic live opt-in surface is a poison pill even when false', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const connector = new SyntheticTextTranslationConnector({ ...config, liveOptInRequested: false })
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_LIVE_EXECUTION_FORBIDDEN')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('connector configuration is a canonical construction-time snapshot and malformed configuration fails before audit or quota', async () => {
  const mutableConfig: TranslationConnectorConfig = { ...config }
  const connector = new SyntheticTextTranslationConnector(mutableConfig)
  // A caller retaining the construction object cannot lower the cap, add a
  // live-mode surface, or otherwise alter the already-created connector.
  mutableConfig.syntheticEnabled = false
  mutableConfig.maxCostCapCents = 1
  ;(mutableConfig as Record<string, unknown>).liveOptInRequested = false
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  await assert.doesNotReject(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }))
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)

  let accessorReads = 0
  const accessorBacked = { ...config } as Record<string, unknown>
  Object.defineProperty(accessorBacked, 'maxCostCapCents', {
    enumerable: true,
    get(): number {
      accessorReads += 1
      throw new Error('configuration accessor must not be evaluated')
    },
  })
  const hiddenField = { ...config } as Record<string, unknown>
  Object.defineProperty(hiddenField, 'unreviewedSetting', { value: true, enumerable: false })
  const symbolField = { ...config }
  Object.defineProperty(symbolField, Symbol('unreviewed-setting'), { value: true, enumerable: true })
  const malformedConfigurations: unknown[] = [
    Object.create(config),
    accessorBacked,
    hiddenField,
    symbolField,
    { ...config, providerUrl: 'synthetic://unaccepted-configuration-surface' },
    new Proxy({ ...config }, { ownKeys: () => { throw new Error('configuration proxy must not escape') } }),
  ]

  for (const malformedConfig of malformedConfigurations) {
    const malformedAudit = new InMemoryHashChainAuditLog()
    const malformedQuota = new TestQuota()
    const malformedRunner = new GovernedConnectorRunner(
      new ConnectorRegistry([new SyntheticTextTranslationConnector(malformedConfig as TranslationConnectorConfig)]),
      malformedAudit,
      malformedQuota,
      now,
    )
    await assert.rejects(() => malformedRunner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_CONFIGURATION_INVALID')
    assert.equal(malformedAudit.entries.length, 0)
    assert.equal(malformedQuota.requests.length, 0)
  }
  assert.equal(accessorReads, 0)
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

test('in-memory audit snapshots caller events and rejects a manually corrupted prior link', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }
  await audit.append(requested)

  requested.detail = { rawFixture: 'must not mutate stored audit metadata' }
  assert.deepEqual(audit.entries[0]?.event.detail, {})

  audit.entries[0]!.event.detail = { rawFixture: 'manually corrupted test seam' }
  await assert.rejects(() => audit.append({
    type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_CHAIN_INVALID')
  assert.equal(audit.entries.length, 1)
})

test('audit boundaries reject hostile envelopes and persist one safe snapshot of a stateful proxy', async () => {
  const rawFixture = 'raw synthetic fixture must not enter audit storage'
  const requested: ConnectorAuditEvent = {
    type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  }

  let accessorReads = 0
  const accessorBacked = { ...requested } as Record<string, unknown>
  Object.defineProperty(accessorBacked, 'detail', {
    enumerable: true,
    get(): never {
      accessorReads += 1
      throw new Error(rawFixture)
    },
  })
  const rejected = new InMemoryHashChainAuditLog()
  await assert.rejects(() => rejected.append(accessorBacked as ConnectorAuditEvent), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(accessorReads, 0)
  assert.equal(rejected.entries.length, 0)
  assert.equal(JSON.stringify(rejected.entries).includes(rawFixture), false)

  const statefulDetail = (counter: { calls: number }): Record<string, unknown> => new Proxy({}, {
    ownKeys(): ArrayLike<string | symbol> {
      counter.calls += 1
      // A later view would expose raw content, but the audit boundary may read
      // this untrusted envelope only once and must persist its first snapshot.
      return counter.calls === 1 ? [] : ['sourceText']
    },
    getOwnPropertyDescriptor(_target, key): PropertyDescriptor | undefined {
      return key === 'sourceText' ? { value: rawFixture, enumerable: true, configurable: true } : undefined
    },
  })
  const inMemoryProxyCalls = { calls: 0 }
  const inMemory = new InMemoryHashChainAuditLog()
  await inMemory.append({ ...requested, detail: statefulDetail(inMemoryProxyCalls) })
  assert.equal(inMemoryProxyCalls.calls, 1)
  assert.deepEqual(inMemory.entries[0]?.event.detail, {})
  assert.equal(JSON.stringify(inMemory.entries).includes(rawFixture), false)

  let persistedValues: unknown
  const durable = new PrismaHashChainAuditLog({
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 1,
      record: {
        findMany: async () => [],
        create: async (argument: { data: { values: unknown } }) => {
          persistedValues = argument.data.values
          return {}
        },
      },
    }),
  } as never)
  const durableProxyCalls = { calls: 0 }
  await durable.append({ ...requested, detail: statefulDetail(durableProxyCalls) })
  assert.equal(durableProxyCalls.calls, 1)
  assert.deepEqual((persistedValues as { event: ConnectorAuditEvent }).event.detail, {})
  assert.equal(JSON.stringify(persistedValues).includes(rawFixture), false)
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

test('a governed run snapshots one valid clock for audit, quota, provenance, and review expiry', async () => {
  const connector = new SyntheticTextTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  let quotaOccurredAt: string | undefined
  const quota: ConnectorQuota = {
    async consume(request): Promise<void> { quotaOccurredAt = request.occurredAt.toISOString() },
  }
  let clockCalls = 0
  const unstableNow = (): Date => {
    clockCalls += 1
    return new Date(`2026-07-22T12:0${clockCalls}:00.000Z`)
  }
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, unstableNow)
  const result = await runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }) as ConnectorResult<TextTranslationData>

  assert.equal(clockCalls, 1)
  assert.equal(quotaOccurredAt, '2026-07-22T12:01:00.000Z')
  assert.deepEqual(audit.entries.map((entry) => entry.event.occurredAt), ['2026-07-22T12:01:00.000Z', '2026-07-22T12:01:00.000Z'])
  assert.equal(result.provenance.retrievedAt, '2026-07-22T12:01:00.000Z')
  assert.equal(result.artifact?.reviewExpiresAt, '2026-07-22T12:02:00.000Z')
})

test('an invalid run clock fails closed before preflight, audit, or quota reservation', async () => {
  let preflightCalls = 0
  const connector: Connector = {
    id: TEXT_TRANSLATION_CONNECTOR_ID,
    kind: 'text-translation',
    authKind: 'owner-token',
    scopes: ['translation:text'],
    preflight(): void { preflightCalls += 1 },
    async run(): Promise<ConnectorResult> { throw new Error('must not run') },
  }
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, () => new Date('invalid'))

  await assert.rejects(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'CONNECTOR_RUN_CLOCK_INVALID')
  assert.equal(preflightCalls, 0)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('a malformed tenant envelope fails closed before preflight, audit, quota, or adapter execution', async () => {
  let preflightCalls = 0
  let adapterCalls = 0
  const connector: Connector = {
    id: TEXT_TRANSLATION_CONNECTOR_ID,
    kind: 'text-translation',
    authKind: 'owner-token',
    scopes: ['translation:text'],
    preflight(): void { preflightCalls += 1 },
    async run(): Promise<ConnectorResult> { adapterCalls += 1; throw new Error('must not run') },
  }
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)

  for (const invalidContext of [
    { product: 'translation-test', workspaceId: context.workspaceId },
    { product: context.product, workspaceId: ' ws-translation' },
  ]) {
    await assert.rejects(() => runner.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context, ...invalidContext }), (error: unknown) => error instanceof ConnectorContextError && error.message === 'INVALID_CONNECTOR_TENANT_CONTEXT')
  }
  assert.equal(preflightCalls, 0)
  assert.equal(adapterCalls, 0)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('duplicate scopes and an unrepresentable review TTL fail closed before audit, quota, or adapter execution', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([new SyntheticTextTranslationConnector(config)]), audit, quota, now)

  await assert.rejects(() => runner.run({
    connectorId: TEXT_TRANSLATION_CONNECTOR_ID,
    input: textInput(),
    ...context,
    scopes: ['translation:text', 'translation:text'],
  }), (error: unknown) => error instanceof ScopeError)
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const overflow = new GovernedConnectorRunner(
    new ConnectorRegistry([new SyntheticTextTranslationConnector({ ...config, reviewTtlMs: Number.MAX_SAFE_INTEGER })]),
    audit,
    quota,
    now,
  )
  await assert.rejects(() => overflow.run({ connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: textInput(), ...context }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'TRANSLATION_REVIEW_TTL_INVALID')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('audit rejects terminal outcomes that do not echo their requested run-clock instant', async () => {
  const terminalAt = '2026-07-22T12:00:00.001Z'

  for (const [type, detail] of [
    ['connector.run.succeeded', {}],
    ['connector.run.failed', { error: 'connector_run_failed' }],
  ] as const) {
    const audit = new InMemoryHashChainAuditLog()
    const requested = await audit.append({
      type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
      scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
    })

    await assert.rejects(() => audit.append({
      type,
      connectorId: TEXT_TRANSLATION_CONNECTOR_ID,
      product: context.product,
      workspaceId: context.workspaceId,
      actor: context.actor,
      scopes: ['translation:text'],
      costCapCents: context.costCapCents,
      requestedItems: 1,
      occurredAt: terminalAt,
      detail: { requestedAuditHash: requested.hash, ...detail },
    }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
    assert.equal(audit.entries.length, 1)
  }
})

test('audit rejects a successful artifact run whose review is expired at its canonical run instant', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const requested = await audit.append({
    type: 'connector.run.requested', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(), detail: {},
  })
  const expiredProposal = (await new SyntheticTextTranslationConnector(config).run(textInput(), context)).artifact!

  await assert.rejects(() => audit.append({
    type: 'connector.run.succeeded', connectorId: TEXT_TRANSLATION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['translation:text'], costCapCents: context.costCapCents, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { requestedAuditHash: requested.hash, artifact: { ...expiredProposal, reviewExpiresAt: now().toISOString() } },
  }), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'GCL_AUDIT_EVENT_INVALID')
  assert.equal(audit.entries.length, 1)
})

test('owner, cost, item, personal-data, locale, and synthetic-descriptor failures stop translation before quota or artifact creation', async () => {
  const connector = new SyntheticSpeechTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const request = { connectorId: SPEECH_TRANSLATION_CONNECTOR_ID, input: speechInput(), ...context, scopes: ['translation:speech'] }

  await assert.rejects(() => runner.run({ ...request, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ ...request, actor: '   ' }), (error: unknown) => error instanceof OwnerGateError && error.message === 'OWNER_ACTOR_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, actor: ' maker@example.test ' }), (error: unknown) => error instanceof OwnerGateError && error.message === 'OWNER_ACTOR_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, costCapCents: 26 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ ...request, requestedItems: 2 }), (error: unknown) => error instanceof CostCapError && error.message === 'TRANSLATION_SINGLE_ARTIFACT_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceAudio: { ...speechInput().sourceAudio, sourceRef: 'https://provider.example/audio.wav' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_TRANSLATION_AUDIO_DESCRIPTOR')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceTranscript: 'TC 12345678901' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_PERSONAL_DATA_NOT_ALLOWED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), targetLocale: 'tr-TR' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_DISTINCT_LOCALES_REQUIRED')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('privacy preflight rejects separator-, format-, and Unicode-decimal-obfuscated identifiers before audit or quota', async () => {
  const connector = new SyntheticSpeechTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const request = { connectorId: SPEECH_TRANSLATION_CONNECTOR_ID, input: speechInput(), ...context, scopes: ['translation:speech'] }

  const blockedInputs = [
    { ...speechInput(), sourceTranscript: 'fixture TCKN 111\u200b222\u200b333\u200b44' },
    { ...speechInput(), sourceTranscript: 'fixture TCKN ١١١/٢٢٢,٣٣٣;٤٤' },
    { ...speechInput(), translatedText: 'fixture IBAN TR00 0000 0000 0000 0000 0000 00' },
    { ...speechInput(), translatedText: 'fixture IBAN ＴＲ۰۰ ۰۰۰۰ ۰۰۰۰ ۰۰۰۰ ۰۰۰۰ ۰۰۰۰ ۰۰' },
    { ...speechInput(), sourceTranscript: 'fixture owner\u200b@\u2060example\u00a0.\u200btest' },
    { ...speechInput(), sourceAudio: { ...speechInput().sourceAudio, sourceRef: 'synthetic://translation/audio/5550000000' } },
    { ...speechInput(), targetVoice: 'synthetic-5550000000' },
    { ...speechInput(), sourceAudio: { ...speechInput().sourceAudio, sourceRef: 'synthetic://translation/audio/٥٥٥٠٠٠٠٠٠٠' } },
    { ...speechInput(), targetVoice: 'synthetic-۵۵۵۰۰۰۰۰۰۰' },
  ]

  for (const input of blockedInputs) {
    await assert.rejects(() => runner.run({ ...request, input }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_PERSONAL_DATA_NOT_ALLOWED')
  }
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
  assert.equal(JSON.stringify(audit.entries).includes('5550000000'), false)
  assert.equal(JSON.stringify(audit.entries).includes('owner@example.test'), false)
})

test('synthetic text rejects invisible or directional formatting before audit or quota while retaining Arabic-script join controls', async () => {
  const connector = new SyntheticSpeechTranslationConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const request = { connectorId: SPEECH_TRANSLATION_CONNECTOR_ID, input: speechInput(), ...context, scopes: ['translation:speech'] }

  const blockedInputs = [
    { ...speechInput(), sourceTranscript: 'safe\u202Evisible' },
    { ...speechInput(), translatedText: 'safe\u2066visible\u2069' },
    { ...speechInput(), sourceTranscript: 'safe\u061Cvisible' },
    { ...speechInput(), sourceTranscript: 'safe\u00advisible' },
    { ...speechInput(), translatedText: 'safe\u0007visible' },
    { ...speechInput(), sourceTranscript: 'safe\ud800visible' },
  ]

  for (const input of blockedInputs) {
    await assert.rejects(() => runner.run({ ...request, input }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_UNSAFE_TEXT_FORMATTING')
  }
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)

  const textAudit = new InMemoryHashChainAuditLog()
  const textQuota = new TestQuota()
  const textRunner = new GovernedConnectorRunner(new ConnectorRegistry([new SyntheticTextTranslationConnector(config)]), textAudit, textQuota, now)
  await assert.rejects(() => textRunner.run({
    connectorId: TEXT_TRANSLATION_CONNECTOR_ID,
    input: { ...textInput(), sourceText: 'safe\u202Evisible' },
    ...context,
  }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_UNSAFE_TEXT_FORMATTING')
  assert.equal(textAudit.entries.length, 0)
  assert.equal(textQuota.requests.length, 0)

  const arabicJoinerInput = {
    ...speechInput(),
    sourceTranscript: 'سلام\u200Cدنیا',
    translatedText: 'Merhaba\u200Cdünya',
    sourceLocale: 'ar',
    targetLocale: 'tr',
  }
  const accepted = await runner.run({ ...request, input: arabicJoinerInput }) as ConnectorResult<SpeechTranslationData>
  assert.equal(accepted.data.translatedText, arabicJoinerInput.translatedText)
  assert.equal(audit.entries.length, 2)
  assert.equal(quota.requests.length, 1)
})

test('fixture envelopes and review-bound text reject noncanonical object or whitespace forms before audit or quota', async () => {
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([
    new SyntheticTextTranslationConnector(config),
    new SyntheticSpeechTranslationConnector(config),
  ]), audit, quota, now)
  let accessorReads = 0
  const accessorBacked = textInput()
  Object.defineProperty(accessorBacked, 'sourceText', {
    enumerable: true,
    get(): string {
      accessorReads += 1
      throw new Error('owner fixture must never reach an accessor')
    },
  })
  const hiddenField = textInput()
  Object.defineProperty(hiddenField, 'rawFixture', { value: 'must never become fixture data', enumerable: false })
  const inheritedAudio = Object.create(speechInput().sourceAudio) as SpeechTranslationInput['sourceAudio']

  const malformedRequests = [
    { connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: Object.create(textInput()), scopes: ['translation:text'] },
    { connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: accessorBacked, scopes: ['translation:text'] },
    { connectorId: TEXT_TRANSLATION_CONNECTOR_ID, input: hiddenField, scopes: ['translation:text'] },
    { connectorId: SPEECH_TRANSLATION_CONNECTOR_ID, input: { ...speechInput(), sourceAudio: inheritedAudio }, scopes: ['translation:speech'] },
  ]
  for (const request of malformedRequests) {
    await assert.rejects(() => runner.run({ ...context, ...request }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_NONCANONICAL_INPUT_OBJECT')
  }
  assert.equal(accessorReads, 0)

  for (const sourceText of [' leading review text', 'trailing review text ', '\ufeffedge formatting']) {
    await assert.rejects(() => runner.run({
      connectorId: TEXT_TRANSLATION_CONNECTOR_ID,
      input: { ...textInput(), sourceText },
      ...context,
    }), (error: unknown) => error instanceof ConnectorInputError && error.message === (sourceText.includes('\ufeff') ? 'TRANSLATION_UNSAFE_TEXT_FORMATTING' : 'TRANSLATION_NONCANONICAL_TEXT'))
  }
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
