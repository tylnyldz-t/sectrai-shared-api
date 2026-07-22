import { createHash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { ConnectorInputError, ConnectorUnavailableError, ConsentError, CostCapError, MakerCheckerError, OwnerGateError } from './errors.js'
import type { AuditLog, Connector, ConnectorResult, ConnectorRunContext } from './types.js'

export const VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID = 'vision-document-field-extraction'
/** There is deliberately no live-provider state or provider implementation in GM2. */
export const LIVE_DISABLED = 'LIVE_DISABLED' as const
export const VISION_DOCUMENT_FIELD_EXTRACTION_SCOPE = 'vision:document-field-extraction'

const MAX_SYNTHETIC_EVIDENCE_BYTES = 10 * 1024 * 1024
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const EVIDENCE_ID_PATTERN = /^synthetic-evidence-[a-zA-Z0-9_-]{1,100}$/
const POLICY_VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PROPOSAL_ID_PATTERN = /^synthetic-document-[a-f0-9]{24}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const DOCUMENT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION = 'synthetic-document-review-packet-v15' as const
const SYNTHETIC_DOCUMENT_DATA_BOUNDARY = {
  evidenceSource: 'synthetic-fixture',
  inputShape: 'plain-own-data-only',
  rawDocumentContentAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY = {
  actorIdentity: 'ascii-case-insensitive-trimmed',
  independentReviewerRequired: true,
} as const
const SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY = {
  collectionShape: 'array-prototype-dense-own-data-only',
  sparseOrInheritedElementsAccepted: false,
  accessorElementsAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_STRING_BOUNDARY = {
  valueEncoding: 'well-formed-unicode-utf8',
  controlCharactersAccepted: false,
  unpairedSurrogateCodeUnitsAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_TIME_BOUNDARY = {
  clockValue: 'utc-epoch-milliseconds',
  clockObject: 'exact-date-prototype-no-own-properties',
  issuedAtSource: 'validated-run-context-clock',
} as const
const SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY = {
  fieldRecordShape: 'plain-own-enumerable-data-only',
  fieldDescriptorsValidatedBeforeValues: true,
  accessorFieldPropertiesAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_PROXY_BOUNDARY = {
  proxyDetection: 'node-util-types-isProxy',
  proxyObjectsAccepted: false,
  proxyArraysAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY = {
  arithmetic: 'checked-utc-epoch-milliseconds',
  overflowAccepted: false,
  invalidDateAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY = {
  encoding: 'canonical-json-utf8',
  objectKeyOrder: 'utf16-code-unit-ascending',
  toJsonHooksAccepted: false,
  inheritedSerializationAccepted: false,
} as const
/** A synthetic packet must never remain reviewable indefinitely. */
const MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS = 24 * 60 * 60
/** ECMAScript Time Values are bounded more tightly than safe integers. */
const MAX_UTC_EPOCH_MILLISECONDS = 8_640_000_000_000_000

const fieldNames = [
  'containerId', 'referenceNumber', 'importOrderNumber', 'exportOrderNumber', 'loadType', 'loadAmount', 'loadWeight',
  'startDate', 'appointmentDate', 'note', 'senderName', 'senderAddress', 'senderCountry', 'recipientName',
  'recipientAddress', 'recipientCountry', 'loadingAddress', 'loadingCountry', 'deliveryAddress', 'deliveryCountry',
  'grossWeightKg', 'numberOfPackages', 'identityNumber',
] as const

export type DocumentFieldName = typeof fieldNames[number]
export type DocumentFieldFixture = { field: DocumentFieldName; value: string }
export type SyntheticDocumentEvidence = {
  source: 'synthetic-fixture'
  evidenceId: string
  sha256: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  byteLength: number
  capturedAt: string
}
export type DocumentConsentAssertion = {
  purpose: 'document-field-extraction'
  status: 'granted'
  policyVersion: string
  expiresAt: string
}
export type SyntheticDocumentScanInput = {
  evidence: SyntheticDocumentEvidence
  consent: DocumentConsentAssertion
  /** Fixture values stand in for OCR output; this adapter never reads image bytes. */
  syntheticFields: readonly DocumentFieldFixture[]
}

export type SyntheticDocumentField = {
  field: DocumentFieldName
  status: 'synthetic-proposal'
  privacy: 'standard' | 'kvkk-masked'
  valueDigest: string
  value?: string
  maskedValue?: string
  confidence: 0
}

export type OwnerReview = {
  status: 'pending' | 'approved' | 'rejected'
  required: true
  visibility: 'owner-only'
  automaticApply: false
  automaticPublication: false
  reviewer?: string
  occurredAt?: string
}

/**
 * A deterministic, non-secret checksum for the synthetic review surface.
 * It detects accidental or in-process mutation; it is not a signature,
 * credential, capability, or authorization to apply/send a document.
 */
export type SyntheticDocumentReviewPacket = {
  version: typeof SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION
  integrityDigest: string
  scopeBinding: {
    productDigest: string
    workspaceDigest: string
  }
  /** Contains no consent token or policy text; the policy version is hashed. */
  consentBinding: {
    purpose: 'document-field-extraction'
    policyVersionDigest: string
    expiresAt: string
  }
  /** The issued synthetic limits make the review deadlines re-derivable. */
  governanceBinding: {
    maxReviewAgeSeconds: number
    maxEvidenceAgeSeconds: number
  }
  /** Records are metadata-only plain own-data, never inherited/accessor content. */
  dataBoundaryBinding: {
    evidenceSource: typeof SYNTHETIC_DOCUMENT_DATA_BOUNDARY.evidenceSource
    inputShape: typeof SYNTHETIC_DOCUMENT_DATA_BOUNDARY.inputShape
    rawDocumentContentAccepted: typeof SYNTHETIC_DOCUMENT_DATA_BOUNDARY.rawDocumentContentAccepted
  }
  /** Independent review compares validated actor identities, not display casing. */
  makerCheckerBinding: {
    actorIdentity: typeof SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY.actorIdentity
    independentReviewerRequired: typeof SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY.independentReviewerRequired
  }
  /** Fixture and proposal field arrays contain only dense own data elements. */
  collectionBoundaryBinding: {
    collectionShape: typeof SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY.collectionShape
    sparseOrInheritedElementsAccepted: typeof SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY.sparseOrInheritedElementsAccepted
    accessorElementsAccepted: typeof SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY.accessorElementsAccepted
  }
  /** Text must have one unambiguous UTF-8 representation before it is hashed. */
  stringBoundaryBinding: {
    valueEncoding: typeof SYNTHETIC_DOCUMENT_STRING_BOUNDARY.valueEncoding
    controlCharactersAccepted: typeof SYNTHETIC_DOCUMENT_STRING_BOUNDARY.controlCharactersAccepted
    unpairedSurrogateCodeUnitsAccepted: typeof SYNTHETIC_DOCUMENT_STRING_BOUNDARY.unpairedSurrogateCodeUnitsAccepted
  }
  /** The caller clock is copied from a plain built-in Date before packet timing. */
  timeBoundaryBinding: {
    clockValue: typeof SYNTHETIC_DOCUMENT_TIME_BOUNDARY.clockValue
    clockObject: typeof SYNTHETIC_DOCUMENT_TIME_BOUNDARY.clockObject
    issuedAtSource: typeof SYNTHETIC_DOCUMENT_TIME_BOUNDARY.issuedAtSource
  }
  /** Every proposal field record is descriptor-validated before its values are read. */
  fieldRecordBoundaryBinding: {
    fieldRecordShape: typeof SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY.fieldRecordShape
    fieldDescriptorsValidatedBeforeValues: typeof SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY.fieldDescriptorsValidatedBeforeValues
    accessorFieldPropertiesAccepted: typeof SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY.accessorFieldPropertiesAccepted
  }
  /** Node-detected Proxy wrappers are rejected before reflection or value reads. */
  proxyBoundaryBinding: {
    proxyDetection: typeof SYNTHETIC_DOCUMENT_PROXY_BOUNDARY.proxyDetection
    proxyObjectsAccepted: typeof SYNTHETIC_DOCUMENT_PROXY_BOUNDARY.proxyObjectsAccepted
    proxyArraysAccepted: typeof SYNTHETIC_DOCUMENT_PROXY_BOUNDARY.proxyArraysAccepted
  }
  /** Deadline arithmetic is checked before an invalid Date can be serialized. */
  dateArithmeticBoundaryBinding: {
    arithmetic: typeof SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY.arithmetic
    overflowAccepted: typeof SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY.overflowAccepted
    invalidDateAccepted: typeof SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY.invalidDateAccepted
  }
  /** Integrity bytes are canonical and never invoke own or inherited toJSON hooks. */
  integrityEncodingBoundaryBinding: {
    encoding: typeof SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.encoding
    objectKeyOrder: typeof SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.objectKeyOrder
    toJsonHooksAccepted: typeof SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.toJsonHooksAccepted
    inheritedSerializationAccepted: typeof SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.inheritedSerializationAccepted
  }
  /** Metadata-only freshness limit for the synthetic evidence reference. */
  evidenceBinding: {
    capturedAt: string
    expiresAt: string
  }
  /** Metadata-only, integrity-bound deadline; it is not a capability or token. */
  reviewWindow: {
    issuedAt: string
    reviewBy: string
  }
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  rawDocumentContentIncluded: false
  automaticApply: false
  automaticPublication: false
}

export type SyntheticDocumentProposal = {
  proposalId: string
  syntheticUri: string
  preparedBy: string
  mode: typeof LIVE_DISABLED
  extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR'
  evidence: Omit<SyntheticDocumentEvidence, 'source'> & { rawContentStored: false }
  fields: SyntheticDocumentField[]
  fieldsDigest: string
  ownerReview: OwnerReview
  reviewPacket: SyntheticDocumentReviewPacket
  mesaEvidenceHandoff: {
    state: 'BLOCKED_PENDING_INDEPENDENT_OWNER_REVIEW'
    referenceOnly: true
    rawContentIncluded: false
    sent: false
  }
}

export type DocumentFieldExtractionData = {
  mode: typeof LIVE_DISABLED
  proposal: SyntheticDocumentProposal
  nextAction: 'INDEPENDENT_OWNER_REVIEW_REQUIRED'
  automaticApply: false
  automaticPublication: false
}

export type ReviewedDocumentProposal = {
  proposalId: string
  decision: 'approved' | 'rejected'
  reviewPacketIntegrityDigest: string
  ownerReview: OwnerReview
  mesaEvidenceHandoff: {
    state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED'
    referenceOnly: true
    rawContentIncluded: false
    sent: false
  }
  auditHash: string
}

export type SyntheticVisionConnectorConfig = {
  liveMode?: string
  maxCostCapCents?: number
  maxItems?: number
  /** Required, positive, and capped at one day; it cannot enable live OCR. */
  maxReviewAgeSeconds?: number
  /** Required, positive, and capped at one day; it cannot enable live OCR. */
  maxEvidenceAgeSeconds?: number
}

/** Captured scalar encoder; canonical packet encoding never stringifies an object graph. */
const intrinsicJsonStringify = JSON.stringify

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
/**
 * A Proxy may run arbitrary traps during even supposedly structural checks
 * such as Object.getPrototypeOf() or Reflect.ownKeys(). Detect it first with
 * Node's intrinsic inspector so an untrusted object graph stays data-only.
 */
function isProxyObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && nodeUtilTypes.isProxy(value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  if (isProxyObject(value)) return false
  if (Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
function hasControlCharacter(value: string): boolean { return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\u007f') }
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], error: string): void {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new ConnectorInputError(error)
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) throw new ConnectorInputError(error)
  }
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && (!descriptor.enumerable || descriptor.get || descriptor.set)) throw new ConnectorInputError(error)
    if (!descriptor && key in value) throw new ConnectorInputError(error)
  }
}

/**
 * Serializes only the plain, bounded packet material used for integrity hashes.
 * It reads own data descriptors directly, sorts record keys deterministically,
 * and invokes the captured JSON encoder only for scalar JSON values. Thus a
 * later own/inherited `toJSON` hook cannot alter review-packet integrity bytes.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return intrinsicJsonStringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    return intrinsicJsonStringify(value)
  }
  if (isProxyObject(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== lengthDescriptor.value + 1) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const items: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
      items.push(canonicalJson(descriptor.value))
    }
    return `[${items.join(',')}]`
  }
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
  const keys = Reflect.ownKeys(value)
  const descriptors: Array<{ key: string; value: unknown }> = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (typeof key !== 'string') throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    descriptors.push({ key, value: descriptor.value })
  }
  descriptors.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  return `{${descriptors.map(({ key, value: item }) => `${intrinsicJsonStringify(key)}:${canonicalJson(item)}`).join(',')}}`
}
/**
 * Arrays are an input boundary too: inspect descriptors before an element is
 * read so sparse, inherited, extra, symbol-keyed, or accessor-backed entries
 * cannot influence a synthetic proposal or review.
 */
function denseOwnDataArray(value: unknown, error: string, maximumLength: number): asserts value is unknown[] {
  if (isProxyObject(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ConnectorInputError(error)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || lengthDescriptor.enumerable || lengthDescriptor.get || lengthDescriptor.set || !('value' in lengthDescriptor)) throw new ConnectorInputError(error)
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 1 || length > maximumLength) throw new ConnectorInputError(error)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== length + 1) throw new ConnectorInputError(error)
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError(error)
  }
}
function requiredString(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || hasControlCharacter(value) || hasUnpairedSurrogate(value)) throw new ConnectorInputError(error)
  return value.trim()
}
function parsedDate(value: unknown, error: string): Date {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ConnectorInputError(error)
  return parsed
}
/**
 * A canonical input timestamp can still be close enough to the ECMAScript
 * ceiling that adding a bounded synthetic interval produces an invalid Date.
 * Reject that condition explicitly instead of leaking a RangeError from
 * toISOString() or allowing NaN through deadline comparisons.
 */
function checkedDateAddSeconds(value: Date, seconds: number, error: string): Date {
  const epochMilliseconds = Date.prototype.getTime.call(value)
  const intervalMilliseconds = seconds * 1000
  const resultMilliseconds = epochMilliseconds + intervalMilliseconds
  if (!Number.isSafeInteger(epochMilliseconds) || !Number.isSafeInteger(intervalMilliseconds) || !Number.isSafeInteger(resultMilliseconds) || Math.abs(resultMilliseconds) > MAX_UTC_EPOCH_MILLISECONDS) throw new ConnectorInputError(error)
  const result = new Date(resultMilliseconds)
  if (!Number.isFinite(Date.prototype.getTime.call(result))) throw new ConnectorInputError(error)
  return result
}
/**
 * A caller-controlled clock must not supply overridden Date methods or extra
 * state to the review path. Copy only the intrinsic epoch value into a fresh
 * built-in Date before it can affect packet timing or an audit decision.
 */
function exactClockDate(value: unknown, error: string): Date {
  if (!value || typeof value !== 'object') throw new ConnectorInputError(error)
  let milliseconds: number
  try {
    milliseconds = Date.prototype.getTime.call(value)
  } catch {
    throw new ConnectorInputError(error)
  }
  if (!Number.isFinite(milliseconds) || Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) throw new ConnectorInputError(error)
  return new Date(milliseconds)
}
function isFieldName(value: unknown): value is DocumentFieldName { return typeof value === 'string' && (fieldNames as readonly string[]).includes(value) }
function isSensitive(field: DocumentFieldName): boolean {
  return field === 'note' || field === 'senderName' || field === 'senderAddress' || field === 'recipientName' || field === 'recipientAddress' || field === 'loadingAddress' || field === 'deliveryAddress' || field === 'identityNumber'
}
function fieldsDigestFrom(fields: readonly Pick<SyntheticDocumentField, 'field' | 'valueDigest' | 'privacy'>[]): string {
  return digest(canonicalJson(fields.map((field) => ({ field: field.field, valueDigest: field.valueDigest, privacy: field.privacy }))))
}
function proposalIdFor(product: string, workspaceId: string, evidenceSha256: string, fieldsDigest: string): string {
  return `synthetic-document-${digest(`${product}:${workspaceId}:${evidenceSha256}:${fieldsDigest}`).slice(0, 24)}`
}
function reviewPacketIntegrityMaterial(
  proposal: Omit<SyntheticDocumentProposal, 'reviewPacket'>,
  scopeBinding: SyntheticDocumentReviewPacket['scopeBinding'],
  consentBinding: SyntheticDocumentReviewPacket['consentBinding'],
  governanceBinding: SyntheticDocumentReviewPacket['governanceBinding'],
  dataBoundaryBinding: SyntheticDocumentReviewPacket['dataBoundaryBinding'],
  makerCheckerBinding: SyntheticDocumentReviewPacket['makerCheckerBinding'],
  collectionBoundaryBinding: SyntheticDocumentReviewPacket['collectionBoundaryBinding'],
  stringBoundaryBinding: SyntheticDocumentReviewPacket['stringBoundaryBinding'],
  timeBoundaryBinding: SyntheticDocumentReviewPacket['timeBoundaryBinding'],
  fieldRecordBoundaryBinding: SyntheticDocumentReviewPacket['fieldRecordBoundaryBinding'],
  proxyBoundaryBinding: SyntheticDocumentReviewPacket['proxyBoundaryBinding'],
  dateArithmeticBoundaryBinding: SyntheticDocumentReviewPacket['dateArithmeticBoundaryBinding'],
  integrityEncodingBoundaryBinding: SyntheticDocumentReviewPacket['integrityEncodingBoundaryBinding'],
  evidenceBinding: SyntheticDocumentReviewPacket['evidenceBinding'],
  reviewWindow: SyntheticDocumentReviewPacket['reviewWindow'],
): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    syntheticUri: proposal.syntheticUri,
    preparedBy: proposal.preparedBy,
    mode: proposal.mode,
    extraction: proposal.extraction,
    evidence: proposal.evidence,
    fields: proposal.fields.map((field) => ({
      field: field.field,
      status: field.status,
      privacy: field.privacy,
      valueDigest: field.valueDigest,
      confidence: field.confidence,
      ...(field.maskedValue === undefined ? {} : { maskedValue: field.maskedValue }),
    })),
    fieldsDigest: proposal.fieldsDigest,
    ownerReview: proposal.ownerReview,
    mesaEvidenceHandoff: proposal.mesaEvidenceHandoff,
    scopeBinding,
    consentBinding,
    governanceBinding,
    dataBoundaryBinding,
    makerCheckerBinding,
    collectionBoundaryBinding,
    stringBoundaryBinding,
    timeBoundaryBinding,
    fieldRecordBoundaryBinding,
    proxyBoundaryBinding,
    dateArithmeticBoundaryBinding,
    integrityEncodingBoundaryBinding,
    evidenceBinding,
    reviewWindow,
  }
}

