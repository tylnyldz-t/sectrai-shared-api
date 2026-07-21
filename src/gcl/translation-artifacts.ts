import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { appendAuditEvent, requireSuccessfulRunAudit, requireTranslationArtifactLifecycleAudit } from './audit.js'
import { ArtifactReviewBindingError, ArtifactReviewExpiredError, ArtifactStateError, ConnectorUnavailableError, MakerCheckerError } from './errors.js'
import type { AuditLog, ConnectorAuditEvent, TranslationArtifactProposal } from './types.js'

export const GCL_TRANSLATION_ARTIFACT_MODULE_ID = 'gcl-translation-artifacts'
const SHA256 = /^sha256:[a-f0-9]{64}$/
const AUDIT_SHA256 = /^[a-f0-9]{64}$/
const PROPOSAL_KEYS = ['kind', 'contentHash', 'mediaType', 'source', 'synthetic', 'approvalState', 'autoPublish', 'reviewPolicyVersion', 'reviewExpiresAt'] as const
const PENDING_ARTIFACT_KEYS = ['connectorId', ...PROPOSAL_KEYS, 'runAuditHash', 'reviewDigest'] as const
const DECIDED_ARTIFACT_KEYS = [...PENDING_ARTIFACT_KEYS, 'decidedAt', 'decidedBy'] as const
const REVIEW_POLICY_VERSION = 'gcl-translation-synthetic-v1' as const

export type TranslationArtifactState = 'pending-checker-approval' | 'approved' | 'rejected'
export type TranslationArtifactDecision = 'approved' | 'rejected'

export type TranslationArtifactRecord = {
  id: string
  product: string
  workspaceId: string
  connectorId: string
  kind: TranslationArtifactProposal['kind']
  contentHash: string
  mediaType: TranslationArtifactProposal['mediaType']
  source: TranslationArtifactProposal['source']
  synthetic: true
  approvalState: TranslationArtifactState
  autoPublish: false
  reviewPolicyVersion: typeof REVIEW_POLICY_VERSION
  reviewExpiresAt: string
  reviewDigest: string
  runAuditHash: string
  createdAt: string
  createdBy: string
  decidedAt?: string
  decidedBy?: string
}

type StoredArtifact = Omit<TranslationArtifactRecord, 'id' | 'product' | 'workspaceId' | 'createdAt' | 'createdBy'>

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
  return typeof value === 'string' && value.trim() === value && Boolean(value) && /^[a-zA-Z0-9:_@. -]{1,160}$/.test(value)
}

function canonicalNow(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return null
  return value.toISOString()
}

function validArtifactBinding(input: Pick<TranslationArtifactRecord, 'connectorId' | 'kind' | 'mediaType' | 'source'>): boolean {
  return (input.connectorId === 'translation-text-synthetic' && input.kind === 'translated-text' && input.mediaType === 'text/plain' && input.source === 'synthetic-text-translation')
    || (input.connectorId === 'translation-speech-synthetic' && input.kind === 'translated-speech' && input.mediaType === 'audio/wav' && input.source === 'synthetic-speech-translation')
}

type ReviewDigestInput = Pick<TranslationArtifactRecord, 'connectorId' | 'kind' | 'contentHash' | 'mediaType' | 'source' | 'synthetic' | 'autoPublish' | 'reviewPolicyVersion' | 'reviewExpiresAt' | 'runAuditHash'>
type ArtifactAuditContext = Pick<ConnectorAuditEvent, 'scopes' | 'costCapCents' | 'requestedItems' | 'occurredAt'>

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Exact metadata binding a checker must echo; it never contains translation or audio content. */
export function translationArtifactReviewDigest(input: ReviewDigestInput): string {
  return digest({
    connectorId: input.connectorId,
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: input.synthetic,
    autoPublish: input.autoPublish,
    reviewPolicyVersion: input.reviewPolicyVersion,
    reviewExpiresAt: input.reviewExpiresAt,
    runAuditHash: input.runAuditHash,
  })
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
}

function translationArtifactProposal(connectorId: string, value: unknown): TranslationArtifactProposal | null {
  if (!isObject(value) || !hasExactlyKeys(value, PROPOSAL_KEYS)) return null
  const input = value as Partial<TranslationArtifactProposal>
  if (typeof input.contentHash !== 'string' || !SHA256.test(input.contentHash) || input.synthetic !== true || input.approvalState !== 'pending-checker-approval' || input.autoPublish !== false || input.reviewPolicyVersion !== REVIEW_POLICY_VERSION || !canonicalTimestamp(input.reviewExpiresAt)) return null
  if (input.kind !== 'translated-text' && input.kind !== 'translated-speech') return null
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') return null
  if (input.source !== 'synthetic-text-translation' && input.source !== 'synthetic-speech-translation') return null
  if (!validArtifactBinding({ connectorId, kind: input.kind, mediaType: input.mediaType, source: input.source })) return null
  return {
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: true,
    approvalState: 'pending-checker-approval',
    autoPublish: false,
    reviewPolicyVersion: REVIEW_POLICY_VERSION,
    reviewExpiresAt: input.reviewExpiresAt,
  }
}

