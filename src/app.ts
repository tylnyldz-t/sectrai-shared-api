import { PrismaClient, Prisma } from '@prisma/client'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { productAuth, validProduct } from './auth.js'
import { PrismaHashChainAuditLog, GCL_AUDIT_MODULE_ID } from './gcl/audit.js'
import { GclError } from './gcl/errors.js'
import { EnvironmentPrismaDailyConnectorQuota, GCL_USAGE_MODULE_ID } from './gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from './gcl/registry.js'
import { translationConnectorsFromEnvironment } from './gcl/translation.js'
import { GCL_TRANSLATION_ARTIFACT_MODULE_ID, PrismaTranslationArtifactStore, type TranslationArtifactRecord } from './gcl/translation-artifacts.js'
import type { AuditLog, ConnectorAuditEvent, ConnectorResult } from './gcl/types.js'
import { serializeRecord } from './types.js'
import { connectorRunFrom, mutationFrom, scopeFrom, translationArtifactApprovalFrom, workspaceScopeFrom } from './validation.js'

type ConnectorRunner = { run(request: RunConnectorRequest): Promise<ConnectorResult> }
type ArtifactAuditContext = Pick<ConnectorAuditEvent, 'scopes' | 'costCapCents' | 'requestedItems' | 'occurredAt'>
type TranslationArtifactStore = {
  propose(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: NonNullable<ConnectorResult['artifact']>; runAuditHash: string }): Promise<TranslationArtifactRecord>
  get(product: string, workspaceId: string, id: string): Promise<TranslationArtifactRecord | null>
  decide(input: { product: string; workspaceId: string; id: string; actor: string; decision: 'approved' | 'rejected'; reviewDigest: string; now: Date }): Promise<TranslationArtifactRecord | null>
  proposeAndAudit?(input: { product: string; workspaceId: string; actor: string; connectorId: string; proposal: NonNullable<ConnectorResult['artifact']>; runAuditHash: string; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord; auditHash: string }>
  decideAndAudit?(input: { product: string; workspaceId: string; id: string; actor: string; decision: 'approved' | 'rejected'; reviewDigest: string; now: Date; audit: ArtifactAuditContext }): Promise<{ artifact: TranslationArtifactRecord | null; auditHash?: string }>
}
type AppOptions = { prisma?: PrismaClient; now?: () => Date; gclRunner?: ConnectorRunner; gclOwnerToken?: string; gclAuditLog?: AuditLog; translationArtifactStore?: TranslationArtifactStore }

const GCL_RESERVED_MODULES = new Set([GCL_AUDIT_MODULE_ID, GCL_USAGE_MODULE_ID, GCL_TRANSLATION_ARTIFACT_MODULE_ID])

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return (request, response, next) => { void Promise.resolve(handler(request, response, next)).catch(next) }
}

function cors(request: Request, response: Response, next: NextFunction): void {
  const origin = request.header('origin')
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Sectrai-Product-Key,X-Sectrai-Owner-Token,X-Sectrai-Owner-Actor')
  response.setHeader('Access-Control-Max-Age', '600')
  next()
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return different === 0
}

function gclOwnerAuth(expectedToken: string | undefined): RequestHandler {
  return (request, response, next) => {
    const supplied = request.header('x-sectrai-owner-token')
    if (!expectedToken) return response.status(503).json({ error: 'GCL_OWNER_GATE_NOT_CONFIGURED', code: 'connector_unavailable' })
    if (!supplied || !constantTimeEqual(supplied, expectedToken)) return response.status(403).json({ error: 'OWNER_APPROVAL_REQUIRED', code: 'owner_approval_required' })
    return next()
  }
}

function ownerActorFrom(request: Request): string {
  const actor = request.header('x-sectrai-owner-actor')
  if (!actor || !/^[a-zA-Z0-9:_@. -]{1,160}$/.test(actor)) throw Object.assign(new Error('INVALID_OWNER_ACTOR'), { status: 422 })
  return actor
}

function connectorIdFrom(request: Request): string {
  const connectorId = request.params.connectorId
  if (typeof connectorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(connectorId)) throw Object.assign(new Error('INVALID_CONNECTOR_ID'), { status: 400 })
  return connectorId
}