function evidenceBindingFor(
  evidence: Pick<SyntheticDocumentProposal['evidence'], 'capturedAt'>,
  issuedAt: Date,
  maxEvidenceAgeSeconds: number,
): SyntheticDocumentReviewPacket['evidenceBinding'] {
  const capturedAt = new Date(evidence.capturedAt)
  const expiresAt = checkedDateAddSeconds(capturedAt, maxEvidenceAgeSeconds, 'DOCUMENT_EVIDENCE_EXPIRY_ARITHMETIC_INVALID')
  if (expiresAt.getTime() <= issuedAt.getTime()) throw new ConnectorInputError('DOCUMENT_EVIDENCE_STALE')
  return { capturedAt: capturedAt.toISOString(), expiresAt: expiresAt.toISOString() }
}

function reviewByFor(
  issuedAt: Date,
  consentExpiresAt: string,
  evidenceExpiresAt: string,
  maxReviewAgeSeconds: number,
): Date {
  return new Date(Math.min(
    checkedDateAddSeconds(issuedAt, maxReviewAgeSeconds, 'DOCUMENT_REVIEW_WINDOW_ARITHMETIC_INVALID').getTime(),
    new Date(consentExpiresAt).getTime(),
    new Date(evidenceExpiresAt).getTime(),
  ))
}

