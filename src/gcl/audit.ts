import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError } from './errors.js'
import type { TranslationArtifactRecord } from './translation-artifacts.js'
import type { AuditLog, ConnectorAuditEvent, TranslationArtifactProposal } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/
const CONNECTOR_ID = /^translation-(?:text|speech)-synthetic$/
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/
const WORKSPACE_ID = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_ID = /^[a-zA-Z0-9:_@. -]{1,160}$/
const SCOPE_ID = /^[a-z][a-z0-9:-]{0,79}$/
const ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/
const REVIEW_POLICY_VERSION = 'gcl-translation-synthetic-v1'
const PROPOSAL_KEYS = ['kind', 'contentHash', 'mediaType', 'source', 'synthetic', 'approvalState', 'autoPublish', 'reviewPolicyVersion', 'reviewExpiresAt'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

/**
 * Audit rows are durable metadata, so a hash alone is not enough to trust a
 * row. This schema gate rejects hash-valid rows that carry unknown fields or
 * raw fixture content before they can become part of the next chain link.
 */
function validAuditEvent(value: unknown): value is ConnectorAuditEvent {
  if (!isObject(value) || !hasExactlyKeys(value, ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])) return false
  if (typeof value.type !== 'string'
    || !CONNECTOR_ID.test(value.connectorId as string)
    || typeof value.product !== 'string' || !PRODUCT_ID.test(value.product)
    || typeof value.workspaceId !== 'string' || !WORKSPACE_ID.test(value.workspaceId)
    || !canonicalActor(value.actor)
    || !scopes(value.scopes)
    || !safeInteger(value.costCapCents, 10_000_000)
    || !safeInteger(value.requestedItems, 100_000)
    || !canonicalTimestamp(value.occurredAt)) return false

  if (value.type === 'connector.run.requested') return isObject(value.detail) && hasExactlyKeys(value.detail, []) && value.costCapCents >= 1 && value.requestedItems >= 1
  if (value.type === 'connector.run.succeeded') {
    if (!isObject(value.detail) || value.costCapCents < 1 || value.requestedItems < 1 || typeof value.detail.requestedAuditHash !== 'string' || !SHA256.test(value.detail.requestedAuditHash)) return false
    if (hasExactlyKeys(value.detail, ['requestedAuditHash'])) return true
    return hasExactlyKeys(value.detail, ['requestedAuditHash', 'artifact']) && artifactProposalDetail(value.connectorId, value.detail.artifact)
  }
  if (value.type === 'connector.run.failed') return isObject(value.detail) && hasExactlyKeys(value.detail, ['requestedAuditHash', 'error']) && typeof value.detail.requestedAuditHash === 'string' && SHA256.test(value.detail.requestedAuditHash) && typeof value.detail.error === 'string' && ERROR_CODE.test(value.detail.error) && value.costCapCents >= 1 && value.requestedItems >= 1
  if (value.type === 'translation.artifact.created') return isObject(value.detail) && artifactDetail(value.detail, 'pending-checker-approval') && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents >= 1 && value.requestedItems >= 1
  if (value.type === 'translation.artifact.approved') return isObject(value.detail) && artifactDetail(value.detail, 'approved') && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents === 0 && value.requestedItems === 0
  if (value.type === 'translation.artifact.rejected') return isObject(value.detail) && artifactDetail(value.detail, 'rejected') && validArtifactBinding(value.connectorId, value.detail) && value.costCapCents === 0 && value.requestedItems === 0
  return false
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

function auditValue(value: unknown): AuditRecordValue | null {
  if (!isObject(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (!hasExactlyKeys(candidate, ['event', 'previousHash', 'hash']) || !validAuditEvent(candidate.event) || typeof candidate.hash !== 'string' || !SHA256.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !SHA256.test(candidate.previousHash)))) return null
  return candidate as AuditRecordValue
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
    if (!value || value.previousHash !== previousHash || value.hash !== hashAuditEvent(value.event, value.previousHash)) {
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
    || !sameScopes(created.entry.event.scopes, succeeded.event.scopes)
    || created.entry.event.costCapCents !== succeeded.event.costCapCents
    || created.entry.event.requestedItems !== succeeded.event.requestedItems
    || !artifactEventMatches(created.entry.event, artifact, 'pending-checker-approval')) {
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
    || !artifactEventMatches(decision.entry.event, artifact, artifact.approvalState)) {
    throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_LIFECYCLE_INVALID')
  }
}

/**
 * A proposal can only reference a verified successful run from the same
 * connector and product/workspace chain. The artifact metadata, maker, and
 * governance context must also be exactly the values from that successful run.
 */
export async function requireSuccessfulRunAudit(transaction: Prisma.TransactionClient, input: { product: string; workspaceId: string; connectorId: string; actor: string; scopes: readonly string[]; costCapCents: number; requestedItems: number; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<void> {
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
    || succeeded.event.actor !== input.actor
    || JSON.stringify(succeeded.event.scopes) !== JSON.stringify(input.scopes)
    || succeeded.event.costCapCents !== input.costCapCents
    || succeeded.event.requestedItems !== input.requestedItems
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
export async function appendAuditEvent(transaction: Prisma.TransactionClient, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  if (!validAuditEvent(event)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  const entries = await validatedAuditEntries(transaction, event.product, event.workspaceId)
  const previousHash = entries.at(-1)?.hash ?? null
  const hash = hashAuditEvent(event, previousHash)
  await transaction.record.create({
    data: {
      product: event.product,
      workspaceId: event.workspaceId,
      moduleId: GCL_AUDIT_MODULE_ID,
      values: { event, previousHash, hash } as Prisma.InputJsonValue,
      status: 'append-only',
      createdBy: 'gcl-audit',
    },
  })
  return { hash }
}

/** Per product/workspace append-only SHA-256 chain. Translation text and audio
 * bytes are represented by hashes only; they never enter audit records. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction((transaction) => appendAuditEvent(transaction, event))
  }
}

/** Test seam only. The application uses the durable Prisma implementation. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    if (!validAuditEvent(event)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    const previousHash = this.entries.at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
