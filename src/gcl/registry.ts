import { types as nodeTypes } from 'node:util'
import { ConnectorInputError, CostCapError, ConnectorUnavailableError, OwnerGateError, ScopeError } from './errors.js'
import type { AuditLog, Connector, ConnectorAuditEvent, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

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
const CONNECTOR_RESULT_FIELDS = ['data', 'provenance', 'confidence'] as const
const CONNECTOR_PROVENANCE_REQUIRED_FIELDS = ['connectorId', 'source', 'retrievedAt', 'untrustedContent'] as const
const CONNECTOR_PROVENANCE_OPTIONAL_FIELDS = ['actorId', 'runId', 'datasetId'] as const
const CONNECTOR_UNTRUSTED_CONTENT_FIELDS = ['source', 'value', 'handling', 'instructionPolicy'] as const
const MAX_RUN_SCOPES = 64
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

type SnapshottedRunConnectorRequest = Omit<RunConnectorRequest, 'scopes' | 'ownerApproved'> & { scopes: string[]; ownerApproved: unknown }

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
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value)
  const length = descriptors['length']
  if (
    !length || !('value' in length) || length.enumerable || typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) || length.value > MAX_RUN_SCOPES || names.length !== length.value + 1 ||
    names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))
  ) throw new ConnectorInputError('INVALID_CONNECTOR_RUN_REQUEST')
  const scopeCount = length.value

  const scopes: string[] = []
  for (let index = 0; index < scopeCount; index += 1) {
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
    typeof envelope.costCapCents !== 'number' ||
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

/**
 * D15 keeps the runner's three unavoidable host seams deliberately narrow.
 * Members are obtained from data descriptors only, so a getter or Proxy cannot
 * execute while governance is being assembled. The callback itself is fixed at
 * runner construction; later host-object mutation cannot replace it mid-run.
 */
function hostMethod<TArgument>(value: unknown, member: string, error: string): (argument: TArgument) => Promise<unknown> {
  try {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ConnectorUnavailableError(error)
    let current: object | null = value
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (nodeTypes.isProxy(current)) throw new ConnectorUnavailableError(error)
      const descriptor = Object.getOwnPropertyDescriptor(current, member)
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
          throw new ConnectorUnavailableError(error)
        }
        return async (argument) => Reflect.apply(descriptor.value, value, [argument]) as unknown
      }
      current = Object.getPrototypeOf(current)
    }
  } catch (cause) {
    if (cause instanceof ConnectorUnavailableError) throw cause
  }
  throw new ConnectorUnavailableError(error)
}

/** A runner audit append may return only an exact SHA-256-shaped data record. */
function auditAppendResult(value: unknown): { hash: string } {
  try {
    if (
      !value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0
    ) throw new ConnectorUnavailableError('CONNECTOR_AUDIT_APPEND_INVALID')
    const names = Object.getOwnPropertyNames(value)
    const descriptor = Object.getOwnPropertyDescriptor(value, 'hash')
    if (
      names.length !== 1 || names[0] !== 'hash' || !descriptor || !descriptor.enumerable ||
      !('value' in descriptor) || typeof descriptor.value !== 'string' || !DIGEST_PATTERN.test(descriptor.value)
    ) throw new ConnectorUnavailableError('CONNECTOR_AUDIT_APPEND_INVALID')
    return { hash: descriptor.value }
  } catch (cause) {
    if (cause instanceof ConnectorUnavailableError) throw cause
    throw new ConnectorUnavailableError('CONNECTOR_AUDIT_APPEND_INVALID')
  }
}

/**
 * D21 snapshots the connector-result wrapper before the succeeded audit is
 * appended. `data` and `untrustedContent.value` remain connector-owned opaque
 * values, but every governance-visible result/provenance field is copied from
 * an exact own-data shape. This prevents a result getter, Proxy, hidden or
 * credential-shaped field, forged audit hash, or later mutation of the
 * connector-owned wrapper from being recorded as a successful run.
 */
