import { types as nodeTypes } from 'node:util'
import { ConnectorInputError, CostCapError, ConnectorUnavailableError, OwnerGateError, ScopeError } from './errors.js'
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

function isSafeNonNegativeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

const RUN_REQUEST_FIELDS = ['connectorId', 'input', 'product', 'workspaceId', 'actor', 'ownerApproved', 'scopes', 'costCapCents', 'requestedItems'] as const
const MAX_RUN_SCOPES = 64

type SnapshottedRunConnectorRequest = Omit<RunConnectorRequest, 'scopes'> & { scopes: string[] }

/**
 * The governed runner is the first library boundary before connector
 * preflight, audit, or quota reservation. Snapshot only its bounded envelope
 * through descriptors so an accessor, Proxy, inherited field, sparse scope
 * list, or hidden credential-shaped field cannot alter a later seam.
 *
 * `input` remains opaque data for the selected connector to validate. This
 * boundary deliberately neither executes nor interprets its contents.
 */
function runRequestEnvelope(value: unknown): Record<string, unknown> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')

  const names = Object.getOwnPropertyNames(value)
  if (
    names.length !== RUN_REQUEST_FIELDS.length || names.some((field) => !RUN_REQUEST_FIELDS.includes(field as typeof RUN_REQUEST_FIELDS[number])) ||
    RUN_REQUEST_FIELDS.some((field) => !names.includes(field))
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const envelope = Object.create(null) as Record<string, unknown>
  for (const field of RUN_REQUEST_FIELDS) {
    const descriptor = descriptors[field]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
    envelope[field] = descriptor.value
  }
  return envelope
}

function runScopes(value: unknown): string[] {
  if (
    !Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')

  const names = Object.getOwnPropertyNames(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const length = descriptors.length
  if (
    !length || !('value' in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value > MAX_RUN_SCOPES ||
    names.length !== length.value + 1 || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')

  const scopes: string[] = []
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
    }
    scopes.push(descriptor.value)
  }
  return scopes
}

function snapshotRunRequest(value: unknown): SnapshottedRunConnectorRequest {
  const envelope = runRequestEnvelope(value)
  if (
    typeof envelope.connectorId !== 'string' || typeof envelope.product !== 'string' ||
    typeof envelope.workspaceId !== 'string' || typeof envelope.actor !== 'string' ||
    typeof envelope.ownerApproved !== 'boolean' || typeof envelope.costCapCents !== 'number' ||
    typeof envelope.requestedItems !== 'number'
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')

  return {
    connectorId: envelope.connectorId,
    input: envelope.input,
    product: envelope.product,
    workspaceId: envelope.workspaceId,
    actor: envelope.actor,
    ownerApproved: envelope.ownerApproved,
    scopes: runScopes(envelope.scopes),
    costCapCents: envelope.costCapCents,
    requestedItems: envelope.requestedItems,
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

export class GovernedConnectorRunner {
  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {}

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    // D12: do not read a caller-owned request after this exact own-data copy.
    const safeRequest = snapshotRunRequest(request)
    // Runtime callers can bypass TypeScript, so owner approval is an exact
    // authority value, never a truthiness check.
    if (safeRequest.ownerApproved !== true) throw new OwnerGateError()
    const connector = this.registry.get(safeRequest.connectorId)
    if (!isSafeNonNegativeInteger(safeRequest.costCapCents) || safeRequest.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!Number.isSafeInteger(safeRequest.requestedItems) || safeRequest.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    if (safeRequest.scopes.length === 0 || safeRequest.scopes.some((scope) => !connector.scopes.includes(scope))) throw new ScopeError()

    const occurredAt = this.now()
    const context: ConnectorRunContext = {
      product: safeRequest.product,
      workspaceId: safeRequest.workspaceId,
      actor: safeRequest.actor,
      ownerApproved: safeRequest.ownerApproved,
      scopes: [...new Set(safeRequest.scopes)].sort(),
      costCapCents: safeRequest.costCapCents,
      requestedItems: safeRequest.requestedItems,
      now: this.now,
    }
    await connector.preflight?.(safeRequest.input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, quotaGroup: connector.quotaGroup, occurredAt })
    try {
      const result = await connector.run(safeRequest.input, context)
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
