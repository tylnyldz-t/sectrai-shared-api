import { types as nodeTypes } from 'node:util'
import { appendVerifiedAuditEvent } from './audit.js'
import { AuditChainError, AuditEventError, AuditReceiptError, ConnectorInputError, ConnectorResultError, CostCapError, GclError, MakerCheckerError, OwnerGateError, ScopeError, ConnectorUnavailableError } from './errors.js'
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

const GOVERNED_CONNECTOR_RESULT_FIELDS = ['data', 'provenance', 'confidence'] as const
const GOVERNED_CONNECTOR_PROVENANCE_FIELDS = ['connectorId', 'source', 'retrievedAt', 'liveStatus', 'synthetic', 'untrustedContent'] as const
const GOVERNED_UNTRUSTED_CONTENT_FIELDS = ['source', 'value', 'handling', 'instructionPolicy'] as const
const SYNTHETIC_SOURCE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,199}$/
const MAX_GOVERNED_INPUT_DEPTH = 8
const MAX_GOVERNED_INPUT_KEYS = 48
const MAX_GOVERNED_INPUT_ARRAY_ITEMS = 48
const MAX_GOVERNED_INPUT_STRING_LENGTH = 4096
const MAX_REGISTERED_CONNECTORS = 12

type RegisteredConnector = Readonly<{
  id: string
  kind: Connector['kind']
  authKind: Connector['authKind']
  scopes: readonly string[]
  preflight?: Connector['preflight']
  run: Connector['run']
  validateResult?: Connector['validateResult']
}>

const REGISTERED_CONNECTOR_METADATA_FIELDS = ['id', 'kind', 'authKind', 'scopes'] as const
const REGISTERED_CONNECTOR_METHOD_FIELDS = ['preflight', 'run', 'validateResult'] as const

/**
 * D22 captures the connector control plane while the local registry is built.
 * It only reads property descriptors, never connector getters, so a later
 * overwrite of id/scopes/methods cannot retarget a governed run's audit, quota,
 * or invocation path. Connector implementation state remains private to that
 * already-admitted synthetic implementation.
 */
function connectorRegistrationError(): never {
  throw new ConnectorUnavailableError('INVALID_CONNECTOR_REGISTRATION')
}

function registeredConnectorList(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    return connectorRegistrationError()
  }
  const names = Object.getOwnPropertyNames(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof length !== 'number' || !Number.isSafeInteger(length) || length > MAX_REGISTERED_CONNECTORS ||
    names.length !== length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    return connectorRegistrationError()
  }
  const connectors: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return connectorRegistrationError()
    connectors.push(descriptor.value)
  }
  return Object.freeze(connectors)
}

function registeredConnectorMetadata(value: object, field: typeof REGISTERED_CONNECTOR_METADATA_FIELDS[number]): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return connectorRegistrationError()
  return descriptor.value
}

function registeredConnectorScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    return connectorRegistrationError()
  }
  const names = Object.getOwnPropertyNames(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > 12 ||
    names.length !== length + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
    return connectorRegistrationError()
  }
  const scopes: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      return connectorRegistrationError()
    }
    scopes.push(descriptor.value)
  }
  if (new Set(scopes).size !== scopes.length) return connectorRegistrationError()
  return Object.freeze(scopes.sort())
}

function registeredConnectorMethod(value: object, field: typeof REGISTERED_CONNECTOR_METHOD_FIELDS[number], required: boolean): Function | undefined {
  let candidate: object | null = value
  for (let depth = 0; candidate !== null && candidate !== Object.prototype && depth < 8; depth += 1) {
    if (nodeTypes.isProxy(candidate)) return connectorRegistrationError()
    const descriptor = Object.getOwnPropertyDescriptor(candidate, field)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) return connectorRegistrationError()
      return descriptor.value
    }
    candidate = Object.getPrototypeOf(candidate)
  }
  if (required || candidate !== null) return connectorRegistrationError()
  return undefined
}

