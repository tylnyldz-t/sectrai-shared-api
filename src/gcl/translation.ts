import { createHash } from 'node:crypto'
import { ConnectorInputError, ConnectorUnavailableError, CostCapError } from './errors.js'
import type { Connector, ConnectorResult, ConnectorRunContext, TranslationArtifactProposal } from './types.js'

/** Deliberate one-way stop: this module has no live provider implementation. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const
export const SYNTHETIC_TRANSLATION_ONLY = true as const
export const TEXT_TRANSLATION_CONNECTOR_ID = 'translation-text-synthetic'
export const SPEECH_TRANSLATION_CONNECTOR_ID = 'translation-speech-synthetic'

export type TranslationConnectorConfig = {
  syntheticEnabled?: boolean
  /** Presence of a live-enable surface is a poison pill, even when set false. */
  liveOptInRequested?: boolean
  liveState?: typeof LIVE_DISABLED
  maxCostCapCents?: number
  maxInputCharacters?: number
  maxAudioDurationMs?: number
  reviewTtlMs?: number
}

export type SyntheticAudioDescriptor = {
  synthetic: true
  sourceRef: string
  contentHash: string
  mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg'
  durationMs: number
}

export type TextTranslationInput = {
  synthetic: true
  sourceText: string
  translatedText: string
  sourceLocale: string
  targetLocale: string
}

export type SpeechTranslationInput = {
  synthetic: true
  sourceAudio: SyntheticAudioDescriptor
  sourceTranscript: string
  translatedText: string
  sourceLocale: string
  targetLocale: string
  targetVoice: string
}

type TranslationReview = {
  state: 'CHECKER_REVIEW_REQUIRED'
  publication: 'BLOCKED'
  persistence: 'METADATA_ONLY'
}

export type TextTranslationData = {
  type: 'text-translation'
  mode: 'SYNTHETIC'
  liveStatus: typeof LIVE_DISABLED
  sourceLocale: string
  targetLocale: string
  translatedText: string
  translationSource: 'owner-supplied-synthetic-fixture'
  review: TranslationReview
}

export type SpeechTranslationData = {
  type: 'speech-translation'
  mode: 'SYNTHETIC'
  liveStatus: typeof LIVE_DISABLED
  sourceLocale: string
  targetLocale: string
  translatedText: string
  translationSource: 'owner-supplied-synthetic-fixture'
  syntheticAudio: {
    sourceRef: string
    contentHash: string
    mimeType: 'audio/wav'
    durationMs: number
    locale: string
    voice: string
  }
  review: TranslationReview
}

const SHA256 = /^sha256:[a-f0-9]{64}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/
const SYNTHETIC_AUDIO_REF = /^synthetic:\/\/translation\/audio\/[a-zA-Z0-9/_-]{1,200}$/
const SYNTHETIC_VOICE = /^synthetic-[a-zA-Z0-9-]{1,80}$/
const EMAIL_SHAPED_PERSONAL_DATA = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const COMPACT_TCKN_SHAPED_DATA = /(?:^|[^0-9])\d{11}(?!\d)/
const COMPACT_TURKISH_MOBILE_SHAPED_DATA = /(?:^|[^0-9])(?:\+?90|0)?5\d{9}(?!\d)/
const COMPACT_TURKISH_IBAN_SHAPED_DATA = /TR\d{24}(?!\d)/i
const DECIMAL_DIGIT = /^\p{Decimal_Number}$/u
const FORMAT_OR_SPACE = /[\p{Z}\p{Cf}]/gu
const NUMERIC_IDENTIFIER_SEPARATORS = /[\p{Z}\p{Cf}\p{P}]/gu
// Directional and non-rendering format controls can make a fixture appear to
// say something other than the value returned to an owner or checker. Keep
// ZWNJ/ZWJ available for ordinary Arabic-script text; all other Cf code points
// are outside this deliberately small synthetic-fixture contract.
const UNSAFE_SYNTHETIC_TEXT_FORMAT = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
const UNSAFE_SYNTHETIC_TEXT_CODE_UNIT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorInputError()
  return value as Record<string, unknown>
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const input = object(value)
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new ConnectorInputError('TRANSLATION_UNEXPECTED_INPUT_FIELD')
  return input
}

