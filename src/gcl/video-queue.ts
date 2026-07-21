import { randomUUID } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError, QueueError } from './errors.js'
import type { ConnectorRunContext } from './types.js'
import type { SyntheticVideoRequest } from './video.js'

export const GCL_VIDEO_QUEUE_MODULE_ID = 'gcl-video-queue'
export const VIDEO_LIVE_STATUS = 'LIVE_DISABLED' as const

export type SyntheticVideoJob = {
  id: string
  state: 'queued'
  mode: 'SYNTHETIC'
  liveStatus: typeof VIDEO_LIVE_STATUS
  publication: 'OWNER_APPROVAL_REQUIRED'
  artifact: { kind: 'video'; state: 'NOT_GENERATED'; autoPublish: false }
  connectorId: string
  product: string
  workspaceId: string
  requestedAt: string
  request: SyntheticVideoRequest
  untrustedContent: { source: 'video-generation-request'; value: SyntheticVideoRequest; handling: 'data-only'; instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' }
}

export type VideoQueueRequest = Pick<ConnectorRunContext, 'product' | 'workspaceId' | 'actor' | 'now'> & {
  connectorId: string
  input: SyntheticVideoRequest
}

export type VideoQueueScope = Pick<ConnectorRunContext, 'product' | 'workspaceId'>

export interface VideoJobQueue {
  preflight(scope: VideoQueueScope): Promise<void> | void
  enqueue(request: VideoQueueRequest): Promise<SyntheticVideoJob>
  list(scope: VideoQueueScope): Promise<SyntheticVideoJob[]>
}

export type VideoQueueConfig = { maxQueuedJobs: number }

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function newJob(id: string, request: VideoQueueRequest): SyntheticVideoJob {
  const requestedAt = request.now().toISOString()
  return {
    id,
    state: 'queued',
    mode: 'SYNTHETIC',
    liveStatus: VIDEO_LIVE_STATUS,
    publication: 'OWNER_APPROVAL_REQUIRED',
    artifact: { kind: 'video', state: 'NOT_GENERATED', autoPublish: false },
    connectorId: request.connectorId,
    product: request.product,
    workspaceId: request.workspaceId,
    requestedAt,
    request: request.input,
    untrustedContent: {
      source: 'video-generation-request',
      value: request.input,
      handling: 'data-only',
      instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
    },
  }
}

function storedJob(id: string, value: unknown): SyntheticVideoJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<SyntheticVideoJob>
  if (candidate.id !== id || candidate.state !== 'queued' || candidate.mode !== 'SYNTHETIC' || candidate.liveStatus !== VIDEO_LIVE_STATUS || candidate.publication !== 'OWNER_APPROVAL_REQUIRED') return null
  if (!candidate.artifact || candidate.artifact.kind !== 'video' || candidate.artifact.state !== 'NOT_GENERATED' || candidate.artifact.autoPublish !== false) return null
  if (typeof candidate.connectorId !== 'string' || typeof candidate.product !== 'string' || typeof candidate.workspaceId !== 'string' || typeof candidate.requestedAt !== 'string') return null
  if (!candidate.request || typeof candidate.request !== 'object' || Array.isArray(candidate.request)) return null
  if (!candidate.untrustedContent || candidate.untrustedContent.handling !== 'data-only' || candidate.untrustedContent.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS') return null
  return candidate as SyntheticVideoJob
}

/**
 * Durable queue ledger for deliberately non-executing synthetic video work.
 * A separate, owner-approved worker would be needed before any real artifact
 * could exist; this class never contacts a provider or writes media bytes.
 */
export class PrismaVideoJobQueue implements VideoJobQueue {
  constructor(private readonly prisma: PrismaClient, private readonly config: VideoQueueConfig) {}

  private assertConfigured(): void {
    if (!positiveInteger(this.config.maxQueuedJobs)) throw new ConnectorUnavailableError('VIDEO_QUEUE_NOT_CONFIGURED')
  }

  async preflight({ product, workspaceId }: VideoQueueScope): Promise<void> {
    this.assertConfigured()
    const queued = await this.prisma.record.count({ where: { product, workspaceId, moduleId: GCL_VIDEO_QUEUE_MODULE_ID, status: 'queued' } })
    if (queued >= this.config.maxQueuedJobs) throw new QueueError('VIDEO_QUEUE_FULL')
  }

  async enqueue(request: VideoQueueRequest): Promise<SyntheticVideoJob> {
    this.assertConfigured()
    const id = `video-${randomUUID()}`
    const job = newJob(id, request)
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${request.product}:${request.workspaceId}:${GCL_VIDEO_QUEUE_MODULE_ID}`}))`
      const queued = await transaction.record.count({ where: { product: request.product, workspaceId: request.workspaceId, moduleId: GCL_VIDEO_QUEUE_MODULE_ID, status: 'queued' } })
      if (queued >= this.config.maxQueuedJobs) throw new QueueError('VIDEO_QUEUE_FULL')
      await transaction.record.create({
        data: {
          id,
          product: request.product,
          workspaceId: request.workspaceId,
          moduleId: GCL_VIDEO_QUEUE_MODULE_ID,
          values: job as Prisma.InputJsonValue,
          status: 'queued',
          createdBy: request.actor,
        },
      })
    })
    return job
  }

  async list({ product, workspaceId }: VideoQueueScope): Promise<SyntheticVideoJob[]> {
    const records = await this.prisma.record.findMany({
      where: { product, workspaceId, moduleId: GCL_VIDEO_QUEUE_MODULE_ID, status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    return records.map((record) => storedJob(record.id, record.values)).filter((job): job is SyntheticVideoJob => job !== null)
  }
}

/** Resolves queue capacity at run time; absent configuration closes video runs. */
export class EnvironmentPrismaVideoJobQueue implements VideoJobQueue {
  constructor(private readonly prisma: PrismaClient, private readonly environment: NodeJS.ProcessEnv = process.env) {}

  private queue(): PrismaVideoJobQueue { return new PrismaVideoJobQueue(this.prisma, videoQueueFromEnvironment(this.environment)) }

  async preflight(scope: VideoQueueScope): Promise<void> { return this.queue().preflight(scope) }
  async enqueue(request: VideoQueueRequest): Promise<SyntheticVideoJob> { return this.queue().enqueue(request) }
  async list(scope: VideoQueueScope): Promise<SyntheticVideoJob[]> {
    const records = await this.prisma.record.findMany({
      where: { product: scope.product, workspaceId: scope.workspaceId, moduleId: GCL_VIDEO_QUEUE_MODULE_ID, status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    return records.map((record) => storedJob(record.id, record.values)).filter((job): job is SyntheticVideoJob => job !== null)
  }
}

/** Test-only seam; application construction always uses the Prisma queue. */
export class InMemoryVideoJobQueue implements VideoJobQueue {
  readonly jobs: SyntheticVideoJob[] = []
  private sequence = 0

  constructor(private readonly config: VideoQueueConfig) {}

  async preflight(scope: VideoQueueScope): Promise<void> {
    if (!positiveInteger(this.config.maxQueuedJobs)) throw new ConnectorUnavailableError('VIDEO_QUEUE_NOT_CONFIGURED')
    if (this.jobs.filter((job) => job.product === scope.product && job.workspaceId === scope.workspaceId && job.state === 'queued').length >= this.config.maxQueuedJobs) throw new QueueError('VIDEO_QUEUE_FULL')
  }

  async enqueue(request: VideoQueueRequest): Promise<SyntheticVideoJob> {
    await this.preflight(request)
    const job = newJob(`synthetic-video-${++this.sequence}`, request)
    this.jobs.push(job)
    return job
  }

  async list(scope: VideoQueueScope): Promise<SyntheticVideoJob[]> {
    return this.jobs.filter((job) => job.product === scope.product && job.workspaceId === scope.workspaceId)
  }
}

export function videoQueueFromEnvironment(environment: NodeJS.ProcessEnv = process.env): VideoQueueConfig {
  const maxQueuedJobs = positiveInteger(environment.GCL_VIDEO_QUEUE_MAX_QUEUED_JOBS)
  if (!maxQueuedJobs) throw new ConnectorUnavailableError('VIDEO_QUEUE_NOT_CONFIGURED')
  return { maxQueuedJobs }
}
