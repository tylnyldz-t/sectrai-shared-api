import { ConnectorInputError, ConnectorUnavailableError, CostCapError, GclError, OwnerGateError, ScopeError } from './errors.js'
import { deepFreeze } from './plan-integrity.js'
import { validatedSyntheticConnectorResult } from './result-boundary.js'
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
const RUN_REQUEST_KEYS = ['connectorId', 'input', 'product', 'workspaceId', 'actor', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems'] as const

type DataRecord = Record<string, unknown>
type ValidRunContext = DataRecord & { product: string; workspaceId: string; actor: string }

/**
 * Governance fields may be supplied to the runner directly by future
 * internal callers. Read only own enumerable data descriptors so inherited
 * or accessor-backed approval, scope, or quota values never reach audit,
 * quota, or a connector.
 */
function runRequestRecord(value: unknown): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== RUN_REQUEST_KEYS.length || names.some((name) => !(RUN_REQUEST_KEYS as readonly string[]).includes(name))) return null
    const output = Object.create(null) as DataRecord
    for (const name of RUN_REQUEST_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[name] = descriptor.value
    }
    return output
  } catch {
    return null
  }
}

function strictScopeArray(value: unknown): string[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    const length = value.length
    if (!Number.isSafeInteger(length) || length < 1 || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return null
    const output: string[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') return null
      output.push(descriptor.value)
    }
    return output
  } catch {
    return null
  }
}

function validContext(request: DataRecord): request is ValidRunContext {
  return typeof request.product === 'string' && PRODUCT_PATTERN.test(request.product) &&
    typeof request.workspaceId === 'string' && WORKSPACE_PATTERN.test(request.workspaceId) &&
    typeof request.actor === 'string' && ACTOR_PATTERN.test(request.actor)
}

/** Audit error details are stable codes, never an adapter's arbitrary message. */
function auditFailureCode(error: unknown): string {
  return error instanceof GclError ? error.code : 'connector_run_failed'
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
    const safeRequest = runRequestRecord(request)
    if (!safeRequest || typeof safeRequest.connectorId !== 'string') throw new ConnectorInputError('CONNECTOR_INVALID_CONTEXT')
    const connector = this.registry.get(safeRequest.connectorId)
    if (safeRequest.ownerApproved !== true) throw new OwnerGateError()
    if (!validContext(safeRequest)) throw new ConnectorInputError('CONNECTOR_INVALID_CONTEXT')
    if (typeof safeRequest.costCapCents !== 'number' || !positiveInteger(safeRequest.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (typeof safeRequest.requestedItems !== 'number' || !positiveInteger(safeRequest.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    const scopes = strictScopeArray(safeRequest.scopes)
    if (!scopes || scopes.some((scope) => !connector.scopes.includes(scope)) || new Set(scopes).size !== scopes.length) throw new ScopeError()

    const occurredAt = this.now()
    const context: ConnectorRunContext = {
      product: safeRequest.product,
      workspaceId: safeRequest.workspaceId,
      actor: safeRequest.actor,
      ownerApproved: true,
      scopes: scopes.sort(),
      costCapCents: safeRequest.costCapCents,
      requestedItems: safeRequest.requestedItems,
      now: this.now,
    }
    await connector.preflight?.(safeRequest.input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
      actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
      occurredAt: occurredAt.toISOString(), detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, occurredAt })
    try {
      const result = validatedSyntheticConnectorResult(await connector.run(safeRequest.input, context), connector.id)
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: this.now().toISOString(), detail: { requestedAuditHash: requestedAudit.hash },
      })
      return deepFreeze({ ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } })
    } catch (error) {
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: this.now().toISOString(),
        detail: { requestedAuditHash: requestedAudit.hash, error: auditFailureCode(error) },
      })
      throw error
    }
  }
}
