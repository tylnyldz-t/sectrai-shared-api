import { ConnectorInputError, CostCapError, ConnectorUnavailableError, OwnerGateError, ScopeError } from './errors.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorRunContext, ConnectorSuccessAuditDetail } from './types.js'

export type RunConnectorRequest = {
  connectorId: string
  input: unknown
  product: string
  workspaceId: string
  actor: string
  correlationId: string
  ownerApproved: boolean
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
}

const ID_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const SUCCESS_AUDIT_DETAIL_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/
const SUCCESS_AUDIT_DETAIL_STRING_LIMIT = 256
const MAX_SCOPES = 16
const RUN_REQUEST_KEYS = ['connectorId', 'input', 'product', 'workspaceId', 'actor', 'correlationId', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems'] as const
const PROVENANCE_REQUIRED_KEYS = ['connectorId', 'source', 'retrievedAt', 'untrustedContent'] as const
const PROVENANCE_OPTIONAL_KEYS = ['actorId', 'runId', 'datasetId'] as const

type DataMethod = (...args: unknown[]) => unknown

type DataProperty =
  | { found: false }
  | { found: true; valid: false }
  | { found: true; valid: true; value: unknown }

type DataMethodResolution = { found: boolean; method: DataMethod | null }

type ConnectorCapabilities = {
  connector: Connector
  id: string
  scopes: readonly string[]
  preflight: DataMethod | null
  run: DataMethod
  successAuditDetail: DataMethod | null
}

function isSafeNonNegativeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.getOwnPropertyNames(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** Read a closed own-data envelope without evaluating a caller-owned getter. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

/** Copy only dense own-data arrays before inspecting scope or registry entries. */
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

/** Resolve a data field or method without evaluating an own/prototype accessor. */
function dataProperty(value: unknown, name: string): DataProperty {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return { found: false }
    let target: object | null = value
    const visited = new Set<object>()
    while (target && target !== Object.prototype && target !== Function.prototype && !visited.has(target)) {
      visited.add(target)
      const descriptor = Object.getOwnPropertyDescriptor(target, name)
      if (descriptor) return descriptor.get || descriptor.set ? { found: true, valid: false } : { found: true, valid: true, value: descriptor.value }
      target = Object.getPrototypeOf(target)
    }
    return { found: false }
  } catch { return { found: false } }
}

function dataMethod(value: unknown, name: string): DataMethodResolution {
  const property = dataProperty(value, name)
  return property.found && property.valid && typeof property.value === 'function'
    ? { found: true, method: property.value as DataMethod }
    : { found: property.found, method: null }
}

function requiredDataMethod(value: unknown, name: string, error: string): DataMethod {
  const resolution = dataMethod(value, name)
  if (!resolution.found || !resolution.method) throw new ConnectorUnavailableError(error)
  return resolution.method
}

function identifierList(value: unknown): string[] | null {
  const items = plainArray(value)
  if (!items || items.length < 1 || items.length > MAX_SCOPES || items.some((item) => typeof item !== 'string' || !ID_PATTERN.test(item))) return null
  const scopes = items as string[]
  return new Set(scopes).size === scopes.length ? scopes : null
}

function connectorCapabilities(value: unknown): ConnectorCapabilities {
  const id = dataProperty(value, 'id')
  const kind = dataProperty(value, 'kind')
  const authKind = dataProperty(value, 'authKind')
  const scopes = dataProperty(value, 'scopes')
  const run = dataMethod(value, 'run')
  const preflight = dataMethod(value, 'preflight')
  const successAuditDetail = dataMethod(value, 'successAuditDetail')
  const scopeList = scopes.found && scopes.valid ? identifierList(scopes.value) : null
  if (!id.found || !id.valid || typeof id.value !== 'string' || !ID_PATTERN.test(id.value) || !kind.found || !kind.valid || (kind.value !== 'external-data' && kind.value !== 'media-generation') || !authKind.found || !authKind.valid || (authKind.value !== 'owner-token' && authKind.value !== 'oauth') || !scopeList || !run.found || !run.method || (preflight.found && !preflight.method) || (successAuditDetail.found && !successAuditDetail.method)) throw new ConnectorUnavailableError('CONNECTOR_CONFIGURATION_INVALID')
  return {
    connector: value as Connector,
    id: id.value,
    scopes: scopeList,
    preflight: preflight.method,
    run: run.method,
    successAuditDetail: successAuditDetail.method,
  }
}

function runRequest(value: unknown): RunConnectorRequest {
  const request = plainRecord(value)
  const scopes = request ? identifierList(request.scopes) : null
  if (!request || !exactKeys(request, RUN_REQUEST_KEYS) || typeof request.connectorId !== 'string' || !ID_PATTERN.test(request.connectorId) || typeof request.product !== 'string' || !ID_PATTERN.test(request.product) || typeof request.workspaceId !== 'string' || !ID_PATTERN.test(request.workspaceId) || typeof request.actor !== 'string' || !ID_PATTERN.test(request.actor) || typeof request.correlationId !== 'string' || !ID_PATTERN.test(request.correlationId) || typeof request.ownerApproved !== 'boolean' || !scopes || typeof request.costCapCents !== 'number' || !isSafeNonNegativeInteger(request.costCapCents) || typeof request.requestedItems !== 'number' || !Number.isSafeInteger(request.requestedItems)) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  return {
    connectorId: request.connectorId,
    input: request.input,
    product: request.product,
    workspaceId: request.workspaceId,
    actor: request.actor,
    correlationId: request.correlationId,
    ownerApproved: request.ownerApproved,
    scopes,
    costCapCents: request.costCapCents,
    requestedItems: request.requestedItems,
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** Use a copied built-in Date so a test seam cannot override date methods. */
function currentDate(clock: unknown): Date {
  try {
    if (typeof clock !== 'function') throw new Error('INVALID_CLOCK')
    const value = clock()
    if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) throw new Error('INVALID_CLOCK')
    const timestamp = Date.prototype.getTime.call(value)
    if (!Number.isFinite(timestamp)) throw new Error('INVALID_CLOCK')
    return new Date(timestamp)
  } catch { throw new ConnectorUnavailableError('CONNECTOR_CLOCK_INVALID') }
}

function returnedAuditHash(value: unknown): string {
  const response = plainRecord(value)
  if (!response || !exactKeys(response, ['hash']) || typeof response.hash !== 'string' || !HASH_PATTERN.test(response.hash)) throw new ConnectorUnavailableError('GCL_AUDIT_APPEND_INVALID')
  return response.hash
}

/** Reject accessor-bearing or unbounded connector audit detail before storage. */
function successAuditDetail(value: unknown): ConnectorSuccessAuditDetail {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
    const detail: ConnectorSuccessAuditDetail = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const item = descriptor.value
      if (key === 'requestedAuditHash' || !SUCCESS_AUDIT_DETAIL_KEY_PATTERN.test(key) || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) || (typeof item === 'string' && item.length > SUCCESS_AUDIT_DETAIL_STRING_LIMIT) || (typeof item === 'number' && !Number.isFinite(item))) throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
      detail[key] = item
    }
    return detail
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
  }
}