function resultDataObject(value: unknown, fields: readonly string[], error: string): Record<string, unknown> {
  try {
    if (
      !value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0
    ) throw new ConnectorUnavailableError(error)
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== fields.length || names.some((field) => !fields.includes(field)) || fields.some((field) => !names.includes(field))) {
      throw new ConnectorUnavailableError(error)
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = Object.create(null) as Record<string, unknown>
    for (const field of fields) {
      const descriptor = descriptors[field]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorUnavailableError(error)
      result[field] = descriptor.value
    }
    return result
  } catch (cause) {
    if (cause instanceof ConnectorUnavailableError) throw cause
    throw new ConnectorUnavailableError(error)
  }
}

function boundedResultString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function canonicalResultTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null
}

function connectorResultSnapshot(value: unknown, connectorId: string): ConnectorResult {
  const result = resultDataObject(value, CONNECTOR_RESULT_FIELDS, 'CONNECTOR_RESULT_INVALID')
  if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')
  }
  const provenanceFields = [...CONNECTOR_PROVENANCE_REQUIRED_FIELDS, ...CONNECTOR_PROVENANCE_OPTIONAL_FIELDS]
  let provenance: Record<string, unknown>
  try {
    if (
      !result.provenance || typeof result.provenance !== 'object' || Array.isArray(result.provenance) || nodeTypes.isProxy(result.provenance) ||
      Object.getPrototypeOf(result.provenance) !== Object.prototype || Object.getOwnPropertySymbols(result.provenance).length > 0
    ) throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')
    const names = Object.getOwnPropertyNames(result.provenance)
    if (
      names.some((field) => !provenanceFields.includes(field)) ||
      CONNECTOR_PROVENANCE_REQUIRED_FIELDS.some((field) => !names.includes(field))
    ) throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(result.provenance)
    provenance = Object.create(null) as Record<string, unknown>
    for (const field of names) {
      const descriptor = descriptors[field]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')
      provenance[field] = descriptor.value
    }
  } catch (cause) {
    if (cause instanceof ConnectorUnavailableError) throw cause
    throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')
  }
  const untrustedContent = resultDataObject(provenance.untrustedContent, CONNECTOR_UNTRUSTED_CONTENT_FIELDS, 'CONNECTOR_RESULT_INVALID')
  const source = boundedResultString(provenance.source)
  const untrustedSource = boundedResultString(untrustedContent.source)
  if (
    provenance.connectorId !== connectorId || !source || !canonicalResultTimestamp(provenance.retrievedAt) || !untrustedSource ||
    untrustedContent.handling !== 'data-only' || untrustedContent.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS' ||
    CONNECTOR_PROVENANCE_OPTIONAL_FIELDS.some((field) => field in provenance && !boundedResultString(provenance[field]))
  ) throw new ConnectorUnavailableError('CONNECTOR_RESULT_INVALID')

  return {
    data: result.data,
    provenance: {
      connectorId,
      source,
      retrievedAt: provenance.retrievedAt as string,
      ...(typeof provenance.actorId === 'string' ? { actorId: provenance.actorId } : {}),
      ...(typeof provenance.runId === 'string' ? { runId: provenance.runId } : {}),
      ...(typeof provenance.datasetId === 'string' ? { datasetId: provenance.datasetId } : {}),
      untrustedContent: {
        source: untrustedSource,
        value: untrustedContent.value,
        handling: 'data-only',
        instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
      },
    },
    confidence: result.confidence,
  }
}

/**
 * The time value is copied before it crosses connector, audit, or quota
 * seams. A malformed clock is a deployment failure rather than a coercion or
 * post-quota failure path.
 */
