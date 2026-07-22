import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, ScopeError } from './errors.js'
import { intrinsicIsProxy } from './intrinsics.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorSuccessAuditDetail, ImageConnectorRunContext } from './types.js'

export type ImageRunConnectorRequest = {
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
const RUN_REQUEST_KEYS = ['connectorId', 'input', 'product', 'workspaceId', 'actor', 'correlationId', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems'] as const
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && ID_PATTERN.test(value) }
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}
function currentDate(now: unknown): Date {
  if (typeof now !== 'function') throw new ConnectorUnavailableError('CONNECTOR_CLOCK_INVALID')
  const date = now()
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new ConnectorUnavailableError('CONNECTOR_CLOCK_INVALID')
  return new Date(date.getTime())
}
function runRequest(value: unknown): ImageRunConnectorRequest {
  if (!isRecord(value) || intrinsicIsProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(value)
  if (keys.length !== RUN_REQUEST_KEYS.length || keys.some((key) => typeof key !== 'string' || !RUN_REQUEST_KEYS.includes(key as typeof RUN_REQUEST_KEYS[number]))) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  const request = Object.fromEntries(RUN_REQUEST_KEYS.map((key) => [key, descriptors[key]?.value])) as ImageRunConnectorRequest
  if (!isIdentifier(request.connectorId) || !isIdentifier(request.product) || !isIdentifier(request.workspaceId) || !isIdentifier(request.actor) || !isIdentifier(request.correlationId) || typeof request.ownerApproved !== 'boolean' || !Array.isArray(request.scopes) || intrinsicIsProxy(request.scopes) || request.scopes.length < 1 || request.scopes.some((scope) => !isIdentifier(scope)) || !Number.isSafeInteger(request.costCapCents) || !Number.isSafeInteger(request.requestedItems)) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  return Object.freeze({ ...request, scopes: Object.freeze([...request.scopes]) })
}
function safeResult(value: unknown, connectorId: string): ConnectorResult {
  if (!isRecord(value) || !isRecord(value.provenance) || !isRecord(value.provenance.untrustedContent) || value.provenance.connectorId !== connectorId || !isIdentifier(value.provenance.source) || !isTimestamp(value.provenance.retrievedAt) || value.provenance.untrustedContent.handling !== 'data-only' || value.provenance.untrustedContent.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new ConnectorUnavailableError('INVALID_CONNECTOR_RESULT')
  return value as unknown as ConnectorResult
}
function auditDetail(value: unknown): ConnectorSuccessAuditDetail {
  if (!isRecord(value)) throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) || (typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && item.length > 256)) throw new ConnectorUnavailableError('INVALID_CONNECTOR_SUCCESS_AUDIT_DETAIL')
  }
  return value as ConnectorSuccessAuditDetail
}

export class ImageConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()
  constructor(connectors: readonly Connector[]) {
    if (!Array.isArray(connectors)) throw new ConnectorUnavailableError('CONNECTOR_REGISTRY_INVALID')
    for (const connector of connectors) {
      if (!connector || connector.id !== 'image-tti' || connector.kind !== 'media-generation' || connector.authKind !== 'owner-token' || !Array.isArray(connector.scopes) || connector.scopes.length !== 1 || connector.scopes[0] !== 'image:generate' || typeof connector.run !== 'function') throw new ConnectorUnavailableError('CONNECTOR_CONFIGURATION_INVALID')
      if (this.connectors.has(connector.id)) throw new ConnectorUnavailableError('DUPLICATE_CONNECTOR')
      this.connectors.set(connector.id, connector)
    }
  }
  get(connectorId: string): Connector {
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
    return connector
  }
}

export class ImageGovernedConnectorRunner {
  constructor(private readonly registry: ImageConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: ImageRunConnectorRequest): Promise<ConnectorResult> {
    const run = runRequest(request)
    if (!run.ownerApproved) throw new OwnerGateError()
    if (run.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (run.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    const connector = this.registry.get(run.connectorId)
    if (run.scopes.length !== connector.scopes.length || new Set(run.scopes).size !== run.scopes.length || run.scopes.some((scope, index) => scope !== connector.scopes[index])) throw new ScopeError()
    const occurredAt = currentDate(this.now)
    const context: ImageConnectorRunContext = { product: run.product, workspaceId: run.workspaceId, actor: run.actor, correlationId: run.correlationId, ownerApproved: true, scopes: [...run.scopes], costCapCents: run.costCapCents, requestedItems: run.requestedItems, now: () => new Date(occurredAt.getTime()) }
    const preparedInput = await connector.preflight?.(run.input, context)
    const adapterInput = preparedInput === undefined ? run.input : preparedInput
    const requested = await this.auditLog.append({ type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {} })
    if (!isRecord(requested) || typeof requested.hash !== 'string' || !HASH_PATTERN.test(requested.hash)) throw new ConnectorUnavailableError('GCL_AUDIT_APPEND_INVALID')
    try {
      await this.quota.consume({ product: context.product, workspaceId: context.workspaceId, connectorId: connector.id, requestedItems: context.requestedItems, occurredAt })
      const result = safeResult(await connector.run(adapterInput, context), connector.id)
      const detail = auditDetail(connector.successAuditDetail ? await connector.successAuditDetail(result, context) : {})
      const success = await this.auditLog.append({ type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: context.now().toISOString(), detail: { ...detail, requestedAuditHash: requested.hash } })
      if (!isRecord(success) || typeof success.hash !== 'string' || !HASH_PATTERN.test(success.hash)) throw new ConnectorUnavailableError('GCL_AUDIT_APPEND_INVALID')
      return { ...result, provenance: { ...result.provenance, auditHash: success.hash } }
    } catch (error) {
      await this.auditLog.append({ type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: context.now().toISOString(), detail: { requestedAuditHash: requested.hash, error: 'CONNECTOR_RUN_FAILED' } })
      throw error
    }
  }
}
