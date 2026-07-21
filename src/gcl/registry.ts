import { ConnectorInputError, CostCapError, ConnectorUnavailableError, OwnerGateError, ScopeError } from './errors.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

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

function isSafeNonNegativeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()

  constructor(connectors: readonly Connector[]) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.id)) throw new Error(`DUPLICATE_CONNECTOR:${connector.id}`)
      this.connectors.set(connector.id, connector)
    }
  }

  get(connectorId: string): Connector {
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
    return connector
  }
}

/**
 * Shared GCL policy order: owner approval, identity/cost/scopes, connector
 * preflight, append-only audit reservation, quota reservation, then adapter.
 */
export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const connector = this.registry.get(request.connectorId)
    if (!request.ownerApproved) throw new OwnerGateError()
    if (!ID_PATTERN.test(request.product) || !ID_PATTERN.test(request.workspaceId) || !ID_PATTERN.test(request.actor) || !ID_PATTERN.test(request.correlationId)) throw new ConnectorInputError('INVALID_CONNECTOR_IDENTITY')
    if (!isSafeNonNegativeInteger(request.costCapCents) || request.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!Number.isSafeInteger(request.requestedItems) || request.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    if (request.scopes.length === 0 || request.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()

    const occurredAt = this.now()
    const context: ConnectorRunContext = {
      product: request.product,
      workspaceId: request.workspaceId,
      actor: request.actor,
      correlationId: request.correlationId,
      ownerApproved: request.ownerApproved,
      scopes: [...new Set(request.scopes)].sort(),
      costCapCents: request.costCapCents,
      requestedItems: request.requestedItems,
      now: this.now,
    }
    await connector.preflight?.(request.input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, occurredAt })
    try {
      const result = await connector.run(request.input, context)
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: this.now().toISOString(), detail: { requestedAuditHash: requestedAudit.hash },
      })
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor, correlationId: context.correlationId,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: this.now().toISOString(),
        detail: { requestedAuditHash: requestedAudit.hash, error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' },
      })
      throw error
    }
  }
}
