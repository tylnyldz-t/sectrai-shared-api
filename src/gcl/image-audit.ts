import { createHash } from 'node:crypto'
import { ConnectorUnavailableError } from './errors.js'
import type { GclPersistence, GclRecordTransaction } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

/** Image lineage is isolated from the heterogeneous shared connector chain. */
export const GCL_AUDIT_MODULE_ID = 'gcl-image-audit'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const EVENT_TYPES = new Set<ConnectorAuditEvent['type']>(['connector.run.requested', 'connector.run.succeeded', 'connector.run.failed', 'connector.artifact.candidates_issued', 'connector.artifact.owner_liked', 'connector.artifact.owner_rejected'])
export type AuditRecordValue = { event: ConnectorAuditEvent; previousHash: string | null; hash: string }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9:_@. -]{1,160}$/.test(value) }
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
}
function assertAuditEvent(event: unknown): asserts event is ConnectorAuditEvent {
  if (!isRecord(event) || !EVENT_TYPES.has(event.type as ConnectorAuditEvent['type']) || !isIdentifier(event.connectorId) || !isIdentifier(event.product) || !isIdentifier(event.workspaceId) || !isIdentifier(event.actor) || !isIdentifier(event.correlationId) || !Array.isArray(event.scopes) || event.scopes.length < 1 || event.scopes.some((scope) => !isIdentifier(scope)) || typeof event.costCapCents !== 'number' || !Number.isSafeInteger(event.costCapCents) || event.costCapCents < 0 || typeof event.requestedItems !== 'number' || !Number.isSafeInteger(event.requestedItems) || event.requestedItems < 1 || !isTimestamp(event.occurredAt) || !isRecord(event.detail)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  canonical(event.detail)
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  assertAuditEvent(event)
  if (previousHash !== null && (typeof previousHash !== 'string' || !HASH_PATTERN.test(previousHash))) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
  return createHash('sha256').update(canonical({ event, previousHash })).digest('hex')
}
export function auditRecordValue(value: unknown): AuditRecordValue | null {
  if (!isRecord(value) || !isRecord(value.event) || (value.previousHash !== null && (typeof value.previousHash !== 'string' || !HASH_PATTERN.test(value.previousHash))) || typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) return null
  try {
    const record = value as unknown as AuditRecordValue
    return record.hash === hashAuditEvent(record.event, record.previousHash) ? record : null
  } catch { return null }
}
export function verifyAuditChain(records: readonly unknown[]): AuditRecordValue[] {
  if (!Array.isArray(records)) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
  const verified: AuditRecordValue[] = []
  let previousHash: string | null = null
  let previousTime = -Infinity
  for (const value of records) {
    const record = auditRecordValue(value)
    if (!record || record.previousHash !== previousHash) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
    const time = new Date(record.event.occurredAt).getTime()
    if (time < previousTime) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_TIME_REGRESSION')
    verified.push(record)
    previousHash = record.hash
    previousTime = time
  }
  return verified
}
export async function appendAuditEvent(transaction: GclRecordTransaction, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  assertAuditEvent(event)
  const records = await transaction.record.findMany({ where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { values: true } })
  const previous = verifyAuditChain(records.map((record) => record.values)).at(-1)
  if (previous && new Date(event.occurredAt).getTime() < new Date(previous.event.occurredAt).getTime()) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_TIME_REGRESSION')
  const previousHash = previous?.hash ?? null
  const hash = hashAuditEvent(event, previousHash)
  await transaction.record.create({ data: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID, values: { event, previousHash, hash }, status: 'append-only', createdBy: 'gcl-audit' } })
  return { hash }
}
export class ImagePrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: GclPersistence) {}
  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      return appendAuditEvent(transaction, event)
    })
  }
}
export class ImageInMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []
  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    assertAuditEvent(event)
    const previous = verifyAuditChain(this.entries).at(-1)
    if (previous && new Date(event.occurredAt).getTime() < new Date(previous.event.occurredAt).getTime()) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_TIME_REGRESSION')
    const previousHash = previous?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