/**
 * Fixtures are data, but this connector is not a personal-data transport.
 * Normalize only for detection so a zero-width character, conventional
 * display separator, or Unicode decimal-digit form cannot smuggle a phone,
 * TCKN-shaped value, Turkish IBAN-shaped value, or email into a synthetic
 * text or identifier. The original value is never rewritten or persisted by
 * this check.
 */
function canonicalDecimalDigits(value: string): string {
  return Array.from(value, (character) => {
    if (!DECIMAL_DIGIT.test(character)) return character
    const point = character.codePointAt(0)!
    let zeroPoint = point
    // Decimal-number code points are consecutive inside one digit set. NFKC
    // has already reduced compatibility-digit sets (for example full-width
    // digits) to ASCII before this local calculation.
    while (zeroPoint > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(zeroPoint - 1))) zeroPoint -= 1
    const digit = point - zeroPoint
    return digit >= 0 && digit <= 9 ? String(digit) : character
  }).join('')
}

function containsBlockedPersonalData(value: string): boolean {
  const normalized = canonicalDecimalDigits(value.normalize('NFKC'))
  const compactEmail = normalized.replace(FORMAT_OR_SPACE, '')
  const compactNumericIdentifier = normalized.replace(NUMERIC_IDENTIFIER_SEPARATORS, '')
  return EMAIL_SHAPED_PERSONAL_DATA.test(compactEmail)
    || COMPACT_TCKN_SHAPED_DATA.test(compactNumericIdentifier)
    || COMPACT_TURKISH_MOBILE_SHAPED_DATA.test(compactNumericIdentifier)
    || COMPACT_TURKISH_IBAN_SHAPED_DATA.test(compactNumericIdentifier)
}

function rejectPersonalData(value: string): void {
  if (containsBlockedPersonalData(value)) throw new ConnectorInputError('TRANSLATION_PERSONAL_DATA_NOT_ALLOWED')
}

function boundedText(value: unknown, code: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new ConnectorInputError(code)
  const output = value.trim()
  rejectPersonalData(output)
  if (UNSAFE_SYNTHETIC_TEXT_FORMAT.test(output) || UNSAFE_SYNTHETIC_TEXT_CODE_UNIT.test(output)) {
    throw new ConnectorInputError('TRANSLATION_UNSAFE_TEXT_FORMATTING')
  }
  return output
}

function locale(value: unknown, code: string): string {
  if (typeof value !== 'string' || !LOCALE.test(value)) throw new ConnectorInputError(code)
  return value
}