function storedArtifact(value: unknown): StoredArtifact | null {
  if (!isObject(value)) return null
  const input = value as Partial<StoredArtifact>
  const expectedKeys = input.approvalState === 'pending-checker-approval' ? PENDING_ARTIFACT_KEYS : DECIDED_ARTIFACT_KEYS
  if (!hasExactlyKeys(input, expectedKeys) || typeof input.connectorId !== 'string' || typeof input.contentHash !== 'string' || !SHA256.test(input.contentHash) || typeof input.runAuditHash !== 'string' || !AUDIT_SHA256.test(input.runAuditHash) || typeof input.reviewDigest !== 'string' || !SHA256.test(input.reviewDigest)) return null
  if (input.kind !== 'translated-text' && input.kind !== 'translated-speech') return null
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') return null
  if (input.source !== 'synthetic-text-translation' && input.source !== 'synthetic-speech-translation') return null
  if (!validArtifactBinding({ connectorId: input.connectorId, kind: input.kind, mediaType: input.mediaType, source: input.source }) || input.synthetic !== true || input.autoPublish !== false || input.reviewPolicyVersion !== REVIEW_POLICY_VERSION || !canonicalTimestamp(input.reviewExpiresAt)) return null
  if (input.approvalState !== 'pending-checker-approval' && input.approvalState !== 'approved' && input.approvalState !== 'rejected') return null
  if (input.approvalState === 'pending-checker-approval' && (input.decidedAt !== undefined || input.decidedBy !== undefined)) return null
  if (input.approvalState !== 'pending-checker-approval' && (!canonicalTimestamp(input.decidedAt) || !canonicalActor(input.decidedBy))) return null
  const artifact: StoredArtifact = {
    connectorId: input.connectorId,
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: true,
    approvalState: input.approvalState,
    autoPublish: false,
    reviewPolicyVersion: REVIEW_POLICY_VERSION,
    reviewExpiresAt: input.reviewExpiresAt,
    reviewDigest: input.reviewDigest,
    runAuditHash: input.runAuditHash,
    ...(input.approvalState !== 'pending-checker-approval' ? { decidedAt: input.decidedAt, decidedBy: input.decidedBy } : {}),
  }
  return constantTimeEqual(artifact.reviewDigest, translationArtifactReviewDigest(artifact)) ? artifact : null
}

/** A decision's durable row and audit event must share one canonical instant. */
function validDecisionAuditInput(input: { actor: string; decision: TranslationArtifactDecision; now: Date; audit: ArtifactAuditContext }): boolean {
  const decidedAt = canonicalNow(input.now)
  return Boolean(decidedAt)
    && canonicalActor(input.actor)
    && (input.decision === 'approved' || input.decision === 'rejected')
    && Array.isArray(input.audit.scopes)
    && input.audit.scopes.length === 1
    && input.audit.scopes[0] === 'translation:artifact:approve'
    && input.audit.costCapCents === 0
    && input.audit.requestedItems === 0
    && input.audit.occurredAt === decidedAt
}

/** A record envelope is part of the artifact state: values alone are not trusted. */
function toRecord(record: { id: string; product: string; workspaceId: string; values: Prisma.JsonValue; status: string | null; createdAt: Date; createdBy: string }): TranslationArtifactRecord | null {
  const stored = storedArtifact(record.values)
  if (!stored
    || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(record.id)
    || typeof record.product !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(record.product)
    || typeof record.workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(record.workspaceId)
    || record.status !== stored.approvalState
    || !canonicalActor(record.createdBy)
    || !(record.createdAt instanceof Date) || Number.isNaN(record.createdAt.valueOf())) return null
  return { id: record.id, product: record.product, workspaceId: record.workspaceId, createdAt: record.createdAt.toISOString(), createdBy: record.createdBy, ...stored }
}

