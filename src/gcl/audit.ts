import { type Prisma, type PrismaClient } from '@prisma/client'
import {
  CameraPrismaHashChainAuditLog,
  appendVerifiedAuditEvent,
  hashAuditEvent as cameraHashAuditEvent,
  sealAuditAppendEvent,
  validateAuditAppendReceipt,
  validateAuditChainHead,
} from './camera-audit.js'
import { MarketPrismaHashChainAuditLog } from './market-audit.js'
import {
  ImagePrismaHashChainAuditLog,
  appendAuditEvent as appendImageAuditEvent,
  hashAuditEvent as imageHashAuditEvent,
  verifyAuditChain as verifyImageAuditChain,
} from './image-audit.js'
import {
  JncPrismaHashChainAuditLog,
  hashAuditEvent as jncHashAuditEvent,
  verifiedAuditChainHead as verifiedJncAuditChainHead,
} from './jnc-audit.js'
import { validGclTenantContext } from './context.js'
import { ConnectorUnavailableError } from './errors.js'
import type { GclPersistence, GclRecordTransaction } from './persistence.js'
import { translationArtifactReviewDigest } from './translation-artifact-review.js'
import type { TranslationArtifactRecord } from './translation-artifacts.js'
import type { AuditAppendReceipt, AuditLog, ConnectorAuditEvent, TranslationArtifactProposal } from './types.js'

export { appendVerifiedAuditEvent, sealAuditAppendEvent, validateAuditAppendReceipt, validateAuditChainHead }
export { verifiedAuditChainHead } from './jnc-audit.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/
const TRANSLATION_CONNECTOR_ID = /^translation-(?:text|speech)-synthetic$/
const VISION_DOCUMENT_CONNECTOR_ID = 'vision-document-field-extraction'
const ACTOR_ID = /^[a-zA-Z0-9:_@. -]{1,160}$/
const SCOPE_ID = /^[a-z][a-z0-9:-]{0,79}$/
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/
const REVIEW_POLICY_VERSION = 'gcl-translation-synthetic-v1'
const PROPOSAL_KEYS = ['kind', 'contentHash', 'mediaType', 'source', 'synthetic', 'approvalState', 'autoPublish', 'reviewPolicyVersion', 'reviewExpiresAt'] as const
const TEXT_TRANSLATION_SCOPES = ['translation:text'] as const
const SPEECH_TRANSLATION_SCOPES = ['translation:speech'] as const
const ARTIFACT_APPROVAL_SCOPES = ['translation:artifact:approve'] as const
const VISION_DOCUMENT_SCOPES = ['vision:document-field-extraction'] as const
const VISION_DOCUMENT_PROPOSAL_ID = /^synthetic-document-[a-f0-9]{24}$/
const MAX_AUDIT_SNAPSHOT_DEPTH = 8
const MAX_AUDIT_SNAPSHOT_NODES = 96
const MAX_AUDIT_SNAPSHOT_STRING_LENGTH = 512

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type AuditSnapshotState = {
  nodes: number
}

/**
 * The audit boundary can be reached by programmatic callers as well as the
 * runner. Capture one ordinary JSON-data snapshot before validation, hashing,
 * or persistence so an accessor or stateful Proxy cannot pass schema checks
 * and then change the event that is hashed or stored. The accepted audit
 * schema is deliberately small, so bounded depth/node/string limits are also
 * a fail-closed resource boundary.
 */
function snapshotAuditData(value: unknown, state: AuditSnapshotState, depth = 0): unknown {
  if (depth > MAX_AUDIT_SNAPSHOT_DEPTH || ++state.nodes > MAX_AUDIT_SNAPSHOT_NODES) throw new TypeError('audit snapshot limit')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_AUDIT_SNAPSHOT_STRING_LENGTH) throw new TypeError('audit snapshot string limit')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('audit snapshot number')
    return value
  }
  if (!value || typeof value !== 'object') throw new TypeError('audit snapshot primitive')

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('audit snapshot array prototype')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      throw new TypeError('audit snapshot array length')
    }
    const length = lengthDescriptor.value
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError('audit snapshot array shape')
    const snapshot: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('audit snapshot array item')
      snapshot.push(snapshotAuditData(descriptor.value, state, depth + 1))
    }
    return snapshot
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('audit snapshot object prototype')
  const keys = Reflect.ownKeys(value)
  const snapshot: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('audit snapshot object field')
    }
    Object.defineProperty(snapshot, key, { value: snapshotAuditData(descriptor.value, state, depth + 1), enumerable: true, writable: true, configurable: true })
  }
  return snapshot
}

function snapshotAuditEvent(value: unknown): ConnectorAuditEvent | null {
  try {
    const snapshot = snapshotAuditData(value, { nodes: 0 })
    return isObject(snapshot) ? snapshot as ConnectorAuditEvent : null
  } catch {
    return null
  }
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value
}