function registeredConnector(value: unknown): RegisteredConnector {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return connectorRegistrationError()
  const candidate = value as object
  const id = registeredConnectorMetadata(candidate, 'id')
  const kind = registeredConnectorMetadata(candidate, 'kind')
  const authKind = registeredConnectorMetadata(candidate, 'authKind')
  const scopes = registeredConnectorScopes(registeredConnectorMetadata(candidate, 'scopes'))
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || kind !== 'synthetic-camera' || authKind !== 'owner-token') {
    return connectorRegistrationError()
  }

  const preflight = registeredConnectorMethod(candidate, 'preflight', false)
  const run = registeredConnectorMethod(candidate, 'run', true)
  const validateResult = registeredConnectorMethod(candidate, 'validateResult', false)
  const call = (method: Function, args: readonly unknown[]): unknown => Reflect.apply(method, candidate, args)

  return Object.freeze({
    id,
    kind,
    authKind,
    scopes,
    ...(preflight ? { preflight: (input: unknown, context: ConnectorRunContext) => call(preflight, [input, context]) as ReturnType<NonNullable<Connector['preflight']>> } : {}),
    run: (input: unknown, context: ConnectorRunContext) => call(run as Function, [input, context]) as ReturnType<Connector['run']>,
    ...(validateResult ? { validateResult: (result: ConnectorResult, context: ConnectorRunContext) => call(validateResult, [result, context]) as ReturnType<NonNullable<Connector['validateResult']>> } : {}),
  })
}

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
 * D21 admits generic connector input only as bounded own-data JSON and gives
 * collaborators a deep immutable copy. It deliberately does not interpret
 * input fields: the selected adapter remains responsible for its contract.
 * The copy merely prevents a caller or preflight hook from changing what a
 * later run observes after the runner has admitted it.
 */
function governedInputSnapshot(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_GOVERNED_INPUT_STRING_LENGTH) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    return value
  }
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || depth >= MAX_GOVERNED_INPUT_DEPTH || ancestors.has(value)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    }
    const names = Object.getOwnPropertyNames(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    const itemCount = lengthDescriptor?.value
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') || typeof itemCount !== 'number' || !Number.isSafeInteger(itemCount) || itemCount > MAX_GOVERNED_INPUT_ARRAY_ITEMS ||
      names.length !== itemCount + 1 || !names.includes('length') || names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    }
    const nextAncestors = new Set(ancestors).add(value)
    const snapshot: unknown[] = []
    for (let index = 0; index < itemCount; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
      snapshot.push(governedInputSnapshot(descriptor.value, depth + 1, nextAncestors))
    }
    return Object.freeze(snapshot)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  const names = Object.getOwnPropertyNames(value)
  if (names.length > MAX_GOVERNED_INPUT_KEYS || Object.getOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const nextAncestors = new Set(ancestors).add(value)
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const name of names) {
    const descriptor = descriptors[name]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    snapshot[name] = governedInputSnapshot(descriptor.value, depth + 1, nextAncestors)
  }
  return Object.freeze(snapshot)
}

/**
 * D12/D21 seal direct library calls at the governed-run envelope before the
 * runner can consult its clock, registry, audit, quota, or adapter. Every
 * envelope field must be an allowlisted own enumerable data property; D21
 * also snapshots opaque input before use so getters and Proxy traps are never
 * evaluated and later collaborators cannot retarget it.
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
    input: governedInputSnapshot(input),
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
 * D13 uses the same no-getter/no-Proxy data boundary for adapter-produced
 * envelopes. It deliberately does not parse generic `data` or untrusted
 * content values: individual adapters retain that responsibility. The runner
 * only accepts and reconstructs the control-plane wrapper it needs to audit.
 */
function governedResultRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  const names = Object.getOwnPropertyNames(value)
  if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== fields.length || names.some((name) => !fields.includes(name))) {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    const descriptor = descriptors[field]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
    normalized[field] = descriptor.value
  }
  return normalized
}

/**
 * D13 verifies and copies the result/provenance control plane after adapter
 * execution but before a success audit is appended or a result is returned.
 * `auditHash` is intentionally absent here: the runner is its sole writer.
 */
