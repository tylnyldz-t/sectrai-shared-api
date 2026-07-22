import { appendVerifiedAuditEvent } from './audit.js'
import { AuditChainError, AuditEventError, AuditReceiptError, ConnectorInputError, ConnectorResultError, CostCapError, GclError, MakerCheckerError, OwnerGateError, ScopeError, ConnectorUnavailableError } from './errors.js'
import {
  intrinsicArrayIncludes, intrinsicArrayIsArray, intrinsicArrayPrototype, intrinsicArraySort, intrinsicDate, intrinsicDateGetTime, intrinsicDateToISOString, intrinsicIsDate, intrinsicIsProxy,
  intrinsicNumberIsFinite, intrinsicNumberIsSafeInteger, intrinsicObjectCreate, intrinsicObjectFreeze, intrinsicObjectGetOwnPropertyDescriptor,
  intrinsicObjectGetOwnPropertyDescriptors, intrinsicObjectGetOwnPropertyNames, intrinsicObjectGetOwnPropertySymbols,
  intrinsicObjectGetPrototypeOf, intrinsicObjectPrototype, intrinsicReflectApply, intrinsicSet, intrinsicSetAdd, intrinsicSetDelete, intrinsicSetHas,
} from './intrinsics.js'
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

function isSafePositiveInteger(value: number): boolean { return intrinsicNumberIsSafeInteger(value) && value > 0 }

function arrayIncludes(values: readonly unknown[], value: unknown): boolean {
  return intrinsicReflectApply(intrinsicArrayIncludes, values, [value]) as boolean
}

function hasUnexpectedArrayName(names: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined || (name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) return true
  }
  return false
}

function hasDisallowedName(names: readonly string[], allowed: readonly string[]): boolean {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]
    if (name === undefined || !arrayIncludes(allowed, name)) return true
  }
  return false
}

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
  if (!intrinsicArrayIsArray(value) || intrinsicIsProxy(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
    return connectorRegistrationError()
  }
  const names = intrinsicObjectGetOwnPropertyNames(value)
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof length !== 'number' || !intrinsicNumberIsSafeInteger(length) || length > MAX_REGISTERED_CONNECTORS ||
    names.length !== length + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
    return connectorRegistrationError()
  }
  const connectors: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return connectorRegistrationError()
    connectors[connectors.length] = descriptor.value
  }
  return intrinsicObjectFreeze(connectors)
}

function registeredConnectorMetadata(value: object, field: typeof REGISTERED_CONNECTOR_METADATA_FIELDS[number]): unknown {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, field)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return connectorRegistrationError()
  return descriptor.value
}

function registeredConnectorScopes(value: unknown): readonly string[] {
  if (!intrinsicArrayIsArray(value) || intrinsicIsProxy(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
    return connectorRegistrationError()
  }
  const names = intrinsicObjectGetOwnPropertyNames(value)
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof length !== 'number' || !intrinsicNumberIsSafeInteger(length) || length < 1 || length > 12 ||
    names.length !== length + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
    return connectorRegistrationError()
  }
  const scopes: string[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      return connectorRegistrationError()
    }
    scopes[scopes.length] = descriptor.value
  }
  const uniqueScopes = new intrinsicSet<string>()
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]
    if (scope === undefined) return connectorRegistrationError()
    if (intrinsicReflectApply(intrinsicSetHas, uniqueScopes, [scope])) return connectorRegistrationError()
    intrinsicReflectApply(intrinsicSetAdd, uniqueScopes, [scope])
  }
  return intrinsicObjectFreeze(intrinsicReflectApply(intrinsicArraySort, scopes, []) as string[])
}

function registeredConnectorMethod(value: object, field: typeof REGISTERED_CONNECTOR_METHOD_FIELDS[number], required: boolean): Function | undefined {
  let candidate: object | null = value
  for (let depth = 0; candidate !== null && candidate !== intrinsicObjectPrototype && depth < 8; depth += 1) {
    if (intrinsicIsProxy(candidate)) return connectorRegistrationError()
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(candidate, field)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || intrinsicIsProxy(descriptor.value)) return connectorRegistrationError()
      return descriptor.value
    }
    candidate = intrinsicObjectGetPrototypeOf(candidate)
  }
  if (required || (candidate !== null && candidate !== intrinsicObjectPrototype)) return connectorRegistrationError()
  return undefined
}

