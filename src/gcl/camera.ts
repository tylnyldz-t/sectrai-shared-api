import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
import { hashAuditEvent } from './audit.js'
import { CameraConsentError, ConnectorInputError, ConnectorUnavailableError, CostCapError, MakerCheckerError, OwnerGateError } from './errors.js'
import type { AuditLog, Connector, ConnectorAuditEvent, ConnectorResult, ConnectorRunContext } from './types.js'

export const CAMERA_CONNECTOR_ID = 'camera-observation'
export const CAMERA_LIVE_STATUS = 'LIVE_DISABLED' as const
export const CAMERA_SCOPE = 'camera:observe' as const
export const CAMERA_REVIEW_PACKET_VERSION = 'synthetic-camera-review-packet-v1' as const
export const CAMERA_REVIEW_RECEIPT_VERSION = 'synthetic-camera-review-receipt-v1' as const
export const CAMERA_REVIEW_AUDIT_WITNESS_VERSION = 'synthetic-camera-review-audit-witness-v1' as const
export const CAMERA_REVIEW_AUDIT_TRAIL_WITNESS_VERSION = 'synthetic-camera-review-audit-trail-witness-v1' as const
export const CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION = 'synthetic-camera-review-audit-trail-receipt-v1' as const
export const CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION = 'synthetic-camera-review-evidence-manifest-v1' as const

export type AdosCameraControl = {
  id: `ADOS-${string}`
  control: string
  enforcement: string
}

/**
 * Contract-local proof of the non-production boundary. These controls are
 * descriptive evidence only; none grants a device, transport, or launch path.
 */
export const ADOS_10_CAMERA_CONTROLS: readonly AdosCameraControl[] = Object.freeze([
  { id: 'ADOS-01', control: 'PRODUCT_WORKSPACE_ISOLATION', enforcement: 'Every audit and review packet is bound to one product and workspace digest.' },
  { id: 'ADOS-02', control: 'MINIMIZED_SYNTHETIC_FIXTURE', enforcement: 'Only an allowlisted synthetic fixture ID and fixed finding are resolved.' },
  { id: 'ADOS-03', control: 'DEFAULT_DENY_LIVE_DISABLED', enforcement: 'Synthetic enablement and positive limits are required; a live flag is rejected.' },
  { id: 'ADOS-04', control: 'NO_MEDIA_OR_BIOMETRICS', enforcement: 'Unknown, hidden, symbol, proxy, or accessor-shaped input, evidence, D8 caller-context fields, D10 execution-context/provenance-clock values, the D11 runner clock, the D12 governed-run request envelope, and the D13 result/provenance control plane—plus media, device identifiers, identity resolution, and biometric inference—are denied.' },
  { id: 'ADOS-05', control: 'PURPOSE_BOUND_CONSENT', enforcement: 'A granted synthetic KVKK consent assertion must match the selected fixture and purpose.' },
  { id: 'ADOS-06', control: 'OWNER_AND_MAKER_CHECKER', enforcement: 'The governed run requires owner approval and separate request/check actors; review rejects the original maker.' },
  { id: 'ADOS-07', control: 'NO_EGRESS_OR_CREDENTIAL_INTERFACE', enforcement: 'The adapter has no camera SDK, network client, stream URL, credential, or provider configuration surface.' },
  { id: 'ADOS-08', control: 'QUOTA_AND_HASH_AUDIT', enforcement: 'Preflight precedes quota reservation and all governance decisions are appended to the scoped SHA-256 chain; D5 only read-checks a caller-supplied three-event segment, D6/D7 only render minimized evidence, D8/D9 protect review context and its local clock, D10 rejects shaped execution context or an invalid provenance clock before a fixture result, D11 freezes one safe runner timestamp, D12 rejects shaped governed-run envelopes before any collaborator is used, and D13 rejects malformed result/provenance control planes before a success audit.' },
  { id: 'ADOS-09', control: 'OWNER_REVIEW_WITHOUT_HANDOFF', enforcement: 'Review, its receipts, and D4/D5/D6/D7 witnesses record only an approved or rejected decision; D8/D9 validate review context and its local clock, D10 validates only synthetic result provenance, D11 validates only local runner time, D12 validates only the request envelope, and D13 permits only a fixed synthetic/no-egress result control plane; action, notification, publication, and handoff remain not sent.' },
  { id: 'ADOS-10', control: 'NO_LAUNCH_OR_PRODUCTION_WRITE', enforcement: 'No production migration, main/prod write, live launch, or camera connection is part of this connector.' },
])

export type CameraPurpose = 'operational-safety' | 'site-security'
export type CameraConsent = {
  state: 'granted'
  receiptRef: string
  policyVersion: 'kvkk-synthetic-v1'
  sourceRights: 'synthetic-fixture'
}
export type CameraObservationInput = {
  synthetic: true
  cameraFixtureId: string
  purpose: CameraPurpose
  consent: CameraConsent
}

export type CameraOwnerReviewRequired = {
  state: 'OWNER_REVIEW_REQUIRED'
  action: 'NOT_EXECUTED'
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}

export type SyntheticCameraReviewPacket = {
  version: typeof CAMERA_REVIEW_PACKET_VERSION
  reviewId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  observationDigest: string
  integrityDigest: string
  state: 'PENDING_INDEPENDENT_OWNER_REVIEW'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}

export type CameraObservationResult = {
  mode: 'SYNTHETIC'
  liveStatus: typeof CAMERA_LIVE_STATUS
  cameraFixtureId: string
  purpose: CameraPurpose
  observation: {
    category: 'operational-safety' | 'site-security'
    severity: 'info' | 'warning' | 'critical'
    findingCode: string
    summary: string
  }
  privacy: {
    rawMediaAccepted: false
    streamConnectionAttempted: false
    deviceIdentifierRetained: false
    biometricInference: 'NOT_PERFORMED'
    identityResolution: 'NOT_PERFORMED'
    resultPersistence: 'NOT_PERSISTED'
  }
  review: CameraOwnerReviewRequired
  reviewPacket: SyntheticCameraReviewPacket
}

/**
 * A minimized, library-only proof that a D1 review was recorded. It is not a
 * credential, signature, delivery instruction, or authorization to act.
 */
export type SyntheticCameraReviewReceipt = {
  version: typeof CAMERA_REVIEW_RECEIPT_VERSION
  receiptId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  reviewId: string
  observationDigest: string
  reviewPacketIntegrityDigest: string
  reviewerDigest: string
  decision: 'approved' | 'rejected'
  occurredAt: string
  mode: 'SYNTHETIC'
  liveStatus: typeof CAMERA_LIVE_STATUS
  disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
  auditHash: string
  integrityDigest: string
}

/**
 * D4's minimized return value after a caller-supplied audit entry has been
 * checked. It is not durable evidence, an authorization, or an action token.
 */