function locales(sourceLocale: unknown, targetLocale: unknown): { sourceLocale: string; targetLocale: string } {
  const source = locale(sourceLocale, 'INVALID_TRANSLATION_SOURCE_LOCALE')
  const target = locale(targetLocale, 'INVALID_TRANSLATION_TARGET_LOCALE')
  if (source.split('-')[0] === target.split('-')[0]) throw new ConnectorInputError('TRANSLATION_DISTINCT_LOCALES_REQUIRED')
  return { sourceLocale: source, targetLocale: target }
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ConnectorInputError(code)
  return value
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function artifact(kind: TranslationArtifactProposal['kind'], contentHash: string, mediaType: TranslationArtifactProposal['mediaType'], source: TranslationArtifactProposal['source'], reviewExpiresAt: Date): TranslationArtifactProposal {
  return {
    kind,
    contentHash,
    mediaType,
    source,
    synthetic: true,
    approvalState: 'pending-checker-approval',
    autoPublish: false,
    reviewPolicyVersion: 'gcl-translation-synthetic-v1',
    reviewExpiresAt: reviewExpiresAt.toISOString(),
  }
}

function positiveConfig(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

function connectorClock(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new ConnectorUnavailableError('TRANSLATION_CONNECTOR_CLOCK_INVALID')
  return new Date(value.valueOf())
}

/** The configured TTL must produce a representable canonical review instant. */
function reviewExpiry(now: Date, reviewTtlMs: number): Date {
  const expiresAt = new Date(now.valueOf() + reviewTtlMs)
  if (!Number.isFinite(expiresAt.valueOf())) throw new ConnectorUnavailableError('TRANSLATION_REVIEW_TTL_INVALID')
  return expiresAt
}

function configured(config: TranslationConnectorConfig, ctx: ConnectorRunContext): Required<Pick<TranslationConnectorConfig, 'maxCostCapCents' | 'maxInputCharacters' | 'maxAudioDurationMs' | 'reviewTtlMs'>> & { now: Date; reviewExpiresAt: Date } {
  // Treat the configuration *surface* as forbidden, not merely a true value.
  // A programmatic adapter construction must not turn an explicit false into a
  // future-compatible live-mode switch.
  if (Object.hasOwn(config, 'liveOptInRequested')) throw new ConnectorUnavailableError('TRANSLATION_LIVE_EXECUTION_FORBIDDEN')
  if (!SYNTHETIC_TRANSLATION_ONLY || !config.syntheticEnabled || config.liveState !== LIVE_DISABLED) throw new ConnectorUnavailableError('TRANSLATION_SYNTHETIC_CONNECTOR_NOT_CONFIGURED')
  const maxCostCapCents = config.maxCostCapCents
  const maxInputCharacters = config.maxInputCharacters
  const maxAudioDurationMs = config.maxAudioDurationMs
  const reviewTtlMs = config.reviewTtlMs
  if (!positiveConfig(maxCostCapCents) || !positiveConfig(maxInputCharacters) || !positiveConfig(maxAudioDurationMs) || !positiveConfig(reviewTtlMs)) {
    throw new ConnectorUnavailableError('TRANSLATION_GOVERNANCE_LIMITS_NOT_CONFIGURED')
  }
  if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
  if (ctx.requestedItems !== 1) throw new CostCapError('TRANSLATION_SINGLE_ARTIFACT_REQUIRED')
  const now = connectorClock(ctx.now())
  return { maxCostCapCents, maxInputCharacters, maxAudioDurationMs, reviewTtlMs, now, reviewExpiresAt: reviewExpiry(now, reviewTtlMs) }
}

function audioDescriptor(value: unknown, maxAudioDurationMs: number): SyntheticAudioDescriptor {
  const audio = exact(value, ['synthetic', 'sourceRef', 'contentHash', 'mimeType', 'durationMs'])
  if (typeof audio.sourceRef === 'string') rejectPersonalData(audio.sourceRef)
  if (audio.synthetic !== true || typeof audio.sourceRef !== 'string' || !SYNTHETIC_AUDIO_REF.test(audio.sourceRef) || typeof audio.contentHash !== 'string' || !SHA256.test(audio.contentHash)) {
    throw new ConnectorInputError('INVALID_SYNTHETIC_TRANSLATION_AUDIO_DESCRIPTOR')
  }
  if (audio.mimeType !== 'audio/wav' && audio.mimeType !== 'audio/mpeg' && audio.mimeType !== 'audio/ogg') throw new ConnectorInputError('INVALID_SYNTHETIC_TRANSLATION_AUDIO_MIME_TYPE')
  const durationMs = positiveInteger(audio.durationMs, 'INVALID_SYNTHETIC_TRANSLATION_AUDIO_DURATION')
  if (durationMs > maxAudioDurationMs) throw new ConnectorInputError('TRANSLATION_AUDIO_DURATION_LIMIT_EXCEEDED')
  return { synthetic: true, sourceRef: audio.sourceRef, contentHash: audio.contentHash, mimeType: audio.mimeType, durationMs }
}

function textInput(value: unknown, maxInputCharacters: number): TextTranslationInput {
  const input = exact(value, ['synthetic', 'sourceText', 'translatedText', 'sourceLocale', 'targetLocale'])
  if (input.synthetic !== true) throw new ConnectorInputError('TRANSLATION_SYNTHETIC_MARKER_REQUIRED')
  return {
    synthetic: true,
    sourceText: boundedText(input.sourceText, 'INVALID_SYNTHETIC_SOURCE_TEXT', maxInputCharacters),
    translatedText: boundedText(input.translatedText, 'INVALID_SYNTHETIC_TRANSLATED_TEXT', maxInputCharacters),
    ...locales(input.sourceLocale, input.targetLocale),
  }
}

function speechInput(value: unknown, maxInputCharacters: number, maxAudioDurationMs: number): SpeechTranslationInput {
  const input = exact(value, ['synthetic', 'sourceAudio', 'sourceTranscript', 'translatedText', 'sourceLocale', 'targetLocale', 'targetVoice'])
  if (input.synthetic !== true) throw new ConnectorInputError('TRANSLATION_SYNTHETIC_MARKER_REQUIRED')
  if (typeof input.targetVoice !== 'string') throw new ConnectorInputError('INVALID_SYNTHETIC_TRANSLATION_VOICE')
  rejectPersonalData(input.targetVoice)
  if (!SYNTHETIC_VOICE.test(input.targetVoice)) throw new ConnectorInputError('INVALID_SYNTHETIC_TRANSLATION_VOICE')
  return {
    synthetic: true,
    sourceAudio: audioDescriptor(input.sourceAudio, maxAudioDurationMs),
    sourceTranscript: boundedText(input.sourceTranscript, 'INVALID_SYNTHETIC_SOURCE_TRANSCRIPT', maxInputCharacters),
    translatedText: boundedText(input.translatedText, 'INVALID_SYNTHETIC_TRANSLATED_TEXT', maxInputCharacters),
    ...locales(input.sourceLocale, input.targetLocale),
    targetVoice: input.targetVoice,
  }
}

function translationReview(): TranslationReview {
  return { state: 'CHECKER_REVIEW_REQUIRED', publication: 'BLOCKED', persistence: 'METADATA_ONLY' }
}

/**
 * Contract adapter only. It accepts an owner-supplied synthetic translation
 * fixture and returns it as data. It has no language model, provider client,
 * credential, provider URL, or network capability.
 */
export class SyntheticTextTranslationConnector implements Connector<TextTranslationInput, TextTranslationData> {
  readonly id = TEXT_TRANSLATION_CONNECTOR_ID
  readonly kind = 'text-translation' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = ['translation:text'] as const
  readonly liveState = LIVE_DISABLED

  constructor(private readonly config: TranslationConnectorConfig = {}) {}

  preflight(input: TextTranslationInput, ctx: ConnectorRunContext): void {
    const limits = configured(this.config, ctx)
    textInput(input, limits.maxInputCharacters)
  }

  async run(input: TextTranslationInput, ctx: ConnectorRunContext): Promise<ConnectorResult<TextTranslationData>> {
    const limits = configured(this.config, ctx)
    const parsed = textInput(input, limits.maxInputCharacters)
    const data: TextTranslationData = {
      type: 'text-translation',
      mode: 'SYNTHETIC',
      liveStatus: LIVE_DISABLED,
      sourceLocale: parsed.sourceLocale,
      targetLocale: parsed.targetLocale,
      translatedText: parsed.translatedText,
      translationSource: 'owner-supplied-synthetic-fixture',
      review: translationReview(),
    }
    const contentHash = digest({ sourceText: parsed.sourceText, ...data })
    return {
      data,
      artifact: artifact('translated-text', contentHash, 'text/plain', 'synthetic-text-translation', limits.reviewExpiresAt),
      provenance: {
        connectorId: this.id,
        source: 'synthetic-text-translation-fixture',
        retrievedAt: limits.now.toISOString(),
        untrustedContent: {
          source: 'owner-supplied-synthetic-text-translation',
          value: { contentHash, sourceLocale: parsed.sourceLocale, targetLocale: parsed.targetLocale },
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

/** Produces a deterministic synthetic audio reference, never audio bytes or provider egress. */
export class SyntheticSpeechTranslationConnector implements Connector<SpeechTranslationInput, SpeechTranslationData> {
  readonly id = SPEECH_TRANSLATION_CONNECTOR_ID
  readonly kind = 'speech-translation' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = ['translation:speech'] as const
  readonly liveState = LIVE_DISABLED

  constructor(private readonly config: TranslationConnectorConfig = {}) {}

  preflight(input: SpeechTranslationInput, ctx: ConnectorRunContext): void {
    const limits = configured(this.config, ctx)
    speechInput(input, limits.maxInputCharacters, limits.maxAudioDurationMs)
  }

  async run(input: SpeechTranslationInput, ctx: ConnectorRunContext): Promise<ConnectorResult<SpeechTranslationData>> {
    const limits = configured(this.config, ctx)
    const parsed = speechInput(input, limits.maxInputCharacters, limits.maxAudioDurationMs)
    const audioHash = digest({ translatedText: parsed.translatedText, targetLocale: parsed.targetLocale, targetVoice: parsed.targetVoice })
    const durationMs = Math.min(limits.maxAudioDurationMs, Math.max(250, parsed.translatedText.split(/\s+/).length * 420))
    const data: SpeechTranslationData = {
      type: 'speech-translation',
      mode: 'SYNTHETIC',
      liveStatus: LIVE_DISABLED,
      sourceLocale: parsed.sourceLocale,
      targetLocale: parsed.targetLocale,
      translatedText: parsed.translatedText,
      translationSource: 'owner-supplied-synthetic-fixture',
      syntheticAudio: {
        sourceRef: `synthetic://translation/speech/${audioHash.slice('sha256:'.length)}`,
        contentHash: audioHash,
        mimeType: 'audio/wav',
        durationMs,
        locale: parsed.targetLocale,
        voice: parsed.targetVoice,
      },
      review: translationReview(),
    }
    const contentHash = digest({ sourceAudioHash: parsed.sourceAudio.contentHash, sourceTranscript: parsed.sourceTranscript, ...data })
    return {
      data,
      artifact: artifact('translated-speech', contentHash, 'audio/wav', 'synthetic-speech-translation', limits.reviewExpiresAt),
      provenance: {
        connectorId: this.id,
        source: 'synthetic-speech-translation-fixture',
        retrievedAt: limits.now.toISOString(),
        untrustedContent: {
          source: 'owner-supplied-synthetic-speech-translation',
          value: { contentHash, sourceAudioHash: parsed.sourceAudio.contentHash, sourceLocale: parsed.sourceLocale, targetLocale: parsed.targetLocale },
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
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

/** No credential, provider URL, or live-enable environment variable exists for this module. */
export function translationConnectorsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): readonly Connector[] {
  // This module deliberately has no live opt-in. If deployment configuration
  // introduces that surface, including an explicit "false", disable the
  // connector instead of treating it as a harmless future compatibility flag.
  const liveOptInWasProvided = Object.hasOwn(environment, 'GCL_TRANSLATION_LIVE_ENABLED')
  const config: TranslationConnectorConfig = {
    syntheticEnabled: environment.GCL_TRANSLATION_SYNTHETIC_ENABLED === 'true' && !liveOptInWasProvided,
    ...(liveOptInWasProvided ? { liveOptInRequested: true } : {}),
    liveState: environment.GCL_TRANSLATION_LIVE_DISABLED === 'true' ? LIVE_DISABLED : undefined,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_TRANSLATION_MAX_COST_CENTS),
    maxInputCharacters: environmentPositiveInteger(environment.GCL_TRANSLATION_MAX_INPUT_CHARACTERS),
    maxAudioDurationMs: environmentPositiveInteger(environment.GCL_TRANSLATION_MAX_AUDIO_DURATION_MS),
    reviewTtlMs: environmentPositiveInteger(environment.GCL_TRANSLATION_REVIEW_TTL_MS),
  }
  return [new SyntheticTextTranslationConnector(config), new SyntheticSpeechTranslationConnector(config)]
}
