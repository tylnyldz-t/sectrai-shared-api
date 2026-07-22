import { ConnectorInputError, ConnectorUnavailableError, CostCapError, GclError, OwnerGateError, ScopeError } from './errors.js'
import { deepFreeze, frozenCanonicalJsonCopy, isProxyValue } from './plan-integrity.js'
import { syntheticResultReviewBinding, validatedSyntheticConnectorResult } from './result-boundary.js'
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
type RegisteredConnector = {
  readonly id: string
  readonly kind: Connector['kind']
  readonly authKind: Connector['authKind']
  readonly scopes: readonly string[]
  readonly preflight?: Connector['preflight']
  readonly run: Connector['run']
}

/**
 * Governance fields may be supplied to the runner directly by future
 * internal callers. Read only own enumerable data descriptors so inherited
 * or accessor-backed approval, scope, or quota values never reach audit,
 * quota, or a connector.
 */
function runRequestRecord(value: unknown): DataRecord | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (isProxyValue(value)) return null
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
    if (isProxyValue(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return null
    const names = Object.getOwnPropertyNames(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return null
    const length = lengthDescriptor.value
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

/** Resolve an own or prototype method without invoking an accessor. */
function connectorMethod(value: object, name: 'run' | 'preflight'): Function | undefined | null {
  try {
    let current: object | null = value
    while (current && current !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name)
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function' ? descriptor.value : null
      current = Object.getPrototypeOf(current)
    }
    return undefined
  } catch {
    return null
  }
}

/**
 * Lock registry metadata and method references at admission. This keeps a
 * later in-memory mutation from changing the connector that audit, quota, or
 * the final egress boundary believes it is governing.
 */
function registerConnector(value: Connector): RegisteredConnector {
  try {
    if (!value || typeof value !== 'object' || isProxyValue(value) || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new ConnectorUnavailableError('CONNECTOR_INVALID_REGISTRATION')
    }
    const field = (name: 'id' | 'kind' | 'authKind' | 'scopes'): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ConnectorUnavailableError('CONNECTOR_INVALID_REGISTRATION')
      return descriptor.value
    }
    const id = field('id')
    const kind = field('kind')
    const authKind = field('authKind')
    const scopes = strictScopeArray(field('scopes'))
    const run = connectorMethod(value, 'run')
    const preflight = connectorMethod(value, 'preflight')
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ||
      (kind !== 'media-3d' && kind !== 'game-engine') || authKind !== 'owner-approval' ||
      !scopes || scopes.some((scope) => !scope || scope.length > 120) || new Set(scopes).size !== scopes.length ||
      !run || preflight === null) throw new ConnectorUnavailableError('CONNECTOR_INVALID_REGISTRATION')
    Object.freeze(field('scopes') as object)
    Object.freeze(value)
    return Object.freeze({
      id,
      kind,
      authKind,
      scopes: Object.freeze([...scopes]),
      ...(preflight ? { preflight: preflight.bind(value) as Connector['preflight'] } : {}),
      run: run.bind(value) as Connector['run'],
    })
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) throw error
    throw new ConnectorUnavailableError('CONNECTOR_INVALID_REGISTRATION')
  }
}

function validContext(request: DataRecord): request is ValidRunContext {
  return typeof request.product === 'string' && PRODUCT_PATTERN.test(request.product) &&
    typeof request.workspaceId === 'string' && WORKSPACE_PATTERN.test(request.workspaceId) &&
    typeof request.actor === 'string' && ACTOR_PATTERN.test(request.actor)
}

type CapturedRunTime = { occurredAt: Date; iso: string; now: () => Date }

/**
 * Treat the clock as governance infrastructure, not adapter-controlled data.
 * A run gets one exact time snapshot; its audit request, terminal audit event,
 * quota reservation, and synthetic provenance cannot disagree because a test
 * seam or a rolling-back clock changed value midway through the run.
 */
function capturedRunTime(now: () => Date): CapturedRunTime {
  try {
    if (typeof now !== 'function' || isProxyValue(now)) throw new TypeError('INVALID_GOVERNANCE_CLOCK')
    const value = now()
    if (!value || typeof value !== 'object' || isProxyValue(value) || Object.getPrototypeOf(value) !== Date.prototype) throw new TypeError('INVALID_GOVERNANCE_CLOCK')
    const milliseconds = Date.prototype.getTime.call(value)
    if (!Number.isFinite(milliseconds)) throw new TypeError('INVALID_GOVERNANCE_CLOCK')
    const occurredAt = new Date(milliseconds)
    const iso = occurredAt.toISOString()
    return Object.freeze({ occurredAt, iso, now: () => new Date(milliseconds) })
  } catch {
    throw new ConnectorUnavailableError('CONNECTOR_CLOCK_UNAVAILABLE')
  }
}

/** Audit error details are stable codes, never an adapter's arbitrary message. */
function auditFailureCode(error: unknown): string {
  return error instanceof GclError ? error.code : 'connector_run_failed'
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, RegisteredConnector>()

  constructor(connectors: readonly Connector[]) {
    for (const connector of connectors) {
      const registered = registerConnector(connector)
      if (this.connectors.has(registered.id)) throw new ConnectorUnavailableError('DUPLICATE_CONNECTOR')
      this.connectors.set(registered.id, registered)
    }
  }

  get(connectorId: string): RegisteredConnector {
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

    let input: unknown
    try {
      input = frozenCanonicalJsonCopy(safeRequest.input)
    } catch {
      throw new ConnectorInputError('CONNECTOR_INVALID_INPUT')
    }
    const runTime = capturedRunTime(this.now)
    const context = Object.freeze({
      product: safeRequest.product,
      workspaceId: safeRequest.workspaceId,
      actor: safeRequest.actor,
      ownerApproved: true,
      scopes: Object.freeze([...scopes].sort()),
      costCapCents: safeRequest.costCapCents,
      requestedItems: safeRequest.requestedItems,
      now: runTime.now,
    }) as ConnectorRunContext
    await connector.preflight?.(input, context)
    const requestedAudit = await this.auditLog.append({
      type: 'connector.run.requested', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
      actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
      occurredAt: runTime.iso, detail: {},
    })
    await this.quota.consume({ ...context, connectorId: connector.id, occurredAt: runTime.occurredAt })
    try {
      const result = validatedSyntheticConnectorResult(await connector.run(input, context), connector.id, input, syntheticResultReviewBinding(context, runTime.iso))
      const succeededAudit = await this.auditLog.append({
        type: 'connector.run.succeeded', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: runTime.iso, detail: { requestedAuditHash: requestedAudit.hash },
      })
      return deepFreeze({ ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } })
    } catch (error) {
      await this.auditLog.append({
        type: 'connector.run.failed', connectorId: connector.id, product: context.product, workspaceId: context.workspaceId,
        actor: context.actor, scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
        occurredAt: runTime.iso,
        detail: { requestedAuditHash: requestedAudit.hash, error: auditFailureCode(error) },
      })
      throw error
    }
  }
}