export type CameraReviewAuditWitness = {
  version: typeof CAMERA_REVIEW_AUDIT_WITNESS_VERSION
  reviewId: string
  auditHash: string
  previousAuditHash: string | null
  state: 'SYNTHETIC_REVIEW_AUDIT_ENTRY_VERIFIED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}

/**
 * D5's minimized return value after a caller-supplied requested/succeeded/
 * owner-review segment has been checked. It does not prove storage state,
 * authorize an action, or carry a replayable capability.
 */
export type CameraReviewAuditTrailWitness = {
  version: typeof CAMERA_REVIEW_AUDIT_TRAIL_WITNESS_VERSION
  reviewId: string
  requestedAuditHash: string
  succeededAuditHash: string
  reviewAuditHash: string
  predecessorHash: string | null
  state: 'SYNTHETIC_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
}

/**
 * D6's portable, minimized rendering of a D5 witness. It is derived only
 * after D5's caller-supplied segment has been revalidated. It is not a
 * signature, a durable audit record, a credential, or an action capability.
 */
export type CameraReviewAuditTrailReceipt = {
  version: typeof CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION
  receiptId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  reviewId: string
  requestedAuditHash: string
  succeededAuditHash: string
  reviewAuditHash: string
  predecessorHash: string | null
  state: 'SYNTHETIC_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
  integrityDigest: string
}

/**
 * D7's compact binding of the independently validated D2 and D6 evidence.
 * It deliberately omits the fixture, observation, reviewer, decision text,
 * and audit hashes. It is never a signature, credential, durable proof, or
 * action capability.
 */
export type CameraReviewEvidenceManifest = {
  version: typeof CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION
  manifestId: string
  scopeBinding: { productDigest: string; workspaceDigest: string }
  reviewId: string
  reviewReceiptIntegrityDigest: string
  auditTrailReceiptIntegrityDigest: string
  state: 'SYNTHETIC_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION'
  rawMediaIncluded: false
  automaticAction: false
  notification: 'NOT_SENT'
  publication: 'NOT_PUBLISHED'
  integrityDigest: string
}

export type ReviewedCameraObservation = {
  reviewId: string
  decision: 'approved' | 'rejected'
  reviewPacketIntegrityDigest: string
  ownerReview: {
    state: 'APPROVED_FOR_SYNTHETIC_OBSERVATION_ONLY' | 'REJECTED_FOR_SYNTHETIC_OBSERVATION_ONLY'
    reviewer: string
    occurredAt: string
  }
  handoff: {
    state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED'
    rawMediaIncluded: false
    sent: false
    automaticAction: false
    notification: 'NOT_SENT'
    publication: 'NOT_PUBLISHED'
  }
  auditHash: string
  reviewReceipt: SyntheticCameraReviewReceipt
}

export type SyntheticCameraConnectorConfig = {
  syntheticEnabled?: boolean
  /** Any attempt to opt in to a live device closes this connector permanently. */
  liveEnabled?: boolean
  maxCostCapCents?: number
  maxItems?: number
}

type CameraFixture = {
  purpose: CameraPurpose
  consentReceiptRef: string
  observation: CameraObservationResult['observation']
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CAMERA_REVIEW_ID_PATTERN = /^synthetic-camera-review-[a-f0-9]{24}$/
const CAMERA_REVIEW_RECEIPT_ID_PATTERN = /^synthetic-camera-review-receipt-[a-f0-9]{24}$/
const CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_ID_PATTERN = /^synthetic-camera-review-audit-trail-receipt-[a-f0-9]{24}$/
const CAMERA_REVIEW_EVIDENCE_MANIFEST_ID_PATTERN = /^synthetic-camera-review-evidence-manifest-[a-f0-9]{24}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CAMERA_REVIEW_CONTEXT_FIELDS = [
  'product', 'workspaceId', 'requestedBy', 'checkedBy', 'correlationId',
  'ownerApproved', 'scopes', 'costCapCents', 'requestedItems', 'now',
] as const

const FIXTURES: Readonly<Record<string, CameraFixture>> = Object.freeze({
  'synthetic-loading-dock-001': {
    purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-001',
    observation: { category: 'operational-safety', severity: 'warning', findingCode: 'PPE_DRILL_INDICATOR', summary: 'Synthetic loading-dock safety drill indicator requires owner review.' },
  },
  'synthetic-perimeter-001': {
    purpose: 'site-security', consentReceiptRef: 'synthetic-consent-security-001',
    observation: { category: 'site-security', severity: 'info', findingCode: 'ACCESS_POINT_DRILL_INDICATOR', summary: 'Synthetic access-point drill indicator requires owner review.' },
  },
  'synthetic-fire-drill-001': {
    purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-002',
    observation: { category: 'operational-safety', severity: 'critical', findingCode: 'FIRE_DRILL_INDICATOR', summary: 'Synthetic fire-drill indicator requires owner review; no action is executed.' },
  },
})

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Accepts only JSON-shaped own data properties, then copies them into a null
 * prototype record. This keeps review evidence parsing from evaluating an
 * accessor and makes non-enumerable/symbol-shaped fields fail closed rather
 * than disappearing from Object.keys()/JSON.stringify().
 */
function exactObject(value: unknown, allowed: readonly string[], error: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorInputError(error)
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.some((key) => !allowed.includes(key))) throw new ConnectorInputError(error)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const key of names) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
    normalized[key] = descriptor.value
  }
  return normalized
}

/** Accepts a dense, ordinary array of own enumerable data strings only. */
function exactStringArray(value: unknown, error: string, maximumItems: number, maximumItemLength: number): string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ConnectorInputError(error)
  if (value.length > maximumItems || Object.getOwnPropertySymbols(value).length > 0) throw new ConnectorInputError(error)
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    throw new ConnectorInputError(error)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
    normalized.push(requiredString(descriptor.value, error, maximumItemLength))
  }
  return normalized
}

function requiredString(value: unknown, error: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength) throw new ConnectorInputError(error)
  return value
}

/**
 * D8 applies D3's own-data rule to every caller-provided review context.
 * It accepts the documented context subsets and the full runner context, but
 * never reads an accessor or a Proxy trap and never tolerates extra fields.
 */
function cameraReviewContextRecord(value: unknown): Record<string, unknown> {
  return exactObject(value, CAMERA_REVIEW_CONTEXT_FIELDS, 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD')
}

function cameraReviewScopeFromRecord(context: Record<string, unknown>): { product: string; workspaceId: string } {
  const product = context.product
  const workspaceId = context.workspaceId
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_CONTEXT')
  }
  return { product, workspaceId }
}

function cameraReviewContext(context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): { product: string; workspaceId: string } {
  return cameraReviewScopeFromRecord(cameraReviewContextRecord(context))
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code < 32 || code === 127)
  })
}

function normalizedActor(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || containsControlCharacter(value)) return null
  const actor = value.trim()
  return ACTOR_PATTERN.test(actor) ? actor : null
}

function reviewActor(value: unknown): string {
  const actor = normalizedActor(value)
  if (!actor) throw new OwnerGateError('CAMERA_REVIEWER_REQUIRED')
  return actor
}

function reviewRequester(value: unknown): string {
  const actor = normalizedActor(value)
  if (!actor) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_REQUESTER')
  return actor
}

function cameraReviewAuditWitnessContextFromRecord(candidate: Record<string, unknown>): { product: string; workspaceId: string; requestedBy: string; correlationId: string; costCapCents: number; requestedItems: number } {
  const scope = cameraReviewScopeFromRecord(candidate)
  const requestedBy = reviewRequester(candidate.requestedBy)
  const correlationId = requiredString(candidate.correlationId, 'INVALID_CAMERA_REVIEW_CONTEXT', 120)
  const costCapCents = positiveInteger(candidate.costCapCents)
  const requestedItems = positiveInteger(candidate.requestedItems)
  if (!SCOPE_ID_PATTERN.test(correlationId) || !costCapCents || !requestedItems) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_CONTEXT')
  return { ...scope, requestedBy, correlationId, costCapCents, requestedItems }
}

function cameraReviewAuditWitnessContext(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): { product: string; workspaceId: string; requestedBy: string; correlationId: string; costCapCents: number; requestedItems: number } {
  return cameraReviewAuditWitnessContextFromRecord(cameraReviewContextRecord(context))
}

function independentCameraReviewContext(context: ConnectorRunContext): { product: string; workspaceId: string; requestedBy: string; correlationId: string; costCapCents: number; requestedItems: number; now: () => Date } {
  const candidate = cameraReviewContextRecord(context)
  const witness = cameraReviewAuditWitnessContextFromRecord(candidate)
  if (typeof candidate.now !== 'function' || nodeTypes.isProxy(candidate.now)) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_CONTEXT')
  return { ...witness, now: candidate.now as () => Date }
}

/**
 * D9/D10 make their only callable context value fail closed. A local clock
 * may supply a native, finite Date only; it cannot provide a forged
 * toISOString implementation or a Proxy-shaped value to an audit append or
 * a synthetic provenance timestamp.
 */
function localCameraOccurredAt(now: () => Date, errorCode: string): string {
  let candidate: unknown
  try {
    candidate = now()
  } catch {
    throw new ConnectorInputError(errorCode)
  }
  if (!nodeTypes.isDate(candidate) || nodeTypes.isProxy(candidate)) throw new ConnectorInputError(errorCode)
  try {
    if (!Number.isFinite(Date.prototype.getTime.call(candidate))) throw new ConnectorInputError(errorCode)
    return canonicalIsoInstant(Date.prototype.toISOString.call(candidate), errorCode)
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError(errorCode)
  }
}

function localReviewOccurredAt(now: () => Date): string {
  return localCameraOccurredAt(now, 'INVALID_CAMERA_REVIEW_CLOCK')
}

type CameraExecutionContext = {
  product: string
  workspaceId: string
  costCapCents: number
  requestedItems: number
  now: () => Date
}

/**
 * D10 applies the strict data boundary to direct adapter execution too. The
 * governed runner already creates this context, but a library caller must not
 * be able to introduce media/device-shaped fields, an accessor, or a Proxy
 * before the fixture or provenance timestamp is resolved.
 */
