import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, ScopeError } from './errors.js'
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
function runRequest(value: unknown): RunConnectorRequest {
  if (!isRecord(value) || !isIdentifier(value.connectorId) || !isIdentifier(value.product) || !isIdentifier(value.workspaceId) || !isIdentifier(value.actor) || !isIdentifier(value.correlationId) || typeof value.ownerApproved !== 'boolean' || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.some((scope) => !isIdentifier(scope)) || !Number.isSafeInteger(value.costCapCents) || !Number.isSafeInteger(value.requestedItems)) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  return value as unknown as RunConnectorRequest
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

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()
  constructor(connectors: readonly Connector[]) {
    if (!Array.isArray(connectors)) throw new ConnectorUnavailableError('CONNECTOR_REGISTRY_INVALID')
    for (const connector of connectors) {
      if (!connector || !isIdentifier(connector.id) || (connector.kind !== 'external-data' && connector.kind !== 'media-generation') || (connector.authKind !== 'owner-token' && connector.authKind !== 'oauth') || !Array.isArray(connector.scopes) || connector.scopes.length < 1 || connector.scopes.some((scope: string) => !isIdentifier(scope)) || typeof connector.run !== 'function') throw new ConnectorUnavailableError('CONNECTOR_CONFIGURATION_INVALID')
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

export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const run = runRequest(request)
    if (!run.ownerApproved) throw new OwnerGateError()
    if (run.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (run.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    const connector = this.registry.get(run.connectorId)
    if (run.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()
    const occurredAt = currentDate(this.now)
    const context: ConnectorRunContext = { product: run.product, workspaceId: run.workspaceId, actor: run.actor, correlationId: run.correlationId, ownerApproved: true, scopes: [...run.scopes], costCapCents: run.costCapCents, requestedItems: run.requestedItems, now: () => currentDate(this.now) }
    await connector.preflight?.(run.input, context)
    const requested = await this.auditLog.append({ type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {} })
    if (!isRecord(requested) || typeof requested.hash !== 'string') throw new ConnectorUnavailableError('GCL_AUDIT_APPEND_INVALID')
    try {
      await this.quota.consume({ product: context.product, workspaceId: context.workspaceId, connectorId: connector.id, requestedItems: context.requestedItems, occurredAt })
      const result = safeResult(await connector.run(run.input, context), connector.id)
      const detail = auditDetail(connector.successAuditDetail ? await connector.successAuditDetail(result, context) : {})
      const success = await this.auditLog.append({ type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: context.now().toISOString(), detail: { ...detail, requestedAuditHash: requested.hash } })
      if (!isRecord(success) || typeof success.hash !== 'string') throw new ConnectorUnavailableError('GCL_AUDIT_APPEND_INVALID')
      return { ...result, provenance: { ...result.provenance, auditHash: success.hash } }
    } catch (error) {
      await this.auditLog.append({ type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: context.now().toISOString(), detail: { requestedAuditHash: requested.hash, error: 'CONNECTOR_RUN_FAILED' } })
      throw error
    }
  }
}