/** Copy and bind a connector result before any success detail or response spread reads it. */
function connectorResult(value: unknown, connectorId: string): ConnectorResult {
  const result = plainRecord(value)
  const provenance = result ? plainRecord(result.provenance) : null
  const content = provenance ? plainRecord(provenance.untrustedContent) : null
  const provenanceKeys = provenance ? Object.getOwnPropertyNames(provenance) : []
  if (!result || !exactKeys(result, ['data', 'provenance', 'confidence']) || !provenance || !PROVENANCE_REQUIRED_KEYS.every((key) => provenanceKeys.includes(key)) || provenanceKeys.some((key) => !PROVENANCE_REQUIRED_KEYS.includes(key as (typeof PROVENANCE_REQUIRED_KEYS)[number]) && !PROVENANCE_OPTIONAL_KEYS.includes(key as (typeof PROVENANCE_OPTIONAL_KEYS)[number])) || provenance.connectorId !== connectorId || typeof provenance.source !== 'string' || !ID_PATTERN.test(provenance.source) || !canonicalTimestamp(provenance.retrievedAt) || (provenance.actorId !== undefined && (typeof provenance.actorId !== 'string' || !ID_PATTERN.test(provenance.actorId))) || (provenance.runId !== undefined && (typeof provenance.runId !== 'string' || !ID_PATTERN.test(provenance.runId))) || (provenance.datasetId !== undefined && (typeof provenance.datasetId !== 'string' || !ID_PATTERN.test(provenance.datasetId))) || !content || !exactKeys(content, ['source', 'value', 'handling', 'instructionPolicy']) || typeof content.source !== 'string' || !ID_PATTERN.test(content.source) || content.handling !== 'data-only' || content.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' || typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new ConnectorUnavailableError('INVALID_CONNECTOR_RESULT')
  return {
    data: result.data,
    provenance: {
      connectorId: provenance.connectorId,
      source: provenance.source,
      retrievedAt: provenance.retrievedAt,
      ...(provenance.actorId === undefined ? {} : { actorId: provenance.actorId }),
      ...(provenance.runId === undefined ? {} : { runId: provenance.runId }),
      ...(provenance.datasetId === undefined ? {} : { datasetId: provenance.datasetId }),
      untrustedContent: {
        source: content.source,
        value: content.value,
        handling: 'data-only',
        instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
      },
    },
    confidence: result.confidence,
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()

  constructor(connectors: readonly Connector[]) {
    const entries = plainArray(connectors)
    if (!entries) throw new ConnectorUnavailableError('CONNECTOR_REGISTRY_INVALID')
    for (const connector of entries) {
      const capabilities = connectorCapabilities(connector)
      if (this.connectors.has(capabilities.id)) throw new Error(`DUPLICATE_CONNECTOR:${capabilities.id}`)
      this.connectors.set(capabilities.id, capabilities.connector)
    }
  }

  get(connectorId: string): Connector {
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
    return connector
  }
}

/**
 * Shared GCL policy order: closed request envelope, owner approval,
 * identity/cost/scopes, connector preflight, append-only audit reservation,
 * quota reservation, then adapter. Connector failures after reservation append
 * only the fixed failure code; untrusted error text never enters the chain.
 */
export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const validated = runRequest(request)
    if (!validated.ownerApproved) throw new OwnerGateError()
    if (validated.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (validated.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')

    const connector = connectorCapabilities(this.registry.get(validated.connectorId))
    if (connector.id !== validated.connectorId) throw new ConnectorUnavailableError('CONNECTOR_CONFIGURATION_INVALID')
    if (validated.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()
    const auditAppend = requiredDataMethod(this.auditLog, 'append', 'GCL_AUDIT_LOG_UNAVAILABLE')
    const quotaConsume = requiredDataMethod(this.quota, 'consume', 'GCL_QUOTA_UNAVAILABLE')
    const occurredAt = currentDate(this.now)
    const safeNow = (): Date => currentDate(this.now)
    const context: ConnectorRunContext = {
      product: validated.product,
      workspaceId: validated.workspaceId,
      actor: validated.actor,
      correlationId: validated.correlationId,
      ownerApproved: true,
      scopes: [...validated.scopes].sort(),
      costCapCents: validated.costCapCents,
      requestedItems: validated.requestedItems,
      now: safeNow,
    }
    await connector.preflight?.call(connector.connector, validated.input, context)
    const requestedAuditHash = returnedAuditHash(await auditAppend.call(this.auditLog, {
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {},
    }))
    try {
      await quotaConsume.call(this.quota, { product: context.product, workspaceId: context.workspaceId, connectorId: connector.id, requestedItems: context.requestedItems, occurredAt })
      const result = connectorResult(await connector.run.call(connector.connector, validated.input, context), connector.id)
      const connectorSuccessDetail = successAuditDetail(connector.successAuditDetail ? await connector.successAuditDetail.call(connector.connector, result, context) : {})
      const succeededAuditHash = returnedAuditHash(await auditAppend.call(this.auditLog, {
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: safeNow().toISOString(), detail: { ...connectorSuccessDetail, requestedAuditHash },
      }))
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAuditHash } }
    } catch (error) {
      await returnedAuditHash(await auditAppend.call(this.auditLog, {
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: safeNow().toISOString(),
        detail: { requestedAuditHash, error: 'CONNECTOR_RUN_FAILED' },
      }))
      throw error
    }
  }
}
