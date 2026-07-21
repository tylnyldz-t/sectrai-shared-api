import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext, VoiceArtifactProposal } from './types.js'

/** This is deliberately a one-way stop: GM1 has no live provider implementation. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const
export const SYNTHETIC_VOICE_ONLY = true as const

export type VoiceConnectorConfig = {
  syntheticEnabled?: boolean
  liveState?: typeof LIVE_DISABLED
  maxCostCapCents?: number
  maxInputCharacters?: number
  maxAudioDurationMs?: number
}

export type SyntheticAudioDescriptor = {
  synthetic: true
  sourceRef: string
  contentHash: string
  mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg'
  durationMs: number
}

export type SyntheticSttInput = {
  audio: SyntheticAudioDescriptor
  transcript: string
  locale: string
}

export type SyntheticTtsInput = {
  synthetic: true
  text: string
  locale: string
  voice: string
}

export type TranscriptData = {
  type: 'transcript'
  transcript: string
  locale: string
  sourceAudio: Pick<SyntheticAudioDescriptor, 'sourceRef' | 'contentHash' | 'mimeType' | 'durationMs'>
}

export type SpeechData = {
  type: 'speech-audio'
  syntheticAudio: {
    sourceRef: string
    contentHash: string
    mimeType: 'audio/wav'
    durationMs: number
    locale: string
    voice: string
  }
}

const SHA256 = /^sha256:[a-f0-9]{64}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/
const SYNTHETIC_REF = /^synthetic:\/\/voice\/[a-zA-Z0-9/_-]{1,200}$/
const VOICE = /^synthetic-[a-zA-Z0-9-]{1,80}$/
const BLOCKED_PERSONAL_DATA = /\b\d{11}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?90|0)?5\d{9}\b/i

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError()
  return value as Record<string, unknown>
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const input = object(value)
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new ConnectorInputError('VOICE_UNEXPECTED_INPUT_FIELD')
  return input
}

function text(value: unknown, code: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new ConnectorInputError(code)
  const output = value.trim()
  if (BLOCKED_PERSONAL_DATA.test(output)) throw new ConnectorInputError('VOICE_PERSONAL_DATA_NOT_ALLOWED')
  return output
}

function locale(value: unknown): string {
  if (typeof value !== 'string' || !LOCALE.test(value)) throw new ConnectorInputError('INVALID_VOICE_LOCALE')
  return value
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ConnectorInputError(code)
  return value
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function artifact(kind: VoiceArtifactProposal['kind'], contentHash: string, mediaType: VoiceArtifactProposal['mediaType'], source: VoiceArtifactProposal['source']): VoiceArtifactProposal {
  return { kind, contentHash, mediaType, source, synthetic: true, approvalState: 'pending-owner-approval', autoPublish: false }
}

function positiveConfig(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function configured(config: VoiceConnectorConfig, ctx: ConnectorRunContext): Required<Pick<VoiceConnectorConfig, 'maxCostCapCents' | 'maxInputCharacters' | 'maxAudioDurationMs'>> {
  if (!SYNTHETIC_VOICE_ONLY || !config.syntheticEnabled || config.liveState !== LIVE_DISABLED) throw new ConnectorUnavailableError('VOICE_SYNTHETIC_CONNECTOR_NOT_CONFIGURED')
  const maxCostCapCents = config.maxCostCapCents
  const maxInputCharacters = config.maxInputCharacters
  const maxAudioDurationMs = config.maxAudioDurationMs
  if (!positiveConfig(maxCostCapCents) || !positiveConfig(maxInputCharacters) || !positiveConfig(maxAudioDurationMs)) {
    throw new ConnectorUnavailableError('VOICE_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  }
  if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
  if (ctx.requestedItems !== 1) throw new CostCapError('VOICE_SINGLE_ARTIFACT_REQUIRED')
  return { maxCostCapCents, maxInputCharacters, maxAudioDurationMs }
}

function sttInput(value: unknown, maxInputCharacters: number, maxAudioDurationMs: number): SyntheticSttInput {
  const input = exact(value, ['audio', 'transcript', 'locale'])
  const audio = exact(input.audio, ['synthetic', 'sourceRef', 'contentHash', 'mimeType', 'durationMs'])
  if (audio.synthetic !== true || typeof audio.sourceRef !== 'string' || !SYNTHETIC_REF.test(audio.sourceRef) || typeof audio.contentHash !== 'string' || !SHA256.test(audio.contentHash)) throw new ConnectorInputError('INVALID_SYNTHETIC_AUDIO_DESCRIPTOR')
  if (audio.mimeType !== 'audio/wav' && audio.mimeType !== 'audio/mpeg' && audio.mimeType !== 'audio/ogg') throw new ConnectorInputError('INVALID_SYNTHETIC_AUDIO_MIME_TYPE')
  const durationMs = positiveInteger(audio.durationMs, 'INVALID_SYNTHETIC_AUDIO_DURATION')
  if (durationMs > maxAudioDurationMs) throw new ConnectorInputError('VOICE_AUDIO_DURATION_LIMIT_EXCEEDED')
  return {
    audio: { synthetic: true, sourceRef: audio.sourceRef, contentHash: audio.contentHash, mimeType: audio.mimeType, durationMs },
    transcript: text(input.transcript, 'INVALID_SYNTHETIC_TRANSCRIPT', maxInputCharacters),
    locale: locale(input.locale),
  }
}

function ttsInput(value: unknown, maxInputCharacters: number): SyntheticTtsInput {
  const input = exact(value, ['synthetic', 'text', 'locale', 'voice'])
  if (input.synthetic !== true) throw new ConnectorInputError('VOICE_SYNTHETIC_MARKER_REQUIRED')
  if (typeof input.voice !== 'string' || !VOICE.test(input.voice)) throw new ConnectorInputError('INVALID_SYNTHETIC_VOICE')
  return { synthetic: true, text: text(input.text, 'INVALID_SYNTHETIC_SPEECH_TEXT', maxInputCharacters), locale: locale(input.locale), voice: input.voice }
}

/**
 * Contract adapter only. It has no HTTP client, credentials, provider URL, or
 * audio codec. It echoes explicitly supplied synthetic fixture text as data;
 * this is never an instruction, action, notification, or publication.
 */
