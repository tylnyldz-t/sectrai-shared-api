import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryHashChainAuditLog } from '../src/gcl/audit.js'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError } from '../src/gcl/errors.js'
import { ConnectorRegistry, GovernedConnectorRunner } from '../src/gcl/registry.js'
import type { ConnectorQuota, ConnectorResult, ConnectorRunContext } from '../src/gcl/types.js'
import { LIVE_DISABLED, SYNTHETIC_VOICE_ONLY, SyntheticSpeechToTextConnector, SyntheticTextToSpeechConnector, type SpeechData, type SyntheticSttInput, type TranscriptData, type VoiceConnectorConfig } from '../src/gcl/voice.js'
import { InMemoryVoiceArtifactStore } from '../src/gcl/voice-artifacts.js'

const now = () => new Date('2026-07-21T12:00:00.000Z')
const context: ConnectorRunContext = {
  product: 'sectrai-voice-test', workspaceId: 'ws-voice', actor: 'owner@example.test', ownerApproved: true,
  scopes: ['voice:transcribe'], costCapCents: 25, requestedItems: 1, now,
}
const config: VoiceConnectorConfig = {
  syntheticEnabled: true,
  liveState: LIVE_DISABLED,
  maxCostCapCents: 25,
  maxInputCharacters: 240,
  maxAudioDurationMs: 5_000,
}

function sttInput(): SyntheticSttInput {
  return {
    audio: {
      synthetic: true,
      sourceRef: 'synthetic://voice/fixture/command-1',
      contentHash: `sha256:${'a'.repeat(64)}`,
      mimeType: 'audio/wav',
      durationMs: 1_200,
    },
    transcript: 'Bugünkü bekleyen onayları göster.',
    locale: 'tr-TR',
  }
}

class TestQuota implements ConnectorQuota {
  readonly requests: Array<{ connectorId: string; requestedItems: number }> = []
  async consume(request: Parameters<ConnectorQuota['consume']>[0]): Promise<void> { this.requests.push({ connectorId: request.connectorId, requestedItems: request.requestedItems }) }
}

test('STT is synthetic-only and fails closed before any artifact when its explicit gates are absent', async () => {
  const connector = new SyntheticSpeechToTextConnector()
  assert.equal(connector.liveState, LIVE_DISABLED)
  assert.equal(SYNTHETIC_VOICE_ONLY, true)
  await assert.rejects(() => connector.run(sttInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError && error.message === 'VOICE_SYNTHETIC_CONNECTOR_NOT_CONFIGURED')

  const missingLiveDisabled = new SyntheticSpeechToTextConnector({ ...config, liveState: undefined })
  await assert.rejects(() => missingLiveDisabled.run(sttInput(), context), (error: unknown) => error instanceof ConnectorUnavailableError)
})

test('governed STT run creates data-only transcript metadata, reserves quota, and chains the run audit', async () => {
  const connector = new SyntheticSpeechToTextConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({ connectorId: connector.id, input: sttInput(), ...context }) as ConnectorResult<TranscriptData>

  assert.equal(result.data.type, 'transcript')
  assert.equal(result.data.transcript, 'Bugünkü bekleyen onayları göster.')
  assert.equal(result.artifact?.approvalState, 'pending-owner-approval')
  assert.equal(result.artifact?.autoPublish, false)
  assert.equal(result.artifact?.synthetic, true)
  assert.equal(result.provenance.untrustedContent.handling, 'data-only')
  assert.equal(result.provenance.untrustedContent.instructionPolicy, 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS')
  assert.equal(result.provenance.auditHash, audit.entries[1]?.hash)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1]?.previousHash, audit.entries[0]?.hash)
  assert.deepEqual(quota.requests, [{ connectorId: connector.id, requestedItems: 1 }])
})

test('owner approval, cost cap, item cap, and synthetic descriptor checks stop a run before quota or artifact creation', async () => {
  const connector = new SyntheticSpeechToTextConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)

  await assert.rejects(() => runner.run({ connectorId: connector.id, input: sttInput(), ...context, ownerApproved: false }), (error: unknown) => error instanceof OwnerGateError)
  await assert.rejects(() => runner.run({ connectorId: connector.id, input: sttInput(), ...context, costCapCents: 26 }), (error: unknown) => error instanceof CostCapError)
  await assert.rejects(() => runner.run({ connectorId: connector.id, input: sttInput(), ...context, requestedItems: 2 }), (error: unknown) => error instanceof CostCapError && error.message === 'VOICE_SINGLE_ARTIFACT_REQUIRED')
  await assert.rejects(() => runner.run({ connectorId: connector.id, input: { ...sttInput(), audio: { ...sttInput().audio, sourceRef: 'https://provider.example/audio.wav' } }, ...context }), (error: unknown) => error instanceof ConnectorInputError)
  await assert.rejects(() => runner.run({ connectorId: connector.id, input: { ...sttInput(), transcript: 'TC 12345678901' }, ...context }), (error: unknown) => error instanceof ConnectorInputError && error.message === 'VOICE_PERSONAL_DATA_NOT_ALLOWED')
  assert.equal(audit.entries.length, 0)
  assert.equal(quota.requests.length, 0)
})

test('TTS returns only a synthetic reference and both voice artifact approval states extend the audit chain without persisting text', async () => {
  const connector = new SyntheticTextToSpeechConnector(config)
  const audit = new InMemoryHashChainAuditLog()
  const quota = new TestQuota()
  const runner = new GovernedConnectorRunner(new ConnectorRegistry([connector]), audit, quota, now)
  const result = await runner.run({
    connectorId: connector.id,
    input: { synthetic: true, text: 'Üç onay bekliyor.', locale: 'tr-TR', voice: 'synthetic-tr-neutral' },
    ...context,
    scopes: ['voice:synthesize'],
  }) as ConnectorResult<SpeechData>
  assert.equal(result.data.type, 'speech-audio')
  assert.match(result.data.syntheticAudio.sourceRef, /^synthetic:\/\/voice\/tts\//)
  assert.equal('audioBytes' in result.data.syntheticAudio, false)
  assert.equal(result.artifact?.autoPublish, false)

  const artifacts = new InMemoryVoiceArtifactStore()
  const proposed = await artifacts.propose({
    product: context.product,
    workspaceId: context.workspaceId,
    actor: context.actor,
    connectorId: connector.id,
    proposal: result.artifact!,
    runAuditHash: result.provenance.auditHash!,
  })
  await audit.append({
    type: 'voice.artifact.created', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['voice:synthesize'], costCapCents: 25, requestedItems: 1, occurredAt: now().toISOString(),
    detail: { artifactId: proposed.id, contentHash: proposed.contentHash, approvalState: proposed.approvalState, autoPublish: false },
  })
  const approved = await artifacts.decide({ ...context, id: proposed.id, decision: 'approved', now: now() })
  assert.equal(approved?.approvalState, 'approved')
  await audit.append({
    type: 'voice.artifact.approved', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
    scopes: ['voice:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString(),
    detail: { artifactId: proposed.id, contentHash: proposed.contentHash, approvalState: 'approved', autoPublish: false },
  })
  assert.equal(audit.entries.length, 4)
  assert.equal(audit.entries[3]?.previousHash, audit.entries[2]?.hash)
  assert.equal(JSON.stringify(artifacts.entries).includes('Üç onay bekliyor.'), false)
})
