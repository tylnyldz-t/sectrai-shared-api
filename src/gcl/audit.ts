import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'
import { AuditReceiptError } from './errors.js'
import { type Prisma, type PrismaClient } from '@prisma/client'
import type { AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

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

/** D14 appends once, then copies the sole safe receipt field before use. */
export async function appendVerifiedAuditEvent(auditLog: AuditLog, event: ConnectorAuditEvent): Promise<{ hash: string }> {
  return validateAuditAppendReceipt(await auditLog.append(event))
}

function auditValue(value: unknown): AuditRecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AuditRecordValue>
  if (!candidate.event || typeof candidate.hash !== 'string' || (candidate.previousHash !== null && typeof candidate.previousHash !== 'string')) return null
  return candidate as AuditRecordValue
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
      const previousHash = previous ? auditValue(previous.values)?.hash ?? null : null
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
