import { createHash } from 'node:crypto'
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
const SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION = 'synthetic-document-review-packet-v1' as const

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
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
function hasControlCharacter(value: string): boolean { return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\u007f') }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], error: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ConnectorInputError(error)
}
function requiredString(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || hasControlCharacter(value)) throw new ConnectorInputError(error)
  return value.trim()
}
function parsedDate(value: unknown, error: string): Date {
  if (typeof value !== 'string') throw new ConnectorInputError(error)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ConnectorInputError(error)
  return parsed
}
function isFieldName(value: unknown): value is DocumentFieldName { return typeof value === 'string' && (fieldNames as readonly string[]).includes(value) }
function isSensitive(field: DocumentFieldName): boolean {
  return field === 'note' || field === 'senderName' || field === 'senderAddress' || field === 'recipientName' || field === 'recipientAddress' || field === 'loadingAddress' || field === 'deliveryAddress' || field === 'identityNumber'
}
function fieldsDigestFrom(fields: readonly Pick<SyntheticDocumentField, 'field' | 'valueDigest' | 'privacy'>[]): string {
  return digest(JSON.stringify(fields.map((field) => ({ field: field.field, valueDigest: field.valueDigest, privacy: field.privacy }))))
}
function proposalIdFor(product: string, workspaceId: string, evidenceSha256: string, fieldsDigest: string): string {
  return `synthetic-document-${digest(`${product}:${workspaceId}:${evidenceSha256}:${fieldsDigest}`).slice(0, 24)}`
}
function reviewPacketIntegrityMaterial(proposal: Omit<SyntheticDocumentProposal, 'reviewPacket'>, scopeBinding: SyntheticDocumentReviewPacket['scopeBinding']): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    syntheticUri: proposal.syntheticUri,
    preparedBy: proposal.preparedBy,
    mode: proposal.mode,
    extraction: proposal.extraction,
    evidence: proposal.evidence,
    fields: proposal.fields.map((field) => ({ field: field.field, status: field.status, privacy: field.privacy, valueDigest: field.valueDigest, confidence: field.confidence, maskedValue: field.maskedValue })),
    fieldsDigest: proposal.fieldsDigest,
    ownerReview: proposal.ownerReview,
    mesaEvidenceHandoff: proposal.mesaEvidenceHandoff,
    scopeBinding,
  }
}
function reviewPacketFor(proposal: Omit<SyntheticDocumentProposal, 'reviewPacket'>, product: string, workspaceId: string): SyntheticDocumentReviewPacket {
  const scopeBinding = { productDigest: digest(product), workspaceDigest: digest(workspaceId) }
  return {
    version: SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION,
    integrityDigest: digest(JSON.stringify(reviewPacketIntegrityMaterial(proposal, scopeBinding))),
    scopeBinding,
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawDocumentContentIncluded: false,
    automaticApply: false,
    automaticPublication: false,
  }
}