/** The audit lock held by requireSuccessfulRunAudit makes this one-use check serializable per workspace. */
async function requireUnusedRunAudit(transaction: Prisma.TransactionClient, input: { product: string; workspaceId: string; runAuditHash: string }): Promise<void> {
  const records = await transaction.record.findMany({
    where: { product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID },
    select: { values: true, status: true, createdBy: true },
  })
  for (const record of records) {
    const existing = storedArtifact(record.values)
    if (!existing || record.status !== existing.approvalState || !canonicalActor(record.createdBy)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    if (existing.runAuditHash === input.runAuditHash) throw new ConnectorUnavailableError('TRANSLATION_RUN_AUDIT_ALREADY_BOUND')
  }
}

function artifactAuditEvent(input: { artifact: TranslationArtifactRecord; product: string; workspaceId: string; actor: string; audit: ArtifactAuditContext; type: 'translation.artifact.created' | 'translation.artifact.approved' | 'translation.artifact.rejected' }): ConnectorAuditEvent {
  const { artifact } = input
  return {
    type: input.type,
    connectorId: artifact.connectorId,
    product: input.product,
    workspaceId: input.workspaceId,
    actor: input.actor,
    ...input.audit,
    detail: {
      artifactId: artifact.id,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      source: artifact.source,
      synthetic: true,
      approvalState: artifact.approvalState,
      reviewPolicyVersion: artifact.reviewPolicyVersion,
      reviewDigest: artifact.reviewDigest,
      reviewExpiresAt: artifact.reviewExpiresAt,
      runAuditHash: artifact.runAuditHash,
      autoPublish: false,
    },
  }
}

/** Stores only metadata and hashes. Every production mutation includes its audit write. */
export class PrismaTranslationArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Atomically persists metadata and its creation audit row; no raw content enters either. */
  async proposeAndAudit(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord; auditHash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const proposal = translationArtifactProposal(input.connectorId, input.proposal)
      if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
      await requireSuccessfulRunAudit(transaction, {
        product: input.product,
        workspaceId: input.workspaceId,
        connectorId: input.connectorId,
        actor: input.actor,
        scopes: input.audit.scopes,
        costCapCents: input.audit.costCapCents,
        requestedItems: input.audit.requestedItems,
        proposal,
        runAuditHash: input.runAuditHash,
      })
      await requireUnusedRunAudit(transaction, input)
      const pending = { connectorId: input.connectorId, ...proposal, runAuditHash: input.runAuditHash }
      const record = await transaction.record.create({
        data: {
          product: input.product,
          workspaceId: input.workspaceId,
          moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID,
          values: { ...pending, reviewDigest: translationArtifactReviewDigest(pending) } as Prisma.InputJsonValue,
          status: 'pending-checker-approval',
          createdBy: input.actor,
        },
      })
      const artifact = toRecord(record)
      if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
      const audit = await appendAuditEvent(transaction, artifactAuditEvent({ artifact, product: input.product, workspaceId: input.workspaceId, actor: input.actor, audit: input.audit, type: 'translation.artifact.created' }))
      return { artifact, auditHash: audit.hash }
    })
  }

  async get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.record.findFirst({ where: { id, product, workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
      if (!record) return null
      const artifact = toRecord(record)
      if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
      await requireTranslationArtifactLifecycleAudit(transaction, artifact)
      return artifact
    })
  }

  /** The compare-and-set decision and its audit row share one transaction. */
  async decideAndAudit(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; reviewDigest: string; now: Date; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord | null; auditHash?: string }> {
    if (!validDecisionAuditInput(input)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_DECISION_AUDIT_INVALID')
    const decidedAt = input.now.toISOString()
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
      if (!record) return { artifact: null }
      const artifact = toRecord(record)
      if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
      await requireTranslationArtifactLifecycleAudit(transaction, artifact)
      if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
      if (artifact.createdBy === input.actor) throw new MakerCheckerError()
      if (!constantTimeEqual(input.reviewDigest, artifact.reviewDigest)) throw new ArtifactReviewBindingError()
      if (new Date(artifact.reviewExpiresAt).valueOf() <= input.now.valueOf()) throw new ArtifactReviewExpiredError()
      const approvalState = input.decision
      const next: TranslationArtifactRecord = { ...artifact, approvalState, decidedAt, decidedBy: input.actor }
      const updated = await transaction.record.updateMany({
        where: { id: record.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID, status: 'pending-checker-approval' },
        data: {
          values: {
            connectorId: artifact.connectorId,
            kind: artifact.kind,
            contentHash: artifact.contentHash,
            mediaType: artifact.mediaType,
            source: artifact.source,
            synthetic: true,
            approvalState,
            autoPublish: false,
            reviewPolicyVersion: artifact.reviewPolicyVersion,
            reviewExpiresAt: artifact.reviewExpiresAt,
            reviewDigest: artifact.reviewDigest,
            runAuditHash: artifact.runAuditHash,
            decidedAt,
            decidedBy: input.actor,
          } as Prisma.InputJsonValue,
          status: approvalState,
          updatedAt: input.now,
        },
      })
      if (updated.count !== 1) {
        const current = await transaction.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
        if (!current) return { artifact: null }
        const currentArtifact = toRecord(current)
        if (!currentArtifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
        if (currentArtifact.createdBy === input.actor) throw new MakerCheckerError()
        throw new ArtifactStateError()
      }
      const audit = await appendAuditEvent(transaction, artifactAuditEvent({ artifact: next, product: input.product, workspaceId: input.workspaceId, actor: input.actor, audit: input.audit, type: input.decision === 'approved' ? 'translation.artifact.approved' : 'translation.artifact.rejected' }))
      return { artifact: next, auditHash: audit.hash }
    })
  }
}