function registeredConnector(value: unknown): RegisteredConnector {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) return connectorRegistrationError()
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
  const call = (method: Function, args: readonly unknown[]): unknown => intrinsicReflectApply(method, candidate, args)

  return intrinsicObjectFreeze({
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
  if (!intrinsicArrayIsArray(value) || intrinsicIsProxy(value) || intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  if (value.length > 12 || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const scopes: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value || descriptor.value.length > 80) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
    }
    scopes[scopes.length] = descriptor.value
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
function governedInputSnapshot(value: unknown, depth = 0, ancestors = new intrinsicSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_GOVERNED_INPUT_STRING_LENGTH) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    return value
  }
  if (typeof value === 'number') {
    if (!intrinsicNumberIsFinite(value)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    return value
  }
  if (!value || typeof value !== 'object' || intrinsicIsProxy(value) || depth >= MAX_GOVERNED_INPUT_DEPTH || intrinsicReflectApply(intrinsicSetHas, ancestors, [value])) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  }

  if (intrinsicArrayIsArray(value)) {
    if (intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    }
    const names = intrinsicObjectGetOwnPropertyNames(value)
    const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
    const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
    const itemCount = lengthDescriptor?.value
    if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof itemCount !== 'number' || !intrinsicNumberIsSafeInteger(itemCount) || itemCount > MAX_GOVERNED_INPUT_ARRAY_ITEMS ||
      names.length !== itemCount + 1 || !arrayIncludes(names, 'length') || hasUnexpectedArrayName(names)) {
      throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
    }
    const snapshot: unknown[] = []
    intrinsicReflectApply(intrinsicSetAdd, ancestors, [value])
    try {
      for (let index = 0; index < itemCount; index += 1) {
        const descriptor = descriptors[`${index}`]
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
        snapshot[snapshot.length] = governedInputSnapshot(descriptor.value, depth + 1, ancestors)
      }
    } finally {
      intrinsicReflectApply(intrinsicSetDelete, ancestors, [value])
    }
    return intrinsicObjectFreeze(snapshot)
  }

  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (names.length > MAX_GOVERNED_INPUT_KEYS || intrinsicObjectGetOwnPropertySymbols(value).length > 0) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const snapshot = intrinsicObjectCreate(null) as Record<string, unknown>
  intrinsicReflectApply(intrinsicSetAdd, ancestors, [value])
  try {
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]
      if (name === undefined) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
      const descriptor = descriptors[name]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_INPUT')
      snapshot[name] = governedInputSnapshot(descriptor.value, depth + 1, ancestors)
    }
  } finally {
    intrinsicReflectApply(intrinsicSetDelete, ancestors, [value])
  }
  return intrinsicObjectFreeze(snapshot)
}

/**
 * D12/D21 seal direct library calls at the governed-run envelope before the
 * runner can consult its clock, registry, audit, quota, or adapter. Every
 * envelope field must be an allowlisted own enumerable data property; D21
 * also snapshots opaque input before use so getters and Proxy traps are never
 * evaluated and later collaborators cannot retarget it.
 */