function canonicalActor(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && Boolean(value) && ACTOR_ID.test(value)
}

function safeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function scopes(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 12
    && value.every((scope) => typeof scope === 'string' && SCOPE_ID.test(scope))
    && new Set(value).size === value.length
}

/**
 * Scope names alone are insufficient provenance: each synthetic connector has
 * one immutable run scope, and checker decisions have their own zero-cost
 * scope. This makes a hash-valid but semantically forged audit row unusable.
 */
function exactScopes(value: unknown, expected: readonly string[]): boolean {
  return scopes(value) && value.length === expected.length && value.every((scope, index) => scope === expected[index])
}

function connectorRunScopes(connectorId: unknown, value: unknown): boolean {
  return (connectorId === 'translation-text-synthetic' && exactScopes(value, TEXT_TRANSLATION_SCOPES))
    || (connectorId === 'translation-speech-synthetic' && exactScopes(value, SPEECH_TRANSLATION_SCOPES))
    || (connectorId === VISION_DOCUMENT_CONNECTOR_ID && exactScopes(value, VISION_DOCUMENT_SCOPES))
}

function validVisionDocumentReviewEvent(value: Record<string, unknown>): boolean {
  if (value.connectorId !== VISION_DOCUMENT_CONNECTOR_ID
    || !exactScopes(value.scopes, VISION_DOCUMENT_SCOPES)
    || value.costCapCents !== 0
    || value.requestedItems !== 1
    || !isObject(value.detail)
    || !hasExactlyKeys(value.detail, ['proposalId', 'decision', 'fieldsDigest', 'reviewPacketIntegrityDigest', 'mesaEvidenceHandoff', 'rawContentIncluded'])) return false

  return typeof value.detail.proposalId === 'string'
    && VISION_DOCUMENT_PROPOSAL_ID.test(value.detail.proposalId)
    && (value.detail.decision === 'approved' || value.detail.decision === 'rejected')
    && typeof value.detail.fieldsDigest === 'string'
    && SHA256.test(value.detail.fieldsDigest)
    && typeof value.detail.reviewPacketIntegrityDigest === 'string'
    && SHA256.test(value.detail.reviewPacketIntegrityDigest)
    && value.detail.mesaEvidenceHandoff === 'NOT_SENT_SEPARATE_OWNER_ACTION_REQUIRED'
    && value.detail.rawContentIncluded === false
}

function validArtifactBinding(connectorId: unknown, value: Record<string, unknown>): boolean {
  return (connectorId === 'translation-text-synthetic' && value.kind === 'translated-text' && value.mediaType === 'text/plain' && value.source === 'synthetic-text-translation')
    || (connectorId === 'translation-speech-synthetic' && value.kind === 'translated-speech' && value.mediaType === 'audio/wav' && value.source === 'synthetic-speech-translation')
}

/** Safe result envelope: hashes and lifecycle metadata only, never fixture text or audio. */
function artifactProposalDetail(connectorId: unknown, value: unknown): value is TranslationArtifactProposal {
  if (!isObject(value) || !hasExactlyKeys(value, PROPOSAL_KEYS)) return false
  return validArtifactBinding(connectorId, value)
    && typeof value.contentHash === 'string'
    && CONTENT_HASH.test(value.contentHash)
    && value.synthetic === true
    && value.approvalState === 'pending-checker-approval'
    && value.autoPublish === false
    && value.reviewPolicyVersion === REVIEW_POLICY_VERSION
    && canonicalTimestamp(value.reviewExpiresAt)
}

function sameArtifactProposal(left: TranslationArtifactProposal, right: TranslationArtifactProposal): boolean {
  return left.kind === right.kind
    && left.contentHash === right.contentHash
    && left.mediaType === right.mediaType
    && left.source === right.source
    && left.synthetic === right.synthetic
    && left.approvalState === right.approvalState
    && left.autoPublish === right.autoPublish
    && left.reviewPolicyVersion === right.reviewPolicyVersion
    && left.reviewExpiresAt === right.reviewExpiresAt
}

function proposalFromArtifact(artifact: TranslationArtifactRecord): TranslationArtifactProposal {
  return {
    kind: artifact.kind,
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType,
    source: artifact.source,
    synthetic: true,
    approvalState: 'pending-checker-approval',
    autoPublish: false,
    reviewPolicyVersion: artifact.reviewPolicyVersion,
    reviewExpiresAt: artifact.reviewExpiresAt,
  }
}

