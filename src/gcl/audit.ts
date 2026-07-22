import { createHash } from 'node:crypto'
import { ConnectorUnavailableError } from './errors.js'
import type { GclPersistence } from './persistence.js'
import type { GclRecordTransaction } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'
const HASH_PATTERN = /^[a-f0-9]{64}$/
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const AUDIT_EVENT_TYPES = new Set<ConnectorAuditEvent['type']>([
  'connector.run.requested',
  'connector.run.succeeded',
  'connector.run.failed',
  'connector.artifact.candidates_issued',
  'connector.artifact.owner_liked',
  'connector.artifact.owner_rejected',
])
const AUDIT_EVENT_KEYS = ['type', 'connectorId', 'product', 'workspaceId', 'actor', 'correlationId', 'scopes', 'costCapCents', 'requestedItems', 'occurredAt', 'detail'] as const
const MAX_AUDIT_SCOPES = 16

export type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.getOwnPropertyNames(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** Reject accessors, symbols, class instances, and arrays before reading event fields. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

/** Copy only dense own-data arrays, so a stored record list cannot run a getter. */
function plainArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || Object.keys(descriptors).length !== length + 1) return null
    const items: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || descriptor.get || descriptor.set) return null
      items.push(descriptor.value)
    }
    return items
  } catch { return null }
}

/** Reject sparse, accessor-bearing, or extra-property scope arrays without reading their elements. */
function scopes(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_AUDIT_SCOPES || Object.keys(descriptors).length !== length + 1) return null
    const items: string[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'string' || !IDENTIFIER_PATTERN.test(descriptor.value)) return null
      items.push(descriptor.value)
    }
    return new Set(items).size === items.length ? items : null
  } catch { return null }
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : null
}

/** Normalize arrays from descriptors so nested audit detail cannot execute an accessor. */
function normalizeArray(value: unknown[]): unknown[] {
  try {
    const items = plainArray(value)
    if (!items) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    return items.map(normalize)
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  }
}

/**
 * Audit records are a closed, data-only envelope. The detail payload remains
 * connector-specific, but its complete nested shape must be normalizable
 * before it can become part of the hash chain.
 */
function assertAuditEvent(event: unknown): number {
  const value = plainRecord(event)
  if (!value || !exactKeys(value, AUDIT_EVENT_KEYS) || typeof value.type !== 'string' || !AUDIT_EVENT_TYPES.has(value.type as ConnectorAuditEvent['type']) || typeof value.connectorId !== 'string' || !IDENTIFIER_PATTERN.test(value.connectorId) || typeof value.product !== 'string' || !IDENTIFIER_PATTERN.test(value.product) || typeof value.workspaceId !== 'string' || !IDENTIFIER_PATTERN.test(value.workspaceId) || typeof value.actor !== 'string' || !IDENTIFIER_PATTERN.test(value.actor) || typeof value.correlationId !== 'string' || !IDENTIFIER_PATTERN.test(value.correlationId) || !scopes(value.scopes) || typeof value.costCapCents !== 'number' || !Number.isSafeInteger(value.costCapCents) || value.costCapCents < 0 || typeof value.requestedItems !== 'number' || !Number.isSafeInteger(value.requestedItems) || value.requestedItems < 1 || !plainRecord(value.detail)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  const occurredAt = canonicalTimestamp(value.occurredAt)
  if (occurredAt === null) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  normalize(value.detail)
  return occurredAt
}

/** Reject getters, symbols, class instances, and non-finite values before hashing. */
function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    return value
  }
  if (Array.isArray(value)) return normalizeArray(value)
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    return Object.fromEntries(Object.entries(descriptors).sort(([left], [right]) => left.localeCompare(right)).map(([key, descriptor]) => [key, normalize(descriptor.value)]))
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  }
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  assertAuditEvent(event)
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

export function auditRecordValue(value: unknown): AuditRecordValue | null {
  try {
    const candidate = plainRecord(value)
    if (!candidate || !exactKeys(candidate, ['event', 'previousHash', 'hash']) || !plainRecord(candidate.event) || typeof candidate.hash !== 'string' || !HASH_PATTERN.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !HASH_PATTERN.test(candidate.previousHash)))) return null
    const record = candidate as AuditRecordValue
    return record.hash === hashAuditEvent(record.event, record.previousHash) ? record : null
  } catch { return null }
}

/**
 * Verifies every stored link, not only the newest entry. Callers must supply
 * records in the same ascending createdAt/id order used by the persistence
 * queries below. A valid standalone hash with a broken predecessor is invalid.
 */
export function verifyAuditChain(records: readonly unknown[]): AuditRecordValue[] {
  const orderedRecords = plainArray(records)
  if (!orderedRecords) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
  const verified: AuditRecordValue[] = []
  let previousHash: string | null = null
  let previousOccurredAt: number | null = null
  for (const value of orderedRecords) {
    const record = auditRecordValue(value)
    if (!record || record.previousHash !== previousHash) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
    const occurredAt = assertAuditEvent(record.event)
    if (previousOccurredAt !== null && occurredAt < previousOccurredAt) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_TIME_REGRESSION')
    verified.push(record)
    previousHash = record.hash
    previousOccurredAt = occurredAt
  }
  return verified
}

/**
 * Appends under a caller-held per-workspace audit lock. Keeping the append
 * primitive transaction-local lets terminal review receipts and their audit
 * evidence commit atomically without a second, replayable write path.
 */
export async function appendAuditEvent(transaction: GclRecordTransaction, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  const occurredAt = assertAuditEvent(event)
  const previousRecords = await transaction.record.findMany({
    where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { values: true },
  })
  const verifiedRecords = verifyAuditChain(previousRecords.map((record) => record.values))
  const previous = verifiedRecords.at(-1)
  if (previous && occurredAt < assertAuditEvent(previous.event)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_TIME_REGRESSION')
  const previousHash = previous?.hash ?? null
  const hash = hashAuditEvent(event, previousHash)
  await transaction.record.create({
    data: {
      product: event.product,
      workspaceId: event.workspaceId,
      moduleId: GCL_AUDIT_MODULE_ID,
      values: { event, previousHash, hash },
      status: 'append-only',
      createdBy: 'gcl-audit',
    },
  })
  return { hash }
}

/** A durable per-workspace SHA-256 chain stored in the existing Record backbone. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: GclPersistence) {}

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      return appendAuditEvent(transaction, event)
    })
  }
}

/** Test-only seam; application wiring must use the durable implementation. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    const occurredAt = assertAuditEvent(event)
    const verifiedEntries = verifyAuditChain(this.entries)
    const previous = verifiedEntries.at(-1)
    if (previous && occurredAt < assertAuditEvent(previous.event)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_TIME_REGRESSION')
    const previousHash = previous?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