/** Test-only metadata store. It has no field for raw source or translated content. */
export class InMemoryTranslationArtifactStore {
  readonly entries: TranslationArtifactRecord[] = []

  constructor(private readonly auditLog?: AuditLog) {}

  private requireAuditLog(): AuditLog {
    if (!this.auditLog) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_AUDIT_NOT_CONFIGURED')
    return this.auditLog
  }

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<TranslationArtifactRecord> {
    const proposal = translationArtifactProposal(input.connectorId, input.proposal)
    if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
    const pending = { connectorId: input.connectorId, ...proposal, runAuditHash: input.runAuditHash }
    const artifact: TranslationArtifactRecord = {
      id: `translation-artifact-${this.entries.length + 1}`,
      product: input.product,
      workspaceId: input.workspaceId,
      ...pending,
      reviewDigest: translationArtifactReviewDigest(pending),
      createdAt: new Date(0).toISOString(),
      createdBy: input.actor,
    }
    this.entries.push(artifact)
    return { ...artifact }
  }

  /** Test seam that mirrors the production atomic write contract. */
  async proposeAndAudit(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord; auditHash: string }> {
    const auditLog = this.requireAuditLog()
    const before = this.entries.length
    const artifact = await this.propose(input)
    try {
      const audit = await auditLog.append(artifactAuditEvent({ artifact, product: input.product, workspaceId: input.workspaceId, actor: input.actor, audit: input.audit, type: 'translation.artifact.created' }))
      return { artifact, auditHash: audit.hash }
    } catch (error) {
      this.entries.splice(before)
      throw error
    }
  }

  async get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null> {
    const artifact = this.entries.find((entry) => entry.id === id && entry.product === product && entry.workspaceId === workspaceId)
    if (!artifact) return null
    const stored = storedArtifact({
      connectorId: artifact.connectorId,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      source: artifact.source,
      synthetic: artifact.synthetic,
      approvalState: artifact.approvalState,
      autoPublish: artifact.autoPublish,
      reviewPolicyVersion: artifact.reviewPolicyVersion,
      reviewExpiresAt: artifact.reviewExpiresAt,
      reviewDigest: artifact.reviewDigest,
      runAuditHash: artifact.runAuditHash,
      ...(artifact.approvalState === 'pending-checker-approval' ? {} : { decidedAt: artifact.decidedAt, decidedBy: artifact.decidedBy }),
    })
    if (!stored) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    return { id: artifact.id, product: artifact.product, workspaceId: artifact.workspaceId, createdAt: artifact.createdAt, createdBy: artifact.createdBy, ...stored }
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; reviewDigest: string; now: Date }): Promise<TranslationArtifactRecord | null> {
    const index = this.entries.findIndex((entry) => entry.id === input.id && entry.product === input.product && entry.workspaceId === input.workspaceId)
    if (index < 0) return null
    const artifact = await this.get(input.product, input.workspaceId, input.id)
    if (!artifact) return null
    if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
    if (!constantTimeEqual(input.reviewDigest, artifact.reviewDigest)) throw new ArtifactReviewBindingError()
    if (new Date(artifact.reviewExpiresAt).valueOf() <= input.now.valueOf()) throw new ArtifactReviewExpiredError()
    const updated: TranslationArtifactRecord = { ...artifact, approvalState: input.decision, decidedAt: input.now.toISOString(), decidedBy: input.actor }
    this.entries[index] = updated
    return { ...updated }
  }

  /** Test seam that restores the prior entry when its corresponding audit fails. */
  async decideAndAudit(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; reviewDigest: string; now: Date; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord | null; auditHash?: string }> {
    const auditLog = this.requireAuditLog()
    const index = this.entries.findIndex((entry) => entry.id === input.id && entry.product === input.product && entry.workspaceId === input.workspaceId)
    if (index < 0) return { artifact: null }
    const prior = { ...this.entries[index]! }
    const artifact = await this.decide(input)
    if (!artifact) return { artifact: null }
    try {
      const audit = await auditLog.append(artifactAuditEvent({ artifact, product: input.product, workspaceId: input.workspaceId, actor: input.actor, audit: input.audit, type: input.decision === 'approved' ? 'translation.artifact.approved' : 'translation.artifact.rejected' }))
      return { artifact, auditHash: audit.hash }
    } catch (error) {
      this.entries[index] = prior
      throw error
    }
  }
}
