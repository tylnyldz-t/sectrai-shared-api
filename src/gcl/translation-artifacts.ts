import { type Prisma, type PrismaClient } from '@prisma/client'
import { ArtifactStateError, ConnectorUnavailableError, MakerCheckerError } from './errors.js'
import type { TranslationArtifactProposal } from './types.js'

export const GCL_TRANSLATION_ARTIFACT_MODULE_ID = 'gcl-translation-artifacts'
const SHA256 = /^sha256:[a-f0-9]{64}$/
const AUDIT_SHA256 = /^[a-f0-9]{64}$/
const PROPOSAL_KEYS = ['connectorId', 'kind', 'contentHash', 'mediaType', 'source', 'synthetic', 'approvalState', 'autoPublish'] as const
const PENDING_ARTIFACT_KEYS = [...PROPOSAL_KEYS, 'runAuditHash'] as const
const DECIDED_ARTIFACT_KEYS = [...PENDING_ARTIFACT_KEYS, 'decidedAt', 'decidedBy'] as const

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

function translationArtifactProposal(value: unknown): TranslationArtifactProposal | null {
  if (!isObject(value) || !hasExactlyKeys(value, PROPOSAL_KEYS)) return null
  const input = value as Partial<TranslationArtifactProposal> & { connectorId?: unknown }
  if (typeof input.connectorId !== 'string' || typeof input.contentHash !== 'string' || !SHA256.test(input.contentHash) || input.synthetic !== true || input.approvalState !== 'pending-checker-approval' || input.autoPublish !== false) return null
  if (input.kind !== 'translated-text' && input.kind !== 'translated-speech') return null
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') return null
  if (input.source !== 'synthetic-text-translation' && input.source !== 'synthetic-speech-translation') return null
  if (!validArtifactBinding({ connectorId: input.connectorId, kind: input.kind, mediaType: input.mediaType, source: input.source })) return null
  return {
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: true,
    approvalState: 'pending-checker-approval',
    autoPublish: false,
  }
}

function storedArtifact(value: unknown): StoredArtifact | null {
  if (!isObject(value)) return null
  const input = value as Partial<StoredArtifact>
  const expectedKeys = input.approvalState === 'pending-checker-approval' ? PENDING_ARTIFACT_KEYS : DECIDED_ARTIFACT_KEYS
  if (!hasExactlyKeys(input, expectedKeys) || typeof input.connectorId !== 'string' || typeof input.contentHash !== 'string' || !SHA256.test(input.contentHash) || typeof input.runAuditHash !== 'string' || !AUDIT_SHA256.test(input.runAuditHash)) return null
  if (input.kind !== 'translated-text' && input.kind !== 'translated-speech') return null
  if (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') return null
  if (input.source !== 'synthetic-text-translation' && input.source !== 'synthetic-speech-translation') return null
  if (!validArtifactBinding({ connectorId: input.connectorId, kind: input.kind, mediaType: input.mediaType, source: input.source }) || input.synthetic !== true || input.autoPublish !== false) return null
  if (input.approvalState !== 'pending-checker-approval' && input.approvalState !== 'approved' && input.approvalState !== 'rejected') return null
  if (input.approvalState === 'pending-checker-approval' && (input.decidedAt !== undefined || input.decidedBy !== undefined)) return null
  if (input.approvalState !== 'pending-checker-approval' && (!canonicalTimestamp(input.decidedAt) || typeof input.decidedBy !== 'string' || !input.decidedBy.trim())) return null
  return {
    connectorId: input.connectorId,
    kind: input.kind,
    contentHash: input.contentHash,
    mediaType: input.mediaType,
    source: input.source,
    synthetic: true,
    approvalState: input.approvalState,
    autoPublish: false,
    runAuditHash: input.runAuditHash,
    ...(input.approvalState !== 'pending-checker-approval' ? { decidedAt: input.decidedAt, decidedBy: input.decidedBy } : {}),
  }
}

function toRecord(record: { id: string; product: string; workspaceId: string; values: Prisma.JsonValue; createdAt: Date; createdBy: string }): TranslationArtifactRecord | null {
  const stored = storedArtifact(record.values)
  return stored ? { id: record.id, product: record.product, workspaceId: record.workspaceId, createdAt: record.createdAt.toISOString(), createdBy: record.createdBy, ...stored } : null
}

/** Stores only metadata and hashes. Decisions require a checker different from the maker. */
export class PrismaTranslationArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<TranslationArtifactRecord> {
    const proposal = translationArtifactProposal({ connectorId: input.connectorId, ...input.proposal })
    if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
    const record = await this.prisma.record.create({
      data: {
        product: input.product,
        workspaceId: input.workspaceId,
        moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID,
        values: { connectorId: input.connectorId, ...proposal, runAuditHash: input.runAuditHash } as Prisma.InputJsonValue,
        status: 'pending-checker-approval',
        createdBy: input.actor,
      },
    })
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    return artifact
  }

  async get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id, product, workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    return artifact
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; now: Date }): Promise<TranslationArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
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
}

/** Test-only metadata store. It has no field for raw source or translated content. */
export class InMemoryTranslationArtifactStore {
  readonly entries: TranslationArtifactRecord[] = []

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<TranslationArtifactRecord> {
    const proposal = translationArtifactProposal({ connectorId: input.connectorId, ...input.proposal })
    if (!proposal || !AUDIT_SHA256.test(input.runAuditHash)) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_PROPOSAL_INVALID')
    const artifact: TranslationArtifactRecord = {
      id: `translation-artifact-${this.entries.length + 1}`,
      product: input.product,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      ...proposal,
      runAuditHash: input.runAuditHash,
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
      runAuditHash: artifact.runAuditHash,
      ...(artifact.approvalState === 'pending-checker-approval' ? {} : { decidedAt: artifact.decidedAt, decidedBy: artifact.decidedBy }),
    })
    if (!stored) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    return { id: artifact.id, product: artifact.product, workspaceId: artifact.workspaceId, createdAt: artifact.createdAt, createdBy: artifact.createdBy, ...stored }
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; now: Date }): Promise<TranslationArtifactRecord | null> {
    const index = this.entries.findIndex((entry) => entry.id === input.id && entry.product === input.product && entry.workspaceId === input.workspaceId)
    if (index < 0) return null
    const artifact = await this.get(input.product, input.workspaceId, input.id)
    if (!artifact) return null
    if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
    const updated: TranslationArtifactRecord = { ...artifact, approvalState: input.decision, decidedAt: input.now.toISOString(), decidedBy: input.actor }
    this.entries[index] = updated
    return { ...updated }
  }
}