function cameraExecutionContext(value: unknown): CameraExecutionContext {
  const candidate = exactObject(value, CAMERA_REVIEW_CONTEXT_FIELDS, 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD')
  const scope = cameraReviewScopeFromRecord(candidate)
  const requestedBy = normalizedActor(candidate.requestedBy)
  const checkedBy = normalizedActor(candidate.checkedBy)
  const correlationId = typeof candidate.correlationId === 'string' ? candidate.correlationId : ''
  const scopes = exactStringArray(candidate.scopes, 'INVALID_CAMERA_EXECUTION_CONTEXT_SCOPES', 12, 80)
  const costCapCents = positiveInteger(candidate.costCapCents)
  const requestedItems = positiveInteger(candidate.requestedItems)
  const now = candidate.now
  if (!requestedBy || requestedBy !== candidate.requestedBy || !checkedBy || checkedBy !== candidate.checkedBy || requestedBy === checkedBy || candidate.ownerApproved !== true || !SCOPE_ID_PATTERN.test(correlationId) || scopes.length !== 1 || scopes[0] !== CAMERA_SCOPE || !costCapCents || !requestedItems || typeof now !== 'function' || nodeTypes.isProxy(now)) {
    throw new ConnectorInputError('INVALID_CAMERA_EXECUTION_CONTEXT')
  }
  return { ...scope, costCapCents, requestedItems, now: now as () => Date }
}

function inputFrom(value: unknown): CameraObservationInput {
  const input = exactObject(value, ['synthetic', 'cameraFixtureId', 'purpose', 'consent'], 'SYNTHETIC_CAMERA_INPUT_REQUIRED')
  if (input.synthetic !== true || typeof input.cameraFixtureId !== 'string' || (input.purpose !== 'operational-safety' && input.purpose !== 'site-security')) {
    throw new ConnectorInputError('SYNTHETIC_CAMERA_INPUT_REQUIRED')
  }
  let assertion: Record<string, unknown>
  try {
    assertion = exactObject(input.consent, ['state', 'receiptRef', 'policyVersion', 'sourceRights'], 'CAMERA_CONSENT_REQUIRED')
  } catch (error) {
    if (error instanceof ConnectorInputError) throw new CameraConsentError()
    throw error
  }
  if (assertion.state !== 'granted' || typeof assertion.receiptRef !== 'string' || assertion.policyVersion !== 'kvkk-synthetic-v1' || assertion.sourceRights !== 'synthetic-fixture') {
    throw new CameraConsentError()
  }
  return {
    synthetic: true,
    cameraFixtureId: input.cameraFixtureId,
    purpose: input.purpose,
    consent: { state: 'granted', receiptRef: assertion.receiptRef, policyVersion: 'kvkk-synthetic-v1', sourceRights: 'synthetic-fixture' },
  }
}

function fixtureFor(input: CameraObservationInput): CameraFixture {
  const fixture = FIXTURES[input.cameraFixtureId]
  if (!fixture) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_FIXTURE_NOT_FOUND')
  if (fixture.purpose !== input.purpose || fixture.consentReceiptRef !== input.consent.receiptRef) throw new CameraConsentError('CAMERA_CONSENT_SCOPE_DENIED')
  return fixture
}

function reviewIdFor(product: string, workspaceId: string, cameraFixtureId: string, purpose: CameraPurpose, observationDigest: string): string {
  return `synthetic-camera-review-${digest(`${product}:${workspaceId}:${cameraFixtureId}:${purpose}:${observationDigest}`).slice(0, 24)}`
}

function reviewPacketIntegrityMaterial(result: Omit<CameraObservationResult, 'reviewPacket'>, scopeBinding: SyntheticCameraReviewPacket['scopeBinding'], reviewId: string, observationDigest: string): Record<string, unknown> {
  return {
    reviewId,
    scopeBinding,
    observationDigest,
    mode: result.mode,
    liveStatus: result.liveStatus,
    cameraFixtureId: result.cameraFixtureId,
    purpose: result.purpose,
    observation: result.observation,
    privacy: result.privacy,
    review: result.review,
  }
}

function reviewPacketFor(result: Omit<CameraObservationResult, 'reviewPacket'>, product: string, workspaceId: string): SyntheticCameraReviewPacket {
  const scopeBinding = { productDigest: digest(product), workspaceDigest: digest(workspaceId) }
  const observationDigest = digest(JSON.stringify(result.observation))
  const reviewId = reviewIdFor(product, workspaceId, result.cameraFixtureId, result.purpose, observationDigest)
  return {
    version: CAMERA_REVIEW_PACKET_VERSION,
    reviewId,
    scopeBinding,
    observationDigest,
    integrityDigest: digest(JSON.stringify(reviewPacketIntegrityMaterial(result, scopeBinding, reviewId, observationDigest))),
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
  }
}

type ReviewedCameraObservationDetails = Omit<ReviewedCameraObservation, 'reviewReceipt'>

function reviewStateFor(decision: 'approved' | 'rejected'): ReviewedCameraObservation['ownerReview']['state'] {
  return decision === 'approved' ? 'APPROVED_FOR_SYNTHETIC_OBSERVATION_ONLY' : 'REJECTED_FOR_SYNTHETIC_OBSERVATION_ONLY'
}

function canonicalIsoInstant(value: unknown, error: string): string {
  const instant = requiredString(value, error, 30)
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== instant) throw new ConnectorInputError(error)
  return instant
}

function cameraReviewHandoffForReceipt(value: unknown): ReviewedCameraObservation['handoff'] {
  const handoff = exactObject(value, ['state', 'rawMediaIncluded', 'sent', 'automaticAction', 'notification', 'publication'], 'INVALID_CAMERA_REVIEW_RECEIPT_HANDOFF')
  if (handoff.state !== 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED' || handoff.rawMediaIncluded !== false || handoff.sent !== false || handoff.automaticAction !== false || handoff.notification !== 'NOT_SENT' || handoff.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT_HANDOFF')
  }
  return { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', rawMediaIncluded: false, sent: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
}

function reviewReceiptIntegrityMaterial(receipt: Omit<SyntheticCameraReviewReceipt, 'receiptId' | 'integrityDigest'>): Record<string, unknown> {
  return {
    version: receipt.version,
    scopeBinding: receipt.scopeBinding,
    reviewId: receipt.reviewId,
    observationDigest: receipt.observationDigest,
    reviewPacketIntegrityDigest: receipt.reviewPacketIntegrityDigest,
    reviewerDigest: receipt.reviewerDigest,
    decision: receipt.decision,
    occurredAt: receipt.occurredAt,
    mode: receipt.mode,
    liveStatus: receipt.liveStatus,
    disposition: receipt.disposition,
    rawMediaIncluded: receipt.rawMediaIncluded,
    automaticAction: receipt.automaticAction,
    notification: receipt.notification,
    publication: receipt.publication,
    auditHash: receipt.auditHash,
  }
}

