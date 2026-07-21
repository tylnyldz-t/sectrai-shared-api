import { PrismaClient, Prisma } from '@prisma/client'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { productAuth, validProduct } from './auth.js'
import { serializeRecord } from './types.js'
import { PrismaHashChainAuditLog, GCL_AUDIT_MODULE_ID } from './gcl/audit.js'
import { GclError } from './gcl/errors.js'
import { gameEngineConnectorFromEnvironment } from './gcl/game-engine.js'
import { ownerGateError } from './gcl/owner-gate.js'
import { EnvironmentPrismaDailyConnectorQuota, GAME_ENGINE_DAILY_QUOTA_ENV, GCL_USAGE_MODULE_ID } from './gcl/quota.js'
import { ConnectorRegistry, GovernedConnectorRunner, type RunConnectorRequest } from './gcl/registry.js'
import { connectorRunFrom, mutationFrom, scopeFrom, workspaceScopeFrom } from './validation.js'

type ConnectorRunner = { run(request: RunConnectorRequest): Promise<unknown> }
type AppOptions = { prisma?: PrismaClient; now?: () => Date; gclRunner?: ConnectorRunner; gclOwnerToken?: string; environment?: NodeJS.ProcessEnv }

const GCL_RESERVED_MODULES = new Set([GCL_AUDIT_MODULE_ID, GCL_USAGE_MODULE_ID])

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

function recordIdFrom(request: Request): string {
  const recordId = request.params.recordId
  if (typeof recordId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(recordId)) throw Object.assign(new Error('INVALID_RECORD_ID'), { status: 400 })
  return recordId
}

function gclOwnerAuth(expectedToken: string | undefined): RequestHandler {
  return (request, response, next) => {
    const error = ownerGateError(expectedToken, request.header('x-sectrai-owner-token'))
    if (error) return response.status(error.status).json({ error: error.message, code: error.code })
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

export function createApp({ prisma = new PrismaClient(), now = () => new Date(), gclRunner, environment = process.env, gclOwnerToken = environment.GCL_OWNER_TOKEN }: AppOptions = {}) {
  const app = express()
  const governedRunner = gclRunner ?? new GovernedConnectorRunner(
    new ConnectorRegistry([gameEngineConnectorFromEnvironment(environment)]),
    new PrismaHashChainAuditLog(prisma),
    new EnvironmentPrismaDailyConnectorQuota(prisma, environment, GAME_ENGINE_DAILY_QUOTA_ENV),
    now,
  )
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
    const result = await governedRunner.run({
      connectorId: connectorIdFrom(request), input: input.input, ...scope, actor: ownerActorFrom(request), ownerApproved: true,
      scopes: input.scopes, costCapCents: input.costCapCents, requestedItems: input.requestedItems,
    })
    return response.json({ result })
  }))

  app.use((error: unknown, _: Request, response: Response, __: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) return response.status(400).json({ error: 'INVALID_JSON', code: 'invalid_json' })
    if (error instanceof GclError) return response.status(error.status).json({ error: error.message, code: error.code })
    const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : 500
    return response.status(status).json({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR', code: status === 500 ? 'internal_error' : 'invalid_request' })
  })
  return app
}
