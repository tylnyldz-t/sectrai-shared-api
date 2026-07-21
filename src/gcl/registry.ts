import { ConnectorInputError, CostCapError, OwnerGateError, ScopeError, ConnectorUnavailableError } from './errors.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

export type RunConnectorRequest = {
  connectorId: string
  input: unknown
  product: string
  workspaceId: string
  actor: string
  ownerApproved: boolean
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
}

const SCOPE_PATTERN = /^[a-z][a-z0-9-]{1,39}:[a-z][a-z0-9-]{1,79}$/
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

function isSafePositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

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
 * Common GCL order: owner/scope/cost validation, pure preflight, audit
 * reservation, quota reservation, then the adapter. This adapter has no
 * provider call, but retaining the order prevents an unsafe future swap-in.
 */
export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const connector = this.registry.get(request.connectorId)
    if (!request.ownerApproved) throw new OwnerGateError()
    if (!SCOPE_ID_PATTERN.test(request.product) || !SCOPE_ID_PATTERN.test(request.workspaceId) || !ACTOR_PATTERN.test(request.actor)) throw new ConnectorInputError('INVALID_CONNECTOR_CONTEXT')
    if (!isSafePositiveInteger(request.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!isSafePositiveInteger(request.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    if (request.scopes.length === 0 || request.scopes.some((scope) => !SCOPE_PATTERN.test(scope) || !connector.scopes.includes(scope))) throw new ScopeError()

    const occurredAt = this.now()
    const context: ConnectorRunContext = {
      product: request.product,
      workspaceId: request.workspaceId,
      actor: request.actor,
      ownerApproved: true,
      scopes: [...new Set(request.scopes)].sort(),
      costCapCents: request.costCapCents,
      requestedItems: request.requestedItems,
      now: this.now,
    }
    await connector.preflight?.(request.input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, occurredAt })
    try {
      const result = await connector.run(request.input, context)
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: this.now().toISOString(), detail: { requestedAuditHash: requestedAudit.hash },
      })
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: this.now().toISOString(),
        detail: { requestedAuditHash: requestedAudit.hash, error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' },
      })
      throw error
    }
  }
}
