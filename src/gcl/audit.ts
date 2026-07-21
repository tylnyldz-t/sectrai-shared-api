import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { AuditChainError } from './errors.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

export type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

function jsonData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    const valid = value.every((item) => jsonData(item, seen))
    seen.delete(value)
    return valid
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  const valid = Object.values(value).every((item) => jsonData(item, seen))
  seen.delete(value)
  return valid
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key))
}

function auditDetailValid(event: ConnectorAuditEvent): boolean {
  const detail = event.detail
  if (!jsonData(detail)) return false
  if (event.type === 'connector.run.requested') return exactKeys(detail, [])
  if (!exactKeys(detail, event.type === 'connector.run.succeeded' ? ['requestedAuditHash'] : ['requestedAuditHash', 'error'])) return false
  if (typeof detail.requestedAuditHash !== 'string' || !/^[a-f0-9]{64}$/i.test(detail.requestedAuditHash)) return false
  return event.type !== 'connector.run.failed' || (typeof detail.error === 'string' && detail.error.length > 0 && detail.error.length <= 500)
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

function auditEvent(value: unknown): ConnectorAuditEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  const allowed = new Set(['type', 'connectorId', 'product', 'workspaceId', 'actor', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'])
  if (Object.keys(event).some((key) => !allowed.has(key))) return null
  if (event.type !== 'connector.run.requested' && event.type !== 'connector.run.succeeded' && event.type !== 'connector.run.failed') return null
  if (typeof event.connectorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(event.connectorId)) return null
  if (typeof event.product !== 'string' || !/^sectrai-[a-z0-9-]{1,80}$/.test(event.product)) return null
  if (typeof event.workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(event.workspaceId)) return null
  if (typeof event.actor !== 'string' || !/^[a-zA-Z0-9:_@. -]{1,160}$/.test(event.actor)) return null
  if (!Array.isArray(event.scopes) || event.scopes.length === 0 || event.scopes.some((scope) => typeof scope !== 'string' || !scope || scope.length > 120) || new Set(event.scopes).size !== event.scopes.length) return null
  if (typeof event.costCapCents !== 'number' || !Number.isSafeInteger(event.costCapCents) || event.costCapCents < 1) return null
  if (typeof event.requestedItems !== 'number' || !Number.isSafeInteger(event.requestedItems) || event.requestedItems < 1) return null
  if (typeof event.occurredAt !== 'string' || Number.isNaN(Date.parse(event.occurredAt)) || new Date(event.occurredAt).toISOString() !== event.occurredAt) return null
  if (!event.detail || typeof event.detail !== 'object' || Array.isArray(event.detail) || !jsonData(event.detail)) return null
  const candidate = event as ConnectorAuditEvent
  return auditDetailValid(candidate) ? candidate : null
}

function auditValue(value: unknown): AuditRecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (!exactKeys(candidate as Record<string, unknown>, ['event', 'previousHash', 'hash'])) return null
  const event = auditEvent(candidate.event)
  if (!event || typeof candidate.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.previousHash)))) return null
  return { event, previousHash: candidate.previousHash ?? null, hash: candidate.hash }
}

/**
 * Verifies every stored link, rather than trusting only the newest row. A
 * broken chain is unavailable governance state, never a new chain root.
 */
export function verifiedAuditChainHead(values: readonly unknown[]): string | null {
  let previousHash: string | null = null
  const requestedEvents = new Map<string, ConnectorAuditEvent>()
  const terminalRequests = new Set<string>()
  for (const value of values) {
    const candidate = auditValue(value)
    if (!candidate || candidate.previousHash !== previousHash || candidate.hash !== hashAuditEvent(candidate.event, previousHash)) throw new AuditChainError()
    if (candidate.event.type === 'connector.run.requested') {
      requestedEvents.set(candidate.hash, candidate.event)
    } else {
      const requestedAuditHash = candidate.event.detail.requestedAuditHash
      const requested = typeof requestedAuditHash === 'string' ? requestedEvents.get(requestedAuditHash) : undefined
      if (!requested || terminalRequests.has(requestedAuditHash) ||
        requested.connectorId !== candidate.event.connectorId || requested.product !== candidate.event.product ||
        requested.workspaceId !== candidate.event.workspaceId || requested.actor !== candidate.event.actor ||
        requested.costCapCents !== candidate.event.costCapCents || requested.requestedItems !== candidate.event.requestedItems ||
        requested.scopes.length !== candidate.event.scopes.length || requested.scopes.some((scope, index) => scope !== candidate.event.scopes[index])) throw new AuditChainError()
      terminalRequests.add(requestedAuditHash)
    }
    previousHash = candidate.hash
  }
  return previousHash
}

/** Durable, workspace-scoped SHA-256 audit chain in the existing record store. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const priorRecords = await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      const previousHash = verifiedAuditChainHead(priorRecords.map((record) => record.values))
      const hash = hashAuditEvent(event, previousHash)
      await transaction.record.create({
        data: {
          product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID,
          values: { event, previousHash, hash } as Prisma.InputJsonValue,
          status: 'append-only', createdBy: 'gcl-audit',
        },
      })
      return { hash }
    })
  }
}

/** Test-only seam; production wiring always uses the durable audit log. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    const previousHash = this.entries.at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