function reviewPacketFor(
  proposal: Omit<SyntheticDocumentProposal, 'reviewPacket'>,
  product: string,
  workspaceId: string,
  consent: DocumentConsentAssertion,
  issuedAt: Date,
  maxReviewAgeSeconds: number,
  maxEvidenceAgeSeconds: number,
): SyntheticDocumentReviewPacket {
  const scopeBinding = { productDigest: digest(product), workspaceDigest: digest(workspaceId) }
  const consentBinding = { purpose: consent.purpose, policyVersionDigest: digest(consent.policyVersion), expiresAt: consent.expiresAt }
  const governanceBinding = { maxReviewAgeSeconds, maxEvidenceAgeSeconds }
  const dataBoundaryBinding = { ...SYNTHETIC_DOCUMENT_DATA_BOUNDARY }
  const makerCheckerBinding = { ...SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY }
  const collectionBoundaryBinding = { ...SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY }
  const stringBoundaryBinding = { ...SYNTHETIC_DOCUMENT_STRING_BOUNDARY }
  const timeBoundaryBinding = { ...SYNTHETIC_DOCUMENT_TIME_BOUNDARY }
  const fieldRecordBoundaryBinding = { ...SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY }
  const proxyBoundaryBinding = { ...SYNTHETIC_DOCUMENT_PROXY_BOUNDARY }
  const dateArithmeticBoundaryBinding = { ...SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY }
  const integrityEncodingBoundaryBinding = { ...SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY }
  const evidenceBinding = evidenceBindingFor(proposal.evidence, issuedAt, maxEvidenceAgeSeconds)
  const reviewWindow = { issuedAt: issuedAt.toISOString(), reviewBy: reviewByFor(issuedAt, consent.expiresAt, evidenceBinding.expiresAt, maxReviewAgeSeconds).toISOString() }
  return {
    version: SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION,
    integrityDigest: digest(canonicalJson(reviewPacketIntegrityMaterial(proposal, scopeBinding, consentBinding, governanceBinding, dataBoundaryBinding, makerCheckerBinding, collectionBoundaryBinding, stringBoundaryBinding, timeBoundaryBinding, fieldRecordBoundaryBinding, proxyBoundaryBinding, dateArithmeticBoundaryBinding, integrityEncodingBoundaryBinding, evidenceBinding, reviewWindow))),
    scopeBinding,
    consentBinding,
    governanceBinding,
    dataBoundaryBinding,
    makerCheckerBinding,
    collectionBoundaryBinding,
    stringBoundaryBinding,
    timeBoundaryBinding,
    fieldRecordBoundaryBinding,
    proxyBoundaryBinding,
    dateArithmeticBoundaryBinding,
    integrityEncodingBoundaryBinding,
    evidenceBinding,
    reviewWindow,
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawDocumentContentIncluded: false,
    automaticApply: false,
    automaticPublication: false,
  }
}