function normalizedInput(value: unknown, now: Date): SyntheticDocumentScanInput {
  if (!isRecord(value)) throw new ConnectorInputError('INVALID_VISION_DOCUMENT_REQUEST')
  exactKeys(value, ['evidence', 'consent', 'syntheticFields'], 'UNEXPECTED_VISION_DOCUMENT_FIELD')
  if (!isRecord(value.evidence) || !isRecord(value.consent) || !Array.isArray(value.syntheticFields)) throw new ConnectorInputError('INVALID_VISION_DOCUMENT_REQUEST')

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

  if (value.syntheticFields.length < 1 || value.syntheticFields.length > fieldNames.length) throw new ConnectorInputError('INVALID_SYNTHETIC_DOCUMENT_FIELDS')
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

function reviewActor(reviewer: unknown): string {
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 160 || hasControlCharacter(reviewer)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  const normalized = reviewer.trim()
  if (!ACTOR_PATTERN.test(normalized)) throw new OwnerGateError('OWNER_REVIEWER_REQUIRED')
  return normalized
}

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
  if (!Array.isArray(value) || value.length < 1 || value.length > fieldNames.length) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELDS')
  const seen = new Set<DocumentFieldName>()
  let previousField = ''
  return value.map((item): SyntheticDocumentField => {
    if (!isRecord(item)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    if (!isFieldName(item.field) || seen.has(item.field) || (previousField && previousField.localeCompare(item.field) >= 0)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_ORDER')
    seen.add(item.field)
    previousField = item.field
    if (item.status !== 'synthetic-proposal' || item.confidence !== 0 || typeof item.privacy !== 'string') throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD')
    const valueDigest = requiredString(item.valueDigest, 'INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST', 64)
    if (!SHA256_PATTERN.test(valueDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_DIGEST')
    if (item.privacy === 'standard' && !isSensitive(item.field)) {
      exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'value', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
      const fieldValue = requiredString(item.value, 'INVALID_SYNTHETIC_DOCUMENT_VALUE', 240)
      if (fieldValue !== item.value || digest(fieldValue) !== valueDigest) throw new ConnectorInputError('DOCUMENT_PROPOSAL_FIELD_DIGEST_MISMATCH')
      return { field: item.field, status: 'synthetic-proposal', privacy: 'standard', valueDigest, value: fieldValue, confidence: 0 }
    }
    if (item.privacy === 'kvkk-masked' && isSensitive(item.field)) {
      exactKeys(item, ['field', 'status', 'privacy', 'valueDigest', 'maskedValue', 'confidence'], 'UNEXPECTED_DOCUMENT_PROPOSAL_FIELD')
      const maskedValue = requiredString(item.maskedValue, 'INVALID_DOCUMENT_PROPOSAL_MASK', 28)
      if (maskedValue !== `KVKK_MASKED:${valueDigest.slice(0, 16)}`) throw new ConnectorInputError('DOCUMENT_PROPOSAL_MASK_MISMATCH')
      return { field: item.field, status: 'synthetic-proposal', privacy: 'kvkk-masked', valueDigest, maskedValue, confidence: 0 }
    }
    throw new ConnectorInputError('INVALID_DOCUMENT_PROPOSAL_FIELD_PRIVACY')
  })
}

/**
 * Validates a returned synthetic proposal before a review audit is appended.
 * The packet is an unkeyed integrity check, so it deliberately does not claim
 * authenticity or grant a sending/applying capability.
 */
export function validateSyntheticDocumentProposalForReview(proposal: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): SyntheticDocumentProposal {
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
  exactKeys(proposal.reviewPacket, ['version', 'integrityDigest', 'scopeBinding', 'state', 'rawDocumentContentIncluded', 'automaticApply', 'automaticPublication'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_FIELD')
  if (!isRecord(proposal.reviewPacket.scopeBinding)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_SCOPE')
  exactKeys(proposal.reviewPacket.scopeBinding, ['productDigest', 'workspaceDigest'], 'UNEXPECTED_DOCUMENT_REVIEW_PACKET_SCOPE_FIELD')
  const productDigest = requiredString(proposal.reviewPacket.scopeBinding.productDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const workspaceDigest = requiredString(proposal.reviewPacket.scopeBinding.workspaceDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_SCOPE', 64)
  const integrityDigest = requiredString(proposal.reviewPacket.integrityDigest, 'INVALID_DOCUMENT_REVIEW_PACKET_DIGEST', 64)
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(integrityDigest)) throw new ConnectorInputError('INVALID_DOCUMENT_REVIEW_PACKET_DIGEST')
  const reviewPacket: SyntheticDocumentReviewPacket = {
    version: SYNTHETIC_DOCUMENT_REVIEW_PACKET_VERSION,
    integrityDigest,
    scopeBinding: { productDigest, workspaceDigest },
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawDocumentContentIncluded: false,
    automaticApply: false,
    automaticPublication: false,
  }
  if (proposal.reviewPacket.version !== reviewPacket.version || proposal.reviewPacket.state !== reviewPacket.state || proposal.reviewPacket.rawDocumentContentIncluded !== false || proposal.reviewPacket.automaticApply !== false || proposal.reviewPacket.automaticPublication !== false || productDigest !== digest(scoped.product) || workspaceDigest !== digest(scoped.workspaceId)) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_SCOPE_MISMATCH')
  const normalized: SyntheticDocumentProposal = { proposalId, syntheticUri: proposal.syntheticUri, preparedBy, mode: LIVE_DISABLED, extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR', evidence, fields, fieldsDigest, ownerReview, reviewPacket, mesaEvidenceHandoff }
  if (integrityDigest !== digest(JSON.stringify(reviewPacketIntegrityMaterial(normalized, reviewPacket.scopeBinding)))) throw new ConnectorInputError('DOCUMENT_REVIEW_PACKET_INTEGRITY_MISMATCH')
  return normalized
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

  private configured(context: ConnectorRunContext): void {
    if ((this.config.liveMode ?? LIVE_DISABLED) !== LIVE_DISABLED) throw new ConnectorUnavailableError('VISION_DOCUMENT_FIELD_EXTRACTION_LIVE_DISABLED')
    if (!positiveInteger(this.config.maxCostCapCents) || !positiveInteger(this.config.maxItems)) throw new ConnectorUnavailableError('VISION_DOCUMENT_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (!positiveInteger(context.costCapCents) || !positiveInteger(context.requestedItems)) throw new CostCapError('INVALID_VISION_GOVERNANCE_REQUEST')
    if (context.costCapCents > this.config.maxCostCapCents) throw new CostCapError()
    if (context.requestedItems > this.config.maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
    if (context.requestedItems !== 1) throw new CostCapError('VISION_DOCUMENT_SINGLE_EVIDENCE_ONLY')
  }

  preflight(input: SyntheticDocumentScanInput, context: ConnectorRunContext): void {
    this.configured(context)
    normalizedInput(input, context.now())
  }

  async run(input: SyntheticDocumentScanInput, context: ConnectorRunContext): Promise<ConnectorResult<DocumentFieldExtractionData>> {
    this.configured(context)
    const normalized = normalizedInput(input, context.now())
    const fields = fieldsFrom(normalized)
    const fieldsDigest = fieldsDigestFrom(fields)
    const proposalId = proposalIdFor(context.product, context.workspaceId, normalized.evidence.sha256, fieldsDigest)
    const generatedAt = context.now().toISOString()
    const proposalWithoutReviewPacket: Omit<SyntheticDocumentProposal, 'reviewPacket'> = {
      proposalId,
      syntheticUri: `synthetic://gcl/${this.id}/${proposalId}`,
      preparedBy: context.actor,
      mode: LIVE_DISABLED,
      extraction: 'SYNTHETIC_PROPOSAL_ONLY_NOT_OCR',
      evidence: { evidenceId: normalized.evidence.evidenceId, sha256: normalized.evidence.sha256, mediaType: normalized.evidence.mediaType, byteLength: normalized.evidence.byteLength, capturedAt: normalized.evidence.capturedAt, rawContentStored: false },
      fields,
      fieldsDigest,
      ownerReview: { status: 'pending', required: true, visibility: 'owner-only', automaticApply: false, automaticPublication: false },
      mesaEvidenceHandoff: { state: 'BLOCKED_PENDING_INDEPENDENT_OWNER_REVIEW', referenceOnly: true, rawContentIncluded: false, sent: false },
    }
    const proposal: SyntheticDocumentProposal = { ...proposalWithoutReviewPacket, reviewPacket: reviewPacketFor(proposalWithoutReviewPacket, context.product, context.workspaceId) }
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
  const normalizedProposal = validateSyntheticDocumentProposalForReview(proposal, context)
  if (normalizedReviewer === normalizedProposal.preparedBy) throw new MakerCheckerError('DOCUMENT_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  const occurredAt = context.now().toISOString()
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
  })
}
