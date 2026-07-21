import { createHash } from 'node:crypto'
import { ConnectorUnavailableError } from './errors.js'
import type { GclPersistence } from './persistence.js'
import type { GclRecordTransaction } from './persistence.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'
const HASH_PATTERN = /^[a-f0-9]{64}$/

export type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

/** Reject getters, symbols, class instances, and non-finite values before hashing. */
function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorUnavailableError('GCL_AUDIT_EVENT_INVALID')
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
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
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

export function auditRecordValue(value: unknown): AuditRecordValue | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    const candidate = value as Partial<AuditRecordValue>
    if (!candidate.event || typeof candidate.event !== 'object' || Array.isArray(candidate.event) || Object.getPrototypeOf(candidate.event) !== Object.prototype || Object.getOwnPropertySymbols(candidate.event).length > 0 || typeof candidate.hash !== 'string' || !HASH_PATTERN.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !HASH_PATTERN.test(candidate.previousHash)))) return null
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
  const verified: AuditRecordValue[] = []
  let previousHash: string | null = null
  for (const value of records) {
    const record = auditRecordValue(value)
    if (!record || record.previousHash !== previousHash) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
    verified.push(record)
    previousHash = record.hash
  }
  return verified
}

/**
 * Appends under a caller-held per-workspace audit lock. Keeping the append
 * primitive transaction-local lets terminal review receipts and their audit
 * evidence commit atomically without a second, replayable write path.
 */
export async function appendAuditEvent(transaction: GclRecordTransaction, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  const previousRecords = await transaction.record.findMany({
    where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { values: true },
  })
  const previousHash = verifyAuditChain(previousRecords.map((record) => record.values)).at(-1)?.hash ?? null
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
    const previousHash = verifyAuditChain(this.entries).at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