function governedRunTime(value: unknown): Date {
  if (typeof value !== 'function' || nodeTypes.isProxy(value)) throw new ConnectorUnavailableError('INVALID_GOVERNED_RUN_TIME')
  let candidate: unknown
  try {
    candidate = Reflect.apply(value, undefined, [])
  } catch {
    throw new ConnectorUnavailableError('INVALID_GOVERNED_RUN_TIME')
  }
  if (!nodeTypes.isDate(candidate) || nodeTypes.isProxy(candidate)) throw new ConnectorUnavailableError('INVALID_GOVERNED_RUN_TIME')
  const epoch = Date.prototype.getTime.call(candidate)
  if (!Number.isFinite(epoch)) throw new ConnectorUnavailableError('INVALID_GOVERNED_RUN_TIME')
  return new Date(epoch)
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
  private readonly auditAppend: (event: ConnectorAuditEvent) => Promise<unknown>
  private readonly quotaConsume: (context: Parameters<ConnectorQuota['consume']>[0]) => Promise<unknown>
  private readonly runClock: () => Date

  constructor(private readonly registry: ConnectorRegistry, auditLog: AuditLog, quota: ConnectorQuota, now: () => Date = () => new Date()) {
    this.auditAppend = hostMethod<ConnectorAuditEvent>(auditLog, 'append', 'CONNECTOR_AUDIT_LOG_UNAVAILABLE')
    this.quotaConsume = hostMethod<Parameters<ConnectorQuota['consume']>[0]>(quota, 'consume', 'CONNECTOR_QUOTA_UNAVAILABLE')
    if (typeof now !== 'function' || nodeTypes.isProxy(now)) throw new ConnectorUnavailableError('INVALID_GOVERNED_RUN_TIME')
    this.runClock = now
  }

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

    // D15: copy one verified clock value before connector preflight, audit, or
    // quota. Every event and the connector's provenance context derive from
    // this local instant, so a host clock cannot mutate later async seams.
    const occurredAt = governedRunTime(this.runClock)
    const localNow = () => new Date(occurredAt.getTime())
    const context: ConnectorRunContext = {
      product: safeRequest.product,
      workspaceId: safeRequest.workspaceId,
      actor: safeRequest.actor,
      ownerApproved: safeRequest.ownerApproved,
      scopes: [...new Set(safeRequest.scopes)].sort(),
      costCapCents: safeRequest.costCapCents,
      requestedItems: safeRequest.requestedItems,
      now: localNow,
    }
    // A connector that returns a canonical preflight value owns its input
    // schema and can close a caller-mutation gap before any async audit or
    // quota seam. Connectors that return undefined retain the generic,
    // opaque-input contract.
    const preparedInput = await connector.preflight?.(safeRequest.input, context)
    const connectorInput = preparedInput === undefined ? safeRequest.input : preparedInput
    const requestedAudit = auditAppendResult(await this.auditAppend({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: {},
    }))
    await this.quotaConsume({ ...context, connectorId: connector.id, quotaGroup: connector.quotaGroup, occurredAt })
    let result: ConnectorResult
    try {
      result = connectorResultSnapshot(await connector.run(connectorInput, context), connector.id)
    } catch (error) {
      auditAppendResult(await this.auditAppend({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(),
        detail: { requestedAuditHash: requestedAudit.hash, error: error instanceof Error ? error.message : 'UNKNOWN_ERROR' },
      }))
      throw error
    }
    // Keep a malformed host result from being mistaken for a successful run;
    // do not append a second, misleading failure event after the success append
    // itself has already crossed the host seam.
    const succeededAudit = auditAppendResult(await this.auditAppend({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId, actor: context.actor,
        scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems, occurredAt: occurredAt.toISOString(), detail: { requestedAuditHash: requestedAudit.hash },
    }))
    // D20/D21: a connector can seal its own known branches, while D21 has
    // already copied the governance-visible result shape before this await.
    // Freeze that copied provenance (including its untrusted-content wrapper)
    // after the local audit summary is attached, so success egress cannot
    // reopen an in-place provider, instruction, or action-shaped mutation.
    return Object.freeze({
      ...result,
      provenance: Object.freeze({
        ...result.provenance,
        untrustedContent: Object.freeze({ ...result.provenance.untrustedContent }),
        auditHash: succeededAudit.hash,
      }),
    })
  }
}
