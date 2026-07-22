import { createHash, Hash } from 'node:crypto'
import { CameraConsentError, ConnectorInputError, ConnectorUnavailableError, OwnerGateError } from './errors.js'
import {
  intrinsicArrayIncludes, intrinsicArrayIsArray, intrinsicArrayPrototype, intrinsicDate, intrinsicDateGetTime, intrinsicDateToISOString,
  intrinsicIsDate, intrinsicIsProxy, intrinsicJsonStringify, intrinsicNumber, intrinsicNumberIsFinite, intrinsicNumberIsNaN,
  intrinsicNumberIsSafeInteger, intrinsicObjectCreate, intrinsicObjectFreeze, intrinsicObjectGetOwnPropertyDescriptors,
  intrinsicObjectGetOwnPropertyNames, intrinsicObjectGetOwnPropertySymbols, intrinsicObjectGetPrototypeOf, intrinsicObjectPrototype,
  intrinsicReflectApply, intrinsicStringCharCodeAt, intrinsicStringTrim,
} from './intrinsics.js'
import type { ConnectorRunContext } from './types.js'
import {
  CAMERA_LIVE_STATUS, CAMERA_REVIEW_PACKET_VERSION, CAMERA_SCOPE,
  type CameraObservationInput, type CameraObservationResult, type CameraOwnerReviewRequired, type CameraPurpose, type SyntheticCameraReviewPacket,
} from './camera-contract.js'

export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const CAMERA_REVIEW_ID_PATTERN = /^synthetic-camera-review-[a-f0-9]{24}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const CONTEXT_FIELDS = ['product', 'workspaceId', 'requestedBy', 'checkedBy', 'correlationId', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems', 'now'] as const

export type CameraFixture = { purpose: CameraPurpose; consentReceiptRef: string; observation: CameraObservationResult['observation'] }
export type CameraExecutionContext = { product: string; workspaceId: string; costCapCents: number; requestedItems: number; now: () => Date }
type ReviewScope = { product: string; workspaceId: string }
type ReviewContext = ReviewScope & { requestedBy: string; correlationId: string; costCapCents: number; requestedItems: number; now: () => Date }

const intrinsicCreateHash = createHash
const intrinsicHashUpdate = Hash.prototype.update
const intrinsicHashDigest = Hash.prototype.digest
const FIXTURES: Readonly<Record<string, CameraFixture>> = intrinsicObjectFreeze({
  'synthetic-loading-dock-001': { purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-001', observation: { category: 'operational-safety', severity: 'warning', findingCode: 'PPE_DRILL_INDICATOR', summary: 'Synthetic loading-dock safety drill indicator requires owner review.' } },
  'synthetic-perimeter-001': { purpose: 'site-security', consentReceiptRef: 'synthetic-consent-security-001', observation: { category: 'site-security', severity: 'info', findingCode: 'ACCESS_POINT_DRILL_INDICATOR', summary: 'Synthetic access-point drill indicator requires owner review.' } },
  'synthetic-fire-drill-001': { purpose: 'operational-safety', consentReceiptRef: 'synthetic-consent-safety-002', observation: { category: 'operational-safety', severity: 'critical', findingCode: 'FIRE_DRILL_INDICATOR', summary: 'Synthetic fire-drill indicator requires owner review; no action is executed.' } },
})

function includes(values: readonly unknown[], value: unknown): boolean { return intrinsicReflectApply(intrinsicArrayIncludes, values, [value]) as boolean }
function hasUnexpectedName(names: readonly string[], allowed: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) if (!includes(allowed, names[index])) return true
  return false
}
function hasUnexpectedArrayName(names: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name ?? '')) return true
  }
  return false
}

