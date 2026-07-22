import { createHash, Hash } from 'node:crypto'
import { AuditChainError, AuditEventError, AuditReceiptError } from './errors.js'
import {
  intrinsicArrayIncludes, intrinsicArrayIsArray, intrinsicArrayMap, intrinsicArrayPrototype, intrinsicArraySort, intrinsicDate, intrinsicDateGetTime,
  intrinsicDateToISOString, intrinsicIsProxy, intrinsicJsonStringify, intrinsicNumberIsFinite, intrinsicNumberIsSafeInteger,
  intrinsicObjectCreate, intrinsicObjectEntries, intrinsicObjectFreeze, intrinsicObjectGetOwnPropertyDescriptors,
  intrinsicObjectGetOwnPropertyNames, intrinsicObjectGetOwnPropertySymbols, intrinsicObjectGetPrototypeOf, intrinsicObjectPrototype,
  intrinsicReflectApply, intrinsicSet, intrinsicSetAdd, intrinsicSetDelete, intrinsicSetHas, intrinsicStringLocaleCompare,
} from './intrinsics.js'
import { type Prisma, type PrismaClient } from '@prisma/client'
import type { AuditAppendReceipt, AuditLog, ConnectorAuditEvent } from './types.js'

export const GCL_AUDIT_MODULE_ID = 'gcl-audit'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const AUDIT_APPEND_RECEIPT_FIELDS = ['hash', 'previousHash'] as const
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

function arrayIncludes(values: readonly unknown[], value: unknown): boolean {
  return intrinsicReflectApply(intrinsicArrayIncludes, values, [value]) as boolean
}

function hasUnexpectedArrayName(names: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined || (name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return true
  }
  return false
}

function hasDisallowedName(names: readonly string[], allowed: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined || !arrayIncludes(allowed, name)) return true
  }
  return false
}

/**
 * D18 captures Node's hash operations while this trusted module initializes.
 * A later mutation of the public Hash prototype must not alter audit-chain
 * derivation or turn an integrity check into a collaborator-controlled hook.
 */
const intrinsicCreateHash = createHash
const intrinsicHashUpdate = Hash.prototype.update
const intrinsicHashDigest = Hash.prototype.digest
type AuditRecordValue = {
  event: ConnectorAuditEvent
  previousHash: string | null
  hash: string
}

function normalize(value: unknown): unknown {
  if (intrinsicArrayIsArray(value)) return intrinsicReflectApply(intrinsicArrayMap, value, [normalize])
  if (value && typeof value === 'object') {
    const entries = intrinsicObjectEntries(value as Record<string, unknown>)
    const ordered = intrinsicReflectApply(intrinsicArraySort, entries, [
      (leftEntry: [string, unknown], rightEntry: [string, unknown]) => intrinsicReflectApply(intrinsicStringLocaleCompare, leftEntry[0], [rightEntry[0]]) as number,
    ]) as [string, unknown][]
    const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index]
      if (!entry) throw new AuditEventError()
      normalized[entry[0]] = normalize(entry[1])
    }
    return normalized
  }
  return value
}

function sha256(value: string): string {
  const hash = intrinsicCreateHash('sha256')
  const updated = intrinsicReflectApply(intrinsicHashUpdate, hash, [value, 'utf8'])
  return intrinsicReflectApply(intrinsicHashDigest, updated, ['hex']) as string
}

export function hashAuditEvent(event: ConnectorAuditEvent, previousHash: string | null): string {
  return sha256(intrinsicJsonStringify(normalize({ event, previousHash })))
}

/**
 * D14/D17 accept only an exact own-data local append witness. D17 adds the
 * predecessor value so the sealed event can be re-hashed before either value
 * reaches audit detail or result provenance. This is not a durable lookup or
 * signature check.
 */
export function validateAuditAppendReceipt(value: unknown): AuditAppendReceipt {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) {
    throw new AuditReceiptError()
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new AuditReceiptError()
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length > 0 || names.length !== AUDIT_APPEND_RECEIPT_FIELDS.length || hasDisallowedName(names, AUDIT_APPEND_RECEIPT_FIELDS)) {
    throw new AuditReceiptError()
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const hash = descriptors.hash
  const previousHash = descriptors.previousHash
  if (!hash || !('value' in hash) || !hash.enumerable || typeof hash.value !== 'string' || !SHA256_PATTERN.test(hash.value) ||
    !previousHash || !('value' in previousHash) || !previousHash.enumerable || (previousHash.value !== null && (typeof previousHash.value !== 'string' || !SHA256_PATTERN.test(previousHash.value)))) {
    throw new AuditReceiptError()
  }
  return intrinsicObjectFreeze({ hash: hash.value, previousHash: previousHash.value })
}

function auditEventRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) {
    throw new AuditEventError()
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new AuditEventError()
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length > 0 || names.length !== AUDIT_EVENT_FIELDS.length || hasDisallowedName(names, AUDIT_EVENT_FIELDS)) {
    throw new AuditEventError()
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
  for (let index = 0; index < AUDIT_EVENT_FIELDS.length; index += 1) {
    const field = AUDIT_EVENT_FIELDS[index]
    if (field === undefined) throw new AuditEventError()
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
  if (typeof value !== 'number' || !intrinsicNumberIsSafeInteger(value) || value <= 0) throw new AuditEventError()
  return value
}

function sealedAuditScopes(value: unknown): readonly string[] {
  if (!intrinsicArrayIsArray(value) || intrinsicIsProxy(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || value.length > 12 || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
    throw new AuditEventError()
  }
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
    throw new AuditEventError()
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[`${index}`]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      throw new AuditEventError()
    }
    scopes[scopes.length] = descriptor.value
  }
  return intrinsicObjectFreeze(scopes)
}

