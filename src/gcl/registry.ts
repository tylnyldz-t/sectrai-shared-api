import { types as nodeTypes } from 'node:util'
import { CostCapError, GclError, MakerCheckerError, OwnerGateError, ScopeError, ConnectorUnavailableError } from './errors.js'
import { ConnectorInputError } from './errors.js'
import type { AuditLog, Connector, ConnectorAuditEvent, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

export type RunConnectorRequest = {
  connectorId: string
  input: unknown
  product: string
  workspaceId: string
  requestedBy: string
  checkedBy: string
  correlationId: string
  ownerApproved: boolean
  scopes: readonly string[]
  costCapCents: number
  requestedItems: number
}

function isSafePositiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }

/**
 * D11 freezes one trusted local timestamp for an entire governed run. The
 * runner's clock is internal infrastructure, never a provider or network time
 * source, but it still must not be a Proxy, a forged date, or a mutable
 * multi-call input that can change between preflight, quota, and audit steps.
 */
function governedRunTimeSnapshot(clock: unknown): Date {
  if (typeof clock !== 'function' || nodeTypes.isProxy(clock)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  let candidate: unknown
  try {
    candidate = clock()
  } catch {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  }
  if (!nodeTypes.isDate(candidate) || nodeTypes.isProxy(candidate)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  try {
    const milliseconds = Date.prototype.getTime.call(candidate)
    if (!Number.isFinite(milliseconds)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
    return new Date(milliseconds)
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  }
}

function snapshotClock(snapshot: Date): () => Date {
  return () => new Date(Date.prototype.getTime.call(snapshot))
}

function auditFailureDetail(error: unknown, stage: 'admission' | 'execution'): Record<string, unknown> {
  return {
    stage,
    errorCode: error instanceof GclError ? error.code : 'internal_error',
  }
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

/** Governance is evaluated before any fixture lookup, quota reservation, or adapter run. */
export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  private event(type: ConnectorAuditEvent['type'], connectorId: string, context: ConnectorRunContext, occurredAt: Date, detail: Record<string, unknown>): ConnectorAuditEvent {
    return {
      type, connectorId, product: context.product, workspaceId: context.workspaceId,
      requestedBy: context.requestedBy, checkedBy: context.checkedBy, correlationId: context.correlationId,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
      occurredAt: Date.prototype.toISOString.call(occurredAt), detail,
    }
  }

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const occurredAt = governedRunTimeSnapshot(this.now)
    const context: ConnectorRunContext = {
      product: request.product,
      workspaceId: request.workspaceId,
      requestedBy: request.requestedBy,
      checkedBy: request.checkedBy,
      correlationId: request.correlationId,
      ownerApproved: request.ownerApproved,
      scopes: [...new Set(request.scopes)].sort(),
      costCapCents: request.costCapCents,
      requestedItems: request.requestedItems,
      now: snapshotClock(occurredAt),
    }
    let connector: Connector
    try {
      connector = this.registry.get(request.connectorId)
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.denied', request.connectorId, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    try {
      if (!context.ownerApproved) throw new OwnerGateError()
      if (context.requestedBy === context.checkedBy) throw new MakerCheckerError()
      if (!isSafePositiveInteger(context.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
      if (!isSafePositiveInteger(context.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
      if (context.scopes.length === 0 || context.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()
      await connector.preflight?.(request.input, context)
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.denied', connector.id, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    const requestedAudit = await this.auditLog.append(this.event('connector.run.requested', connector.id, context, occurredAt, {}))
    try {
      await this.quota.consume({ ...context, connectorId: connector.id, occurredAt: snapshotClock(occurredAt)() })
      const result = await connector.run(request.input, context)
      const succeededAudit = await this.auditLog.append(this.event('connector.run.succeeded', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash }))
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.failed', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash, ...auditFailureDetail(error, 'execution') }))
      throw error
    }
  }
}
