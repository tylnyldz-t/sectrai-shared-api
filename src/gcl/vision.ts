import { createHash, Hash } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { ConnectorInputError, ConnectorUnavailableError, ConsentError, CostCapError, MakerCheckerError, OwnerGateError } from './errors.js'
import type { AuditLog, Connector, ConnectorAuditEvent, ConnectorResult, ConnectorRunContext } from './types.js'

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
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/
const DOCUMENT_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION = 'synthetic-document-review-packet-v25' as const
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
const SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY = {
  runtimeIntrinsics: 'module-captured-ecmascript-structural-temporal-and-encoding-intrinsics',
  latePatchedGlobalsAccepted: false,
  prototypeMethodHooksAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_HASH_BOUNDARY = {
  algorithm: 'sha256',
  digestEncoding: 'hex-lowercase',
  implementation: 'module-captured-node-crypto-hash-methods',
  latePatchedHashMethodsAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY = {
  validation: 'module-captured-regexp-exec',
  latePatchedRegExpMethodsAccepted: false,
  patternMatcherHooksAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY = {
  inspection: 'module-captured-node-util-types-isProxy',
  latePatchedInspectorAccepted: false,
  inspectionFailureAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY = {
  receiptShape: 'plain-own-enumerable-sha256-hash-only',
  malformedReceiptAccepted: false,
  reviewResultRequiresValidatedAuditHash: true,
} as const
const SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY = {
  auditLog: 'non-proxy-data-method-only',
  appendResult: 'native-promise-only',
  accessorOrProxyAuditTargetsAccepted: false,
  rejectedOrThenableAuditResultsAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY = {
  appendMethod: 'own-or-direct-prototype-data-method-only',
  inheritedFromObjectPrototypeAccepted: false,
  inheritedBeyondDirectPrototypeAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY = {
  auditEvent: 'adapter-created-frozen-own-data-only',
  auditEventScope: 'single-read-validated-review-context-only',
  auditEventMutationAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY = {
  contextMembers: 'own-enumerable-data-properties-read-once',
  inheritedOrAccessorMembersAccepted: false,
  proxyClockFunctionAccepted: false,
} as const
const SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY = {
  approvalValue: 'literal-boolean-true-only',
  truthyValuesAccepted: false,
  approvalCheckedBeforeReview: true,
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
  /** Structural, temporal, and encoding checks use module-captured intrinsics. */
  intrinsicBoundaryBinding: {
    runtimeIntrinsics: typeof SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY.runtimeIntrinsics
    latePatchedGlobalsAccepted: typeof SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY.latePatchedGlobalsAccepted
    prototypeMethodHooksAccepted: typeof SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY.prototypeMethodHooksAccepted
  }
  /** SHA-256 derives through module-captured Node hash operations only. */
  hashBoundaryBinding: {
    algorithm: typeof SYNTHETIC_DOCUMENT_HASH_BOUNDARY.algorithm
    digestEncoding: typeof SYNTHETIC_DOCUMENT_HASH_BOUNDARY.digestEncoding
    implementation: typeof SYNTHETIC_DOCUMENT_HASH_BOUNDARY.implementation
    latePatchedHashMethodsAccepted: typeof SYNTHETIC_DOCUMENT_HASH_BOUNDARY.latePatchedHashMethodsAccepted
  }
  /** Regex validation calls the module-captured intrinsic matcher only. */
  patternBoundaryBinding: {
    validation: typeof SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY.validation
    latePatchedRegExpMethodsAccepted: typeof SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY.latePatchedRegExpMethodsAccepted
    patternMatcherHooksAccepted: typeof SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY.patternMatcherHooksAccepted
  }
  /** Proxy detection uses the Node inspector captured when this module loads. */
  proxyInspectionBoundaryBinding: {
    inspection: typeof SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY.inspection
    latePatchedInspectorAccepted: typeof SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY.latePatchedInspectorAccepted
    inspectionFailureAccepted: typeof SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY.inspectionFailureAccepted
  }
  /** A review is not reported successful without a strict audit receipt hash. */
  auditReceiptBoundaryBinding: {
    receiptShape: typeof SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY.receiptShape
    malformedReceiptAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY.malformedReceiptAccepted
    reviewResultRequiresValidatedAuditHash: typeof SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY.reviewResultRequiresValidatedAuditHash
  }
  /** Audit invocation is a data-method/native-Promise boundary before append. */
  auditAppendBoundaryBinding: {
    auditLog: typeof SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.auditLog
    appendResult: typeof SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.appendResult
    accessorOrProxyAuditTargetsAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.accessorOrProxyAuditTargetsAccepted
    rejectedOrThenableAuditResultsAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.rejectedOrThenableAuditResultsAccepted
  }
  /** An audit method cannot arrive through Object.prototype or a prototype chain. */
  auditMethodBoundaryBinding: {
    appendMethod: typeof SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY.appendMethod
    inheritedFromObjectPrototypeAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY.inheritedFromObjectPrototypeAccepted
    inheritedBeyondDirectPrototypeAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY.inheritedBeyondDirectPrototypeAccepted
  }
  /** Audit receives a frozen event built only from a single-read review scope. */
  auditEventBoundaryBinding: {
    auditEvent: typeof SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY.auditEvent
    auditEventScope: typeof SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY.auditEventScope
    auditEventMutationAccepted: typeof SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY.auditEventMutationAccepted
  }
  /** Review scope and clock members are descriptor-read once, never inherited/accessed. */
  reviewContextBoundaryBinding: {
    contextMembers: typeof SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY.contextMembers
    inheritedOrAccessorMembersAccepted: typeof SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY.inheritedOrAccessorMembersAccepted
    proxyClockFunctionAccepted: typeof SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY.proxyClockFunctionAccepted
  }
  /** Owner authority is a literal Boolean gate, never a truthiness coercion. */
  ownerApprovalBoundaryBinding: {
    approvalValue: typeof SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY.approvalValue
    truthyValuesAccepted: typeof SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY.truthyValuesAccepted
    approvalCheckedBeforeReview: typeof SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY.approvalCheckedBeforeReview
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

/** Captured intrinsics keep late runtime monkey patches outside the review boundary. */
const intrinsicJsonStringify = JSON.stringify
const intrinsicCreateHash = createHash
const intrinsicHashUpdate = Hash.prototype.update
const intrinsicHashDigest = Hash.prototype.digest
const intrinsicRegExpExec = RegExp.prototype.exec
const intrinsicNodeUtilTypesIsProxy = nodeUtilTypes.isProxy
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const intrinsicObjectFreeze = Object.freeze
const intrinsicReflectOwnKeys = Reflect.ownKeys
const intrinsicObjectPrototype = Object.prototype
const intrinsicArrayIsArray = Array.isArray
const intrinsicArrayPrototype = Array.prototype
const intrinsicArrayIncludes = Array.prototype.includes
const intrinsicArrayJoin = Array.prototype.join
const intrinsicArraySlice = Array.prototype.slice
const intrinsicArraySort = Array.prototype.sort
const IntrinsicDate = Date
const intrinsicDatePrototype = Date.prototype
const intrinsicDateGetTime = Date.prototype.getTime
const intrinsicDateToISOString = Date.prototype.toISOString
const intrinsicNumber = Number
const intrinsicNumberIsFinite = Number.isFinite
const intrinsicNumberIsSafeInteger = Number.isSafeInteger
const intrinsicMathAbs = Math.abs
const intrinsicMathMin = Math.min
const IntrinsicSet = Set
const intrinsicSetAdd = Set.prototype.add
const intrinsicSetHas = Set.prototype.has
const intrinsicStringCharCodeAt = String.prototype.charCodeAt
const intrinsicStringToLowerCase = String.prototype.toLowerCase
const intrinsicStringTrim = String.prototype.trim
const intrinsicFunctionCall = Function.prototype.call
const IntrinsicPromise = Promise
const intrinsicPromisePrototype = Promise.prototype
const intrinsicPromiseThen = Promise.prototype.then

/** Dense arrays are descriptor-checked before this helper reads an input item. */
function arrayMap<T, TResult>(value: readonly T[], mapper: (item: T, index: number) => TResult): TResult[] {
  const result: TResult[] = []
  for (let index = 0; index < value.length; index += 1) result[index] = mapper(value[index]!, index)
  return result
}

function digest(value: string): string {
  return intrinsicHashDigest.call(intrinsicHashUpdate.call(intrinsicCreateHash('sha256'), value, 'utf8'), 'hex') as string
}
/** Do not dispatch through a mutable RegExp instance or prototype method. */
function matchesPattern(pattern: RegExp, value: string): boolean {
  return intrinsicRegExpExec.call(pattern, value) !== null
}
/**
 * A Proxy may run arbitrary traps during even supposedly structural checks
 * such as Object.getPrototypeOf() or Reflect.ownKeys(). Detect it first with
 * Node's intrinsic inspector so an untrusted object graph stays data-only.
 */
function isProxyObject(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    return intrinsicNodeUtilTypesIsProxy(value)
  } catch {
    throw new ConnectorInputError('INVALID_DOCUMENT_PROXY_INSPECTION')
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  if (isProxyObject(value)) return false
  if (intrinsicArrayIsArray(value)) return false
  const prototype = intrinsicObjectGetPrototypeOf(value)
  return prototype === intrinsicObjectPrototype || prototype === null
}
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && intrinsicNumberIsSafeInteger(value) && value > 0 }
function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !matchesPattern(POSITIVE_INTEGER_PATTERN, value)) return undefined
  const parsed = intrinsicNumber(value)
  return intrinsicNumberIsSafeInteger(parsed) ? parsed : undefined
}
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = intrinsicStringCharCodeAt.call(value, index)
    if (codeUnit < 32 || codeUnit === 0x7f) return true
  }
  return false
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = intrinsicStringCharCodeAt.call(value, index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = intrinsicStringCharCodeAt.call(value, index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], error: string): void {
  const ownKeys = intrinsicReflectOwnKeys(value)
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !intrinsicArrayIncludes.call(allowed, key)) throw new ConnectorInputError(error)
  }
  for (const key of ownKeys) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) throw new ConnectorInputError(error)
  }
  for (const key of allowed) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key)
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
    if (!intrinsicNumberIsFinite(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    return intrinsicJsonStringify(value)
  }
  if (isProxyObject(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
  if (intrinsicArrayIsArray(value)) {
    if (intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !intrinsicNumberIsSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const ownKeys = intrinsicReflectOwnKeys(value)
    if (ownKeys.length !== lengthDescriptor.value + 1) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const items: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
      items.push(canonicalJson(descriptor.value))
    }
    return `[${intrinsicArrayJoin.call(items, ',')}]`
  }
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
  const keys = intrinsicReflectOwnKeys(value)
  const descriptors: Array<{ key: string; value: unknown }> = []
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (typeof key !== 'string') throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError('INVALID_DOCUMENT_INTEGRITY_MATERIAL')
    descriptors.push({ key, value: descriptor.value })
  }
  intrinsicArraySort.call(descriptors, (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  const entries = arrayMap(descriptors, ({ key, value: item }) => `${intrinsicJsonStringify(key)}:${canonicalJson(item)}`)
  return `{${intrinsicArrayJoin.call(entries, ',')}}`
}
/**
 * Arrays are an input boundary too: inspect descriptors before an element is
 * read so sparse, inherited, extra, symbol-keyed, or accessor-backed entries
 * cannot influence a synthetic proposal or review.
 */
function denseOwnDataArray(value: unknown, error: string, maximumLength: number): asserts value is unknown[] {
  if (isProxyObject(value) || !intrinsicArrayIsArray(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype) throw new ConnectorInputError(error)
  const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || lengthDescriptor.enumerable || lengthDescriptor.get || lengthDescriptor.set || !('value' in lengthDescriptor)) throw new ConnectorInputError(error)
  const length = lengthDescriptor.value
  if (!intrinsicNumberIsSafeInteger(length) || length < 1 || length > maximumLength) throw new ConnectorInputError(error)
  const ownKeys = intrinsicReflectOwnKeys(value)
  if (ownKeys.length !== length + 1) throw new ConnectorInputError(error)
  for (let index = 0; index < length; index += 1) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError(error)
  }
}
function requiredString(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== 'string' || !intrinsicStringTrim.call(value) || value.length > maxLength || hasControlCharacter(value) || hasUnpairedSurrogate(value)) throw new ConnectorInputError(error)
  return intrinsicStringTrim.call(value)
}
function parsedDate(value: unknown, error: string): Date {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const parsed = new IntrinsicDate(value)
  if (!intrinsicNumberIsFinite(intrinsicDateGetTime.call(parsed)) || intrinsicDateToISOString.call(parsed) !== value) throw new ConnectorInputError(error)
  return parsed
}
/**
 * A canonical input timestamp can still be close enough to the ECMAScript
 * ceiling that adding a bounded synthetic interval produces an invalid Date.
 * Reject that condition explicitly instead of leaking a RangeError from
 * toISOString() or allowing NaN through deadline comparisons.
 */
function checkedDateAddSeconds(value: Date, seconds: number, error: string): Date {
  const epochMilliseconds = intrinsicDateGetTime.call(value)
  const intervalMilliseconds = seconds * 1000
  const resultMilliseconds = epochMilliseconds + intervalMilliseconds
  if (!intrinsicNumberIsSafeInteger(epochMilliseconds) || !intrinsicNumberIsSafeInteger(intervalMilliseconds) || !intrinsicNumberIsSafeInteger(resultMilliseconds) || intrinsicMathAbs(resultMilliseconds) > MAX_UTC_EPOCH_MILLISECONDS) throw new ConnectorInputError(error)
  const result = new IntrinsicDate(resultMilliseconds)
  if (!intrinsicNumberIsFinite(intrinsicDateGetTime.call(result))) throw new ConnectorInputError(error)
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
    milliseconds = intrinsicDateGetTime.call(value)
  } catch {
    throw new ConnectorInputError(error)
  }
  if (!intrinsicNumberIsFinite(milliseconds) || intrinsicObjectGetPrototypeOf(value) !== intrinsicDatePrototype || intrinsicReflectOwnKeys(value).length !== 0) throw new ConnectorInputError(error)
  return new IntrinsicDate(milliseconds)
}
function isFieldName(value: unknown): value is DocumentFieldName { return typeof value === 'string' && intrinsicArrayIncludes.call(fieldNames as readonly string[], value) }
function isSensitive(field: DocumentFieldName): boolean {
  return field === 'note' || field === 'senderName' || field === 'senderAddress' || field === 'recipientName' || field === 'recipientAddress' || field === 'loadingAddress' || field === 'deliveryAddress' || field === 'identityNumber'
}
function fieldsDigestFrom(fields: readonly Pick<SyntheticDocumentField, 'field' | 'valueDigest' | 'privacy'>[]): string {
  return digest(canonicalJson(arrayMap(fields, (field) => ({ field: field.field, valueDigest: field.valueDigest, privacy: field.privacy }))))
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
  intrinsicBoundaryBinding: SyntheticDocumentReviewPacket['intrinsicBoundaryBinding'],
  hashBoundaryBinding: SyntheticDocumentReviewPacket['hashBoundaryBinding'],
  patternBoundaryBinding: SyntheticDocumentReviewPacket['patternBoundaryBinding'],
  proxyInspectionBoundaryBinding: SyntheticDocumentReviewPacket['proxyInspectionBoundaryBinding'],
  auditReceiptBoundaryBinding: SyntheticDocumentReviewPacket['auditReceiptBoundaryBinding'],
  auditAppendBoundaryBinding: SyntheticDocumentReviewPacket['auditAppendBoundaryBinding'],
  auditMethodBoundaryBinding: SyntheticDocumentReviewPacket['auditMethodBoundaryBinding'],
  auditEventBoundaryBinding: SyntheticDocumentReviewPacket['auditEventBoundaryBinding'],
  reviewContextBoundaryBinding: SyntheticDocumentReviewPacket['reviewContextBoundaryBinding'],
  ownerApprovalBoundaryBinding: SyntheticDocumentReviewPacket['ownerApprovalBoundaryBinding'],
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
    fields: arrayMap(proposal.fields, (field) => ({
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
    intrinsicBoundaryBinding,
    hashBoundaryBinding,
    patternBoundaryBinding,
    proxyInspectionBoundaryBinding,
    auditReceiptBoundaryBinding,
    auditAppendBoundaryBinding,
    auditMethodBoundaryBinding,
    auditEventBoundaryBinding,
    reviewContextBoundaryBinding,
    ownerApprovalBoundaryBinding,
    evidenceBinding,
    reviewWindow,
  }
}

function evidenceBindingFor(
  evidence: Pick<SyntheticDocumentProposal['evidence'], 'capturedAt'>,
  issuedAt: Date,
  maxEvidenceAgeSeconds: number,
): SyntheticDocumentReviewPacket['evidenceBinding'] {
  const capturedAt = new IntrinsicDate(evidence.capturedAt)
  const expiresAt = checkedDateAddSeconds(capturedAt, maxEvidenceAgeSeconds, 'DOCUMENT_EVIDENCE_EXPIRY_ARITHMETIC_INVALID')
  if (intrinsicDateGetTime.call(expiresAt) <= intrinsicDateGetTime.call(issuedAt)) throw new ConnectorInputError('DOCUMENT_EVIDENCE_STALE')
  return { capturedAt: intrinsicDateToISOString.call(capturedAt), expiresAt: intrinsicDateToISOString.call(expiresAt) }
}

function reviewByFor(
  issuedAt: Date,
  consentExpiresAt: string,
  evidenceExpiresAt: string,
  maxReviewAgeSeconds: number,
): Date {
  return new IntrinsicDate(intrinsicMathMin(
    intrinsicDateGetTime.call(checkedDateAddSeconds(issuedAt, maxReviewAgeSeconds, 'DOCUMENT_REVIEW_WINDOW_ARITHMETIC_INVALID')),
    intrinsicDateGetTime.call(new IntrinsicDate(consentExpiresAt)),
    intrinsicDateGetTime.call(new IntrinsicDate(evidenceExpiresAt)),
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
  const intrinsicBoundaryBinding = { ...SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY }
  const hashBoundaryBinding = { ...SYNTHETIC_DOCUMENT_HASH_BOUNDARY }
  const patternBoundaryBinding = { ...SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY }
  const proxyInspectionBoundaryBinding = { ...SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY }
  const auditReceiptBoundaryBinding = { ...SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY }
  const auditAppendBoundaryBinding = { ...SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY }
  const auditMethodBoundaryBinding = { ...SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY }
  const auditEventBoundaryBinding = { ...SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY }
  const reviewContextBoundaryBinding = { ...SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY }
  const ownerApprovalBoundaryBinding = { ...SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY }
  const evidenceBinding = evidenceBindingFor(proposal.evidence, issuedAt, maxEvidenceAgeSeconds)
  const reviewWindow = { issuedAt: intrinsicDateToISOString.call(issuedAt), reviewBy: intrinsicDateToISOString.call(reviewByFor(issuedAt, consent.expiresAt, evidenceBinding.expiresAt, maxReviewAgeSeconds)) }
  return {
    version: SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION,
    integrityDigest: digest(canonicalJson(reviewPacketIntegrityMaterial(proposal, scopeBinding, consentBinding, governanceBinding, dataBoundaryBinding, makerCheckerBinding, collectionBoundaryBinding, stringBoundaryBinding, timeBoundaryBinding, fieldRecordBoundaryBinding, proxyBoundaryBinding, dateArithmeticBoundaryBinding, integrityEncodingBoundaryBinding, intrinsicBoundaryBinding, hashBoundaryBinding, patternBoundaryBinding, proxyInspectionBoundaryBinding, auditReceiptBoundaryBinding, auditAppendBoundaryBinding, auditMethodBoundaryBinding, auditEventBoundaryBinding, reviewContextBoundaryBinding, ownerApprovalBoundaryBinding, evidenceBinding, reviewWindow))),
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
    intrinsicBoundaryBinding,
    hashBoundaryBinding,
    patternBoundaryBinding,
    proxyInspectionBoundaryBinding,
    auditReceiptBoundaryBinding,
    auditAppendBoundaryBinding,
    auditMethodBoundaryBinding,
    auditEventBoundaryBinding,
    reviewContextBoundaryBinding,
    ownerApprovalBoundaryBinding,
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
  if (isProxyObject(value.syntheticFields) || !intrinsicArrayIsArray(value.syntheticFields)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELDS')

  const evidence = value.evidence
  exactKeys(evidence, ['source', 'evidenceId', 'sha256', 'mediaType', 'byteLength', 'capturedAt'], 'UNEXPECTED_DOCUMENT_EVIDENCE_FIELD')
  if (evidence.source !== 'synthetic-fixture') throw new ConnectorInputError('RAW_DOCUMENT_CONTENT_NOT_ACCEPTED')
  const evidenceId = requiredString(evidence.evidenceId, 'INVALID_SYNTHETIC_EVIDENCE_ID', 128)
  if (!matchesPattern(EVIDENCE_ID_PATTERN, evidenceId)) throw new ConnectorInputError('INVALID_SYNTHETIC_EVIDENCE_ID')
  const sha256 = requiredString(evidence.sha256, 'INVALID_DOCUMENT_EVIDENCE_SHA256', 64)
  if (!matchesPattern(SHA256_PATTERN, sha256)) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SHA256')
  if (typeof evidence.mediaType !== 'string' || !intrinsicSetHas.call(DOCUMENT_MEDIA_TYPES, evidence.mediaType)) throw new ConnectorInputError('INVALID_DOCUMENT_MEDIA_TYPE')
  if (!positiveInteger(evidence.byteLength) || evidence.byteLength > MAX_SYNTHETIC_EVIDENCE_BYTES) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SIZE')
  const capturedAt = parsedDate(evidence.capturedAt, 'INVALID_DOCUMENT_CAPTURE_TIME')
  if (intrinsicDateGetTime.call(capturedAt) > intrinsicDateGetTime.call(now)) throw new ConnectorInputError('INVALID_DOCUMENT_CAPTURE_TIME')

  const consent = value.consent
  exactKeys(consent, ['purpose', 'status', 'policyVersion', 'expiresAt'], 'UNEXPECTED_DOCUMENT_CONSENT_FIELD')
  if (consent.purpose !== 'document-field-extraction' || consent.status !== 'granted') throw new ConsentError()
  const policyVersion = requiredString(consent.policyVersion, 'INVALID_DOCUMENT_POLICY_VERSION', 80)
  if (!matchesPattern(POLICY_VERSION_PATTERN, policyVersion)) throw new ConsentError('INVALID_DOCUMENT_POLICY_VERSION')
  const expiresAt = parsedDate(consent.expiresAt, 'INVALID_DOCUMENT_CONSENT_EXPIRY')
  if (intrinsicDateGetTime.call(expiresAt) <= intrinsicDateGetTime.call(now)) throw new ConsentError('DOCUMENT_CONSENT_EXPIRED')

  denseOwnDataArray(value.syntheticFields, 'INVALID_SYNTHETIC_DOCUMENT_FIELDS', fieldNames.length)
  const seen = new IntrinsicSet<DocumentFieldName>()
  const syntheticFields = arrayMap(value.syntheticFields, (item): DocumentFieldFixture => {
    if (!isRecord(item)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELD')
    exactKeys(item, ['field', 'value'], 'UNEXPECTED_SYNTHETIC_DOCUMENT_FIELD')
    if (!isFieldName(item.field) || intrinsicSetHas.call(seen, item.field)) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELD')
    intrinsicSetAdd.call(seen, item.field)
    return { field: item.field, value: requiredString(item.value, 'INVALID_SYNTHETIC_DOCUMENT_VALUE', 240) }
  })

  return {
    evidence: { source: 'synthetic-fixture', evidenceId, sha256, mediaType: evidence.mediaType as SyntheticDocumentEvidence['mediaType'], byteLength: evidence.byteLength, capturedAt: intrinsicDateToISOString.call(capturedAt) },
    consent: { purpose: 'document-field-extraction', status: 'granted', policyVersion, expiresAt: intrinsicDateToISOString.call(expiresAt) },
    syntheticFields,
  }
}

function fieldsFrom(input: SyntheticDocumentScanInput): SyntheticDocumentField[] {
  const sorted = intrinsicArraySlice.call(input.syntheticFields)
  intrinsicArraySort.call(sorted, (left, right) => left.field < right.field ? -1 : left.field > right.field ? 1 : 0)
  return arrayMap(sorted, ({ field, value }) => {
    const valueDigest = digest(value)
    return isSensitive(field)
      ? { field, status: 'synthetic-proposal', privacy: 'kvkk-masked', valueDigest, maskedValue: `KVKK_MASKED:${valueDigest.slice(0, 16)}`, confidence: 0 }
      : { field, status: 'synthetic-proposal', privacy: 'standard', valueDigest, value, confidence: 0 }
  })
}

type ReviewContextSnapshot = { product: string; workspaceId: string; now: unknown }

/** Read the review scope and clock only from own enumerable data descriptors. */
function reviewContextSnapshot(context: unknown): ReviewContextSnapshot {
  if (!isRecord(context)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT')
  const member = (key: 'product' | 'workspaceId' | 'now'): unknown => {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(context, key)
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT')
    return descriptor.value
  }
  const product = member('product')
  const workspaceId = member('workspaceId')
  const now = member('now')
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || !matchesPattern(SCOPE_ID_PATTERN, product) || !matchesPattern(SCOPE_ID_PATTERN, workspaceId)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT')
  if (typeof now !== 'function' || isProxyObject(now)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME')
  return { product, workspaceId, now }
}

function reviewNow(now: unknown): Date {
  if (typeof now !== 'function' || isProxyObject(now)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME')
  let value: unknown
  try {
    value = intrinsicFunctionCall.call(now, undefined)
  } catch {
    throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_TIME')
  }
  return exactClockDate(value, 'INVALID_DOCUMENT_REVIEW_TIME')
}

function reviewActor(reviewer: unknown): string {
  if (typeof reviewer !== 'string' || !intrinsicStringTrim.call(reviewer) || reviewer.length > 160 || hasControlCharacter(reviewer) || hasUnpairedSurrogate(reviewer)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  const normalized = intrinsicStringTrim.call(reviewer)
  if (!matchesPattern(ACTOR_PATTERN, normalized)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  return normalized
}

/** Actor IDs are ASCII-only at this boundary, so locale-free lowercasing is stable. */
function actorIdentity(actor: string): string { return intrinsicStringToLowerCase.call(actor) }

function reviewedEvidence(value: unknown): SyntheticDocumentProposal['evidence'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_EVIDENCE')
  exactKeys(value, ['evidenceId', 'sha256', 'mediaType', 'byteLength', 'capturedAt', 'rawContentStored'], 'UNEXPECTED_DOCUMENT_PROPOSAL_EVIDENCE_FIELD')
  const evidenceId = requiredString(value.evidenceId, 'INVALID_SYNTHETIC_EVIDENCE_ID', 128)
  if (!matchesPattern(EVIDENCE_ID_PATTERN, evidenceId)) throw new ConnectorInputError('INVALID_SYNTHETIC_EVIDENCE_ID')
  const sha256 = requiredString(value.sha256, 'INVALID_DOCUMENT_EVIDENCE_SHA256', 64)
  if (!matchesPattern(SHA256_PATTERN, sha256)) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SHA256')
  if (typeof value.mediaType !== 'string' || !intrinsicSetHas.call(DOCUMENT_MEDIA_TYPES, value.mediaType)) throw new ConnectorInputError('INVALID_DOCUMENT_MEDIA_TYPE')
  if (!positiveInteger(value.byteLength) || value.byteLength > MAX_SYNTHETIC_EVIDENCE_BYTES) throw new ConnectorInputError('INVALID_DOCUMENT_EVIDENCE_SIZE')
  const capturedAt = parsedDate(value.capturedAt, 'INVALID_DOCUMENT_CAPTURE_TIME')
  if (value.rawContentStored !== false) throw new ConnectorInputError('RAW_DOCUMENT_CONTENT_NOT_ACCEPTED')
  return { evidenceId, sha256, mediaType: value.mediaType as SyntheticDocumentEvidence['mediaType'], byteLength: value.byteLength, capturedAt: intrinsicDateToISOString.call(capturedAt), rawContentStored: false }
}

function reviewedFields(value: unknown): SyntheticDocumentField[] {
  denseOwnDataArray(value, 'INVALID_DOCUMENT_PROPOSAL_FIELDS', fieldNames.length)
  const seen = new IntrinsicSet<DocumentFieldName>()
  let previousField = ''
  return arrayMap(value, (item): SyntheticDocumentField => {
    if (!isRecord(item)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'value', 'maskedValue', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
    const field = item.field
    if (!isFieldName(field) || intrinsicSetHas.call(seen, field) || (previousField && previousField >= field)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_ORDER')
    intrinsicSetAdd.call(seen, field)
    previousField = field
    if (item.status !== 'synthetic-proposal' || item.confidence !== 0 || typeof item.privacy !== 'string') throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    const valueDigest = requiredString(item.valueDigest, 'INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST', 64)
    if (!matchesPattern(SHA256_PATTERN, valueDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST')
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
  if (!matchesPattern(SHA256_PATTERN, policyVersionDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_POLICY_DIGEST')
  const expiresAt = parsedDate(value.expiresAt, 'INVALID_DOCUMENT_REVIEW_CONSENT_EXPIRY')
  if (intrinsicDateGetTime.call(expiresAt) <= intrinsicDateGetTime.call(reviewedAt)) throw new ConsentError('DOCUMENT_REVIEW_CONSENT_EXPIRED')
  return { purpose: 'document-field-extraction', policyVersionDigest, expiresAt: intrinsicDateToISOString.call(expiresAt) }
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

function reviewedIntrinsicBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['intrinsicBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_INTRINSIC_BOUNDARY_BINDING')
  exactKeys(value, ['runtimeIntrinsics', 'latePatchedGlobalsAccepted', 'prototypeMethodHooksAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_INTRINSIC_BOUNDARY_BINDING_FIELD')
  if (value.runtimeIntrinsics !== SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY.runtimeIntrinsics || value.latePatchedGlobalsAccepted !== false || value.prototypeMethodHooksAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_INTRINSIC_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_INTRINSIC_BOUNDARY }
}

function reviewedHashBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['hashBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_HASH_BOUNDARY_BINDING')
  exactKeys(value, ['algorithm', 'digestEncoding', 'implementation', 'latePatchedHashMethodsAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_HASH_BOUNDARY_BINDING_FIELD')
  if (value.algorithm !== SYNTHETIC_DOCUMENT_HASH_BOUNDARY.algorithm || value.digestEncoding !== SYNTHETIC_DOCUMENT_HASH_BOUNDARY.digestEncoding || value.implementation !== SYNTHETIC_DOCUMENT_HASH_BOUNDARY.implementation || value.latePatchedHashMethodsAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_HASH_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_HASH_BOUNDARY }
}

function reviewedPatternBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['patternBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PATTERN_BOUNDARY_BINDING')
  exactKeys(value, ['validation', 'latePatchedRegExpMethodsAccepted', 'patternMatcherHooksAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_PATTERN_BOUNDARY_BINDING_FIELD')
  if (value.validation !== SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY.validation || value.latePatchedRegExpMethodsAccepted !== false || value.patternMatcherHooksAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PATTERN_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_PATTERN_BOUNDARY }
}

function reviewedProxyInspectionBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['proxyInspectionBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PROXY_INSPECTION_BOUNDARY_BINDING')
  exactKeys(value, ['inspection', 'latePatchedInspectorAccepted', 'inspectionFailureAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_PROXY_INSPECTION_BOUNDARY_BINDING_FIELD')
  if (value.inspection !== SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY.inspection || value.latePatchedInspectorAccepted !== false || value.inspectionFailureAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PROXY_INSPECTION_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_PROXY_INSPECTION_BOUNDARY }
}

function reviewedAuditReceiptBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['auditReceiptBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_RECEIPT_BOUNDARY_BINDING')
  exactKeys(value, ['receiptShape', 'malformedReceiptAccepted', 'reviewResultRequiresValidatedAuditHash'], 'UNEXPECTED_DOCUMENT_REVIEW_AUDIT_RECEIPT_BOUNDARY_BINDING_FIELD')
  if (value.receiptShape !== SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY.receiptShape || value.malformedReceiptAccepted !== false || value.reviewResultRequiresValidatedAuditHash !== true) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_RECEIPT_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_AUDIT_RECEIPT_BOUNDARY }
}

function reviewedAuditAppendBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['auditAppendBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_APPEND_BOUNDARY_BINDING')
  exactKeys(value, ['auditLog', 'appendResult', 'accessorOrProxyAuditTargetsAccepted', 'rejectedOrThenableAuditResultsAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_AUDIT_APPEND_BOUNDARY_BINDING_FIELD')
  if (value.auditLog !== SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.auditLog || value.appendResult !== SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY.appendResult || value.accessorOrProxyAuditTargetsAccepted !== false || value.rejectedOrThenableAuditResultsAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_APPEND_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_AUDIT_APPEND_BOUNDARY }
}

function reviewedAuditMethodBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['auditMethodBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_METHOD_BOUNDARY_BINDING')
  exactKeys(value, ['appendMethod', 'inheritedFromObjectPrototypeAccepted', 'inheritedBeyondDirectPrototypeAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_AUDIT_METHOD_BOUNDARY_BINDING_FIELD')
  if (value.appendMethod !== SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY.appendMethod || value.inheritedFromObjectPrototypeAccepted !== false || value.inheritedBeyondDirectPrototypeAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_METHOD_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_AUDIT_METHOD_BOUNDARY }
}

function reviewedAuditEventBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['auditEventBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_EVENT_BOUNDARY_BINDING')
  exactKeys(value, ['auditEvent', 'auditEventScope', 'auditEventMutationAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_AUDIT_EVENT_BOUNDARY_BINDING_FIELD')
  if (value.auditEvent !== SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY.auditEvent || value.auditEventScope !== SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY.auditEventScope || value.auditEventMutationAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_EVENT_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_AUDIT_EVENT_BOUNDARY }
}

function reviewedReviewContextBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['reviewContextBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT_BOUNDARY_BINDING')
  exactKeys(value, ['contextMembers', 'inheritedOrAccessorMembersAccepted', 'proxyClockFunctionAccepted'], 'UNEXPECTED_DOCUMENT_REVIEW_CONTEXT_BOUNDARY_BINDING_FIELD')
  if (value.contextMembers !== SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY.contextMembers || value.inheritedOrAccessorMembersAccepted !== false || value.proxyClockFunctionAccepted !== false) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_CONTEXT_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_REVIEW_CONTEXT_BOUNDARY }
}

function reviewedOwnerApprovalBoundaryBinding(value: unknown): SyntheticDocumentReviewPacket['ownerApprovalBoundaryBinding'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_OWNER_APPROVAL_BOUNDARY_BINDING')
  exactKeys(value, ['approvalValue', 'truthyValuesAccepted', 'approvalCheckedBeforeReview'], 'UNEXPECTED_DOCUMENT_REVIEW_OWNER_APPROVAL_BOUNDARY_BINDING_FIELD')
  if (value.approvalValue !== SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY.approvalValue || value.truthyValuesAccepted !== false || value.approvalCheckedBeforeReview !== true) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_OWNER_APPROVAL_BOUNDARY_BINDING')
  return { ...SYNTHETIC_DOCUMENT_OWNER_APPROVAL_BOUNDARY }
}

/**
 * Resolve an audit append method through data descriptors only. Audit classes
 * may expose a normal prototype method, but accessors and Proxy targets are
 * never read or invoked at this synthetic review boundary.
 */
function auditAppendMethod(value: unknown): (event: ConnectorAuditEvent) => Promise<{ hash: string }> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || isProxyObject(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_APPEND_TARGET')
  const ownDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'append')
  const directPrototype = intrinsicObjectGetPrototypeOf(value)
  const descriptor = ownDescriptor ?? (directPrototype && directPrototype !== intrinsicObjectPrototype && !isProxyObject(directPrototype)
    ? intrinsicObjectGetOwnPropertyDescriptor(directPrototype, 'append')
    : undefined)
  if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor) || typeof descriptor.value !== 'function' || isProxyObject(descriptor.value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_APPEND_TARGET')
  return descriptor.value as (event: ConnectorAuditEvent) => Promise<{ hash: string }>
}

/** The audit adapter must return an exact native Promise, never a thenable. */
function auditAppendPromise(value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object' || isProxyObject(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicPromisePrototype) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_APPEND_RESULT')
  return value as Promise<unknown>
}

/**
 * An append error is a controlled denial: review success is never reported
 * when the audit method throws, rejects, or returns a non-native thenable.
 */
function appendReviewedAudit(auditLog: AuditLog, event: ConnectorAuditEvent): Promise<unknown> {
  const append = auditAppendMethod(auditLog)
  let pending: unknown
  try {
    pending = intrinsicFunctionCall.call(append, auditLog, event)
  } catch {
    throw new ConnectorInputError('DOCUMENT_REVIEW_AUDIT_APPEND_FAILED')
  }
  const receipt = auditAppendPromise(pending)
  return new IntrinsicPromise((resolve, reject) => {
    try {
      intrinsicPromiseThen.call(receipt, resolve, () => reject(new ConnectorInputError('DOCUMENT_REVIEW_AUDIT_APPEND_FAILED')))
    } catch {
      reject(new ConnectorInputError('DOCUMENT_REVIEW_AUDIT_APPEND_FAILED'))
    }
  })
}

/**
 * A review audit event is a one-way handoff: it is created from already
 * normalized values, then the event, its detail record, and its scope array
 * are frozen before the audit adapter receives them. This preserves the
 * reviewed scope even if a downstream adapter tries to mutate its argument.
 */
function frozenReviewedAuditEvent(
  scope: { product: string; workspaceId: string },
  actor: string,
  occurredAt: string,
  proposal: SyntheticDocumentProposal,
  decision: 'approved' | 'rejected',
): ConnectorAuditEvent {
  const scopes = intrinsicObjectFreeze([VISION_DOCUMENT_FIELD_EXTRACTION_SCOPE])
  const detail = intrinsicObjectFreeze({
    proposalId: proposal.proposalId,
    decision,
    fieldsDigest: proposal.fieldsDigest,
    reviewPacketIntegrityDigest: proposal.reviewPacket.integrityDigest,
    mesaEvidenceHandoff: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED',
    rawContentIncluded: false,
  })
  return intrinsicObjectFreeze({
    type: 'connector.document.owner_reviewed',
    connectorId: VISION_DOCUMENT_FIELD_EXTRACTION_CONNECTOR_ID,
    product: scope.product,
    workspaceId: scope.workspaceId,
    actor,
    scopes,
    costCapCents: 0,
    requestedItems: 1,
    occurredAt,
    detail,
  })
}

/** An audit append must not make a review appear successful with an unchecked receipt. */
function reviewedAuditHash(value: unknown): string {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_RECEIPT')
  exactKeys(value, ['hash'], 'UNEXPECTED_DOCUMENT_REVIEW_AUDIT_RECEIPT_FIELD')
  const hash = requiredString(value.hash, 'INVALID_DOCUMENT_REVIEW_AUDIT_RECEIPT', 64)
  if (!matchesPattern(SHA256_PATTERN, hash)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_AUDIT_RECEIPT')
  return hash
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
  if (intrinsicDateToISOString.call(capturedAt) !== evidence.capturedAt) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_CAPTURE_MISMATCH')
  const evidenceWindowMilliseconds = intrinsicDateGetTime.call(expiresAt) - intrinsicDateGetTime.call(capturedAt)
  if (evidenceWindowMilliseconds <= 0 || evidenceWindowMilliseconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS * 1000) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_EVIDENCE_BINDING')
  if (intrinsicDateToISOString.call(expiresAt) !== intrinsicDateToISOString.call(checkedDateAddSeconds(capturedAt, governanceBinding.maxEvidenceAgeSeconds, 'DOCUMENT_REVIEW_EVIDENCE_EXPIRY_ARITHMETIC_INVALID'))) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_EXPIRY_MISMATCH')
  if (intrinsicDateGetTime.call(expiresAt) <= intrinsicDateGetTime.call(reviewedAt)) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_EXPIRED')
  return { capturedAt: intrinsicDateToISOString.call(capturedAt), expiresAt: intrinsicDateToISOString.call(expiresAt) }
}

function reviewedReviewWindow(value: unknown, reviewedAt: Date): SyntheticDocumentReviewPacket['reviewWindow'] {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_WINDOW')
  exactKeys(value, ['issuedAt', 'reviewBy'], 'UNEXPECTED_DOCUMENT_REVIEW_WINDOW_FIELD')
  const issuedAt = parsedDate(value.issuedAt, 'INVALID_DOCUMENT_REVIEW_WINDOW_ISSUED_AT')
  const reviewBy = parsedDate(value.reviewBy, 'INVALID_DOCUMENT_REVIEW_WINDOW_DEADLINE')
  const reviewWindowMilliseconds = intrinsicDateGetTime.call(reviewBy) - intrinsicDateGetTime.call(issuedAt)
  if (reviewWindowMilliseconds <= 0 || reviewWindowMilliseconds > MAX_SYNTHETIC_REVIEW_WINDOW_SECONDS * 1000) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_WINDOW')
  if (intrinsicDateGetTime.call(issuedAt) > intrinsicDateGetTime.call(reviewedAt)) throw new ConnectorInputError('DOCUMENT_REVIEW_TIME_BEFORE_ISSUED')
  if (intrinsicDateGetTime.call(reviewBy) <= intrinsicDateGetTime.call(reviewedAt)) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXPIRED')
  return { issuedAt: intrinsicDateToISOString.call(issuedAt), reviewBy: intrinsicDateToISOString.call(reviewBy) }
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
  const capturedAt = new IntrinsicDate(evidenceBinding.capturedAt)
  const issuedAt = new IntrinsicDate(reviewWindow.issuedAt)
  const reviewBy = new IntrinsicDate(reviewWindow.reviewBy)
  if (intrinsicDateGetTime.call(capturedAt) > intrinsicDateGetTime.call(issuedAt)) throw new ConnectorInputError('DOCUMENT_REVIEW_EVIDENCE_CAPTURE_AFTER_ISSUANCE')
  if (intrinsicDateGetTime.call(reviewBy) > intrinsicDateGetTime.call(new IntrinsicDate(consentBinding.expiresAt))) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXCEEDS_CONSENT')
  if (intrinsicDateGetTime.call(reviewBy) > intrinsicDateGetTime.call(new IntrinsicDate(evidenceBinding.expiresAt))) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_EXCEEDS_EVIDENCE_FRESHNESS')
  if (intrinsicDateToISOString.call(reviewBy) !== intrinsicDateToISOString.call(reviewByFor(issuedAt, consentBinding.expiresAt, evidenceBinding.expiresAt, governanceBinding.maxReviewAgeSeconds))) throw new ConnectorInputError('DOCUMENT_REVIEW_WINDOW_DERIVATION_MISMATCH')
}

function validateSyntheticDocumentProposalForReviewAt(
  proposal: unknown,
  scoped: { product: string; workspaceId: string },
  reviewedAt: Date,
): SyntheticDocumentProposal {
  if (!isRecord(proposal)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL')
  exactKeys(proposal, ['proposalId', 'syntheticUri', 'preparedBy', 'mode', 'extraction', 'evidence', 'fields', 'fieldsDigest', 'ownerReview', 'reviewPacket', 'mesaEvidenceHandoff'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
  const proposalId = requiredString(proposal.proposalId, 'INVALID_DOCUMENT_PROPOSAL_ID', 48)
  if (!matchesPattern(PROPOSAL_ID_PATTERN, proposalId)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_ID')
  const preparedBy = requiredString(proposal.preparedBy, 'INVALID_DOCUMENT_PROPOSAL_PREPARER', 160)
  if (!matchesPattern(ACTOR_PATTERN, preparedBy)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_PREPARER')
  if (proposal.mode !== LIVE_DISABLED || proposal.extraction !== 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR') throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_MODE')
  const evidence = reviewedEvidence(proposal.evidence)
  const fields = reviewedFields(proposal.fields)
  const fieldsDigest = requiredString(proposal.fieldsDigest, 'INVALID_DOCUMENT_PROPOSAL_FIELDS_DIGEST', 64)
  if (!matchesPattern(SHA256_PATTERN, fieldsDigest) || fieldsDigest !== fieldsDigestFrom(fields)) throw new ConnectorInputError('DOCUMENT_PROPOSAL_FIELDS_DIGEST_MISMATCH')
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
  exactKeys(proposal.reviewPacket, ['version', 'integrityDigest', 'scopeBinding', 'consentBinding', 'governanceBinding', 'dataBoundaryBinding', 'makerCheckerBinding', 'collectionBoundaryBinding', 'stringBoundaryBinding', 'timeBoundaryBinding', 'fieldRecordBoundaryBinding', 'proxyBoundaryBinding', 'dateArithmeticBoundaryBinding', 'integrityEncodingBoundaryBinding', 'intrinsicBoundaryBinding', 'hashBoundaryBinding', 'patternBoundaryBinding', 'proxyInspectionBoundaryBinding', 'auditReceiptBoundaryBinding', 'auditAppendBoundaryBinding', 'auditMethodBoundaryBinding', 'auditEventBoundaryBinding', 'reviewContextBoundaryBinding', 'ownerApprovalBoundaryBinding', 'evidenceBinding', 'reviewWindow', 'state', 'rawDocumentContentIncluded', 'automaticApply', 'automaticPublication'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_FIELD')
  if (proposal.reviewPacket.version !== SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_VERSION_UNSUPPORTED')
  if (!isRecord(proposal.reviewPacket.scopeBinding)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_SCOPE')
  exactKeys(proposal.reviewPacket.scopeBinding, ['productDigest', 'workspaceDigest'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_SCOPE_FIELD')
  const productDigest = requiredString(proposal.reviewPacket.scopeBinding.productDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const workspaceDigest = requiredString(proposal.reviewPacket.scopeBinding.workspaceDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const integrityDigest = requiredString(proposal.reviewPacket.integrityDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_DIGEST', 64)
  if (!matchesPattern(SHA256_PATTERN, productDigest) || !matchesPattern(SHA256_PATTERN, workspaceDigest) || !matchesPattern(SHA256_PATTERN, integrityDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_DIGEST')
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
  const intrinsicBoundaryBinding = reviewedIntrinsicBoundaryBinding(proposal.reviewPacket.intrinsicBoundaryBinding)
  const hashBoundaryBinding = reviewedHashBoundaryBinding(proposal.reviewPacket.hashBoundaryBinding)
  const patternBoundaryBinding = reviewedPatternBoundaryBinding(proposal.reviewPacket.patternBoundaryBinding)
  const proxyInspectionBoundaryBinding = reviewedProxyInspectionBoundaryBinding(proposal.reviewPacket.proxyInspectionBoundaryBinding)
  const auditReceiptBoundaryBinding = reviewedAuditReceiptBoundaryBinding(proposal.reviewPacket.auditReceiptBoundaryBinding)
  const auditAppendBoundaryBinding = reviewedAuditAppendBoundaryBinding(proposal.reviewPacket.auditAppendBoundaryBinding)
  const auditMethodBoundaryBinding = reviewedAuditMethodBoundaryBinding(proposal.reviewPacket.auditMethodBoundaryBinding)
  const auditEventBoundaryBinding = reviewedAuditEventBoundaryBinding(proposal.reviewPacket.auditEventBoundaryBinding)
  const reviewContextBoundaryBinding = reviewedReviewContextBoundaryBinding(proposal.reviewPacket.reviewContextBoundaryBinding)
  const ownerApprovalBoundaryBinding = reviewedOwnerApprovalBoundaryBinding(proposal.reviewPacket.ownerApprovalBoundaryBinding)
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
    intrinsicBoundaryBinding,
    hashBoundaryBinding,
    patternBoundaryBinding,
    proxyInspectionBoundaryBinding,
    auditReceiptBoundaryBinding,
    auditAppendBoundaryBinding,
    auditMethodBoundaryBinding,
    auditEventBoundaryBinding,
    reviewContextBoundaryBinding,
    ownerApprovalBoundaryBinding,
    evidenceBinding,
    reviewWindow,
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawDocumentContentIncluded: false,
    automaticApply: false,
    automaticPublication: false,
  }
  if (proposal.reviewPacket.state !== reviewPacket.state || proposal.reviewPacket.rawDocumentContentIncluded !== false || proposal.reviewPacket.automaticApply !== false || proposal.reviewPacket.automaticPublication !== false || productDigest !== digest(scoped.product) || workspaceDigest !== digest(scoped.workspaceId)) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_SCOPE_MISMATCH')
  const normalized: SyntheticDocumentProposal = { proposalId, syntheticUri: proposal.syntheticUri, preparedBy, mode: LIVE_DISABLED, extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR', evidence, fields, fieldsDigest, ownerReview, reviewPacket, mesaEvidenceHandoff }
  if (integrityDigest !== digest(canonicalJson(reviewPacketIntegrityMaterial(normalized, reviewPacket.scopeBinding, reviewPacket.consentBinding, reviewPacket.governanceBinding, reviewPacket.dataBoundaryBinding, reviewPacket.makerCheckerBinding, collectionBoundaryBinding, stringBoundaryBinding, timeBoundaryBinding, fieldRecordBoundaryBinding, proxyBoundaryBinding, dateArithmeticBoundaryBinding, integrityEncodingBoundaryBinding, intrinsicBoundaryBinding, hashBoundaryBinding, patternBoundaryBinding, proxyInspectionBoundaryBinding, auditReceiptBoundaryBinding, auditAppendBoundaryBinding, auditMethodBoundaryBinding, auditEventBoundaryBinding, reviewContextBoundaryBinding, ownerApprovalBoundaryBinding, evidenceBinding, reviewPacket.reviewWindow)))) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_INTEGRITY_MISMATCH')
  return normalized
}

/**
 * Validates a returned synthetic proposal before a review audit is appended.
 * The packet is an unkeyed integrity check, so it deliberately does not claim
 * authenticity or grant a sending/applying capability.
 */
export function validateSyntheticDocumentProposalForReview(proposal: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'now'>): SyntheticDocumentProposal {
  const snapshot = reviewContextSnapshot(context)
  return validateSyntheticDocumentProposalForReviewAt(proposal, snapshot, reviewNow(snapshot.now))
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
    const checkedAt = reviewNow(reviewContextSnapshot(context).now)
    const normalized = normalizedInput(input, checkedAt)
    evidenceBindingFor(normalized.evidence, checkedAt, limits.maxEvidenceAgeSeconds)
  }

  async run(input: SyntheticDocumentScanInput, context: ConnectorRunContext): Promise<ConnectorResult<DocumentFieldExtractionData>> {
    const limits = this.configured(context)
    const contextSnapshot = reviewContextSnapshot(context)
    const issuedAt = reviewNow(contextSnapshot.now)
    const normalized = normalizedInput(input, issuedAt)
    const fields = fieldsFrom(normalized)
    const fieldsDigest = fieldsDigestFrom(fields)
    const proposalId = proposalIdFor(contextSnapshot.product, contextSnapshot.workspaceId, normalized.evidence.sha256, fieldsDigest)
    const generatedAt = intrinsicDateToISOString.call(issuedAt)
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
    const proposal: SyntheticDocumentProposal = { ...proposalWithoutReviewPacket, reviewPacket: reviewPacketFor(proposalWithoutReviewPacket, contextSnapshot.product, contextSnapshot.workspaceId, normalized.consent, issuedAt, limits.maxReviewAgeSeconds, limits.maxEvidenceAgeSeconds) }
    return {
      data: { mode: LIVE_DISABLED, proposal, nextAction: 'INDEPENDENT_OWNER_REVIEW_REQUIRED', automaticApply: false, automaticPublication: false },
      provenance: {
        connectorId: this.id,
        source: 'synthetic-xontainer-magicscan-document-field-extraction-design',
        retrievedAt: generatedAt,
        untrustedContent: {
          source: 'synthetic-document-field-fixture',
          value: { evidenceSha256: normalized.evidence.sha256, policyVersion: normalized.consent.policyVersion, fields: arrayMap(fields, (field) => ({ field: field.field, valueDigest: field.valueDigest, privacy: field.privacy })) },
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
  if (ownerApproved !== true) throw new OwnerGateError()
  const normalizedReviewer = reviewActor(reviewer)
  if (decision !== 'approved' && decision !== 'rejected') throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_DECISION')
  const snapshot = reviewContextSnapshot(context)
  const reviewedAt = reviewNow(snapshot.now)
  const normalizedProposal = validateSyntheticDocumentProposalForReviewAt(proposal, snapshot, reviewedAt)
  if (actorIdentity(normalizedReviewer) === actorIdentity(normalizedProposal.preparedBy)) throw new MakerCheckerError('DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  const occurredAt = intrinsicDateToISOString.call(reviewedAt)
  const auditHash = reviewedAuditHash(await appendReviewedAudit(auditLog, frozenReviewedAuditEvent(snapshot, normalizedReviewer, occurredAt, normalizedProposal, decision)))
  return {
    proposalId: normalizedProposal.proposalId,
    decision,
    reviewPacketIntegrityDigest: normalizedProposal.reviewPacket.integrityDigest,
    ownerReview: { status: decision, required: true, visibility: 'owner-only', automaticApply: false, automaticPublication: false, reviewer: normalizedReviewer, occurredAt },
    mesaEvidenceHandoff: { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', referenceOnly: true, rawContentIncluded: false, sent: false },
    auditHash,
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