function governedRunRequest(value: unknown): RunConnectorRequest {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length > 0 || names.length !== GOVERNED_RUN_REQUEST_FIELDS.length || hasDisallowedName(names, GOVERNED_RUN_REQUEST_FIELDS)) {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
  for (let index = 0; index < GOVERNED_RUN_REQUEST_FIELDS.length; index += 1) {
    const field = GOVERNED_RUN_REQUEST_FIELDS[index]
    if (field === undefined) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
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
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  }
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  const names = intrinsicObjectGetOwnPropertyNames(value)
  if (intrinsicObjectGetOwnPropertySymbols(value).length > 0 || names.length !== fields.length || hasDisallowedName(names, fields)) {
    throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
  }
  const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value)
  const normalized = intrinsicObjectCreate(null) as Record<string, unknown>
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined) throw new ConnectorResultError('INVALID_GOVERNED_CONNECTOR_RESULT')
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
  const expectedRetrievedAt = intrinsicReflectApply(intrinsicDateToISOString, occurredAt, []) as string

  if (intrinsicIsProxy(result.data) || intrinsicIsProxy(untrustedContent.value) ||
    typeof result.confidence !== 'number' || !intrinsicNumberIsFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
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
  if (typeof clock !== 'function' || intrinsicIsProxy(clock)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  let candidate: unknown
  try {
    candidate = clock()
  } catch {
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  }
  if (!intrinsicIsDate(candidate) || intrinsicIsProxy(candidate)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  try {
    const milliseconds = intrinsicReflectApply(intrinsicDateGetTime, candidate, []) as number
    if (!intrinsicNumberIsFinite(milliseconds)) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
    return new intrinsicDate(milliseconds)
  } catch (error) {
    if (error instanceof ConnectorInputError) throw error
    throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_CLOCK')
  }
}

function snapshotClock(snapshot: Date): () => Date {
  return () => new intrinsicDate(intrinsicReflectApply(intrinsicDateGetTime, snapshot, []) as number)
}

/**
 * D20 gives every governed collaborator one immutable, own-data run-context
 * snapshot. A connector cannot retarget a later audit event, quota request, or
 * camera review/result check by changing product/workspace/actor/scope/limit
 * fields that the runner already admitted. The local clock remains the D11
 * copy factory: callers only receive fresh copies of the one trusted instant.
 */
function governedRunContext(request: RunConnectorRequest, occurredAt: Date): ConnectorRunContext {
  const uniqueScopes = new intrinsicSet<string>()
  const scopes: string[] = []
  for (let index = 0; index < request.scopes.length; index += 1) {
    const scope = request.scopes[index]
    if (scope === undefined) throw new ConnectorInputError('INVALID_GOVERNED_CONNECTOR_REQUEST')
    if (!intrinsicReflectApply(intrinsicSetHas, uniqueScopes, [scope])) {
      intrinsicReflectApply(intrinsicSetAdd, uniqueScopes, [scope])
      scopes[scopes.length] = scope
    }
  }
  return intrinsicObjectFreeze({
    product: request.product,
    workspaceId: request.workspaceId,
    requestedBy: request.requestedBy,
    checkedBy: request.checkedBy,
    correlationId: request.correlationId,
    ownerApproved: request.ownerApproved,
    scopes: intrinsicObjectFreeze(intrinsicReflectApply(intrinsicArraySort, scopes, []) as string[]),
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

type GovernedRunnerCollaborators = Readonly<{
  resolve: (connectorId: string) => RegisteredConnector
  auditLog: AuditLog
  consume: ConnectorQuota['consume']
  now: () => Date
}>

/**
 * D23 admits only descriptor-backed collaborator methods and captures both
 * their original receiver and the module-initialized apply intrinsic. This
 * prevents a later public-property replacement from retargeting the runner's
 * registry, audit, or quota path. It intentionally does not claim to sandbox
 * code or private mutable state inside an already-admitted collaborator.
 */
function runnerCollaboratorError(): never {
  throw new ConnectorUnavailableError('INVALID_GOVERNED_RUNNER_COLLABORATOR')
}

function capturedRunnerCollaboratorMethod(value: unknown, field: string): (...args: unknown[]) => unknown {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value) || intrinsicIsProxy(value)) return runnerCollaboratorError()
  const receiver = value as object
  let candidate: object | null = receiver
  for (let depth = 0; candidate !== null && candidate !== intrinsicObjectPrototype && depth < 8; depth += 1) {
    if (intrinsicIsProxy(candidate)) return runnerCollaboratorError()
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(candidate, field)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || intrinsicIsProxy(descriptor.value)) return runnerCollaboratorError()
      const method = descriptor.value
      return (...args: unknown[]): unknown => intrinsicReflectApply(method, receiver, args)
    }
    candidate = intrinsicObjectGetPrototypeOf(candidate)
  }
  return runnerCollaboratorError()
}

function governedRunnerCollaborators(registry: ConnectorRegistry, auditLog: AuditLog, quota: ConnectorQuota, now: () => Date): GovernedRunnerCollaborators {
  if (typeof now !== 'function' || intrinsicIsProxy(now)) return runnerCollaboratorError()
  const resolve = capturedRunnerCollaboratorMethod(registry, 'get')
  const append = capturedRunnerCollaboratorMethod(auditLog, 'append')
  const consume = capturedRunnerCollaboratorMethod(quota, 'consume')
  return intrinsicObjectFreeze({
    resolve: (connectorId: string) => resolve(connectorId) as RegisteredConnector,
    auditLog: intrinsicObjectFreeze({ append: (event: ConnectorAuditEvent) => append(event) as ReturnType<AuditLog['append']> }),
    consume: (request: Parameters<ConnectorQuota['consume']>[0]) => consume(request) as ReturnType<ConnectorQuota['consume']>,
    now,
  })
}

export class ConnectorRegistry {
  readonly #connectors = new Map<string, RegisteredConnector>()

  constructor(connectors: readonly Connector[]) {
    const registered = registeredConnectorList(connectors)
    for (let index = 0; index < registered.length; index += 1) {
      const candidate = registered[index]
      if (candidate === undefined) throw new ConnectorUnavailableError('INVALID_CONNECTOR_REGISTRATION')
      const connector = registeredConnector(candidate)
      if (this.#connectors.has(connector.id)) throw new Error(`DUPLICATE_CONNECTOR:${connector.id}`)
      this.#connectors.set(connector.id, connector)
    }
  }

  get(connectorId: string): RegisteredConnector {
    const connector = this.#connectors.get(connectorId)
    if (!connector) throw new ConnectorUnavailableError('CONNECTOR_NOT_REGISTERED')
    return connector
  }
}

/** Governance is evaluated before any fixture lookup, quota reservation, or adapter run. */
export class GovernedConnectorRunner {
  readonly #collaborators: GovernedRunnerCollaborators

  constructor(registry: ConnectorRegistry, auditLog: AuditLog, quota: ConnectorQuota, now: () => Date = () => new Date()) {
    this.#collaborators = governedRunnerCollaborators(registry, auditLog, quota, now)
  }

  #event(type: ConnectorAuditEvent['type'], connectorId: string, context: ConnectorRunContext, occurredAt: Date, detail: Record<string, unknown>): ConnectorAuditEvent {
    return {
      type, connectorId, product: context.product, workspaceId: context.workspaceId,
      requestedBy: context.requestedBy, checkedBy: context.checkedBy, correlationId: context.correlationId,
      scopes: context.scopes, costCapCents: context.costCapCents, requestedItems: context.requestedItems,
      occurredAt: intrinsicReflectApply(intrinsicDateToISOString, occurredAt, []) as string, detail,
    }
  }

  async run(request: RunConnectorRequest): Promise<ConnectorResult> {
    const { resolve, auditLog, consume, now } = this.#collaborators
    const normalizedRequest = governedRunRequest(request)
    const occurredAt = governedRunTimeSnapshot(now)
    const context = governedRunContext(normalizedRequest, occurredAt)
    let connector: Connector
    try {
      connector = resolve(normalizedRequest.connectorId)
    } catch (error) {
      await appendVerifiedAuditEvent(auditLog, this.#event('connector.run.denied', normalizedRequest.connectorId, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    try {
      if (!context.ownerApproved) throw new OwnerGateError()
      if (context.requestedBy === context.checkedBy) throw new MakerCheckerError()
      if (!isSafePositiveInteger(context.costCapCents)) throw new CostCapError('CONNECTOR_COST_CAP_REQUIRED')
      if (!isSafePositiveInteger(context.requestedItems)) throw new CostCapError('CONNECTOR_REQUESTED_ITEMS_REQUIRED')
      let scopeDenied = context.scopes.length === 0
      for (let index = 0; index < context.scopes.length; index += 1) {
        const scope = context.scopes[index]
        if (scope === undefined || !arrayIncludes(connector.scopes, scope)) scopeDenied = true
      }
      if (scopeDenied) throw new ScopeError()
      await connector.preflight?.(normalizedRequest.input, context)
    } catch (error) {
      await appendVerifiedAuditEvent(auditLog, this.#event('connector.run.denied', connector.id, context, occurredAt, auditFailureDetail(error, 'admission')))
      throw error
    }

    const requestedAudit = await appendVerifiedAuditEvent(auditLog, this.#event('connector.run.requested', connector.id, context, occurredAt, {}))
    try {
      await consume({ ...context, connectorId: connector.id, occurredAt: snapshotClock(occurredAt)() })
      const result = governedVerifiedConnectorResult(await connector.run(normalizedRequest.input, context), connector, context, occurredAt)
      const succeededAudit = await appendVerifiedAuditEvent(auditLog, this.#event('connector.run.succeeded', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash }), requestedAudit.hash)
      return { ...result, provenance: { ...result.provenance, auditHash: succeededAudit.hash } }
    } catch (error) {
      // A malformed receipt can mean the preceding append partially persisted.
      // Do not manufacture a second, unactionable transition after it.
      if (error instanceof AuditReceiptError || error instanceof AuditEventError || error instanceof AuditChainError) throw error
      await appendVerifiedAuditEvent(auditLog, this.#event('connector.run.failed', connector.id, context, occurredAt, { requestedAuditHash: requestedAudit.hash, ...auditFailureDetail(error, 'execution') }), requestedAudit.hash)
      throw error
    }
  }
}