export function positiveInteger(value: unknown): number | null { return typeof value === 'number' && intrinsicNumberIsSafeInteger(value) && value > 0 ? value : null }
export function environmentPositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = intrinsicNumber(value)
  return intrinsicNumberIsSafeInteger(parsed) ? parsed : undefined
}
export function digest(value: string): string {
  const hash = intrinsicCreateHash('sha256')
  return intrinsicReflectApply(intrinsicHashDigest, intrinsicReflectApply(intrinsicHashUpdate, hash, [value, 'utf8']), ['hex']) as string
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !intrinsicArrayIsArray(value) && !intrinsicIsProxy(value) && (intrinsicObjectGetPrototypeOf(value) === intrinsicObjectPrototype || intrinsicObjectGetPrototypeOf(value) === null)
}
export function exactObject(value: unknown, allowed: readonly string[], error: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorInputError(error)
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length || hasUnexpectedName(names, allowed)) throw new ConnectorInputError(error)
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined) throw new ConnectorInputError(error)
    const descriptor = descriptors[name]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
    normalized[name] = descriptor.value
  }
  return normalized
}
function exactStringArray(value: unknown, error: string): string[] {
  if (!intrinsicArrayIsArray(value) || intrinsicIsProxy(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || value.length > 12 || intrinsicObjectGetOwnPropertySymbols(value).length) throw new ConnectorInputError(error)
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !includes(names, 'length') || hasUnexpectedArrayName(names)) throw new ConnectorInputError(error)
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[`${index}`]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError(error)
    normalized[index] = requiredString(descriptor.value, error, 80)
  }
  return normalized
}
export function requiredString(value: unknown, error: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength) throw new ConnectorInputError(error)
  return value
}
function contextRecord(value: unknown): Record<string, unknown> { return exactObject(value, CONTEXT_FIELDS, 'UNEXPECTED_CAMERA_REVIEW_CONTEXT_FIELD') }
function reviewScope(candidate: Record<string, unknown>): ReviewScope {
  const product = candidate.product
  const workspaceId = candidate.workspaceId
  if (typeof product !== 'string' || typeof workspaceId !== 'string' || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId)) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_CONTEXT')
  return { product, workspaceId }
}
export function cameraReviewContext(context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): ReviewScope { return reviewScope(contextRecord(context)) }
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = intrinsicReflectApply(intrinsicStringCharCodeAt, value, [index]) as number
    if (code < 32 || code === 127) return true
  }
  return false
}
export function normalizedActor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160 || containsControlCharacter(value)) return null
  const actor = intrinsicReflectApply(intrinsicStringTrim, value, []) as string
  return actor && ACTOR_PATTERN.test(actor) ? actor : null
}
export function reviewActor(value: unknown): string {
  const actor = normalizedActor(value)
  if (!actor) throw new OwnerGateError('CAMERA_REVIEWER_REQUIRED')
  return actor
}
export function independentCameraReviewContext(context: ConnectorRunContext): ReviewContext {
  const candidate = contextRecord(context)
  const scope = reviewScope(candidate)
  const requestedBy = normalizedActor(candidate.requestedBy)
  const correlationId = requiredString(candidate.correlationId, 'INVALID_CAMERA_REVIEW_CONTEXT', 120)
  const costCapCents = positiveInteger(candidate.costCapCents)
  const requestedItems = positiveInteger(candidate.requestedItems)
  if (!requestedBy || !SCOPE_ID_PATTERN.test(correlationId) || !costCapCents || !requestedItems || typeof candidate.now !== 'function' || intrinsicIsProxy(candidate.now)) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_CONTEXT')
  return { ...scope, requestedBy, correlationId, costCapCents, requestedItems, now: candidate.now as () => Date }
}
export function canonicalIsoInstant(value: unknown, error: string): string {
  const instant = requiredString(value, error, 30)
  const parsed = new intrinsicDate(instant)
  if (intrinsicNumberIsNaN(intrinsicReflectApply(intrinsicDateGetTime, parsed, []) as number) || intrinsicReflectApply(intrinsicDateToISOString, parsed, []) !== instant) throw new ConnectorInputError(error)
  return instant
}
export function localCameraOccurredAt(now: () => Date, error: string): string {
  let candidate: unknown
  try { candidate = now() } catch { throw new ConnectorInputError(error) }
  if (!intrinsicIsDate(candidate) || intrinsicIsProxy(candidate)) throw new ConnectorInputError(error)
  try {
    if (!intrinsicNumberIsFinite(intrinsicReflectApply(intrinsicDateGetTime, candidate, []) as number)) throw new ConnectorInputError(error)
    return canonicalIsoInstant(intrinsicReflectApply(intrinsicDateToISOString, candidate, []), error)
  } catch (cause) {
    if (cause instanceof ConnectorInputError) throw cause
    throw new ConnectorInputError(error)
  }
}
export function cameraExecutionContext(value: unknown): CameraExecutionContext {
  const candidate = exactObject(value, CONTEXT_FIELDS, 'UNEXPECTED_CAMERA_EXECUTION_CONTEXT_FIELD')
  const scope = reviewScope(candidate)
  const requestedBy = normalizedActor(candidate.requestedBy)
  const checkedBy = normalizedActor(candidate.checkedBy)
  const correlationId = typeof candidate.correlationId === 'string' ? candidate.correlationId : ''
  const scopes = exactStringArray(candidate.scopes, 'INVALID_CAMERA_EXECUTION_CONTEXT_SCOPES')
  const costCapCents = positiveInteger(candidate.costCapCents)
  const requestedItems = positiveInteger(candidate.requestedItems)
  if (!requestedBy || requestedBy !== candidate.requestedBy || !checkedBy || checkedBy !== candidate.checkedBy || requestedBy === checkedBy || candidate.ownerApproved !== true || !SCOPE_ID_PATTERN.test(correlationId) || scopes.length !== 1 || scopes[0] !== CAMERA_SCOPE || !costCapCents || !requestedItems || typeof candidate.now !== 'function' || intrinsicIsProxy(candidate.now)) throw new ConnectorInputError('INVALID_CAMERA_EXECUTION_CONTEXT')
  return { ...scope, costCapCents, requestedItems, now: candidate.now as () => Date }
}
export function inputFrom(value: unknown): CameraObservationInput {
  const input = exactObject(value, ['synthetic', 'cameraFixtureId', 'purpose', 'consent'], 'SYNTHETIC_CAMERA_INPUT_REQUIRED')
  if (input.synthetic !== true || typeof input.cameraFixtureId !== 'string' || (input.purpose !== 'operational-safety' && input.purpose !== 'site-security')) throw new ConnectorInputError('SYNTHETIC_CAMERA_INPUT_REQUIRED')
  let consent: Record<string, unknown>
  try { consent = exactObject(input.consent, ['state', 'receiptRef', 'policyVersion', 'sourceRights'], 'CAMERA_CONSENT_REQUIRED') } catch (cause) {
    if (cause instanceof ConnectorInputError) throw new CameraConsentError()
    throw cause
  }
  if (consent.state !== 'granted' || typeof consent.receiptRef !== 'string' || consent.policyVersion !== 'kvkk-synthetic-v1' || consent.sourceRights !== 'synthetic-fixture') throw new CameraConsentError()
  return { synthetic: true, cameraFixtureId: input.cameraFixtureId, purpose: input.purpose, consent: { state: 'granted', receiptRef: consent.receiptRef, policyVersion: 'kvkk-synthetic-v1', sourceRights: 'synthetic-fixture' } }
}
export function fixtureFor(input: CameraObservationInput): CameraFixture {
  const fixture = FIXTURES[input.cameraFixtureId]
  if (!fixture) throw new ConnectorUnavailableError('SYNTHETIC_CAMERA_FIXTURE_NOT_FOUND')
  if (fixture.purpose !== input.purpose || fixture.consentReceiptRef !== input.consent.receiptRef) throw new CameraConsentError('CAMERA_CONSENT_SCOPE_DENIED')
  return fixture
}
function reviewIdFor(product: string, workspaceId: string, fixtureId: string, purpose: CameraPurpose, observationDigest: string): string { return `synthetic-camera-review-${digest(`${product}:${workspaceId}:${fixtureId}:${purpose}:${observationDigest}`).slice(0, 24)}` }
function reviewPacketMaterial(result: Omit<CameraObservationResult, 'reviewPacket'>, scopeBinding: SyntheticCameraReviewPacket['scopeBinding'], reviewId: string, observationDigest: string): Record<string, unknown> {
  return { reviewId, scopeBinding, observationDigest, mode: result.mode, liveStatus: result.liveStatus, cameraFixtureId: result.cameraFixtureId, purpose: result.purpose, observation: result.observation, privacy: result.privacy, review: result.review }
}
export function reviewPacketFor(result: Omit<CameraObservationResult, 'reviewPacket'>, product: string, workspaceId: string): SyntheticCameraReviewPacket {
  const scopeBinding = { productDigest: digest(product), workspaceDigest: digest(workspaceId) }
  const observationDigest = digest(intrinsicJsonStringify(result.observation))
  const reviewId = reviewIdFor(product, workspaceId, result.cameraFixtureId, result.purpose, observationDigest)
  return { version: CAMERA_REVIEW_PACKET_VERSION, reviewId, scopeBinding, observationDigest, integrityDigest: digest(intrinsicJsonStringify(reviewPacketMaterial(result, scopeBinding, reviewId, observationDigest))), state: 'PENDING_INDEPENDENT_OWNER_REVIEW', rawMediaIncluded: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
}
export function cameraObservationForReview(value: unknown): CameraObservationResult['observation'] {
  const observation = exactObject(value, ['category', 'severity', 'findingCode', 'summary'], 'INVALID_CAMERA_REVIEW_OBSERVATION')
  const findingCode = requiredString(observation.findingCode, 'INVALID_CAMERA_REVIEW_OBSERVATION', 120)
  const summary = requiredString(observation.summary, 'INVALID_CAMERA_REVIEW_OBSERVATION', 320)
  if ((observation.category !== 'operational-safety' && observation.category !== 'site-security') || (observation.severity !== 'info' && observation.severity !== 'warning' && observation.severity !== 'critical')) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_OBSERVATION')
  return { category: observation.category, severity: observation.severity, findingCode, summary }
}
function cameraPrivacy(value: unknown): CameraObservationResult['privacy'] {
  const privacy = exactObject(value, ['rawMediaAccepted', 'streamConnectionAttempted', 'deviceIdentifierRetained', 'biometricInference', 'identityResolution', 'resultPersistence'], 'INVALID_CAMERA_REVIEW_PRIVACY')
  if (privacy.rawMediaAccepted !== false || privacy.streamConnectionAttempted !== false || privacy.deviceIdentifierRetained !== false || privacy.biometricInference !== 'NOT_PERFORMED' || privacy.identityResolution !== 'NOT_PERFORMED' || privacy.resultPersistence !== 'NOT_PERSISTED') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PRIVACY')
  return { rawMediaAccepted: false, streamConnectionAttempted: false, deviceIdentifierRetained: false, biometricInference: 'NOT_PERFORMED', identityResolution: 'NOT_PERFORMED', resultPersistence: 'NOT_PERSISTED' }
}
function ownerReview(value: unknown): CameraOwnerReviewRequired {
  const review = exactObject(value, ['state', 'action', 'notification', 'publication'], 'INVALID_CAMERA_OWNER_REVIEW')
  if (review.state !== 'OWNER_REVIEW_REQUIRED' || review.action !== 'NOT_EXECUTED' || review.notification !== 'NOT_SENT' || review.publication !== 'NOT_PUBLISHED') throw new ConnectorInputError('INVALID_CAMERA_OWNER_REVIEW')
  return { state: 'OWNER_REVIEW_REQUIRED', action: 'NOT_EXECUTED', notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
}
export function validateCameraObservationForReview(value: unknown, context: Pick<ConnectorRunContext, 'product' | 'workspaceId'>): CameraObservationResult {
  const scoped = cameraReviewContext(context)
  const result = exactObject(value, ['mode', 'liveStatus', 'cameraFixtureId', 'purpose', 'observation', 'privacy', 'review', 'reviewPacket'], 'UNEXPECTED_CAMERA_REVIEW_RESULT_FIELD')
  if (result.mode !== 'SYNTHETIC' || result.liveStatus !== CAMERA_LIVE_STATUS) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_MODE')
  const cameraFixtureId = requiredString(result.cameraFixtureId, 'INVALID_CAMERA_REVIEW_FIXTURE', 120)
  if (result.purpose !== 'operational-safety' && result.purpose !== 'site-security') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PURPOSE')
  const purpose: CameraPurpose = result.purpose
  const fixture = FIXTURES[cameraFixtureId]
  if (!fixture || fixture.purpose !== purpose) throw new ConnectorInputError('CAMERA_REVIEW_FIXTURE_MISMATCH')
  const observation = cameraObservationForReview(result.observation)
  if (intrinsicJsonStringify(observation) !== intrinsicJsonStringify(fixture.observation)) throw new ConnectorInputError('CAMERA_REVIEW_OBSERVATION_MISMATCH')
  const privacy = cameraPrivacy(result.privacy)
  const review = ownerReview(result.review)
  const packet = exactObject(result.reviewPacket, ['version', 'reviewId', 'scopeBinding', 'observationDigest', 'integrityDigest', 'state', 'rawMediaIncluded', 'automaticAction', 'notification', 'publication'], 'UNEXPECTED_CAMERA_REVIEW_PACKET_FIELD')
  const scopeBinding = exactObject(packet.scopeBinding, ['productDigest', 'workspaceDigest'], 'UNEXPECTED_CAMERA_REVIEW_PACKET_SCOPE_FIELD')
  const productDigest = requiredString(scopeBinding.productDigest, 'INVALID_CAMERA_REVIEW_PACKET_SCOPE', 64)
  const workspaceDigest = requiredString(scopeBinding.workspaceDigest, 'INVALID_CAMERA_REVIEW_PACKET_SCOPE', 64)
  const observationDigest = requiredString(packet.observationDigest, 'INVALID_CAMERA_REVIEW_PACKET_DIGEST', 64)
  const integrityDigest = requiredString(packet.integrityDigest, 'INVALID_CAMERA_REVIEW_PACKET_DIGEST', 64)
  const reviewId = requiredString(packet.reviewId, 'INVALID_CAMERA_REVIEW_ID', 64)
  if (!SHA256_PATTERN.test(productDigest) || !SHA256_PATTERN.test(workspaceDigest) || !SHA256_PATTERN.test(observationDigest) || !SHA256_PATTERN.test(integrityDigest) || !CAMERA_REVIEW_ID_PATTERN.test(reviewId)) throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PACKET_DIGEST')
  if (packet.version !== CAMERA_REVIEW_PACKET_VERSION || packet.state !== 'PENDING_INDEPENDENT_OWNER_REVIEW' || packet.rawMediaIncluded !== false || packet.automaticAction !== false || packet.notification !== 'NOT_SENT' || packet.publication !== 'NOT_PUBLISHED') throw new ConnectorInputError('INVALID_CAMERA_REVIEW_PACKET')
  if (productDigest !== digest(scoped.product) || workspaceDigest !== digest(scoped.workspaceId)) throw new ConnectorInputError('CAMERA_REVIEW_PACKET_SCOPE_MISMATCH')
  const normalized: Omit<CameraObservationResult, 'reviewPacket'> = { mode: 'SYNTHETIC', liveStatus: CAMERA_LIVE_STATUS, cameraFixtureId, purpose, observation, privacy, review }
  const expectedObservationDigest = digest(intrinsicJsonStringify(observation))
  if (observationDigest !== expectedObservationDigest || reviewId !== reviewIdFor(scoped.product, scoped.workspaceId, cameraFixtureId, purpose, expectedObservationDigest)) throw new ConnectorInputError('CAMERA_REVIEW_PACKET_BINDING_MISMATCH')
  const reviewPacket: SyntheticCameraReviewPacket = { version: CAMERA_REVIEW_PACKET_VERSION, reviewId, scopeBinding: { productDigest, workspaceDigest }, observationDigest, integrityDigest, state: 'PENDING_INDEPENDENT_OWNER_REVIEW', rawMediaIncluded: false, automaticAction: false, notification: 'NOT_SENT', publication: 'NOT_PUBLISHED' }
  if (integrityDigest !== digest(intrinsicJsonStringify(reviewPacketMaterial(normalized, reviewPacket.scopeBinding, reviewId, observationDigest)))) throw new ConnectorInputError('CAMERA_REVIEW_PACKET_INTEGRITY_MISMATCH')
  return { ...normalized, reviewPacket }
}