function governedConnectorResult(value: unknown, connectorId: string, occurredAt: Date): ConnectorResult {
  const result = governedResultRecord(value, GOVERNED_CONNECTOR_RESULT_FIELDS)
  const provenance = governedResultRecord(result.provenance, GOVERNED_CONNECTOR_PROVENANCE_FIELDS)
  const untrustedContent = governedResultRecord(provenance.untrustedContent, GOVERNED_UNTRUSTED_CONTENT_FIELDS)
  const expectedRetrievedAt = Date.prototype.toISOString.call(occurredAt)

  if (nodeTypes.isProxy(result.data) || nodeTypes.isProxy(untrustedContent.value) ||
    typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
    provenance.connectorId !== connectorId || typeof provenance.source !== 'string' || !SYNTHETIC_SOURCE_PATTERN.test(provenance.source) ||
    provenance.retrievedAt !== expectedRetrievedAt || provenance.liveStatus !== 'LIVE_DISABLED' || provenance.synthetic !== true ||
    typeof untrustedContent.source !== 'string' || !SYNTHETIC_SOURCE_PATTERN.test(untrustedContent.source) ||
    untrustedContent.handling !== 'data-only' || untrustedContent.instructionPolicy !== 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS') {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  }

  return {
    data: result.data,
    confidence: result.confidence,
    provenance: {
      connectorId,
      source: provenance.source,
      retrievedAt: expectedRetrievedAt,
      liveStatus: 'LIVE_DISABLED',
      synthetic: true,
      untrustedContent: {
        source: untrustedContent.source,
        value: untrustedContent.value,
        handling: 'data-only',
        instructionPolicy: 'UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS',
      },
    },
  }
}

/**
 * D19 lets a synthetic connector close the generic D13 data-plane gap before
 * success is audited. The generic runner deliberately keeps `data` and the
 * isolated value opaque; a connector that opts in must reconstruct both and
 * then pass the same control-plane boundary a second time. A verifier failure
 * is always a result failure, never an adapter/input failure.
 */
function governedVerifiedConnectorResult(value: unknown, connector: Connector, context: ConnectorRunContext, occurredAt: Date): ConnectorResult {
  const result = governedConnectorResult(value, connector.id, occurredAt)
  if (!connector.validateResult) return result
  try {
    return governedConnectorResult(connector.validateResult(result, context), connector.id, occurredAt)
  } catch {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
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

/**
 * D20 gives every governed collaborator one immutable, own-data run-context
 * snapshot. A connector cannot retarget a later audit event, quota request, or
 * camera review/result check by changing product/workspace/actor/scope/limit
 * fields that the runner already admitted. The local clock remains the D11
 * copy factory: callers only receive fresh copies of the one trusted instant.
 */
function governedRunContext(request: RunConnectorRequest, occurredAt: Date): ConnectorRunContext {
  const scopes = Object.freeze([...new Set(request.scopes)].sort())
  return Object.freeze({
    product: request.product,
    workspaceId: request.workspaceId,
    requestedBy: request.requestedBy,
    checkedBy: request.checkedBy,
    correlationId: request.correlationId,
    ownerApproved: request.ownerApproved,
    scopes,
    costCapCents: request.costCapCents,
    requestedItems: request.requestedItems,
    now: snapshotClock(occurredAt),
  })
}

function auditFailureDetail(error: unknown, stage: 'admission' | 'execution'): Record<string, unknown> {
  return {
    stage,
    errorCode: error instanceof GclError ? error.code : 'internal_error',
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, RegisteredConnector>()

  constructor(connectors: readonly Connector[]) {
    for (const candidate of registeredConnectorList(connectors)) {
      const connector = registeredConnector(candidate)
      if (this.connectors.has(connector.id)) throw new Error(`DUPLICATE_CONNECTOR:${connector.id}`)
      this.connectors.set(connector.id, connector)
    }
  }

  get(connectorId: string): RegisteredConnector {
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
    const context = governedRunContext(normalizedRequest, occurredAt)
    let connector: Connector
    try {
      connector = this.registry.get(normalizedRequest.connectorId)
    } catch (error) {
      await appendVerifiedAuditEvent(this.auditLog, this.event('connector.run.denied', normalizedRequest.connectorId, context, occurredAt, auditFailureDetail(error, 'admission')))
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
      await appendVerifiedAuditEvent(this.auditLog, this.event('connector.run.denied', connector.id, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    const requestedAudit = await appendVerifiedAuditEvent(this.auditLog, this.event('connector.run.requested', connector.id, context, occurredAt, {}))
    try {
      await this.quota.consume({ ...context, connectorId: connector.id, occurredAt: snapshotClock(occurredAt)() })
      const result = governedVerifiedConnectorResult(await connector.run(normalizedRequest.input, context), connector, context, occurredAt)
      const succeededAudit = await appendVerifiedAuditEvent(this.auditLog, this.event('connector.run.succeeded', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash }), requestedAudit.hash)
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      // A malformed receipt can mean the preceding append partially persisted.
      // Do not manufacture a second, unactionable transition after it.
      if (error instanceof AuditReceiptError || error instanceof AuditEventError || error instanceof AuditChainError) throw error
      await appendVerifiedAuditEvent(this.auditLog, this.event('connector.run.failed', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash, ...auditFailureDetail(error, 'execution') }), requestedAudit.hash)
      throw error
    }
  }
}
