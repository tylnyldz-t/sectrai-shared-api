import { PrismaClient, Prisma } from '@prisma/client'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { productAuth, validProduct } from './auth.js'
import { serializeRecord } from './types.js'
import { isInternalGclModuleId, mutationFrom, scopeFrom } from './validation.js'

type AppOptions = { prisma?: PrismaClient; now?: () => Date }

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return (request, response, next) => { void Promise.resolve(handler(request, response, next)).catch(next) }
}

function cors(request: Request, response: Response, next: NextFunction): void {
  const origin = request.header('origin')
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Sectrai-Product-Key')
  response.setHeader('Access-Control-Max-Age', '600')
  next()
}

function recordIdFrom(request: Request): string {
  const recordId = request.params.recordId
  if (typeof recordId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(recordId)) throw Object.assign(new Error('INVALID_RECORD_ID'), { status: 400 })
  return recordId
}

export function createApp({ prisma = new PrismaClient(), now = () => new Date() }: AppOptions = {}) {
  const app = express()
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
    // System-owned GCL records are written only by their transaction-bound ledgers.
    if (isInternalGclModuleId(request.params.moduleId)) return response.status(404).json({ error: 'NOT_FOUND', code: 'not_found' })
    if (!validProduct(request.params.product ?? '')) return response.status(404).json({ error: 'NOT_FOUND', code: 'not_found' })
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

  app.use((error: unknown, _: Request, response: Response, __: NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) return response.status(400).json({ error: 'INVALID_JSON', code: 'invalid_json' })
    const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : 500
    return response.status(status).json({ error: error instanceof Error ? error.message : 'INTERNAL_ERROR', code: status === 500 ? 'internal_error' : 'invalid_request' })
  })
  return app
}
