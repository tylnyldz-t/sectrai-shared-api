import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { AuditChainError } from './errors.js'
import { frozenCanonicalJsonCopy, isCanonicalJsonData, isProxyValue } from './plan-integrity.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

export type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

const AUDIT_EVENT_KEYS = ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'] as const
const AUDIT_RECORD_VALUE_KEYS = ['event', 'previousHash', 'hash'] as const

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key))
}

/**
 * Audit rows are governance evidence, including when an AuditLog is called
 * directly by an internal integration or test. Read only own enumerable data
 * descriptors so an accessor, inherited field, symbol, or hidden field cannot
 * influence a durable chain hash.
 */
function ownDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (isProxyValue(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const output = Object.create(null) as Record<string, unknown>
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[name] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function strictScopeArray(value: unknown): string[] | null {
  try {
    if (isProxyValue(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1 ||
      names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return null
    const scopes: string[] = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') return null
      scopes.push(descriptor.value)
    }
    return scopes
  } catch {
    return null
  }
}

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const date = new Date(value)
    return !Number.isNaN(date.getTime()) && date.toISOString() === value
  } catch {
    return false
  }
}

function auditDetailValid(event: ConnectorAuditEvent): boolean {
  const detail = event.detail
  if (event.type === 'connector.run.requested') return exactKeys(detail, [])
  if (!exactKeys(detail, event.type === 'connector.run.succeeded' ? ['requestedAuditHash'] : ['requestedAuditHash', 'error'])) return false
  if (typeof detail.requestedAuditHash !== 'string' || !/^[a-f0-9]{64}$/.test(detail.requestedAuditHash)) return false
  return event.type !== 'connector.run.failed' || (typeof detail.error === 'string' && detail.error.length > 0 && detail.error.length <= 500)
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  const safeEvent = auditEvent(event)
  if (!safeEvent || (previousHash !== null && (typeof previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(previousHash)))) {
    throw new AuditChainError()
  }
  const safeValue = frozenCanonicalJsonCopy({ event: safeEvent, previousHash })
  return createHash('sha256').update(JSON.stringify(normalize(safeValue))).digest('hex')
}

function auditEvent(value: unknown): ConnectorAuditEvent | null {
  const event = ownDataRecord(value)
  if (!event || !exactKeys(event, AUDIT_EVENT_KEYS)) return null
  if (event.type !== 'connector.run.requested' && event.type !== 'connector.run.succeeded' && event.type !== 'connector.run.failed') return null
  if (typeof event.connectorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(event.connectorId)) return null
  if (typeof event.product !== 'string' || !/^sectrai-[a-z0-9-]{1,80}$/.test(event.product)) return null
  if (typeof event.workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(event.workspaceId)) return null
  if (typeof event.actor !== 'string' || !/^[a-zA-Z0-9:_@. -]{1,160}$/.test(event.actor)) return null
  const scopes = strictScopeArray(event.scopes)
  if (!scopes || scopes.some((scope) => !scope || scope.length > 120) || new Set(scopes).size !== scopes.length) return null
  if (typeof event.costCapCents !== 'number' || !Number.isSafeInteger(event.costCapCents) || event.costCapCents < 1) return null
  if (typeof event.requestedItems !== 'number' || !Number.isSafeInteger(event.requestedItems) || event.requestedItems < 1) return null
  if (!exactIsoTimestamp(event.occurredAt)) return null
  const detail = ownDataRecord(event.detail)
  if (!detail || !isCanonicalJsonData(detail)) return null
  const candidate: ConnectorAuditEvent = {
    type: event.type,
    connectorId: event.connectorId,
    product: event.product,
    workspaceId: event.workspaceId,
    actor: event.actor,
    scopes,
    costCapCents: event.costCapCents,
    requestedItems: event.requestedItems,
    occurredAt: event.occurredAt,
    detail: frozenCanonicalJsonCopy<Record<string, unknown>>(detail),
  }
  return auditDetailValid(candidate) ? frozenCanonicalJsonCopy<ConnectorAuditEvent>(candidate) : null
}

function auditValue(value: unknown): AuditRecordValue | null {
  const candidate = ownDataRecord(value)
  if (!candidate || !exactKeys(candidate, AUDIT_RECORD_VALUE_KEYS)) return null
  const event = auditEvent(candidate.event)
  if (!event || typeof candidate.hash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.hash) ||
    (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.previousHash)))) return null
  return frozenCanonicalJsonCopy<AuditRecordValue>({ event, previousHash: candidate.previousHash, hash: candidate.hash })
}

