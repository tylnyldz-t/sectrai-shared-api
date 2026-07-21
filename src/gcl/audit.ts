import { createHash } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { ConnectorUnavailableError } from './errors.js'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

const SHA256 = /^[a-f0-9]{64}$/

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

function auditValue(value: unknown): AuditRecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (Object.keys(candidate).length !== 3 || !candidate.event || typeof candidate.hash !== 'string' || !SHA256.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !SHA256.test(candidate.previousHash)))) return null
  return candidate as AuditRecordValue
}

/** Per product/workspace append-only SHA-256 chain. Translation text and audio
 * bytes are represented by hashes only; they never enter audit records. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${event.product}:${event.workspaceId}:${GCL_AUDIT_MODULE_ID}`}))`
      const records = await transaction.record.findMany({
        where: { product: event.product, workspaceId: event.workspaceId, moduleId: GCL_AUDIT_MODULE_ID },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { values: true },
      })
      let previousHash: string | null = null
      for (const record of records) {
        const value = auditValue(record.values)
        if (!value || value.previousHash !== previousHash || value.hash !== hashAuditEvent(value.event, value.previousHash)) {
          throw new ConnectorUnavailableError('GCL_AUDIT_CHAIN_INVALID')
        }
        previousHash = value.hash
      }
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

/** Test seam only. The application uses the durable Prisma implementation. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<{ hash: string }> {
    const previousHash = this.entries.at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries.push({ event, previousHash, hash })
    return { hash }
  }
}
