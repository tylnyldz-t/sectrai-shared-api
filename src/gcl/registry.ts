import { ConnectorInputError, ConnectorUnavailableError, CostCapError, OwnerGateError, ScopeError } from './errors.js'
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

function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }
const PRODUCT_PATTERN = /^sectrai-[a-z0-9-]{1,80}$/
const WORKSPACE_PATTERN = /^[a-zA-Z0-9:_-]{1,120}$/
const ACTOR_PATTERN = /^[a-zA-Z0-9:_@. -]{1,160}$/

function validContext(request: RunConnectorRequest): boolean {
  return PRODUCT_PATTERN.test(request.product) && WORKSPACE_PATTERN.test(request.workspaceId) && ACTOR_PATTERN.test(request.actor)
}

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
 * The runner owns governance only. Connector adapters never receive a network
 * client, process launcher, credential, or JNC transport.
 */
export class GovernedConnectorRunner {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly auditLog: AuditLog,
    private readonly quota: ConnectorQuota,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const connector = this.registry.get(request.connectorId)
    if (request.ownerApproved !== true) throw new OwnerGateError()
    if (!validContext(request)) throw new ConnectorInputError('CONNECTOR_INVALID_CONTEXT')
    if (!positiveInteger(request.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!positiveInteger(request.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    if (!Array.isArray(request.scopes) || request.scopes.length === 0 || request.scopes.some((scope) => typeof scope !== 'string' || !connector.scopes.includes(scope)) || new Set(request.scopes).size !== request.scopes.length) throw new ScopeError()

    const occurredAt = this.now()
    const context: ConnectorRunContext = {
      product: request.product,
      workspaceId: request.workspaceId,
      actor: request.actor,
      ownerApproved: request.ownerApproved,
      scopes: [...request.scopes].sort(),
      costCapCents: request.costCapCents,
      requestedItems: request.requestedItems,
      now: this.now,
    }
    await connector.preflight?.(request.input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
      actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
      occurredAt: occurredAt.toISOString(), detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, occurredAt })
    try {
      const result = await connector.run(request.input, context)
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: this.now().toISOString(), detail: { requestedAuditHash: requestedAudit.hash },
      })
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: this.now().toISOString(),
        detail: { requestedAuditHash: requestedAudit.hash, error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' },
      })
      throw error
    }
  }
}
