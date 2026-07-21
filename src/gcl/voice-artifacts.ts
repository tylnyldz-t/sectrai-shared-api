import { type Prisma, type PrismaClient } from '@prisma/client'
import { ArtifactStateError, ConnectorUnavailableError } from './errors.js'
import type { VoiceArtifactProposal } from './types.js'

export const GCL_VOICE_ARTIFACT_MODULE_ID = 'gcl-voice-artifacts'

export type VoiceArtifactState = 'pending-owner-approval' | 'approved' | 'rejected'
export type VoiceArtifactDecision = 'approved' | 'rejected'

export type VoiceArtifactRecord = {
  id: string
  product: string
  workspaceId: string
  connectorId: string
  kind: VoiceArtifactProposal['kind']
  contentHash: string
  mediaType: VoiceArtifactProposal['mediaType']
  source: VoiceArtifactProposal['source']
  synthetic: true
  approvalState: VoiceArtifactState
  autoPublish: false
  runAuditHash: string
  createdAt: string
  createdBy: string
  decidedAt?: string
  decidedBy?: string
}

type StoredArtifact = Omit<VoiceArtifactRecord, 'id' | 'product' | 'workspaceId' | 'createdAt' | 'createdBy'>

function storedArtifact(value: unknown): StoredArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<StoredArtifact>
  if ((input.kind !== 'transcript' && input.kind !== 'speech-audio') || typeof input.connectorId !== 'string' || typeof input.contentHash !== 'string' || (input.mediaType !== 'text/plain' && input.mediaType !== 'audio/wav') || (input.source !== 'synthetic-stt' && input.source !== 'synthetic-tts') || input.synthetic !== true || input.autoPublish !== false || typeof input.runAuditHash !== 'string') return null
  if (input.approvalState !== 'pending-owner-approval' && input.approvalState !== 'approved' && input.approvalState !== 'rejected') return null
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

function toRecord(record: { id: string; product: string; workspaceId: string; values: Prisma.JsonValue; createdAt: Date; createdBy: string }): VoiceArtifactRecord | null {
  const stored = storedArtifact(record.values)
  return stored ? { id: record.id, product: record.product, workspaceId: record.workspaceId, createdAt: record.createdAt.toISOString(), createdBy: record.createdBy, ...stored } : null
}

/** Stores approval metadata and hashes only; no transcript text or audio bytes persist here. */
export class PrismaVoiceArtifactStore {
  constructor(private readonly prisma: PrismaClient) {}

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: VoiceArtifactProposal; runAuditHash: string }): Promise<VoiceArtifactRecord> {
    const record = await this.prisma.record.create({
      data: {
        product: input.product,
        workspaceId: input.workspaceId,
        moduleId: GCL_VOICE_ARTIFACT_MODULE_ID,
        values: { connectorId: input.connectorId, ...input.proposal, runAuditHash: input.runAuditHash } as Prisma.InputJsonValue,
        status: 'pending-owner-approval',
        createdBy: input.actor,
      },
    })
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('VOICE_ARTIFACT_STORAGE_INVALID')
    return artifact
  }

  async get(product: string, workspaceId: string, id: string): Promise<VoiceArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id, product, workspaceId, moduleId: GCL_VOICE_ARTIFACT_MODULE_ID } })
    return record ? toRecord(record) : null
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: VoiceArtifactDecision; now: Date }): Promise<VoiceArtifactRecord | null> {
    const record = await this.prisma.record.findFirst({ where: { id: input.id, product: input.product, workspaceId: input.workspaceId, moduleId: GCL_VOICE_ARTIFACT_MODULE_ID } })
    if (!record) return null
    const artifact = toRecord(record)
    if (!artifact) throw new ConnectorUnavailableError('VOICE_ARTIFACT_STORAGE_INVALID')
    if (artifact.approvalState !== 'pending-owner-approval') throw new ArtifactStateError()
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

/** Test-only metadata store. It intentionally has no field for raw voice content. */
export class InMemoryVoiceArtifactStore {
  readonly entries: VoiceArtifactRecord[] = []

  async propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: VoiceArtifactProposal; runAuditHash: string }): Promise<VoiceArtifactRecord> {
    const artifact: VoiceArtifactRecord = {
      id: `voice-artifact-${this.entries.length + 1}`,
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

  async get(product: string, workspaceId: string, id: string): Promise<VoiceArtifactRecord | null> {
    const artifact = this.entries.find((entry) => entry.id === id && entry.product === product && entry.workspaceId === workspaceId)
    return artifact ? { ...artifact } : null
  }

  async decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: VoiceArtifactDecision; now: Date }): Promise<VoiceArtifactRecord | null> {
    const index = this.entries.findIndex((entry) => entry.id === input.id && entry.product === input.product && entry.workspaceId === input.workspaceId)
    if (index < 0) return null
    const artifact = this.entries[index]
    if (!artifact || artifact.approvalState !== 'pending-owner-approval') throw new ArtifactStateError()
    const updated: VoiceArtifactRecord = { ...artifact, approvalState: input.decision, decidedAt: input.now.toISOString(), decidedBy: input.actor }
    this.entries[index] = updated
    return { ...updated }
  }
}
