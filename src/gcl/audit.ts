import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
import { AuditChainError, AuditEventError, AuditReceiptError } from './errors.js'
import { type Prisma, type PrismaClient } from '@prisma/client'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const AUDIT_EVENT_FIELDS = [
  'type', 'connectorId', 'product', 'workspaceId', 'requestedBy', 'checkedBy', 'correlationId',
  'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail',
] as const
const AUDIT_RECORD_FIELDS = ['event', 'previousHash', 'hash'] as const
const AUDIT_EVENT_TYPES: readonly ConnectorAuditEvent['type'][] = [
  'connector.run.requested', 'connector.run.succeeded', 'connector.run.failed', 'connector.run.denied', 'connector.camera.owner_reviewed',
]
const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const MAX_AUDIT_JSON_DEPTH = 8
const MAX_AUDIT_JSON_KEYS = 48
const MAX_AUDIT_JSON_ARRAY_ITEMS = 48
const MAX_AUDIT_JSON_STRING_LENGTH = 4096

type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
  }
  return value
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

/**
 * D14 accepts only the exact local hash receipt an audit append needs to bind
 * its successor. This is a data boundary, not an audit-chain lookup or a
 * signature check: it rejects shaped collaborator output before its hash can
 * become audit detail or result provenance.
 */
export function validateAuditAppendReceipt(value: unknown): { hash: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new AuditReceiptError()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AuditReceiptError()
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== 1 || names[0] !== 'hash') {
    throw new AuditReceiptError()
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'hash')
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !SHA256_PATTERN.test(descriptor.value)) {
    throw new AuditReceiptError()
  }
  return { hash: descriptor.value }
}

function auditEventRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new AuditEventError()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AuditEventError()
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== AUDIT_EVENT_FIELDS.length || names.some((name) => !AUDIT_EVENT_FIELDS.includes(name as typeof AUDIT_EVENT_FIELDS[number]))) {
    throw new AuditEventError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const field of AUDIT_EVENT_FIELDS) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditEventError()
    normalized[field] = descriptor.value
  }
  return normalized
}

function auditString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength) throw new AuditEventError()
  return value
}

function auditPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new AuditEventError()
  return value
}

function sealedAuditScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 12 || Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuditEventError()
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    throw new AuditEventError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      throw new AuditEventError()
    }
    scopes.push(descriptor.value)
  }
  return Object.freeze(scopes)
}

/**
 * D15 recursively copies only ordinary own enumerable data before an audit
 * collaborator can observe it. It keeps generic detail data opaque, but makes
 * accessors, Proxy values, cycles, non-finite numbers, and mutable aliases
 * fail closed rather than entering the hash-chain append boundary.
 */
function sealedAuditJson(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return auditString(value, MAX_AUDIT_JSON_STRING_LENGTH)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AuditEventError()
    return value
  }
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || depth >= MAX_AUDIT_JSON_DEPTH || ancestors.has(value)) {
    throw new AuditEventError()
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_AUDIT_JSON_ARRAY_ITEMS || Object.getOwnPropertySymbols(value).length > 0) {
      throw new AuditEventError()
    }
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
      throw new AuditEventError()
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const nextAncestors = new Set(ancestors).add(value)
    const snapshot: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditEventError()
      snapshot.push(sealedAuditJson(descriptor.value, depth + 1, nextAncestors))
    }
    return Object.freeze(snapshot)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AuditEventError()
  const names = Object.getOwnPropertyNames(value)
  if (names.length > MAX_AUDIT_JSON_KEYS || Object.getOwnPropertySymbols(value).length > 0) throw new AuditEventError()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const nextAncestors = new Set(ancestors).add(value)
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const name of names) {
    const descriptor = descriptors[name]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditEventError()
    snapshot[name] = sealedAuditJson(descriptor.value, depth + 1, nextAncestors)
  }
  return Object.freeze(snapshot)
}