function artifactDetail(value: unknown, state: 'pending-checker-approval' | 'approved' | 'rejected'): boolean {
  if (!isObject(value) || !hasExactlyKeys(value, ['artifactId', 'kind', 'contentHash', 'mediaType', 'source', 'synthetic', 'approvalState', 'reviewPolicyVersion', 'reviewDigest', 'reviewExpiresAt', 'runAuditHash', 'autoPublish'])) return false
  return typeof value.artifactId === 'string'
    && /^[a-zA-Z0-9_-]{1,120}$/.test(value.artifactId)
    && (value.kind === 'translated-text' || value.kind === 'translated-speech')
    && typeof value.contentHash === 'string'
    && CONTENT_HASH.test(value.contentHash)
    && (value.mediaType === 'text/plain' || value.mediaType === 'audio/wav')
    && (value.source === 'synthetic-text-translation' || value.source === 'synthetic-speech-translation')
    && value.synthetic === true
    && value.approvalState === state
    && value.reviewPolicyVersion === REVIEW_POLICY_VERSION
    && typeof value.reviewDigest === 'string'
    && CONTENT_HASH.test(value.reviewDigest)
    && canonicalTimestamp(value.reviewExpiresAt)
    && typeof value.runAuditHash === 'string'
    && SHA256.test(value.runAuditHash)
    && value.autoPublish === false
}

function auditDetailArtifactId(event: ConnectorAuditEvent): string | null {
  const detail = event.detail
  return typeof detail.artifactId === 'string' ? detail.artifactId : null
}

function auditDetailRequestedHash(event: ConnectorAuditEvent): string | null {
  const detail = event.detail
  return typeof detail.requestedAuditHash === 'string' ? detail.requestedAuditHash : null
}

function auditDetailRunHash(event: ConnectorAuditEvent): string | null {
  const detail = event.detail
  return typeof detail.runAuditHash === 'string' ? detail.runAuditHash : null
}

/** Audit rows must carry the same canonical checker binding as artifact rows. */
function reviewDigestMatchesArtifactDetail(connectorId: string, detail: Record<string, unknown>): boolean {
  return typeof detail.reviewDigest === 'string'
    && detail.reviewDigest === translationArtifactReviewDigest({
      connectorId,
      kind: detail.kind as TranslationArtifactProposal['kind'],
      contentHash: detail.contentHash as string,
      mediaType: detail.mediaType as TranslationArtifactProposal['mediaType'],
      source: detail.source as TranslationArtifactProposal['source'],
      synthetic: detail.synthetic as true,
      autoPublish: detail.autoPublish as false,
      reviewPolicyVersion: detail.reviewPolicyVersion as TranslationArtifactProposal['reviewPolicyVersion'],
      reviewExpiresAt: detail.reviewExpiresAt as string,
      runAuditHash: detail.runAuditHash as string,
    })
}

function artifactDetailMatchesProposal(detail: Record<string, unknown>, proposal: TranslationArtifactProposal): boolean {
  return detail.kind === proposal.kind
    && detail.contentHash === proposal.contentHash
    && detail.mediaType === proposal.mediaType
    && detail.source === proposal.source
    && detail.synthetic === proposal.synthetic
    && detail.reviewPolicyVersion === proposal.reviewPolicyVersion
    && detail.reviewExpiresAt === proposal.reviewExpiresAt
    && detail.autoPublish === proposal.autoPublish
}

/**
 * Audit rows are durable metadata, so a hash alone is not enough to trust a
 * row. This schema gate rejects hash-valid rows that carry unknown fields or
 * raw fixture content before they can become part of the next chain link.
 */
