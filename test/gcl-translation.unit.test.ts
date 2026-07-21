import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ArtifactStateError, ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError } from '../src/gcl/errors.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import { InMemoryTranslationArtifactStore } from '../src/gcl/translation-artifacts.js'
import { LIVE_DISABLED, SPEECH_TRANSLATION_CONNECTOR_ID, SYNTHETIC_TRANSLATION_ONLY, SyntheticSpeechTranslationConnector, SyntheticTextTranslationConnector, TEXT_TRANSLATION_CONNECTOR_ID, type SpeechTranslationData, type SpeechTranslationInput, type TextTranslationData, type TextTranslationInput, type TranslationConnectorConfig } from '../src/gcl/translation.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'

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
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
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
  await assert.rejects(() => runner.run({ ...request, costCapCents: 26 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ ...request, requestedItems: 2 }), (error: unknown) => error instanceof CostCapError && error.message === 'TRANSLATION_SINGLE_ARTIFACT_REQUIRED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceAudio: { ...speechInput().sourceAudio, sourceRef: 'https://provider.example/audio.wav' } } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'INVALID_SYNTHETIC_TRANSLATION_AUDIO_DESCRIPTOR')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), sourceTranscript: 'TC 12345678901' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_PERSONAL_DATA_NOT_ALLOWED')
  await assert.rejects(() => runner.run({ ...request, input: { ...speechInput(), targetLocale: 'tr-TR' } }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'TRANSLATION_DISTINCT_LOCALES_REQUIRED')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
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
  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, decision: 'approved', now: now() }), (error: unknown) => error instanceof MakerCheckerError)
  const approved = await artifacts.decide({ ...context, id: proposed.id, actor: 'checker@example.test', decision: 'approved', now: now() })
  assert.equal(approved?.approvalState, 'approved')
  assert.equal(approved?.decidedBy, 'checker@example.test')
  await assert.rejects(() => artifacts.decide({ ...context, id: proposed.id, actor: 'second-checker@example.test', decision: 'rejected', now: now() }), (error: unknown) => error instanceof ArtifactStateError)
})
