import { CostCapError, ConnectorUnavailableError, GclError, OwnerGateError, ScopeError } from './errors.js'
import { requireGclTenantContext } from './context.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

const ACTOR_ID = /^[a-zA-Z0-9:_@. -]{1,160}$/
const SCOPE_ID = /^[a-z][a-z0-9:-]{0,79}$/

function canonicalActor(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && Boolean(value) && ACTOR_ID.test(value)
}

/**
 * Do not silently deduplicate a caller's authority request.  The audit must
 * describe the exact authorization that was accepted, so duplicate or
 * noncanonical scope values fail before a clock, preflight, audit, or quota
 * reservation can be reached.
 */
function canonicalScopes(value: unknown, connector: Connector): readonly string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((scope) => typeof scope !== 'string' || !SCOPE_ID.test(scope) || !connector.scopes.includes(scope))
    || new Set(value).size !== value.length) throw new ScopeError()
  return [...value].sort()
}

/**
 * A governed run gets one native-clock snapshot.  Do not hand a connector the
 * ambient clock: an unstable or hostile clock could otherwise make the audit
 * outcome, provenance, and review expiry describe different runs.
 */
function runClock(now: () => Date): { occurredAt: string; now: () => Date } {
  try {
    const candidate = now()
    if (!(candidate instanceof Date)) throw new TypeError('not a date')
    const milliseconds = Date.prototype.getTime.call(candidate)
    if (!Number.isFinite(milliseconds)) throw new TypeError('invalid date')
    const occurredAt = new Date(milliseconds).toISOString()
    return { occurredAt, now: () => new Date(milliseconds) }
  } catch {
    throw new ConnectorUnavailableError('CONNECTOR_RUN_CLOCK_INVALID')
  }
}

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

export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const connector = this.registry.get(request.connectorId)
    requireGclTenantContext(request)
    if (!request.ownerApproved) throw new OwnerGateError()
    if (!canonicalActor(request.actor)) throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
    if (!Number.isSafeInteger(request.costCapCents) || request.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!Number.isSafeInteger(request.requestedItems) || request.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    const scopes = canonicalScopes(request.scopes, connector)

    const run = runClock(this.now)
    const context: ConnectorRunContext = {
      product: request.product,
      workspaceId: request.workspaceId,
      actor: request.actor,
      ownerApproved: request.ownerApproved,
      scopes,
      costCapCents: request.costCapCents,
      requestedItems: request.requestedItems,
      now: run.now,
    }
    // A connector that returns a canonical preflight value commits the exact
    // input that will reach its adapter. This prevents a caller retaining the
    // original object (or a stateful Proxy) from changing a reviewed fixture
    // while the requested audit/quota awaits. Older validate-only connectors
    // still return undefined and retain their existing contract.
    const preparedInput = await connector.preflight?.(request.input, context)
    const adapterInput = preparedInput === undefined ? request.input : preparedInput
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: run.occurredAt, detail: {},
    })
    try {
      // A rejected reservation is still a terminal governed run. Keep its
      // stable error code in the chain so a requested audit cannot be left
      // without an outcome. Preflight remains outside this boundary because
      // malformed input must not create an audit or quota record at all.
      await this.quota.consume({ ...context, connectorId: connector.id, occurredAt: new Date(run.occurredAt) })
      const result = await connector.run(adapterInput, context)
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: run.occurredAt,
        detail: result.artifact ? { requestedAuditHash: requestedAudit.hash, artifact: result.artifact } : { requestedAuditHash: requestedAudit.hash },
      })
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      // Provider/runtime errors must never place raw fixture data in durable audit.
      const errorCode = error instanceof GclError ? error.code : 'connector_run_failed'
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: run.occurredAt,
        detail: { requestedAuditHash: requestedAudit.hash, error: errorCode },
      })
      throw error
    }
  }
}