function reviewReceiptFor(result: CameraObservationResult, reviewed: ReviewedCameraObservationDetails, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): SyntheticCameraReviewReceipt {
  const scoped = cameraReviewContext(context)
  const material: Omit<SyntheticCameraReviewReceipt, 'receiptId' | 'integrityDigest'> = {
    version: CAMERA_REVIEW_RECEIPT_VERSION,
    scopeBinding: { productDigest: digest(scoped.product), workspaceDigest: digest(scoped.workspaceId) },
    reviewId: reviewed.reviewId,
    observationDigest: result.reviewPacket.observationDigest,
    reviewPacketIntegrityDigest: reviewed.reviewPacketIntegrityDigest,
    reviewerDigest: digest(reviewed.ownerReview.reviewer),
    decision: reviewed.decision,
    occurredAt: reviewed.ownerReview.occurredAt,
    mode: 'SYNTHETIC',
    liveStatus: CAMERA_LIVE_STATUS,
    disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
    auditHash: reviewed.auditHash,
  }
  const integrityDigest = digest(JSON.stringify(reviewReceiptIntegrityMaterial(material)))
  return {
    ...material,
    receiptId: `synthetic-camera-review-receipt-${digest(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrityDigest,
  }
}

function cameraObservationForReview(value: unknown): CameraObservationResult['observation'] {
  const observation = exactObject(value, ['category', 'severity', 'findingCode', 'summary'], 'INVALID_CAMERA_REVIEW_OBSERVATION')
  const category = observation.category
  const severity = observation.severity
  const findingCode = requiredString(observation.findingCode, 'INVALID_CAMERA_REVIEW_OBSERVATION', 120)
  const summary = requiredString(observation.summary, 'INVALID_CAMERA_REVIEW_OBSERVATION', 320)
  if ((category !== 'operational-safety' && category !== 'site-security') || (severity !== 'info' && severity !== 'warning' && severity !== 'critical')) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_OBSERVATION')
  }
  return { category, severity, findingCode, summary }
}

function cameraPrivacyForReview(value: unknown): CameraObservationResult['privacy'] {
  const privacy = exactObject(value, ['rawMediaAccepted', 'streamConnectionAttempted', 'deviceIdentifierRetained', 'biometricInference', 'identityResolution', 'resultPersistence'], 'INVALID_CAMERA_REVIEW_PRIVACY')
  if (privacy.rawMediaAccepted !== false || privacy.streamConnectionAttempted !== false || privacy.deviceIdentifierRetained !== false || privacy.biometricInference !== 'NOT_PERFORMED' || privacy.identityResolution !== 'NOT_PERFORMED' || privacy.resultPersistence !== 'NOT_PERSISTED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PRIVACY')
  }
  return { rawMediaAccepted: false, streamConnectionAttempted: false, deviceIdentifierRetained: false, biometricInference: 'NOT_PERFORMED', identityResolution: 'NOT_PERFORMED', resultPersistence: 'NOT_PERSISTED' }
}

function cameraOwnerReviewForReview(value: unknown): CameraOwnerReviewRequired {
  const review = exactObject(value, ['state', 'action', 'notification', 'publication'], 'INVALID_CAMERA_OWNER_REVIEW')
  if (review.state !== 'OWNER_REVIEW_REQUIRED' || review.action !== 'NOT_EXECUTED' || review.notification !== 'NOT_SENT' || review.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_OWNER_REVIEW')
  }
  return { state: 'OWNER_REVIEW_REQUIRED', action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
}

/**
 * Revalidates a returned fixture result before a review decision can append an
 * audit event. The SHA-256 packet is an unkeyed mutation check, not a secret,
 * signature, credential, authorization grant, or delivery capability.
 */
export function validateCameraObservationForReview(value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): CameraObservationResult {
  const scoped = cameraReviewContext(context)
  const result = exactObject(value, ['mode', 'liveStatus', 'cameraFixtureId', 'purpose', 'observation', 'privacy', 'review', 'reviewPacket'], 'UNEXPECTED_CAMERA_REVIEW_RESULT_FIELD')
  if (result.mode !== 'SYNTHETIC' || result.liveStatus !== CAMERA_LIVE_STATUS) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_MODE')
  const cameraFixtureId = requiredString(result.cameraFixtureId, 'INVALID_CAMERA_REVIEW_FIXTURE', 120)
  if (result.purpose !== 'operational-safety' && result.purpose !== 'site-security') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PURPOSE')
  const purpose = result.purpose
  const fixture = FIXTURES[cameraFixtureId]
  if (!fixture || fixture.purpose !== purpose) throw new ConnectorInputError('CAMERA_REVIEW_FIXTURE_MISMATCH')
  const observation = cameraObservationForReview(result.observation)
  if (JSON.stringify(observation) !== JSON.stringify(fixture.observation)) throw new ConnectorInputError('CAMERA_REVIEW_OBSERVATION_MISMATCH')
  const privacy = cameraPrivacyForReview(result.privacy)
  const review = cameraOwnerReviewForReview(result.review)

  const packet = exactObject(result.reviewPacket, ['version', 'reviewId', 'scopeBinding', 'observationDigest', 'integrityDigest', 'state', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication'], 'UNEXPECTED_CAMERA_REVIEW_PACKET_FIELD')
  const scopeBinding = exactObject(packet.scopeBinding, ['productDigest', 'workspaceDigest'], 'UNEXPECTED_CAMERA_REVIEW_PACKET_SCOPE_FIELD')
  const productDigest = requiredString(scopeBinding.productDigest, 'INVALID_CAMERA_REVIEW_PACKET_SCOPE', 64)
  const workspaceDigest = requiredString(scopeBinding.workspaceDigest, 'INVALID_CAMERA_REVIEW_PACKET_SCOPE', 64)
  const observationDigest = requiredString(packet.observationDigest, 'INVALID_CAMERA_REVIEW_PACKET_DIGEST', 64)
  const integrityDigest = requiredString(packet.integrityDigest, 'INVALID_CAMERA_REVIEW_PACKET_DIGEST', 64)
  const reviewId = requiredString(packet.reviewId, 'INVALID_CAMERA_REVIEW_ID', 64)
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(observationDigest) || !SHA256_PATTERN.test(integrityDigest) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PACKET_DIGEST')
  }
  if (packet.version !== CAMERA_REVIEW_PACKET_VERSION || packet.state !== 'PENDING_INDEPENDENT_OWNER_REVIEW' || packet.rawMediaIncluded !== false || packet.automaticAction !== false || packet.notification !== 'NOT_SENT' || packet.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PACKET')
  }
  if (productDigest !== digest(scoped.product) || workspaceDigest !== digest(scoped.workspaceId)) throw new ConnectorInputError('CAMERA_REVIEW_PACKET_SCOPE_MISMATCH')
  const normalizedWithoutPacket: Omit<CameraObservationResult, 'reviewPacket'> = { mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, cameraFixtureId, purpose, observation, privacy, review }
  const expectedObservationDigest = digest(JSON.stringify(observation))
  const expectedReviewId = reviewIdFor(scoped.product, scoped.workspaceId, cameraFixtureId, purpose, expectedObservationDigest)
  if (observationDigest !== expectedObservationDigest || reviewId !== expectedReviewId) throw new ConnectorInputError('CAMERA_REVIEW_PACKET_BINDING_MISMATCH')
  const reviewPacket: SyntheticCameraReviewPacket = {
    version: CAMERA_REVIEW_PACKET_VERSION, reviewId, scopeBinding: { productDigest, workspaceDigest }, observationDigest, integrityDigest,
    state: 'PENDING_INDEPENDENT_OWNER_REVIEW', rawMediaIncluded: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED',
  }
  if (integrityDigest !== digest(JSON.stringify(reviewPacketIntegrityMaterial(normalizedWithoutPacket, reviewPacket.scopeBinding, reviewId, observationDigest)))) {
    throw new ConnectorInputError('CAMERA_REVIEW_PACKET_INTEGRITY_MISMATCH')
  }
  return { ...normalizedWithoutPacket, reviewPacket }
}

function reviewedCameraObservationForReceipt(value: unknown): { reviewed: ReviewedCameraObservationDetails; receipt: unknown } {
  const candidate = exactObject(value, ['reviewId', 'decision', 'reviewPacketIntegrityDigest', 'ownerReview', 'handoff', 'auditHash', 'reviewReceipt'], 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD')
  const reviewId = requiredString(candidate.reviewId, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewPacketIntegrityDigest = requiredString(candidate.reviewPacketIntegrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const auditHash = requiredString(candidate.auditHash, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  if (!CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(reviewPacketIntegrityDigest) || !SHA256_PATTERN.test(auditHash)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  }
  if (candidate.decision !== 'approved' && candidate.decision !== 'rejected') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  const ownerReview = exactObject(candidate.ownerReview, ['state', 'reviewer', 'occurredAt'], 'INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  const reviewer = normalizedActor(ownerReview.reviewer)
  const occurredAt = canonicalIsoInstant(ownerReview.occurredAt, 'INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  if (!reviewer || reviewer !== ownerReview.reviewer || ownerReview.state !== reviewStateFor(candidate.decision)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT_OWNER_REVIEW')
  }
  return {
    reviewed: {
      reviewId,
      decision: candidate.decision,
      reviewPacketIntegrityDigest,
      ownerReview: { state: reviewStateFor(candidate.decision), reviewer, occurredAt },
      handoff: cameraReviewHandoffForReceipt(candidate.handoff),
      auditHash,
    },
    receipt: candidate.reviewReceipt,
  }
}

function cameraReviewReceiptForReview(value: unknown): SyntheticCameraReviewReceipt {
  const receipt = exactObject(value, ['version', 'receiptId', 'scopeBinding', 'reviewId', 'observationDigest', 'reviewPacketIntegrityDigest', 'reviewerDigest', 'decision', 'occurredAt', 'mode', 'liveStatus', 'disposition', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication', 'auditHash', 'integrityDigest'], 'UNEXPECTED_CAMERA_REVIEW_RECEIPT_FIELD')
  const scopeBinding = exactObject(receipt.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE')
  const productDigest = requiredString(scopeBinding.productDigest, 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE', 64)
  const workspaceDigest = requiredString(scopeBinding.workspaceDigest, 'INVALID_CAMERA_REVIEW_RECEIPT_SCOPE', 64)
  const receiptId = requiredString(receipt.receiptId, 'INVALID_CAMERA_REVIEW_RECEIPT', 72)
  const reviewId = requiredString(receipt.reviewId, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const observationDigest = requiredString(receipt.observationDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewPacketIntegrityDigest = requiredString(receipt.reviewPacketIntegrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const reviewerDigest = requiredString(receipt.reviewerDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const auditHash = requiredString(receipt.auditHash, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const integrityDigest = requiredString(receipt.integrityDigest, 'INVALID_CAMERA_REVIEW_RECEIPT', 64)
  const occurredAt = canonicalIsoInstant(receipt.occurredAt, 'INVALID_CAMERA_REVIEW_RECEIPT')
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !CAMERA_REVIEW_RECEIPT_ID_PATTERN.test(receiptId) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(observationDigest) || !SHA256_PATTERN.test(reviewPacketIntegrityDigest) || !SHA256_PATTERN.test(reviewerDigest) || !SHA256_PATTERN.test(auditHash) || !SHA256_PATTERN.test(integrityDigest)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  }
  if (receipt.version !== CAMERA_REVIEW_RECEIPT_VERSION || (receipt.decision !== 'approved' && receipt.decision !== 'rejected') || receipt.mode !== 'SYNTHETIC' || receipt.liveStatus !== CAMERA_LIVE_STATUS || receipt.disposition !== 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION' || receipt.rawMediaIncluded !== false || receipt.automaticAction !== false || receipt.notification !== 'NOT_SENT' || receipt.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_RECEIPT')
  }
  return {
    version: CAMERA_REVIEW_RECEIPT_VERSION,
    receiptId,
    scopeBinding: { productDigest, workspaceDigest },
    reviewId,
    observationDigest,
    reviewPacketIntegrityDigest,
    reviewerDigest,
    decision: receipt.decision,
    occurredAt,
    mode: 'SYNTHETIC',
    liveStatus: CAMERA_LIVE_STATUS,
    disposition: 'SYNTHETIC_REVIEW_RECORDED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
    auditHash,
    integrityDigest,
  }
}

/**
 * D2 revalidates a minimized D1 review receipt without reading storage or
 * performing any action. It is an in-process mutation check, not audit-chain
 * lookup, authorization, delivery, or a substitute for a future owner host.
 */
export function validateCameraReviewReceipt(sourceResult: unknown, value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): ReviewedCameraObservation {
  const source = validateCameraObservationForReview(sourceResult, context)
  const candidate = reviewedCameraObservationForReceipt(value)
  const receipt = cameraReviewReceiptForReview(candidate.receipt)
  const expected = reviewReceiptFor(source, candidate.reviewed, context)
  if (candidate.reviewed.reviewId !== source.reviewPacket.reviewId || candidate.reviewed.reviewPacketIntegrityDigest !== source.reviewPacket.integrityDigest) {
    throw new ConnectorInputError('CAMERA_REVIEW_RECEIPT_PACKET_MISMATCH')
  }
  if (receipt.integrityDigest !== digest(JSON.stringify(reviewReceiptIntegrityMaterial(receipt))) || receipt.receiptId !== expected.receiptId || receipt.integrityDigest !== expected.integrityDigest) {
    throw new ConnectorInputError('CAMERA_REVIEW_RECEIPT_INTEGRITY_MISMATCH')
  }
  return { ...candidate.reviewed, reviewReceipt: expected }
}

type CameraReviewAuditEntry = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function cameraReviewAuditEntry(value: unknown): CameraReviewAuditEntry {
  const entry = exactObject(value, ['event', 'previousHash', 'hash'], 'UNEXPECTED_CAMERA_REVIEW_AUDIT_FIELD')
  const event = exactObject(entry.event, ['type', 'connectorId', 'product', 'workspaceId', 'requestedBy', 'checkedBy', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'], 'UNEXPECTED_CAMERA_REVIEW_AUDIT_EVENT_FIELD')
  const type = requiredString(event.type, 'INVALID_CAMERA_REVIEW_AUDIT', 80)
  const connectorId = requiredString(event.connectorId, 'INVALID_CAMERA_REVIEW_AUDIT', 80)
  const product = requiredString(event.product, 'INVALID_CAMERA_REVIEW_AUDIT', 120)
  const workspaceId = requiredString(event.workspaceId, 'INVALID_CAMERA_REVIEW_AUDIT', 120)
  const requestedBy = normalizedActor(event.requestedBy)
  const checkedBy = normalizedActor(event.checkedBy)
  const correlationId = requiredString(event.correlationId, 'INVALID_CAMERA_REVIEW_AUDIT', 120)
  const scopes = exactStringArray(event.scopes, 'INVALID_CAMERA_REVIEW_AUDIT_SCOPES', 12, 80)
  const costCapCents = positiveInteger(event.costCapCents)
  const requestedItems = positiveInteger(event.requestedItems)
  const occurredAt = canonicalIsoInstant(event.occurredAt, 'INVALID_CAMERA_REVIEW_AUDIT')
  const detail = exactObject(event.detail, ['reviewId', 'decision', 'observationDigest', 'reviewPacketIntegrityDigest', 'rawMediaIncluded', 'action', 'notification', 'publication', 'handoff'], 'UNEXPECTED_CAMERA_REVIEW_AUDIT_DETAIL_FIELD')
  const reviewId = requiredString(detail.reviewId, 'INVALID_CAMERA_REVIEW_AUDIT', 64)
  const observationDigest = requiredString(detail.observationDigest, 'INVALID_CAMERA_REVIEW_AUDIT', 64)
  const reviewPacketIntegrityDigest = requiredString(detail.reviewPacketIntegrityDigest, 'INVALID_CAMERA_REVIEW_AUDIT', 64)
  const previousHash = entry.previousHash
  const hash = requiredString(entry.hash, 'INVALID_CAMERA_REVIEW_AUDIT', 64)
  if (!requestedBy || requestedBy !== event.requestedBy || !checkedBy || checkedBy !== event.checkedBy || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId) || !SCOPE_ID_PATTERN.test(correlationId) || !costCapCents || !requestedItems || !CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(observationDigest) || !SHA256_PATTERN.test(reviewPacketIntegrityDigest) || (previousHash !== null && (typeof previousHash !== 'string' || !SHA256_PATTERN.test(previousHash))) || !SHA256_PATTERN.test(hash)) {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_AUDIT')
  }
  if ((detail.decision !== 'approved' && detail.decision !== 'rejected') || detail.rawMediaIncluded !== false || detail.action !== 'NOT_EXECUTED' || detail.notification !== 'NOT_SENT' || detail.publication !== 'NOT_PUBLISHED' || detail.handoff !== 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_AUDIT')
  }
  return {
    event: {
      type: type as ConnectorAuditEvent['type'], connectorId, product, workspaceId, requestedBy, checkedBy, correlationId, scopes,
      costCapCents, requestedItems, occurredAt,
      detail: { reviewId, decision: detail.decision, observationDigest, reviewPacketIntegrityDigest, rawMediaIncluded: false, action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED', handoff: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED' },
    },
    previousHash,
    hash,
  }
}

/**
 * D4 matches a caller-supplied, already-read hash-chain entry to a D1/D2
 * review. It is fully read-only: it neither queries the audit store nor proves
 * that a supplied predecessor exists, and it never grants an action capability.
 */
export function validateCameraReviewAuditWitness(sourceResult: unknown, reviewedResult: unknown, auditEntry: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewAuditWitness {
  const witnessContext = cameraReviewAuditWitnessContext(context)
  const source = validateCameraObservationForReview(sourceResult, witnessContext)
  const reviewed = validateCameraReviewReceipt(source, reviewedResult, witnessContext)
  const entry = cameraReviewAuditEntry(auditEntry)
  if (entry.hash !== hashAuditEvent(entry.event, entry.previousHash)) throw new ConnectorInputError('CAMERA_REVIEW_AUDIT_HASH_MISMATCH')
  const detail = entry.event.detail
  if (entry.event.type !== 'connector.camera.owner_reviewed' || entry.event.connectorId !== CAMERA_CONNECTOR_ID || entry.event.product !== witnessContext.product || entry.event.workspaceId !== witnessContext.workspaceId || entry.event.requestedBy !== witnessContext.requestedBy || entry.event.checkedBy !== reviewed.ownerReview.reviewer || entry.event.correlationId !== witnessContext.correlationId || entry.event.scopes.length !== 1 || entry.event.scopes[0] !== CAMERA_SCOPE || entry.event.costCapCents !== witnessContext.costCapCents || entry.event.requestedItems !== witnessContext.requestedItems || entry.event.occurredAt !== reviewed.ownerReview.occurredAt || detail.reviewId !== source.reviewPacket.reviewId || detail.decision !== reviewed.decision || detail.observationDigest !== source.reviewPacket.observationDigest || detail.reviewPacketIntegrityDigest !== source.reviewPacket.integrityDigest || entry.hash !== reviewed.auditHash) {
    throw new ConnectorInputError('CAMERA_REVIEW_AUDIT_MISMATCH')
  }
  return {
    version: CAMERA_REVIEW_AUDIT_WITNESS_VERSION,
    reviewId: source.reviewPacket.reviewId,
    auditHash: entry.hash,
    previousAuditHash: entry.previousHash,
    state: 'SYNTHETIC_REVIEW_AUDIT_ENTRY_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
  }
}

type CameraGovernedRunAuditEntry = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function cameraGovernedRunAuditEntry(value: unknown, expectedType: 'connector.run.requested' | 'connector.run.succeeded'): CameraGovernedRunAuditEntry {
  const entry = exactObject(value, ['event', 'previousHash', 'hash'], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_ENTRY_FIELD')
  const event = exactObject(entry.event, ['type', 'connectorId', 'product', 'workspaceId', 'requestedBy', 'checkedBy', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_EVENT_FIELD')
  const type = requiredString(event.type, 'INVALID_CAMERA_AUDIT_TRAIL', 80)
  const connectorId = requiredString(event.connectorId, 'INVALID_CAMERA_AUDIT_TRAIL', 80)
  const product = requiredString(event.product, 'INVALID_CAMERA_AUDIT_TRAIL', 120)
  const workspaceId = requiredString(event.workspaceId, 'INVALID_CAMERA_AUDIT_TRAIL', 120)
  const requestedBy = normalizedActor(event.requestedBy)
  const checkedBy = normalizedActor(event.checkedBy)
  const correlationId = requiredString(event.correlationId, 'INVALID_CAMERA_AUDIT_TRAIL', 120)
  const scopes = exactStringArray(event.scopes, 'INVALID_CAMERA_AUDIT_TRAIL_SCOPES', 12, 80)
  const costCapCents = positiveInteger(event.costCapCents)
  const requestedItems = positiveInteger(event.requestedItems)
  const occurredAt = canonicalIsoInstant(event.occurredAt, 'INVALID_CAMERA_AUDIT_TRAIL')
  const detail = expectedType === 'connector.run.requested'
    ? exactObject(event.detail, [], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_REQUESTED_DETAIL_FIELD')
    : exactObject(event.detail, ['requestedAuditHash'], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_SUCCEEDED_DETAIL_FIELD')
  const previousHash = entry.previousHash
  const hash = requiredString(entry.hash, 'INVALID_CAMERA_AUDIT_TRAIL', 64)
  const requestedAuditHash = expectedType === 'connector.run.succeeded'
    ? requiredString(detail.requestedAuditHash, 'INVALID_CAMERA_AUDIT_TRAIL', 64)
    : undefined

  if (type !== expectedType || connectorId !== CAMERA_CONNECTOR_ID || !requestedBy || requestedBy !== event.requestedBy || !checkedBy || checkedBy !== event.checkedBy || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId) || !SCOPE_ID_PATTERN.test(correlationId) || !costCapCents || !requestedItems || (previousHash !== null && (typeof previousHash !== 'string' || !SHA256_PATTERN.test(previousHash))) || !SHA256_PATTERN.test(hash) || (requestedAuditHash !== undefined && !SHA256_PATTERN.test(requestedAuditHash))) {
    throw new ConnectorInputError('INVALID_CAMERA_AUDIT_TRAIL')
  }

  return {
    event: {
      type: expectedType, connectorId, product, workspaceId, requestedBy, checkedBy, correlationId, scopes,
      costCapCents, requestedItems, occurredAt,
      detail: expectedType === 'connector.run.requested' ? {} : { requestedAuditHash },
    },
    previousHash,
    hash,
  }
}

function auditTrailContext(context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): { product: string; workspaceId: string; requestedBy: string; checkedBy: string; correlationId: string; costCapCents: number; requestedItems: number } {
  const candidate = cameraReviewContextRecord(context)
  const scope = cameraReviewScopeFromRecord(candidate)
  const requestedBy = normalizedActor(candidate.requestedBy)
  const checkedBy = normalizedActor(candidate.checkedBy)
  const correlationId = typeof candidate.correlationId === 'string' ? candidate.correlationId : ''
  const costCapCents = positiveInteger(candidate.costCapCents)
  const requestedItems = positiveInteger(candidate.requestedItems)
  if (!requestedBy || requestedBy !== candidate.requestedBy || !checkedBy || checkedBy !== candidate.checkedBy || requestedBy === checkedBy || !SCOPE_ID_PATTERN.test(correlationId) || !costCapCents || !requestedItems) {
    throw new ConnectorInputError('INVALID_CAMERA_AUDIT_TRAIL_CONTEXT')
  }
  return { ...scope, requestedBy, checkedBy, correlationId, costCapCents, requestedItems }
}

function governedRunEventMatches(entry: CameraGovernedRunAuditEntry, context: ReturnType<typeof auditTrailContext>): boolean {
  return entry.event.connectorId === CAMERA_CONNECTOR_ID && entry.event.product === context.product && entry.event.workspaceId === context.workspaceId && entry.event.requestedBy === context.requestedBy && entry.event.checkedBy === context.checkedBy && entry.event.correlationId === context.correlationId && entry.event.scopes.length === 1 && entry.event.scopes[0] === CAMERA_SCOPE && entry.event.costCapCents === context.costCapCents && entry.event.requestedItems === context.requestedItems
}

/**
 * D5 verifies only a caller-supplied three-entry audit segment: governed run
 * requested, governed run succeeded, then D1 owner review. It does not query
 * or write storage, consume quota, prove a durable predecessor, authenticate
 * a reviewer, send a handoff, or authorize an action.
 */
export function validateCameraReviewAuditTrailWitness(sourceResult: unknown, reviewedResult: unknown, auditTrail: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewAuditTrailWitness {
  const trailContext = auditTrailContext(context)
  const trail = exactObject(auditTrail, ['requestedRun', 'succeededRun', 'ownerReview'], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_FIELD')
  const requested = cameraGovernedRunAuditEntry(trail.requestedRun, 'connector.run.requested')
  const succeeded = cameraGovernedRunAuditEntry(trail.succeededRun, 'connector.run.succeeded')
  const reviewed = cameraReviewAuditEntry(trail.ownerReview)

  if (requested.hash !== hashAuditEvent(requested.event, requested.previousHash) || succeeded.hash !== hashAuditEvent(succeeded.event, succeeded.previousHash) || reviewed.hash !== hashAuditEvent(reviewed.event, reviewed.previousHash)) {
    throw new ConnectorInputError('CAMERA_AUDIT_TRAIL_HASH_MISMATCH')
  }
  if (!governedRunEventMatches(requested, trailContext) || !governedRunEventMatches(succeeded, trailContext)) {
    throw new ConnectorInputError('CAMERA_AUDIT_TRAIL_MISMATCH')
  }
  if (succeeded.event.detail.requestedAuditHash !== requested.hash || succeeded.previousHash !== requested.hash || reviewed.previousHash !== succeeded.hash) {
    throw new ConnectorInputError('CAMERA_AUDIT_TRAIL_CHAIN_MISMATCH')
  }
  if (new Date(requested.event.occurredAt).getTime() > new Date(succeeded.event.occurredAt).getTime() || new Date(succeeded.event.occurredAt).getTime() > new Date(reviewed.event.occurredAt).getTime()) {
    throw new ConnectorInputError('CAMERA_AUDIT_TRAIL_TIME_MISMATCH')
  }

  const witness = validateCameraReviewAuditWitness(sourceResult, reviewedResult, trail.ownerReview, trailContext)
  return {
    version: CAMERA_REVIEW_AUDIT_TRAIL_WITNESS_VERSION,
    reviewId: witness.reviewId,
    requestedAuditHash: requested.hash,
    succeededAuditHash: succeeded.hash,
    reviewAuditHash: witness.auditHash,
    predecessorHash: requested.previousHash,
    state: 'SYNTHETIC_REVIEW_AUDIT_TRAIL_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
  }
}

function reviewAuditTrailReceiptIntegrityMaterial(receipt: Omit<CameraReviewAuditTrailReceipt, 'receiptId' | 'integrityDigest'>): Record<string, unknown> {
  return {
    version: receipt.version,
    scopeBinding: receipt.scopeBinding,
    reviewId: receipt.reviewId,
    requestedAuditHash: receipt.requestedAuditHash,
    succeededAuditHash: receipt.succeededAuditHash,
    reviewAuditHash: receipt.reviewAuditHash,
    predecessorHash: receipt.predecessorHash,
    state: receipt.state,
    rawMediaIncluded: receipt.rawMediaIncluded,
    automaticAction: receipt.automaticAction,
    notification: receipt.notification,
    publication: receipt.publication,
  }
}

function reviewAuditTrailReceiptFor(witness: CameraReviewAuditTrailWitness, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): CameraReviewAuditTrailReceipt {
  const scope = cameraReviewContext(context)
  const material: Omit<CameraReviewAuditTrailReceipt, 'receiptId' | 'integrityDigest'> = {
    version: CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION,
    scopeBinding: { productDigest: digest(scope.product), workspaceDigest: digest(scope.workspaceId) },
    reviewId: witness.reviewId,
    requestedAuditHash: witness.requestedAuditHash,
    succeededAuditHash: witness.succeededAuditHash,
    reviewAuditHash: witness.reviewAuditHash,
    predecessorHash: witness.predecessorHash,
    state: 'SYNTHETIC_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
  }
  const integrityDigest = digest(JSON.stringify(reviewAuditTrailReceiptIntegrityMaterial(material)))
  return {
    ...material,
    receiptId: `synthetic-camera-review-audit-trail-receipt-${digest(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrityDigest,
  }
}

function cameraReviewAuditTrailReceipt(value: unknown): CameraReviewAuditTrailReceipt {
  const receipt = exactObject(value, ['version', 'receiptId', 'scopeBinding', 'reviewId', 'requestedAuditHash', 'succeededAuditHash', 'reviewAuditHash', 'predecessorHash', 'state', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication', 'integrityDigest'], 'UNEXPECTED_CAMERA_AUDIT_TRAIL_RECEIPT_FIELD')
  const scopeBinding = exactObject(receipt.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT_SCOPE')
  const receiptId = requiredString(receipt.receiptId, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 84)
  const reviewId = requiredString(receipt.reviewId, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 64)
  const productDigest = requiredString(scopeBinding.productDigest, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT_SCOPE', 64)
  const workspaceDigest = requiredString(scopeBinding.workspaceDigest, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT_SCOPE', 64)
  const requestedAuditHash = requiredString(receipt.requestedAuditHash, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 64)
  const succeededAuditHash = requiredString(receipt.succeededAuditHash, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 64)
  const reviewAuditHash = requiredString(receipt.reviewAuditHash, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 64)
  const integrityDigest = requiredString(receipt.integrityDigest, 'INVALID_CAMERA_AUDIT_TRAIL_RECEIPT', 64)
  const predecessorHash = receipt.predecessorHash
  if (receipt.version !== CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION || !CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_ID_PATTERN.test(receiptId) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(requestedAuditHash) || !SHA256_PATTERN.test(succeededAuditHash) || !SHA256_PATTERN.test(reviewAuditHash) || !SHA256_PATTERN.test(integrityDigest) || (predecessorHash !== null && (typeof predecessorHash !== 'string' || !SHA256_PATTERN.test(predecessorHash))) || receipt.state !== 'SYNTHETIC_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION' || receipt.rawMediaIncluded !== false || receipt.automaticAction !== false || receipt.notification !== 'NOT_SENT' || receipt.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_AUDIT_TRAIL_RECEIPT')
  }
  return {
    version: CAMERA_REVIEW_AUDIT_TRAIL_RECEIPT_VERSION,
    receiptId,
    scopeBinding: { productDigest, workspaceDigest },
    reviewId,
    requestedAuditHash,
    succeededAuditHash,
    reviewAuditHash,
    predecessorHash,
    state: 'SYNTHETIC_REVIEW_AUDIT_TRAIL_RECEIPT_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
    integrityDigest,
  }
}

/**
 * D6 derives a minimized receipt only after the D5 segment is reconstructed.
 * It is library-only and read-only: no storage read/write, quota use, route,
 * actor authentication, notification, handoff, publication, or action occurs.
 */
export function createCameraReviewAuditTrailReceipt(sourceResult: unknown, reviewedResult: unknown, auditTrail: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewAuditTrailReceipt {
  return reviewAuditTrailReceiptFor(validateCameraReviewAuditTrailWitness(sourceResult, reviewedResult, auditTrail, context), context)
}

/**
 * D6 rechecks a caller-supplied receipt by rebuilding D5's fixed witness.
 * Its digest is deliberately unkeyed mutation evidence, never authorization.
 */
export function validateCameraReviewAuditTrailReceipt(sourceResult: unknown, reviewedResult: unknown, auditTrail: unknown, value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewAuditTrailReceipt {
  const receipt = cameraReviewAuditTrailReceipt(value)
  const expected = createCameraReviewAuditTrailReceipt(sourceResult, reviewedResult, auditTrail, context)
  if (receipt.integrityDigest !== digest(JSON.stringify(reviewAuditTrailReceiptIntegrityMaterial(receipt))) || receipt.receiptId !== expected.receiptId || receipt.integrityDigest !== expected.integrityDigest) {
    throw new ConnectorInputError('CAMERA_AUDIT_TRAIL_RECEIPT_INTEGRITY_MISMATCH')
  }
  return expected
}

function reviewEvidenceManifestIntegrityMaterial(manifest: Omit<CameraReviewEvidenceManifest, 'manifestId' | 'integrityDigest'>): Record<string, unknown> {
  return {
    version: manifest.version,
    scopeBinding: manifest.scopeBinding,
    reviewId: manifest.reviewId,
    reviewReceiptIntegrityDigest: manifest.reviewReceiptIntegrityDigest,
    auditTrailReceiptIntegrityDigest: manifest.auditTrailReceiptIntegrityDigest,
    state: manifest.state,
    rawMediaIncluded: manifest.rawMediaIncluded,
    automaticAction: manifest.automaticAction,
    notification: manifest.notification,
    publication: manifest.publication,
  }
}

function reviewEvidenceManifestFor(reviewed: ReviewedCameraObservation, auditTrailReceipt: CameraReviewAuditTrailReceipt, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): CameraReviewEvidenceManifest {
  const scope = cameraReviewContext(context)
  const material: Omit<CameraReviewEvidenceManifest, 'manifestId' | 'integrityDigest'> = {
    version: CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION,
    scopeBinding: { productDigest: digest(scope.product), workspaceDigest: digest(scope.workspaceId) },
    reviewId: reviewed.reviewId,
    reviewReceiptIntegrityDigest: reviewed.reviewReceipt.integrityDigest,
    auditTrailReceiptIntegrityDigest: auditTrailReceipt.integrityDigest,
    state: 'SYNTHETIC_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
  }
  const integrityDigest = digest(JSON.stringify(reviewEvidenceManifestIntegrityMaterial(material)))
  return {
    ...material,
    manifestId: `synthetic-camera-review-evidence-manifest-${digest(`${material.reviewId}:${integrityDigest}`).slice(0, 24)}`,
    integrityDigest,
  }
}

function cameraReviewEvidenceManifest(value: unknown): CameraReviewEvidenceManifest {
  const manifest = exactObject(value, ['version', 'manifestId', 'scopeBinding', 'reviewId', 'reviewReceiptIntegrityDigest', 'auditTrailReceiptIntegrityDigest', 'state', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication', 'integrityDigest'], 'UNEXPECTED_CAMERA_REVIEW_EVIDENCE_MANIFEST_FIELD')
  const scopeBinding = exactObject(manifest.scopeBinding, ['productDigest', 'workspaceDigest'], 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST_SCOPE')
  const manifestId = requiredString(manifest.manifestId, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST', 80)
  const reviewId = requiredString(manifest.reviewId, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST', 64)
  const productDigest = requiredString(scopeBinding.productDigest, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST_SCOPE', 64)
  const workspaceDigest = requiredString(scopeBinding.workspaceDigest, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST_SCOPE', 64)
  const reviewReceiptIntegrityDigest = requiredString(manifest.reviewReceiptIntegrityDigest, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST', 64)
  const auditTrailReceiptIntegrityDigest = requiredString(manifest.auditTrailReceiptIntegrityDigest, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST', 64)
  const integrityDigest = requiredString(manifest.integrityDigest, 'INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST', 64)
  if (manifest.version !== CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION || !CAMERA_REVIEW_EVIDENCE_MANIFEST_ID_PATTERN.test(manifestId) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId) || !SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(reviewReceiptIntegrityDigest) || !SHA256_PATTERN.test(auditTrailReceiptIntegrityDigest) || !SHA256_PATTERN.test(integrityDigest) || manifest.state !== 'SYNTHETIC_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION' || manifest.rawMediaIncluded !== false || manifest.automaticAction !== false || manifest.notification !== 'NOT_SENT' || manifest.publication !== 'NOT_PUBLISHED') {
    throw new ConnectorInputError('INVALID_CAMERA_REVIEW_EVIDENCE_MANIFEST')
  }
  return {
    version: CAMERA_REVIEW_EVIDENCE_MANIFEST_VERSION,
    manifestId,
    scopeBinding: { productDigest, workspaceDigest },
    reviewId,
    reviewReceiptIntegrityDigest,
    auditTrailReceiptIntegrityDigest,
    state: 'SYNTHETIC_REVIEW_EVIDENCE_MANIFEST_VERIFIED_NO_ACTION',
    rawMediaIncluded: false,
    automaticAction: false,
    notification: 'NOT_SENT',
    publication: 'NOT_PUBLISHED',
    integrityDigest,
  }
}

/**
 * D7 derives a compact evidence manifest only after D2 and D6 independently
 * reconstruct the same supplied review and audit segment. It is library-only
 * and read-only: no storage read/write, quota use, route, delivery, or action.
 */
export function createCameraReviewEvidenceManifest(sourceResult: unknown, reviewedResult: unknown, auditTrail: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewEvidenceManifest {
  const auditTrailReceipt = createCameraReviewAuditTrailReceipt(sourceResult, reviewedResult, auditTrail, context)
  const reviewed = validateCameraReviewReceipt(sourceResult, reviewedResult, context)
  return reviewEvidenceManifestFor(reviewed, auditTrailReceipt, context)
}

/**
 * D7 checks a caller-supplied manifest against freshly reconstructed D2/D6
 * evidence. Its digest is unkeyed mutation evidence, never authorization.
 */
export function validateCameraReviewEvidenceManifest(sourceResult: unknown, reviewedResult: unknown, auditTrail: unknown, value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'requestedBy' | 'checkedBy' | 'correlationId' | 'costCapCents' | 'requestedItems'>): CameraReviewEvidenceManifest {
  const manifest = cameraReviewEvidenceManifest(value)
  const expected = createCameraReviewEvidenceManifest(sourceResult, reviewedResult, auditTrail, context)
  if (manifest.integrityDigest !== digest(JSON.stringify(reviewEvidenceManifestIntegrityMaterial(manifest))) || manifest.manifestId !== expected.manifestId || manifest.integrityDigest !== expected.integrityDigest) {
    throw new ConnectorInputError('CAMERA_REVIEW_EVIDENCE_MANIFEST_INTEGRITY_MISMATCH')
  }
  return expected
}

/**
 * Records an independent synthetic-only review decision. It never mutates a
 * camera result, starts an action, contacts a device, sends a handoff, or
 * publishes anything. A future durable review host is a separate owner choice.
 */
export async function independentlyReviewCameraObservation(result: CameraObservationResult, decision: 'approved' | 'rejected', ownerApproved: boolean, reviewer: string, auditLog: AuditLog, context: ConnectorRunContext): Promise<ReviewedCameraObservation> {
  if (!ownerApproved) throw new OwnerGateError()
  if (decision !== 'approved' && decision !== 'rejected') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_DECISION')
  const reviewContext = independentCameraReviewContext(context)
  const normalizedReviewer = reviewActor(reviewer)
  const normalizedRequester = reviewContext.requestedBy
  const normalized = validateCameraObservationForReview(result, reviewContext)
  if (normalizedReviewer === normalizedRequester) throw new MakerCheckerError('CAMERA_REVIEW_REQUIRES_INDEPENDENT_CHECKER')
  const occurredAt = localReviewOccurredAt(reviewContext.now)
  const audit = await auditLog.append({
    type: 'connector.camera.owner_reviewed', connectorId: CAMERA_CONNECTOR_ID,
    product: reviewContext.product, workspaceId: reviewContext.workspaceId, requestedBy: normalizedRequester, checkedBy: normalizedReviewer,
    correlationId: reviewContext.correlationId, scopes: [CAMERA_SCOPE], costCapCents: reviewContext.costCapCents, requestedItems: reviewContext.requestedItems,
    occurredAt,
    detail: {
      reviewId: normalized.reviewPacket.reviewId,
      decision,
      observationDigest: normalized.reviewPacket.observationDigest,
      reviewPacketIntegrityDigest: normalized.reviewPacket.integrityDigest,
      rawMediaIncluded: false,
      action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED', handoff: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED',
    },
  })
  const reviewed: ReviewedCameraObservationDetails = {
    reviewId: normalized.reviewPacket.reviewId,
    decision,
    reviewPacketIntegrityDigest: normalized.reviewPacket.integrityDigest,
    ownerReview: { state: reviewStateFor(decision), reviewer: normalizedReviewer, occurredAt },
    handoff: { state: 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED', rawMediaIncluded: false, sent: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' },
    auditHash: audit.hash,
  }
  return { ...reviewed, reviewReceipt: reviewReceiptFor(normalized, reviewed, reviewContext) }
}

/**
 * Fixture-only camera contract. It has no camera SDK, HTTP client, device
 * address, snapshot, stream URL, credential, or raw-media input surface.
 */
export class SyntheticCameraConnector implements Connector<unknown, CameraObservationResult> {
  readonly id = CAMERA_CONNECTOR_ID
  readonly kind = 'synthetic-camera' as const
  readonly authKind = 'owner-token' as const
  readonly scopes = [CAMERA_SCOPE] as const
  readonly liveStatus = CAMERA_LIVE_STATUS

  constructor(private readonly config: SyntheticCameraConnectorConfig = {}) {}

  private configured(ctx: Pick<CameraExecutionContext, 'costCapCents' | 'requestedItems'>): void {
    if (this.config.liveEnabled) throw new ConnectorUnavailableError('CAMERA_LIVE_DISABLED')
    if (!this.config.syntheticEnabled) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_CONNECTOR_NOT_CONFIGURED')
    const maxCostCapCents = positiveInteger(this.config.maxCostCapCents)
    const maxItems = positiveInteger(this.config.maxItems)
    if (!maxCostCapCents || !maxItems) throw new ConnectorUnavailableError('CAMERA_GOVERNANCE_LIMITS_NOT_CONFIGURED')
    if (ctx.costCapCents > maxCostCapCents) throw new CostCapError()
    if (ctx.requestedItems > maxItems) throw new CostCapError('CONNECTOR_ITEM_CAP_EXCEEDED')
  }

  preflight(input: unknown, ctx: ConnectorRunContext): void {
    const executionContext = cameraExecutionContext(ctx)
    this.configured(executionContext)
    localCameraOccurredAt(executionContext.now, 'INVALID_CAMERA_PROVENANCE_CLOCK')
    fixtureFor(inputFrom(input))
  }

  async run(input: unknown, ctx: ConnectorRunContext): Promise<ConnectorResult<CameraObservationResult>> {
    const executionContext = cameraExecutionContext(ctx)
    this.configured(executionContext)
    const cameraInput = inputFrom(input)
    const fixture = fixtureFor(cameraInput)
    const resultWithoutReviewPacket: Omit<CameraObservationResult, 'reviewPacket'> = {
      mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, cameraFixtureId: cameraInput.cameraFixtureId, purpose: cameraInput.purpose,
      observation: fixture.observation,
      privacy: {
        rawMediaAccepted: false, streamConnectionAttempted: false, deviceIdentifierRetained: false,
        biometricInference: 'NOT_PERFORMED', identityResolution: 'NOT_PERFORMED', resultPersistence: 'NOT_PERSISTED',
      },
      review: { state: 'OWNER_REVIEW_REQUIRED', action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' },
    }
    const data: CameraObservationResult = { ...resultWithoutReviewPacket, reviewPacket: reviewPacketFor(resultWithoutReviewPacket, executionContext.product, executionContext.workspaceId) }
    return {
      data,
      provenance: {
        connectorId: this.id,
        source: `synthetic-camera-fixture:${cameraInput.cameraFixtureId}`,
        retrievedAt: localCameraOccurredAt(executionContext.now, 'INVALID_CAMERA_PROVENANCE_CLOCK'), liveStatus: CAMERA_LIVE_STATUS, synthetic: true,
        untrustedContent: {
          source: 'synthetic-camera-observation', value: data.observation,
          handling: 'data-only', instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
        },
      },
      confidence: 0,
    }
  }
}

export function cameraConnectorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SyntheticCameraConnector {
  return new SyntheticCameraConnector({
    syntheticEnabled: environment.GCL_CAMERA_SYNTHETIC_ENABLED === 'true',
    liveEnabled: environment.GCL_CAMERA_LIVE_ENABLED === 'true',
    maxCostCapCents: environmentPositiveInteger(environment.GCL_CAMERA_MAX_COST_CENTS),
    maxItems: environmentPositiveInteger(environment.GCL_CAMERA_MAX_ITEMS),
  })
}
