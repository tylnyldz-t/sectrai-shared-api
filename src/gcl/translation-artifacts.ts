import { type Prisma, type PrismaClient } from '@prisma/client'
import { ArtifactStateError, ConnectorUnavailableError, MakerCheckerError } from './errors.js'
import type { TranslationArtifactProposal } from './types.js'

export const GCL_TRANSLATION_ARTIFACT_MODULE_ID = 'gcl-translation-artifacts'

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

function storedArtifact(value: unknown): StoredArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<StoredArtifact>
  if ((input.kind !== 'translated-text' && input.kind !== 'translated-speech') || typeof input.connectorId !== 'string' || typeof input.contentHash !== 'string' || (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') || (input.source !== 'synthetic-text-translation' && input.source !== 'synthetic-speech-translation') || input.synthetic !== true || input.autoPublish !== false || typeof input.runAuditHash !== 'string') return null
  if (input.approvalState !== 'pending-checker-approval' && input.approvalState !== 'approved' && input.approvalState !== 'rejected') return null
  if ((input.decidedAt !== undefined && typeof input.decidedAt !== 'string') || (input.decidedBy !== undefined && typeof input.decidedBy !== 'string')) return null
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
    ...(input.decidedAt ? { decidedAt: input.decidedAt } : {}),
    ...(input.decidedBy ? { decidedBy: input.decidedBy } : {}),
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
    const record = await this.prisma.record.create({
      data: {
        product: input.product,
        workspaceId: input.workspaceId,
        moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID,
        values: { connectorId: input.connectorId, ...input.proposal, runAuditHash: input.runAuditHash } as Prisma.InputJsonValue,
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
    return record ? toRecord(record) : null
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; now: Date }): Promise<TranslationArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_TRANSLATION_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('TRANSLATION_ARTIFACT_STORAGE_INVALID')
    if (artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
    const approvalState = input.decision
    const updated = await this.prisma.record.update({
      where: { id: record.id },
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
          decidedAt: input.now.toISOString(),
          decidedBy: input.actor,
        } as Prisma.InputJsonValue,
        status: approvalState,
        updatedAt: input.now,
      },
    })
    return toRecord(updated)
  }
}

/** Test-only metadata store. It has no field for raw source or translated content. */
export class InMemoryTranslationArtifactStore {
  readonly entries: TranslationArtifactRecord[] = []

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: TranslationArtifactProposal; runAuditHash: string }): Promise<TranslationArtifactRecord> {
    const artifact: TranslationArtifactRecord = {
      id: `translation-artifact-${this.entries.length + 1}`,
      product: input.product,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      ...input.proposal,
      runAuditHash: input.runAuditHash,
      createdAt: new Date(0).toISOString(),
      createdBy: input.actor,
    }
    this.entries.push(artifact)
    return { ...artifact }
  }

  async get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null> {
    const artifact = this.entries.find((entry) => entry.id === id && entry.product === product && entry.workspaceId === workspaceId)
    return artifact ? { ...artifact } : null
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: TranslationArtifactDecision; now: Date }): Promise<TranslationArtifactRecord | null> {
    const index = this.entries.findIndex((entry) => entry.id === input.id && entry.product === input.product && entry.workspaceId === input.workspaceId)
    if (index < 0) return null
    const artifact = this.entries[index]
    if (!artifact || artifact.approvalState !== 'pending-checker-approval') throw new ArtifactStateError()
    if (artifact.createdBy === input.actor) throw new MakerCheckerError()
    const updated: TranslationArtifactRecord = { ...artifact, approvalState: input.decision, decidedAt: input.now.toISOString(), decidedBy: input.actor }
    this.entries[index] = updated
    return { ...updated }
  }
}
