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

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  return createHash('sha256').update(JSON.stringify(normalize({ event, previousHash }))).digest('hex')
}

function auditValue(value: unknown): AuditRecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (!candidate.event || typeof candidate.event !== 'object' || Array.isArray(candidate.event) || typeof candidate.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.hash) || (candidate.previousHash !== null && (typeof candidate.previousHash !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.previousHash)))) return null
  return candidate as AuditRecordValue
}

/**
 * Verifies every stored link, rather than trusting only the newest row. A
 * broken chain is unavailable governance state, never a new chain root.
 */
export function verifiedAuditChainHead(values: readonly unknown[]): string | null {
  let previousHash: string | null = null
  for (const value of values) {
    const candidate = auditValue(value)
    if (!candidate || candidate.previousHash !== previousHash || candidate.hash !== hashAuditEvent(candidate.event, previousHash)) throw new AuditChainError()
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