function normalizedInput(value: unknown, now: Date): SyntheticDocumentScanInput {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_VISION_DOCUMENT_REQUEST')
  exactKeys(value, ['evidence', 'consent', 'syntheticFields'], 'UNEXPECTED_VISION_DOCUMENT_FIELD')
  if (!isRecord(value.evidence) || !isRecord(value.consent)) throw new ConnectorInputError('INVALID_VISION_DOCUMENT_REQUEST')
  if (isProxyObject(value.syntheticFields) || !Array.isArray(value.syntheticFields)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELDS')

  const evidence = value.evidence
  exactKeys(evidence, ['source', 'evidenceId', 'sha256', 'mediaType', 'byteLength', 'capturedAt'], 'UNEXPECTED_DOCUMENT_EVIDENCE_FIELD')
  if (evidence.source !== 'synthetic-fixture') throw new ConnectorInputError('RAW_DOCUMENT_CONTENT_NOT_ACCEPTED')
  const evidenceId = requiredString(evidence.evidenceId, 'INVALID_SYNTHETIC_EVIDENCE_ID', 128)
  if (!EVIDENCE_ID_PATTERN.test(evidenceId)) throw new ConnectorInputError('INVALID_SYNTHETIC_EVIDENCE_ID')
  const sha256 = requiredString(evidence.sha256, 'INVALID_DOCUMENT_EVIDENCE_SHA256', 64)
  if (!SHA256_PATTERN.test(sha256)) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SHA256')
  if (typeof evidence.mediaType !== 'string' || !DOCUMENT_MEDIA_TYPES.has(evidence.mediaType)) throw new ConnectorInputError('INVALID_DOCUMENT_MEDIA_TYPE')
  if (!positiveInteger(evidence.byteLength) || evidence.byteLength > MAX_SYNTHETIC_EVIDENCE_BYTES) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SIZE')
  const capturedAt = parsedDate(evidence.capturedAt, 'INVALID_DOCUMENT_CAPTURE_TIME')
  if (capturedAt.getTime() > now.getTime()) throw new ConnectorInputError('INVALID_DOCUMENT_CAPTURE_TIME')

  const consent = value.consent
  exactKeys(consent, ['purpose', 'status', 'policyVersion', 'expiresAt'], 'UNEXPECTED_DOCUMENT_CONSENT_FIELD')
  if (consent.purpose !== 'document-field-extraction' || consent.status !== 'granted') throw new ConsentError()
  const policyVersion = requiredString(consent.policyVersion, 'INVALID_DOCUMENT_POLICY_VERSION', 80)
  if (!POLICY_VERSION_PATTERN.test(policyVersion)) throw new ConsentError('INVALID_DOCUMENT_POLICY_VERSION')
  const expiresAt = parsedDate(consent.expiresAt, 'INVALID_DOCUMENT_CONSENT_EXPIRY')
  if (expiresAt.getTime() <= now.getTime()) throw new ConsentError('DOCUMENT_CONSENT_EXPIRED')

  denseOwnDataArray(value.syntheticFields, 'INVALID_SYNTHETIC_DOCUMENT_FIELDS', fieldNames.length)
  const seen = new Set<DocumentFieldName>()
  const syntheticFields = value.syntheticFields.map((item): DocumentFieldFixture => {
    if (!isRecord(item)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELD')
    exactKeys(item, ['field', 'value'], 'UNEXPECTED_SYNTHETIC_DOCUMENT_FIELD')
    if (!isFieldName(item.field) || seen.has(item.field)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELD')
    seen.add(item.field)
    return { field: item.field, value: requiredString(item.value, 'INVALID_SYNTHETIC_DOCUMENT_VALUE', 240) }
  })

  return {
    evidence: { source: 'synthetic-fixture', evidenceId, sha256, mediaType: evidence.mediaType as SyntheticDocumentEvidence['mediaType'], byteLength: evidence.byteLength, capturedAt: capturedAt.toISOString() },
    consent: { purpose: 'document-field-extraction', status: 'granted', policyVersion, expiresAt: expiresAt.toISOString() },
    syntheticFields,
  }
}

function fieldsFrom(input: SyntheticDocumentScanInput): SyntheticDocumentField[] {
  return [...input.syntheticFields].sort((left, right) => left.field.localeCompare(right.field)).map(({ field, value }) => {
    const valueDigest = digest(value)
    return isSensitive(field)
      ? { field, status: 'synthetic-proposal', privacy: 'kvkk-masked', valueDigest, maskedValue: `KVKK_MASKED:${valueDigest.slice(0, 16)}`, confidence: 0 }
      : { field, status: 'synthetic-proposal', privacy: 'standard', valueDigest, value, confidence: 0 }
  })
}

function reviewContext(context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): { product: string; workspaceId: string } {
  if (typeof context.product !== 'string' || typeof context.workspaceId !== 'string' || !SCOPE_ID_PATTERN.test(context.product) || !SCOPE_ID_PATTERN.test(context.workspaceId)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT')
  return { product: context.product, workspaceId: context.workspaceId }
}

function reviewNow(context: Pick<ConnectorRunContext, 'now'>): Date {
  if (typeof context.now !== 'function') throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME')
  return exactClockDate(context.now(), 'INVALID_DOCUMENT_REVIEW_TIME')
}

function reviewActor(reviewer: unknown): string {
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 160 || hasControlCharacter(reviewer) || hasUnpairedSurrogate(reviewer)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  const normalized = reviewer.trim()
  if (!ACTOR_PATTERN.test(normalized)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  return normalized
}

/** Actor IDs are ASCII-only at this boundary, so locale-free lowercasing is stable. */
function actorIdentity(actor: string): string { return actor.toLowerCase() }

function reviewedEvidence(value: unknown): SyntheticDocumentProposal['evidence'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_EVIDENCE')
  exactKeys(value, ['evidenceId', 'sha256', 'mediaType', 'byteLength', 'capturedAt', 'rawContentStored'], 'UNEXPECTED_DOCUMENT_PROPOSAL_EVIDENCE_FIELD')
  const evidenceId = requiredString(value.evidenceId, 'INVALID_SYNTHETIC_EVIDENCE_ID', 128)
  if (!EVIDENCE_ID_PATTERN.test(evidenceId)) throw new ConnectorInputError('INVALID_SYNTHETIC_EVIDENCE_ID')
  const sha256 = requiredString(value.sha256, 'INVALID_DOCUMENT_EVIDENCE_SHA256', 64)
  if (!SHA256_PATTERN.test(sha256)) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SHA256')
  if (typeof value.mediaType !== 'string' || !DOCUMENT_MEDIA_TYPES.has(value.mediaType)) throw new ConnectorInputError('INVALID_DOCUMENT_MEDIA_TYPE')
  if (!positiveInteger(value.byteLength) || value.byteLength > MAX_SYNTHETIC_EVIDENCE_BYTES) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SIZE')
  const capturedAt = parsedDate(value.capturedAt, 'INVALID_DOCUMENT_CAPTURE_TIME')
  if (value.rawContentStored !== false) throw new ConnectorInputError('RAW_DOCUMENT_CONTENT_NOT_ACCEPTED')
  return { evidenceId, sha256, mediaType: value.mediaType as SyntheticDocumentEvidence['mediaType'], byteLength: value.byteLength, capturedAt: capturedAt.toISOString(), rawContentStored: false }
}

function reviewedFields(value: unknown): SyntheticDocumentField[] {
  denseOwnDataArray(value, 'INVALID_DOCUMENT_PROPOSAL_FIELDS', fieldNames.length)
  const seen = new Set<DocumentFieldName>()
  let previousField = ''
  return value.map((item): SyntheticDocumentField => {
    if (!isRecord(item)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'value', 'maskedValue', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
    const field = item.field
    if (!isFieldName(field) || seen.has(field) || (previousField && previousField.localeCompare(field) >= 0)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_ORDER')
    seen.add(field)
    previousField = field
    if (item.status !== 'synthetic-proposal' || item.confidence !== 0 || typeof item.privacy !== 'string') throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    const valueDigest = requiredString(item.valueDigest, 'INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST', 64)
    if (!SHA256_PATTERN.test(valueDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST')
    if (item.privacy === 'standard' && !isSensitive(field)) {
      exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'value', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
      const fieldValue = requiredString(item.value, 'INVALID_SYNTHETIC_DOCUMENT_VALUE', 240)
      if (fieldValue !== item.value || digest(fieldValue) !== valueDigest) throw new ConnectorInputError('DOCUMENT_PROPOSAL_FIELD_DIGEST_MISMATCH')
      return { field, status: 'synthetic-proposal', privacy: 'standard', valueDigest, value: fieldValue, confidence: 0 }
    }
    if (item.privacy === 'kvkk-masked' && isSensitive(field)) {
      exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'maskedValue', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
      const maskedValue = requiredString(item.maskedValue, 'INVALID_DOCUMENT_PROPOSAL_MASK', 28)
      if (maskedValue !== `KVKK_MASKED:${valueDigest.slice(0, 16)}`) throw new ConnectorInputError('DOCUMENT_PROPOSAL_MASK_MISMATCH')
      return { field, status: 'synthetic-proposal', privacy: 'kvkk-masked', valueDigest, maskedValue, confidence: 0 }
    }
    throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_PRIVACY')
  })
}

function reviewedConsentBinding(value: unknown, reviewedAt: Date): SyntheticDocumentReviewPacket['consentBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONSENT_BINDING')
  exactKeys(value, ['purpose', 'policyVersionDigest', 'expiresAt'], 'UNEXPECTED_DOCUMENT_REVIEW_CONSENT_BINDING_FIELD')
  if (value.purpose !== 'document-field-extraction') throw new ConsentError('INVALID_DOCUMENT_REVIEW_CONSENT_PURPOSE')
  const policyVersionDigest = requiredString(value.policyVersionDigest, 'INVALID_DOCUMENT_REVIEW_POLICY_DIGEST', 64)
  if (!SHA256_PATTERN.test(policyVersionDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_POLICY_DIGEST')
  const expiresAt = parsedDate(value.expiresAt, 'INVALID_DOCUMENT_REVIEW_CONSENT_EXPIRY')
  if (expiresAt.getTime() <= reviewedAt.getTime()) throw new ConsentError('DOCUMENT_REVIEW_CONSENT_EXPIRED')
  return { purpose: 'document-field-extraction', policyVersionDigest, expiresAt: expiresAt.toISOString() }
}

function reviewedGovernanceBinding(value: unknown): SyntheticDocumentReviewPacket['governanceBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_GOVERNANCE_BINDING')
  exactKeys(value, ['maxReviewAgeSeconds', 'maxEvidenceAgeSeconds'], 'UNEXPECTED_DOCUMENT_REVIEW_GOVERNANCE_BINDING_FIELD')
  if (!positiveInteger(value.maxReviewAgeSeconds) || value.maxReviewAgeSeconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS || !positiveInteger(value.maxEvidenceAgeSeconds) || value.maxEvidenceAgeSeconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_GOVERNANCE_BINDING')
  return { maxReviewAgeSeconds: value.maxReviewAgeSeconds, maxEvidenceAgeSeconds: value.maxEvidenceAgeSeconds }
}

function reviewedDataBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['dataBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING')
  exactKeys(value, ['evidenceSource', 'inputShape', 'rawDocumentContentAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING_FIELD')
  if (value.evidenceSource !== SYNTHETIC_DOCUMENT_DATA_BOUNDARY.evidenceSource || value.inputShape !== SYNTHETIC_DOCUMENT_DATA_BOUNDARY.inputShape || value.rawDocumentContentAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DATA_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_DATA_BOUNDARY }
}

function reviewedMakerCheckerBinding(value: unknown): SyntheticDocumentReviewPacket['makerCheckerBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING')
  exactKeys(value, ['actorIdentity', 'independentReviewerRequired'], 'UNEXPECTED_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING_FIELD')
  if (value.actorIdentity !== SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY.actorIdentity || value.independentReviewerRequired !== true) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_MAKER_CHECKER_BINDING')
  return { ...SYNTHETIC_DOCUMENT_MAKER_CHECKER_BOUNDARY }
}

function reviewedCollectionBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['collectionBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING')
  exactKeys(value, ['collectionShape', 'sparseOrInheritedElementsAccepted', 'accessorElementsAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING_FIELD')
  if (value.collectionShape !== SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY.collectionShape || value.sparseOrInheritedElementsAccepted !== false || value.accessorElementsAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_COLLECTION_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_COLLECTION_BOUNDARY }
}

function reviewedStringBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['stringBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING')
  exactKeys(value, ['valueEncoding', 'controlCharactersAccepted', 'unpairedSurrogateCodeUnitsAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING_FIELD')
  if (value.valueEncoding !== SYNTHETIC_DOCUMENT_STRING_BOUNDARY.valueEncoding || value.controlCharactersAccepted !== false || value.unpairedSurrogateCodeUnitsAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_STRING_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_STRING_BOUNDARY }
}

function reviewedTimeBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['timeBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING')
  exactKeys(value, ['clockValue', 'clockObject', 'issuedAtSource'], 'UNEXPECTED_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING_FIELD')
  if (value.clockValue !== SYNTHETIC_DOCUMENT_TIME_BOUNDARY.clockValue || value.clockObject !== SYNTHETIC_DOCUMENT_TIME_BOUNDARY.clockObject || value.issuedAtSource !== SYNTHETIC_DOCUMENT_TIME_BOUNDARY.issuedAtSource) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_TIME_BOUNDARY }
}

function reviewedFieldRecordBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['fieldRecordBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING')
  exactKeys(value, ['fieldRecordShape', 'fieldDescriptorsValidatedBeforeValues', 'accessorFieldPropertiesAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING_FIELD')
  if (value.fieldRecordShape !== SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY.fieldRecordShape || value.fieldDescriptorsValidatedBeforeValues !== true || value.accessorFieldPropertiesAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_FIELD_RECORD_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_FIELD_RECORD_BOUNDARY }
}

function reviewedProxyBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['proxyBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING')
  exactKeys(value, ['proxyDetection', 'proxyObjectsAccepted', 'proxyArraysAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING_FIELD')
  if (value.proxyDetection !== SYNTHETIC_DOCUMENT_PROXY_BOUNDARY.proxyDetection || value.proxyObjectsAccepted !== false || value.proxyArraysAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PROXY_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_PROXY_BOUNDARY }
}

function reviewedDateArithmeticBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['dateArithmeticBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DATE_ARITHMETIC_BOUNDARY_BINDING')
  exactKeys(value, ['arithmetic', 'overflowAccepted', 'invalidDateAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_DATE_ARITHMETIC_BOUNDARY_BINDING_FIELD')
  if (value.arithmetic !== SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY.arithmetic || value.overflowAccepted !== false || value.invalidDateAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DATE_ARITHMETIC_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_DATE_ARITHMETIC_BOUNDARY }
}

function reviewedIntegrityEncodingBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['integrityEncodingBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_INTEGRITY_ENCODING_BOUNDARY_BINDING')
  exactKeys(value, ['encoding', 'objectKeyOrder', 'toJsonHooksAccepted', 'inheritedSerializationAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_INTEGRITY_ENCODING_BOUNDARY_BINDING_FIELD')
  if (value.encoding !== SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.encoding || value.objectKeyOrder !== SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY.objectKeyOrder || value.toJsonHooksAccepted !== false || value.inheritedSerializationAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_INTEGRITY_ENCODING_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_INTEGRITY_ENCODING_BOUNDARY }
}

function reviewedEvidenceBinding(
  value: unknown,
  evidence: SyntheticDocumentProposal['evidence'],
  governanceBinding: SyntheticDocumentReviewPacket['governanceBinding'],
  reviewedAt: Date,
): SyntheticDocumentReviewPacket['evidenceBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_EVIDENCE_BINDING')
  exactKeys(value, ['capturedAt', 'expiresAt'], 'UNEXPECTED_DOCUMENT_REVIEW_EVIDENCE_BINDING_FIELD')
  const capturedAt = parsedDate(value.capturedAt, 'INVALID_DOCUMENT_REVIEW_EVIDENCE_CAPTURE_TIME')
  const expiresAt = parsedDate(value.expiresAt, 'INVALID_DOCUMENT_REVIEW_EVIDENCE_EXPIRY')
  if (capturedAt.toISOString() !== evidence.capturedAt) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_CAPTURE_MISMATCH')
  const evidenceWindowMilliseconds = expiresAt.getTime() - capturedAt.getTime()
  if (evidenceWindowMilliseconds <= 0 || evidenceWindowMilliseconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS * 1000) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_EVIDENCE_BINDING')
  if (expiresAt.toISOString() !== checkedDateAddSeconds(capturedAt, governanceBinding.maxEvidenceAgeSeconds, 'DOCUMENT_REVIEW_EVIDENCE_EXPIRY_ARITHMETIC_INVALID').toISOString()) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_EXPIRY_MISMATCH')
  if (expiresAt.getTime() <= reviewedAt.getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_EXPIRED')
  return { capturedAt: capturedAt.toISOString(), expiresAt: expiresAt.toISOString() }
}

function reviewedReviewWindow(value: unknown, reviewedAt: Date): SyntheticDocumentReviewPacket['reviewWindow'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_WINDOW')
  exactKeys(value, ['issuedAt', 'reviewBy'], 'UNEXPECTED_DOCUMENT_REVIEW_WINDOW_FIELD')
  const issuedAt = parsedDate(value.issuedAt, 'INVALID_DOCUMENT_REVIEW_WINDOW_ISSUED_AT')
  const reviewBy = parsedDate(value.reviewBy, 'INVALID_DOCUMENT_REVIEW_WINDOW_DEADLINE')
  const reviewWindowMilliseconds = reviewBy.getTime() - issuedAt.getTime()
  if (reviewWindowMilliseconds <= 0 || reviewWindowMilliseconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS * 1000) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_WINDOW')
  if (issuedAt.getTime() > reviewedAt.getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_TIME_BEFORE_ISSUED')
  if (reviewBy.getTime() <= reviewedAt.getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXPIRED')
  return { issuedAt: issuedAt.toISOString(), reviewBy: reviewBy.toISOString() }
}

/**
 * The deadline must describe a coherent synthetic timeline even when an
 * in-process object is malformed. This remains validation, not a signature:
 * an unkeyed packet never authorizes review, apply, or send.
 */
function validateReviewPacketTimeline(
  consentBinding: SyntheticDocumentReviewPacket['consentBinding'],
  governanceBinding: SyntheticDocumentReviewPacket['governanceBinding'],
  evidenceBinding: SyntheticDocumentReviewPacket['evidenceBinding'],
  reviewWindow: SyntheticDocumentReviewPacket['reviewWindow'],
): void {
  const capturedAt = new Date(evidenceBinding.capturedAt)
  const issuedAt = new Date(reviewWindow.issuedAt)
  const reviewBy = new Date(reviewWindow.reviewBy)
  if (capturedAt.getTime() > issuedAt.getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_CAPTURE_AFTER_ISSUANCE')
  if (reviewBy.getTime() > new Date(consentBinding.expiresAt).getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXCEEDS_CONSENT')
  if (reviewBy.getTime() > new Date(evidenceBinding.expiresAt).getTime()) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXCEEDS_EVIDENCE_FRESHNESS')
  if (reviewBy.toISOString() !== reviewByFor(issuedAt, consentBinding.expiresAt, evidenceBinding.expiresAt, governanceBinding.maxReviewAgeSeconds).toISOString()) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_DERIVATION_MISMATCH')
}

function validateSyntheticDocumentProposalForReviewAt(
  proposal: unknown,
  context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>,
  reviewedAt: Date,
): SyntheticDocumentProposal {
  const scoped = reviewContext(context)
  if (!isRecord(proposal)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL')
  exactKeys(proposal, ['proposalId', 'syntheticUri', 'preparedBy', 'mode', 'extraction', 'evidence', 'fields', 'fieldsDigest', 'ownerReview', 'reviewPacket', 'mesaEvidenceHandoff'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
  const proposalId = requiredString(proposal.proposalId, 'INVALID_DOCUMENT_PROPOSAL_ID', 48)
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_ID')
  const preparedBy = requiredString(proposal.preparedBy, 'INVALID_DOCUMENT_PROPOSAL_PREPARER', 160)
  if (!ACTOR_PATTERN.test(preparedBy)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_PREPARER')
  if (proposal.mode !== LIVE_DISABLED || proposal.extraction !== 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR') throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_MODE')
  const evidence = reviewedEvidence(proposal.evidence)
  const fields = reviewedFields(proposal.fields)
  const fieldsDigest = requiredString(proposal.fieldsDigest, 'INVALID_DOCUMENT_PROPOSAL_FIELDS_DIGEST', 64)
  if (!SHA256_PATTERN.test(fieldsDigest) || fieldsDigest !== fieldsDigestFrom(fields)) throw new ConnectorInputError('DOCUMENT_PROPOSAL_FIELDS_DIGEST_MISMATCH')
  const expectedProposalId = proposalIdFor(scoped.product, scoped.workspaceId, evidence.sha256, fieldsDigest)
  if (proposalId !== expectedProposalId) throw new ConnectorInputError('DOCUMENT_PROPOSAL_SCOPE_MISMATCH')
  if (proposal.syntheticUri !== `synthetic://gcl/${VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID}/${proposalId}`) throw new ConnectorInputError('DOCUMENT_PROPOSAL_URI_MISMATCH')

  if (!isRecord(proposal.ownerReview)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_REVIEW')
  exactKeys(proposal.ownerReview, ['status', 'required', 'visibility', 'automaticApply', 'automaticPublication'], 'UNEXPECTED_DOCUMENT_PROPOSAL_REVIEW_FIELD')
  if (proposal.ownerReview.status !== 'pending') throw new ConnectorInputError('DOCUMENT_PROPOSAL_NOT_PENDING_OWNER_REVIEW')
  if (proposal.ownerReview.required !== true || proposal.ownerReview.visibility !== 'owner-only' || proposal.ownerReview.automaticApply !== false || proposal.ownerReview.automaticPublication !== false) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_REVIEW')
  const ownerReview: OwnerReview = { status: 'pending', required: true, visibility: 'owner-only', automaticApply: false, automaticPublication: false }

  if (!isRecord(proposal.mesaEvidenceHandoff)) throw new ConnectorInputError('INVALID_DOCUMENT_HANDOFF')
  exactKeys(proposal.mesaEvidenceHandoff, ['state', 'referenceOnly', 'rawContentIncluded', 'sent'], 'UNEXPECTED_DOCUMENT_HANDOFF_FIELD')
  if (proposal.mesaEvidenceHandoff.state !== 'BLOCKED_PENDING_INDEPENDENT_OWNER_REVIEW' || proposal.mesaEvidenceHandoff.referenceOnly !== true || proposal.mesaEvidenceHandoff.rawContentIncluded !== false || proposal.mesaEvidenceHandoff.sent !== false) throw new ConnectorInputError('INVALID_DOCUMENT_HANDOFF')
  const mesaEvidenceHandoff: SyntheticDocumentProposal['mesaEvidenceHandoff'] = { state: 'BLOCKED_PENDING_INDEPENDENT_OWNER_REVIEW', referenceOnly: true, rawContentIncluded: false, sent: false }

  if (!isRecord(proposal.reviewPacket)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET')
  exactKeys(proposal.reviewPacket, ['version', 'integrityDigest', 'scopeBinding', 'consentBinding', 'governanceBinding', 'dataBoundaryBinding', 'makerCheckerBinding', 'collectionBoundaryBinding', 'stringBoundaryBinding', 'timeBoundaryBinding', 'fieldRecordBoundaryBinding', 'proxyBoundaryBinding', 'dateArithmeticBoundaryBinding', 'integrityEncodingBoundaryBinding', 'evidenceBinding', 'reviewWindow', 'state', 'rawDocumentContentIncluded', 'automaticApply', 'automaticPublication'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_FIELD')
  if (proposal.reviewPacket.version !== SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  if (!isRecord(proposal.reviewPacket.scopeBinding)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_SCOPE')
  exactKeys(proposal.reviewPacket.scopeBinding, ['productDigest', 'workspaceDigest'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_SCOPE_FIELD')
  const productDigest = requiredString(proposal.reviewPacket.scopeBinding.productDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const workspaceDigest = requiredString(proposal.reviewPacket.scopeBinding.workspaceDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const integrityDigest = requiredString(proposal.reviewPacket.integrityDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_DIGEST', 64)
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(integrityDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_DIGEST')
  const consentBinding = reviewedConsentBinding(proposal.reviewPacket.consentBinding, reviewedAt)
  const governanceBinding = reviewedGovernanceBinding(proposal.reviewPacket.governanceBinding)
  const dataBoundaryBinding = reviewedDataBoundaryBinding(proposal.reviewPacket.dataBoundaryBinding)
  const makerCheckerBinding = reviewedMakerCheckerBinding(proposal.reviewPacket.makerCheckerBinding)
  const collectionBoundaryBinding = reviewedCollectionBoundaryBinding(proposal.reviewPacket.collectionBoundaryBinding)
  const stringBoundaryBinding = reviewedStringBoundaryBinding(proposal.reviewPacket.stringBoundaryBinding)
  const timeBoundaryBinding = reviewedTimeBoundaryBinding(proposal.reviewPacket.timeBoundaryBinding)
  const fieldRecordBoundaryBinding = reviewedFieldRecordBoundaryBinding(proposal.reviewPacket.fieldRecordBoundaryBinding)
  const proxyBoundaryBinding = reviewedProxyBoundaryBinding(proposal.reviewPacket.proxyBoundaryBinding)
  const dateArithmeticBoundaryBinding = reviewedDateArithmeticBoundaryBinding(proposal.reviewPacket.dateArithmeticBoundaryBinding)
  const integrityEncodingBoundaryBinding = reviewedIntegrityEncodingBoundaryBinding(proposal.reviewPacket.integrityEncodingBoundaryBinding)
  const evidenceBinding = reviewedEvidenceBinding(proposal.reviewPacket.evidenceBinding, evidence, governanceBinding, reviewedAt)
  const reviewWindow = reviewedReviewWindow(proposal.reviewPacket.reviewWindow, reviewedAt)
  validateReviewPacketTimeline(consentBinding, governanceBinding, evidenceBinding, reviewWindow)
  const reviewPacket: SyntheticDocumentReviewPacket = {
    version: SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION,
    integrityDigest,
    scopeBinding: { productDigest, workspaceDigest },
    consentBinding,
    governanceBinding,
    dataBoundaryBinding,
    makerCheckerBinding,
    collectionBoundaryBinding,
    stringBoundaryBinding,
    timeBoundaryBinding,
    fieldRecordBoundaryBinding,
    proxyBoundaryBinding,
    dateArithmeticBoundaryBinding,
    integrityEncodingBoundaryBinding,
    evidenceBinding,
    reviewWindow,
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawDocumentContentIncluded: false,
    automaticApply: false,
    automaticPublication: false,
  }
  if (proposal.reviewPacket.state !== reviewPacket.state || proposal.reviewPacket.rawDocumentContentIncluded !== false || proposal.reviewPacket.automaticApply !== false || proposal.reviewPacket.automaticPublication !== false || productDigest !== digest(scoped.product) || workspaceDigest !== digest(scoped.workspaceId)) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_SCOPE_MISMATCH')
  const normalized: SyntheticDocumentProposal = { proposalId, syntheticUri: proposal.syntheticUri, preparedBy, mode: LIVE_DISABLED, extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR', evidence, fields, fieldsDigest, ownerReview, reviewPacket, mesaEvidenceHandoff }
  if (integrityDigest !== digest(canonicalJson(reviewPacketIntegrityMaterial(normalized, reviewPacket.scopeBinding, reviewPacket.consentBinding, reviewPacket.governanceBinding, reviewPacket.dataBoundaryBinding, reviewPacket.makerCheckerBinding, reviewPacket.collectionBoundaryBinding, reviewPacket.stringBoundaryBinding, reviewPacket.timeBoundaryBinding, reviewPacket.fieldRecordBoundaryBinding, reviewPacket.proxyBoundaryBinding, reviewPacket.dateArithmeticBoundaryBinding, reviewPacket.integrityEncodingBoundaryBinding, reviewPacket.evidenceBinding, reviewPacket.reviewWindow)))) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_INTEGRITY_MISMATCH')
  return normalized
}

/**
 * Validates a returned synthetic proposal before a review audit is appended.
 * The packet is an unkeyed integrity check, so it deliberately does not claim
 * authenticity or grant a sending/applying capability.
 */
export function validateSyntheticDocumentProposalForReview(proposal: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'now'>): SyntheticDocumentProposal {
  return validateSyntheticDocumentProposalForReviewAt(proposal, context, reviewNow(context))
}

/**
 * GM2 adaptation of the Xontainer MagicScan field schema. It intentionally
 * does not use a camera, Base64 payload, OCR model, network client, provider
 * credential, or data persistence. Only synthetic evidence metadata and
 * fixture field values are accepted.
 */
export class SyntheticVisionDocumentFieldExtractionConnector implements Connector<SyntheticDocumentScanInput, DocumentFieldExtractionData> {
  readonly id = VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID
  readonly kind = 'document-analysis' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [VISION_DOCUMENT_FIELD_EXTRACTION_SCOPE] as const

  constructor(private readonly config: SyntheticVisionConnectorConfig = {}) {}

  private configured(context: ConnectorRunContext): { maxReviewAgeSeconds: number; maxEvidenceAgeSeconds: number } {
    if ((this.config.liveMode ?? LIVE_DISABLED) !== LIVE_DISABLED) throw new ConnectorUnavailableError('VISION_DOCUMENT_FIELD_EXTRACTION_LIVE_DISABLED')
    if (!positiveInteger(this.config.maxCostCapCents) || !positiveInteger(this.config.maxItems)) throw new ConnectorUnavailableError('VISION_DOCUMENT_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (!positiveInteger(this.config.maxReviewAgeSeconds) || this.config.maxReviewAgeSeconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS) throw new ConnectorUnavailableError('VISION_DOCUMENT_REVIEW_WINDOW_NOT_CONFIGURED')
    if (!positiveInteger(this.config.maxEvidenceAgeSeconds) || this.config.maxEvidenceAgeSeconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS) throw new ConnectorUnavailableError('VISION_DOCUMENT_EVIDENCE_FRESHNESS_NOT_CONFIGURED')
    if (!positiveInteger(context.costCapCents) || !positiveInteger(context.requestedItems)) throw new CostCapError('INVALID_VISION_GOVERNANCE_REQUEST')
    if (context.costCapCents > this.config.maxCostCapCents) throw new CostCapError()
    if (context.requestedItems > this.config.maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    if (context.requestedItems !== 1) throw new CostCapError('VISION_DOCUMENT_SINGLE_EVIDENCE_ONLY')
    return { maxReviewAgeSeconds: this.config.maxReviewAgeSeconds, maxEvidenceAgeSeconds: this.config.maxEvidenceAgeSeconds }
  }

  preflight(input: SyntheticDocumentScanInput, context: ConnectorRunContext): void {
    const limits = this.configured(context)
    const checkedAt = reviewNow(context)
    const normalized = normalizedInput(input, checkedAt)
    evidenceBindingFor(normalized.evidence, checkedAt, limits.maxEvidenceAgeSeconds)
  }

  async run(input: SyntheticDocumentScanInput, context: ConnectorRunContext): Promise<ConnectorResult<DocumentFieldExtractionData>> {
    const limits = this.configured(context)
    const issuedAt = reviewNow(context)
    const normalized = normalizedInput(input, issuedAt)
    const fields = fieldsFrom(normalized)
    const fieldsDigest = fieldsDigestFrom(fields)
    const proposalId = proposalIdFor(context.product, context.workspaceId, normalized.evidence.sha256, fieldsDigest)
    const generatedAt = issuedAt.toISOString()
    const proposalWithoutReviewPacket: Omit<SyntheticDocumentProposal, 'reviewPacket'> = {
      proposalId,
      syntheticUri: `synthetic://gcl/${this.id}/${proposalId}`,
      preparedBy: reviewActor(context.actor),
      mode: LIVE_DISABLED,
      extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR',
      evidence: { evidenceId: normalized.evidence.evidenceId, sha256: normalized.evidence.sha256, mediaType: normalized.evidence.mediaType, byteLength: normalized.evidence.byteLength, capturedAt: normalized.evidence.capturedAt, rawContentStored: false },
      fields,
      fieldsDigest,
      ownerReview: { status: 'pending', required: true, visibility: 'owner-only', automaticApply: false, automaticPublication: false },
      mesaEvidenceHandoff: { state: 'BLOCKED_PENDING_INDEPENDENT_OWNER_REVIEW', referenceOnly: true, rawContentIncluded: false, sent: false },
    }
    const proposal: SyntheticDocumentProposal = { ...proposalWithoutReviewPacket, reviewPacket: reviewPacketFor(proposalWithoutReviewPacket, context.product, context.workspaceId, normalized.consent, issuedAt, limits.maxReviewAgeSeconds, limits.maxEvidenceAgeSeconds) }
    return {
      data: { mode: LIVE_DISABLED, proposal, nextAction: 'INDEPENDENT_OWNER_REVIEW_REQUIRED', automaticApply: false, automaticPublication: false },
      provenance: {
        connectorId: this.id,
        source: 'synthetic-xontainer-magicscan-document-field-extraction-design',
        retrievedAt: generatedAt,
        untrustedContent: {
          source: 'synthetic-document-field-fixture',
          value: { evidenceSha256: normalized.evidence.sha256, policyVersion: normalized.consent.policyVersion, fields: fields.map((field) => ({ field: field.field, valueDigest: field.valueDigest, privacy: field.privacy })) },
          handling: 'data-only',
          instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

/**
 * A checker may approve or reject a proposal, but cannot be its maker. This
 * only records a review decision; it never sends data to Masa or applies it.
 */
export async function independentlyReviewSyntheticDocumentProposal(proposal: SyntheticDocumentProposal, decision: 'approved' | 'rejected', ownerApproved: boolean, reviewer: string, auditLog: AuditLog, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'now'>): Promise<ReviewedDocumentProposal> {
  if (!ownerApproved) throw new OwnerGateError()
  const normalizedReviewer = reviewActor(reviewer)
  if (decision !== 'approved' && decision !== 'rejected') throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DECISION')
  const reviewedAt = reviewNow(context)
  const normalizedProposal = validateSyntheticDocumentProposalForReviewAt(proposal, context, reviewedAt)
  if (actorIdentity(normalizedReviewer) === actorIdentity(normalizedProposal.preparedBy)) throw new MakerCheckerError('DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  const occurredAt = reviewedAt.toISOString()
  const audit = await auditLog.append({
    type: 'connector.document.owner_reviewed', connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID, product: context.product, workspaceId: context.workspaceId, actor: normalizedReviewer,
    scopes: [VISION_DOCUMENT_FIELD_EXTRACTION_SCOPE], costCapCents: 0, requestedItems: 1, occurredAt,
    detail: { proposalId: normalizedProposal.proposalId, decision, fieldsDigest: normalizedProposal.fieldsDigest, reviewPacketIntegrityDigest: normalizedProposal.reviewPacket.integrityDigest, mesaEvidenceHandoff: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', rawContentIncluded: false },
  })
  return {
    proposalId: normalizedProposal.proposalId,
    decision,
    reviewPacketIntegrityDigest: normalizedProposal.reviewPacket.integrityDigest,
    ownerReview: { status: decision, required: true, visibility: 'owner-only', automaticApply: false, automaticPublication: false, reviewer: normalizedReviewer, occurredAt },
    mesaEvidenceHandoff: { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', referenceOnly: true, rawContentIncluded: false, sent: false },
    auditHash: audit.hash,
  }
}

/** Only synthetic flags and governance limits are read; credentials are not part of this API. */
export function syntheticVisionDocumentFieldExtractionConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticVisionDocumentFieldExtractionConnector {
  return new SyntheticVisionDocumentFieldExtractionConnector({
    liveMode: environment.GCL_VISION_LIVE_MODE,
    maxCostCapCents: environmentPositiveInteger(environment.GCL_VISION_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_VISION_MAX_ITEMS),
    maxReviewAgeSeconds: environmentPositiveInteger(environment.GCL_VISION_MAX_REVIEW_AGE_SECONDS),
    maxEvidenceAgeSeconds: environmentPositiveInteger(environment.GCL_VISION_MAX_EVIDENCE_AGE_SECONDS),
  })
}