function sealedAuditOccurredAt(value: unknown): string {
  const occurredAt = auditString(value, 40)
  const date = new Date(occurredAt)
  try {
    if (!Number.isFinite(Date.prototype.getTime.call(date)) || Date.prototype.toISOString.call(date) !== occurredAt) throw new AuditEventError()
  } catch (error) {
    if (error instanceof AuditEventError) throw error
    throw new AuditEventError()
  }
  return occurredAt
}

/**
 * D15 seals the exact event an append collaborator receives. The snapshot is
 * a local immutable copy, not a durable audit read, signature, or capability.
 */
export function sealAuditAppendEvent(value: unknown): ConnectorAuditEvent {
  const event = auditEventRecord(value)
  const type = event.type
  const connectorId = auditString(event.connectorId, 80)
  const product = auditString(event.product, 120)
  const workspaceId = auditString(event.workspaceId, 120)
  const requestedBy = auditString(event.requestedBy, 160)
  const checkedBy = auditString(event.checkedBy, 160)
  const correlationId = auditString(event.correlationId, 120)
  if (!AUDIT_EVENT_TYPES.includes(type as ConnectorAuditEvent['type']) || !CONNECTOR_ID_PATTERN.test(connectorId) || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId) || !ACTOR_PATTERN.test(requestedBy) || !ACTOR_PATTERN.test(checkedBy) || !SCOPE_ID_PATTERN.test(correlationId)) {
    throw new AuditEventError()
  }
  const detail = sealedAuditJson(event.detail)
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new AuditEventError()
  return Object.freeze({
    type: type as ConnectorAuditEvent['type'], connectorId, product, workspaceId, requestedBy, checkedBy, correlationId,
    scopes: sealedAuditScopes(event.scopes), costCapCents: auditPositiveInteger(event.costCapCents), requestedItems: auditPositiveInteger(event.requestedItems),
    occurredAt: sealedAuditOccurredAt(event.occurredAt), detail: detail as Record<string, unknown>,
  })
}

/**
 * D16 checks the one durable head that the existing Prisma append already
 * reads. It deliberately verifies only that self-contained record; it does
 * not add a history scan, lookup route, signature, or authorization surface.
 */
export function validateAuditChainHead(value: unknown): Readonly<AuditRecordValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new AuditChainError()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AuditChainError()
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== AUDIT_RECORD_FIELDS.length || names.some((name) => !AUDIT_RECORD_FIELDS.includes(name as typeof AUDIT_RECORD_FIELDS[number]))) {
    throw new AuditChainError()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const field of AUDIT_RECORD_FIELDS) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditChainError()
    normalized[field] = descriptor.value
  }

  const previousHash = normalized.previousHash
  const hash = normalized.hash
  if ((previousHash !== null && (typeof previousHash !== 'string' || !SHA256_PATTERN.test(previousHash))) || typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) {
    throw new AuditChainError()
  }

  let event: ConnectorAuditEvent
  try {
    event = sealAuditAppendEvent(normalized.event)
  } catch {
    throw new AuditChainError()
  }
  if (hash !== hashAuditEvent(event, previousHash)) throw new AuditChainError()
  return Object.freeze({ event, previousHash, hash })
}

/** D14/D15 append one immutable local event, then copy the sole safe receipt field before use. */
export async function appendVerifiedAuditEvent(auditLog: AuditLog, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  return validateAuditAppendReceipt(await auditLog.append(sealAuditAppendEvent(event)))
}

/** A per-product/workspace append-only SHA-256 chain that contains no raw media. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const previous = await transaction.record.findFirst({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const previousHash = previous ? validateAuditChainHead(previous.values).hash : null
      const hash = hashAuditEvent(event, previousHash)
      await transaction.record.create({
        data: {
          product: event.product,
          workspaceId: event.workspaceId,
          moduleId: GCL_AUDIT_MODULE_ID,
          values: { event, previousHash, hash } as Prisma.InputJsonValue,
          status: 'append-only',
          createdBy: 'gcl-audit',
        },
      })
      return { hash }
    })
  }
}

/** Test-only audit seam. The application always uses the durable log above. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    const previousHash = this.entries.at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