/**
 * Verifies every stored link, rather than trusting only the newest row. A
 * broken chain is unavailable governance state, never a new chain root.
 */
export function verifiedAuditChainHead(values: readonly unknown[]): string | null {
  let previousHash: string | null = null
  const requestedEvents = new Map<string, { event: ConnectorAuditEvent; occurredAt: number }>()
  const terminalRequests = new Set<string>()
  for (const value of values) {
    const candidate = auditValue(value)
    if (!candidate || candidate.previousHash !== previousHash || candidate.hash !== hashAuditEvent(candidate.event, previousHash)) throw new AuditChainError()
    // auditEvent has already required an exact ISO timestamp. A global wall
    // clock ordering would reject valid concurrent runs whose request and
    // terminal records interleave, so enforce the meaningful temporal link:
    // a terminal record must not predate its own request.
    const occurredAt = Date.parse(candidate.event.occurredAt)
    if (!Number.isFinite(occurredAt)) throw new AuditChainError()
    if (candidate.event.type === 'connector.run.requested') {
      requestedEvents.set(candidate.hash, { event: candidate.event, occurredAt })
    } else {
      const requestedAuditHash = candidate.event.detail.requestedAuditHash
      if (typeof requestedAuditHash !== 'string') throw new AuditChainError()
      const requested = requestedEvents.get(requestedAuditHash)
      if (!requested || terminalRequests.has(requestedAuditHash) ||
        occurredAt < requested.occurredAt ||
        requested.event.connectorId !== candidate.event.connectorId || requested.event.product !== candidate.event.product ||
        requested.event.workspaceId !== candidate.event.workspaceId || requested.event.actor !== candidate.event.actor ||
        requested.event.costCapCents !== candidate.event.costCapCents || requested.event.requestedItems !== candidate.event.requestedItems ||
        requested.event.scopes.length !== candidate.event.scopes.length || requested.event.scopes.some((scope, index) => scope !== candidate.event.scopes[index])) throw new AuditChainError()
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
    const safeEvent = auditEvent(event)
    if (!safeEvent) throw new AuditChainError()
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${safeEvent.product}:${safeEvent.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const priorRecords = await transaction.record.findMany({
        where: { product: safeEvent.product, workspaceId: safeEvent.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      const priorValues = priorRecords.map((record) => record.values)
      const previousHash = verifiedAuditChainHead(priorValues)
      const hash = hashAuditEvent(safeEvent, previousHash)
      // Verify the prospective link too. Otherwise a clock-regressed new
      // event would not be discovered until a later append, after this run
      // had already reached quota or the adapter.
      verifiedAuditChainHead([...priorValues, { event: safeEvent, previousHash, hash }])
      await transaction.record.create({
        data: {
          product: safeEvent.product, workspaceId: safeEvent.workspaceId, moduleId: GCL_AUDIT_MODULE_ID,
          values: { event: safeEvent, previousHash, hash } as Prisma.InputJsonValue,
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
    const safeEvent = auditEvent(event)
    if (!safeEvent) throw new AuditChainError()
    const previousHash = verifiedAuditChainHead(this.entries)
    const hash = hashAuditEvent(safeEvent, previousHash)
    const next = { event: safeEvent, previousHash, hash }
    verifiedAuditChainHead([...this.entries, next])
    this.entries.push(next)
    return { hash }
  }
}