function validAuditEvent(value: unknown): value is ConnectorAuditEvent {
  if (!isObject(value) || !hasExactlyKeys(value, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) return false
  if (typeof value.type !== 'string'
    || typeof value.connectorId !== 'string' || (!TRANSLATION_CONNECTOR_ID.test(value.connectorId) && value.connectorId !== VISION_DOCUMENT_CONNECTOR_ID)
    || !validGclTenantContext({ product: value.product, workspaceId: value.workspaceId })
    || !canonicalActor(value.actor)
    || !scopes(value.scopes)
    || !safeInteger(value.costCapCents, 10_000_000)
    || !safeInteger(value.requestedItems, 100_000)
    || !canonicalTimestamp(value.occurredAt)) return false

  if (value.type === 'connector.run.requested') return connectorRunScopes(value.connectorId, value.scopes) && isObject(value.detail) && hasExactlyKeys(value.detail, []) && value.costCapCents >= 1 && value.requestedItems === 1
  if (value.type === 'connector.run.succeeded') {
    if (!connectorRunScopes(value.connectorId, value.scopes) || !isObject(value.detail) || value.costCapCents < 1 || value.requestedItems !== 1 || typeof value.detail.requestedAuditHash !== 'string' || !SHA256.test(value.detail.requestedAuditHash)) return false
    if (hasExactlyKeys(value.detail, ['requestedAuditHash'])) return true
    // A result cannot introduce review authority that was already expired at
    // its canonical run instant. This blocks a hash-valid but unusable success
    // event before it can become a durable chain link.
    return hasExactlyKeys(value.detail, ['requestedAuditHash', 'artifact'])
      && artifactProposalDetail(value.connectorId, value.detail.artifact)
      && before(value.occurredAt, value.detail.artifact.reviewExpiresAt)
  }
  if (value.type === 'connector.run.failed') return connectorRunScopes(value.connectorId, value.scopes) && isObject(value.detail) && hasExactlyKeys(value.detail, ['requestedAuditHash', 'error']) && typeof value.detail.requestedAuditHash === 'string' && SHA256.test(value.detail.requestedAuditHash) && typeof value.detail.error === 'string' && ERROR_CODE.test(value.detail.error) && value.costCapCents >= 1 && value.requestedItems === 1
  if (value.type === 'translation.artifact.created') return connectorRunScopes(value.connectorId, value.scopes) && isObject(value.detail) && artifactDetail(value.detail, 'pending-checker-approval') && reviewDigestMatchesArtifactDetail(value.connectorId, value.detail) && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents >= 1 && value.requestedItems === 1
  if (value.type === 'translation.artifact.approved') return exactScopes(value.scopes, ARTIFACT_APPROVAL_SCOPES) && isObject(value.detail) && artifactDetail(value.detail, 'approved') && reviewDigestMatchesArtifactDetail(value.connectorId, value.detail) && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents === 0 && value.requestedItems === 0
  if (value.type === 'translation.artifact.rejected') return exactScopes(value.scopes, ARTIFACT_APPROVAL_SCOPES) && isObject(value.detail) && artifactDetail(value.detail, 'rejected') && reviewDigestMatchesArtifactDetail(value.connectorId, value.detail) && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents === 0 && value.requestedItems === 0
  if (value.type === 'connector.document.owner_reviewed') return validVisionDocumentReviewEvent(value)
  return false
}
export function hashAuditEvent(event: ConnectorAuditEvent | Record<string, unknown>, previousHash: string | null): string {
  return cameraHashAuditEvent(event as ConnectorAuditEvent, previousHash)
}

/** Image candidate ledgers replay the exact synthetic-image chain before trusting lineage. */
export function verifyAuditChain(records: readonly unknown[]) {
  return verifyImageAuditChain(records)
}

function auditValue(value: unknown): AuditRecordValue | null {
  try {
    const snapshot = snapshotAuditData(value, { nodes: 0 })
    if (!isObject(snapshot)) return null
    const candidate = snapshot as Partial<AuditRecordValue>
    if (!hasExactlyKeys(candidate, ['event', 'previousHash', 'hash']) || !validAuditEvent(candidate.event) || typeof candidate.hash !== 'string' || !SHA256.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !SHA256.test(candidate.previousHash)))) return null
    return candidate as AuditRecordValue
  } catch {
    return null
  }
}

async function validatedAuditEntries(transaction: Prisma.TransactionClient, product: string, workspaceId: string): Promise<AuditRecordValue[]> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${product}:${workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
  const records = await transaction.record.findMany({
    where: { product, workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { values: true },
  })
  const entries: AuditRecordValue[] = []
  let previousHash: string | null = null
  for (const record of records) {
    const value = auditValue(record.values)
    if (!value
      || value.previousHash !== previousHash
      || value.hash !== hashAuditEvent(value.event, value.previousHash)
      || !validAuditTransition(entries, value.event)) {
      throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
    }
    entries.push(value)
    previousHash = value.hash
  }
  return entries
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index])
}

/** Audit chain order is not sufficient when durable rows can be independently forged. */
function atOrBefore(left: string, right: string): boolean {
  return new Date(left).valueOf() <= new Date(right).valueOf()
}

function before(left: string, right: string): boolean {
  return new Date(left).valueOf() < new Date(right).valueOf()
}

function sameRunContext(left: ConnectorAuditEvent, right: ConnectorAuditEvent): boolean {
  return left.connectorId === right.connectorId
    && left.product === right.product
    && left.workspaceId === right.workspaceId
    && left.actor === right.actor
    && sameScopes(left.scopes, right.scopes)
    && left.costCapCents === right.costCapCents
    && left.requestedItems === right.requestedItems
}

/**
 * A terminal run outcome is meaningful only for its exact earlier request and
 * the same canonical run-clock instant. The append order may differ, but a
 * later wall-clock value would describe a different synthetic run.
 */
