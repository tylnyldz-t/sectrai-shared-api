import { types as nodeTypes } from 'node:util'
import { ConnectorInputError, CostCapError, GclError, MakerCheckerError, OwnerGateError, ScopeError, ConnectorUnavailableError } from './errors.js'
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

const GOVERNED_RUN_REQUEST_FIELDS = [
  'connectorId', 'input', 'product', 'workspaceId', 'requestedBy', 'checkedBy',
  'correlationId', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems',
] as const

/**
 * D12's runner boundary accepts only a dense, ordinary array of own enumerable
 * data strings. It deliberately keeps the generic connector input opaque: the
 * selected adapter remains responsible for its own input contract.
 */
function governedRunScopes(value: unknown): string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  if (value.length > 12 || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
    }
    scopes.push(descriptor.value)
  }
  return scopes
}

/**
 * D12 seals direct library calls at the governed-run envelope before the
 * runner can consult its clock, registry, audit, quota, or adapter. Every
 * field must be an allowlisted own enumerable data property; descriptors are
 * copied before use so getters and Proxy traps are never evaluated.
 */
function governedRunRequest(value: unknown): RunConnectorRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== GOVERNED_RUN_REQUEST_FIELDS.length || names.some((name) => !GOVERNED_RUN_REQUEST_FIELDS.includes(name as typeof GOVERNED_RUN_REQUEST_FIELDS[number]))) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const field of GOVERNED_RUN_REQUEST_FIELDS) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
    normalized[field] = descriptor.value
  }

  const { connectorId, input, product, workspaceId, requestedBy, checkedBy, correlationId, ownerApproved, scopes, costCapCents, requestedItems } = normalized
  if (typeof connectorId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(connectorId) || typeof product !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(product) || typeof workspaceId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(workspaceId) || typeof requestedBy !== 'string' || !/^[a-zA-Z0-9:_@. -]{1,160}$/.test(requestedBy) || typeof checkedBy !== 'string' || !/^[a-zA-Z0-9:_@. -]{1,160}$/.test(checkedBy) || typeof correlationId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(correlationId) || typeof ownerApproved !== 'boolean' || typeof costCapCents !== 'number' || !isSafePositiveInteger(costCapCents) || typeof requestedItems !== 'number' || !isSafePositiveInteger(requestedItems)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }

  return {
    connectorId,
    input,
    product,
    workspaceId,
    requestedBy,
    checkedBy,
    correlationId,
    ownerApproved,
    scopes: governedRunScopes(scopes),
    costCapCents,
    requestedItems,
  }
}

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
    const normalizedRequest = governedRunRequest(request)
    const occurredAt = governedRunTimeSnapshot(this.now)
    const context: ConnectorRunContext = {
      product: normalizedRequest.product,
      workspaceId: normalizedRequest.workspaceId,
      requestedBy: normalizedRequest.requestedBy,
      checkedBy: normalizedRequest.checkedBy,
      correlationId: normalizedRequest.correlationId,
      ownerApproved: normalizedRequest.ownerApproved,
      scopes: [...new Set(normalizedRequest.scopes)].sort(),
      costCapCents: normalizedRequest.costCapCents,
      requestedItems: normalizedRequest.requestedItems,
      now: snapshotClock(occurredAt),
    }
    let connector: Connector
    try {
      connector = this.registry.get(normalizedRequest.connectorId)
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.denied', normalizedRequest.connectorId, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    try {
      if (!context.ownerApproved) throw new OwnerGateError()
      if (context.requestedBy === context.checkedBy) throw new MakerCheckerError()
      if (!isSafePositiveInteger(context.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
      if (!isSafePositiveInteger(context.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
      if (context.scopes.length === 0 || context.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()
      await connector.preflight?.(normalizedRequest.input, context)
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.denied', connector.id, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    const requestedAudit = await this.auditLog.append(this.event('connector.run.requested', connector.id, context, occurredAt, {}))
    try {
      await this.quota.consume({ ...context, connectorId: connector.id, occurredAt: snapshotClock(occurredAt)() })
      const result = await connector.run(normalizedRequest.input, context)
      const succeededAudit = await this.auditLog.append(this.event('connector.run.succeeded', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash }))
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      await this.auditLog.append(this.event('connector.run.failed', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash, ...auditFailureDetail(error, 'execution') }))
      throw error
    }
  }
}
