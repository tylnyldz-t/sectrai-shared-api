import { ConnectorInputError, CostCapError, ConnectorUnavailableError, GclError, OwnerGateError, ScopeError } from './errors.js'
import { requireGclTenantContext } from './context.js'
import { CameraConnectorRegistry, CameraGovernedConnectorRunner, type CameraRunConnectorRequest } from './camera-registry.js'
import { intrinsicIsProxy, intrinsicObjectGetOwnPropertyDescriptor } from './intrinsics.js'
import type { AuditLog, Connector, ConnectorQuota, ConnectorResult, ConnectorRunContext } from './types.js'

const ACTOR_ID = /^[a-zA-Z0-9:_@. -]{1,160}$/
const SCOPE_ID = /^[a-z][a-z0-9:-]{0,79}$/

function canonicalActor(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && Boolean(value) && ACTOR_ID.test(value)
}

function visionActor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && ACTOR_ID.test(value) ? trimmed : null
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
function runClock(now: () => Date, connector: Connector): { occurredAt: string; now: () => Date } {
  try {
    const candidate = now()
    if (connector.kind !== 'document-analysis' && !(candidate instanceof Date)) throw new TypeError('not a date')
    if (!candidate || typeof candidate !== 'object') throw new TypeError('not a date')
    const milliseconds = Date.prototype.getTime.call(candidate)
    if (!Number.isFinite(milliseconds)
      || (connector.kind === 'document-analysis' && (Object.getPrototypeOf(candidate) !== Date.prototype || Reflect.ownKeys(candidate).length !== 0))) throw new TypeError('invalid date')
    const occurredAt = new Date(milliseconds).toISOString()
    return { occurredAt, now: () => new Date(milliseconds) }
  } catch {
    if (connector.kind === 'document-analysis') throw new ConnectorInputError('INVALID_CONNECTOR_TIME')
    throw new ConnectorUnavailableError('CONNECTOR_RUN_CLOCK_INVALID')
  }
}
export type LegacyRunConnectorRequest = {
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

/** Backward-compatible HTTP runner request; the concrete runner also accepts camera requests. */
export type RunConnectorRequest = LegacyRunConnectorRequest

function connectorLane(value: unknown): 'legacy' | 'camera' {
  if (!value || typeof value !== 'object' || intrinsicIsProxy(value)) return 'camera'
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'kind')
  return descriptor && 'value' in descriptor
    && (descriptor.value === 'text-translation' || descriptor.value === 'speech-translation' || descriptor.value === 'document-analysis')
    ? 'legacy'
    : 'camera'
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>()
  readonly camera?: CameraConnectorRegistry
  readonly hasLegacy: boolean

  constructor(connectors: readonly Connector[]) {
    if (intrinsicIsProxy(connectors)) {
      this.hasLegacy = false
      this.camera = new CameraConnectorRegistry(connectors)
      return
    }
    const legacy: Connector[] = []
    const camera: Connector[] = []
    for (const connector of connectors) (connectorLane(connector) === 'legacy' ? legacy : camera).push(connector)
    this.hasLegacy = legacy.length > 0
    if (camera.length > 0) this.camera = new CameraConnectorRegistry(camera)
    for (const connector of legacy) {
      if (this.connectors.has(connector.id)) throw new Error(`DUPLICATE_CONNECTOR:${connector.id}`)
      this.connectors.set(connector.id, connector)
    }
  }

  get(connectorId: string): Connector {
    if (connectorId === 'camera-observation' && this.camera) return this.camera.get(connectorId)
    const connector = this.connectors.get(connectorId)
    if (!connector) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
    return connector
  }
}

  /**
   * Common GCL order: owner/scope/cost validation, pure preflight, audit
   * reservation, quota reservation, then the adapter.
   */
export class GovernedConnectorRunner {
  private readonly camera?: CameraGovernedConnectorRunner

  constructor(private readonly registry: ConnectorRegistry, private readonly auditLog: AuditLog, private readonly quota: ConnectorQuota, private readonly now: () => Date = () => new Date()) {
    if (intrinsicIsProxy(registry)) {
      this.camera = new CameraGovernedConnectorRunner(registry as unknown as CameraConnectorRegistry, auditLog, quota, now)
      return
    }
    if (registry.camera) this.camera = new CameraGovernedConnectorRunner(registry.camera, auditLog, quota, now)
  }

  async run(request: LegacyRunConnectorRequest | CameraRunConnectorRequest): Promise<ConnectorResult> {
    if (intrinsicIsProxy(request) || (this.camera && !this.registry.hasLegacy) || (request && typeof request === 'object' && intrinsicObjectGetOwnPropertyDescriptor(request, 'connectorId')?.value === 'camera-observation')) {
      if (!this.camera) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
      return this.camera.run(request as CameraRunConnectorRequest)
    }
    const legacyRequest = request as LegacyRunConnectorRequest
    const connector = this.registry.get(legacyRequest.connectorId)
    if (legacyRequest.ownerApproved !== true) throw new OwnerGateError()
    try {
      requireGclTenantContext(legacyRequest)
    } catch (error) {
      if (connector.kind === 'document-analysis') throw new ConnectorInputError('INVALID_CONNECTOR_CONTEXT')
      throw error
    }
    const actor = connector.kind === 'document-analysis' ? visionActor(legacyRequest.actor) : (canonicalActor(legacyRequest.actor) ? legacyRequest.actor : null)
    if (!actor) {
      if (connector.kind === 'document-analysis') throw new ConnectorInputError('INVALID_CONNECTOR_CONTEXT')
      throw new OwnerGateError('OWNER_ACTOR_REQUIRED')
    }
    if (!Number.isSafeInteger(legacyRequest.costCapCents) || legacyRequest.costCapCents < 1) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
    if (!Number.isSafeInteger(legacyRequest.requestedItems) || legacyRequest.requestedItems < 1) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
    const scopes = canonicalScopes(legacyRequest.scopes, connector)

    const run = runClock(this.now, connector)
    const context: ConnectorRunContext = {
      product: legacyRequest.product,
      workspaceId: legacyRequest.workspaceId,
      actor,
      ownerApproved: legacyRequest.ownerApproved,
      scopes,
      costCapCents: legacyRequest.costCapCents,
      requestedItems: legacyRequest.requestedItems,
      now: run.now,
    }
    // A connector that returns a canonical preflight value commits the exact
    // input that will reach its adapter. This prevents a caller retaining the
    // original object (or a stateful Proxy) from changing a reviewed fixture
    // while the requested audit/quota awaits. Older validate-only connectors
    // still return undefined and retain their existing contract.
    const preparedInput = await connector.preflight?.(legacyRequest.input, context)
    const adapterInput = preparedInput === undefined ? legacyRequest.input : preparedInput
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