function validRunOutcomeTransition(entries: readonly AuditRecordValue[], event: ConnectorAuditEvent): boolean {
  const requestedAuditHash = auditDetailRequestedHash(event)
  if (!requestedAuditHash || entries.some((entry) => {
    const priorRequestedHash = auditDetailRequestedHash(entry.event)
    return (entry.event.type === 'connector.run.succeeded' || entry.event.type === 'connector.run.failed') && priorRequestedHash === requestedAuditHash
  })) return false
  const requested = entries.find((entry) => entry.hash === requestedAuditHash)?.event
  return Boolean(requested
    && requested.type === 'connector.run.requested'
    && sameRunContext(requested, event)
    && requested.occurredAt === event.occurredAt)
}

function sameArtifactMetadata(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.contentHash === right.contentHash
    && left.mediaType === right.mediaType
    && left.source === right.source
    && left.synthetic === right.synthetic
    && left.reviewPolicyVersion === right.reviewPolicyVersion
    && left.reviewDigest === right.reviewDigest
    && left.reviewExpiresAt === right.reviewExpiresAt
    && left.runAuditHash === right.runAuditHash
    && left.autoPublish === right.autoPublish
}

/** Creation has one successful run parent and can introduce an artifact ID once. */
function validArtifactCreationTransition(entries: readonly AuditRecordValue[], event: ConnectorAuditEvent): boolean {
  const detail = event.detail
  const artifactId = auditDetailArtifactId(event)
  const runAuditHash = auditDetailRunHash(event)
  if (!artifactId || !runAuditHash || entries.some((entry) =>
    auditDetailArtifactId(entry.event) === artifactId
      || (entry.event.type === 'translation.artifact.created' && auditDetailRunHash(entry.event) === runAuditHash))) return false
  const succeeded = entries.find((entry) => entry.hash === runAuditHash)?.event
  const proposal = succeeded?.detail.artifact
  return Boolean(succeeded
    && succeeded.type === 'connector.run.succeeded'
    && sameRunContext(succeeded, event)
    && artifactProposalDetail(event.connectorId, proposal)
    && isObject(proposal)
    && artifactDetailMatchesProposal(detail, proposal)
    && atOrBefore(succeeded.occurredAt, event.occurredAt)
    && before(event.occurredAt, detail.reviewExpiresAt as string))
}

/** A checker decision must be the sole terminal event for its matching creation. */
function validArtifactDecisionTransition(entries: readonly AuditRecordValue[], event: ConnectorAuditEvent): boolean {
  const artifactId = auditDetailArtifactId(event)
  if (!artifactId) return false
  const artifactEvents = entries.filter((entry) => auditDetailArtifactId(entry.event) === artifactId)
  if (artifactEvents.length !== 1) return false
  const created = artifactEvents[0]!.event
  const createdDetail = created.detail
  const detail = event.detail
  const expectedState = event.type === 'translation.artifact.approved' ? 'approved' : 'rejected'
  return created.type === 'translation.artifact.created'
    && created.actor !== event.actor
    && created.connectorId === event.connectorId
    && created.product === event.product
    && created.workspaceId === event.workspaceId
    && createdDetail.approvalState === 'pending-checker-approval'
    && detail.approvalState === expectedState
    && sameArtifactMetadata(createdDetail, detail)
    && atOrBefore(created.occurredAt, event.occurredAt)
    && before(event.occurredAt, detail.reviewExpiresAt as string)
}

/**
 * The review event deliberately carries hashes and a proposal identifier only,
 * never document fields. It can therefore prove an independent checker and a
 * prior governed vision run in the same tenant chain, while the review packet
 * itself supplies the exact proposal/scope integrity binding.
 */
function validVisionDocumentReviewTransition(entries: readonly AuditRecordValue[], event: ConnectorAuditEvent): boolean {
  const proposalId = event.detail.proposalId
  if (typeof proposalId !== 'string' || entries.some((entry) =>
    entry.event.type === 'connector.document.owner_reviewed'
      && entry.event.detail.proposalId === proposalId)) return false

  const governedRuns = entries.filter((entry) => {
    const prior = entry.event
    return prior.type === 'connector.run.succeeded'
      && prior.connectorId === VISION_DOCUMENT_CONNECTOR_ID
      && prior.product === event.product
      && prior.workspaceId === event.workspaceId
      && sameScopes(prior.scopes, VISION_DOCUMENT_SCOPES)
      && prior.requestedItems === 1
      && atOrBefore(prior.occurredAt, event.occurredAt)
  })
  // The vision adapter's public review API also accepts a fully integrity-bound
  // proposal produced directly by the synthetic connector, without a governed
  // runner. Preserve that standalone audit contract. When governed provenance
  // is present, at least one matching maker must still be independent.
  return governedRuns.length === 0
    || governedRuns.some((entry) => typeof entry.event.actor === 'string'
      && typeof event.actor === 'string'
      && entry.event.actor.toLowerCase() !== event.actor.toLowerCase())
}

/**
 * A valid event schema and hash are not enough: each link must attach to its
 * only permitted predecessor. Replaying this at append time prevents orphaned
 * outcomes and terminal decisions from becoming durable audit history.
 */
