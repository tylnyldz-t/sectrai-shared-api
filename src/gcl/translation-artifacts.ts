import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { appendAuditEvent } from './audit.js'
import { ArtifactReviewBindingError, ArtifactReviewExpiredError, ArtifactStateError, ConnectorUnavailableError, MakerCheckerError } from './errors.js'
import type { ConnectorAuditEvent, TranslationArtifactProposal } from './types.js'

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
  if (input.approvalState !== 'pending-checker-approval' && (!canonicalTimestamp(input.decidedAt) || typeof input.decidedBy !== 'string' || !input.decidedBy.trim())) return null
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

function toRecord(record: { id: string; product: string; workspaceId: string; values: Prisma.JsonValue; createdAt: Date; createdBy: string }): TranslationArtifactRecord | null {
  const stored = storedArtifact(record.values)
  return stored ? { id: record.id, product: record.product, workspaceId: record.workspaceId, createdAt: record.createdAt.toISOString(), createdBy: record.createdBy, ...stored } : null
}

/** Stores only metadata and hashes. Decisions require a checker different from the maker. */
export class PrismaTranslationArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<TranslationArtifactRecord> {
    const proposal = translationArtifactProposal(input.connectorId, input.proposal)
    if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
    const pending = { connectorId: input.connectorId, ...proposal, runAuditHash: input.runAuditHash }
    const record = await this.prisma.record.create({
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
    return artifact
  }

  /** Atomically persists metadata and its creation audit row; no raw content enters either. */
  async proposeAndAudit(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord; auditHash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const proposal = translationArtifactProposal(input.connectorId, input.proposal)
      if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
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
      const audit = await appendAuditEvent(transaction, {
        type: 'translation.artifact.created', connectorId: input.connectorId, product: input.product, workspaceId: input.workspaceId, actor: input.actor, ...input.audit,
        detail: {
          artifactId: artifact.id,
          kind: artifact.kind,
          contentHash: artifact.contentHash,
          approvalState: artifact.approvalState,
          reviewDigest: artifact.reviewDigest,
          reviewExpiresAt: artifact.reviewExpiresAt,
          runAuditHash: artifact.runAuditHash,
          autoPublish: false,
        },
      })
      return { artifact, auditHash: audit.hash }
    })
  }

  async get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id, product, workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    return artifact
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; reviewDigest: string; now: Date }): Promise<TranslationArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
    if (!constantTimeEqual(input.reviewDigest, artifact.reviewDigest)) throw new ArtifactReviewBindingError()
    if (new Date(artifact.reviewExpiresAt).valueOf() <= input.now.valueOf()) throw new ArtifactReviewExpiredError()
    const approvalState = input.decision
    const decidedAt = input.now.toISOString()
    const next: TranslationArtifactRecord = { ...artifact, approvalState, decidedAt, decidedBy: input.actor }
    const updated = await this.prisma.record.updateMany({
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
    if (updated.count === 1) return next

    const current = await this.prisma.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!current) return null
    const currentArtifact = toRecord(current)
    if (!currentArtifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    if (currentArtifact.createdBy === input.actor) throw new MakerCheckerError()
    throw new ArtifactStateError()
  }

  /** The compare-and-set decision and its audit row share one transaction. */
  async decideAndAudit(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; reviewDigest: string; now: Date; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord | null; auditHash?: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
      if (!record) return { artifact: null }
      const artifact = toRecord(record)
      if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
      if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
      if (artifact.createdBy === input.actor) throw new MakerCheckerError()
      if (!constantTimeEqual(input.reviewDigest, artifact.reviewDigest)) throw new ArtifactReviewBindingError()
      if (new Date(artifact.reviewExpiresAt).valueOf() <= input.now.valueOf()) throw new ArtifactReviewExpiredError()
      const approvalState = input.decision
      const decidedAt = input.now.toISOString()
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
      const audit = await appendAuditEvent(transaction, {
        type: input.decision === 'approved' ? 'translation.artifact.approved' : 'translation.artifact.rejected', connectorId: artifact.connectorId, product: input.product, workspaceId: input.workspaceId, actor: input.actor, ...input.audit,
        detail: {
          artifactId: next.id,
          kind: next.kind,
          contentHash: next.contentHash,
          approvalState: next.approvalState,
          reviewDigest: next.reviewDigest,
          reviewExpiresAt: next.reviewExpiresAt,
          runAuditHash: next.runAuditHash,
          autoPublish: false,
        },
      })
      return { artifact: next, auditHash: audit.hash }
    })
  }
}

/** Test-only metadata store. It has no field for raw source or translated content. */
export class InMemoryTranslationArtifactStore {
  readonly entries: TranslationArtifactRecord[] = []

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
}
