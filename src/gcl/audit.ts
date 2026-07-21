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

export function auditRecordValue(value: unknown): AuditRecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (!candidate.event || typeof candidate.event !== 'object' || Array.isArray(candidate.event) || typeof candidate.hash !== 'string' || !HASH_PATTERN.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !HASH_PATTERN.test(candidate.previousHash)))) return null
  try {
    const record = candidate as AuditRecordValue
    return record.hash === hashAuditEvent(record.event, record.previousHash) ? record : null
  } catch { return null }
}

/**
 * Appends under a caller-held per-workspace audit lock. Keeping the append
 * primitive transaction-local lets terminal review receipts and their audit
 * evidence commit atomically without a second, replayable write path.
 */
export async function appendAuditEvent(transaction: GclRecordTransaction, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  const previous = await transaction.record.findFirst({
    where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const previousRecord = previous ? auditRecordValue(previous.values) : null
  if (previous && !previousRecord) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
  const previousHash = previousRecord?.hash ?? null
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
    const previous = this.entries.at(-1)
    if (previous && !auditRecordValue(previous)) throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
    const previousHash = previous?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