function validAuditTransition(entries: readonly AuditRecordValue[], event: ConnectorAuditEvent): boolean {
  if (event.type === 'connector.run.requested') return true
  if (event.type === 'connector.run.succeeded' || event.type === 'connector.run.failed') return validRunOutcomeTransition(entries, event)
  if (event.type === 'translation.artifact.created') return validArtifactCreationTransition(entries, event)
  if (event.type === 'translation.artifact.approved' || event.type === 'translation.artifact.rejected') return validArtifactDecisionTransition(entries, event)
  if (event.type === 'connector.document.owner_reviewed') return validVisionDocumentReviewTransition(entries, event)
  return false
}

function artifactEventMatches(event: ConnectorAuditEvent, artifact: TranslationArtifactRecord, state: 'pending-checker-approval' | 'approved' | 'rejected'): boolean {
  const detail = event.detail
  return event.connectorId === artifact.connectorId
    && event.product === artifact.product
    && event.workspaceId === artifact.workspaceId
    && artifactDetail(detail, state)
    && detail.artifactId === artifact.id
    && detail.kind === artifact.kind
    && detail.contentHash === artifact.contentHash
    && detail.mediaType === artifact.mediaType
    && detail.source === artifact.source
    && detail.synthetic === true
    && detail.approvalState === state
    && detail.reviewPolicyVersion === artifact.reviewPolicyVersion
    && detail.reviewDigest === artifact.reviewDigest
    && detail.reviewExpiresAt === artifact.reviewExpiresAt
    && detail.runAuditHash === artifact.runAuditHash
    && detail.autoPublish === false
}

/**
 * A stored artifact is readable or decidable only when the same verified audit
 * chain proves its full lifecycle. This protects the read boundary from a
 * metadata-shaped row inserted outside the atomic mutation APIs.
 */
export async function requireTranslationArtifactLifecycleAudit(transaction: Prisma.TransactionClient, artifact: TranslationArtifactRecord): Promise<void> {
  const entries = await validatedAuditEntries(transaction, artifact.product, artifact.workspaceId)
  const succeededIndex = entries.findIndex((entry) => entry.hash === artifact.runAuditHash)
  const succeeded = entries[succeededIndex]
  const requestedAuditHash = succeeded?.event.detail.requestedAuditHash
  const requestedIndex = typeof requestedAuditHash === 'string' ? entries.findIndex((entry) => entry.hash === requestedAuditHash) : -1
  const requested = requestedIndex >= 0 ? entries[requestedIndex] : undefined
  const proposal = proposalFromArtifact(artifact)
  const succeededArtifact = succeeded?.event.detail.artifact

  if (!succeeded || !requested || requested.event.type !== 'connector.run.requested'
    || succeeded.event.type !== 'connector.run.succeeded'
    || requestedIndex >= succeededIndex
    || requested.event.connectorId !== artifact.connectorId
    || succeeded.event.connectorId !== artifact.connectorId
    || requested.event.product !== artifact.product
    || succeeded.event.product !== artifact.product
    || requested.event.workspaceId !== artifact.workspaceId
    || succeeded.event.workspaceId !== artifact.workspaceId
    || requested.event.actor !== artifact.createdBy
    || succeeded.event.actor !== artifact.createdBy
    || !sameScopes(requested.event.scopes, succeeded.event.scopes)
    || requested.event.costCapCents !== succeeded.event.costCapCents
    || requested.event.requestedItems !== succeeded.event.requestedItems
    || !artifactProposalDetail(artifact.connectorId, succeededArtifact)
    || !sameArtifactProposal(succeededArtifact, proposal)) {
    throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  }

  const lifecycle = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => {
    const detail = entry.event.detail
    return entry.event.product === artifact.product
      && entry.event.workspaceId === artifact.workspaceId
      && isObject(detail)
      && detail.artifactId === artifact.id
  })
  const created = lifecycle[0]
  if (!created
    || created.index <= succeededIndex
    || created.entry.event.type !== 'translation.artifact.created'
    || created.entry.event.actor !== artifact.createdBy
    || artifact.createdAt !== created.entry.event.occurredAt
    || !sameScopes(created.entry.event.scopes, succeeded.event.scopes)
    || created.entry.event.costCapCents !== succeeded.event.costCapCents
    || created.entry.event.requestedItems !== succeeded.event.requestedItems
    || !artifactEventMatches(created.entry.event, artifact, 'pending-checker-approval')
    || !atOrBefore(requested.event.occurredAt, succeeded.event.occurredAt)
    || !atOrBefore(succeeded.event.occurredAt, created.entry.event.occurredAt)
    || !before(created.entry.event.occurredAt, artifact.reviewExpiresAt)) {
    throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  }

  if (artifact.approvalState === 'pending-checker-approval') {
    if (lifecycle.length !== 1) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
    return
  }

  const expectedType = artifact.approvalState === 'approved' ? 'translation.artifact.approved' : 'translation.artifact.rejected'
  const decision = lifecycle[1]
  if (lifecycle.length !== 2
    || !decision
    || decision.index <= created.index
    || decision.entry.event.type !== expectedType
    || decision.entry.event.actor !== artifact.decidedBy
    || decision.entry.event.actor === artifact.createdBy
    || !sameScopes(decision.entry.event.scopes, ['translation:artifact:approve'])
    || decision.entry.event.costCapCents !== 0
    || decision.entry.event.requestedItems !== 0
    || artifact.decidedAt !== decision.entry.event.occurredAt
    || !atOrBefore(created.entry.event.occurredAt, decision.entry.event.occurredAt)
    || !before(decision.entry.event.occurredAt, artifact.reviewExpiresAt)
    || !artifactEventMatches(decision.entry.event, artifact, artifact.approvalState)) {
    throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  }
}