export class SyntheticSpeechToTextConnector implements Connector<SyntheticSttInput, TranscriptData> {
  readonly id = 'voice-stt-synthetic'
  readonly kind = 'speech-to-text' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = ['voice:transcribe'] as const
  readonly liveState = LIVE_DISABLED

  constructor(private readonly config: VoiceConnectorConfig = {}) {}

  preflight(input: unknown, ctx: ConnectorRunContext): void {
    const limits = configured(this.config, ctx)
    sttInput(input, limits.maxInputCharacters, limits.maxAudioDurationMs)
  }

  async run(input: SyntheticSttInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TranscriptData>> {
    const limits = configured(this.config, ctx)
    const parsed = sttInput(input, limits.maxInputCharacters, limits.maxAudioDurationMs)
    const data: TranscriptData = {
      type: 'transcript',
      transcript: parsed.transcript,
      locale: parsed.locale,
      sourceAudio: { sourceRef: parsed.audio.sourceRef, contentHash: parsed.audio.contentHash, mimeType: parsed.audio.mimeType, durationMs: parsed.audio.durationMs },
    }
    const contentHash = digest(data)
    return {
      data,
      artifact: artifact('transcript', contentHash, 'text/plain', 'synthetic-stt'),
      provenance: {
        connectorId: this.id,
        source: 'synthetic-stt-fixture',
        retrievedAt: ctx.now().toISOString(),
        untrustedContent: { source: 'synthetic-stt-fixture', value: data, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
      confidence: 0,
    }
  }
}

/** Produces a deterministic synthetic reference, never sound bytes or provider egress. */
export class SyntheticTextToSpeechConnector implements Connector<SyntheticTtsInput, SpeechData> {
  readonly id = 'voice-tts-synthetic'
  readonly kind = 'text-to-speech' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = ['voice:synthesize'] as const
  readonly liveState = LIVE_DISABLED

  constructor(private readonly config: VoiceConnectorConfig = {}) {}

  preflight(input: unknown, ctx: ConnectorRunContext): void {
    const limits = configured(this.config, ctx)
    ttsInput(input, limits.maxInputCharacters)
  }

  async run(input: SyntheticTtsInput, ctx: ConnectorRunContext): Promise<ConnectorResult<SpeechData>> {
    const limits = configured(this.config, ctx)
    const parsed = ttsInput(input, limits.maxInputCharacters)
    const contentHash = digest({ text: parsed.text, locale: parsed.locale, voice: parsed.voice })
    const durationMs = Math.min(limits.maxAudioDurationMs, Math.max(250, parsed.text.split(/\s+/).length * 420))
    const data: SpeechData = {
      type: 'speech-audio',
      syntheticAudio: {
        sourceRef: `synthetic://voice/tts/${contentHash.slice('sha256:'.length)}`,
        contentHash,
        mimeType: 'audio/wav',
        durationMs,
        locale: parsed.locale,
        voice: parsed.voice,
      },
    }
    return {
      data,
      artifact: artifact('speech-audio', contentHash, 'audio/wav', 'synthetic-tts'),
      provenance: {
        connectorId: this.id,
        source: 'synthetic-tts-reference',
        retrievedAt: ctx.now().toISOString(),
        untrustedContent: { source: 'synthetic-tts-input', value: { text: parsed.text, locale: parsed.locale, voice: parsed.voice }, handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' },
      },
      confidence: 0,
    }
  }
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** No credential or live-enable environment variable exists for GM1. */
export function voiceConnectorsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  const config: VoiceConnectorConfig = {
    syntheticEnabled: environment.GCL_VOICE_SYNTHETIC_ENABLED === 'true',
    liveState: environment.GCL_VOICE_LIVE_DISABLED === 'true' ? LIVE_DISABLED : undefined,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_VOICE_MAX_COST_CENTS),
    maxInputCharacters: environmentPositiveInteger(environment.GCL_VOICE_MAX_INPUT_CHARACTERS),
    maxAudioDurationMs: environmentPositiveInteger(environment.GCL_VOICE_MAX_AUDIO_DURATION_MS),
  }
  return [new SyntheticSpeechToTextConnector(config), new SyntheticTextToSpeechConnector(config)]
}