/**
 * D15 recursively copies only ordinary own enumerable data before an audit
 * collaborator can observe it. It keeps generic detail data opaque, but makes
 * accessors, Proxy values, cycles, non-finite numbers, and mutable aliases
 * fail closed rather than entering the hash-chain append boundary.
 */
function sealedAuditJson(value: unknown, depth = 0, ancestors = new intrinsicSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return auditString(value, MAX_AUDIT_JSON_STRING_LENGTH)
  if (typeof value === 'number') {
    if (!intrinsicNumberIsFinite(value)) throw new AuditEventError()
    return value
  }
  if (!value || typeof value !== 'object' || intrinsicIsProxy(value) || depth >= MAX_AUDIT_JSON_DEPTH || intrinsicReflectApply(intrinsicSetHas, ancestors, [value])) {
    throw new AuditEventError()
  }
  if (intrinsicArrayIsArray(value)) {
    if (intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || value.length > MAX_AUDIT_JSON_ARRAY_ITEMS || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
      throw new AuditEventError()
    }
    const names = intrinsicObjectGetOwnPropertyNames(value)
    if (names.length !== value.length + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
      throw new AuditEventError()
    }
    const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
    const snapshot: unknown[] = []
    intrinsicReflectApply(intrinsicSetAdd, ancestors, [value])
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[`${index}`]
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditEventError()
        snapshot[snapshot.length] = sealedAuditJson(descriptor.value, depth + 1, ancestors)
      }
    } finally {
      intrinsicReflectApply(intrinsicSetDelete, ancestors, [value])
    }
    return intrinsicObjectFreeze(snapshot)
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new AuditEventError()
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (names.length > MAX_AUDIT_JSON_KEYS || intrinsicObjectGetOwnPropertySymbols(value).length > 0) throw new AuditEventError()
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const snapshot = intrinsicObjectCreate(null) as Record<string, unknown>
  intrinsicReflectApply(intrinsicSetAdd, ancestors, [value])
  try {
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]
      if (name === undefined) throw new AuditEventError()
      const descriptor = descriptors[name]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuditEventError()
      snapshot[name] = sealedAuditJson(descriptor.value, depth + 1, ancestors)
    }
  } finally {
    intrinsicReflectApply(intrinsicSetDelete, ancestors, [value])
  }
  return intrinsicObjectFreeze(snapshot)
}

function sealedAuditOccurredAt(value: unknown): string {
  const occurredAt = auditString(value, 40)
  const date = new intrinsicDate(occurredAt)
  try {
    if (!intrinsicNumberIsFinite(intrinsicReflectApply(intrinsicDateGetTime, date, []) as number) || intrinsicReflectApply(intrinsicDateToISOString, date, []) !== occurredAt) throw new AuditEventError()
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
  if (!arrayIncludes(AUDIT_EVENT_TYPES, type) || !CONNECTOR_ID_PATTERN.test(connectorId) || !SCOPE_ID_PATTERN.test(product) || !SCOPE_ID_PATTERN.test(workspaceId) || !ACTOR_PATTERN.test(requestedBy) || !ACTOR_PATTERN.test(checkedBy) || !SCOPE_ID_PATTERN.test(correlationId)) {
    throw new AuditEventError()
  }
  const detail = sealedAuditJson(event.detail)
  if (!detail || typeof detail !== 'object' || intrinsicArrayIsArray(detail)) throw new AuditEventError()
  return intrinsicObjectFreeze({
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
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) {
    throw new AuditChainError()
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new AuditChainError()
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length > 0 || names.length !== AUDIT_RECORD_FIELDS.length || hasDisallowedName(names, AUDIT_RECORD_FIELDS)) {
    throw new AuditChainError()
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
  for (let index = 0; index < AUDIT_RECORD_FIELDS.length; index += 1) {
    const field = AUDIT_RECORD_FIELDS[index]
    if (field === undefined) throw new AuditChainError()
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
  return intrinsicObjectFreeze({ event, previousHash, hash })
}

/**
 * D17 seals an event, checks the append witness is an exact re-hash of it,
 * and optionally pins a predecessor already known by this caller. It does not
 * read storage or prove that either hash was durably persisted.
 */
export async function appendVerifiedAuditEvent(auditLog: AuditLog, event: ConnectorAuditEvent, expectedPreviousHash?: string): Promise<AuditAppendReceipt> {
  const sealedEvent = sealAuditAppendEvent(event)
  const receipt = validateAuditAppendReceipt(await auditLog.append(sealedEvent))
  if (receipt.hash !== hashAuditEvent(sealedEvent, receipt.previousHash) || (expectedPreviousHash !== undefined && receipt.previousHash !== expectedPreviousHash)) {
    throw new AuditReceiptError()
  }
  return receipt
}

/** A per-product/workspace append-only SHA-256 chain that contains no raw media. */
export class PrismaHashChainAuditLog implements AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: ConnectorAuditEvent): Promise<AuditAppendReceipt> {
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
      return { hash, previousHash }
    })
  }
}

/** Test-only audit seam. The application always uses the durable log above. */
export class InMemoryHashChainAuditLog implements AuditLog {
  readonly entries: AuditRecordValue[] = []

  async append(event: ConnectorAuditEvent): Promise<AuditAppendReceipt> {
    const previousHash = this.entries.at(-1)?.hash ?? null
    const hash = hashAuditEvent(event, previousHash)
    this.entries[this.entries.length] = { event, previousHash, hash }
    return { hash, previousHash }
  }
}