/**
 * A proposal can only reference a verified successful run from the same
 * connector and product/workspace chain. The artifact metadata, maker, and
 * governance context and creation instant must also be exactly compatible with
 * that successful run. This rejects an already-expired proposal before its
 * durable artifact row can be created.
 */
export async function requireSuccessfulRunAudit(transaction: Prisma.TransactionClient, input: { product: string; workspaceId: string; connectorId: string; actor: string; scopes: readonly string[]; costCapCents: number; requestedItems: number; proposal: TranslationArtifactProposal; runAuditHash: string; creationOccurredAt: string }): Promise<void> {
  if (!SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_RUN_AUDIT_LINK_INVALID')
  const entries = await validatedAuditEntries(transaction, input.product, input.workspaceId)
  const succeeded = entries.find((entry) => entry.hash === input.runAuditHash
    && entry.event.type === 'connector.run.succeeded'
    && entry.event.connectorId === input.connectorId
    && entry.event.product === input.product
    && entry.event.workspaceId === input.workspaceId)
  const requestedAuditHash = succeeded?.event.detail.requestedAuditHash
  const requested = typeof requestedAuditHash === 'string' ? entries.find((entry) => entry.hash === requestedAuditHash) : undefined
  const succeededArtifact = succeeded?.event.detail.artifact
  if (!succeeded || !requested || requested.event.type !== 'connector.run.requested'
    || requested.event.connectorId !== succeeded.event.connectorId
    || requested.event.product !== succeeded.event.product
    || requested.event.workspaceId !== succeeded.event.workspaceId
    || requested.event.actor !== succeeded.event.actor
    || JSON.stringify(requested.event.scopes) !== JSON.stringify(succeeded.event.scopes)
    || requested.event.costCapCents !== succeeded.event.costCapCents
    || requested.event.requestedItems !== succeeded.event.requestedItems
    || !atOrBefore(requested.event.occurredAt, succeeded.event.occurredAt)
    || succeeded.event.actor !== input.actor
    || JSON.stringify(succeeded.event.scopes) !== JSON.stringify(input.scopes)
    || succeeded.event.costCapCents !== input.costCapCents
    || succeeded.event.requestedItems !== input.requestedItems
    || !canonicalTimestamp(input.creationOccurredAt)
    || !atOrBefore(succeeded.event.occurredAt, input.creationOccurredAt)
    || !before(input.creationOccurredAt, input.proposal.reviewExpiresAt)
    || !artifactProposalDetail(input.connectorId, succeededArtifact)
    || !sameArtifactProposal(succeededArtifact, input.proposal)) {
    throw new ConnectorUnavailableError('TRANSLATION_RUN_AUDIT_LINK_INVALID')
  }
}

/**
 * Appends within an already-open Prisma transaction. Keeping a lifecycle
 * mutation and its audit row in the same transaction prevents a durable,
 * unaudited translation decision when the audit write fails.
 */
export async function appendAuditEvent(transaction: Prisma.TransactionClient, event: ConnectorAuditEvent): Promise<AuditAppendReceipt> {
  if (isImageAuditEvent(event)) return appendImageAuditEvent(transaction as unknown as GclRecordTransaction, event)
  const snapshot = snapshotAuditEvent(event)
  if (!snapshot || !validAuditEvent(snapshot)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  const entries = await validatedAuditEntries(transaction, snapshot.product, snapshot.workspaceId)
  if (!validAuditTransition(entries, snapshot)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  const previousHash = entries.at(-1)?.hash ?? null
  const hash = hashAuditEvent(snapshot, previousHash)
  await transaction.record.create({
    data: {
      product: snapshot.product,
      workspaceId: snapshot.workspaceId,
      moduleId: GCL_AUDIT_MODULE_ID,
      values: { event: snapshot, previousHash, hash } as Prisma.InputJsonValue,
      status: 'append-only',
      createdBy: 'gcl-audit',
    },
  })
  return { hash }
}

function isCameraAuditEvent(event: ConnectorAuditEvent): boolean {
  return typeof event.requestedBy === 'string'
    && typeof event.checkedBy === 'string'
    && typeof event.correlationId === 'string'
}

function isMarketAuditEvent(event: ConnectorAuditEvent): boolean {
  return event.connectorId === 'market' && typeof event.actor === 'string'
}

function isImageAuditEvent(event: ConnectorAuditEvent): boolean {
  return event.connectorId === 'image-tti'
    && typeof event.actor === 'string'
    && typeof event.correlationId === 'string'
}

function isJncAuditEvent(event: ConnectorAuditEvent): boolean {
  return (event.connectorId === 'text-to-3d' || event.connectorId === 'image-text-to-3d' || event.connectorId === 'game-engine')
    && typeof event.actor === 'string'
}

/** Per product/workspace append-only SHA-256 chain. Translation text and audio
 * bytes are represented by hashes only; they never enter audit records. */
export class PrismaHashChainAuditLog implements AuditLog {
  private readonly camera: CameraPrismaHashChainAuditLog
  private readonly market: MarketPrismaHashChainAuditLog
  private readonly image: ImagePrismaHashChainAuditLog
  private readonly jnc: JncPrismaHashChainAuditLog

  constructor(private readonly prisma: PrismaClient) {
    this.camera = new CameraPrismaHashChainAuditLog(prisma)
    this.market = new MarketPrismaHashChainAuditLog(prisma)
    this.image = new ImagePrismaHashChainAuditLog(prisma as unknown as GclPersistence)
    this.jnc = new JncPrismaHashChainAuditLog(prisma)
  }

  async append(event: ConnectorAuditEvent): Promise<AuditAppendReceipt> {
    if (isCameraAuditEvent(event)) return this.camera.append(event)
    if (isMarketAuditEvent(event)) return this.market.append(event)
    if (isImageAuditEvent(event)) return this.image.append(event)
    if (isJncAuditEvent(event)) return this.jnc.append(event)
    return this.prisma.$transaction((transaction) => appendAuditEvent(transaction, event))
  }
}

/** Test seam only. The application uses the durable Prisma implementation. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []
  readonly imageEntries: AuditRecordValue[] = []
  readonly jncEntries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<AuditAppendReceipt> {
    if (isCameraAuditEvent(event)) {
      const snapshot = sealAuditAppendEvent(event)
      const previousHash = this.entries.at(-1)?.hash ?? null
      const hash = hashAuditEvent(snapshot, previousHash)
      this.entries.push({ event: snapshot, previousHash, hash })
      return { hash, previousHash }
    }
    if (isMarketAuditEvent(event)) {
      const previousHash = this.entries.at(-1)?.hash ?? null
      const hash = hashAuditEvent(event, previousHash)
      this.entries.push({ event, previousHash, hash })
      return { hash }
    }
    if (isImageAuditEvent(event)) {
      const verified = verifyImageAuditChain(this.imageEntries)
      const previousHash = verified.at(-1)?.hash ?? null
      const hash = imageHashAuditEvent(event, previousHash)
      const entry = { event, previousHash, hash }
      this.imageEntries.push(entry)
      this.entries.push(entry)
      return { hash }
    }
    if (isJncAuditEvent(event)) {
      const previousHash = verifiedJncAuditChainHead(this.jncEntries)
      const hash = jncHashAuditEvent(event, previousHash)
      const entry = { event, previousHash, hash }
      verifiedJncAuditChainHead([...this.jncEntries, entry])
      this.jncEntries.push(entry)
      this.entries.push(entry)
      return { hash, previousHash }
    }
    // The durable implementation replays every stored row inside its
    // transaction. Preserve that fail-closed property in the test seam too:
    // a test or caller must not be able to mutate an old entry and then append
    // a seemingly valid continuation.
    let previousHash: string | null = null
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!
      if (!auditValue(entry)
        || entry.previousHash !== previousHash
        || entry.hash !== hashAuditEvent(entry.event, entry.previousHash)
        || !validAuditTransition(this.entries.slice(0, index), entry.event)) {
        throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
      }
      previousHash = entry.hash
    }
    const snapshot = snapshotAuditEvent(event)
    if (!snapshot || !validAuditEvent(snapshot)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    if (!validAuditTransition(this.entries, snapshot)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    const hash = hashAuditEvent(snapshot, previousHash)
    // The private data snapshot—not a JSON stringify pass over caller-owned
    // values—is the exact event both hashed and stored by this test seam.
    this.entries.push({ event: snapshot, previousHash, hash })
    return { hash }
  }
}