function recordIdFrom(request: Request): string {
  const recordId = request.params.recordId
  if (typeof recordId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(recordId)) throw Object.assign(new Error('INVALID_RECORD_ID'), { status: 400 })
  return recordId
}

export function createApp({ prisma = new PrismaClient(), now = () => new Date(), gclRunner, gclOwnerToken = process.env.GCL_OWNER_TOKEN, gclAuditLog, translationArtifactStore }: AppOptions = {}) {
  const app = express()
  const auditLog = gclAuditLog ?? new PrismaHashChainAuditLog(prisma)
  const governedRunner = gclRunner ?? new GovernedConnectorRunner(
    new ConnectorRegistry(translationConnectorsFromEnvironment()),
    auditLog,
    new EnvironmentPrismaDailyConnectorQuota(prisma),
    now,
  )
  const artifacts = translationArtifactStore ?? new PrismaTranslationArtifactStore(prisma)
  app.disable('x-powered-by')
  app.use(cors)
  app.options('*splat', (_, response) => response.sendStatus(204))
  app.use(express.json({ limit: '64kb' }))

  app.get('/healthz', asyncRoute(async (_, response) => {
    await prisma.$queryRaw`SELECT 1`
    response.json({ ok: true, database: 'postgresql' })
  }))

  const base = '/api/products/:product/workspaces/:workspaceId/modules/:moduleId/records'
  app.use(base, (request, response, next) => {
    if (!validProduct(request.params.product ?? '')) return response.status(404).json({ error: 'NOT_FOUND', code: 'not_found' })
    if (GCL_RESERVED_MODULES.has(request.params.moduleId ?? '')) return response.status(404).json({ error: 'NOT_FOUND', code: 'not_found' })
    return productAuth(request, response, next)
  })

  app.get(base, asyncRoute(async (request, response) => {
    const scope = scopeFrom(request)
    const records = await prisma.record.findMany({ where: scope, orderBy: { createdAt: 'desc' } })
    response.json({ records: records.map(serializeRecord) })
  }))

  app.post(base, asyncRoute(async (request, response) => {
    const scope = scopeFrom(request)
    const input = mutationFrom(request.body, true)
    const record = await prisma.record.create({ data: { ...scope, values: input.values as Prisma.InputJsonValue, status: input.status, createdBy: input.createdBy ?? 'sectrai-demo-owner' } })
    response.status(201).json({ record: serializeRecord(record) })
  }))

  app.patch(`${base}/:recordId`, asyncRoute(async (request, response) => {
    const scope = scopeFrom(request)
    const input = mutationFrom(request.body, false)
    const existing = await prisma.record.findFirst({ where: { ...scope, id: recordIdFrom(request) } })
    if (!existing) return response.status(404).json({ error: 'RECORD_NOT_FOUND', code: 'record_not_found' })
    const record = await prisma.record.update({ where: { id: existing.id }, data: { values: input.values as Prisma.InputJsonValue, status: input.status, updatedAt: now() } })
    return response.json({ record: serializeRecord(record) })
  }))

  app.delete(`${base}/:recordId`, asyncRoute(async (request, response) => {
    const scope = scopeFrom(request)
    const existing = await prisma.record.findFirst({ where: { ...scope, id: recordIdFrom(request) } })
    if (!existing) return response.status(404).json({ error: 'RECORD_NOT_FOUND', code: 'record_not_found' })
    await prisma.record.delete({ where: { id: existing.id } })
    return response.status(204).end()
  }))

  const gclBase = '/api/products/:product/workspaces/:workspaceId/gcl'
  app.use(gclBase, (request, response, next) => {
    if (!validProduct(request.params.product ?? '')) return response.status(404).json({ error: 'NOT_FOUND', code: 'not_found' })
    return productAuth(request, response, next)
  })

  app.post(`${gclBase}/connectors/:connectorId/runs`, gclOwnerAuth(gclOwnerToken), asyncRoute(async (request, response) => {
    const scope = workspaceScopeFrom(request)
    const input = connectorRunFrom(request.body)
    const connectorId = connectorIdFrom(request)
    const actor = ownerActorFrom(request)
    const result = await governedRunner.run({
      connectorId,
      input: input.input,
      ...scope,
      actor,
      ownerApproved: true,
      scopes: input.scopes,
      costCapCents: input.costCapCents,
      requestedItems: input.requestedItems,
    })
    if (!result.artifact || !result.provenance.auditHash) return response.json({ result })
    const artifactAuditContext: ArtifactAuditContext = {
      scopes: [...input.scopes].sort(), costCapCents: input.costCapCents, requestedItems: input.requestedItems, occurredAt: now().toISOString(),
    }
    if (artifacts.proposeAndAudit) {
      const persisted = await artifacts.proposeAndAudit({ product: scope.product, workspaceId: scope.workspaceId, actor, connectorId, proposal: result.artifact, runAuditHash: result.provenance.auditHash, audit: artifactAuditContext })
      return response.json({ result, artifact: { ...persisted.artifact, auditHash: persisted.auditHash } })
    }
    const artifact = await artifacts.propose({ product: scope.product, workspaceId: scope.workspaceId, actor, connectorId, proposal: result.artifact, runAuditHash: result.provenance.auditHash })
    const artifactAudit = await auditLog.append({
      type: 'translation.artifact.created', connectorId, product: scope.product, workspaceId: scope.workspaceId, actor, ...artifactAuditContext,
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
    })
    return response.json({ result, artifact: { ...artifact, auditHash: artifactAudit.hash } })
  }))

  const artifactBase = `${gclBase}/translation-artifacts`
  app.get(`${artifactBase}/:recordId`, gclOwnerAuth(gclOwnerToken), asyncRoute(async (request, response) => {
    const scope = workspaceScopeFrom(request)
    ownerActorFrom(request)
    const artifact = await artifacts.get(scope.product, scope.workspaceId, recordIdFrom(request))
    if (!artifact) return response.status(404).json({ error: 'TRANSLATION_ARTIFACT_NOT_FOUND', code: 'translation_artifact_not_found' })
    return response.json({ artifact })
  }))

  app.post(`${artifactBase}/:recordId/approval`, gclOwnerAuth(gclOwnerToken), asyncRoute(async (request, response) => {
    const scope = workspaceScopeFrom(request)
    const actor = ownerActorFrom(request)
    const decision = translationArtifactApprovalFrom(request.body)
    const artifactAuditContext: ArtifactAuditContext = {
      scopes: ['translation:artifact:approve'], costCapCents: 0, requestedItems: 0, occurredAt: now().toISOString(),
    }
    if (artifacts.decideAndAudit) {
      const persisted = await artifacts.decideAndAudit({ ...scope, id: recordIdFrom(request), actor, decision: decision.decision, reviewDigest: decision.reviewDigest, now: now(), audit: artifactAuditContext })
      if (!persisted.artifact || !persisted.auditHash) return response.status(404).json({ error: 'TRANSLATION_ARTIFACT_NOT_FOUND', code: 'translation_artifact_not_found' })
      return response.json({ artifact: persisted.artifact, auditHash: persisted.auditHash })
    }
    const artifact = await artifacts.decide({ ...scope, id: recordIdFrom(request), actor, decision: decision.decision, reviewDigest: decision.reviewDigest, now: now() })
    if (!artifact) return response.status(404).json({ error: 'TRANSLATION_ARTIFACT_NOT_FOUND', code: 'translation_artifact_not_found' })
    const artifactAudit = await auditLog.append({
      type: decision.decision === 'approved' ? 'translation.artifact.approved' : 'translation.artifact.rejected', connectorId: artifact.connectorId,
      product: scope.product, workspaceId: scope.workspaceId, actor, ...artifactAuditContext,
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
    })
    return response.json({ artifact, auditHash: artifactAudit.hash })
  }))

  app.use((error: unknown, _: Request, response: Response, __: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) return response.status(400).json({ error: 'INVALID_JSON', code: 'invalid_json' })
    if (error instanceof GclError) return response.status(error.status).json({ error: error.message, code: error.code })
    const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : 500
    return response.status(status).json({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR', code: status === 500 ? 'internal_error' : 'invalid_request' })
  })
  return app
}
